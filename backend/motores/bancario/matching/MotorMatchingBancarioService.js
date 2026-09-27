/**
 * Motor de matching. Sugere. Não concilia automaticamente.
 * MBC-05.2: respeita valor_disponivel (MBC-05.1). Aceite chama ConciliacaoBancariaService.
 * @module motores/bancario/matching/MotorMatchingBancarioService
 */
'use strict';

const {
  ERROS,
  erroMbc,
  DIRECAO,
  STATUS_CONCILIACAO,
  ORIGEM_FINANCEIRA,
  STATUS_TRANSACAO_CONCILIACAO
} = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const {
  JANELA_DIAS_MATCHING,
  RESULTADO_MATCHING,
  STATUS_SUGESTAO,
  NIVEL_CONFIANCA,
  COMPATIBILIDADE_MATCHING
} = require('./contracts/constantesMatching');
const { montarCandidato } = require('./contracts/CandidatoConciliacao');
const { montarResultado } = require('./contracts/ResultadoMatching');
const { diasEntre, valoresIguais } = require('./MatchingNormalizacaoService');
const { calcularScore } = require('./MatchingScoreService');
const MatchingRepository = require('./MatchingRepository');
const TransacaoBancariaService = require('../services/TransacaoBancariaService');
const ContaBancariaService = require('../services/ContaBancariaService');
const ConciliacaoBancariaService = require('../services/ConciliacaoBancariaService');

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function origemPermiteParcial(origem) {
  return String(origem || '') === ORIGEM_FINANCEIRA.CONTAS_RECEBER;
}

function classificarCompatibilidade(valorDispTx, valorDispCand, permiteParcial) {
  const dispTx = round2(valorDispTx);
  const dispCand = round2(valorDispCand);
  if (!(dispTx > 0) || !(dispCand > 0)) {
    return {
      compatibilidade: COMPATIBILIDADE_MATCHING.INCOMPATIVEL,
      valor_sugerido: 0
    };
  }
  if (!permiteParcial && dispCand > dispTx) {
    return {
      compatibilidade: COMPATIBILIDADE_MATCHING.INCOMPATIVEL,
      valor_sugerido: 0
    };
  }
  const sugerido = round2(Math.min(dispTx, dispCand));
  if (sugerido <= 0) {
    return {
      compatibilidade: COMPATIBILIDADE_MATCHING.INCOMPATIVEL,
      valor_sugerido: 0
    };
  }
  if (valoresIguais(dispCand, dispTx)) {
    return {
      compatibilidade: COMPATIBILIDADE_MATCHING.EXATA,
      valor_sugerido: sugerido
    };
  }
  if (valoresIguais(sugerido, dispCand) && dispCand < dispTx) {
    return {
      compatibilidade: COMPATIBILIDADE_MATCHING.COMPATIVEL,
      valor_sugerido: sugerido
    };
  }
  return {
    compatibilidade: COMPATIBILIDADE_MATCHING.PARCIAL,
    valor_sugerido: sugerido
  };
}

function montarMotivosObjetivos(tx, cand, compat, dias) {
  const motivos = ['MESMA_EMPRESA', 'MESMO_TIPO_MOVIMENTO'];
  if (compat === COMPATIBILIDADE_MATCHING.EXATA) motivos.push('VALOR_EXATO');
  else if (compat === COMPATIBILIDADE_MATCHING.COMPATIVEL) motivos.push('VALOR_COMPATIVEL');
  else if (compat === COMPATIBILIDADE_MATCHING.PARCIAL) motivos.push('VALOR_PARCIALMENTE_COMPATIVEL');
  if (dias != null && dias <= JANELA_DIAS_MATCHING) motivos.push('DATA_COMPATIVEL');
  return motivos;
}

function preFiltrar(tx, bruto, valorDisponivel) {
  const disp = round2(valorDisponivel);
  if (!(disp > 0)) return [];
  return bruto
    .filter((r) => Number(r.empresa_id) === Number(tx.empresa_id) || r.empresa_id == null)
    .filter((r) => {
      const vDisp = round2(
        r.valor_disponivel != null ? r.valor_disponivel : r.valor
      );
      if (!(vDisp > 0)) return false;
      const parcial = origemPermiteParcial(r.origem_financeira) || r.permite_parcial === true;
      if (!parcial && vDisp > disp) return false;
      const d = diasEntre(tx.data_transacao, r.data);
      return d != null && d <= JANELA_DIAS_MATCHING;
    })
    .map((r) => {
      const parcial = origemPermiteParcial(r.origem_financeira) || r.permite_parcial === true;
      const valorDispCand = round2(
        r.valor_disponivel != null ? r.valor_disponivel : r.valor
      );
      return montarCandidato({
        ...r,
        tipo_registro: r.origem_financeira,
        registro_id: r.registro_financeiro_id,
        empresa_id: tx.empresa_id,
        valor: valorDispCand,
        valor_original: r.valor_original != null ? r.valor_original : valorDispCand,
        valor_restante: r.valor_restante,
        valor_pago: r.valor_pago,
        valor_ja_conciliado: r.valor_ja_conciliado != null ? r.valor_ja_conciliado : 0,
        valor_disponivel: valorDispCand,
        permite_parcial: parcial,
        status: r.status,
        data_tipo: r.data_tipo,
        quantidade_pagamentos: r.quantidade_pagamentos,
        pagamentos: r.pagamentos,
        tipo: r.tipo,
        rotulo_entidade: r.rotulo_entidade || null
      });
    });
}

async function buscarCandidatos(params, tx, valorDisponivel) {
  if (tx.direcao === DIRECAO.TRANSFERENCIA) return [];
  const brutos = await ConciliacaoBancariaService.listarRegistrosElegiveis({
    db: params.db,
    empresaId: params.empresaId,
    direcao: tx.direcao
  });
  const disp = valorDisponivel != null
    ? valorDisponivel
    : await ConciliacaoBancariaService.calcularValorDisponivel({
      db: params.db,
      empresaId: params.empresaId,
      transacao: tx
    });
  return preFiltrar(tx, brutos, disp);
}

function ordenarCandidatosDeterministico(lista, valorDisponivel) {
  const disp = round2(valorDisponivel);
  const rank = {
    [COMPATIBILIDADE_MATCHING.EXATA]: 0,
    [COMPATIBILIDADE_MATCHING.COMPATIVEL]: 1,
    [COMPATIBILIDADE_MATCHING.PARCIAL]: 2,
    [COMPATIBILIDADE_MATCHING.INCOMPATIVEL]: 9
  };
  return lista.slice().sort((a, b) => {
    const ra = rank[a.compatibilidade] != null ? rank[a.compatibilidade] : 9;
    const rb = rank[b.compatibilidade] != null ? rank[b.compatibilidade] : 9;
    if (ra !== rb) return ra - rb;
    const ua = Math.abs(disp - round2(a.valor_sugerido));
    const ub = Math.abs(disp - round2(b.valor_sugerido));
    if (ua !== ub) return ua - ub;
    const da = a._dias != null ? a._dias : 99;
    const db = b._dias != null ? b._dias : 99;
    if (da !== db) return da - db;
    const ida = Number(a.alvo_id);
    const idb = Number(b.alvo_id);
    if (ida !== idb) return ida - idb;
    return String(a.tipo_alvo).localeCompare(String(b.tipo_alvo));
  });
}

async function transacaoAnalisavel(params, tx) {
  const st = await ConciliacaoBancariaService.obterStatusDaTransacao(params.db, tx.id);
  if (st.status === STATUS_CONCILIACAO.CONCILIADA) return false;
  if (st.status === STATUS_CONCILIACAO.IGNORADA) return false;
  if (st.status === STATUS_CONCILIACAO.DIVERGENTE) return false;
  return true;
}

async function gerarSugestoes(params, tx, pontuados) {
  const criadas = [];
  const existentes = [];
  for (const item of pontuados) {
    const out = await MatchingRepository.inserirSeNova(params.db, {
      empresa_id: tx.empresa_id,
      transacao_bancaria_id: tx.id,
      tipo_registro: item.candidato.tipo_registro,
      registro_id: item.candidato.registro_id,
      score: item.score,
      nivel_confianca: item.nivel_confianca,
      motivos: item.motivos,
      valor_candidato: item.candidato.valor,
      data_candidato: item.candidato.data
    });
    if (out.criada) criadas.push(out.row);
    else existentes.push(out.row);
  }
  return { criadas, existentes, todas: criadas.concat(existentes) };
}

/**
 * Consulta somente leitura. Não grava sugestão nem conciliação.
 */
async function obterMatchingTransacao(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const tx = await TransacaoBancariaService.obterNoContexto({
    db: params.db,
    empresaId,
    id: params.transacao_bancaria_id || params.id
  });
  if (Number(tx.empresa_id) !== Number(empresaId)) {
    throw erroMbc(ERROS.TRANSACAO_NAO_ENCONTRADA, 'Transação bancária não encontrada.', 404);
  }
  await ContaBancariaService.obterNoContexto({
    db: params.db,
    empresaId,
    id: tx.conta_bancaria_id
  });

  const st = await ConciliacaoBancariaService.obterStatusDaTransacao(params.db, tx.id);
  const valorTotal = round2(st.valor_total != null ? st.valor_total : tx.valor);
  const valorConciliado = round2(st.valor_conciliado || 0);
  const valorDisponivel = round2(st.valor_disponivel != null ? st.valor_disponivel : 0);

  if (
    st.status_conciliacao === STATUS_TRANSACAO_CONCILIACAO.CONCILIADA
    || st.status === STATUS_CONCILIACAO.CONCILIADA
    || valorDisponivel <= 0
  ) {
    return {
      transacao_id: tx.id,
      transacao_bancaria_id: tx.id,
      empresa_id: empresaId,
      conta_bancaria_id: tx.conta_bancaria_id,
      direcao: tx.direcao,
      data: tx.data_transacao,
      descricao: tx.descricao,
      valor_transacao: valorTotal,
      valor_conciliado: valorConciliado,
      valor_disponivel: 0,
      estado: STATUS_TRANSACAO_CONCILIACAO.CONCILIADA,
      status_conciliacao: STATUS_TRANSACAO_CONCILIACAO.CONCILIADA,
      candidatos: []
    };
  }

  if (
    st.status === STATUS_CONCILIACAO.IGNORADA
    || st.status === STATUS_CONCILIACAO.DIVERGENTE
  ) {
    return {
      transacao_id: tx.id,
      transacao_bancaria_id: tx.id,
      empresa_id: empresaId,
      conta_bancaria_id: tx.conta_bancaria_id,
      direcao: tx.direcao,
      data: tx.data_transacao,
      descricao: tx.descricao,
      valor_transacao: valorTotal,
      valor_conciliado: valorConciliado,
      valor_disponivel: valorDisponivel,
      estado: st.status_conciliacao || st.status,
      status_conciliacao: st.status_conciliacao || st.status,
      candidatos: []
    };
  }

  const brutos = await buscarCandidatos(params, tx, valorDisponivel);
  const candidatos = [];
  for (const c of brutos) {
    if (Number(c.empresa_id) !== Number(empresaId)) continue;
    const classif = classificarCompatibilidade(
      valorDisponivel,
      c.valor_disponivel,
      c.permite_parcial === true
    );
    if (classif.compatibilidade === COMPATIBILIDADE_MATCHING.INCOMPATIVEL) continue;
    const dias = diasEntre(tx.data_transacao, c.data);
    const motivos = montarMotivosObjetivos(tx, c, classif.compatibilidade, dias);
    candidatos.push({
      tipo_alvo: c.tipo_registro,
      tipo_registro: c.tipo_registro,
      alvo_id: c.registro_id,
      registro_id: c.registro_id,
      descricao: c.descricao,
      data: c.data,
      data_tipo: c.data_tipo || null,
      status: c.status,
      valor_original: c.valor_original,
      valor_restante: c.valor_restante,
      valor_pago: c.valor_pago,
      valor_ja_conciliado: c.valor_ja_conciliado,
      valor_disponivel: c.valor_disponivel,
      valor_sugerido: classif.valor_sugerido,
      quantidade_pagamentos: c.quantidade_pagamentos,
      pagamentos: c.pagamentos,
      tipo: c.tipo || null,
      rotulo_entidade: c.rotulo_entidade || null,
      compatibilidade: classif.compatibilidade,
      motivos,
      _dias: dias
    });
  }

  const ordenados = ordenarCandidatosDeterministico(candidatos, valorDisponivel)
    .map((c) => {
      const { _dias, ...rest } = c;
      return rest;
    });

  return {
    transacao_id: tx.id,
    transacao_bancaria_id: tx.id,
    empresa_id: empresaId,
    conta_bancaria_id: tx.conta_bancaria_id,
    direcao: tx.direcao,
    data: tx.data_transacao,
    descricao: tx.descricao,
    valor_transacao: valorTotal,
    valor_conciliado: valorConciliado,
    valor_disponivel: valorDisponivel,
    estado: st.status_conciliacao || STATUS_TRANSACAO_CONCILIACAO.NAO_CONCILIADA,
    status_conciliacao: st.status_conciliacao || STATUS_TRANSACAO_CONCILIACAO.NAO_CONCILIADA,
    candidatos: ordenados
  };
}

async function analisarTransacao(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const tx = await TransacaoBancariaService.obterNoContexto({
    db: params.db,
    empresaId,
    id: params.transacao_bancaria_id || params.id
  });
  if (Number(tx.empresa_id) !== Number(empresaId)) {
    throw erroMbc(ERROS.TRANSACAO_NAO_ENCONTRADA, 'Transação bancária não encontrada.', 404);
  }
  await ContaBancariaService.obterNoContexto({
    db: params.db,
    empresaId,
    id: tx.conta_bancaria_id
  });

  if (!(await transacaoAnalisavel(params, tx))) {
    return montarResultado({
      transacao_bancaria_id: tx.id,
      empresa_id: empresaId,
      resultado: RESULTADO_MATCHING.JA_CONCILIADA,
      candidatos: [],
      sugestoes: []
    });
  }

  const valorDisponivel = await ConciliacaoBancariaService.calcularValorDisponivel({
    db: params.db,
    empresaId,
    transacao: tx
  });
  const candidatos = await buscarCandidatos(params, tx, valorDisponivel);
  const pontuados = candidatos
    .map((c) => ({
      candidato: c,
      ...calcularScore(tx, c, { valor_disponivel: valorDisponivel })
    }))
    .filter((p) => p.sugerir)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Number(a.candidato.registro_id) - Number(b.candidato.registro_id);
    });

  const persistidas = await gerarSugestoes(params, tx, pontuados);
  let resultado = RESULTADO_MATCHING.NENHUM;
  if (pontuados.length === 1) resultado = RESULTADO_MATCHING.UNICO;
  if (pontuados.length > 1) resultado = RESULTADO_MATCHING.MULTIPLOS;

  return montarResultado({
    transacao_bancaria_id: tx.id,
    empresa_id: empresaId,
    resultado,
    candidatos: pontuados,
    sugestoes: persistidas.todas,
    criadas: persistidas.criadas.length
  });
}

async function analisarConta(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const conta = await ContaBancariaService.obterNoContexto({
    db: params.db,
    empresaId,
    id: params.conta_bancaria_id || params.id
  });
  const txs = await TransacaoBancariaService.listar({
    db: params.db,
    empresaId,
    conta_bancaria_id: conta.id,
    limite: 200
  });
  let transacoes_analisadas = 0;
  let sugestoes_criadas = 0;
  let alta_confianca = 0;
  let media_confianca = 0;
  let baixa_confianca = 0;
  let sem_candidato = 0;

  for (const tx of txs) {
    const out = await analisarTransacao({
      db: params.db,
      empresaId,
      transacao_bancaria_id: tx.id
    });
    transacoes_analisadas += 1;
    if (out.resultado === RESULTADO_MATCHING.JA_CONCILIADA) continue;
    if (out.resultado === RESULTADO_MATCHING.NENHUM) {
      sem_candidato += 1;
      continue;
    }
    sugestoes_criadas += Number(out.criadas) || 0;
    (out.candidatos || []).forEach((c) => {
      if (c.nivel_confianca === NIVEL_CONFIANCA.ALTA) alta_confianca += 1;
      else if (c.nivel_confianca === NIVEL_CONFIANCA.MEDIA) media_confianca += 1;
      else if (c.nivel_confianca === NIVEL_CONFIANCA.BAIXA) baixa_confianca += 1;
    });
  }

  return {
    empresa_id: empresaId,
    conta_bancaria_id: conta.id,
    transacoes_analisadas,
    sugestoes_criadas,
    alta_confianca,
    media_confianca,
    baixa_confianca,
    sem_candidato
  };
}

async function aceitarSugestao(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const sugestao = await MatchingRepository.obterNoContexto({
    db: params.db,
    empresaId,
    id: params.id
  });
  if (sugestao.status === STATUS_SUGESTAO.ACEITA) {
    throw erroMbc(ERROS.SUGESTAO_INVALIDA, 'Sugestão já foi aceita.', 409);
  }
  if (sugestao.status === STATUS_SUGESTAO.RECUSADA) {
    throw erroMbc(ERROS.SUGESTAO_INVALIDA, 'Sugestão já foi recusada.', 409);
  }
  if (sugestao.status !== STATUS_SUGESTAO.PENDENTE) {
    throw erroMbc(ERROS.SUGESTAO_INVALIDA, 'Sugestão não está pendente.', 409);
  }
  if (Number(sugestao.empresa_id) !== Number(empresaId)) {
    throw erroMbc(ERROS.SUGESTAO_NAO_ENCONTRADA, 'Sugestão de conciliação não encontrada.', 404);
  }

  const tx = await TransacaoBancariaService.obterNoContexto({
    db: params.db,
    empresaId,
    id: sugestao.transacao_bancaria_id
  });
  const st = await ConciliacaoBancariaService.obterStatusDaTransacao(params.db, tx.id);
  if (st.status === STATUS_CONCILIACAO.CONCILIADA || round2(st.valor_disponivel) <= 0) {
    await MatchingRepository.atualizarStatus(
      params.db, sugestao.id, empresaId, STATUS_SUGESTAO.PENDENTE, STATUS_SUGESTAO.EXPIRADA
    );
    throw erroMbc(ERROS.JA_CONCILIADA, 'A transação já está conciliada.', 409);
  }

  const registro = await ConciliacaoBancariaService.listarRegistrosElegiveis({
    db: params.db,
    empresaId,
    direcao: tx.direcao
  });
  const atual = registro.find((r) =>
    r.origem_financeira === sugestao.tipo_registro && Number(r.registro_financeiro_id) === Number(sugestao.registro_id)
  );
  if (!atual || !valoresIguais(atual.valor, sugestao.valor_candidato)) {
    await MatchingRepository.atualizarStatus(
      params.db, sugestao.id, empresaId, STATUS_SUGESTAO.PENDENTE, STATUS_SUGESTAO.EXPIRADA
    );
    throw erroMbc(ERROS.MATCHING_CONFLITO, 'O registro candidato mudou. Execute nova análise.', 409);
  }

  const disponivel = round2(st.valor_disponivel);
  const valorCand = round2(
    atual.valor_disponivel != null ? atual.valor_disponivel : atual.valor
  );
  const permiteParcial = origemPermiteParcial(atual.origem_financeira)
    || atual.permite_parcial === true;
  const classif = classificarCompatibilidade(disponivel, valorCand, permiteParcial);
  if (classif.compatibilidade === COMPATIBILIDADE_MATCHING.INCOMPATIVEL || classif.valor_sugerido <= 0) {
    throw erroMbc(ERROS.VALORES_INCOMPATIVEIS, 'Os valores não são compatíveis para conciliação.', 409);
  }
  const valorConciliar = classif.valor_sugerido;

  const locked = await MatchingRepository.atualizarStatus(
    params.db, sugestao.id, empresaId, STATUS_SUGESTAO.PENDENTE, STATUS_SUGESTAO.ACEITA
  );
  if (!locked) {
    throw erroMbc(ERROS.MATCHING_CONFLITO, 'A sugestão já foi decidida.', 409);
  }

  try {
    const conc = await ConciliacaoBancariaService.conciliar({
      db: params.db,
      empresaId,
      transacao_bancaria_id: tx.id,
      origem_financeira: sugestao.tipo_registro,
      registro_financeiro_id: sugestao.registro_id,
      valor_conciliado: valorConciliar,
      origem_conciliacao: 'SISTEMA',
      observacao: 'Aceite de sugestão de matching'
    });
    await MatchingRepository.expirarPendentesDaTransacao(params.db, empresaId, tx.id, sugestao.id);
    const aceita = await MatchingRepository.obterNoContexto({ db: params.db, empresaId, id: sugestao.id });
    return { sugestao: aceita, conciliacao: conc };
  } catch (err) {
    await MatchingRepository.atualizarStatus(
      params.db, sugestao.id, empresaId, STATUS_SUGESTAO.ACEITA, STATUS_SUGESTAO.PENDENTE
    );
    throw err;
  }
}

async function recusarSugestao(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const atual = await MatchingRepository.obterNoContexto({
    db: params.db,
    empresaId,
    id: params.id
  });
  if (atual.status === STATUS_SUGESTAO.RECUSADA) return atual;
  if (atual.status !== STATUS_SUGESTAO.PENDENTE) {
    throw erroMbc(ERROS.SUGESTAO_INVALIDA, 'Sugestão não está pendente.', 409);
  }
  const ok = await MatchingRepository.atualizarStatus(
    params.db, atual.id, empresaId, STATUS_SUGESTAO.PENDENTE, STATUS_SUGESTAO.RECUSADA
  );
  if (!ok) {
    throw erroMbc(ERROS.MATCHING_CONFLITO, 'A sugestão já foi decidida.', 409);
  }
  return MatchingRepository.obterNoContexto({ db: params.db, empresaId, id: atual.id });
}

module.exports = {
  analisarTransacao,
  analisarConta,
  buscarCandidatos,
  calcularScore,
  gerarSugestoes,
  aceitarSugestao,
  recusarSugestao,
  obterMatchingTransacao,
  classificarCompatibilidade,
  listarSugestoes: MatchingRepository.listar,
  obterSugestao: MatchingRepository.obterNoContexto,
  COMPATIBILIDADE_MATCHING
};
