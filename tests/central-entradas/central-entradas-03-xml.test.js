/**
 * CENTRAL-ENTRADAS-03 — Fechamento operacional do XML (Matriz / Filial 2 / Filial 3).
 *
 * Cadeia exercitada com código real: CentralManifestacaoDfeService → consultarNotaPorChave
 * (montagem consChNFe, parser do retorno, docZip gzip) → CentralDfePersistenciaService.
 * Somente o transporte SOAP e os repositórios SQLite são simulados.
 *
 * Executar: node tests/central-entradas/central-entradas-03-xml.test.js
 */
'use strict';

const assert = require('assert');
const zlib = require('zlib');
const os = require('os');
const fs = require('fs');
const path = require('path');

// O XML_WAIT scheduler carrega backend/database.js: nunca apontar para o banco oficial.
if (!process.env.DB_DIR) {
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ce03-xml-'));
}
const sqlite3 = require('sqlite3');
require.cache[require.resolve('../../backend/database')] = {
  exports: new sqlite3.Database(':memory:')
};
const enfileiramentosXmlWait = [];
require.cache[require.resolve('../../backend/motores/central-entradas/services/CentralXmlWaitScheduler')] = {
  exports: {
    enfileirarRecuperacao: async (documento, meta) => {
      enfileiramentosXmlWait.push({ documentoId: documento.id, motivo: meta?.motivo });
    },
    cancelar: () => true
  }
};

const CentralManifestacaoDfeService = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoDfeService'
);
const { POLITICAS_MANIFESTACAO } = CentralManifestacaoDfeService;
const MotorRecuperacaoXmlService = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService'
);
const CentralDfePersistenciaService = require(
  '../../backend/motores/central-entradas/services/CentralDfePersistenciaService'
);
const { consultarNotaPorChave } = require('../../backend/services/fiscal/distribuicaoDFe');
const {
  CentralSefazOperationalGate
} = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { DocumentoDfeTipo } = require('../../backend/motores/central-entradas/core/DocumentoDfeTipo');
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { CHAVES } = require('../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig');

const S = DocumentoFiscalStatus;
const EMP = Object.freeze({ MATRIZ: 1, FILIAL2: 2, FILIAL3: 3 });
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

function contextoPorEmpresa(opts = {}) {
  const empresaId = Number(opts.empresaId);
  return {
    ok: true,
    contexto: {
      empresaId,
      ambiente: 1,
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

function retDist({ cStat, xMotivo, docXml = null }) {
  const lote = docXml
    ? `<loteDistDFeInt><docZip NSU="000000000000010" schema="procNFe_v4.00.xsd">${zlib.gzipSync(Buffer.from(docXml, 'utf8')).toString('base64')}</docZip></loteDistDFeInt>`
    : '';
  return `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><verAplic>1.7.6</verAplic>`
    + `<cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo><dhResp>2026-09-27T10:00:00-03:00</dhResp>`
    + `<ultNSU>000000000000010</ultNSU><maxNSU>000000000000010</maxNSU>${lote}</retDistDFeInt>`;
}

/**
 * Transporte SOAP simulado: responde por empresa (CNPJ no XML de consulta).
 * @param {Object<number, Function|Object>} respostas por empresaId
 */
function criarTransporte(respostas) {
  const chamadas = [];
  const enviar = async (params) => {
    const cnpj = params.xmlConsulta.match(/<CNPJ>(\d+)<\/CNPJ>/)[1];
    const chave = params.xmlConsulta.match(/<chNFe>(\d+)<\/chNFe>/)?.[1] || null;
    const empresaId = Number(Object.keys(CNPJ).find((k) => CNPJ[k] === cnpj));
    chamadas.push({
      empresaId,
      cnpj,
      chave,
      tpAmb: params.xmlConsulta.match(/<tpAmb>(\d)<\/tpAmb>/)[1],
      ambiente: params.ambiente,
      cert: params.certificadoPath
    });
    const r = typeof respostas[empresaId] === 'function' ? respostas[empresaId](chave) : respostas[empresaId];
    if (r instanceof Error) {
      return { success: false, error: r.message };
    }
    return { success: true, body: r, statusCode: 200, endpoint: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe' };
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

/** Store compartilhado: Central (buscarPorId) e persistência DF-e (buscarPorChave+empresa). */
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
      const emp = Number(empresaId);
      const d = [...docs.values()].find((x) => x.chave === chave && Number(x.empresaId) === emp);
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
        ...atual,
        xml,
        nsu: nsu || atual.nsu,
        tipoDocumento: tipoDfe,
        status: S.XML_COMPLETO
      });
      return { documento: { ...docs.get(Number(documento.id)) } };
    }
  };

  const persistencias = [];
  const criarPersistencia = (empresaId) => {
    const p = new CentralDfePersistenciaService({
      documentosRepository,
      historicoRepository,
      transitionService,
      atualizacaoService,
      empresaId
    });
    p.existeCompraComChave = async () => false;
    persistencias.push(empresaId);
    return p;
  };

  return {
    docs,
    eventos,
    historico,
    persistencias,
    documentosRepository,
    eventosRepository,
    historicoRepository,
    transitionService,
    criarPersistencia
  };
}

/** Gate SEFAZ real, isolado por cenário (o singleton do processo carregaria bloqueios entre testes). */
function criarGateIsolado() {
  const mapa = new Map();
  return new CentralSefazOperationalGate({
    configRepository: {
      async buscarPorChave(chave) {
        return mapa.has(chave) ? { chave, valor: mapa.get(chave), tipo: 'json' } : null;
      },
      parseValor: (reg) => reg.valor,
      async salvar(chave, valor) { mapa.set(chave, valor); }
    },
    agora: () => new Date('2026-09-27T13:00:00.000Z')
  });
}

function criarManifestacao(store, transporte, opcoes = {}) {
  let ciencias = 0;
  const service = new CentralManifestacaoDfeService({
    gate: opcoes.gate || criarGateIsolado(),
    documentosRepository: store.documentosRepository,
    historicoRepository: store.historicoRepository,
    eventosRepository: store.eventosRepository,
    transitionService: store.transitionService,
    criarPersistencia: store.criarPersistencia,
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
      const cStat = opcoes.cStatCiencia || '596';
      return {
        success: true,
        body: `<retEvento><infEvento><cStat>${cStat}</cStat><xMotivo>${cStat === '596' ? 'Rejeicao: Evento apresentado apos o prazo permitido para o evento: [10 dias]' : 'Evento registrado e vinculado a NF-e'}</xMotivo><nProt>${cStat === '135' ? '923260000000001' : ''}</nProt></infEvento></retEvento>`,
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
    agora: () => new Date('2026-09-27T13:00:00.000Z'),
    emitirEvento: async (dados) => store.eventosRepository.inserir(dados)
  });
  return { service, getCiencias: () => ciencias };
}

function criarMotor(store, transporte, opcoes = {}) {
  const config = new Map([[CHAVES.ATIVA, true]]);
  const gateChamadas = [];
  let bloqueado = false;
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
    gate: {
      autorizarConsultaDistDfe: async () => (bloqueado
        ? { permitido: false, codigo: 'BLOQUEADO_CONSUMO_INDEVIDO_656', cStat: '656', mensagem: 'bloqueado 656' }
        : { permitido: true }),
      processarRespostaSefaz: async (r) => {
        gateChamadas.push(String(r.cStat));
        if (String(r.cStat) === '656') bloqueado = true;
      }
    },
    obterContextoOperacional: async (opts) => contextoPorEmpresa(opts),
    criarPersistencia: store.criarPersistencia,
    consultarNotaPorChave: (chave, deps) => consultarNotaPorChave(chave, {
      ...deps,
      enviarDistribuicaoDfe: transporte.enviar
    }),
    processarDocumento: opcoes.processarDocumento || (async () => null),
    agora: () => new Date('2026-09-27T13:00:00.000Z')
  });
  motor._processarManifestacao = async () => {
    manifestacoes += 1;
    return { sucesso: true };
  };
  return { motor, gateChamadas, getManifestacoes: () => manifestacoes };
}

async function run() {
  console.log('\n=== CENTRAL-ENTRADAS-03 — XML Matriz / Filial 2 / Filial 3 ===\n');

  for (const [nome, empresaId, docId] of [
    ['Matriz', EMP.MATRIZ, 11],
    ['Filial 2', EMP.FILIAL2, 22],
    ['Filial 3', EMP.FILIAL3, 33]
  ]) {
    await test(`${nome}: 596 → consChNFe (CNPJ/PFX/empresa próprios) → procNFe → PROC_NFE persistido`, async () => {
      const store = criarStore([docResumo(docId, empresaId)]);
      const transporte = criarTransporte({
        [empresaId]: retDist({ cStat: '138', xMotivo: 'Documento localizado', docXml: procNFeXml(empresaId) })
      });
      const { service, getCiencias } = criarManifestacao(store, transporte);
      const r = await service.processarDocumento(docId, { confirmado: true });

      assert.strictEqual(getCiencias(), 1);
      assert.strictEqual(transporte.chamadas.length, 1, 'uma única consChNFe');
      const c = transporte.chamadas[0];
      assert.strictEqual(c.empresaId, empresaId);
      assert.strictEqual(c.cnpj, CNPJ[empresaId]);
      assert.strictEqual(c.chave, CHAVE[empresaId]);
      assert.strictEqual(c.tpAmb, '1');
      assert.ok(c.cert.endsWith(`certificado-empresa-${empresaId}.pfx`));
      assert.deepStrictEqual(store.persistencias, [empresaId]);

      assert.strictEqual(r.xmlCompleto, true);
      assert.strictEqual(r.cStatCiencia, '596');
      assert.notStrictEqual(r.status, S.XML_INDISPONIVEL);
      const doc = store.docs.get(docId);
      assert.strictEqual(doc.status, S.XML_COMPLETO);
      assert.strictEqual(doc.tipoDocumento, DocumentoDfeTipo.PROC_NFE);
      assert.strictEqual(Number(doc.empresaId), empresaId);
      assert.ok(doc.xml.includes(`NFe${CHAVE[empresaId]}`));
      assert.ok(doc.xml.includes(`<CNPJ>${CNPJ[empresaId]}</CNPJ>`));
      assert.strictEqual(store.docs.size, 1, 'sem documento duplicado');
    });
  }

  await test('consChNFe sem XML (137) após 596 → XML_INDISPONIVEL com cStat real registrado', async () => {
    const store = criarStore([docResumo(22, EMP.FILIAL2)]);
    const transporte = criarTransporte({ 2: retDist({ cStat: '137', xMotivo: 'Nenhum documento localizado' }) });
    const { service } = criarManifestacao(store, transporte);
    const r = await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(r.status, S.XML_INDISPONIVEL);
    assert.strictEqual(r.cStatConsChNFe, '137');
    assert.strictEqual(store.docs.get(22).status, S.XML_INDISPONIVEL);
    const ev = store.eventos.find((e) => e.tipo === TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO);
    assert.strictEqual(ev.detalhe.cStat, '137');
    assert.strictEqual(ev.detalhe.xMotivo, 'Nenhum documento localizado');
  });

  await test('cStat 137 no motor: documento permanece monitorado (não inventa status)', async () => {
    const store = criarStore([docResumo(33, EMP.FILIAL3, { status: S.XML_INDISPONIVEL })]);
    const transporte = criarTransporte({ 3: retDist({ cStat: '137', xMotivo: 'Nenhum documento localizado' }) });
    const { motor } = criarMotor(store, transporte);
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(rel.consultados, 1);
    assert.strictEqual(rel.recuperados, 0);
    assert.strictEqual(store.docs.get(33).status, S.XML_INDISPONIVEL);
    assert.strictEqual(motor._estado.docs['33'].ultimoRetorno, '137');
  });

  await test('cStat 656 no consChNFe após 596: não encerra como XML_INDISPONIVEL', async () => {
    const store = criarStore([docResumo(33, EMP.FILIAL3)]);
    const transporte = criarTransporte({ 3: retDist({ cStat: '656', xMotivo: 'Rejeicao: Consumo Indevido' }) });
    const { service } = criarManifestacao(store, transporte);
    const r = await service.processarDocumento(33, { confirmado: true });
    assert.strictEqual(r.encerrado, false);
    assert.strictEqual(r.cStatConsChNFe, '656');
    assert.strictEqual(store.docs.get(33).status, S.RESUMO_RECEBIDO);
  });

  await test('cStat 656 no motor: aciona cooldown do Gate existente e interrompe o lote (sem retry paralelo)', async () => {
    const store = criarStore([
      docResumo(22, EMP.FILIAL2, { status: S.XML_INDISPONIVEL }),
      docResumo(33, EMP.FILIAL3, { status: S.XML_INDISPONIVEL })
    ]);
    const transporte = criarTransporte({
      2: retDist({ cStat: '656', xMotivo: 'Rejeicao: Consumo Indevido' }),
      3: retDist({ cStat: '137', xMotivo: 'Nenhum documento localizado' })
    });
    const { motor, gateChamadas } = criarMotor(store, transporte);
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.deepStrictEqual(gateChamadas, ['656']);
    assert.strictEqual(transporte.chamadas.length, 1, 'segunda consulta barrada pelo Gate');
    assert.strictEqual(rel.gateBloqueado, true);
    assert.strictEqual(store.docs.get(22).status, S.XML_INDISPONIVEL);
    assert.strictEqual(store.docs.get(33).status, S.XML_INDISPONIVEL);
  });

  await test('erro temporário de transporte no consChNFe: não vira XML_INDISPONIVEL', async () => {
    const store = criarStore([docResumo(33, EMP.FILIAL3)]);
    const transporte = criarTransporte({ 3: new Error('socket hang up') });
    const { service } = criarManifestacao(store, transporte);
    const r = await service.processarDocumento(33, { confirmado: true });
    assert.strictEqual(r.encerrado, false);
    assert.strictEqual(store.docs.get(33).status, S.RESUMO_RECEBIDO);
    const ev = store.eventos.find((e) => e.resultado === 'CONS_CHNFE_ERRO');
    assert.ok(ev, 'erro registrado como CONS_CHNFE_ERRO');
    assert.strictEqual(ev.detalhe.cStat, null);
  });

  await test('rejeição SEFAZ no consChNFe (632): cStat/xMotivo preservados, sem XML_INDISPONIVEL automático', async () => {
    const store = criarStore([docResumo(22, EMP.FILIAL2)]);
    const transporte = criarTransporte({
      2: retDist({ cStat: '632', xMotivo: 'Rejeicao: Solicitacao fora de prazo, a NF-e nao esta mais disponivel para download' })
    });
    const { service } = criarManifestacao(store, transporte);
    const r = await service.processarDocumento(22, { confirmado: true });
    assert.strictEqual(r.encerrado, false);
    assert.strictEqual(r.cStatConsChNFe, '632');
    assert.strictEqual(store.docs.get(22).status, S.RESUMO_RECEBIDO);
    const ev = store.eventos.find((e) => e.tipo === TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO);
    assert.strictEqual(ev.resultado, '632');
    assert.strictEqual(ev.detalhe.cStat, '632');
    assert.strictEqual(ev.detalhe.rejeicaoSefaz, true);
    assert.ok(/fora de prazo/.test(ev.detalhe.xMotivo));
  });

  await test('rejeição SEFAZ no motor: estado/evento registram o cStat real', async () => {
    const store = criarStore([docResumo(33, EMP.FILIAL3, { status: S.XML_INDISPONIVEL })]);
    const transporte = criarTransporte({ 3: retDist({ cStat: '640', xMotivo: 'Rejeicao: CNPJ nao autorizado' }) });
    const { motor } = criarMotor(store, transporte);
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(rel.falhas, 1);
    assert.strictEqual(motor._estado.docs['33'].ultimoRetorno, '640');
    const ev = store.eventos.find((e) => e.tipo === TIPOS_EVENTO.RECUPERACAO_XML_FALHA);
    assert.strictEqual(ev.detalhe.cStat, '640');
    assert.strictEqual(store.docs.get(33).status, S.XML_INDISPONIVEL);
  });

  await test('retry: XML_INDISPONIVEL reconsulta consChNFe sem nova ciência e promove PROC_NFE', async () => {
    const store = criarStore([docResumo(33, EMP.FILIAL3, { status: S.XML_INDISPONIVEL })]);
    const transporte = criarTransporte({
      3: retDist({ cStat: '138', xMotivo: 'Documento localizado', docXml: procNFeXml(3) })
    });
    const { service, getCiencias } = criarManifestacao(store, transporte);
    const r = await service.processarDocumento(33, { confirmado: true });
    assert.strictEqual(getCiencias(), 0);
    assert.strictEqual(r.xmlCompleto, true);
    assert.strictEqual(store.docs.get(33).tipoDocumento, DocumentoDfeTipo.PROC_NFE);
    assert.strictEqual(store.docs.get(33).status, S.XML_COMPLETO);
  });

  await test('XML já persistido: novo procNFe da mesma chave não duplica documento', async () => {
    const store = criarStore([docResumo(11, EMP.MATRIZ, {
      status: S.EM_REVISAO,
      tipoDocumento: DocumentoDfeTipo.PROC_NFE,
      xml: procNFeXml(1)
    })]);
    const persist = store.criarPersistencia(1);
    const r = await persist.persistirDocumentoDfe({ xml: procNFeXml(1), nsu: '10', origem: 'consulta_chave' });
    assert.strictEqual(r.duplicado, true);
    assert.strictEqual(r.novo, false);
    assert.strictEqual(store.docs.size, 1);
    assert.strictEqual(store.docs.get(11).status, S.EM_REVISAO);
  });

  await test('isolamento: procNFe recebido pela Filial 2 nunca atualiza documento da Filial 3 ou Matriz', async () => {
    const chaveComum = CHAVE[3];
    const store = criarStore([
      docResumo(33, EMP.FILIAL3, { chave: chaveComum }),
      docResumo(11, EMP.MATRIZ, { chave: chaveComum })
    ]);
    const persist = store.criarPersistencia(EMP.FILIAL2);
    await persist.persistirDocumentoDfe({ xml: procNFeXml(2, chaveComum), nsu: '10', origem: 'consulta_chave' });
    assert.strictEqual(store.docs.get(33).status, S.RESUMO_RECEBIDO);
    assert.strictEqual(store.docs.get(33).tipoDocumento, DocumentoDfeTipo.RES_NFE);
    assert.strictEqual(store.docs.get(11).status, S.RESUMO_RECEBIDO);
    const daFilial2 = [...store.docs.values()].filter((d) => Number(d.empresaId) === EMP.FILIAL2);
    assert.strictEqual(daFilial2.length, 1);
  });

  await test('isolamento no motor: 3 empresas no mesmo ciclo, cada XML na própria empresa', async () => {
    const store = criarStore([
      docResumo(11, EMP.MATRIZ, { status: S.XML_INDISPONIVEL }),
      docResumo(22, EMP.FILIAL2, { status: S.XML_INDISPONIVEL }),
      docResumo(33, EMP.FILIAL3, { status: S.XML_INDISPONIVEL })
    ]);
    const transporte = criarTransporte({
      1: retDist({ cStat: '138', xMotivo: 'Documento localizado', docXml: procNFeXml(1) }),
      2: retDist({ cStat: '138', xMotivo: 'Documento localizado', docXml: procNFeXml(2) }),
      3: retDist({ cStat: '138', xMotivo: 'Documento localizado', docXml: procNFeXml(3) })
    });
    const { motor } = criarMotor(store, transporte);
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(rel.recuperados, 3);
    for (const [id, emp] of [[11, 1], [22, 2], [33, 3]]) {
      const d = store.docs.get(id);
      assert.strictEqual(d.tipoDocumento, DocumentoDfeTipo.PROC_NFE);
      assert.ok(d.xml.includes(`<CNPJ>${CNPJ[emp]}</CNPJ>`), `XML da empresa ${emp} no doc ${id}`);
      const chamada = transporte.chamadas.find((c) => c.chave === CHAVE[emp]);
      assert.strictEqual(chamada.cnpj, CNPJ[emp]);
      assert.ok(chamada.cert.endsWith(`certificado-empresa-${emp}.pfx`));
    }
    assert.strictEqual(store.docs.size, 3);
  });

  await test('lock: ciclos simultâneos do motor não geram consChNFe paralelo para o mesmo documento', async () => {
    const store = criarStore([docResumo(22, EMP.FILIAL2, { status: S.XML_INDISPONIVEL })]);
    const transporte = criarTransporte({
      2: retDist({ cStat: '138', xMotivo: 'Documento localizado', docXml: procNFeXml(2) })
    });
    const { motor } = criarMotor(store, transporte);
    const [a, b] = await Promise.all([
      motor.executarCiclo({ forcar: true }),
      motor.executarCiclo({ forcar: true })
    ]);
    motor.parar({ silencioso: true });
    assert.strictEqual(transporte.chamadas.length, 1, 'uma única consulta consChNFe');
    assert.ok([a, b].some((r) => r.ignorado === true && r.motivo === 'ciclo_em_execucao'));
    assert.strictEqual(store.docs.size, 1);
  });

  await test('documento antigo (596 já registrado): motor reconsulta pela fila existente, sem remanifestar nem duplicar', async () => {
    const store = criarStore([docResumo(18, EMP.FILIAL3, { createdAt: '2026-08-30T10:00:00.000Z' })]);
    await store.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.CIENCIA_ENVIADA, documentoId: 18, resultado: 'ENVIADA', detalhe: { empresaId: 3 }
    });
    await store.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documentoId: 18, resultado: '596', detalhe: { cStat: '596' }
    });
    const transporte = criarTransporte({
      3: retDist({ cStat: '138', xMotivo: 'Documento localizado', docXml: procNFeXml(3) })
    });
    const { motor, getManifestacoes } = criarMotor(store, transporte);
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(getManifestacoes(), 0, 'não remanifesta');
    assert.strictEqual(rel.recuperados, 1);
    assert.strictEqual(transporte.chamadas.length, 1);
    assert.strictEqual(transporte.chamadas[0].cnpj, CNPJ[3]);
    assert.strictEqual(store.docs.get(18).tipoDocumento, DocumentoDfeTipo.PROC_NFE);
    assert.strictEqual(store.docs.size, 1);
    const ciencias = store.eventos.filter((e) => e.tipo === TIPOS_EVENTO.CIENCIA_ENVIADA);
    assert.strictEqual(ciencias.length, 1, 'nenhum evento de ciência duplicado');
  });

  await test('Matriz continua funcionando: ciência 135 aguarda NSU e não aciona consChNFe nem 596', async () => {
    const store = criarStore([docResumo(11, EMP.MATRIZ)]);
    const transporte = criarTransporte({ 1: retDist({ cStat: '137', xMotivo: 'Nenhum documento localizado' }) });
    const { service, getCiencias } = criarManifestacao(store, transporte, { cStatCiencia: '135' });
    const r = await service.processarDocumento(11, { confirmado: true, apenasManifestacao: true });
    assert.strictEqual(getCiencias(), 1);
    assert.strictEqual(r.sucesso, true);
    assert.strictEqual(transporte.chamadas.length, 0);
    assert.strictEqual(store.docs.get(11).status, S.RESUMO_RECEBIDO);
    const aceita = store.eventos.find((e) => e.tipo === TIPOS_EVENTO.MANIFESTACAO_ACEITA);
    assert.strictEqual(aceita.detalhe.cStat, '135');
    assert.ok(enfileiramentosXmlWait.some((e) => e.documentoId === 11 && e.motivo === 'pos_ciencia_aguardar_janela'));
  });

  console.log(`\n${ok} ok, ${falhas} falha(s)\n`);
  if (falhas) process.exit(1);
}

run();
