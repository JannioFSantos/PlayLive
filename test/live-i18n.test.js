import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, translate } from '../public/assets/live-i18n.js';

test('seleciona o primeiro idioma compatível das preferências do navegador', () => {
  assert.equal(resolveLanguage(['fr-FR', 'es-MX', 'en-US']), 'es');
  assert.equal(resolveLanguage(['PT-PT', 'en-US']), 'pt');
  assert.equal(resolveLanguage(['fr-FR']), 'pt');
});

test('traduz textos dinâmicos e preserva o nome do jogador', () => {
  assert.equal(translate('en', 'turnTitle', { nick: 'Ana' }), "🎮 It's your turn, Ana!");
  assert.equal(translate('es', 'roomCount', { count: '3' }), '3 en la sala');
});

test('traduz o chat próprio nos três idiomas', () => {
  assert.equal(translate('pt', 'chatTitle'), 'Chat da live');
  assert.equal(translate('en', 'chatTitle'), 'Live chat');
  assert.equal(translate('es', 'chatTitle'), 'Chat en vivo');
  assert.equal(translate('pt', 'chatJoin'), 'Entre na fila para participar do chat.');
  assert.equal(translate('en', 'chatJoin'), 'Join the queue to read and send messages.');
  assert.equal(translate('es', 'chatJoin'), 'Únete a la cola para leer y enviar mensajes.');
});

test('traduz a contagem regressiva e o convite para entrar novamente na fila', () => {
  assert.equal(translate('pt', 'turnCountdown', { seconds: 30 }), 'Entre no jogo em até 30 s para não perder a vez.');
  assert.equal(translate('en', 'rejoinButton'), 'Rejoin the queue');
  assert.equal(translate('es', 'rejoinButton'), 'Volver a la cola');
});
