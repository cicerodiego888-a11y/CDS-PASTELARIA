'use strict';

/*
 * Harness isolado de identificação MIIP/MUBC (somente SQLite :memory: e dados sintéticos).
 *
 * As guardas abaixo são instaladas ANTES de qualquer import do projeto:
 *  - bloqueia o carregamento de backend/database.js, backend/server.js, electron*.js e 'electron';
 *  - só permite abrir SQLite com o nome ':memory:';
 *  - bloqueia leitura/abertura de arquivos *.db / *.sqlite pela camada JS.
 * Qualquer violação lança erro e reprova o harness.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const guard = { sqliteOpened: [], blockedModules: [], blockedFiles: [] };

const forbiddenFiles = new Set([
  path.join(ROOT, 'backend', 'database.js'),
  path.join(ROOT, 'backend', 'server.js'),
  ...fs.readdirSync(ROOT)
    .filter((name) => /^electron.*\.js$/i.test(name))
    .map((name) => path.join(ROOT, name))
].map((file) => file.toLowerCase()));

const originalLoad = Module._load;
Module._load = function guardedLoad(request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (request === 'electron' || (resolved && forbiddenFiles.has(resolved.toLowerCase()))) {
    guard.blockedModules.push(request);
    throw new Error(`HARNESS_GUARD: carregamento bloqueado de "${request}"`);
  }
  return originalLoad.apply(this, arguments);
};

const dbFilePattern = /\.(db|sqlite3?|db-wal|db-shm)$/i;
['openSync', 'readFileSync', 'createReadStream', 'open', 'copyFileSync'].forEach((name) => {
  const original = fs[name];
  fs[name] = function guardedFs(target, ...rest) {
    if (typeof target === 'string' && dbFilePattern.test(target)) {
      guard.blockedFiles.push(path.basename(target));
      throw new Error('HARNESS_GUARD: acesso a arquivo de banco bloqueado');
    }
    return original.call(this, target, ...rest);
  };
});

const sqlite3 = require('sqlite3');
const OriginalDatabase = sqlite3.Database;
class GuardedDatabase extends OriginalDatabase {
  constructor(filename, ...rest) {
    if (filename !== ':memory:') {
      guard.blockedFiles.push(String(filename ? path.basename(String(filename)) : '(anonimo)'));
      throw new Error('HARNESS_GUARD: somente SQLite :memory: é permitido');
    }
    super(filename, ...rest);
    guard.sqliteOpened.push(filename);
  }
}
sqlite3.Database = GuardedDatabase;

const {
  createMiipOriginDiagnostics,
  isEnabled
} = require('../../backend/motores/miip/diagnostics/MiipOriginDiagnostics');
const { ProdutoRepository } = require('../../backend/motores/miip/repositories/ProdutoRepository');
const produtoCache = require('../../backend/motores/miip/cache/ProdutoCache');
const MotorGTIN = require('../../backend/motores/miip/engines/gtin/MotorGTIN');
const MotorAssociacaoFornecedor = require('../../backend/motores/miip/engines/fornecedor/MotorAssociacaoFornecedor');
const MotorUniversalBuscaCandidatos = require('../../backend/motores/miip/engines/mubc/MotorUniversalBuscaCandidatos');
const MipLookupCache = require('../../backend/motores/produto-identidade/observability/MipLookupCache');
const ProdutoIdentidadeCatalogo = require('../../backend/motores/produto-identidade/services/ProdutoIdentidadeCatalogo');
const CentralProcessamentoService = require('../../backend/motores/central-entradas/services/CentralProcessamentoService');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const fixtureLoader = require('./helpers/origin-fixture-loader');

// Somente estas fixtures são carregadas; qualquer outro arquivo na pasta reprova o teste de contrato.
const FIXTURES_DECLARADAS = [
  'a-busca-gtin.json',
  'b-gtin-divergente.json',
  'c-associacao-fornecedor.json',
  'd-resultado-persistido.json',
  'e-catalogo-alterado.json',
  'f-metadados-ausentes.json'
];
const carregador = fixtureLoader.criarCarregador({ declaradas: FIXTURES_DECLARADAS });
const fixtures = {};
const fixtureScores = [];

// DB_DIR é apenas a trava exigida pelo gate; nenhum arquivo é criado nesse diretório.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miip-isolated-harness-'));
const ENV = { NODE_ENV: 'test', CDS_MIIP_ORIGIN_DIAGNOSTICS: '1', DB_DIR: TEMP_DIR };
const silent = { registrar() {}, registrarExecucao() {} };

const SYNTHETIC = {
  gtinAlfa: '7890000000011',
  gtinBeta: '7890000000028',
  gtinItemNota: '7890000000035',
  codigoAlfa: 'SINT-A11',
  codigoBeta: 'SINT-B22',
  codigoFornecedor: 'CPROD-SINTETICO-01',
  cnpj: '11111111000191',
  nomeAlfa: 'Bebida Sintetica Alfa 2L',
  nomeBeta: 'Bebida Sintetica Beta 2L'
};
const SENSITIVE_VALUES = Object.values(SYNTHETIC);

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

async function snapshotDb(db) {
  const tables = await all(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const out = {};
  for (const { name } of tables) {
    out[name] = await all(db, `SELECT * FROM ${name} ORDER BY 1`);
  }
  return JSON.stringify(out);
}

async function criarTabelaProdutos(db) {
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, codigo TEXT, codigo_barras TEXT, nome TEXT, unidade TEXT,
    ncm TEXT, cest TEXT, categoria_id INTEGER, subcategoria_id INTEGER, fornecedor TEXT,
    preco_venda REAL, ativo INTEGER, marca_id INTEGER
  )`);
}

async function criarTabelaMarcas(db) {
  await run(db, 'CREATE TABLE marcas (id INTEGER PRIMARY KEY, nome TEXT)');
}

async function criarTabelaAssociacoes(db) {
  await run(db, `CREATE TABLE miip_associacoes (
    id INTEGER PRIMARY KEY, produto_id INTEGER, origem TEXT, fornecedor_cnpj TEXT,
    fornecedor_nome TEXT, codigo_fornecedor TEXT, codigo_barras TEXT, nome_item TEXT,
    nome_normalizado TEXT, ncm TEXT, unidade TEXT, score INTEGER, confianca TEXT,
    status TEXT, fonte TEXT, decisao_operacao_id TEXT, confirmado_por_usuario_id INTEGER,
    metadados TEXT, last_used_at TEXT, created_at TEXT, updated_at TEXT
  )`);
}

async function inserirProduto(db, { id, codigo, gtin, nome, ncm = '22021000' }) {
  await run(db, `INSERT INTO produtos (id,codigo,codigo_barras,nome,unidade,ncm,ativo)
    VALUES (?,?,?,?,'UN',?,1)`, [id, codigo, gtin, nome, ncm]);
}

// `carregadoEm` e `timestamp` de evidência são carimbos de tempo gerados a cada execução; não são dados de decisão.
function candidatosJson(candidatos) {
  return JSON.stringify(
    candidatos.map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c)),
    (key, value) => (key === 'carregadoEm' || key === 'timestamp' ? undefined : value)
  );
}

function resultadoImportacao(operacaoId, candidatos, motor) {
  const selecionado = candidatos[0];
  return {
    resultados: [{
      operacaoId,
      score: selecionado.scoreTotal,
      motor,
      produtoEncontrado: selecionado.produto,
      candidatoSelecionado: selecionado,
      candidatos
    }]
  };
}

function eventosDoDocumento(events, documentoId, evento) {
  return events.filter((e) => e.documentoId === documentoId && (!evento || e.evento === evento));
}

function assertSemValoresSensiveis(events) {
  const serializado = JSON.stringify(events);
  SENSITIVE_VALUES.forEach((valor) => {
    assert.ok(!serializado.includes(valor), 'evento não deve conter valores de identidade');
  });
}

async function main() {
  let passou = 0;
  let falhou = 0;
  const resumo = [];

  async function scenario(name, fn) {
    const db = new sqlite3.Database(':memory:');
    const events = [];
    const diagnostics = createMiipOriginDiagnostics({ env: ENV, sink: (e) => events.push(e) });
    const disabled = createMiipOriginDiagnostics({
      env: { ...ENV, NODE_ENV: 'production' },
      sink: () => { throw new Error('diagnóstico desabilitado não pode emitir'); }
    });
    produtoCache.limpar();
    try {
      await fn({ db, events, diagnostics, disabled });
      passou += 1;
      resumo.push({ cenario: name, resultado: 'OK', eventos: events.length });
      console.log(`  OK  ${name} (${events.length} evento(s))`);
    } catch (error) {
      falhou += 1;
      resumo.push({ cenario: name, resultado: 'FALHOU' });
      console.error(`  FALHOU  ${name}\n         ${error.stack || error.message}`);
    } finally {
      produtoCache.limpar();
      await closeDb(db);
    }
  }

  console.log('\n=== Harness isolado MIIP (SQLite :memory:, dados sintéticos) ===\n');

  await scenario('0. gate e controles negativos das guardas', async () => {
    assert.equal(isEnabled(ENV), true);
    assert.equal(isEnabled({ ...ENV, NODE_ENV: 'production' }), false);
    assert.equal(isEnabled({ ...ENV, CDS_MIIP_ORIGIN_DIAGNOSTICS: '0' }), false);
    assert.equal(isEnabled({ ...ENV, DB_DIR: path.join(ROOT, 'backend', 'banco') }), false);

    assert.throws(() => require('../../backend/database'), /HARNESS_GUARD/);
    assert.throws(() => require('../../backend/server'), /HARNESS_GUARD/);
    assert.throws(() => require('electron'), /HARNESS_GUARD/);

    const controle = path.join(TEMP_DIR, 'controle-guarda.db');
    assert.throws(() => new sqlite3.Database(controle), /HARNESS_GUARD/);
    assert.equal(fs.existsSync(controle), false);
    assert.throws(() => fs.readFileSync(controle), /HARNESS_GUARD/);
  });

  await scenario('1. busca atual por GTIN', async ({ db, events, diagnostics, disabled }) => {
    await criarTabelaProdutos(db);
    await inserirProduto(db, { id: 11, codigo: SYNTHETIC.codigoAlfa, gtin: SYNTHETIC.gtinAlfa, nome: SYNTHETIC.nomeAlfa });
    const repo = new ProdutoRepository({ db, originDiagnostics: diagnostics, isMipEnabled: () => false });
    const repoOff = new ProdutoRepository({ db, originDiagnostics: disabled, isMipEnabled: () => false });
    const item = { codigoBarras: SYNTHETIC.gtinAlfa };

    const referencia = await new MotorGTIN({ produtoRepository: repoOff, metricsCollector: silent, logService: silent })
      .identificar(item);
    produtoCache.limpar();
    const antesDb = await snapshotDb(db);

    let candidatos;
    await diagnostics.withContext({ documentoId: 8101 }, async () => {
      diagnostics.setOperationId('op-harness-gtin');
      candidatos = await new MotorGTIN({ produtoRepository: repo, metricsCollector: silent, logService: silent })
        .identificar(item);
    });
    assert.equal(candidatos.length, 1);
    assert.equal(candidatosJson(candidatos), candidatosJson(referencia));

    const antesCandidato = candidatosJson(candidatos);
    diagnostics.recordImport({
      documentoId: 8101,
      operacaoId: 'op-harness-gtin',
      resultOrigin: 'novo_processamento',
      importResult: resultadoImportacao('op-harness-gtin', candidatos, 'motor_gtin')
    });
    assert.equal(candidatosJson(candidatos), antesCandidato);
    assert.equal(await snapshotDb(db), antesDb);

    const lookup = eventosDoDocumento(events, 8101, 'consulta_produto');
    assert.ok(lookup.some((e) => e.tipoConsulta === 'gtin' && e.cacheHit === false && e.produtoId === 11));
    const resultado = eventosDoDocumento(events, 8101, 'resultado_item')[0];
    assert.equal(resultado.origemResultado, 'novo_processamento');
    assert.equal(resultado.operacaoId, 'op-harness-gtin');
    assert.equal(resultado.candidatos[0].produtoId, 11);
    assert.ok(resultado.candidatos[0].fontes.includes('busca_gtin'));
    assert.equal(resultado.candidatos[0].scoreOriginal, candidatos[0].scoreTotal);
    assertSemValoresSensiveis(events);
  });

  await scenario('2. candidato por descrição/NCM com GTIN divergente', async ({ db, events, diagnostics, disabled }) => {
    await criarTabelaProdutos(db);
    await criarTabelaMarcas(db);
    await inserirProduto(db, { id: 22, codigo: SYNTHETIC.codigoBeta, gtin: SYNTHETIC.gtinBeta, nome: SYNTHETIC.nomeBeta });
    const item = {
      produtoNome: SYNTHETIC.nomeBeta,
      codigoBarras: SYNTHETIC.gtinItemNota,
      ncm: '22021000',
      unidade: 'UN'
    };
    const mubc = (diag) => new MotorUniversalBuscaCandidatos({
      produtoRepository: new ProdutoRepository({ db, originDiagnostics: diag, isMipEnabled: () => false }),
      metricsCollector: silent,
      logService: silent
    });

    const referencia = await mubc(disabled).identificar(item);
    produtoCache.limpar();
    const antesDb = await snapshotDb(db);

    let candidatos;
    await diagnostics.withContext({ documentoId: 8102 }, async () => {
      diagnostics.setOperationId('op-harness-mubc');
      candidatos = await mubc(diagnostics).identificar(item);
    });
    assert.ok(candidatos.length >= 1, 'MUBC deve devolver o candidato textual');
    assert.equal(candidatosJson(candidatos), candidatosJson(referencia));

    const candidato = candidatos.find((c) => c.produtoId === 22);
    assert.ok(candidato);
    assert.ok(!candidato.evidencias.some((e) => e.tipo === 'gtin_exato'));
    const [linha] = await all(db, 'SELECT codigo_barras FROM produtos WHERE id = 22');
    assert.notEqual(linha.codigo_barras, item.codigoBarras, 'GTIN do catálogo difere do GTIN do item');

    const antesCandidato = candidatosJson(candidatos);
    diagnostics.recordImport({
      documentoId: 8102,
      operacaoId: 'op-harness-mubc',
      resultOrigin: 'novo_processamento',
      importResult: resultadoImportacao('op-harness-mubc', candidatos, 'motor_mubc')
    });
    assert.equal(candidatosJson(candidatos), antesCandidato);
    assert.equal(await snapshotDb(db), antesDb);

    const busca = eventosDoDocumento(events, 8102, 'busca_catalogo_universal')[0];
    assert.equal(busca.contextoCatalogo, 'sqlite_injetado');
    assert.ok(busca.candidatos.some((c) => c.produtoId === 22 && c.motivosBusca.includes('descricao')));
    const resultado = eventosDoDocumento(events, 8102, 'resultado_item')[0];
    const registro = resultado.candidatos.find((c) => c.produtoId === 22);
    assert.ok(registro.fontes.includes('busca_textual_ncm'));
    assert.ok(!registro.fontes.includes('busca_gtin'));
    assert.ok(!registro.fontes.includes('associacao_fornecedor'));
    assertSemValoresSensiveis(events);
  });

  await scenario('3. associação sintética de fornecedor', async ({ db, events, diagnostics, disabled }) => {
    await criarTabelaProdutos(db);
    await criarTabelaAssociacoes(db);
    await inserirProduto(db, { id: 33, codigo: 'SINT-C33', gtin: '7890000000042', nome: 'Produto Associado Sintetico' });
    await run(db, `INSERT INTO miip_associacoes
      (id,produto_id,origem,fornecedor_cnpj,codigo_fornecedor,nome_item,status)
      VALUES (1,33,'manual',?,?,'Item associado sintetico','ativa')`, [SYNTHETIC.cnpj, SYNTHETIC.codigoFornecedor]);
    const item = { fornecedorCnpj: SYNTHETIC.cnpj, codigoFornecedor: SYNTHETIC.codigoFornecedor };
    const motor = (diag) => new MotorAssociacaoFornecedor({
      db,
      produtoRepository: new ProdutoRepository({ db, originDiagnostics: diag, isMipEnabled: () => false }),
      metricsCollector: silent,
      logService: silent
    });

    const referencia = await motor(disabled).identificar(item);
    produtoCache.limpar();
    const antesDb = await snapshotDb(db);

    let candidatos;
    await diagnostics.withContext({ documentoId: 8103 }, async () => {
      diagnostics.setOperationId('op-harness-assoc');
      candidatos = await motor(diagnostics).identificar(item);
    });
    assert.equal(candidatos[0].produtoId, 33);
    assert.equal(candidatosJson(candidatos), candidatosJson(referencia));

    const antesCandidato = candidatosJson(candidatos);
    diagnostics.recordImport({
      documentoId: 8103,
      operacaoId: 'op-harness-assoc',
      resultOrigin: 'novo_processamento',
      importResult: resultadoImportacao('op-harness-assoc', candidatos, 'motor_associacao_fornecedor')
    });
    assert.equal(candidatosJson(candidatos), antesCandidato);
    assert.equal(await snapshotDb(db), antesDb);

    const resultado = eventosDoDocumento(events, 8103, 'resultado_item')[0];
    assert.ok(resultado.candidatos[0].fontes.includes('associacao_fornecedor'));
    assert.equal(resultado.candidatos[0].produtoId, 33);
    assertSemValoresSensiveis(events);
  });

  await scenario('4. resultado MIIP persistido reutilizado', async ({ events, diagnostics }) => {
    const persistido = {
      operacaoId: 'op-harness-persistido',
      resultados: [{
        operacaoId: 'op-harness-persistido',
        produtoEncontrado: { id: 44, nome: 'Snapshot sintetico antigo', codigo: 'ANTIGO', codigoBarras: '0000000000000' },
        candidatoSelecionado: {
          produtoId: 44,
          produto: { id: 44, nome: 'Snapshot sintetico antigo', codigo: 'ANTIGO', codigoBarras: '0000000000000' },
          motoresQueVotaram: ['motor_gtin'],
          evidencias: [{ motor: 'motor_gtin', tipo: 'gtin_exato', valor: 'valor-privado-sintetico' }]
        },
        score: 58,
        motor: 'motor_gtin'
      }]
    };
    const documento = {
      id: 8104,
      empresaId: 7,
      status: DocumentoFiscalStatus.EM_REVISAO,
      parseJson: { miip_importacao: persistido },
      miipResumoJson: persistido,
      miipSessaoId: persistido.operacaoId
    };
    const antes = JSON.stringify(documento);
    const service = new CentralProcessamentoService({
      documentosRepository: { async buscarPorId() { return documento; } },
      originDiagnostics: diagnostics,
      parseXml: async () => { throw new Error('parser não deveria rodar'); },
      enriquecerParse: async () => { throw new Error('MIIP não deveria rodar'); }
    });
    const resposta = await service.processar(8104, { empresaId: 7 });
    assert.equal(resposta.reutilizado, true);
    assert.equal(JSON.stringify(documento), antes, 'documento persistido não pode ser alterado');

    const resultado = eventosDoDocumento(events, 8104, 'resultado_item')[0];
    assert.equal(resultado.origemResultado, 'persistido_reutilizado');
    assert.equal(resultado.operacaoId, 'op-harness-persistido');
    assert.equal(resultado.candidatos[0].produtoId, 44);
    assert.equal(resultado.candidatos[0].scoreOriginal, 58);
    assert.ok(!JSON.stringify(events).includes('valor-privado-sintetico'));
  });

  await scenario('5. cache por ID/GTIN com snapshot sintético desatualizado', async ({ db, events, diagnostics }) => {
    await criarTabelaProdutos(db);
    await inserirProduto(db, { id: 55, codigo: SYNTHETIC.codigoAlfa, gtin: SYNTHETIC.gtinAlfa, nome: SYNTHETIC.nomeAlfa });
    const repo = new ProdutoRepository({ db, originDiagnostics: diagnostics, isMipEnabled: () => false });

    await diagnostics.withContext({ documentoId: 8105, operacaoId: 'op-harness-cache' }, async () => {
      const primeiro = await repo.buscarPorId(55);
      assert.equal(primeiro.nome, SYNTHETIC.nomeAlfa);
      const primeiroGtin = await repo.buscarPorGtin(SYNTHETIC.gtinAlfa);
      assert.equal(primeiroGtin.id, 55);

      await run(db, "UPDATE produtos SET nome='Nome sintetico atualizado', codigo='SINT-NOVO', codigo_barras='7890000000059' WHERE id=55");
      const [atual] = await all(db, 'SELECT nome FROM produtos WHERE id = 55');
      assert.equal(atual.nome, 'Nome sintetico atualizado');

      const porId = await repo.buscarPorId(55);
      const porGtin = await repo.buscarPorGtin(SYNTHETIC.gtinAlfa);
      assert.equal(porId.nome, SYNTHETIC.nomeAlfa, 'cache por ID devolve snapshot desatualizado');
      assert.equal(porGtin.nome, SYNTHETIC.nomeAlfa, 'cache por GTIN devolve snapshot desatualizado');
    });

    const consultas = eventosDoDocumento(events, 8105, 'consulta_produto');
    const porId = consultas.filter((e) => e.tipoConsulta === 'id');
    const porGtin = consultas.filter((e) => e.tipoConsulta === 'gtin');
    assert.equal(porId[porId.length - 1].cacheHit, true);
    assert.equal(porId[porId.length - 1].fonteConsulta, 'produto_cache');
    assert.equal(porGtin[porGtin.length - 1].cacheHit, true);
    assert.equal(porGtin[porGtin.length - 1].produtoId, 55);

    const mipCache = new MipLookupCache(10);
    const catalogo = new ProdutoIdentidadeCatalogo({ db, cache: mipCache, originDiagnostics: diagnostics });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await diagnostics.withContext({ documentoId: 8106, operacaoId: 'op-harness-mip' }, async () => {
        await run(db, "UPDATE produtos SET codigo_barras='7890000000066', nome='Nome MIP original' WHERE id=55");
        const primeiro = await catalogo.buscarProdutoPorCodigoBarras('7890000000066');
        assert.equal(primeiro.id, 55);
        await run(db, "UPDATE produtos SET nome='Nome MIP alterado' WHERE id=55");
        const segundo = await catalogo.buscarProdutoPorCodigoBarras('7890000000066');
        assert.equal(segundo.nome, 'Nome MIP original');
      });
    } finally {
      console.log = originalLog;
    }
    const mip = eventosDoDocumento(events, 8106, 'consulta_produto').filter((e) => e.tipoConsulta === 'gtin');
    assert.deepEqual(mip.map((e) => e.cacheHit), [false, true]);
    assert.ok(!JSON.stringify(events).includes('7890000000066'));
    assertSemValoresSensiveis(events);
  });

  await scenario('6. ausência de metadados de origem', async ({ events, diagnostics }) => {
    const entrada = {
      resultados: [
        { operacaoId: 'op-harness-sem-origem', score: 58, produtoEncontrado: { id: 66 } },
        { operacaoId: 'op-harness-sem-origem', score: 0 }
      ]
    };
    const antes = JSON.stringify(entrada);
    diagnostics.recordImport({
      documentoId: 8107,
      operacaoId: 'op-harness-sem-origem',
      resultOrigin: undefined,
      importResult: entrada
    });
    assert.equal(JSON.stringify(entrada), antes);

    const [comProduto, semProduto] = eventosDoDocumento(events, 8107, 'resultado_item');
    assert.equal(comProduto.origemResultado, 'desconhecida');
    assert.deepEqual(comProduto.candidatos[0].fontes, ['desconhecida']);
    assert.equal(comProduto.candidatos[0].produtoId, 66);
    assert.equal(comProduto.candidatos[0].motor, null);
    assert.deepEqual(comProduto.candidatos[0].origemCamposIdentidade, {
      nome: 'desconhecida', codigo: 'desconhecida', gtin: 'desconhecida'
    });
    assert.equal(semProduto.candidatos[0].produtoId, null);
    assert.deepEqual(semProduto.candidatos[0].fontes, ['desconhecida']);
  });

  // ===== Fixtures JSON sintéticas (contratos reais) =====
  console.log('\n--- Fixtures sintéticas ---\n');

  const estruturaFonte = (registro) => [...registro.fontes].sort();
  // Nenhum valor de identidade da fixture (nome, código, GTIN, CNPJ, código de fornecedor) pode aparecer nos eventos.
  function assertEventosSemFixture(events, fx) {
    const serializado = JSON.stringify(events);
    const valores = [
      ...(fx.catalogo || []).flatMap((p) => [p.codigo, p.codigo_barras, p.nome]),
      ...(fx.associacoes || []).flatMap((a) => [a.fornecedor_cnpj, a.codigo_fornecedor, a.fornecedor_nome, a.nome_item]),
      ...Object.values(fx.item || {}).filter((v) => typeof v === 'string' && v.length >= 8)
    ];
    valores.forEach((valor) => assert.ok(!serializado.includes(valor), 'evento não deve conter valores de identidade da fixture'));
  }
  const registrosDoDocumento = (events, documentoId) =>
    eventosDoDocumento(events, documentoId, 'resultado_item').flatMap((e) => e.candidatos);

  async function executarBusca(fx, { db, diagnostics, disabled, events, documentoId, operacaoId }) {
    const construir = (diag) => {
      const repo = new ProdutoRepository({ db, originDiagnostics: diag, isMipEnabled: () => false });
      if (fx.cenario === 'A') {
        return new MotorGTIN({ produtoRepository: repo, metricsCollector: silent, logService: silent });
      }
      if (fx.cenario === 'B') {
        return new MotorUniversalBuscaCandidatos({ produtoRepository: repo, metricsCollector: silent, logService: silent });
      }
      return new MotorAssociacaoFornecedor({ db, produtoRepository: repo, metricsCollector: silent, logService: silent });
    };
    const motorPorCenario = { A: 'motor_gtin', B: 'motor_mubc', C: 'motor_associacao_fornecedor' };

    const referencia = await construir(disabled).identificar(fx.item);
    produtoCache.limpar();
    const antesDb = await snapshotDb(db);

    let candidatos;
    await diagnostics.withContext({ documentoId }, async () => {
      diagnostics.setOperationId(operacaoId);
      candidatos = await construir(diagnostics).identificar(fx.item);
    });
    assert.ok(candidatos.length >= 1, 'o motor real deve devolver ao menos um candidato');
    assert.equal(candidatosJson(candidatos), candidatosJson(referencia), 'instrumentação não altera candidatos');

    const antesCandidatos = candidatosJson(candidatos);
    diagnostics.recordImport({
      documentoId,
      operacaoId,
      resultOrigin: 'novo_processamento',
      importResult: resultadoImportacao(operacaoId, candidatos, motorPorCenario[fx.cenario])
    });
    assert.equal(candidatosJson(candidatos), antesCandidatos, 'recordImport não altera candidatos');
    assert.equal(await snapshotDb(db), antesDb, 'tabelas em memória intactas');

    const resultado = eventosDoDocumento(events, documentoId, 'resultado_item')[0];
    assert.equal(resultado.origemResultado, fx.esperado.origemResultado ?? 'novo_processamento');
    assert.equal(resultado.operacaoId, operacaoId);
    const registro = resultado.candidatos.find((c) => c.produtoId === fx.esperado.produtoId);
    assert.ok(registro, 'candidato esperado presente nos eventos');
    assert.deepEqual(estruturaFonte(registro), [...fx.esperado.fontes].sort());
    assert.equal(registro.scoreOriginal, candidatos.find((c) => c.produtoId === fx.esperado.produtoId).scoreTotal);
    fixtureScores.push({
      fixture: fx.id,
      origem: 'calculado_pelo_motor_real',
      motor: motorPorCenario[fx.cenario],
      scoreCalculado: registro.scoreOriginal
    });
    assertSemValoresSensiveis(events);
    assertEventosSemFixture(events, fx);
    return { candidatos, registro, resultado };
  }

  await scenario('Fx0. contrato, schema e rejeições do carregador de fixtures', async () => {
    assert.deepEqual(carregador.naoDeclaradasNoDiretorio(), [], 'pasta de fixtures só contém arquivos declarados');
    FIXTURES_DECLARADAS.forEach((nome) => {
      fixtures[nome] = carregador.carregar(nome);
      assert.equal(fixtures[nome].sintetico, true);
      assert.equal(fixtures[nome].schema, fixtureLoader.SCHEMA);
    });
    assert.deepEqual(Object.keys(fixtures).sort(), [...FIXTURES_DECLARADAS].sort());
    assert.throws(() => carregador.carregar('nao-declarada.json'), /não declarada/);
    assert.throws(() => carregador.carregar('..\\a-busca-gtin.json'), /não declarada/);
    assert.throws(() => fixtureLoader.criarCarregador({ declaradas: ['..\\x.json'] }), /nome de arquivo inválido/);
    assert.throws(() => fixtureLoader.criarCarregador({ declaradas: ['sub/x.json'] }), /nome de arquivo inválido/);

    const base = () => JSON.parse(JSON.stringify(fixtures['a-busca-gtin.json']));
    const rejeita = (mutar, padrao) => {
      const copia = base();
      mutar(copia);
      assert.throws(() => fixtureLoader.validarFixture('(memoria)', copia), padrao);
    };
    rejeita((f) => { f.schema = 'outro'; }, /schema deve ser/);
    rejeita((f) => { f.sintetico = false; }, /sintetico deve ser true/);
    rejeita((f) => { f.extra = 1; }, /campo de topo não permitido/);
    rejeita((f) => { f.catalogo[0].cpf = '0'; }, /nome de campo fiscal\/pessoal rejeitado/);
    rejeita((f) => { f.catalogo[0].codigo_barras = '7891234567890'; }, /GTIN sintético/);
    rejeita((f) => { f.catalogo[0].codigo = 'ABC001'; }, /código interno SINT/);
    rejeita((f) => { f.catalogo[0].nome = 'Produto Comum'; }, /Sintetic/);
    rejeita((f) => { f.catalogo[0].nome = 'Sintetico mercadao.db'; }, /SQLite/);
    rejeita((f) => { f.descricao = 'caminho C:\\dados\\x'; }, /caminho rejeitado/);
    rejeita((f) => { f.descricao = 'veja ../fora'; }, /caminho rejeitado/);
    rejeita((f) => { f.descricao = 'insert into produtos values (1)'; }, /SQL rejeitado/);
    rejeita((f) => { f.descricao = '<nfe>real'; }, /marcação/);
    rejeita((f) => { f.item.fornecedorCnpj = '11222333000181'; }, /CNPJ sintético/);
    rejeita((f) => { f.item.xml = 'x'; }, /nome de campo fiscal\/pessoal rejeitado/);
    rejeita((f) => { f.item.produtoNome = 'Produto Sintetico'; f.item.estranho = 'x'; }, /campo não permitido/);

    const comAssoc = JSON.parse(JSON.stringify(fixtures['c-associacao-fornecedor.json']));
    comAssoc.associacoes[0].codigo_fornecedor = 'REAL-123';
    assert.throws(() => fixtureLoader.validarFixture('(memoria)', comAssoc), /CPROD-SINT/);
    const congelada = fixtures['a-busca-gtin.json'];
    assert.throws(() => { 'use strict'; congelada.id = 'x'; }, TypeError);
  });

  await scenario('FxA. busca atual por identificador (motor real)', async (ctx) => {
    const fx = fixtures['a-busca-gtin.json'];
    await fixtureLoader.criarSchema(ctx.db, ['produtos']);
    await fixtureLoader.inserirCatalogo(ctx.db, fx);
    const { candidatos, registro } = await executarBusca(fx, {
      ...ctx, documentoId: 9201, operacaoId: 'op-fixture-a'
    });
    assert.ok(candidatos[0].evidencias.some((e) => e.tipo === 'gtin_exato'));
    assert.ok(registro.evidencias.some((e) => e.tipo === 'gtin_exato'));
    const lookup = eventosDoDocumento(ctx.events, 9201, 'consulta_produto');
    assert.ok(lookup.some((e) => e.tipoConsulta === 'gtin' && e.cacheHit === fx.esperado.cacheHitEsperado));
    assert.deepEqual(registro.origemCamposIdentidade, { nome: 'snapshot_miip', codigo: 'snapshot_miip', gtin: 'snapshot_miip' });
  });

  await scenario('FxB. divergência de GTIN com score calculado pelo motor', async (ctx) => {
    const fx = fixtures['b-gtin-divergente.json'];
    await fixtureLoader.criarSchema(ctx.db, ['produtos', 'marcas']);
    await fixtureLoader.inserirCatalogo(ctx.db, fx);
    const produto = fx.catalogo[0];
    assert.notEqual(fx.item.codigoBarras, produto.codigo_barras, 'GTIN do item difere do cadastrado');
    assert.notEqual(fx.item.codigoFornecedor, produto.codigo, 'código do fornecedor difere do código interno');

    const { candidatos, registro } = await executarBusca(fx, {
      ...ctx, documentoId: 9202, operacaoId: 'op-fixture-b'
    });
    const candidato = candidatos.find((c) => c.produtoId === fx.esperado.produtoId);
    assert.ok(!candidato.evidencias.some((e) => e.tipo === 'gtin_exato'));
    assert.ok(!registro.fontes.includes('busca_gtin'));
    assert.ok(!registro.fontes.includes('associacao_fornecedor'));
    assert.equal(typeof candidato.scoreTotal, 'number');
    const busca = eventosDoDocumento(ctx.events, 9202, 'busca_catalogo_universal')[0];
    assert.ok(busca.candidatos.some((c) => c.produtoId === 202 && c.motivosBusca.includes('descricao')));
  });

  await scenario('FxC. associação de fornecedor sintética', async (ctx) => {
    const fx = fixtures['c-associacao-fornecedor.json'];
    await fixtureLoader.criarSchema(ctx.db, ['produtos', 'miip_associacoes']);
    await fixtureLoader.inserirCatalogo(ctx.db, fx);
    await fixtureLoader.inserirAssociacoes(ctx.db, fx);
    assert.notEqual(fx.item.codigoFornecedor, fx.catalogo[0].codigo);

    const { registro } = await executarBusca(fx, {
      ...ctx, documentoId: 9203, operacaoId: 'op-fixture-c'
    });
    assert.ok(registro.fontes.includes('associacao_fornecedor'));
    assert.ok(!JSON.stringify(ctx.events).includes(fx.item.fornecedorCnpj));
    assert.ok(!JSON.stringify(ctx.events).includes(fx.item.codigoFornecedor));
  });

  function documentoDaFixture(fx) {
    return {
      id: fx.documento.id,
      chave: fx.documento.chave,
      empresaId: fx.documento.empresaId,
      status: DocumentoFiscalStatus[fx.documento.status] ?? fx.documento.status,
      parseJson: { miip_importacao: fx.resultadoPersistido },
      miipResumoJson: fx.resultadoPersistido,
      miipSessaoId: fx.documento.miipSessaoId
    };
  }

  async function verificarContratoPersistido(db, fx) {
    // O candidato persistido só pode usar chaves que o motor real também produz.
    await fixtureLoader.criarSchema(db, ['produtos']);
    await fixtureLoader.inserirCatalogo(db, fx);
    const repo = new ProdutoRepository({ db, isMipEnabled: () => false });
    const [real] = await new MotorGTIN({ produtoRepository: repo, metricsCollector: silent, logService: silent })
      .identificar(fx.item);
    produtoCache.limpar();
    const chavesReais = Object.keys(real.toJSON ? real.toJSON() : real);
    const chavesProdutoReais = Object.keys((real.toJSON ? real.toJSON() : real).produto);
    const selecionado = fx.resultadoPersistido.resultados[0].candidatoSelecionado;
    Object.keys(selecionado).forEach((k) => assert.ok(chavesReais.includes(k), `chave "${k}" existe no contrato real`));
    Object.keys(selecionado.produto).forEach((k) => assert.ok(chavesProdutoReais.includes(k), `produto.${k} existe no contrato real`));
    return real;
  }

  async function reutilizarPersistido(fx, repoDocumentos, diag, opcoes = {}) {
    const service = new CentralProcessamentoService({
      documentosRepository: repoDocumentos,
      originDiagnostics: diag,
      parseXml: async () => { throw new Error('parser não deveria rodar'); },
      enriquecerParse: async () => { throw new Error('MIIP não deveria rodar'); }
    });
    return service.processar(fx.documento.id, { empresaId: fx.documento.empresaId, ...opcoes });
  }

  await scenario('FxD1. resultado persistido [persistencia_simulada: repositório fake, sem SQL de documentos]', async ({ db, events, diagnostics, disabled }) => {
    const fx = fixtures['d-resultado-persistido.json'];
    assert.equal(fx.persistencia, 'persistencia_simulada');
    await verificarContratoPersistido(db, fx);
    const documento = documentoDaFixture(fx);
    const antes = JSON.stringify(documento);
    const repoFake = { async buscarPorId() { return documento; } };

    const respostaOff = await reutilizarPersistido(fx, repoFake, disabled);
    const respostaOn = await reutilizarPersistido(fx, repoFake, diagnostics);
    assert.equal(respostaOn.reutilizado, true);
    assert.equal(JSON.stringify(respostaOn), JSON.stringify(respostaOff), 'resposta idêntica com instrumentação ligada/desligada');
    assert.equal(JSON.stringify(documento), antes, 'documento não alterado');

    const [registro] = registrosDoDocumento(events, fx.documento.id);
    const resultado = eventosDoDocumento(events, fx.documento.id, 'resultado_item')[0];
    assert.equal(resultado.origemResultado, fx.esperado.origemResultado);
    assert.equal(resultado.operacaoId, fx.documento.miipSessaoId);
    assert.equal(registro.produtoId, fx.esperado.produtoId);
    assert.deepEqual(estruturaFonte(registro), [...fx.esperado.fontes].sort());
    assert.equal(registro.scoreOriginal, fx.resultadoPersistido.resultados[0].score);
    fixtureScores.push({
      fixture: `${fx.id} (simulada)`,
      origem: 'valor_de_entrada_persistido',
      motor: registro.motor,
      scoreCalculado: null,
      scorePersistido: registro.scoreOriginal
    });
  });

  await scenario('FxD2. resultado persistido [persistencia_sql_memoria: CentralDocumentosRepository real em :memory:]', async ({ db, events, diagnostics, disabled }) => {
    const fx = fixtures['d-resultado-persistido.json'];
    await fixtureLoader.criarSchema(db, ['compras', 'central_entradas_documentos']);
    await fixtureLoader.inserirDocumentoPersistido(db, fx);
    const repoReal = new CentralDocumentosRepository({ db });
    const antesDb = await snapshotDb(db);

    const lido = await repoReal.buscarPorId(fx.documento.id);
    assert.deepEqual(lido.miipResumoJson, fx.resultadoPersistido, 'mapeador real desserializa miip_resumo_json');
    assert.equal(lido.miipSessaoId, fx.documento.miipSessaoId);

    const respostaOff = await reutilizarPersistido(fx, repoReal, disabled);
    const respostaOn = await reutilizarPersistido(fx, repoReal, diagnostics);
    assert.equal(respostaOn.reutilizado, true);
    assert.equal(JSON.stringify(respostaOn), JSON.stringify(respostaOff), 'resposta idêntica com instrumentação ligada/desligada');
    assert.equal(await snapshotDb(db), antesDb, 'tabelas em memória intactas');

    const [registro] = registrosDoDocumento(events, fx.documento.id);
    const resultado = eventosDoDocumento(events, fx.documento.id, 'resultado_item')[0];
    assert.equal(resultado.origemResultado, 'persistido_reutilizado');
    assert.equal(registro.produtoId, fx.esperado.produtoId);
    assert.equal(registro.scoreOriginal, fx.resultadoPersistido.resultados[0].score);
    assert.deepEqual(estruturaFonte(registro), [...fx.esperado.fontes].sort());
    fixtureScores.push({
      fixture: `${fx.id} (sql_memoria)`,
      origem: 'valor_de_entrada_persistido',
      motor: registro.motor,
      scoreCalculado: null,
      scorePersistido: registro.scoreOriginal
    });
  });

  async function sequenciaCache(db, fx, tipo, repo) {
    const original = fx.catalogo[0];
    const atualizacao = fx.catalogoAtualizado[0];
    const ler = tipo === 'id'
      ? () => repo.buscarPorId(original.id)
      : () => repo.buscarPorGtin(original.codigo_barras);
    const primeiro = await ler();
    await fixtureLoader.aplicarAtualizacaoCatalogo(db, fx);
    const aposAtualizar = await ler();
    return { primeiro, aposAtualizar };
  }

  for (const tipo of ['id', 'gtin']) {
    await scenario(`FxE-${tipo}. catálogo alterado após a identificação (cache por ${tipo.toUpperCase()})`, async ({ db, events, diagnostics, disabled }) => {
      const fx = fixtures['e-catalogo-alterado.json'];
      const original = fx.catalogo[0];
      const atualizacao = fx.catalogoAtualizado[0];
      await fixtureLoader.criarSchema(db, ['produtos']);
      await fixtureLoader.inserirCatalogo(db, fx);
      const inicial = await snapshotDb(db);
      const documentoId = tipo === 'id' ? 9501 : 9502;

      const repoOff = new ProdutoRepository({ db, originDiagnostics: disabled, isMipEnabled: () => false });
      const off = await sequenciaCache(db, fx, tipo, repoOff);
      const finalOff = await snapshotDb(db);

      // Restaura o catálogo e esvazia o cache apenas neste processo de teste para repetir com a instrumentação ligada.
      await fixtureLoader.aplicarAtualizacaoCatalogo(db, {
        catalogoAtualizado: [{
          id: original.id, codigo: original.codigo, codigo_barras: original.codigo_barras, nome: original.nome
        }]
      });
      assert.equal(await snapshotDb(db), inicial);
      produtoCache.limpar();

      let on;
      const repoOn = new ProdutoRepository({ db, originDiagnostics: diagnostics, isMipEnabled: () => false });
      await diagnostics.withContext({ documentoId, operacaoId: `op-fixture-e-${tipo}` }, async () => {
        on = await sequenciaCache(db, fx, tipo, repoOn);
      });
      assert.equal(await snapshotDb(db), finalOff, 'instrumentação não altera tabelas');
      const semCarimbo = (key, value) => (key === 'carregadoEm' ? undefined : value);
      assert.equal(JSON.stringify(on, semCarimbo), JSON.stringify(off, semCarimbo), 'valores devolvidos idênticos com instrumentação ligada/desligada');

      assert.equal(on.primeiro.nome, original.nome);
      assert.equal(on.aposAtualizar.nome, original.nome, 'cache devolve snapshot anterior');
      const [atual] = await all(db, 'SELECT nome, codigo, codigo_barras FROM produtos WHERE id = ?', [original.id]);
      assert.equal(atual.nome, atualizacao.nome, 'catálogo atual já foi atualizado');
      assert.notEqual(on.aposAtualizar.nome, atual.nome, 'snapshot do cache diverge do catálogo atual');

      const consultas = eventosDoDocumento(events, documentoId, 'consulta_produto').filter((e) => e.tipoConsulta === tipo);
      assert.deepEqual(consultas.map((e) => e.cacheHit), [false, fx.esperado.cacheHitEsperado]);
      assert.equal(consultas[1].produtoId, original.id);

      // Fora da instrumentação: após esvaziar o cache do processo de teste, a leitura reflete o catálogo atual.
      produtoCache.limpar();
      const fresco = tipo === 'id'
        ? await repoOff.buscarPorId(original.id)
        : await repoOff.buscarPorGtin(atualizacao.codigo_barras);
      assert.equal(fresco.nome, atualizacao.nome);
      assertSemValoresSensiveis(events);
      assert.ok(!JSON.stringify(events).includes(original.codigo_barras));
    });
  }

  await scenario('FxF. metadados de origem ausentes', async ({ events, diagnostics }) => {
    const fx = fixtures['f-metadados-ausentes.json'];
    const entrada = JSON.parse(JSON.stringify(fx.resultadoPersistido));
    const antes = JSON.stringify(entrada);
    diagnostics.recordImport({
      documentoId: 9601,
      operacaoId: entrada.operacaoId,
      resultOrigin: undefined,
      importResult: entrada
    });
    assert.equal(JSON.stringify(entrada), antes);
    const [registro] = registrosDoDocumento(events, 9601);
    const resultado = eventosDoDocumento(events, 9601, 'resultado_item')[0];
    assert.equal(resultado.origemResultado, fx.esperado.origemResultado);
    assert.deepEqual(registro.fontes, fx.esperado.fontes);
    assert.equal(registro.produtoId, fx.esperado.produtoId);
    assert.equal(registro.motor, null);
    assert.equal(registro.scoreOriginal, null);
    assert.deepEqual(registro.evidencias, []);
    assert.deepEqual(registro.origemCamposIdentidade, { nome: 'desconhecida', codigo: 'desconhecida', gtin: 'desconhecida' });
  });

  // Prova final de isolamento
  const projetoCarregado = Object.keys(require.cache)
    .filter((file) => file.startsWith(ROOT) && !file.includes(`${path.sep}node_modules${path.sep}`))
    .map((file) => path.relative(ROOT, file).toLowerCase());
  const proibidoCarregado = projetoCarregado.filter((file) =>
    file === path.join('backend', 'database.js')
    || file === path.join('backend', 'server.js')
    || /^electron.*\.js$/.test(file));
  const arquivosNoTemp = fs.readdirSync(TEMP_DIR);

  const provas = {
    arquivoProibidoCarregado: proibidoCarregado,
    sqliteAbertos: guard.sqliteOpened.length,
    sqliteSomenteMemoria: guard.sqliteOpened.every((f) => f === ':memory:'),
    bloqueiosDeModulo: guard.blockedModules.length,
    bloqueiosDeArquivoBanco: guard.blockedFiles.length,
    arquivosCriadosNoDiretorioTemporario: arquivosNoTemp.length,
    modulosDoProjetoCarregados: projetoCarregado.length
  };

  await (async () => {
    try {
      assert.deepEqual(provas.arquivoProibidoCarregado, []);
      assert.equal(provas.sqliteSomenteMemoria, true);
      assert.equal(provas.arquivosCriadosNoDiretorioTemporario, 0);
      // Os únicos bloqueios permitidos são os 3 + 2 controles negativos do cenário 0.
      assert.equal(provas.bloqueiosDeModulo, 3);
      assert.equal(provas.bloqueiosDeArquivoBanco, 2);
      passou += 1;
      console.log('  OK  prova de isolamento (nenhum banco em arquivo, nenhum entrypoint carregado)');
    } catch (error) {
      falhou += 1;
      console.error(`  FALHOU  prova de isolamento\n         ${error.stack || error.message}`);
    }
  })();

  console.log(`HARNESS_PROVAS ${JSON.stringify(provas)}`);
  console.log(`FIXTURE_SCORES ${JSON.stringify(fixtureScores)}`);
  console.log(`FIXTURES_CARREGADAS ${JSON.stringify(Object.keys(fixtures))}`);
  console.log(`HARNESS_RESUMO ${JSON.stringify(resumo)}`);
  console.log(`\nResultado: ${passou} passou, ${falhou} falhou`);
  if (falhou > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  });
