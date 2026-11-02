/**
 * PDV-MOBILE-05 — vínculo da cobrança com o operador e navegação dos módulos.
 * Banco temporário. Sem adaptador, cobrança real ou SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-05.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mobpdv05-'));
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
const OrquestradorPagamento = require('../../backend/services/OrquestradorPagamento');

const efeitosAdaptador = [];
let capturaPagar = null;
['autorizar', 'consultar', 'cancelar', 'reimprimir', 'status'].forEach((nome) => {
  tefManager[nome] = async (dados) => {
    efeitosAdaptador.push(nome);
    if (nome === 'autorizar') capturaPagar = dados;
    return { sucesso: false, aprovado: false, status: 'pendente', codigo: 'SEM_COBRANCA' };
  };
});

let server;
let porta;
let empresaA;
let empresaB;
let usuarioA;
let usuarioA2;
let usuarioB;
let tokenA;
let tokenA2;
let tokenB;
let tokenSemVinculo;
let tokenExpirado;
const ids = {};

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

function pedir(caminho, token, empresaId, metodo, corpo) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const payload = corpo ? JSON.stringify(corpo) : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    if (empresaId) headers['X-Empresa-Id'] = String(empresaId);
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port: porta,
      path: caminho,
      method: metodo || 'GET',
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
    if (payload) req.write(payload);
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

describe('vínculo operador e cobrança', () => {
  before(async () => {
    await db.whenReady;
    await esperarTabela('tef_transacoes');
    await esperarTabela('empresas');
    const coluna = await get(`SELECT name FROM pragma_table_info('tef_transacoes') WHERE name = 'operador_id'`);
    assert.ok(coluna, 'tef_transacoes.operador_id');
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'Empresa A' }, { db });
    empresaB = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'Empresa B' }, { db });
    usuarioA = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-a', 'x', 'operador', 'Operador A', 'CAIXA', 1)`
    );
    usuarioA2 = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-a2', 'x', 'operador', 'Operador A2', 'CAIXA', 1)`
    );
    usuarioB = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-b', 'x', 'operador', 'Operador B', 'CAIXA', 1)`
    );
    const usuarioC = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-c', 'x', 'operador', 'Sem empresa', 'CAIXA', 1)`
    );
    await run(`INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [usuarioA.lastID, empresaA.id]);
    await run(`INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [usuarioA2.lastID, empresaA.id]);
    await run(`INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [usuarioB.lastID, empresaB.id]);
    const segredo = getJwtSecret();
    tokenA = jwt.sign({ id: usuarioA.lastID, username: 'op-a', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });
    tokenA2 = jwt.sign({ id: usuarioA2.lastID, username: 'op-a2', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });
    tokenB = jwt.sign({ id: usuarioB.lastID, username: 'op-b', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });
    tokenSemVinculo = jwt.sign({ id: usuarioC.lastID, username: 'op-c', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });
    tokenExpirado = jwt.sign({
      id: usuarioA.lastID,
      username: 'op-a',
      role: 'operador',
      perfil: 'CAIXA',
      exp: Math.floor(Date.now() / 1000) - 60
    }, segredo);
    const agora = '2026-11-01 21:40:00';
    const linhas = [
      ['corr-a', empresaA.id, usuarioA.lastID, 'aprovado', 'pix', 12.5],
      ['corr-outra', empresaA.id, usuarioA.lastID, 'aprovado', 'pix', 7],
      ['corr-reuso', empresaA.id, usuarioA.lastID, 'aprovado', 'cartao_debito', 9],
      ['corr-pendente', empresaA.id, usuarioA.lastID, 'pendente', 'pix', 4],
      ['corr-recusada', empresaA.id, usuarioA.lastID, 'negado', 'credito', 4],
      ['corr-timeout', empresaA.id, usuarioA.lastID, 'timeout', 'pix', 4],
      ['corr-falha', empresaA.id, usuarioA.lastID, 'falha_comunicacao', 'pix', 4],
      ['corr-cancelada', empresaA.id, usuarioA.lastID, 'cancelado', 'pix', 4],
      ['corr-b', empresaB.id, usuarioB.lastID, 'aprovado', 'pix', 30]
    ];
    for (const [chave, empresa, operador, status, tipo, valor] of linhas) {
      const gravado = await run(
        `INSERT INTO tef_transacoes (
           empresa_id, operador_id, tipo, valor, status, nsu, autorizacao, idempotency_key, atualizado_em
         ) VALUES (?, ?, ?, ?, ?, 'NSU-SECRETO', 'AUT-SECRETA', ?, ?)`,
        [empresa, operador, tipo, valor, status, chave, agora]
      );
      ids[chave] = gravado.lastID;
    }
    const app = express();
    app.use(express.json());
    app.use('/api/tef', tefRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    porta = server.address().port;
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('o operador que iniciou a cobrança acompanha na própria sessão', async () => {
    const antes = await get(`SELECT atualizado_em FROM tef_transacoes WHERE id = ?`, [ids['corr-a']]);
    const resposta = await pedir('/api/tef/acompanhamento?idempotency_key=corr-a&operador_id=' + usuarioA2.lastID, tokenA, empresaA.id);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.json.aprovado, true);
    assert.equal(resposta.json.transacao_id, ids['corr-a']);
    assert.equal(resposta.json.valor, 12.5);
    assert.equal(resposta.json.executou_cobranca, false);
    assert.equal(Object.prototype.hasOwnProperty.call(resposta.json, 'nsu'), false);
    const depois = await get(`SELECT atualizado_em, venda_id FROM tef_transacoes WHERE id = ?`, [ids['corr-a']]);
    assert.equal(depois.atualizado_em, antes.atualizado_em);
    assert.equal(depois.venda_id, null);
    assert.equal(efeitosAdaptador.length, 0);
  });

  it('outro operador da mesma empresa não acompanha a cobrança', async () => {
    const resposta = await pedir('/api/tef/acompanhamento?idempotency_key=corr-a', tokenA2, empresaA.id);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.json.encontrado, false);
    assert.equal(resposta.json.aprovado, false);
    assert.equal(resposta.json.transacao_id, undefined);
    assert.equal(resposta.body.includes('NSU-SECRETO'), false);
    assert.equal(efeitosAdaptador.length, 0);
  });

  it('o outro operador não usa a chave no fechamento', async () => {
    const prova = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([{
      forma_pagamento: 'pix',
      valor: 12.5,
      tef_transacao_id: ids['corr-a'],
      idempotency_key: 'corr-a',
      operador_id: usuarioA.lastID
    }], empresaA.id, usuarioA2.lastID);
    assert.equal(prova.sucesso, false);
    assert.match(prova.erro, /outro operador/);
  });

  it('trocar a chave para outra cobrança não confirma o pagamento', async () => {
    const prova = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([{
      forma_pagamento: 'pix',
      valor: 12.5,
      tef_transacao_id: ids['corr-a'],
      idempotency_key: 'corr-outra'
    }], empresaA.id, usuarioA.lastID);
    assert.equal(prova.sucesso, false);
    assert.match(prova.erro, /correlação/);
  });

  it('trocar a empresa na requisição não abre a cobrança', async () => {
    const resposta = await pedir('/api/tef/acompanhamento?idempotency_key=corr-a&empresa_id=' + empresaB.id, tokenA, empresaB.id);
    assert.equal(resposta.status, 403);
    assert.equal(resposta.json.code, 'EMPRESA_NAO_AUTORIZADA');
  });

  it('operador_id enviado pelo navegador não troca a sessão', async () => {
    const efeitos = efeitosAdaptador.length;
    const resposta = await pedir('/api/tef/pagar', tokenA, empresaA.id, 'POST', {
      tipo: 'pix',
      valor: 12.5,
      operador_id: usuarioA2.lastID,
      idempotency_key: 'corr-nova-a'
    });
    assert.equal(resposta.status, 422);
    assert.equal(capturaPagar.operador_id, usuarioA.lastID);
    assert.notEqual(capturaPagar.operador_id, usuarioA2.lastID);
    assert.equal(efeitosAdaptador.length, efeitos + 1);
    assert.equal(efeitosAdaptador.at(-1), 'autorizar');
  });

  it('operador de outra empresa não acompanha a cobrança', async () => {
    const cabecalho = await pedir('/api/tef/acompanhamento?idempotency_key=corr-a', tokenB, empresaA.id);
    assert.equal(cabecalho.status, 403);
    const propria = await pedir('/api/tef/acompanhamento?idempotency_key=corr-a', tokenB, empresaB.id);
    assert.equal(propria.status, 200);
    assert.equal(propria.json.encontrado, false);
    assert.equal(propria.body.includes('NSU-SECRETO'), false);
  });

  it('cobrança já vinculada não é reutilizada e a repetição permanece idempotente', async () => {
    const pagamento = {
      forma_pagamento: 'cartao_debito',
      valor: 9,
      tef_transacao_id: ids['corr-reuso'],
      idempotency_key: 'corr-reuso',
      operador_id: 999
    };
    const primeira = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([pagamento], empresaA.id, usuarioA.lastID);
    const segunda = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([pagamento], empresaA.id, usuarioA.lastID);
    assert.equal(primeira.sucesso, true);
    assert.equal(segunda.sucesso, true);
    const vinculo = await run(`
      UPDATE tef_transacoes
      SET venda_id = ?, atualizado_em = datetime('now')
      WHERE id = ? AND venda_id IS NULL AND empresa_id = ?
        AND (operador_id IS NULL OR operador_id = ?)
    `, [80, ids['corr-reuso'], empresaA.id, usuarioA.lastID]);
    assert.equal(vinculo.changes, 1);
    const repetido = await run(`
      UPDATE tef_transacoes
      SET venda_id = ?, atualizado_em = datetime('now')
      WHERE id = ? AND venda_id IS NULL AND empresa_id = ?
        AND (operador_id IS NULL OR operador_id = ?)
    `, [81, ids['corr-reuso'], empresaA.id, usuarioA.lastID]);
    assert.equal(repetido.changes, 0);
    const outro = await run(`
      UPDATE tef_transacoes
      SET venda_id = ?, atualizado_em = datetime('now')
      WHERE id = ? AND venda_id IS NULL AND empresa_id = ?
        AND (operador_id IS NULL OR operador_id = ?)
    `, [82, ids['corr-reuso'], empresaA.id, usuarioA2.lastID]);
    assert.equal(outro.changes, 0);
    const reuso = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([pagamento], empresaA.id, usuarioA.lastID);
    assert.equal(reuso.sucesso, false);
    assert.match(reuso.erro, /já vinculada/);
    const gravada = await get(`SELECT venda_id FROM tef_transacoes WHERE id = ?`, [ids['corr-reuso']]);
    assert.equal(gravada.venda_id, 80);
  });

  it('pendente, recusada, timeout, falha e cancelada não entram no fechamento', async () => {
    const casos = [
      ['corr-pendente', 'pix', 4],
      ['corr-recusada', 'cartao_credito', 4],
      ['corr-timeout', 'pix', 4],
      ['corr-falha', 'pix', 4],
      ['corr-cancelada', 'pix', 4]
    ];
    for (const [chave, forma, valor] of casos) {
      const leitura = await pedir('/api/tef/acompanhamento?idempotency_key=' + chave, tokenA, empresaA.id);
      assert.equal(leitura.json.aprovado, false);
      assert.ok(!leitura.json.transacao_id);
      const prova = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([{
        forma_pagamento: forma,
        valor,
        tef_transacao_id: ids[chave],
        idempotency_key: chave
      }], empresaA.id, usuarioA.lastID);
      assert.equal(prova.sucesso, false);
    }
  });

  it('sessão ausente ou expirada e operador sem empresa são recusados', async () => {
    const ausente = await pedir('/api/tef/acompanhamento?idempotency_key=corr-a');
    assert.equal(ausente.status, 401);
    const expirada = await pedir('/api/tef/acompanhamento?idempotency_key=corr-a', tokenExpirado, empresaA.id);
    assert.equal(expirada.status, 403);
    assert.equal(expirada.json.code, 'SESSAO_INVALIDA');
    assert.equal(expirada.body.includes('NSU-SECRETO'), false);
    const semEmpresa = await pedir('/api/tef/acompanhamento?idempotency_key=corr-a', tokenSemVinculo, empresaA.id);
    assert.equal(semEmpresa.status, 403);
    assert.equal(semEmpresa.json.code, 'EMPRESA_NAO_AUTORIZADA');
  });
});

describe('navegação integrada dos módulos', () => {
  it('Pedido e PDV apontam um para o outro na mesma origem', () => {
    const pedido = fs.readFileSync(path.join(__dirname, '../../frontend/mobile-pedido/index.html'), 'utf8');
    const pdv = fs.readFileSync(path.join(__dirname, '../../frontend/mobile-pdv/index.html'), 'utf8');
    assert.match(pedido, /href="\/mobile-pdv\/"/);
    assert.match(pdv, /href="\/mobile-pedido\/"/);
    assert.match(pedido, /CDS Sistemas/);
    assert.match(pdv, /CDS Sistemas/);
    assert.doesNotMatch(pedido, /<form/i);
    assert.doesNotMatch(pdv, /<form/i);
  });

  it('o encaminhamento preserva operador e empresa e recusa sessão diferente', async () => {
    require('../../frontend/mobile-pedido/mobile-pedido.js');
    require('../../frontend/mobile-pdv/mobile-pdv.js');
    const storage = { valor: null, setItem(_chave, valor) { this.valor = valor; } };
    const resultado = await global.MobilePedido.encaminharPedidoAoPdv(15, {
      fetch: async () => ({
        ok: true,
        json: async () => ({
          pedido_id: 15,
          operacao_id: 4,
          empresa_id: 4,
          itens: [{ produto_id: 1, quantidade: 1, preco_unitario: 10, subtotal: 10 }],
          desconto: 0,
          total: 10
        })
      }),
      storage,
      contexto: {
        temEmpresaSelecionada: () => true,
        headersJson: () => ({ 'X-Empresa-Id': '4', Authorization: 'Bearer sessao' })
      },
      usuario: { id: 8, nome: 'Operador A' }
    });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.destino, '/mobile-pdv');
    const handoff = JSON.parse(storage.valor);
    assert.equal(handoff.sessao_operador_id, 8);
    assert.equal(handoff.empresa_id, 4);
    const mesma = global.MobilePdv.handoffCompativelComSessao(handoff, { id: 8 }, 4);
    assert.equal(mesma.ok, true);
    const outroOperador = global.MobilePdv.handoffCompativelComSessao(handoff, { id: 9 }, 4);
    assert.equal(outroOperador.ok, false);
    assert.equal(outroOperador.codigo, 'OPERADOR_DIVERGENTE');
    const outraEmpresa = global.MobilePdv.handoffCompativelComSessao(handoff, { id: 8 }, 5);
    assert.equal(outraEmpresa.ok, false);
    assert.equal(outraEmpresa.codigo, 'EMPRESA_DIVERGENTE');
  });
});
