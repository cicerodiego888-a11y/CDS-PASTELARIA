/**
 * PDV-SEL-02 — Homologação E2E do seletor automático (HTTP → persistência).
 * Isolamento: DB_DIR temporário + CDS_BLOQUEAR_BANCO_OFICIAL (sem CDS_ALLOW_OFFICIAL_DB).
 * Executar: node --test tests/pdv/pdv-sel-02-e2e-selecao-empresa.test.js
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-sel-02-'));
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
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  CODIGOS_BLOQUEIO,
  hashCarrinho
} = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL_B = '11222333000262';
const CNPJ_FILIAL_C = '11222333000343';

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

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
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

let modoOriginal;
let matriz;
let filialB;
let filialC;
let caixaMatriz;
let caixaFilialB;
let server;
let caixaAtivoRef = { current: null };
let headerEmpresaRef = { current: null };

async function criarProduto({ nome, saldoFiscal = 0, saldoNaoFiscal = 0, controla = 1, usaFicha = 0, preco = 10 }) {
  const ins = await run(
    `INSERT INTO produtos (
       nome, unidade, tipo_operacional, controla_estoque, utiliza_ficha_tecnica,
       saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
     ) VALUES (?, 'UN', 'COMERCIAL', ?, ?, ?, ?, ?, ?, 1)`,
    [nome, controla, usaFicha, saldoFiscal, saldoNaoFiscal, saldoFiscal + saldoNaoFiscal, preco]
  );
  const id = ins.lastID;
  for (const emp of [matriz, filialB, filialC]) {
    await EstoqueEmpresaService.criarRegistro({
      produtoId: id,
      empresaId: emp.id,
      saldo_fiscal: 0,
      saldo_nao_fiscal: 0,
      estoque_atual: 0
    }, { db });
  }
  return id;
}

async function setEstoque(produtoId, empresaId, fiscal, naoFiscal = fiscal) {
  await run(
    `UPDATE estoque_empresa
     SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?,
         reservado_fiscal = 0, reservado_nao_fiscal = 0
     WHERE produto_id = ? AND empresa_id = ?`,
    [fiscal, naoFiscal, fiscal + naoFiscal, produtoId, empresaId]
  );
  // Espelha o agregado em produtos — não sobrescrever com o último UPDATE de filial zerada.
  const agg = await get(
    `SELECT COALESCE(SUM(saldo_fiscal),0) AS sf,
            COALESCE(SUM(saldo_nao_fiscal),0) AS snf,
            COALESCE(SUM(estoque_atual),0) AS ea
     FROM estoque_empresa WHERE produto_id = ?`,
    [produtoId]
  );
  await run(
    `UPDATE produtos SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ? WHERE id = ?`,
    [Number(agg.sf), Number(agg.snf), Number(agg.ea), produtoId]
  );
}

async function garantirTerminal() {
  const existente = await get(`SELECT id FROM terminais ORDER BY id LIMIT 1`);
  if (existente) return Number(existente.id);
  const cols = await all(`PRAGMA table_info(terminais)`);
  const nomes = new Set(cols.map((c) => c.name));
  if (nomes.has('nome') && nomes.has('hostname')) {
    const ins = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-SEL02', 'sel02-host')`);
    return ins.lastID;
  }
  const ins = await run(`INSERT INTO terminais DEFAULT VALUES`);
  return ins.lastID;
}

async function abrirCaixa(empresaId) {
  const terminalId = await garantirTerminal();
  const admin = await get(`SELECT id FROM usuarios ORDER BY id LIMIT 1`);
  const operadorId = admin ? Number(admin.id) : null;
  const turno = await run(
    `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
     VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
    [terminalId, operadorId]
  );
  // caixa_id referencia tabela caixas (multi-caixa); em modo turno usa só caixa_turno_id → caixa(id)
  const sess = await run(
    `INSERT INTO caixa_sessoes (
       caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
     ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
    [turno.lastID, terminalId, operadorId, empresaId]
  );
  return {
    id: sess.lastID,
    empresa_id: empresaId,
    status: 'aberto',
    caixa_turno_id: turno.lastID,
    caixa_id: null,
    terminal_id: terminalId,
    operador_id: operadorId
  };
}

/**
 * Homologação E2E sem SEFAZ (restrição PDV-SEL-02):
 * - venda_fiscal controla tipo de saldo / Motor F×NF (capacidade + baixa)
 * - emitir_fiscal permanece false para não transmitir NFC-e
 */
function montarPayload({ produtoId, quantidade = 1, preco = 10, vendaFiscal = true, extras = {} }) {
  const total = Number((quantidade * preco).toFixed(2));
  return {
    origem: 'PDV',
    total,
    desconto: 0,
    acrescimo: 0,
    forma_pagamento: 'dinheiro',
    emitir_fiscal: false,
    venda_fiscal: vendaFiscal,
    itens: [{
      produto_id: produtoId,
      quantidade,
      preco_unitario: preco,
      subtotal: total,
      tipo_venda: 'UNIDADE'
    }],
    pagamentos: [{
      forma_pagamento: 'dinheiro',
      valor: total,
      tipo_recebimento: vendaFiscal ? 'fiscal' : 'nao_fiscal'
    }],
    ...extras
  };
}

function criarAppHttp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    req.user = { id: 1, perfil: 'ADMIN', nome: 'sel02' };
    req.empresaId = headerEmpresaRef.current != null ? headerEmpresaRef.current : matriz.id;
    if (caixaAtivoRef.current) {
      req.caixaSessao = caixaAtivoRef.current;
      req.caixaSessaoId = caixaAtivoRef.current.id;
      req.caixaId = caixaAtivoRef.current.caixa_turno_id;
      req.terminalId = 1;
      req.operadorId = 1;
    }
    next();
  });

  app.post('/api/vendas/selecao-empresa', async (req, res) => {
    try {
      const {
        avaliarSelecaoEmpresaPdv
      } = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');
      const out = await avaliarSelecaoEmpresaPdv({
        body: req.body || {},
        itens: (req.body && req.body.itens) || [],
        usuarioId: req.user.id,
        usuario: req.user
      }, { db, usarAutorizacaoUsuario: false, verificarFiscalValido: async () => true });
      if (out.bloqueio) {
        return res.status(409).json({
          success: false,
          code: out.bloqueio.codigo,
          error: out.bloqueio.mensagem,
          mensagem: out.bloqueio.mensagem,
          selecao: out
        });
      }
      return res.status(200).json({
        success: true,
        empresa_id: out.selecionada.empresaId,
        justificativa: out.justificativa,
        hash_carrinho: out.hashCarrinho
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        success: false,
        code: err.code,
        error: err.message
      });
    }
  });

  app.post('/api/vendas', (req, res) => {
    const result = VendaApplicationService.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'MULTIEMPRESA',
      db,
      usarAutorizacaoUsuario: false,
      verificarFiscalValido: async () => true
    });
    if (result && typeof result.then === 'function') {
      result.catch((err) => {
        if (!res.headersSent) {
          res.status(err.statusCode || 500).json({
            success: false,
            error: err.message,
            code: err.code
          });
        }
      });
    }
  });

  return app;
}

describe('PDV-SEL-02 E2E seletor', { concurrency: false }, () => {
  before(async () => {
    modoOriginal = configService.obterModoOperacionalGlobal;
    configService.obterModoOperacionalGlobal = () => 'MULTIEMPRESA';

    await whenReady();
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaFichaTecnicaAsync(db);

    matriz = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz SEL02' },
      { db }
    );
    filialB = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B SEL02' },
      { db }
    );
    filialC = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C SEL02' },
      { db }
    );

    caixaMatriz = await abrirCaixa(matriz.id);
    caixaFilialB = await abrirCaixa(filialB.id);
    caixaAtivoRef.current = caixaMatriz;
    headerEmpresaRef.current = matriz.id;

    assert.ok(String(db.dbPath || '').startsWith(dbDir), `dbPath fora do isolamento: ${db.dbPath}`);
    assert.ok(!/ProgramData/i.test(String(db.dbPath || '')));

    const app = criarAppHttp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    configService.obterModoOperacionalGlobal = modoOriginal;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('T01 — POST /api/vendas persiste empresa selecionada (matriz)', async () => {
    caixaAtivoRef.current = caixaMatriz;
    headerEmpresaRef.current = filialB.id; // header diverge de propósito
    const produtoId = await criarProduto({ nome: 'Pastel T01', saldoFiscal: 0 });
    await setEstoque(produtoId, matriz.id, 5, 5);
    await setEstoque(produtoId, filialB.id, 5, 5);

    const payload = montarPayload({ produtoId, vendaFiscal: true });
    const resp = await httpJson(server, 'POST', '/api/vendas', payload, {
      'X-Empresa-Id': String(filialB.id)
    });

    assert.ok(resp.status < 400, `HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
    const vendaId = resp.body.venda_id || resp.body.id || resp.body.vendaId;
    assert.ok(vendaId, `sem venda_id: ${JSON.stringify(resp.body)}`);

    const venda = await get('SELECT id, empresa_id, total, caixa_sessao_id FROM vendas WHERE id = ?', [vendaId]);
    assert.equal(Number(venda.empresa_id), Number(matriz.id));
    assert.equal(Number(venda.caixa_sessao_id), Number(caixaMatriz.id));

    const itens = await all('SELECT empresa_id FROM vendas_itens WHERE venda_id = ?', [vendaId]).catch(() => []);
    // Schema pode não ter empresa_id em itens — ownership via venda.
    if (itens.length && Object.prototype.hasOwnProperty.call(itens[0], 'empresa_id') && itens[0].empresa_id != null) {
      assert.ok(itens.every((i) => Number(i.empresa_id) === Number(matriz.id)));
    }

    const ee = await get(
      'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
      [produtoId, matriz.id]
    );
    assert.ok(Number(ee.saldo_fiscal) < 5, 'estoque da matriz deveria ter baixado');
  });

  it('T01b — bloqueio não cria venda parcial', async () => {
    caixaAtivoRef.current = caixaMatriz;
    headerEmpresaRef.current = matriz.id;
    const produtoId = await criarProduto({ nome: 'Pastel T01b' });
    await setEstoque(produtoId, matriz.id, 1, 1);
    await setEstoque(produtoId, filialB.id, 1, 1);
    await setEstoque(produtoId, filialC.id, 1, 1);

    const antes = await get('SELECT COUNT(*) AS n FROM vendas');
    const resp = await httpJson(server, 'POST', '/api/vendas', montarPayload({
      produtoId,
      quantidade: 10,
      vendaFiscal: true
    }));
    assert.equal(resp.status, 409);
    assert.equal(resp.body.code, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    const depois = await get('SELECT COUNT(*) AS n FROM vendas');
    assert.equal(Number(depois.n), Number(antes.n));
  });

  it('T02 — integridade multiempresa (venda/estoque/financeiro/caixa)', async () => {
    caixaAtivoRef.current = caixaFilialB;
    headerEmpresaRef.current = matriz.id;
    const produtoId = await criarProduto({ nome: 'Pastel T02' });
    await setEstoque(produtoId, matriz.id, 0, 0);
    await setEstoque(produtoId, filialB.id, 3, 3);
    await setEstoque(produtoId, filialC.id, 3, 3);

    const resp = await httpJson(server, 'POST', '/api/vendas', montarPayload({
      produtoId,
      vendaFiscal: true
    }), { 'X-Empresa-Id': String(matriz.id) });

    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const vendaId = resp.body.venda_id || resp.body.id;
    const venda = await get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    assert.equal(Number(venda.empresa_id), Number(filialB.id));
    assert.equal(Number(venda.caixa_sessao_id), Number(caixaFilialB.id));

    const eeB = await get(
      'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
      [produtoId, filialB.id]
    );
    const eeM = await get(
      'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
      [produtoId, matriz.id]
    );
    assert.equal(Number(eeM.saldo_fiscal), 0);
    assert.ok(Number(eeB.saldo_fiscal) < 3);

    const finCols = await all(`PRAGMA table_info(financeiro)`);
    const temEmpresaFin = finCols.some((c) => c.name === 'empresa_id');
    if (temEmpresaFin) {
      const fins = await all('SELECT empresa_id FROM financeiro WHERE venda_id = ?', [vendaId]).catch(() => []);
      if (fins.length) {
        assert.ok(fins.every((f) => Number(f.empresa_id) === Number(filialB.id)));
      }
    }

    const pagCols = await all(`PRAGMA table_info(venda_pagamentos)`);
    const temEmpresaPag = pagCols.some((c) => c.name === 'empresa_id');
    if (temEmpresaPag) {
      const pags = await all('SELECT empresa_id FROM venda_pagamentos WHERE venda_id = ?', [vendaId]);
      if (pags.length && pags[0].empresa_id != null) {
        assert.ok(pags.every((p) => Number(p.empresa_id) === Number(filialB.id)));
      }
    }
  });

  it('T03 — concorrência HTTP: duas finalizações no mesmo estoque unitário', async () => {
    caixaAtivoRef.current = caixaMatriz;
    headerEmpresaRef.current = matriz.id;
    const produtoId = await criarProduto({ nome: 'Pastel T03 race' });
    await setEstoque(produtoId, matriz.id, 1, 0);
    await setEstoque(produtoId, filialB.id, 0, 0);
    await setEstoque(produtoId, filialC.id, 0, 0);

    const payload = montarPayload({ produtoId, vendaFiscal: true });
    const [r1, r2] = await Promise.all([
      httpJson(server, 'POST', '/api/vendas', { ...payload }, { 'X-Empresa-Id': String(matriz.id) }),
      httpJson(server, 'POST', '/api/vendas', { ...payload }, { 'X-Empresa-Id': String(matriz.id) })
    ]);

    const statuses = [r1.status, r2.status].sort();
    const okCount = [r1, r2].filter((r) => r.status < 400).length;
    const failCount = [r1, r2].filter((r) => r.status >= 400).length;

    assert.equal(okCount, 1, `esperado 1 sucesso; got ${JSON.stringify({ r1, r2, statuses })}`);
    assert.equal(failCount, 1, `esperado 1 falha; got ${JSON.stringify({ r1, r2 })}`);

    const ee = await get(
      'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
      [produtoId, matriz.id]
    );
    assert.ok(Number(ee.saldo_fiscal) <= 0 + 1e-9, `saldo residual inconsistente: ${ee.saldo_fiscal}`);

    const idsPersistidos = [r1, r2]
      .map((r) => Number(r.body && (r.body.venda_id || r.body.id)))
      .filter((id) => Number.isInteger(id) && id > 0);
    assert.ok(idsPersistidos.length <= 1, `vendas persistidas inconsistentes: ${idsPersistidos}`);
    if (idsPersistidos.length === 1) {
      const row = await get('SELECT id FROM vendas WHERE id = ?', [idsPersistidos[0]]);
      assert.ok(row, 'venda de sucesso deve existir');
    }
  });

  it('T04 — misto fiscal/não fiscal: capacidade alinhada ao tipo da operação', async () => {
    caixaAtivoRef.current = caixaMatriz;
    headerEmpresaRef.current = matriz.id;
    const produtoId = await criarProduto({ nome: 'Pastel T04 misto' });
    // Só saldo não fiscal na matriz; filiais zeradas.
    await setEstoque(produtoId, matriz.id, 0, 5);
    await setEstoque(produtoId, filialB.id, 0, 0);
    await setEstoque(produtoId, filialC.id, 0, 0);

    const bloqueioFiscal = await httpJson(server, 'POST', '/api/vendas', montarPayload({
      produtoId,
      vendaFiscal: true
    }));
    assert.equal(bloqueioFiscal.status, 409, 'com venda_fiscal=true não pode aprovar só com saldo não fiscal');

    const okNaoFiscal = await httpJson(server, 'POST', '/api/vendas', montarPayload({
      produtoId,
      vendaFiscal: false
    }));
    assert.ok(okNaoFiscal.status < 400, JSON.stringify(okNaoFiscal.body));
    const vendaId = okNaoFiscal.body.venda_id || okNaoFiscal.body.id;
    const venda = await get('SELECT empresa_id, valor_fiscal, valor_nao_fiscal FROM vendas WHERE id = ?', [vendaId]);
    assert.equal(Number(venda.empresa_id), Number(matriz.id));

    // Evidência estrutural: seletor usa um único tipoSaldo por operação (R08),
    // correspondente a venda_fiscal (Motor F×NF) — não soma tipos nem CNPJs.
    // Carrinho misto item-a-item com saldos granulares distintos não é coberto
    // pelo contrato atual do seletor (um tipoSaldo por request); motor fiscal
    // não foi alterado nesta sprint.
  });

  it('T05 — caixa: compatível / outra empresa / ausente / header divergente', async () => {
    const produtoId = await criarProduto({ nome: 'Pastel T05' });
    await setEstoque(produtoId, matriz.id, 2, 2);
    await setEstoque(produtoId, filialB.id, 2, 2);

    // Compatível (matriz selecionada + caixa matriz)
    caixaAtivoRef.current = caixaMatriz;
    headerEmpresaRef.current = matriz.id;
    let resp = await httpJson(server, 'POST', '/api/vendas', montarPayload({ produtoId }));
    assert.ok(resp.status < 400, JSON.stringify(resp.body));

    // Caixa só na filial, mas matriz atende → bloqueio sem troca
    caixaAtivoRef.current = caixaFilialB;
    headerEmpresaRef.current = filialB.id;
    await setEstoque(produtoId, matriz.id, 2, 2);
    resp = await httpJson(server, 'POST', '/api/vendas', montarPayload({ produtoId }), {
      'X-Empresa-Id': String(filialB.id)
    });
    assert.equal(resp.status, 409);
    assert.equal(resp.body.code, CODIGOS_BLOQUEIO.CAIXA_INCOMPATIVEL);

    // Ausência de caixa
    caixaAtivoRef.current = null;
    headerEmpresaRef.current = matriz.id;
    resp = await httpJson(server, 'POST', '/api/vendas', montarPayload({ produtoId }));
    assert.equal(resp.status, 409);
    assert.equal(resp.body.code, CODIGOS_BLOQUEIO.CAIXA_INCOMPATIVEL);

    // Header divergente mas caixa da empresa selecionada
    caixaAtivoRef.current = caixaMatriz;
    headerEmpresaRef.current = filialC.id;
    resp = await httpJson(server, 'POST', '/api/vendas', montarPayload({ produtoId }), {
      'X-Empresa-Id': String(filialC.id)
    });
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const vendaId = resp.body.venda_id || resp.body.id;
    const venda = await get('SELECT empresa_id FROM vendas WHERE id = ?', [vendaId]);
    assert.equal(Number(venda.empresa_id), Number(matriz.id));
  });

  it('T06 — snapshot/carrinho alterado: hash antigo não autoriza', async () => {
    caixaAtivoRef.current = caixaMatriz;
    headerEmpresaRef.current = matriz.id;
    const produtoId = await criarProduto({ nome: 'Pastel T06' });
    await setEstoque(produtoId, matriz.id, 10, 10);

    const preview = await httpJson(server, 'POST', '/api/vendas/selecao-empresa', {
      itens: [{ produto_id: produtoId, quantidade: 1 }],
      venda_fiscal: true,
      emitir_fiscal: false
    });
    assert.ok(preview.status < 400, JSON.stringify(preview.body));
    const hashAntigo = preview.body.hash_carrinho;
    assert.ok(hashAntigo);

    const hashNovo = hashCarrinho([{ produto_id: produtoId, quantidade: 2 }]);
    assert.notEqual(hashAntigo, hashNovo);

    // Finaliza com carrinho diferente + hash antigo: servidor recalcula (não usa snapshot como autorização)
    const resp = await httpJson(server, 'POST', '/api/vendas', montarPayload({
      produtoId,
      quantidade: 2,
      vendaFiscal: true,
      extras: { selecao_hash: hashAntigo }
    }));
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const vendaId = resp.body.venda_id || resp.body.id;
    const item = await get(
      'SELECT quantidade FROM vendas_itens WHERE venda_id = ?',
      [vendaId]
    );
    assert.ok(Number(item.quantidade) === 2 || Number(item.quantidade) >= 2 - 1e-9);

    // Carrinho impossível com hash de carrinho antigo viável → bloqueio
    await setEstoque(produtoId, matriz.id, 0, 0);
    await setEstoque(produtoId, filialB.id, 0, 0);
    await setEstoque(produtoId, filialC.id, 0, 0);
    const bloqueio = await httpJson(server, 'POST', '/api/vendas', montarPayload({
      produtoId,
      quantidade: 1,
      vendaFiscal: true,
      extras: { selecao_hash: hashAntigo }
    }));
    assert.equal(bloqueio.status, 409);
  });
});
