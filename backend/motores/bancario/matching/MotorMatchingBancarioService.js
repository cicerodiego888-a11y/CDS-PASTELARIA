/**
 * Motor de matching. Sugere. Não concilia. Aceite chama MBC-04.
 * @module motores/bancario/matching/MotorMatchingBancarioService
 */
'use strict';

const { ERROS, erroMbc, DIRECAO, STATUS_CONCILIACAO } = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { JANELA_DIAS_MATCHING, RESULTADO_MATCHING, STATUS_SUGESTAO, NIVEL_CONFIANCA } = require('./contracts/constantesMatching');
const { montarCandidato } = require('./contracts/CandidatoConciliacao');
const { montarResultado } = require('./contracts/ResultadoMatching');
const { diasEntre, valoresIguais } = require('./MatchingNormalizacaoService');
const { calcularScore } = require('./MatchingScoreService');
const MatchingRepository = require('./MatchingRepository');
const TransacaoBancariaService = require('../services/TransacaoBancariaService');
const ContaBancariaService = require('../services/ContaBancariaService');
const ConciliacaoBancariaService = require('../services/ConciliacaoBancariaService');

function preFiltrar(tx, bruto) {
  return bruto
    .filter((r) => valoresIguais(tx.valor, r.valor))
    .filter((r) => {
      const d = diasEntre(tx.data_transacao, r.data);
      return d != null && d <= JANELA_DIAS_MATCHING;
    })
    .map((r) => montarCandidato({
      ...r,
      tipo_registro: r.origem_financeira,
      registro_id: r.registro_financeiro_id,
      empresa_id: tx.empresa_id
    }));
}

async function buscarCandidatos(params, tx) {
  if (tx.direcao === DIRECAO.TRANSFERENCIA) return [];
  const brutos = await ConciliacaoBancariaService.listarRegistrosElegiveis({
    db: params.db,
    empresaId: params.empresaId,
    direcao: tx.direcao
  });
  return preFiltrar(tx, brutos);
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

  const candidatos = await buscarCandidatos(params, tx);
  const pontuados = candidatos
    .map((c) => ({ candidato: c, ...calcularScore(tx, c) }))
    .filter((p) => p.sugerir)
    .sort((a, b) => b.score - a.score);

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
    const novas = (out.sugestoes || []).filter((s) => s.status === STATUS_SUGESTAO.PENDENTE);
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
  if (st.status === STATUS_CONCILIACAO.CONCILIADA) {
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
  if (!valoresIguais(atual.valor, tx.valor)) {
    throw erroMbc(ERROS.VALORES_INCOMPATIVEIS, 'Os valores não são compatíveis para conciliação.', 409);
  }

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
      valor_conciliado: tx.valor,
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
  listarSugestoes: MatchingRepository.listar,
  obterSugestao: MatchingRepository.obterNoContexto
};
