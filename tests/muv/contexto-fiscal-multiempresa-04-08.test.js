/**
 * Sprint 04.08 — contexto fiscal por empresa + materialização fiscal.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { STATUS_ATENDIMENTO } = require('../../backend/motores/muv');
const atendimentoService = require('../../backend/motores/muv/AtendimentoMultiempresaService');
const fiscalService = require('../../backend/motores/muv/FiscalizarAtendimentoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  upsertConfiguracaoFiscalEmpresa,
  incrementaNumeroFiscalEmpresa,
  garantirSchemaFiscalEmpresaAsync
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { getFiscalConfig, incrementaNumeroFiscal } = require('../../backend/services/fiscal/configService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_C = '65957340000150';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava ${code}`);
  } catch (err) {
    if (err.message === `Esperava ${code}`) throw err;
    assert.strictEqual(err.code || err.codigo, code, err.message);
  }
}

function item(produtoId, empresaId, quantidade, valorUnitario, tipoFiscal) {
  const base = { produtoId, empresaId, quantidade, valorUnitario };
  if (tipoFiscal) base.tipoFiscal = tipoFiscal;
  return base;
}

function cfgEmpresa(tag) {
  return {
    ambiente: 2,
    uf: 'CE',
    codigo_uf: '23',
    serie: 1,
    numero_atual: tag === 'A' ? 100 : tag === 'B' ? 200 : 300,
    token_csc: `CSC-${tag}`,
    id_csc: `ID-${tag}`,
    certificado_path: `C:/certs/${tag}.pfx`,
    certificado_senha: `senha-${tag}`,
    crt: '1',
    ie: `IE${tag}`,
    ws_autorizacao: `https://sefaz.local/${tag}/auth`,
    csc_qrcode_url: `https://qr.local/${tag}`,
    consulta_chave_url: `https://consulta.local/${tag}`
  };
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT, ncm TEXT, cfop TEXT, csosn TEXT,
      saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1, estoque_atual REAL DEFAULT 0, updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT, data_venda TEXT, total REAL, desconto REAL DEFAULT 0,
      forma_pagamento TEXT, status TEXT, status_pagamento TEXT, origem TEXT,
      valor_fiscal REAL DEFAULT 0, valor_nao_fiscal REAL DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER, produto_id INTEGER, quantidade REAL,
      preco_unitario REAL, subtotal REAL,
      quantidade_fiscal REAL DEFAULT 0, quantidade_nao_fiscal REAL DEFAULT 0,
      valor_fiscal REAL DEFAULT 0, valor_nao_fiscal REAL DEFAULT 0, item_fiscal INTEGER DEFAULT 0
    )
  `);
  await run(db, `CREATE TABLE venda_pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, forma_pagamento TEXT, valor REAL)`);
  await run(db, `CREATE TABLE financeiro (id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, tipo TEXT, origem TEXT, valor REAL, status TEXT)`);
  await run(db, `
    CREATE TABLE nfce_notas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER, numero INTEGER, serie INTEGER, chave_acesso TEXT,
      ambiente INTEGER, status TEXT, empresa_id INTEGER
    )
  `);
  await run(db, `CREATE TABLE configuracoes (chave TEXT PRIMARY KEY, valor TEXT, tipo TEXT, descricao TEXT, updated_at DATETIME)`);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, ncm, cfop, csosn, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', '22021000', '5102', '102', 999, 999, 1998)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Empresa A', inscricao_estadual: 'IEA' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Empresa B', inscricao_estadual: 'IEB' }, { db });
  const c = await EmpresaService.criarEmpresa({ cnpj: CNPJ_C, razao_social: 'Empresa C', inscricao_estadual: 'IEC' }, { db });
  await upsertConfiguracaoFiscalEmpresa(a.id, cfgEmpresa('A'), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfgEmpresa('B'), db);
  await upsertConfiguracaoFiscalEmpresa(c.id, cfgEmpresa('C'), db);
  for (const emp of [a, b, c]) {
    await EstoqueEmpresaService.criarRegistro({
      produtoId: p.lastID, empresaId: emp.id, saldo_fiscal: 20, saldo_nao_fiscal: 8, estoque_atual: 28
    }, { db });
  }
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b, empresaC: c };
}

async function materializadoABC(ctx) {
  const atd = await atendimentoService.criarAtendimento({
    itens: [
      item(ctx.produtoId, ctx.empresaA.id, 1, 12, 'FISCAL'),
      item(ctx.produtoId, ctx.empresaB.id, 1, 18, 'FISCAL'),
      item(ctx.produtoId, ctx.empresaC.id, 1, 21, 'FISCAL')
    ]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos: [{ formaPagamento: 'pix', valor: 51 }]
  }, { db: ctx.db });
  return atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db });
}

function emitComConfig(ctx, mat, overrides = {}) {
  const calls = [];
  return {
    calls,
    async emitirPorVendaId(vendaId, opcoes = {}) {
      const op = mat.operacoes.find((o) => o.vendaId === vendaId);
      const config = await getFiscalConfig({ empresaId: op.empresaId, db: ctx.db, validarUrls: false });
      calls.push({ vendaId, empresaId: opcoes.empresaId, config });
      if (overrides[op.empresaId] === 'fail') {
        return { success: false, status: 'rejeitada', message: 'rejeicao' };
      }
      const numero = await incrementaNumeroFiscal({ empresaId: op.empresaId, db: ctx.db });
      const ins = await run(
        ctx.db,
        `INSERT INTO nfce_notas (venda_id, numero, serie, chave_acesso, ambiente, status, empresa_id)
         VALUES (?, ?, ?, ?, 2, 'autorizada', ?)`,
        [vendaId, numero, config.serie, `XML-${config.cnpj}-${vendaId}`, op.empresaId]
      );
      return {
        success: true,
        status: 'autorizada',
        notaId: ins.lastID,
        numero,
        chaveAcesso: `XML-${config.cnpj}-${vendaId}`,
        qrCodeUrl: config.urls.consultaQr
      };
    }
  };
}

function mockRes() {
  const state = { statusCode: null, body: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.body = payload; return payload; }
  };
}

function loadAppWithFakePagamento() {
  const pagamentoPath = require.resolve('../../backend/services/vendas/VendaPagamentoService');
  const appPath = path.resolve(__dirname, '../../backend/services/vendas/VendaApplicationService.js');
  const originalPag = require.cache[pagamentoPath];
  const originalApp = require.cache[appPath];
  let pagamentoChamado = 0;
  require.cache[pagamentoPath] = {
    id: pagamentoPath, filename: pagamentoPath, loaded: true,
    exports: { criarVenda() { pagamentoChamado += 1; return 'DELEGATED_PDV'; } }
  };
  delete require.cache[appPath];
  const app = require('../../backend/services/vendas/VendaApplicationService');
  return {
    app,
    getPagamentoChamado: () => pagamentoChamado,
    restore() {
      if (originalPag) require.cache[pagamentoPath] = originalPag;
      else delete require.cache[pagamentoPath];
      if (originalApp) require.cache[appPath] = originalApp;
      else delete require.cache[appPath];
    }
  };
}

async function test01aConfigA() {
  const ctx = await setupBase();
  const cfg = await getFiscalConfig({ empresaId: ctx.empresaA.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.fonte, 'EMPRESA');
  assert.strictEqual(cfg.cnpj, CNPJ_A);
  assert.strictEqual(cfg.tokenCSC, 'CSC-A');
  await closeDb(ctx.db);
}

async function test02bConfigB() {
  const ctx = await setupBase();
  const cfg = await getFiscalConfig({ empresaId: ctx.empresaB.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.cnpj, CNPJ_B);
  assert.strictEqual(cfg.tokenCSC, 'CSC-B');
  await closeDb(ctx.db);
}

async function test03cConfigC() {
  const ctx = await setupBase();
  const cfg = await getFiscalConfig({ empresaId: ctx.empresaC.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.cnpj, CNPJ_C);
  assert.strictEqual(cfg.certificadoPath, 'C:/certs/C.pfx');
  await closeDb(ctx.db);
}

async function test04aNaoLeB() {
  const ctx = await setupBase();
  const a = await getFiscalConfig({ empresaId: ctx.empresaA.id, db: ctx.db, validarUrls: false });
  assert.notStrictEqual(a.tokenCSC, 'CSC-B');
  assert.notStrictEqual(a.cnpj, CNPJ_B);
  await closeDb(ctx.db);
}

async function test05bNaoLeA() {
  const ctx = await setupBase();
  const b = await getFiscalConfig({ empresaId: ctx.empresaB.id, db: ctx.db, validarUrls: false });
  assert.notStrictEqual(b.certificadoPath, 'C:/certs/A.pfx');
  await closeDb(ctx.db);
}

async function test06DocA() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const a = r.documentos.find((d) => d.empresaId === ctx.empresaA.id);
  assert.ok(a.chaveAcesso.includes(CNPJ_A));
  await closeDb(ctx.db);
}

async function test07DocB() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const b = r.documentos.find((d) => d.empresaId === ctx.empresaB.id);
  assert.ok(b.chaveAcesso.includes(CNPJ_B));
  await closeDb(ctx.db);
}

async function test08EmpresaExterna() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat);
  await assertRejects(
    fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
      db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId, empresaId: ctx.empresaB.id
    }),
    'VINCULO_FISCAL_INVALIDO'
  );
  await closeDb(ctx.db);
}

async function test09VendaNaoPertence() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const opA = mat.operacoes.find((o) => o.empresaId === ctx.empresaA.id);
  const orphan = await run(
    ctx.db,
    `INSERT INTO vendas (codigo, total, status, status_pagamento, origem) VALUES ('ORFA', 1, 'concluida', 'quitada', 'PDV')`
  );
  await run(ctx.db, 'UPDATE atendimento_operacoes SET venda_id = ? WHERE id = ?', [orphan.lastID, opA.operacaoId]);
  await assertRejects(
    fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
      db: ctx.db, emitirPorVendaId() { return { success: true, status: 'autorizada' }; }
    }),
    'VINCULO_FISCAL_INVALIDO'
  );
  await closeDb(ctx.db);
}

async function test10DocEmpresaDiferente() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const opA = mat.operacoes.find((o) => o.empresaId === ctx.empresaA.id);
  await run(
    ctx.db,
    `INSERT INTO atendimento_operacao_documentos (
       atendimento_id, atendimento_operacao_id, empresa_id, venda_id, status
     ) VALUES (?, ?, ?, ?, 'PENDENTE')`,
    [mat.atendimentoId, opA.operacaoId, ctx.empresaB.id, opA.vendaId]
  );
  await assertRejects(
    fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
      db: ctx.db, emitirPorVendaId() { return { success: true, status: 'autorizada' }; }
    }),
    'VINCULO_FISCAL_INVALIDO'
  );
  await closeDb(ctx.db);
}

async function test11SeqAIndepB() {
  const ctx = await setupBase();
  const nA = await incrementaNumeroFiscalEmpresa(ctx.empresaA.id, ctx.db);
  const nB = await incrementaNumeroFiscalEmpresa(ctx.empresaB.id, ctx.db);
  assert.strictEqual(nA, 100);
  assert.strictEqual(nB, 200);
  await closeDb(ctx.db);
}

async function test12SeqBIndepC() {
  const ctx = await setupBase();
  await incrementaNumeroFiscalEmpresa(ctx.empresaB.id, ctx.db);
  const nC = await incrementaNumeroFiscalEmpresa(ctx.empresaC.id, ctx.db);
  assert.strictEqual(nC, 300);
  const rowB = await get(ctx.db, 'SELECT numero_atual FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.empresaB.id]);
  assert.strictEqual(Number(rowB.numero_atual), 201);
  const rowC = await get(ctx.db, 'SELECT numero_atual FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.empresaC.id]);
  assert.strictEqual(Number(rowC.numero_atual), 301);
  await closeDb(ctx.db);
}

async function test13RetryNaoReemite() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const n1 = emit.calls.length;
  const r2 = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(emit.calls.length, n1);
  assert.ok(r2.documentos.every((d) => d.reused));
  await closeDb(ctx.db);
}

async function test14FalhaCMantemA() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat, { [ctx.empresaC.id]: 'fail' });
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const a = r.documentos.find((d) => d.empresaId === ctx.empresaA.id);
  assert.strictEqual(a.status, 'AUTORIZADA');
  await closeDb(ctx.db);
}

async function test15Parcial() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat, { [ctx.empresaC.id]: 'fail' });
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.FISCAL_PARCIAL);
  await closeDb(ctx.db);
}

async function test16RetryPendente() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat, { [ctx.empresaC.id]: 'fail' });
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  delete emit.calls;
  emit.calls = [];
  const emit2 = emitComConfig(ctx, mat);
  const r2 = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit2.emitirPorVendaId
  });
  assert.strictEqual(emit2.calls.length, 1);
  assert.strictEqual(emit2.calls[0].empresaId, ctx.empresaC.id);
  assert.strictEqual(r2.status, STATUS_ATENDIMENTO.FISCALIZADO);
  await closeDb(ctx.db);
}

async function test17MaterializacaoFiscal() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const itens = await all(ctx.db, 'SELECT * FROM vendas_itens');
  assert.ok(itens.every((i) => Number(i.quantidade_fiscal) > 0 && Number(i.valor_fiscal) > 0));
  const vendas = await all(ctx.db, 'SELECT valor_fiscal FROM vendas');
  assert.ok(vendas.every((v) => Number(v.valor_fiscal) > 0));
  await closeDb(ctx.db);
}

async function test18FalhaAntesEmissao() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  await run(ctx.db, 'UPDATE vendas_itens SET quantidade_fiscal = 0, valor_fiscal = 0');
  let chamado = 0;
  await assertRejects(
    fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
      db: ctx.db,
      emitirPorVendaId() { chamado += 1; return { success: true, status: 'autorizada' }; }
    }),
    'DADOS_FISCAIS_INCOMPLETOS'
  );
  assert.strictEqual(chamado, 0);
  await closeDb(ctx.db);
}

async function test19EmpresaUnica() {
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const result = app.criarVenda({ body: { total: 10, itens: [] } }, mockRes(), {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA'
    });
    assert.strictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
  } finally {
    restore();
  }
}

async function test20NuncaGlobal() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const fontes = [];
  const emit = emitComConfig(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db,
    emitirPorVendaId: emit.emitirPorVendaId,
    getFiscalConfig: async (opts) => {
      const cfg = await getFiscalConfig(opts);
      fontes.push(cfg.fonte);
      return cfg;
    }
  });
  assert.ok(fontes.length > 0);
  assert.ok(fontes.every((f) => f === 'EMPRESA'));
  await closeDb(ctx.db);
}

async function test21SemEmpresa1() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/services/fiscal/empresasConfiguracaoFiscal.js'),
    'utf8'
  );
  assert.ok(!src.includes('empresa_id = 1') && !src.includes('empresaId === 1'));
}

async function test22SemFallbackOutra() {
  const ctx = await setupBase();
  await run(ctx.db, 'DELETE FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.empresaA.id]);
  await assertRejects(
    getFiscalConfig({ empresaId: ctx.empresaA.id, db: ctx.db, validarUrls: false }),
    'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE'
  );
  await closeDb(ctx.db);
}

async function test23IntegridadeAtd() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  for (const op of mat.operacoes) {
    assert.ok(op.vendaId);
    assert.ok(op.empresaId);
  }
  await closeDb(ctx.db);
}

async function test24IntegridadeDoc() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  for (const d of r.documentos) {
    const op = mat.operacoes.find((o) => o.operacaoId === d.operacaoId);
    assert.strictEqual(d.empresaId, op.empresaId);
    assert.strictEqual(d.vendaId, op.vendaId);
  }
  await closeDb(ctx.db);
}

async function test25XmlOperacao() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const notas = await all(ctx.db, 'SELECT * FROM nfce_notas');
  for (const n of notas) {
    const op = mat.operacoes.find((o) => o.vendaId === n.venda_id);
    assert.strictEqual(n.empresa_id, op.empresaId);
    assert.ok(String(n.chave_acesso).includes(op.empresaId === ctx.empresaA.id ? CNPJ_A : op.empresaId === ctx.empresaB.id ? CNPJ_B : CNPJ_C));
  }
  await closeDb(ctx.db);
}

async function test26ErroLocal() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitComConfig(ctx, mat);
  await assertRejects(
    fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
      db: ctx.db,
      emitirPorVendaId: emit.emitirPorVendaId,
      aposFiscalizarOperacao() {
        const err = new Error('falha local');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const docs = await all(ctx.db, 'SELECT * FROM atendimento_operacao_documentos');
  assert.ok(docs.length >= 1);
  await closeDb(ctx.db);
}

async function test27IncrementoGlobalIntacto() {
  const ctx = await setupBase();
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor, tipo) VALUES ('fiscal_numero_atual', '7', 'number')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor, tipo) VALUES ('fiscal_serie', '1', 'number')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor, tipo) VALUES ('fiscal_ambiente', '2', 'number')`);
  const n = await incrementaNumeroFiscal({ db: ctx.db });
  assert.strictEqual(n, 7);
  const cfgA = await get(ctx.db, 'SELECT numero_atual FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.empresaA.id]);
  assert.strictEqual(Number(cfgA.numero_atual), 100);
  await closeDb(ctx.db);
}

async function test28FonteGlobalSemEmpresa() {
  const ctx = await setupBase();
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ambiente', '2')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('nome_empresa', 'Legado')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('cnpj', '00000000000000')`);
  const cfg = await getFiscalConfig({ db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.fonte, 'GLOBAL');
  assert.strictEqual(cfg.empresaId, null);
  await closeDb(ctx.db);
}

async function test29SchemaGarantido() {
  const ctx = await setupBase();
  await garantirSchemaFiscalEmpresaAsync(ctx.db);
  const row = await get(ctx.db, `SELECT name FROM sqlite_master WHERE name = 'empresas_configuracao_fiscal'`);
  assert.ok(row);
  await closeDb(ctx.db);
}

async function test30EmissorAceitaDoisArgs() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/services/fiscal/emissor.js'),
    'utf8'
  );
  assert.ok(src.includes('async function emitirPorVendaId(vendaId, opcoes'));
}

async function main() {
  const testes = [
    ['01 config A', test01aConfigA],
    ['02 config B', test02bConfigB],
    ['03 config C', test03cConfigC],
    ['04 A não lê B', test04aNaoLeB],
    ['05 B não lê A', test05bNaoLeA],
    ['06 documento A', test06DocA],
    ['07 documento B', test07DocB],
    ['08 empresaId externo rejeitado', test08EmpresaExterna],
    ['09 venda não pertence', test09VendaNaoPertence],
    ['10 documento empresa divergente', test10DocEmpresaDiferente],
    ['11 sequência A independente B', test11SeqAIndepB],
    ['12 sequência B independente C', test12SeqBIndepC],
    ['13 retry não reemite', test13RetryNaoReemite],
    ['14 falha C mantém A', test14FalhaCMantemA],
    ['15 FISCAL_PARCIAL', test15Parcial],
    ['16 retry só pendente', test16RetryPendente],
    ['17 venda com dados fiscais', test17MaterializacaoFiscal],
    ['18 bloqueia antes da emissão', test18FalhaAntesEmissao],
    ['19 EMPRESA_UNICA compatível', test19EmpresaUnica],
    ['20 MULTIEMPRESA sem config global', test20NuncaGlobal],
    ['21 sem fallback empresa 1', test21SemEmpresa1],
    ['22 sem fallback de outra empresa', test22SemFallbackOutra],
    ['23 integridade atendimento/operação/venda', test23IntegridadeAtd],
    ['24 integridade operação/documento', test24IntegridadeDoc],
    ['25 XML da operação correta', test25XmlOperacao],
    ['26 erro local preserva vínculo', test26ErroLocal],
    ['27 numeração global intacta', test27IncrementoGlobalIntacto],
    ['28 getFiscalConfig legado GLOBAL', test28FonteGlobalSemEmpresa],
    ['29 schema fiscal empresa', test29SchemaGarantido],
    ['30 overload emitirPorVendaId', test30EmissorAceitaDoisArgs]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\ncontexto-fiscal-multiempresa-04-08: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
