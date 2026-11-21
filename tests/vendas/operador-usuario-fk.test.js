'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const {
  idDeclaradoDoUsuario,
  resolverOperadorUsuario,
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
function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function preparar() {
  const db = await abrirDb();
  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, 'CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
  await run(db, `CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    nome TEXT,
    role TEXT,
    perfil TEXT,
    ativo INTEGER DEFAULT 1
  )`);
  await run(db, 'CREATE TABLE operadores (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, `CREATE TABLE usuario_empresas (
    id INTEGER PRIMARY KEY,
    usuario_id INTEGER,
    empresa_id INTEGER,
    ativo INTEGER DEFAULT 1,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )`);
  await run(db, 'CREATE TABLE caixas (id INTEGER PRIMARY KEY)');
  await run(db, 'CREATE TABLE terminais (id INTEGER PRIMARY KEY, nome TEXT, hostname TEXT)');
  await run(db, `CREATE TABLE caixa (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    status TEXT
  )`);
  await run(db, `CREATE TABLE caixa_sessoes (
    id INTEGER PRIMARY KEY,
    caixa_id INTEGER,
    caixa_turno_id INTEGER,
    terminal_id INTEGER,
    operador_id INTEGER,
    empresa_id INTEGER,
    status TEXT
  )`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT,
    data_venda TEXT NOT NULL,
    total REAL NOT NULL,
    caixa_id INTEGER,
    caixa_sessao_id INTEGER,
    terminal_id INTEGER,
    operador_id INTEGER REFERENCES usuarios(id),
    empresa_id INTEGER,
    origem_operacao TEXT,
    operador_nome_snapshot TEXT,
    terminal_tipo_snapshot TEXT
  )`);
  await run(db, `INSERT INTO empresas (id) VALUES (1), (2)`);
  await run(db, `INSERT INTO usuarios (id, username, nome, role, perfil, ativo)
    VALUES (5, 'caixa', 'Vendedor Autenticado', 'operador', 'USUARIO', 1)`);
  await run(db, `INSERT INTO usuarios (id, username, nome, role, perfil, ativo)
    VALUES (9, 'outro', 'Outro Vendedor', 'operador', 'USUARIO', 1)`);
  await run(db, `INSERT INTO operadores (id, nome) VALUES (2, 'Cadastro que não é usuário')`);
  await run(db, `INSERT INTO usuario_empresas (id, usuario_id, empresa_id, ativo) VALUES (1, 5, 1, 1), (2, 9, 2, 1)`);
  await run(db, `INSERT INTO terminais (id, nome, hostname) VALUES (3, 'PDV', 'pdv-01')`);
  await run(db, `INSERT INTO terminais (id, nome, hostname)
    VALUES (4, 'Mobile', 'cds-mobile-v1:11111111-2222-4333-8444-555555555555')`);
  await run(db, `INSERT INTO caixa (id, data, status) VALUES (15, '2026-11-12', 'aberto')`);
  await run(db, `INSERT INTO caixa (id, data, status) VALUES (16, '2026-11-12', 'aberto')`);
  await run(db, `INSERT INTO caixa_sessoes (
    id, caixa_id, caixa_turno_id, terminal_id, operador_id, empresa_id, status
  ) VALUES (8, 2, 15, 3, 2, 1, 'aberto'), (9, 2, 16, 4, 2, 1, 'aberto')`);
  return db;
}

function contexto(empresaId = 1) {
  return {
    caixaId: 15,
    caixaSessaoId: 8,
    terminalId: 3,
    empresaId,
    usuario: { id: 2, usuario_id: 2, username: 'caixa' }
  };
}

test('o login declara usuario_id e ignora o id solto quando os dois divergem', () => {
  assert.equal(idDeclaradoDoUsuario({ id: 2, usuario_id: 5 }), 5);
  assert.equal(idDeclaradoDoUsuario({ id: 5 }), 5);
  assert.equal(idDeclaradoDoUsuario(null), null);
});

test('o operador autenticado grava usuarios.id 5, não o cadastro 2', async () => {
  const db = await preparar();
  try {
    const operadorId = await resolverOperadorUsuario(db, contexto());
    assert.equal(operadorId, 5);
    assert.notEqual(operadorId, 2);
    const refs = await validarReferenciasPersistenciaVenda(db, contexto());
    await run(db, `INSERT INTO vendas (
      codigo, data_venda, total, caixa_id, caixa_sessao_id, terminal_id, operador_id, empresa_id
    ) VALUES ('OK', '2026-11-12', 10, ?, ?, ?, ?, ?)`, [
      refs.caixaId, refs.caixaSessaoId, refs.terminalId, refs.operadorId, refs.empresaId
    ]);
    const venda = await get(db, 'SELECT operador_id FROM vendas');
    assert.equal(venda.operador_id, 5);
  } finally {
    await fecharDb(db);
  }
});

test('origem, nome e tipo de terminal vêm da sessão validada, não do body', async () => {
  const db = await preparar();
  try {
    const desktop = await validarReferenciasPersistenciaVenda(db, {
      ...contexto(),
      req: {
        canalVendaHttp: 'PDV',
        vendaContext: { origem: 'PDV' },
        body: { origem: 'FATURAMENTO', operador_id: 9, terminal_id: 4 }
      }
    });
    assert.equal(desktop.operadorId, 5);
    assert.equal(desktop.operadorNomeSnapshot, 'Vendedor Autenticado');
    assert.equal(desktop.terminalId, 3);
    assert.equal(desktop.terminalTipoSnapshot, 'DESKTOP');
    assert.equal(desktop.origemOperacao, 'PDV_DESKTOP');
    const faturamento = await validarReferenciasPersistenciaVenda(db, {
      ...contexto(),
      req: { vendaContext: { origem: 'FATURAMENTO' } }
    });
    assert.equal(faturamento.origemOperacao, 'FATURAMENTO');

    const mobile = await validarReferenciasPersistenciaVenda(db, {
      caixaId: 16,
      caixaSessaoId: 9,
      terminalId: 4,
      operadorId: 9,
      usuario: { id: 9, username: 'caixa' },
      empresaId: 1,
      req: {
        canalVendaHttp: 'PDV',
        mobileInstallationId: '11111111-2222-4333-8444-555555555555',
        vendaContext: { origem: 'PDV' },
        body: { origem: 'PDV_DESKTOP', operador_id: 9, terminal_id: 3 }
      }
    });
    assert.equal(mobile.operadorId, 5);
    assert.equal(mobile.operadorNomeSnapshot, 'Vendedor Autenticado');
    assert.equal(mobile.terminalId, 4);
    assert.equal(mobile.terminalTipoSnapshot, 'MOBILE');
    assert.equal(mobile.origemOperacao, 'PDV_MOBILE');
    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, {
        caixaId: 16,
        caixaSessaoId: 9,
        terminalId: 4,
        operadorId: 5,
        usuario: { id: 5, username: 'caixa' },
        empresaId: 1,
        req: { canalVendaHttp: 'PDV', vendaContext: { origem: 'PDV' } }
      }),
      (err) => err.codigo === 'IDENTIDADE_MOBILE_NAO_VALIDADA'
    );

    await run(db, `INSERT INTO vendas (
      codigo, data_venda, total, caixa_id, caixa_sessao_id, terminal_id, operador_id,
      empresa_id, origem_operacao, operador_nome_snapshot, terminal_tipo_snapshot
    ) VALUES ('DESKTOP', '2026-11-12', 10, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      desktop.caixaId, desktop.caixaSessaoId, desktop.terminalId, desktop.operadorId,
      desktop.empresaId, desktop.origemOperacao, desktop.operadorNomeSnapshot,
      desktop.terminalTipoSnapshot
    ]);
    await run(db, `INSERT INTO vendas (
      codigo, data_venda, total, caixa_id, caixa_sessao_id, terminal_id, operador_id,
      empresa_id, origem_operacao, operador_nome_snapshot, terminal_tipo_snapshot
    ) VALUES ('MOBILE', '2026-11-12', 10, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      mobile.caixaId, mobile.caixaSessaoId, mobile.terminalId, mobile.operadorId,
      mobile.empresaId, mobile.origemOperacao, mobile.operadorNomeSnapshot,
      mobile.terminalTipoSnapshot
    ]);
    const gravadas = await get(db, `
      SELECT origem_operacao, operador_id, operador_nome_snapshot, terminal_id, terminal_tipo_snapshot
      FROM vendas ORDER BY id
    `);
    assert.equal(gravadas.origem_operacao, 'PDV_DESKTOP');
    assert.equal(gravadas.operador_id, 5);
    assert.equal(gravadas.operador_nome_snapshot, 'Vendedor Autenticado');
    const todas = await new Promise((resolve, reject) => {
      db.all(`
        SELECT origem_operacao, terminal_id, terminal_tipo_snapshot
        FROM vendas ORDER BY id
      `, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    assert.deepEqual(todas, [
      { origem_operacao: 'PDV_DESKTOP', terminal_id: 3, terminal_tipo_snapshot: 'DESKTOP' },
      { origem_operacao: 'PDV_MOBILE', terminal_id: 4, terminal_tipo_snapshot: 'MOBILE' }
    ]);
  } finally {
    await fecharDb(db);
  }
});

test('id inexistente, id de outro cadastro e sessão sem usuário bloqueiam a venda', async () => {
  const db = await preparar();
  try {
    await assert.rejects(
      () => resolverOperadorUsuario(db, { operadorId: 77 }),
      (err) => err.codigo === 'OPERADOR_INEXISTENTE' && err.referencia.id === 77
    );
    await assert.rejects(
      () => resolverOperadorUsuario(db, { operadorId: 2 }),
      (err) => err.codigo === 'OPERADOR_INEXISTENTE' && err.referencia.id === 2
    );
    await assert.rejects(
      () => resolverOperadorUsuario(db, {}),
      (err) => err.codigo === 'SESSAO_SEM_USUARIO'
    );
    await assert.rejects(
      () => resolverOperadorUsuario(db, { ...contexto(2) }),
      (err) => err.codigo === 'OPERADOR_OUTRA_EMPRESA' && err.referencia.empresa_id === 2
    );
    assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM vendas')).n, 0);
  } finally {
    await fecharDb(db);
  }
});

test('falha de operador desfaz a venda e a repetição grava uma só', async () => {
  const db = await preparar();
  try {
    await run(db, 'BEGIN');
    const refs = await validarReferenciasPersistenciaVenda(db, contexto());
    await run(db, `INSERT INTO vendas (
      codigo, data_venda, total, caixa_id, caixa_sessao_id, terminal_id, operador_id, empresa_id
    ) VALUES ('PARCIAL', '2026-11-12', 10, ?, ?, ?, ?, ?)`, [
      refs.caixaId, refs.caixaSessaoId, refs.terminalId, refs.operadorId, refs.empresaId
    ]);
    await run(db, 'ROLLBACK');
    assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM vendas')).n, 0);

    await assert.rejects(
      () => validarReferenciasPersistenciaVenda(db, { ...contexto(), usuario: { id: 2, username: 'ausente' } }),
      (err) => err.codigo === 'OPERADOR_INEXISTENTE'
    );
    assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM vendas')).n, 0);

    await run(db, 'BEGIN');
    const deNovo = await validarReferenciasPersistenciaVenda(db, contexto());
    assert.equal(deNovo.operadorId, 5);
    await run(db, `INSERT INTO vendas (
      codigo, data_venda, total, caixa_id, caixa_sessao_id, terminal_id, operador_id, empresa_id
    ) VALUES ('OK', '2026-11-12', 10, ?, ?, ?, ?, ?)`, [
      deNovo.caixaId, deNovo.caixaSessaoId, deNovo.terminalId, deNovo.operadorId, deNovo.empresaId
    ]);
    await run(db, 'COMMIT');
    const vendas = await get(db, 'SELECT COUNT(*) AS n, MIN(operador_id) AS operador_id FROM vendas');
    assert.equal(vendas.n, 1);
    assert.equal(vendas.operador_id, 5);
  } finally {
    await fecharDb(db);
  }
});
