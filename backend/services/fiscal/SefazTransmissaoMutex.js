/**
 * Mutex de transmissão SEFAZ — in-process + coordenação interprocesso por arquivo.
 *
 * Escopo: CNPJ + ambiente (quando informado); senão chave global.
 * Reentrante no mesmo contexto assíncrono (ALS).
 *
 * Lock file usa open exclusivo (wx) — sem banco oficial, sem segunda fonte de verdade.
 *
 * @module services/fiscal/SefazTransmissaoMutex
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const CODIGO_OCUPADO = 'TRANSMISSAO_SEFAZ_EM_ANDAMENTO';

function normalizarCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

function chaveEscopo({ cnpj, ambiente, tipo } = {}) {
  const c = normalizarCnpj(cnpj);
  const amb = ambiente == null || ambiente === '' ? null : (Number(ambiente) === 1 ? 1 : 2);
  const t = String(tipo || 'distNSU').replace(/[^\w.-]/g, '_');
  if (c.length === 14 && amb != null) return `${t}__${c}__${amb}`;
  return `${t}__global`;
}

function resolverLockDir(override) {
  if (override) return override;
  if (process.env.CDS_SEFAZ_LOCK_DIR) return process.env.CDS_SEFAZ_LOCK_DIR;
  if (process.env.FISCAL_DIR) return path.join(process.env.FISCAL_DIR, 'sefaz-locks');
  if (process.env.DB_DIR && !/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(process.env.DB_DIR)) {
    return path.join(process.env.DB_DIR, 'sefaz-locks');
  }
  return path.join(os.tmpdir(), 'cds-sefaz-locks');
}

class SefazTransmissaoMutex {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.lockDir]
   * @param {boolean} [opts.interprocesso=true]
   */
  constructor(opts = {}) {
    /** @private Map<string, { dono: string }> */
    this._ocupados = new Map();
    this._dono = null;
    this._lockDir = opts.lockDir || null;
    this._interprocesso = opts.interprocesso !== false;
    this._fds = new Map();
  }

  estaOcupado(escopo = {}) {
    const chave = chaveEscopo(escopo);
    if (this._ocupados.has(chave) || this._ocupados.has('distNSU__global')) return true;
    return this._ocupados.size > 0 && !escopo.cnpj;
  }

  dono() {
    return this._dono;
  }

  estaNoContexto() {
    return Boolean(als.getStore());
  }

  /**
   * @param {string} dono
   * @param {Function} fn
   * @param {Object} [escopo] { cnpj, ambiente, tipo }
   */
  async comLock(dono, fn, escopo = {}) {
    if (als.getStore()) {
      return { ok: true, aninhado: true, valor: await fn() };
    }

    const chave = chaveEscopo(escopo);
    if (this._ocupados.has(chave)) {
      const atual = this._ocupados.get(chave);
      return {
        ok: false,
        codigo: CODIGO_OCUPADO,
        consultaExecutada: false,
        lockDono: atual?.dono || this._dono,
        mensagem: `Transmissão SEFAZ já em andamento (${atual?.dono || this._dono || 'desconhecido'})`
      };
    }

    let fd = null;
    let lockPath = null;
    if (this._interprocesso) {
      try {
        const dir = resolverLockDir(this._lockDir);
        fs.mkdirSync(dir, { recursive: true });
        lockPath = path.join(dir, `${chave}.lock`);
        fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, `${process.pid}|${dono || 'sefaz'}|${new Date().toISOString()}`);
        this._fds.set(chave, { fd, lockPath });
      } catch (err) {
        if (err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES')) {
          return {
            ok: false,
            codigo: CODIGO_OCUPADO,
            consultaExecutada: false,
            lockDono: 'interprocesso',
            mensagem: `Transmissão SEFAZ já em andamento em outro processo (${chave}).`
          };
        }
        // Falha inesperada no filesystem → fail-closed (não transmitir sem exclusão).
        return {
          ok: false,
          codigo: 'MUTEX_INTERPROCESSO_INDISPONIVEL',
          consultaExecutada: false,
          mensagem: `Coordenação interprocesso indisponível — transmissão bloqueada (fail-closed): ${
            err && err.message ? err.message : 'erro'
          }`
        };
      }
    }

    this._ocupados.set(chave, { dono: dono || 'sefaz' });
    this._dono = dono || 'sefaz';
    try {
      const valor = await als.run({ dono: this._dono, chave }, fn);
      return { ok: true, aninhado: false, valor, chave };
    } finally {
      this._ocupados.delete(chave);
      if (this._dono && !this._ocupados.size) this._dono = null;
      const held = this._fds.get(chave);
      if (held) {
        try { fs.closeSync(held.fd); } catch { /* ignore */ }
        try { fs.unlinkSync(held.lockPath); } catch { /* ignore */ }
        this._fds.delete(chave);
      }
    }
  }

  resetParaTeste() {
    for (const held of this._fds.values()) {
      try { fs.closeSync(held.fd); } catch { /* ignore */ }
      try { fs.unlinkSync(held.lockPath); } catch { /* ignore */ }
    }
    this._fds.clear();
    this._ocupados.clear();
    this._dono = null;
  }
}

const singleton = new SefazTransmissaoMutex();

function obterMutexTransmissaoSefaz() {
  return singleton;
}

module.exports = {
  SefazTransmissaoMutex,
  obterMutexTransmissaoSefaz,
  CODIGO_OCUPADO,
  chaveEscopo,
  resolverLockDir
};
