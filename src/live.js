import crypto from 'node:crypto';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { bad, conflict, notFound } from './errors.js';
import { now } from './util.js';
import { config } from './config.js';
import { assertOnline } from './availability.js';
import { ACTIVE_STATUSES, remainingMs, slotStatus, startGuestSession } from './sessions.js';

/**
 * Modo live: o espectador da live do YouTube entra numa sala com um apelido e
 * o dono escolhe quem joga. Quem é escolhido ganha uma sessão de convidado
 * (sem pagamento, com tempo fixo) e a página /live mostra o botão de jogar.
 *
 * A sala (apelidos) fica só em memória; a configuração e a sessão são do state.
 */

const STALE_MS = 25_000; // sem sinal de vida (heartbeat) por tanto tempo → sai da sala
const MAX_VIEWERS = 200;

/** viewerId (segredo do espectador) → { id, pub, nick, joinedAt, seenAt } */
const lobby = new Map();

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Aceita link de live/vídeo do YouTube (ou o ID de 11 caracteres). */
export function extractVideoId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (VIDEO_ID.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  let candidate = null;
  if (host === 'youtu.be') {
    candidate = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') candidate = url.searchParams.get('v');
    else {
      const [, kind, id] = url.pathname.split('/');
      if (['live', 'embed', 'shorts', 'v'].includes(kind)) candidate = id;
    }
  }
  return candidate && VIDEO_ID.test(candidate) ? candidate : null;
}

export function liveSettings(state = store.data) {
  return state.live ?? { enabled: false, videoId: null };
}

export function configureLive({ url, enabled }) {
  const videoId = extractVideoId(url);
  if (enabled && !videoId) {
    throw bad('Cole um link válido de live do YouTube.', 'invalid_live_url');
  }
  store.mutate((state) => {
    state.live = { enabled: Boolean(enabled), videoId: videoId ?? state.live?.videoId ?? null };
    pushEvent(state, 'live.configured', { enabled: state.live.enabled, videoId: state.live.videoId });
  });
  if (!enabled) lobby.clear();
  bus.emit('state:changed');
  return liveSettings();
}

function prune(t = now()) {
  for (const [key, viewer] of lobby) {
    if (t - viewer.seenAt > STALE_MS) lobby.delete(key);
  }
}

function cleanNick(value) {
  const nick = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (nick.length < 2 || nick.length > 24) {
    throw bad('Escolha um apelido de 2 a 24 caracteres.', 'invalid_nick');
  }
  return nick;
}

export function publicLive(t = now()) {
  prune(t);
  const { enabled, videoId } = liveSettings();
  const session = store.data.session;
  const activeSession = session && ACTIVE_STATUSES.includes(session.status) ? session : null;
  const queue = [...lobby.values()]
    .filter((viewer) => viewer.id !== activeSession?.guestViewerId)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((viewer) => viewer.nick);
  const timeLeft = session?.status === 'active' ? remainingMs(session, t) : 0;
  const playing = timeLeft > 0
    ? { name: session.customer.name, remainingMs: timeLeft }
    : null;

  return {
    enabled: Boolean(enabled && videoId),
    videoId: enabled ? videoId : null,
    viewers: lobby.size,
    queue,
    playing,
  };
}

export function joinLobby(nickInput) {
  const settings = liveSettings();
  if (!settings.enabled) throw conflict('A live não está aberta para jogar agora.', 'live_disabled');
  prune();
  if (lobby.size >= MAX_VIEWERS) throw conflict('A sala está cheia.', 'lobby_full');
  const nick = cleanNick(nickInput);
  const t = now();
  const viewer = {
    id: crypto.randomBytes(18).toString('base64url'),
    pub: crypto.randomBytes(5).toString('hex'),
    nick,
    joinedAt: t,
    seenAt: t,
  };
  lobby.set(viewer.id, viewer);
  bus.emit('state:changed');
  return { viewerId: viewer.id, nick };
}

export function leaveLobby(viewerId) {
  if (lobby.delete(String(viewerId ?? ''))) bus.emit('state:changed');
}

/** Heartbeat + resposta: "sou eu o escolhido?" */
export function viewerStatus(viewerId, t = now()) {
  const key = String(viewerId ?? '');
  const session = store.data.session;
  const chosen = session?.guestViewerId === key
    && ['provisioning', 'active'].includes(session.status);

  const viewer = lobby.get(key);
  if (viewer) viewer.seenAt = t;
  const settings = liveSettings();

  if (chosen) {
    return {
      joined: true,
      enabled: Boolean(settings.enabled),
      chosen: true,
      nick: session.customer.name,
      playUrl: `/play.html?s=${encodeURIComponent(session.token)}`,
      sessionStatus: session.status,
      endsAt: session.endsAt,
    };
  }
  return {
    joined: Boolean(viewer),
    enabled: Boolean(settings.enabled),
    chosen: false,
    nick: viewer?.nick ?? null,
  };
}

export function adminLive(t = now()) {
  prune(t);
  const settings = liveSettings();
  return {
    enabled: Boolean(settings.enabled),
    videoId: settings.videoId,
    viewers: [...lobby.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((v) => ({ pub: v.pub, nick: v.nick, joinedAt: v.joinedAt })),
  };
}

export function pickViewer(pub, minutesInput) {
  const settings = liveSettings();
  if (!settings.enabled) throw conflict('A live está desativada.', 'live_disabled');
  const minutes = Math.trunc(Number(minutesInput));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > config.maxGuestMinutes) {
    throw bad(`Escolha de 1 a ${config.maxGuestMinutes} minutos.`, 'invalid_minutes');
  }
  prune();
  const viewer = [...lobby.values()].find((v) => v.pub === String(pub ?? ''));
  if (!viewer) throw notFound('Esse espectador saiu da sala.');
  assertOnline();
  const slot = slotStatus();
  if (slot.status !== 'free') {
    throw conflict('O Xbox está ocupado ou reservado. Encerre a sessão atual antes.', 'slot_busy');
  }
  const session = startGuestSession({ nick: viewer.nick, minutes, viewerId: viewer.id });
  if (!session) throw conflict('O Xbox ficou ocupado.', 'slot_busy');
  return { nick: viewer.nick, minutes };
}

export function kickViewer(pub) {
  for (const [key, v] of lobby) {
    if (v.pub === String(pub ?? '')) {
      lobby.delete(key);
      bus.emit('state:changed');
      return true;
    }
  }
  return false;
}

/** Só para testes. */
export function _resetLobby() {
  lobby.clear();
}
