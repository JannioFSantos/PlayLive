import crypto from 'node:crypto';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { ApiError, bad, conflict, notFound } from './errors.js';
import { now } from './util.js';
import { config } from './config.js';
import { assertOnline } from './availability.js';
import {
  ACTIVE_STATUSES,
  activeSession,
  addGuestPlayer,
  PLAYER_START_TIMEOUT_MS,
  remainingMs,
  slotStatus,
  startGuestSession,
} from './sessions.js';
import { liveChatStatus, resetLiveChat } from './live-chat.js';

/**
 * Modo live: o espectador da live do YouTube entra numa sala com um apelido e
 * o dono escolhe quem joga. Quem é escolhido ganha uma sessão de convidado
 * (sem pagamento, com tempo fixo) e a página /live mostra o botão de jogar.
 *
 * A sala (apelidos) fica só em memória; a configuração e a sessão são do state.
 */

const STALE_MS = 25_000; // sem sinal de vida (heartbeat) por tanto tempo → sai da sala
const MISSED_TURN_TTL_MS = 30 * 60_000;
const MAX_VIEWERS = 200;

/** viewerId (segredo do espectador) → { id, pub, nick, joinedAt, seenAt } */
const lobby = new Map();
const missedTurns = new Map();

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
  const nextEnabled = Boolean(enabled);
  const current = liveSettings();
  if (nextEnabled && !videoId) {
    throw bad('Cole um link válido de live do YouTube.', 'invalid_live_url');
  }
  store.mutate((state) => {
    state.live = { enabled: nextEnabled, videoId: videoId ?? state.live?.videoId ?? null };
    pushEvent(state, 'live.configured', { enabled: state.live.enabled, videoId: state.live.videoId });
  });
  if (!nextEnabled) {
    lobby.clear();
    missedTurns.clear();
    resetLiveChat(false);
  } else if (!current.enabled || current.videoId !== videoId) {
    resetLiveChat(true);
  }
  bus.emit('state:changed');
  return liveSettings();
}

export function stopLive() {
  store.mutate((state) => {
    state.live = { enabled: false, videoId: null };
    pushEvent(state, 'live.stopped');
  });
  lobby.clear();
  missedTurns.clear();
  resetLiveChat(false);
  bus.emit('state:changed');
  return liveSettings();
}

function prune(t = now()) {
  for (const [key, viewer] of lobby) {
    if (t - viewer.seenAt > STALE_MS) lobby.delete(key);
  }
  for (const [key, missed] of missedTurns) {
    if (t - missed.at > MISSED_TURN_TTL_MS) missedTurns.delete(key);
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
  const enabledNow = Boolean(enabled && videoId);
  const queue = [...lobby.values()]
    .filter((viewer) => !activeSession?.players?.some((player) => player.viewerId === viewer.id)
      && (activeSession?.players || viewer.id !== activeSession?.guestViewerId))
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((viewer) => viewer.nick);
  const timeLeft = session?.status === 'active' ? remainingMs(session, t) : 0;
  const playing = enabledNow && timeLeft > 0
    ? (config.multiplayer
        ? {
            name: session.customer.name,
            players: (session.players ?? []).map((player) => ({ slot: player.slot, name: player.name })),
            remainingMs: timeLeft,
          }
        : { name: session.customer.name, remainingMs: timeLeft })
    : null;
  const chat = liveChatStatus();

  return {
    enabled: enabledNow,
    videoId: enabledNow ? videoId : null,
    viewers: lobby.size,
    queue,
    playing,
    chatEnabled: Boolean(enabled && videoId && chat.enabled),
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

export function liveChatIdentity(viewerId) {
  const { enabled, videoId } = liveSettings();
  if (!enabled || !videoId) {
    throw conflict('O chat está disponível apenas durante a live.', 'live_disabled');
  }
  const key = String(viewerId ?? '');
  prune();
  const viewer = lobby.get(key);
  if (viewer) {
    viewer.seenAt = now();
    return viewer.nick;
  }
  const session = store.data.session;
  const player = (session?.players ?? []).find((item) => item.viewerId === key);
  if (ACTIVE_STATUSES.includes(session?.status)) {
    if (player) return player.name;
    if (!session.players && session.guestViewerId === key) return session.customer.name;
  }
  throw new ApiError(403, 'not_in_queue', 'Entre na fila para acessar o chat.');
}

/** Heartbeat + resposta: "sou eu o escolhido?" */
export function viewerStatus(viewerId, t = now()) {
  prune(t);
  const key = String(viewerId ?? '');
  const session = store.data.session;
  const player = (session?.players ?? []).find((item) => item.viewerId === key)
    ?? (!Array.isArray(session?.players) && session?.guestViewerId === key ? {
      slot: 1,
      name: session.customer.name,
      token: session.token,
    } : null);
  const chosen = Boolean(player && ['provisioning', 'active'].includes(session.status));

  const viewer = lobby.get(key);
  if (viewer) viewer.seenAt = t;
  const settings = liveSettings();

  if (chosen) {
    return {
      joined: true,
      enabled: Boolean(settings.enabled),
      chosen: true,
      nick: player.name,
      playerSlot: player.slot,
      playUrl: `/play.html?s=${encodeURIComponent(player.token)}`,
      sessionStatus: session.status,
      endsAt: session.endsAt,
      serverNow: t,
      joinDeadlineAt: Number.isFinite(player.selectedAt)
        && (player.viewer?.connections ?? 0) === 0
        ? player.selectedAt + PLAYER_START_TIMEOUT_MS
        : null,
    };
  }
  const missed = missedTurns.get(key);
  return {
    joined: Boolean(viewer),
    enabled: Boolean(settings.enabled),
    chosen: false,
    nick: viewer?.nick ?? missed?.nick ?? null,
    turnMissed: Boolean(missed),
  };
}

export function adminLive(t = now()) {
  prune(t);
  const settings = liveSettings();
  return {
    enabled: Boolean(settings.enabled),
    videoId: settings.videoId,
    chat: liveChatStatus(),
    viewers: [...lobby.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((v) => ({ pub: v.pub, nick: v.nick, joinedAt: v.joinedAt })),
  };
}

export function pickViewer(pub, minutesInput, playerCountInput = 1) {
  const settings = liveSettings();
  if (!settings.enabled) throw conflict('A live está desativada.', 'live_disabled');
  const minutes = Math.trunc(Number(minutesInput));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > config.maxGuestMinutes) {
    throw bad(`Escolha de 1 a ${config.maxGuestMinutes} minutos.`, 'invalid_minutes');
  }
  const playerCount = Math.trunc(Number(playerCountInput));
  if (!Number.isFinite(playerCount) || playerCount < 1
    || playerCount > config.maxRemotePlayers
    || (playerCount > 1 && !config.multiplayer)) {
    throw bad('Escolha 1 jogador ou habilite o modo de 2 jogadores.', 'invalid_player_count');
  }
  prune();
  const viewer = [...lobby.values()].find((v) => v.pub === String(pub ?? ''));
  if (!viewer) throw notFound('Esse espectador saiu da sala.');
  assertOnline();
  const slot = slotStatus();
  if (slot.status !== 'free' && !config.multiplayer) {
    throw conflict('O Xbox está ocupado ou reservado. Encerre a sessão atual antes.', 'slot_busy');
  }
  if (slot.status !== 'free') {
    const result = addGuestPlayer({ nick: viewer.nick, minutes, viewerId: viewer.id });
    if (!result) throw conflict('A sessão já está cheia ou não aceita outro jogador.', 'slot_busy');
    return {
      nick: viewer.nick,
      minutes: Math.ceil(remainingMs(result.session) / 60_000),
      playerSlot: result.player.slot,
    };
  }
  const session = startGuestSession({
    nick: viewer.nick,
    minutes,
    viewerId: viewer.id,
    playerCount,
  });
  if (!session) throw conflict('O Xbox ficou ocupado.', 'slot_busy');
  return { nick: viewer.nick, minutes, playerSlot: 1, playerCount };
}

function advanceAfterPlayerTimeout({ session, players }) {
  const t = now();
  for (const player of players) {
    const viewer = lobby.get(player.viewerId);
    if (!viewer) continue;
    lobby.delete(player.viewerId);
    missedTurns.set(player.viewerId, { nick: viewer.nick, at: t });
  }

  const settings = liveSettings();
  if (!settings.enabled || !settings.videoId) return;

  let target = activeSession();
  if (!target && session?.endedReason !== 'player_timeout') return;
  if (!target && store.data.session?.id === session?.id && session.status === 'ended') {
    const next = [...lobby.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!next) return;
    target = startGuestSession({
      nick: next.nick,
      minutes: Math.max(1, Math.ceil(session.durationMs / 60_000)),
      viewerId: next.id,
      playerCount: session.maxPlayers ?? 1,
    });
    if (!target) return;
  }

  while (target && target.players.length < (target.maxPlayers ?? 1)) {
    const playerIds = new Set(target.players.map((player) => player.viewerId));
    const next = [...lobby.values()]
      .filter((viewer) => !playerIds.has(viewer.id))
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!next) break;
    const minutes = Math.max(1, Math.ceil(remainingMs(target) / 60_000));
    const added = addGuestPlayer({ nick: next.nick, minutes, viewerId: next.id });
    if (!added) break;
    target = added.session;
  }
}

bus.on('session:players_timed_out', advanceAfterPlayerTimeout);

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
  missedTurns.clear();
}
