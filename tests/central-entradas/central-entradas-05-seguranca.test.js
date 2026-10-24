/**
 * CENTRAL-ENTRADAS-05 — Cancelamento DistDFe (P19) + Política de manifestação no Motor (P08)
 * + expiração/recuperação do claim de manifestação.
 *
 * Código real exercitado: sincronizarDistribuicaoDFe / persistirDocumentosRetorno,
 * CentralDfePersistenciaService.aplicarEventoDfe, DocumentoTransitionService (máquina de estados),
 * CentralManifestacaoDfeService, MotorRecuperacaoXmlService, CentralSefazOperationalGate (instância
 * isolada) e CentralEventosRepository sobre SQLite real em arquivo temporário (claims).
 * Simulados: transporte SOAP, envio 210210, repositório de documentos, NSU e contexto fiscal.
 * Nenhuma chamada SEFAZ real; banco oficial nunca é aberto.
 *
 * Executar: node tests/central-entradas/central-entradas-05-seguranca.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-central-entradas-05-seguranca-');

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

if (!process.env.DB_DIR) {
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ce05-seg-'));
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
const { POLITICAS_MANIFESTACAO, TTL_CLAIM_MANIFESTACAO_MS } = CentralManifestacaoDfeService;
const MotorRecuperacaoXmlService = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService'
);
const CentralDfePersistenciaService = require(
  '../../backend/motores/central-entradas/services/CentralDfePersistenciaService'
);
const DocumentoTransitionService = require(
  '../../backend/motores/central-entradas/services/DocumentoTransitionService'
);
const CentralEventosRepository = require(
  '../../backend/motores/central-entradas/repositories/CentralEventosRepository'
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
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { DocumentoDfeTipo } = require('../../backend/motores/central-entradas/core/DocumentoDfeTipo');
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { CHAVES } = require('../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig');

const S = DocumentoFiscalStatus;
const BANCO_OFICIAL = /MercantilFiscal[\\/]+dados[\\/]+mercadao\.db/i;
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

/** Chave com mesma série (001) e número (431) variando só o emitente/código. */
function chaveSerieNumero431(cnpjEmitente, cNF) {
  return `232608${cnpjEmitente}550010000004311${cNF}0`;
}

let ok = 0;
let falhas = 0;

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      ok += 1;
      console.log(`  OK  ${nome}`);
    })
    .catch((err) => {
      falhas += 1;
      console.error(`  FALHOU  ${nome}`);
      console.error(`         ${err.stack || err.message}`);
    });
}

function criarRelogio(iso = '2026-09-27T13:00:00.000Z') {
  let t = new Date(iso).getTime();
  return {
    agora: () => new Date(t),
    avancarMs: (ms) => { t += ms; },
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
  return new CentralSefazOperationalGate({ configRepository, agora: relogio.agora });
}

async function bloquearEmpresa(gate, empresaId) {
  await gate.processarRespostaSefaz(
    { cStat: '656', xMotivo: 'Rejeicao: Consumo Indevido' },
    { ...ctxEmpresa(empresaId), origem: 'teste' }
  );
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

// ——————————————————————————————————————————————— XML simulados (DistDFe)

function gz(xml) {
  return zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
}

function eventoXml(chave, tpEvento, { descEvento = 'Cancelamento', cStat = '135' } = {}) {
  return `<procEventoNFe versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><evento versao="1.00">`
    + `<infEvento Id="ID${tpEvento}${chave}01"><cOrgao>23</cOrgao><tpAmb>1</tpAmb><CNPJ>75315333000100</CNPJ>`
    + `<chNFe>${chave}</chNFe><dhEvento>2026-09-27T09:00:00-03:00</dhEvento><tpEvento>${tpEvento}</tpEvento>`
    + `<nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>${descEvento}</descEvento>`
    + '<nProt>123</nProt><xJust>Teste de evento CE-05</xJust></detEvento></infEvento></evento>'
    + `<retEvento versao="1.00"><infEvento><tpAmb>1</tpAmb><cStat>${cStat}</cStat><xMotivo>Evento registrado</xMotivo>`
    + `<chNFe>${chave}</chNFe><tpEvento>${tpEvento}</tpEvento><nProt>923260000000009</nProt></infEvento></retEvento></procEventoNFe>`;
}

function procNFeXml(empresaId, chave) {
  return `<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${chave}" versao="4.00">`
    + `<ide><cUF>23</cUF><mod>55</mod><serie>1</serie><nNF>${Number(chave.slice(25, 34))}</nNF>`
    + '<dhEmi>2026-08-20T10:00:00-03:00</dhEmi></ide>'
    + '<emit><CNPJ>75315333000100</CNPJ><xNome>FORNECEDOR TESTE</xNome></emit>'
    + `<dest><CNPJ>${CNPJ[empresaId]}</CNPJ><xNome>PASTELARIA ${empresaId}</xNome></dest>`
    + '<total><ICMSTot><vNF>210.77</vNF></ICMSTot></total></infNFe></NFe>'
    + `<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><cStat>100</cStat><nProt>123</nProt></infProt></protNFe></nfeProc>`;
}

/** retDistDFeInt 138 com lote arbitrário: [{ nsu, schema, xml }]. */
function retLote(docs) {
  const ult = docs.length ? docs[docs.length - 1].nsu : '000000000000000';
  const lote = docs
    .map((d) => `<docZip NSU="${d.nsu}" schema="${d.schema}">${gz(d.xml)}</docZip>`)
    .join('');
  return `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><verAplic>1.7.6</verAplic>`
    + '<cStat>138</cStat><xMotivo>Documento localizado</xMotivo><dhResp>2026-09-27T10:00:00-03:00</dhResp>'
    + `<ultNSU>${ult}</ultNSU><maxNSU>${ult}</maxNSU><loteDistDFeInt>${lote}</loteDistDFeInt></retDistDFeInt>`;
}

const loteEvento = (nsu, chave, tp) => ({ nsu, schema: 'procEventoNFe_v1.00.xsd', xml: eventoXml(chave, tp) });

function retDistSimples(cStat) {
  const xm = { 137: 'Nenhum documento localizado', 138: 'Documento localizado', 632: 'Rejeicao: fora de prazo' }[cStat];
  return `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><verAplic>1.7.6</verAplic>`
    + `<cStat>${cStat}</cStat><xMotivo>${xm}</xMotivo><dhResp>2026-09-27T10:00:00-03:00</dhResp>`
    + '<ultNSU>000000000000010</ultNSU><maxNSU>000000000000010</maxNSU></retDistDFeInt>';
}

/** Transporte SOAP simulado. corpo: string | fn(empresaId, chave) → string. */
function criarTransporte(corpo) {
  const chamadas = [];
  const enviar = async (params) => {
    const cnpj = params.xmlConsulta.match(/<CNPJ>(\d+)<\/CNPJ>/)[1];
    const chave = params.xmlConsulta.match(/<chNFe>(\d+)<\/chNFe>/)?.[1] || null;
    const empresaId = Number(Object.keys(CNPJ).find((k) => CNPJ[k] === cnpj));
    chamadas.push({ empresaId, cnpj, chave, tipo: chave ? 'consChNFe' : 'distNSU' });
    const body = typeof corpo === 'function' ? corpo(empresaId, chave) : corpo;
    return { success: true, body, statusCode: 200, endpoint: 'https://mock.sefaz.invalid/NFeDistribuicaoDFe' };
  };
  return { chamadas, enviar };
}

// ——————————————————————————————————————————————— store em memória

function doc(id, empresaId, extra = {}) {
  return {
    id,
    empresaId,
    empresa_id: empresaId,
    chave: CHAVE[empresaId],
    status: S.RESUMO_RECEBIDO,
    tipoDocumento: DocumentoDfeTipo.RES_NFE,
    // CENTRAL-XML-02: resNFe real traz dhEmi (hora + offset); sem ele não há ciência automática.
    xml: '<resNFe><dhEmi>2026-09-25T10:00:00-03:00</dhEmi></resNFe>',
    nsu: String(id).padStart(15, '0'),
    createdAt: '2026-09-16T12:00:00.000Z',
    ...extra
  };
}

function criarStore(docsIniciais, { eventosRepository = null } = {}) {
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

  const eventosMemoria = {
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
      const existente = eventos.find((e) => e.tipo === dados.tipo
        && [TIPOS_EVENTO.MANIFESTACAO_CLAIM, TIPOS_EVENTO.MANIFESTACAO_ACEITA].includes(dados.tipo)
        && e.documentoId === Number(dados.documentoId));
      if (existente) return { evento: existente, criado: false, conflito: true };
      const evento = await eventosMemoria.inserir(dados);
      return { evento, criado: true, conflito: false };
    },
    async removerPorTipoDocumento(tipo, documentoId) {
      const i = eventos.findIndex((e) => e.tipo === tipo && e.documentoId === Number(documentoId));
      if (i >= 0) eventos.splice(i, 1);
      return i >= 0;
    },
    async contar() { return 0; }
  };

  const historicoRepository = {
    async inserir(dados) {
      historico.push(dados);
      return { id: historico.length, ...dados };
    },
    async listarPorDocumento() { return [...historico]; }
  };

  const transitionService = new DocumentoTransitionService({
    documentosRepository,
    historicoService: { registrar: async (dados) => { historico.push(dados); return dados; } }
  });

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
    docs,
    eventos,
    historico,
    documentosRepository,
    eventosRepository: eventosRepository || eventosMemoria,
    historicoRepository,
    transitionService,
    criarPersistencia
  };
}

function criarAuditoria() {
  const registros = [];
  return new Proxy({ registros }, {
    get: (alvo, prop) => {
      if (prop === 'registros') return alvo.registros;
      if (prop === 'registrar') return async (r) => { registros.push(r); return r; };
      if (prop === 'then') return undefined;
      return async () => null;
    }
  });
}

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

/** DistNSU real da empresa com lote simulado; captura console.warn de falha de evento. */
async function distNsuComLote(store, empresaId, corpo, { relogio = criarRelogio(), gate = null } = {}) {
  const transporte = criarTransporte(corpo);
  const auditoria = criarAuditoria();
  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (...args) => { avisos.push(args.map(String).join(' ')); };
  try {
    const r = await sincronizarDistribuicaoDFe({
      contextoCentral: contextoPorEmpresa({ empresaId }).contexto,
      gateSefaz: gate || criarGate(relogio),
      origemGate: 'teste-ce05',
      enviarDistribuicaoDfe: transporte.enviar,
      nsuService: criarNsuService(),
      nsuRepository: {},
      persistenciaService: store.criarPersistencia(empresaId),
      auditoriaService: auditoria,
      maxIteracoes: 1
    });
    return { r, transporte, auditoria, avisos };
  } finally {
    console.warn = warnOriginal;
  }
}

const falhasEvento = (avisos) => avisos.filter((a) => /falha ao aplicar evento/i.test(a));
const transicoesPara = (store, id, status) => store.historico
  .filter((h) => Number(h.documentoId) === Number(id) && h.statusNovo === status);

// ——————————————————————————————————————————————— manifestação / motor

function criarManifestacao(store, transporte, opts = {}) {
  const {
    gate, relogio, cStatCiencia = '135', politica = () => POLITICAS_MANIFESTACAO.MANUAL,
    locksDocumento, atrasoCienciaMs = 0
  } = opts;
  let ciencias = 0;
  const service = new CentralManifestacaoDfeService({
    documentosRepository: store.documentosRepository,
    historicoRepository: store.historicoRepository,
    eventosRepository: store.eventosRepository,
    transitionService: store.transitionService,
    criarPersistencia: store.criarPersistencia,
    gate,
    locksDocumento,
    nsuService: {
      buscarPorCnpjAmbiente: async () => ({ ultNsu: '10', maxNsu: '10' }),
      avaliarCooldown: () => ({ ativo: true, proximaConsultaEm: '2026-09-27T15:00:00.000Z' })
    },
    configuracaoService: {
      obterPoliticaManifestacao: async () => politica(),
      obterContextoOperacional: async (o) => contextoPorEmpresa(o)
    },
    prepararEnvelopeAssinado: () => '<envEvento/>',
    enviarManifestacao: async (params) => {
      ciencias += 1;
      if (atrasoCienciaMs) await new Promise((r) => setTimeout(r, atrasoCienciaMs));
      const xm = {
        596: 'Rejeicao: Evento apresentado apos o prazo permitido para o evento: [10 dias]',
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

function criarMotor(store, transporte, manifestacao, { gate, relogio, obterPoliticaManifestacao } = {}) {
  const config = new Map([[CHAVES.ATIVA, true]]);
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
    obterContextoOperacional: async (o) => contextoPorEmpresa(o),
    criarPersistencia: store.criarPersistencia,
    consultarNotaPorChave: (chave, deps) => consultarNotaPorChave(chave, {
      ...deps,
      enviarDistribuicaoDfe: transporte.enviar
    }),
    processarDocumento: async () => null,
    manifestacaoService: manifestacao.service,
    obterPoliticaManifestacao,
    agora: relogio.agora
  });
  return motor;
}

async function cicloMotor(motor) {
  await motor.executarCiclo({ forcar: true });
  motor.parar({ silencioso: true });
}

const eventosTipo = (store, tipo, id) => store.eventos
  .filter((e) => e.tipo === tipo && (id == null || e.documentoId === Number(id)));

function cenarioP08(politicaInicial, docs = [doc(22, 2)], extra = {}) {
  let politica = politicaInicial;
  const relogio = criarRelogio();
  const gate = criarGate(relogio);
  const store = criarStore(docs);
  const transporte = criarTransporte(retDistSimples('137'));
  const manifestacao = criarManifestacao(store, transporte, {
    gate, relogio, politica: () => politica, cStatCiencia: extra.cStatCiencia || '135'
  });
  const motor = criarMotor(store, transporte, manifestacao, {
    gate, relogio, obterPoliticaManifestacao: extra.obterPoliticaManifestacao
  });
  return {
    relogio,
    gate,
    store,
    transporte,
    manifestacao,
    motor,
    definirPolitica: (p) => { politica = p; }
  };
}

// ——————————————————————————————————————————————— SQLite real (claims)

let seqBanco = 0;
const bancosAbertos = [];

function execSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) { return err ? reject(err) : resolve(this); });
  });
}
function getSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function allSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/** Arquivo SQLite temporário com o schema oficial de central_entradas_eventos e duas conexões. */
async function criarBancoClaims() {
  seqBanco += 1;
  const arquivo = path.join(process.env.DB_DIR, `ce05-claims-${process.pid}-${seqBanco}.db`);
  assert.ok(!BANCO_OFICIAL.test(arquivo), 'nunca usar o banco oficial');
  const abrir = () => {
    const db = new sqlite3.Database(arquivo);
    db.configure('busyTimeout', 5000);
    bancosAbertos.push(db);
    return db;
  };
  const db1 = abrir();
  await execSql(db1, `CREATE TABLE IF NOT EXISTS central_entradas_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    origem TEXT NOT NULL DEFAULT 'sistema',
    descricao TEXT,
    resultado TEXT,
    sucesso INTEGER,
    documento_id INTEGER,
    notas_novas INTEGER DEFAULT 0,
    notas_duplicadas INTEGER DEFAULT 0,
    duracao_ms INTEGER,
    detalhe_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await execSql(db1, `CREATE UNIQUE INDEX IF NOT EXISTS idx_central_eventos_manif_aceita
    ON central_entradas_eventos(documento_id) WHERE tipo = 'MANIFESTACAO_ACEITA' AND documento_id IS NOT NULL`);
  await execSql(db1, `CREATE UNIQUE INDEX IF NOT EXISTS idx_central_eventos_manif_claim
    ON central_entradas_eventos(documento_id) WHERE tipo = 'MANIFESTACAO_CLAIM' AND documento_id IS NOT NULL`);
  const db2 = abrir();
  return {
    arquivo,
    db1,
    db2,
    repo1: new CentralEventosRepository({ db: db1 }),
    repo2: new CentralEventosRepository({ db: db2 }),
    claims: (docId) => allSql(db1,
      `SELECT * FROM central_entradas_eventos WHERE tipo = 'MANIFESTACAO_CLAIM' AND documento_id = ?`, [docId]),
    recuperacoes: (docId) => allSql(db1,
      `SELECT * FROM central_entradas_eventos WHERE tipo = 'MANIFESTACAO_CLAIM_RECUPERADO' AND documento_id = ?`, [docId]),
    contar: async (tipo, docId) => Number((await getSql(db1,
      'SELECT COUNT(*) AS n FROM central_entradas_eventos WHERE tipo = ? AND documento_id = ?', [tipo, docId])).n)
  };
}

/** "Processo" isolado: conexão SQLite própria, locks de documento próprios, mesmo relógio. */
function criarProcessoClaim(banco, repo, relogio, docs, opts = {}) {
  const store = criarStore(docs, { eventosRepository: repo });
  const transporte = criarTransporte(retDistSimples('137'));
  const m = criarManifestacao(store, transporte, {
    gate: criarGate(relogio),
    relogio,
    politica: () => POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA,
    locksDocumento: new Set(),
    ...opts
  });
  return { ...m, store };
}

async function run() {
  console.log('\n=== CENTRAL-ENTRADAS-05 — Cancelamento + Política + Claim ===\n');
  console.log(`DB_DIR temporário: ${process.env.DB_DIR}`);
  assert.ok(!BANCO_OFICIAL.test(process.env.DB_DIR), 'DB_DIR não pode apontar para o banco oficial');

  // ————————————————————————————————————— P19
  console.log('\n— P19 cancelamento recebido pelo DistDFe —');

  await test('P19-01 evento 110111 → documento CANCELADA, evento persistido, sem ReferenceError', async () => {
    const store = criarStore([doc(11, 1, { status: S.XML_COMPLETO, tipoDocumento: DocumentoDfeTipo.PROC_NFE })]);
    const { r, auditoria, avisos } = await distNsuComLote(store, 1, retLote([loteEvento('000000000000031', CHAVE[1], '110111')]));
    assert.deepStrictEqual(falhasEvento(avisos), [], 'nenhuma falha ao aplicar evento (ReferenceError)');
    assert.strictEqual(r.sucesso, true);
    const d = store.docs.get(11);
    assert.strictEqual(d.status, S.CANCELADA);
    assert.strictEqual(d.nsu, '000000000000031', 'NSU do evento gravado no documento');
    assert.match(d.statusDetalhe, /110111/);
    const trans = transicoesPara(store, 11, S.CANCELADA);
    assert.strictEqual(trans.length, 1, 'transição registrada no histórico');
    assert.strictEqual(trans[0].statusAnterior, S.XML_COMPLETO);
    const aud = auditoria.registros.filter((a) => a.tipo === 'EVENTO' && a.resultado === S.CANCELADA);
    assert.strictEqual(aud.length, 1, 'evento aplicado auditado');
    assert.strictEqual(aud[0].chave, CHAVE[1]);
    assert.strictEqual(aud[0].nsu, '000000000000031');
  });

  await test('P19-02 evento 110112 → documento CANCELADA, evento persistido, sem ReferenceError', async () => {
    const store = criarStore([doc(22, 2)]);
    const { auditoria, avisos } = await distNsuComLote(store, 2, retLote([loteEvento('000000000000032', CHAVE[2], '110112')]));
    assert.deepStrictEqual(falhasEvento(avisos), []);
    assert.strictEqual(store.docs.get(22).status, S.CANCELADA);
    assert.strictEqual(transicoesPara(store, 22, S.CANCELADA)[0].statusAnterior, S.RESUMO_RECEBIDO);
    assert.strictEqual(auditoria.registros.filter((a) => a.tipo === 'EVENTO' && a.resultado === S.CANCELADA).length, 1);
  });

  await test('P19-03 evento recebido pela empresa 2 não altera documento da empresa 1 (mesma chave)', async () => {
    const chave = CHAVE[3];
    const store = criarStore([
      doc(101, 1, { chave, status: S.XML_COMPLETO }),
      doc(202, 2, { chave, status: S.XML_COMPLETO })
    ]);
    await distNsuComLote(store, 2, retLote([loteEvento('000000000000033', chave, '110111')]));
    assert.strictEqual(store.docs.get(202).status, S.CANCELADA, 'empresa 2 cancelada');
    assert.strictEqual(store.docs.get(101).status, S.XML_COMPLETO, 'empresa 1 intacta');
    assert.strictEqual(transicoesPara(store, 101, S.CANCELADA).length, 0);
  });

  await test('P19-04 mesmo número/série em empresas diferentes permanece isolado', async () => {
    const chaveA = chaveSerieNumero431('75315333000100', '00000001');
    const chaveB = chaveSerieNumero431('07000000000000', '00000002');
    assert.strictEqual(chaveA.length, 44);
    assert.strictEqual(chaveA.slice(22, 34), chaveB.slice(22, 34), 'mesma série e número');
    const store = criarStore([
      doc(301, 1, { chave: chaveA, status: S.XML_COMPLETO }),
      doc(302, 2, { chave: chaveB, status: S.XML_COMPLETO })
    ]);
    await distNsuComLote(store, 2, retLote([loteEvento('000000000000034', chaveB, '110111')]));
    assert.strictEqual(store.docs.get(302).status, S.CANCELADA);
    assert.strictEqual(store.docs.get(301).status, S.XML_COMPLETO);
    // Evento da chave da empresa 1 chegando pela empresa 2 não encontra documento → ignorado.
    await distNsuComLote(store, 2, retLote([loteEvento('000000000000035', chaveA, '110111')]));
    assert.strictEqual(store.docs.get(301).status, S.XML_COMPLETO, 'empresa 1 continua intacta');
  });

  await test('P19-05 DistDFe sem eventos continua funcionando (procNFe persistido)', async () => {
    const store = criarStore([]);
    const chaveNova = CHAVE[1];
    const { r, avisos } = await distNsuComLote(store, 1, retLote([
      { nsu: '000000000000036', schema: 'procNFe_v4.00.xsd', xml: procNFeXml(1, chaveNova) }
    ]));
    assert.deepStrictEqual(falhasEvento(avisos), []);
    assert.strictEqual(r.sucesso, true);
    const novos = [...store.docs.values()].filter((d) => d.chave === chaveNova);
    assert.strictEqual(novos.length, 1, 'documento normal persistido');
    assert.strictEqual(Number(novos[0].empresaId), 1);
  });

  await test('P19-06 lote misto (procNFe + evento 210210 + cancelamento) processado sem interrupção', async () => {
    const store = criarStore([doc(22, 2, { status: S.XML_COMPLETO })]);
    const chaveNova = chaveSerieNumero431('75315333000100', '00000077');
    const { r, avisos } = await distNsuComLote(store, 2, retLote([
      { nsu: '000000000000040', schema: 'procNFe_v4.00.xsd', xml: procNFeXml(2, chaveNova) },
      { nsu: '000000000000041', schema: 'procEventoNFe_v1.00.xsd', xml: eventoXml(CHAVE[2], '210210', { descEvento: 'Ciencia da Operacao' }) },
      loteEvento('000000000000042', CHAVE[2], '110111')
    ]));
    assert.deepStrictEqual(falhasEvento(avisos), []);
    assert.strictEqual(r.sucesso, true);
    assert.strictEqual(store.docs.get(22).status, S.CANCELADA, 'cancelamento aplicado');
    assert.strictEqual([...store.docs.values()].filter((d) => d.chave === chaveNova).length, 1, 'procNFe do mesmo lote persistido');
  });

  await test('P19-07 evento desconhecido não quebra o processamento', async () => {
    const store = criarStore([doc(22, 2, { status: S.XML_COMPLETO }), doc(11, 1, { status: S.XML_COMPLETO })]);
    const chaveNova = chaveSerieNumero431('75315333000100', '00000088');
    const { r, avisos } = await distNsuComLote(store, 2, retLote([
      { nsu: '000000000000050', schema: 'procEventoNFe_v1.00.xsd', xml: eventoXml(CHAVE[2], '999999', { descEvento: 'Evento Desconhecido' }) },
      { nsu: '000000000000051', schema: 'procNFe_v4.00.xsd', xml: procNFeXml(2, chaveNova) }
    ]));
    assert.deepStrictEqual(falhasEvento(avisos), []);
    assert.strictEqual(r.sucesso, true);
    assert.strictEqual(store.docs.get(22).status, S.XML_COMPLETO, 'evento sem efeito não altera status');
    assert.strictEqual([...store.docs.values()].filter((d) => d.chave === chaveNova).length, 1, 'documento seguinte processado');
  });

  await test('P19-08 reprocessar o mesmo evento não corrompe nem duplica', async () => {
    const store = criarStore([doc(22, 2, { status: S.XML_COMPLETO })]);
    const corpo = retLote([loteEvento('000000000000060', CHAVE[2], '110111')]);
    const a = await distNsuComLote(store, 2, corpo);
    const b = await distNsuComLote(store, 2, corpo);
    assert.deepStrictEqual(falhasEvento([...a.avisos, ...b.avisos]), []);
    const d = store.docs.get(22);
    assert.strictEqual(d.status, S.CANCELADA);
    assert.strictEqual(d.nsu, '000000000000060');
    assert.strictEqual(transicoesPara(store, 22, S.CANCELADA).length, 1, 'uma única transição');
    assert.strictEqual(b.auditoria.registros.filter((x) => x.tipo === 'EVENTO' && x.resultado === S.CANCELADA).length, 0,
      'reprocessamento não registra novo cancelamento');
    assert.strictEqual(store.docs.size, 1, 'nenhum documento duplicado');
  });

  // ————————————————————————————————————— P08
  console.log('\n— P08 política de manifestação no Motor de Recuperação —');

  await test('P08-01 AUTOMATICA_CIENCIA + documento elegível → motor envia ciência', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA);
    await cicloMotor(c.motor);
    assert.strictEqual(c.manifestacao.getCiencias(), 1);
    assert.strictEqual(eventosTipo(c.store, TIPOS_EVENTO.MANIFESTACAO_ACEITA, 22).length, 1);
  });

  const assertSemManifestacao = (c, id = 22) => {
    assert.strictEqual(c.manifestacao.getCiencias(), 0, 'zero 210210');
    assert.strictEqual(c.transporte.chamadas.length, 0, 'zero SOAP');
    assert.strictEqual(eventosTipo(c.store, TIPOS_EVENTO.CIENCIA_ENVIADA, id).length, 0, 'sem CIENCIA_ENVIADA falsa');
    assert.strictEqual(eventosTipo(c.store, TIPOS_EVENTO.MANIFESTACAO_ACEITA, id).length, 0, 'sem aceite falso');
    assert.strictEqual(eventosTipo(c.store, TIPOS_EVENTO.MANIFESTACAO_CLAIM, id).length, 0, 'claim não consumido');
    assert.strictEqual(c.store.docs.get(id).status, S.RESUMO_RECEBIDO, 'documento continua disponível');
  };

  await test('P08-02 MANUAL → zero 210210, sem CIENCIA_ENVIADA falsa, estado observável', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.MANUAL);
    await cicloMotor(c.motor);
    assertSemManifestacao(c);
    const est = c.motor._estado.docs['22'];
    assert.strictEqual(est.ultimoRetorno, 'AGUARDANDO_POLITICA_MANIFESTACAO');
    assert.strictEqual(est.politica, POLITICAS_MANIFESTACAO.MANUAL);
    assert.match(est.motivo, /MANUAL/);
  });

  await test('P08-03 CONFIRMAR_OPERADOR → zero envio; documento aguarda e o operador ainda pode confirmar', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.CONFIRMAR_OPERADOR);
    await cicloMotor(c.motor);
    assertSemManifestacao(c);
    assert.strictEqual(c.motor._estado.docs['22'].politica, POLITICAS_MANIFESTACAO.CONFIRMAR_OPERADOR);
    const r = await c.manifestacao.service.processarDocumento(22, { confirmado: true, apenasManifestacao: true });
    assert.strictEqual(c.manifestacao.getCiencias(), 1, 'confirmação explícita do operador envia');
    assert.notStrictEqual(r.ignorado, true);
  });

  await test('P08-04 MANUAL + scheduler automático (sincronização + motor) → zero envio', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.MANUAL);
    const rSync = await c.manifestacao.service.processarCandidatos({ apenasManifestacao: true });
    assert.strictEqual(rSync.executado, false);
    await cicloMotor(c.motor);
    await cicloMotor(c.motor);
    assertSemManifestacao(c);
  });

  await test('P08-05 CONFIRMAR_OPERADOR + scheduler automático → zero envio', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.CONFIRMAR_OPERADOR);
    const rSync = await c.manifestacao.service.processarCandidatos({ apenasManifestacao: true });
    assert.strictEqual(rSync.executado, false);
    assert.match(rSync.mensagem, /confirmação do operador/i);
    await cicloMotor(c.motor);
    await cicloMotor(c.motor);
    assertSemManifestacao(c);
  });

  await test('P08-06 AUTOMATICA + Gate 656 da empresa bloqueado → zero SOAP', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA);
    await bloquearEmpresa(c.gate, 2);
    await cicloMotor(c.motor);
    assertSemManifestacao(c);
  });

  await test('P08-07 AUTOMATICA + janela pós-596 vigente → zero SOAP', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA);
    await c.store.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documentoId: 22, resultado: '596', detalhe: { cStat: '596' }
    });
    await c.store.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
      documentoId: 22,
      resultado: '632',
      detalhe: { cStat: '632', proximaConsultaEm: '2026-09-27T14:00:00.000Z' }
    });
    await cicloMotor(c.motor);
    assert.strictEqual(c.manifestacao.getCiencias(), 0, 'não remanifesta após 596');
    assert.strictEqual(c.transporte.chamadas.length, 0, 'janela respeitada');
  });

  await test('P08-08 política MANUAL → AUTOMATICA: execução seguinte pode enviar', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.MANUAL);
    await cicloMotor(c.motor);
    assert.strictEqual(c.manifestacao.getCiencias(), 0);
    c.definirPolitica(POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA);
    await cicloMotor(c.motor);
    assert.strictEqual(c.manifestacao.getCiencias(), 1);
  });

  await test('P08-09 política AUTOMATICA → MANUAL: execução seguinte não envia', async () => {
    const c = cenarioP08(POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA, [doc(22, 2)]);
    await cicloMotor(c.motor);
    assert.strictEqual(c.manifestacao.getCiencias(), 1);
    c.definirPolitica(POLITICAS_MANIFESTACAO.MANUAL);
    c.store.docs.set(33, doc(33, 3));
    await cicloMotor(c.motor);
    assert.strictEqual(c.manifestacao.getCiencias(), 1, 'nenhum envio novo após voltar para MANUAL');
    assert.strictEqual(eventosTipo(c.store, TIPOS_EVENTO.MANIFESTACAO_CLAIM, 33).length, 0);
    assert.strictEqual(c.motor._estado.docs['33'].ultimoRetorno, 'AGUARDANDO_POLITICA_MANIFESTACAO');
  });

  await test('P08-10 fluxo automático não contorna a política com confirmado=true', async () => {
    // Motor com leitura de política divergente (AUTOMATICA) e configuração real MANUAL:
    // a regra de negócio no serviço ainda bloqueia.
    const c = cenarioP08(POLITICAS_MANIFESTACAO.MANUAL, [doc(22, 2)], {
      obterPoliticaManifestacao: async () => POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA
    });
    await cicloMotor(c.motor);
    assertSemManifestacao(c);
    const r = await c.manifestacao.service.processarDocumento(22, {
      origemAutomatica: true,
      confirmado: true,
      politica: POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA,
      apenasManifestacao: true
    });
    assert.strictEqual(r.ignorado, true);
    assert.strictEqual(r.politica, POLITICAS_MANIFESTACAO.MANUAL);
    assertSemManifestacao(c);
  });

  // ————————————————————————————————————— CLAIM
  console.log('\n— CLAIM expiração e recuperação —');

  assert.ok(Number.isFinite(TTL_CLAIM_MANIFESTACAO_MS) && TTL_CLAIM_MANIFESTACAO_MS > 90000,
    'TTL centralizado e maior que o timeout SOAP');

  await test('CLAIM-01 sem claim → claim adquirido com dono e expiração', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    const p = criarProcessoClaim(banco, banco.repo1, relogio, [doc(22, 2)]);
    const r = await p.service._reclamarManifestacao(doc(22, 2), { processoId: 'A' });
    assert.strictEqual(r.ok, true);
    const [c] = await banco.claims(22);
    const det = JSON.parse(c.detalhe_json);
    assert.strictEqual(det.token, r.token);
    assert.strictEqual(det.processo, 'A');
    assert.strictEqual(det.reclamadoEm, '2026-09-27T13:00:00.000Z');
    assert.strictEqual(new Date(det.expiraEm).getTime() - new Date(det.reclamadoEm).getTime(), TTL_CLAIM_MANIFESTACAO_MS);
  });

  await test('CLAIM-02 claim válido → segundo processo bloqueado', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    const a = criarProcessoClaim(banco, banco.repo1, relogio, [doc(22, 2)]);
    const b = criarProcessoClaim(banco, banco.repo2, relogio, [doc(22, 2)]);
    assert.strictEqual((await a.service._reclamarManifestacao(doc(22, 2), { processoId: 'A' })).ok, true);
    const rb = await b.service._reclamarManifestacao(doc(22, 2), { processoId: 'B' });
    assert.strictEqual(rb.ok, false);
    assert.match(rb.mensagem, /em andamento/);
    assert.strictEqual((await banco.claims(22)).length, 1);
  });

  await test('CLAIM-03 claim expirado → recuperável', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    const a = criarProcessoClaim(banco, banco.repo1, relogio, [doc(22, 2)]);
    const b = criarProcessoClaim(banco, banco.repo2, relogio, [doc(22, 2)]);
    await a.service._reclamarManifestacao(doc(22, 2), { processoId: 'A' });
    relogio.avancarMs(TTL_CLAIM_MANIFESTACAO_MS);
    const rb = await b.service._reclamarManifestacao(doc(22, 2), { processoId: 'B' });
    assert.strictEqual(rb.ok, true);
    assert.strictEqual(rb.recuperado, true);
    const claims = await banco.claims(22);
    assert.strictEqual(claims.length, 1, 'continua um único claim');
    assert.strictEqual(JSON.parse(claims[0].detalhe_json).processo, 'B');
  });

  await test('CLAIM-04 dois processos recuperam ao mesmo tempo → exatamente um vence (20 rodadas)', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    for (let rodada = 0; rodada < 20; rodada += 1) {
      const id = 500 + rodada;
      const d = doc(id, 2, { chave: CHAVE[2] });
      const crash = criarProcessoClaim(banco, banco.repo1, relogio, [d]);
      assert.strictEqual((await crash.service._reclamarManifestacao(d, { processoId: 'CRASH' })).ok, true);
      relogio.avancarMs(TTL_CLAIM_MANIFESTACAO_MS + 1000);
      const b = criarProcessoClaim(banco, banco.repo1, relogio, [d]);
      const c = criarProcessoClaim(banco, banco.repo2, relogio, [d]);
      const [rb, rc] = await Promise.all([
        b.service._reclamarManifestacao(d, { processoId: 'B' }),
        c.service._reclamarManifestacao(d, { processoId: 'C' })
      ]);
      const vencedores = [rb, rc].filter((r) => r.ok);
      assert.strictEqual(vencedores.length, 1, `rodada ${rodada}: exatamente um vencedor`);
      const claims = await banco.claims(id);
      assert.strictEqual(claims.length, 1);
      assert.strictEqual(JSON.parse(claims[0].detalhe_json).token, vencedores[0].token);
      assert.strictEqual((await banco.recuperacoes(id)).length, 1, 'uma única recuperação registrada');
    }
  });

  await test('CLAIM-05 claim válido não pode ser recuperado antes do TTL', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    const a = criarProcessoClaim(banco, banco.repo1, relogio, [doc(22, 2)]);
    const b = criarProcessoClaim(banco, banco.repo2, relogio, [doc(22, 2)]);
    const ra = await a.service._reclamarManifestacao(doc(22, 2), { processoId: 'A' });
    relogio.avancarMs(TTL_CLAIM_MANIFESTACAO_MS - 1);
    const rb = await b.service._reclamarManifestacao(doc(22, 2), { processoId: 'B' });
    assert.strictEqual(rb.ok, false);
    assert.strictEqual((await banco.recuperacoes(22)).length, 0);
    assert.strictEqual(JSON.parse((await banco.claims(22))[0].detalhe_json).token, ra.token, 'dono original mantido');
  });

  await test('CLAIM-06 liberação normal continua funcionando', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    const a = criarProcessoClaim(banco, banco.repo1, relogio, [doc(22, 2)]);
    const b = criarProcessoClaim(banco, banco.repo2, relogio, [doc(22, 2)]);
    const ra = await a.service._reclamarManifestacao(doc(22, 2), { processoId: 'A' });
    await a.service._liberarClaim(22, ra.token);
    assert.strictEqual((await banco.claims(22)).length, 0);
    const rb = await b.service._reclamarManifestacao(doc(22, 2), { processoId: 'B' });
    assert.strictEqual(rb.ok, true);
    assert.notStrictEqual(rb.recuperado, true, 'aquisição normal, não recuperação');
    // Ciência rejeitada também libera o claim (fluxo completo).
    const banco2 = await criarBancoClaims();
    const p = criarProcessoClaim(banco2, banco2.repo1, relogio, [doc(22, 2)], { cStatCiencia: '596' });
    await p.service.processarDocumento(22, { confirmado: true, apenasManifestacao: true });
    assert.strictEqual(p.getCiencias(), 1);
    assert.strictEqual((await banco2.claims(22)).length, 0, 'claim liberado após rejeição');
  });

  await test('CLAIM-07 crash após claim → claim permanece e só é recuperável após o TTL', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    let a = criarProcessoClaim(banco, banco.repo1, relogio, [doc(22, 2)]);
    await a.service._reclamarManifestacao(doc(22, 2), { processoId: 'A' });
    a = null; // processo A "morreu" sem liberar
    assert.strictEqual((await banco.claims(22)).length, 1, 'claim órfão permanece');
    const b = criarProcessoClaim(banco, banco.repo2, relogio, [doc(22, 2)]);
    relogio.avancarMs(TTL_CLAIM_MANIFESTACAO_MS - 1000);
    assert.strictEqual((await b.service._reclamarManifestacao(doc(22, 2), { processoId: 'B' })).ok, false);
    relogio.avancarMs(2000);
    assert.strictEqual((await b.service._reclamarManifestacao(doc(22, 2), { processoId: 'B' })).ok, true);
  });

  await test('CLAIM-08 histórico consistente após recuperação; dono antigo não apaga o novo claim', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    const a = criarProcessoClaim(banco, banco.repo1, relogio, [doc(22, 2)]);
    const b = criarProcessoClaim(banco, banco.repo2, relogio, [doc(22, 2)]);
    const ra = await a.service._reclamarManifestacao(doc(22, 2), { processoId: 'A' });
    const claimOriginalId = (await banco.claims(22))[0].id;
    relogio.avancarMin(15);
    const rb = await b.service._reclamarManifestacao(doc(22, 2), { processoId: 'B' });
    assert.strictEqual(rb.ok, true);

    const [rec] = await banco.recuperacoes(22);
    const h = JSON.parse(rec.detalhe_json);
    assert.strictEqual(h.claimOriginal.claimId, claimOriginalId);
    assert.strictEqual(h.claimOriginal.token, ra.token);
    assert.strictEqual(h.claimOriginal.processo, 'A');
    assert.strictEqual(h.claimOriginal.reclamadoEm, '2026-09-27T13:00:00.000Z');
    assert.strictEqual(h.claimOriginal.expiradoEm, new Date(Date.parse('2026-09-27T13:00:00.000Z') + TTL_CLAIM_MANIFESTACAO_MS).toISOString());
    assert.strictEqual(h.recuperadoPor.token, rb.token);
    assert.strictEqual(h.recuperadoPor.processo, 'B');
    assert.strictEqual(h.recuperadoEm, '2026-09-27T13:15:00.000Z');
    assert.strictEqual(h.ttlMs, TTL_CLAIM_MANIFESTACAO_MS);

    const [claimAtual] = await banco.claims(22);
    const recuperadoDe = JSON.parse(claimAtual.detalhe_json).recuperadoDe;
    assert.strictEqual(recuperadoDe.claimId, claimOriginalId, 'claim atual referencia o anterior');
    assert.strictEqual(recuperadoDe.processo, 'A');

    await a.service._liberarClaim(22, ra.token);
    assert.strictEqual((await banco.claims(22)).length, 1, 'liberação tardia do dono antigo não remove o claim de B');
  });

  await test('CLAIM-09 claim da empresa 1 não interfere na empresa 2', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    const p = criarProcessoClaim(banco, banco.repo1, relogio, [doc(11, 1), doc(22, 2)]);
    const r1 = await p.service._reclamarManifestacao(doc(11, 1), { processoId: 'E1' });
    const r2 = await p.service._reclamarManifestacao(doc(22, 2), { processoId: 'E2' });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    relogio.avancarMs(TTL_CLAIM_MANIFESTACAO_MS + 1);
    const outro = criarProcessoClaim(banco, banco.repo2, relogio, [doc(22, 2)]);
    await outro.service._reclamarManifestacao(doc(22, 2), { processoId: 'E2-rec' });
    assert.strictEqual(JSON.parse((await banco.claims(11))[0].detalhe_json).token, r1.token, 'claim da empresa 1 intacto');
    assert.strictEqual((await banco.recuperacoes(11)).length, 0);
  });

  await test('CLAIM-10 recuperação não permite duas manifestações simultâneas', async () => {
    const banco = await criarBancoClaims();
    const relogio = criarRelogio();
    const d = doc(22, 2);
    const crash = criarProcessoClaim(banco, banco.repo1, relogio, [d]);
    await crash.service._reclamarManifestacao(d, { processoId: 'CRASH' });
    relogio.avancarMs(TTL_CLAIM_MANIFESTACAO_MS + 1000);
    const b = criarProcessoClaim(banco, banco.repo1, relogio, [d], { atrasoCienciaMs: 30 });
    const c = criarProcessoClaim(banco, banco.repo2, relogio, [d], { atrasoCienciaMs: 30 });
    const [rb, rc] = await Promise.all([
      b.service.processarDocumento(22, { apenasManifestacao: true, processoId: 'B' }),
      c.service.processarDocumento(22, { apenasManifestacao: true, processoId: 'C' })
    ]);
    assert.strictEqual(b.getCiencias() + c.getCiencias(), 1, 'exatamente uma ciência 210210');
    assert.strictEqual(await banco.contar(TIPOS_EVENTO.MANIFESTACAO_ACEITA, 22), 1);
    assert.strictEqual((await banco.recuperacoes(22)).length, 1);
    const perdedor = [rb, rc].find((r) => r.ignorado === true);
    assert.ok(perdedor, 'o outro processo foi recusado');
    // Execução seguinte com aceite registrado não reenvia.
    const e = criarProcessoClaim(banco, banco.repo2, relogio, [d]);
    await e.service.processarDocumento(22, { apenasManifestacao: true });
    assert.strictEqual(e.getCiencias(), 0);
  });

  for (const db of bancosAbertos) {
    await new Promise((resolve) => db.close(() => resolve()));
  }

  console.log(`\n${ok} ok, ${falhas} falha(s)\n`);
  if (falhas) process.exit(1);
}

run();
