/**
 * CENTRAL-ENTRADAS-04 — Contenção SEFAZ + Gate por empresa + fim do loop 596.
 *
 * Código real exercitado: CentralSefazOperationalGate (instância isolada, estado em memória),
 * CentralManifestacaoDfeService, MotorRecuperacaoXmlService, CentralSincronizacaoService,
 * consultarNotaPorChave / sincronizarDistribuicaoDFe (montagem SOAP + parser).
 * Simulados: transporte SOAP, envio 210210, repositórios, NSU e auditoria.
 * Nenhuma chamada SEFAZ real; banco oficial nunca é aberto.
 *
 * Executar: node tests/central-entradas/central-entradas-04-gate.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-central-entradas-04-gate-');

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

if (!process.env.DB_DIR) {
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ce04-gate-'));
}
const sqlite3 = require('sqlite3');
require.cache[require.resolve('../../backend/database')] = {
  exports: new sqlite3.Database(':memory:')
};
require.cache[require.resolve('../../backend/motores/central-entradas/services/CentralXmlWaitScheduler')] = {
  exports: {
    enfileirarRecuperacao: async () => {},
    cancelar: () => true
  }
};

const {
  CentralSefazOperationalGate
} = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
const CentralManifestacaoDfeService = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoDfeService'
);
const { POLITICAS_MANIFESTACAO } = CentralManifestacaoDfeService;
const MotorRecuperacaoXmlService = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService'
);
const CentralSincronizacaoService = require(
  '../../backend/motores/central-entradas/services/CentralSincronizacaoService'
);
const CentralDfePersistenciaService = require(
  '../../backend/motores/central-entradas/services/CentralDfePersistenciaService'
);
const {
  consultarNotaPorChave: consultarNotaPorChaveRaw,
  sincronizarDistribuicaoDFe: sincronizarDistribuicaoDFeRaw
} = require('../../backend/services/fiscal/distribuicaoDFe');
const { anexarAutorizacaoTesteSefaz } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
function consultarNotaPorChave(chave, deps) {
  return consultarNotaPorChaveRaw(chave, anexarAutorizacaoTesteSefaz(deps));
}
function sincronizarDistribuicaoDFe(deps) {
  return sincronizarDistribuicaoDFeRaw(anexarAutorizacaoTesteSefaz(deps));
}
const {
  montarCandidatoManifestacao,
  ESTADOS_MANIFESTACAO
} = require('../../backend/motores/central-entradas/contracts/CandidatoManifestacaoDTO');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { DocumentoDfeTipo } = require('../../backend/motores/central-entradas/core/DocumentoDfeTipo');
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { CHAVES } = require('../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig');
const zlib = require('zlib');

const S = DocumentoFiscalStatus;
const CNPJ = Object.freeze({
  1: '38111111000115',
  2: '38111111000387',
  3: '38111111000204'
});
const CHAVE = Object.freeze({
  1: '23260807000000000000550010000004311000000011',
  2: '23260807000000000000550010002528181000000022',
  3: '23260875315333000000550010005415881000000033'
});
const AMBIENTE = 1;
const ctxEmpresa = (empresaId) => ({ empresaId, cnpj: CNPJ[empresaId], ambiente: AMBIENTE });

let ok = 0;
let falhas = 0;
const resultados = [];

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      ok += 1;
      resultados.push({ nome, ok: true });
      console.log(`  OK  ${nome}`);
    })
    .catch((err) => {
      falhas += 1;
      resultados.push({ nome, ok: false });
      console.error(`  FALHOU  ${nome}`);
      console.error(`         ${err.stack || err.message}`);
    });
}

function criarRelogio(iso = '2026-09-27T13:00:00.000Z') {
  let t = new Date(iso).getTime();
  return {
    agora: () => new Date(t),
    avancarMin: (min) => { t += min * 60 * 1000; }
  };
}

function criarGate(relogio) {
  const mapa = new Map();
  const configRepository = {
    async buscarPorChave(chave) {
      return mapa.has(chave) ? { chave, valor: mapa.get(chave), tipo: 'json' } : null;
    },
    parseValor: (reg) => (typeof reg.valor === 'string' ? JSON.parse(reg.valor) : reg.valor),
    async salvar(chave, valor) { mapa.set(chave, JSON.parse(JSON.stringify(valor))); }
  };
  const gate = new CentralSefazOperationalGate({ configRepository, agora: relogio.agora });
  gate._persistido = mapa;
  return gate;
}

function contextoPorEmpresa(opts = {}) {
  const empresaId = Number(opts.empresaId);
  return {
    ok: true,
    contexto: {
      empresaId,
      ambiente: AMBIENTE,
      codigoUf: '23',
      cnpj: CNPJ[empresaId],
      certificadoPath: `C:\\certs\\certificado-empresa-${empresaId}.pfx`,
      certificadoSenha: 'secret-nao-logar',
      origemAmbiente: 'empresas_configuracao_fiscal'
    }
  };
}

function procNFeXml(empresaId, chave = CHAVE[empresaId]) {
  return `<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${chave}" versao="4.00">`
    + `<ide><cUF>23</cUF><mod>55</mod><serie>1</serie><nNF>${Number(chave.slice(25, 34))}</nNF>`
    + '<dhEmi>2026-08-20T10:00:00-03:00</dhEmi></ide>'
    + '<emit><CNPJ>75315333000100</CNPJ><xNome>FORNECEDOR TESTE</xNome></emit>'
    + `<dest><CNPJ>${CNPJ[empresaId]}</CNPJ><xNome>PASTELARIA ${empresaId}</xNome></dest>`
    + '<total><ICMSTot><vNF>210.77</vNF></ICMSTot></total></infNFe></NFe>'
    + `<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><cStat>100</cStat><nProt>123</nProt></infProt></protNFe></nfeProc>`;
}

/** Mocks determinísticos de retorno SEFAZ (retDistDFeInt). */
const XMOTIVO = Object.freeze({
  137: 'Nenhum documento localizado para o destinatario',
  138: 'Documento localizado',
  632: 'Rejeicao: Solicitacao fora de prazo, a NF-e nao esta mais disponivel para download',
  640: 'Rejeicao: CNPJ/CPF do interessado nao possui permissao para consultar esta NF-e',
  656: 'Rejeicao: Consumo Indevido'
});

function retDist(cStat, docXml = null) {
  const lote = docXml
    ? `<loteDistDFeInt><docZip NSU="000000000000010" schema="procNFe_v4.00.xsd">${zlib.gzipSync(Buffer.from(docXml, 'utf8')).toString('base64')}</docZip></loteDistDFeInt>`
    : '';
  return `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><verAplic>1.7.6</verAplic>`
    + `<cStat>${cStat}</cStat><xMotivo>${XMOTIVO[cStat]}</xMotivo><dhResp>2026-09-27T10:00:00-03:00</dhResp>`
    + `<ultNSU>000000000000010</ultNSU><maxNSU>000000000000010</maxNSU>${lote}</retDistDFeInt>`;
}

const TIMEOUT = Symbol('timeout');

/** Transporte SOAP simulado por empresa. Resposta: cStat | TIMEOUT | { cStat, docXml } | fn(chave). */
function criarTransporte(respostas, { atrasoMs = 0 } = {}) {
  const chamadas = [];
  const enviar = async (params) => {
    const cnpj = params.xmlConsulta.match(/<CNPJ>(\d+)<\/CNPJ>/)[1];
    const chave = params.xmlConsulta.match(/<chNFe>(\d+)<\/chNFe>/)?.[1] || null;
    const empresaId = Number(Object.keys(CNPJ).find((k) => CNPJ[k] === cnpj));
    chamadas.push({ empresaId, cnpj, chave, tipo: chave ? 'consChNFe' : 'distNSU' });
    if (atrasoMs) await new Promise((r) => setTimeout(r, atrasoMs));
    let r = respostas[empresaId];
    if (typeof r === 'function') r = r(chave);
    if (r === TIMEOUT) return { success: false, error: 'ETIMEDOUT: timeout de 30000ms excedido' };
    const body = typeof r === 'object' ? retDist(r.cStat, r.docXml) : retDist(r);
    return { success: true, body, statusCode: 200, endpoint: 'https://mock.sefaz.invalid/NFeDistribuicaoDFe' };
  };
  return { chamadas, enviar };
}

function docResumo(id, empresaId, extra = {}) {
  return {
    id,
    empresaId,
    empresa_id: empresaId,
    chave: CHAVE[empresaId],
    status: S.RESUMO_RECEBIDO,
    tipoDocumento: DocumentoDfeTipo.RES_NFE,
    xml: '<resNFe/>',
    nsu: String(id).padStart(15, '0'),
    createdAt: '2026-09-16T12:00:00.000Z',
    ...extra
  };
}

function criarStore(docsIniciais) {
  const docs = new Map(docsIniciais.map((d) => [Number(d.id), { ...d }]));
  const eventos = [];
  const historico = [];
  let proximoId = 1000;

  const documentosRepository = {
    async buscarPorId(id) {
      const d = docs.get(Number(id));
      return d ? { ...d } : null;
    },
    async buscarPorChave(chave, empresaId) {
      const d = [...docs.values()].find((x) => x.chave === chave && Number(x.empresaId) === Number(empresaId));
      return d ? { ...d } : null;
    },
    async listar({ statusIn }) {
      return [...docs.values()].filter((d) => statusIn.includes(d.status)).map((d) => ({ ...d }));
    },
    async listarPorStatus(status) {
      return [...docs.values()].filter((d) => d.status === status).map((d) => ({ ...d }));
    },
    async inserir(dados) {
      const id = proximoId++;
      docs.set(id, { id, ...dados, empresa_id: dados.empresaId });
      return { ...docs.get(id) };
    },
    async atualizar(id, dados) {
      docs.set(Number(id), { ...docs.get(Number(id)), ...dados });
      return { ...docs.get(Number(id)) };
    }
  };

  const eventosRepository = {
    async listar(filtros = {}) {
      return eventos
        .filter((e) => (!filtros.tipo || e.tipo === filtros.tipo)
          && (filtros.documentoId == null || e.documentoId === Number(filtros.documentoId)))
        .sort((a, b) => b.id - a.id)
        .slice(0, filtros.limite || 50);
    },
    async inserir(dados) {
      const evento = {
        id: eventos.length + 1,
        createdAt: '2026-09-27T13:00:00.000Z',
        ...dados,
        documentoId: dados.documentoId ?? dados.documento_id ?? null
      };
      eventos.push(evento);
      return evento;
    },
    async inserirUnico(dados) {
      const evento = await eventosRepository.inserir(dados);
      return { evento, criado: true, conflito: false };
    },
    async removerPorTipoDocumento() { return true; },
    async contar() { return 0; }
  };

  const historicoRepository = {
    async inserir(dados) {
      historico.push(dados);
      return { id: historico.length, ...dados };
    },
    async listarPorDocumento() { return [...historico]; }
  };

  const transitionService = {
    async transicionar(id, _de, para) {
      docs.set(Number(id), { ...docs.get(Number(id)), status: para });
      return { ...docs.get(Number(id)) };
    }
  };

  const atualizacaoService = {
    async atualizarComXmlCompleto({ documento, xml, tipoDfe, nsu }) {
      const atual = docs.get(Number(documento.id));
      docs.set(Number(documento.id), {
        ...atual, xml, nsu: nsu || atual.nsu, tipoDocumento: tipoDfe, status: S.XML_COMPLETO
      });
      return { documento: { ...docs.get(Number(documento.id)) } };
    }
  };

  const criarPersistencia = (empresaId) => {
    const p = new CentralDfePersistenciaService({
      documentosRepository, historicoRepository, transitionService, atualizacaoService, empresaId
    });
    p.existeCompraComChave = async () => false;
    return p;
  };

  return {
    docs, eventos, historico, documentosRepository, eventosRepository,
    historicoRepository, transitionService, criarPersistencia
  };
}

function criarManifestacao(store, transporte, { gate, relogio, cStatCiencia = '596' } = {}) {
  let ciencias = 0;
  const service = new CentralManifestacaoDfeService({
    documentosRepository: store.documentosRepository,
    historicoRepository: store.historicoRepository,
    eventosRepository: store.eventosRepository,
    transitionService: store.transitionService,
    criarPersistencia: store.criarPersistencia,
    gate,
    nsuService: {
      buscarPorCnpjAmbiente: async () => ({ ultNsu: '10', maxNsu: '10' }),
      avaliarCooldown: () => ({ ativo: true, proximaConsultaEm: '2026-09-27T15:00:00.000Z' })
    },
    configuracaoService: {
      obterPoliticaManifestacao: async () => POLITICAS_MANIFESTACAO.MANUAL,
      obterContextoOperacional: async (opts) => contextoPorEmpresa(opts)
    },
    prepararEnvelopeAssinado: () => '<envEvento/>',
    enviarManifestacao: async (params) => {
      ciencias += 1;
      const xm = {
        596: 'Rejeicao: Evento apresentado apos o prazo permitido para o evento: [10 dias]',
        656: 'Rejeicao: Consumo Indevido',
        135: 'Evento registrado e vinculado a NF-e'
      }[cStatCiencia];
      return {
        success: true,
        body: `<retEvento><infEvento><cStat>${cStatCiencia}</cStat><xMotivo>${xm}</xMotivo><nProt>${cStatCiencia === '135' ? '923260000000001' : ''}</nProt></infEvento></retEvento>`,
        source: 'PLATFORM',
        fallbackUtilizado: false,
        statusCode: 200,
        tempoTotalMs: 5,
        cnpjEnviado: params.cnpj
      };
    },
    consultarNotaPorChave: (chave, deps) => consultarNotaPorChave(chave, {
      ...deps,
      enviarDistribuicaoDfe: transporte.enviar
    }),
    cancelarXmlWait: () => true,
    agora: relogio.agora,
    emitirEvento: async (dados) => store.eventosRepository.inserir(dados)
  });
  return { service, getCiencias: () => ciencias };
}

function criarMotor(store, transporte, { gate, relogio }) {
  const config = new Map([[CHAVES.ATIVA, true]]);
  let manifestacoes = 0;
  const motor = new MotorRecuperacaoXmlService({
    documentosRepository: store.documentosRepository,
    historicoRepository: store.historicoRepository,
    eventosRepository: store.eventosRepository,
    transitionService: store.transitionService,
    configRepository: {
      async listarTodas() {
        return [...config.entries()].map(([chave, valor]) => ({ chave, valor, tipo: 'json' }));
      },
      parseValor: (reg) => reg.valor,
      async buscarPorChave(chave) {
        return config.has(chave) ? { chave, valor: config.get(chave), tipo: 'json' } : null;
      },
      async salvar(chave, valor) { config.set(chave, valor); }
    },
    gate,
    obterContextoOperacional: async (opts) => contextoPorEmpresa(opts),
    criarPersistencia: store.criarPersistencia,
    consultarNotaPorChave: (chave, deps) => consultarNotaPorChave(chave, {
      ...deps,
      enviarDistribuicaoDfe: transporte.enviar
    }),
    processarDocumento: async () => null,
    agora: relogio.agora
  });
  motor._processarManifestacao = async () => {
    manifestacoes += 1;
    return { sucesso: true };
  };
  return { motor, getManifestacoes: () => manifestacoes };
}

const auditoriaMock = new Proxy({}, { get: () => async () => null });

function criarNsuService() {
  const cursores = new Map();
  return {
    cursores,
    async obterOuCriar(cnpj, ambiente) {
      const k = `${cnpj}|${ambiente}`;
      if (!cursores.has(k)) cursores.set(k, { cnpj, ambiente, ultNsu: '000000000000000', maxNsu: '000000000000000' });
      return { ...cursores.get(k) };
    },
    async aplicarRetornoDistDfe({ controle, ultNsu, maxNsu }) {
      const k = `${controle.cnpj}|${controle.ambiente}`;
      const novo = { ...controle, ultNsu, maxNsu };
      cursores.set(k, novo);
      return { controle: novo, ultNsu, maxNsu, atualizouNsu: true };
    },
    async buscarPorCnpjAmbiente() { return null; },
    avaliarCooldown: () => null
  };
}

function distNsu(empresaId, transporte, gate, nsuService) {
  const store = criarStore([]);
  return sincronizarDistribuicaoDFe({
    contextoCentral: contextoPorEmpresa({ empresaId }).contexto,
    gateSefaz: gate,
    origemGate: 'teste',
    enviarDistribuicaoDfe: transporte.enviar,
    nsuService,
    nsuRepository: {},
    persistenciaService: store.criarPersistencia(empresaId),
    auditoriaService: auditoriaMock,
    maxIteracoes: 1
  });
}

async function bloquearEmpresa(gate, empresaId) {
  await gate.processarRespostaSefaz(
    { cStat: '656', xMotivo: XMOTIVO[656] },
    { ...ctxEmpresa(empresaId), origem: 'teste' }
  );
}

async function run() {
  console.log('\n=== CENTRAL-ENTRADAS-04 — Gate por empresa + fim do loop 596 ===\n');

  await test('T01 596 → processarDocumento ×2 → exatamente 1 consulta SEFAZ (consChNFe)', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const store = criarStore([docResumo(22, 2)]);
    const transporte = criarTransporte({ 2: '632' });
    const { service, getCiencias } = criarManifestacao(store, transporte, { gate, relogio });
    const r1 = await service.processarDocumento(22, { confirmado: true });
    const r2 = await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(getCiencias(), 1, 'uma única ciência 210210');
    assert.strictEqual(transporte.chamadas.length, 1, 'uma única consulta SEFAZ');
    assert.strictEqual(r1.cStatConsChNFe, '632');
    assert.strictEqual(r2.aguardandoJanela, true);
    assert.strictEqual(r2.motivo, 'AGUARDANDO_JANELA_POS_596');
    assert.ok(r2.proximaConsultaEm);
  });

  await test('T02 596 com proximaConsultaEm futura → 0 consultas', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const store = criarStore([docResumo(22, 2)]);
    await store.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documentoId: 22, resultado: '596', detalhe: { cStat: '596' }
    });
    await store.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
      documentoId: 22,
      resultado: '632',
      detalhe: { cStat: '632', proximaConsultaEm: '2026-09-27T13:30:00.000Z' }
    });
    const transporte = criarTransporte({ 2: '138' });
    const { service, getCiencias } = criarManifestacao(store, transporte, { gate, relogio });
    const r = await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(transporte.chamadas.length, 0);
    assert.strictEqual(getCiencias(), 0);
    assert.strictEqual(r.aguardandoJanela, true);
    assert.strictEqual(r.proximaConsultaEm, '2026-09-27T13:30:00.000Z');

    const { motor } = criarMotor(store, transporte, { gate, relogio });
    await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(transporte.chamadas.length, 0, 'motor também respeita a janela 596');
  });

  await test('T03 596 com Gate da empresa bloqueado → 0 consultas', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 2);
    const store = criarStore([docResumo(22, 2)]);
    await store.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documentoId: 22, resultado: '596', detalhe: { cStat: '596' }
    });
    const transporte = criarTransporte({ 2: '138' });
    const { service, getCiencias } = criarManifestacao(store, transporte, { gate, relogio });
    const r = await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(transporte.chamadas.length, 0);
    assert.strictEqual(getCiencias(), 0);
    assert.strictEqual(r.bloqueadoGate, true);
    assert.strictEqual(store.docs.get(22).status, S.RESUMO_RECEBIDO);
  });

  await test('T04 consChNFe 656 bloqueia o Gate da empresa (não o global)', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const store = criarStore([docResumo(22, 2, { status: S.XML_INDISPONIVEL })]);
    const transporte = criarTransporte({ 2: '656' });
    const { service } = criarManifestacao(store, transporte, { gate, relogio });
    await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(transporte.chamadas.length, 1);
    assert.strictEqual(gate.estaBloqueado656Contexto(ctxEmpresa(2)), true);
    assert.strictEqual(gate.obterBloqueio656().ativo, false, 'circuito global intacto');
  });

  await test('T05 manifestação 210210 com 656 bloqueia o Gate da empresa', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const store = criarStore([docResumo(22, 2)]);
    const transporte = criarTransporte({ 2: '138' });
    const { service, getCiencias } = criarManifestacao(store, transporte, { gate, relogio, cStatCiencia: '656' });
    await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(getCiencias(), 1);
    assert.strictEqual(gate.estaBloqueado656Contexto(ctxEmpresa(2)), true);
    assert.strictEqual(transporte.chamadas.length, 0, 'nenhum consChNFe após o 656 da ciência');
  });

  await test('T06 empresa 2 recebe 656 → empresas 1 e 3 continuam liberadas', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const transporte = criarTransporte({ 2: '656' });
    const store = criarStore([]);
    await consultarNotaPorChave(CHAVE[2], {
      contextoCentral: contextoPorEmpresa({ empresaId: 2 }).contexto,
      persistenciaService: store.criarPersistencia(2),
      gateSefaz: gate,
      enviarDistribuicaoDfe: transporte.enviar
    });
    assert.strictEqual(gate.estaBloqueado656Contexto(ctxEmpresa(2)), true);
    assert.strictEqual(gate.estaBloqueado656Contexto(ctxEmpresa(1)), false);
    assert.strictEqual(gate.estaBloqueado656Contexto(ctxEmpresa(3)), false);
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(1))).permitido, true);
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(3))).permitido, true);
    const neg = await gate.autorizarConsultaDistDfe(ctxEmpresa(2));
    assert.strictEqual(neg.permitido, false);
    assert.strictEqual(neg.escopo, 'EMPRESA');
    assert.strictEqual(neg.empresaId, 2);
  });

  await test('T07 empresa 2 bloqueada → consChNFe da empresa 2 não executa', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 2);
    const transporte = criarTransporte({ 2: '138' });
    const store = criarStore([docResumo(22, 2, { status: S.XML_INDISPONIVEL })]);
    await assert.rejects(
      consultarNotaPorChave(CHAVE[2], {
        contextoCentral: contextoPorEmpresa({ empresaId: 2 }).contexto,
        persistenciaService: store.criarPersistencia(2),
        gateSefaz: gate,
        enviarDistribuicaoDfe: transporte.enviar
      }),
      (e) => e.bloqueadoGate === true && e.codigo === 'BLOQUEADO_CONSUMO_INDEVIDO_656'
    );
    const { service } = criarManifestacao(store, transporte, { gate, relogio });
    const r = await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(r.bloqueadoGate, true);
    const { motor } = criarMotor(store, transporte, { gate, relogio });
    await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(transporte.chamadas.length, 0);
  });

  await test('T08 empresa 2 bloqueada → consChNFe da empresa 1 executa (procNFe 138)', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 2);
    const transporte = criarTransporte({ 1: { cStat: '138', docXml: procNFeXml(1) }, 2: '138' });
    const store = criarStore([docResumo(11, 1, { status: S.XML_INDISPONIVEL })]);
    const { service } = criarManifestacao(store, transporte, { gate, relogio });
    const r = await service.processarDocumento(11, { confirmado: true });
    assert.strictEqual(transporte.chamadas.length, 1);
    assert.strictEqual(transporte.chamadas[0].empresaId, 1);
    assert.strictEqual(r.xmlCompleto, true);
    assert.strictEqual(store.docs.get(11).tipoDocumento, DocumentoDfeTipo.PROC_NFE);
  });

  await test('T09 empresa 2 bloqueada → distNSU da empresa 2 não consulta nem toca NSU', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 2);
    const transporte = criarTransporte({ 2: '137' });
    const nsuService = criarNsuService();
    const r = await distNsu(2, transporte, gate, nsuService);
    assert.strictEqual(r.bloqueadoGate, true);
    assert.strictEqual(transporte.chamadas.length, 0);
    assert.strictEqual(nsuService.cursores.size, 0, 'cursor NSU não foi lido nem alterado');
  });

  await test('T10 empresa 2 bloqueada → distNSU da empresa 1 continua (sincronização por empresa)', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 2);
    const transporte = criarTransporte({ 1: '137', 2: '137', 3: '137' });
    const nsuService = criarNsuService();
    const r1 = await distNsu(1, transporte, gate, nsuService);
    assert.strictEqual(r1.sucesso, true);
    assert.notStrictEqual(r1.bloqueadoGate, true);

    const store = criarStore([]);
    const sinc = new CentralSincronizacaoService({
      gate,
      documentosRepository: store.documentosRepository,
      configuracaoService: { obterContextoOperacional: async (o) => contextoPorEmpresa(o) },
      nsuRepository: {},
      nsuService,
      sincronizarDistribuicaoDFe: (deps) => sincronizarDistribuicaoDFe({
        ...deps,
        enviarDistribuicaoDfe: transporte.enviar,
        auditoriaService: auditoriaMock,
        maxIteracoes: 1
      })
    });
    const porEmpresa = {};
    for (const empresaId of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      porEmpresa[empresaId] = await sinc._sincronizarEmpresa({ empresaId }, { modo: 'MULTIEMPRESA' });
    }
    assert.strictEqual(porEmpresa[2].bloqueadoGate, true);
    assert.ok(porEmpresa[2].proximaConsultaEm);
    assert.notStrictEqual(porEmpresa[1].bloqueadoGate, true);
    assert.notStrictEqual(porEmpresa[3].bloqueadoGate, true);
    const distPorEmpresa = transporte.chamadas.filter((c) => c.tipo === 'distNSU').map((c) => c.empresaId);
    assert.deepStrictEqual(distPorEmpresa, [1, 1, 3], 'empresa 2 nunca consultou');
  });

  await test('T11 empresa 2 bloqueada → ciência 210210 da empresa 2 não é enviada', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 2);
    const store = criarStore([docResumo(22, 2), docResumo(11, 1)]);
    const transporte = criarTransporte({ 1: '137', 2: '137' });
    const { service, getCiencias } = criarManifestacao(store, transporte, { gate, relogio, cStatCiencia: '135' });
    const r2 = await service.processarDocumento(22, { confirmado: true, apenasManifestacao: true });
    assert.strictEqual(getCiencias(), 0);
    assert.strictEqual(r2.bloqueadoGate, true);
    assert.ok(!store.eventos.some((e) => e.tipo === TIPOS_EVENTO.MANIFESTACAO_CLAIM && e.documentoId === 22),
      'sem claim para documento bloqueado');
    const r1 = await service.processarDocumento(11, { confirmado: true, apenasManifestacao: true });
    assert.strictEqual(getCiencias(), 1, 'empresa 1 manifesta normalmente');
    assert.strictEqual(r1.sucesso, true);
  });

  await test('T12 scheduler/botão + motor simultâneos → 1 consulta por documento', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const store = criarStore([docResumo(22, 2, { status: S.XML_INDISPONIVEL })]);
    const transporte = criarTransporte({ 2: '137' }, { atrasoMs: 30 });
    const { service } = criarManifestacao(store, transporte, { gate, relogio });
    const { motor } = criarMotor(store, transporte, { gate, relogio });
    const [rSvc, rMotor] = await Promise.all([
      service.processarDocumento(22, { confirmado: true }),
      motor.executarCiclo({ forcar: true }),
      service.processarDocumento(22, { confirmado: true })
    ]);
    motor.parar({ silencioso: true });
    assert.strictEqual(transporte.chamadas.length, 1, 'uma única consulta SEFAZ para o documento');
    assert.ok(rSvc && rMotor);
  });

  await test('T12b botão e depois motor dentro da janela do documento → 1 consulta', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const store = criarStore([docResumo(22, 2, { status: S.XML_INDISPONIVEL })]);
    const transporte = criarTransporte({ 2: '137' });
    const { service } = criarManifestacao(store, transporte, { gate, relogio });
    await service.processarDocumento(22, { confirmado: true });
    const { motor } = criarMotor(store, transporte, { gate, relogio });
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(transporte.chamadas.length, 1);
    assert.strictEqual(rel.itens[0].aguardandoJanela, true);
  });

  await test('T13 656 + cooldown → consChNFe, distNSU e 210210 bloqueados durante a janela', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 3);
    relogio.avancarMin(5);
    const b = gate.obterBloqueio656Contexto(ctxEmpresa(3));
    assert.strictEqual(b.ativo, true);
    assert.strictEqual(b.estado, 'BLOQUEADO');
    const transporte = criarTransporte({ 3: '137' });
    const store = criarStore([docResumo(33, 3)]);
    const { service, getCiencias } = criarManifestacao(store, transporte, { gate, relogio });
    await service.processarDocumento(33, { confirmado: true });
    await distNsu(3, transporte, gate, criarNsuService());
    assert.strictEqual(transporte.chamadas.length, 0);
    assert.strictEqual(getCiencias(), 0);
  });

  await test('T14 cooldown expirado → consulta volta a ser permitida (liberação automática)', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 3);
    relogio.avancarMin(11);
    const b = gate.obterBloqueio656Contexto(ctxEmpresa(3));
    assert.strictEqual(b.ativo, false);
    assert.strictEqual(b.estado, 'OPERACIONAL');
    const transporte = criarTransporte({ 3: '137' });
    const r = await distNsu(3, transporte, gate, criarNsuService());
    assert.strictEqual(transporte.chamadas.length, 1);
    assert.strictEqual(r.sucesso, true);
  });

  await test('T15 596 sozinho não cria XML_INDISPONIVEL (632/640/656/timeout/janela/Gate)', async () => {
    for (const resposta of ['632', '640', '656', TIMEOUT]) {
      const relogio = criarRelogio();
      const gate = criarGate(relogio);
      const store = criarStore([docResumo(22, 2)]);
      const transporte = criarTransporte({ 2: resposta });
      const { service } = criarManifestacao(store, transporte, { gate, relogio });
      // eslint-disable-next-line no-await-in-loop
      const r = await service.processarDocumento(22, { confirmado: true });
      assert.strictEqual(store.docs.get(22).status, S.RESUMO_RECEBIDO, `resposta ${String(resposta)}`);
      assert.strictEqual(r.encerrado, false, `resposta ${String(resposta)}`);
    }
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 2);
    const store = criarStore([docResumo(22, 2)]);
    const { service } = criarManifestacao(store, criarTransporte({ 2: '137' }), { gate, relogio });
    await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(store.docs.get(22).status, S.RESUMO_RECEBIDO, 'Gate bloqueado');
  });

  await test('T16 cStat/xMotivo persistidos no evento e no estado (manifestação, consChNFe, Gate)', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const store = criarStore([docResumo(22, 2)]);
    const transporte = criarTransporte({ 2: '656' });
    const { service } = criarManifestacao(store, transporte, { gate, relogio });
    await service.processarDocumento(22, { confirmado: true });

    const rej = store.eventos.find((e) => e.tipo === TIPOS_EVENTO.MANIFESTACAO_REJEITADA);
    assert.strictEqual(String(rej.detalhe.cStat), '596');
    assert.ok(/prazo/i.test(rej.detalhe.xMotivo));
    const cons = store.eventos.find((e) => e.tipo === TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO);
    assert.strictEqual(cons.detalhe.cStat, '656');
    assert.strictEqual(cons.detalhe.xMotivo, XMOTIVO[656]);
    assert.ok(cons.detalhe.proximaConsultaEm, 'janela persistida no evento');

    const b = gate.obterBloqueio656Contexto(ctxEmpresa(2));
    assert.strictEqual(b.cStat, '656');
    assert.strictEqual(b.xMotivo, XMOTIVO[656]);
    assert.strictEqual(b.empresaId, 2);
    assert.strictEqual(b.cnpj, CNPJ[2]);
    assert.strictEqual(b.ambienteLabel, 'PRODUCAO');
    assert.ok(b.iniciadoEm && b.bloqueadoAte);
    const persistido = gate._persistido.get('xml_wait_scheduler_state')
      || [...gate._persistido.values()][0];
    const reg = persistido.bloqueios656PorEmpresa[`2|${CNPJ[2]}|${AMBIENTE}`];
    assert.strictEqual(reg.cStat, '656');
    assert.strictEqual(reg.xMotivo, XMOTIVO[656]);

    const gate2 = criarGate(relogio);
    gate2._configRepository = gate._configRepository;
    await gate2.autorizarConsultaDistDfe(ctxEmpresa(1));
    assert.strictEqual(gate2.estaBloqueado656Contexto(ctxEmpresa(2)), true, 'bloqueio sobrevive a reinício');
  });

  await test('T17 mocks determinísticos: reação do Gate por cStat (137/138/596/632/640/656/timeout)', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const acoes = {};
    for (const cStat of ['137', '138', '596', '632', '640']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await gate.processarRespostaSefaz({ cStat, xMotivo: XMOTIVO[cStat] || '' }, ctxEmpresa(1));
      acoes[cStat] = r.acao;
    }
    assert.deepStrictEqual(acoes, {
      137: 'backoff', 138: 'continuar', 596: 'continuar', 632: 'continuar', 640: 'continuar'
    });
    assert.strictEqual(gate.estaBloqueado656Contexto(ctxEmpresa(1)), false);

    const store = criarStore([]);
    const transporte = criarTransporte({ 1: TIMEOUT });
    await assert.rejects(consultarNotaPorChave(CHAVE[1], {
      contextoCentral: contextoPorEmpresa({ empresaId: 1 }).contexto,
      persistenciaService: store.criarPersistencia(1),
      gateSefaz: gate,
      enviarDistribuicaoDfe: transporte.enviar
    }));
    assert.strictEqual(gate.estaBloqueado656Contexto(ctxEmpresa(1)), false, 'timeout não bloqueia');

    const r656 = await gate.processarRespostaSefaz({ cStat: '656', xMotivo: XMOTIVO[656] }, ctxEmpresa(1));
    assert.strictEqual(r656.acao, 'bloquear');
    assert.strictEqual(r656.escopo, 'EMPRESA');
  });

  await test('T18 cooldown progressivo por empresa (10 → 20 min) sem afetar outras', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    await bloquearEmpresa(gate, 2);
    const b1 = gate.obterBloqueio656Contexto(ctxEmpresa(2));
    relogio.avancarMin(11);
    await bloquearEmpresa(gate, 2);
    const b2 = gate.obterBloqueio656Contexto(ctxEmpresa(2));
    assert.strictEqual(b1.intervaloMs, 10 * 60 * 1000);
    assert.strictEqual(b2.intervaloMs, 20 * 60 * 1000);
    assert.strictEqual(gate.listarBloqueios656PorEmpresa().length, 1);
    assert.strictEqual(gate.obterTelemetria().bloqueios656PorEmpresa.length, 1);
  });

  await test('T19 motor pós-596: consChNFe grava janela e não repete no ciclo seguinte', async () => {
    const relogio = criarRelogio();
    const gate = criarGate(relogio);
    const store = criarStore([docResumo(18, 3)]);
    await store.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documentoId: 18, resultado: '596', detalhe: { cStat: '596' }
    });
    const transporte = criarTransporte({ 3: '632' });
    const { motor, getManifestacoes } = criarMotor(store, transporte, { gate, relogio });
    await motor.executarCiclo({ forcar: true });
    await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(transporte.chamadas.length, 1);
    assert.strictEqual(getManifestacoes(), 0, 'não remanifesta');
    const ev = store.eventos.find((e) => e.tipo === TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO);
    assert.strictEqual(ev.detalhe.cStat, '632');
    assert.ok(ev.detalhe.proximaConsultaEm);
  });

  await test('T20 contrato P01: candidato por empresa com prazo, estado, Gate, claim e prioridade', async () => {
    const agora = new Date('2026-09-27T13:00:00.000Z');
    const c = montarCandidatoManifestacao(
      { id: 110, chave: CHAVE[2], empresa_id: 2, dataEmissao: '2026-09-25T10:00:00.000Z' },
      { cnpj: CNPJ[2], ultimoCStat: null },
      agora
    );
    assert.strictEqual(c.empresaId, 2);
    assert.strictEqual(c.cnpj, CNPJ[2]);
    assert.strictEqual(c.dataLimiteManifestacao, '2026-10-05T10:00:00.000Z');
    assert.strictEqual(c.estadoManifestacao, ESTADOS_MANIFESTACAO.SEM_CIENCIA);
    assert.strictEqual(c.prioridade, 7);
    const bloqueado = montarCandidatoManifestacao({ id: 1, empresa_id: 2 }, { gateBloqueado: true }, agora);
    assert.strictEqual(bloqueado.prioridade, null);
    const p596 = montarCandidatoManifestacao({ id: 2, empresa_id: 3 }, { cStatCiencia: '596' }, agora);
    assert.strictEqual(p596.estadoManifestacao, ESTADOS_MANIFESTACAO.PRAZO_EXPIRADO_596);
  });

  console.log(`\n${ok} ok, ${falhas} falha(s)\n`);
  if (falhas) process.exit(1);
}

run();
