/**
 * Datas de calendário do MIS (ISO YYYY-MM-DD). Sem regra de venda.
 * @module services/mis/misPeriodo
 */
'use strict';

function addDaysIso(iso, delta) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(delta));
  return dt.toISOString().slice(0, 10);
}

function diasInclusivos(inicio, fim) {
  const a = Date.parse(String(inicio) + 'T00:00:00Z');
  const b = Date.parse(String(fim) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000) + 1;
}

function listarDiasIso(inicio, fim) {
  const out = [];
  let cur = String(inicio);
  const last = String(fim);
  while (cur <= last) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

/** Mesma duração, imediatamente anterior ao início do período atual. */
function calcularPeriodoAnterior(inicio, fim) {
  const n = diasInclusivos(inicio, fim);
  const anteriorFim = addDaysIso(inicio, -1);
  const anteriorInicio = addDaysIso(anteriorFim, -(n - 1));
  return { inicio: anteriorInicio, fim: anteriorFim };
}

/**
 * ((atual - anterior) / anterior) * 100
 * anterior=0 e atual=0 → sem_variacao
 * anterior=0 e atual≠0 → sem_base (sem NaN/Infinity)
 */
function calcularVariacaoPercentual(atual, anterior) {
  const a = Number(atual);
  const b = Number(anterior);
  const atualN = Number.isFinite(a) ? a : 0;
  const anteriorN = Number.isFinite(b) ? b : 0;
  if (anteriorN === 0 && atualN === 0) {
    return { percentual: null, estado: 'sem_variacao' };
  }
  if (anteriorN === 0) {
    return { percentual: null, estado: 'sem_base' };
  }
  const percentual = Math.round(((atualN - anteriorN) / anteriorN) * 10000) / 100;
  return { percentual, estado: 'ok' };
}

module.exports = {
  addDaysIso,
  diasInclusivos,
  listarDiasIso,
  calcularPeriodoAnterior,
  calcularVariacaoPercentual
};
