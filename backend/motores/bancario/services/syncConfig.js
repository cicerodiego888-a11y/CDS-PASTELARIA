/**
 * Configuração centralizada de sincronização MBC (MBC-04).
 * TTL do soft-lock e limite de páginas — sem hardcode espalhado.
 * @module motores/bancario/services/syncConfig
 */
'use strict';

/** Default: 15 minutos — compatível com syncs reais, evita reclaim precoce. */
const SYNC_LOCK_TTL_MS_PADRAO = 15 * 60 * 1000;
const SYNC_MAX_PAGINAS_PADRAO = 50;

function resolverSyncLockTtlMs(env = process.env, overrideMs) {
  if (overrideMs != null) {
    const o = Number(overrideMs);
    if (Number.isFinite(o) && o > 0) return Math.floor(o);
  }
  const n = Number(env && env.SYNC_LOCK_TTL_MS);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return SYNC_LOCK_TTL_MS_PADRAO;
}

function resolverSyncMaxPaginas(env = process.env, override) {
  if (override != null) {
    const o = Number(override);
    if (Number.isFinite(o) && o > 0) return Math.floor(o);
  }
  const n = Number(env && env.SYNC_MAX_PAGINAS);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return SYNC_MAX_PAGINAS_PADRAO;
}

/**
 * @param {object} row linha sincronizacao_bancaria
 * @param {number} ttlMs
 * @param {number} [agoraMs]
 */
function lockExpirado(row, ttlMs, agoraMs = Date.now()) {
  if (!row || String(row.status || '') !== 'SINCRONIZANDO') return false;
  const raw = row.lock_iniciado_em || row.updated_at || null;
  if (!raw) return true; // legado sem timestamp: reclaim seguro
  const t = Date.parse(String(raw).replace(' ', 'T'));
  if (!Number.isFinite(t)) return true;
  return (agoraMs - t) >= Number(ttlMs);
}

module.exports = {
  SYNC_LOCK_TTL_MS_PADRAO,
  SYNC_MAX_PAGINAS_PADRAO,
  resolverSyncLockTtlMs,
  resolverSyncMaxPaginas,
  lockExpirado
};
