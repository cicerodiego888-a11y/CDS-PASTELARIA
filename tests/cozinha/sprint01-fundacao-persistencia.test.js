/**
 * Sprint 01 — Fundação de persistência Cozinha V1.2.3
 * Banco temporário (:memory: / tmp). Sem banco oficial.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/cozinha/sprint01-fundacao-persistencia.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s01-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaCozinha } = require('../../backend/utils/cozinhaSchema');
const {
  decimalParaMilessimos,
  milessimosParaDecimalString,
  somarMilessimos,
  subtrairMilessimos,
  compararMilessimos,
  serializarQtyParaHash
} = require('../../backend/services/cozinha/cozinhaQuantidade');
const {
  TIPOS_OPERACAO,
  calcularPayloadHash,
  calcularHashOperacao,
  canonicalJson,
  montarPayloadSemantico
} = require('../../backend/services/cozinha/cozinhaIdempotenciaHash');

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
      db.run('PRAGMA foreign_keys = ON', (fkErr) => (fkErr ? reject(fkErr) : resolve(db)));
    });
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function baseMinima(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave VARCHAR(100) UNIQUE NOT NULL,
      valor TEXT,
      tipo VARCHAR(50),
      descricao TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await garantirSchemaCozinha(db);
}

const TABELAS = [
  'cozinha_unidades',
  'cozinha_comandas',
  'cozinha_rodadas',
  'cozinha_itens',
  'cozinha_item_ingredientes',
  'cozinha_bebida_entregas',
  'cozinha_impressao_fila',
  'cozinha_notificacoes',
  'cozinha_eventos_outbox',
  'cozinha_estacoes_impressao',
  'cozinha_autorizacoes_qty',
  'cozinha_reducoes_teto',
  'cozinha_idempotencia',
  'cozinha_pedido_item_controle'
];

describe('Sprint 01 — Cozinha fundação (banco temporário)', () => {
  it('cria todas as tabelas e migração é idempotente', async () => {
    const db = await open();
    await baseMinima(db);
    await garantirSchemaCozinha(db);
    await garantirSchemaCozinha(db);

    for (const t of TABELAS) {
      const row = await get(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [t]);
      assert.ok(row, `tabela ausente: ${t}`);
    }

    const cfg = await get(db, `SELECT valor FROM configuracoes WHERE chave='cozinha_notificacao_modo'`);
    assert.equal(cfg.valor, 'INDIVIDUAL');
    await close(db);
  });

  it('UNIQUE global de idempotency_key e isolamento por empresa', async () => {
    const db = await open();
    await baseMinima(db);

    await run(db, `
      INSERT INTO cozinha_idempotencia (
        idempotency_key, tipo_operacao, contexto, payload_hash, situacao
      ) VALUES ('k-1', 'AUTORIZAR_QTY', '{"empresa_id":1}', 'abc', 'CONCLUIDA')
    `);

    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_idempotencia (
          idempotency_key, tipo_operacao, contexto, payload_hash, situacao
        ) VALUES ('k-1', 'DESPACHO_LOTE', '{"empresa_id":2}', 'def', 'EM_ANDAMENTO')
      `),
      (err) => /UNIQUE/i.test(String(err.message))
    );

    await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual) VALUES (1, 'U1', 0)
    `);
    await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual) VALUES (2, 'U1', 0)
    `);
    const unidades = await all(db, `SELECT empresa_id, codigo FROM cozinha_unidades ORDER BY empresa_id`);
    assert.equal(unidades.length, 2);
    assert.equal(unidades[0].empresa_id, 1);
    assert.equal(unidades[1].empresa_id, 2);

    await close(db);
  });

  it('FK entre domínio cozinha e rollback sem resíduos', async () => {
    const db = await open();
    await baseMinima(db);

    await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo) VALUES (1, 'A')`);
    const u = await get(db, `SELECT id FROM cozinha_unidades`);

    await run(db, `
      INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, rotulo)
      VALUES (1, 10, 1, 'João')
    `);
    const c = await get(db, `SELECT id FROM cozinha_comandas`);

    await run(db, `
      INSERT INTO cozinha_rodadas (
        empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
      ) VALUES (1, ?, 5, 10, 1, 1)
    `, [u.id]);
    const r = await get(db, `SELECT id FROM cozinha_rodadas`);

    await run(db, `
      INSERT INTO cozinha_itens (
        empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
        sequencia_global, tipo_item, qty_solicitada_millis
      ) VALUES (1, ?, ?, ?, 100, 200, 1, 'PASTEL', 1000)
    `, [u.id, r.id, c.id]);

    await run(db, 'BEGIN');
    try {
      await run(db, `
        INSERT INTO cozinha_itens (
          empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global, tipo_item, qty_solicitada_millis
        ) VALUES (1, ?, 999999, ?, 100, 201, 1, 'PASTEL', 1000)
      `, [u.id, c.id]);
      await run(db, 'COMMIT');
      assert.fail('deveria falhar FK');
    } catch (err) {
      await run(db, 'ROLLBACK');
      assert.match(String(err.message), /FOREIGN KEY|constraint/i);
    }

    const count = await get(db, `SELECT COUNT(*) AS n FROM cozinha_itens`);
    assert.equal(count.n, 1);
    await close(db);
  });

  it('idempotência: replay mesmo hash; conflito hash/operação', async () => {
    const db = await open();
    await baseMinima(db);

    const hashA = calcularHashOperacao(TIPOS_OPERACAO.AUTORIZAR_QTY, {
      pedido_item_id: 10,
      empresa_id: 1,
      qty_adicional: '2.000',
      motivo: 'extra',
      responsavel_operador_id: 7
    });

    await run(db, `
      INSERT INTO cozinha_idempotencia (
        idempotency_key, tipo_operacao, contexto, payload_hash, situacao,
        resultado_http_status, resultado_json, recurso_tipo, recurso_id, concluded_at
      ) VALUES (?, 'AUTORIZAR_QTY', '{}', ?, 'CONCLUIDA', 201, '{"ok":true,"id":1}', 'autorizacao', 1, datetime('now'))
    `, ['op-key', hashA]);

    const hit = await get(db, `SELECT * FROM cozinha_idempotencia WHERE idempotency_key=?`, ['op-key']);
    assert.equal(hit.situacao, 'CONCLUIDA');
    assert.equal(hit.payload_hash, hashA);
    assert.equal(JSON.parse(hit.resultado_json).id, 1);

    const hashB = calcularHashOperacao(TIPOS_OPERACAO.AUTORIZAR_QTY, {
      pedido_item_id: 10,
      empresa_id: 1,
      qty_adicional: '3.000',
      motivo: 'extra',
      responsavel_operador_id: 7
    });
    assert.notEqual(hashA, hashB);

    // Mesmo key + hash diferente → conflito conceitual (aplicação rejeita; DB mantém um registro)
    assert.notEqual(hit.payload_hash, hashB);

    // Mesma key não pode inserir outra operação
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_idempotencia (
          idempotency_key, tipo_operacao, payload_hash, situacao
        ) VALUES ('op-key', 'DESPACHO_LOTE', ?, 'EM_ANDAMENTO')
      `, [hashA]),
      (err) => /UNIQUE/i.test(String(err.message))
    );

    await close(db);
  });

  it('concorrência: duas inserções com mesma key → um registro', async () => {
    const arquivo = path.join(dbDir, 'conc.sqlite');
    const db1 = await open(arquivo);
    await baseMinima(db1);
    await close(db1);

    async function tentarInserir(label) {
      const db = await open(arquivo);
      await run(db, 'PRAGMA busy_timeout = 5000');
      try {
        await run(db, 'BEGIN IMMEDIATE');
        try {
          await run(db, `
            INSERT INTO cozinha_idempotencia (
              idempotency_key, tipo_operacao, payload_hash, situacao, resultado_json
            ) VALUES ('conc-key', 'AUTORIZAR_QTY', 'hash-x', 'CONCLUIDA', ?)
          `, [JSON.stringify({ label })]);
          await run(db, 'COMMIT');
          return { ok: true, label };
        } catch (err) {
          try { await run(db, 'ROLLBACK'); } catch (_e) { /* ignore */ }
          return { ok: false, label, err: String(err.message) };
        }
      } finally {
        await close(db);
      }
    }

    const [a, b] = await Promise.all([tentarInserir('A'), tentarInserir('B')]);
    const sucessos = [a, b].filter((x) => x.ok);
    assert.equal(sucessos.length, 1, `esperado 1 sucesso, got ${JSON.stringify([a, b])}`);

    const db = await open(arquivo);
    const rows = await all(db, `SELECT * FROM cozinha_idempotencia WHERE idempotency_key='conc-key'`);
    assert.equal(rows.length, 1);
    await close(db);
  });
});

describe('Sprint 01 — Hash determinístico', () => {
  it('mesmas propriedades em ordem diferente → mesmo hash', () => {
    const h1 = calcularPayloadHash({ b: 1, a: 2, qty_adicional: '1.000' });
    const h2 = calcularPayloadHash({ a: 2, b: 1, qty_adicional: '1.000' });
    assert.equal(h1, h2);
  });

  it('ordem diferente de itens do lote → hash diferente', () => {
    const base = {
      tipo_operacao: TIPOS_OPERACAO.DESPACHO_LOTE,
      unidade_id: 1,
      atendimento_id: 2,
      mesa_id: 3,
      itens: [
        { pedido_item_id: 1, comanda_id: 10, qty_solicitada: '1.000' },
        { pedido_item_id: 2, comanda_id: 11, qty_solicitada: '2.000' }
      ]
    };
    const invertido = {
      ...base,
      itens: [base.itens[1], base.itens[0]]
    };
    assert.notEqual(calcularPayloadHash(base), calcularPayloadHash(invertido));
  });

  it('payload semanticamente diferente → hash diferente', () => {
    const a = montarPayloadSemantico(TIPOS_OPERACAO.AUTORIZAR_QTY, {
      pedido_item_id: 1, empresa_id: 1, qty_adicional: 1, motivo: 'a', responsavel_operador_id: 9
    });
    const b = montarPayloadSemantico(TIPOS_OPERACAO.AUTORIZAR_QTY, {
      pedido_item_id: 1, empresa_id: 1, qty_adicional: 2, motivo: 'a', responsavel_operador_id: 9
    });
    assert.notEqual(calcularPayloadHash(a), calcularPayloadHash(b));
  });

  it('timestamps de servidor não alteram o hash', () => {
    const h1 = calcularPayloadHash({
      tipo_operacao: 'AUTORIZAR_QTY',
      pedido_item_id: 1,
      qty_adicional: '1.500',
      created_at: '2026-01-01 00:00:00',
      enviada_em: '2026-01-02 00:00:00'
    });
    const h2 = calcularPayloadHash({
      tipo_operacao: 'AUTORIZAR_QTY',
      pedido_item_id: 1,
      qty_adicional: '1.500',
      created_at: '2099-12-31 23:59:59',
      enviada_em: '2099-12-31 23:59:59'
    });
    assert.equal(h1, h2);
  });

  it('quantidades equivalentes normalizadas → mesmo hash', () => {
    const h1 = calcularHashOperacao(TIPOS_OPERACAO.AUTORIZAR_QTY, {
      pedido_item_id: 5,
      empresa_id: 1,
      qty_adicional: '2',
      motivo: 'x',
      responsavel_operador_id: 1
    });
    const h2 = calcularHashOperacao(TIPOS_OPERACAO.AUTORIZAR_QTY, {
      pedido_item_id: 5,
      empresa_id: 1,
      qty_adicional: '2.000',
      motivo: 'x',
      responsavel_operador_id: 1
    });
    assert.equal(h1, h2);
    assert.equal(serializarQtyParaHash('2'), '2.000');
    assert.match(canonicalJson({ z: 1, a: 2 }), /^\{/);
  });
});

describe('Sprint 01 — Precisão em milésimos', () => {
  it('converte inteiros e fracionários', () => {
    assert.equal(decimalParaMilessimos('1'), 1000);
    assert.equal(decimalParaMilessimos('1.000'), 1000);
    assert.equal(decimalParaMilessimos('0.500'), 500);
    assert.equal(decimalParaMilessimos('0.250'), 250);
    assert.equal(decimalParaMilessimos('0.001'), 1);
    assert.equal(milessimosParaDecimalString(1000), '1.000');
    assert.equal(milessimosParaDecimalString(500), '0.500');
  });

  it('soma e subtração sem float', () => {
    assert.equal(somarMilessimos(100, 200), 300);
    assert.equal(subtrairMilessimos(1000, 250), 750);
    assert.equal(compararMilessimos(1, 2), -1);
    assert.equal(compararMilessimos(2, 2), 0);
  });

  it('rejeita mais de três casas', () => {
    assert.throws(
      () => decimalParaMilessimos('1.2345'),
      (err) => err && err.codigo === 'QTY_PRECISAO_INVALIDA'
    );
  });

  it('persistência de qty em INTEGER millis no banco temporário', async () => {
    const db = await open();
    await baseMinima(db);
    await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo) VALUES (1, 'X')`);
    const u = await get(db, `SELECT id FROM cozinha_unidades`);
    await run(db, `
      INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda)
      VALUES (1, 1, 1)
    `);
    const c = await get(db, `SELECT id FROM cozinha_comandas`);
    await run(db, `
      INSERT INTO cozinha_rodadas (
        empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
      ) VALUES (1, ?, 1, 1, 1, 1)
    `, [u.id]);
    const r = await get(db, `SELECT id FROM cozinha_rodadas`);
    const millis = decimalParaMilessimos('0.500');
    await run(db, `
      INSERT INTO cozinha_itens (
        empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
        sequencia_global, tipo_item, qty_solicitada_millis
      ) VALUES (1, ?, ?, ?, 1, 1, 1, 'OUTRO', ?)
    `, [u.id, r.id, c.id, millis]);
    const item = await get(db, `SELECT qty_solicitada_millis, typeof(qty_solicitada_millis) AS t FROM cozinha_itens`);
    assert.equal(item.qty_solicitada_millis, 500);
    assert.equal(item.t, 'integer');
    await close(db);
  });
});
