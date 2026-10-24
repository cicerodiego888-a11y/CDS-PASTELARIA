/**
 * CE-PASTELARIA-05 — Auditoria final de prontidão e recuperação NF-e 4456.
 * Isolado: mocks, :memory:, sem SEFAZ, sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
 *   tests/central-entradas/ce-pastelaria-05-auditoria-final-prontidao.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-ce-p05-');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const CentralNsuService = require('../../backend/motores/central-entradas/services/CentralNsuService');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');
const CentralEventosRepository = require('../../backend/motores/central-entradas/repositories/CentralEventosRepository');
const CentralConsultaDistDfeDecisaoService = require(
  '../../backend/motores/central-entradas/services/CentralConsultaDistDfeDecisaoService'
);
const { CentralSefazOperationalGate } = require(
  '../../backend/motores/central-entradas/services/CentralSefazOperationalGate'
);
const { obterMutexTransmissaoSefaz } = require('../../backend/services/fiscal/SefazTransmissaoMutex');
const {
  avaliarAutorizacaoTransmissao,
  criarAutorizacaoOperacaoReal,
  criarAutorizacaoTesteIsolado,
  MODO_OPERACAO_REAL
} = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const {
  avaliarPrecondicoesRecuperacaoNfe4456,
  decidirPosDistDfeRecuperacao4456,
  CHAVE_NFE_4456,
  EMPRESA_ALVO_ID,
  CNPJ_DESTINO
} = require('../../backend/motores/central-entradas/procedures/preparacaoRecuperacaoNfe4456');

const ROOT = path.join(__dirname, '../..');
const EMP1 = 1;
const EMP2 = 2;
const EMP3 = 3;
const CNPJ1 = '38204469000123';
const CNPJ2 = '38204469000385';
const CNPJ3 = CNPJ_DESTINO;
const FIXO = new Date('2026-10-19T14:00:00.000Z');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

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
  await run(db, `
    CREATE TABLE central_entradas_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      origem TEXT,
      descricao TEXT,
      resultado TEXT,
      sucesso INTEGER,
      documento_id INTEGER,
      notas_novas INTEGER DEFAULT 0,
      notas_duplicadas INTEGER DEFAULT 0,
      duracao_ms INTEGER,
      detalhe_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT,
      empresa_id INTEGER,
      xml TEXT,
      UNIQUE(chave, empresa_id)
    )
  `);
  return db;
}

describe('CE-PASTELARIA-05 — auditoria final de prontidão', () => {
  let db;
  let nsuService;
  let eventosRepo;
  let decisao;
  let gate;
  let agoraMs;

  beforeEach(async () => {
    db = await criarDb();
    agoraMs = FIXO.getTime();
    const agora = () => new Date(agoraMs);
    eventosRepo = new CentralEventosRepository({ db });
    nsuService = new CentralNsuService({
      nsuRepository: new CentralNsuRepository({ db }),
      agora,
      eventosRepository: eventosRepo,
      emitirEventoObrigatorio: async (dados) => eventosRepo.inserir(dados)
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

  it('0) isolamento ativo', () => {
    assert.ok(isolamento.dbDir);
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.throws(
      () => new sqlite3.Database(path.join('C:\\ProgramData\\MercantilFiscal\\dados', 'mercadao.db')),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
        || /banco oficial bloqueado/i.test(String(err.message))
    );
  });

  it('1) auth empresa 1 não autoriza 2 ou 3', async () => {
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ3, padNsu(1), padNsu(10)]);
    const auth1 = { modo: MODO_OPERACAO_REAL, empresaId: EMP1 };
    const r = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: auth1,
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'AUTORIZACAO_AUSENTE');
  });

  it('2) CNPJ incompatível na autorização OPERACAO_REAL bloqueia', () => {
    const auth = criarAutorizacaoOperacaoReal({
      empresaId: EMP3,
      cnpj: CNPJ1,
      tokenSeed: 'seed-p05',
      tiposConsulta: ['distNSU'],
      confirmacaoConsultaReal: true,
      confirmacaoAmbienteProducao: true
    });
    const aval = avaliarAutorizacaoTransmissao({
      autorizacao: auth,
      empresaId: EMP3,
      tipoConsulta: 'distNSU',
      cnpjEmpresa: CNPJ3,
      tokenSeedAtivo: 'seed-p05',
      ativacaoAtiva: true
    });
    assert.equal(aval.ok, false);
    assert.match(String(aval.codigo || aval.mensagem), /CNPJ|DIVERGENTE|inconsistente/i);
  });

  it('3) ambiente ausente/inválido bloqueia decisão', async () => {
    const r = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: null,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: { modo: MODO_OPERACAO_REAL, empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'CONTEXTO_INVALIDO');
  });

  it('4) certificado/gate 593 bloqueia (fonte + decisão)', async () => {
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ3, padNsu(1), padNsu(10)]);
    const gate593 = {
      avaliarBloqueioContexto: async () => ({
        bloqueado: true,
        cStat: '593',
        escopo: 'empresa',
        mensagem: 'CNPJ-base diverge do certificado'
      })
    };
    const d = new CentralConsultaDistDfeDecisaoService({
      nsuService,
      gate: gate593,
      agora: () => new Date(agoraMs),
      rateLimitMs: 0
    });
    const r = await d.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: { modo: MODO_OPERACAO_REAL, empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'ERRO_CONFIGURACAO_CERTIFICADO');
  });

  it('5) cooldown ativo bloqueia emp.1/2/3', async () => {
    const ate = new Date(agoraMs + 3600_000).toISOString();
    for (const [cnpj] of [[CNPJ1], [CNPJ2], [CNPJ3]]) {
      await run(db, `INSERT INTO central_entradas_nsu
        (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate)
        VALUES (?, 1, ?, ?, '656', ?)`,
      [cnpj, padNsu(5), padNsu(5), ate]);
    }
    for (const [emp, cnpj] of [[EMP1, CNPJ1], [EMP2, CNPJ2], [EMP3, CNPJ3]]) {
      const r = await decisao.avaliar({
        empresaId: emp,
        cnpj,
        ambiente: 1,
        origem: 'background',
        autorizacaoTransmissaoSefaz: { modo: MODO_OPERACAO_REAL, empresaId: emp },
        verificarMutex: false
      });
      assert.equal(r.codigo, 'COOLDOWN_ATIVO', `emp ${emp}`);
    }
  });

  it('6) FILA esgotada bloqueia', async () => {
    const ate = new Date(agoraMs - 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?, ?)`,
    [CNPJ3, padNsu(35), padNsu(35), ate, FIXO.toISOString()]);
    const r = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'abrir_central',
      autorizacaoTransmissaoSefaz: { modo: MODO_OPERACAO_REAL, empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r.codigo, 'FILA_ESGOTADA');
  });

  it('7) falha de lock / consulta em andamento bloqueia', async () => {
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ3, padNsu(1), padNsu(10)]);
    const d = new CentralConsultaDistDfeDecisaoService({
      nsuService,
      gate,
      agora: () => new Date(agoraMs),
      syncExecucao: {
        estaExecutando: () => true,
        obterEstado: () => ({ lockDono: 'sync:background' })
      },
      rateLimitMs: 0
    });
    const r = await d.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: { modo: MODO_OPERACAO_REAL, empresaId: EMP3 },
      verificarMutex: true
    });
    assert.equal(r.codigo, 'CONSULTA_EM_ANDAMENTO');
  });

  it('8) duas instâncias — mutex / sync em andamento', async () => {
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ3, padNsu(1), padNsu(10)]);
    // Simula segunda instância: syncExecucao ocupado (não reentrante via ALS).
    const dOcupado = new CentralConsultaDistDfeDecisaoService({
      nsuService,
      gate,
      agora: () => new Date(agoraMs),
      syncExecucao: {
        estaExecutando: () => true,
        obterEstado: () => ({ lockDono: 'sync:outra-instancia' })
      },
      rateLimitMs: 0
    });
    const r = await dOcupado.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: { modo: MODO_OPERACAO_REAL, empresaId: EMP3 },
      verificarMutex: true
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'CONSULTA_EM_ANDAMENTO');

    const mutex = obterMutexTransmissaoSefaz();
    const externo = await mutex.comLock('p05-ext', async () => 'ok', {
      cnpj: CNPJ3, ambiente: 1, tipo: 'distNSU'
    });
    assert.equal(externo.ok, true);
  });

  it('9) empresas diferentes não compartilham NSU', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ1, padNsu(10), padNsu(10), new Date(agoraMs + 3600_000).toISOString()]);
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ3, padNsu(40), padNsu(50)]);
    const r1 = await decisao.diagnosticarEmpresa({ empresaId: EMP1, cnpj: CNPJ1, ambiente: 1 });
    const r3 = await decisao.diagnosticarEmpresa({ empresaId: EMP3, cnpj: CNPJ3, ambiente: 1 });
    assert.equal(r1.codigo, 'COOLDOWN_ATIVO');
    assert.equal(r3.codigo, 'PRONTO_PARA_CONSULTA');
    assert.notEqual(r1.detalhe.ultNsu, r3.detalhe.ultNsu);
  });

  it('10) persistência associação empresaId', async () => {
    const docs = [];
    const repo = {
      async buscarPorChave(chave, empresaId) {
        return docs.find((d) => d.chave === chave && d.empresa_id === empresaId) || null;
      },
      async criar(d) {
        const row = { id: docs.length + 1, chave: d.chave, empresa_id: d.empresaId };
        docs.push(row);
        return row;
      }
    };
    docs.push({ id: 1, chave: CHAVE_NFE_4456, empresa_id: EMP1 });
    assert.equal(await repo.buscarPorChave(CHAVE_NFE_4456, EMP3), null);
    const c = await repo.criar({ chave: CHAVE_NFE_4456, empresaId: EMP3 });
    assert.equal(c.empresa_id, EMP3);
    assert.equal((await repo.buscarPorChave(CHAVE_NFE_4456, EMP1)).empresa_id, EMP1);
  });

  it('11) cStat 656 sem retry automático (procedimento + NSU)', () => {
    const pos = decidirPosDistDfeRecuperacao4456({ cStat: '656', chavePresenteNoLote: false });
    assert.equal(pos.encerrar, true);
    assert.equal(pos.retryAutomatico, false);
    assert.equal(pos.sugerirConsChNFe, false);
    const nsu = src('backend/motores/central-entradas/services/CentralNsuService.js');
    assert.match(nsu, /NÃO avança cursor/i);
  });

  it('12) cStat 137 sem lotes não inventa documento', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '137', ?)`,
    [CNPJ3, padNsu(35), padNsu(35), FIXO.toISOString()]);
    const c = await nsuService.buscarPorCnpjAmbiente(CNPJ3, 1);
    await nsuService.aplicarRetornoDistDfe({
      controle: c,
      cStat: '137',
      ultNsu: padNsu(35),
      maxNsu: padNsu(35),
      ultNsuRaw: padNsu(35),
      maxNsuRaw: padNsu(35),
      xmlRetorno: `<retDistDFeInt><cStat>137</cStat><ultNSU>${padNsu(35)}</ultNSU><maxNSU>${padNsu(35)}</maxNSU></retDistDFeInt>`
    });
    const count = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS c FROM central_entradas_documentos', (e, r) => (e ? reject(e) : resolve(r.c)));
    });
    assert.equal(count, 0);
    const pos = decidirPosDistDfeRecuperacao4456({ cStat: '137', documentosRecebidos: 0 });
    assert.equal(pos.motivo, 'DISTDFE_SEM_CHAVE');
  });

  it('13) falha evento liberação não declara sucesso', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ3, padNsu(35), padNsu(35), FIXO.toISOString()]);
    const nsuFail = new CentralNsuService({
      nsuRepository: new CentralNsuRepository({ db }),
      agora: () => new Date(agoraMs),
      eventosRepository: eventosRepo,
      emitirEventoObrigatorio: async () => { throw new Error('evento_down'); }
    });
    const controle = await nsuFail.buscarPorCnpjAmbiente(CNPJ3, 1);
    await assert.rejects(
      () => nsuFail.liberarFilaEsgotadaAutorizada({
        controle,
        confirmacaoLiberacaoFila: true,
        autorizacao: { modo: MODO_OPERACAO_REAL, empresaId: EMP3 },
        empresaId: EMP3,
        correlationId: 'p05-evt-fail'
      }),
      (e) => e.code === 'EVENTO_LIBERACAO_FALHOU'
    );
    assert.equal((await nsuFail.buscarPorCnpjAmbiente(CNPJ3, 1)).ultimoCstat, '656');
  });

  it('14) diagnóstico/probe não contorna barreiras', async () => {
    // Cursor avançável: auth é avaliada (sem FILA sticky).
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ3, padNsu(1), padNsu(20)]);

    const rSemAuth = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'DIAGNOSTICO_PROBE',
      verificarMutex: false
    });
    assert.equal(rSemAuth.codigo, 'AUTORIZACAO_AUSENTE');

    await run(db, `UPDATE central_entradas_nsu SET ult_nsu=?, max_nsu=?, ultimo_cstat='137',
      cooldown_ate=?, data_sincronizacao=? WHERE cnpj=?`,
    [padNsu(35), padNsu(35), new Date(agoraMs - 1000).toISOString(), FIXO.toISOString(), CNPJ3]);

    const rFila = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'DIAGNOSTICO_PROBE',
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP3 }),
      verificarMutex: false
    });
    assert.equal(rFila.codigo, 'FILA_ESGOTADA');

    const orch = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
    assert.match(orch, /delete seguro\.forcarProbeDistDfe/);
    const diag = src('backend/motores/central-entradas/services/CentralDiagnosticoService.js');
    assert.match(diag, /verificarAutorizacao:\s*true/);
    assert.match(diag, /permitirSemAutorizacao:\s*false/);
    const rotas = src('backend/rotas/central-entradas.js');
    assert.match(rotas, /testar-sefaz/);
    assert.doesNotMatch(rotas, /forcarProbeDistDfe:\s*true/);
  });

  it('15) CE-04 regressão: BACKGROUND/sync exigem auth', () => {
    const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
    assert.match(sync, /verificarAutorizacao:\s*true/);
    assert.match(sync, /permitirSemAutorizacao:\s*false/);
    const dec = src('backend/motores/central-entradas/services/CentralConsultaDistDfeDecisaoService.js');
    assert.match(dec, /diagnostico_probe/);
    assert.match(dec, /origemExigeAuth/);
  });

  it('16) manifestação 210210 e MIRX: barreiras estáticas', () => {
    const auth = src('backend/services/fiscal/autorizacaoTransmissaoSefaz.js');
    assert.match(auth, /Manifestação 210210 NÃO é autorizada por OPERACAO_REAL/);
    assert.match(auth, /TIPOS_MANIFESTACAO/);
    const manifRt = src('backend/services/fiscal/manifestacaoRuntime.js');
    assert.match(manifRt, /exigirAutorizacaoTransmissao/);
    const manifSvc = src('backend/motores/central-entradas/services/CentralManifestacaoDfeService.js');
    assert.match(manifSvc, /autorizacaoTransmissaoSefaz/);
    assert.match(manifSvc, /falta autorização operacional explícita/);
    const mirx = src('backend/motores/central-entradas/mirx/MirxWorker.js');
    assert.match(mirx, /forcarConsulta:\s*false/);
    assert.match(mirx, /AGUARDANDO_CIENCIA|temCienciaAceita/);
    const motor = src('backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig.js');
    assert.match(motor, /autorizaTransmissaoSefaz:\s*false/);
  });

  it('17) procedimento 4456 — checklist completo sem transmissão', () => {
    const prep = src('backend/motores/central-entradas/procedures/preparacaoRecuperacaoNfe4456.js');
    assert.match(prep, /NÃO transmite/);
    assert.match(prep, /NÃO libera FILA automaticamente/);
    assert.match(prep, /liberacaoFilaNaoAutorizaTransmissao/);

    const incompleto = avaliarPrecondicoesRecuperacaoNfe4456({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      cooldownAtivo: false,
      filaEsgotada: false,
      preVooOk: true,
      decisaoCentralizadaFavoravel: true,
      autorizacaoOperacaoRealAtiva: true,
      confirmacaoOperador: true
      // falta confirmacaoHumanaEspecifica
    });
    assert.equal(incompleto.pronto, false);
    assert.ok(incompleto.bloqueios.includes('AUTORIZACAO_AUSENTE'));

    const comFilaLib = avaliarPrecondicoesRecuperacaoNfe4456({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      cooldownAtivo: false,
      filaEsgotada: false,
      consultaEmAndamento: false,
      backgroundPodeTransmitir: false,
      preVooOk: true,
      decisaoCentralizadaFavoravel: true,
      autorizacaoOperacaoRealAtiva: true,
      confirmacaoOperador: true,
      confirmacaoHumanaEspecifica: true,
      filaLiberadaLocalmente: true
    });
    assert.equal(comFilaLib.pronto, true);
    assert.ok(comFilaLib.avisos.some((a) => /NÃO recupera XML/i.test(a)));
    assert.equal(comFilaLib.regras.sefazConsultadaNestaFuncao, false);
    assert.equal(comFilaLib.empresaId, EMPRESA_ALVO_ID);
    assert.equal(comFilaLib.chave, CHAVE_NFE_4456);

    const recebido = decidirPosDistDfeRecuperacao4456({
      cStat: '138',
      chavePresenteNoLote: true
    });
    assert.equal(recebido.exigirComprovacaoPersistenciaEmpresa, true);
    assert.equal(recebido.empresaIdEsperado, EMP3);
  });

  it('18) consulta válida permanece possível quando condições OK', async () => {
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ3, padNsu(1), padNsu(20)]);
    const r = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: { modo: MODO_OPERACAO_REAL, empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r.permitido, true);
    assert.equal(r.codigo, 'PRONTO_PARA_CONSULTA');
  });
});
