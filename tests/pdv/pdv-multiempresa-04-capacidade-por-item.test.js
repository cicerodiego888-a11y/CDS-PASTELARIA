/**
 * PDV-MULTIEMPRESA-04 — Capacidade por item e tipo de saldo.
 * Isolamento: sqlite :memory:
 * Executar: node --test tests/pdv/pdv-multiempresa-04-capacidade-por-item.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  avaliarCapacidadeCarrinho,
  resolverRequisitoEstoqueItem,
  CODIGOS_BLOQUEIO,
  hashCarrinho
} = require('../../backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

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
      resolve({ lastID: this.lastID, changes: this.changes });
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
      utiliza_conversao INTEGER DEFAULT 0,
      unidade_estoque TEXT,
      updated_at DATETIME
    )
  `);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);

  const matriz = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz M04' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B M04' },
    { db }
  );
  const filialC = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C M04' },
    { db }
  );
  return { db, matriz, filialB, filialC };
}

async function criarProduto(db, nome, tipo, opts = {}) {
  const ins = await run(
    db,
    `INSERT INTO produtos (
       nome, tipo_operacional, unidade, controla_estoque, utiliza_ficha_tecnica,
       saldo_fiscal, estoque_atual
     ) VALUES (?, ?, 'UN', ?, ?, 0, 0)`,
    [
      nome,
      tipo,
      opts.controla_estoque != null ? opts.controla_estoque : 1,
      opts.utiliza_ficha_tecnica != null ? opts.utiliza_ficha_tecnica : null
    ]
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
      `UPDATE estoque_empresa
       SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?,
           reservado_fiscal = 0, reservado_nao_fiscal = 0
       WHERE produto_id = ? AND empresa_id = ?`,
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

async function salvarFicha(db, comercialId, itens) {
  await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [comercialId]);
  return FichaTecnicaService.salvar(comercialId, { ativo: 1, itens }, { db });
}

const depsBase = (db) => ({
  db,
  usarAutorizacaoUsuario: false,
  verificarFiscalValido: async () => true
});

describe('PDV-MULTIEMPRESA-04 capacidade por item', { concurrency: false }, () => {
  it('resolverRequisitoEstoqueItem: herda operação ou usa tipo do item / split', () => {
    assert.equal(
      resolverRequisitoEstoqueItem({ quantidade: 2 }, TipoSaldo.FISCAL).tipoSaldo,
      TipoSaldo.FISCAL
    );
    assert.equal(
      resolverRequisitoEstoqueItem({ quantidade: 2, tipo_saldo: 'NAO_FISCAL' }, TipoSaldo.FISCAL).tipoSaldo,
      TipoSaldo.NAO_FISCAL
    );
    const split = resolverRequisitoEstoqueItem({
      quantidade: 3,
      quantidade_fiscal: 1,
      quantidade_nao_fiscal: 2
    }, TipoSaldo.FISCAL);
    assert.equal(split.modo, 'SPLIT');
    assert.equal(split.quantidadeFiscal, 1);
    assert.equal(split.quantidadeNaoFiscal, 2);
  });

  it('item fiscal atendido pelo saldo fiscal', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Item F', 'COMERCIAL');
    await setEstoque(db, prod, matriz.id, 5, 0);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 2, tipo_saldo: 'FISCAL' }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.NAO_FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.equal(out.bloqueio, null);
    await closeDb(db);
  });

  it('item não fiscal atendido pelo saldo não fiscal', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Item NF', 'COMERCIAL');
    await setEstoque(db, prod, matriz.id, 0, 5);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 2, tipoSaldo: TipoSaldo.NAO_FISCAL }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('carrinho misto fiscal + não fiscal no mesmo request', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const fiscal = await criarProduto(db, 'Fiscal', 'COMERCIAL');
    const naoFiscal = await criarProduto(db, 'NaoFiscal', 'COMERCIAL');
    await setEstoque(db, fiscal, matriz.id, 3, 0);
    await setEstoque(db, naoFiscal, matriz.id, 0, 4);
    await setEstoque(db, fiscal, filialB.id, 0, 0);
    await setEstoque(db, naoFiscal, filialB.id, 0, 0);
    await setEstoque(db, fiscal, filialC.id, 0, 0);
    await setEstoque(db, naoFiscal, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [
        { produtoId: fiscal, quantidade: 2, tipo_saldo: 'FISCAL' },
        { produtoId: naoFiscal, quantidade: 3, tipo_saldo: 'NAO_FISCAL' }
      ],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, matriz.id, JSON.stringify(out.porEmpresa));
    assert.equal(out.bloqueio, null);
    await closeDb(db);
  });

  it('carrinho misto bloqueia se um dos tipos faltar na mesma empresa', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const fiscal = await criarProduto(db, 'Fiscal2', 'COMERCIAL');
    const naoFiscal = await criarProduto(db, 'NaoFiscal2', 'COMERCIAL');
    await setEstoque(db, fiscal, matriz.id, 3, 0);
    await setEstoque(db, naoFiscal, matriz.id, 0, 0);
    await setEstoque(db, fiscal, filialB.id, 0, 0);
    await setEstoque(db, naoFiscal, filialB.id, 0, 10);
    await setEstoque(db, fiscal, filialC.id, 0, 0);
    await setEstoque(db, naoFiscal, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [
        { produtoId: fiscal, quantidade: 1, tipo_saldo: 'FISCAL' },
        { produtoId: naoFiscal, quantidade: 1, tipo_saldo: 'NAO_FISCAL' }
      ],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    // Nenhuma empresa tem AMBOS — não soma CNPJs / não divide venda.
    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('split quantidade_fiscal + quantidade_nao_fiscal na mesma linha', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Misto linha', 'COMERCIAL');
    await setEstoque(db, prod, matriz.id, 1, 2);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const ok = await avaliarCapacidadeCarrinho({
      itens: [{
        produtoId: prod,
        quantidade: 3,
        quantidade_fiscal: 1,
        quantidade_nao_fiscal: 2
      }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));
    assert.equal(ok.selecionada.empresaId, matriz.id);

    await setEstoque(db, prod, matriz.id, 1, 0);
    const fail = await avaliarCapacidadeCarrinho({
      itens: [{
        produtoId: prod,
        quantidade: 3,
        quantidade_fiscal: 1,
        quantidade_nao_fiscal: 2
      }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));
    assert.equal(fail.selecionada, null);
    const g = fail.porEmpresa.find((e) => e.empresaId === matriz.id).gargalos;
    assert.ok(g.some((x) => x.codigoMotivo === 'ESTOQUE_INSUFICIENTE_NAO_FISCAL'));
    await closeDb(db);
  });

  it('ficha técnica: insumos (total F+NF) e não soma outra empresa', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 2, unidade: 'UN' }]);
    await setEstoque(db, massa, matriz.id, 0, 1);
    await setEstoque(db, massa, filialB.id, 0, 10);
    await setEstoque(db, massa, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, filialB.id);
    const avM = out.porEmpresa.find((e) => e.empresaId === matriz.id);
    assert.equal(avM.atendeIntegralmente, false);
    assert.ok(avM.gargalos.some((g) => g.codigoMotivo === 'INSUMO_INSUFICIENTE'));
    await closeDb(db);
  });

  it('nenhuma soma entre CNPJs nem divisão da venda', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Agg', 'COMERCIAL');
    await setEstoque(db, prod, matriz.id, 2, 0);
    await setEstoque(db, prod, filialB.id, 2, 0);
    await setEstoque(db, prod, filialC.id, 2, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 5, tipo_saldo: 'FISCAL' }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    assert.equal(out.porEmpresa.filter((e) => e.atendeIntegralmente).length, 0);
    await closeDb(db);
  });

  it('hash muda quando tipo de saldo do item muda (snapshot)', () => {
    const a = hashCarrinho([{ produtoId: 1, quantidade: 1, tipo_saldo: 'FISCAL' }]);
    const b = hashCarrinho([{ produtoId: 1, quantidade: 1, tipo_saldo: 'NAO_FISCAL' }]);
    assert.notEqual(a, b);
  });

  it('avaliação de capacidade não debita estoque (sem consumo duplicado)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'NoDebit', 'COMERCIAL');
    await setEstoque(db, prod, matriz.id, 4, 0);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 2, tipo_saldo: 'FISCAL' }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));
    await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 2, tipo_saldo: 'FISCAL' }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?`,
        [prod, matriz.id],
        (err, r) => (err ? reject(err) : resolve(r))
      );
    });
    assert.equal(Number(row.saldo_fiscal), 4);
    await closeDb(db);
  });
});
