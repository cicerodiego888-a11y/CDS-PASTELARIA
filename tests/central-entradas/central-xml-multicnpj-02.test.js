/**
 * CENTRAL-XML-MULTICNPJ-02 — XML_INDISPONIVEL não pode ser só 596 de ciência.
 * Executar: node tests/central-entradas/central-xml-multicnpj-02.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const CentralManifestacaoDfeService = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoDfeService'
);
const {
  POLITICAS_MANIFESTACAO,
  CSTAT_MANIFESTACAO_ACEITA,
  CSTAT_XML_INDISPONIVEL
} = CentralManifestacaoDfeService;
const { ehElegivelRecuperacaoXml } = require(
  '../../backend/motores/central-entradas/recuperacao-xml/FilaRecuperacaoXml'
);
const { DocumentoFiscalStatus, isTerminal } = require(
  '../../backend/motores/central-entradas/core/DocumentoFiscalStatus'
);
const { DocumentoDfeTipo } = require(
  '../../backend/motores/central-entradas/core/DocumentoDfeTipo'
);
const { TIPOS_EVENTO } = require(
  '../../backend/motores/central-entradas/config/centralEventosTipos'
);

const S = DocumentoFiscalStatus;
const CNPJ = Object.freeze({
  1: '38111111000115',
  2: '38111111000387',
  3: '38111111000204'
});
const CHAVE = Object.freeze({
  1: '23260800000000000000000000000000000000000001',
  2: '23260900000000000000000000000000000000000002',
  3: '23260800000000000000000000000000000000000003'
});

let ok = 0;
let falhas = 0;

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

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
      console.error(`         ${err.message}`);
    });
}

function retornoCiencia(cStat, xMotivo) {
  return `<retEvento><infEvento>
    <cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>
    <nProt>135000000000001</nProt>
  </infEvento></retEvento>`;
}

function contextoPorEmpresa(opts = {}) {
  const empresaId = Number(opts.empresaId) || 1;
  return {
    ok: true,
    contexto: {
      empresaId,
      ambiente: 1,
      cnpj: CNPJ[empresaId],
      certificadoPath: `C:\\\\certs\\\\certificado-empresa-${empresaId}.pfx`,
      certificadoSenha: 'secret-nao-logar',
      origemAmbiente: 'empresas_configuracao_fiscal'
    }
  };
}

function criarCenario(opcoes = {}) {
  const empresaId = Number(opcoes.empresaId) || 3;
  const documento = {
    id: opcoes.id || 18,
    empresaId,
    empresa_id: empresaId,
    chave: opcoes.chave || CHAVE[empresaId] || CHAVE[3],
    status: S.RESUMO_RECEBIDO,
    tipoDocumento: DocumentoDfeTipo.RES_NFE,
    xml: '<resNFe/>',
    nsu: String(empresaId).padStart(15, '0')
  };
  const eventos = [...(opcoes.eventosIniciais || [])];
  const historico = [];
  const consultas = [];
  let manifestacoes = 0;

  const documentosRepository = {
    buscarPorId: async () => ({ ...documento }),
    listarPorStatus: async (status) => (
      documento.status === status ? [{ ...documento }] : []
    ),
    atualizar: async (_id, dados) => {
      if (dados.status) documento.status = dados.status;
      if (dados.tipoDocumento) documento.tipoDocumento = dados.tipoDocumento;
      if (dados.xml) documento.xml = dados.xml;
      return { ...documento };
    }
  };

  const eventosRepository = {
    listar: async (filtros) => eventos
      .filter((e) => e.tipo === filtros.tipo && e.documentoId === filtros.documentoId)
      .sort((a, b) => b.id - a.id)
      .slice(0, filtros.limite || 50),
    inserir: async (dados) => {
      const evento = {
        id: eventos.length + 1,
        createdAt: '2026-09-17T01:33:30.000Z',
        ...dados,
        documentoId: dados.documentoId ?? dados.documento_id
      };
      eventos.push(evento);
      return evento;
    },
    inserirUnico: async (dados) => {
      const evento = await eventosRepository.inserir(dados);
      return { evento, criado: true, conflito: false };
    },
    removerPorTipoDocumento: async () => true,
    contar: async () => 0
  };

  const service = new CentralManifestacaoDfeService({
    documentosRepository,
    historicoRepository: {
      inserir: async (dados) => {
        historico.push(dados);
        return { id: historico.length, ...dados };
      },
      listarPorDocumento: async () => [...historico]
    },
    eventosRepository,
    nsuService: {
      buscarPorCnpjAmbiente: async () => ({ ultNsu: '4', maxNsu: '4' }),
      avaliarCooldown: () => (opcoes.nsuCooldown
        ? { ativo: true, proximaConsultaEm: '2026-09-17T03:00:00.000Z' }
        : { ativo: false })
    },
    configuracaoService: {
      obterPoliticaManifestacao: async () => POLITICAS_MANIFESTACAO.MANUAL,
      obterContextoOperacional: async (opts) => contextoPorEmpresa(opts)
    },
    prepararEnvelopeAssinado: (params) => {
      consultas.push({ etapa: 'envelope', cnpj: params.cnpj, cert: params.certificadoPath });
      return '<envEvento/>';
    },
    enviarManifestacao: async (params) => {
      manifestacoes += 1;
      consultas.push({ etapa: 'ciencia', cnpj: params.cnpj, cert: params.certificadoPath });
      return {
        success: true,
        body: retornoCiencia(opcoes.cStatCiencia || '596', opcoes.xMotivo || 'prazo 10 dias'),
        source: 'PLATFORM',
        fallbackUtilizado: false,
        tempoTotalMs: 8,
        statusCode: 200,
        endpoint: 'https://www1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'
      };
    },
    consultarNotaPorChave: async (chave, deps = {}) => {
      consultas.push({
        etapa: 'consChNFe',
        chave,
        cnpj: deps.contextoCentral?.cnpj,
        empresaId: deps.contextoCentral?.empresaId,
        cert: deps.contextoCentral?.certificadoPath
      });
      if (opcoes.chaveErro) {
        throw new Error(opcoes.chaveErro);
      }
      if (opcoes.docZip) {
        documento.status = S.XML_COMPLETO;
        documento.tipoDocumento = DocumentoDfeTipo.PROC_NFE;
        documento.xml = `<nfeProc><NFe><infNFe Id="NFe${documento.chave}"/></NFe></nfeProc>`;
        return {
          sucesso: true,
          cStat: '138',
          mensagem: 'Documento localizado',
          notasNovas: 1
        };
      }
      return {
        sucesso: true,
        cStat: opcoes.cStatConsChNFe || '137',
        mensagem: opcoes.xMotivoConsChNFe || 'Nenhum documento localizado',
        notasNovas: 0
      };
    },
    cancelarXmlWait: () => true,
    agora: () => new Date('2026-09-17T01:33:30.000Z'),
    emitirEvento: async (dados) => eventosRepository.inserir(dados)
  });

  return {
    service,
    documento,
    eventos,
    historico,
    consultas,
    getManifestacoes: () => manifestacoes
  };
}

async function run() {
  console.log('\n=== CENTRAL-XML-MULTICNPJ-02 — XML_INDISPONIVEL / 596 ===\n');

  await test('cStat 596 pertence ao evento 210210, não à DistDFe', () => {
    assert.ok(CSTAT_XML_INDISPONIVEL.has('596'));
    assert.ok(!CSTAT_XML_INDISPONIVEL.has('137'));
    assert.ok(!CSTAT_XML_INDISPONIVEL.has('138'));
    assert.ok(CSTAT_MANIFESTACAO_ACEITA.has('135'));
    assert.ok(CSTAT_MANIFESTACAO_ACEITA.has('573'));
    const manif = src('backend/motores/central-entradas/services/CentralManifestacaoDfeService.js');
    assert.ok(manif.includes('_resolverAposEvento596'));
    assert.ok(manif.includes('ciencia_210210_prazo'));
  });

  await test('Filial 3 + 596 + consChNFe sem docZip → XML_INDISPONIVEL com evidência de chave', async () => {
    const c = criarCenario({ empresaId: 3, id: 18 });
    const r = await c.service.processarDocumento(18, { confirmado: true });
    assert.strictEqual(r.encerrado, true);
    assert.strictEqual(r.cStat, '596');
    assert.strictEqual(r.cStatConsChNFe, '137');
    assert.strictEqual(c.documento.status, S.XML_INDISPONIVEL);
    const cons = c.consultas.filter((x) => x.etapa === 'consChNFe');
    assert.strictEqual(cons.length, 1);
    assert.strictEqual(cons[0].empresaId, 3);
    assert.strictEqual(cons[0].cnpj, CNPJ[3]);
    assert.ok(String(cons[0].cert).includes('certificado-empresa-3.pfx'));
    assert.ok(c.consultas.every((x) => x.cnpj === CNPJ[3]));
  });

  await test('Filial 2 + 596 + consChNFe usa CNPJ/PFX da Filial 2', async () => {
    const c = criarCenario({ empresaId: 2, id: 201, chave: CHAVE[2] });
    await c.service.processarDocumento(201, { confirmado: true });
    const cons = c.consultas.filter((x) => x.etapa === 'consChNFe');
    assert.strictEqual(cons[0].empresaId, 2);
    assert.strictEqual(cons[0].cnpj, CNPJ[2]);
    assert.ok(String(cons[0].cert).includes('certificado-empresa-2.pfx'));
  });

  await test('cStat 135 ciência aceita não vira XML_INDISPONIVEL', async () => {
    const c = criarCenario({
      empresaId: 3,
      cStatCiencia: '135',
      xMotivo: 'Evento registrado e vinculado a NF-e'
    });
    const r = await c.service.processarDocumento(18, { confirmado: true, apenasManifestacao: true });
    assert.strictEqual(r.sucesso, true);
    assert.notStrictEqual(c.documento.status, S.XML_INDISPONIVEL);
    assert.strictEqual(c.consultas.filter((x) => x.etapa === 'consChNFe').length, 0);
  });

  await test('ciência rejeitada (não 596) não encerra como XML_INDISPONIVEL', async () => {
    const c = criarCenario({
      empresaId: 3,
      cStatCiencia: '213',
      xMotivo: 'Rejeicao generica'
    });
    const r = await c.service.processarDocumento(18, { confirmado: true });
    assert.notStrictEqual(r.status, S.XML_INDISPONIVEL);
    assert.notStrictEqual(c.documento.status, S.XML_INDISPONIVEL);
    assert.strictEqual(c.consultas.filter((x) => x.etapa === 'consChNFe').length, 0);
  });

  await test('consChNFe com docZip/procNFe após 596 persiste XML e não encerra', async () => {
    const c = criarCenario({ empresaId: 3, docZip: true });
    const r = await c.service.processarDocumento(18, { confirmado: true });
    assert.strictEqual(r.xmlCompleto, true);
    assert.strictEqual(r.encerrado, false);
    assert.strictEqual(r.cienciaRejeitadaPrazo, true);
    assert.strictEqual(c.documento.status, S.XML_COMPLETO);
    assert.strictEqual(c.documento.tipoDocumento, DocumentoDfeTipo.PROC_NFE);
    assert.ok(String(c.documento.xml).includes('nfeProc'));
  });

  await test('consChNFe sem docZip (137) após 596 → XML_INDISPONIVEL', async () => {
    const c = criarCenario({ empresaId: 2, id: 77, cStatConsChNFe: '137' });
    const r = await c.service.processarDocumento(77, { confirmado: true });
    assert.strictEqual(r.xmlCompleto, false);
    assert.strictEqual(r.cStatConsChNFe, '137');
    assert.strictEqual(c.documento.status, S.XML_INDISPONIVEL);
  });

  await test('erro temporário no consChNFe após 596 não vira XML_INDISPONIVEL', async () => {
    const c = criarCenario({ empresaId: 3, chaveErro: 'socket hang up' });
    const r = await c.service.processarDocumento(18, { confirmado: true });
    assert.strictEqual(r.encerrado, false);
    assert.strictEqual(c.consultas.filter((x) => x.etapa === 'consChNFe').length, 1);
    assert.strictEqual(c.documento.status, S.RESUMO_RECEBIDO);
  });

  await test('XML_INDISPONIVEL permanece terminal no ciclo de ciência, mas fila de recuperação aceita retry', () => {
    assert.strictEqual(isTerminal(S.XML_INDISPONIVEL), true);
    assert.strictEqual(ehElegivelRecuperacaoXml(S.XML_INDISPONIVEL), true);
    assert.strictEqual(ehElegivelRecuperacaoXml(S.RESUMO_RECEBIDO), true);
  });

  await test('isolamento: Matriz não é usada como fallback no consChNFe da Filial 3', async () => {
    const c = criarCenario({ empresaId: 3 });
    await c.service.processarDocumento(18, { confirmado: true });
    assert.ok(c.consultas.length >= 2);
    assert.ok(c.consultas.every((x) => x.cnpj === CNPJ[3]));
  });

  await test('regressão: Matriz ciência 135 sem 596 não chama resolver 596', async () => {
    const c = criarCenario({
      empresaId: 1,
      id: 41,
      chave: CHAVE[1],
      cStatCiencia: '135',
      xMotivo: 'Evento registrado'
    });
    const r = await c.service.processarDocumento(41, { confirmado: true, apenasManifestacao: true });
    assert.strictEqual(r.sucesso, true);
    assert.strictEqual(c.documento.status, S.RESUMO_RECEBIDO);
    assert.strictEqual(c.consultas.filter((x) => x.etapa === 'consChNFe').length, 0);
  });

  await test('retry: XML_INDISPONIVEL não remanifesta, mas consulta consChNFe', async () => {
    const c = criarCenario({ empresaId: 3 });
    c.documento.status = S.XML_INDISPONIVEL;
    const r = await c.service.processarDocumento(18, { confirmado: true });
    assert.strictEqual(c.getManifestacoes(), 0);
    assert.ok(c.consultas.some((x) => x.etapa === 'consChNFe' && x.empresaId === 3));
    assert.ok(!c.consultas.some((x) => x.etapa === 'ciencia'));
    assert.ok(r.consultaPorChave === true || r.xmlCompleto === false);
  });

  await test('Filial 3: ciência 135 + cooldown NSU ainda consulta consChNFe no CNPJ da filial', async () => {
    const c = criarCenario({
      empresaId: 3,
      nsuCooldown: true,
      docZip: true,
      eventosIniciais: [{
        id: 1,
        tipo: TIPOS_EVENTO.MANIFESTACAO_ACEITA,
        documentoId: 18,
        resultado: '135',
        detalhe: { cStat: '135' }
      }]
    });
    const r = await c.service.processarDocumento(18, {
      confirmado: true,
      modoRecuperacaoXml: true
    });
    assert.strictEqual(c.getManifestacoes(), 0);
    const cons = c.consultas.filter((x) => x.etapa === 'consChNFe');
    assert.strictEqual(cons.length, 1);
    assert.strictEqual(cons[0].empresaId, 3);
    assert.strictEqual(cons[0].cnpj, CNPJ[3]);
    assert.strictEqual(r.xmlCompleto, true);
    assert.strictEqual(c.documento.tipoDocumento, DocumentoDfeTipo.PROC_NFE);
  });

  console.log(`\n${ok} ok, ${falhas} falha(s)\n`);
  if (falhas) process.exit(1);
}

run();
