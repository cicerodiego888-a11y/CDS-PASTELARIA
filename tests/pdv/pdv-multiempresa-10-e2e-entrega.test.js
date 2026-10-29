/**
 * PDV-MULTIEMPRESA-10 — E2E Entrega (CriarVendaEntregaService via POST /api/vendas).
 * Isolamento: DB_DIR temporário. Sem CDS_ALLOW_OFFICIAL_DB / SEFAZ / vendas reais.
 * Executar: node --test tests/pdv/pdv-multiempresa-10-e2e-entrega.test.js
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-m10-entrega-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const db = require('../../backend/database');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const VendaApplicationService = require('../../backend/services/vendas/VendaApplicationService');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const CNPJ = '11222333000181';

function whenReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DB isolado não ficou pronto')), 90000);
    db.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

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

function httpJson(server, method, urlPath, body, headers = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body == null ? null : JSON.stringify(body);
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`HTTP timeout ${timeoutMs}ms ${method} ${urlPath}`));
    }, timeoutMs);
    const req = http.request({
      host: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = { raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

let recursoOriginal;
let empresa;
let caixaSessao;
let server;
const mensagensBloqueio = [];

async function criarProduto(nome) {
  const ins = await run(
    `INSERT INTO produtos (
       nome, unidade, tipo_operacional, controla_estoque,
       saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
     ) VALUES (?, 'UN', 'COMERCIAL', 1, 0, 0, 0, 10, 1)`,
    [nome]
  );
  await EstoqueEmpresaService.criarRegistro({
    produtoId: ins.lastID,
    empresaId: empresa.id,
    saldo_fiscal: 0,
    saldo_nao_fiscal: 0,
    estoque_atual: 0
  }, { db });
  return ins.lastID;
}

async function setEstoque(produtoId, fiscal, naoFiscal) {
  await run(
    `UPDATE estoque_empresa
     SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?,
         reservado_fiscal = 0, reservado_nao_fiscal = 0
     WHERE produto_id = ? AND empresa_id = ?`,
    [fiscal, naoFiscal, fiscal + naoFiscal, produtoId, empresa.id]
  );
  await run(
    `UPDATE produtos SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ? WHERE id = ?`,
    [fiscal, naoFiscal, fiscal + naoFiscal, produtoId]
  );
}

async function snapshotEstoque(produtoId) {
  return get(
    `SELECT e.saldo_fiscal, e.saldo_nao_fiscal, e.estoque_atual,
            e.reservado_fiscal, e.reservado_nao_fiscal,
            p.saldo_fiscal AS p_sf, p.saldo_nao_fiscal AS p_snf
     FROM estoque_empresa e
     JOIN produtos p ON p.id = e.produto_id
     WHERE e.produto_id = ? AND e.empresa_id = ?`,
    [produtoId, empresa.id]
  );
}

async function abrirCaixa() {
  let terminal = await get(`SELECT id FROM terminais ORDER BY id LIMIT 1`);
  if (!terminal) {
    const cols = await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(terminais)`, [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    const nomes = new Set(cols.map((c) => c.name));
    const ins = nomes.has('nome')
      ? await run(`INSERT INTO terminais (nome, hostname) VALUES ('M10-ENT', 'm10-host')`)
      : await run(`INSERT INTO terminais DEFAULT VALUES`);
    terminal = { id: ins.lastID };
  }
  const admin = await get(`SELECT id FROM usuarios ORDER BY id LIMIT 1`);
  const turno = await run(
    `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
     VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
    [terminal.id, admin ? admin.id : null]
  );
  const sess = await run(
    `INSERT INTO caixa_sessoes (
       caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
     ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
    [turno.lastID, terminal.id, admin ? admin.id : null, empresa.id]
  );
  return {
    id: sess.lastID,
    empresa_id: empresa.id,
    status: 'aberto',
    caixa_turno_id: turno.lastID,
    terminal_id: terminal.id,
    operador_id: admin ? admin.id : 1
  };
}

function payloadEntrega({ produtoId, quantidade, emitirFiscal, preco = 10 }) {
  const total = Number((quantidade * preco).toFixed(2));
  return {
    tipo_venda: 'ENTREGA',
    origem: 'PDV',
    total,
    desconto: 0,
    emitir_fiscal: emitirFiscal,
    pagamento_previsto: 'DINHEIRO',
    endereco_entrega: 'Rua Sintética 100',
    telefone_entrega: '11999990000',
    itens: [{
      produto_id: produtoId,
      quantidade,
      preco_unitario: preco,
      subtotal: total,
      tipo_venda: 'UNIDADE'
    }]
  };
}

function criarApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.user = { id: 1, perfil: 'ADMIN', nome: 'm10-entrega' };
    req.empresaId = empresa.id;
    req.empresa_id = empresa.id;
    req.caixaSessao = caixaSessao;
    req.caixaSessaoId = caixaSessao.id;
    req.caixaId = caixaSessao.caixa_turno_id;
    req.terminalId = caixaSessao.terminal_id;
    req.operadorId = caixaSessao.operador_id || 1;
    next();
  });
  app.post('/api/vendas', (req, res) => {
    const result = VendaApplicationService.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
      db
    });
    if (result && typeof result.then === 'function') {
      result.catch((err) => {
        if (!res.headersSent) {
          res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
        }
      });
    }
  });
  return app;
}

describe('PDV-MULTIEMPRESA-10 E2E Entrega', { concurrency: false }, () => {
  before(async () => {
    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'vendasEntrega') return true;
      return typeof recursoOriginal === 'function' ? recursoOriginal.call(configService, nome) : true;
    };

    await whenReady();
    await garantirSchemaEstoqueEmpresaAsync(db);
    empresa = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ, razao_social: 'Empresa M10 Entrega' },
      { db }
    );
    caixaSessao = await abrirCaixa();
    server = http.createServer(criarApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  it('E1 — fiscal com saldo fiscal suficiente: permite (reserva, sem SEFAZ)', async () => {
    const prod = await criarProduto('E1-FiscalOk');
    await setEstoque(prod, 10, 0);
    const before = await snapshotEstoque(prod);
    const resp = await httpJson(server, 'POST', '/api/vendas', payloadEntrega({
      produtoId: prod,
      quantidade: 3,
      emitirFiscal: true
    }));
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    assert.ok(resp.body && (resp.body.id || resp.body.venda_id || resp.body.sucesso !== false));
    const after = await snapshotEstoque(prod);
    // Entrega reserva (não baixa definitiva): NF permanece 0; sem consumo cruzado.
    assert.equal(Number(after.saldo_nao_fiscal), Number(before.saldo_nao_fiscal));
    assert.ok(
      Number(after.saldo_fiscal) <= Number(before.saldo_fiscal),
      'saldo fiscal não deve aumentar após reserva'
    );
  });

  it('E2 — fiscal sem saldo fiscal: bloqueia; mensagem com estoqueTotal; sem débito parcial', async () => {
    const prod = await criarProduto('E2-FiscalBloq');
    await setEstoque(prod, 0, 20);
    const before = await snapshotEstoque(prod);
    const resp = await httpJson(server, 'POST', '/api/vendas', payloadEntrega({
      produtoId: prod,
      quantidade: 2,
      emitirFiscal: true
    }));
    assert.equal(resp.status, 400, JSON.stringify(resp.body));
    const msg = String(resp.body && (resp.body.error || resp.body.mensagem) || '');
    mensagensBloqueio.push({ cenario: 'E2', mensagem: msg });
    assert.match(msg, /insuficiente|Disponível/i);
    // Diferença conhecida M09/M10: canal usa estoqueTotal (20), não disponivelBucket (0).
    assert.match(msg, /Disponível:\s*20/);
    const after = await snapshotEstoque(prod);
    assert.deepEqual(
      {
        sf: Number(after.saldo_fiscal),
        snf: Number(after.saldo_nao_fiscal),
        rf: Number(after.reservado_fiscal),
        rnf: Number(after.reservado_nao_fiscal)
      },
      {
        sf: Number(before.saldo_fiscal),
        snf: Number(before.saldo_nao_fiscal),
        rf: Number(before.reservado_fiscal),
        rnf: Number(before.reservado_nao_fiscal)
      }
    );
  });

  it('E3 — não fiscal com saldo NF suficiente: permite', async () => {
    const prod = await criarProduto('E3-NfOk');
    await setEstoque(prod, 0, 8);
    const resp = await httpJson(server, 'POST', '/api/vendas', payloadEntrega({
      produtoId: prod,
      quantidade: 4,
      emitirFiscal: false
    }));
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
  });

  it('E4 — não fiscal sem saldo NF: bloqueia sem débito parcial', async () => {
    const prod = await criarProduto('E4-NfBloq');
    await setEstoque(prod, 15, 0);
    const before = await snapshotEstoque(prod);
    const resp = await httpJson(server, 'POST', '/api/vendas', payloadEntrega({
      produtoId: prod,
      quantidade: 2,
      emitirFiscal: false
    }));
    assert.equal(resp.status, 400, JSON.stringify(resp.body));
    const msg = String(resp.body && resp.body.error || '');
    mensagensBloqueio.push({ cenario: 'E4', mensagem: msg });
    assert.match(msg, /Disponível:\s*15/);
    const after = await snapshotEstoque(prod);
    assert.equal(Number(after.saldo_fiscal), Number(before.saldo_fiscal));
    assert.equal(Number(after.saldo_nao_fiscal), Number(before.saldo_nao_fiscal));
    assert.equal(Number(after.reservado_fiscal), Number(before.reservado_fiscal));
    assert.equal(Number(after.reservado_nao_fiscal), Number(before.reservado_nao_fiscal));
  });

  it('E5 — qty > bucket fiscal com NF sobrando: bloqueia sem parcial', async () => {
    const prod = await criarProduto('E5-Parcial');
    await setEstoque(prod, 2, 50);
    const before = await snapshotEstoque(prod);
    const resp = await httpJson(server, 'POST', '/api/vendas', payloadEntrega({
      produtoId: prod,
      quantidade: 5,
      emitirFiscal: true
    }));
    assert.equal(resp.status, 400, JSON.stringify(resp.body));
    const msg = String(resp.body && resp.body.error || '');
    mensagensBloqueio.push({ cenario: 'E5', mensagem: msg });
    // Total 52 — mensagem ainda reporta estoqueTotal (limitação documentada).
    assert.match(msg, /Disponível:\s*52/);
    const after = await snapshotEstoque(prod);
    assert.equal(Number(after.saldo_fiscal), 2);
    assert.equal(Number(after.saldo_nao_fiscal), 50);
    assert.equal(Number(after.reservado_fiscal), Number(before.reservado_fiscal));
  });

  it('registro auxiliar — mensagens de bloqueio capturadas', () => {
    assert.ok(mensagensBloqueio.length >= 3);
    for (const m of mensagensBloqueio) {
      assert.ok(m.mensagem.includes('Disponível:'));
    }
  });
});
