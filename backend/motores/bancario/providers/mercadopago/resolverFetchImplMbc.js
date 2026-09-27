/**
 * Resolve implementação de fetch para o MBC (ERP Electron Node 16 sem fetch global).
 * Ordem: preferido → global fetch → electron.net.fetch → HTTPS nativo.
 * @module motores/bancario/providers/mercadopago/resolverFetchImplMbc
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function headersGet(headers, name) {
  if (!headers || !name) return null;
  const alvo = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === alvo) {
      const v = headers[key];
      return Array.isArray(v) ? (v[0] != null ? String(v[0]) : null) : (v != null ? String(v) : null);
    }
  }
  return null;
}

function criarResposta(statusCode, headers, bodyBuf) {
  const body = bodyBuf && bodyBuf.length ? bodyBuf.toString('utf8') : '';
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    headers: {
      get(name) {
        return headersGet(headers, name);
      }
    },
    async text() {
      return body;
    },
    async json() {
      if (!body) return null;
      return JSON.parse(body);
    }
  };
}

/**
 * Fetch mínimo via http/https (Node 16 / Electron sem undici).
 * Suporta method, headers, body string e AbortSignal.
 */
function criarFetchHttps() {
  return function fetchHttps(url, init = {}) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(String(url));
      } catch (err) {
        reject(err);
        return;
      }
      const lib = parsed.protocol === 'http:' ? http : https;
      const method = String(init.method || 'GET').toUpperCase();
      const headers = Object.assign({}, init.headers || {});
      const body = init.body == null ? null : String(init.body);
      if (body != null && !headers['Content-Length'] && !headers['content-length']) {
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
          path: parsed.pathname + parsed.search,
          method,
          headers
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve(criarResposta(res.statusCode || 0, res.headers || {}, Buffer.concat(chunks)));
          });
        }
      );

      const onAbort = () => {
        req.destroy();
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (init.signal) {
        if (init.signal.aborted) {
          onAbort();
          return;
        }
        init.signal.addEventListener('abort', onAbort, { once: true });
      }
      req.on('error', reject);
      if (body != null) req.write(body);
      req.end();
    });
  };
}

function tentarElectronNetFetch() {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      return electron.net.fetch.bind(electron.net);
    }
  } catch (_) {
    /* processo sem electron (Gateway Node, testes) */
  }
  return null;
}

/**
 * @param {Function|null|undefined} preferido
 * @returns {Function|null}
 */
function resolverFetchImplMbc(preferido) {
  if (typeof preferido === 'function') return preferido;
  if (typeof fetch === 'function') return fetch.bind(globalThis);
  const netFetch = tentarElectronNetFetch();
  if (typeof netFetch === 'function') return netFetch;
  return criarFetchHttps();
}

module.exports = {
  resolverFetchImplMbc,
  criarFetchHttps
};
