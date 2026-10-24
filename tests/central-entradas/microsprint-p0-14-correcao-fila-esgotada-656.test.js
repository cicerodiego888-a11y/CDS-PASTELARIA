/**
 * Microsprint P0.14 — Fail-closed de FILA_ESGOTADA após cStat 656.
 * Isolado: mocks, SQLite :memory:, sem SEFAZ real, sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
 *   tests/central-entradas/microsprint-p0-14-correcao-fila-esgotada-656.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p014-fila-');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const CentralNsuService = require('../../backend/motores/central-entradas/services/CentralNsuService');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');
const CentralConsultaDistDfeDecisaoService = require(
  '../../backend/motores/central-entradas/services/CentralConsultaDistDfeDecisaoService'
);
const { CentralSefazOperationalGate } = require(
  '../../backend/motores/central-entradas/services/CentralSefazOperationalGate'
);
const CentralSincronizacaoService = require(
  '../../backend/motores/central-entradas/services/CentralSincronizacaoService'
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
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { etapaPorCodigoPreVoo } = require(
  '../../backend/motores/central-entradas/services/CentralOperacaoFiscalRealService'
);

const EMP_A = 11;
const EMP_B = 22;
const CNPJ_A = '11111111000191';
const CNPJ_B = '22222222000182';
const FIXO = new Date('2026-10-18T23:40:00.000Z');

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

describe('P0.14 — FILA_ESGOTADA fail-closed pós-656', () => {
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
    nsuService = new CentralNsuService({
      nsuRepository: repo,
      agora,
      eventosRepository: { buscarPorTipoECorrelationId: async () => null },
      emitirEventoObrigatorio: async (dados) => ({ id: 9001, ...dados })
    });
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
      rateLimitMs: 0,
      mutexTransmissaoSefaz: obterMutexTransmissaoSefaz()
    });
    decisao.resetRateLimitParaTeste();
    obterMutexTransmissaoSefaz().resetParaTeste();
  });

  afterEach(async () => {
    obterMutexTransmissaoSefaz().resetParaTeste();
    if (db) await new Promise((r) => db.close(() => r()));
  });

  it('1) ult=max + 656 + cooldown expirado NÃO libera transmissão', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, ?, '656', ?)`,
    [
      CNPJ_A,
      padNsu(196),
      padNsu(196),
      new Date(agoraMs - 1000).toISOString(),
      new Date(agoraMs - 90 * 60 * 1000).toISOString()
    ]);

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
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.sefazConsultada, false);
  });

  it('2) cooldown explícito 656 ativo continua bloqueando', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, ?, '656', ?)`,
    [
      CNPJ_A,
      padNsu(196),
      padNsu(196),
      new Date(agoraMs + 30 * 60 * 1000).toISOString(),
      FIXO.toISOString()
    ]);

    const cd = nsuService.avaliarCooldown(await nsuService.buscarPorCnpjAmbiente(CNPJ_A, 1));
    assert.equal(cd.motivo, 'COOLDOWN_EXPLICITO');

    const r = await decisao.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      origem: 'BACKGROUND',
      verificarAutorizacao: false,
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'COOLDOWN_ATIVO');
    assert.equal(r.motivoCooldown, 'COOLDOWN_EXPLICITO');
  });

  it('3) ult=max + 137 bloqueia por FILA_ESGOTADA (semântica estabelecida)', () => {
    const cd = nsuService.avaliarCooldown({
      ultNsu: padNsu(8),
      maxNsu: padNsu(8),
      ultimoCstat: '137',
      dataSincronizacao: new Date(agoraMs - 2 * 60 * 60 * 1000).toISOString()
    });
    assert.equal(cd.ativo, true);
    assert.equal(cd.motivo, 'FILA_ESGOTADA');
  });

  it('4) 138 com ult<max NÃO é FILA; 138 com ult=max É FILA', () => {
    const pendente = nsuService.avaliarCooldown({
      ultNsu: padNsu(5),
      maxNsu: padNsu(20),
      ultimoCstat: '138',
      dataSincronizacao: new Date(agoraMs - 1000).toISOString()
    });
    assert.equal(pendente.ativo, false);

    const topo = nsuService.avaliarCooldown({
      ultNsu: padNsu(20),
      maxNsu: padNsu(20),
      ultimoCstat: '138',
      dataSincronizacao: new Date(agoraMs - 1000).toISOString()
    });
    assert.equal(topo.ativo, true);
    assert.equal(topo.motivo, 'FILA_ESGOTADA');
  });

  it('5) avanço legítimo do cursor (ult≠max) reavalia e libera sem reinicializar NSU', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, NULL, '656', ?)`,
    [CNPJ_A, padNsu(196), padNsu(196), new Date(agoraMs - 2 * 60 * 60 * 1000).toISOString()]);

    assert.equal((await decisao.diagnosticarEmpresa({
      empresaId: EMP_A, cnpj: CNPJ_A, ambiente: 1
    })).codigo, 'FILA_ESGOTADA');

    // Simula evidência de cursor avançável (ex.: apply 138 anterior com max maior).
    await run(db, `UPDATE central_entradas_nsu SET ult_nsu = ?, max_nsu = ?, ultimo_cstat = '138'
      WHERE cnpj = ? AND ambiente = 1`,
    [padNsu(196), padNsu(250), CNPJ_A]);

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
    assert.equal(r.detalhe.ultNsu, padNsu(196));
    assert.equal(r.detalhe.maxNsu, padNsu(250));
  });

  it('6) estado ausente/inconsistente fail-closed (não libera)', () => {
    const semData = nsuService.avaliarCooldown({
      ultNsu: padNsu(10),
      maxNsu: padNsu(10),
      ultimoCstat: '656',
      dataSincronizacao: null,
      cooldownAte: null
    });
    assert.equal(semData.ativo, true);
    assert.equal(semData.motivo, 'ESTADO_NSU_INCONSISTENTE');

    const ultMaior = nsuService.avaliarCooldown({
      ultNsu: padNsu(50),
      maxNsu: padNsu(10),
      ultimoCstat: '137',
      dataSincronizacao: FIXO.toISOString()
    });
    assert.equal(ultMaior.ativo, true);
    assert.equal(ultMaior.motivo, 'ESTADO_NSU_INCONSISTENTE');
  });

  it('7) forcar / ignorarCooldown não contornam FILA_ESGOTADA na sync', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ_A, padNsu(196), padNsu(196), new Date(agoraMs - 2 * 60 * 60 * 1000).toISOString()]);

    let soap = 0;
    const sync = new CentralSincronizacaoService({
      gate: null,
      nsuService,
      decisaoDistDfe: decisao,
      configuracaoService: {
        obterContextoOperacional: async () => ({
          ok: true,
          contexto: { cnpj: CNPJ_A, ambiente: 1, syncMaxDocumentos: 10 }
        })
      },
      sincronizarDistribuicaoDFe: async () => {
        soap += 1;
        return { sucesso: true, consultaExecutada: true };
      }
    });

    const r = await sync._sincronizarEmpresa(
      { empresaId: EMP_A, cnpj: CNPJ_A },
      {
        modo: ModoOperacionalGlobal.EMPRESA_SIMPLES,
        forcar: true,
        ignorarCooldown: true,
        origem: 'MANUAL'
      }
    );
    assert.equal(soap, 0);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.codigoDecisao, 'FILA_ESGOTADA');
  });

  it('8) decisão bloqueada não agenda retry/SOAP (SyncExecucao)', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '137', ?)`,
    [CNPJ_A, padNsu(4), padNsu(4), new Date(agoraMs - 60 * 60 * 1000).toISOString()]);

    let syncChamadas = 0;
    const exec = new CentralSyncExecucaoService({
      nsuService,
      nsuRepository: new CentralNsuRepository({ db }),
      listarAlvosSincronizacaoCentral: async () => ({
        modo: ModoOperacionalGlobal.EMPRESA_SIMPLES,
        alvos: [{ empresaId: EMP_A, cnpj: CNPJ_A }]
      }),
      sincronizacaoService: {
        sincronizar: async () => {
          syncChamadas += 1;
          return { sucesso: true, consultaExecutada: true };
        }
      },
      configuracaoService: {
        verificarHorarioPermitido: async () => ({ permitido: true }),
        obterResumo: async () => ({ syncMaxDocumentos: 10, notificarNovasNotas: false }),
        obterContextoOperacional: async () => ({
          ok: true,
          contexto: { cnpj: CNPJ_A, ambiente: 1 }
        })
      },
      notificacoesService: { notificarSyncConcluida: async () => {} },
      emitirEvento: async () => {},
      emitirSefazConsulta: () => {},
      mutexTransmissaoSefaz: obterMutexTransmissaoSefaz()
    });

    const gateMod = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
    const orig = gateMod.autorizarConsultaDistDfe;
    gateMod.autorizarConsultaDistDfe = async () => ({ permitido: true });
    try {
      const r = await exec.executar({ origem: 'BACKGROUND', empresaId: EMP_A, ignorarHorario: true });
      assert.equal(syncChamadas, 0);
      assert.equal(r.consultaExecutada, false);
      assert.equal(r.codigoDecisao, 'FILA_ESGOTADA');
    } finally {
      gateMod.autorizarConsultaDistDfe = orig;
    }
  });

  it('9) empresas/ambientes explícitos — sem fallback global', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ_A, padNsu(196), padNsu(196), new Date(agoraMs - 2 * 60 * 60 * 1000).toISOString()]);
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_B, padNsu(1), padNsu(5)]);

    const rA = await decisao.diagnosticarEmpresa({ empresaId: EMP_A, cnpj: CNPJ_A, ambiente: 1 });
    const rB = await decisao.diagnosticarEmpresa({ empresaId: EMP_B, cnpj: CNPJ_B, ambiente: 1 });
    assert.equal(rA.codigo, 'FILA_ESGOTADA');
    assert.equal(rB.codigo, 'PRONTO_PARA_CONSULTA');

    const semEmpresa = await decisao.avaliar({
      cnpj: CNPJ_A,
      ambiente: 1,
      verificarMutex: false,
      verificarAutorizacao: false
    });
    assert.equal(semEmpresa.codigo, 'EMPRESA_INVALIDA');
  });

  it('10) motivo de bloqueio rastreável e etapa HTTP mapeada', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ_A, padNsu(196), padNsu(196), new Date(agoraMs - 2 * 60 * 60 * 1000).toISOString()]);

    const r = await decisao.avaliar({
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      correlationId: 'corr-p014',
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP_A }),
      verificarMutex: false
    });
    assert.equal(r.codigo, 'FILA_ESGOTADA');
    assert.equal(r.correlationId, 'corr-p014');
    assert.equal(r.empresaId, EMP_A);
    assert.match(r.mensagem, /fila esgotada/i);
    assert.doesNotMatch(r.mensagem, /\d{14}/);
    assert.equal(etapaPorCodigoPreVoo('FILA_ESGOTADA'), 'cooldown');
    assert.equal(etapaPorCodigoPreVoo('ESTADO_NSU_INCONSISTENTE'), 'cooldown');
  });

  it('11) 656 não avança NSU mesmo com max remoto 0/maior', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ_A, padNsu(196), padNsu(196)]);
    const controle = await nsuService.buscarPorCnpjAmbiente(CNPJ_A, 1);
    const out = await nsuService.aplicarRetornoDistDfe({
      controle,
      cStat: '656',
      ultNsu: padNsu(0),
      maxNsu: padNsu(0),
      xmlRetorno: '<retDistDFeInt><cStat>656</cStat><ultNSU>000000000000000</ultNSU><maxNSU>000000000000000</maxNSU></retDistDFeInt>'
    });
    assert.equal(out.atualizouNsu, false);
    assert.equal(out.controle.ultNsu, padNsu(196));
    assert.equal(out.controle.maxNsu, padNsu(196));
  });

  it('12) probe diagnóstico: Gate indisponível é fail-closed (código)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/motores/central-entradas/services/CentralDiagnosticoService.js'),
      'utf8'
    );
    assert.doesNotMatch(src, /segue probe se gate indisponível/);
    assert.match(src, /GATE_INDISPONIVEL/);
    assert.match(src, /bloqueadoPelaDecisao/);
    assert.match(src, /CentralConsultaDistDfeDecisaoService/);
  });

  it('13) FILA sticky — 25h depois ainda bloqueia; liberação só operacional/cursor', async () => {
    assert.equal(CentralNsuService.INTERVALO_COOLDOWN_MS, 60 * 60 * 1000);
    const dataSync = new Date(agoraMs - 25 * 60 * 60 * 1000).toISOString();
    const ainda = nsuService.avaliarCooldown({
      ultNsu: padNsu(196),
      maxNsu: padNsu(196),
      ultimoCstat: '656',
      dataSincronizacao: dataSync,
      cooldownAte: new Date(agoraMs - 20 * 60 * 60 * 1000).toISOString()
    });
    assert.equal(ainda.ativo, true);
    assert.equal(ainda.motivo, 'FILA_ESGOTADA');
    assert.equal(ainda.proximaConsultaEm, null);

    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ_A, padNsu(196), padNsu(196), dataSync]);
    const controle = await nsuService.buscarPorCnpjAmbiente(CNPJ_A, 1);
    const lib = await nsuService.liberarFilaEsgotadaAutorizada({
      controle,
      confirmacaoLiberacaoFila: true,
      autorizacao: criarAutorizacaoTesteIsolado({ empresaId: EMP_A }),
      empresaId: EMP_A,
      motivo: 'teste_encerramento'
    });
    assert.equal(lib.consultaExecutada, false);
    assert.equal(lib.sefazConsultada, false);
    const pos = nsuService.avaliarCooldown(lib.controle);
    assert.equal(pos.ativo, false);
  });

  it('14) isolamento — não abre banco oficial', () => {
    assert.ok(isolamento.dbDir);
    assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(isolamento.dbDir), false);
    assert.throws(
      () => new sqlite3.Database(path.join('C:\\ProgramData\\MercantilFiscal\\dados', 'mercadao.db')),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
        || /banco oficial bloqueado/i.test(String(err.message))
    );
  });
});
