import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playlive-provision-'));
process.env.DATA_DIR = tempDir;
process.env.PROVISION_TIMEOUT_SEC = '30';
process.env.HOST_KEY = 'k';
process.env.ADMIN_PASSWORD = 'p';

const { store } = await import('../src/state.js');
const { startGuestSession, markStreamReady, tick, activeSession } = await import('../src/sessions.js');

const reset = () => store.mutate((state) => { state.session = null; });

test('imagem que não sobe: relógio não começa e a vaga é liberada', () => {
  reset();
  const session = startGuestSession({ nick: 'Ana', minutes: 10, viewerId: 'v1' });
  const t = session.createdAt + 31_000;
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

test('relógio começa só quando o host publica e o tempo acaba sozinho', () => {
  reset();
  const session = startGuestSession({ nick: 'Cris', minutes: 2, viewerId: 'v3' });
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
