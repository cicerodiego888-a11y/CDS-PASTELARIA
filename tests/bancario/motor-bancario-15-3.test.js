/**
 * MBC-15.3 — fetch no ERP Electron (sem global fetch).
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  resolverFetchImplMbc,
  criarFetchHttps
} = require('../../backend/motores/bancario/providers/mercadopago/resolverFetchImplMbc');
const { MercadoPagoApiClient } = require('../../backend/motores/bancario/providers/mercadopago/MercadoPagoApiClient');

describe('MBC-15.3 fetchImpl Electron', () => {
  it('T01 — preferido vence global', () => {
    const preferido = async () => ({ ok: true, status: 200 });
    assert.equal(resolverFetchImplMbc(preferido), preferido);
  });

  it('T02 — sem preferido ainda resolve função (global ou HTTPS)', () => {
    const fn = resolverFetchImplMbc(null);
    assert.equal(typeof fn, 'function');
  });

  it('T03 — criarFetchHttps GET funcional', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Retry-After': '3' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const fetchHttps = criarFetchHttps();
      const res = await fetchHttps('http://127.0.0.1:' + port + '/x', { method: 'GET' });
      assert.equal(res.status, 200);
      assert.equal(res.ok, true);
      assert.equal(res.headers.get('retry-after'), '3');
      const body = await res.json();
      assert.equal(body.ok, true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('T04 — ApiClient sem global fetch não lança "não configurado"', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const fetchHttps = criarFetchHttps();
    const client = new MercadoPagoApiClient({
      fetchImpl: fetchHttps,
      apiBase: 'http://127.0.0.1:' + port
    });
    try {
      const out = await client.request({
        path: '/v1/users/me',
        accessToken: 'tok',
        method: 'GET'
      });
      assert.equal(out.status, 200);
      assert.equal(out.body.id, 1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('T05 — ApiClient com fetchImpl forçado inválido ainda falha fechado', async () => {
    const client = new MercadoPagoApiClient({ fetchImpl: async () => null });
    client.fetchImpl = undefined;
    await assert.rejects(
      () => client.request({ path: '/x', accessToken: 't' }),
      (err) => {
        assert.match(String(err.message), /Cliente HTTP Mercado Pago não configurado/);
        return true;
      }
    );
  });
});
