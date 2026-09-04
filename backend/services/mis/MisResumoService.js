/**
 * Orquestração do resumo MIS (04.02 + 05).
 * Sem SQL. Sem consolidação. Sem MUC.
 * @module services/mis/MisResumoService
 */
'use strict';

const {
  exigirEmpresaId,
  faturamentoPorEmpresa,
  faturamentoDiarioPorEmpresa,
  comprasPorEmpresa,
  financeiroReceberPorEmpresa,
  fiscalNfcePorEmpresa,
  rankingProdutosPorEmpresa,
  estoqueCriticoPorEmpresa
} = require('./MisIndicadoresService');
const { calcularPeriodoAnterior, calcularVariacaoPercentual } = require('./misPeriodo');

function validarPeriodo(inicio, fim) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(inicio || '')) || !re.test(String(fim || '')) || String(inicio) > String(fim)) {
    const err = new Error('Período inválido.');
    err.code = 'PERIODO_INVALIDO';
    err.statusCode = 400;
    throw err;
  }
  return { inicio: String(inicio), fim: String(fim) };
}

function snapshotVendas(row) {
  return {
    faturamento: row.faturamento,
    vendas: row.total_vendas,
    ticket_medio: row.ticket_medio
  };
}

function montarComparacao(atualVendas, anteriorVendas, periodoAtual, periodoAnterior) {
  const atual = snapshotVendas(atualVendas);
  const anterior = snapshotVendas(anteriorVendas);
  const fat = calcularVariacaoPercentual(atual.faturamento, anterior.faturamento);
  const qtd = calcularVariacaoPercentual(atual.vendas, anterior.vendas);
  const tkt = calcularVariacaoPercentual(atual.ticket_medio, anterior.ticket_medio);
  return {
    habilitada: true,
    periodo_atual: { inicio: periodoAtual.inicio, fim: periodoAtual.fim },
    periodo_anterior: periodoAnterior,
    atual,
    anterior,
    variacao: {
      faturamento: fat.percentual,
      vendas: qtd.percentual,
      ticket_medio: tkt.percentual,
      faturamento_estado: fat.estado,
      vendas_estado: qtd.estado,
      ticket_medio_estado: tkt.estado
    }
  };
}

async function obterResumoMis(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { inicio, fim } = validarPeriodo(params.inicio, params.fim);
  const modoFiscal = params.modoFiscal != null ? params.modoFiscal : '0';
  const db = params.db;
  const comparar = params.comparar === true || params.comparar === 1 || params.comparar === '1';
  const base = { db, empresaId, inicio, fim, modoFiscal };

  const jobs = [
    faturamentoPorEmpresa(base),
    comprasPorEmpresa(base),
    financeiroReceberPorEmpresa(base),
    fiscalNfcePorEmpresa(base),
    rankingProdutosPorEmpresa({ ...base, limite: 10 }),
    estoqueCriticoPorEmpresa({ db, empresaId, modoFiscal, limite: 10 }),
    faturamentoDiarioPorEmpresa(base)
  ];

  let periodoAnt = null;
  if (comparar) {
    periodoAnt = calcularPeriodoAnterior(inicio, fim);
    jobs.push(faturamentoPorEmpresa({
      db,
      empresaId,
      inicio: periodoAnt.inicio,
      fim: periodoAnt.fim,
      modoFiscal
    }));
  }

  const results = await Promise.all(jobs);
  const vendas = results[0];
  const compras = results[1];
  const receber = results[2];
  const fiscal = results[3];
  const ranking = results[4];
  const estoque = results[5];
  const diario = results[6];
  const vendasAnterior = comparar ? results[7] : null;

  return {
    empresa_id: empresaId,
    periodo: { inicio, fim },
    vendas: {
      faturamento: vendas.faturamento,
      total_vendas: vendas.total_vendas,
      ticket_medio: vendas.ticket_medio
    },
    compras: {
      total: compras.total,
      quantidade: compras.quantidade
    },
    receber: {
      total: receber.total,
      quantidade: receber.quantidade,
      natureza: 'em_aberto'
    },
    fiscal: {
      quantidade: fiscal.quantidade,
      total: fiscal.total
    },
    ranking: ranking.produtos,
    estoque_critico: estoque.produtos,
    evolucao: diario.serie,
    comparacao: comparar
      ? montarComparacao(vendas, vendasAnterior, { inicio, fim }, periodoAnt)
      : { habilitada: false }
  };
}

module.exports = {
  validarPeriodo,
  obterResumoMis,
  calcularPeriodoAnterior,
  calcularVariacaoPercentual,
  montarComparacao
};
