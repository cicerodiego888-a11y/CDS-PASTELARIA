/**
 * CDS-PDV-EMPRESA-UNICA-04 — validação no save + HTTP isolado (middleware → persistência).
 * Executar: node --test tests/pdv/cds-pdv-empresa-unica-04.test.js
 * Isolamento: DB_DIR temporário. Sem banco oficial / SEFAZ / venda real de produção.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { describe, it, before, after } = require('node:test');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pdv-empresa-unica-04-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const db = require('../../backend/database');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const {
  validarPdvModeloEmpresaAntesDeSalvar,
  middlewareAplicarPdvModeloEmpresa,
  PDV_MODELO_UNICA
} = require('../../backend/services/pdv/PdvModeloEmpresaService');
const {
  exigirEmpresaDaOperacao,
  exigirCaixaCompativelComVenda
} = require('../../backend/services/vendas/VendaEmpresaContextoService');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL = '11222333000262';

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

function writeConfig(partial) {
  const dir = path.join(dbDir, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    tipoImplantacao: 'ERP_SEM_FISCAL',
    modoOperacao: 'LOCAL',
    porta: 3001,
    modo_operacional_global: 'MULTIEMPRESA',
    empresa_operacional_id: null,
    modo_operacao_venda: 'MULTIEMPRESA',
    pdv_modelo_empresa: 'MULTIPLAS',
    pdv_empresa_id: null,
    ...partial
  };
  fs.writeFileSync(path.join(dir, 'configuracoes.json'), JSON.stringify(full, null, 2), 'utf8');
  configService.reloadGlobalConfig();
  return full;
}

function httpJson(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body == null ? null : JSON.stringify(body);
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
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = { raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let matriz;
let filial;
let server;
let caixaMatriz;
let caixaFilial;
let caixaAtivoRef = { current: null };
let persistCalls = 0;

async function abrirCaixa(empresaId) {
  let terminal = await get(`SELECT id FROM terminais ORDER BY id LIMIT 1`);
  if (!terminal) {
    const cols = await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(terminais)`, [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    const nomes = new Set(cols.map((c) => c.name));
    if (nomes.has('nome') && nomes.has('hostname')) {
      const ins = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-U04', 'u04-host')`);
      terminal = { id: ins.lastID };
    } else {
      const ins = await run(`INSERT INTO terminais DEFAULT VALUES`);
      terminal = { id: ins.lastID };
    }
  }
  const admin = await get(`SELECT id FROM usuarios ORDER BY id LIMIT 1`);
  const operadorId = admin ? Number(admin.id) : 1;
  const turno = await run(
    `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
     VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
    [terminal.id, operadorId]
  );
  const sess = await run(
    `INSERT INTO caixa_sessoes (
       caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
     ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
    [turno.lastID, terminal.id, operadorId, empresaId]
  );
  return {
    id: sess.lastID,
    empresa_id: empresaId,
    status: 'aberto',
    caixa_turno_id: turno.lastID,
    caixa_id: null,
    terminal_id: terminal.id,
    operador_id: operadorId
  };
}

/**
 * Harness HTTP: middleware real de PDV UNICA + checagem de caixa +
 * persistência controlada em `vendas` (mesmo contrato de empresa_id do núcleo).
 * Não chama SEFAZ/TEF; INSERT isolado no DB_DIR.
 */
function criarAppHttp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.user = { id: 1, perfil: 'ADMIN', nome: 'u04' };
    const hdr = req.headers['x-empresa-id'] || req.headers['x-empresaid'];
    req.headerEmpresaIdOriginal = hdr != null && hdr !== '' ? Number(hdr) : null;
    if (req.headerEmpresaIdOriginal != null) {
      req.empresaId = req.headerEmpresaIdOriginal;
    }
    if (caixaAtivoRef.current) {
      req.caixaSessao = caixaAtivoRef.current;
      req.caixaSessaoId = caixaAtivoRef.current.id;
      req.caixaId = caixaAtivoRef.current.caixa_turno_id;
      req.terminalId = caixaAtivoRef.current.terminal_id;
      req.operadorId = caixaAtivoRef.current.operador_id;
    }
    next();
  });

  // Alinhado à rota real (CDS-06): canal HTTP confiável.
  const aplicarPdv = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });

  app.post('/api/vendas', aplicarPdv, async (req, res) => {
    try {
      const empresaIdVenda = exigirEmpresaDaOperacao(req);
      exigirCaixaCompativelComVenda(req, empresaIdVenda);
      req.empresaIdVenda = empresaIdVenda;

      persistCalls += 1;
      const codigo = `U04-${Date.now()}`;
      const total = Number((req.body && req.body.total) || 10);
      const ins = await run(
        `INSERT INTO vendas (
           codigo, data_venda, total, desconto, forma_pagamento, status,
           caixa_sessao_id, terminal_id, operador_id, empresa_id, origem
         ) VALUES (?, datetime('now','localtime'), ?, 0, 'dinheiro', 'concluida', ?, ?, ?, ?, 'PDV')`,
        [
          codigo,
          total,
          req.caixaSessaoId || null,
          req.terminalId || null,
          req.operadorId || null,
          empresaIdVenda
        ]
      );

      return res.status(201).json({
        success: true,
        venda_id: ins.lastID,
        empresa_id: empresaIdVenda,
        empresa_id_middleware: req.empresaId,
        header_empresa_id_original: req.headerEmpresaIdOriginal,
        header_empresa_id_apos_middleware: req.headers['x-empresa-id']
          ? Number(req.headers['x-empresa-id'])
          : null,
        pdv_modelo: req.pdvModeloEmpresa || null
      });
    } catch (err) {
      return res.status(err.statusCode || err.status || 400).json({
        success: false,
        error: err.message,
        code: err.code,
        venda_concluida: false
      });
    }
  });

  return app;
}

describe('CDS-PDV-EMPRESA-UNICA-04', { concurrency: false }, () => {
  before(async () => {
    writeConfig({});
    await whenReady();
    assert.ok(String(db.dbPath || '').startsWith(dbDir), `dbPath fora do isolamento: ${db.dbPath}`);

    matriz = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz U04' },
      { db }
    );
    filial = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_FILIAL, razao_social: 'Filial U04' },
      { db }
    );
    caixaMatriz = await abrirCaixa(matriz.id);
    caixaFilial = await abrirCaixa(filial.id);
    caixaAtivoRef.current = caixaMatriz;

    writeConfig({
      pdv_modelo_empresa: 'UNICA',
      pdv_empresa_id: matriz.id,
      modo_operacional_global: 'MULTIEMPRESA'
    });

    const app = criarAppHttp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
    } catch (_e) { /* ignore */ }
  });

  it('A1) save UNICA com empresa ativa persiste; global intacto', async () => {
    writeConfig({
      pdv_modelo_empresa: 'MULTIPLAS',
      pdv_empresa_id: null,
      modo_operacional_global: 'MULTIEMPRESA',
      empresa_operacional_id: null
    });
    const before = configService.readConfig();
    const saved = await configService.saveConfigComValidacaoPdv({
      ...before,
      pdv_modelo_empresa: 'UNICA',
      pdv_empresa_id: matriz.id
    }, { db });

    assert.equal(saved.pdv_modelo_empresa, PDV_MODELO_UNICA);
    assert.equal(Number(saved.pdv_empresa_id), Number(matriz.id));
    assert.equal(saved.modo_operacional_global, 'MULTIEMPRESA');
    assert.equal(saved.empresa_operacional_id, null);

    const disk = JSON.parse(
      fs.readFileSync(path.join(dbDir, 'config', 'configuracoes.json'), 'utf8')
    );
    assert.equal(disk.pdv_modelo_empresa, 'UNICA');
    assert.equal(Number(disk.pdv_empresa_id), Number(matriz.id));
  });

  it('A2) save UNICA com empresa inexistente rejeita e não grava', async () => {
    writeConfig({
      pdv_modelo_empresa: 'MULTIPLAS',
      pdv_empresa_id: null,
      modo_operacional_global: 'MULTIEMPRESA'
    });
    const beforeDisk = fs.readFileSync(
      path.join(dbDir, 'config', 'configuracoes.json'),
      'utf8'
    );

    await assert.rejects(
      () => configService.saveConfigComValidacaoPdv({
        ...configService.readConfig(),
        pdv_modelo_empresa: 'UNICA',
        pdv_empresa_id: 999999
      }, { db }),
      (err) => err.code === 'EMPRESA_NAO_ENCONTRADA'
        || err.code === 'PDV_EMPRESA_INVALIDA'
    );

    const afterDisk = fs.readFileSync(
      path.join(dbDir, 'config', 'configuracoes.json'),
      'utf8'
    );
    assert.equal(afterDisk, beforeDisk);
    const cfg = configService.readConfig();
    assert.equal(cfg.pdv_modelo_empresa, 'MULTIPLAS');
  });

  it('A3) save UNICA com empresa inativa rejeita e não grava', async () => {
    writeConfig({
      pdv_modelo_empresa: 'MULTIPLAS',
      pdv_empresa_id: null
    });
    await run(`UPDATE empresas SET ativo = 0 WHERE id = ?`, [filial.id]);
    const beforeDisk = fs.readFileSync(
      path.join(dbDir, 'config', 'configuracoes.json'),
      'utf8'
    );

    await assert.rejects(
      () => validarPdvModeloEmpresaAntesDeSalvar({
        pdv_modelo_empresa: 'UNICA',
        pdv_empresa_id: filial.id
      }, { db }),
      (err) => err.code === 'EMPRESA_INATIVA' || err.code === 'PDV_EMPRESA_INVALIDA'
    );

    await assert.rejects(
      () => configService.saveConfigComValidacaoPdv({
        ...configService.readConfig(),
        pdv_modelo_empresa: 'UNICA',
        pdv_empresa_id: filial.id
      }, { db }),
      (err) => err.code === 'EMPRESA_INATIVA' || err.code === 'PDV_EMPRESA_INVALIDA'
    );

    const afterDisk = fs.readFileSync(
      path.join(dbDir, 'config', 'configuracoes.json'),
      'utf8'
    );
    assert.equal(afterDisk, beforeDisk);
    await run(`UPDATE empresas SET ativo = 1 WHERE id = ?`, [filial.id]);
  });

  it('A4) MULTIPLAS não exige pdv_empresa_id', async () => {
    const out = await validarPdvModeloEmpresaAntesDeSalvar({
      pdv_modelo_empresa: 'MULTIPLAS',
      pdv_empresa_id: null
    }, { db });
    assert.equal(out.ok, true);
    assert.equal(out.pdv_modelo_empresa, 'MULTIPLAS');
  });

  it('B1) POST /api/vendas UNICA: header filial → vendas.empresa_id = Matriz', async () => {
    writeConfig({
      pdv_modelo_empresa: 'UNICA',
      pdv_empresa_id: matriz.id,
      modo_operacional_global: 'MULTIEMPRESA'
    });
    caixaAtivoRef.current = caixaMatriz;
    persistCalls = 0;

    const countBefore = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const resp = await httpJson(
      server,
      'POST',
      '/api/vendas',
      { origem: 'PDV', total: 15, itens: [{ produto_id: 1, quantidade: 1, preco: 15 }] },
      { 'X-Empresa-Id': String(filial.id) }
    );

    assert.ok(resp.status < 400, `HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
    assert.equal(persistCalls, 1);
    assert.equal(Number(resp.body.empresa_id), Number(matriz.id));
    assert.equal(Number(resp.body.empresa_id_middleware), Number(matriz.id));
    assert.equal(Number(resp.body.header_empresa_id_original), Number(filial.id));
    assert.equal(
      Number(resp.body.header_empresa_id_apos_middleware),
      Number(matriz.id),
      'middleware sobrescreve X-Empresa-Id para a Matriz'
    );

    const vendaId = resp.body.venda_id;
    assert.ok(vendaId);
    const venda = await get(
      `SELECT id, empresa_id, origem FROM vendas WHERE id = ?`,
      [vendaId]
    );
    assert.ok(venda, 'venda deve existir no DB isolado');
    assert.equal(Number(venda.empresa_id), Number(matriz.id), 'INSERT usou Matriz, não o header');
    assert.equal(String(venda.origem), 'PDV');

    const countAfter = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(countAfter.n), Number(countBefore.n) + 1);
  });

  it('B2) caixa da filial com PDV UNICA Matriz rejeita antes de persistir', async () => {
    writeConfig({
      pdv_modelo_empresa: 'UNICA',
      pdv_empresa_id: matriz.id
    });
    caixaAtivoRef.current = caixaFilial;
    const countBefore = await get(`SELECT COUNT(*) AS n FROM vendas`);
    persistCalls = 0;

    const resp = await httpJson(
      server,
      'POST',
      '/api/vendas',
      { origem: 'PDV', total: 10 },
      { 'X-Empresa-Id': String(filial.id) }
    );

    assert.ok(resp.status >= 400, `deveria rejeitar: ${resp.status}`);
    assert.equal(persistCalls, 0);
    assert.equal(resp.body.venda_concluida, false);
    assert.match(
      String(resp.body.code || resp.body.error || ''),
      /CAIXA|EMPRESA|SESSAO|caixa/i
    );

    const countAfter = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(countAfter.n), Number(countBefore.n));
  });

  it('C) CDS-06: FATURAMENTO/NF_AVULSA no POST /api/vendas são rejeitados (não escapam para filial)', async () => {
    const { resolverVendaOrigin, origemPodeConcluirVenda, origemExigeCaixa, VendaOrigin } = require(
      '../../backend/services/vendas/VendaOrigin'
    );
    assert.equal(resolverVendaOrigin('FATURAMENTO'), VendaOrigin.FATURAMENTO);
    assert.equal(resolverVendaOrigin('NF_AVULSA'), VendaOrigin.NF_AVULSA);
    assert.equal(origemPodeConcluirVenda('FATURAMENTO'), true);
    assert.equal(origemPodeConcluirVenda('NF_AVULSA'), true);
    assert.equal(origemExigeCaixa('FATURAMENTO'), false);
    assert.equal(origemExigeCaixa('NF_AVULSA'), false);

    writeConfig({ pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id });
    caixaAtivoRef.current = caixaFilial;
    persistCalls = 0;

    const countBefore = await get(`SELECT COUNT(*) AS n FROM vendas`);

    for (const origem of ['FATURAMENTO', 'NF_AVULSA']) {
      persistCalls = 0;
      const resp = await httpJson(
        server,
        'POST',
        '/api/vendas',
        { origem, total: 8 },
        { 'X-Empresa-Id': String(filial.id) }
      );
      assert.equal(resp.status, 400, JSON.stringify(resp.body));
      assert.equal(resp.body.code, 'ORIGEM_NAO_PERMITIDA_NA_ROTA_VENDAS');
      assert.equal(resp.body.venda_concluida, false);
      assert.equal(persistCalls, 0);
    }

    const countAfter = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(countAfter.n), Number(countBefore.n));
  });
});
