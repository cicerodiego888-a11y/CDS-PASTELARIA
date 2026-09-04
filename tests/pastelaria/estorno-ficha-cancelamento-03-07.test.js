/**
 * Sprint 03.07 — Estorno total da ficha técnica no cancelamento.
 * Executar: node tests/pastelaria/estorno-ficha-cancelamento-03-07.test.js
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
  estornarConsumoFichaTecnicaDaVenda
} = require('../../backend/services/produtos/FichaTecnicaConsumoService');
const { creditarEstoqueItemVenda } = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
const {
  exigirOperacaoReversaoDaVenda
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
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
    try {
      db.close(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(
    db,
    `CREATE TABLE produtos (
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
      updated_at DATETIME
    )`
  );
  await run(
    db,
    `CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      status TEXT DEFAULT 'concluida',
      cancelada INTEGER DEFAULT 0
    )`
  );
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaVendaFichaConsumoAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, tipo, unidade, saldoProdutos) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [nome, tipo, unidade, saldoProdutos, saldoProdutos]
  );
  return ins.lastID;
}

async function estoque(db, produtoId, empresaId, saldoFiscal) {
  await EstoqueEmpresaService.criarRegistro(
    {
      produtoId,
      empresaId,
      saldo_fiscal: saldoFiscal,
      saldo_nao_fiscal: 0,
      estoque_atual: saldoFiscal
    },
    { db }
  );
}

async function ee(db, produtoId, empresaId) {
  return get(db, 'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [
    produtoId,
    empresaId
  ]);
}

async function setupQueijo() {
  const ctx = await setupBase();
  const { db, empresaA, empresaB } = ctx;
  const comercialId = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', 40);
  const queijoId = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 20);
  await estoque(db, comercialId, empresaA.id, 40);
  await estoque(db, comercialId, empresaB.id, 40);
  await estoque(db, queijoId, empresaA.id, 10);
  await estoque(db, queijoId, empresaB.id, 20);
  await FichaTecnicaService.salvar(
    comercialId,
    {
      ativo: 1,
      itens: [{ insumo_id: queijoId, quantidade: 100, unidade: 'G' }]
    },
    { db }
  );
  const vendaA = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  const vendaB = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaB.id]);
  return {
    ...ctx,
    comercialId,
    queijoId,
    vendaA: vendaA.lastID,
    vendaB: vendaB.lastID
  };
}

async function setupMultiInsumo() {
  const ctx = await setupBase();
  const { db, empresaA } = ctx;
  const comercialId = await criarProduto(db, 'Pastel completo', 'COMERCIAL', 'UN', 20);
  const massaId = await criarProduto(db, 'Massa', 'INSUMO', 'UN', 50);
  const queijoId = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 5);
  const presuntoId = await criarProduto(db, 'Presunto', 'INSUMO', 'KG', 5);
  const oleoId = await criarProduto(db, 'Óleo', 'INSUMO', 'L', 2);
  await estoque(db, comercialId, empresaA.id, 20);
  await estoque(db, massaId, empresaA.id, 50);
  await estoque(db, queijoId, empresaA.id, 5);
  await estoque(db, presuntoId, empresaA.id, 5);
  await estoque(db, oleoId, empresaA.id, 2);
  await FichaTecnicaService.salvar(
    comercialId,
    {
      ativo: 1,
      itens: [
        { insumo_id: massaId, quantidade: 1, unidade: 'UN' },
        { insumo_id: queijoId, quantidade: 80, unidade: 'G' },
        { insumo_id: presuntoId, quantidade: 50, unidade: 'G' },
        { insumo_id: oleoId, quantidade: 300, unidade: 'ML' }
      ]
    },
    { db }
  );
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  return {
    ...ctx,
    comercialId,
    massaId,
    queijoId,
    presuntoId,
    oleoId,
    vendaId: venda.lastID
  };
}

const consumoSrc = src('backend/services/produtos/FichaTecnicaConsumoService.js');
const cancelSrc = src('backend/services/vendas/VendaCancelamentoService.js');
const devolSrc = src('backend/services/vendas/VendaDevolucaoService.js');
const pagSrc = src('backend/services/vendas/VendaPagamentoService.js');
const finSrc = src('backend/services/vendas/VendaFinanceiroService.js');
const rotasSrc = src('backend/rotas/vendas.js');

describe('03.07 T01–T05 consumo e estorno do snapshot', () => {
  it('T01 — venda com ficha consome insumo', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const sal = await ee(db, queijoId, empresaA.id);
    assert.equal(Number(sal.saldo_fiscal), 9.8);
    await closeDb(db);
  });

  it('T02 — cancelamento estorna consumo total', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const r = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      db
    });
    assert.equal(r.estornado, true);
    const sal = await ee(db, queijoId, empresaA.id);
    assert.equal(Number(sal.saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T03 — quantidade estornada corresponde ao snapshot', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const snap = await get(
      db,
      'SELECT quantidade, unidade FROM venda_ficha_consumo_itens WHERE venda_id = ? AND insumo_id = ?',
      [vendaA, queijoId]
    );
    const r = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      db
    });
    assert.equal(Number(r.itens[0].quantidade), Number(snap.quantidade));
    assert.equal(String(r.itens[0].unidade).toUpperCase(), String(snap.unidade).toUpperCase());
    assert.equal(Number(snap.quantidade), 0.2);
    await closeDb(db);
  });

  it('T04 — ficha alterada após venda não altera estorno', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const snap = await get(
      db,
      'SELECT quantidade FROM venda_ficha_consumo_itens WHERE venda_id = ? AND insumo_id = ?',
      [vendaA, queijoId]
    );
    await FichaTecnicaService.salvar(
      comercialId,
      {
        ativo: 1,
        itens: [{ insumo_id: queijoId, quantidade: 500, unidade: 'G' }]
      },
      { db }
    );
    const r = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      db
    });
    assert.equal(Number(r.itens[0].quantidade), Number(snap.quantidade));
    assert.equal(Number(r.itens[0].quantidade), 0.2);
    const sal = await ee(db, queijoId, empresaA.id);
    assert.equal(Number(sal.saldo_fiscal), 10);
    const estornarFn = trecho('estornarConsumoFichaTecnicaDaVenda', consumoSrc);
    assert.doesNotMatch(estornarFn, /obterPorProdutoId|montarLinhasConsumo/);
    await closeDb(db);
  });

  it('T05 — múltiplos insumos são estornados', async () => {
    const { db, comercialId, massaId, queijoId, presuntoId, oleoId, empresaA, vendaId } =
      await setupMultiInsumo();
    const antes = {
      massa: Number((await ee(db, massaId, empresaA.id)).saldo_fiscal),
      queijo: Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal),
      presunto: Number((await ee(db, presuntoId, empresaA.id)).saldo_fiscal),
      oleo: Number((await ee(db, oleoId, empresaA.id)).saldo_fiscal)
    };
    await consumirFichaTecnicaDaVenda({
      vendaId,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }],
      db
    });
    await estornarConsumoFichaTecnicaDaVenda({
      vendaId,
      empresaId: empresaA.id,
      db
    });
    assert.equal(Number((await ee(db, massaId, empresaA.id)).saldo_fiscal), antes.massa);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), antes.queijo);
    assert.equal(Number((await ee(db, presuntoId, empresaA.id)).saldo_fiscal), antes.presunto);
    assert.equal(Number((await ee(db, oleoId, empresaA.id)).saldo_fiscal), antes.oleo);
    await closeDb(db);
  });
});

describe('03.07 T06–T08 falha, sem ficha, sem consumo', () => {
  it('T06 — falha em um insumo gera rollback total', async () => {
    const { db, comercialId, massaId, queijoId, empresaA, vendaId } = await setupMultiInsumo();
    await consumirFichaTecnicaDaVenda({
      vendaId,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }],
      db
    });
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
      await estornarConsumoFichaTecnicaDaVenda(
        { vendaId, empresaId: empresaA.id, db },
        { creditarEstoqueItemVenda: creditarFalhando }
      );
    } catch (e) {
      falhou = true;
      assert.match(String(e.message), /falha forçada/);
    }
    assert.equal(falhou, true);
    await run(db, 'ROLLBACK');
    assert.equal(Number((await ee(db, massaId, empresaA.id)).saldo_fiscal), massaApos);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), queijoApos);
    const cab = await get(db, 'SELECT estornado_em FROM venda_ficha_consumo WHERE venda_id = ?', [vendaId]);
    assert.equal(cab.estornado_em, null);
    const venda = await get(db, 'SELECT status, cancelada FROM vendas WHERE id = ?', [vendaId]);
    assert.equal(venda.status, 'concluida');
    assert.equal(Number(venda.cancelada), 0);
    await closeDb(db);
  });

  it('T07 — venda sem ficha continua cancelável (estorno no-op)', async () => {
    const ctx = await setupBase();
    const { db, empresaA } = ctx;
    const id = await criarProduto(db, 'Água', 'COMERCIAL', 'UN', 10);
    await estoque(db, id, empresaA.id, 10);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    const cons = await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID,
      empresaId: empresaA.id,
      itens: [{ produto_id: id, quantidade: 1 }],
      db
    });
    assert.equal(cons.consumido, false);
    const r = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: venda.lastID,
      empresaId: empresaA.id,
      db
    });
    assert.equal(r.sem_consumo, true);
    assert.equal(r.estornado, false);
    assert.equal(Number((await ee(db, id, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T08 — ausência de consumo não gera estorno artificial', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo();
    const antes = Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal);
    const r = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      db
    });
    assert.equal(r.sem_consumo, true);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), antes);
    const cab = await get(db, 'SELECT id FROM venda_ficha_consumo WHERE venda_id = ?', [vendaA]);
    assert.equal(cab, null);
    const estornarFn = trecho('estornarConsumoFichaTecnicaDaVenda', consumoSrc);
    assert.doesNotMatch(estornarFn, /INSERT INTO venda_ficha_consumo/);
    void comercialId;
    await closeDb(db);
  });
});

describe('03.07 T09–T15 empresa, multiempresa, idempotência', () => {
  it('T09 — cancelamento utiliza empresa_id da venda', async () => {
    const { db, comercialId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const r = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      db
    });
    assert.equal(Number(r.empresa_id), empresaA.id);
    const cab = await get(db, 'SELECT empresa_id FROM venda_ficha_consumo WHERE venda_id = ?', [vendaA]);
    assert.equal(Number(cab.empresa_id), empresaA.id);
    const wrapper = trecho('devolverEstoqueEEstornarFichaDaVenda', cancelSrc);
    assert.match(wrapper, /montarOpcoesRetornoEstoqueDaVenda\(venda/);
    assert.match(wrapper, /exigirEmpresa: true|opcoes\.empresaId/);
    assert.doesNotMatch(consumoSrc, /req\.empresaId/);
    await closeDb(db);
  });

  it('T10 — Empresa A não altera estoque da Empresa B', async () => {
    const { db, comercialId, queijoId, empresaA, empresaB, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const bAntes = Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal);
    await estornarConsumoFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      db
    });
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), bAntes);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T11 — Empresa B não consegue cancelar venda da Empresa A', async () => {
    const { db, comercialId, queijoId, empresaA, empresaB, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const aApos = Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal);
    const bApos = Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal);
    const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaA]);
    assert.throws(
      () => exigirOperacaoReversaoDaVenda(venda, empresaB.id),
      (e) => e.code === 'VENDA_NAO_ENCONTRADA'
    );
    await assert.rejects(
      () => estornarConsumoFichaTecnicaDaVenda({
        vendaId: vendaA,
        empresaId: empresaB.id,
        db
      }),
      (e) => e.code === 'FICHA_CONSUMO_EMPRESA_DIVERGENTE'
    );
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), aApos);
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), bApos);
    const cab = await get(db, 'SELECT estornado_em FROM venda_ficha_consumo WHERE venda_id = ?', [vendaA]);
    assert.equal(cab.estornado_em, null);
    const st = await get(db, 'SELECT status FROM vendas WHERE id = ?', [vendaA]);
    assert.equal(st.status, 'concluida');
    await closeDb(db);
  });

  it('T12 — segundo cancelamento não duplica estorno', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    await estornarConsumoFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      db
    });
    const r2 = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      db
    });
    assert.equal(r2.ja_estornado, true);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T13 — reexecução não duplica estorno', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    const cab = await get(db, 'SELECT estornado_em FROM venda_ficha_consumo WHERE venda_id = ?', [vendaA]);
    assert.ok(cab.estornado_em);
    await closeDb(db);
  });

  it('T14 — venda já cancelada não gera novo crédito', async () => {
    assert.match(cancelSrc, /Venda já cancelada|status !== 'concluida'/);
    const putFn = trecho('cancelarVendaPut', cancelSrc);
    const postStart = cancelSrc.indexOf('function cancelarVendaPost');
    const postFn = postStart >= 0 ? cancelSrc.slice(postStart) : '';
    assert.ok(putFn.indexOf("status !== 'concluida'") < putFn.indexOf('devolverEstoqueEEstornarFichaDaVenda'));
    assert.ok(postFn.indexOf('Venda já cancelada') < postFn.indexOf('devolverEstoqueEEstornarFichaDaVenda'));
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    await run(db, `UPDATE vendas SET status = 'cancelada', cancelada = 1 WHERE id = ?`, [vendaA]);
    const r = await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    assert.equal(r.ja_estornado, true);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T15 — nenhuma mutação ocorre em cross-company', async () => {
    const { db, comercialId, queijoId, empresaA, empresaB, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const a = Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal);
    const b = Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal);
    const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaA]);
    assert.throws(() => exigirOperacaoReversaoDaVenda(venda, empresaB.id));
    try {
      await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaB.id, db });
    } catch (_e) { /* bloqueado */ }
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), a);
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), b);
    const st = await get(db, 'SELECT status, cancelada FROM vendas WHERE id = ?', [vendaA]);
    assert.equal(st.status, 'concluida');
    assert.equal(Number(st.cancelada), 0);
    await closeDb(db);
  });
});

describe('03.07 T16–T20 fiscal, MUV, fluxo, rollback, saldo', () => {
  it('T16 — financeiro/caixa não recebem lançamento adicional da ficha', () => {
    const estornarFn = trecho('estornarConsumoFichaTecnicaDaVenda', consumoSrc);
    assert.doesNotMatch(estornarFn, /INSERT INTO financeiro|contas_receber|caixa_sessoes|tef/i);
    assert.match(cancelSrc, /cancelarFinanceiroVenda/);
    assert.doesNotMatch(finSrc, /venda_ficha_consumo|estornarConsumoFicha/);
  });

  it('T17 — MUV não é acionado', () => {
    const estornarFn = trecho('estornarConsumoFichaTecnicaDaVenda', consumoSrc);
    assert.doesNotMatch(estornarFn, /criarAtendimento|MotorMuv|muv\./i);
    assert.doesNotMatch(consumoSrc, /require\('\.\.\/\.\.\/motores\/muv/);
    assert.doesNotMatch(pagSrc, /criarAtendimento/);
  });

  it('T18 — cancelamento continua seguindo fluxo fiscal existente', () => {
    assert.match(cancelSrc, /cancelarNfceAutorizadaVenda/);
    const idxFiscal = cancelSrc.indexOf('cancelarNfceAutorizadaVenda');
    const idxBegin = cancelSrc.indexOf('BEGIN IMMEDIATE');
    assert.ok(idxFiscal >= 0 && idxBegin > idxFiscal);
    assert.match(rotasSrc, /cancelarVendaPut/);
    assert.match(rotasSrc, /cancelarVendaPost/);
    assert.doesNotMatch(devolSrc, /estornarConsumoFichaTecnicaDaVenda/);
  });

  it('T19 — venda permanece não cancelada quando estorno falha', async () => {
    const idxEst = cancelSrc.indexOf('devolverEstoqueEEstornarFichaDaVenda');
    const idxUp = cancelSrc.indexOf("status = 'cancelada'");
    assert.ok(idxEst >= 0 && idxEst < idxUp);
    const { db, comercialId, empresaA, vendaA } = await setupQueijo();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    await run(db, 'BEGIN IMMEDIATE');
    try {
      await estornarConsumoFichaTecnicaDaVenda(
        { vendaId: vendaA, empresaId: empresaA.id, db },
        {
          creditarEstoqueItemVenda: (_c, _d, cb) => cb(new Error('falha estorno'))
        }
      );
    } catch (_e) { /* esperado */ }
    await run(db, 'ROLLBACK');
    const st = await get(db, 'SELECT status, cancelada FROM vendas WHERE id = ?', [vendaA]);
    assert.equal(st.status, 'concluida');
    assert.equal(Number(st.cancelada), 0);
    await closeDb(db);
  });

  it('T20 — estoque retorna exatamente ao saldo esperado', async () => {
    const { db, comercialId, queijoId, empresaA, empresaB, vendaA, vendaB } = await setupQueijo();
    const { obterMuc } = require('../../backend/motores/muc/public');
    const conv = obterMuc(null).converterQuantidade({
      quantidade: 200, unidadeOrigem: 'G', unidadeDestino: 'KG'
    }).quantidade;
    assert.equal(Number(conv), 0.2);
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaB,
      empresaId: empresaB.id,
      itens: [{ produto_id: comercialId, quantidade: 3 }],
      db
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.8);
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), 19.7);
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), 19.7);
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaB, empresaId: empresaB.id, db });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), 20);
    assert.match(consumoSrc, /estorno_ficha_tecnica_cancelamento/);
    assert.match(consumoSrc, /creditarEstoqueItemVenda/);
    assert.equal((cancelSrc.match(/devolverEstoqueEEstornarFichaDaVenda\(itens, venda, req, db,/g) || []).length, 2);
    await closeDb(db);
  });
});
