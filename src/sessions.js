import { config } from './config.js';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { ApiError } from './errors.js';
import { id, now } from './util.js';
import { availability } from './availability.js';

export const ACTIVE_STATUSES = ['provisioning', 'active'];
const PLAYER_START_TIMEOUT_MS = 30_000;

export function activeSession(state = store.data) {
  const s = state.session;
  return s && ACTIVE_STATUSES.includes(s.status) ? s : null;
}

/** busy → alguém jogando (ou preparando) · free → livre */
export function slotStatus(state = store.data) {
  const session = activeSession(state);
  if (!session) return { status: 'free' };
  return {
    status: 'busy',
    until: session.endsAt,
    sessionStatus: session.status,
    streamReady: Boolean(session.streamReady),
  };
}

export function remainingMs(session, t = now()) {
  if (!session || !session.endsAt) return 0;
  return Math.max(0, session.endsAt - t);
}

export function publicSession(session, t = now()) {
  if (!session) return null;
  const players = (session.players ?? []).map((player) => ({
    slot: player.slot,
    name: player.name,
    connected: Boolean(player.viewer?.connected),
    inputEnabled: player.inputEnabled !== false,
  }));
  return {
    status: session.status,
    streamReady: Boolean(session.streamReady),
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    remainingMs: remainingMs(session, t),
    minutes: Math.round(session.durationMs / 60_000),
    failedProvision: session.status === 'provisioning'
      && t - session.createdAt > config.provisionTimeoutSec * 1000,
    ...(config.multiplayer
      ? { players, playerCount: players.length, maxPlayers: session.maxPlayers ?? 1 }
      : {}),
  };
}

/** Estado público (página da live, polling) — sem token nem id interno. */
export function publicStatus(t = now(), state = store.data) {
  const session = activeSession(state);
  return {
    serverNow: t,
    slot: slotStatus(state),
    session: session
      ? { ...publicSession(session, t), player: session.customer.name }
      : null,
    availability: availability(),
  };
}

/** Visão do jogador (por token). */
export function sessionView(tokenValue) {
  const t = now();
  const session = store.data.session;
  if (!session) {
    throw new ApiError(401, 'invalid_token', 'Link de sessão inválido ou expirado.');
  }
  const player = (session.players ?? []).find((item) => item.token === tokenValue);
  const legacy = session.token === tokenValue;
  if (!player && (!legacy || (config.multiplayer && Array.isArray(session.players)))) {
    throw new ApiError(401, 'invalid_token', 'Link de sessão inválido ou expirado.');
  }
  const slot = player?.slot ?? 1;
  const name = player?.name ?? session.customer?.name;
  return {
    serverNow: t,
    id: session.id,
    status: session.status,
    customer: { name },
    playerSlot: slot,
    ...(config.multiplayer ? {
      players: (session.players ?? []).map((item) => ({
        slot: item.slot,
        name: item.name,
        connected: Boolean(item.viewer?.connected),
        inputEnabled: item.inputEnabled !== false,
      })),
    } : {}),
    controllerEnabled: player?.inputEnabled !== false,
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    remainingMs: remainingMs(session, t),
    minutes: Math.round(session.durationMs / 60_000),
    streamReady: Boolean(session.streamReady),
    playerUrl: `${config.baseUrl}/play.html?s=${encodeURIComponent(tokenValue)}`,
    warnings: session.warningsSent,
    endedReason: session.endedReason,
  };
}

/**
 * O dono escolheu um espectador: cria a sessão com tempo fixo em minutos.
 * O relógio só começa quando o host avisa que a transmissão subiu.
 */
export function startGuestSession({ nick, minutes, viewerId, playerCount = 1 }) {
  const t = now();
  return store.mutate((state) => {
    if (activeSession(state)) return null;
    const token = id('tok_') + id('');
    const session = {
      id: id('ses_'),
      token,
      createdAt: t,
      startedAt: null,
      endsAt: null,
      status: 'provisioning',
      guestViewerId: viewerId,
      durationMs: minutes * 60_000,
      customer: { name: nick },
      maxPlayers: playerCount,
      warningsSent: [],
      streamReady: false,
      viewer: { connected: false, lastSeenAt: null, connections: 0 },
      players: [{
        slot: 1,
        viewerId,
        name: nick,
        token,
        selectedAt: t,
        viewer: { connected: false, lastSeenAt: null, connections: 0 },
        inputEnabled: true,
      }],
      endedAt: null,
      endedReason: null,
    };
    state.session = session;
    state.counters.sessionsTotal += 1;
    pushEvent(state, 'session.created', { sessionID: session.id, nick, minutes });
    bus.emit('session:created', { session });
    return session;
  });
}

/** Adiciona um segundo espectador remoto à sessão ativa em modo multiplayer. */
export function addGuestPlayer({ nick, minutes, viewerId }) {
  if (!config.multiplayer || config.maxRemotePlayers < 2) return null;
  return store.mutate((state) => {
    const session = state.session;
    if (!session || !ACTIVE_STATUSES.includes(session.status)) return null;
    if (!Array.isArray(session.players)) {
      session.players = [{
        slot: 1,
        viewerId: session.guestViewerId,
        name: session.customer.name,
        token: session.token,
        viewer: session.viewer ?? { connected: false, lastSeenAt: null, connections: 0 },
        inputEnabled: true,
      }];
    }
    const playerLimit = session.maxPlayers ?? 1;
    if (session.players.length >= playerLimit) return null;
    if (session.players?.some((player) => player.viewerId === viewerId)) return null;
    const slot = Array.from({ length: playerLimit }, (_, index) => index + 1)
      .find((candidate) => !session.players.some((player) => player.slot === candidate));
    if (!slot) return null;

    const token = id('tok_') + id('');
    const player = {
      slot,
      viewerId,
      name: nick,
      token,
      selectedAt: now(),
      viewer: { connected: false, lastSeenAt: null, connections: 0 },
      inputEnabled: true,
    };
    session.players = [...(session.players ?? []), player];
    session.customer = { name: `${session.customer.name} + ${nick}` };
    pushEvent(state, 'session.player_added', {
      sessionID: session.id,
      nick,
      minutes,
      slot: player.slot,
    });
    bus.emit('session:player_added', { session, player });
    return { session, player };
  });
}

/** Bloqueia ou reativa a entrada de controle de um slot individual. */
export function setPlayerControl(slot, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new ApiError(400, 'invalid_player_control', 'Estado de controle inválido.');
  }
  const result = store.mutate((state) => {
    const session = state.session;
    if (!session || !ACTIVE_STATUSES.includes(session.status)) {
      throw new ApiError(409, 'no_active_session', 'Não há sessão ativa.');
    }
    const player = (session.players ?? []).find((item) => item.slot === slot);
    if (!player) throw new ApiError(404, 'player_not_found', 'Jogador não encontrado.');
    const changed = player.inputEnabled !== enabled;
    player.inputEnabled = enabled;
    if (changed) {
      pushEvent(state, 'session.player_control', {
        sessionID: session.id,
        slot,
        enabled,
      }, enabled ? 'info' : 'warn');
    }
    return { player, changed };
  });
  if (result.changed) {
    bus.emit('session:player_control', { playerSlot: slot, enabled });
    bus.emit('state:changed');
  }
  return { playerSlot: slot, enabled };
}

/** Remove um jogador sem encerrar os demais na mesma sessão multiplayer. */
export function forfeitGuestPlayer(tokenValue) {
  if (!config.multiplayer) return null;
  const t = now();
  const result = store.mutate((state) => {
    const session = state.session;
    if (!session || !ACTIVE_STATUSES.includes(session.status)) return null;
    const index = (session.players ?? []).findIndex((player) => player.token === tokenValue);
    if (index < 0) return null;
    const [player] = session.players.splice(index, 1);
    player.viewer.connected = false;
    if (session.players.length === 0) {
      session.status = 'forfeited';
      session.endedReason = 'forfeited';
      session.endedAt = t;
      session.streamReady = false;
      if (session.startedAt) state.counters.minutesPlayed += Math.round((t - session.startedAt) / 60_000);
      pushEvent(state, 'session.ended', { sessionID: session.id, reason: 'forfeited', by: 'player' }, 'warn');
      return { session, player, ended: true };
    }

    session.customer = { name: session.players.map((item) => item.name).join(' + ') };
    pushEvent(state, 'session.player_forfeited', {
      sessionID: session.id,
      nick: player.name,
      slot: player.slot,
    }, 'warn');
    return { session, player, ended: false };
  });

  if (!result) return null;
  if (result.ended) {
    bus.emit('session:ended', { session: result.session, reason: 'forfeited' });
  } else {
    bus.emit('session:player_ended', { session: result.session, player: result.player });
  }
  return result;
}

/** Host avisou que a captura está publicando. Aqui o relógio começa. */
export function markStreamReady(sessionID) {
  const t = now();
  const result = store.mutate((state) => {
    const s = state.session;
    if (!s || s.id !== sessionID) return null;
    if (s.status !== 'provisioning') {
      if (s.status === 'active') {
        s.streamReady = true;
        return { changed: false, session: s };
      }
      return null;
    }
    s.streamReady = true;
    s.startedAt = t;
    s.endsAt = t + s.durationMs;
    s.status = 'active';
    pushEvent(state, 'session.started', { sessionID: s.id, endsAt: s.endsAt });
    return { changed: true, session: s };
  });

  if (result?.changed) bus.emit('session:started', { session: result.session });
  return result?.session ?? null;
}

/** Dono soma minutos à sessão em andamento. */
export function extendSession(minutes) {
  const extended = store.mutate((state) => {
    const s = state.session;
    if (!s || s.status !== 'active' || now() >= s.endsAt) return null;
    s.durationMs += minutes * 60_000;
    s.endsAt += minutes * 60_000;
    s.warningsSent = [];
    pushEvent(state, 'session.extended', { sessionID: s.id, minutes }, 'info');
    return s;
  });
  if (extended) bus.emit('session:extended', { session: extended });
  return extended;
}

export function endSession(reason, { sessionID = null, by = 'system' } = {}) {
  const t = now();
  const ended = store.mutate((state) => {
    const s = state.session;
    if (!s) return null;
    if (sessionID && s.id !== sessionID) return null;
    if (!ACTIVE_STATUSES.includes(s.status)) return null;

    s.status = reason === 'forfeited' ? 'forfeited' : 'ended';
    s.endedReason = reason;
    s.endedAt = t;
    s.streamReady = false;
    if (s.startedAt) state.counters.minutesPlayed += Math.round((t - s.startedAt) / 60_000);

    pushEvent(state, 'session.ended', {
      sessionID: s.id,
      reason,
      by,
      playedMs: s.startedAt ? t - s.startedAt : 0,
    }, reason === 'forfeited' ? 'warn' : 'info');
    return s;
  });

  if (ended) bus.emit('session:ended', { session: ended, reason });
  return ended;
}

/** Tick do relógio: avisos de fim, expiração e transmissão que não subiu. */
export function tick(t = now()) {
  const current = store.data.session;
  if (!current || !ACTIVE_STATUSES.includes(current.status)) {
    return { warnings: [], sessionEnded: null, provisionFailed: null, playersTimedOut: [] };
  }

  const warnings = [];
  let sessionEnded = null;
  let provisionFailed = null;
  let playersTimedOut = [];

  store.mutate((state) => {
    const s = state.session;

    playersTimedOut = (s.players ?? []).filter((player) => (
      Number.isFinite(player.selectedAt)
      && t - player.selectedAt >= PLAYER_START_TIMEOUT_MS
      && (player.viewer?.connections ?? 0) === 0
    ));
    if (playersTimedOut.length) {
      const timedOutIds = new Set(playersTimedOut.map((player) => player.viewerId));
      s.players = (s.players ?? []).filter((player) => !timedOutIds.has(player.viewerId));
      for (const player of playersTimedOut) {
        pushEvent(state, 'session.player_timeout', {
          sessionID: s.id,
          nick: player.name,
          slot: player.slot,
          timeoutSec: PLAYER_START_TIMEOUT_MS / 1000,
        }, 'warn');
      }

      if (s.players.length) {
        s.customer = { name: s.players.map((player) => player.name).join(' + ') };
      } else {
        s.status = 'ended';
        s.endedReason = 'player_timeout';
        s.endedAt = t;
        s.streamReady = false;
        pushEvent(state, 'session.ended', {
          sessionID: s.id,
          reason: 'player_timeout',
        }, 'warn');
        sessionEnded = s;
      }
    }

    if (s.status === 'active') {
      const left = s.endsAt - t;
      for (const minutes of [5, 1]) {
        const key = String(minutes);
        if (left <= minutes * 60_000 && left > 0 && !s.warningsSent.includes(key)) {
          s.warningsSent.push(key);
          warnings.push({ minutes, remainingMs: left });
        }
      }
      if (left <= 0) {
        s.status = 'ended';
        s.endedReason = 'time_up';
        s.endedAt = t;
        s.streamReady = false;
        state.counters.minutesPlayed += Math.round((t - s.startedAt) / 60_000);
        pushEvent(state, 'session.ended', { sessionID: s.id, reason: 'time_up' });
        sessionEnded = s;
      }
    } else if (s.status === 'provisioning'
      && t - s.createdAt > config.provisionTimeoutSec * 1000) {
      // O host não subiu a transmissão: o relógio nunca começou. Libera a vaga.
      s.status = 'ended';
      s.endedReason = 'provision_timeout';
      s.endedAt = t;
      s.streamReady = false;
      pushEvent(state, 'session.provision_failed', {
        sessionID: s.id,
        timeoutSec: config.provisionTimeoutSec,
      }, 'warn');
      provisionFailed = s;
    }
  });

  for (const w of warnings) bus.emit('session:warning', w);
  if (sessionEnded) {
    bus.emit('session:ended', { session: sessionEnded, reason: sessionEnded.endedReason });
  }
  if (provisionFailed) {
    bus.emit('session:ended', { session: provisionFailed, reason: 'provision_timeout' });
  }
  if (playersTimedOut.length) {
    bus.emit('session:players_timed_out', { session: store.data.session, players: playersTimedOut });
  }
  if (warnings.length || sessionEnded || provisionFailed || playersTimedOut.length) bus.emit('state:changed');

  return { warnings, sessionEnded, provisionFailed, playersTimedOut };
}
