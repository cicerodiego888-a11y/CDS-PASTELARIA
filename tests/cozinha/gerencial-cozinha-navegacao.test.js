'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const kds = require('../../frontend/erp/js/cozinha-kds');

it('navega à Gestão da Cozinha somente após abertura confirmada', async () => {
  const chamadas = [];
  const turno = { id: 19, estado: 'ABERTA' };
  const navegador = { loadPage: pagina => chamadas.push(pagina) };

  const resultado = await kds.abrirTurnoENavegarParaGestao({
    abrirTurno: async () => ({ ok: true, data: { turno } })
  }, navegador);

  assert.equal(resultado.ok, true);
  assert.deepEqual(chamadas, ['cozinha-gerencial']);
  assert.equal(navegador.CDS_COZINHA_TURNO_ATUAL, turno);

  chamadas.length = 0;
  await kds.abrirTurnoENavegarParaGestao({
    abrirTurno: async () => ({ erro: new Error('abertura negada') })
  }, navegador);
  assert.deepEqual(chamadas, []);
});
