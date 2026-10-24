/**
 * Sprint final CE-ENCERRAMENTO-01 — estabilização Central de Entradas.
 * Isolado: mocks, :memory:, temp locks, sem SEFAZ, sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
 *   tests/central-entradas/sprint-final-ce-encerramento-01.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-ce-enc-');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
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
const {
  SefazTransmissaoMutex,
  obterMutexTransmissaoSefaz
} = require('../../backend/services/fiscal/SefazTransmissaoMutex');
const { criarAutorizacaoTesteIsolado } = require(
  '../../backend/services/fiscal/autorizacaoTransmissaoSefaz'
);
const { createDistribuicaoDfeRuntime } = require(
  '../../backend/services/fiscal/distribuicaoDfeRuntime'
);
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { lerConfigDeMapa } = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig'
);
const EMP = 11;
const CNPJ = '11111111000191';
const FIXO = new Date('2026-10-19T00:00:00.000Z');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function padNsu(n) {
  return String(n).padStart(15, '0');
}

async function criarDb() {
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

describe('CE-ENCERRAMENTO-01', () => {
  let db;
  let nsuService;
  let decisao;
  let gate;
  let agoraMs;
  let lockDir;

  beforeEach(async () => {
    db = await criarDb();
    agoraMs = FIXO.getTime();
    const agora = () => new Date(agoraMs);
    nsuService = new CentralNsuService({
      nsuRepository: new CentralNsuRepository({ db }),
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
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ce-lock-'));
  });

  afterEach(async () => {
    obterMutexTransmissaoSefaz().resetParaTeste();
    if (db) await new Promise((r) => db.close(() => r()));
    try {
      for (const f of fs.readdirSync(lockDir)) fs.unlinkSync(path.join(lockDir, f));
      fs.rmdirSync(lockDir);
    } catch { /* ignore */ }
  });

  it('1) 656 + ult=max + cooldown expirado → bloqueado FILA_ESGOTADA', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, ?, '656', ?)`,
    [CNPJ, padNsu(196), padNsu(196), new Date(agoraMs - 1000).toISOString(),
      new Date(agoraMs - 2 * 3600_000).toISOString()]);
    const r = await decisao.avaliar({
      empresaId: EMP, cnpj: CNPJ, ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP }),
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'FILA_ESGOTADA');
  });

  it('2) cooldown explícito ativo bloqueia', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, ?, '656', ?)`,
    [CNPJ, padNsu(196), padNsu(196), new Date(agoraMs + 3600_000).toISOString(), FIXO.toISOString()]);
    const r = await decisao.avaliar({
      empresaId: EMP, cnpj: CNPJ, ambiente: 1,
      verificarAutorizacao: false, verificarMutex: false
    });
    assert.equal(r.codigo, 'COOLDOWN_ATIVO');
    assert.equal(r.motivoCooldown, 'COOLDOWN_EXPLICITO');
  });

  it('3) 137 fila esgotada', () => {
    const cd = nsuService.avaliarCooldown({
      ultNsu: padNsu(8), maxNsu: padNsu(8), ultimoCstat: '137',
      dataSincronizacao: FIXO.toISOString()
    });
    assert.equal(cd.motivo, 'FILA_ESGOTADA');
  });

  it('4) 138 com ult<max não é FILA; ult=max é FILA', () => {
    assert.equal(nsuService.avaliarCooldown({
      ultNsu: padNsu(5), maxNsu: padNsu(20), ultimoCstat: '138',
      dataSincronizacao: FIXO.toISOString()
    }).ativo, false);
    assert.equal(nsuService.avaliarCooldown({
      ultNsu: padNsu(20), maxNsu: padNsu(20), ultimoCstat: '138',
      dataSincronizacao: FIXO.toISOString()
    }).motivo, 'FILA_ESGOTADA');
  });

  it('5) maxNSU=0 remoto em 656 preserva cursor', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ, padNsu(196), padNsu(196)]);
    const c = await nsuService.buscarPorCnpjAmbiente(CNPJ, 1);
    const out = await nsuService.aplicarRetornoDistDfe({
      controle: c, cStat: '656', ultNsu: padNsu(0), maxNsu: padNsu(0),
      xmlRetorno: '<retDistDFeInt><cStat>656</cStat><ultNSU>0</ultNSU><maxNSU>0</maxNSU></retDistDFeInt>'
    });
    assert.equal(out.controle.ultNsu, padNsu(196));
    assert.equal(out.controle.maxNsu, padNsu(196));
  });

  it('6) avanço de cursor reavalia FILA', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ, padNsu(196), padNsu(196), FIXO.toISOString()]);
    assert.equal((await decisao.diagnosticarEmpresa({
      empresaId: EMP, cnpj: CNPJ, ambiente: 1
    })).codigo, 'FILA_ESGOTADA');
    await run(db, `UPDATE central_entradas_nsu SET ult_nsu=?, max_nsu=?, ultimo_cstat='138'
      WHERE cnpj=?`, [padNsu(196), padNsu(250), CNPJ]);
    const r = await decisao.avaliar({
      empresaId: EMP, cnpj: CNPJ, ambiente: 1,
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP }),
      verificarMutex: false
    });
    assert.equal(r.codigo, 'PRONTO_PARA_CONSULTA');
    assert.match(r.mensagem, /não implica aceitação/i);
  });

  it('7) NSU inconsistente fail-closed', () => {
    assert.equal(nsuService.avaliarCooldown({
      ultNsu: padNsu(50), maxNsu: padNsu(10), ultimoCstat: '137',
      dataSincronizacao: FIXO.toISOString()
    }).motivo, 'ESTADO_NSU_INCONSISTENTE');
  });

  it('8) forcar/ignorarCooldown não contornam', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ, padNsu(196), padNsu(196), FIXO.toISOString()]);
    let soap = 0;
    const sync = new CentralSincronizacaoService({
      gate: null, nsuService, decisaoDistDfe: decisao,
      configuracaoService: {
        obterContextoOperacional: async () => ({
          ok: true, contexto: { cnpj: CNPJ, ambiente: 1, syncMaxDocumentos: 10 }
        })
      },
      sincronizarDistribuicaoDFe: async () => { soap += 1; return { sucesso: true, consultaExecutada: true }; }
    });
    const r = await sync._sincronizarEmpresa(
      { empresaId: EMP, cnpj: CNPJ },
      { modo: ModoOperacionalGlobal.EMPRESA_SIMPLES, forcar: true, ignorarCooldown: true, origem: 'MANUAL' }
    );
    assert.equal(soap, 0);
    assert.equal(r.codigoDecisao, 'FILA_ESGOTADA');
  });

  it('9) runtime DistDFe sem auth não transmite', async () => {
    let legado = 0;
    const rt = createDistribuicaoDfeRuntime({
      legadoSender: async () => { legado += 1; return { success: true, body: '<ok/>' }; },
      platform: {
        resolve: () => ({ success: false }),
        getSoapTransport: () => ({ getFactory: () => ({ createRequest: () => ({}) }) })
      }
    });
    const out = await rt.enviarDistribuicaoDfe({
      xmlConsulta: '<distDFeInt/>', ambiente: 1, empresaId: EMP
    });
    assert.equal(out.success, false);
    assert.equal(out.bloqueadoAutorizacao, true);
    assert.equal(legado, 0);
  });

  it('10) probe/runtime com auth mas decisão FILA — caminhos documentados', () => {
    const diag = fs.readFileSync(
      path.join(__dirname, '../../backend/motores/central-entradas/services/CentralDiagnosticoService.js'),
      'utf8'
    );
    assert.match(diag, /bloqueadoPelaDecisao/);
    assert.match(diag, /GATE_INDISPONIVEL/);
    assert.doesNotMatch(diag, /segue probe se gate indisponível/);
    const runtime = fs.readFileSync(
      path.join(__dirname, '../../backend/services/fiscal/distribuicaoDfeRuntime.js'),
      'utf8'
    );
    assert.match(runtime, /avaliarAutorizacaoTransmissao/);
  });

  it('11) empresa/ambiente ausentes bloqueiam', async () => {
    const r = await decisao.avaliar({
      cnpj: CNPJ, ambiente: 1, verificarMutex: false, verificarAutorizacao: false
    });
    assert.equal(r.codigo, 'EMPRESA_INVALIDA');
  });

  it('12) mutex interprocesso impede segunda transmissão', async () => {
    const m1 = new SefazTransmissaoMutex({ lockDir, interprocesso: true });
    const m2 = new SefazTransmissaoMutex({ lockDir, interprocesso: true });
    const escopo = { cnpj: CNPJ, ambiente: 1, tipo: 'distNSU' };
    const p = m1.comLock('proc1', async () => {
      await new Promise((r) => setTimeout(r, 80));
      return 'ok';
    }, escopo);
    await new Promise((r) => setTimeout(r, 10));
    const blocked = await m2.comLock('proc2', async () => 'nope', escopo);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.codigo, 'TRANSMISSAO_SEFAZ_EM_ANDAMENTO');
    assert.equal((await p).ok, true);
    m1.resetParaTeste();
    m2.resetParaTeste();
  });

  it('13) Gate indisponível na decisão → fail-closed', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ, padNsu(1), padNsu(2)]);
    const d = new CentralConsultaDistDfeDecisaoService({
      nsuService,
      gate: { avaliarBloqueioContexto: async () => { throw new Error('down'); } },
      agora: () => new Date(agoraMs),
      rateLimitMs: 0
    });
    const r = await d.avaliar({
      empresaId: EMP, cnpj: CNPJ, ambiente: 1,
      verificarAutorizacao: false, verificarMutex: false
    });
    assert.equal(r.codigo, 'GATE_INDISPONIVEL');
  });

  it('14) recuperação XML legado não autoriza DistDFe', () => {
    const cfg = lerConfigDeMapa({ recuperacao_xml_ativa: true });
    assert.equal(cfg.ativa, false);
    assert.equal(cfg.autorizaTransmissaoSefaz, false);
  });

  it('15) liberação operacional não envia SOAP e não altera NSU', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ, padNsu(196), padNsu(196), FIXO.toISOString()]);
    const c = await nsuService.buscarPorCnpjAmbiente(CNPJ, 1);
    const lib = await nsuService.liberarFilaEsgotadaAutorizada({
      controle: c,
      confirmacaoLiberacaoFila: true,
      autorizacao: criarAutorizacaoTesteIsolado({ empresaId: EMP }),
      empresaId: EMP
    });
    assert.equal(lib.ultNsu, padNsu(196));
    assert.equal(lib.sefazConsultada, false);
    assert.equal(lib.controle.ultimoCstat, 'FILA_LIBERADA_OP');
  });

  it('16) liberação sem confirmação falha; forcar não existe nesse fluxo', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ, padNsu(196), padNsu(196), FIXO.toISOString()]);
    const c = await nsuService.buscarPorCnpjAmbiente(CNPJ, 1);
    await assert.rejects(
      () => nsuService.liberarFilaEsgotadaAutorizada({
        controle: c, autorizacao: criarAutorizacaoTesteIsolado({ empresaId: EMP })
      }),
      (e) => e.code === 'CONFIRMACAO_LIBERACAO_FILA_OBRIGATORIA'
    );
  });

  it('17) auditoria/eventos: empresaId no detalhe (fonte)', () => {
    const emitter = fs.readFileSync(
      path.join(__dirname, '../../backend/motores/central-entradas/utils/centralEventosEmitter.js'),
      'utf8'
    );
    assert.match(emitter, /detalheBase\.empresaId/);
    const dist = fs.readFileSync(
      path.join(__dirname, '../../backend/services/fiscal/distribuicaoDFe.js'),
      'utf8'
    );
    assert.match(dist, /empresa_id: empresaIdAudit/);
    assert.match(dist, /empresaId: empresaIdAudit/);
  });

  it('18) isolamento banco oficial', () => {
    assert.ok(isolamento.dbDir);
    assert.throws(
      () => new sqlite3.Database(path.join('C:\\ProgramData\\MercantilFiscal\\dados', 'mercadao.db')),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
        || /banco oficial bloqueado/i.test(String(err.message))
    );
  });
});
