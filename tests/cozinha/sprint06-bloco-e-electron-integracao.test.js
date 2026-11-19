/**
 * Sprint 06 — Bloco E · 2ª rodada correção auditoria (E-01/E-02/E-03).
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-e-electron-integracao.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s06e2-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  COZINHA_SCHEMA_VERSION
} = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const EstacaoService = require('../../backend/services/cozinha/CozinhaImpressaoEstacaoService');
const WorkerService = require('../../backend/services/cozinha/CozinhaImpressaoWorkerService');
const { renderizarTexto } = require('../../backend/services/cozinha/CozinhaImpressaoRenderer');
const { criarFakeDriver, RESULTADOS_DRIVER } = require('../../backend/services/cozinha/cozinhaImpressaoDriver');
const {
  criarElectronDriver,
  criarAdapterElectronMock
} = require('../../backend/services/cozinha/cozinhaImpressaoElectronDriver');
const {
  criarDriverElectronProducao,
  criarDriverParaWorker,
  descreverIntegracaoProducao
} = require('../../backend/services/cozinha/CozinhaImpressaoElectronProducao');
const {
  criarWorkerImpressaoCozinha,
  instalarWorkerImpressaoCozinhaNoElectron,
  encerrarWorkerImpressaoCozinhaNoElectron,
  obterWorkerImpressaoCozinhaInstalado,
  contarInstalacoesWorkerImpressao,
  simularReadyToShowElectronInstalarWorker,
  _resetBootstrapWorkerImpressaoParaTeste
} = require('../../backend/services/cozinha/CozinhaImpressaoWorkerBootstrap');
const {
  criarIntegracaoCicloVidaCozinhaImpressao,
  anexarAoReadyToShowMainWindow,
  _resetIntegracaoCicloVidaParaTeste
} = require('../../backend/services/cozinha/CozinhaImpressaoElectronCicloVida');
const {
  _definirSessaoAutenticadaParaTeste,
  limparSessaoAutenticadaCozinha,
  validarContextoContraSessaoAutenticada,
  obterSessaoAutenticadaCozinha
} = require('../../backend/services/cozinha/cozinhaImpressaoSessaoElectron');
const { EventEmitter } = require('events');
const {
  IPC_CANAIS,
  isImpressaoFisicaAutorizada,
  validarRemetenteIpc,
  rejeitarImpressaoGenericaPorIpc,
  listarImpressorasCozinha,
  enviarParaSpoolerCozinha
} = require('../../backend/services/cozinha/cozinhaImpressaoElectronBridge');
const { ESTADOS_FILA } = require('../../backend/services/cozinha/cozinhaImpressaoContratos');

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
function open() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
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

async function schemaErpMinimo(db) {
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE IF NOT EXISTS configuracoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chave VARCHAR(100) UNIQUE NOT NULL,
    valor TEXT, tipo VARCHAR(50), descricao TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE IF NOT EXISTS mesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL,
    numero INTEGER NOT NULL, ativo INTEGER NOT NULL DEFAULT 1)`);
  await run(db, `CREATE TABLE IF NOT EXISTS mesa_atendimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, mesa_id INTEGER NOT NULL,
    estado TEXT NOT NULL, operador_abertura_id INTEGER NOT NULL DEFAULT 1,
    aberto_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL,
    tipo_operacional TEXT DEFAULT 'COMERCIAL', utiliza_ficha_tecnica INTEGER DEFAULT 0)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, codigo VARCHAR(50),
    data_pedido DATE NOT NULL DEFAULT '2026-01-01', total DECIMAL(10,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PEDIDO', empresa_id INTEGER, mesa_id INTEGER, mesa_atendimento_id INTEGER)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL,
    quantidade REAL NOT NULL, preco_unitario DECIMAL(10,2) NOT NULL DEFAULT 0,
    subtotal DECIMAL(10,2) NOT NULL DEFAULT 0, classificacao_operacional_snapshot TEXT,
    produto_nome_snapshot TEXT, observacao TEXT)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, pedido_item_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL, insumo_id INTEGER NOT NULL, insumo_nome_snapshot TEXT NOT NULL,
    quantidade_snapshot REAL NOT NULL, unidade_snapshot TEXT NOT NULL,
    classificacao_comercial_snapshot TEXT NOT NULL, selecionado INTEGER NOT NULL,
    preco_adicional_snapshot REAL NOT NULL DEFAULT 0)`);
  const info = await garantirSchemaCozinha(db);
  assert.equal(info.operacional, true);
  assert.equal(COZINHA_SCHEMA_VERSION, 4);
  assert.equal(isCozinhaOperacional(), true);
}

async function prepararBase(db, cnpj = '55555555000155') {
  const emp = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES (?, 'Emp E', 'EE', 1)`, [cnpj]);
  const empresaId = emp.lastID;
  const mesa = await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 21, 1)`, [empresaId]);
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
    VALUES (?, ?, 'OCUPADA', 1)`, [empresaId, mesa.lastID]);
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
    VALUES (?, 'U-E', 1, 0)`, [empresaId]);
  const prod = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, utiliza_ficha_tecnica) VALUES ('Pastel', 'COMERCIAL', 1)`);
  let n = 0;
  async function criarItem(numeroComanda, tipo = 'PASTEL', nome = 'Pastel E', qty = 1) {
    n += 1;
    const ped = await run(db, `
      INSERT INTO pedidos (codigo, data_pedido, total, status, empresa_id, mesa_id, mesa_atendimento_id)
      VALUES (?, '2026-01-01', 10, 'PEDIDO', ?, ?, ?)`, [`PE-${n}`, empresaId, mesa.lastID, at.lastID]);
    const item = await run(db, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal,
        classificacao_operacional_snapshot, produto_nome_snapshot, observacao
      ) VALUES (?, ?, ?, 9.90, 9.90, ?, ?, 'obs')`, [ped.lastID, prod.lastID, qty, tipo, nome]);
    const cmd = await run(db, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, ?, ?, ?, 1)`, [empresaId, at.lastID, numeroComanda, `C${numeroComanda}`, ped.lastID]);
    return { pedidoId: ped.lastID, pedidoItemId: item.lastID, comandaId: cmd.lastID, tipo, qty };
  }
  return { empresaId, mesaId: mesa.lastID, atendimentoId: at.lastID, unidadeId: un.lastID, criarItem };
}

function entrada(ctx, itens, chave) {
  return {
    empresaId: ctx.empresaId, operadorId: 7, idempotencyKey: chave,
    unidade_id: ctx.unidadeId, mesa_id: ctx.mesaId, atendimento_id: ctx.atendimentoId,
    itens: itens.map((c) => ({
      pedido_id: c.pedidoId, pedido_item_id: c.pedidoItemId, comanda_id: c.comandaId,
      qty_solicitada: Number(c.qty || 1).toFixed(3)
    }))
  };
}

async function despacharComJob(db, ctx, key, estacaoOpts = {}) {
  await EstacaoService.criarEstacao({
    db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, codigo_estacao: 'PASTEL',
    device_name: estacaoOpts.device_name != null ? estacaoOpts.device_name : 'Cozinha-Termica-80',
    largura_mm: estacaoOpts.largura_mm != null ? estacaoOpts.largura_mm : 80,
    vias: estacaoOpts.vias != null ? estacaoOpts.vias : 2,
    modelo_individual: 0, modelo_agrupado: 1, ativo: 1
  });
  const item = await ctx.criarItem(1, 'PASTEL', 'Pastel E');
  const out = await CozinhaDespacho.despacharLote(entrada(ctx, [item], key), { db });
  const jobs = await all(db, `SELECT * FROM cozinha_impressao_fila WHERE rodada_id=?`, [out.rodada.id]);
  assert.equal(jobs.length, 1);
  return { despacho: out, job: jobs[0] };
}

function adapterProducaoSpy(opts = {}) {
  const prints = [];
  return {
    tipo: 'electron-producao',
    prints,
    async getPrinters() {
      return opts.printers || [{ name: 'Cozinha-Termica-80', isDefault: true }];
    },
    async print(payload) {
      prints.push(payload);
      if (opts.modo === 'falha-comunicacao') throw new Error('IPC canal indisponível');
      if (opts.modo === 'hang') return new Promise(() => {});
      return { token: `prod:${prints.length}` };
    }
  };
}

describe('Sprint 06 Bloco E — 2ª rodada E-01/E-02/E-03', () => {
  beforeEach(() => {
    marcarCozinhaOperacional(false);
    delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;
    WorkerService._resetJobsImpressaoAtivosParaTeste();
    _resetIntegracaoCicloVidaParaTeste();
    _resetBootstrapWorkerImpressaoParaTeste();
    limparSessaoAutenticadaCozinha();
  });

  it('1) E-01: dry-run nunca ACEITA_PELO_SPOOLER e não consome tentativas em ciclos', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'e2-1');
    assert.equal(job.tentativas, 0);

    const adapter = criarAdapterElectronMock();
    const driver = criarElectronDriver({ adapter });
    assert.equal(driver.spoolerRealHabilitado, false);

    for (let i = 0; i < 5; i += 1) {
      const out = await WorkerService.processarProximo({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: `w-sim-${i}`
      }, { db, driver });
      assert.equal(out.simulado, true);
      assert.equal(out.processado, false);
      assert.equal(out.resultado_driver, RESULTADOS_DRIVER.SIMULADO);
      assert.notEqual(out.job.estado, ESTADOS_FILA.ACEITA_PELO_SPOOLER);
      assert.equal(out.job.estado, ESTADOS_FILA.PENDENTE);
      assert.equal(out.job.spooler_job_token, null);
      assert.equal(Number(out.tentativas), 0);
      assert.equal(adapter.prints.length, 0);
    }

    const final = await get(db, `SELECT estado, tentativas, max_tentativas, spooler_job_token FROM cozinha_impressao_fila WHERE id=?`, [job.id]);
    assert.equal(final.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(final.tentativas, 0);
    assert.ok(final.tentativas < final.max_tentativas);
    assert.equal(final.spooler_job_token, null);
    await close(db);
  });

  it('2) E-02: job inexistente não chama print', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const adapter = adapterProducaoSpy();
    let imprimirChamadas = 0;
    const driverSpy = criarFakeDriver({
      modo: 'sucesso',
      resolver: () => {
        imprimirChamadas += 1;
        adapter.prints.push({ via: 'driver' });
        return 'sucesso';
      }
    });
    await assert.rejects(
      () => WorkerService.processarJobReivindicado({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w',
        job: { id: 999999 }
      }, { db, driver: driverSpy }),
      (err) => err.codigo === 'IMPRESSAO_JOB_NAO_ENCONTRADO'
    );
    assert.equal(imprimirChamadas, 0);
    assert.equal(adapter.prints.length, 0);
    await close(db);
  });

  it('3) E-02: empresa/unidade/worker/estado divergentes bloqueiam print', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'e2-3');
    const claim = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-ok'
    }, { db });
    assert.equal(claim.reivindicado, true);

    const adapter = adapterProducaoSpy();
    let imprimirChamadas = 0;
    const fakePrint = criarFakeDriver({
      modo: 'sucesso',
      resolver: () => {
        imprimirChamadas += 1;
        adapter.prints.push({ via: 'driver' });
        return 'sucesso';
      }
    });

    await assert.rejects(
      () => WorkerService.processarJobReivindicado({
        db, empresaId: ctx.empresaId + 1, unidadeId: ctx.unidadeId, workerId: 'w-ok',
        job: { id: claim.job.id }
      }, { db, driver: fakePrint }),
      (err) => err.codigo === 'IMPRESSAO_JOB_EMPRESA_DIVERGENTE'
    );

    await assert.rejects(
      () => WorkerService.processarJobReivindicado({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId + 1, workerId: 'w-ok',
        job: { id: claim.job.id }
      }, { db, driver: fakePrint }),
      (err) => err.codigo === 'IMPRESSAO_JOB_UNIDADE_DIVERGENTE'
    );

    await assert.rejects(
      () => WorkerService.processarJobReivindicado({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-outro',
        job: { id: claim.job.id }
      }, { db, driver: fakePrint }),
      (err) => err.codigo === 'IMPRESSAO_WORKER_DIVERGENTE'
    );

    // Fora de PROCESSANDO
    await run(db, `UPDATE cozinha_impressao_fila SET estado='PENDENTE', worker_id=NULL WHERE id=?`, [job.id]);
    await assert.rejects(
      () => WorkerService.processarJobReivindicado({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-ok',
        job: { id: job.id }
      }, { db, driver: fakePrint }),
      (err) => err.codigo === 'IMPRESSAO_JOB_ESTADO_INVALIDO'
    );

    assert.equal(imprimirChamadas, 0);
    assert.equal(adapter.prints.length, 0);
    await close(db);
  });

  it('4) E-02: snapshot adulterado no argumento é ignorado; persistido preservado', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'e2-4');
    const snapOriginal = job.payload_snapshot;
    const claim = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-snap'
    }, { db });

    let snapshotVisto = null;
    const driver = criarFakeDriver({
      resolver: (ctxJob) => {
        snapshotVisto = ctxJob.job.payload_snapshot;
        return 'sucesso';
      }
    });

    await WorkerService.processarJobReivindicado({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-snap',
      job: {
        id: claim.job.id,
        payload_snapshot: JSON.stringify({ adulterado: true, empresa_id: 1, unidade_id: 1, rodada_id: 1, modelo: 'AGRUPADO', itens: [] })
      }
    }, { db, driver });

    assert.equal(snapshotVisto, snapOriginal);
    const depois = await get(db, `SELECT payload_snapshot, estado FROM cozinha_impressao_fila WHERE id=?`, [job.id]);
    assert.equal(depois.payload_snapshot, snapOriginal);
    assert.equal(depois.estado, ESTADOS_FILA.ACEITA_PELO_SPOOLER);
    await close(db);
  });

  it('5) E-03: bootstrap injeta ELECTRON e executa tick completo (físico off)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'e2-5');

    const adapter = adapterProducaoSpy();
    const worker = criarWorkerImpressaoCozinha({
      modo: 'ELECTRON',
      adapter,
      autorizarSpoolerReal: false,
      permitirAdapterCompat: true,
      empresaId: ctx.empresaId,
      unidadeId: ctx.unidadeId,
      workerId: 'bootstrap-e',
      db
    });

    assert.equal(worker.obterDriverInjetado().nome, 'ELECTRON');
    assert.equal(worker.obterDriverInjetado().isProducao, true);
    assert.equal(worker.meta.ok, true);
    assert.equal(worker.descrever().impressao_fisica_autorizada, false);

    const t1 = await worker.tick();
    assert.equal(t1.simulado, true);
    assert.equal(t1.resultado_driver, RESULTADOS_DRIVER.SIMULADO);
    assert.equal(adapter.prints.length, 0);

    const t2 = await worker.tick();
    assert.equal(t2.simulado, true);
    assert.equal(Number(t2.tentativas), 0);
    assert.equal(adapter.prints.length, 0);

    // FAKE isolado
    const fakeWorker = criarWorkerImpressaoCozinha({ modo: 'FAKE', db });
    assert.equal(fakeWorker.obterDriverInjetado().nome, 'FAKE');
    await close(db);
  });

  it('6) timeout → INCERTO sem reenvio automático', async () => {
    const out = await enviarParaSpoolerCozinha({
      deviceName: 'T', texto: 'x', vias: 1, job_id: 3, timeout_ms: 40
    }, {
      adapter: { async getPrinters() { return [{ name: 'T' }]; }, async print() { return new Promise(() => {}); } },
      origem: 'teste-mock',
      __testeForcarSpooler: true
    });
    assert.equal(out.resultado, RESULTADOS_DRIVER.INCERTO);

    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'e2-6');
    const claim = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-to'
    }, { db });
    await WorkerService.registrarResultado({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      jobId: claim.job.id, workerId: 'w-to',
      resultado: RESULTADOS_DRIVER.INCERTO, erro: 'timeout'
    }, { db });
    const tick = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-to2'
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });
    assert.equal(tick.processado, false);
    assert.equal((await get(db, `SELECT estado FROM cozinha_impressao_fila WHERE id=?`, [job.id])).estado, ESTADOS_FILA.RESULTADO_INCERTO);
    await close(db);
  });

  it('7) falha não altera preparação; listagem não imprime; vias/largura', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { despacho } = await despacharComJob(db, ctx, 'e2-7', { device_name: 'Inexistente' });
    const driver = criarElectronDriver({
      adapter: criarAdapterElectronMock({ printers: [{ name: 'Outra' }] })
    });
    const out = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-f'
    }, { db, driver });
    // simulação: device inexistente ainda é dry-run SIMULADO sem claim
    assert.equal(out.simulado, true);
    const item = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE rodada_id=?`, [despacho.rodada.id]);
    assert.equal(item.estado_preparacao, 'AGUARDANDO');

    const adapter = criarAdapterElectronMock({ printers: [{ name: 'A' }] });
    const lista = await listarImpressorasCozinha(adapter);
    assert.equal(lista.impressao_fisica, false);
    assert.equal(adapter.prints.length, 0);

    const r58 = renderizarTexto({
      empresa_id: 1, unidade_id: 1, rodada_id: 1, modelo: 'AGRUPADO', largura_mm: 58,
      mesa_numero: '1', itens: [{ descricao: 'X', qty: '1.000', tipo_item: 'PASTEL', ingredientes: [] }]
    }, { largura_mm: 58 });
    assert.equal(r58.colunas, 32);

    const viasOut = await enviarParaSpoolerCozinha({
      deviceName: 'Cozinha-Termica-80', texto: 'Z', vias: 3, job_id: 8
    }, { adapter: criarAdapterElectronMock(), origem: 'teste-mock', __testeForcarSpooler: true });
    assert.equal(viasOut.vias_enviadas, 3);
    await close(db);
  });

  it('8) falha de comunicação no spooler mock; snapshot imutável; sem duplicidade FAKE', async () => {
    const falha = await enviarParaSpoolerCozinha({
      deviceName: 'X', texto: 'ola', vias: 1, job_id: 9
    }, {
      adapter: {
        async getPrinters() { return [{ name: 'X' }]; },
        async print() { throw new Error('IPC canal indisponível'); }
      },
      origem: 'teste-mock',
      __testeForcarSpooler: true
    });
    assert.equal(falha.resultado, RESULTADOS_DRIVER.FALHA);

    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'e2-8');
    const snap = job.payload_snapshot;
    const r1 = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-dup1'
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });
    assert.equal(r1.processado, true);
    const r2 = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-dup2'
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });
    assert.equal(r2.processado, false);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 1);
    assert.equal((await get(db, `SELECT payload_snapshot FROM cozinha_impressao_fila WHERE id=?`, [job.id])).payload_snapshot, snap);
    await close(db);
  });

  it('9) IPC genérico/remetente bloqueados; isolamento comercial', () => {
    assert.throws(
      () => rejeitarImpressaoGenericaPorIpc({ deviceName: 'X', texto: 'x' }),
      (err) => err.codigo === 'IMPRESSAO_IPC_PRINT_BLOQUEADO'
    );
    assert.throws(
      () => validarRemetenteIpc({ sender: null }),
      (err) => err.codigo === 'IMPRESSAO_IPC_REMETENTE_INVALIDO'
    );
    assert.equal(isImpressaoFisicaAutorizada({ autorizarSpoolerReal: true }), false);
    assert.equal(IPC_CANAIS.IMPRIMIR, 'cozinha-impressao:imprimir');

    const ipcSrc = fs.readFileSync(path.join(__dirname, '../../electron-cozinha-impressao.js'), 'utf8');
    assert.ok(!/imprimir-danfe-silencioso|impressora_cupom/.test(ipcSrc));
    const bootSrc = fs.readFileSync(
      path.join(__dirname, '../../backend/services/cozinha/CozinhaImpressaoWorkerBootstrap.js'), 'utf8'
    );
    assert.ok(bootSrc.includes("criarDriverParaWorker"));
    assert.ok(bootSrc.includes('processarProximo'));
    const electronSrc = fs.readFileSync(path.join(__dirname, '../../electron.js'), 'utf8');
    assert.ok(electronSrc.includes('anexarAoReadyToShowMainWindow'));
    assert.ok(electronSrc.includes('CozinhaImpressaoElectronCicloVida'));
  });

  it('10) E-03 evidência: factory sozinha ≠ integração; tick usa driver injetado', async () => {
    const apenasFactory = criarDriverParaWorker('ELECTRON', {
      adapter: adapterProducaoSpy(),
      permitirAdapterCompat: true
    });
    assert.equal(apenasFactory.nome, 'ELECTRON');

    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'e2-10');
    const adapter = adapterProducaoSpy();
    const worker = criarWorkerImpressaoCozinha({
      modo: 'ELECTRON',
      adapter,
      permitirAdapterCompat: true,
      db,
      empresaId: ctx.empresaId,
      unidadeId: ctx.unidadeId
    });
    assert.strictEqual(worker.obterDriverInjetado(), worker.driver);
    const meta = descreverIntegracaoProducao(worker.obterDriverInjetado());
    assert.equal(meta.ok, true);
    const tick = await worker.tick({ db });
    assert.equal(tick.simulado, true);
    assert.equal(adapter.prints.length, 0);
    await close(db);
  });

  it('11) E-01: tick simulação não altera job antigo em PROCESSANDO', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'e2-11-pend');
    // Job antigo PROCESSANDO (seria recuperado se a simulação chamasse recuperarJobsAbandonados).
    const claim = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-old'
    }, { db });
    assert.equal(claim.reivindicado, true);
    assert.equal(Number(claim.job.id), Number(job.id));
    const antigoIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await run(db, `
      UPDATE cozinha_impressao_fila
      SET processando_em = ?, updated_at = ?, tentativas = 2, ultimo_erro = 'hold'
      WHERE id = ?
    `, [antigoIso, antigoIso, claim.job.id]);

    const antes = await get(db, `
      SELECT id, estado, tentativas, worker_id, spooler_job_token, processando_em,
             ultimo_erro, payload_snapshot, updated_at
      FROM cozinha_impressao_fila WHERE id = ?
    `, [claim.job.id]);
    assert.equal(antes.estado, ESTADOS_FILA.PROCESSANDO);

    // Job PENDENTE separado para o dry-run observar.
    const item2 = await ctx.criarItem(2, 'PASTEL', 'Pastel E2');
    const out2 = await CozinhaDespacho.despacharLote(entrada(ctx, [item2], 'e2-11-b'), { db });
    const pendJobs = await all(db, `SELECT * FROM cozinha_impressao_fila WHERE rodada_id=?`, [out2.rodada.id]);
    assert.equal(pendJobs.length, 1);
    assert.equal(pendJobs[0].estado, ESTADOS_FILA.PENDENTE);

    const driver = criarElectronDriver({ adapter: criarAdapterElectronMock() });
    const tick = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-sim',
      limiteMs: 0
    }, { db, driver });
    assert.equal(tick.simulado, true);
    assert.equal(tick.recuperacao && tick.recuperacao.omitida, true);
    assert.equal(tick.recuperacao.recuperados, 0);

    const depois = await get(db, `
      SELECT id, estado, tentativas, worker_id, spooler_job_token, processando_em,
             ultimo_erro, payload_snapshot, updated_at
      FROM cozinha_impressao_fila WHERE id = ?
    `, [claim.job.id]);
    assert.deepEqual(depois, antes);
    assert.equal(depois.estado, ESTADOS_FILA.PROCESSANDO);
    assert.equal(depois.tentativas, 2);
    assert.equal(depois.worker_id, 'w-old');
    assert.equal(depois.spooler_job_token, null);
    await close(db);
  });

  it('12) E-02: propriedade perdida não chama driver; recuperação não invalida durante print', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'e2-12a');
    const claim = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-prop'
    }, { db });
    assert.equal(claim.reivindicado, true);

    let imprimirChamadas = 0;
    const driverSpy = criarFakeDriver({
      resolver: () => {
        imprimirChamadas += 1;
        return 'sucesso';
      }
    });

    // Janela validação → confirmação: invalida propriedade antes do driver.
    await assert.rejects(
      () => WorkerService.processarJobReivindicado({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-prop',
        job: { id: claim.job.id }
      }, {
        db,
        driver: driverSpy,
        async __aposValidacaoCanonico() {
          await run(db, `
            UPDATE cozinha_impressao_fila
            SET estado = ?, worker_id = 'outro', updated_at = ?
            WHERE id = ?
          `, [ESTADOS_FILA.RESULTADO_INCERTO, new Date().toISOString(), claim.job.id]);
        }
      }),
      (err) => err.codigo === 'IMPRESSAO_PROPRIEDADE_PERDIDA'
    );
    assert.equal(imprimirChamadas, 0);

    // Novo job: durante driver, recuperação lim=0 NÃO invalida propriedade ativa.
    const itemB = await ctx.criarItem(3, 'PASTEL', 'Pastel Conc');
    const despB = await CozinhaDespacho.despacharLote(entrada(ctx, [itemB], 'e2-12b'), { db });
    const jobB = (await all(db, `SELECT * FROM cozinha_impressao_fila WHERE rodada_id=?`, [despB.rodada.id]))[0];
    const claimB = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-conc'
    }, { db });
    assert.equal(claimB.reivindicado, true);
    assert.equal(Number(claimB.job.id), Number(jobB.id));

    let releaseDriver;
    const hold = new Promise((resolve) => { releaseDriver = resolve; });
    let durantePrintEstado = null;
    let recuperadosDurante = null;

    const driverHold = criarFakeDriver({
      resolver: async () => {
        assert.equal(
          WorkerService.jobImpressaoEstaAtivo(ctx.empresaId, ctx.unidadeId, claimB.job.id),
          true
        );
        recuperadosDurante = await WorkerService.recuperarJobsAbandonados({
          db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, limiteMs: 0
        }, { db });
        durantePrintEstado = await get(db, `
          SELECT estado, worker_id FROM cozinha_impressao_fila WHERE id = ?
        `, [claimB.job.id]);
        await hold;
        return 'sucesso';
      }
    });

    const procPromise = WorkerService.processarJobReivindicado({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-conc',
      job: { id: claimB.job.id }
    }, { db, driver: driverHold });

    // Aguarda o driver entrar no hold (poll curto).
    for (let i = 0; i < 50 && recuperadosDurante == null; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(recuperadosDurante, 'driver deveria ter iniciado');
    assert.equal(recuperadosDurante.recuperados, 0);
    assert.ok(!(recuperadosDurante.job_ids || []).includes(claimB.job.id));
    assert.equal(durantePrintEstado.estado, ESTADOS_FILA.PROCESSANDO);
    assert.equal(durantePrintEstado.worker_id, 'w-conc');

    releaseDriver();
    const out = await procPromise;
    assert.equal(out.resultado_driver, RESULTADOS_DRIVER.ACEITA);
    assert.equal(out.job.estado, ESTADOS_FILA.ACEITA_PELO_SPOOLER);
    assert.equal(WorkerService.jobImpressaoEstaAtivo(ctx.empresaId, ctx.unidadeId, claimB.job.id), false);

    // Job A permanece INCERTO (não reimpresso).
    const jobA = await get(db, `SELECT estado FROM cozinha_impressao_fila WHERE id=?`, [job.id]);
    assert.equal(jobA.estado, ESTADOS_FILA.RESULTADO_INCERTO);
    await close(db);
  });

  it('13) E-02: UPDATE recuperação condicional à versão — corrida A→B→C e inversa', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);

    // --- Ordem A→B→C: leitura antiga perde para renovação do worker ---
    const { job: jobRace } = await despacharComJob(db, ctx, 'e2-13a');
    const claim = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-race'
    }, { db });
    assert.equal(claim.reivindicado, true);
    assert.equal(Number(claim.job.id), Number(jobRace.id));

    const antigoIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await run(db, `
      UPDATE cozinha_impressao_fila
      SET processando_em = ?, updated_at = ?
      WHERE id = ?
    `, [antigoIso, antigoIso, claim.job.id]);

    let renovouEntreSelectUpdate = false;
    const recStale = await WorkerService.recuperarJobsAbandonados({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, limiteMs: 0
    }, {
      db,
      async __aposLeituraAbandonados({ rows }) {
        const alvo = rows.find((r) => Number(r.id) === Number(claim.job.id));
        assert.ok(alvo, 'SELECT deveria ter visto o job abandonado');
        assert.equal(alvo.processando_em, antigoIso);
        assert.equal(alvo.worker_id, 'w-race');
        // B: worker renova processando_em / confirma propriedade.
        // libera Set para provar que o UPDATE condicional (não só a memória) bloqueia.
        const posse = await WorkerService.confirmarPropriedadeAntesDeImprimir(db, {
          jobId: claim.job.id,
          empresaId: ctx.empresaId,
          unidadeId: ctx.unidadeId,
          workerId: 'w-race'
        });
        posse.liberar();
        renovouEntreSelectUpdate = true;
      }
    });

    assert.equal(renovouEntreSelectUpdate, true);
    assert.equal(recStale.recuperados, 0);
    assert.ok((recStale.ignorados_versao || []).map(Number).includes(Number(claim.job.id)));
    assert.ok(!(recStale.job_ids || []).map(Number).includes(Number(claim.job.id)));

    const aposCorrida = await get(db, `
      SELECT estado, worker_id, processando_em FROM cozinha_impressao_fila WHERE id = ?
    `, [claim.job.id]);
    assert.equal(aposCorrida.estado, ESTADOS_FILA.PROCESSANDO);
    assert.equal(aposCorrida.worker_id, 'w-race');
    assert.notEqual(aposCorrida.processando_em, antigoIso);

    // Driver conclui normalmente após a corrida.
    const outOk = await WorkerService.processarJobReivindicado({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-race',
      job: { id: claim.job.id }
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });
    assert.equal(outOk.resultado_driver, RESULTADOS_DRIVER.ACEITA);
    assert.equal(outOk.job.estado, ESTADOS_FILA.ACEITA_PELO_SPOOLER);

    // --- Ordem inversa: recuperação vence; worker não confirma nem imprime ---
    const itemB = await ctx.criarItem(4, 'PASTEL', 'Pastel Inv');
    const despB = await CozinhaDespacho.despacharLote(entrada(ctx, [itemB], 'e2-13b'), { db });
    const jobB = (await all(db, `SELECT * FROM cozinha_impressao_fila WHERE rodada_id=?`, [despB.rodada.id]))[0];
    const claimB = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-lose'
    }, { db });
    assert.equal(Number(claimB.job.id), Number(jobB.id));

    const antigoB = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await run(db, `
      UPDATE cozinha_impressao_fila SET processando_em = ?, updated_at = ? WHERE id = ?
    `, [antigoB, antigoB, claimB.job.id]);

    const recWin = await WorkerService.recuperarJobsAbandonados({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, limiteMs: 0
    }, { db });
    assert.equal(recWin.recuperados, 1);
    assert.ok(recWin.job_ids.map(Number).includes(Number(claimB.job.id)));

    const aposRec = await get(db, `SELECT estado, worker_id FROM cozinha_impressao_fila WHERE id=?`, [claimB.job.id]);
    assert.equal(aposRec.estado, ESTADOS_FILA.RESULTADO_INCERTO);

    let imprimirChamadas = 0;
    await assert.rejects(
      () => WorkerService.processarJobReivindicado({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-lose',
        job: { id: claimB.job.id }
      }, {
        db,
        driver: criarFakeDriver({
          resolver: () => {
            imprimirChamadas += 1;
            return 'sucesso';
          }
        })
      }),
      (err) => err.codigo === 'IMPRESSAO_JOB_ESTADO_INVALIDO'
        || err.codigo === 'IMPRESSAO_PROPRIEDADE_PERDIDA'
    );
    assert.equal(imprimirChamadas, 0);

    await assert.rejects(
      () => WorkerService.confirmarPropriedadeAntesDeImprimir(db, {
        jobId: claimB.job.id,
        empresaId: ctx.empresaId,
        unidadeId: ctx.unidadeId,
        workerId: 'w-lose'
      }),
      (err) => err.codigo === 'IMPRESSAO_PROPRIEDADE_PERDIDA'
    );

    await close(db);
  });

  it('14) E-03: instalador real Electron → worker único → tick ELECTRON → encerramento', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'e2-14');

    const adapter = adapterProducaoSpy();
    let instaladorChamadas = 0;

    // Electron mockado: evento ready-to-show dispara o instalador REAL (não criarWorker direto).
    function onReadyToShowElectron() {
      instaladorChamadas += 1;
      return simularReadyToShowElectronInstalarWorker({
        modo: 'ELECTRON',
        adapter,
        permitirAdapterCompat: true,
        autorizarSpoolerReal: false,
        db,
        empresaId: ctx.empresaId,
        unidadeId: ctx.unidadeId,
        workerId: 'electron-cozinha-worker',
        obterWebContents: () => ({
          isDestroyed: () => false,
          getPrintersAsync: async () => [{ name: 'Cozinha-Termica-80', isDefault: true }],
          print: () => {
            throw new Error('print físico não deve ser chamado no teste E-03');
          }
        })
      });
    }

    assert.equal(contarInstalacoesWorkerImpressao(), 0);
    assert.equal(obterWorkerImpressaoCozinhaInstalado(), null);

    // Fluxo: evento init → instalador → worker → tick → driver ELECTRON
    const worker1 = onReadyToShowElectron();
    assert.equal(instaladorChamadas, 1);
    assert.equal(contarInstalacoesWorkerImpressao(), 1);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), worker1);
    assert.equal(typeof instalarWorkerImpressaoCozinhaNoElectron, 'function');
    assert.ok(worker1.estaAtivo());

    const driver = worker1.obterDriverInjetado();
    assert.equal(driver.nome, 'ELECTRON');
    assert.equal(driver.isProducao, true);
    assert.strictEqual(worker1.driver, driver);
    assert.equal(worker1.modo, 'ELECTRON');

    const ctxW = worker1.obterContexto();
    assert.equal(ctxW.empresaId, ctx.empresaId);
    assert.equal(ctxW.unidadeId, ctx.unidadeId);
    assert.equal(ctxW.tem_db, true);

    const tick1 = await worker1.tick();
    assert.equal(tick1.simulado, true);
    assert.equal(tick1.resultado_driver, RESULTADOS_DRIVER.SIMULADO);
    assert.equal(adapter.prints.length, 0);

    // Segunda inicialização NÃO cria outro worker.
    const worker2 = onReadyToShowElectron();
    assert.equal(instaladorChamadas, 2);
    assert.equal(contarInstalacoesWorkerImpressao(), 1);
    assert.strictEqual(worker2, worker1);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), worker1);

    // FAKE isolado: fábrica FAKE ≠ instância ELECTRON instalada.
    const fake = criarWorkerImpressaoCozinha({ modo: 'FAKE', db });
    assert.equal(fake.obterDriverInjetado().nome, 'FAKE');
    assert.notEqual(fake.obterDriverInjetado(), driver);

    // Evidência wiring Electron nos fontes (ciclo de vida único).
    const electronSrc = fs.readFileSync(path.join(__dirname, '../../electron.js'), 'utf8');
    assert.ok(electronSrc.includes('anexarAoReadyToShowMainWindow'));
    assert.ok(electronSrc.includes('CozinhaImpressaoElectronCicloVida'));
    assert.ok(electronSrc.includes('aoWillQuit'));
    assert.ok(electronSrc.includes('will-quit'));
    const commonSrc = fs.readFileSync(path.join(__dirname, '../../electron-common.js'), 'utf8');
    assert.ok(commonSrc.includes('anexarAoReadyToShowMainWindow'));
    assert.ok(commonSrc.includes('aoWillQuit'));
    const ipcSrc = fs.readFileSync(path.join(__dirname, '../../electron-cozinha-impressao.js'), 'utf8');
    assert.ok(ipcSrc.includes('registrarCozinhaImpressaoHandlers'));
    assert.ok(ipcSrc.includes('cozinha-impressao:contexto-operacional'));

    // Encerramento impede novos ticks e limpa singleton.
    const fim = encerrarWorkerImpressaoCozinhaNoElectron();
    assert.equal(fim.encerrado, true);
    assert.equal(obterWorkerImpressaoCozinhaInstalado(), null);
    assert.equal(worker1.estaAtivo(), false);
    await assert.rejects(
      () => worker1.tick({ db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId }),
      (err) => err.codigo === 'IMPRESSAO_WORKER_ENCERRADO'
    );
    assert.equal(adapter.prints.length, 0);

    await close(db);
  });

  it('15) E-03: listener real ready-to-show + agendador + will-quit (ciclo operacional)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'e2-15');

    // Entry point real do app (package.json "main": electron.js) DEVE usar o anexador.
    const electronSrc = fs.readFileSync(path.join(__dirname, '../../electron.js'), 'utf8');
    assert.ok(electronSrc.includes('CozinhaImpressaoElectronCicloVida'));
    assert.ok(electronSrc.includes('anexarAoReadyToShowMainWindow'));
    assert.ok(electronSrc.includes('aoWillQuit'));
    assert.ok(!/instalarWorkerImpressaoCozinhaNoElectron\s*\(/.test(electronSrc),
      'electron.js não deve chamar o instalador fora do ciclo de vida');
    const commonSrc = fs.readFileSync(path.join(__dirname, '../../electron-common.js'), 'utf8');
    assert.ok(commonSrc.includes('anexarAoReadyToShowMainWindow'));

    class MockWindow extends EventEmitter {
      constructor() {
        super();
        this._destroyed = false;
        this.shown = false;
        this.focused = false;
        this.webContents = {
          isDestroyed: () => false,
          getPrintersAsync: async () => [{ name: 'Cozinha-Termica-80', isDefault: true }],
          print: () => { throw new Error('print físico proibido no teste 15'); }
        };
      }
      isDestroyed() { return this._destroyed; }
      show() { this.shown = true; }
      focus() { this.focused = true; }
    }

    const win = new MockWindow();
    const adapter = adapterProducaoSpy();
    const integracao = criarIntegracaoCicloVidaCozinhaImpressao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 40,
      workerId: 'electron-cozinha-worker'
    });

    // Listener REAL (mesma função usada por electron.js) — não chama instalador direto.
    anexarAoReadyToShowMainWindow(win, integracao);
    assert.equal(obterWorkerImpressaoCozinhaInstalado(), null);
    assert.equal(integracao.descrever().agendador_ativo, false);

    // 1) Evento real de inicialização
    win.emit('ready-to-show');
    assert.equal(win.shown, true);
    assert.ok(obterWorkerImpressaoCozinhaInstalado());
    assert.equal(contarInstalacoesWorkerImpressao(), 1);
    assert.equal(integracao.descrever().agendador_ativo, false, 'sem contexto ainda');

    const driver = obterWorkerImpressaoCozinhaInstalado().obterDriverInjetado();
    assert.equal(driver.nome, 'ELECTRON');
    assert.equal(driver.isProducao, true);

    // 5) Segunda inicialização (idempotente) — sem segundo worker/agendador
    integracao.aoReadyToShow();
    assert.equal(contarInstalacoesWorkerImpressao(), 1);
    assert.equal(integracao._estadoInterno().temTimerTick, false);

    // 2) Sessão autenticada no main + contexto (não inventado pelo instalador)
    _definirSessaoAutenticadaParaTeste({
      empresaId: ctx.empresaId,
      unidadeId: ctx.unidadeId,
      usuarioId: 1
    });
    const nctx = await integracao.notificarContextoOperacional({
      empresa_id: ctx.empresaId,
      unidade_cozinha_id: ctx.unidadeId
    });
    assert.equal(nctx.ok, true);
    assert.equal(nctx.agendador_ativo, true);
    assert.equal(integracao._estadoInterno().temTimerTick, true);

    const ctxW = obterWorkerImpressaoCozinhaInstalado().obterContexto();
    assert.equal(ctxW.empresaId, ctx.empresaId);
    assert.equal(ctxW.unidadeId, ctx.unidadeId);
    assert.equal(ctxW.tem_db, true);

    // 3) Agendador executa tick
    for (let i = 0; i < 40 && integracao.descrever().ticks_executados < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(integracao.descrever().ticks_executados >= 1, 'agendador deveria ter executado tick');
    assert.equal(adapter.prints.length, 0);

    // Job permanece PENDENTE (simulação não consome / não marca impresso)
    const jobRow = await get(db, `SELECT estado, tentativas, spooler_job_token FROM cozinha_impressao_fila LIMIT 1`);
    assert.equal(jobRow.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(jobRow.tentativas, 0);
    assert.equal(jobRow.spooler_job_token, null);

    // 7) Erro no tick não derruba o “app”
    const worker = obterWorkerImpressaoCozinhaInstalado();
    const tickOrig = worker.tick.bind(worker);
    worker.tick = async () => { throw new Error('boom-teste-tick'); };
    const rErr = await integracao.executarTickSeguro();
    assert.equal(rErr.ok, false);
    assert.match(integracao.descrever().ultimo_erro_tick, /boom-teste-tick/);
    assert.equal(integracao.descrever().agendador_ativo, true);
    worker.tick = tickOrig;

    // 6) Encerramento will-quit
    const fim = integracao.aoWillQuit();
    assert.equal(fim.encerrado, true);
    assert.equal(integracao.descrever().agendador_ativo, false);
    assert.equal(integracao._estadoInterno().temTimerTick, false);
    assert.equal(obterWorkerImpressaoCozinhaInstalado(), null);
    await assert.rejects(
      () => tickOrig({ db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId }),
      (err) => err.codigo === 'IMPRESSAO_WORKER_ENCERRADO'
    );
    assert.equal(adapter.prints.length, 0);

    await close(db);
  });

  it('16) E-03: troca segura de contexto + IPC rejeita IDs divergentes da sessão', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctxA = await prepararBase(db, '11111111000111');
    const ctxB = await prepararBase(db, '22222222000122');
    await despacharComJob(db, ctxA, 'e2-16a');
    await despacharComJob(db, ctxB, 'e2-16b');

    class MockWindow extends EventEmitter {
      constructor() {
        super();
        this._destroyed = false;
        this.webContents = {
          isDestroyed: () => false,
          getPrintersAsync: async () => [{ name: 'Cozinha-Termica-80', isDefault: true }],
          print: () => { throw new Error('print físico proibido no teste 16'); }
        };
      }
      isDestroyed() { return this._destroyed; }
      show() {}
      focus() {}
    }
    const win = new MockWindow();
    const adapter = adapterProducaoSpy();
    const integracao = criarIntegracaoCicloVidaCozinhaImpressao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 10000,
      workerId: 'electron-cozinha-worker'
    });

    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');
    assert.equal(contarInstalacoesWorkerImpressao(), 1);

    // 1) Sessão + Worker em A/A
    _definirSessaoAutenticadaParaTeste({
      empresaId: ctxA.empresaId,
      unidadeId: ctxA.unidadeId,
      usuarioId: 7
    });
    const nA = await integracao.notificarContextoOperacional({
      empresa_id: ctxA.empresaId,
      unidade_id: ctxA.unidadeId
    });
    assert.equal(nA.ok, true);
    assert.equal(nA.agendador_ativo, true);
    assert.equal(integracao.descrever().contexto.empresaId, ctxA.empresaId);
    assert.equal(integracao.descrever().contexto.unidadeId, ctxA.unidadeId);

    // Tick inicial sob A (imediato do agendador)
    for (let i = 0; i < 40 && integracao.descrever().ticks_executados < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(integracao.descrever().ticks_executados >= 1);

    const instalacoesAntes = contarInstalacoesWorkerImpressao();
    const workerRef = obterWorkerImpressaoCozinhaInstalado();

    // 8) Troca durante tick em andamento
    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    const tickOrig = workerRef.tick.bind(workerRef);
    let contextoVistoNoTickAposTroca = null;
    workerRef.tick = async (entrada) => {
      // Simula tick longo sob contexto A
      await hold;
      contextoVistoNoTickAposTroca = {
        empresaId: entrada.empresaId,
        unidadeId: entrada.unidadeId
      };
      return tickOrig(entrada);
    };

    const tickPromise = integracao.executarTickSeguro();
    // Aguarda o tick marcar em curso
    for (let i = 0; i < 30 && !integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(integracao._estadoInterno().tickEmCurso, true);

    // Sessão passa a B/B; notificar deve aguardar o tick atual
    _definirSessaoAutenticadaParaTeste({
      empresaId: ctxB.empresaId,
      unidadeId: ctxB.unidadeId,
      usuarioId: 7
    });
    const trocaPromise = integracao.notificarContextoOperacional({
      empresa_id: ctxB.empresaId,
      unidade_id: ctxB.unidadeId
    });

    // Enquanto espera, contexto aplicado ainda é A (troca não aplicada)
    assert.equal(integracao.descrever().contexto.empresaId, ctxA.empresaId);

    releaseHold();
    const tickOut = await tickPromise;
    const trocaOut = await trocaPromise;

    assert.equal(trocaOut.ok, true);
    assert.equal(trocaOut.trocou, true);
    assert.equal(trocaOut.empresaId, ctxB.empresaId);
    assert.equal(trocaOut.unidadeId, ctxB.unidadeId);
    // 3) Um Worker / um agendador
    assert.equal(contarInstalacoesWorkerImpressao(), instalacoesAntes);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);
    assert.equal(integracao._estadoInterno().temTimerTick, true);
    assert.equal(trocaOut.tem_timer_unico, true);

    // Tick que estava em curso usou snapshot A
    assert.equal(contextoVistoNoTickAposTroca.empresaId, ctxA.empresaId);
    assert.equal(contextoVistoNoTickAposTroca.unidadeId, ctxA.unidadeId);
    assert.equal(tickOut.contexto_obsoleto === true || tickOut.ok === true, true);

    // 4/5) Próximo tick usa exclusivamente B/B
    workerRef.tick = tickOrig;
    const tickB = await integracao.executarTickSeguro();
    assert.equal(tickB.ok, true);
    assert.equal(tickB.contexto.empresaId, ctxB.empresaId);
    assert.equal(tickB.contexto.unidadeId, ctxB.unidadeId);
    assert.equal(obterWorkerImpressaoCozinhaInstalado().obterContexto().empresaId, ctxB.empresaId);
    assert.equal(obterWorkerImpressaoCozinhaInstalado().obterContexto().unidadeId, ctxB.unidadeId);

    // 6) IPC: IDs diferentes da sessão autenticada → rejeição
    assert.throws(
      () => validarContextoContraSessaoAutenticada(
        { empresa_id: ctxA.empresaId, unidade_id: ctxA.unidadeId },
        obterSessaoAutenticadaCozinha()
      ),
      (err) => err.codigo === 'IMPRESSAO_CONTEXTO_DIVERGENTE_SESSAO'
    );
    const rejeitado = await integracao.notificarContextoOperacional({
      empresa_id: ctxA.empresaId,
      unidade_id: ctxA.unidadeId
    });
    assert.equal(rejeitado.ok, false);
    assert.equal(rejeitado.codigo, 'IMPRESSAO_CONTEXTO_DIVERGENTE_SESSAO');
    // Contexto permanece B
    assert.equal(integracao.descrever().contexto.empresaId, ctxB.empresaId);

    // 7) Contexto válido (igual à sessão) aceito
    const okB = await integracao.notificarContextoOperacional({
      empresa_id: ctxB.empresaId,
      unidade_id: ctxB.unidadeId
    });
    assert.equal(okB.ok, true);
    assert.equal(okB.trocou, false);

    // 9) Encerramento + físico off
    assert.equal(adapter.prints.length, 0);
    const fim = integracao.aoWillQuit();
    assert.equal(fim.encerrado, true);
    assert.equal(integracao.descrever().agendador_ativo, false);
    assert.equal(obterWorkerImpressaoCozinhaInstalado(), null);
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    assert.equal(adapter.prints.length, 0);

    await close(db);
  });
});
