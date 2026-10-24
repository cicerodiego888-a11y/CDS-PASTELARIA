/**
 * CE-PASTELARIA-04 — Correção operacional da Central de Entradas.
 * Isolado: mocks, :memory:, sem SEFAZ, sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
 *   tests/central-entradas/ce-pastelaria-04-correcao-operacional-central.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-ce-p04-');

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
const CentralDfePersistenciaService = require(
  '../../backend/motores/central-entradas/services/CentralDfePersistenciaService'
);
const { obterMutexTransmissaoSefaz } = require('../../backend/services/fiscal/SefazTransmissaoMutex');
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const {
  avaliarPrecondicoesRecuperacaoNfe4456,
  decidirPosDistDfeRecuperacao4456,
  CHAVE_NFE_4456
} = require('../../backend/motores/central-entradas/procedures/preparacaoRecuperacaoNfe4456');

const ROOT = path.join(__dirname, '../..');
const EMP1 = 1;
const EMP2 = 2;
const EMP3 = 3;
const CNPJ1 = '38204469000123';
const CNPJ2 = '38204469000204'.replace(/04$/, '15'); // placeholder distinto
const CNPJ3 = '38204469000204';
const FIXO = new Date('2026-10-19T12:00:00.000Z');

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
      numero TEXT,
      serie TEXT,
      modelo TEXT,
      cnpj_fornecedor TEXT,
      data_emissao TEXT,
      valor_total REAL,
      xml TEXT,
      nsu TEXT,
      origem TEXT,
      status TEXT,
      tipo_documento TEXT,
      empresa_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave, empresa_id)
    )
  `);
  return db;
}

describe('CE-PASTELARIA-04 — correção operacional', () => {
  let db;
  let nsuService;
  let eventosRepo;
  let decisao;
  let gate;
  let agoraMs;
  let eventosGravados;

  beforeEach(async () => {
    db = await criarDb();
    agoraMs = FIXO.getTime();
    const agora = () => new Date(agoraMs);
    eventosRepo = new CentralEventosRepository({ db });
    eventosGravados = [];
    nsuService = new CentralNsuService({
      nsuRepository: new CentralNsuRepository({ db }),
      agora,
      eventosRepository: eventosRepo,
      emitirEventoObrigatorio: async (dados) => {
        const ev = await eventosRepo.inserir(dados);
        eventosGravados.push(ev);
        return ev;
      }
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

  it('1) BACKGROUND sem autorização válida bloqueia', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ3, padNsu(1), padNsu(10)]);
    const r = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'background',
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'AUTORIZACAO_AUSENTE');
  });

  it('2) BACKGROUND com cooldown ativo bloqueia', async () => {
    const ate = new Date(agoraMs + 30 * 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ3, padNsu(35), padNsu(35), ate]);
    const r = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'background',
      autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'COOLDOWN_ATIVO');
  });

  it('3) BACKGROUND com fila esgotada bloqueia', async () => {
    const ate = new Date(agoraMs - 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?, ?)`,
    [CNPJ3, padNsu(35), padNsu(35), ate, FIXO.toISOString()]);
    const r = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'background',
      autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'FILA_ESGOTADA');
  });

  it('4) sincronização ao abrir com fila esgotada bloqueia', async () => {
    const ate = new Date(agoraMs - 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '137', ?, ?)`,
    [CNPJ3, padNsu(35), padNsu(35), ate, FIXO.toISOString()]);
    const r = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'abrir_central',
      autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'FILA_ESGOTADA');
  });

  it('5) bypass forcar/ignorarCooldown não existe na decisão sync', () => {
    const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
    assert.match(sync, /verificarAutorizacao:\s*true/);
    assert.match(sync, /permitirSemAutorizacao:\s*false/);
    assert.match(sync, /forcar.*NÃO bypassam|NÃO bypassam/i);
    const exec = src('backend/motores/central-entradas/services/CentralSyncExecucaoService.js');
    assert.match(exec, /forcar.*NÃO liberam DistDFe|NÃO liberam DistDFe/i);
    const decisaoSrc = src('backend/motores/central-entradas/services/CentralConsultaDistDfeDecisaoService.js');
    assert.match(decisaoSrc, /origemExigeAuth/);
    assert.match(decisaoSrc, /background/);
  });

  it('6) falha na leitura de NSU bloqueia (fail-closed)', async () => {
    const d = new CentralConsultaDistDfeDecisaoService({
      nsuService: {
        buscarPorCnpjAmbiente: async () => { throw new Error('nsu_boom'); },
        avaliarCooldown: () => ({ ativo: false })
      },
      gate,
      agora: () => new Date(agoraMs),
      rateLimitMs: 0
    });
    const r = await d.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'background',
      autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'NSU_INDISPONIVEL');
  });

  it('7) concorrência entre duas instâncias (mutex)', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ3, padNsu(1), padNsu(10)]);
    const mutex = obterMutexTransmissaoSefaz();
    const dentro = await mutex.comLock('ce04-a', async () => {
      const syncFake = {
        estaExecutando: () => true,
        obterEstado: () => ({ lockDono: 'sync:background' })
      };
      const d2 = new CentralConsultaDistDfeDecisaoService({
        nsuService,
        gate,
        agora: () => new Date(agoraMs),
        syncExecucao: syncFake,
        rateLimitMs: 0
      });
      return d2.avaliar({
        empresaId: EMP3,
        cnpj: CNPJ3,
        ambiente: 1,
        origem: 'CONSULTA_DFE_REAL',
        autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
        verificarMutex: true
      });
    }, { cnpj: CNPJ3, ambiente: 1, tipo: 'distNSU' });
    assert.equal(dentro.ok, true);
    assert.equal(dentro.valor.codigo, 'CONSULTA_EM_ANDAMENTO');
  });

  it('8) liberação administrativa sem transmissão', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ3, padNsu(35), padNsu(35), FIXO.toISOString()]);
    const c = await nsuService.buscarPorCnpjAmbiente(CNPJ3, 1);
    const out = await nsuService.liberarFilaEsgotadaAutorizada({
      controle: c,
      confirmacaoLiberacaoFila: true,
      autorizacao: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      empresaId: EMP3,
      usuarioId: 77,
      motivo: 'teste_ce04',
      origem: 'liberacao_admin_central_ui',
      correlationId: 'corr-ce04-lib-1'
    });
    assert.equal(out.sucesso, true);
    assert.equal(out.consultaExecutada, false);
    assert.equal(out.sefazConsultada, false);
    assert.equal(out.ultNsu, padNsu(35));
    assert.equal(out.ultimoCstat, 'FILA_LIBERADA_OP');
  });

  it('9) evento liberação com empresa e correlação', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ3, padNsu(35), padNsu(35), FIXO.toISOString()]);
    const c = await nsuService.buscarPorCnpjAmbiente(CNPJ3, 1);
    const out = await nsuService.liberarFilaEsgotadaAutorizada({
      controle: c,
      confirmacaoLiberacaoFila: true,
      autorizacao: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      empresaId: EMP3,
      usuarioId: 77,
      correlationId: 'corr-ce04-evt-9',
      origem: 'liberacao_admin_central_ui'
    });
    assert.equal(TIPOS_EVENTO.FILA_ESGOTADA_LIBERACAO_OP, 'FILA_ESGOTADA_LIBERACAO_OP');
    assert.ok(out.eventoId);
    const ev = await eventosRepo.buscarPorTipoECorrelationId(
      TIPOS_EVENTO.FILA_ESGOTADA_LIBERACAO_OP,
      'corr-ce04-evt-9'
    );
    assert.ok(ev);
    assert.equal(ev.detalhe.empresaId, EMP3);
    assert.equal(ev.detalhe.cnpj, CNPJ3);
    assert.equal(ev.detalhe.correlationId, 'corr-ce04-evt-9');
    assert.equal(ev.detalhe.estadoAnterior.ultimoCstat, '656');
    assert.equal(ev.detalhe.estadoPosterior.ultimoCstat, 'FILA_LIBERADA_OP');
    assert.equal(ev.detalhe.sefazConsultada, false);
  });

  it('10) falha no registro do evento reverte liberação', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ3, padNsu(35), padNsu(35), FIXO.toISOString()]);
    const nsuFalhou = new CentralNsuService({
      nsuRepository: new CentralNsuRepository({ db }),
      agora: () => new Date(agoraMs),
      eventosRepository: eventosRepo,
      emitirEventoObrigatorio: async () => {
        throw new Error('evento_indisponivel');
      }
    });
    const c = await nsuFalhou.buscarPorCnpjAmbiente(CNPJ3, 1);
    await assert.rejects(
      () => nsuFalhou.liberarFilaEsgotadaAutorizada({
        controle: c,
        confirmacaoLiberacaoFila: true,
        autorizacao: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
        empresaId: EMP3,
        correlationId: 'corr-fail-evt'
      }),
      (e) => e.code === 'EVENTO_LIBERACAO_FALHOU'
    );
    const pos = await nsuFalhou.buscarPorCnpjAmbiente(CNPJ3, 1);
    assert.equal(pos.ultimoCstat, '656');
  });

  it('11) proteção contra evento duplicado (mesma correlação)', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ3, padNsu(35), padNsu(35), FIXO.toISOString()]);
    const c = await nsuService.buscarPorCnpjAmbiente(CNPJ3, 1);
    const a = await nsuService.liberarFilaEsgotadaAutorizada({
      controle: c,
      confirmacaoLiberacaoFila: true,
      autorizacao: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      empresaId: EMP3,
      correlationId: 'corr-dup-11'
    });
    assert.equal(a.sucesso, true);
    const b = await nsuService.liberarFilaEsgotadaAutorizada({
      controle: await nsuService.buscarPorCnpjAmbiente(CNPJ3, 1),
      confirmacaoLiberacaoFila: true,
      autorizacao: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      empresaId: EMP3,
      correlationId: 'corr-dup-11'
    });
    assert.equal(b.eventoDuplicadoEvitado, true);
    const rows = await all(db,
      `SELECT id FROM central_entradas_eventos WHERE tipo = ?`,
      [TIPOS_EVENTO.FILA_ESGOTADA_LIBERACAO_OP]);
    assert.equal(rows.length, 1);
  });

  it('12) isolamento empresas 1, 2 e 3 na decisão', async () => {
    const ate = new Date(agoraMs + 3600_000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate)
      VALUES (?, 1, ?, ?, '656', ?)`,
    [CNPJ1, padNsu(10), padNsu(10), ate]);
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu) VALUES (?, 1, ?, ?)`,
    [CNPJ3, padNsu(1), padNsu(20)]);

    const r1 = await decisao.diagnosticarEmpresa({
      empresaId: EMP1, cnpj: CNPJ1, ambiente: 1
    });
    const r3 = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP3 },
      verificarMutex: false
    });
    assert.equal(r1.codigo, 'COOLDOWN_ATIVO');
    assert.equal(r3.codigo, 'PRONTO_PARA_CONSULTA');

    const cruzado = await decisao.avaliar({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP1 },
      verificarMutex: false
    });
    assert.equal(cruzado.permitido, false);
    assert.equal(cruzado.codigo, 'AUTORIZACAO_AUSENTE');
  });

  it('13) persistência vinculada à empresa correta', async () => {
    const docs = [];
    const repo = {
      async buscarPorChave(chave, empresaId) {
        return docs.find((d) => d.chave === chave && d.empresa_id === empresaId) || null;
      },
      async criar(dados) {
        const row = {
          id: docs.length + 1,
          chave: dados.chave,
          empresa_id: dados.empresaId != null ? dados.empresaId : dados.empresa_id,
          xml: dados.xml || '<nfe/>'
        };
        docs.push(row);
        return row;
      },
      async atualizar() { return null; }
    };
    const svc = new CentralDfePersistenciaService({
      empresaId: EMP3,
      documentosRepository: repo,
      db: { get: (sql, params, cb) => cb(null, null) }
    });
    // Isolamento por (chave, empresa_id): mesma chave em empresas distintas não colide.
    docs.push({ id: 1, chave: CHAVE_NFE_4456, empresa_id: EMP1, xml: '<a/>' });
    const naEmp3 = await repo.buscarPorChave(CHAVE_NFE_4456, EMP3);
    assert.equal(naEmp3, null);
    const criado = await repo.criar({
      chave: CHAVE_NFE_4456,
      empresaId: EMP3,
      xml: '<nfe>4456</nfe>'
    });
    assert.equal(criado.empresa_id, EMP3);
    assert.equal((await repo.buscarPorChave(CHAVE_NFE_4456, EMP3)).empresa_id, EMP3);
    assert.equal((await repo.buscarPorChave(CHAVE_NFE_4456, EMP1)).empresa_id, EMP1);
    assert.equal(await svc.existeCompraComChave(CHAVE_NFE_4456, EMP3), false);
    assert.equal(svc._empresaIdOperacao({ empresaId: EMP3 }), EMP3);
  });

  it('14) ausência de retry automático em cStat 656 (fonte)', () => {
    const nsu = src('backend/motores/central-entradas/services/CentralNsuService.js');
    assert.match(nsu, /cStat 656.*preserva NSU|656: preserva NSU/i);
    assert.match(nsu, /NÃO avança cursor/i);
    const prep = src('backend/motores/central-entradas/procedures/preparacaoRecuperacaoNfe4456.js');
    assert.match(prep, /retryAutomatico:\s*false/);
    assert.match(prep, /interromperEmCStat/);
    const pos = decidirPosDistDfeRecuperacao4456({ cStat: '656', chavePresenteNoLote: false });
    assert.equal(pos.encerrar, true);
    assert.equal(pos.sugerirConsChNFe, false);
    assert.equal(pos.motivo, 'CSTAT_656_SEM_RETRY');
  });

  it('15) regressão proteções sprints anteriores + procedimento 4456', () => {
    const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
    assert.match(sync, /permitirSemAutorizacao:\s*false/);
    const runtime = src('backend/services/fiscal/distribuicaoDfeRuntime.js');
    assert.match(runtime, /avaliarAutorizacaoTransmissao/);
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /operacao-fiscal-real\/consultar-dfe/);
    assert.match(ui, /liberar-fila-esgotada/);
    const liberar = ui.match(/async function liberarFilaEsgotadaCentral\(\) \{[\s\S]*?\n\}/);
    assert.ok(liberar);
    assert.doesNotMatch(liberar[0], /consultar-dfe/);

    const bloq = avaliarPrecondicoesRecuperacaoNfe4456({
      empresaId: EMP3,
      cnpj: CNPJ3,
      ambiente: 1,
      cooldownAtivo: false,
      filaEsgotada: true,
      consultaEmAndamento: false,
      backgroundPodeTransmitir: false,
      preVooOk: true,
      decisaoCentralizadaFavoravel: true,
      autorizacaoOperacaoRealAtiva: true,
      confirmacaoOperador: true,
      confirmacaoHumanaEspecifica: true
    });
    assert.equal(bloq.pronto, false);
    assert.ok(bloq.bloqueios.includes('FILA_ESGOTADA'));

    const ok = avaliarPrecondicoesRecuperacaoNfe4456({
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
      confirmacaoHumanaEspecifica: true
    });
    assert.equal(ok.pronto, true);
    assert.equal(ok.regras.sefazConsultadaNestaFuncao, false);
    assert.equal(ok.chave, CHAVE_NFE_4456);
  });

  it('16) mapa estático: sync exige auth; BACKGROUND não omite decisão', () => {
    const bg = src('backend/motores/central-entradas/services/CentralSyncBackgroundService.js');
    assert.match(bg, /ORIGENS\.BACKGROUND/);
    assert.match(bg, /sync_background_bloqueada_sem_autorizacao|CE-PASTELARIA-04/);
    const tipos = src('backend/motores/central-entradas/config/centralEventosTipos.js');
    assert.match(tipos, /FILA_ESGOTADA_LIBERACAO_OP/);
  });
});
