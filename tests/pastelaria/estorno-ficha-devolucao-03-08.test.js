/**
 * Sprint 03.08 — Estorno proporcional da ficha técnica na devolução.
 * Executar: node tests/pastelaria/estorno-ficha-devolucao-03-08.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaVendaFichaConsumoAsync } = require('../../backend/services/produtos/vendaFichaConsumoSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  consumirFichaTecnicaDaVenda,
  estornarConsumoFichaTecnicaDaDevolucao
} = require('../../backend/services/produtos/FichaTecnicaConsumoService');
const { creditarEstoqueItemVenda } = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
const { exigirOperacaoReversaoDaVenda } = require('../../backend/services/vendas/VendaEmpresaContextoService');
const MotorUM = require('../../backend/services/unidades/MotorUnidadesMedida');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function trecho(fnName, fileSrc) {
  const re = new RegExp(`(?:async )?function ${fnName}\\([\\s\\S]*?\\n(?=(?:async )?function )`);
  const m = fileSrc.match(re);
  return m ? m[0] : '';
}

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
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, ativo INTEGER DEFAULT 1,
    unidade TEXT DEFAULT 'UN', tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
    saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0,
    reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0, controla_estoque INTEGER DEFAULT 1, updated_at DATETIME
  )`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, status TEXT DEFAULT 'concluida', cancelada INTEGER DEFAULT 0
  )`);
  await run(db, `CREATE TABLE vendas_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, produto_id INTEGER, quantidade REAL
  )`);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaVendaFichaConsumoAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, tipo, unidade, saldo) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [nome, tipo, unidade, saldo, saldo]
  );
  return ins.lastID;
}

async function estoque(db, produtoId, empresaId, saldoFiscal) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId, saldo_fiscal: saldoFiscal, saldo_nao_fiscal: 0, estoque_atual: saldoFiscal
  }, { db });
}

async function ee(db, produtoId, empresaId) {
  return get(db, 'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [produtoId, empresaId]);
}

async function itemVenda(db, vendaId, produtoId, qtd) {
  const r = await run(db, 'INSERT INTO vendas_itens (venda_id, produto_id, quantidade) VALUES (?, ?, ?)', [
    vendaId, produtoId, qtd
  ]);
  return r.lastID;
}

async function setupQueijo(qtdVenda = 10) {
  const ctx = await setupBase();
  const { db, empresaA, empresaB } = ctx;
  const comercialId = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', 40);
  const queijoId = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 20);
  await estoque(db, comercialId, empresaA.id, 40);
  await estoque(db, comercialId, empresaB.id, 40);
  await estoque(db, queijoId, empresaA.id, 10);
  await estoque(db, queijoId, empresaB.id, 20);
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [{ insumo_id: queijoId, quantidade: 100, unidade: 'G' }]
  }, { db });
  const vendaA = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  const vendaB = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaB.id]);
  await itemVenda(db, vendaA.lastID, comercialId, qtdVenda);
  await itemVenda(db, vendaB.lastID, comercialId, qtdVenda);
  return { ...ctx, comercialId, queijoId, vendaA: vendaA.lastID, vendaB: vendaB.lastID, qtdVenda };
}

async function consumir(db, vendaId, empresaId, comercialId, qtd) {
  return consumirFichaTecnicaDaVenda({
    vendaId, empresaId, itens: [{ produto_id: comercialId, quantidade: qtd }], db
  });
}

async function devolver(db, opts) {
  return estornarConsumoFichaTecnicaDaDevolucao({
    vendaId: opts.vendaId,
    empresaId: opts.empresaId,
    produtoId: opts.produtoId,
    quantidadeDevolvida: opts.qtd,
    quantidadeVendida: opts.qtdVendida,
    vendaDevolucaoId: opts.devolucaoId,
    db
  }, opts.deps);
}

const consumoSrc = src('backend/services/produtos/FichaTecnicaConsumoService.js');
const devolSrc = src('backend/services/vendas/VendaDevolucaoService.js');
const cancelSrc = src('backend/services/vendas/VendaCancelamentoService.js');
const finSrc = src('backend/services/vendas/VendaFinanceiroService.js');
const rotasSrc = src('backend/rotas/vendas.js');
const centralJs = src('frontend/erp/js/central-entradas.js');
const pdvUni = src('backend/rotas/pdv-universal.js');

describe('03.08 T01–T06 proporcional e snapshot', () => {
  it('T01 — devolução parcial estorna proporcionalmente', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(10);
    await consumir(db, vendaA, empresaA.id, comercialId, 10);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9);
    const r = await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 3, qtdVendida: 10, devolucaoId: 1
    });
    assert.equal(Number(r.itens[0].quantidade), 0.3);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.3);
    await closeDb(db);
  });

  it('T02 — devolução de 1 item em venda de vários calcula corretamente', async () => {
    const ctx = await setupQueijo(10);
    const { db, comercialId, queijoId, empresaA, vendaA } = ctx;
    const aguaId = await criarProduto(db, 'Água', 'COMERCIAL', 'UN', 20);
    await estoque(db, aguaId, empresaA.id, 20);
    await itemVenda(db, vendaA, aguaId, 2);
    await consumir(db, vendaA, empresaA.id, comercialId, 10);
    const queijoApos = Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal);
    const agua = await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: aguaId, qtd: 1, qtdVendida: 2, devolucaoId: 11
    });
    assert.equal(agua.sem_consumo_produto || agua.estornado === false, true);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), queijoApos);
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 1, qtdVendida: 10, devolucaoId: 12
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), queijoApos + 0.1);
    await closeDb(db);
  });

  it('T03 — devolução de múltiplos itens calcula corretamente', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(10);
    await consumir(db, vendaA, empresaA.id, comercialId, 10);
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 2, qtdVendida: 10, devolucaoId: 21
    });
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 1, qtdVendida: 10, devolucaoId: 22
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.3);
    await closeDb(db);
  });

  it('T04 — estorno usa snapshot da venda', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(5);
    await consumir(db, vendaA, empresaA.id, comercialId, 5);
    const snap = await get(db, 'SELECT quantidade FROM venda_ficha_consumo_itens WHERE venda_id = ?', [vendaA]);
    const r = await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 2, qtdVendida: 5, devolucaoId: 31
    });
    assert.equal(Number(r.itens[0].quantidade), Number((Number(snap.quantidade) * 2 / 5).toFixed(3)));
    await closeDb(db);
  });

  it('T05 — alteração posterior da ficha não altera o estorno', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(5);
    await consumir(db, vendaA, empresaA.id, comercialId, 5);
    await FichaTecnicaService.salvar(comercialId, {
      ativo: 1,
      itens: [{ insumo_id: queijoId, quantidade: 500, unidade: 'G' }]
    }, { db });
    const r = await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 2, qtdVendida: 5, devolucaoId: 41
    });
    assert.equal(Number(r.itens[0].quantidade), 0.2);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.7);
    await closeDb(db);
  });

  it('T06 — múltiplos insumos são estornados proporcionalmente', async () => {
    const ctx = await setupBase();
    const { db, empresaA } = ctx;
    const comercialId = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', 20);
    const massaId = await criarProduto(db, 'Massa', 'INSUMO', 'UN', 50);
    const queijoId = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 5);
    const oleoId = await criarProduto(db, 'Óleo', 'INSUMO', 'L', 2);
    await estoque(db, comercialId, empresaA.id, 20);
    await estoque(db, massaId, empresaA.id, 50);
    await estoque(db, queijoId, empresaA.id, 5);
    await estoque(db, oleoId, empresaA.id, 2);
    await FichaTecnicaService.salvar(comercialId, {
      ativo: 1,
      itens: [
        { insumo_id: massaId, quantidade: 1, unidade: 'UN' },
        { insumo_id: queijoId, quantidade: 80, unidade: 'G' },
        { insumo_id: oleoId, quantidade: 300, unidade: 'ML' }
      ]
    }, { db });
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await itemVenda(db, venda.lastID, comercialId, 4);
    const antes = {
      massa: Number((await ee(db, massaId, empresaA.id)).saldo_fiscal),
      queijo: Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal),
      oleo: Number((await ee(db, oleoId, empresaA.id)).saldo_fiscal)
    };
    await consumir(db, venda.lastID, empresaA.id, comercialId, 4);
    await devolver(db, {
      vendaId: venda.lastID, empresaId: empresaA.id, produtoId: comercialId, qtd: 1, qtdVendida: 4, devolucaoId: 51
    });
    assert.equal(Number((await ee(db, massaId, empresaA.id)).saldo_fiscal), antes.massa - 3);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), Number((antes.queijo - 0.24).toFixed(3)));
    assert.equal(Number((await ee(db, oleoId, empresaA.id)).saldo_fiscal), Number((antes.oleo - 0.9).toFixed(3)));
    await closeDb(db);
  });
});

describe('03.08 T07–T13 limite, sucessivas, sem ficha, inativa', () => {
  it('T07 — quantidade total estornada nunca supera o consumo original', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(10);
    await consumir(db, vendaA, empresaA.id, comercialId, 10);
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 8, qtdVendida: 10, devolucaoId: 61
    });
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 8, qtdVendida: 10, devolucaoId: 62
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    const tot = await get(db, 'SELECT SUM(quantidade) AS q FROM venda_ficha_consumo_estornos WHERE venda_id = ?', [vendaA]);
    assert.ok(Number(tot.q) <= 1 + 1e-9);
    await closeDb(db);
  });

  it('T08 — duas devoluções sucessivas acumulam corretamente', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(10);
    await consumir(db, vendaA, empresaA.id, comercialId, 10);
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 3, qtdVendida: 10, devolucaoId: 71
    });
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 2, qtdVendida: 10, devolucaoId: 72
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.5);
    await closeDb(db);
  });

  it('T09 — três devoluções sucessivas fecham exatamente o consumo', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(10);
    await consumir(db, vendaA, empresaA.id, comercialId, 10);
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 3, qtdVendida: 10, devolucaoId: 81
    });
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 2, qtdVendida: 10, devolucaoId: 82
    });
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 5, qtdVendida: 10, devolucaoId: 83
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T10 — mesma devolução reprocessada não duplica estorno', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(5);
    await consumir(db, vendaA, empresaA.id, comercialId, 5);
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 2, qtdVendida: 5, devolucaoId: 91
    });
    const r2 = await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 2, qtdVendida: 5, devolucaoId: 91
    });
    assert.equal(r2.ja_estornado, true);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.7);
    await closeDb(db);
  });

  it('T11 — devolução total estorna 100% do consumo', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(10);
    await consumir(db, vendaA, empresaA.id, comercialId, 10);
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 10, qtdVendida: 10, devolucaoId: 101
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T12 — venda sem ficha continua funcionando', async () => {
    const ctx = await setupBase();
    const { db, empresaA } = ctx;
    const id = await criarProduto(db, 'Água', 'COMERCIAL', 'UN', 10);
    await estoque(db, id, empresaA.id, 10);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await itemVenda(db, venda.lastID, id, 2);
    const cons = await consumir(db, venda.lastID, empresaA.id, id, 2);
    assert.equal(cons.consumido, false);
    const r = await devolver(db, {
      vendaId: venda.lastID, empresaId: empresaA.id, produtoId: id, qtd: 1, qtdVendida: 2, devolucaoId: 111
    });
    assert.equal(r.sem_consumo, true);
    assert.equal(Number((await ee(db, id, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T13 — ficha posteriormente inativa não impede estorno', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo(4);
    await consumir(db, vendaA, empresaA.id, comercialId, 4);
    await FichaTecnicaService.salvar(comercialId, { ativo: 0, itens: [] }, { db });
    const r = await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 1, qtdVendida: 4, devolucaoId: 121
    });
    assert.equal(r.estornado, true);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.7);
    await closeDb(db);
  });
});

describe('03.08 T14–T19 empresa, rollback', () => {
  it('T14 — empresa da venda determina estoque', async () => {
    const { db, comercialId, empresaA, vendaA } = await setupQueijo(10);
    await consumir(db, vendaA, empresaA.id, comercialId, 10);
    const r = await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 3, qtdVendida: 10, devolucaoId: 131
    });
    assert.equal(Number(r.empresa_id), empresaA.id);
    assert.match(devolSrc, /montarOpcoesRetornoEstoqueDaVenda\(venda/);
    assert.match(devolSrc, /opcoesEstoque\.empresaId/);
    await closeDb(db);
  });

  it('T15 — Empresa A não altera estoque da Empresa B', async () => {
    const { db, comercialId, queijoId, empresaA, empresaB, vendaA } = await setupQueijo(5);
    await consumir(db, vendaA, empresaA.id, comercialId, 5);
    const bAntes = Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal);
    await devolver(db, {
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId, qtd: 5, qtdVendida: 5, devolucaoId: 141
    });
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), bAntes);
    await closeDb(db);
  });

  it('T16 — cross-company bloqueia', async () => {
    const { db, comercialId, queijoId, empresaA, empresaB, vendaA } = await setupQueijo(5);
    await consumir(db, vendaA, empresaA.id, comercialId, 5);
    const a = Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal);
    const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaA]);
    assert.throws(() => exigirOperacaoReversaoDaVenda(venda, empresaB.id), (e) => e.code === 'VENDA_NAO_ENCONTRADA');
    await assert.rejects(
      () => devolver(db, {
        vendaId: vendaA, empresaId: empresaB.id, produtoId: comercialId, qtd: 1, qtdVendida: 5, devolucaoId: 151
      }),
      (e) => e.code === 'FICHA_CONSUMO_EMPRESA_DIVERGENTE'
    );
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), a);
    await closeDb(db);
  });

  it('T17 — cross-company não altera status', async () => {
    const { db, comercialId, empresaA, empresaB, vendaA } = await setupQueijo(5);
    await consumir(db, vendaA, empresaA.id, comercialId, 5);
    const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaA]);
    assert.throws(() => exigirOperacaoReversaoDaVenda(venda, empresaB.id));
    try {
      await devolver(db, {
        vendaId: vendaA, empresaId: empresaB.id, produtoId: comercialId, qtd: 1, qtdVendida: 5, devolucaoId: 161
      });
    } catch (_e) { /* bloqueado */ }
    const st = await get(db, 'SELECT status, cancelada FROM vendas WHERE id = ?', [vendaA]);
    assert.equal(st.status, 'concluida');
    assert.equal(Number(st.cancelada), 0);
    await closeDb(db);
  });

  it('T18 — falha em um insumo gera rollback total', async () => {
    const ctx = await setupBase();
    const { db, empresaA } = ctx;
    const comercialId = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', 20);
    const massaId = await criarProduto(db, 'Massa', 'INSUMO', 'UN', 50);
    const queijoId = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 5);
    await estoque(db, comercialId, empresaA.id, 20);
    await estoque(db, massaId, empresaA.id, 50);
    await estoque(db, queijoId, empresaA.id, 5);
    await FichaTecnicaService.salvar(comercialId, {
      ativo: 1,
      itens: [
        { insumo_id: massaId, quantidade: 1, unidade: 'UN' },
        { insumo_id: queijoId, quantidade: 100, unidade: 'G' }
      ]
    }, { db });
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await itemVenda(db, venda.lastID, comercialId, 2);
    await consumir(db, venda.lastID, empresaA.id, comercialId, 2);
    const massaApos = Number((await ee(db, massaId, empresaA.id)).saldo_fiscal);
    const queijoApos = Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal);
    let n = 0;
    const creditarFalhando = (cnn, dados, cb) => {
      n += 1;
      if (n === 2) return cb(new Error('falha forçada insumo'));
      creditarEstoqueItemVenda(cnn, dados, cb);
    };
    await run(db, 'BEGIN IMMEDIATE');
    let falhou = false;
    try {
      await estornarConsumoFichaTecnicaDaDevolucao({
        vendaId: venda.lastID,
        empresaId: empresaA.id,
        produtoId: comercialId,
        quantidadeDevolvida: 1,
        quantidadeVendida: 2,
        vendaDevolucaoId: 171,
        db
      }, { creditarEstoqueItemVenda: creditarFalhando });
    } catch (e) {
      falhou = true;
      assert.match(String(e.message), /falha forçada/);
    }
    assert.equal(falhou, true);
    await run(db, 'ROLLBACK');
    assert.equal(Number((await ee(db, massaId, empresaA.id)).saldo_fiscal), massaApos);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), queijoApos);
    await closeDb(db);
  });

  it('T19 — devolução e estorno são atômicos', () => {
    assert.match(devolSrc, /BEGIN IMMEDIATE/);
    assert.match(devolSrc, /estornarConsumoFichaTecnicaDaDevolucaoCb/);
    assert.match(devolSrc, /fichaErr[\s\S]{0,80}ROLLBACK/);
    const post = devolSrc.slice(devolSrc.indexOf('function devolverParcial'));
    const idxInsert = post.indexOf('INSERT INTO vendas_devolucoes');
    const idxFicha = post.indexOf('estornarConsumoFichaTecnicaDaDevolucaoCb');
    const idxCommit = post.indexOf("db.run('COMMIT')");
    assert.ok(idxInsert < idxFicha && idxFicha < idxCommit);
  });
});

describe('03.08 T20–T25 unidades, ficha atual, financeiro, MUV, Central, Universal', () => {
  it('T20 — conversão/unidade preservada', async () => {
    const ctx = await setupBase();
    const { db, empresaA } = ctx;
    const comercialId = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', 20);
    const oleoId = await criarProduto(db, 'Óleo', 'INSUMO', 'L', 5);
    await estoque(db, comercialId, empresaA.id, 20);
    await estoque(db, oleoId, empresaA.id, 5);
    await FichaTecnicaService.salvar(comercialId, {
      ativo: 1,
      itens: [{ insumo_id: oleoId, quantidade: 300, unidade: 'ML' }]
    }, { db });
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await itemVenda(db, venda.lastID, comercialId, 3);
    await consumir(db, venda.lastID, empresaA.id, comercialId, 3);
    const { obterMuc } = require('../../backend/motores/muc/public');
    const conv = obterMuc(null).converterQuantidade({
      quantidade: 300, unidadeOrigem: 'ML', unidadeDestino: 'L'
    }).quantidade;
    assert.equal(Number(conv), 0.3);
    const r = await devolver(db, {
      vendaId: venda.lastID, empresaId: empresaA.id, produtoId: comercialId, qtd: 1, qtdVendida: 3, devolucaoId: 201
    });
    assert.equal(Number(r.itens[0].quantidade), 0.3);
    assert.equal(String(r.itens[0].unidade).toUpperCase(), 'L');
    await closeDb(db);
  });

  it('T21 — não usa ficha técnica atual', () => {
    const fn = trecho('estornarConsumoFichaTecnicaDaDevolucao', consumoSrc);
    assert.doesNotMatch(fn, /obterPorProdutoId|montarLinhasConsumo/);
    assert.match(fn, /venda_ficha_consumo_itens/);
  });

  it('T22 — não gera lançamento financeiro adicional', () => {
    const fn = trecho('estornarConsumoFichaTecnicaDaDevolucao', consumoSrc);
    assert.doesNotMatch(fn, /INSERT INTO financeiro|contas_receber|caixa/i);
    assert.doesNotMatch(finSrc, /venda_ficha_consumo_estornos|estornarConsumoFichaTecnicaDaDevolucao/);
    assert.match(devolSrc, /recalcularFinanceiroDevolucaoVenda/);
  });

  it('T23 — não chama MUV', () => {
    const fn = trecho('estornarConsumoFichaTecnicaDaDevolucao', consumoSrc);
    assert.doesNotMatch(fn, /criarAtendimento|MotorMuv|muv\./i);
    assert.doesNotMatch(consumoSrc, /require\('\.\.\/\.\.\/motores\/muv/);
  });

  it('T24 — não altera Central', () => {
    assert.doesNotMatch(devolSrc, /central-entradas|CentralEntradas/);
    assert.doesNotMatch(consumoSrc, /central-entradas/);
    assert.match(rotasSrc, /router\.post\('\/:id\/devolver'/);
    assert.ok(centralJs.includes('loadCentralEntradas'));
  });

  it('T25 — não altera PDV Universal', () => {
    assert.match(pdvUni, /CONGELADO|congelado/i);
    assert.doesNotMatch(devolSrc, /pdv-universal|PDVUniversal/);
    assert.doesNotMatch(consumoSrc, /pdv-universal/);
    assert.match(cancelSrc, /estornarConsumoFichaTecnicaDaVendaCb/);
  });
});
