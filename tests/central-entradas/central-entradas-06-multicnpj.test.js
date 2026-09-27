/**
 * CENTRAL-ENTRADAS-06 — Seleção de candidatos (P01), ambiente (P04) e certificado (P09) por
 * empresa, Gate 593/fingerprint por empresa (P14) e diagnóstico por empresa (P15).
 *
 * Código real exercitado: CentralManifestacaoDfeService (seleção + processarCandidatos),
 * CandidatoManifestacaoDTO, CentralConfiguracaoService (painel/contexto por empresa),
 * CentralConfiguracaoController, CentralSefazOperationalGate (instância isolada, relógio controlado)
 * e CentralDiagnosticoService.
 * Simulados: repositórios, eventos, configuração fiscal por empresa, certificados (arquivos
 * fictícios, nunca abertos como PFX), transporte SOAP e cursor NSU.
 * Nenhuma chamada SEFAZ real; banco oficial nunca é aberto.
 *
 * Executar: node tests/central-entradas/central-entradas-06-multicnpj.test.js
 */
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

if (!process.env.DB_DIR) {
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ce06-multicnpj-'));
}
const BANCO_OFICIAL = /MercantilFiscal[\\/]+dados[\\/]+mercadao\.db/i;
assert.ok(!BANCO_OFICIAL.test(process.env.DB_DIR), 'DB_DIR não pode apontar para o banco oficial');

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

// Barreira: qualquer SOAP real de DistDFe falha o teste.
const runtimeDist = require('../../backend/services/fiscal/distribuicaoDfeRuntime');
let soapReal = 0;
runtimeDist.enviarDistribuicaoDfe = async () => {
  soapReal += 1;
  throw new Error('SOAP real proibido na CE-06');
};

const {
  CentralSefazOperationalGate,
  COOLDOWN_656_MINUTOS
} = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
const CentralManifestacaoDfeService = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoDfeService'
);
const { POLITICAS_MANIFESTACAO, MOTIVOS_EXCLUSAO_CANDIDATO: M } = CentralManifestacaoDfeService;
const CentralConfiguracaoService = require(
  '../../backend/motores/central-entradas/services/CentralConfiguracaoService'
);
const CentralConfiguracaoController = require(
  '../../backend/motores/central-entradas/controllers/CentralConfiguracaoController'
);
const CentralDiagnosticoService = require(
  '../../backend/motores/central-entradas/services/CentralDiagnosticoService'
);
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { DocumentoDfeTipo } = require('../../backend/motores/central-entradas/core/DocumentoDfeTipo');
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const MULTI = ModoOperacionalGlobal.MULTIEMPRESA;
const SIMPLES = ModoOperacionalGlobal.EMPRESA_SIMPLES;
const DIA_MS = 24 * 60 * 60 * 1000;
const CNPJ = Object.freeze({
  1: '38111111000115',
  2: '38111111000387',
  3: '38111111000204',
  4: '38111111000476'
});
const CNPJ_GLOBAL = '11222333000181';
const AGORA_ISO = '2026-09-27T13:00:00.000Z';
const ctxEmpresa = (empresaId, ambiente = 1) => ({ empresaId, cnpj: CNPJ[empresaId], ambiente });

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
    avancarMs: (ms) => { t += ms; },
    avancarMin: (min) => { t += min * 60 * 1000; }
  };
}

function criarRepoGate() {
  const mapa = new Map();
  return {
    mapa,
    async buscarPorChave(chave) {
      return mapa.has(chave) ? { chave, valor: mapa.get(chave), tipo: 'json' } : null;
    },
    parseValor: (reg) => (typeof reg.valor === 'string' ? JSON.parse(reg.valor) : reg.valor),
    async salvar(chave, valor) { mapa.set(chave, JSON.parse(JSON.stringify(valor))); }
  };
}

/** Gate isolado; fingerprints fictícios por empresa (nenhum PFX aberto). */
function criarGate(relogio, fingerprints = {}) {
  const chamadasFingerprint = [];
  const fp = (ctx) => {
    const chave = ctx && ctx.empresaId ? String(ctx.empresaId) : 'global';
    chamadasFingerprint.push(chave);
    return fingerprints[chave] || `fp-${chave}-v1`;
  };
  const gate = new CentralSefazOperationalGate({
    configRepository: criarRepoGate(),
    agora: relogio.agora,
    obterFingerprintConfig: async (ctx) => fp(ctx),
    obterFingerprintDetalhado: async (ctx) => ({
      fingerprint: fp(ctx),
      cnpjCertificado: ctx && ctx.empresaId ? CNPJ[ctx.empresaId] : CNPJ_GLOBAL,
      path: null,
      serial: null,
      thumbprint: null,
      validade: null
    })
  });
  return { gate, fingerprints, chamadasFingerprint };
}

async function bloquear656(gate, empresaId) {
  await gate.processarRespostaSefaz({ cStat: '656', xMotivo: 'Rejeicao: Consumo Indevido' }, ctxEmpresa(empresaId));
}

async function registrar593(gate, empresaId) {
  return gate.processarRespostaSefaz(
    { cStat: '593', xMotivo: 'Rejeicao: CNPJ-Base consultado difere do CNPJ-Base do Certificado Digital' },
    ctxEmpresa(empresaId)
  );
}

function contextoFiscal(empresaId, ambiente = 1) {
  return {
    ok: true,
    contexto: {
      empresaId,
      ambiente,
      uf: 'CE',
      codigoUf: '23',
      cnpj: CNPJ[empresaId],
      certificadoPath: `C:\\certs-ficticios\\certificado-empresa-${empresaId}.pfx`,
      certificadoSenha: 'secret-nao-logar',
      versaoServico: '1.01',
      origemAmbiente: 'empresas_configuracao_fiscal'
    }
  };
}

// ——————————————————————————————————————————————— P01 — cenário de seleção

const chaveDoc = (id) => `2326${String(id).padStart(40, '0')}`;
const emitidoHa = (relogio, dias) => new Date(relogio.agora().getTime() - dias * DIA_MS).toISOString();

function docPendente(id, empresaId, dataEmissao, extra = {}) {
  return {
    id,
    empresaId,
    empresa_id: empresaId,
    chave: chaveDoc(id),
    status: DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO,
    tipoDocumento: DocumentoDfeTipo.RES_NFE,
    dataEmissao,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra
  };
}

function criarEventos(relogio) {
  const eventos = [];
  return {
    eventos,
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
        createdAt: relogio.agora().toISOString(),
        ...dados,
        documentoId: Number(dados.documentoId ?? dados.documento_id)
      };
      eventos.push(evento);
      return evento;
    },
    async inserirUnico(dados) {
      const evento = await this.inserir(dados);
      return { evento, criado: true, conflito: false };
    },
    async removerPorTipoDocumento() { return true; },
    async contar() { return 0; }
  };
}

function cenarioP01(docs, opcoes = {}) {
  const relogio = opcoes.relogio || criarRelogio();
  const modo = opcoes.modo || MULTI;
  const contextoInvalido = new Set(opcoes.contextoInvalido || []);
  const { gate } = opcoes.gate ? { gate: opcoes.gate } : criarGate(relogio);
  const eventosRepository = criarEventos(relogio);
  const chamadasContexto = [];
  const processados = [];

  const service = new CentralManifestacaoDfeService({
    documentosRepository: {
      listarPendentesManifestacao: async (limite) => docs.slice(0, limite).map((d) => ({ ...d })),
      listarPorStatus: async () => { throw new Error('seleção não deve usar listarPorStatus'); },
      buscarPorId: async (id) => docs.find((d) => d.id === Number(id)) || null
    },
    eventosRepository,
    historicoRepository: { inserir: async (d) => d, listarPorDocumento: async () => [] },
    nsuRepository: {},
    nsuService: {},
    transitionService: {},
    configuracaoService: {
      obterPoliticaManifestacao: async () => POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA,
      obterContextoOperacional: async (opts = {}) => {
        chamadasContexto.push({ ...opts });
        const empresaId = Number(opts.empresaId);
        if (!empresaId) {
          return modo === SIMPLES
            ? { ok: true, contexto: { ...contextoFiscal(1).contexto, empresaId: null, cnpj: CNPJ_GLOBAL } }
            : { ok: false, codigoErro: 'CONFIG_FISCAL', mensagem: 'sem empresa' };
        }
        if (contextoInvalido.has(empresaId)) {
          return { ok: false, codigoErro: 'CERTIFICADO', mensagem: `Certificado ausente empresa ${empresaId}` };
        }
        return contextoFiscal(empresaId);
      }
    },
    gate,
    agora: relogio.agora,
    obterModoOperacionalGlobal: () => modo
  });
  service.processarDocumento = async (id) => {
    processados.push(Number(id));
    return { documentoId: Number(id), sucesso: true, xmlCompleto: false };
  };
  return { service, relogio, gate, eventosRepository, chamadasContexto, processados };
}

const idsSelecionados = (sel) => sel.selecionados.map((d) => d.id);
const motivoDe = (sel, id) => (sel.excluidos.find((e) => e.documentoId === id) || {}).motivo;

// ——————————————————————————————————————————————— P04/P09 — configuração por empresa

function criarCertificadosFicticios() {
  const dir = fs.mkdtempSync(path.join(process.env.DB_DIR, 'certs-'));
  const caminhos = {};
  for (const id of ['1', '2', '3', '4', 'global']) {
    const p = path.join(dir, `cert-${id === 'global' ? 'global' : `empresa-${id}`}.pfx`);
    fs.writeFileSync(p, `CERTIFICADO FICTICIO ${id} — nao e PFX`);
    caminhos[id] = p;
  }
  return caminhos;
}
const CERTS = criarCertificadosFicticios();

function criarConfigService(opcoes = {}) {
  const fiscalEmpresa = {
    1: { cnpj: CNPJ[1], ambiente: 1 },
    2: { cnpj: CNPJ[2], ambiente: 1 },
    3: { cnpj: CNPJ[3], ambiente: 1 },
    4: { cnpj: CNPJ[4], ambiente: 2 },
    ...(opcoes.fiscalEmpresa || {})
  };
  const global = { ambiente: 2, cnpj: CNPJ_GLOBAL, certificadoPath: CERTS.global, certificadoSenha: 'senha-global' };
  const chamadas = { global: 0, empresa: [], certificados: [] };
  const valores = [];
  const repo = {
    ensureDefaults: async () => {},
    listarTodas: async () => valores,
    parseValor: (r) => r.valor,
    salvar: async () => {}
  };
  const svc = new CentralConfiguracaoService({
    configuracaoRepository: repo,
    syncConfigService: { obterResumo: async () => ({ syncMaxDocumentos: 50 }) },
    getFiscalConfig: async () => {
      chamadas.global += 1;
      return { ...global };
    },
    obterFiscalEmpresa: async ({ empresaId }) => {
      chamadas.empresa.push(Number(empresaId));
      const f = fiscalEmpresa[Number(empresaId)];
      if (!f) {
        const err = new Error(`Configuração fiscal da empresa ${empresaId} não encontrada.`);
        err.code = 'CONFIG_FISCAL_EMPRESA_AUSENTE';
        throw err;
      }
      return {
        cnpj: f.cnpj,
        ambiente: f.ambiente,
        uf: 'CE',
        codigoUf: '23',
        certificadoPath: CERTS[String(empresaId)],
        certificadoSenha: `senha-empresa-${empresaId}`
      };
    },
    carregarCertificado: (p) => {
      chamadas.certificados.push(p);
      return { certPem: 'PEM-FICTICIO', privateKeyPem: 'KEY-FICTICIA', certBase64: 'AAAA' };
    }
  });
  svc._obterResumoDiagnostico = async () => ({});
  return { svc, global, chamadas, fiscalEmpresa };
}

const painelEmpresa = (svc, empresaId, modo = MULTI) => svc.obterPainelCompleto({
  empresa: { empresaId, cnpj: CNPJ[empresaId] || null, modo }
});
const painelSemEmpresa = (svc) => svc.obterPainelCompleto({
  empresaErro: {
    codigo: 'EMPRESA_CENTRAL_AUSENTE',
    mensagem: 'Modo MULTIEMPRESA exige empresa explícita (empresa_id ou X-Empresa-Id) para a Central.'
  }
});

function semSegredo(obj) {
  const txt = JSON.stringify(obj);
  assert.ok(!/senha-empresa|senha-global|secret-nao-logar/.test(txt), 'senha nunca exposta');
}

// ——————————————————————————————————————————————— P15 — diagnóstico por empresa

function retDist137() {
  return '<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb>'
    + '<verAplic>1.7.6</verAplic><cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo>'
    + '<dhResp>2026-09-27T10:00:00-03:00</dhResp><ultNSU>000000000000010</ultNSU>'
    + '<maxNSU>000000000000010</maxNSU></retDistDFeInt>';
}

function cenarioP15(opcoes = {}) {
  const relogio = criarRelogio();
  const { gate } = criarGate(relogio);
  const chamadasSoap = [];
  const chamadasContexto = [];
  const chamadasNsu = [];
  const nsuPorCnpj = {
    [CNPJ[1]]: '000000000000111',
    [CNPJ[2]]: '000000000000222',
    [CNPJ[3]]: '000000000000333'
  };
  const svc = new CentralDiagnosticoService({
    documentosRepository: {},
    eventosRepository: {},
    eventosService: {},
    flags: {},
    nsuRepository: {
      buscarPorCnpjAmbiente: async (cnpj, ambiente) => {
        chamadasNsu.push({ cnpj, ambiente });
        return { cnpj, ambiente, ultNsu: nsuPorCnpj[cnpj] || null };
      },
      obterUltimaSincronizacao: async () => {
        chamadasNsu.push({ global: true });
        return { ultNsu: '000000000000999' };
      }
    },
    configuracaoService: {
      obterContextoOperacional: async (opts = {}) => {
        chamadasContexto.push({ ...opts });
        const empresaId = Number(opts.empresaId);
        if (!empresaId) {
          return { ok: true, contexto: { ...contextoFiscal(1).contexto, empresaId: null, cnpj: CNPJ_GLOBAL } };
        }
        return contextoFiscal(empresaId);
      }
    },
    gate,
    enviarDistribuicaoDfe: async (params) => {
      chamadasSoap.push({
        cnpj: params.xmlConsulta.match(/<CNPJ>(\d+)<\/CNPJ>/)[1],
        ultNsu: params.xmlConsulta.match(/<ultNSU>(\d+)<\/ultNSU>/)[1],
        tpAmb: params.xmlConsulta.match(/<tpAmb>(\d)<\/tpAmb>/)[1],
        certificadoPath: params.certificadoPath
      });
      return { success: true, body: retDist137(), endpoint: 'https://mock.sefaz.invalid/NFeDistribuicaoDFe' };
    },
    carregarCertificado: () => ({ certBase64: 'AAAA' }),
    obterModoOperacionalGlobal: () => opcoes.modo || MULTI
  });
  return { svc, gate, relogio, chamadasSoap, chamadasContexto, chamadasNsu };
}

const diagEmpresa = (empresaId) => ({ empresa: { empresaId, cnpj: CNPJ[empresaId], modo: MULTI } });

// ——————————————————————————————————————————————— execução

async function main() {
  console.log('\nCENTRAL-ENTRADAS-06 — multi-CNPJ (P01/P04/P09/P14/P15)');
  console.log(`DB_DIR temporário: ${process.env.DB_DIR}`);

  // ————————————————————————————————————— P01
  console.log('\n— P01 seleção de candidatos à ciência —');

  await test('P01-01 11 antigos inelegíveis + novos elegíveis → novos entram (via processarCandidatos)', async () => {
    const relogio = criarRelogio();
    const antigos = Array.from({ length: 11 }, (_, i) => docPendente(i + 1, 1, emitidoHa(relogio, 20 + i)));
    const novos = [
      docPendente(101, 1, emitidoHa(relogio, 2)),
      docPendente(102, 2, emitidoHa(relogio, 3)),
      docPendente(103, 3, emitidoHa(relogio, 1))
    ];
    const c = cenarioP01([...antigos, ...novos], { relogio });
    const r = await c.service.processarCandidatos({ limite: 10 });
    assert.strictEqual(r.executado, true);
    assert.deepStrictEqual([...c.processados].sort((a, b) => a - b), [101, 102, 103]);
    assert.strictEqual(r.candidatos, 3);
    assert.strictEqual(r.selecao.excluidosPorMotivo[M.FORA_DO_PRAZO], 11);
  });

  await test('P01-02 documento com 596 é excluído', async () => {
    const relogio = criarRelogio();
    const c = cenarioP01([docPendente(1, 1, emitidoHa(relogio, 3)), docPendente(2, 1, emitidoHa(relogio, 3))], { relogio });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documentoId: 1, resultado: '596', detalhe: { cStat: '596' }
    });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.deepStrictEqual(idsSelecionados(sel), [2]);
    assert.strictEqual(motivoDe(sel, 1), M.PRAZO_EXPIRADO_596);
  });

  await test('P01-03 claim ativo é excluído; claim expirado (TTL CE-05) volta a ser elegível', async () => {
    const relogio = criarRelogio();
    const c = cenarioP01([docPendente(1, 1, emitidoHa(relogio, 3)), docPendente(2, 1, emitidoHa(relogio, 3))], { relogio });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_CLAIM, documentoId: 1,
      detalhe: { token: 't1', reclamadoEm: new Date(relogio.agora().getTime() - 60 * 1000).toISOString() }
    });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_CLAIM, documentoId: 2,
      detalhe: { token: 't2', reclamadoEm: new Date(relogio.agora().getTime() - 11 * 60 * 1000).toISOString() }
    });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 1), M.CLAIM_ATIVO);
    assert.deepStrictEqual(idsSelecionados(sel), [2]);
  });

  await test('P01-04 Gate 656 da empresa exclui somente os documentos dessa empresa', async () => {
    const relogio = criarRelogio();
    const { gate } = criarGate(relogio);
    await bloquear656(gate, 2);
    const c = cenarioP01([
      docPendente(1, 1, emitidoHa(relogio, 3)),
      docPendente(2, 2, emitidoHa(relogio, 3)),
      docPendente(3, 3, emitidoHa(relogio, 3))
    ], { relogio, gate });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 2), M.GATE_BLOQUEADO);
    assert.deepStrictEqual(idsSelecionados(sel).sort(), [1, 3]);
  });

  await test('P01-05 janela futura (pós-596 / pós-consulta) é excluída', async () => {
    const relogio = criarRelogio();
    const futuro = new Date(relogio.agora().getTime() + 30 * 60 * 1000).toISOString();
    const c = cenarioP01([
      docPendente(1, 1, emitidoHa(relogio, 3)),
      docPendente(2, 1, emitidoHa(relogio, 3)),
      docPendente(3, 1, emitidoHa(relogio, 3))
    ], { relogio });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO, documentoId: 1, detalhe: { proximaConsultaEm: futuro }
    });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documentoId: 2, resultado: '596', detalhe: { cStat: '596' }
    });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO, documentoId: 2, detalhe: { proximaConsultaEm: futuro }
    });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 1), M.JANELA_FUTURA);
    assert.ok([M.PRAZO_EXPIRADO_596, M.JANELA_FUTURA].includes(motivoDe(sel, 2)));
    assert.deepStrictEqual(idsSelecionados(sel), [3]);
  });

  await test('P01-06 documento fora do prazo da ciência é excluído', async () => {
    const relogio = criarRelogio();
    const c = cenarioP01([
      docPendente(1, 1, emitidoHa(relogio, 12)),
      docPendente(2, 1, emitidoHa(relogio, 9.5))
    ], { relogio });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 1), M.FORA_DO_PRAZO);
    assert.deepStrictEqual(idsSelecionados(sel), [2]);
  });

  await test('P01-07 sem empresa é excluído no MULTIEMPRESA (sem fallback global)', async () => {
    const relogio = criarRelogio();
    const semEmpresa = docPendente(1, null, emitidoHa(relogio, 3));
    const c = cenarioP01([semEmpresa, docPendente(2, 1, emitidoHa(relogio, 3))], { relogio });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 1), M.SEM_EMPRESA);
    assert.deepStrictEqual(idsSelecionados(sel), [2]);
    assert.ok(c.chamadasContexto.every((o) => Number(o.empresaId) > 0), 'nenhum contexto global consultado');
    assert.ok(c.chamadasContexto.every((o) => o.permitirFallbackGlobal === false));

    const simples = cenarioP01([semEmpresa], { relogio, modo: SIMPLES });
    const selSimples = await simples.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.deepStrictEqual(idsSelecionados(selSimples), [1], 'EMPRESA_SIMPLES mantém o legado');
  });

  await test('P01-08 empresa 2 sem contexto válido não impede empresas 1 e 3', async () => {
    const relogio = criarRelogio();
    const c = cenarioP01([
      docPendente(1, 1, emitidoHa(relogio, 3)),
      docPendente(2, 2, emitidoHa(relogio, 1)),
      docPendente(3, 3, emitidoHa(relogio, 3))
    ], { relogio, contextoInvalido: [2] });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 2), M.CONTEXTO_INVALIDO);
    assert.deepStrictEqual(idsSelecionados(sel).sort(), [1, 3]);
  });

  await test('P01-09 três empresas recebem oportunidade (cota por empresa)', async () => {
    const relogio = criarRelogio();
    const docs = [];
    // Empresa 1 tem os 5 documentos mais urgentes; ainda assim 2 e 3 entram no lote de 6.
    // CENTRAL-XML-02 P3: a cota por empresa vale na faixa NORMAL (> 48 h); URGENTE/ATENCAO
    // furam a cota (central-xml-02 T11b). Aqui todos estão em NORMAL (restam ≥ 3 dias).
    for (let i = 0; i < 5; i += 1) docs.push(docPendente(10 + i, 1, emitidoHa(relogio, 7 - i * 0.1)));
    for (let i = 0; i < 5; i += 1) docs.push(docPendente(20 + i, 2, emitidoHa(relogio, 4 - i * 0.1)));
    for (let i = 0; i < 5; i += 1) docs.push(docPendente(30 + i, 3, emitidoHa(relogio, 2 - i * 0.1)));
    const c = cenarioP01(docs, { relogio });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 6 });
    assert.strictEqual(sel.selecionados.length, 6);
    assert.deepStrictEqual(sel.porEmpresa, { 1: 2, 2: 2, 3: 2 });
    assert.deepStrictEqual(idsSelecionados(sel).slice(0, 3), [10, 20, 30], 'primeira rodada: o mais urgente de cada empresa');
  });

  await test('P01-10 uma única empresa pode preencher o lote', async () => {
    const relogio = criarRelogio();
    const docs = Array.from({ length: 12 }, (_, i) => docPendente(i + 1, 1, emitidoHa(relogio, 1 + i * 0.5)));
    const c = cenarioP01(docs, { relogio });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(sel.selecionados.length, 10);
    assert.deepStrictEqual(sel.porEmpresa, { 1: 10 });
  });

  await test('P01-11 ordenação pelo menor prazo restante', async () => {
    const relogio = criarRelogio();
    const c = cenarioP01([
      docPendente(1, 1, emitidoHa(relogio, 2)),
      docPendente(2, 1, emitidoHa(relogio, 9)),
      docPendente(3, 1, emitidoHa(relogio, 5)),
      docPendente(4, 1, null)
    ], { relogio });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    // CENTRAL-XML-02 P0: sem dhEmi com hora/offset o prazo é indeterminado → sem ciência automática.
    assert.deepStrictEqual(idsSelecionados(sel), [2, 3, 1]);
    assert.strictEqual(motivoDe(sel, 4), M.PRAZO_INDETERMINADO);
  });

  await test('P01-12 seleção determinística (duas execuções e entrada embaralhada)', async () => {
    const relogio = criarRelogio();
    const mesmaEmissao = emitidoHa(relogio, 4);
    const docs = [
      docPendente(5, 2, mesmaEmissao), docPendente(3, 1, mesmaEmissao), docPendente(9, 3, emitidoHa(relogio, 6)),
      docPendente(1, 1, mesmaEmissao), docPendente(7, 2, emitidoHa(relogio, 8)), docPendente(2, 3, mesmaEmissao)
    ];
    const a = await cenarioP01(docs, { relogio }).service._selecionarCandidatosManifestacao({ limite: 4 });
    const b = await cenarioP01(docs, { relogio }).service._selecionarCandidatosManifestacao({ limite: 4 });
    const d = await cenarioP01([...docs].reverse(), { relogio }).service._selecionarCandidatosManifestacao({ limite: 4 });
    assert.deepStrictEqual(idsSelecionados(a), idsSelecionados(b));
    assert.deepStrictEqual(idsSelecionados(a), idsSelecionados(d));
  });

  await test('P01-13 CIENCIA_ACEITA é excluída', async () => {
    const relogio = criarRelogio();
    const c = cenarioP01([docPendente(1, 1, emitidoHa(relogio, 3)), docPendente(2, 1, emitidoHa(relogio, 3))], { relogio });
    await c.eventosRepository.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_ACEITA, documentoId: 1, resultado: '135', detalhe: { cStat: '135' }
    });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 1), M.CIENCIA_ACEITA);
    assert.deepStrictEqual(idsSelecionados(sel), [2]);
  });

  await test('P01-14 tipo não elegível é excluído (somente RES_NFE)', async () => {
    const relogio = criarRelogio();
    const c = cenarioP01([
      docPendente(1, 1, emitidoHa(relogio, 3), { tipoDocumento: DocumentoDfeTipo.PROC_NFE }),
      docPendente(2, 1, emitidoHa(relogio, 3))
    ], { relogio });
    const sel = await c.service._selecionarCandidatosManifestacao({ limite: 10 });
    assert.strictEqual(motivoDe(sel, 1), M.TIPO_NAO_ELEGIVEL);
    assert.deepStrictEqual(idsSelecionados(sel), [2]);
  });

  await test('P01-15 limite do lote respeitado (após elegibilidade e distribuição; teto 50)', async () => {
    const relogio = criarRelogio();
    const docs = Array.from({ length: 60 }, (_, i) => docPendente(i + 1, (i % 3) + 1, emitidoHa(relogio, 1 + (i % 8))));
    const c = cenarioP01(docs, { relogio });
    const r7 = await c.service.processarCandidatos({ limite: 7 });
    assert.strictEqual(r7.candidatos, 7);
    assert.strictEqual(c.processados.length, 7);
    c.processados.length = 0;
    const rMax = await c.service.processarCandidatos({ limite: 500 });
    assert.strictEqual(rMax.candidatos, 50);
    assert.strictEqual(c.processados.length, 50);
  });

  // ————————————————————————————————————— P04
  console.log('\n— P04 ambiente por empresa no painel —');

  await test('P04-01 global=2 e empresa 1=1 → painel mostra Produção', async () => {
    const { svc, chamadas } = criarConfigService();
    const painel = await painelEmpresa(svc, 1);
    assert.strictEqual(painel.ambiente.codigo, 1);
    assert.strictEqual(painel.ambiente.label, 'Produção');
    assert.strictEqual(painel.ambiente.origem, 'empresas_configuracao_fiscal');
    assert.ok(!/fonte oficial/i.test(painel.ambiente.origemLabel));
    assert.strictEqual(painel.empresaContexto.estado, 'OK');
    assert.strictEqual(painel.empresaContexto.empresaId, 1);
    assert.strictEqual(chamadas.global, 0, 'config global não consultada');
  });

  await test('P04-02 empresa 2 → Produção', async () => {
    const { svc } = criarConfigService();
    const painel = await painelEmpresa(svc, 2);
    assert.strictEqual(painel.ambiente.codigo, 1);
    assert.strictEqual(painel.empresaContexto.cnpj, CNPJ[2]);
  });

  await test('P04-03 empresa 3 → Produção', async () => {
    const { svc } = criarConfigService();
    const painel = await painelEmpresa(svc, 3);
    assert.strictEqual(painel.ambiente.codigo, 1);
    assert.strictEqual(painel.empresaContexto.cnpj, CNPJ[3]);
  });

  await test('P04-04 alterar o ambiente global não altera o da empresa', async () => {
    const { svc, global } = criarConfigService();
    global.ambiente = 1;
    assert.strictEqual((await painelEmpresa(svc, 1)).ambiente.codigo, 1);
    global.ambiente = 2;
    const painel = await painelEmpresa(svc, 1);
    assert.strictEqual(painel.ambiente.codigo, 1);
    const legado = await svc.obterPainelCompleto();
    assert.strictEqual(legado.ambiente.codigo, 2, 'painel sem empresa (legado) continua lendo o global');
  });

  await test('P04-05 sem contexto → sem fallback global; controller devolve estado explícito', async () => {
    const { svc, chamadas } = criarConfigService();
    const painel = await painelSemEmpresa(svc);
    assert.strictEqual(painel.ambiente.codigo, null);
    assert.strictEqual(painel.empresaContexto.estado, 'EMPRESA_NAO_SELECIONADA');
    assert.strictEqual(painel.empresaContexto.codigo, 'EMPRESA_CENTRAL_AUSENTE');
    assert.strictEqual(painel.sefaz.urlDistribuicaoDfe, null, 'sem ambiente não escolhe endpoint');
    assert.strictEqual(chamadas.global, 0);
    assert.deepStrictEqual(chamadas.empresa, []);

    const controller = new CentralConfiguracaoController({
      configuracaoService: svc,
      resolverEmpresa: async () => {
        const err = new Error('Modo MULTIEMPRESA exige empresa explícita.');
        err.code = 'EMPRESA_CENTRAL_AUSENTE';
        throw err;
      }
    });
    let enviado = null;
    await controller.obter({ headers: {} }, { json: (b) => { enviado = b; }, status() { return this; } });
    assert.strictEqual(enviado.empresaContexto.estado, 'EMPRESA_NAO_SELECIONADA');
    assert.strictEqual(enviado.ambiente.codigo, null);
    assert.strictEqual(chamadas.global, 0);
  });

  await test('P04-06 trocar de empresa atualiza o ambiente', async () => {
    const { svc } = criarConfigService();
    const p1 = await painelEmpresa(svc, 1);
    const p4 = await painelEmpresa(svc, 4);
    const p1b = await painelEmpresa(svc, 1);
    assert.strictEqual(p1.ambiente.codigo, 1);
    assert.strictEqual(p4.ambiente.codigo, 2);
    assert.strictEqual(p4.empresaContexto.cnpj, CNPJ[4]);
    assert.strictEqual(p1b.ambiente.codigo, 1);
  });

  // ————————————————————————————————————— P09
  console.log('\n— P09 certificado por empresa —');

  const assertCertEmpresa = async (empresaId) => {
    const { svc, chamadas } = criarConfigService();
    const painel = await painelEmpresa(svc, empresaId);
    assert.strictEqual(painel.certificado.empresaId, empresaId);
    assert.strictEqual(painel.certificado.arquivo, `cert-empresa-${empresaId}.pfx`);
    assert.strictEqual(painel.certificado.cnpj, CNPJ[empresaId]);
    assert.strictEqual(painel.certificado.presente, true);
    assert.strictEqual(painel.certificado.caminho, null, 'caminho completo não exposto');
    assert.deepStrictEqual(chamadas.certificados, [CERTS[String(empresaId)]], 'somente o arquivo fictício da empresa');
    assert.strictEqual(painel.empresaContexto.certificado.empresaId, empresaId);
    semSegredo(painel);
  };

  await test('P09-01 empresa 1 → certificado da empresa 1', async () => assertCertEmpresa(1));
  await test('P09-02 empresa 2 → certificado da empresa 2', async () => assertCertEmpresa(2));
  await test('P09-03 empresa 3 → certificado da empresa 3', async () => assertCertEmpresa(3));

  await test('P09-04 certificado global diferente não aparece no painel da empresa', async () => {
    const { svc, chamadas } = criarConfigService();
    const painel = await painelEmpresa(svc, 2);
    const txt = JSON.stringify(painel);
    assert.ok(!txt.includes('cert-global.pfx'));
    assert.ok(!txt.includes(CNPJ_GLOBAL));
    assert.ok(!chamadas.certificados.includes(CERTS.global));
    assert.strictEqual(painel.certificadosFiliais.length, 1);
    assert.strictEqual(painel.certificadosFiliais[0].id, 'empresa:2');
  });

  await test('P09-05 sem contexto → sem certificado global; empresa desconhecida → contexto não resolvido', async () => {
    const { svc, chamadas } = criarConfigService();
    const semEmp = await painelSemEmpresa(svc);
    assert.strictEqual(semEmp.certificado.presente, false);
    assert.strictEqual(semEmp.certificado.status, 'EMPRESA_NAO_SELECIONADA');
    assert.deepStrictEqual(semEmp.certificadosFiliais, []);
    const desconhecida = await painelEmpresa(svc, 99);
    assert.strictEqual(desconhecida.empresaContexto.estado, 'CONTEXTO_NAO_RESOLVIDO');
    assert.strictEqual(desconhecida.certificado.status, 'CONTEXTO_NAO_RESOLVIDO');
    assert.strictEqual(desconhecida.certificado.presente, false);
    assert.strictEqual(chamadas.global, 0, 'nunca cai no certificado global');
    assert.ok(!JSON.stringify([semEmp, desconhecida]).includes('cert-global.pfx'));
    semSegredo([semEmp, desconhecida]);
  });

  await test('P09-06 trocar de empresa troca o certificado', async () => {
    const { svc } = criarConfigService();
    const a = await painelEmpresa(svc, 1);
    const b = await painelEmpresa(svc, 3);
    assert.strictEqual(a.certificado.arquivo, 'cert-empresa-1.pfx');
    assert.strictEqual(b.certificado.arquivo, 'cert-empresa-3.pfx');
    assert.strictEqual(b.certificado.cnpj, CNPJ[3]);
  });

  // ————————————————————————————————————— P14
  console.log('\n— P14 Gate 593 e fingerprint por empresa —');

  await test('P14-01 empresa 2 recebe 593 → só a empresa 2 bloqueada', async () => {
    const relogio = criarRelogio();
    const { gate } = criarGate(relogio);
    const r = await registrar593(gate, 2);
    assert.strictEqual(r.acao, 'suspender');
    assert.strictEqual(r.escopo, 'EMPRESA');
    const a2 = await gate.autorizarConsultaDistDfe(ctxEmpresa(2));
    assert.strictEqual(a2.permitido, false);
    assert.strictEqual(a2.cStat, '593');
    assert.strictEqual(a2.escopo, 'EMPRESA');
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(1))).permitido, true);
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(3))).permitido, true);
    assert.strictEqual(gate.estaSuspenso593(), false, 'estado 593 global intacto');
    assert.notStrictEqual(gate.obterEstadoOperacional().codigo, 'CONFIG_ERROR', 'circuito global não vira CONFIG_ERROR');
  });

  await test('P14-02 empresa 1 consulta normalmente enquanto a 2 está bloqueada', async () => {
    const relogio = criarRelogio();
    const { gate } = criarGate(relogio);
    await registrar593(gate, 2);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const a1 = await gate.autorizarConsultaDistDfe(ctxEmpresa(1));
      assert.strictEqual(a1.permitido, true);
      // eslint-disable-next-line no-await-in-loop
      await gate.processarRespostaSefaz({ cStat: '138' }, ctxEmpresa(1));
    }
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(2))).permitido, false);
    const b = await gate.avaliarBloqueioContexto(ctxEmpresa(1));
    assert.strictEqual(b.bloqueado, false);
  });

  await test('P14-03 empresa 2 permanece bloqueada até a condição de liberação (fingerprint da empresa 2)', async () => {
    const relogio = criarRelogio();
    const { gate, fingerprints } = criarGate(relogio);
    await registrar593(gate, 2);
    relogio.avancarMs(48 * 60 * 60 * 1000);
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(2))).permitido, false, 'tempo não libera 593');
    fingerprints['1'] = 'fp-1-v2';
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(2))).permitido, false,
      'troca do certificado da empresa 1 não libera a empresa 2');
    fingerprints['2'] = 'fp-2-v2';
    const liberado = await gate.autorizarConsultaDistDfe(ctxEmpresa(2));
    assert.strictEqual(liberado.permitido, true, 'troca do certificado/CNPJ da empresa 2 libera');
    assert.strictEqual(gate.estaSuspenso593Contexto(ctxEmpresa(2)), false);
  });

  await test('P14-04 contexto incompleto mantém o circuito legado global', async () => {
    const relogio = criarRelogio();
    const { gate } = criarGate(relogio);
    const r = await gate.processarRespostaSefaz({ cStat: '593' }, { cnpj: CNPJ[1] });
    assert.strictEqual(r.acao, 'suspender');
    assert.notStrictEqual(r.escopo, 'EMPRESA');
    assert.strictEqual(gate.estaSuspenso593(), true);
    assert.strictEqual(gate.obterEstadoOperacional().codigo, 'CONFIG_ERROR');
    const aLegado = await gate.autorizarConsultaDistDfe({});
    assert.strictEqual(aLegado.permitido, false);
    assert.strictEqual(aLegado.escopo, 'GLOBAL');
    assert.strictEqual(gate.listarErros593PorEmpresa().length, 0);
  });

  await test('P14-05 fingerprint diferente da empresa 2 não bloqueia a empresa 1', async () => {
    const relogio = criarRelogio();
    const { gate, fingerprints, chamadasFingerprint } = criarGate(relogio, { 1: 'fp-empresa-1', 2: 'fp-empresa-2' });
    const r = await registrar593(gate, 2);
    assert.strictEqual(r.estado593.fingerprint, 'fp-empresa-2', 'fingerprint calculado com a config da empresa 2');
    assert.ok(chamadasFingerprint.includes('2'));
    assert.ok(!chamadasFingerprint.includes('global'), 'fingerprint global não usado no escopo por empresa');
    fingerprints['1'] = 'fp-empresa-1-diferente';
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(1))).permitido, true);
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(2))).permitido, false);
  });

  await test('P14-06 estado 593 por empresa sobrevive a restart (serializar/hidratar)', async () => {
    const relogio = criarRelogio();
    const { gate } = criarGate(relogio);
    await registrar593(gate, 2);
    const serial = JSON.parse(JSON.stringify(gate.serializar()));
    assert.ok(serial.erros593PorEmpresa && Object.keys(serial.erros593PorEmpresa).length === 1);
    const { gate: reiniciado } = criarGate(relogio);
    reiniciado.hidratar(serial);
    assert.strictEqual((await reiniciado.autorizarConsultaDistDfe(ctxEmpresa(2))).permitido, false);
    assert.strictEqual((await reiniciado.autorizarConsultaDistDfe(ctxEmpresa(1))).permitido, true);
    assert.strictEqual(reiniciado.estaSuspenso593(), false);
    assert.strictEqual(reiniciado.listarErros593PorEmpresa()[0].empresaId, 2);
  });

  await test('P14-07 Gate 656 da CE-04 inalterado', async () => {
    const relogio = criarRelogio();
    const { gate } = criarGate(relogio);
    await bloquear656(gate, 1);
    const b1 = gate.obterBloqueio656Contexto(ctxEmpresa(1));
    assert.strictEqual(b1.ativo, true);
    assert.strictEqual(b1.intervaloMs, COOLDOWN_656_MINUTOS[0] * 60 * 1000);
    const a1 = await gate.autorizarConsultaDistDfe(ctxEmpresa(1));
    assert.strictEqual(a1.permitido, false);
    assert.strictEqual(a1.cStat, '656');
    assert.strictEqual(a1.escopo, 'EMPRESA');
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(2))).permitido, true);
    assert.strictEqual(gate.estaBloqueado656(), false, '656 por empresa não toca o global');
    relogio.avancarMs(COOLDOWN_656_MINUTOS[0] * 60 * 1000 + 1);
    assert.strictEqual((await gate.autorizarConsultaDistDfe(ctxEmpresa(1))).permitido, true);
    await gate.processarRespostaSefaz({ cStat: '656' }, {});
    assert.strictEqual(gate.estaBloqueado656(), true, '656 sem contexto segue global legado');
  });

  // ————————————————————————————————————— P15
  console.log('\n— P15 diagnóstico / Testar SEFAZ por empresa —');

  const assertDiagEmpresa = async (empresaId) => {
    const c = cenarioP15();
    const r = await c.svc.testarConexaoSefaz(diagEmpresa(empresaId));
    assert.strictEqual(r.empresaId, empresaId);
    assert.strictEqual(r.cnpj, CNPJ[empresaId]);
    assert.strictEqual(r.cStat, '137');
    assert.strictEqual(c.chamadasSoap.length, 1);
    assert.strictEqual(c.chamadasSoap[0].cnpj, CNPJ[empresaId]);
    assert.ok(c.chamadasSoap[0].certificadoPath.includes(`empresa-${empresaId}`));
    assert.deepStrictEqual(c.chamadasContexto, [{ empresaId, permitirFallbackGlobal: false }]);
    semSegredo(r);
  };

  await test('P15-01 empresa 1 → diagnóstico usa a empresa 1', async () => assertDiagEmpresa(1));
  await test('P15-02 empresa 2 → diagnóstico usa a empresa 2', async () => assertDiagEmpresa(2));
  await test('P15-03 empresa 3 → diagnóstico usa a empresa 3', async () => assertDiagEmpresa(3));

  await test('P15-04 sem empresa → nenhuma SEFAZ (EMPRESA_CENTRAL_AUSENTE)', async () => {
    const c = cenarioP15();
    const r = await c.svc.testarConexaoSefaz({
      empresaErro: { codigo: 'EMPRESA_CENTRAL_AUSENTE', mensagem: 'Selecione a empresa.' }
    });
    assert.strictEqual(r.sucesso, false);
    assert.strictEqual(r.codigo, 'EMPRESA_CENTRAL_AUSENTE');
    assert.strictEqual(r.contextoEmpresaNaoSelecionado, true);
    const semArgs = await c.svc.testarConexaoSefaz();
    assert.strictEqual(semArgs.codigo, 'EMPRESA_CENTRAL_AUSENTE', 'chamada legada sem empresa também recusa no MULTIEMPRESA');
    const cert = await c.svc.testarCertificado();
    assert.strictEqual(cert.codigo, 'EMPRESA_CENTRAL_AUSENTE');
    assert.strictEqual(c.chamadasSoap.length, 0);
    assert.strictEqual(c.chamadasContexto.length, 0, 'nenhum contexto (global) resolvido');
    assert.strictEqual(c.chamadasNsu.length, 0);
  });

  await test('P15-05 empresa 2 bloqueada no Gate → nenhum SOAP (656 e 593)', async () => {
    const c = cenarioP15();
    await bloquear656(c.gate, 2);
    const r656 = await c.svc.testarConexaoSefaz(diagEmpresa(2));
    assert.strictEqual(r656.bloqueadoPeloGate, true);
    assert.strictEqual(r656.cStat, '656');
    assert.strictEqual(r656.escopoGate, 'EMPRESA');
    const c593 = cenarioP15();
    await registrar593(c593.gate, 2);
    const r593 = await c593.svc.testarConexaoSefaz(diagEmpresa(2));
    assert.strictEqual(r593.bloqueadoPeloGate, true);
    assert.strictEqual(r593.cStat, '593');
    assert.strictEqual(c.chamadasSoap.length + c593.chamadasSoap.length, 0);
  });

  await test('P15-06 empresa 1 executa enquanto a empresa 2 está bloqueada', async () => {
    const c = cenarioP15();
    await bloquear656(c.gate, 2);
    await registrar593(c.gate, 2);
    const r1 = await c.svc.testarConexaoSefaz(diagEmpresa(1));
    assert.notStrictEqual(r1.bloqueadoPeloGate, true);
    assert.strictEqual(r1.cStat, '137');
    assert.strictEqual(c.chamadasSoap.length, 1);
    assert.strictEqual(c.chamadasSoap[0].cnpj, CNPJ[1]);
  });

  await test('P15-07 NSU consultado pertence à empresa selecionada (não o cursor global)', async () => {
    const c = cenarioP15();
    const r = await c.svc.testarConexaoSefaz(diagEmpresa(2));
    assert.strictEqual(r.ultNsuConsultado, '000000000000222');
    assert.strictEqual(c.chamadasSoap[0].ultNsu, '000000000000222');
    assert.deepStrictEqual(c.chamadasNsu, [{ cnpj: CNPJ[2], ambiente: 1 }]);
    assert.ok(!c.chamadasNsu.some((n) => n.global), 'obterUltimaSincronizacao (global) não usado');
  });

  await test('P15-08 trocar de empresa troca o contexto do diagnóstico', async () => {
    const c = cenarioP15();
    const a = await c.svc.testarConexaoSefaz(diagEmpresa(1));
    const b = await c.svc.testarConexaoSefaz(diagEmpresa(3));
    assert.strictEqual(a.empresaId, 1);
    assert.strictEqual(b.empresaId, 3);
    assert.deepStrictEqual(c.chamadasSoap.map((s) => s.cnpj), [CNPJ[1], CNPJ[3]]);
    assert.deepStrictEqual(c.chamadasSoap.map((s) => s.ultNsu), ['000000000000111', '000000000000333']);
    const certA = await c.svc.testarCertificado(diagEmpresa(1));
    assert.strictEqual(certA.empresaId, 1);
    assert.strictEqual(certA.sucesso, true);
  });

  assert.strictEqual(soapReal, 0, 'nenhuma chamada SOAP real');
  console.log(`\nResultado CE-06: ${ok} passou; ${falhas} falhou. SOAP real: ${soapReal}.`);
  if (falhas > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
