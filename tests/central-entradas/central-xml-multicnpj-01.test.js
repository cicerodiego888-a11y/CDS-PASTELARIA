/**
 * CENTRAL-XML-MULTICNPJ-01 — XML completo isolado por CNPJ/empresa.
 * Executar: node tests/central-entradas/central-xml-multicnpj-01.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-central-xml-multicnpj-01-');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const MotorRecuperacaoXmlService = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService'
);
const CentralManifestacaoDfeService = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoDfeService'
);
const { POLITICAS_MANIFESTACAO } = CentralManifestacaoDfeService;
const CentralDfePersistenciaService = require(
  '../../backend/motores/central-entradas/services/CentralDfePersistenciaService'
);
const {
  obterContextoOperacionalDoDocumento,
  mascararCnpj,
  mascararChave,
  resolverEmpresaIdDocumento
} = require('../../backend/motores/central-entradas/services/resolverContextoDocumentoCentral');
const { DocumentoFiscalStatus } = require(
  '../../backend/motores/central-entradas/core/DocumentoFiscalStatus'
);
const { DocumentoDfeTipo } = require(
  '../../backend/motores/central-entradas/core/DocumentoDfeTipo'
);
const { CHAVES } = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig'
);

const S = DocumentoFiscalStatus;
const EMP = Object.freeze({ MATRIZ: 1, FILIAL2: 2, FILIAL3: 3 });
const CNPJ = Object.freeze({
  1: '38111111000115',
  2: '38111111000387',
  3: '38111111000204'
});
const CHAVE = Object.freeze({
  1: '23260800000000000000000000000000000000000001',
  2: '23260900000000000000000000000000000000000002',
  3: '23260900000000000000000000000000000000000003'
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

function criarRepoMotor(docsIniciais) {
  const docs = new Map(docsIniciais.map((d) => [Number(d.id), { ...d }]));
  const historico = [];
  const eventos = [];
  const config = new Map();
  return {
    docs,
    historico,
    eventos,
    documentosRepository: {
      async listar({ statusIn }) {
        return [...docs.values()].filter((d) => statusIn.includes(d.status));
      },
      async buscarPorId(id) {
        return docs.get(Number(id)) || null;
      },
      async buscarPorChave(chave, empresaId) {
        const emp = Number(empresaId);
        return [...docs.values()].find((d) => d.chave === chave && Number(d.empresaId) === emp) || null;
      }
    },
    historicoRepository: {
      inserir: async (dados) => {
        historico.push(dados);
        return { id: historico.length, ...dados };
      }
    },
    eventosRepository: {
      inserir: async (dados) => {
        eventos.push(dados);
        return { id: eventos.length, ...dados };
      }
    },
    configRepository: {
      async listarTodas() {
        return [...config.entries()].map(([chave, valor]) => ({ chave, valor, tipo: 'boolean' }));
      },
      parseValor(reg) {
        return reg.valor;
      },
      async buscarPorChave(chave) {
        if (!config.has(chave)) return null;
        return { chave, valor: config.get(chave), tipo: 'boolean' };
      },
      async salvar(chave, valor) {
        config.set(chave, valor);
      }
    },
    transitionService: {
      transicionar: async () => ({})
    }
  };
}

function docResumo(id, empresaId) {
  return {
    id,
    empresaId,
    empresa_id: empresaId,
    chave: CHAVE[empresaId],
    status: S.RESUMO_RECEBIDO,
    tipoDocumento: DocumentoDfeTipo.RES_NFE,
    nsu: String(empresaId).padStart(15, '0'),
    createdAt: '2026-09-16T12:00:00.000Z'
  };
}

function contextoPorEmpresa(opts = {}) {
  const empresaId = Number(opts.empresaId);
  if (!empresaId) {
    return {
      ok: true,
      contexto: {
        empresaId: null,
        ambiente: 1,
        cnpj: CNPJ[1],
        certificadoPath: 'C:\\\\certs\\\\global.pfx',
        certificadoSenha: 'secret-nao-logar',
        origemAmbiente: 'getFiscalConfig'
      }
    };
  }
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

async function main() {
  console.log('CENTRAL-XML-MULTICNPJ-01');

  await test('Helper mascara CNPJ e chave; resolve empresa_id', () => {
    assert.strictEqual(mascararCnpj('38123456000115'), '38.***.***/0001-15');
    assert.strictEqual(mascararChave(CHAVE[2]).includes('…'), true);
    assert.strictEqual(resolverEmpresaIdDocumento({ empresa_id: 3 }), 3);
    assert.strictEqual(resolverEmpresaIdDocumento({}), null);
  });

  await test('Contexto MULTIEMPRESA usa empresa do documento sem fallback global', async () => {
    const calls = [];
    const r = await obterContextoOperacionalDoDocumento(
      async (opts) => {
        calls.push(opts);
        return contextoPorEmpresa(opts);
      },
      { empresaId: 2, chave: CHAVE[2] },
      { obterModoOperacionalGlobal: () => 'MULTIEMPRESA' }
    );
    assert.strictEqual(calls[0].empresaId, 2);
    assert.strictEqual(calls[0].permitirFallbackGlobal, false);
    assert.strictEqual(r.contexto.cnpj, CNPJ[2]);
    assert.strictEqual(r.contexto.empresaId, 2);
    assert.ok(!JSON.stringify(calls).includes('secret-nao-logar'));
  });

  await test('Motor: Matriz, Filial 2 e Filial 3 consultam CNPJ/certificado/persistência próprios', async () => {
    const mem = criarRepoMotor([
      docResumo(11, EMP.MATRIZ),
      docResumo(22, EMP.FILIAL2),
      docResumo(33, EMP.FILIAL3)
    ]);
    await mem.configRepository.salvar(CHAVES.ATIVA, true);
    const consultas = [];
    const persistencias = [];
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: mem.documentosRepository,
      historicoRepository: mem.historicoRepository,
      eventosRepository: mem.eventosRepository,
      configRepository: mem.configRepository,
      transitionService: mem.transitionService,
      gate: { autorizarConsultaDistDfe: async () => ({ permitido: true }) },
      obterContextoOperacional: async (opts) => contextoPorEmpresa(opts),
      criarPersistencia: (empresaId) => {
        persistencias.push(empresaId);
        return { _empresaId: empresaId };
      },
      consultarNotaPorChave: async (chave, opts) => {
        consultas.push({
          chave,
          empresaId: opts.contextoCentral.empresaId,
          cnpj: opts.contextoCentral.cnpj,
          cert: opts.contextoCentral.certificadoPath,
          persistenciaEmpresaId: opts.persistenciaService?._empresaId
        });
        return { cStat: '137', mensagem: 'Nenhum documento localizado', notasNovas: 0 };
      },
      processarDocumento: async () => null,
      agora: () => new Date('2026-09-16T18:00:00Z')
    });
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(rel.consultados, 3);
    assert.strictEqual(rel.recuperados, 0);
    assert.deepStrictEqual(consultas.map((c) => c.empresaId).sort(), [1, 2, 3]);
    assert.deepStrictEqual(consultas.map((c) => c.cnpj).sort(), [CNPJ[1], CNPJ[2], CNPJ[3]].sort());
    assert.ok(consultas.every((c) => String(c.cert).includes(`certificado-empresa-${c.empresaId}.pfx`)));
    assert.ok(consultas.every((c) => c.persistenciaEmpresaId === c.empresaId));
    assert.ok(consultas.every((c) => c.cnpj !== CNPJ[1] || c.empresaId === 1));
    const filial2 = consultas.find((c) => c.empresaId === 2);
    assert.strictEqual(filial2.cnpj, CNPJ[2]);
    assert.notStrictEqual(filial2.cnpj, CNPJ[1]);
    assert.deepStrictEqual(persistencias.sort(), [1, 2, 3]);
    assert.strictEqual(mem.docs.get(22).status, S.RESUMO_RECEBIDO);
  });

  await test('Motor: XML da empresa 2 nunca atualiza documento da empresa 3 (chave isolada)', async () => {
    const lookups = [];
    const persist = new CentralDfePersistenciaService({
      documentosRepository: {
        buscarPorChave: async (chave, empresaId) => {
          lookups.push({ chave, empresaId });
          if (Number(empresaId) === 2 && chave === CHAVE[2]) {
            return { id: 22, chave, empresaId: 2, status: S.RESUMO_RECEBIDO };
          }
          return null;
        }
      }
    });
    persist._empresaId = 2;
    const existente = await persist._documentosRepository.buscarPorChave(CHAVE[2], persist._empresaId);
    const outro = await persist._documentosRepository.buscarPorChave(CHAVE[2], 3);
    assert.strictEqual(existente.empresaId, 2);
    assert.strictEqual(outro, null);
    assert.ok(lookups.some((l) => l.empresaId === 2));
    assert.ok(lookups.some((l) => l.empresaId === 3));
  });

  await test('Motor: retorno sem XML/docZip (cStat 137) mantém RESUMO_RECEBIDO', async () => {
    const mem = criarRepoMotor([docResumo(22, EMP.FILIAL2)]);
    await mem.configRepository.salvar(CHAVES.ATIVA, true);
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: mem.documentosRepository,
      historicoRepository: mem.historicoRepository,
      eventosRepository: mem.eventosRepository,
      configRepository: mem.configRepository,
      transitionService: mem.transitionService,
      gate: { autorizarConsultaDistDfe: async () => ({ permitido: true }) },
      obterContextoOperacional: async (opts) => contextoPorEmpresa(opts),
      criarPersistencia: (empresaId) => ({ _empresaId: empresaId }),
      consultarNotaPorChave: async () => ({ cStat: '137', mensagem: 'Nenhum documento', notasNovas: 0 }),
      processarDocumento: async () => null,
      agora: () => new Date('2026-09-16T18:00:00Z')
    });
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(rel.recuperados, 0);
    assert.strictEqual(mem.docs.get(22).status, S.RESUMO_RECEBIDO);
  });

  await test('Motor: erro SEFAZ registra falha e preserva CNPJ da filial', async () => {
    const mem = criarRepoMotor([docResumo(33, EMP.FILIAL3)]);
    await mem.configRepository.salvar(CHAVES.ATIVA, true);
    let cnpjUsado = null;
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: mem.documentosRepository,
      historicoRepository: mem.historicoRepository,
      eventosRepository: mem.eventosRepository,
      configRepository: mem.configRepository,
      transitionService: mem.transitionService,
      gate: { autorizarConsultaDistDfe: async () => ({ permitido: true }) },
      obterContextoOperacional: async (opts) => contextoPorEmpresa(opts),
      criarPersistencia: (empresaId) => ({ _empresaId: empresaId }),
      consultarNotaPorChave: async (_ch, opts) => {
        cnpjUsado = opts.contextoCentral.cnpj;
        throw new Error('SEFAZ timeout');
      },
      processarDocumento: async () => null,
      agora: () => new Date('2026-09-16T18:00:00Z')
    });
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.ok(rel.falhas >= 1);
    assert.strictEqual(cnpjUsado, CNPJ[3]);
    assert.strictEqual(mem.docs.get(33).status, S.RESUMO_RECEBIDO);
  });

  await test('Motor: retry incrementa tentativas no mesmo CNPJ', async () => {
    const mem = criarRepoMotor([docResumo(22, EMP.FILIAL2)]);
    await mem.configRepository.salvar(CHAVES.ATIVA, true);
    const cnpjs = [];
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: mem.documentosRepository,
      historicoRepository: mem.historicoRepository,
      eventosRepository: mem.eventosRepository,
      configRepository: mem.configRepository,
      transitionService: mem.transitionService,
      gate: { autorizarConsultaDistDfe: async () => ({ permitido: true }) },
      obterContextoOperacional: async (opts) => contextoPorEmpresa(opts),
      criarPersistencia: (empresaId) => ({ _empresaId: empresaId }),
      consultarNotaPorChave: async (_ch, opts) => {
        cnpjs.push(opts.contextoCentral.cnpj);
        return { cStat: '137', notasNovas: 0 };
      },
      processarDocumento: async () => null,
      agora: () => new Date('2026-09-16T18:00:00Z')
    });
    await motor.executarCiclo({ forcar: true });
    await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(cnpjs.length, 2);
    assert.ok(cnpjs.every((c) => c === CNPJ[2]));
    assert.strictEqual(motor._estado.docs['22'].tentativas, 2);
  });

  await test('Motor: XML já persistido (PROC_NFE) não reconsulta', async () => {
    const mem = criarRepoMotor([{
      ...docResumo(11, EMP.MATRIZ),
      status: S.XML_COMPLETO,
      tipoDocumento: DocumentoDfeTipo.PROC_NFE
    }]);
    await mem.configRepository.salvar(CHAVES.ATIVA, true);
    let consultas = 0;
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: mem.documentosRepository,
      historicoRepository: mem.historicoRepository,
      eventosRepository: mem.eventosRepository,
      configRepository: mem.configRepository,
      transitionService: mem.transitionService,
      consultarNotaPorChave: async () => {
        consultas += 1;
        return { cStat: '138' };
      },
      processarDocumento: async () => null,
      agora: () => new Date('2026-09-16T18:00:00Z')
    });
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(consultas, 0);
    assert.strictEqual(rel.consultados, 0);
  });

  await test('Motor: Matriz recupera procNFe sem contaminar filial', async () => {
    const mem = criarRepoMotor([docResumo(11, EMP.MATRIZ), docResumo(22, EMP.FILIAL2)]);
    await mem.configRepository.salvar(CHAVES.ATIVA, true);
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: mem.documentosRepository,
      historicoRepository: mem.historicoRepository,
      eventosRepository: mem.eventosRepository,
      configRepository: mem.configRepository,
      transitionService: {
        transicionar: async (id, _de, para) => {
          const cur = mem.docs.get(id);
          mem.docs.set(id, { ...cur, status: para });
        }
      },
      gate: { autorizarConsultaDistDfe: async () => ({ permitido: true }) },
      obterContextoOperacional: async (opts) => contextoPorEmpresa(opts),
      criarPersistencia: (empresaId) => ({ _empresaId: empresaId }),
      consultarNotaPorChave: async (_ch, opts) => {
        if (opts.contextoCentral.empresaId === 1) {
          const cur = mem.docs.get(11);
          mem.docs.set(11, {
            ...cur,
            status: S.XML_COMPLETO,
            tipoDocumento: DocumentoDfeTipo.PROC_NFE,
            xml: '<nfeProc/>'
          });
          return { cStat: '138', notasNovas: 0 };
        }
        return { cStat: '137', notasNovas: 0 };
      },
      processarDocumento: async () => null,
      agora: () => new Date('2026-09-16T18:00:00Z')
    });
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.strictEqual(rel.recuperados, 1);
    assert.strictEqual(mem.docs.get(11).tipoDocumento, DocumentoDfeTipo.PROC_NFE);
    assert.strictEqual(mem.docs.get(22).status, S.RESUMO_RECEBIDO);
    assert.ok(!mem.docs.get(22).xml);
  });

  await test('Manifestação/ciência usa CNPJ da Filial 2, não da Matriz', async () => {
    const documento = {
      id: 106,
      empresaId: 2,
      chave: CHAVE[2],
      status: S.RESUMO_RECEBIDO,
      tipoDocumento: DocumentoDfeTipo.RES_NFE,
      nsu: '15'
    };
    const envios = [];
    const service = new CentralManifestacaoDfeService({
      documentosRepository: {
        buscarPorId: async () => ({ ...documento })
      },
      historicoRepository: { inserir: async (d) => d },
      eventosRepository: {
        listar: async () => [],
        inserir: async (d) => d,
        inserirUnico: async (d) => ({ evento: { id: 1, ...d }, criado: true, conflito: false }),
        removerPorTipoDocumento: async () => true
      },
      nsuService: {
        buscarPorCnpjAmbiente: async () => ({ ultNsu: '15', maxNsu: '15' }),
        avaliarCooldown: () => ({ ativo: false })
      },
      configuracaoService: {
        obterPoliticaManifestacao: async () => POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA,
        obterContextoOperacional: async (opts) => contextoPorEmpresa(opts)
      },
      prepararEnvelopeAssinado: (params) => {
        envios.push({ etapa: 'envelope', cnpj: params.cnpj, cert: params.certificadoPath });
        return '<envEvento/>';
      },
      enviarManifestacao: async (params) => {
        envios.push({ etapa: 'soap', cnpj: params.cnpj, cert: params.certificadoPath });
        return {
          success: true,
          body: '<retEvento><infEvento><cStat>135</cStat><xMotivo>ok</xMotivo><nProt>1</nProt></infEvento></retEvento>',
          source: 'PLATFORM',
          fallbackUtilizado: false,
          tempoTotalMs: 5,
          statusCode: 200
        };
      },
      agora: () => new Date('2026-09-16T18:00:00Z')
    });
    const r = await service.processarDocumento(106, {
      confirmado: true,
      apenasManifestacao: true
    });
    assert.strictEqual(r.sucesso, true);
    assert.ok(envios.length >= 2);
    assert.ok(envios.every((e) => e.cnpj === CNPJ[2]));
    assert.ok(envios.every((e) => String(e.cert).includes('certificado-empresa-2.pfx')));
    assert.ok(envios.every((e) => e.cnpj !== CNPJ[1]));
  });

  await test('Regressão: DistDFe/NSU da sincronização continua passando empresaId', () => {
    const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
    assert.ok(sync.includes('obterContextoOperacional({'));
    assert.ok(sync.includes('empresaId'));
    assert.ok(sync.includes('buscarPorCnpjAmbiente'));
    const manif = src('backend/motores/central-entradas/services/CentralManifestacaoDfeService.js');
    assert.ok(manif.includes('obterContextoOperacionalDoDocumento'));
    assert.ok(manif.includes('persistenciaService'));
    const motor = src('backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js');
    assert.ok(motor.includes('obterContextoOperacionalDoDocumento'));
    assert.ok(motor.includes('persistenciaService'));
  });

  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}

main();
