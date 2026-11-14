/**
 * SPRINT CDS-ESTOQUE-CONTAGEM-REDESIGN-PREVIEW-05.3
 *
 * Banco em memória. Não abre o banco oficial.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/estoque/contagem-fisica-preview-tempo-real-05-3.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-contagem-preview-05-3-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const {
  buscarProdutosParaContagem
} = require('../../backend/services/estoque/EstoqueContagemProdutoBuscaService');
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
  listarHistoricoContagens
} = require('../../backend/services/estoque/EstoqueContagemPeriodicidadeService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const ROOT = path.resolve(__dirname, '../..');
const UI = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/contagem-estoque.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'frontend/css/contagem-fisica.css'), 'utf8');
const ROTAS = fs.readFileSync(path.join(ROOT, 'backend/rotas/estoque.js'), 'utf8');
const FISICA = fs.readFileSync(
  path.join(ROOT, 'backend/services/estoque/EstoqueContagemFisicaService.js'),
  'utf8'
);
const INDEX = fs.readFileSync(path.join(ROOT, 'frontend/erp/index.html'), 'utf8');

require('../../frontend/erp/js/contagem-estoque.js');
const ui = globalThis.__cdsContagemEstoqueTest;

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
  const empresa = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_A, razao_social: 'Matriz' },
    { db }
  );
  const empresaB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_B, razao_social: 'Outra' },
    { db }
  );
  return { db, empresa, empresaB };
}

async function criarCoca(db, extras = {}) {
  const nome = extras.nome || 'Coca-Cola 1,5 L';
  const codigo = extras.codigo || '64896';
  const fatorMl = extras.fatorMl || 1500;
  const r = await run(
    db,
    `INSERT INTO produtos (
      nome, nome_busca, codigo, codigo_barras, unidade, unidade_comercial,
      unidade_estoque, utiliza_conversao, ativo
    ) VALUES (?, ?, ?, ?, 'UN', 'UN', 'ML', 1, 1)`,
    [nome, nome.toLowerCase(), codigo, extras.codigo_barras || null]
  );
  const id = r.lastID;
  await run(
    db,
    `INSERT INTO produto_embalagens
      (produto_id, tipo, quantidade, unidade, principal, venda, compra, estoque, ativa)
     VALUES (?, 'UN', ?, 'ML', 1, 1, 1, 1, 1)`,
    [id, fatorMl]
  );
  await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
    utiliza_conversao: 1,
    unidade_estoque: 'ML',
    apresentacoes: [{
      tipo: 'UN',
      quantidade: fatorMl,
      unidade: 'ML',
      principal: 1,
      venda: 1,
      compra: 1,
      ativa: 1
    }],
    relacoes: [{ unidade_origem: 'L', unidade_destino: 'ML', fator: 1000 }]
  }).catch(async () => {
    await run(
      db,
      `UPDATE produtos SET utiliza_conversao = 1, unidade_estoque = 'ML', unidade = 'ML' WHERE id = ?`,
      [id]
    );
  });
  await run(
    db,
    `INSERT OR IGNORE INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator)
     VALUES (?, 'UN', 'ML', ?)`,
    [id, fatorMl]
  );
  return id;
}

async function saldo(db, empresaId, produtoId, f, nf) {
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

async function contagens(db) {
  const row = await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas');
  return Number(row && row.n || 0);
}

async function ajustes(db) {
  const row = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque');
  return Number(row && row.n || 0);
}

async function saldoEmpresa(db, empresaId, produtoId) {
  return EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
}

function extrair(src, inicio, fim) {
  const i = src.indexOf(inicio);
  const j = src.indexOf(fim, i + inicio.length);
  assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + inicio);
  return src.slice(i, j);
}

describe('CDS-ESTOQUE-CONTAGEM-REDESIGN-PREVIEW-05.3', { concurrency: false }, () => {
  it('01 pesquisa seleciona o produto por nome, código e barras', async () => {
    const { db } = await setup();
    await criarCoca(db, { codigo: '64896', codigo_barras: '789100' });
    const porNome = await buscarProdutosParaContagem(db, 'Coca-Cola 1,5 L');
    const porCodigo = await buscarProdutosParaContagem(db, '64896');
    const porBarras = await buscarProdutosParaContagem(db, '789100');
    assert.equal(porNome.itens[0].nome, 'Coca-Cola 1,5 L');
    assert.equal(porCodigo.itens[0].codigo, '64896');
    assert.equal(porBarras.itens[0].codigo_barras, '789100');
    assert.equal(porNome.itens[0].id, porCodigo.itens[0].id);
    await closeDb(db);
  });

  it('02 saldo fiscal atual vem da empresa selecionada', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 100);
    const saldoAtual = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db,
      empresaId: empresa.id,
      produtoId: id
    });
    assert.equal(saldoAtual.saldo_fiscal_atual, 24000);
    assert.equal(saldoAtual.saldo_fiscal_esperado, 24000);
    assert.equal(saldoAtual.nome, 'Coca-Cola 1,5 L');
    assert.equal(saldoAtual.codigo, '64896');
    assert.equal(saldoAtual.unidade_comercial, 'UN');
    assert.equal(saldoAtual.unidade_base, 'ML');
    assert.equal(Number(saldoAtual.fator_conversao), 1500);
    await closeDb(db);
  });

  it('03 saldo não fiscal é retornado para o snapshot quando a consulta é feita', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'NF1' });
    await saldo(db, empresa.id, id, 24000, 7500);
    const saldoAtual = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db,
      empresaId: empresa.id,
      produtoId: id
    });
    assert.equal(saldoAtual.saldo_nao_fiscal_atual, 7500);
    assert.equal(saldoAtual.saldo_nao_fiscal_esperado, 7500);
    await closeDb(db);
  });

  it('04 e 05 consulta respeita a empresa e não soma outra empresa nem o saldo global', async () => {
    const { db, empresa, empresaB } = await setup();
    const id = await criarCoca(db, { codigo: 'ISO1' });
    await saldo(db, empresa.id, id, 24000, 100);
    await saldo(db, empresaB.id, id, 5000, 50);
    await run(
      db,
      `UPDATE produtos SET saldo_fiscal = 999999, saldo_nao_fiscal = 888888, estoque_atual = 1888887 WHERE id = ?`,
      [id]
    );
    const daA = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db, empresaId: empresa.id, produtoId: id
    });
    const daB = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db, empresaId: empresaB.id, produtoId: id
    });
    assert.equal(daA.empresa_id, empresa.id);
    assert.equal(daA.saldo_fiscal_atual, 24000);
    assert.equal(daA.saldo_nao_fiscal_atual, 100);
    assert.equal(daA.origem_saldo, 'estoque_empresa');
    assert.notEqual(daA.saldo_fiscal_atual, 999999);
    assert.notEqual(daA.saldo_fiscal_atual, 29000);
    assert.equal(daB.saldo_fiscal_atual, 5000);
    assert.equal(daB.saldo_nao_fiscal_atual, 50);
    await closeDb(db);
  });

  it('06 consulta e prévia não movimentam estoque nem gravam histórico', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'READ1' });
    await saldo(db, empresa.id, id, 24000, 100);
    const antesCont = await contagens(db);
    const antesAj = await ajustes(db);
    await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db, empresaId: empresa.id, produtoId: id
    });
    await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 2
    });
    const depois = await saldoEmpresa(db, empresa.id, id);
    assert.equal(Number(depois.saldoFiscal), 24000);
    assert.equal(Number(depois.saldoNaoFiscal), 100);
    assert.equal(await contagens(db), antesCont);
    assert.equal(await ajustes(db), antesAj);
    const hist = await listarHistoricoContagens(db, empresa.id, { limite: 15 });
    assert.equal(hist.itens.length, 0);
    const fn = extrair(FISICA, 'async function consultarSaldoAtualContagem', 'module.exports');
    assert.match(fn, /legado:\s*false/);
    assert.doesNotMatch(fn, /creditarSaldo|debitarSaldo|registrarContagemFisica|INSERT INTO estoque_contagens/);
    await closeDb(db);
  });

  it('07 Coca-Cola 1,5 L: 10 UN resultam em 15.000 ML', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.quantidade_fiscal_contada, 15000);
    assert.equal(preview.unidade_base, 'ML');
    assert.equal(ui.textoConversao(preview), '10 UN × 1.500 ML = 15.000 ML');
    await closeDb(db);
  });

  it('08 diferença fiscal 15.000 − 24.000 = −9.000 é baixa prevista', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'DIF1' });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.diferenca_fiscal, -9000);
    assert.equal(ui.classificarDiferenca(preview.diferenca_fiscal), 'baixa');
    assert.equal(ui.rotuloDiferenca('baixa'), 'Baixa prevista');
    await closeDb(db);
  });

  it('09 quantidade maior que o saldo é acréscimo previsto', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'ACR1' });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 20,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.quantidade_fiscal_contada, 30000);
    assert.equal(preview.diferenca_fiscal, 6000);
    assert.equal(ui.classificarDiferenca(preview.diferenca_fiscal), 'acrescimo');
    assert.equal(ui.rotuloDiferenca('acrescimo'), 'Acréscimo previsto');
    await closeDb(db);
  });

  it('10 quantidade igual ao saldo tem diferença zero', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'EQ1' });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 16,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.quantidade_fiscal_contada, 24000);
    assert.equal(preview.diferenca_fiscal, 0);
    assert.equal(ui.classificarDiferenca(preview.diferenca_fiscal), 'sem_diferenca');
    assert.equal(ui.rotuloDiferenca('sem_diferenca'), 'Sem diferença');
    await closeDb(db);
  });

  it('11 alterar a quantidade recalcula a diferença', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'ALT1' });
    await saldo(db, empresa.id, id, 24000, 0);
    const dez = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 10, quantidade_nao_fiscal_informada: 0
    });
    const doze = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 12, quantidade_nao_fiscal_informada: 0
    });
    assert.equal(dez.diferenca_fiscal, -9000);
    assert.equal(doze.quantidade_fiscal_contada, 18000);
    assert.equal(doze.diferenca_fiscal, -6000);
    assert.notEqual(dez.diferenca_fiscal, doze.diferenca_fiscal);
    await closeDb(db);
  });

  it('12 trocar o produto invalida o cálculo anterior', () => {
    assert.equal(ui.calculoAindaValido({
      seqResposta: 2, seqAtual: 2, produtoResposta: 10, produtoAtual: 11
    }), false);
    assert.equal(ui.calculoAindaValido({
      seqResposta: 1, seqAtual: 2, produtoResposta: 10, produtoAtual: 10
    }), false);
    assert.equal(ui.calculoAindaValido({
      seqResposta: 4, seqAtual: 4, produtoResposta: 10, produtoAtual: 10
    }), true);
    assert.match(UI, /limparCalculoVisual/);
    assert.doesNotMatch(UI, /quantidade\s*\*\s*fator|qtd\s*\*\s*fator/i);
  });

  it('13 produto sem conversão confiável não gera quantidade convertida', async () => {
    const { db, empresa } = await setup();
    const r = await run(
      db,
      `INSERT INTO produtos (nome, codigo, unidade, unidade_estoque, utiliza_conversao, ativo, saldo_fiscal, saldo_nao_fiscal)
       VALUES ('Sem fator', 'SF053', 'UN', 'ML', 1, 1, 10, 10)`
    );
    await saldo(db, empresa.id, r.lastID, 10, 10);
    const saldoAtual = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db, empresaId: empresa.id, produtoId: r.lastID
    });
    assert.equal(saldoAtual.conversao_confiavel, false);
    assert.equal(saldoAtual.fator_conversao, null);
    assert.equal(saldoAtual.quantidade_convertida, undefined);
    assert.equal(saldoAtual.saldo_fiscal_atual, 10);
    await assert.rejects(
      () => EstoqueContagemFisicaService.previsualizarContagem({
        db,
        empresaId: empresa.id,
        produtoId: r.lastID,
        quantidade_fiscal_informada: 10,
        quantidade_nao_fiscal_informada: 0
      }),
      (err) => err && /CONVERSAO/.test(String(err.code || ''))
    );
    await closeDb(db);
  });

  it('14 15 16 incluir, editar e remover não movimentam estoque', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'LIST1' });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 10, quantidade_nao_fiscal_informada: 0
    });
    const incluido = ui.incluirNaLista([], preview, { nome: 'Coca-Cola 1,5 L', codigo: '64896' });
    assert.equal(incluido.ok, true);
    assert.equal(incluido.linhas.length, 1);
    assert.equal(incluido.linhas[0].saldo_fiscal_esperado, 24000);
    const editadoPreview = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 12, quantidade_nao_fiscal_informada: 0
    });
    const editado = ui.atualizarLinhaPorPreview(incluido.linhas, 0, editadoPreview, {
      nome: 'Coca-Cola 1,5 L', codigo: '64896'
    });
    assert.equal(editado.ok, true);
    assert.equal(editado.linhas[0].quantidade_fiscal_contada, 18000);
    assert.equal(editado.linhas[0].diferenca_fiscal, -6000);
    assert.notEqual(
      Number(editado.linhas[0].quantidade_fiscal_contada),
      Number(incluido.linhas[0].quantidade_fiscal_contada) + 18000
    );
    const semItem = ui.removerDaLista(editado.linhas, 0);
    assert.equal(semItem.length, 0);
    const depois = await saldoEmpresa(db, empresa.id, id);
    assert.equal(Number(depois.saldoFiscal), 24000);
    assert.equal(await contagens(db), 0);
    assert.equal(await ajustes(db), 0);
    const blocoAdd = extrair(UI, 'async function adicionarLinha', 'async function atualizarPreviewsDaLista');
    const blocoEdit = extrair(UI, 'async function salvarEdicao', 'async function adicionarLinha');
    assert.doesNotMatch(blocoAdd, /\/api\/estoque\/contagem-fisica['"`]/);
    assert.doesNotMatch(blocoEdit, /\/api\/estoque\/contagem-fisica['"`]/);
    assert.match(blocoAdd, /incluirNaLista/);
    assert.match(UI, /removerDaLista/);
    await closeDb(db);
  });

  it('17 produto duplicado não é somado e aponta o item existente', () => {
    const preview = {
      produto_id: 7,
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0,
      saldo_fiscal_anterior: 24000,
      saldo_nao_fiscal_anterior: 0,
      quantidade_fiscal_informada: 10,
      quantidade_fiscal_contada: 15000,
      quantidade_nao_fiscal_informada: 0,
      quantidade_nao_fiscal_contada: 0,
      diferenca_fiscal: -9000,
      diferenca_nao_fiscal: 0,
      omitir_nao_fiscal: false
    };
    const primeiro = ui.incluirNaLista([], preview, { nome: 'Coca-Cola 1,5 L', codigo: '64896' });
    const segundo = ui.incluirNaLista(primeiro.linhas, Object.assign({}, preview, {
      quantidade_fiscal_informada: 4,
      quantidade_fiscal_contada: 6000
    }), { nome: 'Coca-Cola 1,5 L' });
    assert.equal(segundo.ok, false);
    assert.equal(segundo.code, 'PRODUTO_JA_NA_LISTA');
    assert.equal(segundo.indice, 0);
    assert.equal(segundo.linhas.length, 1);
    assert.equal(segundo.linhas[0].quantidade_fiscal_contada, 15000);
    assert.match(UI, /Produto já está na lista/);
    assert.match(UI, /linhas\.some/);
  });

  it('18 e 19 a lista guarda o snapshot e o resumo reflete os itens', () => {
    const linhaA = ui.snapshotDaLinha({
      produto_id: 1,
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0,
      quantidade_fiscal_contada: 15000,
      quantidade_nao_fiscal_contada: 0,
      diferenca_fiscal: -9000,
      diferenca_nao_fiscal: 0
    }, { nome: 'Coca-Cola 1,5 L', codigo: '64896' });
    const linhaB = ui.snapshotDaLinha({
      produto_id: 2,
      saldo_fiscal_esperado: 1000,
      saldo_nao_fiscal_esperado: 0,
      quantidade_fiscal_contada: 1000,
      quantidade_nao_fiscal_contada: 0,
      diferenca_fiscal: 0,
      diferenca_nao_fiscal: 0
    }, { nome: 'Água' });
    assert.equal(linhaA.saldo_fiscal_esperado, 24000);
    assert.notEqual(linhaA.saldo_fiscal_esperado, linhaA.quantidade_fiscal_contada);
    const resumo = ui.resumoContagem([linhaA, linhaB]);
    assert.equal(resumo.produtos_adicionados, 2);
    assert.equal(resumo.produtos_com_diferenca, 1);
    assert.equal(resumo.produtos_sem_diferenca, 1);
    assert.equal(resumo.ajustes_previstos, 1);
    assert.equal(resumo.aguardando_confirmacao, true);
    assert.match(UI, /Aguardando confirmação/);
    assert.match(UI, /Ajustes previstos/);
    assert.match(UI, /Diferenças calculadas/);
    assert.doesNotMatch(UI, /Estoque atualizado|Baixa realizada|Ajuste concluído/);
  });

  it('20 F12 ON oculta informações não fiscais na interface', () => {
    assert.match(UI, /F12 ON — somente quantidade fiscal/);
    assert.match(UI, /f12On[\s\S]{0,80}d-none|cef-wrap-qnf.*d-none/);
    assert.match(UI, /cef-card-nf/);
    assert.match(UI, /Qtd não fiscal contada/);
    assert.match(UI, /F12 OFF/);
    assert.match(UI, /saldo-atual\?produto_id=/);
  });

  it('21 e 22 F12 ON preserva o saldo não fiscal e não gera ajuste não fiscal', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'F12ON' });
    await saldo(db, empresa.id, id, 0, 9000);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      modo_fiscal: '1'
    });
    assert.equal(preview.omitir_nao_fiscal, true);
    assert.equal(preview.quantidade_nao_fiscal_contada, null);
    assert.equal(preview.saldo_nao_fiscal_esperado, 9000);
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      modo_fiscal: '1',
      chaveIdempotencia: 'f12-on-05-3',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 10,
        omitir_nao_fiscal: true,
        modo_fiscal: '1',
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    const depois = await saldoEmpresa(db, empresa.id, id);
    assert.equal(Number(depois.saldoNaoFiscal), 9000);
    assert.equal(Number(depois.saldoFiscal), 15000);
    const adj = await get(
      db,
      `SELECT ajuste_nao_fiscal, ajuste_fiscal FROM produtos_ajustes_estoque WHERE produto_id = ? ORDER BY id DESC LIMIT 1`,
      [id]
    );
    assert.equal(Number(adj.ajuste_nao_fiscal), 0);
    assert.equal(Number(adj.ajuste_fiscal), 15000);
    await closeDb(db);
  });

  it('23 F12 OFF calcula fiscal e não fiscal em separado', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'F12OFF' });
    await saldo(db, empresa.id, id, 24000, 8000);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 4,
      modo_fiscal: '0'
    });
    assert.equal(preview.quantidade_fiscal_contada, 15000);
    assert.equal(preview.quantidade_nao_fiscal_contada, 6000);
    assert.equal(preview.diferenca_fiscal, -9000);
    assert.equal(preview.diferenca_nao_fiscal, -2000);
    assert.notEqual(preview.diferenca_fiscal, preview.diferenca_nao_fiscal);
    await closeDb(db);
  });

  it('24 sem confirmação final não existe movimentação', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'SEMCONF' });
    await saldo(db, empresa.id, id, 24000, 100);
    await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db, empresaId: empresa.id, produtoId: id
    });
    await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 10, quantidade_nao_fiscal_informada: 1
    });
    const depois = await saldoEmpresa(db, empresa.id, id);
    assert.equal(Number(depois.saldoFiscal), 24000);
    assert.equal(Number(depois.saldoNaoFiscal), 100);
    assert.equal(await contagens(db), 0);
    assert.doesNotMatch(UI, /setTimeout\(\s*confirmar|setInterval\(/);
    await closeDb(db);
  });

  it('25 confirmação efetiva gera o ajuste previsto', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'CONF1' });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 10, quantidade_nao_fiscal_informada: 0
    });
    assert.equal(await contagens(db), 0);
    const conf = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      chaveIdempotencia: 'conf-05-3',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 10,
        quantidade_nao_fiscal_informada: 0,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    const depois = await saldoEmpresa(db, empresa.id, id);
    assert.equal(Number(depois.saldoFiscal), 15000);
    assert.equal(Number(conf.itens[0].diferenca_fiscal), -9000);
    assert.equal(await contagens(db), 1);
    assert.equal(await ajustes(db), 1);
    await closeDb(db);
  });

  it('26 snapshot desatualizado bloqueia o lote inteiro', async () => {
    const { db, empresa } = await setup();
    const a = await criarCoca(db, { nome: 'Coca A', codigo: 'CA' });
    const b = await criarCoca(db, { nome: 'Coca B', codigo: 'CB' });
    await saldo(db, empresa.id, a, 24000, 0);
    await saldo(db, empresa.id, b, 24000, 0);
    const prevA = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: a,
      quantidade_fiscal_informada: 10, quantidade_nao_fiscal_informada: 0
    });
    const prevB = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: b,
      quantidade_fiscal_informada: 8, quantidade_nao_fiscal_informada: 0
    });
    await run(
      db,
      `UPDATE estoque_empresa SET saldo_fiscal = 1000 WHERE produto_id = ? AND empresa_id = ?`,
      [b, empresa.id]
    );
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresa.id,
        chaveIdempotencia: 'lote-stale-05-3',
        itens: exigirSnapshotItensOficiais([
          {
            produto_id: a,
            quantidade_fiscal_informada: 10,
            quantidade_nao_fiscal_informada: 0,
            saldo_fiscal_esperado: prevA.saldo_fiscal_esperado,
            saldo_nao_fiscal_esperado: prevA.saldo_nao_fiscal_esperado
          },
          {
            produto_id: b,
            quantidade_fiscal_informada: 8,
            quantidade_nao_fiscal_informada: 0,
            saldo_fiscal_esperado: prevB.saldo_fiscal_esperado,
            saldo_nao_fiscal_esperado: prevB.saldo_nao_fiscal_esperado
          }
        ])
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    const saldoA = await saldoEmpresa(db, empresa.id, a);
    const saldoB = await saldoEmpresa(db, empresa.id, b);
    assert.equal(Number(saldoA.saldoFiscal), 24000);
    assert.equal(Number(saldoB.saldoFiscal), 1000);
    assert.equal(await contagens(db), 0);
    assert.equal(await ajustes(db), 0);
    await closeDb(db);
  });

  it('27 retry com a mesma chave não duplica a movimentação', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'RETRY' });
    await saldo(db, empresa.id, id, 0, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 2, quantidade_nao_fiscal_informada: 0
    });
    const item = exigirSnapshotItensOficiais([{
      produto_id: id,
      quantidade_fiscal_informada: 2,
      quantidade_nao_fiscal_informada: 0,
      saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
      saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
    }]);
    const primeira = await EstoqueContagemFisicaService.registrarContagemFisica({
      db, empresaId: empresa.id, chaveIdempotencia: 'retry-05-3', itens: item
    });
    const segunda = await EstoqueContagemFisicaService.registrarContagemFisica({
      db, empresaId: empresa.id, chaveIdempotencia: 'retry-05-3', itens: item
    });
    assert.equal(segunda.id, primeira.id);
    const depois = await saldoEmpresa(db, empresa.id, id);
    assert.equal(Number(depois.saldoFiscal), 3000);
    assert.equal(await contagens(db), 1);
    assert.equal(await ajustes(db), 1);
    await closeDb(db);
  });

  it('28 falha em um item não deixa lote parcialmente aplicado', async () => {
    const { db, empresa } = await setup();
    const a = await criarCoca(db, { nome: 'Lote A', codigo: 'LA' });
    const b = await criarCoca(db, { nome: 'Lote B', codigo: 'LB' });
    await saldo(db, empresa.id, a, 1000, 0);
    await saldo(db, empresa.id, b, 1000, 0);
    const prevA = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: a,
      quantidade_fiscal_informada: 1, quantidade_nao_fiscal_informada: 0
    });
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresa.id,
        chaveIdempotencia: 'parcial-05-3',
        itens: exigirSnapshotItensOficiais([
          {
            produto_id: a,
            quantidade_fiscal_informada: 1,
            quantidade_nao_fiscal_informada: 0,
            saldo_fiscal_esperado: prevA.saldo_fiscal_esperado,
            saldo_nao_fiscal_esperado: prevA.saldo_nao_fiscal_esperado
          },
          {
            produto_id: b,
            quantidade_fiscal_informada: 1,
            quantidade_nao_fiscal_informada: 0,
            saldo_fiscal_esperado: 999999,
            saldo_nao_fiscal_esperado: 0
          }
        ])
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    const saldoA = await saldoEmpresa(db, empresa.id, a);
    assert.equal(Number(saldoA.saldoFiscal), 1000);
    assert.equal(await contagens(db), 0);
    await closeDb(db);
  });

  it('29 histórico só registra contagem confirmada', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'HIST1' });
    await saldo(db, empresa.id, id, 0, 0);
    const antes = await listarHistoricoContagens(db, empresa.id, { limite: 15 });
    assert.equal(antes.itens.length, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 1, quantidade_nao_fiscal_informada: 0
    });
    const meio = await listarHistoricoContagens(db, empresa.id, { limite: 15 });
    assert.equal(meio.itens.length, 0);
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      usuarioNome: 'Operador',
      chaveIdempotencia: 'hist-05-3',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 1,
        quantidade_nao_fiscal_informada: 0,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    const depois = await listarHistoricoContagens(db, empresa.id, { limite: 15 });
    assert.equal(depois.itens.length, 1);
    assert.equal(Number(depois.itens[0].quantidade_produtos), 1);
    assert.match(UI, /carregarHistorico\(\)/);
    const blocoAdd = extrair(UI, 'async function adicionarLinha', 'async function atualizarPreviewsDaLista');
    assert.doesNotMatch(blocoAdd, /carregarHistorico/);
    await closeDb(db);
  });

  it('30 confirmação reconverte a quantidade informada e ignora base divergente do cliente', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'RECONV' });
    await saldo(db, empresa.id, id, 0, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db, empresaId: empresa.id, produtoId: id,
      quantidade_fiscal_informada: 10, quantidade_nao_fiscal_informada: 0
    });
    const conf = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      chaveIdempotencia: 'reconv-05-3',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        quantidade_fiscal_informada: 10,
        quantidade_fiscal_contada: 1,
        quantidade_nao_fiscal_informada: 0,
        quantidade_nao_fiscal_contada: 1,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    assert.equal(Number(conf.itens[0].quantidade_fiscal_contada), 15000);
    const depois = await saldoEmpresa(db, empresa.id, id);
    assert.equal(Number(depois.saldoFiscal), 15000);
    await closeDb(db);
  });

  it('31 a 35 layout, resoluções, vazio, erro preservado e script sem erro de sintaxe', () => {
    assert.match(UI, /Contagem Física/);
    assert.match(UI, /Conferência, ajuste e controle do estoque/);
    assert.match(UI, /data-cef-layout="proposta-2"/);
    assert.match(UI, /cef-workspace/);
    assert.match(UI, /cef-form/);
    assert.match(UI, /cef-lista/);
    assert.match(UI, /Incluir na lista/);
    assert.match(UI, /Confirmar contagem/);
    assert.match(UI, /Pesquisar produto/);
    assert.match(UI, /Nenhum produto encontrado/);
    assert.match(UI, /Selecione um produto na pesquisa/);
    assert.match(UI, /Nenhum produto na contagem/);
    assert.match(UI, /configuracao-estoque/);
    assert.match(UI, /Baixa prevista/);
    assert.match(UI, /Acréscimo previsto/);
    assert.match(UI, /Sem diferença/);
    assert.match(INDEX, /id="sidebar"/);
    assert.match(INDEX, /contagem-fisica\.css/);
    assert.doesNotMatch(UI, /Produto ID/);
    const blocoErro = extrair(UI, 'async function calcularTempoReal', 'async function previewLinha');
    assert.match(blocoErro, /mostrarErro/);
    assert.doesNotMatch(blocoErro, /cef-qf'\)\.value\s*=\s*''|getElementById\('cef-qf'\)\.value\s*=/);
    assert.match(CSS, /grid-template-columns:\s*minmax\(320px/);
    assert.match(CSS, /min-width:\s*0/);
    assert.match(CSS, /@media \(min-width: 1366px\)/);
    assert.match(CSS, /@media \(min-width: 1440px\)/);
    assert.match(CSS, /@media \(min-width: 1920px\)/);
    assert.match(CSS, /@media \(max-width: 991\.98px\)/);
    const iSaldo = ROTAS.indexOf("'/contagem-fisica/saldo-atual'");
    const iId = ROTAS.indexOf("'/contagem-fisica/:id'");
    assert.ok(iSaldo >= 0 && iSaldo < iId);
    const check = spawnSync(process.execPath, ['--check', path.join(ROOT, 'frontend/erp/js/contagem-estoque.js')], {
      encoding: 'utf8'
    });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.equal(ui.rotuloTipoEmpresa({ cnpj: '11222333000181' }), 'Matriz');
    assert.equal(ui.rotuloTipoEmpresa({ cnpj: '11222333000281' }), 'Filial');
    assert.equal(ui.rotuloTipoEmpresa({ tipo_empresa: 'FILIAL', cnpj: '11222333000181' }), 'Filial');
    assert.equal(ui.textoConversao({
      quantidade_fiscal_informada: 10,
      fator_total: 1500,
      quantidade_fiscal_contada: 1,
      unidade_informada: 'UN',
      unidade_base: 'ML'
    }), '10 UN × 1.500 ML = 1 ML');
  });
});
