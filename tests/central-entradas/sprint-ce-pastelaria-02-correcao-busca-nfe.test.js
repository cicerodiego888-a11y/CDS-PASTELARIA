/**
 * Sprint CE-PASTELARIA-02 — Correção do bloqueio/falha na busca de NF-e.
 * Isolado: mocks, :memory:, sem SEFAZ, sem banco oficial, sem mutar produção.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
 *   tests/central-entradas/sprint-ce-pastelaria-02-correcao-busca-nfe.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-ce-p02-');

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
const CentralOperacaoFiscalRealService = require(
  '../../backend/motores/central-entradas/services/CentralOperacaoFiscalRealService'
);
const { obterMutexTransmissaoSefaz } = require('../../backend/services/fiscal/SefazTransmissaoMutex');

const ROOT = path.join(__dirname, '../..');
const EMP = 22;
const CNPJ = '22222222000191';
const FIXO = new Date('2026-10-19T12:00:00.000Z');
const SEED = 'seed-teste-isolado-ce-pastelaria-02';

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

function memConfigRepo() {
  const mapa = new Map();
  return {
    async buscarPorChave(chave) {
      if (!mapa.has(chave)) return null;
      return { chave, valor: JSON.stringify(mapa.get(chave)), tipo: 'json' };
    },
    parseValor(reg) {
      if (!reg) return null;
      return JSON.parse(reg.valor);
    },
    async salvar(chave, dados) {
      mapa.set(chave, dados);
      return dados;
    },
    _mapa: mapa
  };
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

/**
 * Extrai classificarMensagemBloqueioFiscalCentral do frontend (sem DOM).
 * formatarDataHoraCentral é stub — FILA não depende dela.
 */
function carregarClassificarMensagemUi() {
  const ui = src('frontend/erp/js/central-entradas.js');
  const m = ui.match(
    /function classificarMensagemBloqueioFiscalCentral\(resultado\) \{[\s\S]*?\n\}/
  );
  assert.ok(m, 'função classificarMensagemBloqueioFiscalCentral não encontrada');
  // eslint-disable-next-line no-new-func
  return new Function(
    'formatarDataHoraCentral',
    `${m[0]}; return classificarMensagemBloqueioFiscalCentral;`
  )((iso) => iso || null);
}

describe('CE-PASTELARIA-02 — busca NF-e / FILA / liberação UI', () => {
  let db;
  let nsuService;
  let decisao;
  let gate;
  let agoraMs;
  let configRepository;
  let opReal;

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

    configRepository = memConfigRepo();
    opReal = new CentralOperacaoFiscalRealService({
      configRepository,
      nsuService,
      decisaoDistDfe: decisao,
      exigirCertificadoAptoParaUsoFiscal: async () => ({ apto: true }),
      configuracaoService: {
        obterContextoOperacional: async () => ({
          ok: true,
          contexto: {
            empresaId: EMP,
            cnpj: CNPJ,
            ambiente: 1,
            nomeEmpresa: 'EMPRESA TESTE P02'
          }
        })
      }
    });
    await opReal._gravarAtivacao(EMP, {
      ativa: true,
      empresaId: EMP,
      tokenSeed: SEED,
      cnpj: CNPJ,
      tiposPermitidos: ['distNSU'],
      ativadaEm: FIXO.toISOString()
    });
  });

  afterEach(async () => {
    obterMutexTransmissaoSefaz().resetParaTeste();
    if (db) await new Promise((r) => db.close(() => r()));
  });

  it('0) isolamento ativo (sem banco oficial)', () => {
    assert.ok(isolamento.dbDir);
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.throws(
      () => new sqlite3.Database(path.join('C:\\ProgramData\\MercantilFiscal\\dados', 'mercadao.db')),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
        || /banco oficial bloqueado/i.test(String(err.message))
    );
  });

  it('1) REPRODUÇÃO — sticky FILA bloqueia pré-voo após cooldown 656 expirado', async () => {
    const cooldownExpirado = new Date(agoraMs - 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?, ?)`,
    [CNPJ, padNsu(196), padNsu(196), cooldownExpirado, FIXO.toISOString()]);

    const status = await opReal.obterStatus(EMP);
    assert.equal(status.ativa, true);
    assert.equal(status.preVoo.ok, false);
    assert.equal(status.preVoo.codigo, 'FILA_ESGOTADA');
    assert.equal(status.preVoo.nsu?.motivoCooldown, 'FILA_ESGOTADA');

    await assert.rejects(
      () => opReal.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true,
        usuario: { id: 1, perfil: 'ADMIN' }
      }),
      (e) => {
        assert.equal(e.codigo, 'FILA_ESGOTADA');
        assert.equal(e.consultaExecutada, false);
        assert.equal(e.sefazConsultada, false);
        return true;
      }
    );
  });

  it('2) REPRODUÇÃO UI — FILA não vira “Aguarde a liberação” genérico', () => {
    const classificar = carregarClassificarMensagemUi();
    const msgFila = classificar({
      codigo: 'FILA_ESGOTADA',
      etapa: 'cooldown',
      mensagemAmigavel: null,
      mensagem: null,
      proximaConsultaEm: null,
      motivoCooldown: 'FILA_ESGOTADA'
    });
    assert.match(msgFila, /fila esgotada/i);
    assert.match(msgFila, /Liberar fila esgotada/i);
    assert.doesNotMatch(msgFila, /Aguarde a liberação/);

    const msgCd = classificar({
      codigo: 'COOLDOWN_ATIVO',
      etapa: 'cooldown',
      proximaConsultaEm: null
    });
    assert.match(msgCd, /Aguarde a liberação|Cooldown SEFAZ/i);
  });

  it('3) REGRESSÃO — liberarFilaEsgotada não envia SOAP e não altera NSU', async () => {
    const cooldownExpirado = new Date(agoraMs - 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?, ?)`,
    [CNPJ, padNsu(196), padNsu(196), cooldownExpirado, FIXO.toISOString()]);

    let soapChamado = false;
    const syncSpy = {
      sincronizar: async () => {
        soapChamado = true;
        throw new Error('SOAP não deveria ser chamado na liberação');
      }
    };
    opReal._sincronizacao = syncSpy;

    const out = await opReal.liberarFilaEsgotada({
      empresaId: EMP,
      usuario: { id: 9, perfil: 'ADMIN' },
      confirmacaoLiberacaoFila: true,
      motivo: 'teste_ce_pastelaria_02'
    });

    assert.equal(out.sucesso, true);
    assert.equal(out.consultaExecutada, false);
    assert.equal(out.sefazConsultada, false);
    assert.equal(soapChamado, false);
    assert.equal(out.ultNsu, padNsu(196));
    assert.equal(out.maxNsu, padNsu(196));
    assert.equal(out.ultimoCstat, 'FILA_LIBERADA_OP');

    const pos = await nsuService.buscarPorCnpjAmbiente(CNPJ, 1);
    assert.equal(pos.ultNsu, padNsu(196));
    assert.equal(pos.maxNsu, padNsu(196));
    assert.equal(pos.ultimoCstat, 'FILA_LIBERADA_OP');
    assert.equal(nsuService.avaliarCooldown(pos).ativo, false);

    const status = await opReal.obterStatus(EMP);
    assert.equal(status.preVoo.ok, true, 'pré-voo deve liberar após FILA_LIBERADA_OP');
  });

  it('4) liberação exige admin + confirmação; não contorna cooldown 656 ativo', async () => {
    const cooldownFuturo = new Date(agoraMs + 30 * 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?, ?)`,
    [CNPJ, padNsu(50), padNsu(50), cooldownFuturo, FIXO.toISOString()]);

    await assert.rejects(
      () => opReal.liberarFilaEsgotada({
        empresaId: EMP,
        usuario: { id: 1, perfil: 'OPERADOR' },
        confirmacaoLiberacaoFila: true
      }),
      (e) => e.code === 'ADMIN_OBRIGATORIO' || e.statusCode === 403
    );

    await assert.rejects(
      () => opReal.liberarFilaEsgotada({
        empresaId: EMP,
        usuario: { id: 1, perfil: 'ADMIN' },
        confirmacaoLiberacaoFila: false
      }),
      (e) => e.codigo === 'CONFIRMACAO_LIBERACAO_FILA_OBRIGATORIA'
    );

    await assert.rejects(
      () => opReal.liberarFilaEsgotada({
        empresaId: EMP,
        usuario: { id: 1, perfil: 'ADMIN' },
        confirmacaoLiberacaoFila: true
      }),
      (e) => e.codigo === 'COOLDOWN_EXPLICITO_ATIVO' || e.code === 'COOLDOWN_EXPLICITO_ATIVO'
    );
  });

  it('5) rota e orquestração expõem liberar-fila-esgotada (sem auth no body)', () => {
    const rotas = src('backend/rotas/central-entradas.js');
    assert.match(rotas, /operacao-fiscal-real\/liberar-fila-esgotada/);
    assert.match(rotas, /liberarFilaEsgotadaOperacaoReal/);
    assert.match(rotas, /confirmacaoLiberacaoFila/);
    assert.match(rotas, /AUTORIZACAO_CLIENTE_RECUSADA/);

    const orch = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
    assert.match(orch, /liberarFilaEsgotadaOperacaoReal/);

    const svc = src('backend/motores/central-entradas/CentralEntradasService.js');
    assert.match(svc, /liberarFilaEsgotadaOperacaoReal/);
  });

  it('6) Pastelaria: sync do cabeçalho encaminha para consulta real (não restaura ZIP CDS)', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /async function sincronizarCentralEntradas/);
    assert.match(ui, /operacaoFiscalReal/);
    assert.match(ui, /return consultarDfeRealCentral\(\)/);
    assert.match(ui, /operacao-fiscal-real\/consultar-dfe/);
    assert.match(ui, /liberarFilaEsgotadaCentral/);
    assert.match(ui, /centralCfgOpRealLiberarFila/);
    assert.match(ui, /operacao-fiscal-real\/liberar-fila-esgotada/);
    // barreira OPERACAO_REAL mantida
    assert.match(ui, /Operação fiscal real desabilitada/);
  });

  it('7) sticky FILA e barreira runtime preservadas (não removidas)', () => {
    const nsu = src('backend/motores/central-entradas/services/CentralNsuService.js');
    assert.match(nsu, /CSTAT_FILA_ESGOTADA/);
    assert.match(nsu, /liberarFilaEsgotadaAutorizada/);
    assert.match(nsu, /FILA_LIBERADA_OP|CSTAT_FILA_LIBERADA/);

    const runtime = src('backend/services/fiscal/distribuicaoDfeRuntime.js');
    assert.match(runtime, /avaliarAutorizacaoTransmissao/);
  });

  it('8) REGRESSÃO — path PFX absoluto obsoleto remapeia para FISCAL_DIR', () => {
    const os = require('os');
    const CentralConfiguracaoService = require(
      '../../backend/motores/central-entradas/services/CentralConfiguracaoService'
    );
    const {
      resolverCaminhoCertificadoEmpresaSeguro
    } = require('../../backend/services/fiscal/CertificadoEmpresaService');
    const tmpFiscal = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ce-pfx-'));
    const certDir = path.join(tmpFiscal, 'certificados');
    fs.mkdirSync(certDir, { recursive: true });
    const pfxReal = path.join(certDir, 'certificado-empresa-3.pfx');
    fs.writeFileSync(pfxReal, Buffer.from('dummy-pfx'));
    const pathObsoleto = path.join(
      os.tmpdir(),
      'MercantilFiscal',
      'dados',
      'fiscal',
      'certificados',
      'certificado-empresa-3.pfx'
    );
    assert.equal(fs.existsSync(pathObsoleto), false);

    const prevFiscal = process.env.FISCAL_DIR;
    process.env.FISCAL_DIR = tmpFiscal;
    try {
      const svc = new CentralConfiguracaoService({});
      const resolvido = svc._resolverCaminhoCertificadoExistente(pathObsoleto, 3);
      assert.equal(path.resolve(resolvido), path.resolve(pfxReal));

      const seguro = resolverCaminhoCertificadoEmpresaSeguro(3, pathObsoleto, {
        pastaCertificados: certDir
      });
      assert.equal(path.resolve(seguro), path.resolve(pfxReal));
    } finally {
      if (prevFiscal == null) delete process.env.FISCAL_DIR;
      else process.env.FISCAL_DIR = prevFiscal;
      try { fs.unlinkSync(pfxReal); } catch { /* ignore */ }
      try { fs.rmdirSync(certDir); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpFiscal); } catch { /* ignore */ }
    }
  });
});
