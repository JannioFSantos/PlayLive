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
