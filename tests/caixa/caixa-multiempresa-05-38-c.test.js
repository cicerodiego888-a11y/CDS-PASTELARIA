/**
 * Sprint 05.38.C — Caixa por empresa (isolamento + EMPRESA_SIMPLES transparente).
 * Executar: node tests/caixa/caixa-multiempresa-05-38-c.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const configService = require('../../backend/services/configuracaoService');
const {
  ModoOperacionalGlobal,
  ContratoOperacionalService
} = require('../../backend/core/modo-operacional');
const {
  resolverEmpresaIdParaCaixa,
  exigirSessaoDaEmpresa,
  obterMetaEmpresaPorId
} = require('../../backend/services/caixa/CaixaEmpresaContextoService');
const {
  montarSqlSessaoAberta,
  migrarEmpresaIdCaixaSessoes
} = require('../../backend/utils/caixaSessaoHelpers');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caixa-0538c-'));
  const prev = process.env.DB_DIR;
  process.env.DB_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dbDir, obj) {
  const p = path.join(dbDir, 'config', 'configuracoes.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
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

async function criarDbCaixa() {
  const db = await new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(conn)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE caixa_sessoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_id INTEGER,
      caixa_turno_id INTEGER,
      terminal_id INTEGER,
      operador_id INTEGER,
      empresa_id INTEGER,
      valor_abertura REAL DEFAULT 0,
      valor_fechamento REAL DEFAULT 0,
      status TEXT DEFAULT 'aberto',
      aberto_em TEXT,
      fechado_em TEXT
    )
  `);
  await run(db, `
    CREATE TABLE caixa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT,
      valor_inicial REAL DEFAULT 0,
      status TEXT,
      terminal_id INTEGER,
      valor_fechamento REAL
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

async function abrirSessao(db, { empresaId, terminalId = null, valor = 100 }) {
  const caixaIns = await run(db,
    `INSERT INTO caixa (data, valor_inicial, status, terminal_id) VALUES ('2026-08-24', ?, 'aberto', ?)`,
    [valor, terminalId]
  );
  const caixaId = caixaIns.lastID;
  const sessIns = await run(db, `
    INSERT INTO caixa_sessoes (caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura)
    VALUES (?, ?, 1, ?, 'aberto', ?)
  `, [caixaId, terminalId, empresaId, valor]);
  return { caixaId, sessaoId: sessIns.lastID };
}

// ─── Cenários ───────────────────────────────────────────────────────────────

async function cenario01EmpresaSimplesResolveAutomaticamente() {
  await withTempDbDir(async (dir) => {
    configService.ensureConfigFile();
    writeConfig(dir, {
      ...configService.readConfig(),
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: 7
    });
    const resolved = await resolverEmpresaIdParaCaixa({}, {
      obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
      empresa_operacional_id: 7,
      buscarEmpresaAtivaPorId: async (id) => ({
        id, cnpj: '11222333000181', razao_social: 'Op', ativo: 1
      })
    });
    assert.strictEqual(resolved.empresaId, 7);
    assert.strictEqual(resolved.modo, ModoOperacionalGlobal.EMPRESA_SIMPLES);
    assert.strictEqual(resolved.origem, 'CONTRATO_EMPRESA_SIMPLES');
  });
}

async function cenario02AberturaComEmpresaIdInterno() {
  const db = await criarDbCaixa();
  const { a } = await seedEmpresas(db);
  const { sessaoId } = await abrirSessao(db, { empresaId: a.id, valor: 50 });
  const sessao = await get(db, `SELECT * FROM caixa_sessoes WHERE id = ?`, [sessaoId]);
  assert.strictEqual(Number(sessao.empresa_id), Number(a.id));
  assert.ok(src('backend/rotas/caixa.js').includes('empresa_id'));
  assert.ok(src('backend/rotas/caixa.js').includes('INSERT INTO caixa_sessoes'));
  assert.ok(src('backend/rotas/caixa.js').includes('empresa_id, valor_abertura'));
  db.close();
}

async function cenario03ConsultaCaixaAbertoPorEmpresa() {
  const q = montarSqlSessaoAberta({ empresaId: 2 });
  assert.ok(q.sql.includes('empresa_id = ?'));
  assert.deepStrictEqual(q.params, [2]);
  const qTerm = montarSqlSessaoAberta({ terminalId: 9, empresaId: 2 });
  assert.ok(qTerm.sql.includes('terminal_id = ?'));
  assert.ok(qTerm.sql.includes('empresa_id = ?'));
  assert.deepStrictEqual(qTerm.params, [9, 2]);
}

async function cenario04MultiempresaAbreEmpresaA() {
  await withTempDbDir(async () => {
    const resolved = await resolverEmpresaIdParaCaixa(
      { headers: { 'x-empresa-id': '2' }, user: { id: 1 } },
      {
        obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
        validarEmpresa: async () => true,
        exigirAutorizacaoUsuario: false
      }
    );
    assert.strictEqual(resolved.empresaId, 2);
    assert.strictEqual(resolved.modo, ModoOperacionalGlobal.MULTIEMPRESA);
  });
}

async function cenario05EstadosIndependentes() {
  const db = await criarDbCaixa();
  const { a, b } = await seedEmpresas(db);
  await abrirSessao(db, { empresaId: a.id });
  // B permanece sem sessão aberta
  const abertaA = await get(db,
    `SELECT * FROM caixa_sessoes WHERE status = 'aberto' AND empresa_id = ?`, [a.id]);
  const abertaB = await get(db,
    `SELECT * FROM caixa_sessoes WHERE status = 'aberto' AND empresa_id = ?`, [b.id]);
  assert.ok(abertaA);
  assert.strictEqual(abertaB, null);
  db.close();
}

async function cenario06CaixaANaoApareceParaB() {
  const db = await criarDbCaixa();
  const { a, b } = await seedEmpresas(db);
  await abrirSessao(db, { empresaId: a.id, terminalId: 1 });
  const { sql, params } = montarSqlSessaoAberta({ terminalId: 1, empresaId: b.id });
  const row = await get(db, sql, params);
  assert.strictEqual(row, null);
  const { sql: sqlA, params: paramsA } = montarSqlSessaoAberta({ terminalId: 1, empresaId: a.id });
  const foundA = await get(db, sqlA, paramsA);
  assert.ok(foundA);
  assert.strictEqual(Number(foundA.empresa_id), Number(a.id));
  db.close();
}

async function cenario07SangriaNaoCruzaEmpresas() {
  const sessaoB = { id: 10, empresa_id: 3, status: 'aberto' };
  assert.throws(
    () => exigirSessaoDaEmpresa(sessaoB, 2),
    (err) => err.code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
  );
  assert.doesNotThrow(() => exigirSessaoDaEmpresa(sessaoB, 3));
}

async function cenario08SuprimentoNaoCruzaEmpresas() {
  // mesma regra estrutural de isolamento (sessão + empresa)
  const sessaoA = { id: 1, empresa_id: 2 };
  assert.throws(() => exigirSessaoDaEmpresa(sessaoA, 99), { code: 'CAIXA_SESSAO_EMPRESA_DIVERGENTE' });
  const rota = src('backend/rotas/caixa.js');
  assert.ok(rota.includes("router.post('/suprimento'"));
  assert.ok(rota.includes('exigirSessaoDaEmpresa'));
  assert.ok(rota.includes('anexarEmpresaCaixa'));
}

async function cenario09FechamentoNaoFechaOutraEmpresa() {
  const db = await criarDbCaixa();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const sb = await abrirSessao(db, { empresaId: b.id });

  await run(db, `
    UPDATE caixa_sessoes
    SET status = 'fechado', fechado_em = DATETIME('now')
    WHERE status = 'aberto' AND empresa_id = ? AND id = ?
  `, [a.id, sa.sessaoId]);

  const aRow = await get(db, `SELECT status FROM caixa_sessoes WHERE id = ?`, [sa.sessaoId]);
  const bRow = await get(db, `SELECT status FROM caixa_sessoes WHERE id = ?`, [sb.sessaoId]);
  assert.strictEqual(aRow.status, 'fechado');
  assert.strictEqual(bRow.status, 'aberto');
  db.close();
}

async function cenario10EmpresaIdInvalidoBloqueado() {
  await assert.rejects(
    () => resolverEmpresaIdParaCaixa(
      { headers: { 'x-empresa-id': '99999' }, user: { id: 1 } },
      {
        obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
        validarEmpresa: async () => false,
        exigirAutorizacaoUsuario: false
      }
    ),
    (err) => err.code === 'EMPRESA_NAO_ENCONTRADA'
  );
}

async function cenario11EmpresaInativaBloqueada() {
  const db = await criarDbCaixa();
  const emp = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Inativa X' },
    { db }
  );
  await EmpresaService.inativarEmpresa(emp.id, { db });

  await assert.rejects(
    () => resolverEmpresaIdParaCaixa(
      { headers: { 'x-empresa-id': String(emp.id) }, user: { id: 1 } },
      {
        obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
        db,
        exigirAutorizacaoUsuario: false
      }
    ),
    (err) => err.code === 'EMPRESA_INATIVA'
  );
  db.close();
}

async function cenario12MigrationBackfillPreservaSessoes() {
  const db = await new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(conn)));
  });
  await garantirSchemaEmpresasAsync(db);
  const emp = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Unica' },
    { db }
  );
  // schema legado SEM empresa_id
  await run(db, `
    CREATE TABLE caixa_sessoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_turno_id INTEGER,
      status TEXT,
      valor_abertura REAL
    )
  `);
  await run(db, `INSERT INTO caixa_sessoes (caixa_turno_id, status, valor_abertura) VALUES (1, 'aberto', 10)`);
  await run(db, `INSERT INTO caixa_sessoes (caixa_turno_id, status, valor_abertura) VALUES (2, 'fechado', 20)`);

  const info = await migrarEmpresaIdCaixaSessoes(db, {
    resolverEmpresaIdBackfill: async () => emp.id
  });
  assert.strictEqual(info.added, true);
  assert.strictEqual(info.backfilled, 2);

  const rows = await new Promise((resolve, reject) => {
    db.all(`SELECT id, empresa_id, status FROM caixa_sessoes ORDER BY id`, [], (err, r) => {
      if (err) reject(err);
      else resolve(r);
    });
  });
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((r) => Number(r.empresa_id) === Number(emp.id)));
  assert.strictEqual(rows[0].status, 'aberto');
  assert.strictEqual(rows[1].status, 'fechado');

  // idempotente
  const info2 = await migrarEmpresaIdCaixaSessoes(db, {
    resolverEmpresaIdBackfill: async () => emp.id
  });
  assert.strictEqual(info2.added, false);
  assert.strictEqual(info2.backfilled, 0);
  db.close();
}

async function cenario13MultiempresaSemContextoBloqueado() {
  await assert.rejects(
    () => resolverEmpresaIdParaCaixa(
      { headers: {}, user: { id: 1 } },
      {
        obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
        exigirAutorizacaoUsuario: false
      }
    ),
    (err) => err.code === 'CAIXA_EMPRESA_OBRIGATORIA'
  );
}

function cenario14ContratosHttpPreservados() {
  const rota = src('backend/rotas/caixa.js');
  assert.ok(rota.includes("router.get('/aberto'"));
  assert.ok(rota.includes("router.post('/abrir'"));
  assert.ok(rota.includes("router.post('/sangria'"));
  assert.ok(rota.includes("router.post('/suprimento'"));
  assert.ok(rota.includes("router.post('/fechar'"));
  assert.ok(!rota.includes('/api/caixa/empresa/'));
  assert.ok(!rota.includes("router.post('/empresa/"));
}

function cenario15RegressaoFluxoAntigo() {
  const rota = src('backend/rotas/caixa.js');
  // motor de caixa não duplicado
  assert.ok(rota.includes('FechamentoCaixaResumoService'));
  assert.ok(rota.includes('exigirPermissaoOuSenhaAdmin'));
  // sem dependência de configuracoes.cnpj no Caixa
  assert.ok(!rota.includes("chave IN ('nome_empresa'"));
  assert.ok(!rota.includes("FROM configuracoes WHERE chave"));
  assert.ok(rota.includes('obterMetaEmpresaPorId'));
  // frontend reutiliza APIs existentes
  const front = src('frontend/pdv-universal/pdv-universal-caixa.js');
  assert.ok(front.includes('/caixa/aberto'));
  assert.ok(front.includes('/caixa/abrir'));
  assert.ok(front.includes('X-Empresa-Id'));
  // schema
  const dbSrc = src('backend/database.js');
  assert.ok(dbSrc.includes('empresa_id INTEGER'));
  assert.ok(dbSrc.includes("ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)"));
}

async function cenarioMetaEmpresaSemConfigGlobal() {
  const meta = await obterMetaEmpresaPorId(5, {
    buscarEmpresaPorId: async (id) => ({
      id,
      cnpj: '11222333000181',
      razao_social: 'Razao Teste',
      nome_fantasia: 'Fantasia'
    })
  });
  assert.strictEqual(meta.empresa_id, 5);
  assert.strictEqual(meta.empresa_nome, 'Fantasia');
  assert.strictEqual(meta.empresa_cnpj, '11222333000181');
}

async function cenarioContratoSimplesNoServico() {
  const contrato = await ContratoOperacionalService.montarContratoOperacional({
    obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
    empresa_operacional_id: 4,
    buscarEmpresaAtivaPorId: async (id) => ({
      id, cnpj: 'x', razao_social: 'Y', ativo: 1
    })
  });
  assert.strictEqual(contrato.empresa_operacional.empresa_id, 4);
}

async function main() {
  const testes = [
    ['C1 EMPRESA_SIMPLES resolve automaticamente', cenario01EmpresaSimplesResolveAutomaticamente],
    ['C2 abertura com empresa_id interno', cenario02AberturaComEmpresaIdInterno],
    ['C3 consulta caixa aberto por empresa', cenario03ConsultaCaixaAbertoPorEmpresa],
    ['C4 MULTIEMPRESA abre Empresa A', cenario04MultiempresaAbreEmpresaA],
    ['C5 estados independentes A/B', cenario05EstadosIndependentes],
    ['C6 caixa A não aparece para B', cenario06CaixaANaoApareceParaB],
    ['C7 sangria não cruza empresas', cenario07SangriaNaoCruzaEmpresas],
    ['C8 suprimento não cruza empresas', cenario08SuprimentoNaoCruzaEmpresas],
    ['C9 fechamento A não fecha B', cenario09FechamentoNaoFechaOutraEmpresa],
    ['C10 empresa_id inválido bloqueado', cenario10EmpresaIdInvalidoBloqueado],
    ['C11 empresa inativa bloqueada', cenario11EmpresaInativaBloqueada],
    ['C12 migration/backfill preserva sessões', cenario12MigrationBackfillPreservaSessoes],
    ['C13 MULTIEMPRESA sem contexto bloqueado', cenario13MultiempresaSemContextoBloqueado],
    ['C14 contratos HTTP preservados', cenario14ContratosHttpPreservados],
    ['C15 regressão fluxo antigo', cenario15RegressaoFluxoAntigo],
    ['extra meta empresa sem configuracoes.cnpj', cenarioMetaEmpresaSemConfigGlobal],
    ['extra contrato simples', cenarioContratoSimplesNoServico]
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
  console.log(`\n${ok}/${testes.length} cenários 05.38.C OK`);
}

main();
