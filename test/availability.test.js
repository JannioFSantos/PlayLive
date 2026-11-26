import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_KEY = 'chave-availability-e2e';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const children = [];
const sockets = [];

async function until(predicate, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('condição não atingida a tempo');
}

async function startServer(port, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playlive-avail-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: 'senha-availability',
      HOST_KEY,
      DEBUG: '0',
      REQUIRE_ONLINE: '1',
      REQUIRE_BRIDGE: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  children.push(child);

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* subindo */
    }
    await sleep(250);
  }

  const api = async (pathname, options = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      ...options,
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };

  const connect = async (role) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    ws.send(JSON.stringify({ type: 'hello', role, key: HOST_KEY }));
    await new Promise((resolve) => {
      ws.addEventListener('message', (event) => {
        if (JSON.parse(event.data).type === 'hello') resolve();
      });
    });
    return ws;
  };

  const status = async () => (await api('/api/status')).data.availability;

  // O dono abre a sala; "buy" = um espectador entra e o dono tenta escolhê-lo.
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'senha-availability' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = async (body) => {
    const res = await fetch(`${base}/api/admin/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  await admin({ action: 'live_set', url: 'dQw4w9WgXcQ', enabled: true });
  const buy = async () => {
    const joined = await api('/api/live/join', { method: 'POST', body: { nick: 'Disponib' } });
    const overview = await fetch(`${base}/api/admin/overview`, { headers: { Cookie: cookie } }).then((r) => r.json());
    const viewer = overview.live.viewers.find((v) => v.nick === 'Disponib');
    const result = await admin({ action: 'live_pick', pub: viewer.pub, minutes: 5 });
    await api('/api/live/leave', { method: 'POST', body: { viewerId: joined.data.viewerId } });
    if (result.status === 200) await admin({ action: 'end_session' });
    return result;
  };

  return { api, connect, status, buy };
}

test.after(() => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  for (const child of children) child.kill();
});

test('só deixa escolher com host e ponte online, e volta a bloquear quando caem', async () => {
  const server = await startServer(8191);

  // Tudo offline
  let availability = await server.status();
  assert.equal(availability.ready, false);
  assert.equal(availability.reason, 'host_offline');
  let attempt = await server.buy();
  assert.equal(attempt.status, 503);
  assert.equal(attempt.data.error.code, 'machine_offline');
  assert.equal(attempt.data.error.reason, 'host_offline');

  // Só o host: ainda falta a ponte
  const host = await server.connect('host');
  await until(async () => (await server.status()).hostOnline === true);
  availability = await server.status();
  assert.equal(availability.ready, false);
  assert.equal(availability.reason, 'bridge_offline');
  attempt = await server.buy();
  assert.equal(attempt.status, 503);
  assert.equal(attempt.data.error.reason, 'bridge_offline');

  // Host + ponte: permite
  const bridge = await server.connect('bridge');
  await until(async () => (await server.status()).ready === true);
  attempt = await server.buy();
  assert.equal(attempt.status, 200);

  // A ponte cai: bloqueia de novo
  bridge.close();
  await until(async () => (await server.status()).reason === 'bridge_offline');
  attempt = await server.buy();
  assert.equal(attempt.status, 503);

  // O host cai também
  host.close();
  await until(async () => (await server.status()).reason === 'host_offline');
  attempt = await server.buy();
  assert.equal(attempt.status, 503);
  assert.equal(attempt.data.error.reason, 'host_offline');
});

test('REQUIRE_BRIDGE=0 exige só o host (ex.: Xbox com placa de captura)', async () => {
  const server = await startServer(8190, { REQUIRE_BRIDGE: '0' });

  let attempt = await server.buy();
  assert.equal(attempt.status, 503);
  assert.equal(attempt.data.error.reason, 'host_offline');

  await server.connect('host');
  await until(async () => (await server.status()).ready === true);
  attempt = await server.buy();
  assert.equal(attempt.status, 200);
});

test('REQUIRE_ONLINE=0 desliga a trava (desenvolvimento)', async () => {
  const server = await startServer(8189, { REQUIRE_ONLINE: '0' });

  const availability = await server.status();
  assert.equal(availability.ready, true);
  assert.equal(availability.hostOnline, false);
  const attempt = await server.buy();
  assert.equal(attempt.status, 200);
});
