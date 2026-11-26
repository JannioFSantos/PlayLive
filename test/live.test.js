import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractVideoId } from '../src/live.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_KEY = 'chave-live-e2e';
const PASSWORD = 'senha-live';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const sockets = [];

test('extractVideoId aceita os formatos de link do YouTube e rejeita lixo', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(extractVideoId(`https://www.youtube.com/watch?v=${id}&t=5`), id);
  assert.equal(extractVideoId(`https://youtu.be/${id}?si=x`), id);
  assert.equal(extractVideoId(`https://www.youtube.com/live/${id}`), id);
  assert.equal(extractVideoId(`https://m.youtube.com/embed/${id}`), id);
  assert.equal(extractVideoId(`youtube.com/watch?v=${id}`), id);
  assert.equal(extractVideoId(id), id);
  assert.equal(extractVideoId('https://evil.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=curto'), null);
  assert.equal(extractVideoId(''), null);
});

async function until(predicate, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('condição não atingida a tempo');
}

test.after(() => {
  for (const ws of sockets) try { ws.close(); } catch { /* ignore */ }
  for (const child of children) child.kill();
});

test('live: sala por apelido, dono escolhe, escolhido ganha acesso sem pagar', async () => {
  const port = 8188;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: base,
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'playlive-live-')),
      ADMIN_PASSWORD: PASSWORD,
      HOST_KEY,
      DEBUG: '0',
      REQUIRE_ONLINE: '1',
      REQUIRE_BRIDGE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  children.push(child);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* subindo */ }
    await sleep(250);
  }

  const call = async (p, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
  };

  const home = await fetch(base);
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  const homeHtml = await home.text();
  assert.match(homeHtml, /<iframe id="player" referrerpolicy="origin"/);
  assert.match(homeHtml, /id="chatPanel"/);
  assert.match(homeHtml, /id="chatMessages"/);
  assert.match(homeHtml, /id="chatForm"/);
  assert.doesNotMatch(homeHtml, /youtube\.com\/live_chat|youtubeChatLink|chatMobile/);
  assert.match(homeHtml, /id="playingCard"/);
  assert.match(homeHtml, /id="playingName"/);
  assert.match(homeHtml, /id="playingTime"/);
  assert.match(homeHtml, /id="queueList"/);
  const adminHtml = await (await fetch(`${base}/admin`)).text();
  assert.match(adminHtml, /id="liveStop"[^>]*>STOP<\/button>/);

  const login = await call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = (action, extra = {}) => call('/api/admin/action', {
    method: 'POST', cookie, body: { action, ...extra },
  });

  // Sala fechada: ninguém entra
  const closedLive = (await call('/api/live')).data;
  assert.equal(closedLive.enabled, false);
  assert.equal(closedLive.chatEnabled, false);
  assert.equal((await call('/api/live/join', { method: 'POST', body: { nick: 'Ana' } })).status, 409);
  assert.equal((await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: 'alguem' },
  })).status, 409);

  // Link inválido é recusado; válido abre a sala
  assert.equal((await admin('live_set', { url: 'https://evil.com/x', enabled: true })).status, 400);
  const set = await admin('live_set', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', enabled: true });
  assert.equal(set.status, 200);
  let publicLive = (await call('/api/live')).data;
  assert.equal(publicLive.videoId, 'dQw4w9WgXcQ');
  assert.equal(publicLive.chatEnabled, true);
  assert.deepEqual(publicLive.queue, []);
  assert.equal(publicLive.playing, null);

  // Apelido inválido
  assert.equal((await call('/api/live/join', { method: 'POST', body: { nick: 'A' } })).status, 400);

  let ana = (await call('/api/live/join', { method: 'POST', body: { nick: 'Ana' } })).data;
  let bia = (await call('/api/live/join', { method: 'POST', body: { nick: 'Bia' } })).data;
  const selectedAnaViewerId = ana.viewerId;
  assert.ok(ana.viewerId && bia.viewerId);
  publicLive = (await call('/api/live')).data;
  assert.deepEqual(publicLive.queue, ['Ana', 'Bia']);
  assert.equal(publicLive.viewers, 2);
  assert.equal(publicLive.playing, null);
  assert.ok(!JSON.stringify(publicLive).includes(ana.viewerId));
  assert.equal((await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: 'nao-entrou-na-fila' },
  })).status, 403);
  assert.equal((await call('/api/live/chat/send', {
    method: 'POST',
    body: { viewerId: 'nao-entrou-na-fila', text: 'oi' },
  })).status, 403);

  const firstChatRead = await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: ana.viewerId },
  });
  assert.equal(firstChatRead.status, 200);
  assert.deepEqual(firstChatRead.data.messages, []);
  const sentMessage = await call('/api/live/chat/send', {
    method: 'POST',
    body: { viewerId: ana.viewerId, text: '<script>oi</script>' },
  });
  assert.equal(sentMessage.status, 201);
  assert.equal(sentMessage.data.nick, 'Ana');
  assert.equal(sentMessage.data.text, '<script>oi</script>');
  assert.deepEqual(Object.keys(sentMessage.data).sort(), ['at', 'id', 'nick', 'text']);
  const chatForBia = await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: bia.viewerId },
  });
  assert.deepEqual(chatForBia.data.messages, [sentMessage.data]);
  assert.equal((await call('/api/live/chat/send', {
    method: 'POST',
    body: { viewerId: ana.viewerId, text: 'mensagem rápida' },
  })).status, 429);
  assert.equal((await call('/api/live/chat/send', {
    method: 'POST',
    body: { viewerId: bia.viewerId, text: 'x'.repeat(501) },
  })).status, 400);

  // O painel vê os dois, sem expor o segredo de cada um
  let overview = (await call('/api/admin/overview', { cookie })).data;
  assert.equal(overview.live.viewers.length, 2);
  assert.ok(!JSON.stringify(overview.live).includes(ana.viewerId));
  const anaPub = overview.live.viewers.find((v) => v.nick === 'Ana').pub;

  // Sem PC online não dá para escolher
  let pick = await admin('live_pick', { pub: anaPub, minutes: 5 });
  assert.equal(pick.status, 503);

  // Liga host + ponte
  const connect = async (role) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    ws.send(JSON.stringify({ type: 'hello', role, key: HOST_KEY }));
    await new Promise((resolve) => ws.addEventListener('message', (e) => {
      if (JSON.parse(e.data).type === 'hello') resolve();
    }));
    return ws;
  };
  const host = await connect('host');
  await connect('bridge');
  await until(async () => (await call('/api/status')).data.availability.ready === true);

  // Minutos inválidos
  assert.equal((await admin('live_pick', { pub: anaPub, minutes: 0 })).status, 400);
  assert.equal((await admin('live_pick', { pub: anaPub, minutes: 999 })).status, 400);

  // Antes de escolher, ninguém tem acesso
  assert.equal((await call(`/api/live/me?v=${ana.viewerId}`)).data.chosen, false);

  pick = await admin('live_pick', { pub: anaPub, minutes: 7 });
  assert.equal(pick.status, 200);
  publicLive = (await call('/api/live')).data;
  assert.deepEqual(publicLive.queue, ['Bia']);
  assert.equal(publicLive.playing, null);

  // Só a Ana recebe o link de jogar; a Bia não
  const meAna = (await call(`/api/live/me?v=${ana.viewerId}`)).data;
  const meBia = (await call(`/api/live/me?v=${bia.viewerId}`)).data;
  assert.equal(meAna.chosen, true);
  assert.match(meAna.playUrl, /^\/play\.html\?s=/);
  assert.equal(meBia.chosen, false);
  assert.equal(meBia.playUrl, undefined);

  // Segundo escolhido enquanto ocupado → 409
  const biaPub = overview.live.viewers.find((v) => v.nick === 'Bia').pub;
  assert.equal((await admin('live_pick', { pub: biaPub, minutes: 5 })).status, 409);

  // O link funciona como sessão normal
  const token = decodeURIComponent(meAna.playUrl.split('s=')[1]);
  let session = (await call(`/api/session?s=${encodeURIComponent(token)}`)).data;
  assert.equal(session.status, 'provisioning');
  assert.equal(session.minutes, 7);
  // Não existe rota de pagamento
  assert.equal((await call('/api/orders', { method: 'POST', body: {} })).status, 404);

  // Host publica → relógio começa com 7 minutos
  host.send(JSON.stringify({ type: 'stream:ready' }));
  await until(async () => (await call(`/api/session?s=${encodeURIComponent(token)}`)).data.status === 'active');
  session = (await call(`/api/session?s=${encodeURIComponent(token)}`)).data;
  assert.ok(session.remainingMs > 6.9 * 60_000 && session.remainingMs <= 7 * 60_000);
  publicLive = (await call('/api/live')).data;
  assert.deepEqual(publicLive.queue, ['Bia']);
  assert.deepEqual(Object.keys(publicLive.playing).sort(), ['name', 'remainingMs']);
  assert.equal(publicLive.playing.name, 'Ana');
  assert.ok(publicLive.playing.remainingMs > 6.9 * 60_000);
  assert.ok(!JSON.stringify(publicLive).includes(token));

  assert.equal((await admin('live_chat_toggle', { enabled: false })).status, 200);
  publicLive = (await call('/api/live')).data;
  assert.equal(publicLive.chatEnabled, false);
  const mutedChat = await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: bia.viewerId, after: 0, revision: chatForBia.data.revision },
  });
  assert.equal(mutedChat.data.chatEnabled, false);
  assert.deepEqual(mutedChat.data.messages, [sentMessage.data]);
  assert.equal((await call('/api/live/chat/send', {
    method: 'POST',
    body: { viewerId: bia.viewerId, text: 'chat pausado' },
  })).status, 409);

  assert.equal((await admin('live_chat_clear')).data.chat.messageCount, 0);
  const clearedChat = await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: bia.viewerId, after: 1, revision: chatForBia.data.revision },
  });
  assert.equal(clearedChat.data.reset, true);
  assert.deepEqual(clearedChat.data.messages, []);
  assert.equal((await admin('live_chat_toggle', { enabled: true })).status, 200);

  // O dono pode somar minutos
  assert.equal((await admin('extend', { minutes: 5 })).status, 200);
  session = (await call(`/api/session?s=${encodeURIComponent(token)}`)).data;
  assert.ok(session.remainingMs > 11.9 * 60_000);
  overview = (await call('/api/admin/overview', { cookie })).data;
  assert.equal(overview.counters.sessionsTotal, 1);

  // STOP tira o vídeo do site, mas não encerra a sessão de jogo nem a live do YouTube
  const stopped = await admin('live_stop');
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.data.live, { enabled: false, videoId: null });
  session = (await call(`/api/session?s=${encodeURIComponent(token)}`)).data;
  assert.equal(session.status, 'active');
  publicLive = (await call('/api/live')).data;
  assert.equal(publicLive.enabled, false);
  assert.equal(publicLive.videoId, null);
  assert.deepEqual(publicLive.queue, []);
  assert.equal(publicLive.playing, null);
  assert.equal(publicLive.chatEnabled, false);

  // Reabre a sala para confirmar que ela começa limpa; a sessão atual continua em andamento
  await admin('live_set', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', enabled: true });
  ana = (await call('/api/live/join', { method: 'POST', body: { nick: 'Ana' } })).data;
  bia = (await call('/api/live/join', { method: 'POST', body: { nick: 'Bia' } })).data;
  assert.deepEqual((await call('/api/live')).data.queue, ['Ana', 'Bia']);
  const reopenedChat = await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: ana.viewerId },
  });
  assert.deepEqual(reopenedChat.data.messages, []);

  // Dono encerra → a Ana perde o acesso
  await admin('end_session', { reason: 'admin' });
  assert.equal((await call(`/api/live/me?v=${selectedAnaViewerId}`)).data.chosen, false);
  publicLive = (await call('/api/live')).data;
  assert.equal(publicLive.playing, null);
  assert.deepEqual(publicLive.queue, ['Ana', 'Bia']);

  // Quem sai da sala não aparece mais; fechar a sala limpa tudo
  await call('/api/live/leave', { method: 'POST', body: { viewerId: bia.viewerId } });
  assert.equal((await call('/api/live')).data.viewers, 1);
  assert.equal((await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: bia.viewerId },
  })).status, 403);
  await admin('live_set', { url: '', enabled: false });
  publicLive = (await call('/api/live')).data;
  assert.equal(publicLive.enabled, false);
  assert.equal(publicLive.chatEnabled, false);
  assert.equal((await call(`/api/live/me?v=${ana.viewerId}`)).data.joined, false);
  assert.equal((await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: ana.viewerId },
  })).status, 409);

  await admin('live_set', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', enabled: true });
  const caio = (await call('/api/live/join', { method: 'POST', body: { nick: 'Caio' } })).data;
  const freshChat = await call('/api/live/chat/read', {
    method: 'POST',
    body: { viewerId: caio.viewerId },
  });
  assert.deepEqual(freshChat.data.messages, []);
});
