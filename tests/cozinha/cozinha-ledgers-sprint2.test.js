'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-ledgers-sprint2-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  executarMigracaoSprint2,
  verificarAmbienteIsolado
} = require('../../backend/migrations/sprint2-cozinha-ledgers');

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
      else resolve(this);
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

async function schemaPreSprint2(db) {
  await run(db, 'CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT)');
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL
    )
  `);
  await run(db, 'CREATE UNIQUE INDEX ux_pedidos_id_empresa ON pedidos(id, empresa_id)');
  await run(db, `
    CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY,
      pedido_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      produto_id INTEGER,
      quantidade REAL
    )
  `);
  await run(db, `
    CREATE UNIQUE INDEX ux_pedidos_itens_id_pedido_empresa
    ON pedidos_itens(id, pedido_id, empresa_id)
  `);
  await run(db, `
    CREATE TABLE cozinha_unidades (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      codigo TEXT,
      UNIQUE(id, empresa_id)
    )
  `);
  await run(db, `
    CREATE TABLE cozinha_rodadas (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      mesa_id INTEGER,
      atendimento_id INTEGER,
      estado_preparacao TEXT,
      UNIQUE(id, empresa_id)
    )
  `);
  await run(db, `
    CREATE UNIQUE INDEX ux_cozinha_rodadas_id_unidade_empresa
    ON cozinha_rodadas(id, unidade_id, empresa_id)
  `);
  await run(db, `
    CREATE TABLE cozinha_comandas (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL
    )
  `);
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
      qty_solicitada_millis INTEGER,
      qty_cancelada_millis INTEGER DEFAULT 0,
      UNIQUE(id, empresa_id)
    )
  `);
  await run(db, `
    CREATE UNIQUE INDEX ux_cozinha_itens_vinculo_retirada
    ON cozinha_itens(
      id,
      empresa_id,
      unidade_id,
      rodada_id,
      pedido_id,
      pedido_item_id
    )
  `);
  await run(db, `
    CREATE TABLE cozinha_idempotencia (
      id INTEGER PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      tipo_operacao TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      situacao TEXT NOT NULL,
      resultado_json TEXT
    )
  `);
  await run(db, `
    CREATE UNIQUE INDEX ux_cozinha_idempotencia_key
    ON cozinha_idempotencia(idempotency_key)
  `);

  await run(db, 'INSERT INTO empresas(id) VALUES (1)');
  await run(db, 'INSERT INTO usuarios(id,username) VALUES (7,\'garcom\')');
  await run(db, 'INSERT INTO pedidos(id,empresa_id) VALUES (10,1)');
  await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,empresa_id,produto_id,quantidade) VALUES (20,10,1,30,2)');
  await run(db, 'INSERT INTO cozinha_unidades(id,empresa_id,codigo) VALUES (40,1,\'COZ1\')');
  await run(db, `
    INSERT INTO cozinha_rodadas(id,empresa_id,unidade_id,mesa_id,atendimento_id,estado_preparacao)
    VALUES (50,1,40,2,3,'PRONTA')
  `);
  await run(db, 'INSERT INTO cozinha_comandas(id,empresa_id) VALUES (60,1)');
  await run(db, `
    INSERT INTO cozinha_itens(
      id,empresa_id,unidade_id,rodada_id,comanda_id,pedido_id,pedido_item_id,
      tipo_item,qty_solicitada_millis,qty_cancelada_millis
    ) VALUES (70,1,40,50,60,10,20,'PASTEL',1000,0)
  `);
}

function dadosRetiradaExemplo() {
  return {
    empresa_id: 1,
    unidade_id: 40,
    pedido_id: 10,
    pedido_item_id: 20,
    cozinha_item_id: 70,
    rodada_id: 50,
    tipo_evento: 'RETIRADA_CONFIRMADA',
    qty_millis: 1000,
    operador_id: 7,
    autorizado_por_operador_id: null,
    operacao_id: 'op-retirada-1',
    evento_origem_id: null,
    justificativa: null
  };
}

function paramsEvento(evento) {
  return [
    evento.empresa_id,
    evento.unidade_id,
    evento.pedido_id,
    evento.pedido_item_id,
    evento.cozinha_item_id,
    evento.rodada_id,
    evento.tipo_evento,
    evento.qty_millis,
    evento.operador_id,
    evento.autorizado_por_operador_id,
    evento.operacao_id,
    evento.evento_origem_id,
    evento.justificativa
  ];
}

async function inserirRetirada(db, evento) {
  return run(db, `
    INSERT INTO cozinha_retirada_itens (
      empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
      tipo_evento,qty_millis,operador_id,autorizado_por_operador_id,
      operacao_id,evento_origem_id,justificativa
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, paramsEvento(evento));
}

describe('Sprint 2 — ledgers de retirada e cancelamento', () => {
  it('confirma isolamento obrigatório', () => {
    verificarAmbienteIsolado();
  });

  it('cria os dois ledgers e a estrutura esperada', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    const out = await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    assert.equal(out.success, true);
    assert.equal(out.foreignKeysEnabled, true);
    assert.deepEqual(out.foreignKeyCheck, []);

    const tabelas = await all(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cozinha_%itens'"
    );
    assert.ok(tabelas.some((row) => row.name === 'cozinha_retirada_itens'));
    assert.ok(tabelas.some((row) => row.name === 'cozinha_cancelamento_itens'));

    await close(db);
  });

  it('reexecução não duplica tabelas nem falha', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });

    const retirada = await get(db, "SELECT COUNT(*) AS n FROM cozinha_retirada_itens");
    const cancelamento = await get(db, "SELECT COUNT(*) AS n FROM cozinha_cancelamento_itens");
    assert.equal(retirada.n, 0);
    assert.equal(cancelamento.n, 0);
    await close(db);
  });

  it('rejeita quantidade zero, negativa e tipo inválido', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    const base = dadosRetiradaExemplo();

    await assert.rejects(
      () => inserirRetirada(db, { ...base, operacao_id: 'zero', qty_millis: 0 }),
      /CHECK constraint failed/
    );
    await assert.rejects(
      () => inserirRetirada(db, { ...base, operacao_id: 'negativo', qty_millis: -1 }),
      /CHECK constraint failed/
    );
    await assert.rejects(
      () => inserirRetirada(db, { ...base, operacao_id: 'tipo', tipo_evento: 'OUTRO' }),
      /CHECK constraint failed/
    );
    await close(db);
  });

  it('rejeita referência cruzada de pedido ou rodada', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });

    await assert.rejects(
      () => inserirRetirada(db, { ...dadosRetiradaExemplo(), pedido_id: 999, operacao_id: 'cross-pedido' }),
      /FOREIGN KEY constraint failed/
    );
    await assert.rejects(
      () => inserirRetirada(db, { ...dadosRetiradaExemplo(), rodada_id: 999, operacao_id: 'cross-rodada' }),
      /FOREIGN KEY constraint failed/
    );
    await close(db);
  });

  it('permite estornos parciais acumulados até o original', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await inserirRetirada(db, dadosRetiradaExemplo());
    const original = await get(db, 'SELECT id FROM cozinha_retirada_itens');

    await inserirRetirada(db, {
      ...dadosRetiradaExemplo(),
      tipo_evento: 'RETIRADA_ESTORNADA',
      qty_millis: 400,
      autorizado_por_operador_id: 7,
      operacao_id: 'estorno-1',
      evento_origem_id: original.id,
      justificativa: 'Retirada registrada incorretamente'
    });
    await inserirRetirada(db, {
      ...dadosRetiradaExemplo(),
      tipo_evento: 'RETIRADA_ESTORNADA',
      qty_millis: 300,
      autorizado_por_operador_id: 7,
      operacao_id: 'estorno-2',
      evento_origem_id: original.id,
      justificativa: 'Segunda correção parcial'
    });
    await assert.rejects(
      () => inserirRetirada(db, {
        ...dadosRetiradaExemplo(),
        tipo_evento: 'RETIRADA_ESTORNADA',
        qty_millis: 301,
        autorizado_por_operador_id: 7,
        operacao_id: 'estorno-excedente',
        evento_origem_id: original.id,
        justificativa: 'Estorno excedente'
      }),
      /estorno superior/
    );

    await close(db);
  });

  it('bloqueia estorno de estorno e origem de outro contexto', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await inserirRetirada(db, dadosRetiradaExemplo());
    const original = await get(db, 'SELECT id FROM cozinha_retirada_itens');

    await inserirRetirada(db, {
      ...dadosRetiradaExemplo(),
      tipo_evento: 'RETIRADA_ESTORNADA',
      qty_millis: 100,
      autorizado_por_operador_id: 7,
      operacao_id: 'estorno-original',
      evento_origem_id: original.id,
      justificativa: 'Correção válida'
    });
    const estorno = await get(db, "SELECT id FROM cozinha_retirada_itens WHERE operacao_id='estorno-original'");

    await assert.rejects(
      () => inserirRetirada(db, {
        ...dadosRetiradaExemplo(),
        tipo_evento: 'RETIRADA_ESTORNADA',
        qty_millis: 100,
        autorizado_por_operador_id: 7,
        operacao_id: 'estorno-estorno',
        evento_origem_id: estorno.id,
        justificativa: 'Não permitido'
      }),
      /referencia de retirada invalida/
    );
    await close(db);
  });

  it('bloqueia UPDATE e DELETE nos dois ledgers', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await inserirRetirada(db, {
      ...dadosRetiradaExemplo(),
      qty_millis: 500,
      operacao_id: 'op-retirada-append-only'
    });

    await assert.rejects(
      () => run(db, 'UPDATE cozinha_retirada_itens SET qty_millis=500'),
      /append-only/
    );
    await assert.rejects(
      () => run(db, 'DELETE FROM cozinha_retirada_itens'),
      /append-only/
    );

    await run(db, `
      INSERT INTO cozinha_cancelamento_itens (
        empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
        tipo_evento,qty_millis,operador_id,operacao_id,justificativa
      ) VALUES (1,40,10,20,70,50,'CANCELAMENTO_CONFIRMADO',100,7,'cancel-1',NULL)
    `);
    await assert.rejects(
      () => run(db, 'UPDATE cozinha_cancelamento_itens SET qty_millis=50'),
      /append-only/
    );
    await assert.rejects(
      () => run(db, 'DELETE FROM cozinha_cancelamento_itens'),
      /append-only/
    );
    await close(db);
  });

  it('representa estornos parciais de cancelamento e bloqueia excesso', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });

    await run(db, `
      INSERT INTO cozinha_cancelamento_itens (
        empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
        tipo_evento,qty_millis,operador_id,operacao_id,justificativa
      ) VALUES (1,40,10,20,70,50,'CANCELAMENTO_CONFIRMADO',500,7,'cancel-original',NULL)
    `);
    const original = await get(db, 'SELECT id FROM cozinha_cancelamento_itens');

    await run(db, `
      INSERT INTO cozinha_cancelamento_itens (
        empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
        tipo_evento,qty_millis,operador_id,autorizado_por_operador_id,
        operacao_id,evento_origem_id,justificativa
      ) VALUES (
        1,40,10,20,70,50,'CANCELAMENTO_ESTORNADO',200,7,7,
        'cancel-estorno-1',?, 'Cancelamento revertido'
      )
    `, [original.id]);

    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_cancelamento_itens (
          empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
          tipo_evento,qty_millis,operador_id,autorizado_por_operador_id,
          operacao_id,evento_origem_id,justificativa
        ) VALUES (
          1,40,10,20,70,50,'CANCELAMENTO_ESTORNADO',301,7,7,
          'cancel-estorno-excedente',?, 'Excede o original'
        )
      `, [original.id]),
      /estorno de cancelamento superior/
    );
    await close(db);
  });

  it('usa cozinha_idempotencia como unicidade central e não cria unicidade redundante no ledger', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });

    const listaCooc = await all(db, "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='cozinha_retirada_itens'");
    assert.ok(listaCooc.some((row) => String(row.name).includes('operacao')));
    assert.ok(!listaCooc.some((row) => /UNIQUE.*operacao_id/i.test(String(row.sql))));

    const central = await all(db, "PRAGMA index_list('cozinha_idempotencia')");
    assert.ok(central.some((row) => row.unique === 1));
    await close(db);
  });

  it('retorna foreign_key_check vazio após criação e reexecução', async () => {
    const db = await openDb();
    await schemaPreSprint2(db);
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
    await close(db);
  });
});
