/**
 * Microsprint P0.11 — Normalização do cooldown e consulta controlada.
 * Isolado: mocks, SQLite :memory:, sem SEFAZ real, sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
 *   tests/central-entradas/microsprint-p0-11-normalizacao-cooldown-consulta-controlada.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p011-cooldown-');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const CentralNsuService = require('../../backend/motores/central-entradas/services/CentralNsuService');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');
const CentralConsultaDistDfeDecisaoService = require(
  '../../backend/motores/central-entradas/services/CentralConsultaDistDfeDecisaoService'
);
const { CentralSefazOperationalGate } = require(
  '../../backend/motores/central-entradas/services/CentralSefazOperationalGate'
);
const { CentralSyncExecucaoService } = require(
  '../../backend/motores/central-entradas/services/CentralSyncExecucaoService'
);
const { obterMutexTransmissaoSefaz } = require(
  '../../backend/services/fiscal/SefazTransmissaoMutex'
);
const { criarAutorizacaoTesteIsolado } = require(
  '../../backend/services/fiscal/autorizacaoTransmissaoSefaz'
);
const { lerConfigDeMapa } = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig'
);

const EMP_A = 11;
const EMP_B = 22;
const CNPJ_A = '11111111000191';
const CNPJ_B = '22222222000182';
const FIXO = new Date('2026-10-18T23:30:00.000Z');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function criarDbNsu() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await run(db, `
    CREATE TABLE central_entradas_nsu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ambiente INTEGER NOT NULL DEFAULT 2,
      ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
      max_nsu TEXT NOT NULL DEFAULT '000000000000000',
      data_sincronizacao DATETIME,
      cooldown_ate DATETIME,
      ultimo_cstat TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ambiente)
    )
  `);
  return db;
}

function padNsu(n) {
  return String(n).padStart(15, '0');
}

describe('P0.11 decisão unificada DistDFe', () => {
  let db;
  let nsuService;
  let gate;
  let decisao;
  let agoraMs;

  beforeEach(async () => {
    db = await criarDbNsu();
    agoraMs = FIXO.getTime();
    const agora = () => new Date(agoraMs);
    const repo = new CentralNsuRepository({ db });
    nsuService = new CentralNsuService({ nsuRepository: repo, agora });
    gate = new CentralSefazOperationalGate({
      agora,
      autoPersist: false,
      configRepository: {
        buscarPorChave: async () => null,
        parseValor: () => ({}),
        salvar: async () => {}
      }
    });
    gate.hidratar({});
    decisao = new CentralConsultaDistDfeDecisaoService({
      nsuService,
      gate,
      agora,
      rateLimitMs: 30_000,
      mutexTransmissaoSefaz: obterMutexTransmissaoSefaz()
    });
    decisao.resetRateLimitParaTeste();
    obterMutexTransmissaoSefaz().resetParaTeste();
  });

  afterEach(async () => {
    obterMutexTransmissaoSefaz().resetParaTeste();
    if (db) await new Promise((r) => db.close(() => r()));
  });

  it('1) cooldown vigente bloqueia consulta', async () => {
    const ate = new Date(agoraMs + 60 * 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, ?, '656', ?)`,
    [CNPJ_A, padNsu(10), padNsu(10), ate, FIXO.toISOString()]);

    const r = await decisao.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP_A }),
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'COOLDOWN_ATIVO');
    assert.ok(r.proximaConsultaEm);
  });

  it('2) cooldown 656 vencido com ult=max permanece bloqueado por FILA_ESGOTADA (P0.14)', async () => {
    const ate = new Date(agoraMs - 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, ?, '656', ?)`,
    [CNPJ_A, padNsu(10), padNsu(10), ate, new Date(agoraMs - 3600_000).toISOString()]);

    const r = await decisao.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP_A }),
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'FILA_ESGOTADA');
    assert.equal(r.motivoCooldown, 'FILA_ESGOTADA');
  });

  it('2b) cooldown vencido com cursor avançável (ult<max) libera verificações locais', async () => {
    const ate = new Date(agoraMs - 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, ?, '656', ?)`,
    [CNPJ_A, padNsu(10), padNsu(20), ate, new Date(agoraMs - 3600_000).toISOString()]);

    const r = await decisao.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP_A }),
      verificarMutex: false
    });
    assert.equal(r.permitido, true);
    assert.equal(r.codigo, 'PRONTO_PARA_CONSULTA');
  });

  it('3) autorização ausente bloqueia CONSULTA_DFE_REAL (sem SOAP)', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_A, padNsu(1), padNsu(1)]);

    const r = await decisao.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: null,
      verificarAutorizacao: true,
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'AUTORIZACAO_AUSENTE');
  });

  it('4) cStat 656 preserva NSU', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_A, padNsu(196), padNsu(196)]);
    const controle = await nsuService.buscarPorCnpjAmbiente(CNPJ_A, 1);
    const out = await nsuService.aplicarRetornoDistDfe({
      controle,
      cStat: '656',
      ultNsu: padNsu(999),
      maxNsu: padNsu(999),
      xmlRetorno: '<retDistDFeInt><cStat>656</cStat><ultNSU>000000000000999</ultNSU><maxNSU>000000000000999</maxNSU></retDistDFeInt>'
    });
    assert.equal(out.atualizouNsu, false);
    assert.equal(out.preservado, true);
    assert.equal(out.controle.ultNsu, padNsu(196));
    assert.equal(out.controle.maxNsu, padNsu(196));
    assert.equal(out.cooldownAtivo, true);
  });

  it('5) falha de persistência não confirma avanço (preservarNsu em erro)', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_A, padNsu(50), padNsu(50)]);
    const controle = await nsuService.buscarPorCnpjAmbiente(CNPJ_A, 1);
    const out = await nsuService.aplicarRetornoDistDfe({
      controle,
      cStat: '999',
      ultNsu: padNsu(80),
      maxNsu: padNsu(80)
    });
    assert.equal(out.atualizouNsu, false);
    assert.equal(out.preservado, true);
    const again = await nsuService.buscarPorCnpjAmbiente(CNPJ_A, 1);
    assert.equal(again.ultNsu, padNsu(50));
  });

  it('6) mutex impede consultas simultâneas', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_A, padNsu(1), padNsu(1)]);
    const mutex = obterMutexTransmissaoSefaz();
    const locked = await mutex.comLock('teste-p011', async () => {
      const r = await decisao.avaliar({
        empresaId: EMP_A,
        cnpj: CNPJ_A,
        ambiente: 1,
        origem: 'MANUAL',
        verificarAutorizacao: false,
        verificarMutex: true
      });
      // Dentro do ALS o mutex é reentrante — simula outro dono via syncExecucao.
      return r;
    });
    assert.equal(locked.ok, true);

    const syncFake = {
      estaExecutando: () => true,
      obterEstado: () => ({ lockDono: 'sync:BACKGROUND' })
    };
    const d2 = new CentralConsultaDistDfeDecisaoService({
      nsuService,
      gate,
      agora: () => new Date(agoraMs),
      syncExecucao: syncFake,
      rateLimitMs: 0
    });
    const r2 = await d2.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      verificarAutorizacao: false,
      verificarMutex: true
    });
    assert.equal(r2.codigo, 'CONSULTA_EM_ANDAMENTO');
  });

  it('7) empresas diferentes mantêm cursores independentes', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat)
      VALUES (?, 1, ?, ?, ?, '656')`,
    [CNPJ_A, padNsu(10), padNsu(10), new Date(agoraMs + 3600_000).toISOString()]);
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_B, padNsu(45), padNsu(45)]);

    const rA = await decisao.diagnosticarEmpresa({
      empresaId: EMP_A, cnpj: CNPJ_A, ambiente: 1
    });
    const rB = await decisao.diagnosticarEmpresa({
      empresaId: EMP_B, cnpj: CNPJ_B, ambiente: 1
    });
    assert.equal(rA.codigo, 'COOLDOWN_ATIVO');
    assert.equal(rB.codigo, 'PRONTO_PARA_CONSULTA');
    assert.equal(rA.detalhe.ultNsu, padNsu(10));
    assert.equal(rB.detalhe.ultNsu, padNsu(45));
  });

  it('8) recuperação XML não contorna cooldown NSU (config legado não autoriza ciclo)', () => {
    const cfg = lerConfigDeMapa({ recuperacao_xml_ativa: true });
    assert.equal(cfg.ativa, false);
    assert.equal(cfg.autorizaTransmissaoSefaz, false);
    assert.equal(cfg.valorLegadoPersistido, true);
  });

  it('9) falha do Gate gera fail-closed na decisão', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_A, padNsu(1), padNsu(1)]);
    const gateQuebra = {
      avaliarBloqueioContexto: async () => {
        throw new Error('gate_boom');
      }
    };
    const d = new CentralConsultaDistDfeDecisaoService({
      nsuService,
      gate: gateQuebra,
      agora: () => new Date(agoraMs),
      rateLimitMs: 0
    });
    const r = await d.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      verificarAutorizacao: false,
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'GATE_INDISPONIVEL');
  });

  it('10) reinicialização não provoca rajada (rate limit local)', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_A, padNsu(1), padNsu(1)]);
    const auth = criarAutorizacaoTesteIsolado({ empresaId: EMP_A });
    const r1 = await decisao.avaliar({
      empresaId: EMP_A, cnpj: CNPJ_A, ambiente: 1,
      autorizacaoTransmissaoSefaz: auth,
      verificarAutorizacao: true,
      verificarMutex: false
    });
    assert.equal(r1.codigo, 'PRONTO_PARA_CONSULTA');
    decisao.registrarTentativaLocal({ empresaId: EMP_A, cnpj: CNPJ_A, ambiente: 1 });
    const r2 = await decisao.avaliar({
      empresaId: EMP_A, cnpj: CNPJ_A, ambiente: 1,
      autorizacaoTransmissaoSefaz: auth,
      verificarAutorizacao: true,
      verificarMutex: false
    });
    assert.equal(r2.codigo, 'RATE_LIMIT_ATIVO');
  });

  it('11) fluxo controlado não ignora cooldown (origem CONSULTA_DFE_REAL)', async () => {
    const ate = new Date(agoraMs + 60 * 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat)
      VALUES (?, 1, ?, ?, ?, '656')`,
    [CNPJ_A, padNsu(5), padNsu(5), ate]);
    const r = await decisao.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP_A }),
      verificarMutex: false
    });
    assert.equal(r.codigo, 'COOLDOWN_ATIVO');
    assert.equal(r.permitido, false);
  });

  it('12) testes não abrem o banco oficial', () => {
    assert.ok(isolamento.dbDir);
    assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(isolamento.dbDir), false);
    assert.throws(
      () => new sqlite3.Database(path.join('C:\\ProgramData\\MercantilFiscal\\dados', 'mercadao.db')),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
        || /banco oficial bloqueado/i.test(String(err.message))
    );
  });

  it('Gate 656 também bloqueia mesmo com NSU cooldown vencido', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate)
      VALUES (?, 1, ?, ?, ?)`,
    [CNPJ_A, padNsu(1), padNsu(1), new Date(agoraMs - 1000).toISOString()]);
    gate.registrarBloqueio656Contexto(
      { empresaId: EMP_A, cnpj: CNPJ_A, ambiente: 1 },
      { origem: 'teste' }
    );
    const r = await decisao.diagnosticarEmpresa({
      empresaId: EMP_A, cnpj: CNPJ_A, ambiente: 1
    });
    assert.equal(r.codigo, 'COOLDOWN_ATIVO');
  });

  it('SyncExecucao: falha do Gate não é engolida (fail-closed)', async () => {
    const sync = new CentralSyncExecucaoService({
      nsuService,
      nsuRepository: new CentralNsuRepository({ db }),
      sincronizacaoService: {
        sincronizar: async () => {
          throw new Error('nao_deveria_sincronizar');
        }
      },
      configuracaoService: {
        verificarHorarioPermitido: async () => ({ permitido: true }),
        obterResumo: async () => ({ syncMaxDocumentos: 10, notificarNovasNotas: false })
      },
      notificacoesService: { notificarSyncConcluida: async () => {} },
      emitirEvento: async () => {},
      emitirSefazConsulta: () => {},
      mutexTransmissaoSefaz: obterMutexTransmissaoSefaz()
    });
    // Injeta Gate que quebra via monkey-patch do require cache — usa opção
    // ignorarBloqueio656 false e stub do módulo já carregado.
    const gateMod = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
    const original = gateMod.autorizarConsultaDistDfe;
    gateMod.autorizarConsultaDistDfe = async () => {
      throw new Error('gate_offline');
    };
    try {
      const r = await sync.executar({ origem: 'MANUAL', empresaId: EMP_A });
      assert.equal(r.consultaExecutada, false);
      assert.equal(r.codigo, 'GATE_INDISPONIVEL');
    } finally {
      gateMod.autorizarConsultaDistDfe = original;
    }
  });
});
