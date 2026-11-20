/**
 * Sprint 06 — Bloco D: worker, claim atômico, FAKE driver, reenvio controlado.
 * Sem Electron / impressão física / Bloco E.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-d-worker-falhas.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s06d-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
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
const FilaService = require('../../backend/services/cozinha/CozinhaImpressaoFilaService');
const WorkerService = require('../../backend/services/cozinha/CozinhaImpressaoWorkerService');
const {
  criarFakeDriver,
  FakeImpressaoDriver,
  RESULTADOS_DRIVER
} = require('../../backend/services/cozinha/cozinhaImpressaoDriver');
const {
  ESTADOS_FILA,
  montarIdempotencyKeyReenvio
} = require('../../backend/services/cozinha/cozinhaImpressaoContratos');

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
function openFile(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 15000', (e) => (e ? reject(e) : resolve(db)));
      });
    });
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function schemaErpMinimo(db) {
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave VARCHAR(100) UNIQUE NOT NULL,
      valor TEXT, tipo VARCHAR(50), descricao TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS mesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      numero INTEGER NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS mesa_atendimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      mesa_id INTEGER NOT NULL,
      estado TEXT NOT NULL,
      operador_abertura_id INTEGER NOT NULL DEFAULT 1,
      aberto_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo_operacional TEXT DEFAULT 'COMERCIAL',
      utiliza_ficha_tecnica INTEGER DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(50),
      data_pedido DATE NOT NULL DEFAULT '2026-01-01',
      total DECIMAL(10,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PEDIDO',
      empresa_id INTEGER,
      mesa_id INTEGER,
      mesa_atendimento_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario DECIMAL(10,2) NOT NULL DEFAULT 0,
      subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
      classificacao_operacional_snapshot TEXT,
      produto_nome_snapshot TEXT,
      observacao TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      insumo_id INTEGER NOT NULL,
      insumo_nome_snapshot TEXT NOT NULL,
      quantidade_snapshot REAL NOT NULL,
      unidade_snapshot TEXT NOT NULL,
      classificacao_comercial_snapshot TEXT NOT NULL,
      selecionado INTEGER NOT NULL,
      preco_adicional_snapshot REAL NOT NULL DEFAULT 0
    )
  `);
  const info = await garantirSchemaCozinha(db);
  assert.equal(info.operacional, true);
  assert.ok(COZINHA_SCHEMA_VERSION >= 4);
  assert.equal(isCozinhaOperacional(), true);
}

async function prepararBase(db) {
  const emp = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('33333333000133', 'Emp D', 'ED', 1)
  `);
  const empresaId = emp.lastID;
  const mesa = await run(db, `
    INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 12, 1)
  `, [empresaId]);
  const mesaId = mesa.lastID;
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
    VALUES (?, ?, 'OCUPADA', 1)
  `, [empresaId, mesaId]);
  const atendimentoId = at.lastID;
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
    VALUES (?, 'U-D', 1, 0)
  `, [empresaId]);
  const unidadeId = un.lastID;
  const prod = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, utiliza_ficha_tecnica)
    VALUES ('Pastel', 'COMERCIAL', 1)
  `);

  let n = 0;
  async function criarItem(numeroComanda, tipo = 'PASTEL', nome = 'Pastel D', qty = 1) {
    n += 1;
    const ped = await run(db, `
      INSERT INTO pedidos (
        codigo, data_pedido, total, status, empresa_id, mesa_id, mesa_atendimento_id
      ) VALUES (?, '2026-01-01', 10, 'PEDIDO', ?, ?, ?)
    `, [`PD-${empresaId}-${n}`, empresaId, mesaId, atendimentoId]);
    const item = await run(db, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal,
        classificacao_operacional_snapshot, produto_nome_snapshot, observacao
      ) VALUES (?, ?, ?, 9.90, 9.90, ?, ?, 'obs')
    `, [ped.lastID, prod.lastID, qty, tipo, nome]);
    const cmd = await run(db, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, ?, ?, ?, 1)
    `, [empresaId, atendimentoId, numeroComanda, `C${numeroComanda}`, ped.lastID]);
    return {
      pedidoId: ped.lastID,
      pedidoItemId: item.lastID,
      comandaId: cmd.lastID,
      tipo,
      qty
    };
  }

  return { empresaId, mesaId, atendimentoId, unidadeId, criarItem };
}

function entrada(ctx, itens, chave) {
  return {
    empresaId: ctx.empresaId,
    operadorId: 7,
    idempotencyKey: chave,
    unidade_id: ctx.unidadeId,
    mesa_id: ctx.mesaId,
    atendimento_id: ctx.atendimentoId,
    itens: itens.map((c) => ({
      pedido_id: c.pedidoId,
      pedido_item_id: c.pedidoItemId,
      comanda_id: c.comandaId,
      qty_solicitada: Number(c.qty || 1).toFixed(3)
    }))
  };
}

async function criarEstacao(db, ctx, codigo = 'PASTEL', flags = {}) {
  return EstacaoService.criarEstacao({
    db,
    empresaId: ctx.empresaId,
    unidadeId: ctx.unidadeId,
    codigo_estacao: codigo,
    device_name: `DEV-${codigo}`,
    largura_mm: 80,
    vias: flags.vias != null ? flags.vias : 1,
    modelo_individual: flags.modelo_individual != null ? flags.modelo_individual : 0,
    modelo_agrupado: flags.modelo_agrupado != null ? flags.modelo_agrupado : 1,
    ativo: 1
  });
}

async function despacharComJob(db, ctx, key = 'd-job', opts = {}) {
  if (opts.criarEstacao !== false) {
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
  }
  const numeroComanda = opts.numeroComanda != null ? opts.numeroComanda : 1;
  const item = await ctx.criarItem(numeroComanda, 'PASTEL', opts.nome || 'Pastel D');
  const out = await CozinhaDespacho.despacharLote(entrada(ctx, [item], key), { db });
  const jobs = await all(db, `
    SELECT * FROM cozinha_impressao_fila WHERE rodada_id = ?
  `, [out.rodada.id]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].estado, ESTADOS_FILA.PENDENTE);
  return { despacho: out, job: jobs[0], item };
}

async function despacharDoisJobsPendentes(db, ctx, prefix = 'd-duo') {
  const a = await despacharComJob(db, ctx, `${prefix}-a`, { numeroComanda: 1, nome: 'A' });
  const b = await despacharComJob(db, ctx, `${prefix}-b`, {
    criarEstacao: false,
    numeroComanda: 2,
    nome: 'B'
  });
  return [a.job, b.job];
}

describe('Sprint 06 Bloco D — worker / FAKE / falhas', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('1) worker processa job PENDENTE', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-1');
    const driver = criarFakeDriver({ modo: 'sucesso' });
    const out = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-1'
    }, { db, driver });
    assert.equal(out.processado, true);
    assert.equal(out.job.estado, ESTADOS_FILA.ACEITA_PELO_SPOOLER);
    assert.equal(out.impressao_fisica, false);
    assert.equal(driver.chamadas.length, 1);
    await close(db);
  });

  it('2) claim atômico: dois workers — só um reivindica', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-2');

    const a = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-A'
    }, { db });
    const b = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-B'
    }, { db });

    assert.equal(a.reivindicado, true);
    assert.equal(b.reivindicado, false);
    assert.equal(a.job.worker_id, 'w-A');
    assert.equal(a.job.estado, ESTADOS_FILA.PROCESSANDO);

    // Guarda atômica: UPDATE condicional com estado=PENDENTE não altera job já reivindicado.
    const guarda = await run(db, `
      UPDATE cozinha_impressao_fila
      SET worker_id = 'w-INTRUSO'
      WHERE id = ? AND estado = ?
    `, [a.job.id, ESTADOS_FILA.PENDENTE]);
    assert.equal(guarda.changes, 0);

    const row = await get(db, `SELECT worker_id, estado FROM cozinha_impressao_fila WHERE id=?`, [a.job.id]);
    assert.equal(row.worker_id, 'w-A');
    assert.equal(row.estado, ESTADOS_FILA.PROCESSANDO);
    assert.equal(
      (await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila WHERE estado=?`, [ESTADOS_FILA.PROCESSANDO])).n,
      1
    );
    await close(db);
  });

  it('3) sucesso → ACEITA_PELO_SPOOLER', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-3');
    const out = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-3'
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });
    assert.equal(out.resultado_driver, RESULTADOS_DRIVER.ACEITA);
    assert.equal(out.job.estado, ESTADOS_FILA.ACEITA_PELO_SPOOLER);
    assert.ok(out.job.spooler_job_token);
    await close(db);
  });

  it('4) falha conhecida → FALHA', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-4');
    const out = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-4'
    }, { db, driver: criarFakeDriver({ modo: 'falha', erro: 'spooler recusou' }) });
    assert.equal(out.job.estado, ESTADOS_FILA.FALHA);
    assert.match(String(out.job.ultimo_erro), /spooler recusou|falha/i);
    await close(db);
  });

  it('5) timeout → RESULTADO_INCERTO', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-5');
    const out = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-5'
    }, { db, driver: criarFakeDriver({ modo: 'timeout' }) });
    assert.equal(out.job.estado, ESTADOS_FILA.RESULTADO_INCERTO);
    assert.match(String(out.job.ultimo_erro), /timeout|indetermin/i);
    await close(db);
  });

  it('6) worker reiniciado NÃO reenvia automaticamente job incerto', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-6');
    await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-6a'
    }, { db, driver: criarFakeDriver({ modo: 'incerto' }) });

    const reinicio = await WorkerService.aoIniciarWorker({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, limiteMs: 0
    }, { db });
    assert.equal(reinicio.reenvio_automatico, false);

    const tick = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-6b'
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });
    assert.equal(tick.processado, false);

    const depois = await all(db, `SELECT * FROM cozinha_impressao_fila`);
    assert.equal(depois.length, 1);
    assert.equal(depois[0].estado, ESTADOS_FILA.RESULTADO_INCERTO);
    await close(db);
  });

  it('7) PROCESSANDO abandonado → RESULTADO_INCERTO (não volta a PENDENTE)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-7');
    const claim = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-dead'
    }, { db });
    assert.equal(claim.reivindicado, true);

    await run(db, `
      UPDATE cozinha_impressao_fila SET processando_em = ? WHERE id = ?
    `, ['2000-01-01T00:00:00.000Z', claim.job.id]);

    const rec = await WorkerService.recuperarJobsAbandonados({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, limiteMs: 1000
    }, { db });
    assert.equal(rec.recuperados, 1);
    assert.equal(rec.novo_estado, ESTADOS_FILA.RESULTADO_INCERTO);

    const job = await get(db, `SELECT estado FROM cozinha_impressao_fila WHERE id=?`, [claim.job.id]);
    assert.equal(job.estado, ESTADOS_FILA.RESULTADO_INCERTO);
    assert.notEqual(job.estado, ESTADOS_FILA.PENDENTE);
    await close(db);
  });

  it('8) reenvio de FALHA cria job filho', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'd-8');
    await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-8'
    }, { db, driver: criarFakeDriver({ modo: 'falha' }) });

    const re = await FilaService.reenviarJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, id: job.id
    }, { db });
    assert.equal(re.repetida, false);
    assert.equal(re.job.job_origem_id, job.id);
    assert.equal(re.job.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(re.job.idempotency_key, montarIdempotencyKeyReenvio(job.id, 1));
    assert.equal(re.job.payload_snapshot, re.job_origem.payload_snapshot);

    const origem = await get(db, `SELECT estado FROM cozinha_impressao_fila WHERE id=?`, [job.id]);
    assert.equal(origem.estado, ESTADOS_FILA.FALHA);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 2);
    await close(db);
  });

  it('9) reenvio de RESULTADO_INCERTO exige confirmação humana', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'd-9');
    await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-9'
    }, { db, driver: criarFakeDriver({ modo: 'incerto' }) });

    await assert.rejects(
      () => FilaService.reenviarJob({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, id: job.id
      }, { db }),
      (err) => err.codigo === 'IMPRESSAO_REENVIO_EXIGE_CONFIRMACAO_HUMANA'
    );

    const ok = await FilaService.reenviarJob({
      db,
      empresaId: ctx.empresaId,
      unidadeId: ctx.unidadeId,
      id: job.id,
      confirmacao_humana: true
    }, { db });
    assert.equal(ok.job.job_origem_id, job.id);
    assert.equal(ok.job.estado, ESTADOS_FILA.PENDENTE);
    await close(db);
  });

  it('10) reenvio de ACEITA_PELO_SPOOLER é bloqueado', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'd-10');
    await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-10'
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });

    await assert.rejects(
      () => FilaService.reenviarJob({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, id: job.id
      }, { db }),
      (err) => err.codigo === 'IMPRESSAO_REENVIO_BLOQUEADO_ACEITA'
    );
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 1);
    await close(db);
  });

  it('11) snapshot original permanece intacto após processamento e reenvio', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'd-11');
    const snapOriginal = job.payload_snapshot;

    await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-11'
    }, { db, driver: criarFakeDriver({ modo: 'falha' }) });

    const aposFalha = await get(db, `SELECT payload_snapshot FROM cozinha_impressao_fila WHERE id=?`, [job.id]);
    assert.equal(aposFalha.payload_snapshot, snapOriginal);

    const re = await FilaService.reenviarJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, id: job.id
    }, { db });
    assert.equal(re.job.payload_snapshot, snapOriginal);
    assert.equal(re.job_origem.payload_snapshot, snapOriginal);
    await close(db);
  });

  it('12) histórico de tentativas permanece preservado', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'd-12');
    await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-12'
    }, { db, driver: criarFakeDriver({ modo: 'falha' }) });

    const origem = await get(db, `SELECT tentativas, estado FROM cozinha_impressao_fila WHERE id=?`, [job.id]);
    assert.equal(origem.estado, ESTADOS_FILA.FALHA);
    assert.ok(origem.tentativas >= 1);

    const re = await FilaService.reenviarJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, id: job.id
    }, { db });
    assert.equal(re.job.tentativas, 0);

    const origemDepois = await get(db, `SELECT tentativas, estado FROM cozinha_impressao_fila WHERE id=?`, [job.id]);
    assert.equal(origemDepois.tentativas, origem.tentativas);
    assert.equal(origemDepois.estado, ESTADOS_FILA.FALHA);
    await close(db);
  });

  it('13) isolamento por empresa e unidade', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-13a');

    const emp2 = await run(db, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('44444444000144', 'Emp D2', 'ED2', 1)
    `);
    const uni2 = await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-D2', 1)
    `, [emp2.lastID]);

    const tick = await WorkerService.processarProximo({
      db, empresaId: emp2.lastID, unidadeId: uni2.lastID, workerId: 'w-other'
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });
    assert.equal(tick.processado, false);

    const jobCtx = await get(db, `
      SELECT estado, empresa_id, unidade_id FROM cozinha_impressao_fila
    `);
    assert.equal(jobCtx.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(jobCtx.empresa_id, ctx.empresaId);
    assert.equal(jobCtx.unidade_id, ctx.unidadeId);

    const ok = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-13'
    }, { db, driver: criarFakeDriver({ modo: 'sucesso' }) });
    assert.equal(ok.processado, true);
    await close(db);
  });

  it('14) falha de impressão não altera preparação nem bloqueia despacho', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { despacho } = await despacharComJob(db, ctx, 'd-14');
    assert.equal(despacho.success, true);
    assert.equal(despacho.rodada.estado_preparacao, 'AGUARDANDO');

    await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-14'
    }, { db, driver: criarFakeDriver({ modo: 'falha' }) });

    const item = await get(db, `
      SELECT estado_preparacao FROM cozinha_itens WHERE rodada_id=?
    `, [despacho.rodada.id]);
    assert.equal(item.estado_preparacao, 'AGUARDANDO');
    const rodada = await get(db, `
      SELECT estado_preparacao FROM cozinha_rodadas WHERE id=?
    `, [despacho.rodada.id]);
    assert.equal(rodada.estado_preparacao, 'AGUARDANDO');
    await close(db);
  });

  it('15) nenhum job é enviado duas vezes pelo worker', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharComJob(db, ctx, 'd-15');
    const driver = criarFakeDriver({ modo: 'sucesso' });

    const r1 = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-15a'
    }, { db, driver });
    assert.equal(r1.processado, true);

    const r2 = await WorkerService.processarProximo({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-15b'
    }, { db, driver });
    assert.equal(r2.processado, false);
    assert.equal(driver.chamadas.length, 1);

    const jobs = await all(db, `SELECT estado FROM cozinha_impressao_fila`);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].estado, ESTADOS_FILA.ACEITA_PELO_SPOOLER);
    await close(db);
  });

  it('16) Driver FAKE não utiliza impressora real', async () => {
    const driver = criarFakeDriver({ modo: 'sucesso' });
    assert.ok(driver instanceof FakeImpressaoDriver);
    assert.equal(driver.nome, 'FAKE');
    assert.equal(driver.impressaoFisica, false);

    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/services/cozinha/cozinhaImpressaoDriver.js'),
      'utf8'
    );
    assert.ok(!/require\(['"]electron['"]\)/.test(src));
    assert.ok(!/\.print\s*\(/.test(src));
    assert.ok(!/getPrinters|printers\.get/.test(src));

    const workerSrc = fs.readFileSync(
      path.join(__dirname, '../../backend/services/cozinha/CozinhaImpressaoWorkerService.js'),
      'utf8'
    );
    assert.ok(!/require\(['"]electron['"]\)/.test(workerSrc));
    assert.ok(!/\.print\s*\(/.test(workerSrc));

    const out = await driver.imprimir({ job: { id: 99, vias: 1 } });
    assert.equal(out.impressao_fisica, false);
    assert.equal(out.driver, 'FAKE');
    assert.equal(out.resultado, RESULTADOS_DRIVER.ACEITA);
  });

  it('17) mesmo worker: chamadas concorrentes recebem jobs distintos', async () => {
    const dbPath = path.join(dbDir, `claim-17-${Date.now()}.sqlite`);
    const db1 = await openFile(dbPath);
    await schemaErpMinimo(db1);
    const ctx = await prepararBase(db1);
    const jobsPendentes = await despacharDoisJobsPendentes(db1, ctx, 'd-17');
    assert.equal(jobsPendentes.length, 2);

    const db2 = await openFile(dbPath);
    const [c1, c2] = await Promise.all([
      WorkerService.reivindicarProximoJob({
        db: db1, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-same'
      }, { db: db1 }),
      WorkerService.reivindicarProximoJob({
        db: db2, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-same'
      }, { db: db2 })
    ]);

    assert.equal(c1.reivindicado, true);
    assert.equal(c2.reivindicado, true);
    assert.notEqual(c1.job.id, c2.job.id);
    assert.deepEqual(
      [c1.job.id, c2.job.id].sort((a, b) => a - b),
      jobsPendentes.map((j) => j.id).sort((a, b) => a - b)
    );

    const rows = await all(db1, `
      SELECT id, estado, worker_id FROM cozinha_impressao_fila ORDER BY id
    `);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.estado === ESTADOS_FILA.PROCESSANDO));
    assert.ok(rows.every((r) => r.worker_id === 'w-same'));

    // Cada chamada recebeu exatamente o id que ela reivindicou (sem cruzamento).
    const idsRetornados = new Set([c1.job.id, c2.job.id]);
    assert.equal(idsRetornados.size, 2);

    await close(db2);
    await close(db1);
  });

  it('18) concorrência entre workers: um job — só um reivindica', async () => {
    const dbPath = path.join(dbDir, `claim-18-${Date.now()}.sqlite`);
    const db1 = await openFile(dbPath);
    await schemaErpMinimo(db1);
    const ctx = await prepararBase(db1);
    await despacharComJob(db1, ctx, 'd-18');
    const db2 = await openFile(dbPath);

    const [a, b] = await Promise.all([
      WorkerService.reivindicarProximoJob({
        db: db1, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-A'
      }, { db: db1 }),
      WorkerService.reivindicarProximoJob({
        db: db2, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-B'
      }, { db: db2 })
    ]);

    const ganhos = [a, b].filter((x) => x.reivindicado);
    const perdas = [a, b].filter((x) => !x.reivindicado);
    assert.equal(ganhos.length, 1);
    assert.equal(perdas.length, 1);
    assert.equal(
      (await get(db1, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila WHERE estado=?`, [
        ESTADOS_FILA.PROCESSANDO
      ])).n,
      1
    );
    await close(db2);
    await close(db1);
  });

  it('19) processamento concorrente sem duplicidade no driver', async () => {
    const dbPath = path.join(dbDir, `claim-19-${Date.now()}.sqlite`);
    const db1 = await openFile(dbPath);
    await schemaErpMinimo(db1);
    const ctx = await prepararBase(db1);
    const jobsPendentes = await despacharDoisJobsPendentes(db1, ctx, 'd-19');
    const db2 = await openFile(dbPath);

    const vistos = [];
    const driver = criarFakeDriver({
      modo: 'sucesso',
      resolver: (contexto) => {
        vistos.push(contexto.job.id);
        return 'sucesso';
      }
    });

    const [p1, p2] = await Promise.all([
      WorkerService.processarProximo({
        db: db1, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-19a'
      }, { db: db1, driver }),
      WorkerService.processarProximo({
        db: db2, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-19b'
      }, { db: db2, driver })
    ]);

    assert.equal(p1.processado, true);
    assert.equal(p2.processado, true);
    assert.notEqual(p1.job.id, p2.job.id);
    assert.equal(vistos.length, 2);
    assert.equal(new Set(vistos).size, 2);
    assert.deepEqual(
      vistos.slice().sort((a, b) => a - b),
      jobsPendentes.map((j) => j.id).sort((a, b) => a - b)
    );

    const finais = await all(db1, `SELECT id, estado FROM cozinha_impressao_fila ORDER BY id`);
    assert.ok(finais.every((j) => j.estado === ESTADOS_FILA.ACEITA_PELO_SPOOLER));
    await close(db2);
    await close(db1);
  });

  it('20) resultado vinculado ao claim correto (ordem invertida)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await despacharDoisJobsPendentes(db, ctx, 'd-20');

    const c1 = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-20'
    }, { db });
    const c2 = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-20'
    }, { db });
    assert.equal(c1.reivindicado, true);
    assert.equal(c2.reivindicado, true);
    assert.notEqual(c1.job.id, c2.job.id);

    // Registra resultados em ordem invertida ao claim.
    await WorkerService.registrarResultado({
      db,
      empresaId: ctx.empresaId,
      unidadeId: ctx.unidadeId,
      jobId: c2.job.id,
      workerId: 'w-20',
      resultado: RESULTADOS_DRIVER.FALHA,
      erro: 'falha no segundo claim'
    }, { db });
    await WorkerService.registrarResultado({
      db,
      empresaId: ctx.empresaId,
      unidadeId: ctx.unidadeId,
      jobId: c1.job.id,
      workerId: 'w-20',
      resultado: RESULTADOS_DRIVER.ACEITA,
      spooler_job_token: 'tok-c1'
    }, { db });

    const j1 = await get(db, `SELECT estado, spooler_job_token, ultimo_erro FROM cozinha_impressao_fila WHERE id=?`, [c1.job.id]);
    const j2 = await get(db, `SELECT estado, spooler_job_token, ultimo_erro FROM cozinha_impressao_fila WHERE id=?`, [c2.job.id]);
    assert.equal(j1.estado, ESTADOS_FILA.ACEITA_PELO_SPOOLER);
    assert.equal(j1.spooler_job_token, 'tok-c1');
    assert.equal(j2.estado, ESTADOS_FILA.FALHA);
    assert.match(String(j2.ultimo_erro), /falha no segundo claim/);
    await close(db);
  });

  it('21) claim recusa aderir a transação externa da conexão', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const { job } = await despacharComJob(db, ctx, 'd-21');

    await run(db, 'BEGIN');
    let claimErro = null;
    try {
      await WorkerService.reivindicarProximoJob({
        db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-21'
      }, { db });
    } catch (err) {
      claimErro = err;
    }

    assert.ok(claimErro, 'claim deveria falhar com TX externa aberta');
    // Deve ser o erro encapsulado do worker — não o SQLITE_ERROR cru.
    assert.equal(claimErro.codigo, 'IMPRESSAO_CLAIM_TX_EXTERNA');
    assert.equal(claimErro.statusCode, 409);
    assert.match(String(claimErro.message), /BEGIN IMMEDIATE|transação externa/i);
    assert.ok(
      claimErro.detalhes && /within a transaction/i.test(String(claimErro.detalhes.causa || '')),
      'detalhes.causa deve preservar a mensagem SQLite original'
    );

    // Job permanece PENDENTE — claim não aderiu nem atualizou sob a TX externa.
    const antes = await get(db, `
      SELECT estado, worker_id FROM cozinha_impressao_fila WHERE id=?
    `, [job.id]);
    assert.equal(antes.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(antes.worker_id, null);

    // Marcador sob controle exclusivo do chamador (TX externa intacta).
    await run(db, `
      UPDATE cozinha_impressao_fila SET ultimo_erro = 'marcador-tx-externa' WHERE id = ?
    `, [job.id]);
    await run(db, 'ROLLBACK');

    const depois = await get(db, `
      SELECT estado, worker_id, ultimo_erro FROM cozinha_impressao_fila WHERE id=?
    `, [job.id]);
    assert.equal(depois.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(depois.worker_id, null);
    assert.equal(depois.ultimo_erro, null);

    // Após o chamador encerrar a TX externa, o claim independente funciona.
    const ok = await WorkerService.reivindicarProximoJob({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, workerId: 'w-21'
    }, { db });
    assert.equal(ok.reivindicado, true);
    assert.equal(ok.job.id, job.id);
    await close(db);
  });
});
