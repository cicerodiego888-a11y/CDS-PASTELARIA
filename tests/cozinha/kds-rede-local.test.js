'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const path = require('path');
const {
  criarServidorKds, interfacesIpv4, clientePermitido, rotaPermitida, validarNomeDnsLocal
} = require('../../backend/cozinha-rede-local');

test('restringe cliente à mesma sub-rede privada, sem confiar em endereços públicos', () => {
  const redes = [{ endereco: '10.22.4.10', mascara: '255.255.255.0' }];
  assert.equal(clientePermitido('10.22.4.20', '10.22.4.10', redes), true);
  assert.equal(clientePermitido('10.22.5.20', '10.22.4.10', redes), false);
  assert.equal(clientePermitido('8.8.8.8', '10.22.4.10', redes), false);
  assert.equal(clientePermitido('127.0.0.1', '127.0.0.1', redes), true);
  assert.equal(clientePermitido('10.22.4.20', '203.0.113.1', redes), false);
});

test('nome DNS configurado é aceito sem liberar outros hosts ou origens', async (t) => {
  assert.equal(validarNomeDnsLocal('CDS-LOJA.home.arpa'), 'cds-loja.home.arpa');
  for (const invalido of ['192.168.1.1', '*.home.arpa', 'loja:3002', 'loja..local', ' ']) {
    assert.throws(() => validarNomeDnsLocal(invalido), /inválido/);
  }
  const servidor = criarServidorKds((_req, res) => res.end('ok'), interfacesIpv4, 'cds-loja.home.arpa');
  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => servidor.close(resolve)));
  const porta = servidor.address().port;
  const requisitar = (host, origin) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: porta, path: '/cozinha',
      headers: { Host: host, Origin: origin }
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await requisitar(`cds-loja.home.arpa:${porta}`, `http://cds-loja.home.arpa:${porta}`), 200);
  assert.equal(await requisitar(`outra.home.arpa:${porta}`, `http://outra.home.arpa:${porta}`), 403);
  assert.equal(await requisitar(`cds-loja.home.arpa:${porta}`, 'http://site-estranho'), 403);
});

test('gateway aceita somente o nome mDNS ativo, mantendo restrições de rota e origem', async (t) => {
  let nome = 'cds-servidor.local';
  const servidor = criarServidorKds((_req, res) => res.end('ok'), interfacesIpv4, null, () => nome);
  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => servidor.close(resolve)));
  const porta = servidor.address().port;
  const requisitar = (host, rota = '/cozinha', origin = `http://${host}`) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, headers: { Host: host, Origin: origin } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await requisitar(`cds-servidor.local:${porta}`), 200);
  assert.equal(await requisitar(`outro.local:${porta}`), 403);
  assert.equal(await requisitar(`cds-servidor.local:${porta}`, '/api/backup'), 404);
  assert.equal(await requisitar(`cds-servidor.local:${porta}`, '/cozinha', 'http://outro.local'), 403);
  nome = null;
  assert.equal(await requisitar(`cds-servidor.local:${porta}`), 403);
});

test('porta KDS serve somente recursos e métodos permitidos e preserva autenticação', async (t) => {
  const frontend = path.join(__dirname, '../../frontend');
  const app = express();
  app.use(express.static(frontend));
  app.get(['/cozinha', '/cozinha/'], (_req, res) => res.sendFile(path.join(frontend, 'cozinha-tv/index.html')));
  app.use('/api', (req, res) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Sessão obrigatória' });
    return res.json({ url: req.url });
  });
  const servidor = criarServidorKds(app);
  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(0, '0.0.0.0', resolve);
  });
  t.after(() => new Promise((resolve) => servidor.close(resolve)));
  const porta = servidor.address().port;
  for (const endereco of ['127.0.0.1', ...interfacesIpv4().map((rede) => rede.endereco)]) {
    const base = `http://${endereco}:${porta}`;
    const pagina = await fetch(`${base}/cozinha`);
    assert.equal(pagina.status, 200);
    const html = await pagina.text();
    assert.match(html, /Acesso à cozinha/);
    assert.match(html, /\/erp\/js\/cozinha-kds\.js/);
    assert.doesNotMatch(html, /id="sidebar"|data-page="vendas"/);
    assert.equal((await fetch(`${base}/api/cozinha/preparacao/painel`)).status, 401);
    assert.equal((await fetch(`${base}/api/empresas/contexto/disponiveis`)).status, 401);
    assert.equal((await fetch(`${base}/api/cozinha/preparacao/painel`, {
      headers: { Authorization: 'Bearer teste' }
    })).status, 200);
    for (const bloqueada of ['/erp', '/mobile', '/storage/teste', '/api/backup', '/api/cozinha/unidades', '/cozinha-tv/index.html']) {
      assert.equal((await fetch(base + bloqueada)).status, 404, bloqueada);
    }
    assert.equal((await fetch(`${base}/api/cozinha/preparacao/painel`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/cozinha`, { headers: { Origin: 'http://site-estranho' } })).status, 403);
  }
  const requisitarBruto = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await requisitarBruto('/cozinha', { Host: 'site-estranho' }), 403);
  assert.equal(await requisitarBruto('/api/cozinha/%70reparacao/painel'), 404);
  assert.equal(await requisitarBruto('/cozinha/../api/cozinha/preparacao/painel'), 404);
  assert.equal(await requisitarBruto('//cozinha'), 404);
  assert.equal(rotaPermitida('POST', '/api/cozinha/itens/4/pronto'), true);
  assert.equal(rotaPermitida('POST', '/api/cozinha/itens/4/bebida/entregar'), false);
  assert.equal(rotaPermitida('GET', '/api/cozinha/%70reparacao/painel'), false);
});
