import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isNeutral } from '../tools/gamepad-bridge/mapping.js';
import { createBridge, originFromServerUrl } from '../tools/gamepad-bridge/bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8187;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const HOST_KEY = 'chave-p2p-e2e';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sockets = [];
let child;

async function until(predicate, timeout = 4000, step = 20) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(step);
  }
  throw new Error('condição não atingida a tempo');
}

function padPayload({ pressed = [], axes = [0, 0, 0, 0] } = {}) {
  const buttons = Array.from({ length: 17 }, (_, i) => (pressed.includes(i) ? [1, 1] : [0, 0]));
  return { id: 'Teste', axes, buttons };
}

function openWS(url, { expectKeepOpen = false } = {}) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const queue = [];
  const waiters = [];
  const closed = { code: null };
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const i = waiters.findIndex((w) => w.predicate(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  ws.addEventListener('close', (event) => { closed.code = event.code; });
  return {
    closed,
    opened: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('ws error')));
    }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => ws.close(),
    next(predicate, timeout = 4000) {
      const found = queue.findIndex(predicate);
      if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout esperando mensagem: ' + predicate.toString())), timeout);
        waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
  };
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/** Tenta um upgrade WebSocket cru com cabeçalhos escolhidos; devolve o status HTTP. */
function rawUpgrade(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/local',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

function recordingSink() {
  const calls = [];
  return {
    calls,
    last: () => calls.at(-1),
    sink: { name: 'teste', async start() {}, apply: (s) => calls.push(s), async close() {} },
  };
}

test.before(async () => {
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      BASE_URL: BASE,
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'playlive-p2p-')),
      REQUIRE_ONLINE: '0',
      ADMIN_PASSWORD: 'senha-p2p',
      HOST_KEY,
      DEBUG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* subindo */ }
    await sleep(250);
  }
  throw new Error('servidor não subiu');
});

test.after(() => {
  for (const ws of sockets) try { ws.close(); } catch { /* ignore */ }
  child?.kill();
});

test('originFromServerUrl deriva a origem do site a partir da URL do WebSocket', () => {
  assert.equal(originFromServerUrl('wss://live.exemplo.com/ws'), 'https://live.exemplo.com');
  assert.equal(originFromServerUrl('ws://localhost:8080/ws'), 'http://localhost:8080');
  assert.equal(originFromServerUrl('lixo'), null);
});

test('canal local: só aceita o site certo, a chave certa e respeita a sessão do servidor', async () => {
  // Sessão: dono escolhe o espectador
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'senha-p2p' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = (body) => fetch(`${BASE}/api/admin/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  await admin({ action: 'live_set', url: 'dQw4w9WgXcQ', enabled: true });
  const joined = await api('/api/live/join', { method: 'POST', body: { nick: 'P2P' } });
  const overview = await fetch(`${BASE}/api/admin/overview`, { headers: { Cookie: cookie } }).then((r) => r.json());
  await admin({ action: 'live_pick', pub: overview.live.viewers[0].pub, minutes: 5 });
  const me = await api(`/api/live/me?v=${joined.data.viewerId}`);
  const token = new URL(me.data.playUrl, BASE).searchParams.get('s');

  const host = openWS(`ws://127.0.0.1:${PORT}/ws`);
  await host.opened;
  host.send({ type: 'hello', role: 'host', key: HOST_KEY });
  await host.next((m) => m.type === 'hello');
  const viewer = openWS(`ws://127.0.0.1:${PORT}/ws`);
  await viewer.opened;
  viewer.send({ type: 'hello', role: 'viewer', token });
  await viewer.next((m) => m.type === 'hello');

  const rec = recordingSink();
  const bridge = createBridge({
    url: WS_URL,
    key: HOST_KEY,
    sink: rec.sink,
    log: (t) => process.env.DBG && console.log('[bridge]', t),
    watchdogMs: 5000,
    localPort: 0,
  });
  bridge.start();
  const localPort = await bridge.startLocal();
  assert.ok(localPort > 0);
  await sleep(300);

  // --- segurança do canal local ---
  assert.equal(await rawUpgrade(localPort, { Origin: `http://127.0.0.1:${PORT}` }), 101, 'origem do site é aceita');
  assert.equal(await rawUpgrade(localPort, { Origin: 'https://site-malicioso.example' }), 403, 'outra origem é recusada');
  assert.equal(await rawUpgrade(localPort, { Host: `rebind.example:${localPort}` }), 403, 'Host estranho (DNS rebinding) é recusado');

  const wrongKey = openWS(`ws://127.0.0.1:${localPort}/local`);
  await wrongKey.opened;
  wrongKey.send({ type: 'hello', key: 'errada' });
  await until(() => wrongKey.closed.code !== null);
  assert.equal(wrongKey.closed.code, 4401);

  const noHello = openWS(`ws://127.0.0.1:${localPort}/local`);
  await noHello.opened;
  noHello.send({ type: 'input', payload: padPayload({ pressed: [0] }) }); // sem hello: derruba
  await until(() => noHello.closed.code !== null);
  assert.equal(noHello.closed.code, 4401);
  assert.equal(rec.calls.length, 0);

  const local = openWS(`ws://127.0.0.1:${localPort}/local`);
  await local.opened;
  local.send({ type: 'hello', key: HOST_KEY });
  const hello = await local.next((m) => m.type === 'hello');
  assert.equal(hello.ok, true);

  // --- só vale com sessão ATIVA no servidor (mesmo vindo pelo canal local) ---
  local.send({ type: 'input', payload: padPayload({ pressed: [0] }) });
  await sleep(250);
  assert.equal(rec.calls.length, 0, 'sessão ainda em preparação: nada é aplicado');

  host.send({ type: 'stream:ready' });
  await viewer.next((m) => m.type === 'stream:ready');
  await local.next((m) => m.type === 'session' && m.active === true);

  // --- comandos pelo caminho P2P (host → canal local) ---
  local.send({ type: 'input', payload: padPayload({ pressed: [0] }) });
  await until(() => rec.calls.length >= 1);
  assert.deepEqual(rec.last().buttons, ['A']);
  assert.equal(bridge.stats.localInputs >= 1, true);

  // --- reserva: o mesmo controle continua funcionando pelo WebSocket do servidor ---
  viewer.send({ type: 'input', payload: padPayload({ pressed: [1] }) });
  await until(() => rec.last().buttons.includes('B'));
  assert.equal(bridge.stats.wsInputs >= 1, true);

  // --- sondas de latência dos dois caminhos ---
  local.send({ type: 'ping', id: 7 });
  const pong = await local.next((m) => m.type === 'pong');
  assert.equal(pong.id, 7);
  viewer.send({ type: 'input:ping', id: 9 });
  const wsPong = await viewer.next((m) => m.type === 'input:pong');
  assert.equal(wsPong.id, 9);

  // --- se o host (canal local) cai, o controle é solto na hora ---
  local.send({ type: 'input', payload: padPayload({ pressed: [3] }) });
  await until(() => rec.last().buttons.includes('Y'));
  local.close();
  await until(() => isNeutral(rec.last()), 2000);

  // --- 'release' explícito (DataChannel fechou) ---
  const local2 = openWS(`ws://127.0.0.1:${localPort}/local`);
  await local2.opened;
  local2.send({ type: 'hello', key: HOST_KEY });
  await local2.next((m) => m.type === 'hello');
  local2.send({ type: 'input', payload: padPayload({ pressed: [2] }) });
  await until(() => rec.last().buttons.includes('X'));
  local2.send({ type: 'release' });
  await until(() => isNeutral(rec.last()), 2000);

  // --- encerrou a sessão: tudo bloqueado de novo ---
  await api('/api/session/forfeit', { method: 'POST', body: { token, confirm: true } });
  await local2.next((m) => m.type === 'session' && m.active === false);
  const before = rec.calls.length;
  local2.send({ type: 'input', payload: padPayload({ pressed: [0] }) });
  await sleep(250);
  assert.equal(rec.calls.length, before);

  await bridge.stop();
});

test('servidor limita o envio de comandos por conexão (anti-inundação)', async () => {
  const rec = recordingSink();
  const bridge = createBridge({ url: WS_URL, key: HOST_KEY, sink: rec.sink, log: () => {} });
  bridge.start();
  await sleep(300);

  // Nova sessão para ter um viewer válido
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'senha-p2p' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = (body) => fetch(`${BASE}/api/admin/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const joined = await api('/api/live/join', { method: 'POST', body: { nick: 'Flood' } });
  const overview = await fetch(`${BASE}/api/admin/overview`, { headers: { Cookie: cookie } }).then((r) => r.json());
  const viewerPub = overview.live.viewers.find((v) => v.nick === 'Flood').pub;
  await admin({ action: 'live_pick', pub: viewerPub, minutes: 5 });
  const me = await api(`/api/live/me?v=${joined.data.viewerId}`);
  const token = new URL(me.data.playUrl, BASE).searchParams.get('s');

  const viewer = openWS(`ws://127.0.0.1:${PORT}/ws`);
  await viewer.opened;
  viewer.send({ type: 'hello', role: 'viewer', token });
  await viewer.next((m) => m.type === 'hello');

  for (let i = 0; i < 600; i++) {
    viewer.send({ type: 'input', payload: padPayload({ axes: [(i % 100) / 100, 0, 0, 0] }) });
  }
  await sleep(600);
  assert.ok(bridge.stats.inputs >= 1, 'alguns comandos passam');
  assert.ok(bridge.stats.inputs <= 480, `o limite barrou o excesso (passaram ${bridge.stats.inputs})`);
  await bridge.stop();
});
