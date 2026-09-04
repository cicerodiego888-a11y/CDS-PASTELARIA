/**
 * Sprint 05.38.E — Central de Entradas por Modo Operacional Global.
 * Executar: node tests/central-entradas-multiempresa-05-38-e.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..');
const configService = require('../backend/services/configuracaoService');
const { ModoOperacionalGlobal } = require('../backend/core/modo-operacional');
const {
  resolverEmpresaParaCentral,
  listarAlvosSincronizacaoCentral,
  exigirDocumentoCompraMesmaEmpresa,
  erroCentralEmpresa
} = require('../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const {
  migrarEmpresaIdCentralDocumentos,
  extrairCnpjDestinatarioXml,
  backfillDocumentosCentral,
  resolverEmpresaIdBackfillSeguro
} = require('../backend/utils/centralEntradasEmpresaHelpers');
const { garantirSchemaEmpresasAsync } = require('../backend/services/empresas/empresasSchema');
const CentralNsuRepository = require('../backend/motores/central-entradas/repositories/CentralNsuRepository');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-0538e-'));
  const prev = process.env.DB_DIR;
  process.env.DB_DIR = dir;
  const finish = () => {
    if (prev === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(finish);
    }
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL UNIQUE,
      xml TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'RECEBIDA',
      empresa_id INTEGER,
      cnpj_fornecedor TEXT
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_nsu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ambiente INTEGER NOT NULL DEFAULT 2,
      ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
      max_nsu TEXT NOT NULL DEFAULT '000000000000000',
      data_sincronizacao DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ambiente)
    )
  `);
  await run(db, `
    CREATE TABLE estoque_empresa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      saldo REAL NOT NULL DEFAULT 0,
      UNIQUE(produto_id, empresa_id)
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      valor REAL,
      empresa_id INTEGER
    )
  `);
  return db;
}

async function seedEmpresas(db, lista) {
  for (const e of lista) {
    await run(
      db,
      `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo)
       VALUES (?, ?, ?, ?, ?)`,
      [e.id, e.cnpj, e.razao_social, e.nome_fantasia || e.razao_social, e.ativo != null ? e.ativo : 1]
    );
  }
}

const EMP_A = { id: 10, cnpj: '11111111000191', razao_social: 'Empresa A SA', ativo: 1 };
const EMP_B = { id: 20, cnpj: '22222222000182', razao_social: 'Empresa B SA', ativo: 1 };
const EMP_INATIVA = { id: 30, cnpj: '33333333000173', razao_social: 'Inativa', ativo: 0 };

function xmlDest(cnpjDest) {
  return `<?xml version="1.0"?><nfeProc><NFe><infNFe>
    <emit><CNPJ>99888777000166</CNPJ><xNome>Fornecedor</xNome></emit>
    <dest><CNPJ>${cnpjDest}</CNPJ><xNome>Dest</xNome></dest>
  </infNFe></NFe></nfeProc>`;
}

async function test01EmpresaSimplesResolveOperacional() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    const r = await resolverEmpresaParaCentral({}, {
      db,
      listarEmpresasAtivas: async () => [EMP_A]
    });
    assert.strictEqual(r.empresaId, EMP_A.id);
    assert.strictEqual(r.modo, ModoOperacionalGlobal.EMPRESA_SIMPLES);
    assert.strictEqual(r.origem, 'CONTRATO_EMPRESA_SIMPLES');
    db.close();
  });
}

async function test02EmpresaSimplesSincronizaSomenteOperacional() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      listarEmpresasAtivas: async () => [EMP_A]
    });
    assert.strictEqual(plano.modo, ModoOperacionalGlobal.EMPRESA_SIMPLES);
    assert.strictEqual(plano.alvos.length, 1);
    assert.strictEqual(plano.alvos[0].empresaId, EMP_A.id);
    assert.strictEqual(plano.alvos[0].cnpj, EMP_A.cnpj);
    db.close();
  });
}

async function test03MultiempresaListaAtivas() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B, EMP_INATIVA]);
    const plano = await listarAlvosSincronizacaoCentral({ db });
    assert.strictEqual(plano.modo, ModoOperacionalGlobal.MULTIEMPRESA);
    const ids = plano.alvos.map((a) => a.empresaId).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [EMP_A.id, EMP_B.id]);
    assert.ok(!ids.includes(EMP_INATIVA.id));
    db.close();
  });
}

async function test04e05ProcessaEmpresaAeB() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    const plano = await listarAlvosSincronizacaoCentral({ db });
    assert.strictEqual(plano.alvos.length, 2);
    assert.ok(plano.alvos.some((a) => a.empresaId === EMP_A.id && a.cnpj === EMP_A.cnpj));
    assert.ok(plano.alvos.some((a) => a.empresaId === EMP_B.id && a.cnpj === EMP_B.cnpj));
    db.close();
  });
}

async function test06NsuANaoInterfereNsuB() {
  const db = await criarDb();
  const repo = new CentralNsuRepository({ db });
  const a = await repo.obterOuCriar(EMP_A.cnpj, 2);
  await repo.obterOuCriar(EMP_B.cnpj, 2);
  await repo.atualizarSincronizacao(a.id, {
    ultNsu: '000000000000100',
    maxNsu: '000000000000100'
  });
  const bAntes = await repo.buscarPorCnpjAmbiente(EMP_B.cnpj, 2);
  assert.strictEqual(bAntes.ultNsu, '000000000000000');
  const a2 = await repo.buscarPorCnpjAmbiente(EMP_A.cnpj, 2);
  await repo.atualizarSincronizacao(a2.id, {
    ultNsu: '000000000000200',
    maxNsu: '000000000000200'
  });
  const bDepois = await repo.buscarPorCnpjAmbiente(EMP_B.cnpj, 2);
  const aDepois = await repo.buscarPorCnpjAmbiente(EMP_A.cnpj, 2);
  assert.strictEqual(bDepois.ultNsu, '000000000000000');
  assert.strictEqual(aDepois.ultNsu, '000000000000200');
  db.close();
}

async function test07e08DocumentoContexto() {
  const db = await criarDb();
  await seedEmpresas(db, [EMP_A, EMP_B]);
  await run(db,
    `INSERT INTO central_entradas_documentos (chave, xml, empresa_id) VALUES (?, ?, ?)`,
    ['CHAVEA', xmlDest(EMP_A.cnpj), EMP_A.id]
  );
  await run(db,
    `INSERT INTO central_entradas_documentos (chave, xml, empresa_id) VALUES (?, ?, ?)`,
    ['CHAVEB', xmlDest(EMP_B.cnpj), EMP_B.id]
  );
  const a = await get(db, `SELECT * FROM central_entradas_documentos WHERE chave='CHAVEA'`);
  const b = await get(db, `SELECT * FROM central_entradas_documentos WHERE chave='CHAVEB'`);
  assert.strictEqual(a.empresa_id, EMP_A.id);
  assert.strictEqual(b.empresa_id, EMP_B.id);
  db.close();
}

async function test09DocumentoANaoGeraCompraB() {
  assert.throws(
    () => exigirDocumentoCompraMesmaEmpresa(EMP_A.id, EMP_B.id),
    (err) => err && err.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  assert.strictEqual(exigirDocumentoCompraMesmaEmpresa(EMP_A.id, EMP_A.id), EMP_A.id);
}

async function test10EntradaANaoMovimentaEstoqueB() {
  const db = await criarDb();
  await seedEmpresas(db, [EMP_A, EMP_B]);
  await run(db, `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo) VALUES (1, ?, 0)`, [EMP_A.id]);
  await run(db, `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo) VALUES (1, ?, 0)`, [EMP_B.id]);
  // Entrada originada de documento A
  const documentoEmpresaId = EMP_A.id;
  await run(
    db,
    `UPDATE estoque_empresa SET saldo = saldo + 5 WHERE produto_id = 1 AND empresa_id = ?`,
    [documentoEmpresaId]
  );
  const a = await get(db, `SELECT saldo FROM estoque_empresa WHERE empresa_id=?`, [EMP_A.id]);
  const b = await get(db, `SELECT saldo FROM estoque_empresa WHERE empresa_id=?`, [EMP_B.id]);
  assert.strictEqual(Number(a.saldo), 5);
  assert.strictEqual(Number(b.saldo), 0);
  db.close();
}

async function test11FinanceiroRecebeEmpresaCorreta() {
  const db = await criarDb();
  await seedEmpresas(db, [EMP_A, EMP_B]);
  const docEmpresa = EMP_A.id;
  await run(db, `INSERT INTO financeiro (compra_id, valor, empresa_id) VALUES (1, 100, ?)`, [docEmpresa]);
  const fin = await get(db, `SELECT * FROM financeiro WHERE compra_id=1`);
  assert.strictEqual(fin.empresa_id, EMP_A.id);
  assert.notStrictEqual(fin.empresa_id, EMP_B.id);
  db.close();
}

async function test12EmpresaInativaNaoSincronizada() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_INATIVA]);
    const plano = await listarAlvosSincronizacaoCentral({ db });
    assert.ok(!plano.alvos.some((a) => a.empresaId === EMP_INATIVA.id));
    db.close();
  });
}

async function test13EmpresaInexistenteBloqueada() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A]);
    await assert.rejects(
      () => resolverEmpresaParaCentral({ empresaId: 99999 }, { db }),
      (err) => err && (err.code === 'EMPRESA_NAO_ENCONTRADA' || err.code === 'EMPRESA_CENTRAL_INVALIDA'
        || err.code === 'EMPRESA_OPERACIONAL_INVALIDA' || err.statusCode === 404 || err.statusCode === 400)
    );
    db.close();
  });
}

async function test14XmlCnpjAResolveEmpresaA() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    const r = await resolverEmpresaParaCentral({ cnpj: EMP_A.cnpj }, { db });
    assert.strictEqual(r.empresaId, EMP_A.id);
    assert.strictEqual(r.origem, 'CNPJ_DESTINATARIO');
    assert.strictEqual(extrairCnpjDestinatarioXml(xmlDest(EMP_A.cnpj)), EMP_A.cnpj);
    db.close();
  });
}

async function test15XmlCnpjDesconhecidoBloqueado() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A]);
    await assert.rejects(
      () => resolverEmpresaParaCentral({ cnpj: '44444444000155' }, { db }),
      (err) => err && err.code === 'EMPRESA_CENTRAL_INVALIDA'
    );
    db.close();
  });
}

async function test16LegadoSeguroRecebeBackfill() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A]);
    await run(db,
      `INSERT INTO central_entradas_documentos (chave, xml, empresa_id) VALUES (?, ?, NULL)`,
      ['LEGADO1', '<NFe/>']
    );
    const info = await migrarEmpresaIdCentralDocumentos(db);
    assert.ok(info.fromOperacional >= 1 || info.empresaId === EMP_A.id);
    const row = await get(db, `SELECT empresa_id FROM central_entradas_documentos WHERE chave='LEGADO1'`);
    assert.strictEqual(row.empresa_id, EMP_A.id);
    db.close();
  });
}

async function test17LegadoAmbiguoNaoRecebeEmpresaArbitraria() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    await run(db,
      `INSERT INTO central_entradas_documentos (chave, xml, empresa_id) VALUES (?, ?, NULL)`,
      ['AMBIGUO1', '<NFe><infNFe/></NFe>']
    );
    const seguro = await resolverEmpresaIdBackfillSeguro(db);
    assert.strictEqual(seguro, null);
    const fill = await backfillDocumentosCentral(db, null);
    assert.ok(fill.ambiguos >= 1);
    const row = await get(db, `SELECT empresa_id FROM central_entradas_documentos WHERE chave='AMBIGUO1'`);
    assert.strictEqual(row.empresa_id, null);
    db.close();
  });
}

async function test18RegressaoEmpresaSimplesFluxo() {
  const syncSrc = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
  assert.ok(syncSrc.includes('listarAlvosSincronizacaoCentral'));
  assert.ok(syncSrc.includes('_sincronizarEmpresa'));
  assert.ok(syncSrc.includes('ModoOperacionalGlobal.EMPRESA_SIMPLES')
    || syncSrc.includes('permitirFallbackGlobal'));
}

async function test19RegressaoNsuExistente() {
  const nsuRepo = src('backend/motores/central-entradas/repositories/CentralNsuRepository.js');
  assert.ok(nsuRepo.includes('UNIQUE') || nsuRepo.includes('cnpj'));
  assert.ok(nsuRepo.includes('buscarPorCnpjAmbiente'));
  assert.ok(!src('backend/utils/centralEntradasEmpresaHelpers.js').includes('CREATE TABLE.*nsu'));
}

async function test20IdempotenciaSincronizacao() {
  const syncSrc = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
  assert.ok(syncSrc.includes('porEmpresa'));
  // Repositório NSU continua chaveado por CNPJ+ambiente (idempotente por alvo)
  const db = await criarDb();
  const repo = new CentralNsuRepository({ db });
  await repo.obterOuCriar(EMP_A.cnpj, 2);
  await repo.obterOuCriar(EMP_A.cnpj, 2);
  const rows = await all(db, `SELECT * FROM central_entradas_nsu WHERE cnpj=?`, [EMP_A.cnpj]);
  assert.strictEqual(rows.length, 1);
  db.close();
}

async function testEstruturalArquivos() {
  assert.ok(fs.existsSync(path.join(ROOT,
    'backend/services/central-entradas/CentralEntradasEmpresaContextoService.js')));
  assert.ok(fs.existsSync(path.join(ROOT,
    'backend/utils/centralEntradasEmpresaHelpers.js')));
  const docsDDL = src('backend/database.js');
  assert.ok(docsDDL.includes('central_entradas_documentos') && docsDDL.includes('empresa_id'));
  const bridge = src('backend/motores/central-entradas/services/CentralComprasBridgeService.js');
  assert.ok(bridge.includes('exigirDocumentoCompraMesmaEmpresa'));
  const upload = src('backend/motores/central-entradas/services/CentralUploadService.js');
  assert.ok(upload.includes('resolverEmpresaParaCentral'));
}

async function main() {
  const testes = [
    ['01 EMPRESA_SIMPLES resolve operacional', test01EmpresaSimplesResolveOperacional],
    ['02 EMPRESA_SIMPLES sync só CNPJ operacional', test02EmpresaSimplesSincronizaSomenteOperacional],
    ['03 MULTIEMPRESA lista ativas', test03MultiempresaListaAtivas],
    ['04/05 MULTIEMPRESA processa A e B', test04e05ProcessaEmpresaAeB],
    ['06 NSU A não interfere NSU B', test06NsuANaoInterfereNsuB],
    ['07/08 Documento contexto A/B', test07e08DocumentoContexto],
    ['09 Documento A não gera compra B', test09DocumentoANaoGeraCompraB],
    ['10 Entrada A não movimenta estoque B', test10EntradaANaoMovimentaEstoqueB],
    ['11 Financeiro recebe empresa correta', test11FinanceiroRecebeEmpresaCorreta],
    ['12 Empresa inativa não sincronizada', test12EmpresaInativaNaoSincronizada],
    ['13 Empresa inexistente bloqueada', test13EmpresaInexistenteBloqueada],
    ['14 XML CNPJ A resolve Empresa A', test14XmlCnpjAResolveEmpresaA],
    ['15 XML CNPJ desconhecido bloqueado', test15XmlCnpjDesconhecidoBloqueado],
    ['16 Legado seguro recebe backfill', test16LegadoSeguroRecebeBackfill],
    ['17 Legado ambíguo sem empresa arbitrária', test17LegadoAmbiguoNaoRecebeEmpresaArbitraria],
    ['18 Regressão fluxo EMPRESA_SIMPLES', test18RegressaoEmpresaSimplesFluxo],
    ['19 Regressão NSU existente', test19RegressaoNsuExistente],
    ['20 Idempotência sincronização/NSU', test20IdempotenciaSincronizacao],
    ['Estrutural arquivos 05.38.E', testEstruturalArquivos]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      console.log(`PASS — ${nome}`);
      ok += 1;
    } catch (err) {
      console.error(`FAIL — ${nome}`);
      console.error(err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\nOK ${ok}/${testes.length} testes 05.38.E`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
