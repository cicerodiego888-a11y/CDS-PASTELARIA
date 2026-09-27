/**
 * CandidatoManifestacaoDTO — Contrato do candidato à ciência 210210 / consChNFe
 * por empresa (preparação P01 — CENTRAL-ENTRADAS-04).
 *
 * Função pura: não consulta banco nem SEFAZ. Usada pela seleção de candidatos
 * (CentralManifestacaoDfeService._selecionarCandidatosManifestacao — CE-06 P01).
 * Prazo e urgência vêm exclusivamente de calcularPrazoManifestacao (CENTRAL-XML-02 P0).
 *
 * @module motores/central-entradas/contracts/CandidatoManifestacaoDTO
 */

'use strict';

const {
  PRAZO_CIENCIA_DIAS,
  calcularPrazoManifestacao
} = require('../utils/prazoManifestacao');

const ESTADOS_MANIFESTACAO = Object.freeze({
  SEM_CIENCIA: 'SEM_CIENCIA',
  CIENCIA_ENVIADA: 'CIENCIA_ENVIADA',
  CIENCIA_ACEITA: 'CIENCIA_ACEITA',
  PRAZO_EXPIRADO_596: 'PRAZO_EXPIRADO_596'
});

function dataValida(valor) {
  if (!valor) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

function resolverEstadoManifestacao(estado = {}) {
  if (estado.cienciaAceita) return ESTADOS_MANIFESTACAO.CIENCIA_ACEITA;
  if (String(estado.cStatCiencia || '') === '596') return ESTADOS_MANIFESTACAO.PRAZO_EXPIRADO_596;
  if (estado.cienciaEnviada) return ESTADOS_MANIFESTACAO.CIENCIA_ENVIADA;
  return ESTADOS_MANIFESTACAO.SEM_CIENCIA;
}

/**
 * Prioridade (menor = mais urgente). `null` = não elegível agora.
 * SEM_CIENCIA dentro do prazo vem primeiro, ordenado pelos dias restantes;
 * sem dhEmi com hora e offset o prazo é desconhecido e a ciência automática não é permitida.
 */
function calcularPrioridade({ estadoManifestacao, prazo, agora, gateBloqueado, claimAtivo, proximaConsultaEm }) {
  if (gateBloqueado || claimAtivo) return null;
  if (proximaConsultaEm && agora < proximaConsultaEm) return null;
  switch (estadoManifestacao) {
    case ESTADOS_MANIFESTACAO.SEM_CIENCIA:
      if (!prazo.valido) return null;
      return prazo.expirado ? 300 : Math.max(0, prazo.diasRestantes);
    case ESTADOS_MANIFESTACAO.CIENCIA_ACEITA:
    case ESTADOS_MANIFESTACAO.CIENCIA_ENVIADA:
      return 100;
    case ESTADOS_MANIFESTACAO.PRAZO_EXPIRADO_596:
      return 200;
    default:
      return 300;
  }
}

/**
 * @param {Object} documento  registro da Central (camelCase ou snake_case; dhEmi/xml opcionais)
 * @param {Object} [estado]
 * @param {string|null} [estado.cnpj]              CNPJ da empresa destinatária
 * @param {boolean} [estado.cienciaEnviada]
 * @param {boolean} [estado.cienciaAceita]
 * @param {string|null} [estado.cStatCiencia]
 * @param {string|null} [estado.ultimoCStat]
 * @param {string|Date|null} [estado.proximaConsultaEm]
 * @param {boolean} [estado.gateBloqueado]         Gate da empresa (empresaId+CNPJ+ambiente)
 * @param {boolean} [estado.claimAtivo]
 * @param {Date} [agora]
 */
function montarCandidatoManifestacao(documento = {}, estado = {}, agora = new Date()) {
  const empresaId = Number(documento.empresaId ?? documento.empresa_id) || null;
  const cnpj = String(
    estado.cnpj || documento.cnpjDestinatario || documento.cnpj_destinatario || ''
  ).replace(/\D/g, '') || null;
  const prazo = calcularPrazoManifestacao(documento, agora);
  const proximaConsultaEm = dataValida(estado.proximaConsultaEm);
  const estadoManifestacao = resolverEstadoManifestacao(estado);
  const gateBloqueado = estado.gateBloqueado === true;
  const claimAtivo = estado.claimAtivo === true;

  return Object.freeze({
    documentoId: Number(documento.id) || null,
    chave: documento.chave || null,
    numero: documento.numero || null,
    empresaId,
    cnpj,
    dataEmissao: prazo.emissaoEm,
    dhEmi: prazo.dhEmi,
    fontePrazo: prazo.fonte,
    prazoValido: prazo.valido,
    motivoPrazoInvalido: prazo.motivo,
    dataLimiteManifestacao: prazo.prazoFinal,
    tempoRestanteMs: prazo.tempoRestanteMs,
    diasRestantes: prazo.diasRestantes,
    dentroDaJanela: prazo.dentroDaJanela,
    expirado: prazo.expirado,
    urgencia: prazo.urgencia,
    estadoManifestacao,
    ultimoCStat: estado.ultimoCStat != null ? String(estado.ultimoCStat) : null,
    proximaConsultaEm: proximaConsultaEm ? proximaConsultaEm.toISOString() : null,
    gateBloqueado,
    claimAtivo,
    prioridade: calcularPrioridade({
      estadoManifestacao,
      prazo,
      agora,
      gateBloqueado,
      claimAtivo,
      proximaConsultaEm
    })
  });
}

module.exports = {
  PRAZO_CIENCIA_DIAS,
  ESTADOS_MANIFESTACAO,
  montarCandidatoManifestacao
};
