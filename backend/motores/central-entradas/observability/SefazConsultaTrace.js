/**
 * Rastreio de consultas DistDFe da Central — memória do processo.
 *
 * Distingue solicitação, bloqueio (Gate/cooldown/mutex) e envio efetivo.
 * Não grava certificado, senha, PFX, XML completo nem outros segredos.
 * Não substitui `dfe_auditoria`; convive com ela.
 *
 * @module motores/central-entradas/observability/SefazConsultaTrace
 */

'use strict';

const EVENTOS_CONSULTA_SEFAZ = Object.freeze({
  CONSULTA_SOLICITADA: 'CONSULTA_SOLICITADA',
  BLOQUEADA_GATE: 'BLOQUEADA_GATE',
  BLOQUEADA_COOLDOWN: 'BLOQUEADA_COOLDOWN',
  ENFILEIRADA: 'ENFILEIRADA',
  CONSULTA_EXECUTADA: 'CONSULTA_EXECUTADA',
  RESPOSTA_RECEBIDA: 'RESPOSTA_RECEBIDA',
  PERSISTENCIA_CONCLUIDA: 'PERSISTENCIA_CONCLUIDA',
  PERSISTENCIA_FALHOU: 'PERSISTENCIA_FALHOU'
});

const CHAVES_SECRETAS = /senha|password|pfx|certificado|private.?key|secret|token|authorization/i;
const MAX_EVENTOS = 800;

function textoCurto(valor, max = 240) {
  if (valor == null) return null;
  const s = String(valor);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function sanitizar(valor, profundidade = 0) {
  if (valor == null) return valor;
  if (typeof valor !== 'object') return valor;
  if (profundidade > 4) return '[truncado]';
  if (Array.isArray(valor)) {
    return valor.slice(0, 20).map((item) => sanitizar(item, profundidade + 1));
  }
  const out = {};
  for (const [chave, item] of Object.entries(valor)) {
    if (CHAVES_SECRETAS.test(chave)) continue;
    if (chave === 'xml' || chave === 'xmlConsulta' || chave === 'body') continue;
    out[chave] = sanitizar(item, profundidade + 1);
  }
  return out;
}

class SefazConsultaTrace {
  constructor() {
    /** @type {Object[]} */
    this._eventos = [];
  }

  /**
   * @param {string} tipo
   * @param {Object} [payload]
   * @returns {Object|null}
   */
  emitir(tipo, payload = {}) {
    const tipoOk = EVENTOS_CONSULTA_SEFAZ[tipo] || tipo;
    const agora = new Date().toISOString();
    const limpo = sanitizar(payload) || {};
    const evento = {
      tipo: tipoOk,
      em: agora,
      empresaId: limpo.empresaId != null ? Number(limpo.empresaId) : null,
      cnpj: limpo.cnpj ? String(limpo.cnpj).replace(/\D/g, '') : null,
      origem: limpo.origem || null,
      correlationId: limpo.correlationId || null,
      tipoConsulta: limpo.tipoConsulta || null,
      estadoGate: limpo.estadoGate || null,
      nsuAnterior: limpo.nsuAnterior != null ? String(limpo.nsuAnterior) : null,
      nsuRetornado: limpo.nsuRetornado != null ? String(limpo.nsuRetornado) : null,
      maxNsu: limpo.maxNsu != null ? String(limpo.maxNsu) : null,
      resultado: limpo.resultado != null ? limpo.resultado : null,
      motivo: textoCurto(limpo.motivo || limpo.mensagem || null),
      codigo: limpo.codigo || null,
      cStat: limpo.cStat != null ? String(limpo.cStat) : null,
      detalhe: limpo.detalhe && typeof limpo.detalhe === 'object' ? sanitizar(limpo.detalhe) : null
    };

    this._eventos.push(evento);
    if (this._eventos.length > MAX_EVENTOS) {
      this._eventos.splice(0, this._eventos.length - MAX_EVENTOS);
    }
    return evento;
  }

  /**
   * @param {Object} [filtro]
   * @returns {Object[]}
   */
  listar(filtro = {}) {
    return this._eventos.filter((ev) => {
      if (filtro.tipo && ev.tipo !== filtro.tipo) return false;
      if (filtro.origem && ev.origem !== filtro.origem) return false;
      if (filtro.correlationId && ev.correlationId !== filtro.correlationId) return false;
      if (filtro.empresaId != null && Number(ev.empresaId) !== Number(filtro.empresaId)) return false;
      if (filtro.cnpj && ev.cnpj !== String(filtro.cnpj).replace(/\D/g, '')) return false;
      return true;
    });
  }

  /**
   * @returns {{ total: number, porTipo: Object<string, number>, porOrigem: Object<string, number> }}
   */
  resumo() {
    const porTipo = {};
    const porOrigem = {};
    for (const ev of this._eventos) {
      porTipo[ev.tipo] = (porTipo[ev.tipo] || 0) + 1;
      const origem = ev.origem || '(sem-origem)';
      porOrigem[origem] = (porOrigem[origem] || 0) + 1;
    }
    return {
      total: this._eventos.length,
      porTipo,
      porOrigem,
      enviadas: porTipo[EVENTOS_CONSULTA_SEFAZ.CONSULTA_EXECUTADA] || 0,
      solicitadas: porTipo[EVENTOS_CONSULTA_SEFAZ.CONSULTA_SOLICITADA] || 0,
      bloqueadasGate: porTipo[EVENTOS_CONSULTA_SEFAZ.BLOQUEADA_GATE] || 0,
      bloqueadasCooldown: porTipo[EVENTOS_CONSULTA_SEFAZ.BLOQUEADA_COOLDOWN] || 0,
      enfileiradas: porTipo[EVENTOS_CONSULTA_SEFAZ.ENFILEIRADA] || 0
    };
  }

  reset() {
    this._eventos = [];
  }
}

const instance = new SefazConsultaTrace();

function emitirSefazConsulta(tipo, payload) {
  try {
    return instance.emitir(tipo, payload);
  } catch {
    return null;
  }
}

module.exports = instance;
module.exports.SefazConsultaTrace = SefazConsultaTrace;
module.exports.EVENTOS_CONSULTA_SEFAZ = EVENTOS_CONSULTA_SEFAZ;
module.exports.emitirSefazConsulta = emitirSefazConsulta;
