/**
 * Ponte de controle (bridge) — roda no PC host.
 *
 * Conecta no servidor como `bridge`, recebe os eventos de gamepad do cliente
 * e aplica em um controle Xbox 360 virtual (ViGEmBus) para o jogo no PC.
 *
 * Uso (na raiz do projeto):
 *   npm run bridge                 # controle virtual real (Windows + ViGEmBus)
 *   npm run bridge -- --dry-run    # só mostra o que seria aplicado
 *
 * Opções / variáveis de ambiente:
 *   --url / BRIDGE_URL      ws://localhost:8080/ws  (ou wss://seu-dominio.com/ws)
 *   --key / HOST_KEY        chave do host (padrão: lê data/host-key.txt)
 *   --python / BRIDGE_PYTHON  executável do Python (padrão: python no Windows)
 *   --dry-run / BRIDGE_DRY_RUN=1
 *   --local-port / BRIDGE_LOCAL_PORT   porta do canal local (padrão 8765; 0 desliga)
 *   BRIDGE_ALLOWED_ORIGINS  origens extras aceitas no canal local (separadas por vírgula)
 *
 * Caminhos dos comandos:
 *   P2P (preferido): player ──WebRTC DataChannel──> /host (navegador) ──ws://127.0.0.1──> ponte
 *   Reserva:         player ──WebSocket──> servidor ──WebSocket──> ponte
 * Nos dois casos a ponte só aplica comandos enquanto o SERVIDOR diz que há
 * sessão ativa; o canal local nunca decide isso sozinho.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWebSocketServer } from '../../src/ws.js';
import { safeEqual } from '../../src/util.js';

import { ALL_BUTTONS, isNeutral, mapPayload, neutralState, sameState } from './mapping.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const WATCHDOG_MS = 3000; // o player reenvia ao menos 1x/s; sem sinal → solta tudo
const PING_MS = 20_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 10_000;
const DEFAULT_LOCAL_PORT = 8765;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Origem do site a partir da URL do servidor (wss://x/ws → https://x). */
export function originFromServerUrl(url) {
  try {
    const u = new URL(url);
    const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sinks: onde o estado do controle é aplicado                         */
/* ------------------------------------------------------------------ */

export function summarize(state) {
  const parts = [];
  if (state.buttons.length) parts.push(state.buttons.join('+'));
  if (state.lt) parts.push(`LT=${state.lt}`);
  if (state.rt) parts.push(`RT=${state.rt}`);
  if (state.lx || state.ly) parts.push(`L=(${state.lx},${state.ly})`);
  if (state.rx || state.ry) parts.push(`R=(${state.rx},${state.ry})`);
  return parts.length ? parts.join(' ') : 'neutro';
}

export function dryRunSink(log = console.log) {
  return {
    name: 'dry-run',
    async start() {},
    apply(state) {
      log(`[dry-run] ${summarize(state)}`);
    },
    async close() {},
  };
}

/** Controle Xbox 360 virtual via tools/gamepad-bridge/vpad.py (vgamepad/ViGEmBus). */
export function vigemSink({ python, log = console.log, onExit = () => {} }) {
  const script = path.join(here, 'vpad.py');
  let child = null;
  let closing = false;

  return {
    name: 'ViGEmBus',

    start() {
      return new Promise((resolve, reject) => {
        child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let buffer = '';
        let settled = false;

        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };

        const timer = setTimeout(
          () => settle(reject, new Error('O controle virtual não respondeu em 15 s.')),
          15_000,
        );

        child.on('error', (err) => {
          const hint = err.code === 'ENOENT'
            ? ` Python não encontrado ("${python}"). Instale o Python 3 e marque "Add to PATH", ou use --python.`
            : '';
          settle(reject, new Error(`Não foi possível iniciar o Python.${hint}`));
        });

        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.ready) settle(resolve);
            if (msg.error) {
              if (!settled) settle(reject, new Error(msg.error));
              else log(`[vpad] ${msg.error}`);
            }
          }
        });

        child.stderr.on('data', (chunk) => {
          const text = chunk.toString().trim();
          if (text) log(`[vpad] ${text}`);
        });

        child.on('exit', (code) => {
          if (!settled) {
            settle(reject, new Error(`O controle virtual terminou (código ${code}).`));
          } else if (!closing) {
            onExit(code);
          }
        });
      });
    },

    apply(state) {
      if (!child || child.killed || !child.stdin.writable) {
        throw new Error('controle virtual indisponível');
      }
      child.stdin.write(`${JSON.stringify(state)}\n`);
    },

    async close() {
      closing = true;
      if (!child) return;
      try {
        child.stdin.write(`${JSON.stringify(neutralState())}\n`);
        child.stdin.end();
      } catch {
        /* já fechou */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 1500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cliente WebSocket                                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {string} options.url      endpoint ws(s)://.../ws
 * @param {string} options.key      chave do host
 * @param {object} options.sink     { apply(state), close() }
 * @param {Function} [options.log]
 * @param {Function} [options.onFatal] erro sem retry (ex.: chave inválida)
 * @param {number} [options.watchdogMs]
 */
export function createBridge({
  url,
  key,
  sink,
  log = console.log,
  onFatal = () => {},
  watchdogMs = WATCHDOG_MS,
  WebSocketImpl = globalThis.WebSocket,
  localPort = null, // null = canal local desligado; 0 = porta efêmera (testes)
  allowedOrigins = [],
}) {
  let ws = null;
  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  let pingTimer = null;
  let watchdogTimer = null;

  let sessionActive = false;
  const appliedBySlot = new Map([[1, neutralState()]]);
  const inputEnabledBySlot = new Map();
  const lastInputBySlot = new Map();
  const stats = { inputs: 0, applied: 0, ignored: 0, releases: 0, localInputs: 0, wsInputs: 0 };

  // Canal local: o /host (navegador) entrega aqui os comandos recebidos por P2P.
  let localServer = null;
  let localClient = null;
  let lastSource = 'ws';
  const origins = new Set([originFromServerUrl(url), ...allowedOrigins].filter(Boolean));

  function safeApply(state) {
    const slot = Number(state?.playerSlot ?? 1);
    try {
      const tagged = { ...state, playerSlot: slot };
      sink.apply(tagged);
      appliedBySlot.set(slot, tagged);
      stats.applied++;
    } catch (err) {
      log(`Erro ao aplicar o controle: ${err.message}`);
    }
  }

  function release(reason) {
    for (const [slot, state] of appliedBySlot) {
      if (isNeutral(state)) continue;
      stats.releases++;
      log(`Soltando todos os botões do slot ${slot} (${reason}).`);
      safeApply({ ...neutralState(), playerSlot: slot });
    }
  }

  function releaseSlot(slot, reason) {
    const state = appliedBySlot.get(slot) ?? neutralState();
    if (isNeutral(state)) return;
    stats.releases++;
    log(`Soltando todos os botões do slot ${slot} (${reason}).`);
    safeApply({ ...neutralState(), playerSlot: slot });
  }

  function updateSession(state) {
    for (const player of state?.session?.players ?? []) {
      inputEnabledBySlot.set(player.slot, player.inputEnabled !== false);
      if (player.inputEnabled === false) releaseSlot(player.slot, 'controle bloqueado pelo admin');
    }
    const active = state?.session?.status === 'active';
    if (active !== sessionActive) {
      sessionActive = active;
      log(active ? 'Sessão ativa: controle liberado.' : 'Sem sessão ativa: controle bloqueado.');
      if (!active) release('sessão encerrada');
      sendLocal({ type: 'session', active });
    }
  }

  function sendLocal(message) {
    if (localClient?.readyState === 1) localClient.send(JSON.stringify(message));
  }

  function handleInput(payload, source = 'ws') {
    stats.inputs++;
    if (source === 'local') stats.localInputs++;
    else stats.wsInputs++;
    lastSource = source;
    const slot = Math.max(1, Math.min(2, Number(payload?.playerSlot ?? 1)));
    if (!sessionActive || inputEnabledBySlot.get(slot) === false) {
      stats.ignored++;
      return;
    }
    const mapped = mapPayload(payload);
    if (!mapped) {
      stats.ignored++;
      return;
    }
    lastInputBySlot.set(slot, Date.now());
    const tagged = { ...mapped, playerSlot: slot };
    if (!sameState(tagged, appliedBySlot.get(slot))) safeApply(tagged);
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello':
        if (msg.ok) {
          backoff = BACKOFF_MIN_MS;
          log('Conectado ao servidor como bridge.');
          updateSession(msg.state);
        }
        break;
      case 'state':
        updateSession(msg.state);
        break;
      case 'player:control': {
        const slot = Math.max(1, Math.min(2, Number(msg.playerSlot ?? 1)));
        const enabled = msg.enabled === true;
        inputEnabledBySlot.set(slot, enabled);
        if (!enabled) releaseSlot(slot, 'controle bloqueado pelo admin');
        break;
      }
      case 'input':
        handleInput(msg.payload, 'ws');
        break;
      case 'input:ping':
        // Sonda de latência do caminho WebSocket (player → servidor → ponte).
        if (ws?.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'input:pong',
            id: msg.id,
            playerSlot: Number(msg.playerSlot ?? 1),
          }));
        }
        break;
      case 'error':
        if (msg.code === 'invalid_host_key') {
          stopped = true;
          log('Chave do host inválida. Confira HOST_KEY (ou data/host-key.txt do servidor).');
          onFatal(new Error('invalid_host_key'));
        } else {
          log(`Servidor: ${msg.message ?? msg.code}`);
        }
        break;
      default:
        break;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    log(`Reconectando em ${Math.round(backoff / 1000)} s...`);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function connect() {
    if (stopped) return;
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (err) {
      log(`URL inválida (${url}): ${err.message}`);
      onFatal(err);
      return;
    }
    ws = socket;

    // Conexão recusada dispara só `error` em alguns runtimes; queda normal
    // dispara `close`. Trata os dois, uma única vez por conexão.
    let down = false;
    const onDown = () => {
      if (down) return;
      down = true;
      sessionActive = false;
      release('conexão perdida');
      if (!stopped) {
        log('Sem conexão com o servidor.');
        scheduleReconnect();
      }
    };

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'bridge', key }));
    });
    socket.addEventListener('message', (event) => handleMessage(event.data));
    socket.addEventListener('error', onDown);
    socket.addEventListener('close', onDown);
  }

  function originAllowed(origin) {
    // Navegadores sempre enviam Origin; programas locais (sem Origin) já têm
    // acesso à máquina, então só a origem de um site precisa ser conferida.
    if (!origin) return true;
    return origins.has(origin);
  }

  function startLocal() {
    if (localPort === null || localPort === undefined || localServer) return Promise.resolve(0);
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Ponte de controle local.');
    });
    const openSockets = new Set();
    httpServer.on('connection', (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });
    const gate = new EventEmitter();
    const wss = createWebSocketServer({ server: gate, path: '/local', maxPayload: 64 * 1024 });

    httpServer.on('upgrade', (req, socket, head) => {
      const hostName = String(req.headers.host ?? '').replace(/:\d+$/, '');
      if (!LOCAL_HOSTS.has(hostName) || !originAllowed(req.headers.origin)) {
        log(`Canal local recusou uma origem não autorizada (${req.headers.origin ?? 'sem origem'}).`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      gate.emit('upgrade', req, socket, head);
    });

    wss.on('connection', (client) => {
      let authed = false;
      const hello = setTimeout(() => { if (!authed) client.close(4401, 'hello'); }, 5000);
      client.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!authed) {
          if (msg.type !== 'hello' || !safeEqual(String(msg.key ?? ''), key)) {
            client.close(4401, 'chave');
            return;
          }
          authed = true;
          clearTimeout(hello);
          if (localClient && localClient !== client) {
            try { localClient.close(4001, 'outro_host'); } catch { /* ignore */ }
          }
          localClient = client;
          log('Canal local conectado (comandos por P2P liberados).');
          client.send(JSON.stringify({ type: 'hello', ok: true, sessionActive }));
          return;
        }
        if (localClient !== client) return;
        if (msg.type === 'input') handleInput(msg.payload, 'local');
        else if (msg.type === 'ping') {
          client.send(JSON.stringify({
            type: 'pong',
            id: msg.id,
            playerSlot: Number(msg.playerSlot ?? 1),
          }));
        }
        else if (msg.type === 'release') {
          releaseSlot(Number(msg.playerSlot ?? 1), 'canal P2P fechado');
        }
      });
      client.on('close', () => {
        clearTimeout(hello);
        if (localClient === client) {
          localClient = null;
          log('Canal local desconectado.');
          if (lastSource === 'local') release('canal local desconectado');
        }
      });
    });

    localServer = { httpServer, wss, openSockets };
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(localPort, '127.0.0.1', () => {
        const port = httpServer.address().port;
        log(`Canal local em ws://127.0.0.1:${port}/local (origens: ${[...origins].join(', ') || 'nenhuma'}).`);
        resolve(port);
      });
    });
  }

  return {
    stats,

    /** Sobe o canal local (no-op se desligado). Retorna a porta em uso. */
    startLocal,
    get localPort() {
      return localServer?.httpServer.address()?.port ?? 0;
    },

    start() {
      stopped = false;
      log(`Conectando em ${url} ...`);
      connect();

      pingTimer = setInterval(() => {
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
      }, PING_MS);

      watchdogTimer = setInterval(() => {
        for (const [slot, state] of appliedBySlot) {
          const lastInputAt = lastInputBySlot.get(slot) ?? 0;
          if (!isNeutral(state) && lastInputAt > 0 && Date.now() - lastInputAt > watchdogMs) {
            stats.releases++;
            log(`Soltando todos os botões do slot ${slot} (sem sinal do cliente).`);
            safeApply({ ...neutralState(), playerSlot: slot });
          }
        }
      }, 500);
    },

    async stop() {
      stopped = true;
      if (localServer) {
        const { httpServer, wss, openSockets } = localServer;
        localServer = null;
        wss.close();
        for (const socket of openSockets) socket.destroy();
        await new Promise((resolve) => httpServer.close(resolve));
      }
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      clearInterval(watchdogTimer);
      release('encerrando');
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      await sink.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Linha de comando                                                    */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--python') args.python = argv[++i];
    else if (a === '--local-port') args.localPort = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function resolveUrl(raw) {
  const value = raw || `ws://localhost:${process.env.PORT || 8080}/ws`;
  return value.replace(/^http/i, 'ws');
}

function resolveKey(explicit) {
  if (explicit) return explicit;
  if (process.env.HOST_KEY) return process.env.HOST_KEY;
  const dataDir = path.resolve(root, process.env.DATA_DIR || './data');
  const file = path.join(dataDir, 'host-key.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log('Uso: npm run bridge [-- --dry-run] [--url ws://host/ws] [--key CHAVE] [--python python] [--local-port 8765]');
    return;
  }

  const stamp = () => new Date().toLocaleTimeString('pt-BR');
  const log = (text) => console.log(`[${stamp()}] ${text}`);

  const url = resolveUrl(args.url || process.env.BRIDGE_URL);
  const key = resolveKey(args.key);
  const dryRun = args.dryRun || process.env.BRIDGE_DRY_RUN === '1';

  if (!key) {
    console.error(
      'Chave do host não encontrada. Defina HOST_KEY no .env, passe --key, ' +
      'ou rode na mesma máquina do servidor (usa data/host-key.txt).',
    );
    process.exit(1);
  }

  if (!dryRun && process.platform !== 'win32') {
    console.error(
      'O controle virtual (ViGEmBus) só existe no Windows. ' +
      'Use --dry-run para testar o fluxo em outro sistema.',
    );
    process.exit(1);
  }

  let bridge;
  const shutdown = async (code = 0) => {
    try {
      await bridge?.stop();
    } finally {
      process.exit(code);
    }
  };

  const python = args.python || process.env.BRIDGE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const sink = dryRun
    ? dryRunSink(log)
    : vigemSink({
        python,
        log,
        onExit: (code) => {
          log(`O controle virtual parou inesperadamente (código ${code}).`);
          shutdown(1);
        },
      });

  try {
    await sink.start();
  } catch (err) {
    console.error(`\nFalha ao iniciar o controle virtual: ${err.message}\n`);
    process.exit(1);
  }

  log(`Controle: ${sink.name}. Botões suportados: ${ALL_BUTTONS.length} + 2 gatilhos + 2 analógicos.`);

  const envPort = process.env.BRIDGE_LOCAL_PORT;
  const localPort = Number.isFinite(args.localPort)
    ? args.localPort
    : envPort !== undefined && envPort !== '' ? Number(envPort) : DEFAULT_LOCAL_PORT;
  const allowedOrigins = String(process.env.BRIDGE_ALLOWED_ORIGINS ?? '')
    .split(',').map((v) => v.trim()).filter(Boolean);

  bridge = createBridge({
    url,
    key,
    sink,
    log,
    onFatal: () => shutdown(1),
    localPort: localPort > 0 ? localPort : null, // 0 desliga o canal local
    allowedOrigins,
  });
  bridge.start();
  try {
    await bridge.startLocal();
  } catch (err) {
    log(`Canal local indisponível (${err.message}). Os comandos seguirão pelo WebSocket.`);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
