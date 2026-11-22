'use strict';

const crypto = require('crypto');
const Module = require('node:module');
const sqlite3 = require('sqlite3').verbose();
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const databasePath = require.resolve('../../backend/database');
const databaseMock = new Module(databasePath);
databaseMock.filename = databasePath;
databaseMock.loaded = true;
databaseMock.exports = {};
require.cache[databasePath] = databaseMock;
const Historico = require('../../backend/services/cozinha/CozinhaHistoricoPedidosService');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function cb(err) {
    if (err) reject(err);
    else resolve({ lastID: this.lastID, changes: this.changes });
  }));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row || null);
  }));
}

function open() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

async function preparar(db) {
  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao_social TEXT, ativo INTEGER)`);
  await run(db, `CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY, username TEXT, nome TEXT, role TEXT, perfil TEXT, ativo INTEGER
  )`);
  await run(db, `CREATE TABLE usuario_empresas (usuario_id INTEGER, empresa_id INTEGER, ativo INTEGER)`);
  await run(db, `CREATE TABLE cozinha_unidades (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, codigo TEXT, ativo INTEGER
  )`);
  await run(db, `CREATE TABLE cozinha_operador_unidades (
    empresa_id INTEGER, operador_id INTEGER, unidade_id INTEGER, ativo INTEGER
  )`);
  await run(db, `CREATE TABLE cozinha_turnos (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, unidade_id INTEGER, estado TEXT,
    abertura_em TEXT, fechamento_em TEXT, fechamento_tipo TEXT, fechamento_justificativa TEXT,
    fechamento_operador_id INTEGER
  )`);
  await run(db, `CREATE TABLE cozinha_turno_relatorios (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, unidade_id INTEGER, turno_id INTEGER,
    snapshot_json TEXT, snapshot_sha256 TEXT
  )`);
  await run(db, `CREATE TABLE mesas (id INTEGER PRIMARY KEY, empresa_id INTEGER, numero INTEGER)`);
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, codigo TEXT, status TEXT, created_at TEXT
  )`);
  await run(db, `CREATE TABLE cozinha_comandas (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, numero_comanda INTEGER, operador_lancamento_id INTEGER
  )`);
  await run(db, `CREATE TABLE cozinha_rodadas (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, unidade_id INTEGER, turno_id INTEGER, mesa_id INTEGER,
    numero_rodada INTEGER, operador_envio_id INTEGER, enviada_em TEXT
  )`);
  await run(db, `CREATE TABLE categorias (id INTEGER PRIMARY KEY, nome TEXT, tipo TEXT)`);
  await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT, categoria_id INTEGER)`);
  await run(db, `CREATE TABLE cozinha_itens (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, unidade_id INTEGER, turno_id INTEGER,
    rodada_id INTEGER, comanda_id INTEGER, pedido_id INTEGER, pedido_item_id INTEGER,
    produto_id INTEGER, tipo_item TEXT, produto_nome_snapshot TEXT,
    qty_solicitada_millis INTEGER, qty_preparada_millis INTEGER, qty_cancelada_millis INTEGER,
    estado_preparacao TEXT, preparo_iniciado_em TEXT, pronto_em TEXT
  )`);
  await run(db, `CREATE TABLE cozinha_retirada_itens (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, unidade_id INTEGER, turno_id INTEGER,
    pedido_id INTEGER, cozinha_item_id INTEGER, rodada_id INTEGER, tipo_evento TEXT,
    qty_millis INTEGER, operador_id INTEGER, autorizado_por_operador_id INTEGER,
    registrado_em TEXT, justificativa TEXT, evento_origem_id INTEGER
  )`);
  await run(db, `CREATE TABLE cozinha_cancelamento_itens (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, unidade_id INTEGER, turno_id INTEGER,
    cozinha_item_id INTEGER, tipo_evento TEXT, qty_millis INTEGER, operador_id INTEGER,
    autorizado_por_operador_id INTEGER, registrado_em TEXT, justificativa TEXT, evento_origem_id INTEGER
  )`);
  await run(db, `CREATE TABLE cozinha_bebida_entregas (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, unidade_id INTEGER, cozinha_item_id INTEGER,
    qty_entregue_millis INTEGER, operador_id INTEGER, entregue_em TEXT
  )`);
  await run(db, `CREATE TABLE cozinha_eventos_outbox (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, unidade_id INTEGER, tipo TEXT,
    payload_json TEXT, created_at TEXT
  )`);

  await run(db, `INSERT INTO empresas VALUES (1, 'Empresa A', 1), (2, 'Empresa B', 1)`);
  await run(db, `INSERT INTO usuarios VALUES
    (1, 'gerente-a', 'Gerente A', 'gerente', 'GERENTE', 1),
    (2, 'operador-a', 'Operador A', 'operador', 'USUARIO', 1),
    (3, 'gerente-b', 'Gerente B', 'gerente', 'GERENTE', 1),
    (7, 'cozinha', 'Cozinheiro', 'operador', 'USUARIO', 1)`);
  await run(db, `INSERT INTO usuario_empresas VALUES (1,1,1), (3,2,1)`);
  await run(db, `INSERT INTO cozinha_unidades VALUES (11,1,'A',1), (22,2,'B',1)`);
  await run(db, `INSERT INTO cozinha_operador_unidades VALUES (1,1,11,1), (2,3,22,1)`);

  await run(db, `INSERT INTO cozinha_turnos VALUES
    (101,1,11,'FECHADA','2026-03-10T10:00:00Z','2026-03-10T18:30:00Z','NORMAL',NULL,1),
    (102,1,11,'FECHADA','2026-03-10T19:00:00Z','2026-03-10T22:00:00Z','EXCEPCIONAL','Pendências preservadas',1),
    (201,2,22,'FECHADA','2026-03-10T10:00:00Z','2026-03-10T18:30:00Z','NORMAL',NULL,3)`);
  await run(db, `INSERT INTO mesas VALUES (1,1,5), (2,1,6), (3,2,1)`);
  await run(db, `INSERT INTO categorias VALUES (1,'Pastelaria','produto'),(2,'Bebidas','produto')`);
  await run(db, `INSERT INTO produtos VALUES (1,'Pastel de carne',1),(2,'Suco',2)`);
  await run(db, `INSERT INTO pedidos VALUES
    (301,1,'PED-A','PEDIDO','2026-03-10T10:00:00Z'),
    (302,1,'PED-B','CANCELADO','2026-03-10T19:30:00Z'),
    (401,2,'PED-C','PEDIDO','2026-03-10T10:00:00Z')`);
  await run(db, `INSERT INTO cozinha_comandas VALUES
    (1,1,5,7),(2,1,6,7),(3,2,1,7)`);
  await run(db, `INSERT INTO cozinha_rodadas VALUES
    (1,1,11,101,1,1,7,'2026-03-10T10:30:00Z'),
    (2,1,11,102,2,1,7,'2026-03-10T19:30:00Z'),
    (3,2,22,201,3,1,7,'2026-03-10T10:30:00Z')`);
  await run(db, `INSERT INTO cozinha_itens VALUES
    (1,1,11,101,1,1,301,9001,1,'PASTEL','Pastel de carne',1000,1000,0,'PRONTO','2026-03-10T10:40:00Z','2026-03-10T11:00:00Z'),
    (2,1,11,102,2,2,302,9002,2,'BEBIDA','Suco',2000,1000,1000,'PRONTO','2026-03-10T19:35:00Z','2026-03-10T19:45:00Z'),
    (3,2,22,201,3,3,401,9003,1,'PASTEL','Pastel de carne',1000,1000,0,'PRONTO','2026-03-10T10:40:00Z','2026-03-10T11:00:00Z')`);
  await run(db, `INSERT INTO cozinha_retirada_itens VALUES
    (1,1,11,101,301,1,1,'RETIRADA_CONFIRMADA',500,7,NULL,'2026-03-10T12:00:00Z',NULL,NULL),
    (4,1,11,101,301,1,1,'RETIRADA_CONFIRMADA',250,7,NULL,'2026-03-10T12:05:00Z',NULL,NULL),
    (2,1,11,102,302,2,2,'RETIRADA_CONFIRMADA',1000,7,NULL,'2026-03-10T20:00:00Z',NULL,NULL),
    (3,2,22,201,401,3,3,'RETIRADA_CONFIRMADA',1000,7,NULL,'2026-03-10T12:00:00Z',NULL,NULL)`);
  await run(db, `INSERT INTO cozinha_cancelamento_itens VALUES
    (1,1,11,102,2,'CANCELAMENTO_CONFIRMADO',1000,7,NULL,'2026-03-10T20:05:00Z','Cancelamento parcial',NULL)`);
  await run(db, `INSERT INTO cozinha_bebida_entregas VALUES
    (1,1,11,1,1000,7,'2026-03-10T11:30:00Z')`);
  await run(db, `INSERT INTO cozinha_eventos_outbox VALUES
    (1,1,11,'PREPARACAO_INICIADA','{"operador_id":7,"item":{"id":1},"iniciado_em":"2026-03-10T10:40:00Z"}','2026-03-10T10:40:00Z'),
    (2,1,11,'ITEM_PRONTO','{"operador_id":7,"item":{"id":1},"pronto_em":"2026-03-10T11:00:00Z"}','2026-03-10T11:00:00Z')`);
  const snapshot = JSON.stringify({
    indicadores: {
      pendencias: [{ tipo: 'ITEM_PENDENTE', quantidade: 1, situacao: 'PRESERVADA' }]
    }
  });
  await run(db, `INSERT INTO cozinha_turno_relatorios
    VALUES (1,1,11,102,?,?)`, [snapshot, crypto.createHash('sha256').update(snapshot).digest('hex')]);
}

describe('Histórico de Pedidos Retirados', () => {
  it('consulta por dia e turno, mantém bebidas separadas e usa pendências do snapshot imutável', async () => {
    const db = await open();
    try {
      await preparar(db);
      const diario = await Historico.listarHistoricoPedidosRetirados({
        operadorId: 1, unidadeId: 11, data: '2026-03-10'
      }, { db });
      assert.equal(diario.total, 2);
      assert.equal(diario.pedidos.length, 2);
      const pedidoParcial = diario.pedidos.find((pedido) => pedido.pedido_id === 301);
      assert.equal(pedidoParcial.status_retirada, 'RETIRADA_PARCIAL');
      assert.equal(pedidoParcial.itens[0].quantidade_retirada_liquida, '0.750');
      assert.equal(pedidoParcial.itens[0].eventos_retirada.length, 2);
      assert.equal(pedidoParcial.itens[0].eventos_preparacao.length, 2);
      assert.equal(pedidoParcial.itens[0].entregas_bebida[0].quantidade, '1.000');
      assert.equal(pedidoParcial.itens[0].quantidade_retirada_liquida, '0.750');
      const turno = await Historico.listarHistoricoPedidosRetirados({
        operadorId: 1, unidadeId: 11, data: '2026-03-10', turnoId: 101
      }, { db });
      assert.equal(turno.total, 1);
      assert.deepEqual(turno.pedidos.map((pedido) => pedido.pedido_id), [301]);
      const filtrado = await Historico.listarHistoricoPedidosRetirados({
        operadorId: 1, unidadeId: 11, data: '2026-03-10',
        pedido: 'PED-A', mesa: '5', garcom: 'Cozinheiro',
        produto: 'Pastel de carne', categoria: 'Pastelaria'
      }, { db });
      assert.equal(filtrado.total, 1);
      assert.equal(filtrado.pedidos[0].pedido_codigo, 'PED-A');
      assert.equal(diario.pendencias_excepcionais[0].snapshot_persistido, true);
      assert.equal(diario.pendencias_excepcionais[0].pendencias[0].situacao, 'PRESERVADA');
      const cancelado = diario.pedidos.find((pedido) => pedido.pedido_id === 302);
      assert.equal(cancelado.status_retirada,
        'CANCELADO_COM_HISTORICO_DE_RETIRADA');
      assert.equal(cancelado.itens[0].eventos_cancelamento.length, 1);
      assert.equal(cancelado.itens[0].quantidade_cancelada, '1.000');
    } finally {
      await new Promise((resolve) => db.close(resolve));
    }
  });

  it('nega usuários sem perfil gerencial e impede consulta a unidade não autorizada', async () => {
    const db = await open();
    try {
      await preparar(db);
      await assert.rejects(
        () => Historico.listarHistoricoPedidosRetirados({
          operadorId: 2, unidadeId: 11, data: '2026-03-10'
        }, { db }),
        (err) => err.codigo === 'GESTAO_COZINHA_SEM_AUTORIZACAO'
      );
      await assert.rejects(
        () => Historico.listarHistoricoPedidosRetirados({
          operadorId: 1, unidadeId: 22, data: '2026-03-10'
        }, { db }),
        (err) => err.codigo === 'EMPRESA_SEM_AUTORIZACAO'
          || err.codigo === 'UNIDADE_SEM_AUTORIZACAO'
      );
      const outraEmpresa = await Historico.listarHistoricoPedidosRetirados({
        operadorId: 3, unidadeId: 22, data: '2026-03-10'
      }, { db });
      assert.deepEqual(outraEmpresa.pedidos.map((pedido) => pedido.pedido_id), [401]);
      assert.equal(outraEmpresa.empresa_id, 2);
    } finally {
      await new Promise((resolve) => db.close(resolve));
    }
  });

  it('recusa snapshot excepcional cujo hash não corresponde ao conteúdo persistido', async () => {
    const db = await open();
    try {
      await preparar(db);
      await run(db, `UPDATE cozinha_turno_relatorios SET snapshot_sha256='invalido' WHERE turno_id=102`);
      await assert.rejects(
        () => Historico.listarHistoricoPedidosRetirados({
          operadorId: 1, unidadeId: 11, data: '2026-03-10', turnoId: 102
        }, { db }),
        (err) => err.codigo === 'RELATORIO_SNAPSHOT_INTEGRIDADE'
      );
    } finally {
      await new Promise((resolve) => db.close(resolve));
    }
  });
});
