/**
 * CENTRAL-ENTRADAS-03 — Período padrão da Central por empresa (MES_VIGENTE | TODO_PERIODO).
 *
 * SQLite em memória com as tabelas reais da Central; nunca abre o banco oficial.
 */

'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-central-entradas-03-periodo-');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DB_DIR) {
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ce03-periodo-'));
}
const sqlite3 = require('sqlite3');
require.cache[require.resolve('../../backend/database')] = {
  exports: new sqlite3.Database(':memory:')
};

const CentralPeriodoPadraoService = require('../../backend/motores/central-entradas/services/CentralPeriodoPadraoService');
const CentralConfiguracaoRepository = require('../../backend/motores/central-entradas/repositories/CentralConfiguracaoRepository');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const { listarPresets, obterPreset } = require('../../backend/motores/central-entradas/utils/filtrosRapidosCentral');

const {
  PERIODOS_PADRAO,
  PERIODO_PADRAO_DEFAULT,
  OPCOES_PERIODO_PADRAO,
  chavePeriodoPadrao,
  calcularIntervaloPeriodoPadrao
} = CentralPeriodoPadraoService;

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function criarBanco() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE central_entradas_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chave TEXT NOT NULL UNIQUE,
    valor TEXT,
    tipo TEXT DEFAULT 'string',
    descricao TEXT,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  )`);
  await run(db, `CREATE TABLE central_entradas_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chave TEXT, numero TEXT, serie TEXT, modelo TEXT, fornecedor TEXT, cnpj_fornecedor TEXT,
    data_emissao TEXT, data_entrada TEXT, valor_total REAL, nsu TEXT, origem TEXT, status TEXT,
    status_detalhe TEXT, tipo_documento TEXT, miip_sessao_id TEXT, miip_resumo_json TEXT,
    compra_id INTEGER, usuario_id INTEGER, processado_em TEXT, empresa_id INTEGER,
    xml TEXT, parse_json TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  )`);
  await run(db, `CREATE TABLE central_entradas_nsu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER, ultimo_nsu TEXT, max_nsu TEXT
  )`);
  return db;
}

async function inserirDoc(db, { empresaId, dataEmissao, chave }) {
  await run(
    db,
    `INSERT INTO central_entradas_documentos (chave, numero, data_emissao, status, tipo_documento, empresa_id, origem)
     VALUES (?, ?, ?, 'RESUMO_RECEBIDO', 'RES_NFE', ?, 'SEFAZ')`,
    [chave, chave.slice(-6), dataEmissao, empresaId]
  );
}

const AGORA = new Date(2026, 8, 27, 15, 30, 0);

let ok = 0;
let falhas = 0;

async function test(nome, fn) {
  try {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  } catch (error) {
    falhas += 1;
    console.error(`  FALHOU  ${nome}`);
    console.error(error);
  }
}

async function main() {
  console.log('\nCENTRAL-ENTRADAS-03 — Período padrão por empresa\n');

  await test('somente duas opções existem: MES_VIGENTE e TODO_PERIODO', async () => {
    assert.deepStrictEqual(Object.values(PERIODOS_PADRAO).sort(), ['MES_VIGENTE', 'TODO_PERIODO']);
    assert.deepStrictEqual(OPCOES_PERIODO_PADRAO.map((o) => o.codigo), ['MES_VIGENTE', 'TODO_PERIODO']);
  });

  await test('novo cliente: sem registro persistido usa MES_VIGENTE e não grava no GET', async () => {
    const db = await criarBanco();
    const service = new CentralPeriodoPadraoService({ db, agora: () => AGORA });
    const r = await service.obter(1);
    assert.strictEqual(PERIODO_PADRAO_DEFAULT, 'MES_VIGENTE');
    assert.strictEqual(r.periodoPadrao, 'MES_VIGENTE');
    assert.strictEqual(r.origem, 'PADRAO_NOVO_CLIENTE');
    const cnt = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_config');
    assert.strictEqual(cnt.n, 0);
  });

  await test('MES_VIGENTE: data inicial é o dia 01 do mês vigente', async () => {
    assert.strictEqual(calcularIntervaloPeriodoPadrao('MES_VIGENTE', AGORA).dataEmissaoInicio, '2026-09-01');
    assert.strictEqual(
      calcularIntervaloPeriodoPadrao('MES_VIGENTE', new Date(2026, 11, 31, 23, 59)).dataEmissaoInicio,
      '2026-12-01'
    );
    const dia01 = calcularIntervaloPeriodoPadrao('MES_VIGENTE', new Date(2026, 9, 1, 0, 5));
    assert.deepStrictEqual(dia01, { dataEmissaoInicio: '2026-10-01', dataEmissaoFim: '2026-10-01' });
  });

  await test('MES_VIGENTE: data final é hoje (data local)', async () => {
    assert.strictEqual(calcularIntervaloPeriodoPadrao('MES_VIGENTE', AGORA).dataEmissaoFim, '2026-09-27');
    const service = new CentralPeriodoPadraoService({
      configuracaoRepository: { buscarPorChave: async () => null, parseValor: () => null }
    });
    const hoje = new Date();
    const esperado = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    assert.strictEqual((await service.obter(1)).intervalo.dataEmissaoFim, esperado);
  });

  await test('TODO_PERIODO: sem limite inicial nem final', async () => {
    assert.deepStrictEqual(
      calcularIntervaloPeriodoPadrao('TODO_PERIODO', AGORA),
      { dataEmissaoInicio: null, dataEmissaoFim: null }
    );
  });

  await test('persistência: salvar grava em central_entradas_config com chave por empresa', async () => {
    const db = await criarBanco();
    const service = new CentralPeriodoPadraoService({ db, agora: () => AGORA });
    const salvo = await service.salvar(2, 'todo_periodo');
    assert.strictEqual(salvo.periodoPadrao, 'TODO_PERIODO');
    const row = await get(db, 'SELECT chave, valor FROM central_entradas_config');
    assert.deepStrictEqual({ ...row }, { chave: 'periodo_padrao_empresa_2', valor: 'TODO_PERIODO' });
    const nova = new CentralPeriodoPadraoService({
      configuracaoRepository: new CentralConfiguracaoRepository({ db }),
      agora: () => AGORA
    });
    const lido = await nova.obter(2);
    assert.strictEqual(lido.periodoPadrao, 'TODO_PERIODO');
    assert.strictEqual(lido.origem, 'PERSISTIDO');
    assert.deepStrictEqual(lido.intervalo, { dataEmissaoInicio: null, dataEmissaoFim: null });
  });

  await test('empresa A não herda configuração da empresa B (nem da Matriz)', async () => {
    const db = await criarBanco();
    const service = new CentralPeriodoPadraoService({ db, agora: () => AGORA });
    await service.salvar(1, 'TODO_PERIODO');
    const f2 = await service.obter(2);
    const f3 = await service.obter(3);
    assert.strictEqual(f2.periodoPadrao, 'MES_VIGENTE');
    assert.strictEqual(f2.origem, 'PADRAO_NOVO_CLIENTE');
    assert.strictEqual(f3.periodoPadrao, 'MES_VIGENTE');
    await service.salvar(3, 'TODO_PERIODO');
    await service.salvar(1, 'MES_VIGENTE');
    assert.strictEqual((await service.obter(3)).periodoPadrao, 'TODO_PERIODO');
    assert.strictEqual((await service.obter(1)).periodoPadrao, 'MES_VIGENTE');
    assert.strictEqual(chavePeriodoPadrao(1) === chavePeriodoPadrao(2), false);
  });

  await test('alteração funciona e valor inválido/empresa inválida são rejeitados', async () => {
    const db = await criarBanco();
    const service = new CentralPeriodoPadraoService({ db, agora: () => AGORA });
    await service.salvar(1, 'TODO_PERIODO');
    await service.salvar(1, 'MES_VIGENTE');
    const r = await service.obter(1);
    assert.strictEqual(r.periodoPadrao, 'MES_VIGENTE');
    assert.deepStrictEqual(r.intervalo, { dataEmissaoInicio: '2026-09-01', dataEmissaoFim: '2026-09-27' });
    const cnt = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_config');
    assert.strictEqual(cnt.n, 1);
    for (const invalido of ['ULTIMOS_7_DIAS', 'ULTIMOS_30_DIAS', 'PERSONALIZADO', '', null]) {
      await assert.rejects(service.salvar(1, invalido), (e) => e.code === 'PERIODO_PADRAO_INVALIDO' && e.statusCode === 400);
    }
    await assert.rejects(service.obter(0), (e) => e.code === 'EMPRESA_CENTRAL_AUSENTE');
    await assert.rejects(service.salvar('todas', 'MES_VIGENTE'), (e) => e.code === 'EMPRESA_CENTRAL_AUSENTE');
    assert.strictEqual((await service.obter(1)).periodoPadrao, 'MES_VIGENTE');
  });

  await test('filtro manual: com MES_VIGENTE salvo, datas informadas pelo operador consultam meses anteriores', async () => {
    const db = await criarBanco();
    await inserirDoc(db, { empresaId: 1, dataEmissao: '2026-07-15T10:00:00-03:00', chave: '35260700000000000000550010000001111000000011' });
    await inserirDoc(db, { empresaId: 1, dataEmissao: '2026-08-20T10:00:00-03:00', chave: '35260800000000000000550010000002222000000022' });
    await inserirDoc(db, { empresaId: 1, dataEmissao: '2026-09-05T10:00:00-03:00', chave: '35260900000000000000550010000003333000000033' });
    await inserirDoc(db, { empresaId: 2, dataEmissao: '2026-08-21T10:00:00-03:00', chave: '35260800000000000000550010000004444000000044' });
    const service = new CentralPeriodoPadraoService({ db, agora: () => AGORA });
    await service.salvar(1, 'MES_VIGENTE');
    const repo = new CentralDocumentosRepository({ db });

    const padrao = (await service.obter(1)).intervalo;
    const mes = await repo.listar({ empresaId: 1, ...padrao });
    assert.deepStrictEqual(mes.map((d) => d.dataEmissao.slice(0, 7)), ['2026-09']);

    const manual = await repo.listar({ empresaId: 1, dataEmissaoInicio: '2026-07-01', dataEmissaoFim: '2026-08-31' });
    assert.deepStrictEqual(manual.map((d) => d.dataEmissao.slice(0, 7)).sort(), ['2026-07', '2026-08']);

    const semDatas = await repo.listar({ empresaId: 1 });
    assert.strictEqual(semDatas.length, 3);
    assert.ok(semDatas.every((d) => d.empresaId === 1));
  });

  await test('histórico preservado: salvar período não apaga documentos, NSU nem outras configs', async () => {
    const db = await criarBanco();
    await inserirDoc(db, { empresaId: 1, dataEmissao: '2025-01-10', chave: '35250100000000000000550010000005555000000055' });
    await inserirDoc(db, { empresaId: 1, dataEmissao: '2026-09-10', chave: '35260900000000000000550010000006666000000066' });
    await run(db, "INSERT INTO central_entradas_nsu (empresa_id, ultimo_nsu, max_nsu) VALUES (1, '000000000012345', '000000000012400')");
    await run(db, "INSERT INTO central_entradas_config (chave, valor, tipo) VALUES ('recuperacao_xml_ativa', 'true', 'boolean')");
    const service = new CentralPeriodoPadraoService({ db, agora: () => AGORA });
    await service.salvar(1, 'MES_VIGENTE');
    await service.salvar(1, 'TODO_PERIODO');
    await service.salvar(1, 'MES_VIGENTE');
    assert.strictEqual((await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos')).n, 2);
    const nsu = await get(db, 'SELECT ultimo_nsu, max_nsu FROM central_entradas_nsu WHERE empresa_id = 1');
    assert.deepStrictEqual({ ...nsu }, { ultimo_nsu: '000000000012345', max_nsu: '000000000012400' });
    const cfg = await get(db, "SELECT valor FROM central_entradas_config WHERE chave = 'recuperacao_xml_ativa'");
    assert.strictEqual(cfg.valor, 'true');
    const repo = new CentralDocumentosRepository({ db });
    assert.strictEqual((await repo.listar({ empresaId: 1 })).length, 2);
  });

  await test('filtros rápidos continuam disponíveis e funcionando', async () => {
    const codigos = listarPresets().map((p) => p.codigo);
    for (const c of ['hoje', 'ontem', 'ultimos_7_dias', 'ultimos_30_dias', 'este_mes']) {
      assert.ok(codigos.includes(c), `preset ${c}`);
      assert.ok(obterPreset(c).sql);
    }
    const db = await criarBanco();
    await run(
      db,
      `INSERT INTO central_entradas_documentos (chave, data_emissao, status, tipo_documento, empresa_id)
       VALUES ('A', date('now', 'localtime'), 'RESUMO_RECEBIDO', 'RES_NFE', 1),
              ('B', date('now', 'localtime', '-60 days'), 'RESUMO_RECEBIDO', 'RES_NFE', 1)`
    );
    const service = new CentralPeriodoPadraoService({ db });
    await service.salvar(1, 'TODO_PERIODO');
    const repo = new CentralDocumentosRepository({ db });
    assert.deepStrictEqual((await repo.listar({ empresaId: 1, filtroRapido: 'hoje' })).map((d) => d.chave), ['A']);
    assert.deepStrictEqual((await repo.listar({ empresaId: 1, filtroRapido: 'ultimos_7_dias' })).map((d) => d.chave), ['A']);
    assert.deepStrictEqual((await repo.listar({ empresaId: 1, filtroRapido: 'este_mes' })).map((d) => d.chave), ['A']);
    assert.strictEqual((await repo.listar({ empresaId: 1 })).length, 2);
  });

  await test('tela: configuração oferece somente as duas opções e aplica o período ao trocar de empresa', async () => {
    const js = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/central-entradas.js'), 'utf8');
    assert.ok(js.includes('/configuracao/periodo-padrao'));
    assert.ok(js.includes('cfgPeriodoPadrao'));
    assert.ok(js.includes('cfgBtnSalvarPeriodoPadrao'));
    assert.ok(/aplicarPeriodoPadraoCentral\(\)/.test(js));
    const rotas = fs.readFileSync(path.join(__dirname, '../../backend/rotas/central-entradas.js'), 'utf8');
    assert.ok(rotas.includes("router.get('/configuracao/periodo-padrao'"));
    assert.ok(rotas.includes("router.put('/configuracao/periodo-padrao'"));
  });

  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exitCode = falhas ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
