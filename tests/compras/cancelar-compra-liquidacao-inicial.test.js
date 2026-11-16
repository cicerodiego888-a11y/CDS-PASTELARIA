/**
 * Cancelamento de compra com título quitado por liquidação inicial (avista/sem_pagamento).
 * Executar: node --test tests/compras/cancelar-compra-liquidacao-inicial.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const ContasPagarService = require('../../backend/motores/mcf/services/ContasPagarService');
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
    razao_social: 'Cancel Compra MCF'
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
        db.run('ROLLBACK', () => reject(err));
      }
    });
  });
}

describe('cancelar compra — estorno liquidação inicial', () => {
  it('estorna pagamento-inicial e permite cancelar título quitado', async () => {
    const ctx = await setup();
    await dentroDeTransacao(ctx.db, async () => {
      const compra = await run(ctx.db, 'INSERT INTO compras (empresa_id) VALUES (?)', [ctx.empresa.id]);
      const compraId = compra.lastID;
      await CompraContasPagarMcfService.criarTitulosMcfCompra({
        db: ctx.db,
        compra_id: compraId,
        empresa_id: ctx.empresa.id,
        data_emissao: '2026-11-16',
        documento: 'NF-1',
        forma_pagamento: 'sem_pagamento',
        usuario_id: 1,
        parcelas: [{
          numero_parcela: 1,
          valor: 1859.51,
          data_vencimento: '2026-11-16',
          documento: 'NF-1',
          pagar_agora: true,
          descricao: `Compra ${compraId} - Parcela 1/1`
        }]
      });

      const titulo = await get(
        ctx.db,
        `SELECT id, status, valor_restante FROM contas_pagar
         WHERE referencia_tipo='compra' AND referencia_id=?`,
        [compraId]
      );
      assert.equal(titulo.status, 'quitada');

      await ContasPagarService.estornarBaixasIniciaisCompraNaTransacaoAtual({
        db: ctx.db,
        empresaId: ctx.empresa.id,
        id: titulo.id,
        compra_id: compraId
      });
      const reaberto = await get(ctx.db, 'SELECT status, valor_restante FROM contas_pagar WHERE id=?', [titulo.id]);
      assert.equal(reaberto.status, 'aberto');
      assert.equal(Number(reaberto.valor_restante), 1859.51);

      await ContasPagarService.cancelarNaTransacaoAtual({
        db: ctx.db,
        empresaId: ctx.empresa.id,
        id: titulo.id,
        motivo: `Cancelamento da compra ${compraId}: teste`,
        idempotency_key: `compra:${compraId}:cancelamento:1`,
        usuario_id: 1
      });
      const cancelado = await get(ctx.db, 'SELECT status FROM contas_pagar WHERE id=?', [titulo.id]);
      assert.equal(cancelado.status, 'cancelada');
    });
    await close(ctx.db);
  });

  it('bloqueia se existir baixa manual além da liquidação inicial', async () => {
    const ctx = await setup();
    let bloqueou = false;
    await dentroDeTransacao(ctx.db, async () => {
      const compra = await run(ctx.db, 'INSERT INTO compras (empresa_id) VALUES (?)', [ctx.empresa.id]);
      const compraId = compra.lastID;
      const titulos = await CompraContasPagarMcfService.criarTitulosMcfCompra({
        db: ctx.db,
        compra_id: compraId,
        empresa_id: ctx.empresa.id,
        data_emissao: '2026-11-16',
        forma_pagamento: 'pix',
        usuario_id: 1,
        parcelas: [{
          numero_parcela: 1,
          valor: 100,
          data_vencimento: '2026-11-16',
          pagar_agora: false,
          descricao: `Compra ${compraId}`
        }]
      });
      await ContasPagarService.baixarNaTransacaoAtual({
        db: ctx.db,
        empresaId: ctx.empresa.id,
        id: titulos[0].id,
        valor_pago: 100,
        data_pagamento: '2026-11-16',
        forma_pagamento: 'pix',
        observacao: 'Baixa manual',
        idempotency_key: `manual:${compraId}:1`,
        usuario_id: 1,
        origem_operacao: 'mcf'
      });
      try {
        await ContasPagarService.estornarBaixasIniciaisCompraNaTransacaoAtual({
          db: ctx.db,
          empresaId: ctx.empresa.id,
          id: titulos[0].id,
          compra_id: compraId
        });
      } catch (err) {
        bloqueou = err.code === ContasPagarService.ERROS_MCF.TITULO_QUITADO
          || /baixa manual/i.test(String(err.message || ''));
      }
    });
    assert.equal(bloqueou, true);
    await close(ctx.db);
  });

  it('rota de cancelamento chama estorno da liquidação inicial', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../backend/rotas/compras.js'),
      'utf8'
    );
    assert.match(src, /estornarBaixasIniciaisCompraNaTransacaoAtual/);
  });
});
