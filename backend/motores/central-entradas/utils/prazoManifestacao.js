/**
 * prazoManifestacao — relógio oficial da Ciência da Emissão (210210) no CDS (CENTRAL-XML-02 P0/P1).
 *
 * O prazo parte do timestamp real de emissão (dhEmi, com hora e offset) e soma exatamente
 * PRAZO_CIENCIA_DIAS × 24 h. Datas sem horário (YYYY-MM-DD) ou sem offset não são aceitas
 * como relógio: a meia-noite artificial antecipava o prazo em até ~24 h, e um horário sem offset
 * dependeria do fuso do processo (cálculo não determinístico).
 *
 * A urgência (NORMAL/ATENCAO/URGENTE/EXPIRADO) é classificação operacional do CDS e não altera
 * o prazo definido pelo Ambiente Nacional. Backend é a autoridade; o frontend apenas exibe.
 *
 * Função pura: não consulta banco nem SEFAZ.
 *
 * @module motores/central-entradas/utils/prazoManifestacao
 */

'use strict';

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
/** Prazo observado para a ciência 210210 antes do cStat 596 ("[10 dias]"). */
const PRAZO_CIENCIA_DIAS = 10;
const PRAZO_CIENCIA_MS = PRAZO_CIENCIA_DIAS * DIA_MS;
const LIMITE_ATENCAO_MS = 48 * HORA_MS;
const LIMITE_URGENTE_MS = 24 * HORA_MS;
const FUSO_EXIBICAO = 'America/Sao_Paulo';

const URGENCIA_MANIFESTACAO = Object.freeze({
  NORMAL: 'NORMAL',
  ATENCAO: 'ATENCAO',
  URGENTE: 'URGENTE',
  EXPIRADO: 'EXPIRADO',
  /** Sem dhEmi com hora e offset: prazo real desconhecido, sem ciência automática. */
  INDETERMINADO: 'INDETERMINADO'
});

/** Ordem de atendimento: URGENTE → ATENCAO → NORMAL (demais não são enviados). */
const ORDEM_URGENCIA = Object.freeze([
  URGENCIA_MANIFESTACAO.URGENTE,
  URGENCIA_MANIFESTACAO.ATENCAO,
  URGENCIA_MANIFESTACAO.NORMAL
]);

const MOTIVOS_PRAZO_INVALIDO = Object.freeze({
  DHEMI_AUSENTE: 'DHEMI_AUSENTE',
  DHEMI_SEM_HORARIO_OU_OFFSET: 'DHEMI_SEM_HORARIO_OU_OFFSET'
});

const RE_TIMESTAMP_COM_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const RE_DHEMI_XML = /<(?:[\w.-]+:)?dhEmi>\s*([^<]+?)\s*<\/(?:[\w.-]+:)?dhEmi>/i;

function extrairDhEmiXml(xml) {
  if (!xml) return null;
  return String(xml).match(RE_DHEMI_XML)?.[1] || null;
}

function dhEmiDoParse(parseJson) {
  if (!parseJson || typeof parseJson !== 'object') return null;
  return parseJson.ide?.dhEmi
    || parseJson.dhEmi
    || parseJson.cabecalho?.dhEmi
    || parseJson.nfe?.ide?.dhEmi
    || null;
}

/**
 * Primeiro timestamp com hora e offset entre as fontes do documento, em ordem de confiança.
 * @returns {{ fonte: string, dhEmi: string, ms: number } | { fonte: null, motivo: string }}
 */
function resolverDhEmi(documento = {}) {
  const fontes = [
    ['dhEmi', documento.dhEmi ?? documento.dh_emi],
    ['xml', extrairDhEmiXml(documento.xml)],
    ['parseJson', dhEmiDoParse(documento.parseJson ?? documento.parse_json)],
    ['dataEmissao', documento.dataEmissao ?? documento.data_emissao]
  ];
  let algumValor = false;
  for (const [fonte, valor] of fontes) {
    if (valor == null || valor === '') continue;
    algumValor = true;
    const texto = valor instanceof Date
      ? (Number.isNaN(valor.getTime()) ? '' : valor.toISOString())
      : String(valor).trim();
    if (!RE_TIMESTAMP_COM_OFFSET.test(texto)) continue;
    const ms = Date.parse(texto);
    if (Number.isFinite(ms)) return { fonte, dhEmi: texto, ms };
  }
  return {
    fonte: null,
    motivo: algumValor
      ? MOTIVOS_PRAZO_INVALIDO.DHEMI_SEM_HORARIO_OU_OFFSET
      : MOTIVOS_PRAZO_INVALIDO.DHEMI_AUSENTE
  };
}

function classificarUrgencia(tempoRestanteMs) {
  if (!Number.isFinite(tempoRestanteMs)) return URGENCIA_MANIFESTACAO.INDETERMINADO;
  if (tempoRestanteMs <= 0) return URGENCIA_MANIFESTACAO.EXPIRADO;
  if (tempoRestanteMs <= LIMITE_URGENTE_MS) return URGENCIA_MANIFESTACAO.URGENTE;
  if (tempoRestanteMs <= LIMITE_ATENCAO_MS) return URGENCIA_MANIFESTACAO.ATENCAO;
  return URGENCIA_MANIFESTACAO.NORMAL;
}

function instante(agora) {
  if (agora instanceof Date) return agora.getTime();
  const ms = agora == null ? Date.now() : new Date(agora).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * @param {Object} documento  registro da Central (camelCase ou snake_case; xml opcional)
 * @param {Date|string|number} [agora]
 * @returns {Readonly<{
 *   valido: boolean, motivo: string|null, fonte: string|null, dhEmi: string|null,
 *   emissaoEm: string|null, prazoFinal: string|null, tempoRestanteMs: number|null,
 *   diasRestantes: number|null, dentroDaJanela: boolean, expirado: boolean, urgencia: string
 * }>}
 */
function calcularPrazoManifestacao(documento = {}, agora = new Date()) {
  const origem = resolverDhEmi(documento || {});
  if (!origem.fonte) {
    return Object.freeze({
      valido: false,
      motivo: origem.motivo,
      fonte: null,
      dhEmi: null,
      emissaoEm: null,
      prazoFinal: null,
      tempoRestanteMs: null,
      diasRestantes: null,
      dentroDaJanela: false,
      expirado: false,
      urgencia: URGENCIA_MANIFESTACAO.INDETERMINADO
    });
  }
  const prazoMs = origem.ms + PRAZO_CIENCIA_MS;
  const tempoRestanteMs = prazoMs - instante(agora);
  // No instante exato do prazo a janela já é considerada encerrada.
  const expirado = tempoRestanteMs <= 0;
  return Object.freeze({
    valido: true,
    motivo: null,
    fonte: origem.fonte,
    dhEmi: origem.dhEmi,
    emissaoEm: new Date(origem.ms).toISOString(),
    prazoFinal: new Date(prazoMs).toISOString(),
    tempoRestanteMs,
    diasRestantes: Math.floor(tempoRestanteMs / DIA_MS),
    dentroDaJanela: !expirado,
    expirado,
    urgencia: classificarUrgencia(tempoRestanteMs)
  });
}

function formatarDataHoraBrasil(iso) {
  const data = iso ? new Date(iso) : null;
  if (!data || Number.isNaN(data.getTime())) return '—';
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_EXIBICAO,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(data).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

/** "17h32" (horas totais) ou "expirado". */
function formatarTempoRestante(tempoRestanteMs) {
  if (!Number.isFinite(tempoRestanteMs)) return '—';
  if (tempoRestanteMs <= 0) return 'expirado';
  const totalMin = Math.floor(tempoRestanteMs / 60000);
  const horas = Math.floor(totalMin / 60);
  const minutos = totalMin % 60;
  return `${horas}h${String(minutos).padStart(2, '0')}`;
}

function montarMensagemAlertaPrazo({ numero, chave, prazoFinal, tempoRestanteMs, urgencia }) {
  const nota = numero ? `NF-e ${numero}` : `NF-e ${String(chave || '').slice(-9) || '—'}`;
  return `${nota} · Prazo para Ciência: ${formatarDataHoraBrasil(prazoFinal)}`
    + ` · Tempo restante: ${formatarTempoRestante(tempoRestanteMs)} · Status: ${urgencia}`;
}

module.exports = {
  PRAZO_CIENCIA_DIAS,
  PRAZO_CIENCIA_MS,
  LIMITE_ATENCAO_MS,
  LIMITE_URGENTE_MS,
  URGENCIA_MANIFESTACAO,
  ORDEM_URGENCIA,
  MOTIVOS_PRAZO_INVALIDO,
  calcularPrazoManifestacao,
  classificarUrgencia,
  resolverDhEmi,
  extrairDhEmiXml,
  formatarDataHoraBrasil,
  formatarTempoRestante,
  montarMensagemAlertaPrazo
};
