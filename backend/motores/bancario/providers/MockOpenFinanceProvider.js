/**
 * Provider MOCK Open Finance — autorização + sincronização determinística.
 * Sem HTTP externo. Sem banco real. Sem INSERT em transacao_bancaria.
 * @module motores/bancario/providers/MockOpenFinanceProvider
 */
'use strict';

const { IBankProvider } = require('../contracts/IBankProvider');
const { normalizarTransacao } = require('../contracts/TransacaoBancariaNormalizada');
const { CODIGO_PROVIDER, ERROS, erroMbc, STATUS_CONSENTIMENTO } = require('../contracts/constantes');

const SALDO_PADRAO = 1250.55;
const SALDO_DATA = '2026-09-04';

function montarItem(n, empresaId, contaId) {
  const entrada = n % 2 === 1;
  return normalizarTransacao({
    empresaId,
    empresa_id: empresaId,
    accountId: contaId,
    conta_bancaria_id: contaId,
    amount: entrada ? 100 : 50,
    valor: entrada ? 100 : 50,
    direction: entrada ? 'entrada' : 'saida',
    direcao: entrada ? 'entrada' : 'saida',
    date: '2026-01-' + String(n).padStart(2, '0') + 'T10:00:00',
    data_transacao: '2026-01-' + String(n).padStart(2, '0') + 'T10:00:00',
    description: 'Mock Open Finance ' + String(n).padStart(3, '0'),
    type: entrada ? 'DEPOSITO' : 'TARIFA',
    externalSource: CODIGO_PROVIDER.MOCK_OPEN_FINANCE,
    external_source: CODIGO_PROVIDER.MOCK_OPEN_FINANCE,
    externalId: 'OF-TX-' + String(n).padStart(3, '0'),
    external_id: 'OF-TX-' + String(n).padStart(3, '0'),
    saldo_apos_transacao: 1000 + n
  });
}

function pagina(de, ate, empresaId, contaId) {
  const transacoes = [];
  for (let n = de; n <= ate; n += 1) transacoes.push(montarItem(n, empresaId, contaId));
  return transacoes;
}

class MockOpenFinanceProvider extends IBankProvider {
  constructor() {
    super();
    this.saldoOverride = null;
    this.falharSaldo = false;
    this.falharNaPagina = 0;
    this.liberarPaginaExtra = false;
    this.falhaModo = null;
  }

  get codigo() {
    return CODIGO_PROVIDER.MOCK_OPEN_FINANCE;
  }

  get nome() {
    return 'Mock Open Finance';
  }

  get disponivel() {
    return true;
  }

  get suportaAutorizacao() {
    return true;
  }

  get suportaSincronizacao() {
    return true;
  }

  async conectar() {
    return { ok: true, modo: 'mock-open-finance' };
  }

  async desconectar() {
    return { ok: true };
  }

  async listarContas() {
    return [];
  }

  _falhaSimulada() {
    if (this.falhaModo === 'timeout') {
      throw erroMbc(ERROS.PROVIDER_TIMEOUT, 'Timeout simulado no provider.', 504);
    }
    if (this.falhaModo === 'rate_limit') {
      throw erroMbc(ERROS.PROVIDER_RATE_LIMIT, 'Rate limit simulado no provider.', 429);
    }
    if (this.falhaModo === 'indisponivel') {
      throw erroMbc(ERROS.PROVIDER_INDISPONIVEL, 'Provider indisponível (simulado).', 503);
    }
    return null;
  }

  async consultarSaldo() {
    this._falhaSimulada();
    if (this.falharSaldo) {
      throw erroMbc(ERROS.PROVIDER_INDISPONIVEL, 'Falha simulada ao consultar saldo.', 502);
    }
    const valor = this.saldoOverride != null ? this.saldoOverride : SALDO_PADRAO;
    return {
      valor,
      data: SALDO_DATA,
      natureza: 'informado_banco',
      rotulo: 'Saldo bancário (informado pelo provider)'
    };
  }

  async listarTransacoes(params = {}) {
    const empresaId = params.empresaId != null ? params.empresaId : params.empresa_id;
    const contaId = params.contaBancariaId != null ? params.contaBancariaId : params.conta_bancaria_id;
    const cursor = params.cursor == null || params.cursor === '' ? null : String(params.cursor);
    this._falhaSimulada();
    if (this.falhaModo === 'cursor_invalido' && cursor && cursor !== 'CURSOR-001' && cursor !== 'CURSOR-002' && cursor !== 'CURSOR-003') {
      throw erroMbc(ERROS.CURSOR_INVALIDO, 'Cursor inválido (simulado).', 400);
    }

    if (this.falharNaPagina === 1 && !cursor) {
      throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Falha simulada na página 1.', 502);
    }
    if (this.falharNaPagina === 2 && cursor === 'CURSOR-001') {
      throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Falha simulada na página 2.', 502);
    }

    if (!cursor) {
      return {
        transacoes: pagina(1, 10, empresaId, contaId),
        has_more: true,
        next_cursor: 'CURSOR-001'
      };
    }
    if (cursor === 'CURSOR-001') {
      return {
        transacoes: pagina(11, 20, empresaId, contaId),
        has_more: false,
        next_cursor: 'CURSOR-002'
      };
    }
    if (cursor === 'CURSOR-002' && this.liberarPaginaExtra) {
      return {
        transacoes: pagina(21, 25, empresaId, contaId),
        has_more: false,
        next_cursor: 'CURSOR-003'
      };
    }
    return { transacoes: [], has_more: false, next_cursor: cursor };
  }

  async iniciarAutorizacao(params = {}) {
    const state = String(params.state || '').trim();
    if (!state) {
      throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Autorização inválida.', 400);
    }
    return {
      authorization_url: '/api/bancario/open-finance/mock-autorizar?state=' + encodeURIComponent(state)
    };
  }

  async processarCallback(params = {}) {
    const query = params.query || {};
    const erro = String(query.error || query.erro || '').toLowerCase();
    const resultado = String(query.resultado || '').toLowerCase();
    if (erro === 'access_denied' || resultado === 'negado') {
      return { status: STATUS_CONSENTIMENTO.NEGADO };
    }
    return {
      status: STATUS_CONSENTIMENTO.AUTORIZADO,
      consentimento_externo_id: 'OF-MOCK-CONSENT-001'
    };
  }

  async revogarAutorizacao() {
    return { ok: true };
  }
}

module.exports = { MockOpenFinanceProvider, SALDO_PADRAO };
