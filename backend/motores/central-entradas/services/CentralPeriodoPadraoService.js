/**
 * CentralPeriodoPadraoService — Período inicial de consulta da Central (CENTRAL-ENTRADAS-03).
 *
 * Persistido por empresa em central_entradas_config (chave periodo_padrao_empresa_<id>).
 * Define somente o estado inicial dos filtros data_emissao_inicio/data_emissao_fim da tela:
 * não apaga, oculta ou bloqueia documentos, NSU ou histórico.
 *
 * @module motores/central-entradas/services/CentralPeriodoPadraoService
 */

'use strict';

const CentralConfiguracaoRepository = require('../repositories/CentralConfiguracaoRepository');

const PERIODOS_PADRAO = Object.freeze({
  MES_VIGENTE: 'MES_VIGENTE',
  TODO_PERIODO: 'TODO_PERIODO'
});

const PERIODO_PADRAO_DEFAULT = PERIODOS_PADRAO.MES_VIGENTE;

const OPCOES_PERIODO_PADRAO = Object.freeze([
  Object.freeze({
    codigo: PERIODOS_PADRAO.MES_VIGENTE,
    label: 'Mês vigente',
    descricao: 'A partir do dia 01 do mês vigente'
  }),
  Object.freeze({
    codigo: PERIODOS_PADRAO.TODO_PERIODO,
    label: 'Todo o período',
    descricao: 'Exibir todo o período disponível'
  })
]);

const PREFIXO_CHAVE = 'periodo_padrao_empresa_';

function normalizarEmpresaId(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    const erro = new Error('Empresa inválida para o período padrão da Central.');
    erro.code = 'EMPRESA_CENTRAL_AUSENTE';
    erro.statusCode = 400;
    throw erro;
  }
  return n;
}

function chavePeriodoPadrao(empresaId) {
  return `${PREFIXO_CHAVE}${normalizarEmpresaId(empresaId)}`;
}

function periodoPadraoValido(valor) {
  return Object.values(PERIODOS_PADRAO).includes(String(valor || ''));
}

function formatarDataLocal(data) {
  const y = data.getFullYear();
  const m = String(data.getMonth() + 1).padStart(2, '0');
  const d = String(data.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * @param {string} periodo
 * @param {Date} [agora]
 * @returns {{ dataEmissaoInicio: string|null, dataEmissaoFim: string|null }}
 */
function calcularIntervaloPeriodoPadrao(periodo, agora = new Date()) {
  if (periodo === PERIODOS_PADRAO.TODO_PERIODO) {
    return { dataEmissaoInicio: null, dataEmissaoFim: null };
  }
  const primeiroDia = new Date(agora.getFullYear(), agora.getMonth(), 1);
  return {
    dataEmissaoInicio: formatarDataLocal(primeiroDia),
    dataEmissaoFim: formatarDataLocal(agora)
  };
}

class CentralPeriodoPadraoService {
  constructor(deps = {}) {
    this._repository = deps.configuracaoRepository
      ?? deps.configRepository
      ?? new CentralConfiguracaoRepository({ db: deps.db ?? null });
    this._agora = deps.agora || (() => new Date());
  }

  /**
   * @param {number} empresaId
   * @returns {Promise<Object>}
   */
  async obter(empresaId) {
    const id = normalizarEmpresaId(empresaId);
    const registro = await this._repository.buscarPorChave(chavePeriodoPadrao(id));
    const valor = registro ? this._repository.parseValor(registro) : null;
    const persistido = periodoPadraoValido(valor);
    const periodoPadrao = persistido ? valor : PERIODO_PADRAO_DEFAULT;
    return this._montarResposta(id, periodoPadrao, persistido, registro?.updatedAt || null);
  }

  /**
   * @param {number} empresaId
   * @param {string} periodoPadrao
   * @returns {Promise<Object>}
   */
  async salvar(empresaId, periodoPadrao) {
    const id = normalizarEmpresaId(empresaId);
    const valor = String(periodoPadrao || '').trim().toUpperCase();
    if (!periodoPadraoValido(valor)) {
      const erro = new Error('Período padrão inválido. Use MES_VIGENTE ou TODO_PERIODO.');
      erro.code = 'PERIODO_PADRAO_INVALIDO';
      erro.statusCode = 400;
      throw erro;
    }
    const registro = await this._repository.salvar(chavePeriodoPadrao(id), valor, 'string');
    return this._montarResposta(id, valor, true, registro?.updatedAt || null);
  }

  /** @private */
  _montarResposta(empresaId, periodoPadrao, persistido, atualizadoEm) {
    const opcao = OPCOES_PERIODO_PADRAO.find((o) => o.codigo === periodoPadrao);
    return {
      empresaId,
      periodoPadrao,
      periodoPadraoLabel: opcao.label,
      origem: persistido ? 'PERSISTIDO' : 'PADRAO_NOVO_CLIENTE',
      atualizadoEm,
      intervalo: calcularIntervaloPeriodoPadrao(periodoPadrao, this._agora()),
      opcoes: OPCOES_PERIODO_PADRAO.map((o) => ({ ...o }))
    };
  }
}

module.exports = CentralPeriodoPadraoService;
module.exports.PERIODOS_PADRAO = PERIODOS_PADRAO;
module.exports.PERIODO_PADRAO_DEFAULT = PERIODO_PADRAO_DEFAULT;
module.exports.OPCOES_PERIODO_PADRAO = OPCOES_PERIODO_PADRAO;
module.exports.chavePeriodoPadrao = chavePeriodoPadrao;
module.exports.calcularIntervaloPeriodoPadrao = calcularIntervaloPeriodoPadrao;
