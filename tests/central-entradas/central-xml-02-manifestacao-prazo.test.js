/**
 * CENTRAL-XML-02 — Relógio da Ciência da Emissão (210210), urgência, Motor de Manifestação
 * independente (scheduler), ordem de seleção, documento vencido, alerta e telemetria.
 *
 * Código real exercitado: prazoManifestacao (calcularPrazoManifestacao), CandidatoManifestacaoDTO,
 * CentralManifestacaoDfeService (seleção, processarCandidatos, processarDocumento, _enviarCiencia,
 * claim atômico, painel de prazos), CentralManifestacaoScheduler, CentralDocumentosRepository
 * (extração de dhEmi em SQLite :memory:) e CentralSefazOperationalGate (instância isolada).
 * Simulados: repositórios de eventos/histórico, contexto fiscal (certificado fictício, nunca aberto),
 * assinatura do envelope e transporte 210210 (barreira: nenhum SOAP real), DistDFe e consChNFe.
 * Nenhuma chamada SEFAZ real; nenhuma manifestação real; banco oficial nunca é aberto.
 *
 * Executar: node tests/central-entradas/central-xml-02-manifestacao-prazo.test.js
 */
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

if (!process.env.DB_DIR) {
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'central-xml-02-'));
}
const BANCO_OFICIAL = /MercantilFiscal[\\/]+dados[\\/]+mercadao\.db/i;
assert.ok(!BANCO_OFICIAL.test(process.env.DB_DIR), 'DB_DIR não pode apontar para o banco oficial');

const sqlite3 = require('sqlite3');
const dbMemoria = new sqlite3.Database(':memory:');
require.cache[require.resolve('../../backend/database')] = { exports: dbMemoria };
require.cache[require.resolve('../../backend/motores/central-entradas/services/CentralXmlWaitScheduler')] = {
  exports: { enfileirarRecuperacao: async () => {}, cancelar: () => true }
};

// Barreira: qualquer SOAP real (DistDFe / 210210) falha o teste.
const runtimeDist = require('../../backend/services/fiscal/distribuicaoDfeRuntime');
let soapReal = 0;
runtimeDist.enviarDistribuicaoDfe = async () => {
  soapReal += 1;
  throw new Error('SOAP real proibido na CENTRAL-XML-02');
};

const prazoLib = require('../../backend/motores/central-entradas/utils/prazoManifestacao');
const {
  calcularPrazoManifestacao,
  URGENCIA_MANIFESTACAO: U,
  MOTIVOS_PRAZO_INVALIDO,
  formatarDataHoraBrasil,
  montarMensagemAlertaPrazo
} = prazoLib;
const { montarCandidatoManifestacao } = require('../../backend/motores/central-entradas/contracts/CandidatoManifestacaoDTO');
const CentralManifestacaoDfeService = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoDfeService'
);
const {
  POLITICAS_MANIFESTACAO,
  MOTIVOS_EXCLUSAO_CANDIDATO: M,
  CODIGO_CIENCIA_FORA_DO_PRAZO
} = CentralManifestacaoDfeService;
const { CentralManifestacaoScheduler } = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoScheduler'
);
const { CentralSefazOperationalGate } = require(
  '../../backend/motores/central-entradas/services/CentralSefazOperationalGate'
);
const CentralDocumentosRepository = require(
  '../../backend/motores/central-entradas/repositories/CentralDocumentosRepository'
);
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { DocumentoDfeTipo } = require('../../backend/motores/central-entradas/core/DocumentoDfeTipo');
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const AGORA_ISO = '2026-09-27T13:00:00.000Z'; // 10:00 em Brasília
const CNPJ = Object.freeze({ 1: '38111111000115', 2: '38111111000387', 3: '38111111000204' });
const SENHA_FICTICIA = 'senha-ficticia-nao-logar';

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

function criarRelogio(iso = AGORA_ISO) {
  let t = new Date(iso).getTime();
  return {
    agora: () => new Date(t),
    definir: (novo) => { t = new Date(novo).getTime(); },
    avancarMs: (ms) => { t += ms; }
  };
}

const chaveDoc = (id) => `2326${String(id).padStart(40, '0')}`;
const xmlResNFe = (id, dhEmi) => (
  `<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>${chaveDoc(id)}</chNFe>`
  + `<CNPJ>07000000000100</CNPJ><xNome>Fornecedor Ficticio</xNome>`
  + (dhEmi ? `<dhEmi>${dhEmi}</dhEmi>` : '')
  + '<tpNF>1</tpNF><vNF>10.00</vNF><cSitNFe>1</cSitNFe></resNFe>'
);
/** dhEmi em Brasília (-03:00) `horas` antes do relógio. */
const dhEmiHa = (relogio, horas) => {
  const ms = relogio.agora().getTime() - horas * HORA_MS;
  const local = new Date(ms - 3 * HORA_MS).toISOString().slice(0, 19);
  return `${local}-03:00`;
};

/** Documento como gravado pela Central: data_emissao só com a data; dhEmi real no XML resNFe. */
function docPendente(id, empresaId, dhEmi, extra = {}) {
  return {
    id,
    empresaId,
    empresa_id: empresaId,
    chave: chaveDoc(id),
    numero: String(100000 + id),
    status: DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO,
    tipoDocumento: DocumentoDfeTipo.RES_NFE,
    dataEmissao: dhEmi ? dhEmi.slice(0, 10) : null,
    xml: xmlResNFe(id, dhEmi),
    createdAt: '2026-09-01T00:00:00.000Z',
    ...extra
  };
}

const TIPOS_UNICOS = new Set([TIPOS_EVENTO.MANIFESTACAO_CLAIM, TIPOS_EVENTO.MANIFESTACAO_ACEITA]);

/** Repositório de eventos com índice único (tipo, documento) para claim/aceite — como o SQLite. */
function criarEventos(relogio) {
  const eventos = [];
  let seq = 0;
  const repo = {
    eventos,
    async listar(filtros = {}) {
      return eventos
        .filter((e) => (!filtros.tipo || e.tipo === filtros.tipo)
          && (filtros.documentoId == null || e.documentoId === Number(filtros.documentoId)))
        .sort((a, b) => b.id - a.id)
        .slice(0, filtros.limite || 50);
    },
    async inserir(dados) {
      seq += 1;
      const evento = {
        id: seq,
        createdAt: relogio.agora().toISOString(),
        ...dados,
        documentoId: dados.documentoId == null ? null : Number(dados.documentoId)
      };
      eventos.push(evento);
      return evento;
    },
    async inserirUnico(dados) {
      const documentoId = Number(dados.documentoId);
      if (TIPOS_UNICOS.has(dados.tipo) && eventos.some((e) => e.tipo === dados.tipo && e.documentoId === documentoId)) {
        return { evento: null, criado: false, conflito: true };
      }
      const evento = await repo.inserir(dados);
      return { evento, criado: true, conflito: false };
    },
    async removerPorTipoDocumento(tipo, documentoId) {
      for (let i = eventos.length - 1; i >= 0; i -= 1) {
        if (eventos[i].tipo === tipo && eventos[i].documentoId === Number(documentoId)) eventos.splice(i, 1);
      }
      return true;
    },
    async removerPorTipoDocumentoToken(tipo, documentoId, token) {
      for (let i = eventos.length - 1; i >= 0; i -= 1) {
        const e = eventos[i];
        if (e.tipo === tipo && e.documentoId === Number(documentoId) && e.detalhe?.token === token) eventos.splice(i, 1);
      }
      return true;
    },
    async contar() { return eventos.length; },
    doTipo: (tipo) => eventos.filter((e) => e.tipo === tipo)
  };
  return repo;
}

/** Gate por empresa (simulado): bloqueio por empresaId, contadores de consulta. */
function criarGateFalso(bloqueadas = []) {
  const bloqueio = new Set(bloqueadas.map(Number));
  const chamadas = { avaliar: [], autorizar: [], respostas: [] };
  return {
    bloqueio,
    chamadas,
    async avaliarBloqueioContexto(ctx) {
      chamadas.avaliar.push(Number(ctx.empresaId));
      return bloqueio.has(Number(ctx.empresaId))
        ? { bloqueado: true, cStat: '656', escopo: 'EMPRESA' }
        : { bloqueado: false, cStat: null, escopo: 'EMPRESA' };
    },
    async autorizarConsultaDistDfe(ctx) {
      chamadas.autorizar.push(Number(ctx.empresaId));
      if (bloqueio.has(Number(ctx.empresaId))) {
        return {
          permitido: false,
          codigo: 'COOLDOWN_656',
          escopo: 'EMPRESA',
          proximaConsultaEm: '2026-09-27T14:00:00.000Z',
          mensagem: 'Consumo indevido: aguardando cooldown da empresa.'
        };
      }
      return { permitido: true };
    },
    async processarRespostaSefaz(resp, ctx) {
      chamadas.respostas.push({ cStat: resp.cStat, empresaId: Number(ctx.empresaId) });
    }
  };
}

function contextoFiscal(empresaId) {
  return {
    ok: true,
    contexto: {
      empresaId,
      ambiente: 1,
      uf: 'CE',
      codigoUf: '23',
      cnpj: CNPJ[empresaId],
      certificadoPath: `C:\\certs-ficticios\\empresa-${empresaId}.pfx`,
      certificadoSenha: SENHA_FICTICIA,
      versaoServico: '1.01',
      origemAmbiente: 'empresas_configuracao_fiscal'
    }
  };
}

const retEvento = (cStat, xMotivo) => (
  '<retEnvEvento><retEvento versao="1.00"><infEvento>'
  + `<tpAmb>1</tpAmb><cOrgao>91</cOrgao><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>`
  + `<nProt>${cStat === '135' ? '891260000000001' : ''}</nProt><dhRegEvento>2026-09-27T10:00:05-03:00</dhRegEvento>`
  + '</infEvento></retEvento></retEnvEvento>'
);

/**
 * Cenário com processarDocumento REAL: o transporte 210210 é um stub que conta envios
 * (barreira) e responde conforme `respostaCiencia`.
 */
function cenario(docs, opcoes = {}) {
  const relogio = opcoes.relogio || criarRelogio();
  const eventosRepository = opcoes.eventosRepository || criarEventos(relogio);
  const gate = opcoes.gate || criarGateFalso(opcoes.bloqueadas || []);
  const envios = opcoes.envios || [];
  const consultas = { dist: 0, consChNFe: 0 };
  const historico = [];
  const service = new CentralManifestacaoDfeService({
    documentosRepository: {
      listarPendentesManifestacao: async (limite) => docs.slice(0, limite).map((d) => ({ ...d })),
      listarPorStatus: async () => { throw new Error('seleção não deve usar listarPorStatus'); },
      buscarPorId: async (id) => {
        const d = docs.find((x) => x.id === Number(id));
        return d ? { ...d } : null;
      }
    },
    eventosRepository,
    historicoRepository: {
      inserir: async (d) => { historico.push(d); return d; },
      listarPorDocumento: async (id) => historico.filter((h) => h.documentoId === Number(id))
    },
    nsuRepository: {},
    nsuService: {},
    transitionService: {},
    configuracaoService: {
      obterPoliticaManifestacao: async () => opcoes.politica || POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA,
      obterContextoOperacional: async (opts = {}) => {
        const empresaId = Number(opts.empresaId);
        return empresaId ? contextoFiscal(empresaId) : { ok: false, codigoErro: 'CONFIG_FISCAL', mensagem: 'sem empresa' };
      }
    },
    gate,
    agora: relogio.agora,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA,
    emitirEvento: (dados) => eventosRepository.inserir(dados),
    prepararEnvelopeAssinado: () => '<envEvento>ficticio</envEvento>',
    enviarManifestacao: async (params) => {
      envios.push({ chave: params.chave, cnpj: params.cnpj, ambiente: params.ambiente });
      if (opcoes.atrasoEnvioMs) await new Promise((r) => setTimeout(r, opcoes.atrasoEnvioMs));
      const [cStat, xMotivo] = opcoes.respostaCiencia || ['135', 'Evento registrado e vinculado a NF-e'];
      return { success: true, body: retEvento(cStat, xMotivo), statusCode: 200, source: 'PLATFORM', tempoTotalMs: 5 };
    },
    sincronizarDfe: async () => { consultas.dist += 1; throw new Error('DistDFe proibido'); },
    consultarNotaPorChave: async () => { consultas.consChNFe += 1; throw new Error('consChNFe proibido'); },
    locksDocumento: opcoes.locksDocumento || new Set(),
    cicloManifestacao: opcoes.cicloManifestacao || { ativo: false, desde: null }
  });
  return { service, relogio, eventosRepository, gate, envios, consultas, historico };
}

const ids = (sel) => sel.selecionados.map((d) => d.id);
const motivoDe = (sel, id) => (sel.excluidos.find((e) => e.documentoId === id) || {}).motivo;

function semSegredo(obj) {
  const texto = JSON.stringify(obj);
  assert.ok(!texto.includes(SENHA_FICTICIA), 'senha do certificado não pode aparecer');
  assert.ok(!/\.pfx/i.test(texto), 'caminho do certificado não pode aparecer');
  assert.ok(!texto.includes(CNPJ[1]) && !texto.includes(CNPJ[2]), 'CNPJ completo não pode aparecer na telemetria');
}

async function main() {
  console.log('\nCENTRAL-XML-02 — prazo da Ciência da Emissão e Motor de Manifestação');
  console.log(`DB_DIR temporário: ${process.env.DB_DIR}`);

  // ————————————————————————————————————————— P0 / P1 — relógio e urgência
  console.log('\n— P0/P1 relógio da ciência e urgência —');

  await test('T01 início da janela: emitida agora → prazo = dhEmi + 10×24h, NORMAL', () => {
    const p = calcularPrazoManifestacao({ dhEmi: '2026-09-27T10:00:00-03:00' }, new Date(AGORA_ISO));
    assert.strictEqual(p.valido, true);
    assert.strictEqual(p.dhEmi, '2026-09-27T10:00:00-03:00', 'dhEmi original preservado');
    assert.strictEqual(p.prazoFinal, '2026-10-07T13:00:00.000Z');
    assert.strictEqual(p.tempoRestanteMs, 10 * DIA_MS);
    assert.strictEqual(p.diasRestantes, 10);
    assert.strictEqual(p.dentroDaJanela, true);
    assert.strictEqual(p.expirado, false);
    assert.strictEqual(p.urgencia, U.NORMAL);
  });

  await test('T02 emissão 19:58 → prazo 27/09 19:58 (sem meia-noite artificial)', () => {
    const doc = { dataEmissao: '2026-09-17', xml: xmlResNFe(1, '2026-09-17T19:58:00-03:00') };
    const p = calcularPrazoManifestacao(doc, new Date(AGORA_ISO));
    assert.strictEqual(p.fonte, 'xml');
    assert.strictEqual(p.prazoFinal, '2026-09-27T22:58:00.000Z');
    assert.strictEqual(formatarDataHoraBrasil(p.prazoFinal), '27/09/2026 19:58');
    assert.strictEqual(p.tempoRestanteMs, 9 * HORA_MS + 58 * 60 * 1000);
    assert.strictEqual(p.expirado, false, 'bug antigo (YYYY-MM-DD → 00:00Z) marcaria como vencido');
    assert.strictEqual(p.urgencia, U.URGENTE);
  });

  await test('T03 emissão 23:59 (-03:00, já dia seguinte em UTC) → prazo 27/09 23:59 local', () => {
    const p = calcularPrazoManifestacao({ dhEmi: '2026-09-17T23:59:00-03:00' }, new Date(AGORA_ISO));
    assert.strictEqual(p.prazoFinal, '2026-09-28T02:59:00.000Z');
    assert.strictEqual(formatarDataHoraBrasil(p.prazoFinal), '27/09/2026 23:59');
    assert.strictEqual(p.urgencia, U.URGENTE);
  });

  await test('T04 mesmo dia, horários diferentes → prazos diferentes (hora preservada)', () => {
    const a = calcularPrazoManifestacao({ dhEmi: '2026-09-20T08:15:00-03:00' }, new Date(AGORA_ISO));
    const b = calcularPrazoManifestacao({ dhEmi: '2026-09-20T17:40:00-03:00' }, new Date(AGORA_ISO));
    assert.strictEqual(a.prazoFinal, '2026-09-30T11:15:00.000Z');
    assert.strictEqual(b.prazoFinal, '2026-09-30T20:40:00.000Z');
    assert.strictEqual(b.tempoRestanteMs - a.tempoRestanteMs, 9 * HORA_MS + 25 * 60 * 1000);
  });

  await test('T05 próximo do vencimento: 1 min antes dentro; no instante exato já expirado', () => {
    const doc = { dhEmi: '2026-09-17T19:58:00-03:00' };
    const antes = calcularPrazoManifestacao(doc, new Date('2026-09-27T22:57:00.000Z'));
    assert.strictEqual(antes.dentroDaJanela, true);
    assert.strictEqual(antes.tempoRestanteMs, 60 * 1000);
    assert.strictEqual(antes.urgencia, U.URGENTE);
    const exato = calcularPrazoManifestacao(doc, new Date('2026-09-27T22:58:00.000Z'));
    assert.strictEqual(exato.expirado, true);
    assert.strictEqual(exato.dentroDaJanela, false);
  });

  await test('T06 fronteiras de urgência: ≤24h URGENTE, ≤48h ATENCAO, >48h NORMAL', () => {
    const prazo = new Date('2026-10-01T12:00:00.000Z').getTime();
    const doc = { dhEmi: new Date(prazo - 10 * DIA_MS).toISOString() };
    const em = (restanteMs) => calcularPrazoManifestacao(doc, new Date(prazo - restanteMs)).urgencia;
    assert.strictEqual(em(23 * HORA_MS + 59 * 60 * 1000), U.URGENTE);
    assert.strictEqual(em(24 * HORA_MS), U.URGENTE);
    assert.strictEqual(em(24 * HORA_MS + 1), U.ATENCAO);
    assert.strictEqual(em(48 * HORA_MS), U.ATENCAO);
    assert.strictEqual(em(48 * HORA_MS + 60 * 1000), U.NORMAL);
  });

  await test('T07 vencido: expirado, EXPIRADO, tempo restante negativo', () => {
    const p = calcularPrazoManifestacao({ dhEmi: '2026-09-10T09:00:00-03:00' }, new Date(AGORA_ISO));
    assert.strictEqual(p.expirado, true);
    assert.strictEqual(p.dentroDaJanela, false);
    assert.strictEqual(p.urgencia, U.EXPIRADO);
    assert.ok(p.tempoRestanteMs < 0);
    assert.strictEqual(p.prazoFinal, '2026-09-20T12:00:00.000Z');
  });

  await test('T08 timezone: o mesmo instante em offsets distintos gera o mesmo prazo', () => {
    const agora = new Date(AGORA_ISO);
    const formas = ['2026-09-20T15:30:00-03:00', '2026-09-20T18:30:00Z', '2026-09-20T18:30:00+00:00', '2026-09-20T16:30:00-02:00'];
    const prazos = formas.map((dh) => calcularPrazoManifestacao({ dhEmi: dh }, agora).prazoFinal);
    assert.ok(prazos.every((p) => p === '2026-09-30T18:30:00.000Z'), JSON.stringify(prazos));
    const repetido = calcularPrazoManifestacao({ dhEmi: formas[0] }, agora);
    assert.deepStrictEqual(repetido, calcularPrazoManifestacao({ dhEmi: formas[0] }, agora), 'determinístico');
  });

  await test('T09 horário de verão (-02:00): prazo = exatos 240 h; exibição no fuso de Brasília', () => {
    const p = calcularPrazoManifestacao({ dhEmi: '2018-11-10T23:30:00-02:00' }, new Date('2018-11-12T00:00:00Z'));
    assert.strictEqual(p.prazoFinal, '2018-11-21T01:30:00.000Z');
    assert.strictEqual(new Date(p.prazoFinal).getTime() - new Date(p.emissaoEm).getTime(), 240 * HORA_MS);
    assert.strictEqual(formatarDataHoraBrasil(p.prazoFinal), '20/11/2018 23:30');
    const pos = calcularPrazoManifestacao({ dhEmi: '2019-02-10T12:00:00-02:00' }, new Date('2019-02-11T00:00:00Z'));
    assert.strictEqual(pos.prazoFinal, '2019-02-20T14:00:00.000Z');
    assert.strictEqual(formatarDataHoraBrasil(pos.prazoFinal), '20/02/2019 11:00', 'fim do verão: exibido em -03:00');
  });

  await test('T10 sem dhEmi válido → prazo INDETERMINADO, sem ciência automática, sem SOAP', async () => {
    const agora = new Date(AGORA_ISO);
    const soData = calcularPrazoManifestacao({ dataEmissao: '2026-09-20' }, agora);
    assert.strictEqual(soData.valido, false);
    assert.strictEqual(soData.urgencia, U.INDETERMINADO);
    assert.strictEqual(soData.motivo, MOTIVOS_PRAZO_INVALIDO.DHEMI_SEM_HORARIO_OU_OFFSET);
    assert.strictEqual(soData.prazoFinal, null);
    const semOffset = calcularPrazoManifestacao({ dhEmi: '2026-09-20T19:58:00' }, agora);
    assert.strictEqual(semOffset.valido, false, 'sem offset dependeria do fuso do processo');
    const ausente = calcularPrazoManifestacao({}, agora);
    assert.strictEqual(ausente.motivo, MOTIVOS_PRAZO_INVALIDO.DHEMI_AUSENTE);

    const doc = docPendente(1, 1, null);
    const c = cenario([doc, docPendente(2, 1, dhEmiHa(criarRelogio(), 30))]);
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 1), M.PRAZO_INDETERMINADO);
    assert.deepStrictEqual(ids(sel), [2]);
    const r = await c.service.processarDocumento(1, { origemAutomatica: true });
    assert.strictEqual(r.codigo, M.PRAZO_INDETERMINADO);
    assert.strictEqual(c.envios.length, 0);
  });

  // ————————————————————————————————————————— P3 / P4 — seleção
  console.log('\n— P3/P4 prioridade e ordem de seleção —');

  await test('T11 múltiplas empresas: ordem por menor tempo restante, não pelos mais antigos', async () => {
    const r = criarRelogio();
    const docs = [
      docPendente(1, 1, dhEmiHa(r, 12 * 24)), // vencido (mais antigo)
      docPendente(2, 1, dhEmiHa(r, 2 * 24)), // NORMAL, 8 dias
      docPendente(3, 2, dhEmiHa(r, 9 * 24 + 20)), // URGENTE, 4h
      docPendente(4, 3, dhEmiHa(r, 8 * 24 + 6)), // ATENCAO, 42h
      docPendente(5, 2, dhEmiHa(r, 9 * 24 + 2)), // URGENTE, 22h
      docPendente(6, 3, dhEmiHa(r, 5 * 24)) // NORMAL, 5 dias
    ];
    const c = cenario(docs, { relogio: r });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.deepStrictEqual(ids(sel), [3, 5, 4, 6, 2]);
    assert.strictEqual(motivoDe(sel, 1), M.FORA_DO_PRAZO);
    assert.deepStrictEqual(sel.porUrgencia, { URGENTE: 2, ATENCAO: 1, NORMAL: 2 });
    assert.deepStrictEqual(sel.candidatos.map((x) => x.urgencia), [U.URGENTE, U.URGENTE, U.ATENCAO, U.NORMAL, U.NORMAL]);
  });

  await test('T11b URGENTE/ATENCAO furam a cota por empresa; NORMAL mantém round-robin', async () => {
    const r = criarRelogio();
    const docs = [];
    for (let i = 0; i < 4; i += 1) docs.push(docPendente(10 + i, 1, dhEmiHa(r, 9 * 24 + 10 - i)));
    docs.push(docPendente(20, 2, dhEmiHa(r, 3 * 24)), docPendente(21, 2, dhEmiHa(r, 3 * 24 - 1)));
    docs.push(docPendente(30, 3, dhEmiHa(r, 2 * 24)), docPendente(31, 3, dhEmiHa(r, 2 * 24 - 1)));
    const c = cenario(docs, { relogio: r });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 6 });
    assert.deepStrictEqual(ids(sel), [10, 11, 12, 13, 20, 30]);
    assert.deepStrictEqual(sel.porEmpresa, { 1: 4, 2: 1, 3: 1 });
  });

  await test('T11c desempate P4: prazo → emissão → chave → id (determinístico)', async () => {
    const r = criarRelogio();
    const dh = dhEmiHa(r, 30);
    const docs = [docPendente(9, 1, dh, { chave: 'B'.repeat(44) }), docPendente(4, 1, dh, { chave: 'A'.repeat(44) }),
      docPendente(7, 1, dh, { chave: 'A'.repeat(44) })];
    const a = await cenario(docs, { relogio: r }).service._selecionarCandidatosManifestacao({ limite: 10 });
    const b = await cenario([...docs].reverse(), { relogio: r }).service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.deepStrictEqual(ids(a), [4, 7, 9]);
    assert.deepStrictEqual(ids(a), ids(b));
  });

  await test('T12 empresa bloqueada pelo Gate: sem SOAP para ela; demais seguem; telemetria por empresa', async () => {
    const r = criarRelogio();
    const docs = [docPendente(1, 1, dhEmiHa(r, 30)), docPendente(2, 2, dhEmiHa(r, 9 * 24)), docPendente(3, 2, dhEmiHa(r, 40))];
    const c = cenario(docs, { relogio: r, bloqueadas: [2] });
    const res = await c.service.processarCandidatos({ limite: 10 });
    assert.strictEqual(res.executado, true);
    assert.deepStrictEqual(c.envios.map((e) => e.cnpj), [CNPJ[1]]);
    assert.strictEqual(res.selecao.excluidosPorMotivo[M.GATE_BLOQUEADO], 2);
    const bloq = c.eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_BLOQUEADA_GATE);
    assert.strictEqual(bloq.length, 1, 'um evento agregado por empresa');
    assert.strictEqual(bloq[0].detalhe.empresaId, 2);
    assert.strictEqual(bloq[0].detalhe.documentos, 2);

    // Caminho direto (botão/MIRX): Gate avaliado antes do SOAP.
    const direto = await c.service.processarDocumento(2, { origemAutomatica: false });
    assert.strictEqual(direto.bloqueadoGate, true);
    assert.strictEqual(c.envios.length, 1);
    assert.strictEqual(c.eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_BLOQUEADA_GATE).length, 2);

    // Gate real (instância isolada) com 656 na empresa 2.
    const repoGate = new Map();
    const gateReal = new CentralSefazOperationalGate({
      configRepository: {
        async buscarPorChave(k) { return repoGate.has(k) ? { chave: k, valor: repoGate.get(k), tipo: 'json' } : null; },
        parseValor: (reg) => (typeof reg.valor === 'string' ? JSON.parse(reg.valor) : reg.valor),
        async salvar(k, v) { repoGate.set(k, JSON.parse(JSON.stringify(v))); }
      },
      agora: r.agora,
      obterFingerprintConfig: async (ctx) => `fp-${ctx?.empresaId || 'global'}`,
      obterFingerprintDetalhado: async (ctx) => ({ fingerprint: `fp-${ctx?.empresaId || 'global'}`, cnpjCertificado: CNPJ[ctx?.empresaId] })
    });
    await gateReal.processarRespostaSefaz({ cStat: '656', xMotivo: 'Rejeicao: Consumo Indevido' }, { empresaId: 2, cnpj: CNPJ[2], ambiente: 1 });
    const cReal = cenario(docs, { relogio: r, gate: gateReal });
    const sel = await cReal.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.deepStrictEqual(ids(sel), [1]);
    assert.strictEqual(motivoDe(sel, 3), M.GATE_BLOQUEADO);
  });

  await test('T13 claim ocupado: excluído da seleção; caminho direto não envia SOAP', async () => {
    const r = criarRelogio();
    const c = cenario([docPendente(1, 1, dhEmiHa(r, 30)), docPendente(2, 1, dhEmiHa(r, 30))], { relogio: r });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_CLAIM,
      documentoId: 1,
      detalhe: { token: 'outro-processo', reclamadoEm: new Date(r.agora().getTime() - 60 * 1000).toISOString() }
    });
    const res = await c.service.processarCandidatos({ limite: 10 });
    assert.strictEqual(res.selecao.excluidosPorMotivo[M.CLAIM_ATIVO], 1);
    assert.deepStrictEqual(c.envios.map((e) => e.chave), [chaveDoc(2)]);
    assert.strictEqual(c.eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_CLAIM_OCUPADO).length, 1);

    const direto = await c.service.processarDocumento(1, { origemAutomatica: false });
    assert.strictEqual(direto.claimOcupado, true);
    assert.strictEqual(c.envios.length, 1, 'nenhum 210210 extra');
    assert.ok(c.eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_CLAIM).some((e) => e.detalhe.token === 'outro-processo'),
      'claim alheio não é removido');
  });

  await test('T14 dois workers concorrentes (processos distintos) → um único 210210', async () => {
    const r = criarRelogio();
    const docs = [docPendente(1, 1, dhEmiHa(r, 30))];
    const eventosRepository = criarEventos(r);
    const envios = [];
    const w1 = cenario(docs, { relogio: r, eventosRepository, envios, atrasoEnvioMs: 20 });
    const w2 = cenario(docs, { relogio: r, eventosRepository, envios, atrasoEnvioMs: 20 });
    const [a, b] = await Promise.all([
      w1.service.processarDocumento(1, { origemAutomatica: true }),
      w2.service.processarDocumento(1, { origemAutomatica: true })
    ]);
    assert.strictEqual(envios.length, 1);
    assert.strictEqual([a, b].filter((x) => x.claimOcupado).length, 1);
    assert.strictEqual(eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_ACEITA).length, 1);
  });

  await test('T15 scheduler executando duas vezes: sem sobreposição e sem duplicar manifestação', async () => {
    const r = criarRelogio();
    const docs = [docPendente(1, 1, dhEmiHa(r, 30)), docPendente(2, 2, dhEmiHa(r, 9 * 24))];
    const envios = [];
    const eventosRepository = criarEventos(r);
    const ciclo = { ativo: false, desde: null };
    let criados = 0;
    const timers = [];
    const scheduler = new CentralManifestacaoScheduler({
      criarServico: () => {
        criados += 1;
        return cenario(docs, { relogio: r, eventosRepository, envios, cicloManifestacao: ciclo, atrasoEnvioMs: 10 }).service;
      },
      lerConfig: () => ({ habilitado: true, intervaloMs: 30 * 60 * 1000, limitePorCiclo: 10, atrasoInicialMs: 60 * 1000 }),
      flags: { estaHabilitado: () => true },
      setTimeout: (fn, ms) => { const t = { fn, ms, cancelado: false }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.cancelado = true; },
      agora: r.agora
    });

    assert.strictEqual(scheduler.iniciar(), true);
    scheduler.iniciar();
    assert.strictEqual(timers.filter((t) => !t.cancelado).length, 1, 'iniciar duas vezes mantém um único timer');

    const [x, y] = await Promise.all([scheduler.executarCiclo(), scheduler.executarCiclo()]);
    assert.strictEqual(y.motivo, 'CICLO_EM_EXECUCAO');
    assert.strictEqual(x.executado, true);
    assert.strictEqual(criados, 1);
    assert.strictEqual(envios.length, 2, 'um 210210 por documento');

    // Scheduler e pós-sincronização no mesmo processo: o ciclo compartilhado barra a sobreposição.
    const s1 = cenario(docs, { relogio: r, eventosRepository, envios, cicloManifestacao: ciclo, atrasoEnvioMs: 10 }).service;
    const s2 = cenario(docs, { relogio: r, eventosRepository, envios, cicloManifestacao: ciclo }).service;
    const [p1, p2] = await Promise.all([s1.processarCandidatos({}), s2.processarCandidatos({})]);
    assert.ok(p1.executado === true && p2.emExecucao === true);

    await scheduler.executarCiclo();
    assert.strictEqual(envios.length, 2, 'ciclos seguintes não reenviam ciência já aceita');

    const pendente = timers.find((t) => !t.cancelado);
    assert.strictEqual(pendente.ms, 60 * 1000);
    scheduler.parar();
    assert.strictEqual(scheduler.obterStatus().ativo, false);
    assert.ok(pendente.cancelado);
  });

  await test('T15b scheduler não depende da Central aberta: timer do backend dispara o ciclo', async () => {
    const r = criarRelogio();
    const docs = [docPendente(1, 1, dhEmiHa(r, 30))];
    const envios = [];
    const timers = [];
    const scheduler = new CentralManifestacaoScheduler({
      criarServico: () => cenario(docs, { relogio: r, envios }).service,
      lerConfig: () => ({ habilitado: true, intervaloMs: 30 * 60 * 1000, limitePorCiclo: 10, atrasoInicialMs: 60 * 1000 }),
      flags: { estaHabilitado: () => true },
      setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimeout: () => {},
      agora: r.agora
    });
    scheduler.iniciar();
    timers[0].fn();
    await new Promise((res) => setTimeout(res, 30));
    assert.strictEqual(envios.length, 1);
    assert.strictEqual(timers.length, 2, 'reagenda o próximo ciclo');
    assert.strictEqual(timers[1].ms, 30 * 60 * 1000);
    scheduler.parar();

    const desligado = new CentralManifestacaoScheduler({
      lerConfig: () => ({ habilitado: false, intervaloMs: 1, limitePorCiclo: 1, atrasoInicialMs: 1 }),
      setTimeout: () => { throw new Error('não deve agendar'); }
    });
    assert.strictEqual(desligado.iniciar(), false);
    const semModulo = new CentralManifestacaoScheduler({
      criarServico: () => { throw new Error('não deve criar serviço'); },
      lerConfig: () => ({ habilitado: true, intervaloMs: 1, limitePorCiclo: 1, atrasoInicialMs: 1 }),
      flags: { estaHabilitado: () => false }
    });
    assert.strictEqual((await semModulo.executarCiclo()).motivo, 'MODULO_CENTRAL_DESABILITADO');
  });

  await test('T15c configuração do scheduler é conservadora (mín. 10 min, limite ≤ 50)', () => {
    const { lerConfigAmbiente } = require('../../backend/motores/central-entradas/services/CentralManifestacaoScheduler');
    assert.deepStrictEqual(
      [lerConfigAmbiente({}).intervaloMs, lerConfigAmbiente({}).limitePorCiclo, lerConfigAmbiente({}).habilitado],
      [30 * 60 * 1000, 10, true]
    );
    assert.strictEqual(lerConfigAmbiente({ CENTRAL_MANIFESTACAO_INTERVALO_MIN: '1' }).intervaloMs, 10 * 60 * 1000);
    assert.strictEqual(lerConfigAmbiente({ CENTRAL_MANIFESTACAO_LIMITE_CICLO: '999' }).limitePorCiclo, 50);
    assert.strictEqual(lerConfigAmbiente({ CENTRAL_MANIFESTACAO_SCHEDULER: '0' }).habilitado, false);
  });

  await test('T16 ciência já aceita: excluída da seleção e nenhum 210210 novo', async () => {
    const r = criarRelogio();
    const c = cenario([docPendente(1, 1, dhEmiHa(r, 30))], { relogio: r });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_ACEITA, documentoId: 1, resultado: '135', detalhe: { cStat: '135' }
    });
    const res = await c.service.processarCandidatos({ limite: 10 });
    assert.strictEqual(res.selecao.excluidosPorMotivo[M.CIENCIA_ACEITA], 1);
    await c.service.processarDocumento(1, { origemAutomatica: false });
    assert.strictEqual(c.envios.length, 0);
  });

  await test('T17 ciência já rejeitada por 596: excluída, sem novo 210210', async () => {
    const r = criarRelogio();
    const c = cenario([docPendente(1, 1, dhEmiHa(r, 30)), docPendente(2, 1, dhEmiHa(r, 30))], { relogio: r });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documentoId: 1, resultado: '596', detalhe: { cStat: '596' }
    });
    const res = await c.service.processarCandidatos({ limite: 10 });
    assert.strictEqual(res.selecao.excluidosPorMotivo[M.PRAZO_EXPIRADO_596], 1);
    assert.deepStrictEqual(c.envios.map((e) => e.chave), [chaveDoc(2)]);
  });

  await test('T18 documento fora da janela: sem Gate, sem SOAP, CIENCIA_FORA_DO_PRAZO uma única vez', async () => {
    const r = criarRelogio();
    const vencido = docPendente(1, 1, '2026-09-16T14:00:00-03:00');
    const c = cenario([vencido], { relogio: r });

    const res1 = await c.service.processarCandidatos({ limite: 10 });
    const res2 = await c.service.processarCandidatos({ limite: 10 });
    assert.strictEqual(res1.candidatos, 0);
    assert.strictEqual(res2.selecao.excluidosPorMotivo[M.FORA_DO_PRAZO], 1);
    assert.strictEqual(M.FORA_DO_PRAZO, 'CIENCIA_FORA_DO_PRAZO');

    const direto = await c.service.processarDocumento(1, { origemAutomatica: false, confirmado: true });
    assert.strictEqual(direto.foraDoPrazo, true);
    assert.strictEqual(direto.codigo, CODIGO_CIENCIA_FORA_DO_PRAZO);
    assert.strictEqual(direto.prazoFinal, '2026-09-26T17:00:00.000Z');
    await c.service.processarDocumento(1, { origemAutomatica: true });

    assert.strictEqual(c.envios.length, 0, 'nenhum 210210');
    assert.strictEqual(c.gate.chamadas.autorizar.length, 0, 'Gate nem consultado');
    assert.strictEqual(c.gate.chamadas.avaliar.length, 0);
    assert.strictEqual(c.eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_FORA_DO_PRAZO).length, 1, 'sem loop de eventos');
    assert.strictEqual(c.eventosRepository.doTipo(TIPOS_EVENTO.CIENCIA_ENVIADA).length, 0);
  });

  // ————————————————————————————————————————— P6 / P9 — alerta e telemetria
  console.log('\n— P6/P9 alerta, telemetria e retorno —');

  await test('T19 fluxo completo simulado: CANDIDATO → ENVIADA → ACEITA com contexto da empresa', async () => {
    const r = criarRelogio();
    const c = cenario([docPendente(1, 1, '2026-09-17T19:58:00-03:00')], { relogio: r });
    const res = await c.service.processarCandidatos({ limite: 10, correlationId: 'corr-xml02' });
    assert.strictEqual(c.envios.length, 1);
    assert.strictEqual(res.resultados[0].aguardandoDisponibilizacao, true);
    for (const tipo of [TIPOS_EVENTO.MANIFESTACAO_CANDIDATO, TIPOS_EVENTO.MANIFESTACAO_ENVIADA, TIPOS_EVENTO.MANIFESTACAO_ACEITA]) {
      const evs = c.eventosRepository.doTipo(tipo);
      assert.strictEqual(evs.length, 1, tipo);
      assert.strictEqual(evs[0].detalhe.empresaId, 1, `${tipo} com empresaId`);
      assert.ok(evs[0].detalhe.cnpjMascarado && evs[0].detalhe.cnpjMascarado.includes('*'), `${tipo} com CNPJ mascarado`);
      assert.strictEqual(evs[0].detalhe.ambiente, 1, `${tipo} com ambiente`);
      semSegredo(evs[0]);
    }
    const enviada = c.eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_ENVIADA)[0];
    assert.strictEqual(enviada.detalhe.prazoFinal, '2026-09-27T22:58:00.000Z');
    assert.strictEqual(enviada.detalhe.urgencia, U.URGENTE);
    assert.deepStrictEqual(c.gate.chamadas.respostas, [{ cStat: '135', empresaId: 1 }], 'retorno entregue ao Gate da empresa');
    assert.strictEqual(soapReal, 0);
  });

  await test('T20 rejeição do 210210 registra MANIFESTACAO_REJEITADA com contexto da empresa', async () => {
    const r = criarRelogio();
    const c = cenario([docPendente(1, 2, dhEmiHa(r, 30))], {
      relogio: r,
      respostaCiencia: ['999', 'Rejeicao: erro simulado']
    });
    await c.service.processarCandidatos({ limite: 10 });
    const rej = c.eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_REJEITADA);
    assert.strictEqual(rej.length, 1);
    assert.strictEqual(rej[0].detalhe.empresaId, 2);
    assert.strictEqual(rej[0].detalhe.cStat, '999');
    semSegredo(rej[0]);
  });

  await test('T21 alerta ATENCAO/URGENTE por empresa, sem repetir no ciclo seguinte; mensagem no formato', async () => {
    const r = criarRelogio();
    const docs = [docPendente(1, 1, '2026-09-17T19:58:00-03:00'), docPendente(2, 2, dhEmiHa(r, 8 * 24 + 4)), docPendente(3, 1, dhEmiHa(r, 24))];
    const livre = cenario(docs, { relogio: r });
    // Sem envio: os mesmos documentos voltam no ciclo seguinte e o alerta não pode repetir.
    livre.service.processarDocumento = async (id) => ({ documentoId: id, sucesso: true });
    await livre.service.processarCandidatos({ limite: 10 });
    await livre.service.processarCandidatos({ limite: 10 });
    const al = livre.eventosRepository.doTipo(TIPOS_EVENTO.MANIFESTACAO_ALERTA_PRAZO);
    assert.deepStrictEqual(al.map((e) => [e.documentoId, e.detalhe.urgencia]).sort(), [[1, U.URGENTE], [2, U.ATENCAO]]);
    const urg = al.find((e) => e.documentoId === 1);
    assert.strictEqual(urg.detalhe.empresaId, 1);
    assert.match(urg.descricao, /^NF-e 100001 · Prazo para Ciência: 27\/09\/2026 19:58 · Tempo restante: 9h58 · Status: URGENTE$/);
    assert.strictEqual(
      montarMensagemAlertaPrazo({ numero: '123456', prazoFinal: '2026-09-27T22:58:00.000Z', tempoRestanteMs: 17 * HORA_MS + 32 * 60 * 1000, urgencia: 'URGENTE' }),
      'NF-e 123456 · Prazo para Ciência: 27/09/2026 19:58 · Tempo restante: 17h32 · Status: URGENTE'
    );
  });

  await test('T22 painel de prazos por empresa (backend autoridade, somente leitura)', async () => {
    const r = criarRelogio();
    const docs = [
      docPendente(1, 1, '2026-09-17T19:58:00-03:00'),
      docPendente(2, 1, dhEmiHa(r, 8 * 24 + 4)),
      docPendente(3, 1, dhEmiHa(r, 24)),
      docPendente(4, 1, '2026-09-10T10:00:00-03:00'),
      docPendente(5, 1, null),
      docPendente(6, 2, dhEmiHa(r, 30))
    ];
    const c = cenario(docs, { relogio: r });
    await c.eventosRepository.inserir({ tipo: TIPOS_EVENTO.MANIFESTACAO_ACEITA, documentoId: 3, resultado: '135', detalhe: {} });
    const painel = await c.service.obterPainelPrazos({ empresaId: 1 });
    assert.deepStrictEqual(painel.contagem, {
      URGENTE: 1, ATENCAO: 1, NORMAL: 0, EXPIRADO: 1, INDETERMINADO: 1, CIENCIA_ACEITA: 1, CIENCIA_REJEITADA_596: 0
    });
    assert.deepStrictEqual(painel.itens.map((i) => i.documentoId), [4, 1, 2, 5]);
    assert.strictEqual(painel.itens[1].prazoFinalLocal, '27/09/2026 19:58');
    assert.strictEqual(painel.itens[1].tempoRestante, '9h58');
    assert.ok(painel.itens.every((i) => i.empresaId === 1));
    assert.strictEqual(c.envios.length + c.gate.chamadas.autorizar.length + c.gate.chamadas.avaliar.length, 0);
  });

  await test('T23 repositório extrai dhEmi do XML resNFe (SQLite :memory:)', async () => {
    const db = new sqlite3.Database(':memory:');
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
    await run(`CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY, chave TEXT, numero TEXT, serie TEXT, modelo TEXT, fornecedor TEXT, cnpj_fornecedor TEXT,
      data_emissao TEXT, data_entrada TEXT, valor_total REAL, nsu TEXT, origem TEXT, status TEXT, status_detalhe TEXT,
      tipo_documento TEXT, miip_sessao_id TEXT, miip_resumo_json TEXT, compra_id TEXT, usuario_id TEXT, processado_em TEXT,
      empresa_id INTEGER, created_at TEXT, updated_at TEXT, xml TEXT, cnpj_destinatario TEXT, parse_json TEXT)`);
    const ins = 'INSERT INTO central_entradas_documentos (id, chave, data_emissao, status, tipo_documento, empresa_id, xml) VALUES (?,?,?,?,?,?,?)';
    await run(ins, [1, chaveDoc(1), '2026-09-17', DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO, DocumentoDfeTipo.RES_NFE, 1,
      xmlResNFe(1, '2026-09-17T19:58:00-03:00')]);
    await run(ins, [2, chaveDoc(2), '2026-09-18', DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO, DocumentoDfeTipo.RES_NFE, 1,
      xmlResNFe(2, null)]);
    const repo = new CentralDocumentosRepository({ db });
    let linhas;
    try {
      linhas = await repo.listarPendentesManifestacao(10);
    } catch (e) {
      if (/no such column/i.test(e.message)) throw new Error(`schema mínimo do teste incompleto: ${e.message}`);
      throw e;
    }
    const d1 = linhas.find((l) => Number(l.id) === 1);
    const d2 = linhas.find((l) => Number(l.id) === 2);
    assert.strictEqual(d1.dhEmi, '2026-09-17T19:58:00-03:00');
    assert.strictEqual(d2.dhEmi, null);
    const p = calcularPrazoManifestacao(d1, new Date(AGORA_ISO));
    assert.strictEqual(p.fonte, 'dhEmi');
    assert.strictEqual(p.prazoFinal, '2026-09-27T22:58:00.000Z');
    const cand = montarCandidatoManifestacao(d1, {}, new Date(AGORA_ISO));
    assert.strictEqual(cand.urgencia, U.URGENTE);
    db.close();
  });

  console.log(`\nResultado CENTRAL-XML-02: ${ok} passou; ${falhas} falhou. SOAP real: ${soapReal}.`);
  process.exitCode = falhas === 0 && soapReal === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
