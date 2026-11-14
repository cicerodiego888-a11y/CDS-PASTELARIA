'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { obterCaixaTurnoId } = require('../../backend/utils/caixaSessaoHelpers');
const {
  validarReferenciasPersistenciaVenda
} = require('../../backend/services/vendas/VendaReferenciaIntegridade');

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
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
function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function preparar() {
  const db = await abrirDb();
  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, 'CREATE TABLE empresas (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE caixas (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, `CREATE TABLE terminais (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    hostname TEXT NOT NULL UNIQUE,
    caixa_id INTEGER,
    FOREIGN KEY (caixa_id) REFERENCES caixas(id)
  )`);
  await run(db, `CREATE TABLE caixa (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    status TEXT DEFAULT 'aberto',
    terminal_id INTEGER REFERENCES terminais(id),
    aberto_por INTEGER REFERENCES usuarios(id)
  )`);
  await run(db, `CREATE TABLE caixa_sessoes (
    id INTEGER PRIMARY KEY,
    caixa_id INTEGER,
    caixa_turno_id INTEGER,
    terminal_id INTEGER,
    operador_id INTEGER,
    empresa_id INTEGER,
    status TEXT,
    FOREIGN KEY (caixa_id) REFERENCES caixas(id),
    FOREIGN KEY (caixa_turno_id) REFERENCES caixa(id),
    FOREIGN KEY (terminal_id) REFERENCES terminais(id),
    FOREIGN KEY (operador_id) REFERENCES usuarios(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT,
    data_venda TEXT NOT NULL,
    cliente_id INTEGER,
    total REAL NOT NULL,
    caixa_id INTEGER,
    caixa_sessao_id INTEGER,
    terminal_id INTEGER,
    operador_id INTEGER,
    empresa_id INTEGER,
    FOREIGN KEY (cliente_id) REFERENCES clientes(id),
    FOREIGN KEY (caixa_id) REFERENCES caixa(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (caixa_sessao_id) REFERENCES caixa_sessoes(id),
    FOREIGN KEY (terminal_id) REFERENCES terminais(id),
    FOREIGN KEY (operador_id) REFERENCES usuarios(id)
  )`);
  await run(db, `INSERT INTO empresas (id, nome) VALUES (1, 'Pastelaria')`);
  await run(db, `INSERT INTO usuarios (id, nome) VALUES (2, 'Operador')`);
  await run(db, `INSERT INTO caixas (id, nome) VALUES (8, 'Cadastro PDV')`);
  await run(db, `INSERT INTO terminais (id, nome, hostname, caixa_id) VALUES (3, 'Caixa 1', 'pdv-01', 8)`);
  await run(db, `INSERT INTO terminais (id, nome, hostname, caixa_id) VALUES (4, 'Caixa 2', 'pdv-02', 8)`);
  await run(db, `INSERT INTO caixa (id, data, status, terminal_id, aberto_por) VALUES (15, '2026-11-12', 'aberto', 3, 2)`);
  await run(db, `INSERT INTO caixa (id, data, status, terminal_id, aberto_por) VALUES (21, '2026-11-12', 'aberto', 3, 2)`);
  await run(db, `INSERT INTO caixa_sessoes (
    id, caixa_id, caixa_turno_id, terminal_id, operador_id, empresa_id, status
  ) VALUES (8, 8, NULL, 3, 2, 1, 'aberto')`);
  await run(db, `INSERT INTO caixa_sessoes (
    id, caixa_id, caixa_turno_id, terminal_id, operador_id, empresa_id, status
  ) VALUES (9, 8, 15, 3, 2, 1, 'aberto')`);
  return db;
}

function inserirVenda(db, refs) {
  return run(db, `INSERT INTO vendas (
    codigo, data_venda, total, caixa_id, caixa_sessao_id, terminal_id, operador_id, empresa_id
  ) VALUES ('T', '2026-11-12', 10, ?, ?, ?, ?, 1)`, [
    refs.caixaId,
    refs.caixaSessaoId,
    refs.terminalId,
    refs.operadorId
  ]);
}

test('a chave que falha é vendas.caixa_id quando o cadastro 8 entra no lugar do turno', async () => {
  const db = await preparar();
  try {
    const fk = await get(db, 'PRAGMA foreign_keys');
    assert.equal(fk.foreign_keys, 1);
    const lista = await all(db, 'PRAGMA foreign_key_list(vendas)');
    const caixa = lista.find((item) => item.from === 'caixa_id');
    const sessao = lista.find((item) => item.from === 'caixa_sessao_id');
    assert.equal(caixa.table, 'caixa');
    assert.equal(caixa.to, 'id');
    assert.equal(sessao.table, 'caixa_sessoes');
    const sessaoSemTurno = await get(db, 'SELECT id, caixa_id, caixa_turno_id FROM caixa_sessoes WHERE id = 8');
    assert.equal(sessaoSemTurno.caixa_id, 8);
    assert.equal(sessaoSemTurno.caixa_turno_id, null);
    assert.equal(obterCaixaTurnoId(sessaoSemTurno), null);
    assert.equal((await get(db, 'SELECT id FROM caixas WHERE id = 8')).id, 8);
    assert.equal(await get(db, 'SELECT id FROM caixa WHERE id = 8'), null);
    assert.equal((await get(db, 'SELECT id FROM terminais WHERE id = 3')).id, 3);
    assert.equal((await get(db, 'SELECT id FROM usuarios WHERE id = 2')).id, 2);

    await assert.rejects(
      () => inserirVenda(db, {
        caixaId: 8,
        caixaSessaoId: 8,
        terminalId: 3,
        operadorId: 2
      }),
      /FOREIGN KEY/
    );
    await inserirVenda(db, {
      caixaId: null,
      caixaSessaoId: 8,
      terminalId: 3,
      operadorId: 2
    });
    const gravada = await get(db, 'SELECT caixa_id, caixa_sessao_id FROM vendas WHERE id = 1');
    assert.equal(gravada.caixa_id, null);
    assert.equal(gravada.caixa_sessao_id, 8);
    await run(db, 'DELETE FROM vendas');

    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, {
        caixaId: 8,
        caixaSessaoId: 8,
        terminalId: 3,
        operadorId: 2,
        empresaId: 1
      }),
      (err) => {
        assert.equal(err.codigo, 'SESSAO_SEM_TURNO');
        assert.equal(err.referencia.caixa_cadastro_id, 8);
        assert.equal(err.referencia.caixa_sessao_id, 8);
        return true;
      }
    );
    const restante = await get(db, 'SELECT COUNT(*) AS n FROM vendas');
    assert.equal(restante.n, 0);
  } finally {
    await fecharDb(db);
  }
});

test('referências válidas gravam o turno 15 e a sessão 9, sem igualar os números', async () => {
  const db = await preparar();
  try {
    const refs = await validarReferenciasPersistenciaVenda(db, {
      caixaId: 15,
      caixaSessaoId: 9,
      terminalId: 3,
      operadorId: 2,
      empresaId: 1
    });
    assert.equal(refs.caixaId, 15);
    assert.equal(refs.caixaSessaoId, 9);
    assert.notEqual(refs.caixaId, refs.caixaSessaoId);
    await inserirVenda(db, refs);
    const venda = await get(db, 'SELECT caixa_id, caixa_sessao_id, terminal_id, operador_id FROM vendas');
    assert.equal(venda.caixa_id, 15);
    assert.equal(venda.caixa_sessao_id, 9);
    assert.equal(venda.terminal_id, 3);
    assert.equal(venda.operador_id, 2);
  } finally {
    await fecharDb(db);
  }
});

test('cada referência ausente ou incompatível recebe a mensagem da chave correspondente', async () => {
  const db = await preparar();
  try {
    const base = {
      caixaId: 15,
      caixaSessaoId: 9,
      terminalId: 3,
      operadorId: 2,
      empresaId: 1
    };
    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, { ...base, caixaId: 77, caixaSessaoId: null }),
      (err) => err.codigo === 'CAIXA_INEXISTENTE' && err.referencia.coluna === 'caixa_id'
    );
    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, { ...base, caixaSessaoId: 77 }),
      (err) => err.codigo === 'SESSAO_INEXISTENTE'
    );
    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, { ...base, caixaSessaoId: null, terminalId: 77 }),
      (err) => err.codigo === 'TERMINAL_INEXISTENTE' && err.referencia.coluna === 'terminal_id'
    );
    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, { ...base, operadorId: 77 }),
      (err) => err.codigo === 'OPERADOR_INEXISTENTE' && err.referencia.coluna === 'operador_id'
    );
    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, { ...base, caixaId: 21 }),
      (err) => err.codigo === 'SESSAO_OUTRO_CAIXA' && err.referencia.caixa_turno_id === 15
    );
    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, { ...base, terminalId: 4 }),
      (err) => err.codigo === 'TERMINAL_INCOMPATIVEL' && err.referencia.terminal_da_sessao === 3
    );
    const total = await get(db, 'SELECT COUNT(*) AS n FROM vendas');
    assert.equal(total.n, 0);
  } finally {
    await fecharDb(db);
  }
});

test('falha no meio da transação desfaz a venda e a repetição grava uma vez', async () => {
  const db = await preparar();
  try {
    await run(db, 'BEGIN');
    const refs = await validarReferenciasPersistenciaVenda(db, {
      caixaId: 15,
      caixaSessaoId: 9,
      terminalId: 3,
      operadorId: 2,
      empresaId: 1
    });
    await inserirVenda(db, refs);
    await run(db, 'ROLLBACK');
    assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM vendas')).n, 0);

    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, {
        caixaId: 15,
        caixaSessaoId: 9,
        terminalId: 99,
        operadorId: 2,
        empresaId: 1
      }),
      (err) => err.codigo === 'TERMINAL_INCOMPATIVEL'
    );
    assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM vendas')).n, 0);

    await run(db, 'BEGIN');
    const novamente = await validarReferenciasPersistenciaVenda(db, {
      caixaSessaoId: 9,
      terminalId: 3,
      operadorId: 2,
      empresaId: 1
    });
    assert.equal(novamente.caixaId, 15);
    await inserirVenda(db, novamente);
    await run(db, 'COMMIT');
    const vendas = await all(db, 'SELECT caixa_id, caixa_sessao_id FROM vendas');
    assert.equal(vendas.length, 1);
    assert.equal(vendas[0].caixa_id, 15);
    assert.equal(vendas[0].caixa_sessao_id, 9);
  } finally {
    await fecharDb(db);
  }
});
