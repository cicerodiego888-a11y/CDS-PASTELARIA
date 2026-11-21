'use strict';

const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.DB_DIR = path.join(os.tmpdir(), 'cds-mobile-fiscal-mock-' + process.pid);
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const databasePath = require.resolve('../../backend/database');
const emissorPath = require.resolve('../../backend/services/fiscal/emissor');
const vendaFiscalServicePath = require.resolve('../../backend/services/vendas/VendaFiscalService');
const databaseCacheAnterior = require.cache[databasePath];
const emissorCacheAnterior = require.cache[emissorPath];

const chamadasEmissor = [];
const dbIsolado = {
  get(_sql, _params, callback) {
    callback(null, null);
  },
  all(_sql, _params, callback) {
    callback(null, []);
  }
};

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: dbIsolado
};
require.cache[emissorPath] = {
  id: emissorPath,
  filename: emissorPath,
  loaded: true,
  exports: {
    async emitirPorVendaId(vendaId, opcoes) {
      chamadasEmissor.push({ vendaId, opcoes });
      return {
        success: false,
        status: 'pendente',
        message: 'Resultado controlado em teste isolado.',
        transmitido: false
      };
    }
  }
};

delete require.cache[vendaFiscalServicePath];
const { responderVendaComFiscal } = require(vendaFiscalServicePath);

if (databaseCacheAnterior) require.cache[databasePath] = databaseCacheAnterior;
else delete require.cache[databasePath];
if (emissorCacheAnterior) require.cache[emissorPath] = emissorCacheAnterior;
else delete require.cache[emissorPath];

describe('PDV Mobile — finalização fiscal oficial isolada', () => {
  it('chama o emissor oficial uma vez para venda quitada e devolve o estado controlado', async () => {
    let resposta;
    await responderVendaComFiscal({
      json(body) {
        resposta = body;
        return body;
      }
    }, {
      vendaId: 9201,
      codigo: 'VND-TESTE-FISCAL',
      message: 'Venda registrada.',
      emitirFiscal: true,
      valorFiscal: 25,
      valorNaoFiscal: 0,
      statusPagamento: 'quitada',
      empresaId: 8
    });

    assert.equal(chamadasEmissor.length, 1);
    assert.equal(chamadasEmissor[0].vendaId, 9201);
    assert.equal(chamadasEmissor[0].opcoes.empresaIdContexto, 8);
    assert.equal(resposta.fiscal.status, 'pendente');
    assert.equal(resposta.fiscal.transmitido, false);
    assert.equal(resposta.status_pagamento, 'quitada');
  });

  it('não chama o emissor quando a venda não solicita emissão', async () => {
    const chamadasAntes = chamadasEmissor.length;
    let resposta;
    await responderVendaComFiscal({
      json(body) {
        resposta = body;
        return body;
      }
    }, {
      vendaId: 9202,
      codigo: 'VND-TESTE-NAO-FISCAL',
      message: 'Venda registrada.',
      emitirFiscal: false,
      valorFiscal: 0,
      valorNaoFiscal: 25,
      statusPagamento: 'quitada'
    });

    assert.equal(chamadasEmissor.length, chamadasAntes);
    assert.equal(resposta.fiscal, null);
  });
});
