/**
 * PDV-MULTIEMPRESA-05 — preview propaga requisitos de estoque por item quando confiáveis.
 * Isolamento: sem banco oficial; helper do PDV via vm + capacidade em :memory:.
 * Executar: node --test tests/pdv/pdv-multiempresa-05-preview-itens.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite3 = require('sqlite3').verbose();

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  avaliarCapacidadeCarrinho,
  hashCarrinho,
  CODIGOS_BLOQUEIO
} = require('../../backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa');
const {
  avaliarSelecaoEmpresaPdv,
  extrairItensCarrinho
} = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

const pdvJsPath = path.join(__dirname, '../../frontend/pdv/js/pdv.js');
const pdvSource = fs.readFileSync(pdvJsPath, 'utf8');
const fnMatch = pdvSource.match(
  /function montarItensSelecaoEmpresaPreviewPdv\(itensCarrinho\) \{[\s\S]*?\n\}/
);
assert.ok(fnMatch, 'montarItensSelecaoEmpresaPreviewPdv deve existir em pdv.js');
assert.match(pdvSource, /montarItensSelecaoEmpresaPreviewPdv\(carrinho\)/);
assert.match(pdvSource, /venda_fiscal:\s*emitir/);

const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(
  `${fnMatch[0]}\nmodule.exports = { montarItensSelecaoEmpresaPreviewPdv };`,
  sandbox
);
const { montarItensSelecaoEmpresaPreviewPdv } = sandbox.module.exports;

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL_B = '11222333000262';
const CNPJ_FILIAL_C = '11222333000343';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID });
    });
  });
}
function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      ativo INTEGER DEFAULT 1,
      unidade TEXT DEFAULT 'UN',
      tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      utiliza_ficha_tecnica INTEGER,
      updated_at DATETIME
    )
  `);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);
  const matriz = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz M05' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B M05' },
    { db }
  );
  const filialC = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C M05' },
    { db }
  );
  return { db, matriz, filialB, filialC };
}

async function criarProduto(db, nome) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, controla_estoque, saldo_fiscal, estoque_atual)
     VALUES (?, 'COMERCIAL', 'UN', 1, 0, 0)`,
    [nome]
  );
  return ins.lastID;
}

async function setEstoque(db, produtoId, empresaId, fiscal, naoFiscal = 0) {
  const existe = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?`,
      [produtoId, empresaId],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
  if (existe) {
    await run(
      db,
      `UPDATE estoque_empresa SET saldo_fiscal=?, saldo_nao_fiscal=?, estoque_atual=?
       WHERE produto_id=? AND empresa_id=?`,
      [fiscal, naoFiscal, fiscal + naoFiscal, produtoId, empresaId]
    );
  } else {
    await EstoqueEmpresaService.criarRegistro({
      produtoId,
      empresaId,
      saldo_fiscal: fiscal,
      saldo_nao_fiscal: naoFiscal,
      estoque_atual: fiscal + naoFiscal
    }, { db });
  }
}

const depsBase = (db) => ({
  db,
  usarAutorizacaoUsuario: false,
  verificarFiscalValido: async () => true
});

describe('PDV-MULTIEMPRESA-05 preview itens', { concurrency: false }, () => {
  it('1) preview homogêneo: só produto/quantidade/unidade (comportamento anterior)', () => {
    const itens = montarItensSelecaoEmpresaPreviewPdv([
      { id: 10, quantidade: 2, unidade: 'UN', item_fiscal: 1 }
    ]);
    assert.equal(itens.length, 1);
    assert.equal(itens[0].produto_id, 10);
    assert.equal(itens[0].quantidade, 2);
    assert.equal(itens[0].unidade, 'UN');
    assert.equal(itens[0].tipo_saldo, undefined);
    assert.equal(itens[0].quantidade_fiscal, undefined);
    assert.equal(itens[0].quantidade_nao_fiscal, undefined);
    assert.equal(itens[0].item_fiscal, 1);
  });

  it('2) carrinho misto transmite tipo_saldo por item quando disponível', () => {
    const itens = montarItensSelecaoEmpresaPreviewPdv([
      { id: 1, quantidade: 1, tipo_saldo: 'FISCAL' },
      { produto_id: 2, quantidade: 3, tipoSaldo: 'NAO_FISCAL' }
    ]);
    assert.equal(itens[0].tipo_saldo, 'FISCAL');
    assert.equal(itens[1].tipo_saldo, 'NAO_FISCAL');
  });

  it('3) quantidades fiscais/não fiscais preservadas na montagem e na normalização', () => {
    const preview = montarItensSelecaoEmpresaPreviewPdv([{
      id: 7,
      quantidade: 3,
      quantidade_fiscal: 1,
      quantidade_nao_fiscal: 2
    }]);
    assert.equal(preview[0].quantidade_fiscal, 1);
    assert.equal(preview[0].quantidade_nao_fiscal, 2);

    const extraidos = extrairItensCarrinho({ itens: preview });
    assert.equal(Number(extraidos[0].quantidade_fiscal), 1);
    assert.equal(Number(extraidos[0].quantidade_nao_fiscal), 2);
  });

  it('4) campos ausentes / tipo inválido → fallback operacional (sem inventar)', () => {
    const itens = montarItensSelecaoEmpresaPreviewPdv([
      { id: 5, quantidade: 1, tipo_saldo: 'XYZ_INVALIDO' },
      { id: 6, quantidade: 2 }
    ]);
    assert.equal(itens[0].tipo_saldo, undefined);
    assert.equal(itens[1].tipo_saldo, undefined);
  });

  it('5) item_fiscal isolado não seleciona bucket (capacidade herda tipo da operação)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Somente item_fiscal');
    await setEstoque(db, prod, matriz.id, 0, 5);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const preview = montarItensSelecaoEmpresaPreviewPdv([
      { id: prod, quantidade: 1, item_fiscal: 1 }
    ]);
    assert.equal(preview[0].tipo_saldo, undefined);

    const out = await avaliarSelecaoEmpresaPdv({
      body: { emitir_fiscal: true, itens: preview },
      itens: preview,
      usuarioId: 1
    }, depsBase(db));

    // emitir_fiscal true → tipo operacional FISCAL; só NF no estoque → bloqueio
    assert.ok(out.bloqueio);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('6) servidor revalida capacidade (consulta ≠ reserva; 2ª avaliação após baixa sintética)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Reval');
    await setEstoque(db, prod, matriz.id, 1, 0);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const preview = montarItensSelecaoEmpresaPreviewPdv([
      { id: prod, quantidade: 1, tipo_saldo: 'FISCAL' }
    ]);
    const r1 = await avaliarSelecaoEmpresaPdv({
      body: { emitir_fiscal: true, venda_fiscal: true, itens: preview },
      itens: preview,
      usuarioId: 1
    }, depsBase(db));
    assert.equal(r1.bloqueio, null);
    assert.equal(r1.selecionada.empresaId, matriz.id);

    await setEstoque(db, prod, matriz.id, 0, 0);
    const r2 = await avaliarSelecaoEmpresaPdv({
      body: { emitir_fiscal: true, venda_fiscal: true, itens: preview },
      itens: preview,
      usuarioId: 1
    }, depsBase(db));
    assert.ok(r2.bloqueio);
    assert.equal(r2.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('7-8) misto: sem soma entre CNPJs e sem dividir venda', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const a = await criarProduto(db, 'A fiscal');
    const b = await criarProduto(db, 'B nf');
    await setEstoque(db, a, matriz.id, 2, 0);
    await setEstoque(db, b, matriz.id, 0, 0);
    await setEstoque(db, a, filialB.id, 0, 0);
    await setEstoque(db, b, filialB.id, 0, 5);
    await setEstoque(db, a, filialC.id, 0, 0);
    await setEstoque(db, b, filialC.id, 0, 0);

    const preview = montarItensSelecaoEmpresaPreviewPdv([
      { id: a, quantidade: 1, tipo_saldo: 'FISCAL' },
      { id: b, quantidade: 1, tipo_saldo: 'NAO_FISCAL' }
    ]);

    const out = await avaliarCapacidadeCarrinho({
      itens: extrairItensCarrinho({ itens: preview }),
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('9) hash diferencia requisitos de estoque diferentes', () => {
    const previewA = montarItensSelecaoEmpresaPreviewPdv([
      { id: 1, quantidade: 1, tipo_saldo: 'FISCAL' }
    ]);
    const previewB = montarItensSelecaoEmpresaPreviewPdv([
      { id: 1, quantidade: 1, tipo_saldo: 'NAO_FISCAL' }
    ]);
    assert.notEqual(
      hashCarrinho(extrairItensCarrinho({ itens: previewA })),
      hashCarrinho(extrairItensCarrinho({ itens: previewB }))
    );
  });
});
