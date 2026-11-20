/**
 * Sprint 06 — Bloco E · E-03 auditoria complementar
 * IPC real (handler invocado) + JWT real (estabelecerSessaoApartirDoToken) + chave + ciclo de vida.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-e-e03-auditoria-complementar.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');

const JWT_TEST_SECRET = 'cds-test-jwt-secret-e03-complementar-explicit';
process.env.JWT_SECRET = JWT_TEST_SECRET;
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s06e03c-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;
delete process.env.CDS_ALLOW_OFFICIAL_DB;
if (process.env.NODE_ENV === 'production') {
  process.env.NODE_ENV = 'test';
}

/** Mock Electron antes de carregar electron-cozinha-impressao.js */
const electronMock = {
  BrowserWindow: {
    fromWebContents(sender) {
      if (!sender || sender.__unauthorized === true) return null;
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return null;
      return sender.__win || { id: 1, webContents: sender };
    }
  }
};
const _origRequire = Module.prototype.require;
Module.prototype.require = function mockElectronRequire(id) {
  if (id === 'electron') return electronMock;
  return _origRequire.apply(this, arguments);
};

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  COZINHA_SCHEMA_VERSION
} = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  criarIntegracaoCicloVidaCozinhaImpressao,
  obterOuCriarIntegracaoPadrao,
  anexarAoReadyToShowMainWindow,
  _resetIntegracaoCicloVidaParaTeste,
  obterIntegracaoAtiva
} = require('../../backend/services/cozinha/CozinhaImpressaoElectronCicloVida');
const {
  obterWorkerImpressaoCozinhaInstalado,
  contarInstalacoesWorkerImpressao,
  _resetBootstrapWorkerImpressaoParaTeste
} = require('../../backend/services/cozinha/CozinhaImpressaoWorkerBootstrap');
const {
  estabelecerSessaoApartirDoToken,
  obterSessaoAutenticadaCozinha,
  limparSessaoAutenticadaCozinha
} = require('../../backend/services/cozinha/cozinhaImpressaoSessaoElectron');
const { getJwtSecret } = require('../../backend/config/secrets');
const { registrarCozinhaImpressaoHandlers } = require('../../electron-cozinha-impressao');
const WorkerService = require('../../backend/services/cozinha/CozinhaImpressaoWorkerService');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const EstacaoService = require('../../backend/services/cozinha/CozinhaImpressaoEstacaoService');
const { ESTADOS_FILA } = require('../../backend/services/cozinha/cozinhaImpressaoContratos');
const { criarFakeDriver } = require('../../backend/services/cozinha/cozinhaImpressaoDriver');
const {
  descreverGateClaimLogout,
  _resetGateClaimLogoutParaTeste
} = require('../../backend/services/cozinha/cozinhaImpressaoClaimLogoutGate');

function getRow(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
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
  assert.ok(COZINHA_SCHEMA_VERSION >= 4);
  assert.equal(isCozinhaOperacional(), true);
}

async function prepararUnidades(db) {
  const empA = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11111111000191', 'Emp A', 'EA', 1)`);
  const empB = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('22222222000182', 'Emp B', 'EB', 1)`);
  const unA = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
    VALUES (?, 'U-A', 1, 0)`, [empA.lastID]);
  const unB = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
    VALUES (?, 'U-B', 1, 0)`, [empB.lastID]);
  const unInativa = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
    VALUES (?, 'U-OFF', 0, 0)`, [empA.lastID]);
  return {
    empresaA: empA.lastID,
    empresaB: empB.lastID,
    unidadeA: unA.lastID,
    unidadeB: unB.lastID,
    unidadeInativa: unInativa.lastID
  };
}

async function prepararOperacionalComJob(db, empresaId, unidadeId, chave) {
  const mesa = await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 31, 1)`, [empresaId]);
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
    VALUES (?, ?, 'OCUPADA', 1)`, [empresaId, mesa.lastID]);
  const prod = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, utiliza_ficha_tecnica) VALUES ('Pastel L', 'COMERCIAL', 1)`);
  const ped = await run(db, `
    INSERT INTO pedidos (codigo, data_pedido, total, status, empresa_id, mesa_id, mesa_atendimento_id)
    VALUES (?, '2026-01-01', 10, 'PEDIDO', ?, ?, ?)`, [`PL-${chave}`, empresaId, mesa.lastID, at.lastID]);
  const item = await run(db, `
    INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, subtotal,
      classificacao_operacional_snapshot, produto_nome_snapshot, observacao
    ) VALUES (?, ?, 1, 9.90, 9.90, 'PASTEL', 'Pastel L', 'obs')`, [ped.lastID, prod.lastID]);
  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (
      empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id, operador_lancamento_id
    ) VALUES (?, ?, 1, 'C1', ?, 1)`, [empresaId, at.lastID, ped.lastID]);
  await EstacaoService.criarEstacao({
    db, empresaId, unidadeId, codigo_estacao: 'PASTEL',
    device_name: 'Cozinha-Termica-80', largura_mm: 80, vias: 1,
    modelo_individual: 0, modelo_agrupado: 1, ativo: 1
  });
  await CozinhaDespacho.despacharLote({
    empresaId, operadorId: 7, idempotencyKey: chave,
    unidade_id: unidadeId, mesa_id: mesa.lastID, atendimento_id: at.lastID,
    itens: [{
      pedido_id: ped.lastID, pedido_item_id: item.lastID, comanda_id: cmd.lastID,
      qty_solicitada: '1.000'
    }]
  }, { db });
}

function assinarToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_TEST_SECRET, opts.expiresIn ? { expiresIn: opts.expiresIn } : undefined);
}

function criarIpcMainMock() {
  const handlers = new Map();
  return {
    handle(canal, fn) {
      handlers.set(canal, fn);
    },
    removeHandler(canal) {
      handlers.delete(canal);
    },
    async invoke(canal, event, payload) {
      const fn = handlers.get(canal);
      if (!fn) throw new Error(`Handler ausente: ${canal}`);
      return fn(event, payload);
    },
    has(canal) {
      return handlers.has(canal);
    }
  };
}

function criarSenderAutorizado(win) {
  return {
    __win: win || { id: 42 },
    isDestroyed: () => false
  };
}

function criarSenderNaoAutorizado() {
  return {
    __unauthorized: true,
    isDestroyed: () => false
  };
}

function adapterSpy() {
  const prints = [];
  return {
    tipo: 'electron-producao',
    prints,
    async getPrinters() {
      return [{ name: 'Cozinha-Termica-80', isDefault: true }];
    },
    async print() {
      prints.push({});
      throw new Error('print físico proibido na auditoria complementar');
    }
  };
}

class MockWindow extends EventEmitter {
  constructor() {
    super();
    this._destroyed = false;
    this.webContents = {
      isDestroyed: () => false,
      getPrintersAsync: async () => [{ name: 'Cozinha-Termica-80', isDefault: true }],
      print: () => { throw new Error('print físico proibido'); }
    };
  }
  isDestroyed() { return this._destroyed; }
  show() {}
  focus() {}
}

describe('Sprint 06 E-03 — auditoria complementar IPC/JWT/ciclo', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = JWT_TEST_SECRET;
    marcarCozinhaOperacional(false);
    limparSessaoAutenticadaCozinha();
    _resetIntegracaoCicloVidaParaTeste();
    _resetBootstrapWorkerImpressaoParaTeste();
    _resetGateClaimLogoutParaTeste();
  });

  after(() => {
    Module.prototype.require = _origRequire;
  });

  it('C1) JWT_SECRET: produção sem chave lança; teste usa segredo explícito; segredo não logado', () => {
    assert.equal(getJwtSecret(), JWT_TEST_SECRET);

    const prevEnv = process.env.NODE_ENV;
    const prevSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    assert.throws(
      () => getJwtSecret(),
      (err) => err.codigo === 'JWT_SECRET_AUSENTE_PRODUCAO'
        && !String(err.message).includes(JWT_TEST_SECRET)
        && !String(err.message).includes('cds-dev-jwt')
    );
    process.env.NODE_ENV = prevEnv || 'test';
    process.env.JWT_SECRET = prevSecret;

    // Evidência: middleware importa getJwtSecret (não chave hardcoded de produção).
    const authSrc = fs.readFileSync(
      path.join(__dirname, '../../backend/middleware/auth.js'),
      'utf8'
    );
    assert.ok(authSrc.includes("require('../config/secrets')"));
    assert.ok(authSrc.includes('getJwtSecret()'));
    assert.ok(!authSrc.includes('cds-dev-jwt-change-in-production'));

    const secretsSrc = fs.readFileSync(
      path.join(__dirname, '../../backend/config/secrets.js'),
      'utf8'
    );
    assert.ok(secretsSrc.includes('JWT_SECRET_AUSENTE_PRODUCAO'));
    assert.ok(secretsSrc.includes('NODE_ENV === \'production\''));
  });

  it('C2) JWT real: token válido estabelece sessão (empresa da unidade no DB)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);

    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });

    const sessao = await estabelecerSessaoApartirDoToken({ token, db });
    assert.equal(sessao.empresaId, ids.empresaA);
    assert.equal(sessao.unidadeId, ids.unidadeA);
    assert.equal(obterSessaoAutenticadaCozinha().empresaId, ids.empresaA);
    await close(db);
  });

  it('C3) JWT real: inválido / expirado invalidam sessão anterior', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);

    const ok = assinarToken({
      id: 1,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    await estabelecerSessaoApartirDoToken({ token: ok, db });
    assert.ok(obterSessaoAutenticadaCozinha());

    await assert.rejects(
      () => estabelecerSessaoApartirDoToken({ token: 'nao-e-jwt', db }),
      (err) => err.codigo === 'IMPRESSAO_SESSAO_TOKEN_INVALIDO'
    );
    assert.equal(obterSessaoAutenticadaCozinha(), null);

    await estabelecerSessaoApartirDoToken({ token: ok, db });
    const expired = jwt.sign(
      { id: 1, unidade_cozinha_id: ids.unidadeA, empresa_id: ids.empresaA },
      JWT_TEST_SECRET,
      { expiresIn: -10 }
    );
    await assert.rejects(
      () => estabelecerSessaoApartirDoToken({ token: expired, db }),
      (err) => err.codigo === 'IMPRESSAO_SESSAO_TOKEN_EXPIRADO'
    );
    assert.equal(obterSessaoAutenticadaCozinha(), null);

    await close(db);
  });

  it('C4) JWT real: unidade inexistente / inativa / empresa divergente', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);

    await assert.rejects(
      () => estabelecerSessaoApartirDoToken({
        token: assinarToken({ id: 1, unidade_cozinha_id: 999999 }, { expiresIn: '1h' }),
        db
      }),
      (err) => err.codigo === 'IMPRESSAO_SESSAO_UNIDADE_INEXISTENTE'
    );
    assert.equal(obterSessaoAutenticadaCozinha(), null);

    await assert.rejects(
      () => estabelecerSessaoApartirDoToken({
        token: assinarToken({ id: 1, unidade_cozinha_id: ids.unidadeInativa }, { expiresIn: '1h' }),
        db
      }),
      (err) => err.codigo === 'IMPRESSAO_SESSAO_UNIDADE_INATIVA'
    );
    assert.equal(obterSessaoAutenticadaCozinha(), null);

    // Token afirma empresa B, mas unidade A pertence à empresa A.
    await assert.rejects(
      () => estabelecerSessaoApartirDoToken({
        token: assinarToken({
          id: 1,
          unidade_cozinha_id: ids.unidadeA,
          empresa_id: ids.empresaB
        }, { expiresIn: '1h' }),
        db
      }),
      (err) => err.codigo === 'IMPRESSAO_SESSAO_EMPRESA_DIVERGENTE'
    );
    assert.equal(obterSessaoAutenticadaCozinha(), null);

    await close(db);
  });

  it('C5) IPC real: handler contexto-operacional (autorizado / não autorizado / sessão / divergente / válido)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);

    const win = new MockWindow();
    const adapter = adapterSpy();
    // Mesmo caminho do electron.js: singleton ativo para o handler IPC.
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c5'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');
    assert.strictEqual(obterIntegracaoAtiva(), integracao);

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    assert.equal(ipcMain.has('cozinha-impressao:contexto-operacional'), true);
    assert.equal(ipcMain.has('cozinha-impressao:sessao-autenticada'), true);

    const eventOk = { sender: criarSenderAutorizado(win) };
    const eventBad = { sender: criarSenderNaoAutorizado() };

    // Remetente não autorizado
    const rNaoAuth = await ipcMain.invoke(
      'cozinha-impressao:contexto-operacional',
      eventBad,
      { empresa_id: ids.empresaA, unidade_id: ids.unidadeA }
    );
    assert.equal(rNaoAuth.success, false);
    assert.equal(rNaoAuth.codigo, 'IMPRESSAO_IPC_REMETENTE_INVALIDO');

    // Sessão ausente
    limparSessaoAutenticadaCozinha();
    const rSemSessao = await ipcMain.invoke(
      'cozinha-impressao:contexto-operacional',
      eventOk,
      { empresa_id: ids.empresaA, unidade_id: ids.unidadeA }
    );
    assert.equal(rSemSessao.success, false);
    assert.equal(rSemSessao.codigo, 'IMPRESSAO_SESSAO_AUSENTE');

    // Sessão via JWT real (IPC sessao-autenticada)
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    const rSessao = await ipcMain.invoke(
      'cozinha-impressao:sessao-autenticada',
      eventOk,
      { token }
    );
    assert.equal(rSessao.success, true);
    assert.equal(rSessao.sessao.empresaId, ids.empresaA);
    assert.equal(rSessao.sessao.unidadeId, ids.unidadeA);
    assert.equal(rSessao.contexto.ok, true);
    assert.equal(integracao.descrever().contexto.empresaId, ids.empresaA);

    // Renderer tenta outra empresa/unidade → rejeitado
    const rDivEmp = await ipcMain.invoke(
      'cozinha-impressao:contexto-operacional',
      eventOk,
      { empresa_id: ids.empresaB, unidade_id: ids.unidadeA }
    );
    assert.equal(rDivEmp.success, false);
    assert.equal(rDivEmp.codigo, 'IMPRESSAO_CONTEXTO_DIVERGENTE_SESSAO');

    const rDivUn = await ipcMain.invoke(
      'cozinha-impressao:contexto-operacional',
      eventOk,
      { empresa_id: ids.empresaA, unidade_id: ids.unidadeB }
    );
    assert.equal(rDivUn.success, false);
    assert.equal(rDivUn.codigo, 'IMPRESSAO_CONTEXTO_DIVERGENTE_SESSAO');
    assert.equal(integracao.descrever().contexto.empresaId, ids.empresaA);
    assert.equal(integracao.descrever().contexto.unidadeId, ids.unidadeA);

    // Contexto válido (coincide com sessão)
    const rOk = await ipcMain.invoke(
      'cozinha-impressao:contexto-operacional',
      eventOk,
      { empresa_id: ids.empresaA, unidade_id: ids.unidadeA }
    );
    assert.equal(rOk.success, true);
    assert.equal(rOk.ok, true);
    assert.equal(rOk.empresaId, ids.empresaA);
    assert.equal(rOk.unidadeId, ids.unidadeA);

    // Payload vazio → usa sessão canônica (renderer não escolhe)
    const rVazio = await ipcMain.invoke(
      'cozinha-impressao:contexto-operacional',
      eventOk,
      {}
    );
    assert.equal(rVazio.success, true);
    assert.equal(rVazio.empresaId, ids.empresaA);
    assert.equal(rVazio.unidadeId, ids.unidadeA);

    assert.equal(adapter.prints.length, 0);
    integracao.aoWillQuit();
    await close(db);
  });

  it('C6) Ciclo: troca de sessão durante tick; logout; contexto pendente após encerramento', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = criarIntegracaoCicloVidaCozinhaImpressao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c6'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const tokenA = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    await estabelecerSessaoApartirDoToken({ token: tokenA, db });
    const nA = await integracao.notificarContextoOperacional({
      empresa_id: ids.empresaA,
      unidade_id: ids.unidadeA
    });
    assert.equal(nA.ok, true);

    const worker = obterWorkerImpressaoCozinhaInstalado();
    assert.ok(worker);
    const tickOrig = worker.tick.bind(worker);
    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    worker.tick = async (entrada) => {
      await hold;
      return tickOrig(entrada);
    };

    const tickPromise = integracao.executarTickSeguro();
    for (let i = 0; i < 40 && !integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(integracao._estadoInterno().tickEmCurso, true);

    // Troca de sessão JWT A→B enquanto tick em curso
    const tokenB = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeB,
      empresa_id: ids.empresaB
    }, { expiresIn: '1h' });
    await estabelecerSessaoApartirDoToken({ token: tokenB, db });
    const trocaPromise = integracao.notificarContextoOperacional({
      empresa_id: ids.empresaB,
      unidade_id: ids.unidadeB
    });
    assert.equal(integracao.descrever().contexto.empresaId, ids.empresaA);

    releaseHold();
    await tickPromise;
    const troca = await trocaPromise;
    assert.equal(troca.ok, true);
    assert.equal(troca.empresaId, ids.empresaB);
    assert.equal(contarInstalacoesWorkerImpressao(), 1);

    // Logout: limpa sessão — contexto divergente / ausente rejeitado
    limparSessaoAutenticadaCozinha();
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    const aposLogout = await integracao.notificarContextoOperacional({
      empresa_id: ids.empresaB,
      unidade_id: ids.unidadeB
    });
    assert.equal(aposLogout.ok, false);
    assert.equal(aposLogout.codigo, 'IMPRESSAO_SESSAO_AUSENTE');

    // Restaura sessão e inicia tick longo; encerrar durante espera → contexto não aplica
    await estabelecerSessaoApartirDoToken({ token: tokenB, db });
    let release2;
    const hold2 = new Promise((r) => { release2 = r; });
    worker.tick = async (entrada) => {
      await hold2;
      return tickOrig(entrada);
    };
    const tick2 = integracao.executarTickSeguro();
    for (let i = 0; i < 40 && !integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(integracao._estadoInterno().tickEmCurso, true);

    const pendente = integracao.notificarContextoOperacional({
      empresa_id: ids.empresaB,
      unidade_id: ids.unidadeB
    });
    const fim = integracao.aoWillQuit();
    assert.equal(fim.encerrado, true);
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    assert.equal(obterWorkerImpressaoCozinhaInstalado(), null);

    release2();
    await tick2;
    const pendenteOut = await pendente;
    assert.equal(pendenteOut.ok, false);
    assert.equal(pendenteOut.codigo, 'IMPRESSAO_WORKER_ENCERRADO');

    assert.equal(adapter.prints.length, 0);
    await close(db);
  });

  it('C7) Logout real com agendador ativo: sem claim/processamento/contexto; retomada 1 Worker/1 agendador', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c7-logout');

    // Evidência do fluxo real de logout/retomada no frontend + preload.
    const coreSrc = fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/core.js'), 'utf8');
    assert.ok(coreSrc.includes('cozinhaImpressao.logout'));
    assert.ok(coreSrc.includes('/auth/logout'));
    const preloadSrc = fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf8');
    assert.ok(preloadSrc.includes('cozinha-impressao:logout'));
    assert.ok(preloadSrc.includes('cozinha-impressao:sessao-autenticada'));
    const loginSrc = fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/login.js'), 'utf8');
    assert.ok(loginSrc.includes('estabelecerSessao'));
    const ipcSrc = fs.readFileSync(path.join(__dirname, '../../electron-cozinha-impressao.js'), 'utf8');
    assert.ok(ipcSrc.includes('cozinha-impressao:logout'));
    assert.ok(ipcSrc.includes('aoLogoutOperacional'));

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 40,
      workerId: 'electron-cozinha-worker-c7'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    assert.equal(ipcMain.has('cozinha-impressao:logout'), true);

    const eventOk = { sender: criarSenderAutorizado(win) };
    const tokenA = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });

    const rSessao = await ipcMain.invoke(
      'cozinha-impressao:sessao-autenticada',
      eventOk,
      { token: tokenA }
    );
    assert.equal(rSessao.success, true);
    assert.equal(rSessao.contexto.ok, true);
    assert.equal(integracao.descrever().agendador_ativo, true);
    assert.equal(integracao._estadoInterno().temTimerTick, true);

    const workerRef = obterWorkerImpressaoCozinhaInstalado();
    assert.ok(workerRef);
    const instalacoesAntes = contarInstalacoesWorkerImpressao();

    let claims = 0;
    const claimOrig = WorkerService.reivindicarProximoJob;
    WorkerService.reivindicarProximoJob = async (...args) => {
      claims += 1;
      return claimOrig(...args);
    };

    let processamentos = 0;
    const contextosTick = [];
    const tickOrig = workerRef.tick.bind(workerRef);
    workerRef.tick = async (entrada) => {
      processamentos += 1;
      contextosTick.push({
        empresaId: entrada && entrada.empresaId,
        unidadeId: entrada && entrada.unidadeId
      });
      return tickOrig(entrada);
    };

    // Agendador ativo executa ao menos um tick.
    for (let i = 0; i < 50 && processamentos < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(processamentos >= 1, 'agendador deveria ter processado ao menos um tick');
    const processamentosAntesLogout = processamentos;
    const claimsAntesLogout = claims;
    const ticksAntes = integracao.descrever().ticks_executados;

    const jobAntes = await new Promise((resolve, reject) => {
      db.get(
        `SELECT estado, tentativas, worker_id FROM cozinha_impressao_fila LIMIT 1`,
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });
    assert.equal(jobAntes.estado, ESTADOS_FILA.PENDENTE);

    // Logout via IPC real (mesmo canal do frontend electronAPI.cozinhaImpressao.logout)
    const rLogout = await ipcMain.invoke('cozinha-impressao:logout', eventOk);
    assert.equal(rLogout.success, true);
    assert.equal(rLogout.logout, true);
    assert.equal(rLogout.agendador_ativo, false);
    assert.equal(rLogout.contexto, null);
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    assert.equal(integracao.descrever().contexto.empresaId, null);
    assert.equal(integracao.descrever().agendador_ativo, false);
    assert.equal(integracao._estadoInterno().temTimerTick, false);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);
    assert.equal(contarInstalacoesWorkerImpressao(), instalacoesAntes);

    // Nenhum novo processamento/claim/contexto após logout.
    for (let i = 0; i < 5; i += 1) {
      const skipped = await integracao.executarTickSeguro();
      assert.equal(skipped.skipped, true);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(processamentos, processamentosAntesLogout);
    assert.equal(claims, claimsAntesLogout);
    assert.equal(integracao.descrever().ticks_executados, ticksAntes);
    assert.ok(contextosTick.every((c) => Number(c.empresaId) === Number(ids.empresaA)));

    const jobDepois = await new Promise((resolve, reject) => {
      db.get(
        `SELECT estado, tentativas, worker_id FROM cozinha_impressao_fila LIMIT 1`,
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });
    assert.equal(jobDepois.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(jobDepois.tentativas, jobAntes.tentativas);
    assert.equal(jobDepois.worker_id, null);

    // Retomada segura com nova autenticação JWT (mesmo caminho do login Electron).
    const tokenRetoma = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    const rRetoma = await ipcMain.invoke(
      'cozinha-impressao:sessao-autenticada',
      eventOk,
      { token: tokenRetoma }
    );
    assert.equal(rRetoma.success, true);
    assert.equal(rRetoma.contexto.ok, true);
    assert.equal(integracao.descrever().agendador_ativo, true);
    assert.equal(integracao._estadoInterno().temTimerTick, true);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);
    assert.equal(contarInstalacoesWorkerImpressao(), 1);
    assert.equal(rRetoma.contexto.tem_timer_unico, true);

    for (let i = 0; i < 50 && processamentos <= processamentosAntesLogout; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(processamentos > processamentosAntesLogout, 'retomada deve voltar a executar ticks');
    const ultimo = contextosTick[contextosTick.length - 1];
    assert.equal(ultimo.empresaId, ids.empresaA);
    assert.equal(ultimo.unidadeId, ids.unidadeA);

    WorkerService.reivindicarProximoJob = claimOrig;
    assert.equal(adapter.prints.length, 0);
    integracao.aoWillQuit();
    await close(db);
  });

  it('C8-A) Logout antes do claim: zero claims e zero processamento', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c8a');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c8a'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);
    // Espera o tick imediato do agendador (simulação ELECTRON) terminar.
    for (let i = 0; i < 40 && integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const worker = obterWorkerImpressaoCozinhaInstalado();
    const workerRef = worker;
    let passouAntesClaim = false;
    let driverCalls = 0;

    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    const tickBuiltIn = worker.tick.bind(worker);
    worker.tick = async (entrada) => tickBuiltIn({
      ...entrada,
      driver: criarFakeDriver({
        modo: 'sucesso',
        resolver: () => {
          driverCalls += 1;
          return 'sucesso';
        }
      }),
      __antesClaim: async () => {
        passouAntesClaim = true;
        await hold;
      }
    });

    const tickPromise = integracao.executarTickSeguro();
    for (let i = 0; i < 40 && !passouAntesClaim; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(passouAntesClaim, true);
    assert.equal(integracao._estadoInterno().tickEmCurso, true);

    // Logout invalida geração e aguarda o tick — liberar o hold em paralelo.
    const logoutPromise = ipcMain.invoke('cozinha-impressao:logout', eventOk);
    for (let i = 0; i < 30 && obterSessaoAutenticadaCozinha() != null; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    releaseHold();
    const rLogout = await logoutPromise;
    const tickOut = await tickPromise;
    assert.equal(rLogout.success, true);
    assert.equal(tickOut.cancelado === true || tickOut.contexto_obsoleto === true, true);
    assert.equal(driverCalls, 0);
    assert.ok(tickOut.out && tickOut.out.cancelado === true);
    assert.equal(tickOut.out.reivindicado, false);

    const job = await getRow(db, `SELECT estado, worker_id, tentativas FROM cozinha_impressao_fila LIMIT 1`);
    assert.equal(job.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(job.worker_id, null);
    assert.equal(job.tentativas, 0);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);
    assert.equal(adapter.prints.length, 0);

    integracao.aoWillQuit();
    await close(db);
  });

  it('C8-B) Logout após claim e antes do driver: sem impressão; job não volta a PENDENTE', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c8b');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c8b'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);
    for (let i = 0; i < 40 && integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const worker = obterWorkerImpressaoCozinhaInstalado();
    const workerRef = worker;
    let driverCalls = 0;
    let passouAposClaim = false;

    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    const tickBuiltIn = worker.tick.bind(worker);
    worker.tick = async (entrada) => tickBuiltIn({
      ...entrada,
      driver: criarFakeDriver({
        modo: 'sucesso',
        resolver: () => {
          driverCalls += 1;
          return 'sucesso';
        }
      }),
      __antesDriver: async () => {
        passouAposClaim = true;
        await hold;
      }
    });

    const tickPromise = integracao.executarTickSeguro();
    for (let i = 0; i < 80 && !passouAposClaim; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(passouAposClaim, true, 'deveria ter reivindicado e pausado antes do driver');
    assert.equal(integracao._estadoInterno().tickEmCurso, true);

    const jobDurante = await getRow(db, `SELECT id, estado, worker_id, tentativas FROM cozinha_impressao_fila LIMIT 1`);
    assert.equal(jobDurante.estado, ESTADOS_FILA.PROCESSANDO);
    assert.ok(jobDurante.worker_id);

    const logoutPromise = ipcMain.invoke('cozinha-impressao:logout', eventOk);
    for (let i = 0; i < 30 && obterSessaoAutenticadaCozinha() != null; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    releaseHold();
    const rLogout = await logoutPromise;
    const tickOut = await tickPromise;
    assert.equal(rLogout.success, true);
    assert.equal(tickOut.cancelado === true || tickOut.contexto_obsoleto === true, true);
    assert.ok(tickOut.out && tickOut.out.claim_sem_driver === true);
    assert.equal(driverCalls, 0);
    assert.equal(adapter.prints.length, 0);

    const jobDepois = await getRow(db, `SELECT estado, worker_id, tentativas FROM cozinha_impressao_fila WHERE id = ?`, [jobDurante.id]);
    // Política: não devolve automaticamente a PENDENTE; sem reenvio automático.
    assert.equal(jobDepois.estado, ESTADOS_FILA.PROCESSANDO);
    assert.equal(jobDepois.worker_id, jobDurante.worker_id);
    assert.equal(jobDepois.tentativas, jobDurante.tentativas);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);

    integracao.aoWillQuit();
    await close(db);
  });

  it('C8-C) Retomada após C8: JWT válido → mesmo Worker / único agendador', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c8c');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 40,
      workerId: 'electron-cozinha-worker-c8c'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);

    const workerRef = obterWorkerImpressaoCozinhaInstalado();
    assert.ok(workerRef);
    assert.equal(integracao.descrever().agendador_ativo, true);

    assert.equal((await ipcMain.invoke('cozinha-impressao:logout', eventOk)).success, true);
    assert.equal(integracao.descrever().agendador_ativo, false);
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);

    const token2 = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    const retoma = await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token: token2 });
    assert.equal(retoma.success, true);
    assert.equal(retoma.contexto.ok, true);
    assert.equal(retoma.sessao.empresaId, ids.empresaA);
    assert.equal(retoma.sessao.unidadeId, ids.unidadeA);
    assert.equal(integracao.descrever().agendador_ativo, true);
    assert.equal(integracao._estadoInterno().temTimerTick, true);
    assert.equal(retoma.contexto.tem_timer_unico, true);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);
    assert.equal(contarInstalacoesWorkerImpressao(), 1);

    for (let i = 0; i < 50 && integracao.descrever().ticks_executados < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(integracao.descrever().ticks_executados >= 1);
    assert.equal(adapter.prints.length, 0);

    integracao.aoWillQuit();
    await close(db);
  });

  it('C9) Logout durante TX de claim (após SELECT, antes do UPDATE): ROLLBACK', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c9');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c9'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);
    // Drena o tick imediato do agendador (ELECTRON sim) antes do claim controlado.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 40 && integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(integracao._estadoInterno().tickEmCurso, false);

    const jobAntes = await getRow(db, `
      SELECT id, estado, worker_id, tentativas FROM cozinha_impressao_fila LIMIT 1
    `);
    assert.equal(jobAntes.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(jobAntes.worker_id, null);
    assert.equal(jobAntes.tentativas, 0);

    const worker = obterWorkerImpressaoCozinhaInstalado();
    const workerRef = worker;
    const instalacoesAntes = contarInstalacoesWorkerImpressao();
    let driverCalls = 0;
    let pausouAntesUpdate = false;
    let candidatoId = null;
    let tickSettled = null;

    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    const tickBuiltIn = worker.tick.bind(worker);
    worker.tick = async (entrada) => tickBuiltIn({
      ...entrada,
      driver: criarFakeDriver({
        modo: 'sucesso',
        resolver: () => {
          driverCalls += 1;
          return 'sucesso';
        }
      }),
      __antesUpdateClaim: async (ctx) => {
        pausouAntesUpdate = true;
        candidatoId = ctx.jobId;
        assert.equal(ctx.dentro_transacao, true);
        await hold;
      }
    });

    const tickPromise = integracao.executarTickSeguro().then((out) => {
      tickSettled = out;
      return out;
    });
    for (let i = 0; i < 100 && !pausouAntesUpdate && !tickSettled; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      pausouAntesUpdate,
      true,
      `hook pré-UPDATE não acionado; tickSettled=${JSON.stringify(tickSettled)}`
    );
    assert.equal(Number(candidatoId), Number(jobAntes.id));
    assert.equal(integracao._estadoInterno().tickEmCurso, true);

    const logoutPromise = ipcMain.invoke('cozinha-impressao:logout', eventOk);
    for (let i = 0; i < 30 && obterSessaoAutenticadaCozinha() != null; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    assert.ok(worker.obterGeracaoOperacional() > 0);

    releaseHold();
    const rLogout = await logoutPromise;
    const tickOut = await tickPromise;
    assert.equal(rLogout.success, true);
    assert.equal(tickOut.cancelado === true || tickOut.contexto_obsoleto === true, true);
    assert.ok(tickOut.out && tickOut.out.cancelado === true);
    assert.equal(tickOut.out.claim_rollback, true);
    assert.equal(tickOut.out.reivindicado, false);
    assert.equal(driverCalls, 0);
    assert.equal(adapter.prints.length, 0);

    const jobDepois = await getRow(db, `
      SELECT estado, worker_id, tentativas FROM cozinha_impressao_fila WHERE id = ?
    `, [jobAntes.id]);
    assert.equal(jobDepois.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(jobDepois.worker_id, null);
    assert.equal(jobDepois.tentativas, 0);

    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);
    assert.equal(contarInstalacoesWorkerImpressao(), instalacoesAntes);
    assert.equal(integracao.descrever().agendador_ativo, false);

    integracao.aoWillQuit();
    await close(db);
  });

  it('C9-R) Claim normal sem logout confirma PROCESSANDO e processa (sem físico)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c9r');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c9r'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);
    for (let i = 0; i < 40 && integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const worker = obterWorkerImpressaoCozinhaInstalado();
    let driverCalls = 0;
    let viuUpdate = false;
    const tickBuiltIn = worker.tick.bind(worker);
    worker.tick = async (entrada) => tickBuiltIn({
      ...entrada,
      driver: criarFakeDriver({
        modo: 'sucesso',
        resolver: () => {
          driverCalls += 1;
          return 'sucesso';
        }
      }),
      __antesUpdateClaim: async (ctx) => {
        viuUpdate = true;
        assert.equal(ctx.dentro_transacao, true);
      }
    });

    const tickOut = await integracao.executarTickSeguro();
    assert.equal(tickOut.ok, true);
    assert.equal(viuUpdate, true);
    assert.equal(driverCalls, 1);
    assert.equal(adapter.prints.length, 0);

    const job = await getRow(db, `SELECT estado, worker_id, tentativas FROM cozinha_impressao_fila LIMIT 1`);
    assert.notEqual(job.estado, ESTADOS_FILA.PENDENTE);
    assert.ok(job.tentativas >= 1);

    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), worker);
    assert.equal(contarInstalacoesWorkerImpressao(), 1);

    integracao.aoWillQuit();
    await close(db);
  });

  it('C10-A) Invalidar geração após UPDATE na confirmação do COMMIT → ROLLBACK', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c10a');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c10a'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 40 && integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const jobAntes = await getRow(db, `
      SELECT id, estado, worker_id, tentativas FROM cozinha_impressao_fila LIMIT 1
    `);
    assert.equal(jobAntes.estado, ESTADOS_FILA.PENDENTE);

    const worker = obterWorkerImpressaoCozinhaInstalado();
    let driverCalls = 0;
    let pausouAntesCommit = false;
    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    const tickBuiltIn = worker.tick.bind(worker);
    worker.tick = async (entrada) => tickBuiltIn({
      ...entrada,
      driver: criarFakeDriver({
        modo: 'sucesso',
        resolver: () => {
          driverCalls += 1;
          return 'sucesso';
        }
      }),
      __antesCommitClaim: async (ctx) => {
        pausouAntesCommit = true;
        assert.equal(ctx.update_aplicado, true);
        assert.equal(ctx.dentro_transacao, true);
        await hold;
      }
    });

    const tickPromise = integracao.executarTickSeguro();
    for (let i = 0; i < 100 && !pausouAntesCommit; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(pausouAntesCommit, true);

    const logoutPromise = ipcMain.invoke('cozinha-impressao:logout', eventOk);
    for (let i = 0; i < 30 && obterSessaoAutenticadaCozinha() != null; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    releaseHold();

    const rLogout = await logoutPromise;
    const tickOut = await tickPromise;
    assert.equal(rLogout.success, true);
    assert.equal(tickOut.cancelado === true || tickOut.contexto_obsoleto === true, true);
    assert.ok(tickOut.out && tickOut.out.claim_rollback === true);
    assert.equal(driverCalls, 0);
    assert.equal(adapter.prints.length, 0);

    const jobDepois = await getRow(db, `
      SELECT estado, worker_id, tentativas FROM cozinha_impressao_fila WHERE id = ?
    `, [jobAntes.id]);
    assert.equal(jobDepois.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(jobDepois.worker_id, null);
    assert.equal(jobDepois.tentativas, 0);
    assert.equal(descreverGateClaimLogout().ocupado, false);

    integracao.aoWillQuit();
    await close(db);
  });

  it('C10-B) Logout concorrente com COMMIT: ordem inequívoca; sem driver após logout', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c10b');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c10b'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 40 && integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const worker = obterWorkerImpressaoCozinhaInstalado();
    const workerRef = worker;
    const ordem = [];
    let driverCalls = 0;
    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });

    const invOrig = worker.invalidarGeracaoOperacional.bind(worker);
    worker.invalidarGeracaoOperacional = async (...args) => {
      ordem.push('logout-entrou-gate');
      const out = await invOrig(...args);
      ordem.push('logout-invalidou');
      return out;
    };

    const tickBuiltIn = worker.tick.bind(worker);
    worker.tick = async (entrada) => tickBuiltIn({
      ...entrada,
      driver: criarFakeDriver({
        modo: 'sucesso',
        resolver: () => {
          driverCalls += 1;
          ordem.push('driver');
          return 'sucesso';
        }
      }),
      __antesCommitClaim: async () => {
        ordem.push('claim-apos-update');
        await hold;
        ordem.push('claim-vai-commit-gate');
      }
    });

    const tickPromise = integracao.executarTickSeguro();
    for (let i = 0; i < 100 && !ordem.includes('claim-apos-update'); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(ordem.includes('claim-apos-update'));

    const logoutPromise = ipcMain.invoke('cozinha-impressao:logout', eventOk);
    await new Promise((r) => setTimeout(r, 15));
    releaseHold();

    const rLogout = await logoutPromise;
    const tickOut = await tickPromise;
    assert.equal(rLogout.success, true);
    assert.equal(driverCalls, 0);
    assert.ok(!ordem.includes('driver'));
    assert.ok(ordem.includes('logout-invalidou'));
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);
    assert.equal(contarInstalacoesWorkerImpressao(), 1);

    // Ordem inequívoca: logout não invalida antes do claim sair da etapa pós-UPDATE,
    // e nunca há driver após logout.
    const idxUpdate = ordem.indexOf('claim-apos-update');
    const idxLogout = ordem.indexOf('logout-invalidou');
    assert.ok(idxUpdate >= 0 && idxLogout >= 0);
    assert.ok(idxLogout > idxUpdate);

    const job = await getRow(db, `SELECT estado, worker_id FROM cozinha_impressao_fila LIMIT 1`);
    if (tickOut.out && tickOut.out.claim_rollback) {
      assert.equal(job.estado, ESTADOS_FILA.PENDENTE);
      assert.equal(job.worker_id, null);
    } else {
      // Claim confirmou sob o gate antes do logout; driver bloqueado pela geração inválida.
      assert.equal(job.estado, ESTADOS_FILA.PROCESSANDO);
      assert.equal(adapter.prints.length, 0);
    }

    integracao.aoWillQuit();
    await close(db);
  });

  it('C10-C) Claim normal com geração válida continua com driver FAKE (sem físico)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c10c');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c10c'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 40 && integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const worker = obterWorkerImpressaoCozinhaInstalado();
    let driverCalls = 0;
    let viuCommit = false;
    const tickBuiltIn = worker.tick.bind(worker);
    worker.tick = async (entrada) => tickBuiltIn({
      ...entrada,
      driver: criarFakeDriver({
        modo: 'sucesso',
        resolver: () => {
          driverCalls += 1;
          return 'sucesso';
        }
      }),
      __antesCommitClaim: async (ctx) => {
        viuCommit = true;
        assert.equal(ctx.update_aplicado, true);
      }
    });

    const tickOut = await integracao.executarTickSeguro();
    assert.equal(tickOut.ok, true);
    assert.equal(viuCommit, true);
    assert.equal(driverCalls, 1);
    assert.equal(adapter.prints.length, 0);
    assert.ok(tickOut.out && tickOut.out.commit_coordenado_logout === true);

    const job = await getRow(db, `SELECT estado, tentativas FROM cozinha_impressao_fila LIMIT 1`);
    assert.notEqual(job.estado, ESTADOS_FILA.PENDENTE);
    assert.ok(job.tentativas >= 1);
    assert.equal(descreverGateClaimLogout().ocupado, false);

    integracao.aoWillQuit();
    await close(db);
  });

  it('C10-D) Claim adquire o gate antes do logout: COMMIT → depois invalidação; sem driver', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ids = await prepararUnidades(db);
    await prepararOperacionalComJob(db, ids.empresaA, ids.unidadeA, 'e03-c10d');

    const win = new MockWindow();
    const adapter = adapterSpy();
    const integracao = obterOuCriarIntegracaoPadrao({
      obterMainWindow: () => win,
      obterDb: () => db,
      adapter,
      permitirAdapterCompat: true,
      intervaloTickMs: 60000,
      workerId: 'electron-cozinha-worker-c10d'
    });
    anexarAoReadyToShowMainWindow(win, integracao);
    win.emit('ready-to-show');

    const ipcMain = criarIpcMainMock();
    registrarCozinhaImpressaoHandlers(ipcMain, {
      obterDb: () => db,
      resolveWindow: (sender) => electronMock.BrowserWindow.fromWebContents(sender)
    });
    const eventOk = { sender: criarSenderAutorizado(win) };
    const token = assinarToken({
      id: 7,
      unidade_cozinha_id: ids.unidadeA,
      empresa_id: ids.empresaA
    }, { expiresIn: '1h' });
    assert.equal((await ipcMain.invoke('cozinha-impressao:sessao-autenticada', eventOk, { token })).success, true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 40 && integracao._estadoInterno().tickEmCurso; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const worker = obterWorkerImpressaoCozinhaInstalado();
    const workerRef = worker;
    const instalacoesAntes = contarInstalacoesWorkerImpressao();
    assert.equal(instalacoesAntes, 1);
    assert.equal(integracao.descrever().agendador_ativo, true);

    const ordem = [];
    let driverCalls = 0;
    let driverAposLogout = 0;
    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    let logoutPromise = null;
    let updateAplicado = false;

    const invOrig = worker.invalidarGeracaoOperacional.bind(worker);
    worker.invalidarGeracaoOperacional = async (...args) => {
      // Chamada alcançada (pode estar enfileirada no gate ainda ocupado pelo claim).
      ordem.push('logout-chamou-invalidar');
      const out = await invOrig(...args);
      ordem.push('logout-invalidou');
      return out;
    };

    const tickBuiltIn = worker.tick.bind(worker);
    worker.tick = async (entrada) => tickBuiltIn({
      ...entrada,
      driver: criarFakeDriver({
        modo: 'sucesso',
        resolver: () => {
          driverCalls += 1;
          if (ordem.includes('logout-invalidou')) driverAposLogout += 1;
          ordem.push('driver');
          return 'sucesso';
        }
      }),
      __antesCommitClaim: async (ctx) => {
        assert.equal(ctx.update_aplicado, true);
        updateAplicado = true;
        ordem.push('claim-apos-update');
      },
      __antesCommitDentroGate: async (ctx) => {
        assert.equal(updateAplicado, true);
        assert.equal(ctx.update_aplicado, true);
        assert.equal(ctx.gate_dono, 'claim-commit');
        assert.equal(descreverGateClaimLogout().ocupado, true);
        assert.equal(descreverGateClaimLogout().ultimo_dono, 'claim-commit');
        ordem.push('claim-entrou-gate');
        const geracaoSobGate = worker.obterGeracaoOperacional();

        logoutPromise = ipcMain.invoke('cozinha-impressao:logout', eventOk);
        for (let i = 0; i < 50 && obterSessaoAutenticadaCozinha() != null; i += 1) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(obterSessaoAutenticadaCozinha(), null);
        // Logout avançou (sessão limpa / chamou invalidar), mas a invalidação
        // operacional ainda NÃO concluiu — aguarda o gate do claim.
        for (let i = 0; i < 30 && !ordem.includes('logout-chamou-invalidar'); i += 1) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(ordem.includes('logout-chamou-invalidar'));
        assert.ok(!ordem.includes('logout-invalidou'));
        assert.equal(worker.obterGeracaoOperacional(), geracaoSobGate);
        assert.equal(descreverGateClaimLogout().ocupado, true);
        assert.equal(descreverGateClaimLogout().ultimo_dono, 'claim-commit');

        await hold;
      },
      __aposCommitDentroGate: async (ctx) => {
        assert.equal(ctx.commit_confirmado, true);
        assert.equal(descreverGateClaimLogout().ocupado, true);
        assert.equal(descreverGateClaimLogout().ultimo_dono, 'claim-commit');
        assert.ok(!ordem.includes('logout-invalidou'));
        ordem.push('claim-commit-confirmado');
      }
    });

    const tickPromise = integracao.executarTickSeguro();
    for (let i = 0; i < 100 && !ordem.includes('claim-entrou-gate'); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(ordem.includes('claim-entrou-gate'));
    assert.ok(logoutPromise);
    assert.ok(!ordem.includes('logout-invalidou'));

    releaseHold();

    const rLogout = await logoutPromise;
    const tickOut = await tickPromise;

    assert.equal(rLogout.success, true);
    assert.equal(obterSessaoAutenticadaCozinha(), null);
    assert.strictEqual(obterWorkerImpressaoCozinhaInstalado(), workerRef);
    assert.equal(contarInstalacoesWorkerImpressao(), 1);
    assert.equal(integracao.descrever().agendador_ativo, false);
    assert.equal(integracao._estadoInterno().temTimerTick, false);

    assert.deepEqual(
      ordem.filter((x) => [
        'claim-entrou-gate',
        'claim-commit-confirmado',
        'logout-invalidou'
      ].includes(x)),
      ['claim-entrou-gate', 'claim-commit-confirmado', 'logout-invalidou']
    );
    assert.ok(ordem.indexOf('claim-apos-update') < ordem.indexOf('claim-entrou-gate'));
    assert.equal(driverCalls, 0);
    assert.equal(driverAposLogout, 0);
    assert.ok(!ordem.includes('driver'));
    assert.equal(adapter.prints.length, 0);
    assert.equal(descreverGateClaimLogout().ocupado, false);

    const job = await getRow(db, `
      SELECT estado, worker_id, tentativas FROM cozinha_impressao_fila LIMIT 1
    `);
    // Claim confirmou sob o gate: PROCESSANDO coerente; sem retorno automático a PENDENTE.
    assert.equal(job.estado, ESTADOS_FILA.PROCESSANDO);
    assert.ok(job.worker_id);
    assert.ok(job.tentativas >= 1);
    assert.ok(
      tickOut.out
        && (tickOut.out.claim_sem_driver === true || tickOut.out.cancelado === true || tickOut.contexto_obsoleto === true)
    );

    integracao.aoWillQuit();
    await close(db);
  });
});
