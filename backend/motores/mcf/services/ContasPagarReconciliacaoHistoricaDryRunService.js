/**
 * MCF-02.2 — Dry-run de reconciliação histórica de Contas a Pagar.
 * SOMENTE LEITURA: nenhuma INSERT/UPDATE/DELETE.
 *
 * @module motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService
 */
'use strict';

const { round2, erroMcf, ERROS_MCF } = require('../contracts/constantesMcf');
const {
  ORIGEM_PROJECAO,
  REFERENCIA_TIPO_PROJECAO
} = require('./ContasPagarFinanceiroCompatGuard');

const ACOES = Object.freeze({
  VINCULAR: 'vincular',
  CRIAR_TITULO: 'criar_titulo',
  IGNORAR: 'ignorar',
  REVISAO_MANUAL: 'revisao_manual'
});

const CONF_ALTA = 'alta';
const CONF_MEDIA = 'media';
const CONF_BAIXA = 'baixa';
const CONF_NENHUMA = 'nenhuma';

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function exigirEmpresaId(empresaId) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMcf(ERROS_MCF.EMPRESA_OBRIGATORIA, 'empresa_id obrigatório para dry-run.', 400);
  }
  return id;
}

function valorQuaseIgual(a, b) {
  return Math.abs(round2(a) - round2(b)) <= 0.01;
}

function normalizarTexto(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

function chaveCompraParcela(empresaId, compraId, numeroParcela) {
  return `${empresaId}|compra|${compraId}|${numeroParcela}`;
}

function chaveDocumento(empresaId, documento, valor, vencimento) {
  return `${empresaId}|doc|${normalizarTexto(documento)}|${round2(valor)}|${vencimento || ''}`;
}

function chaveFornecedor(empresaId, pessoa, valor, data) {
  return `${empresaId}|forn|${normalizarTexto(pessoa)}|${round2(valor)}|${data || ''}`;
}

/**
 * Status legado é informativo. Não inferimos quitação/saldo parcial
 * apenas pelo status — saldo_conhecido permanece null quando não verificável.
 */
function classificarSituacaoLegado(row) {
  const status = normalizarTexto(row.status);
  const valor = round2(row.valor);
  const conhecido = Number.isFinite(valor);
  return {
    status_legado: row.status || null,
    valor_lancamento: conhecido ? valor : null,
    saldo_conhecido: null,
    saldo_verificavel: false,
    situacao_informativa: status || 'desconhecido'
  };
}

function sugerirAcaoPorStatus(statusLegado, temMatchUnico, temDivergencia, semEmpresa) {
  if (semEmpresa) return ACOES.REVISAO_MANUAL;
  if (temDivergencia) return ACOES.REVISAO_MANUAL;
  if (temMatchUnico) return ACOES.VINCULAR;
  const st = normalizarTexto(statusLegado);
  if (st === 'cancelado' || st === 'cancelada') return ACOES.IGNORAR;
  if (st === 'pago' || st === 'recebido' || st === 'parcial' || st === 'pendente' || !st) {
    return ACOES.CRIAR_TITULO;
  }
  return ACOES.REVISAO_MANUAL;
}

async function carregarCandidatosFinanceiro(db, empresaId) {
  return dbAll(
    db,
    `SELECT
       f.id AS financeiro_id,
       f.empresa_id,
       f.tipo,
       f.descricao,
       f.valor,
       f.data_movimento,
       f.vencimento,
       f.status,
       f.origem,
       f.referencia_tipo,
       f.referencia_id,
       f.documento,
       f.numero_parcela,
       f.total_parcelas,
       f.compra_id,
       f.pessoa_nome,
       f.categoria,
       f.observacao
     FROM financeiro f
     WHERE f.tipo = 'despesa'
       AND f.empresa_id = ?
       AND COALESCE(f.origem, '') <> ?
       AND COALESCE(f.referencia_tipo, '') <> ?
       AND f.id NOT IN (
         SELECT financeiro_id FROM contas_pagar_financeiro_compat WHERE empresa_id = ?
       )
     ORDER BY f.id ASC`,
    [empresaId, ORIGEM_PROJECAO, REFERENCIA_TIPO_PROJECAO, empresaId]
  );
}

async function carregarTitulosMcf(db, empresaId) {
  return dbAll(
    db,
    `SELECT
       cp.id AS conta_pagar_id,
       cp.empresa_id,
       cp.descricao,
       cp.valor_original,
       cp.valor_restante,
       cp.status,
       cp.data_emissao,
       cp.data_vencimento,
       cp.documento,
       cp.origem,
       cp.referencia_tipo,
       cp.referencia_id,
       cp.numero_parcela,
       cp.total_parcelas,
       cp.pessoa_nome,
       f.nome AS fornecedor_nome,
       EXISTS (
         SELECT 1 FROM contas_pagar_financeiro_compat c
         WHERE c.empresa_id = cp.empresa_id AND c.conta_pagar_id = cp.id
       ) AS tem_projecao
     FROM contas_pagar cp
     LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
     WHERE cp.empresa_id = ?
     ORDER BY cp.id ASC`,
    [empresaId]
  );
}

function indexarTitulos(titulos) {
  const porCompraParcela = new Map();
  const porDocumento = new Map();
  const porFornecedor = new Map();

  for (const t of titulos) {
    if (t.referencia_tipo === 'compra' && t.referencia_id != null && t.numero_parcela != null) {
      const k = chaveCompraParcela(t.empresa_id, t.referencia_id, t.numero_parcela);
      if (!porCompraParcela.has(k)) porCompraParcela.set(k, []);
      porCompraParcela.get(k).push(t);
    }
    if (t.documento) {
      const k = chaveDocumento(t.empresa_id, t.documento, t.valor_original, t.data_vencimento);
      if (!porDocumento.has(k)) porDocumento.set(k, []);
      porDocumento.get(k).push(t);
    }
    const pessoa = t.pessoa_nome || t.fornecedor_nome;
    if (pessoa) {
      const data = t.data_vencimento || t.data_emissao;
      const k = chaveFornecedor(t.empresa_id, pessoa, t.valor_original, data);
      if (!porFornecedor.has(k)) porFornecedor.set(k, []);
      porFornecedor.get(k).push(t);
    }
  }
  return { porCompraParcela, porDocumento, porFornecedor };
}

function avaliarMatch(fin, indices) {
  const candidatos = [];
  const justificativas = [];
  const empresaId = fin.empresa_id;
  const compraId = fin.compra_id != null ? fin.compra_id : (
    fin.referencia_tipo === 'compra' ? fin.referencia_id : null
  );
  const numeroParcela = fin.numero_parcela != null ? Number(fin.numero_parcela) : 1;

  if (fin.origem === 'compra' && compraId != null) {
    const k = chaveCompraParcela(empresaId, compraId, numeroParcela);
    const hits = indices.porCompraParcela.get(k) || [];
    for (const t of hits) {
      const divergenciaValor = !valorQuaseIgual(fin.valor, t.valor_original);
      const divergenciaVenc = fin.vencimento
        && t.data_vencimento
        && String(fin.vencimento) !== String(t.data_vencimento);
      candidatos.push({
        conta_pagar_id: t.conta_pagar_id,
        criterio: 'compra_parcela',
        confianca: divergenciaValor || divergenciaVenc ? CONF_MEDIA : CONF_ALTA,
        divergencia_valor: divergenciaValor,
        divergencia_vencimento: !!divergenciaVenc,
        tem_projecao: !!t.tem_projecao,
        valor_original: round2(t.valor_original),
        valor_restante: round2(t.valor_restante),
        status_mcf: t.status
      });
      if (divergenciaValor || divergenciaVenc) {
        justificativas.push(
          `Match compra/parcela com divergência`
          + (divergenciaValor ? ` valor legado=${round2(fin.valor)} MCF=${round2(t.valor_original)}` : '')
          + (divergenciaVenc ? ` vencimento legado=${fin.vencimento} MCF=${t.data_vencimento}` : '')
        );
      }
    }
  }

  if (candidatos.length === 0 && fin.documento) {
    const k = chaveDocumento(empresaId, fin.documento, fin.valor, fin.vencimento);
    const hits = indices.porDocumento.get(k) || [];
    for (const t of hits) {
      candidatos.push({
        conta_pagar_id: t.conta_pagar_id,
        criterio: 'documento_valor_vencimento',
        confianca: CONF_MEDIA,
        divergencia_valor: false,
        divergencia_vencimento: false,
        tem_projecao: !!t.tem_projecao,
        valor_original: round2(t.valor_original),
        valor_restante: round2(t.valor_restante),
        status_mcf: t.status
      });
    }
  }

  if (candidatos.length === 0 && fin.pessoa_nome) {
    const data = fin.vencimento || fin.data_movimento;
    const k = chaveFornecedor(empresaId, fin.pessoa_nome, fin.valor, data);
    const hits = indices.porFornecedor.get(k) || [];
    for (const t of hits) {
      candidatos.push({
        conta_pagar_id: t.conta_pagar_id,
        criterio: 'fornecedor_valor_data',
        confianca: CONF_BAIXA,
        divergencia_valor: false,
        divergencia_vencimento: false,
        tem_projecao: !!t.tem_projecao,
        valor_original: round2(t.valor_original),
        valor_restante: round2(t.valor_restante),
        status_mcf: t.status
      });
    }
  }

  // Dedup por conta_pagar_id (mantém melhor confiança)
  const rank = { [CONF_ALTA]: 3, [CONF_MEDIA]: 2, [CONF_BAIXA]: 1, [CONF_NENHUMA]: 0 };
  const porId = new Map();
  for (const c of candidatos) {
    const prev = porId.get(c.conta_pagar_id);
    if (!prev || rank[c.confianca] > rank[prev.confianca]) {
      porId.set(c.conta_pagar_id, c);
    }
  }
  const unicos = [...porId.values()];

  return { candidatos: unicos, justificativas };
}

function montarItem(fin, match) {
  const situacao = classificarSituacaoLegado(fin);
  const semEmpresa = fin.empresa_id == null || !Number.isInteger(Number(fin.empresa_id));
  const { candidatos, justificativas } = match;

  let acao = ACOES.CRIAR_TITULO;
  let confianca = CONF_NENHUMA;
  let candidato = null;
  let justificativa = null;

  if (semEmpresa) {
    acao = ACOES.REVISAO_MANUAL;
    justificativa = 'Lançamento sem empresa_id válido.';
  } else if (candidatos.length > 1) {
    acao = ACOES.REVISAO_MANUAL;
    confianca = CONF_BAIXA;
    justificativa = `Correspondência ambígua: ${candidatos.length} títulos MCF candidatos.`;
  } else if (candidatos.length === 1) {
    candidato = candidatos[0];
    confianca = candidato.confianca;
    const divergente = candidato.divergencia_valor || candidato.divergencia_vencimento;
    if (divergente || candidato.tem_projecao) {
      acao = ACOES.REVISAO_MANUAL;
      justificativa = divergente
        ? (justificativas[0] || 'Match com divergência de valor/vencimento.')
        : 'Título MCF já possui projeção vinculada; risco de dupla obrigação se vincular o legado.';
    } else {
      acao = ACOES.VINCULAR;
      justificativa = `Match 1:1 por ${candidato.criterio}.`;
    }
  } else {
    const st = normalizarTexto(fin.status);
    if (st === 'cancelado' || st === 'cancelada') {
      acao = ACOES.IGNORAR;
      justificativa = 'Cancelado no legado sem título MCF correspondente; ignorar até revisão pontual.';
    } else if (!fin.documento && !fin.pessoa_nome && fin.origem !== 'compra') {
      acao = ACOES.REVISAO_MANUAL;
      justificativa = 'Sem documento/fornecedor/origem compra suficiente para criar título automaticamente.';
    } else {
      acao = sugerirAcaoPorStatus(fin.status, false, false, false);
      justificativa = 'Sem candidato MCF; sugerido criar título em etapa futura (sem execução neste dry-run).';
      // Status pago/parcial: não inferir saldo — revisão se não houver evidência de valores de pagamento
      if (st === 'parcial' || st === 'pago' || st === 'recebido') {
        acao = ACOES.REVISAO_MANUAL;
        justificativa = 'Status legado indica pagamento, mas saldo/quitação não é inferido só pelo status; revisão manual.';
      }
    }
  }

  return {
    empresa_id: fin.empresa_id != null ? Number(fin.empresa_id) : null,
    financeiro_id: Number(fin.financeiro_id),
    descricao: fin.descricao || null,
    origem: fin.origem || null,
    documento: fin.documento || null,
    compra_id: fin.compra_id != null ? Number(fin.compra_id) : null,
    numero_parcela: fin.numero_parcela != null ? Number(fin.numero_parcela) : null,
    valor_lancamento: situacao.valor_lancamento,
    saldo_conhecido: situacao.saldo_conhecido,
    saldo_verificavel: situacao.saldo_verificavel,
    status_legado: situacao.status_legado,
    situacao_informativa: situacao.situacao_informativa,
    candidato_mcf: candidato,
    candidatos_ambiguidade: candidatos.length > 1 ? candidatos : [],
    criterio: candidato ? candidato.criterio : null,
    confianca,
    acao_sugerida: acao,
    justificativa
  };
}

function agregarTotais(itens) {
  const base = () => ({
    quantidade: 0,
    valor_conhecido: 0,
    valor_nao_verificavel_qtd: 0
  });
  const porAcao = {
    [ACOES.VINCULAR]: base(),
    [ACOES.CRIAR_TITULO]: base(),
    [ACOES.IGNORAR]: base(),
    [ACOES.REVISAO_MANUAL]: base()
  };
  for (const item of itens) {
    const bucket = porAcao[item.acao_sugerida] || porAcao[ACOES.REVISAO_MANUAL];
    bucket.quantidade += 1;
    if (item.valor_lancamento != null && Number.isFinite(item.valor_lancamento)) {
      bucket.valor_conhecido = round2(bucket.valor_conhecido + item.valor_lancamento);
    } else {
      bucket.valor_nao_verificavel_qtd += 1;
    }
  }
  const gerais = base();
  for (const a of Object.keys(porAcao)) {
    gerais.quantidade += porAcao[a].quantidade;
    gerais.valor_conhecido = round2(gerais.valor_conhecido + porAcao[a].valor_conhecido);
    gerais.valor_nao_verificavel_qtd += porAcao[a].valor_nao_verificavel_qtd;
  }
  return { por_acao: porAcao, gerais };
}

/**
 * Executa dry-run somente leitura para uma empresa.
 * @returns {Promise<object>}
 */
async function executarDryRun({ db, empresaId } = {}) {
  if (!db) throw new Error('db é obrigatório para dry-run.');
  const emp = exigirEmpresaId(empresaId);

  const [candidatosFin, titulos] = await Promise.all([
    carregarCandidatosFinanceiro(db, emp),
    carregarTitulosMcf(db, emp)
  ]);
  const indices = indexarTitulos(titulos);

  // Contagem de títulos MCF já apontados por mais de um financeiro (ambiguidade inversa)
  const usoTitulo = new Map();
  const itensBrutos = candidatosFin.map((fin) => {
    const match = avaliarMatch(fin, indices);
    for (const c of match.candidatos) {
      usoTitulo.set(c.conta_pagar_id, (usoTitulo.get(c.conta_pagar_id) || 0) + 1);
    }
    return montarItem(fin, match);
  });

  const itens = itensBrutos.map((item) => {
    if (
      item.candidato_mcf
      && usoTitulo.get(item.candidato_mcf.conta_pagar_id) > 1
      && item.acao_sugerida === ACOES.VINCULAR
    ) {
      return {
        ...item,
        acao_sugerida: ACOES.REVISAO_MANUAL,
        confianca: CONF_BAIXA,
        justificativa: 'Mesmo título MCF casou com mais de um lançamento legado; revisão manual.'
      };
    }
    return item;
  });

  const totais = agregarTotais(itens);
  const projecoesExcluidas = await dbGet(
    db,
    `SELECT COUNT(*) AS n FROM financeiro
     WHERE empresa_id = ? AND tipo = 'despesa'
       AND (origem = ? OR referencia_tipo = ?)`,
    [emp, ORIGEM_PROJECAO, REFERENCIA_TIPO_PROJECAO]
  );
  const universoDespesas = await dbGet(
    db,
    `SELECT COUNT(*) AS n FROM financeiro WHERE empresa_id = ? AND tipo = 'despesa'`,
    [emp]
  );
  const jaVinculadosCompat = await dbGet(
    db,
    `SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat WHERE empresa_id = ?`,
    [emp]
  );
  const fingerprint = itens
    .map((i) => [
      i.financeiro_id,
      i.acao_sugerida,
      i.confianca,
      i.candidato_mcf ? i.candidato_mcf.conta_pagar_id : '',
      i.valor_lancamento == null ? '' : round2(i.valor_lancamento)
    ].join(':'))
    .sort()
    .join('|');

  const cobertura = {
    despesas_totais_empresa: Number(universoDespesas?.n || 0),
    projecoes_excluidas: Number(projecoesExcluidas?.n || 0),
    ja_vinculados_compat: Number(jaVinculadosCompat?.n || 0),
    candidatos_elegiveis: itens.length,
    // elegíveis = totais - projeções - (linhas já no compat; projeções normalmente já estão no compat)
    formula: 'despesas_totais - projecoes - demais_ja_no_compat ≈ candidatos (aprox.)'
  };

  return {
    modo: 'dry-run',
    somente_leitura: true,
    empresa_id: emp,
    gerado_em: new Date().toISOString(),
    itens,
    totais_empresa: totais,
    cobertura,
    fingerprint,
    meta: {
      candidatos_legado: itens.length,
      titulos_mcf: titulos.length,
      projecoes_excluidas_do_universo: Number(projecoesExcluidas?.n || 0),
      aviso: 'Nenhuma escrita foi executada. Saldo parcial/quitação não é inferido só pelo status legado.'
    }
  };
}

/**
 * Dry-run multiempresa (lista de empresas) — ainda somente SELECT.
 */
async function executarDryRunMultiempresa({ db, empresaIds } = {}) {
  if (!db) throw new Error('db é obrigatório.');
  const ids = Array.isArray(empresaIds) && empresaIds.length
    ? empresaIds.map(exigirEmpresaId)
    : (await dbAll(db, 'SELECT id FROM empresas WHERE COALESCE(ativo, 1) = 1 ORDER BY id'))
      .map((r) => Number(r.id));

  const porEmpresa = [];
  for (const id of ids) {
    porEmpresa.push(await executarDryRun({ db, empresaId: id }));
  }

  const totaisGerais = {
    quantidade: 0,
    valor_conhecido: 0,
    valor_nao_verificavel_qtd: 0,
    por_acao: {
      [ACOES.VINCULAR]: { quantidade: 0, valor_conhecido: 0, valor_nao_verificavel_qtd: 0 },
      [ACOES.CRIAR_TITULO]: { quantidade: 0, valor_conhecido: 0, valor_nao_verificavel_qtd: 0 },
      [ACOES.IGNORAR]: { quantidade: 0, valor_conhecido: 0, valor_nao_verificavel_qtd: 0 },
      [ACOES.REVISAO_MANUAL]: { quantidade: 0, valor_conhecido: 0, valor_nao_verificavel_qtd: 0 }
    }
  };

  for (const rel of porEmpresa) {
    const g = rel.totais_empresa.gerais;
    totaisGerais.quantidade += g.quantidade;
    totaisGerais.valor_conhecido = round2(totaisGerais.valor_conhecido + g.valor_conhecido);
    totaisGerais.valor_nao_verificavel_qtd += g.valor_nao_verificavel_qtd;
    for (const acao of Object.keys(totaisGerais.por_acao)) {
      const src = rel.totais_empresa.por_acao[acao];
      totaisGerais.por_acao[acao].quantidade += src.quantidade;
      totaisGerais.por_acao[acao].valor_conhecido = round2(
        totaisGerais.por_acao[acao].valor_conhecido + src.valor_conhecido
      );
      totaisGerais.por_acao[acao].valor_nao_verificavel_qtd += src.valor_nao_verificavel_qtd;
    }
  }

  return {
    modo: 'dry-run',
    somente_leitura: true,
    gerado_em: new Date().toISOString(),
    empresas: porEmpresa,
    totais_gerais: totaisGerais
  };
}

module.exports = {
  ACOES,
  executarDryRun,
  executarDryRunMultiempresa,
  // exportados para testes unitários de matching
  avaliarMatch,
  montarItem,
  indexarTitulos,
  classificarSituacaoLegado,
  valorQuaseIgual
};
