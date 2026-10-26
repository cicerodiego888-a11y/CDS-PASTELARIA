/**
 * MCF-02.3 — Simulação da reconciliação histórica (sem persistência).
 * Produz o estado esperado após as ações do dry-run, sem INSERT/UPDATE/DELETE.
 *
 * @module motores/mcf/services/ContasPagarReconciliacaoHistoricaSimulacaoService
 */
'use strict';

const { round2, erroMcf, ERROS_MCF } = require('../contracts/constantesMcf');
const DryRun = require('./ContasPagarReconciliacaoHistoricaDryRunService');
const {
  ORIGEM_PROJECAO,
  sqlExcluirProjecaoMcf
} = require('./ContasPagarFinanceiroCompatGuard');

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
    throw erroMcf(ERROS_MCF.EMPRESA_OBRIGATORIA, 'empresa_id obrigatório para simulação.', 400);
  }
  return id;
}

/**
 * Indicadores atuais (antes) — leitura apenas, sem dupla contagem título+projeção.
 */
async function capturarIndicadoresAtuais(db, empresaId) {
  const emp = exigirEmpresaId(empresaId);
  const excl = sqlExcluirProjecaoMcf('f');

  const mcfAberto = await dbGet(
    db,
    `SELECT
       COUNT(*) AS qtd,
       COALESCE(SUM(valor_original), 0) AS valor_original,
       COALESCE(SUM(valor_restante), 0) AS saldo_confirmado
     FROM contas_pagar
     WHERE empresa_id = ? AND status IN ('aberto', 'parcial')`,
    [emp]
  );
  const mcfQuitados = await dbGet(
    db,
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor_original), 0) AS valor_original
     FROM contas_pagar WHERE empresa_id = ? AND status = 'quitada'`,
    [emp]
  );
  const mcfCancelados = await dbGet(
    db,
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor_original), 0) AS valor_original
     FROM contas_pagar WHERE empresa_id = ? AND status = 'cancelada'`,
    [emp]
  );
  const mcfPagamentos = await dbGet(
    db,
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor_pago), 0) AS valor
     FROM contas_pagar_pagamentos WHERE empresa_id = ?`,
    [emp]
  );
  const legadoHistoricoAberto = await dbGet(
    db,
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(f.valor), 0) AS valor
     FROM financeiro f
     WHERE f.empresa_id = ? AND f.tipo = 'despesa'
       AND f.status NOT IN ('pago','recebido','cancelado')
       ${excl}`,
    [emp]
  );
  const projecoes = await dbGet(
    db,
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor), 0) AS valor
     FROM financeiro
     WHERE empresa_id = ? AND tipo = 'despesa' AND origem = ?`,
    [emp, ORIGEM_PROJECAO]
  );
  const compat = await dbGet(
    db,
    `SELECT COUNT(*) AS qtd FROM contas_pagar_financeiro_compat WHERE empresa_id = ?`,
    [emp]
  );

  return {
    empresa_id: emp,
    mcf_abertos: {
      quantidade: Number(mcfAberto.qtd || 0),
      valor_original: round2(mcfAberto.valor_original),
      saldo_confirmado: round2(mcfAberto.saldo_confirmado)
    },
    mcf_quitados: {
      quantidade: Number(mcfQuitados.qtd || 0),
      valor_original: round2(mcfQuitados.valor_original)
    },
    mcf_cancelados: {
      quantidade: Number(mcfCancelados.qtd || 0),
      valor_original: round2(mcfCancelados.valor_original)
    },
    mcf_pagamentos: {
      quantidade: Number(mcfPagamentos.qtd || 0),
      valor: round2(mcfPagamentos.valor)
    },
    legado_historico_aberto_sem_projecao: {
      quantidade: Number(legadoHistoricoAberto.qtd || 0),
      valor_conhecido: round2(legadoHistoricoAberto.valor),
      nota: 'Valor do lançamento; saldo residual não verificável só pelo status'
    },
    projecoes_compat: {
      quantidade: Number(projecoes.qtd || 0),
      valor: round2(projecoes.valor),
      vinculos: Number(compat.qtd || 0),
      nota: 'Não devem ser somadas aos títulos MCF nos indicadores'
    },
    // Indicador reconciliável: saldo MCF confirmado + legado histórico (sem projeção)
    total_a_pagar_sem_dupla_contagem: round2(
      round2(mcfAberto.saldo_confirmado) + round2(legadoHistoricoAberto.valor)
    )
  };
}

function simularEstadoAposAcoes(dryRun, indicadoresAntes) {
  const itens = dryRun.itens || [];
  const vinculados = [];
  const criarTitulo = [];
  const ignorados = [];
  const revisaoManual = [];

  let vinculosNovos = 0;
  let titulosNovosPropostos = 0;
  let valorTitulosNovosPropostos = 0;
  let valorLegadoRemovidoDoHistoricoAberto = 0;
  let valorNaoVerificavel = 0;

  for (const item of itens) {
    const acao = item.acao_sugerida;
    const snapshot = {
      financeiro_id: item.financeiro_id,
      valor_lancamento: item.valor_lancamento,
      status_legado: item.status_legado,
      saldo_conhecido: item.saldo_conhecido,
      saldo_verificavel: item.saldo_verificavel,
      candidato_mcf_id: item.candidato_mcf ? item.candidato_mcf.conta_pagar_id : null,
      criterio: item.criterio,
      confianca: item.confianca,
      justificativa: item.justificativa,
      estado_esperado: null
    };

    if (acao === DryRun.ACOES.VINCULAR) {
      vinculosNovos += 1;
      snapshot.estado_esperado = {
        operacao: 'vincular_legado_ao_titulo_mcf',
        conta_pagar_id: snapshot.candidato_mcf_id,
        cria_titulo: false,
        cria_pagamento_sintetico: false,
        altera_saldo_mcf: false,
        preserva_pagamentos_mcf_existentes: true,
        remove_do_universo_historico_aberto: ['pendente', 'parcial'].includes(
          String(item.status_legado || '').toLowerCase()
        ),
        nota: 'Apenas vínculo compat; título e pagamentos MCF permanecem como estão'
      };
      if (snapshot.estado_esperado.remove_do_universo_historico_aberto
        && item.valor_lancamento != null) {
        valorLegadoRemovidoDoHistoricoAberto = round2(
          valorLegadoRemovidoDoHistoricoAberto + item.valor_lancamento
        );
      }
      vinculados.push(snapshot);
    } else if (acao === DryRun.ACOES.CRIAR_TITULO) {
      titulosNovosPropostos += 1;
      if (item.valor_lancamento != null) {
        valorTitulosNovosPropostos = round2(valorTitulosNovosPropostos + item.valor_lancamento);
      } else {
        valorNaoVerificavel += 1;
      }
      snapshot.estado_esperado = {
        operacao: 'criar_titulo_mcf_proposto',
        conta_pagar_id: null,
        cria_titulo: true,
        // Status legado NÃO define saldo/quitação automaticamente
        status_titulo_proposto: 'aberto',
        valor_original_proposto: item.valor_lancamento,
        valor_restante_proposto: item.saldo_verificavel
          ? item.saldo_conhecido
          : item.valor_lancamento,
        cria_pagamento_sintetico: false,
        exige_evidencia_pagamento_antes_baixa: true,
        remove_do_universo_historico_aberto: true,
        nota: 'Criação proposta; pagamentos sintéticos NÃO são gerados nesta simulação nem no backfill sem evidência'
      };
      if (item.valor_lancamento != null
        && ['pendente', 'parcial'].includes(String(item.status_legado || '').toLowerCase())) {
        valorLegadoRemovidoDoHistoricoAberto = round2(
          valorLegadoRemovidoDoHistoricoAberto + item.valor_lancamento
        );
      }
      criarTitulo.push(snapshot);
    } else if (acao === DryRun.ACOES.IGNORAR) {
      snapshot.estado_esperado = {
        operacao: 'ignorar',
        cria_titulo: false,
        cria_pagamento_sintetico: false,
        remove_do_universo_historico_aberto: false,
        nota: 'Permanece histórico sem obrigação ativa MCF'
      };
      ignorados.push(snapshot);
    } else {
      snapshot.estado_esperado = {
        operacao: 'revisao_manual',
        cria_titulo: false,
        cria_pagamento_sintetico: false,
        aprovacao_automatica: false,
        remove_do_universo_historico_aberto: false,
        nota: 'Bloqueado para migração automática'
      };
      revisaoManual.push(snapshot);
      if (!item.saldo_verificavel) valorNaoVerificavel += 1;
    }
  }

  const saldoMcfConfirmado = indicadoresAntes.mcf_abertos.saldo_confirmado;
  const legadoAbertoApos = round2(
    Math.max(
      0,
      indicadoresAntes.legado_historico_aberto_sem_projecao.valor_conhecido
        - valorLegadoRemovidoDoHistoricoAberto
    )
  );
  // Após vincular/criar, o total a pagar canônico tende a: MCF atual + títulos novos (saldo proposto)
  // Vinculações NÃO somam de novo o valor legado (já está no MCF).
  const totalAPagarSimulado = round2(saldoMcfConfirmado + valorTitulosNovosPropostos + legadoAbertoApos);

  // Dupla contagem seria: MCF + projeções + legado do mesmo fato
  const duplaContagemEvitada = {
    nao_soma_projecoes: true,
    nao_soma_legado_apos_vincular: true,
    nao_cria_pagamento_sintetico: true,
    ambiguidade_nao_aprovada: revisaoManual.length === (dryRun.totais_empresa?.por_acao?.revisao_manual?.quantidade || revisaoManual.length)
  };

  return {
    vinculados,
    criar_titulo: criarTitulo,
    ignorados,
    revisao_manual: revisaoManual,
    resumo_simulacao: {
      vinculos_novos: vinculosNovos,
      titulos_novos_propostos: titulosNovosPropostos,
      valor_titulos_novos_propostos: valorTitulosNovosPropostos,
      ignorados: ignorados.length,
      revisao_manual: revisaoManual.length,
      valor_legado_deixaria_universo_aberto: valorLegadoRemovidoDoHistoricoAberto,
      itens_sem_saldo_verificavel: valorNaoVerificavel,
      saldo_mcf_confirmado_inalterado_por_vinculo: saldoMcfConfirmado,
      legado_historico_aberto_apos_simulacao: legadoAbertoApos,
      total_a_pagar_simulado_sem_dupla_contagem: totalAPagarSimulado
    },
    anti_duplicidade: duplaContagemEvitada
  };
}

/**
 * Executa dry-run + simulação + indicadores, sem persistir.
 */
async function executarSimulacao({ db, empresaId } = {}) {
  if (!db) throw new Error('db é obrigatório para simulação.');
  const emp = exigirEmpresaId(empresaId);

  const dryRun = await DryRun.executarDryRun({ db, empresaId: emp });
  const indicadoresAntes = await capturarIndicadoresAtuais(db, emp);
  const simulacao = simularEstadoAposAcoes(dryRun, indicadoresAntes);

  // Totais reconciliáveis: dry-run gerais devem bater com soma das ações da simulação
  const qtdSim = simulacao.vinculados.length
    + simulacao.criar_titulo.length
    + simulacao.ignorados.length
    + simulacao.revisao_manual.length;
  const reconciliacaoTotais = {
    candidatos_dry_run: dryRun.totais_empresa.gerais.quantidade,
    candidatos_simulacao: qtdSim,
    batimento_quantidade: dryRun.totais_empresa.gerais.quantidade === qtdSim,
    valor_conhecido_dry_run: dryRun.totais_empresa.gerais.valor_conhecido,
    fingerprint_dry_run: dryRun.fingerprint
  };

  return {
    modo: 'simulacao',
    somente_leitura: true,
    empresa_id: emp,
    gerado_em: new Date().toISOString(),
    dry_run: {
      cobertura: dryRun.cobertura,
      fingerprint: dryRun.fingerprint,
      totais_empresa: dryRun.totais_empresa,
      meta: dryRun.meta,
      itens: dryRun.itens
    },
    indicadores_antes: indicadoresAntes,
    simulacao,
    reconciliacao_totais: reconciliacaoTotais,
    aviso: 'Nenhuma alteração persistente. Aguardando aprovação Tech Lead para backfill.'
  };
}

/**
 * Valida estabilidade: dois dry-runs consecutivos devem ter o mesmo fingerprint.
 */
async function validarEstabilidadeDryRun({ db, empresaId } = {}) {
  const a = await DryRun.executarDryRun({ db, empresaId });
  const b = await DryRun.executarDryRun({ db, empresaId });
  return {
    estavel: a.fingerprint === b.fingerprint,
    fingerprint: a.fingerprint,
    fingerprint_segunda_execucao: b.fingerprint,
    quantidade: a.itens.length
  };
}

module.exports = {
  capturarIndicadoresAtuais,
  simularEstadoAposAcoes,
  executarSimulacao,
  validarEstabilidadeDryRun
};
