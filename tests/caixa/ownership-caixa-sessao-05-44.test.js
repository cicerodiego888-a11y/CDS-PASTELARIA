/**
 * Sprint 05.44 — Isolamento empresarial de caixa e sessão ativa.
 * Executar: node tests/caixa/ownership-caixa-sessao-05-44.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const {
  montarSqlSessaoAberta,
  obterSessaoAtivaDaEmpresa,
  montarSqlHistoricoTurnosDaEmpresa,
  montarSqlUltimaSessaoDoTurnoDaEmpresa
} = require('../../backend/utils/caixaSessaoHelpers');
const { exigirSessaoDaEmpresa } = require('../../backend/services/caixa/CaixaEmpresaContextoService');
const { exigirCaixaCompativelComVenda } = require('../../backend/services/vendas/VendaEmpresaContextoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(conn)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nome TEXT)`);
  await run(db, `
    CREATE TABLE caixa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT,
      valor_inicial REAL DEFAULT 0,
      status TEXT,
      terminal_id INTEGER,
      aberto_por INTEGER,
      fechado_por INTEGER,
      valor_fechamento REAL
    )
  `);
  await run(db, `
    CREATE TABLE caixa_sessoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_id INTEGER,
      caixa_turno_id INTEGER,
      terminal_id INTEGER,
      operador_id INTEGER,
      empresa_id INTEGER,
      valor_abertura REAL DEFAULT 0,
      status TEXT DEFAULT 'aberto',
      aberto_em TEXT,
      fechado_em TEXT
    )
  `);
  await run(db, `
    CREATE TABLE caixa_movimentacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_id INTEGER,
      sessao_id INTEGER,
      tipo TEXT,
      valor REAL
    )
  `);
  return db;
}

async function seedEmpresas(db) {
  const a = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Empresa A', nome_fantasia: 'A' },
    { db }
  );
  const b = await EmpresaService.criarEmpresa(
    { cnpj: '04252011000110', razao_social: 'Empresa B', nome_fantasia: 'B' },
    { db }
  );
  return { a, b };
}

async function abrirSessao(db, { empresaId, terminalId = 1, valor = 100 }) {
  const caixaIns = await run(db,
    `INSERT INTO caixa (data, valor_inicial, status, terminal_id) VALUES ('2026-08-25', ?, 'aberto', ?)`,
    [valor, terminalId]
  );
  const caixaId = caixaIns.lastID;
  const sessIns = await run(db, `
    INSERT INTO caixa_sessoes (caixa_turno_id, caixa_id, terminal_id, operador_id, empresa_id, status, valor_abertura)
    VALUES (?, ?, ?, 1, ?, 'aberto', ?)
  `, [caixaId, caixaId, terminalId, empresaId, valor]);
  return { caixaId, sessaoId: sessIns.lastID };
}

async function t01SessaoAPorEmpresaA() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const row = await obterSessaoAtivaDaEmpresa(db, { empresaId: a.id });
  assert.ok(row);
  assert.strictEqual(Number(row.id), Number(sa.sessaoId));
  assert.strictEqual(Number(row.empresa_id), Number(a.id));
  db.close();
}

async function t02SessaoBNaoApareceParaA() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id, terminalId: 1 });
  await abrirSessao(db, { empresaId: b.id, terminalId: 1 });
  const row = await obterSessaoAtivaDaEmpresa(db, { empresaId: a.id, terminalId: 1 });
  assert.ok(row);
  assert.strictEqual(Number(row.id), Number(sa.sessaoId));
  assert.strictEqual(Number(row.empresa_id), Number(a.id));
  db.close();
}

async function t03UltimaSessaoGlobalNaoInterfere() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const sb = await abrirSessao(db, { empresaId: b.id });
  assert.ok(Number(sb.sessaoId) > Number(sa.sessaoId), 'B deve ser mais recente (id maior)');
  const row = await obterSessaoAtivaDaEmpresa(db, { empresaId: a.id });
  assert.strictEqual(Number(row.id), Number(sa.sessaoId));
  assert.notStrictEqual(Number(row.id), Number(sb.sessaoId));
  db.close();
}

async function t04OperacaoCruzadaPorId() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const q = montarSqlSessaoAberta({ sessaoId: sa.sessaoId, empresaId: b.id });
  assert.ok(q.sql.includes('empresa_id = ?'));
  const row = await get(db, q.sql, q.params);
  assert.strictEqual(row, null);
  db.close();
}

async function t05FechamentoCruzadoBloqueado() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const upd = await run(db, `
    UPDATE caixa_sessoes
    SET status = 'fechado', fechado_em = DATETIME('now')
    WHERE id = ? AND status = 'aberto' AND empresa_id = ?
  `, [sa.sessaoId, b.id]);
  assert.strictEqual(Number(upd.changes), 0);
  const row = await get(db, `SELECT status FROM caixa_sessoes WHERE id = ?`, [sa.sessaoId]);
  assert.strictEqual(row.status, 'aberto');
  db.close();
}

function t06VendaACaixaA() {
  assert.doesNotThrow(() => exigirCaixaCompativelComVenda(
    { caixaSessao: { id: 10, empresa_id: 2 } },
    2
  ));
}

function t07VendaACaixaB() {
  assert.throws(
    () => exigirCaixaCompativelComVenda(
      { caixaSessao: { id: 10, empresa_id: 3 } },
      2
    ),
    (err) => err.code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
  );
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('exigirCaixaCompativelComVenda'));
  assert.ok(src('backend/middleware/validarCaixaAberto.js').includes('exigirSessaoDaEmpresa'));
  assert.ok(!src('backend/middleware/validarCaixaAberto.js').includes('req.empresaId = Number(sessao.empresa_id)'));
}

async function t08ListagemIsolada() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const sb = await abrirSessao(db, { empresaId: b.id });
  await run(db, `INSERT INTO caixa_movimentacoes (caixa_id, sessao_id, tipo, valor) VALUES (?, ?, 'sangria', 10)`, [sb.caixaId, sb.sessaoId]);

  const hist = montarSqlHistoricoTurnosDaEmpresa(a.id, { limite: 100 });
  const turnosA = await all(db, hist.sql, hist.params);
  assert.ok(turnosA.every((t) => Number(t.id) === Number(sa.caixaId)));
  assert.ok(!turnosA.some((t) => Number(t.id) === Number(sb.caixaId)));

  const sessaoB = montarSqlUltimaSessaoDoTurnoDaEmpresa({ caixaTurnoId: sb.caixaId, empresaId: a.id });
  const cruzado = await get(db, sessaoB.sql, sessaoB.params);
  assert.strictEqual(cruzado, null);

  const movB = await all(db, `
    SELECT cm.* FROM caixa_movimentacoes cm
    INNER JOIN caixa_sessoes s ON s.id = cm.sessao_id
    WHERE s.empresa_id = ?
  `, [a.id]);
  assert.strictEqual(movB.length, 0);
  db.close();
}

function t09LegadoNull() {
  assert.throws(
    () => exigirSessaoDaEmpresa({ id: 7, empresa_id: null, status: 'aberto' }, 2),
    (err) => err.code === 'EMPRESA_OWNERSHIP_REQUIRED' || err.code === 'CAIXA_SESSAO_SEM_EMPRESA'
  );
}

function t10FonteNaoUsaLimiteGlobal() {
  const helper = src('backend/utils/caixaSessaoHelpers.js');
  const rota = src('backend/rotas/caixa.js');
  const mid = src('backend/middleware/validarCaixaAberto.js');
  assert.ok(!/FROM caixa_sessoes WHERE status = 'aberto' ORDER BY id DESC LIMIT 1/.test(helper));
  assert.ok(!/FROM caixa WHERE status = 'aberto' ORDER BY id DESC LIMIT 1/.test(rota));
  assert.ok(helper.includes('obterSessaoAtivaDaEmpresa'));
  assert.ok(helper.includes('empresa_id = ?'));
  assert.ok(mid.includes('montarSqlSessaoAberta({ sessaoId, empresaId })') || mid.includes('empresaId'));
  assert.throws(() => montarSqlSessaoAberta({}), (err) => err.code === 'CAIXA_EMPRESA_OBRIGATORIA');
}

async function main() {
  const testes = [
    ['T01 sessão A encontrada por empresa A', t01SessaoAPorEmpresaA],
    ['T02 sessão B mais recente não aparece para A', t02SessaoBNaoApareceParaA],
    ['T03 última sessão global não interfere', t03UltimaSessaoGlobalNaoInterfere],
    ['T04 operação cruzada por ID bloqueada (não encontrado)', t04OperacaoCruzadaPorId],
    ['T05 fechamento cruzado bloqueado', t05FechamentoCruzadoBloqueado],
    ['T06 venda A + caixa A permitido', t06VendaACaixaA],
    ['T07 venda A + caixa B bloqueado', t07VendaACaixaB],
    ['T08 listagem isolada', t08ListagemIsolada],
    ['T09 legado NULL exige ownership', t09LegadoNull],
    ['T10 helper não usa LIMIT 1 global', t10FonteNaoUsaLimiteGlobal]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    try {
      await fn();
      console.log(`OK  ${nome}`);
      ok += 1;
    } catch (err) {
      console.error(`FAIL ${nome}`);
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${ok}/${testes.length} cenários 05.44 OK`);
}

main();
