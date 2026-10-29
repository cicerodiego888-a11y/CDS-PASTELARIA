/**
 * PDV-MULTIEMPRESA-13 — Diagnóstico sintético da consulta de estoque entre empresas.
 * Somente leitura das APIs de capacidade/disponibilidade. Não altera regras de produção.
 *
 * Executar: node --test tests/pdv/pdv-multiempresa-13-diagnostico-estoque.test.js
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
  consultarDisponibilidade
} = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const {
  avaliarCapacidadeCarrinho,
  lerDisponivel,
  lerDisponivelFichaInsumo,
  CODIGOS_BLOQUEIO
} = require('../../backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa');
const {
  avaliarSelecaoEmpresaPdv
} = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

const CNPJ_A = '11222333000181'; // matriz
const CNPJ_B = '11222333000262'; // filial

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

  const empresaA = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_A, razao_social: 'Empresa A Matriz M13' },
    { db }
  );
  const empresaB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_B, razao_social: 'Empresa B Filial M13' },
    { db }
  );
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, opts = {}) {
  const ins = await run(
    db,
    `INSERT INTO produtos (
       nome, tipo_operacional, unidade, controla_estoque, utiliza_ficha_tecnica,
       saldo_fiscal, saldo_nao_fiscal, estoque_atual
     ) VALUES (?, ?, 'UN', ?, ?, ?, ?, ?)`,
    [
      nome,
      opts.tipo || 'COMERCIAL',
      opts.controla_estoque != null ? opts.controla_estoque : 1,
      opts.utiliza_ficha_tecnica != null ? opts.utiliza_ficha_tecnica : null,
      opts.saldo_fiscal_global || 0,
      opts.saldo_nao_fiscal_global || 0,
      (opts.saldo_fiscal_global || 0) + (opts.saldo_nao_fiscal_global || 0)
    ]
  );
  return ins.lastID;
}

async function setEstoque(db, produtoId, empresaId, fiscal, naoFiscal = 0) {
  const existe = await get(
    db,
    `SELECT id FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?`,
    [produtoId, empresaId]
  );
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

async function persistidoEe(db, produtoId, empresaId) {
  return get(
    db,
    `SELECT saldo_fiscal, saldo_nao_fiscal, estoque_atual,
            reservado_fiscal, reservado_nao_fiscal
       FROM estoque_empresa
      WHERE produto_id = ? AND empresa_id = ?`,
    [produtoId, empresaId]
  );
}

const deps = (db) => ({
  db,
  usarAutorizacaoUsuario: false,
  verificarFiscalValido: async () => true
});

describe('PDV-MULTIEMPRESA-13 diagnóstico estoque', { concurrency: false }, () => {
  it('origem: consultarDisponibilidade com empresaId lê estoque_empresa (não produtos.*)', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const prod = await criarProduto(db, 'Refrigerante Copo 300 ml', {
      saldo_fiscal_global: 999,
      saldo_nao_fiscal_global: 999
    });
    // Só B tem NF; A sem registro EE; produtos.* com 999 (enganoso se alguém olhar o global).
    await setEstoque(db, prod, empresaB.id, 0, 7);

    const dispA = await consultarDisponibilidade(prod, {
      db,
      empresaId: empresaA.id,
      modoLegadoSemEmpresa: false
    });
    const dispB = await consultarDisponibilidade(prod, {
      db,
      empresaId: empresaB.id,
      modoLegadoSemEmpresa: false
    });
    const rowB = await persistidoEe(db, prod, empresaB.id);
    const isoA = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: prod,
      empresaId: empresaA.id,
      db
    }, { db });

    assert.equal(isoA, null, 'registro ausente em A → null (não fallback produtos)');
    assert.equal(dispA.disponivel_fiscal, 0);
    assert.equal(dispA.disponivel_nao_fiscal, 0);
    assert.equal(dispA.empresa_id, empresaA.id);

    assert.equal(Number(rowB.saldo_nao_fiscal), 7);
    assert.equal(dispB.disponivel_nao_fiscal, 7);
    assert.equal(dispB.disponivel_fiscal, 0);
    assert.equal(dispB.empresa_id, empresaB.id);
    assert.notEqual(dispB.disponivel_total, 999 + 999);

    await closeDb(db);
  });

  it('A sem saldo + B com NF suficiente → seletor escolhe B (venda não fiscal)', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const prod = await criarProduto(db, 'Refrig 300 A0 Bnf');
    await setEstoque(db, prod, empresaA.id, 0, 0);
    await setEstoque(db, prod, empresaB.id, 0, 10);

    const cap = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 2 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.NAO_FISCAL
    }, deps(db));

    assert.equal(cap.matrizId, empresaA.id);
    assert.deepEqual(cap.ordemAvaliacao, [empresaA.id, empresaB.id]);
    const gA = cap.porEmpresa.find((e) => e.empresaId === empresaA.id);
    assert.equal(gA.atendeIntegralmente, false);
    assert.ok(gA.gargalos.some((g) => g.codigoMotivo === 'ESTOQUE_INSUFICIENTE_NAO_FISCAL'));
    assert.equal(gA.gargalos.find((g) => g.produtoId === prod).disponivel, 0);

    assert.equal(cap.selecionada.empresaId, empresaB.id);
    assert.equal(cap.bloqueio, null);
    await closeDb(db);
  });

  it('A com fiscal + B com NF: fiscal escolhe A; NF escolhe B; total F+NF NÃO atende fiscal em B', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const prod = await criarProduto(db, 'Split buckets');
    await setEstoque(db, prod, empresaA.id, 8, 0);
    await setEstoque(db, prod, empresaB.id, 0, 8);

    const fiscal = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 3 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, deps(db));
    assert.equal(fiscal.selecionada.empresaId, empresaA.id);

    const nf = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 3 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.NAO_FISCAL
    }, deps(db));
    assert.equal(nf.selecionada.empresaId, empresaB.id);

    // Espelho do engano de UI: "estoque_atual" em A = 8, mas lerDisponivel NF em A = 0.
    const dispA = await consultarDisponibilidade(prod, {
      db, empresaId: empresaA.id, modoLegadoSemEmpresa: false
    });
    const totalUiA = Number(dispA.disponivel_fiscal) + Number(dispA.disponivel_nao_fiscal);
    assert.equal(totalUiA, 8);
    assert.equal(lerDisponivel(dispA, TipoSaldo.NAO_FISCAL), 0);
    assert.equal(lerDisponivel(dispA, TipoSaldo.FISCAL), 8);

    const gBFiscal = fiscal.porEmpresa.find((e) => e.empresaId === empresaB.id);
    assert.equal(gBFiscal.atendeIntegralmente, false);
    assert.equal(gBFiscal.gargalos[0].disponivel, 0);
    assert.equal(gBFiscal.gargalos[0].tipoSaldo, TipoSaldo.FISCAL);

    await closeDb(db);
  });

  it('uma empresa com estoque suficiente para todos os itens → selecionada', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const p1 = await criarProduto(db, 'Item1');
    const p2 = await criarProduto(db, 'Item2');
    await setEstoque(db, p1, empresaA.id, 0, 5);
    await setEstoque(db, p2, empresaA.id, 0, 5);
    await setEstoque(db, p1, empresaB.id, 0, 0);
    await setEstoque(db, p2, empresaB.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [
        { produtoId: p1, quantidade: 2 },
        { produtoId: p2, quantidade: 1 }
      ],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.NAO_FISCAL
    }, deps(db));

    assert.equal(out.selecionada.empresaId, empresaA.id);
    assert.equal(out.bloqueio, null);
    await closeDb(db);
  });

  it('nenhuma empresa atende integralmente (estoque partido entre CNPJs) → NENHUMA_EMPRESA_ATENDE', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const p1 = await criarProduto(db, 'SóA');
    const p2 = await criarProduto(db, 'SóB');
    await setEstoque(db, p1, empresaA.id, 0, 5);
    await setEstoque(db, p2, empresaA.id, 0, 0);
    await setEstoque(db, p1, empresaB.id, 0, 0);
    await setEstoque(db, p2, empresaB.id, 0, 5);

    const out = await avaliarCapacidadeCarrinho({
      itens: [
        { produtoId: p1, quantidade: 1 },
        { produtoId: p2, quantidade: 1 }
      ],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.NAO_FISCAL
    }, deps(db));

    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    // Não soma CNPJs: A tem p1 e falta p2; B tem p2 e falta p1.
    await closeDb(db);
  });

  it('ficha: consulta insumos (total F+NF) separada do produto acabado; insumo insuficiente bloqueia', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const acabado = await criarProduto(db, 'Pastel ficha', { utiliza_ficha_tecnica: 1 });
    const insumo = await criarProduto(db, 'Massa', { tipo: 'INSUMO' });
    await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [acabado]);
    await FichaTecnicaService.salvar(
      acabado,
      { ativo: 1, itens: [{ insumo_id: insumo, quantidade: 2, unidade: 'UN' }] },
      { db }
    );
    // Acabado com “estoque” enganoso; capacidade ignora saldo do acabado e olha insumo.
    await setEstoque(db, acabado, empresaA.id, 100, 100);
    await setEstoque(db, insumo, empresaA.id, 0, 1); // total 1 < need 2
    await setEstoque(db, insumo, empresaB.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: acabado, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, deps(db));

    assert.equal(out.selecionada, null);
    const gA = out.porEmpresa.find((e) => e.empresaId === empresaA.id);
    const garg = gA.gargalos.find((g) => g.codigoMotivo === 'INSUMO_INSUFICIENTE');
    assert.ok(garg);
    assert.equal(garg.insumoId, insumo);
    assert.equal(garg.baseConsulta, 'TOTAL_FICHA');
    assert.equal(garg.disponivel, 1);
    assert.equal(garg.necessario, 2);

    const dispInsumo = await consultarDisponibilidade(insumo, {
      db, empresaId: empresaA.id, modoLegadoSemEmpresa: false
    });
    assert.equal(lerDisponivelFichaInsumo(dispInsumo), 1);
    await closeDb(db);
  });

  it('registro EE ausente ≡ saldo zero (mesmos zeros na consulta)', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Sem EE', {
      saldo_fiscal_global: 50,
      saldo_nao_fiscal_global: 50
    });
    const iso = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: prod,
      empresaId: empresaA.id,
      db
    }, { db });
    assert.equal(iso, null);

    const disp = await consultarDisponibilidade(prod, {
      db, empresaId: empresaA.id, modoLegadoSemEmpresa: false
    });
    assert.equal(disp.disponivel_fiscal, 0);
    assert.equal(disp.disponivel_nao_fiscal, 0);

    await setEstoque(db, prod, empresaA.id, 0, 0);
    const isoZero = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: prod,
      empresaId: empresaA.id,
      db
    }, { db });
    assert.ok(isoZero);
    assert.equal(isoZero.saldoFiscal, 0);
    assert.equal(isoZero.saldoNaoFiscal, 0);

    const dispZero = await consultarDisponibilidade(prod, {
      db, empresaId: empresaA.id, modoLegadoSemEmpresa: false
    });
    assert.equal(dispZero.disponivel_fiscal, 0);
    assert.equal(dispZero.disponivel_nao_fiscal, 0);
    await closeDb(db);
  });

  it('PDV emitir_fiscal:false → capacidade NAO_FISCAL; estoque só fiscal aparece como disponível 0', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const prod = await criarProduto(db, 'Refrig só fiscal');
    await setEstoque(db, prod, empresaA.id, 20, 0);
    await setEstoque(db, prod, empresaB.id, 20, 0);

    // Espelho do preview PDV (emitir_fiscal: false + venda_fiscal: false).
    const preview = await avaliarSelecaoEmpresaPdv({
      body: { emitir_fiscal: false, venda_fiscal: false },
      itens: [{ produto_id: prod, quantidade: 1 }]
    }, deps(db));

    assert.equal(preview.tipoSaldo, TipoSaldo.NAO_FISCAL);
    assert.equal(preview.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);

    const gA = preview.capacidade.porEmpresa.find((e) => e.empresaId === empresaA.id);
    assert.equal(gA.gargalos[0].disponivel, 0);
    assert.equal(gA.gargalos[0].tipoSaldo, TipoSaldo.NAO_FISCAL);
    assert.equal(gA.gargalos[0].necessario, 1);

    // Persistido: há 20 fiscal — a “disponibilidade zerada” é do bucket elegível, não do total.
    const row = await persistidoEe(db, prod, empresaA.id);
    assert.equal(Number(row.saldo_fiscal), 20);
    assert.equal(Number(row.estoque_atual), 20);
    await closeDb(db);
  });

  it('cache: hashCarrinho muda com quantidade; segunda avaliação relê estoque (sem cache de saldo)', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const prod = await criarProduto(db, 'Sem cache');
    await setEstoque(db, prod, empresaA.id, 0, 1);
    await setEstoque(db, prod, empresaB.id, 0, 0);

    const r1 = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.NAO_FISCAL
    }, deps(db));
    assert.equal(r1.selecionada.empresaId, empresaA.id);

    await setEstoque(db, prod, empresaA.id, 0, 0);
    const r2 = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: prod, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.NAO_FISCAL
    }, deps(db));
    assert.equal(r2.selecionada, null);
    assert.equal(r2.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    assert.notEqual(r1.meta.hashCarrinho, undefined);
    await closeDb(db);
  });
});
