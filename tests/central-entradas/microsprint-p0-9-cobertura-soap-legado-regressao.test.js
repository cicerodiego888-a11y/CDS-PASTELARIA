/**
 * Microsprint P0.9 — Cobertura SOAP 210210, configuração legada e regressão.
 * Isolado: preload, banco Temp, mocks. Sem SOAP real, sem PFX, sem banco oficial.
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p09-soap-legado-');

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { OperationType } = require('../../backend/services/fiscal/core/OperationType');
const {
  createManifestacaoRuntime,
  enviarManifestacao
} = require('../../backend/services/fiscal/manifestacaoRuntime');
const { enviarManifestacaoLegado } = require('../../backend/services/fiscal/manifestacaoLegado');
const {
  consultarNotaPorChave
} = require('../../backend/services/fiscal/distribuicaoDFe');
const {
  criarAutorizacaoTesteIsolado,
  anexarAutorizacaoTesteSefaz,
  anexarAutorizacaoTesteManifestacao,
  TOKEN_TESTE_ISOLADO,
  CODIGOS_AUTORIZACAO_SEFAZ,
  TIPOS_CONSULTA_SEFAZ,
  TIPOS_MANIFESTACAO_SEFAZ,
  avaliarAutorizacaoTransmissao
} = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
const { obterMutexTransmissaoSefaz } = require('../../backend/services/fiscal/SefazTransmissaoMutex');
const MotorRecuperacaoXmlService = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService'
);
const {
  CHAVES,
  lerConfigDeMapa
} = require('../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig');
const { gerarChaveAcesso } = require('../../backend/services/fiscal/utils');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const CentralManifestacaoDfeService = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoDfeService'
);

const ROOT = path.join(__dirname, '../..');
const EMP = 11;
const CNPJ = '38204469000115';
const SOAP_OK = '<retEvento><infEvento><cStat>135</cStat><xMotivo>Evento registrado</xMotivo></infEvento></retEvento>';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function chaveValida(numero = 900900) {
  return gerarChaveAcesso({
    uf: '35',
    aamm: '2610',
    cnpj: '12345678000195',
    modelo: '55',
    serie: 1,
    numero,
    tpEmis: '1',
    cNF: 12345678
  });
}

function contexto(empresaId = EMP) {
  return {
    empresaId,
    cnpj: CNPJ,
    ambiente: 1,
    codigoUf: '23',
    certificadoPath: `C:\\certs\\mock-empresa-${empresaId}.pfx`,
    certificadoSenha: 'mock-nao-abrir',
    modo: ModoOperacionalGlobal.MULTIEMPRESA
  };
}

function criarPlataformaSpy() {
  const chamadas = [];
  return {
    chamadas,
    platform: {
      resolve: () => ({
        success: true,
        definition: {
          endpoint: 'https://example.invalid/NFeRecepcaoEvento4',
          namespace: 'nfe',
          soapAction: 'RecepcaoEvento',
          versao: '1.00'
        }
      }),
      getSoapTransport: () => ({
        getFactory: () => ({ createRequest: (r) => r }),
        send: async (req) => {
          chamadas.push(req);
          return { success: true, body: SOAP_OK, statusCode: 200, attempts: 1 };
        }
      })
    }
  };
}

function criarSoapDistSpy() {
  const chamadas = [];
  return {
    chamadas,
    enviar: async (params) => {
      chamadas.push(params);
      return {
        success: true,
        body: '<retDistDFeInt><cStat>137</cStat><xMotivo>Nenhum documento</xMotivo></retDistDFeInt>',
        statusCode: 200,
        endpoint: 'mock://sefaz'
      };
    }
  };
}

afterEach(() => {
  obterMutexTransmissaoSefaz().resetParaTeste();
});

describe('P0.9 cobertura SOAP 210210, legado e regressão', () => {
  it('1. 210210 sem autorização não chama o transporte SOAP', async () => {
    const spy = criarPlataformaSpy();
    const runtime = createManifestacaoRuntime({ platform: spy.platform });
    const r = await runtime.enviarManifestacao({
      operacao: OperationType.MANIFESTACAO_CIENCIA,
      ambiente: 2,
      empresaId: EMP,
      chave: chaveValida(),
      cnpj: CNPJ
    });
    assert.equal(spy.chamadas.length, 0);
    assert.equal(r.success, false);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.bloqueadoAutorizacao, true);
    assert.equal(r.codigo, CODIGOS_AUTORIZACAO_SEFAZ.NAO_AUTORIZADA);
  });

  it('2. GET buscar-chave e abertura da Central continuam sem SOAP implícito', async () => {
    const rota = src('backend/rotas/central-entradas.js');
    const blocoGet = rota.slice(
      rota.indexOf("router.get('/buscar-chave'"),
      rota.indexOf("router.post('/upload'")
    );
    assert.equal(/consultarNotaPorChave/.test(blocoGet), false);
    assert.equal(/enviarManifestacao/.test(blocoGet), false);

    const runtimeSrc = src('backend/services/fiscal/manifestacaoRuntime.js');
    assert.match(runtimeSrc, /exigirAutorizacaoTransmissao/);
    const legadoSrc = src('backend/services/fiscal/manifestacaoLegado.js');
    assert.match(legadoSrc, /exigirAutorizacaoTransmissao/);
  });

  it('3. Motor XML com recuperacao_xml_ativa legado true não transmite sem autorização', async () => {
    const cfg = lerConfigDeMapa({ [CHAVES.ATIVA]: true });
    assert.equal(cfg.ativa, false);
    assert.equal(cfg.valorLegadoPersistido, true);
    assert.equal(cfg.autorizaTransmissaoSefaz, false);

    const soap = criarSoapDistSpy();
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: {
        listar: async () => [{
          id: 19,
          chave: chaveValida(19),
          status: 'XML_INDISPONIVEL',
          empresaId: EMP,
          createdAt: '2026-10-01T00:00:00Z'
        }],
        buscarPorId: async (id) => ({
          id,
          chave: chaveValida(19),
          status: 'XML_INDISPONIVEL',
          empresaId: EMP
        })
      },
      historicoRepository: { inserir: async () => null },
      eventosRepository: { inserir: async () => ({ id: 1 }) },
      configRepository: {
        parseValor: (reg) => (reg && reg.tipo === 'boolean' ? reg.valor === true : reg && reg.valor),
        listarTodas: async () => [{ chave: CHAVES.ATIVA, valor: true, tipo: 'boolean' }],
        buscarPorChave: async (chave) => (chave === CHAVES.ATIVA
          ? { chave, valor: true, tipo: 'boolean' }
          : null),
        salvar: async () => null
      },
      gate: { autorizarConsultaDistDfe: async () => ({ permitido: true }) },
      obterContextoOperacional: async () => ({ ok: true, contexto: contexto(EMP) }),
      consultarNotaPorChave: (chave, deps) => consultarNotaPorChave(chave, {
        ...deps,
        enviarDistribuicaoDfe: soap.enviar
      }),
      processarDocumento: async () => null
    });
    const rel = await motor.executarCiclo({ forcar: true });
    motor.parar({ silencioso: true });
    assert.equal(soap.chamadas.length, 0);
    assert.equal(rel.itens[0].bloqueadoAutorizacao, true);
    assert.equal(rel.itens[0].consultaExecutada, false);
  });

  it('4. scheduler de manifestação não injeta autorização de produção', async () => {
    const sched = src('backend/motores/central-entradas/services/CentralManifestacaoScheduler.js');
    assert.equal(/autorizacaoTransmissaoSefaz\s*:/.test(sched), false);
    assert.equal(/criarAutorizacaoTesteIsolado/.test(sched), false);
    const bg = src('backend/motores/central-entradas/services/CentralSyncBackgroundService.js');
    assert.equal(/autorizacaoTransmissaoSefaz\s*:/.test(bg), false);
  });

  it('5. consultarNotaPorChave e enviarManifestacao falham fechados sem autorização', async () => {
    const soapDist = criarSoapDistSpy();
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contexto(EMP),
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP,
        enviarDistribuicaoDfe: soapDist.enviar
      }),
      (e) => e.bloqueadoAutorizacao === true
        && e.codigo === CODIGOS_AUTORIZACAO_SEFAZ.NAO_AUTORIZADA
        && e.consultaExecutada === false
    );
    assert.equal(soapDist.chamadas.length, 0);

    const spy = criarPlataformaSpy();
    const r = await createManifestacaoRuntime({ platform: spy.platform })
      .enviarManifestacao({
        operacao: OperationType.MANIFESTACAO_CIENCIA,
        ambiente: 2,
        empresaId: EMP
      });
    assert.equal(spy.chamadas.length, 0);
    assert.equal(r.bloqueadoAutorizacao, true);
  });

  it('6. autorização de teste exercita 210210 mockado sem rede', async () => {
    const spy = criarPlataformaSpy();
    const runtime = createManifestacaoRuntime({ platform: spy.platform });
    const r = await runtime.enviarManifestacao(anexarAutorizacaoTesteManifestacao({
      operacao: OperationType.MANIFESTACAO_CIENCIA,
      ambiente: 2,
      empresaId: EMP,
      chave: chaveValida(),
      cnpj: CNPJ
    }));
    assert.equal(spy.chamadas.length, 1);
    assert.equal(r.success, true);
    assert.notEqual(r.bloqueadoAutorizacao, true);
  });

  it('7. legado 210210 sem autorização não chama httpClient nem carrega PFX', async () => {
    let http = 0;
    const r = await enviarManifestacaoLegado({
      operacao: OperationType.MANIFESTACAO_CIENCIA,
      ambiente: 2,
      empresaId: EMP,
      certificadoPath: 'C:\\ProgramData\\MercantilFiscal\\certs\\producao.pfx',
      httpClient: async () => {
        http += 1;
        return { statusCode: 200, body: SOAP_OK };
      }
    });
    assert.equal(http, 0);
    assert.equal(r.success, false);
    assert.equal(r.bloqueadoAutorizacao, true);
    assert.equal(r.consultaExecutada, false);
  });

  it('8. KV legado e env não autorizam; DistDFe não cobre 210210', async () => {
    process.env.CDS_SEFAZ_AUTH = '1';
    process.env.RECUPERACAO_XML_ATIVA = 'true';
    const env = avaliarAutorizacaoTransmissao({
      autorizacao: process.env,
      empresaId: EMP,
      tipoConsulta: TIPOS_CONSULTA_SEFAZ.MANIFESTACAO_210210
    });
    assert.equal(env.ok, false);

    const kv = avaliarAutorizacaoTransmissao({
      autorizacao: { recuperacao_xml_ativa: true, empresaId: EMP },
      empresaId: EMP,
      tipoConsulta: '210210'
    });
    assert.equal(kv.ok, false);

    const prod = avaliarAutorizacaoTransmissao({
      autorizacao: {
        modo: 'PRODUCAO',
        token: TOKEN_TESTE_ISOLADO,
        empresaId: EMP,
        tiposConsulta: [...TIPOS_MANIFESTACAO_SEFAZ]
      },
      empresaId: EMP,
      tipoConsulta: '210210'
    });
    assert.equal(prod.ok, false);
    assert.equal(prod.codigo, CODIGOS_AUTORIZACAO_SEFAZ.PRODUCAO_INDISPONIVEL);

    const soDist = criarAutorizacaoTesteIsolado({ empresaId: EMP });
    const cruzado = avaliarAutorizacaoTransmissao({
      autorizacao: soDist,
      empresaId: EMP,
      tipoConsulta: '210210'
    });
    assert.equal(cruzado.ok, false);
    assert.equal(cruzado.codigo, CODIGOS_AUTORIZACAO_SEFAZ.TIPO_NAO_COBERTO);

    const spy = criarPlataformaSpy();
    const r = await createManifestacaoRuntime({ platform: spy.platform })
      .enviarManifestacao({
        operacao: OperationType.MANIFESTACAO_CIENCIA,
        ambiente: 2,
        empresaId: EMP,
        autorizacaoTransmissaoSefaz: soDist
      });
    assert.equal(spy.chamadas.length, 0);
    assert.equal(r.codigo, CODIGOS_AUTORIZACAO_SEFAZ.TIPO_NAO_COBERTO);
    delete process.env.CDS_SEFAZ_AUTH;
    delete process.env.RECUPERACAO_XML_ATIVA;
  });

  it('9. persistência de configuração legada não vira autorização implícita', async () => {
    assert.equal(lerConfigDeMapa({}).autorizaTransmissaoSefaz, false);
    assert.equal(lerConfigDeMapa({ [CHAVES.ATIVA]: 'true' }).autorizaTransmissaoSefaz, false);
    assert.equal(lerConfigDeMapa({ [CHAVES.ATIVA]: true }).autorizaTransmissaoSefaz, false);
    const cfgSrc = src('backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig.js');
    assert.match(cfgSrc, /recuperacao_xml_ativa|autorizaTransmissaoSefaz/);
    assert.match(cfgSrc, /false/);
    const authSrc = src('backend/services/fiscal/autorizacaoTransmissaoSefaz.js');
    assert.match(authSrc, /NÃO autoriza|não autorizada/i);
  });

  it('10. DistDFe e 210210 respeitam autorização distinta (sem implícito)', async () => {
    const soapDist = criarSoapDistSpy();
    const rDist = await consultarNotaPorChave(chaveValida(10), anexarAutorizacaoTesteSefaz({
      contextoCentral: contexto(EMP),
      modo: ModoOperacionalGlobal.MULTIEMPRESA,
      empresaId: EMP,
      persistenciaService: {
        persistirDocumentoDfe: async () => ({ novo: false }),
        _documentosRepository: { buscarPorChave: async () => null }
      },
      enviarDistribuicaoDfe: soapDist.enviar
    }));
    assert.ok(soapDist.chamadas.length >= 1);
    assert.notEqual(rDist.consultaExecutada, false);

    const spy = criarPlataformaSpy();
    const rManif = await createManifestacaoRuntime({ platform: spy.platform })
      .enviarManifestacao(anexarAutorizacaoTesteSefaz({
        operacao: OperationType.MANIFESTACAO_CIENCIA,
        ambiente: 2,
        empresaId: EMP
      }));
    assert.equal(spy.chamadas.length, 0);
    assert.equal(rManif.bloqueadoAutorizacao, true);
  });

  it('11. identidade ausente e Gate não provocam SOAP 210210', async () => {
    const spy = criarPlataformaSpy();
    const semEmpresa = await createManifestacaoRuntime({ platform: spy.platform })
      .enviarManifestacao(anexarAutorizacaoTesteManifestacao({
        operacao: OperationType.MANIFESTACAO_CIENCIA,
        ambiente: 2,
        empresaId: EMP
      }, { empresaId: EMP }));
    assert.equal(semEmpresa.success, true);

    const semId = await createManifestacaoRuntime({ platform: spy.platform })
      .enviarManifestacao({
        operacao: OperationType.MANIFESTACAO_CIENCIA,
        ambiente: 2,
        autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({
          empresaId: EMP,
          tiposConsulta: [...TIPOS_MANIFESTACAO_SEFAZ]
        })
      });
    assert.equal(spy.chamadas.length, 1, 'somente a chamada com empresaId autorizado');
    assert.equal(semId.consultaExecutada, false);
    assert.equal(semId.codigo, CODIGOS_AUTORIZACAO_SEFAZ.EMPRESA_AUSENTE);
  });

  it('12. cursor 656 e NSU não foram reabertos nesta sprint', async () => {
    const gate = src('backend/motores/central-entradas/services/CentralSefazOperationalGate.js');
    assert.match(gate, /BLOQUEADO_CONSUMO_INDEVIDO_656/);
    const nsu = src('backend/motores/central-entradas/services/CentralNsuService.js');
    assert.match(nsu, /FILA_ESGOTADA/);
    assert.equal(/nsu\s*=\s*0/.test(src('backend/services/fiscal/autorizacaoTransmissaoSefaz.js')), false);
  });

  it('13. serviço Central não transmite 210210 real sem autorização (mock de transporte)', async () => {
    const spy = criarPlataformaSpy();
    const runtime = createManifestacaoRuntime({ platform: spy.platform });
    const service = new CentralManifestacaoDfeService({
      documentosRepository: {
        buscarPorId: async () => ({
          id: 7,
          chave: chaveValida(7),
          status: 'RESUMO_RECEBIDO',
          empresaId: EMP
        })
      },
      historicoRepository: { inserir: async () => null },
      eventosRepository: {
        inserir: async () => ({ id: 1 }),
        inserirUnico: async (e) => ({ evento: e })
      },
      prepararEnvelopeAssinado: () => '<envEvento/>',
      emitirEvento: async (dados) => ({ id: 1, ...dados }),
      enviarManifestacao: (params) => runtime.enviarManifestacao(params),
      configuracaoService: {
        obterPoliticaManifestacao: async () => 'MANUAL',
        obterContextoOperacional: async () => ({ ok: true, contexto: contexto(EMP) })
      },
      gate: { autorizarConsultaDistDfe: async () => ({ permitido: true }) }
    });
    const r = await service._enviarCiencia(
      { id: 7, chave: chaveValida(7), status: 'RESUMO_RECEBIDO', empresaId: EMP },
      contexto(EMP),
      {}
    );
    assert.equal(spy.chamadas.length, 0);
    assert.equal(r.bloqueadoAutorizacao, true);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.sucesso, false);
  });

  it('14. export default enviarManifestacao também exige autorização', async () => {
    const r = await enviarManifestacao({
      operacao: OperationType.MANIFESTACAO_CIENCIA,
      ambiente: 2,
      empresaId: EMP
    });
    assert.equal(r.success, false);
    assert.equal(r.bloqueadoAutorizacao, true);
    assert.equal(r.consultaExecutada, false);
  });
});

describe('P0.9 isolamento', () => {
  it('banco de teste não é o oficial', () => {
    assert.match(isolamento.dbDir, /Temp|tmp/i);
    assert.equal(/ProgramData[\\/]+MercantilFiscal[\\/]+dados/i.test(isolamento.dbDir), false);
    assert.equal(/ProgramData[\\/]+MercantilFiscal[\\/]+dados/i.test(process.env.DB_DIR || ''), false);
  });
});
