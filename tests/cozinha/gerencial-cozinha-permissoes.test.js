'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { perfilPodeAcessarGestao } = require('../../backend/services/cozinha/permissaoGerencial');

it('limita o painel gerencial a Gerente e Super Administrador', () => {
  assert.equal(perfilPodeAcessarGestao({ perfil: 'GERENTE' }), true);
  assert.equal(perfilPodeAcessarGestao({ role: 'gerente', perfil: 'USUARIO' }), true);
  assert.equal(perfilPodeAcessarGestao({ perfil: 'SUPER_ADMIN' }), true);
  assert.equal(perfilPodeAcessarGestao({ role: 'admin', perfil: 'ADMIN' }), false);
  assert.equal(perfilPodeAcessarGestao({ role: 'cozinheiro', perfil: 'USUARIO' }), false);
  assert.equal(perfilPodeAcessarGestao({ role: 'garcom', perfil: 'USUARIO' }), false);
});
