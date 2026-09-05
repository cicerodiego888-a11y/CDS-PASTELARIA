/**
 * Provider MOCK — dados determinísticos. Sem HTTP. Sem banco real.
 * Não persiste transação. Não lê secrets.
 * @module motores/bancario/providers/MockBankProvider
 */
'use strict';

const { IBankProvider } = require('../contracts/IBankProvider');
const { normalizarTransacao } = require('../contracts/TransacaoBancariaNormalizada');
const { CODIGO_PROVIDER } = require('../contracts/constantes');

class MockBankProvider extends IBankProvider {
  get codigo() {
    return CODIGO_PROVIDER.MOCK;
  }

  get nome() {
    return 'Provider de Teste';
  }

  get disponivel() {
    return true;
  }

  async conectar() {
    return { ok: true, modo: 'mock' };
  }

  async desconectar() {
    return { ok: true };
  }

  async listarContas() {
    return [];
  }

  async consultarSaldo() {
    return { natureza: 'mock', valor: 0, rotulo: 'Saldo mock (não é saldo bancário)' };
  }

  async listarTransacoes(params = {}) {
    const empresaId = params.empresaId != null ? params.empresaId : params.empresa_id;
    const contaId = params.contaBancariaId != null ? params.contaBancariaId : params.conta_bancaria_id;
    return [
      normalizarTransacao({
        empresaId,
        empresa_id: empresaId,
        accountId: contaId,
        conta_bancaria_id: contaId,
        amount: 150,
        valor: 150,
        direction: 'entrada',
        date: '2026-09-04T10:00:00',
        data_transacao: '2026-09-04T10:00:00',
        description: 'Mock crédito determinístico',
        type: 'OUTROS',
        externalSource: 'MOCK',
        external_source: 'MOCK',
        externalId: 'MOCK-TRANS-001',
        external_id: 'MOCK-TRANS-001'
      })
    ];
  }
}

module.exports = { MockBankProvider };
