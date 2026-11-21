'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-ledger-s3-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BOCO_OFICIAL = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  executarMigracaoSprint2
} = require('../../backend/migrations/sprint2-cozinha-ledgers');
const Ledger = require('../../backend/services/cozinha/CozinhaRetiradaLedgerService');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      db.run('PRAGMA foreign_keys = ON', (fkErr) => {
        if (fkErr) reject(fkErr);
        else resolve(db);
      });
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
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
  await run(db, 'CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT, role TEXT, perfil TEXT, ativo INTEGER DEFAULT 1)');
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ABERTO'
    )
  `);
  await run(db, 'CREATE UNIQUE INDEX ux_pedidos_id_empresa ON pedidos(id, empresa_id)');
  await run(db, `
    CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY,
      pedido_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      produto_id INTEGER,
      quantidade REAL NOT NULL
    )
  `);
  await run(db, `
    CREATE UNIQUE INDEX ux_pedidos_itens_id_pedido_empresa
    ON pedidos_itens(id, pedido_id, empresa_id)
  `);
  await run(db, 'CREATE TABLE cozinha_unidades (id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, codigo TEXT, UNIQUE(id,empresa_id))');
  await run(db, `
    CREATE TABLE cozinha_rodadas (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      estado_preparacao TEXT,
      retirada_estado TEXT,
      retirada_em TEXT,
      retirada_por INTEGER,
      updated_at TEXT,
      UNIQUE(id,empresa_id)
    )
  `);
  await run(db, 'CREATE UNIQUE INDEX ux_cozinha_rodadas_id_unidade_empresa ON cozinha_rodadas(id, unidade_id, empresa_id)');
  await run(db, 'CREATE TABLE cozinha_comandas (id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL)');
  await run(db, `
    CREATE TABLE cozinha_itens (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      rodada_id INTEGER NOT NULL,
      comanda_id INTEGER,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      tipo_item TEXT,
      estado_preparacao TEXT,
      qty_solicitada_millis INTEGER NOT NULL,
      qty_preparada_millis INTEGER NOT NULL DEFAULT 0,
      qty_cancelada_millis INTEGER NOT NULL DEFAULT 0,
      UNIQUE(id,empresa_id)
    )
  `);
  await run(db, `
    CREATE UNIQUE INDEX ux_cozinha_itens_vinculo_retirada
    ON cozinha_itens(id,empresa_id,unidade_id,rodada_id,pedido_id,pedido_item_id)
  `);
  await run(db, `
    CREATE TABLE cozinha_idempotencia (
      id INTEGER PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      tipo_operacao TEXT NOT NULL,
      contexto TEXT,
      payload_hash TEXT NOT NULL,
      situacao TEXT NOT NULL,
      resultado_http_status INTEGER,
      resultado_json TEXT,
      recurso_tipo TEXT,
      recurso_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      concluded_at TEXT
    )
  `);
  await run(db, 'CREATE UNIQUE INDEX ux_cozinha_idempotencia_key ON cozinha_idempotencia(idempotency_key)');
  await run(db, `
    CREATE TABLE cozinha_bebida_entregas (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      cozinha_item_id INTEGER NOT NULL,
      rodada_id INTEGER NOT NULL,
      qty_entregue_millis INTEGER NOT NULL,
      qty_restante_millis INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE cozinha_eventos_outbox (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER,
      tipo TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE
    )
  `);

  await run(db, 'INSERT INTO empresas(id) VALUES (1)');
  await run(db, 'INSERT INTO usuarios(id,username,role,perfil,ativo) VALUES (7,\'garcom\',\'admin\',\'ADMIN\',1)');
  await run(db, 'INSERT INTO pedidos(id,empresa_id) VALUES (10,1)');
  await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,empresa_id,produto_id,quantidade) VALUES (20,10,1,30,2)');
  await run(db, 'INSERT INTO cozinha_unidades(id,empresa_id,codigo) VALUES (40,1,\'COZ1\')');
  await run(db, 'INSERT INTO cozinha_rodadas(id,empresa_id,unidade_id,estado_preparacao,retirada_estado) VALUES (50,1,40,\'PRONTA\',\'PENDENTE\')');
  await run(db, 'INSERT INTO cozinha_comandas(id,empresa_id) VALUES (60,1)');
  await run(db, `
    INSERT INTO cozinha_itens(
      id,empresa_id,unidade_id,rodada_id,comanda_id,pedido_id,pedido_item_id,
      tipo_item,estado_preparacao,qty_solicitada_millis,qty_preparada_millis,qty_cancelada_millis
    ) VALUES (70,1,40,50,60,10,20,'PASTEL','PRONTO',2000,2000,0)
  `);
}

const base = {
  empresaId: 1,
  unidade_id: 40,
  operadorId: 7,
  itemId: 70
};

describe('Sprint 3 — operações sobre ledgers', () => {
  it('confirma isolamento obrigatório', () => {
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB, undefined);
  });

  it('retirada parcial, múltiplas retiradas e integral', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });

    const p1 = await Ledger.retirarItem({
      ...base,
      qty_millis: 500,
      idempotencyKey: 'ret-1'
    }, { db });
    const p2 = await Ledger.retirarItem({
      ...base,
      qty_millis: 500,
      idempotencyKey: 'ret-2'
    }, { db });
    const p1Replay = await Ledger.retirarItem({
      ...base,
      qty_millis: 500,
      idempotencyKey: 'ret-1'
    }, { db });
    assert.equal(p1.repetida, false);
    assert.equal(p1Replay.repetida, true);
    assert.equal(p2.qty_millis, 500);

    const integral = await Ledger.retirarItem({
      ...base,
      qty_millis: 1000,
      idempotencyKey: 'ret-3'
    }, { db });
    assert.equal(integral.qty_millis, 1000);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM cozinha_retirada_itens')).n), 3);
    await assert.rejects(
      () => Ledger.retirarItem({ ...base, qty_millis: 1, idempotencyKey: 'ret-extra' }, { db }),
      (err) => err.codigo === 'RETIRADA_ACIMA_DO_PERMITIDO'
    );
    await close(db);
  });

  it('calcula o saldo pendente de retirada dentro da transação e reproduz a mesma chave', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });

    await Ledger.retirarItem({
      ...base,
      qty_millis: 500,
      idempotencyKey: 'ret-saldo-parcial'
    }, { db });
    const entrada = {
      ...base,
      usar_saldo_pendente: true,
      idempotencyKey: 'ret-saldo-auto'
    };
    const retirada = await Ledger.retirarItem(entrada, { db });
    const replay = await Ledger.retirarItem({
      ...entrada,
      qty_millis: 1
    }, { db });

    assert.equal(retirada.qty_millis, 1500);
    assert.equal(replay.repetida, true);
    assert.equal(replay.qty_millis, 1500);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM cozinha_retirada_itens')).n), 2);
    await assert.rejects(
      () => Ledger.retirarItem({
        ...base,
        usar_saldo_pendente: true,
        idempotencyKey: 'ret-saldo-vazio'
      }, { db }),
      (err) => err.codigo === 'RETIRADA_SEM_SALDO'
    );
    await close(db);
  });

  it('chave reutilizada com payload diferente é bloqueada', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await Ledger.retirarItem({ ...base, qty_millis: 500, idempotencyKey: 'same-key' }, { db });
    await assert.rejects(
      () => Ledger.retirarItem({ ...base, qty_millis: 600, idempotencyKey: 'same-key' }, { db }),
      (err) => err.codigo === 'IDEMPOTENCY_PAYLOAD_DIVERGENTE'
    );
    await close(db);
  });

  it('duas retiradas simultâneas não ultrapassam o saldo', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    const entradas = [
      Ledger.retirarItem({ ...base, qty_millis: 1500, idempotencyKey: 'conc-a' }, { db }),
      Ledger.retirarItem({ ...base, qty_millis: 1500, idempotencyKey: 'conc-b' }, { db })
    ];
    const resultados = await Promise.allSettled(entradas);
    assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(resultados.filter((r) => r.status === 'rejected').length, 1);
    await close(db);
  });

  it('retirada e cancelamento simultâneos não ultrapassam o saldo', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    const resultados = await Promise.allSettled([
      Ledger.retirarItem({ ...base, qty_millis: 1500, idempotencyKey: 'race-r' }, { db }),
      Ledger.cancelarItem({
        ...base,
        qty_millis: 1000,
        justificativa: 'Concorrência',
        idempotencyKey: 'race-c'
      }, { db })
    ]);
    assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(resultados.filter((r) => r.status === 'rejected').length, 1);
    await close(db);
  });

  it('cancelamento parcial e integral impedidos após retirada integral', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await Ledger.retirarItem({ ...base, qty_millis: 500, idempotencyKey: 'cancel-retirada' }, { db });
    const parcial = await Ledger.cancelarItem({
      ...base,
      qty_millis: 500,
      justificativa: 'Cancelamento parcial',
      idempotencyKey: 'cancel-1'
    }, { db });
    assert.equal(parcial.qty_millis, 500);
    await Ledger.retirarItem({ ...base, qty_millis: 1000, idempotencyKey: 'cancel-retirada-2' }, { db });
    await assert.rejects(
      () => Ledger.cancelarItem({
        ...base,
        qty_millis: 500,
        justificativa: 'Sem saldo',
        idempotencyKey: 'cancel-extra'
      }, { db }),
      (err) => err.codigo === 'CANCELAMENTO_ACIMA_DO_PERMITIDO'
    );
    await close(db);
  });

  it('estorno parcial e integral de retirada', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    const retirada = await Ledger.retirarItem({ ...base, qty_millis: 1000, idempotencyKey: 'orig-ret' }, { db });
    const e1 = await Ledger.estornarRetirada({
      ...base,
      eventoId: retirada.evento_id,
      qty_millis: 400,
      justificativa: 'Correção parcial',
      autorizadoPorOperadorId: 7,
      idempotencyKey: 'est-ret-1'
    }, { db });
    const replay = await Ledger.estornarRetirada({
      ...base,
      eventoId: retirada.evento_id,
      qty_millis: 400,
      justificativa: 'Correção parcial',
      autorizadoPorOperadorId: 7,
      idempotencyKey: 'est-ret-1'
    }, { db });
    assert.equal(e1.repetida, false);
    assert.equal(replay.repetida, true);
    await Ledger.estornarRetirada({
      ...base,
      eventoId: retirada.evento_id,
      qty_millis: 600,
      justificativa: 'Estorno integral',
      autorizadoPorOperadorId: 7,
      idempotencyKey: 'est-ret-2'
    }, { db });
    await assert.rejects(
      () => Ledger.estornarRetirada({
        ...base,
        eventoId: retirada.evento_id,
        qty_millis: 1,
        justificativa: 'Excede',
        autorizadoPorOperadorId: 7,
        idempotencyKey: 'est-ret-extra'
      }, { db }),
      (err) => err.codigo === 'ESTORNO_ACIMA_DO_SALDO'
    );
    await close(db);
  });

  it('estorno parcial e integral de cancelamento', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    const cancelamento = await Ledger.cancelarItem({
      ...base,
      qty_millis: 1000,
      justificativa: 'Cancelamento',
      idempotencyKey: 'cancel-orig'
    }, { db });
    await Ledger.estornarCancelamento({
      ...base,
      eventoId: cancelamento.evento_id,
      qty_millis: 400,
      justificativa: 'Reverter cancelamento parcial',
      autorizadoPorOperadorId: 7,
      idempotencyKey: 'est-cancel-1'
    }, { db });
    await Ledger.estornarCancelamento({
      ...base,
      eventoId: cancelamento.evento_id,
      qty_millis: 600,
      justificativa: 'Reverter integral',
      autorizadoPorOperadorId: 7,
      idempotencyKey: 'est-cancel-2'
    }, { db });
    await assert.rejects(
      () => Ledger.estornarCancelamento({
        ...base,
        eventoId: cancelamento.evento_id,
        qty_millis: 1,
        justificativa: 'Excede',
        autorizadoPorOperadorId: 7,
        idempotencyKey: 'est-cancel-extra'
      }, { db }),
      (err) => err.codigo === 'ESTORNO_CANCELAMENTO_ACIMA'
    );
    await close(db);
  });

  it('estorno de estorno é bloqueado por referência', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    const retirada = await Ledger.retirarItem({ ...base, qty_millis: 500, idempotencyKey: 'orig-ref' }, { db });
    const estorno = await Ledger.estornarRetirada({
      ...base,
      eventoId: retirada.evento_id,
      qty_millis: 100,
      justificativa: 'Estorno',
      autorizadoPorOperadorId: 7,
      idempotencyKey: 'est-ref'
    }, { db });
    await assert.rejects(
      () => Ledger.estornarRetirada({
        ...base,
        eventoId: estorno.evento_id,
        qty_millis: 100,
        justificativa: 'Estorno de estorno',
        autorizadoPorOperadorId: 7,
        idempotencyKey: 'est-estorno'
      }, { db }),
      (err) => err.codigo === 'EVENTO_ORIGEM_INVALIDO'
    );
    await close(db);
  });

  it('ajustes exigem autorização, justificativa e saldo válido', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    const retirada = await Ledger.retirarItem({ ...base, qty_millis: 500, idempotencyKey: 'ajuste-orig' }, { db });

    await assert.rejects(
      () => Ledger.ajustarRetirada({
        ...base,
        eventoId: retirada.evento_id,
        tipo_evento: 'AJUSTE_CREDITO',
        qty_millis: 100,
        justificativa: 'Sem autorização',
        autorizadoPorOperadorId: 7,
        idempotencyKey: 'ajuste-negado',
        adminAutorizado: false
      }, { db }),
      (err) => err.codigo === 'AJUSTE_SEM_AUTORIZACAO'
    );
    await assert.rejects(
      () => Ledger.ajustarRetirada({
        ...base,
        eventoId: retirada.evento_id,
        tipo_evento: 'AJUSTE_CREDITO',
        qty_millis: 100,
        justificativa: '',
        autorizadoPorOperadorId: 7,
        idempotencyKey: 'ajuste-sem-just',
        adminAutorizado: true
      }, { db }),
      (err) => err.codigo === 'JUSTIFICATIVA_OBRIGATORIA'
    );
    const credito = await Ledger.ajustarRetirada({
      ...base,
      eventoId: retirada.evento_id,
      tipo_evento: 'AJUSTE_CREDITO',
      qty_millis: 500,
      justificativa: 'Ajuste autorizado',
      autorizadoPorOperadorId: 7,
      idempotencyKey: 'ajuste-ok',
      adminAutorizado: true
    }, { db });
    assert.equal(credito.tipo_evento, 'AJUSTE_CREDITO');
    await assert.rejects(
      () => Ledger.ajustarRetirada({
        ...base,
        eventoId: credito.evento_id,
        tipo_evento: 'AJUSTE_DEBITO',
        qty_millis: 2000,
        justificativa: 'Débito excessivo',
        autorizadoPorOperadorId: 7,
        idempotencyKey: 'ajuste-debito',
        adminAutorizado: true
      }, { db }),
      (err) => err.codigo === 'AJUSTE_DEBITO_ACIMA'
    );
    await close(db);
  });

  it('rollback integral em falha de referência', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await assert.rejects(
      () => Ledger.retirarItem({
        ...base,
        itemId: 999,
        qty_millis: 500,
        idempotencyKey: 'rollback-ref'
      }, { db }),
      (err) => err.codigo === 'ITEM_NAO_ENCONTRADO'
    );
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM cozinha_retirada_itens')).n), 0);
    assert.equal(Number((await get(db, "SELECT COUNT(*) AS n FROM cozinha_idempotencia WHERE idempotency_key='rollback-ref'")).n), 0);
    await close(db);
  });

  it('integridade de vínculos e foreign_key_check', async () => {
    const db = await openDb();
    await schema(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await assert.rejects(
      () => Ledger.retirarItem({
        ...base,
        unidade_id: 41,
        qty_millis: 500,
        idempotencyKey: 'wrong-unit'
      }, { db }),
      (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
    );
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
    await close(db);
  });

  it('endpoints novos existem isolados da liberação e faturamento', () => {
    const rota = fs.readFileSync(path.join(__dirname, '../../backend/rotas/cozinha.js'), 'utf8');
    const liberacao = fs.readFileSync(
      path.join(__dirname, '../../backend/services/cozinha/CozinhaLiberacaoPdvService.js'),
      'utf8'
    );
    assert.match(rota, /retirada-ledger/);
    assert.match(rota, /cancelamento-ledger/);
    assert.match(rota, /retiradas\/:id\/estornar/);
    assert.match(rota, /cancelamentos\/:id\/estornar/);
    assert.match(rota, /ajuste-retirada/);
    assert.doesNotMatch(rota, /CozinhaLiberacaoPdvService/);
    assert.doesNotMatch(liberacao, /CozinhaRetiradaLedgerService/);
  });
});
