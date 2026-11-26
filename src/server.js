import http from 'node:http';
import { exec } from 'node:child_process';
import path from 'node:path';

import { config } from './config.js';
import { createApp, jsonBody, staticFiles } from './web.js';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { ApiError, bad, conflict } from './errors.js';
import { log, now, safeEqual } from './util.js';
import {
  endSession,
  extendSession,
  publicSession,
  publicStatus,
  remainingMs,
  sessionView,
  slotStatus,
  tick,
} from './sessions.js';
import {
  ADMIN_COOKIE,
  checkPassword,
  isAdminRequest,
  issueAdminCookie,
  rateLimit,
  requireAdmin,
  resetRateLimit,
} from './security.js';
import { attachRealtime } from './realtime.js';
import {
  clearLiveChat,
  liveChatStatus,
  readLiveChat,
  resetLiveChat,
  sendLiveChatMessage,
  setLiveChatEnabled,
} from './live-chat.js';
import {
  adminLive,
  configureLive,
  joinLobby,
  kickViewer,
  liveChatIdentity,
  liveSettings,
  leaveLobby,
  pickViewer,
  publicLive,
  viewerStatus,
} from './live.js';

const app = createApp({ trustProxy: config.trustProxy });

const initialLive = liveSettings();
resetLiveChat(Boolean(initialLive.enabled && initialLive.videoId));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
    + "script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; "
    + 'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
  );
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(jsonBody({ limit: 64 * 1024 }));

const clientIP = (req) => req.ip || req.socket.remoteAddress || 'desconhecido';

function limit(req, key, max, windowMs) {
  const result = rateLimit(`${key}:${clientIP(req)}`, max, windowMs);
  if (!result.ok) {
    throw new ApiError(429, 'rate_limited', 'Muitas tentativas. Aguarde um pouco.', {
      retryAfterSec: result.retryAfterSec,
    });
  }
}

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* Público                                                            */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: now() });
});

app.get('/api/config', (_req, res) => {
  res.json({
    iceServers: config.iceServers,
    rules: {
      maxMinutes: config.maxGuestMinutes,
      defaultMinutes: config.defaultGuestMinutes,
      provisionTimeoutSec: config.provisionTimeoutSec,
    },
  });
});

app.get('/api/status', (_req, res) => {
  res.json(publicStatus());
});

/* Sala e chat dos espectadores da live */
app.get('/api/live', (_req, res) => {
  res.json(publicLive());
});

app.post('/api/live/join', (req, res) => {
  limit(req, 'live:join', 20, 10 * 60_000);
  res.status(201).json(joinLobby(req.body?.nick));
});

app.get('/api/live/me', (req, res) => {
  limit(req, 'live:me', 600, 60_000);
  res.json(viewerStatus(String(req.query.v ?? '')));
});

app.post('/api/live/leave', (req, res) => {
  leaveLobby(req.body?.viewerId);
  res.json({ ok: true });
});

app.post('/api/live/chat/read', (req, res) => {
  limit(req, 'live:chat:read', 6000, 60_000);
  liveChatIdentity(req.body?.viewerId);
  res.json({
    ...readLiveChat(req.body?.after, req.body?.revision),
    chatEnabled: liveChatStatus().enabled,
  });
});

app.post('/api/live/chat/send', (req, res) => {
  limit(req, 'live:chat:send', 12_000, 60_000);
  const viewerId = String(req.body?.viewerId ?? '');
  const nick = liveChatIdentity(viewerId);
  res.status(201).json(sendLiveChatMessage(viewerId, nick, req.body?.text));
});

/* ------------------------------------------------------------------ */
/* Sessão do jogador (por token)                                      */
/* ------------------------------------------------------------------ */

function sessionByToken(tokenValue) {
  const session = store.data.session;
  if (!session || !tokenValue || !safeEqual(session.token, tokenValue)) {
    throw new ApiError(401, 'invalid_token', 'Link de sessão inválido ou expirado.');
  }
  return session;
}

app.get('/api/session', (req, res) => {
  limit(req, 'session:view', 240, 60_000);
  res.json(sessionView(sessionByToken(String(req.query.s ?? '')).token));
});

app.post('/api/session/forfeit', (req, res) => {
  limit(req, 'session:forfeit', 10, 10 * 60_000);
  const { token: tokenValue, confirm } = req.body ?? {};
  if (confirm !== true) throw bad('Confirmação obrigatória.', 'confirm_required');
  const session = sessionByToken(tokenValue);
  if (!['active', 'provisioning'].includes(session.status)) {
    throw conflict('Esta sessão já foi encerrada.', 'session_already_ended');
  }
  const ended = endSession('forfeited', { sessionID: session.id, by: 'player' });
  res.json({ ok: true, ended: Boolean(ended), status: ended?.status ?? session.status });
});

/* ------------------------------------------------------------------ */
/* Admin                                                              */
/* ------------------------------------------------------------------ */

app.post('/api/admin/login', (req, res) => {
  const key = `admin:login:${clientIP(req)}`;
  const rl = rateLimit(key, 8, 10 * 60_000);
  if (!rl.ok) {
    throw new ApiError(429, 'rate_limited', 'Muitas tentativas. Aguarde.', {
      retryAfterSec: rl.retryAfterSec,
    });
  }
  if (!checkPassword(req.body?.password ?? '')) {
    throw new ApiError(401, 'invalid_password', 'Senha incorreta.');
  }
  resetRateLimit(key);
  const cookie = issueAdminCookie();
  res.cookie(ADMIN_COOKIE, cookie.value, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: cookie.maxAgeSec * 1000,
    path: '/',
    secure: config.baseUrl.startsWith('https://'),
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ admin: isAdminRequest(req) });
});

app.get('/api/admin/overview', (req, res) => {
  requireAdmin(req);
  const state = store.data;
  const s = state.session;

  res.json({
    serverNow: now(),
    baseUrl: config.baseUrl,
    presence: realtime.presence(),
    counters: state.counters,
    slot: slotStatus(),
    session: s
      ? {
          id: s.id,
          status: s.status,
          player: s.customer.name,
          createdAt: s.createdAt,
          startedAt: s.startedAt,
          endsAt: s.endsAt,
          remainingMs: remainingMs(s),
          minutes: Math.round(s.durationMs / 60_000),
          streamReady: s.streamReady,
          viewerConnected: Boolean(s.viewer?.connected),
          endedReason: s.endedReason,
          playUrl: `${config.baseUrl}/play.html?s=${encodeURIComponent(s.token)}`,
        }
      : null,
    live: adminLive(),
    events: state.events.slice(0, 40),
    config: {
      maxMinutes: config.maxGuestMinutes,
      defaultMinutes: config.defaultGuestMinutes,
      provisionTimeoutSec: config.provisionTimeoutSec,
      xboxPowerConfigured: Boolean(config.xboxPowerOnCmd || config.xboxPowerOffCmd),
    },
  });
});

app.get('/api/admin/host-key', (req, res) => {
  requireAdmin(req);
  res.json({ hostKey: config.hostKey });
});

app.post('/api/admin/action', asyncH(async (req, res) => {
  requireAdmin(req);
  const { action, ...payload } = req.body ?? {};

  switch (action) {
    case 'live_set': {
      const settings = configureLive({ url: payload.url, enabled: payload.enabled });
      return res.json({ ok: true, live: settings });
    }

    case 'live_chat_toggle': {
      const live = liveSettings();
      if (!live.enabled || !live.videoId) throw conflict('A live não está aberta.', 'live_disabled');
      return res.json({ ok: true, chat: setLiveChatEnabled(payload.enabled) });
    }

    case 'live_chat_clear': {
      const live = liveSettings();
      if (!live.enabled || !live.videoId) throw conflict('A live não está aberta.', 'live_disabled');
      return res.json({ ok: true, chat: clearLiveChat() });
    }

    case 'live_pick': {
      const picked = pickViewer(payload.pub, payload.minutes);
      bus.emit('state:changed');
      return res.json({ ok: true, ...picked });
    }

    case 'live_kick':
      return res.json({ ok: true, removed: kickViewer(payload.pub) });

    case 'end_session': {
      const ended = endSession(String(payload.reason ?? 'admin'), { by: 'admin' });
      return res.json({ ok: true, ended: Boolean(ended) });
    }

    case 'extend': {
      const minutes = Math.trunc(Number(payload.minutes));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > config.maxGuestMinutes) {
        throw bad(`Escolha de 1 a ${config.maxGuestMinutes} minutos.`, 'invalid_minutes');
      }
      const session = extendSession(minutes);
      if (!session) throw conflict('Não há sessão ativa.', 'no_active_session');
      bus.emit('state:changed');
      return res.json({ ok: true, session: publicSession(session) });
    }

    case 'xbox_power': {
      const which = payload.mode === 'off' ? 'off' : 'on';
      const cmd = which === 'on' ? config.xboxPowerOnCmd : config.xboxPowerOffCmd;
      if (!cmd) throw bad('Comando de energia do Xbox não configurado.', 'xbox_power_not_configured');
      const output = await runCommand(cmd);
      store.mutate((state) => {
        pushEvent(state, 'xbox.power', { mode: which, ok: output.ok }, output.ok ? 'info' : 'error');
      });
      return res.json(output);
    }

    case 'reset_session_state': {
      // Último recurso: libera uma sessão travada.
      endSession('admin_reset', { by: 'admin' });
      store.mutate((state) => pushEvent(state, 'admin.reset', {}, 'warn'));
      bus.emit('state:changed');
      return res.json({ ok: true });
    }

    default:
      throw bad('Ação desconhecida.', 'unknown_action');
  }
}));

function runCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout ?? '').slice(0, 2000),
        stderr: String(stderr ?? '').slice(0, 2000),
        code: err?.code ?? 0,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Páginas                                                            */
/* ------------------------------------------------------------------ */

app.get('/', (_req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(config.publicDir, 'play.html')));
app.get('/host', (_req, res) => res.sendFile(path.join(config.publicDir, 'host.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(config.publicDir, 'admin.html')));
app.use(staticFiles(config.publicDir));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: { code: 'not_found', message: 'Rota não encontrada.' } });
    return;
  }
  res.status(404).send('Não encontrado.');
});

app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...err.extra },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'JSON inválido.' } });
  }
  console.error('[http]', err);
  res.status(500).json({ error: { code: 'internal', message: 'Erro interno.' } });
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);
const realtime = attachRealtime(server);

const scheduler = setInterval(() => {
  try {
    tick();
  } catch (err) {
    console.error('[tick]', err);
  }
}, 1000);
scheduler.unref?.();

server.listen(config.port, '0.0.0.0', () => {
  const generated = (name) => !process.env[name];
  log('──────────────────────────────────────────────');
  log(`Play Live no ar em http://localhost:${config.port}`);
  log(`Página da live    : ${config.baseUrl}/`);
  log(`Painel admin      : ${config.baseUrl}/admin`);
  log(`Host de captura   : ${config.baseUrl}/host`);
  if (generated('ADMIN_PASSWORD')) log(`Senha admin gerada: ${config.adminPassword}`);
  if (generated('HOST_KEY')) log(`Chave do host     : ${config.hostKey}`);
  log('──────────────────────────────────────────────');
});

function shutdown() {
  log('Encerrando...');
  clearInterval(scheduler);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
