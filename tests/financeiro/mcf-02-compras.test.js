'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const CompraContasPagarMcfService = require('../../backend/services/compras/CompraContasPagarMcfService');

function abrirDb() {
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

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function setup() {
  const db = await abrirDb();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf_cnpj TEXT
  )`);
  await run(db, `CREATE TABLE compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL
  )`);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT,
    categoria TEXT, forma_pagamento TEXT, referencia_id INTEGER,
    referencia_tipo TEXT, status TEXT, origem TEXT, documento TEXT,
    vencimento TEXT, numero_parcela INTEGER, total_parcelas INTEGER,
    compra_id INTEGER, venda_id INTEGER, pessoa_nome TEXT, observacao TEXT,
    baixado_em TEXT, empresa_id INTEGER
  )`);
  await garantirSchemaMcfAsync(db);
  const empresa = await EmpresaService.criarEmpresa({
    cnpj: '11222333000181',
    razao_social: 'Compra MCF Isolada'
  }, { db });
  return { db, empresa };
}

function dentroDeTransacao(db, fn) {
  return new Promise((resolve, reject) => {
    db.run('BEGIN IMMEDIATE', async (beginErr) => {
      if (beginErr) return reject(beginErr);
      try {
        const result = await fn();
        db.run('COMMIT', (commitErr) => (commitErr ? reject(commitErr) : resolve(result)));
      } catch (err) {
        db.run('ROLLBACK', (rollbackErr) => {
          if (rollbackErr) {
            err.rollbackError = rollbackErr;
          }
          reject(err);
        });
      }
    });
  });
}

describe('MCF-02 — títulos de compras', () => {
  it('cria um título por parcela, projeta para MBC e repete sem duplicar', async () => {
    const ctx = await setup();
    const parcelas = [
      {
        numero_parcela: 1,
        valor: 40,
        data_vencimento: '2026-11-10',
        documento: 'NF-100',
        pagar_agora: true
      },
      {
        numero_parcela: 2,
        valor: 60,
        data_vencimento: '2026-12-10',
        documento: 'NF-100',
        pagar_agora: false
      }
    ];
    const executar = () => dentroDeTransacao(ctx.db, async () => {
      const compra = await run(
        ctx.db,
        'INSERT INTO compras (empresa_id) VALUES (?)',
        [ctx.empresa.id]
      );
      const parametros = {
        db: ctx.db,
        compra_id: compra.lastID,
        empresa_id: ctx.empresa.id,
        data_emissao: '2026-10-25',
        documento: 'NF-100',
        forma_pagamento: 'dinheiro',
        usuario_id: 9,
        parcelas
      };
      const criados = await CompraContasPagarMcfService.criarTitulosMcfCompra(parametros);
      const repetidos = await CompraContasPagarMcfService.criarTitulosMcfCompra(parametros);
      return { criados, repetidos };
    });
    const { criados, repetidos } = await executar();
    assert.equal(criados.length, 2);
    assert.deepEqual(repetidos.map((titulo) => titulo.id), criados.map((titulo) => titulo.id));
    assert.ok(repetidos.every((titulo) => titulo.idempotente));

    const rows = await new Promise((resolve, reject) => {
      ctx.db.all(
        `SELECT * FROM contas_pagar WHERE empresa_id = ? ORDER BY numero_parcela`,
        [ctx.empresa.id],
        (err, result) => (err ? reject(err) : resolve(result))
      );
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].numero_parcela, 1);
    assert.equal(rows[0].total_parcelas, 2);
    assert.equal(rows[0].valor_original, 40);
    assert.equal(rows[0].valor_restante, 0);
    assert.equal(rows[0].status, 'quitada');
    assert.equal(rows[1].numero_parcela, 2);
    assert.equal(rows[1].valor_original, 60);
    assert.equal(rows[1].valor_restante, 60);
    const pagamento = await get(
      ctx.db,
      'SELECT valor_pago, usuario_id, origem_operacao FROM contas_pagar_pagamentos WHERE conta_pagar_id = ?',
      [rows[0].id]
    );
    assert.deepEqual(pagamento, {
      valor_pago: 40,
      usuario_id: 9,
      origem_operacao: 'compra'
    });
    assert.equal(
      Number((await get(ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat')).n),
      2
    );
    assert.equal(
      Number((await get(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro WHERE origem = ?', [
        'mcf_compatibilidade'
      ])).n),
      2
    );
    await close(ctx.db);
  });

  it('reverte compra, títulos, pagamentos e projeções se uma parcela falhar', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => dentroDeTransacao(ctx.db, async () => {
        const compra = await run(
          ctx.db,
          'INSERT INTO compras (empresa_id) VALUES (?)',
          [ctx.empresa.id]
        );
        return CompraContasPagarMcfService.criarTitulosMcfCompra({
          db: ctx.db,
          compra_id: compra.lastID,
          empresa_id: ctx.empresa.id,
          data_emissao: '2026-10-25',
          usuario_id: 9,
          parcelas: [
            { numero_parcela: 1, valor: 40, data_vencimento: '2026-11-10' },
            { numero_parcela: 2, valor: 60, data_vencimento: 'data-invalida' }
          ]
        });
      }),
      /data_vencimento inválida/
    );
    for (const tabela of [
      'compras',
      'contas_pagar',
      'contas_pagar_pagamentos',
      'contas_pagar_financeiro_compat',
      'financeiro'
    ]) {
      assert.equal(Number((await get(ctx.db, `SELECT COUNT(*) AS n FROM ${tabela}`)).n), 0, tabela);
    }
    await close(ctx.db);
  });
});
