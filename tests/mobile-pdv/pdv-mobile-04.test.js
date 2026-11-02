/**
 * PDV-MOBILE-04 — autorização da leitura TEF.
 * Banco temporário. Sem adaptador, cobrança real ou SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-04.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mobpdv04-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const db = require('../../backend/database');
const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const tefManager = require('../../backend/services/tef/TefManager');
const tefRouter = require('../../backend/rotas/tef');

const efeitosAdaptador = [];
['autorizar', 'consultar', 'cancelar', 'reimprimir', 'status'].forEach((nome) => {
  tefManager[nome] = async () => {
    efeitosAdaptador.push(nome);
    throw new Error('adaptador não pode ser chamado na leitura');
  };
});

let server;
let porta;
let empresaA;
let empresaB;
let tokenA;
let tokenB;
let tokenSemVinculo;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function pedir(caminho, token, empresaId) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (empresaId) headers['X-Empresa-Id'] = String(empresaId);
    const req = http.request({
      hostname: '127.0.0.1',
      port: porta,
      path: caminho,
      method: 'GET',
      headers
    }, (res) => {
      let body = '';
      res.on('data', (parte) => { body += parte; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { json = null; }
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function esperarTabela(nome) {
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    const row = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [nome]);
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('tabela ausente: ' + nome);
}

describe('acompanhamento TEF', () => {
  before(async () => {
    await db.whenReady;
    await esperarTabela('tef_transacoes');
    await esperarTabela('empresas');
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'Empresa A' }, { db });
    empresaB = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'Empresa B' }, { db });
    const usuarioA = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-a', 'x', 'operador', 'Operador A', 'CAIXA', 1)`
    );
    const usuarioB = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-b', 'x', 'operador', 'Operador B', 'CAIXA', 1)`
    );
    const usuarioC = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-c', 'x', 'operador', 'Sem empresa', 'CAIXA', 1)`
    );
    await run(`INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [usuarioA.lastID, empresaA.id]);
    await run(`INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [usuarioB.lastID, empresaB.id]);
    const segredo = getJwtSecret();
    tokenA = jwt.sign({ id: usuarioA.lastID, username: 'op-a', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });
    tokenB = jwt.sign({ id: usuarioB.lastID, username: 'op-b', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });
    tokenSemVinculo = jwt.sign({ id: usuarioC.lastID, username: 'op-c', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });
    const agora = '2026-11-01 21:00:00';
    const linhas = [
      ['corr-aprovada', empresaA.id, usuarioA.lastID, 'aprovado', 'pix', 12.5],
      ['corr-pendente', empresaA.id, usuarioA.lastID, 'pendente', 'debito', 8],
      ['corr-recusada', empresaA.id, usuarioA.lastID, 'negado', 'credito', 9],
      ['corr-timeout', empresaA.id, usuarioA.lastID, 'timeout', 'pix', 4],
      ['corr-falha', empresaA.id, usuarioA.lastID, 'falha_comunicacao', 'pix', 4],
      ['corr-cancelada', empresaA.id, usuarioA.lastID, 'cancelado', 'pix', 4],
      ['corr-outra-empresa', empresaB.id, usuarioB.lastID, 'aprovado', 'pix', 30]
    ];
    for (const [chave, empresa, operador, status, tipo, valor] of linhas) {
      await run(
        `INSERT INTO tef_transacoes (
           empresa_id, operador_id, tipo, valor, status, nsu, autorizacao, idempotency_key, atualizado_em
         ) VALUES (?, ?, ?, ?, ?, 'NSU-SECRETO', 'AUT-SECRETA', ?, ?)`,
        [empresa, operador, tipo, valor, status, chave, agora]
      );
    }
    const app = express();
    app.use('/api/tef', tefRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    porta = server.address().port;
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('recusa consulta sem sessão', async () => {
    const resposta = await pedir('/api/tef/acompanhamento?idempotency_key=corr-aprovada');
    assert.equal(resposta.status, 401);
    assert.equal(resposta.json.code, 'SESSAO_INVALIDA');
  });

  it('recusa operador autenticado sem vínculo com a empresa', async () => {
    const resposta = await pedir('/api/tef/acompanhamento?idempotency_key=corr-aprovada', tokenSemVinculo, empresaA.id);
    assert.equal(resposta.status, 403);
    assert.equal(resposta.json.code, 'EMPRESA_NAO_AUTORIZADA');
  });

  it('não abre transação de outra empresa pelo cabeçalho nem pela chave', async () => {
    const cabecalhoTrocado = await pedir('/api/tef/acompanhamento?idempotency_key=corr-outra-empresa', tokenA, empresaB.id);
    assert.equal(cabecalhoTrocado.status, 403);
    const chaveTrocada = await pedir(
      '/api/tef/acompanhamento?idempotency_key=corr-outra-empresa&empresa_id=' + empresaB.id,
      tokenA,
      empresaA.id
    );
    assert.equal(chaveTrocada.status, 200);
    assert.equal(chaveTrocada.json.encontrado, false);
    assert.equal(chaveTrocada.json.aprovado, false);
    assert.equal(chaveTrocada.json.transacao_id, undefined);
    assert.equal(JSON.stringify(chaveTrocada.json).includes('NSU-SECRETO'), false);
  });

  it('devolve a cobrança aprovada da própria empresa sem segredo de adquirente', async () => {
    const antes = await get(`SELECT status, atualizado_em FROM tef_transacoes WHERE idempotency_key = 'corr-aprovada'`);
    const resposta = await pedir('/api/tef/acompanhamento?idempotency_key=corr-aprovada', tokenA, empresaA.id);
    const depois = await get(`SELECT status, atualizado_em, venda_id FROM tef_transacoes WHERE idempotency_key = 'corr-aprovada'`);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.json.aprovado, true);
    assert.equal(resposta.json.valor, 12.5);
    assert.equal(resposta.json.tipo, 'pix');
    assert.equal(resposta.json.executou_cobranca, false);
    assert.equal(Object.hasOwn(resposta.json, 'nsu'), false);
    assert.equal(Object.hasOwn(resposta.json, 'autorizacao'), false);
    assert.equal(depois.status, antes.status);
    assert.equal(depois.atualizado_em, antes.atualizado_em);
    assert.equal(depois.venda_id, null);
  });

  it('não trata pendente, recusa, timeout, falha ou cancelamento como recebidos', async () => {
    for (const chave of ['corr-pendente', 'corr-recusada', 'corr-timeout', 'corr-falha', 'corr-cancelada']) {
      const resposta = await pedir('/api/tef/acompanhamento?idempotency_key=' + chave, tokenA, empresaA.id);
      assert.equal(resposta.json.aprovado, false, chave);
      assert.equal(resposta.json.transacao_id, undefined, chave);
      assert.equal(Object.hasOwn(resposta.json, 'nsu'), false);
    }
  });

  it('repete a leitura e recusa a cobrança depois que ela já foi vinculada', async () => {
    const primeira = await pedir('/api/tef/acompanhamento?idempotency_key=corr-aprovada', tokenA, empresaA.id);
    const segunda = await pedir('/api/tef/acompanhamento?idempotency_key=corr-aprovada', tokenA, empresaA.id);
    assert.equal(segunda.json.transacao_id, primeira.json.transacao_id);
    const total = await get(`SELECT COUNT(*) AS total FROM tef_transacoes WHERE idempotency_key = 'corr-aprovada'`);
    assert.equal(total.total, 1);
    const vinculo = await run(
      `UPDATE tef_transacoes SET venda_id = 80 WHERE idempotency_key = 'corr-aprovada' AND venda_id IS NULL AND empresa_id = ?`,
      [empresaA.id]
    );
    assert.equal(vinculo.changes, 1);
    const repetida = await run(
      `UPDATE tef_transacoes SET venda_id = 81 WHERE idempotency_key = 'corr-aprovada' AND venda_id IS NULL AND empresa_id = ?`,
      [empresaA.id]
    );
    assert.equal(repetida.changes, 0);
    const outraEmpresa = await run(
      `UPDATE tef_transacoes SET venda_id = 82 WHERE idempotency_key = 'corr-aprovada' AND empresa_id = ?`,
      [empresaB.id]
    );
    assert.equal(outraEmpresa.changes, 0);
    const leitura = await pedir('/api/tef/acompanhamento?idempotency_key=corr-aprovada', tokenA, empresaA.id);
    assert.equal(leitura.json.aprovado, false);
    assert.equal(leitura.json.code, 'TRANSACAO_JA_VINCULADA');
    assert.equal(leitura.json.transacao_id, undefined);
    const operadorB = await pedir('/api/tef/acompanhamento?idempotency_key=corr-aprovada', tokenB, empresaB.id);
    assert.equal(operadorB.json.encontrado, false);
    assert.equal(efeitosAdaptador.length, 0);
  });

  it('responde chave inexistente sem detalhe interno', async () => {
    const resposta = await pedir('/api/tef/acompanhamento?idempotency_key=nao-existe', tokenA, empresaA.id);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.json.encontrado, false);
    assert.equal(resposta.json.aprovado, false);
    assert.equal(/sqlite|select |programdata|stack/i.test(resposta.body), false);
  });
});
