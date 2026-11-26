import { config } from './config.js';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { ApiError } from './errors.js';
import { id, now } from './util.js';
import { availability } from './availability.js';

export const ACTIVE_STATUSES = ['provisioning', 'active'];

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
  return {
    status: session.status,
    streamReady: Boolean(session.streamReady),
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    remainingMs: remainingMs(session, t),
    minutes: Math.round(session.durationMs / 60_000),
    failedProvision: session.status === 'provisioning'
      && t - session.createdAt > config.provisionTimeoutSec * 1000,
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
  if (!session || session.token !== tokenValue) {
    throw new ApiError(401, 'invalid_token', 'Link de sessão inválido ou expirado.');
  }
  return {
    serverNow: t,
    id: session.id,
    status: session.status,
    customer: { name: session.customer.name },
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    remainingMs: remainingMs(session, t),
    minutes: Math.round(session.durationMs / 60_000),
    streamReady: Boolean(session.streamReady),
    playerUrl: `${config.baseUrl}/play.html?s=${encodeURIComponent(session.token)}`,
    warnings: session.warningsSent,
    endedReason: session.endedReason,
  };
}

/**
 * O dono escolheu um espectador: cria a sessão com tempo fixo em minutos.
 * O relógio só começa quando o host avisa que a transmissão subiu.
 */
export function startGuestSession({ nick, minutes, viewerId }) {
  const t = now();
  return store.mutate((state) => {
    if (activeSession(state)) return null;
    const session = {
      id: id('ses_'),
      token: id('tok_') + id(''),
      createdAt: t,
      startedAt: null,
      endsAt: null,
      status: 'provisioning',
      guestViewerId: viewerId,
      durationMs: minutes * 60_000,
      customer: { name: nick },
      warningsSent: [],
      streamReady: false,
      viewer: { connected: false, lastSeenAt: null, connections: 0 },
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
    return { warnings: [], sessionEnded: null, provisionFailed: null };
  }

  const warnings = [];
  let sessionEnded = null;
  let provisionFailed = null;

  store.mutate((state) => {
    const s = state.session;

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
  if (sessionEnded) bus.emit('session:ended', { session: sessionEnded, reason: 'time_up' });
  if (provisionFailed) {
    bus.emit('session:ended', { session: provisionFailed, reason: 'provision_timeout' });
  }
  if (warnings.length || sessionEnded || provisionFailed) bus.emit('state:changed');

  return { warnings, sessionEnded, provisionFailed };
}
