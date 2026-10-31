/**
 * CDS-PDV-EMPRESA-UNICA-06 — confiança na origem do POST /api/vendas.
 * Executar: node --test tests/pdv/cds-pdv-empresa-unica-06.test.js
 * Isolamento: DB_DIR temporário. Sem banco oficial / SEFAZ / TEF / venda real.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { describe, it, before, after } = require('node:test');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pdv-empresa-unica-06-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const db = require('../../backend/database');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const {
  aplicarModeloEmpresaPdvNaRequisicao,
  middlewareAplicarPdvModeloEmpresa,
  PDV_MODELO_UNICA,
  PDV_MODELO_MULTIPLAS
} = require('../../backend/services/pdv/PdvModeloEmpresaService');
const {
  exigirEmpresaDaOperacao,
  exigirCaixaCompativelComVenda
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
const { VendaOrigin } = require('../../backend/services/vendas/VendaOrigin');
const { criarVendaContext } = require('../../backend/services/vendas/VendaContext');

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
let sefazCalls = 0;
let tefCalls = 0;

async function abrirCaixa(empresaId) {
  let terminal = await get(`SELECT id FROM terminais ORDER BY id LIMIT 1`);
  if (!terminal) {
    const cols = await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(terminais)`, [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    const nomes = new Set(cols.map((c) => c.name));
    if (nomes.has('nome') && nomes.has('hostname')) {
      const ins = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-U06', 'u06-host')`);
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

function criarAppHttp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.user = { id: 1, perfil: 'ADMIN', nome: 'u06' };
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

  const aplicarPdv = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });

  app.post('/api/vendas', aplicarPdv, async (req, res) => {
    try {
      assert.equal(req.canalVendaHttp, 'PDV');
      const empresaIdVenda = exigirEmpresaDaOperacao(req);
      exigirCaixaCompativelComVenda(req, empresaIdVenda);
      req.empresaIdVenda = empresaIdVenda;

      persistCalls += 1;
      const codigo = `U06-${Date.now()}`;
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
        header_empresa_id_original: req.headerEmpresaIdOriginal,
        pdv_modelo: req.pdvModeloEmpresa || null,
        sefaz_calls: sefazCalls,
        tef_calls: tefCalls
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

describe('CDS-PDV-EMPRESA-UNICA-06', { concurrency: false }, () => {
  before(async () => {
    writeConfig({});
    await whenReady();
    assert.ok(String(db.dbPath || '').startsWith(dbDir), `dbPath fora do isolamento: ${db.dbPath}`);

    matriz = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz U06' },
      { db }
    );
    filial = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_FILIAL, razao_social: 'Filial U06' },
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

  it('1) UNICA + Matriz + header filial + origem PDV → usa Matriz', async () => {
    writeConfig({ pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id });
    caixaAtivoRef.current = caixaMatriz;
    persistCalls = 0;

    const resp = await httpJson(
      server,
      'POST',
      '/api/vendas',
      { origem: 'PDV', total: 12 },
      { 'X-Empresa-Id': String(filial.id) }
    );
    assert.equal(resp.status, 201, JSON.stringify(resp.body));
    assert.equal(Number(resp.body.empresa_id), Number(matriz.id));
    assert.equal(Number(resp.body.header_empresa_id_original), Number(filial.id));
    assert.equal(resp.body.pdv_modelo.aplicada, true);

    const venda = await get(`SELECT empresa_id FROM vendas WHERE id = ?`, [resp.body.venda_id]);
    assert.equal(Number(venda.empresa_id), Number(matriz.id));
  });

  it('2) UNICA + origem FATURAMENTO na rota genérica → rejeitada; sem escapar para filial', async () => {
    writeConfig({ pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id });
    caixaAtivoRef.current = caixaFilial;
    persistCalls = 0;
    const before = await get(`SELECT COUNT(*) AS n FROM vendas`);

    const resp = await httpJson(
      server,
      'POST',
      '/api/vendas',
      { origem: 'FATURAMENTO', total: 9 },
      { 'X-Empresa-Id': String(filial.id) }
    );
    assert.equal(resp.status, 400, JSON.stringify(resp.body));
    assert.equal(resp.body.code, 'ORIGEM_NAO_PERMITIDA_NA_ROTA_VENDAS');
    assert.equal(resp.body.venda_concluida, false);
    assert.equal(persistCalls, 0);
    const after = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(after.n), Number(before.n));
  });

  it('3) UNICA + origem NF_AVULSA na rota genérica → mesma proteção', async () => {
    writeConfig({ pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id });
    caixaAtivoRef.current = caixaFilial;
    persistCalls = 0;
    const before = await get(`SELECT COUNT(*) AS n FROM vendas`);

    const resp = await httpJson(
      server,
      'POST',
      '/api/vendas',
      { origem: 'NF_AVULSA', total: 9 },
      { 'X-Empresa-Id': String(filial.id) }
    );
    assert.equal(resp.status, 400, JSON.stringify(resp.body));
    assert.equal(resp.body.code, 'ORIGEM_NAO_PERMITIDA_NA_ROTA_VENDAS');
    assert.equal(persistCalls, 0);
    const after = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(after.n), Number(before.n));
  });

  it('4) Caixa de outra empresa → rejeição sem persistência', async () => {
    writeConfig({ pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id });
    caixaAtivoRef.current = caixaFilial;
    persistCalls = 0;
    const before = await get(`SELECT COUNT(*) AS n FROM vendas`);

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
    const after = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(after.n), Number(before.n));
  });

  it('5) MULTIPLAS preserva seleção via header (sem forçar Matriz)', async () => {
    writeConfig({ pdv_modelo_empresa: 'MULTIPLAS', pdv_empresa_id: null });
    caixaAtivoRef.current = caixaFilial;
    persistCalls = 0;

    const resp = await httpJson(
      server,
      'POST',
      '/api/vendas',
      { origem: 'PDV', total: 7 },
      { 'X-Empresa-Id': String(filial.id) }
    );
    assert.equal(resp.status, 201, JSON.stringify(resp.body));
    assert.equal(Number(resp.body.empresa_id), Number(filial.id));
    assert.equal(resp.body.pdv_modelo.aplicada, false);
    assert.equal(resp.body.pdv_modelo.motivo, 'PDV_MULTIPLAS');
  });

  it('6) Faturamento legítimo: override servidor + rota própria intactos; sem canalHttp', async () => {
    const fatSrc = fs.readFileSync(
      path.join(__dirname, '../../backend/services/faturamento/FaturamentoService.js'),
      'utf8'
    );
    const fatRota = fs.readFileSync(
      path.join(__dirname, '../../backend/rotas/faturamento.js'),
      'utf8'
    );
    assert.match(fatRota, /pedidos\/:id\/faturar/);
    assert.match(fatSrc, /origem:\s*VendaOrigin\.FATURAMENTO/);
    assert.match(fatSrc, /criarVendaContext\(reqHttp,\s*\{\s*origem:\s*VendaOrigin\.FATURAMENTO/);

    const ctx = criarVendaContext({ body: { origem: 'PDV' } }, { origem: VendaOrigin.FATURAMENTO });
    assert.equal(ctx.origem, VendaOrigin.FATURAMENTO);

    // Sem canalHttp: origem FATURAMENTO continua ignorando UNICA (contrato interno).
    writeConfig({ pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id });
    const req = { body: { origem: 'FATURAMENTO' }, empresaId: filial.id };
    const out = await aplicarModeloEmpresaPdvNaRequisicao(req, {
      db,
      cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id }
    });
    assert.equal(out.aplicada, false);
    assert.equal(out.motivo, 'ORIGEM_NAO_PDV');
    assert.equal(Number(req.empresaId), Number(filial.id));
  });

  it('7) NF avulsa legítima: override servidor + rota própria intactos', async () => {
    const nfeSrc = fs.readFileSync(
      path.join(__dirname, '../../backend/services/fiscal/nfeAvulsaService.js'),
      'utf8'
    );
    const nfeRota = fs.readFileSync(
      path.join(__dirname, '../../backend/rotas/nfe.js'),
      'utf8'
    );
    assert.match(nfeRota, /router\.post\('\/avulsa'/);
    assert.match(nfeSrc, /criarVendaContext\(reqHttp,\s*\{\s*origem:\s*VendaOrigin\.NF_AVULSA/);

    const ctx = criarVendaContext({}, { origem: VendaOrigin.NF_AVULSA });
    assert.equal(ctx.origem, VendaOrigin.NF_AVULSA);

    writeConfig({ pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id });
    const req = { body: { origem: 'NF_AVULSA' }, empresaId: filial.id };
    const out = await aplicarModeloEmpresaPdvNaRequisicao(req, {
      db,
      cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id }
    });
    assert.equal(out.aplicada, false);
    assert.equal(out.motivo, 'ORIGEM_NAO_PDV');
  });

  it('8) Configuração inválida (UNICA sem empresa) → nenhuma venda parcial', async () => {
    writeConfig({ pdv_modelo_empresa: 'UNICA', pdv_empresa_id: null });
    caixaAtivoRef.current = caixaMatriz;
    persistCalls = 0;
    const before = await get(`SELECT COUNT(*) AS n FROM vendas`);

    const resp = await httpJson(
      server,
      'POST',
      '/api/vendas',
      { origem: 'PDV', total: 5 },
      { 'X-Empresa-Id': String(matriz.id) }
    );
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    assert.match(String(resp.body.code || ''), /PDV_EMPRESA/);
    assert.equal(resp.body.venda_concluida, false);
    assert.equal(persistCalls, 0);
    const after = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(after.n), Number(before.n));
  });

  it('9) Sem SEFAZ/TEF/integração externa neste harness', () => {
    assert.equal(sefazCalls, 0);
    assert.equal(tefCalls, 0);
    // Limitação: harness não invoca núcleo fiscal; apenas INSERT isolado.
  });

  it('rota real monta middleware com canalHttpVendas', () => {
    const vendasRota = fs.readFileSync(
      path.join(__dirname, '../../backend/rotas/vendas.js'),
      'utf8'
    );
    assert.match(vendasRota, /canalHttpVendas:\s*true/);
    assert.match(vendasRota, /aplicarPdvModeloEmpresa,\s*validarCaixaSeOrigemPdv,\s*criarVenda/);
  });
});
