'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const PedidoRepository = require('../../backend/services/pedido/PedidoRepository');
const { exigirEmpresaDaCriacao } = require('../../backend/services/pedidos/PedidoEmpresaContextoService');

const UI = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');

function run(db, sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, function cb(e) { return e ? rej(e) : res(this); }));
}

async function criarDb() {
  const db = await new Promise((res, rej) => {
    const d = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(d)));
  });
  await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, nome TEXT, unidade TEXT, tipo_operacional TEXT DEFAULT 'COMERCIAL')`);
  await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, data_pedido TEXT, cliente_id INTEGER, total REAL DEFAULT 0, desconto REAL DEFAULT 0, frete REAL DEFAULT 0, status TEXT, representante_id INTEGER, representante_nome TEXT, observacao TEXT, operador_id INTEGER, venda_id INTEGER, empresa_id INTEGER, updated_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE pedidos_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL, quantidade REAL NOT NULL, preco_unitario REAL NOT NULL, desconto_percentual REAL DEFAULT 0, subtotal REAL NOT NULL, tipo_venda TEXT DEFAULT 'PESO', classificacao_operacional_snapshot TEXT, produto_codigo_snapshot TEXT, produto_nome_snapshot TEXT, produto_unidade_snapshot TEXT)`);
  await run(db, `CREATE TABLE clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT)`);
  await run(db, `CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, nome TEXT)`);
  return db;
}

describe('Tela de Pedidos adaptada (código-fonte; sem navegador)', () => {
  it('remove abas e controles legados da interface operacional', () => {
    assert.ok(!/data-aba="orcamentos"|data-aba="expedidos"|data-aba="aguardando/.test(UI));
    assert.ok(!/pedTipoOrcamento|pedTipoDocumento|pedRepresentante|pedFiltroRepresentante|pedFrete\b/.test(UI));
    assert.ok(!/converterPedido|excluirOrcamento|enviarFaturamento|expedicaoHabilitada/.test(UI));
  });
  it('envia contexto de empresa e bloqueia sem empresa', () => {
    assert.match(UI, /CdsEmpresaContexto\.headersJson/);
    assert.match(UI, /Selecione a empresa/);
    assert.match(UI, /cds-empresa-contexto-alterado/);
    assert.ok(!/headers:\s*\{\s*Authorization/.test(UI), 'não deve enviar só Authorization');
  });
  it('mantém cliente opcional e usa a mesa aprovada como identificação', () => {
    assert.match(UI, /opcional/);
    assert.match(UI, /pedMesaId/);
  });
  it('preserva impressão usada pelo faturamento legado', () => {
    assert.match(UI, /window\.imprimirPedidoPorId/);
    assert.match(UI, /montarHtmlImpressaoPedido/);
  });
});

describe('Backend reutilizado (PedidoRepository, banco em memória)', () => {
  it('exige empresa explícita na criação', () => {
    assert.throws(() => exigirEmpresaDaCriacao(null), (e) => e.statusCode === 400);
    assert.equal(exigirEmpresaDaCriacao(7), 7);
  });

  it('salva sem cliente, altera e remove itens, recalcula e consulta por empresa', async () => {
    const db = await criarDb();
    try {
      const a = (await run(db, `INSERT INTO produtos (codigo,nome,unidade) VALUES ('A','Pastel','UN')`)).lastID;
      const b = (await run(db, `INSERT INTO produtos (codigo,nome,unidade) VALUES ('B','Caldo','UN')`)).lastID;
      const id = await PedidoRepository.criarPedido({
        db, codigo: 'P1', dataPedido: '2026-01-01', clienteId: null, total: 30, desconto: 0, frete: 0,
        status: 'PEDIDO', empresaId: 1,
        itens: [
          { produto_id: a, quantidade: 2, preco_unitario: 10, desconto_percentual: 0, subtotal: 20 },
          { produto_id: b, quantidade: 1, preco_unitario: 10, desconto_percentual: 0, subtotal: 10 }
        ]
      });
      let p = await PedidoRepository.obterPorId(id, { db });
      assert.equal(p.cliente_id, null);
      assert.equal(p.itens.length, 2);
      assert.equal(p.total, 30);

      await PedidoRepository.substituirPedido({
        pedidoId: id, clienteId: null, total: 30, desconto: 0, frete: 0, observacao: null, empresaId: 1, db,
        itens: [{ produto_id: a, quantidade: 3, preco_unitario: 10, desconto_percentual: 0, subtotal: 30 }]
      });
      p = await PedidoRepository.obterPorId(id, { db });
      assert.equal(p.itens.length, 1);
      assert.equal(Number(p.itens[0].quantidade), 3);
      assert.equal(p.total, 30);

      const lista1 = await PedidoRepository.listarPedidos({ db, empresaId: 1, statusIn: ['PEDIDO'] });
      assert.equal(lista1.length, 1);
      assert.equal(lista1[0].cliente_nome, null);
      assert.equal((await PedidoRepository.listarPedidos({ db, empresaId: 2 })).length, 0);
      assert.equal((await PedidoRepository.listarPedidos({ db })).length, 0);
    } finally {
      await new Promise((r) => db.close(() => r()));
    }
  });
});
