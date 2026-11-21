'use strict';

/**
 * Auditoria e proteção Cozinha → PDV.
 * Banco temporário (:memory:) isolado. Não usa banco oficial nem executa vendas.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-pdv-liberacao-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { validarLiberacaoPdv } = require('../../backend/services/cozinha/CozinhaLiberacaoPdvService');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function schema(db) {
  await run(db, 'CREATE TABLE pedidos (id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL)');
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY,
    pedido_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    quantidade TEXT NOT NULL,
    classificacao_operacional_snapshot TEXT
  )`);
  await run(db, `
    CREATE TABLE cozinha_rodadas (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      estado_preparacao TEXT NOT NULL,
      retirada_estado TEXT NOT NULL,
      retirada_em TEXT,
      retirada_por INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE cozinha_itens (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      rodada_id INTEGER NOT NULL,
      tipo_item TEXT NOT NULL,
      estado_preparacao TEXT NOT NULL,
      qty_solicitada_millis INTEGER NOT NULL,
      qty_cancelada_millis INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE cozinha_bebida_entregas (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      cozinha_item_id INTEGER NOT NULL,
      qty_entregue_millis INTEGER NOT NULL
    )
  `);
  await run(db, `
    CREATE TABLE cozinha_retirada_itens (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      cozinha_item_id INTEGER NOT NULL,
      rodada_id INTEGER NOT NULL,
      tipo_evento TEXT NOT NULL,
      qty_millis INTEGER NOT NULL,
      operador_id INTEGER,
      operacao_id TEXT,
      evento_origem_id INTEGER,
      justificativa TEXT
    )
  `);
  await run(db, `
    CREATE TABLE cozinha_cancelamento_itens (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      cozinha_item_id INTEGER NOT NULL,
      rodada_id INTEGER NOT NULL,
      tipo_evento TEXT NOT NULL,
      qty_millis INTEGER NOT NULL,
      operador_id INTEGER,
      operacao_id TEXT,
      evento_origem_id INTEGER,
      justificativa TEXT
    )
  `);
}

async function adicionarRetirada(db, { itemId, pedidoId, pedidoItemId, rodadaId, qtd = 1000 }) {
  await run(db, `
    INSERT INTO cozinha_retirada_itens (
      id,empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
      tipo_evento,qty_millis,operador_id,operacao_id
    ) VALUES (NULL,1,1,?,?,?,?,'RETIRADA_CONFIRMADA',?,7,'operacao-test')
  `, [pedidoId, pedidoItemId, itemId, rodadaId, qtd]);
}

async function addPedidoItem(
  db,
  pedidoId,
  itemId,
  quantidade = '1.000',
  classificacao = 'EXIGE_COZINHA'
) {
  await run(db, 'INSERT OR IGNORE INTO pedidos (id,empresa_id) VALUES (?,1)', [pedidoId]);
  await run(
    db,
    `INSERT INTO pedidos_itens
       (id,pedido_id,empresa_id,quantidade,classificacao_operacional_snapshot)
     VALUES (?,?,1,?,?)`,
    [itemId, pedidoId, quantidade, classificacao]
  );
}

async function adicionarRodada(db, rodadaId, retirada = 'PENDENTE', estado = 'PRONTA') {
  await run(db, `
    INSERT INTO cozinha_rodadas
      (id,empresa_id,unidade_id,estado_preparacao,retirada_estado,retirada_em,retirada_por)
    VALUES (?,?,1,?,?,NULL,?)
  `, [rodadaId, 1, estado, retirada, retirada === 'RETIRADA' ? 7 : null]);
}

async function adicionarItem(db, {
  id, pedidoId, pedidoItemId, rodadaId, tipo = 'PASTEL',
  estado = 'AGUARDANDO', qtd = 1000, cancelada = 0
}) {
  await run(db, `
    INSERT INTO cozinha_itens (
      id,empresa_id,unidade_id,pedido_id,pedido_item_id,rodada_id,tipo_item,
      estado_preparacao,qty_solicitada_millis,qty_cancelada_millis
    ) VALUES (?,?,1,?,?,?,?,?,?,?)
  `, [id, 1, pedidoId, pedidoItemId, rodadaId, tipo, estado, qtd, cancelada]);
}

async function assertBloqueado(db, pedidoId) {
  await assert.rejects(
    () => validarLiberacaoPdv({ pedidoId, empresaId: 1 }, { db }),
    (err) => err.statusCode === 409
      && /retirada individual confirmada pelo garçom/i.test(err.message)
  );
}

describe('Liberação Cozinha → PDV', () => {
  it('1. pedido comprovadamente sem cozinha é liberado', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 10, 100, '1.000', 'NAO_EXIGE_COZINHA');
    assert.deepEqual(await validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }), {
      liberado: true,
      pendencias: []
    });
    await close(db);
  });

  it('2. item em preparação bloqueia', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 11, 101);
    await adicionarRodada(db, 201, 'PENDENTE', 'EM_PREPARACAO');
    await adicionarItem(db, { id: 301, pedidoId: 11, pedidoItemId: 101, rodadaId: 201, estado: 'EM_PREPARACAO' });
    await assertBloqueado(db, 11);
    await close(db);
  });

  it('3. item pronto sem retirada bloqueia', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 12, 102);
    await adicionarRodada(db, 202, 'PENDENTE', 'PRONTA');
    await adicionarItem(db, { id: 302, pedidoId: 12, pedidoItemId: 102, rodadaId: 202, estado: 'PRONTO' });
    await assertBloqueado(db, 12);
    await close(db);
  });

  it('4. item retirado libera', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 13, 103);
    await adicionarRodada(db, 203, 'RETIRADA', 'PRONTA');
    await adicionarItem(db, { id: 303, pedidoId: 13, pedidoItemId: 103, rodadaId: 203, estado: 'PRONTO' });
    await adicionarRetirada(db, { itemId: 303, pedidoId: 13, pedidoItemId: 103, rodadaId: 203, qtd: 1000 });
    assert.equal((await validarLiberacaoPdv({ pedidoId: 13, empresaId: 1 }, { db })).liberado, true);
    await close(db);
  });

  it('5. um item pendente entre vários retirados bloqueia', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 14, 104);
    await addPedidoItem(db, 14, 105);
    await adicionarRodada(db, 204, 'RETIRADA', 'PRONTA');
    await adicionarRodada(db, 216, 'PENDENTE', 'PRONTA');
    await adicionarItem(db, { id: 304, pedidoId: 14, pedidoItemId: 104, rodadaId: 204, estado: 'PRONTO' });
    await adicionarItem(db, { id: 305, pedidoId: 14, pedidoItemId: 105, rodadaId: 216, estado: 'PRONTO' });
    await assertBloqueado(db, 14);
    await close(db);
  });

  it('6. retirada parcial por rodadas mantém pendência', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 16, 106, '2.000');
    await adicionarRodada(db, 206, 'RETIRADA', 'PRONTA');
    await adicionarRodada(db, 207, 'PENDENTE', 'PRONTA');
    await adicionarItem(db, { id: 306, pedidoId: 16, pedidoItemId: 106, rodadaId: 206, estado: 'PRONTO', qtd: 1000 });
    await adicionarItem(db, { id: 307, pedidoId: 16, pedidoItemId: 106, rodadaId: 207, estado: 'PRONTO', qtd: 1000 });
    await adicionarRetirada(db, { itemId: 306, pedidoId: 16, pedidoItemId: 106, rodadaId: 206, qtd: 1000 });
    await assertBloqueado(db, 16);
    await close(db);
  });

  it('7. bebida com entrega pendente bloqueia', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 17, 107);
    await adicionarRodada(db, 208, 'RETIRADA', 'PRONTA');
    await adicionarItem(db, { id: 308, pedidoId: 17, pedidoItemId: 107, rodadaId: 208, tipo: 'BEBIDA', estado: 'PRONTO', qtd: 2000 });
    await run(db, 'INSERT INTO cozinha_bebida_entregas (id,empresa_id,cozinha_item_id,qty_entregue_millis) VALUES (1,1,308,1000)');
    await assertBloqueado(db, 17);
    await close(db);
  });

  it('8. bebida totalmente entregue libera', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 18, 108);
    await adicionarRodada(db, 209, 'RETIRADA', 'PRONTA');
    await adicionarItem(db, { id: 309, pedidoId: 18, pedidoItemId: 108, rodadaId: 209, tipo: 'BEBIDA', estado: 'PRONTO', qtd: 1000 });
    await run(db, 'INSERT INTO cozinha_bebida_entregas (id,empresa_id,cozinha_item_id,qty_entregue_millis) VALUES (2,1,309,1000)');
    await adicionarRetirada(db, { itemId: 309, pedidoId: 18, pedidoItemId: 108, rodadaId: 209, qtd: 1000 });
    assert.equal((await validarLiberacaoPdv({ pedidoId: 18, empresaId: 1 }, { db })).liberado, true);
    await close(db);
  });

  it('9. rodada compartilhada é filtrada pelo pedido', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 19, 109);
    await addPedidoItem(db, 20, 110);
    await adicionarRodada(db, 210, 'RETIRADA', 'PRONTA');
    await adicionarItem(db, { id: 310, pedidoId: 19, pedidoItemId: 109, rodadaId: 210, estado: 'PRONTO' });
    await adicionarItem(db, { id: 311, pedidoId: 20, pedidoItemId: 110, rodadaId: 210, estado: 'PRONTO' });
    await adicionarRetirada(db, { itemId: 310, pedidoId: 19, pedidoItemId: 109, rodadaId: 210, qtd: 1000 });
    await adicionarRetirada(db, { itemId: 311, pedidoId: 20, pedidoItemId: 110, rodadaId: 210, qtd: 1000 });
    assert.equal((await validarLiberacaoPdv({ pedidoId: 19, empresaId: 1 }, { db })).liberado, true);
    assert.equal((await validarLiberacaoPdv({ pedidoId: 20, empresaId: 1 }, { db })).liberado, true);
    await close(db);
  });

  it('10. pedido com várias rodadas bloqueia enquanto uma fica pendente', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 21, 111);
    await adicionarRodada(db, 211, 'RETIRADA', 'PRONTA');
    await adicionarRodada(db, 212, 'PENDENTE', 'PRONTA');
    await adicionarItem(db, { id: 312, pedidoId: 21, pedidoItemId: 111, rodadaId: 211, estado: 'PRONTO' });
    await adicionarItem(db, { id: 313, pedidoId: 21, pedidoItemId: 111, rodadaId: 212, estado: 'PRONTO' });
    await adicionarRetirada(db, { itemId: 312, pedidoId: 21, pedidoItemId: 111, rodadaId: 211, qtd: 1000 });
    await assertBloqueado(db, 21);
    await close(db);
  });

  it('11. nova rodada invalida liberação', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 22, 112);
    await adicionarRodada(db, 213, 'RETIRADA', 'PRONTA');
    await adicionarItem(db, { id: 314, pedidoId: 22, pedidoItemId: 112, rodadaId: 213, estado: 'PRONTO' });
    await adicionarRodada(db, 214, 'PENDENTE', 'AGUARDANDO');
    await adicionarItem(db, { id: 315, pedidoId: 22, pedidoItemId: 112, rodadaId: 214, estado: 'AGUARDANDO' });
    await assertBloqueado(db, 22);
    await close(db);
  });

  it('12. itens integralmente cancelados não bloqueiam', async () => {
    const db = await openDb();
    await schema(db);
    await addPedidoItem(db, 23, 113);
    await adicionarRodada(db, 215, 'PENDENTE', 'PRONTA');
    await adicionarItem(db, { id: 316, pedidoId: 23, pedidoItemId: 113, rodadaId: 215, estado: 'CANCELADO', qtd: 1000, cancelada: 1000 });
    await run(db, `
      INSERT INTO cozinha_cancelamento_itens (
        id,empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
        tipo_evento,qty_millis,operador_id,operacao_id
      ) VALUES (1,1,1,23,113,316,215,'CANCELAMENTO_CONFIRMADO',1000,7,'cancel-ledger-test')
    `);
    assert.equal((await validarLiberacaoPdv({ pedidoId: 23, empresaId: 1 }, { db })).liberado, true);
    await close(db);
  });

  it('13-16. pontos de integração e mensagem frontend estão presentes', () => {
    const pedidos = fs.readFileSync(path.join(__dirname, '../../backend/rotas/pedidos.js'), 'utf8');
    const vendas = fs.readFileSync(path.join(__dirname, '../../backend/rotas/vendas.js'), 'utf8');
    const faturamento = fs.readFileSync(path.join(__dirname, '../../backend/services/faturamento/FaturamentoService.js'), 'utf8');
    const mobile = fs.readFileSync(path.join(__dirname, '../../frontend/mobile-pedido/mobile-pedido.js'), 'utf8');
    const desktop = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');

    assert.match(pedidos, /:id\/preparar-venda-pdv/);
    assert.match(pedidos, /:id\/finalizar-venda-pdv/);
    assert.match(pedidos, /validarLiberacaoPdv/);
    assert.match(vendas, /pedido_id|pedidoId/);
    assert.match(vendas, /COZINHA_RETIRADA_PENDENTE/);
    assert.match(faturamento, /validarLiberacaoPdv/);
    assert.match(mobile, /mensagemErroApi/);
    assert.match(desktop, /montarDiagnosticoPreparacao/);
  });
});
