/**
 * CE-PASTELARIA-04/05 — Preparação da recuperação controlada da NF-e 4456.
 *
 * Somente checklist / pré-condições locais.
 * NÃO transmite DistDFe nem consChNFe.
 * NÃO libera FILA automaticamente.
 * NÃO altera NSU, cooldown, flags nem estado de produção.
 *
 * @module motores/central-entradas/procedures/preparacaoRecuperacaoNfe4456
 */
'use strict';

const CHAVE_NFE_4456 = '23261031255007000188550010000044561664976903';
const EMPRESA_ALVO_ID = 3;
const CNPJ_DESTINO = '38204469000204';
const NUMERO = '4456';
const SERIE = '1';

/**
 * Avalia pré-condições locais para uma futura DistDFe autorizada (mockável).
 *
 * @param {Object} estado
 * @returns {{ pronto: boolean, podeTransmitir: boolean, etapas: Object[], bloqueios: string[], avisos: string[], chave: string }}
 */
function avaliarPrecondicoesRecuperacaoNfe4456(estado = {}) {
  const etapas = [];
  const bloqueios = [];
  const avisos = [];

  const chaveOk = String(estado.chave || CHAVE_NFE_4456).replace(/\D/g, '') === CHAVE_NFE_4456;
  etapas.push({ id: 'chave_acesso', ok: chaveOk, detalhe: { chave: CHAVE_NFE_4456, numero: NUMERO, serie: SERIE } });
  if (!chaveOk) bloqueios.push('CHAVE_INVALIDA');

  const empresaOk = Number(estado.empresaId) === EMPRESA_ALVO_ID;
  const cnpjOk = String(estado.cnpj || '').replace(/\D/g, '') === CNPJ_DESTINO;
  const ambienteOk = Number(estado.ambiente) === 1 || Number(estado.ambiente) === 2;
  etapas.push({
    id: 'contexto_empresa',
    ok: empresaOk && cnpjOk && ambienteOk,
    detalhe: { empresaId: estado.empresaId, cnpj: estado.cnpj, ambiente: estado.ambiente }
  });
  if (!empresaOk || !cnpjOk || !ambienteOk) {
    bloqueios.push('CONTEXTO_EMPRESA_INVALIDO');
  }

  const certificadoOk = estado.certificadoDisponivel !== false
    && estado.certificadoDisponivel !== null
    && estado.certificadoIndisponivel !== true;
  etapas.push({
    id: 'certificado',
    ok: certificadoOk,
    detalhe: { certificadoDisponivel: estado.certificadoDisponivel !== false }
  });
  if (!certificadoOk) bloqueios.push('CERTIFICADO_INDISPONIVEL');

  const cooldownOk = estado.cooldownAtivo !== true;
  etapas.push({
    id: 'cooldown',
    ok: cooldownOk,
    detalhe: { motivo: estado.motivoCooldown || null, proximaConsultaEm: estado.proximaConsultaEm || null }
  });
  if (!cooldownOk) bloqueios.push('COOLDOWN_ATIVO');

  const filaOk = estado.filaEsgotada !== true;
  etapas.push({
    id: 'fila_esgotada',
    ok: filaOk,
    detalhe: {
      nota: 'Liberação local da FILA não recupera documentos e não autoriza transmissão DistDFe.'
    }
  });
  if (!filaOk) bloqueios.push('FILA_ESGOTADA');

  const concorrenciaOk = estado.consultaEmAndamento !== true
    && estado.backgroundPodeTransmitir !== true;
  etapas.push({
    id: 'concorrencia',
    ok: concorrenciaOk,
    detalhe: {
      consultaEmAndamento: estado.consultaEmAndamento === true,
      backgroundPodeTransmitir: estado.backgroundPodeTransmitir === true
    }
  });
  if (!concorrenciaOk) bloqueios.push('CONCORRENCIA_ATIVA');

  const decisaoOk = estado.decisaoCentralizadaFavoravel === true;
  etapas.push({
    id: 'decisao_centralizada',
    ok: decisaoOk,
    detalhe: { codigo: estado.codigoDecisao || null }
  });
  if (!decisaoOk) bloqueios.push('DECISAO_NAO_FAVORAVEL');

  const lockOk = estado.lockDisponivel !== false && estado.consultaEmAndamento !== true;
  etapas.push({ id: 'lock', ok: lockOk });
  if (!lockOk) bloqueios.push('LOCK_INDISPONIVEL');

  const preVooOk = estado.preVooOk === true;
  etapas.push({ id: 'pre_voo', ok: preVooOk });
  if (!preVooOk) bloqueios.push('PRE_VOO_PENDENTE');

  const authOk = estado.autorizacaoOperacaoRealAtiva === true
    && estado.confirmacaoOperador === true
    && estado.confirmacaoHumanaEspecifica === true;
  etapas.push({
    id: 'autorizacao_explicita',
    ok: authOk,
    detalhe: {
      maxTentativasDistDfe: 1,
      retryAutomatico656: false,
      liberacaoFilaNaoAutorizaTransmissao: true
    }
  });
  if (!authOk) bloqueios.push('AUTORIZACAO_AUSENTE');

  if (estado.filaLiberadaLocalmente === true) {
    avisos.push(
      'FILA liberada localmente: permite reavaliar decisão, mas NÃO recupera XML e NÃO dispara DistDFe.'
    );
  }

  const pronto = bloqueios.length === 0;
  return {
    pronto,
    podeTransmitir: pronto,
    chave: CHAVE_NFE_4456,
    empresaId: EMPRESA_ALVO_ID,
    cnpj: CNPJ_DESTINO,
    numero: NUMERO,
    serie: SERIE,
    etapas,
    bloqueios,
    avisos,
    regras: {
      maxTentativasDistDfePorAutorizacao: 1,
      interromperEmCStat: ['656', '137'],
      retryAutomatico: false,
      consChNFeExigeAutorizacaoSeparada: true,
      liberacaoFilaNaoRecuperaDocumento: true,
      liberacaoFilaNaoAutorizaTransmissao: true,
      sefazConsultadaNestaFuncao: false,
      alteraEstadoProducao: false
    }
  };
}

/**
 * Após DistDFe (resultado mock/autorizado), decide se consChNFe ainda é candidato.
 * Não executa consulta.
 *
 * @param {Object} resultadoDist
 * @returns {{ encerrar: boolean, sugerirConsChNFe: boolean, motivo: string }}
 */
function decidirPosDistDfeRecuperacao4456(resultadoDist = {}) {
  const cStat = String(resultadoDist.cStat || '');
  const chavePresente = resultadoDist.chavePresenteNoLote === true
    || (Array.isArray(resultadoDist.chaves) && resultadoDist.chaves.includes(CHAVE_NFE_4456));

  if (chavePresente) {
    return {
      encerrar: true,
      sugerirConsChNFe: false,
      motivo: 'DOCUMENTO_RECEBIDO_DISTDFE',
      exigirComprovacaoPersistenciaEmpresa: true,
      empresaIdEsperado: EMPRESA_ALVO_ID
    };
  }
  if (cStat === '656') {
    return {
      encerrar: true,
      sugerirConsChNFe: false,
      motivo: 'CSTAT_656_SEM_RETRY',
      sugerirConsChNFeAposAutorizacaoSeparada: true,
      retryAutomatico: false
    };
  }
  if (cStat === '137' || Number(resultadoDist.documentosRecebidos || 0) === 0) {
    return {
      encerrar: true,
      sugerirConsChNFe: false,
      motivo: 'DISTDFE_SEM_CHAVE',
      sugerirConsChNFeAposAutorizacaoSeparada: true,
      retryAutomatico: false
    };
  }
  return {
    encerrar: true,
    sugerirConsChNFe: false,
    motivo: 'INTERROMPER_SEM_RETRY',
    sugerirConsChNFeAposAutorizacaoSeparada: true,
    retryAutomatico: false
  };
}

module.exports = {
  CHAVE_NFE_4456,
  EMPRESA_ALVO_ID,
  CNPJ_DESTINO,
  NUMERO,
  SERIE,
  avaliarPrecondicoesRecuperacaoNfe4456,
  decidirPosDistDfeRecuperacao4456
};
