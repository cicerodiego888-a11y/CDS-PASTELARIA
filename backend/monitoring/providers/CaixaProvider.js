/**
 * CaixaProvider — indicadores de sessão fiscal / não fiscal (somente leitura).
 * Sprint 05.45 — sessão ativa e totais filtrados por caixa_sessoes.empresa_id.
 */

const db = require('../../database');
const { FILTRO_VENDA_VALIDA, getExprValorVendaFiscal, getExprValorVendaNaoFiscal } = require('../../services/reportFiscalHelpers');
const { criarMonitoringResult } = require('../MonitoringResult');
const { num, dbGetFactory } = require('../monitoringDateHelpers');
const {
  empresaIdOperacionalCaixa,
  obterSessaoAtivaDaEmpresa,
  montarSqlSomaMovimentacaoDaSessaoDaEmpresa
} = require('../../utils/caixaSessaoHelpers');
const { resolverEmpresaIdParaCaixa } = require('../../services/caixa/CaixaEmpresaContextoService');

function montarBlocoCaixa({ abertura, entradas, sangrias, suprimentos, fechamento, status, sessaoId, abertoEm, fechadoEm }) {
  const saidas = num(sangrias);
  const saldo = num(abertura) + num(entradas) + num(suprimentos) - saidas;
  return {
    saldo,
    entradas: num(entradas),
    saidas,
    suprimentos: num(suprimentos),
    sangrias: num(sangrias),
    abertura: num(abertura),
    fechamento: fechamento != null ? num(fechamento) : null,
    status: status || null,
    sessaoId: sessaoId || null,
    abertoEm: abertoEm || null,
    fechadoEm: fechadoEm || null
  };
}

function blocoVazio(status = 'fechado') {
  return montarBlocoCaixa({
    abertura: 0,
    entradas: 0,
    sangrias: 0,
    suprimentos: 0,
    fechamento: null,
    status
  });
}

async function resolverEmpresaIdDoContextoCaixa(context = {}, deps = {}) {
  const direto = empresaIdOperacionalCaixa(context.empresaId);
  if (direto) return direto;
  try {
    const resolved = await resolverEmpresaIdParaCaixa({
      empresaId: context.empresaId,
      headers: context.headers || {},
      user: context.user || (context.usuarioId ? { id: context.usuarioId } : null)
    }, {
      exigirAutorizacaoUsuario: false,
      db: deps.db || context.db || null
    });
    return empresaIdOperacionalCaixa(resolved && resolved.empresaId);
  } catch (err) {
    const code = err && err.code;
    if (
      code === 'CAIXA_EMPRESA_OBRIGATORIA'
      || code === 'EMPRESA_OPERACIONAL_AUSENTE'
      || code === 'EMPRESA_OPERACIONAL_AMBIGUA'
      || code === 'EMPRESA_CONTEXT_REQUIRED'
    ) {
      return null;
    }
    throw err;
  }
}

async function sumVendasSessaoDaEmpresa(dbGet, exprValor, sessaoId, empresaId) {
  if (!sessaoId || !empresaId) return { total: 0 };
  return dbGet(
    `SELECT COALESCE(SUM(${exprValor}), 0) AS total
     FROM vendas v
     INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
     WHERE ${FILTRO_VENDA_VALIDA}
       AND v.caixa_sessao_id = ?
       AND cs.empresa_id = ?`,
    [sessaoId, empresaId]
  );
}

async function sumMovimentacoesDaEmpresa(dbConn, tipo, sessaoId, empresaId) {
  const q = montarSqlSomaMovimentacaoDaSessaoDaEmpresa({ sessaoId, empresaId, tipo });
  return new Promise((resolve, reject) => {
    dbConn.get(q.sql, q.params, (err, row) => {
      if (err) reject(err);
      else resolve(row || { total: 0 });
    });
  });
}

const CaixaProvider = {
  id: 'caixa',

  async collect(context = {}) {
    const inicio = Date.now();
    const warnings = [];
    const errors = [];
    const dbConn = context.db || db;
    const dbGet = dbGetFactory(dbConn);

    const resultadoVazio = (status, warning, extra = {}) => criarMonitoringResult({
      success: true,
      source: 'CaixaProvider',
      metrics: { tempoConsultaMs: Date.now() - inicio },
      data: {
        caixa: {
          empresaId: extra.empresaId != null ? extra.empresaId : null,
          fiscal: blocoVazio(status),
          naoFiscal: { ...blocoVazio(status), abertura: 0 }
        }
      },
      warnings,
      errors
    });

    try {
      const empresaId = await resolverEmpresaIdDoContextoCaixa(context, { db: dbConn });
      if (empresaId == null) {
        warnings.push('caixa: contexto empresarial obrigatório');
        return resultadoVazio('fechado', null, { empresaId: null });
      }

      const sessao = await obterSessaoAtivaDaEmpresa(dbConn, { empresaId });
      if (!sessao || !sessao.id) {
        warnings.push('CAIXA_SESSAO_NAO_ENCONTRADA');
        return resultadoVazio('fechado', null, { empresaId });
      }

      const sessaoId = sessao.id;
      const abertura = num(sessao.valor_abertura);
      const fechamento = sessao.valor_fechamento != null ? num(sessao.valor_fechamento) : null;
      const exprF = getExprValorVendaFiscal();
      const exprNf = getExprValorVendaNaoFiscal();

      const [vendasF, vendasNf, sangrias, suprimentos] = await Promise.all([
        sumVendasSessaoDaEmpresa(dbGet, exprF, sessaoId, empresaId),
        sumVendasSessaoDaEmpresa(dbGet, exprNf, sessaoId, empresaId),
        sumMovimentacoesDaEmpresa(dbConn, 'sangria', sessaoId, empresaId),
        sumMovimentacoesDaEmpresa(dbConn, 'suprimento', sessaoId, empresaId)
      ]);

      const sang = num(sangrias.total);
      const supr = num(suprimentos.total);
      const fiscal = montarBlocoCaixa({
        abertura,
        entradas: num(vendasF.total),
        sangrias: sang,
        suprimentos: supr,
        fechamento,
        status: sessao.status,
        sessaoId,
        abertoEm: sessao.aberto_em || null,
        fechadoEm: sessao.fechado_em || null
      });
      const naoFiscal = montarBlocoCaixa({
        abertura: 0,
        entradas: num(vendasNf.total),
        sangrias: 0,
        suprimentos: 0,
        fechamento: null,
        status: sessao.status,
        sessaoId,
        abertoEm: sessao.aberto_em || null,
        fechadoEm: sessao.fechado_em || null
      });

      return criarMonitoringResult({
        success: true,
        source: 'CaixaProvider',
        metrics: { tempoConsultaMs: Date.now() - inicio },
        data: { caixa: { empresaId, fiscal, naoFiscal } },
        warnings,
        errors
      });
    } catch (err) {
      errors.push(err.message || String(err));
      const vazio = blocoVazio('erro');
      return criarMonitoringResult({
        success: false,
        source: 'CaixaProvider',
        metrics: { tempoConsultaMs: Date.now() - inicio },
        data: { caixa: { empresaId: null, fiscal: vazio, naoFiscal: vazio } },
        warnings,
        errors
      });
    }
  }
};

module.exports = CaixaProvider;
module.exports.resolverEmpresaIdDoContextoCaixa = resolverEmpresaIdDoContextoCaixa;
