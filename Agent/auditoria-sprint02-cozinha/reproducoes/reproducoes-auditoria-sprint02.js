/**
 * Reproduções isoladas de auditoria Sprint 02 — banco temporário apenas.
 * NÃO altera o projeto. Executar a partir da raiz do repositório:
 *
 *   node Agent/auditoria-sprint02-cozinha/reproducoes/reproducoes-auditoria-sprint02.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-s02-audit-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const root = path.resolve(__dirname, '..', '..', '..');
const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional
} = require(path.join(root, 'backend/utils/cozinhaSchema'));
const CozinhaDespacho = require(path.join(root, 'backend/services/cozinha/CozinhaDespachoService'));

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
function open(arquivo) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo || ':memory:', (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (e) => (e ? reject(e) : resolve(db)));
      });
    });
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function schemaErp(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS configuracoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chave VARCHAR(100) UNIQUE NOT NULL,
    valor TEXT, tipo VARCHAR(50), descricao TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE IF NOT EXISTS mesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, numero INTEGER NOT NULL, ativo INTEGER DEFAULT 1)`);
  await run(db, `CREATE TABLE IF NOT EXISTS mesa_atendimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, mesa_id INTEGER NOT NULL,
    estado TEXT NOT NULL, operador_abertura_id INTEGER NOT NULL DEFAULT 1, aberto_em TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, tipo_operacional TEXT DEFAULT 'COMERCIAL')`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, codigo VARCHAR(50), data_pedido DATE DEFAULT '2026-01-01',
    total DECIMAL(10,2) DEFAULT 0, status TEXT DEFAULT 'PEDIDO', empresa_id INTEGER, mesa_id INTEGER, mesa_atendimento_id INTEGER)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL,
    quantidade REAL NOT NULL, preco_unitario DECIMAL(10,2) DEFAULT 0, subtotal DECIMAL(10,2) DEFAULT 0,
    classificacao_operacional_snapshot TEXT, produto_nome_snapshot TEXT)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, pedido_item_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL, insumo_id INTEGER NOT NULL, insumo_nome_snapshot TEXT NOT NULL,
    quantidade_snapshot REAL NOT NULL, unidade_snapshot TEXT NOT NULL,
    classificacao_comercial_snapshot TEXT NOT NULL, selecionado INTEGER NOT NULL, preco_adicional_snapshot REAL DEFAULT 0)`);
  await garantirSchemaCozinha(db);
}

async function seed(db) {
  const mesa = await run(db, `INSERT INTO mesas (empresa_id, numero) VALUES (1, 5)`);
  const at = await run(db, `INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado) VALUES (1, ?, 'OCUPADA')`, [mesa.lastID]);
  const un = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual) VALUES (1, 'U1', 0)`);
  const prod = await run(db, `INSERT INTO produtos (nome) VALUES ('Pastel')`);
  async function ped(n, qty) {
    const p = await run(db, `INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id)
      VALUES (?, 'PEDIDO', 1, ?, ?)`, [`P${n}`, mesa.lastID, at.lastID]);
    const i = await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, produto_nome_snapshot)
      VALUES (?, ?, ?, 'Pastel')`, [p.lastID, prod.lastID, qty]);
    const c = await run(db, `INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, pedido_id)
      VALUES (1, ?, ?, ?)`, [at.lastID, n, p.lastID]);
    return { pedidoId: p.lastID, pedidoItemId: i.lastID, comandaId: c.lastID };
  }
  const a = await ped(1, 2);
  const b = await ped(2, 1);
  return {
    empresaId: 1, operadorId: 7, mesaId: mesa.lastID, atendimentoId: at.lastID, unidadeId: un.lastID,
    a, b
  };
}

function entrada(ctx, itens, key) {
  return {
    empresaId: ctx.empresaId, operadorId: ctx.operadorId, idempotencyKey: key,
    unidade_id: ctx.unidadeId, mesa_id: ctx.mesaId, atendimento_id: ctx.atendimentoId, itens
  };
}

const resultados = [];

function ok(nome, detalhe) {
  resultados.push({ nome, ok: true, detalhe });
  console.log(`PASS  ${nome} — ${detalhe}`);
}
function fail(nome, detalhe) {
  resultados.push({ nome, ok: false, detalhe });
  console.log(`FAIL  ${nome} — ${detalhe}`);
}

async function main() {
  marcarCozinhaOperacional(false);

  // R1 — concorrência chaves diferentes (já coberto no suite; reconfirma)
  {
    const arquivo = path.join(dbDir, 'r1.sqlite');
    let db = await open(arquivo);
    await schemaErp(db);
    const ctx = await seed(db);
    await close(db);
    const [x, y] = await Promise.all([
      (async () => {
        const d = await open(arquivo);
        try {
          return await CozinhaDespacho.despacharLote(entrada(ctx, [{
            pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
            comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
          }], 'r1-a'), { db: d });
        } finally { await close(d); }
      })(),
      (async () => {
        const d = await open(arquivo);
        try {
          return await CozinhaDespacho.despacharLote(entrada(ctx, [{
            pedido_id: ctx.b.pedidoId, pedido_item_id: ctx.b.pedidoItemId,
            comanda_id: ctx.b.comandaId, qty_solicitada: '1.000'
          }], 'r1-b'), { db: d });
        } finally { await close(d); }
      })()
    ]);
    const seqs = [x.rodada.sequencia_global, y.rodada.sequencia_global].sort();
    if (seqs[0] === 1 && seqs[1] === 2) ok('R1 concorrência chaves distintas', `seqs=${seqs.join(',')}`);
    else fail('R1 concorrência chaves distintas', `seqs=${seqs.join(',')}`);
  }

  // R2 — concorrência mesma chave
  {
    const arquivo = path.join(dbDir, 'r2.sqlite');
    let db = await open(arquivo);
    await schemaErp(db);
    const ctx = await seed(db);
    await close(db);
    const outs = await Promise.allSettled([
      (async () => {
        const d = await open(arquivo);
        try {
          return await CozinhaDespacho.despacharLote(entrada(ctx, [{
            pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
            comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
          }], 'r2-same'), { db: d });
        } finally { await close(d); }
      })(),
      (async () => {
        const d = await open(arquivo);
        try {
          return await CozinhaDespacho.despacharLote(entrada(ctx, [{
            pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
            comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
          }], 'r2-same'), { db: d });
        } finally { await close(d); }
      })()
    ]);
    db = await open(arquivo);
    const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
    const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id=?`, [ctx.unidadeId]);
    await close(db);
    const fulfilled = outs.filter((o) => o.status === 'fulfilled');
    const rejected = outs.filter((o) => o.status === 'rejected');
    const okCount = rods.length === 1 && un.sequencia_atual === 1 && fulfilled.length >= 1;
    if (okCount) {
      ok('R2 concorrência mesma chave',
        `rodadas=${rods.length} seq=${un.sequencia_atual} fulfilled=${fulfilled.length} rejected=${rejected.length} ` +
        `rejCodes=${rejected.map((r) => r.reason && r.reason.codigo).join('|')}`);
    } else {
      fail('R2 concorrência mesma chave',
        `rodadas=${rods.length} seq=${un.sequencia_atual} fulfilled=${fulfilled.length}`);
    }
  }

  // R3 — replay após alteração do pedido (suite 9; reconfirma)
  {
    const db = await open();
    await schemaErp(db);
    const ctx = await seed(db);
    const payload = entrada(ctx, [{
      pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
      comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
    }], 'r3');
    const first = await CozinhaDespacho.despacharLote(payload, { db });
    await run(db, `UPDATE pedidos SET status='CANCELADO' WHERE id=?`, [ctx.a.pedidoId]);
    const second = await CozinhaDespacho.despacharLote(payload, { db });
    const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
    await close(db);
    if (second.repetida && second.rodada.id === first.rodada.id && rods.length === 1) {
      ok('R3 replay após alteração pedido', `rodada=${first.rodada.id}`);
    } else fail('R3 replay após alteração pedido', JSON.stringify(second));
  }

  // R4 — falha após incremento FIFO (trigger artificial)
  {
    const db = await open();
    await schemaErp(db);
    const ctx = await seed(db);
    await run(db, `
      CREATE TRIGGER audit_fail_after_fifo
      AFTER UPDATE OF sequencia_atual ON cozinha_unidades
      BEGIN
        SELECT RAISE(ABORT, 'AUDIT_FORCE_FAIL_AFTER_FIFO');
      END
    `);
    let erro;
    try {
      await CozinhaDespacho.despacharLote(entrada(ctx, [{
        pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
        comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
      }], 'r4'), { db });
    } catch (e) { erro = e; }
    const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id=?`, [ctx.unidadeId]);
    const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
    const itens = await all(db, `SELECT id FROM cozinha_itens`);
    const idemp = await get(db, `SELECT * FROM cozinha_idempotencia WHERE idempotency_key='r4'`);
    await close(db);
    if (erro && un.sequencia_atual === 0 && rods.length === 0 && itens.length === 0 && !idemp) {
      ok('R4 falha após incremento FIFO → rollback', `msg=${erro.message}`);
    } else {
      fail('R4 falha após incremento FIFO → rollback',
        `seq=${un.sequencia_atual} rods=${rods.length} itens=${itens.length} idemp=${!!idemp} err=${erro && erro.message}`);
    }
  }

  // R5 — falha após criação parcial de itens (trigger no 2º insert)
  {
    const db = await open();
    await schemaErp(db);
    const ctx = await seed(db);
    await run(db, `
      CREATE TRIGGER audit_fail_second_item
      BEFORE INSERT ON cozinha_itens
      WHEN (SELECT COUNT(*) FROM cozinha_itens) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'AUDIT_FORCE_FAIL_PARTIAL_ITENS');
      END
    `);
    let erro;
    try {
      await CozinhaDespacho.despacharLote(entrada(ctx, [
        {
          pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
          comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
        },
        {
          pedido_id: ctx.b.pedidoId, pedido_item_id: ctx.b.pedidoItemId,
          comanda_id: ctx.b.comandaId, qty_solicitada: '1.000'
        }
      ], 'r5'), { db });
    } catch (e) { erro = e; }
    const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id=?`, [ctx.unidadeId]);
    const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
    const itens = await all(db, `SELECT id FROM cozinha_itens`);
    await close(db);
    if (erro && un.sequencia_atual === 0 && rods.length === 0 && itens.length === 0) {
      ok('R5 falha após item parcial → rollback total', `msg=${erro.message}`);
    } else {
      fail('R5 falha após item parcial → rollback total',
        `seq=${un.sequencia_atual} rods=${rods.length} itens=${itens.length}`);
    }
  }

  // R6 — item duplicado no payload
  {
    const db = await open();
    await schemaErp(db);
    const ctx = await seed(db);
    let erro;
    try {
      await CozinhaDespacho.despacharLote(entrada(ctx, [
        {
          pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
          comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
        },
        {
          pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
          comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
        }
      ], 'r6'), { db });
    } catch (e) { erro = e; }
    await close(db);
    if (erro && erro.codigo === 'ITEM_DUPLICADO_NO_LOTE') ok('R6 item duplicado no payload', erro.codigo);
    else fail('R6 item duplicado no payload', erro && erro.codigo);
  }

  // R7 — item de unidade diferente: payload não carrega unidade por item
  {
    resultados.push({
      nome: 'R7 unidade diferente por item',
      ok: null,
      detalhe: 'AUSÊNCIA DE COBERTURA NO SERVIÇO: unidade_id é única por requisição; não há campo unidade por item. Mistura de unidades no lote não é modelada no contrato atual.'
    });
    console.log('INFO  R7 unidade diferente por item — sem validação por-item (contrato: 1 unidade/lote)');
  }

  // R8 — comanda de outro atendimento
  {
    const db = await open();
    await schemaErp(db);
    const ctx = await seed(db);
    const at2 = await run(db, `INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado) VALUES (1, ?, 'OCUPADA')`, [ctx.mesaId]);
    // Move comanda B para outro atendimento
    await run(db, `UPDATE cozinha_comandas SET atendimento_id=? WHERE id=?`, [at2.lastID, ctx.b.comandaId]);
    let erro;
    try {
      await CozinhaDespacho.despacharLote(entrada(ctx, [{
        pedido_id: ctx.b.pedidoId, pedido_item_id: ctx.b.pedidoItemId,
        comanda_id: ctx.b.comandaId, qty_solicitada: '1.000'
      }], 'r8'), { db });
    } catch (e) { erro = e; }
    await close(db);
    if (erro && erro.codigo === 'COMANDA_ATENDIMENTO_INCOMPATIVEL') {
      ok('R8 comanda outro atendimento', erro.codigo);
    } else fail('R8 comanda outro atendimento', erro && erro.codigo);
  }

  // R9 — qty > teto
  {
    const db = await open();
    await schemaErp(db);
    const ctx = await seed(db);
    let erro;
    try {
      await CozinhaDespacho.despacharLote(entrada(ctx, [{
        pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
        comanda_id: ctx.a.comandaId, qty_solicitada: '9.000'
      }], 'r9'), { db });
    } catch (e) { erro = e; }
    await close(db);
    if (erro && erro.codigo === 'QTY_EXCEDE_RESTANTE') ok('R9 qty > teto', erro.codigo);
    else fail('R9 qty > teto', erro && erro.codigo);
  }

  // R10 — mesma chave payload semanticamente diferente
  {
    const db = await open();
    await schemaErp(db);
    const ctx = await seed(db);
    await CozinhaDespacho.despacharLote(entrada(ctx, [{
      pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
      comanda_id: ctx.a.comandaId, qty_solicitada: '1.000'
    }], 'r10'), { db });
    let erro;
    try {
      await CozinhaDespacho.despacharLote(entrada(ctx, [{
        pedido_id: ctx.a.pedidoId, pedido_item_id: ctx.a.pedidoItemId,
        comanda_id: ctx.a.comandaId, qty_solicitada: '2.000'
      }], 'r10'), { db });
    } catch (e) { erro = e; }
    await close(db);
    if (erro && erro.codigo === 'IDEMPOTENCY_PAYLOAD_DIVERGENTE') {
      ok('R10 mesma chave payload diferente', erro.codigo);
    } else fail('R10 mesma chave payload diferente', erro && erro.codigo);
  }

  const outPath = path.join(__dirname, 'RESULTADO-REPRODUCOES.json');
  fs.writeFileSync(outPath, JSON.stringify({ geradoEm: new Date().toISOString(), dbDir, resultados }, null, 2), 'utf8');
  console.log('\n--- RESUMO ---');
  console.log(JSON.stringify(resultados, null, 2));
  console.log('Escrito:', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
