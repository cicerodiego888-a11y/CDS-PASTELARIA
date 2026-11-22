'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint4-liberacao-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { validarLiberacaoPdv } = require('../../backend/services/cozinha/CozinhaLiberacaoPdvService');
const { executarMigracaoSprint1 } = require('../../backend/migrations/sprint1-pedidos-itens-empresa');
const { executarMigracaoSprint2 } = require('../../backend/migrations/sprint2-cozinha-ledgers');

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
  await run(db, 'INSERT INTO empresas(id) VALUES (1)');
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, nome TEXT, tipo_operacional TEXT,
    comercializavel INTEGER, utiliza_ficha_tecnica INTEGER, categoria_id INTEGER
  )`);
  await run(db, 'INSERT INTO produtos(id,nome) VALUES (30,\'Pastel\')');
  await run(db, 'INSERT INTO produtos(id,nome) VALUES (31,\'Bebida ou outro\')');
  await run(db, 'CREATE TABLE categorias (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT, role TEXT, perfil TEXT, ativo INTEGER DEFAULT 1)');
  await run(db, 'INSERT INTO usuarios(id,username,role,perfil,ativo) VALUES (7,\'garcom\',\'admin\',\'ADMIN\',1)');
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER,
      codigo TEXT,
      status TEXT DEFAULT 'PEDIDO'
    )
  `);
  await run(db, `
    CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER,
      quantidade REAL NOT NULL,
      subtotal REAL,
      classificacao_operacional_snapshot TEXT,
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
    )
  `);
  await run(db, 'CREATE TABLE cozinha_unidades (id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, codigo TEXT, UNIQUE(id,empresa_id))');
  await run(db, 'CREATE TABLE cozinha_rodadas (id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, unidade_id INTEGER NOT NULL, estado_preparacao TEXT, retirada_estado TEXT, UNIQUE(id,empresa_id))');
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
      qty_solicitada_millis INTEGER,
      qty_cancelada_millis INTEGER DEFAULT 0,
      UNIQUE(id,empresa_id)
    )
  `);
  await run(db, `
    CREATE TABLE cozinha_idempotencia (
      id INTEGER PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      tipo_operacao TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      contexto TEXT,
      situacao TEXT NOT NULL,
      resultado_json TEXT
    )
  `);
  await run(db, 'CREATE UNIQUE INDEX ux_cozinha_idempotencia_key ON cozinha_idempotencia(idempotency_key)');
  await run(db, 'CREATE TABLE cozinha_bebida_entregas (id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, cozinha_item_id INTEGER NOT NULL, rodada_id INTEGER NOT NULL, qty_entregue_millis INTEGER NOT NULL)');
  await run(db, 'CREATE UNIQUE INDEX ux_cozinha_rodadas_id_unidade_empresa ON cozinha_rodadas(id,unidade_id,empresa_id)');
  await run(db, 'CREATE UNIQUE INDEX ux_cozinha_itens_vinculo_retirada ON cozinha_itens(id,empresa_id,unidade_id,rodada_id,pedido_id,pedido_item_id)');
}

async function seed(db, tipo = 'PASTEL') {
  await run(db, 'INSERT INTO pedidos(id,empresa_id,codigo) VALUES (10,1,\'P10\')');
  await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,produto_id,quantidade,subtotal) VALUES (20,10,30,2,20)');
  await run(db, 'INSERT INTO cozinha_unidades(id,empresa_id,codigo) VALUES (40,1,\'COZ\')');
  await run(db, 'INSERT INTO cozinha_rodadas(id,empresa_id,unidade_id,estado_preparacao,retirada_estado) VALUES (50,1,40,\'PRONTA\',\'PENDENTE\')');
  await run(db, 'INSERT INTO cozinha_comandas(id,empresa_id) VALUES (60,1)');
  await run(db, `
    INSERT INTO cozinha_itens(
      id,empresa_id,unidade_id,rodada_id,comanda_id,pedido_id,pedido_item_id,
      tipo_item,estado_preparacao,qty_solicitada_millis,qty_cancelada_millis
    ) VALUES (70,1,40,50,60,10,20,?, 'PRONTO',2000,0)
  `, [tipo]);

  await executarMigracaoSprint1(db, { isolamentoExplicito: true });
  await executarMigracaoSprint2(db, { isolamentoExplicito: true });
}

async function retirar(db, qty = 2000) {
  await run(db, `
    INSERT INTO cozinha_retirada_itens(
      empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
      tipo_evento,qty_millis,operador_id,operacao_id,registrado_em
    ) VALUES (1,40,10,20,70,50,'RETIRADA_CONFIRMADA',?,7,'ret',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `, [qty]);
}

async function cancelar(db, qty = 500) {
  await run(db, `
    INSERT INTO cozinha_cancelamento_itens(
      empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
      tipo_evento,qty_millis,operador_id,operacao_id,justificativa,registrado_em
    ) VALUES (1,40,10,20,70,50,'CANCELAMENTO_CONFIRMADO',?,7,'cancel', 'Cancelado','2026-01-01T00:00:00.000Z')
  `, [qty]);
}

describe('Sprint 4 — liberação central por ledgers', () => {
  it('pedido sem cozinha continua liberado', async () => {
    const db = await openDb();
    await schema(db);
    await run(db, 'INSERT INTO pedidos(id,empresa_id,codigo) VALUES (11,1,\'AVULSO\')');
    await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,produto_id,quantidade,subtotal,classificacao_operacional_snapshot) VALUES (21,11,31,1,10,\'NAO_COZINHA\')');
    await executarMigracaoSprint1(db, { isolamentoExplicito: true });
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    assert.equal((await validarLiberacaoPdv({ pedidoId: 11, empresaId: 1 }, { db })).liberado, true);
    await close(db);
  });

  it('bloqueia item pronto sem retirada individual', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.codigo === 'COZINHA_RETIRADA_PENDENTE'
        && err.pendencias[0].qty_pendente === 2000
        && err.pendencias[0].qty_retirada_liquida === 0
    );
    await close(db);
  });

  it('libera retirada integral', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await retirar(db, 2000);
    assert.equal((await validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db })).liberado, true);
    await close(db);
  });

  it('bloqueia pedido comercial cancelado mesmo com retirada integral no ledger', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await retirar(db, 2000);
    await run(db, `UPDATE pedidos SET status='CANCELADO' WHERE id=10`);
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.codigo === 'PEDIDO_CANCELADO' && err.statusCode === 409
    );
    await close(db);
  });

  it('cancelamento líquido reduz a exigível', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await cancelar(db, 500);
    await retirar(db, 1500);
    assert.equal((await validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db })).liberado, true);
    await close(db);
  });

  it('retirada excedente bloqueia', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await run(db, 'UPDATE pedidos_itens SET quantidade=1.000 WHERE id=20');
    await retirar(db, 2000);
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.codigo === 'COZINHA_RETIRADA_PENDENTE'
        && err.pendencias[0].motivo === 'RETIRADA_SUPERIOR_A_EXIGIVEL'
    );
    await close(db);
  });

  it('item sem rodada é bloqueado', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await run(db, 'UPDATE cozinha_itens SET rodada_id=999');
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.codigo === 'COZINHA_RETIRADA_PENDENTE'
        && err.pendencias.some((p) => p.motivo === 'RODADA_OU_ITEM_ORFAO')
    );
    await close(db);
  });

  it('rodada compartilhada filtra pelo pedido', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await run(db, 'INSERT INTO pedidos(id,empresa_id,codigo) VALUES (11,1,\'P11\')');
    await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,produto_id,quantidade,subtotal) VALUES (21,11,31,1,10)');
    await executarMigracaoSprint1(db, { isolamentoExplicito: true });
    await run(db, `
      INSERT INTO cozinha_itens(
        id,empresa_id,unidade_id,rodada_id,comanda_id,pedido_id,pedido_item_id,
        tipo_item,estado_preparacao,qty_solicitada_millis,qty_cancelada_millis
      ) VALUES (71,1,40,50,60,11,21,'PASTEL','PRONTO',1000,0)
    `);
    await retirar(db, 2000);
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 11, empresaId: 1 }, { db }),
      (err) => err.codigo === 'COZINHA_RETIRADA_PENDENTE'
    );
    await close(db);
  });

  it('bebida exige entrega completa e retirada completa', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db, 'BEBIDA');
    await run(db, 'INSERT INTO cozinha_bebida_entregas(id,empresa_id,cozinha_item_id,rodada_id,qty_entregue_millis) VALUES (1,1,70,50,1000)');
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.pendencias[0].motivo === 'ENTREGA_BEBIDA_INCOMPLETA'
    );
    await run(db, 'UPDATE cozinha_bebida_entregas SET qty_entregue_millis=2000');
    await retirar(db, 2000);
    assert.equal((await validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db })).liberado, true);
    await close(db);
  });

  it('entrega de bebida acima do exigível é bloqueada', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db, 'BEBIDA');
    await run(db, 'INSERT INTO cozinha_bebida_entregas(id,empresa_id,cozinha_item_id,rodada_id,qty_entregue_millis) VALUES (1,1,70,50,2500)');
    await retirar(db, 2000);
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.pendencias[0].motivo === 'ENTREGA_BEBIDA_ACIMA_DO_EXIGIVEL'
    );
    await close(db);
  });

  it('mantém ambíguo o item sem KDS quando o cadastro não comprova sua exigibilidade', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,empresa_id,produto_id,quantidade,subtotal) VALUES (21,10,1,31,1,10)');
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.pendencias.some((p) => p.motivo === 'CLASSIFICACAO_COZINHA_AMBIGUA')
    );
    await close(db);
  });

  it('identifica produto com ficha técnica como cozinha sem encaminhamento KDS', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await run(db, 'UPDATE produtos SET tipo_operacional=\'COMERCIAL\', utiliza_ficha_tecnica=1 WHERE id=31');
    await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,empresa_id,produto_id,quantidade,subtotal) VALUES (21,10,1,31,1,10)');
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.pendencias.some((p) => p.motivo === 'ITEM_COZINHA_SEM_ENCAMINHAMENTO'
        && p.tipo_cozinha === 'PASTEL'
        && p.classificacao_motivo === 'comercial_utiliza_ficha_tecnica')
    );
    await close(db);
  });

  it('identifica bebida comercializável por categoria como cozinha sem encaminhamento KDS', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db);
    await run(db, 'INSERT INTO categorias(id,nome) VALUES (8,\'Refrigerantes\')');
    await run(db, 'UPDATE produtos SET tipo_operacional=\'INSUMO\', comercializavel=1, categoria_id=8 WHERE id=31');
    await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,empresa_id,produto_id,quantidade,subtotal) VALUES (21,10,1,31,1,10)');
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.pendencias.some((p) => p.motivo === 'ITEM_COZINHA_SEM_ENCAMINHAMENTO'
        && p.tipo_cozinha === 'BEBIDA'
        && p.classificacao_motivo === 'insumo_comercializavel_categoria_refrigerante')
    );
    await close(db);
  });

  it('não compensa entrega assimétrica entre duas bebidas', async () => {
    const db = await openDb();
    await schema(db);
    await seed(db, 'BEBIDA');
    await run(db, 'UPDATE cozinha_itens SET qty_solicitada_millis=1000 WHERE id=70');
    await run(db, `
      INSERT INTO cozinha_itens(
        id,empresa_id,unidade_id,rodada_id,comanda_id,pedido_id,pedido_item_id,
        tipo_item,estado_preparacao,qty_solicitada_millis,qty_cancelada_millis
      ) VALUES (71,1,40,50,60,10,20,'BEBIDA','PRONTO',1000,0)
    `);
    await run(db, `
      INSERT INTO cozinha_retirada_itens(
        empresa_id,unidade_id,pedido_id,pedido_item_id,cozinha_item_id,rodada_id,
        tipo_evento,qty_millis,operador_id,operacao_id,registrado_em
      ) VALUES
        (1,40,10,20,70,50,'RETIRADA_CONFIRMADA',1000,7,'ret-bebida-70',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (1,40,10,20,71,50,'RETIRADA_CONFIRMADA',1000,7,'ret-bebida-71',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `);
    await run(db, 'INSERT INTO cozinha_bebida_entregas(id,empresa_id,cozinha_item_id,rodada_id,qty_entregue_millis) VALUES (1,1,70,50,2000),(2,1,71,50,0)');
    await assert.rejects(
      () => validarLiberacaoPdv({ pedidoId: 10, empresaId: 1 }, { db }),
      (err) => err.pendencias.some((p) =>
        p.motivo === 'ENTREGA_BEBIDA_INCOMPLETA'
        || p.motivo === 'ENTREGA_BEBIDA_ACIMA_DO_EXIGIVEL'
      )
    );
    await close(db);
  });

  it('leitura estática confirma os quatro endpoints e resolução por operação', () => {
    const pedidos = fs.readFileSync(path.join(__dirname, '../../backend/rotas/pedidos.js'), 'utf8');
    const vendas = fs.readFileSync(path.join(__dirname, '../../backend/rotas/vendas.js'), 'utf8');
    const faturamento = fs.readFileSync(path.join(__dirname, '../../backend/services/faturamento/FaturamentoService.js'), 'utf8');
    assert.match(pedidos, /:id\/preparar-venda-pdv/);
    assert.match(pedidos, /:id\/finalizar-venda-pdv/);
    assert.match(pedidos, /validarLiberacaoPdv/);
    assert.match(vendas, /pedido_faturamento_operacao_id/);
    assert.match(vendas, /validarLiberacaoPdv/);
    assert.match(faturamento, /validarLiberacaoPdv/);
  });

  it('inicializador oficial integra sequencialmente as migrations dos ledgers', () => {
    const database = fs.readFileSync(path.join(__dirname, '../../backend/database.js'), 'utf8');
    assert.match(database, /executarMigracaoSprint1/);
    assert.match(database, /executarMigracaoSprint2/);
    assert.ok(
      database.indexOf('executarMigracaoSprint1') < database.indexOf('executarMigracaoSprint2'),
      'Sprint 1 deve preceder Sprint 2 na inicialização'
    );
  });

  it('migrations Sprint 1 e 2 executam sequencialmente em banco limpo', async () => {
    const db = await openDb();
    await schema(db);
    await run(db, 'INSERT INTO pedidos(id,empresa_id,codigo) VALUES (10,1,\'P10\')');
    await run(db, 'INSERT INTO pedidos_itens(id,pedido_id,produto_id,quantidade,subtotal) VALUES (20,10,30,2,20)');
    await executarMigracaoSprint1(db, { isolamentoExplicito: true });
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    await executarMigracaoSprint1(db, { isolamentoExplicito: true });
    await executarMigracaoSprint2(db, { isolamentoExplicito: true });
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM pedidos_itens')).n), 1);
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
    await close(db);
  });
});
