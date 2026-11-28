import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playlive-provision-'));
process.env.DATA_DIR = tempDir;
process.env.PROVISION_TIMEOUT_SEC = '180';
process.env.HOST_KEY = 'k';
process.env.ADMIN_PASSWORD = 'p';
process.env.REQUIRE_ONLINE = '0';
process.env.MULTIPLAYER = '1';

const { store } = await import('../src/state.js');
const { startGuestSession, markStreamReady, tick, activeSession } = await import('../src/sessions.js');
const {
  _resetLobby,
  adminLive,
  configureLive,
  joinLobby,
  pickViewer,
  viewerStatus,
} = await import('../src/live.js');

const reset = () => store.mutate((state) => { state.session = null; });
const markPlayerEntered = (session) => store.mutate((state) => {
  state.session.players[0].viewer.connections = 1;
});

test('imagem que não sobe: relógio não começa e a vaga é liberada', () => {
  reset();
  const session = startGuestSession({ nick: 'Ana', minutes: 10, viewerId: 'v1' });
  markPlayerEntered(session);
  const t = session.createdAt + 181_000;
  const result = tick(t);
  assert.equal(result.provisionFailed?.id, session.id);
  assert.equal(store.data.session.status, 'ended');
  assert.equal(store.data.session.endedReason, 'provision_timeout');
  assert.equal(store.data.session.startedAt, null);
  assert.equal(activeSession(), null);
});

test('antes do prazo a sessão continua aguardando o host', () => {
  reset();
  const session = startGuestSession({ nick: 'Bia', minutes: 10, viewerId: 'v2' });
  const result = tick(session.createdAt + 10_000);
  assert.equal(result.provisionFailed, null);
  assert.equal(store.data.session.status, 'provisioning');
});

test('jogador que não entra em 30 segundos cede a vez automaticamente ao próximo', () => {
  reset();
  _resetLobby();
  configureLive({ url: 'dQw4w9WgXcQ', enabled: true });
  const ana = joinLobby('Ana');
  const bia = joinLobby('Bia');
  const anaPub = adminLive().viewers.find((viewer) => viewer.nick === 'Ana').pub;
  pickViewer(anaPub, 7);
  const firstSession = store.data.session;

  const result = tick(firstSession.createdAt + 30_001);

  assert.equal(result.playersTimedOut.length, 1);
  assert.equal(store.data.session.customer.name, 'Bia');
  assert.equal(store.data.session.durationMs, 7 * 60_000);
  assert.equal(viewerStatus(ana.viewerId).turnMissed, true);
  assert.equal(viewerStatus(bia.viewerId).chosen, true);
});

test('vaga de multiplayer sem entrada é preenchida sem remover quem já entrou', () => {
  reset();
  _resetLobby();
  configureLive({ url: 'dQw4w9WgXcQ', enabled: true });
  const ana = joinLobby('Ana');
  const bia = joinLobby('Bia');
  const cris = joinLobby('Cris');
  const pubs = new Map(adminLive().viewers.map((viewer) => [viewer.nick, viewer.pub]));
  pickViewer(pubs.get('Ana'), 7, 2);
  pickViewer(pubs.get('Bia'), 7);
  store.data.session.players[0].viewer.connections = 1;
  const sessionId = store.data.session.id;
  const biaSelectedAt = store.data.session.players[1].selectedAt;
  assert.deepEqual(store.data.session.players.map((player) => player.viewer.connections), [1, 0]);

  tick(biaSelectedAt + 30_001);

  assert.equal(store.data.session.id, sessionId);
  assert.deepEqual(store.data.session.players.map((player) => player.name), ['Ana', 'Cris']);
  assert.equal(viewerStatus(ana.viewerId).chosen, true);
  assert.equal(viewerStatus(bia.viewerId).turnMissed, true);
  assert.equal(viewerStatus(cris.viewerId).playerSlot, 2);
});

test('fim normal do tempo não inicia uma nova sessão por causa de timeout simultâneo', () => {
  reset();
  _resetLobby();
  configureLive({ url: 'dQw4w9WgXcQ', enabled: true });
  const ana = joinLobby('Ana');
  const bia = joinLobby('Bia');
  const cris = joinLobby('Cris');
  const pubs = new Map(adminLive().viewers.map((viewer) => [viewer.nick, viewer.pub]));
  pickViewer(pubs.get('Ana'), 1, 2);
  pickViewer(pubs.get('Bia'), 1);
  store.data.session.players[0].viewer.connections = 1;
  const session = markStreamReady(store.data.session.id);

  tick(session.endsAt + 1);

  assert.equal(store.data.session.id, session.id);
  assert.equal(store.data.session.endedReason, 'time_up');
  assert.equal(viewerStatus(cris.viewerId).chosen, false);
  assert.equal(viewerStatus(bia.viewerId).turnMissed, true);
});

test('relógio começa só quando o host publica e o tempo acaba sozinho', () => {
  reset();
  const session = startGuestSession({ nick: 'Cris', minutes: 2, viewerId: 'v3' });
  markPlayerEntered(session);
  const started = markStreamReady(session.id);
  assert.equal(started.status, 'active');
  assert.equal(started.endsAt - started.startedAt, 2 * 60_000);

  // sessão curta: os avisos de 5 e 1 minuto já valem; cada um só dispara uma vez
  const warn = tick(started.endsAt - 50_000);
  assert.deepEqual(warn.warnings.map((w) => w.minutes).sort(), [1, 5]);
  assert.equal(tick(started.endsAt - 40_000).warnings.length, 0);
  const end = tick(started.endsAt + 1);
  assert.equal(end.sessionEnded?.id, session.id);
  assert.equal(store.data.session.endedReason, 'time_up');
});

test('só um jogador por vez', () => {
  reset();
  assert.ok(startGuestSession({ nick: 'Dani', minutes: 5, viewerId: 'v4' }));
  assert.equal(startGuestSession({ nick: 'Edu', minutes: 5, viewerId: 'v5' }), null);
});
