/**
 * SPRINT CDS-ESTOQUE-CONTAGEM-CONVERSAO-UNIDADES-F12-05.2
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/estoque/contagem-fisica-conversao-unidades-f12-05-2.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-contagem-conv-05-2-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  converterQuantidadeContagem
} = require('../../backend/services/estoque/EstoqueContagemConversaoService');
const {
  buscarProdutosParaContagem
} = require('../../backend/services/estoque/EstoqueContagemProdutoBuscaService');
const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const { exigirSnapshotItensOficiais } = require('../../backend/services/estoque/contagemFisicaSnapshotOficial');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaEstoqueContagemFisicaAsync } = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const {
  garantirSchemaEstoqueContagemPeriodicidadeAsync
} = require('../../backend/services/estoque/estoqueContagemPeriodicidadeSchema');
const {
  garantirSchemaProdutoConversaoAsync
} = require('../../backend/services/produtos/produtoConversaoSchema');
const ProdutoConversaoConfigService = require('../../backend/services/produtos/ProdutoConversaoConfigService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  salvarPeriodicidade,
  obterStatusPeriodicidade
} = require('../../backend/services/estoque/EstoqueContagemPeriodicidadeService');
const EmpresaModoEstoqueService = require('../../backend/services/empresas/EmpresaModoEstoqueService');
const {
  garantirSchemaEmpresasConfiguracaoEstoqueAsync
} = require('../../backend/services/empresas/empresasConfiguracaoEstoqueSchema');

const CNPJ_A = '11222333000181';
const ROOT = path.resolve(__dirname, '../..');
const UI = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/contagem-estoque.js'), 'utf8');
const SVC = fs.readFileSync(
  path.join(ROOT, 'backend/services/estoque/EstoqueContagemConversaoService.js'),
  'utf8'
);
const FISICA = fs.readFileSync(
  path.join(ROOT, 'backend/services/estoque/EstoqueContagemFisicaService.js'),
  'utf8'
);

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

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await garantirSchemaEstoqueContagemPeriodicidadeAsync(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      nome_busca TEXT,
      codigo TEXT,
      codigo_barras TEXT,
      unidade TEXT DEFAULT 'UN',
      unidade_comercial TEXT DEFAULT 'UN',
      unidade_estoque TEXT,
      utiliza_conversao INTEGER DEFAULT 0,
      utiliza_volume INTEGER DEFAULT 0,
      volume_valor REAL,
      volume_unidade TEXT,
      tipo_operacional TEXT DEFAULT 'COMERCIAL',
      ativo INTEGER DEFAULT 1,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await garantirSchemaProdutoConversaoAsync(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produto_embalagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'UN',
      descricao TEXT,
      quantidade REAL NOT NULL,
      unidade TEXT NOT NULL,
      gtin TEXT,
      principal INTEGER DEFAULT 0,
      compra INTEGER DEFAULT 1,
      venda INTEGER DEFAULT 1,
      estoque INTEGER DEFAULT 0,
      ativa INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      motivo TEXT,
      ajuste_fiscal REAL,
      ajuste_nao_fiscal REAL,
      saldo_fiscal_antes REAL,
      saldo_fiscal_depois REAL,
      saldo_nao_fiscal_antes REAL,
      saldo_nao_fiscal_depois REAL,
      estoque_total_antes REAL,
      estoque_total_depois REAL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const empresa = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  return { db, empresa };
}

async function criarProdutoConvertivel(db, {
  nome, codigo, codigo_barras, fatorMl, unidadeBase = 'ML'
}) {
  const r = await run(
    db,
    `INSERT INTO produtos (
      nome, nome_busca, codigo, codigo_barras, unidade, unidade_comercial,
      unidade_estoque, utiliza_conversao, ativo
    ) VALUES (?, ?, ?, ?, 'UN', 'UN', ?, 1, 1)`,
    [nome, nome.toLowerCase(), codigo, codigo_barras || null, unidadeBase]
  );
  const id = r.lastID;
  await run(
    db,
    `INSERT INTO produto_embalagens
      (produto_id, tipo, quantidade, unidade, principal, venda, compra, estoque, ativa)
     VALUES (?, 'UN', ?, ?, 1, 1, 1, 1, 1)`,
    [id, fatorMl, unidadeBase]
  );
  await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
    utiliza_conversao: 1,
    unidade_estoque: unidadeBase,
    apresentacoes: [{
      tipo: 'UN',
      quantidade: fatorMl,
      unidade: unidadeBase,
      principal: 1,
      venda: 1,
      compra: 1,
      ativa: 1
    }],
    relacoes: [{ unidade_origem: unidadeBase === 'ML' ? 'L' : 'KG', unidade_destino: unidadeBase, fator: unidadeBase === 'ML' ? 1000 : 1000 }]
  }).catch(async () => {
    // Relação SI opcional; apresentação UN→ML já basta via montarRelacoesMuc.
    await run(
      db,
      `UPDATE produtos SET utiliza_conversao = 1, unidade_estoque = ?, unidade = ? WHERE id = ?`,
      [unidadeBase, unidadeBase, id]
    );
  });
  // Garante relação direta UN → ML no MUC (conteúdo da apresentação).
  await run(
    db,
    `INSERT OR IGNORE INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator)
     VALUES (?, 'UN', ?, ?)`,
    [id, unidadeBase, fatorMl]
  );
  return id;
}

async function saldo(db, empresaId, produtoId, f, nf) {
  // Dual-write: porta pública ainda valida/atualiza produtos.saldo_* além de estoque_empresa.
  await run(
    db,
    `UPDATE produtos
        SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?
      WHERE id = ?`,
    [f, nf, f + nf, produtoId]
  );
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: f,
    saldo_nao_fiscal: nf,
    estoque_atual: f + nf
  }, { db });
}

describe('CDS-ESTOQUE-CONTAGEM-CONVERSAO-UNIDADES-F12-05.2', { concurrency: false }, () => {
  it('01 Coca-Cola 1,5 L: 10 UN → 15.000 ml', async () => {
    const { db } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca-Cola 1,5 L',
      codigo: 'COCA15',
      fatorMl: 1500
    });
    const out = await converterQuantidadeContagem(db, id, 10);
    assert.equal(out.quantidade_convertida, 15000);
    assert.equal(out.unidade_base, 'ML');
    assert.equal(out.quantidade_informada, 10);
    await closeDb(db);
  });

  it('02 Coca-Cola 2 L: 8 UN → 16.000 ml', async () => {
    const { db } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca-Cola 2 L',
      codigo: 'COCA20',
      fatorMl: 2000
    });
    const out = await converterQuantidadeContagem(db, id, 8);
    assert.equal(out.quantidade_convertida, 16000);
    await closeDb(db);
  });

  it('03 Água 500 ml: 20 UN → 10.000 ml', async () => {
    const { db } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Água 500 ml',
      codigo: 'AGUA500',
      fatorMl: 500
    });
    const out = await converterQuantidadeContagem(db, id, 20);
    assert.equal(out.quantidade_convertida, 10000);
    await closeDb(db);
  });

  it('04 unidade comercial igual à unidade-base', async () => {
    const { db } = await setup();
    const r = await run(
      db,
      `INSERT INTO produtos (nome, codigo, unidade, unidade_comercial, utiliza_conversao, ativo)
       VALUES ('Produto UN', 'PUN', 'UN', 'UN', 0, 1)`
    );
    const out = await converterQuantidadeContagem(db, r.lastID, 12);
    assert.equal(out.quantidade_convertida, 12);
    assert.equal(out.fator_total, 1);
    await closeDb(db);
  });

  it('05 apresentação alternativa (fator próprio)', async () => {
    const { db } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Refri Dual',
      codigo: 'REFDUAL',
      fatorMl: 1500
    });
    await run(
      db,
      `INSERT INTO produto_embalagens
        (produto_id, tipo, quantidade, unidade, principal, venda, compra, estoque, ativa)
       VALUES (?, 'UN', 350, 'ML', 0, 1, 1, 0, 1)`,
      [id]
    );
    const aps = await get(
      db,
      `SELECT id FROM produto_embalagens WHERE produto_id = ? AND quantidade = 350`,
      [id]
    );
    const out = await converterQuantidadeContagem(db, id, 10, { apresentacaoId: aps.id });
    assert.equal(out.quantidade_convertida, 3500);
    await closeDb(db);
  });

  it('06 conversão fiscal independente', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca Fiscal',
      codigo: 'CFIS',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 24000, 7500);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 5,
      modo_fiscal: '0'
    });
    assert.equal(preview.quantidade_fiscal_contada, 15000);
    assert.equal(preview.diferenca_fiscal, 15000 - 24000);
    await closeDb(db);
  });

  it('07 conversão não fiscal independente', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca NF',
      codigo: 'CNF',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 24000, 7500);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 5,
      modo_fiscal: '0'
    });
    assert.equal(preview.quantidade_nao_fiscal_contada, 7500);
    assert.equal(preview.diferenca_nao_fiscal, 0);
    await closeDb(db);
  });

  it('08 diferença somente em unidade-base', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca Diff',
      codigo: 'CDIFF',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.quantidade_fiscal_contada, 15000);
    assert.equal(preview.diferenca_fiscal, -9000);
    assert.match(String(preview.mensagem_conversao_fiscal || ''), /15\.?000|15000/);
    await closeDb(db);
  });

  it('09 produto sem fator confiável é rejeitado', async () => {
    const { db } = await setup();
    const r = await run(
      db,
      `INSERT INTO produtos (nome, codigo, unidade, unidade_estoque, utiliza_conversao, ativo)
       VALUES ('Sem Fator', 'SF1', 'UN', 'ML', 1, 1)`
    );
    await assert.rejects(
      () => converterQuantidadeContagem(db, r.lastID, 10),
      (err) => err && /CONVERSAO_PRODUTO_INCOMPLETA|CONVERSAO/.test(err.code)
    );
    await closeDb(db);
  });

  it('10 conversão decimal respeita precisão', async () => {
    const { db } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Item Decimal',
      codigo: 'DEC1',
      fatorMl: 1.5
    });
    const out = await converterQuantidadeContagem(db, id, 2);
    assert.equal(out.quantidade_convertida, 3);
    await closeDb(db);
  });

  it('11 F12 OFF exibe campo não fiscal', () => {
    assert.match(UI, /cef-wrap-qnf/);
    assert.match(UI, /Qtd não fiscal contada/);
    assert.match(UI, /F12 OFF/);
  });

  it('12 F12 OFF permite converter F e NF', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca OFF',
      codigo: 'COFF',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 0, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 5,
      modo_fiscal: '0'
    });
    assert.equal(preview.omitir_nao_fiscal, false);
    assert.equal(preview.quantidade_fiscal_contada, 15000);
    assert.equal(preview.quantidade_nao_fiscal_contada, 7500);
    await closeDb(db);
  });

  it('13 F12 ON oculta campo não fiscal', () => {
    assert.match(UI, /f12On[\s\S]{0,80}d-none|cef-wrap-qnf.*d-none/);
    assert.match(UI, /F12 ON — somente quantidade fiscal/);
  });

  it('14 F12 ON não interpreta campo ausente como zero', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca ON',
      codigo: 'CON',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 1000, 5000);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      modo_fiscal: '1'
    });
    assert.equal(preview.omitir_nao_fiscal, true);
    assert.equal(preview.quantidade_nao_fiscal_contada, null);
    assert.equal(preview.diferenca_nao_fiscal, null);
    await closeDb(db);
  });

  it('15 F12 ON preserva saldo não fiscal', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca Preserva',
      codigo: 'CPRES',
      fatorMl: 1500
    });
    // Parte de 0 fiscal para evitar débito legado em produtos.*; NF permanece intocado.
    await saldo(db, empresa.id, id, 0, 9000);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      modo_fiscal: '1'
    });
    assert.equal(preview.saldo_nao_fiscal_esperado, 9000);
    const conf = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      modo_fiscal: '1',
      chaveIdempotencia: 'f12-preserva',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 10,
        omitir_nao_fiscal: true,
        modo_fiscal: '1',
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    const depois = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: id,
      empresaId: empresa.id,
      db
    });
    assert.equal(Number(depois.saldoNaoFiscal), 9000);
    assert.equal(Number(depois.saldoFiscal), 15000);
    assert.ok(conf.id > 0);
    assert.equal(Number(conf.itens[0].diferenca_nao_fiscal), 0);
    await closeDb(db);
  });

  it('16 F12 ON não gera ajuste não fiscal', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca Sem Adj NF',
      codigo: 'CSANF',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 1000, 777);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 2,
      modo_fiscal: '1'
    });
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      modo_fiscal: '1',
      chaveIdempotencia: 'f12-sem-nf',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 2,
        omitir_nao_fiscal: true,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    const adj = await get(
      db,
      `SELECT ajuste_nao_fiscal FROM produtos_ajustes_estoque WHERE produto_id = ? ORDER BY id DESC LIMIT 1`,
      [id]
    );
    assert.ok(adj);
    assert.equal(Number(adj.ajuste_nao_fiscal), 0);
    await closeDb(db);
  });

  it('17 alteração F12 exige atualização de contexto', () => {
    assert.match(UI, /modoFiscalMudou/);
    assert.match(UI, /Atualizar contexto F12/);
    assert.match(UI, /estado F12 mudou/i);
  });

  it('18 F12 OFF preserva separação F×NF', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca Sep',
      codigo: 'CSEP',
      fatorMl: 1000
    });
    await saldo(db, empresa.id, id, 0, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 3,
      quantidade_nao_fiscal_informada: 1,
      modo_fiscal: '0'
    });
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      modo_fiscal: '0',
      chaveIdempotencia: 'fxnf-18',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 3,
        quantidade_nao_fiscal_informada: 1,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    const depois = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: id,
      empresaId: empresa.id,
      db
    });
    assert.equal(Number(depois.saldoFiscal), 3000);
    assert.equal(Number(depois.saldoNaoFiscal), 1000);
    await closeDb(db);
  });

  it('19 snapshot continua sendo enviado', () => {
    assert.match(UI, /saldo_fiscal_esperado/);
    assert.match(UI, /saldo_nao_fiscal_esperado/);
    assert.match(FISICA, /saldo_fiscal_esperado/);
  });

  it('20 snapshot desatualizado → CONTAGEM_DESATUALIZADA', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca Snap',
      codigo: 'CSNAP',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 15000, 0);
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresa.id,
        chaveIdempotencia: 'snap-20',
        itens: exigirSnapshotItensOficiais([{
          produto_id: id,
          quantidade_fiscal_informada: 10,
          quantidade_nao_fiscal_informada: 0,
          saldo_fiscal_esperado: 999,
          saldo_nao_fiscal_esperado: 0
        }])
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    await closeDb(db);
  });

  it('21 idempotência continua funcionando', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca Idem',
      codigo: 'CIDEM',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 15000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 0
    });
    const a = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      chaveIdempotencia: 'idem-21',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 10,
        quantidade_nao_fiscal_informada: 0,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    const b = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      chaveIdempotencia: 'idem-21',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 10,
        quantidade_nao_fiscal_informada: 0,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    assert.equal(a.id, b.id);
    await closeDb(db);
  });

  it('22 histórico continua íntegro', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, {
      nome: 'Coca Hist',
      codigo: 'CHIST',
      fatorMl: 1500
    });
    await saldo(db, empresa.id, id, 0, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 1,
      quantidade_nao_fiscal_informada: 0
    });
    const out = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      chaveIdempotencia: 'hist-22',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 1,
        quantidade_nao_fiscal_informada: 0,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    assert.equal(out.itens[0].quantidade_fiscal_contada, 1500);
    await closeDb(db);
  });

  it('23 busca por nome continua funcionando', async () => {
    const { db } = await setup();
    await criarProdutoConvertivel(db, { nome: 'Coca Nome', codigo: 'CNOME', fatorMl: 1500 });
    const out = await buscarProdutosParaContagem(db, 'Coca Nome');
    assert.ok(out.itens.some((p) => p.nome === 'Coca Nome'));
    await closeDb(db);
  });

  it('24 busca por código de barras', async () => {
    const { db } = await setup();
    await criarProdutoConvertivel(db, {
      nome: 'Coca Barras',
      codigo: 'CBAR',
      codigo_barras: '7891000111111',
      fatorMl: 1500
    });
    const out = await buscarProdutosParaContagem(db, '7891000111111');
    assert.equal(out.itens[0].codigo_barras, '7891000111111');
    await closeDb(db);
  });

  it('25 busca por código interno', async () => {
    const { db } = await setup();
    await criarProdutoConvertivel(db, { nome: 'Coca Cod', codigo: 'CCOD99', fatorMl: 1500 });
    const out = await buscarProdutosParaContagem(db, 'CCOD99');
    assert.ok(out.itens.some((p) => p.codigo === 'CCOD99'));
    await closeDb(db);
  });

  it('26 pesquisa não movimenta estoque', async () => {
    const { db, empresa } = await setup();
    const id = await criarProdutoConvertivel(db, { nome: 'Coca Estavel', codigo: 'CEST', fatorMl: 1500 });
    await saldo(db, empresa.id, id, 100, 50);
    await buscarProdutosParaContagem(db, 'Coca Estavel');
    const depois = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: id,
      empresaId: empresa.id,
      db
    });
    assert.equal(Number(depois.saldoFiscal), 100);
    assert.equal(Number(depois.saldoNaoFiscal), 50);
    await closeDb(db);
  });

  it('27 modo MANUAL continua sem alteração estrutural', async () => {
    const { db, empresa } = await setup();
    await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'MANUAL');
    const modo = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(db, empresa.id);
    assert.equal(modo.modo, 'MANUAL');
    await closeDb(db);
  });

  it('28 modo AUTOMATICO não sofre alteração', async () => {
    const { db, empresa } = await setup();
    await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'AUTOMATICO');
    const modo = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(db, empresa.id);
    assert.equal(modo.modo, 'AUTOMATICO');
    await closeDb(db);
  });

  it('29 periodicidade continua funcionando', async () => {
    const { db, empresa } = await setup();
    await salvarPeriodicidade(db, empresa.id, { periodicidade: 'SEMANAL' });
    const st = await obterStatusPeriodicidade(db, empresa.id);
    assert.equal(st.configuracao.periodicidade, 'SEMANAL');
    await closeDb(db);
  });

  it('30 alerta da Central continua na UI', () => {
    assert.match(UI, /pendencias-entrada|cef-alerta-pendencias/);
  });

  it('fonte: conversão reutiliza MUC oficial', () => {
    assert.match(SVC, /obterMuc\(db\)\.converterQuantidade/);
    assert.match(SVC, /ProdutoConversaoConfigService/);
    assert.match(SVC, /montarRelacoesMuc/);
    assert.doesNotMatch(SVC, /motorConversaoUnidades|MotorUnidadesMedida/);
  });
});
