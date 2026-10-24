/**
 * Microsprint P0.10 — contenção SQLite, barreira de cancelamento 110111 e ciência.
 * Isolado: preload, banco Temp, mocks. Sem SOAP real, sem PFX, sem banco oficial.
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p010-incidente-');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { OperationType } = require('../../backend/services/fiscal/core/OperationType');
const { ModelType } = require('../../backend/services/fiscal/core/ModelType');
const {
  FiscalWebServices
} = require('../../backend/services/fiscal/core/FiscalWebServices');
const {
  createCancelamentoRuntime,
  CancelamentoMetrics
} = require('../../backend/services/fiscal/cancelamentoRuntime');
const { enviarCancelamentoLegado } = require('../../backend/services/fiscal/cancelamentoLegado');
const {
  criarAutorizacaoTesteIsolado,
  anexarAutorizacaoTesteCancelamento,
  CODIGOS_AUTORIZACAO_SEFAZ,
  TIPOS_CONSULTA_SEFAZ,
  avaliarAutorizacaoTransmissao
} = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
const MotorRecuperacaoXmlService = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService'
);
const {
  CHAVES,
  lerConfigDeMapa
} = require('../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig');
const CentralManifestacaoDfeService = require(
  '../../backend/motores/central-entradas/services/CentralManifestacaoDfeService'
);
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { gerarChaveAcesso } = require('../../backend/services/fiscal/utils');

const ROOT = path.join(__dirname, '../..');
const EMP = 11;
const SOAP_OK = '<retEvento><infEvento><cStat>135</cStat><xMotivo>Evento registrado</xMotivo></infEvento></retEvento>';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function chaveValida(numero = 900910) {
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
    cnpj: '38204469000115',
    ambiente: 2,
    codigoUf: '23',
    certificadoPath: `C:\\certs\\mock-empresa-${empresaId}.pfx`,
    certificadoSenha: 'mock-nao-abrir'
  };
}

function criarServicoCiencia({ enviarManifestacao, prepararEnvelopeAssinado } = {}) {
  const eventos = [];
  const historico = [];
  const service = new CentralManifestacaoDfeService({
    documentosRepository: {
      buscarPorId: async () => ({
        id: 21,
        chave: chaveValida(21),
        status: 'RESUMO_RECEBIDO',
        empresaId: EMP
      })
    },
    historicoRepository: {
      inserir: async (h) => {
        historico.push(h);
        return h;
      },
      listarPorDocumento: async () => historico
    },
    eventosRepository: {
      inserir: async (e) => {
        eventos.push(e);
        return { id: eventos.length, ...e };
      },
      inserirUnico: async (e) => {
        eventos.push(e);
        return { evento: e };
      }
    },
    emitirEvento: async (dados) => {
      const ev = { id: eventos.length + 1, ...dados };
      eventos.push(ev);
      return ev;
    },
    prepararEnvelopeAssinado: prepararEnvelopeAssinado || (() => '<envEvento/>'),
    enviarManifestacao,
    configuracaoService: {
      obterPoliticaManifestacao: async () => 'MANUAL',
      obterContextoOperacional: async () => ({ ok: true, contexto: contexto(EMP) })
    },
    gate: { autorizarConsultaDistDfe: async () => ({ permitido: true }) }
  });
  return { service, eventos, historico };
}

describe('P0.10 contenção SQLite, cancelamento e ciência', () => {
  it('1. incidente: comando e cadeia de imports comprovados no fonte', () => {
    const relatorioP09 = src('docs/central-entradas/microsprint-p0-9-cobertura-soap-legado-regressao-relatorio.md');
    assert.match(relatorioP09, /fiscal-manifestacao-runtime\.test\.js/);
    assert.match(relatorioP09, /ProgramData\\MercantilFiscal\\dados\\mercadao\.db/);

    const telemetria = src('backend/services/fiscal/core/FiscalSoapTelemetryConfig.js');
    assert.match(telemetria, /require\.cache\[resolved\]/);
    assert.match(telemetria, /CDS_FORCAR_LOCAL/);
    assert.match(telemetria, /require\('\.\.\/\.\.\/\.\.\/database'\)/);

    const soapTransport = src('backend/services/fiscal/core/SoapTransport.js');
    assert.match(soapTransport, /fiscalSoapTelemetry/);
    const fiscalTelemetry = src('backend/services/fiscal/core/FiscalSoapTelemetry.js');
    assert.match(fiscalTelemetry, /isLogDetalhadoAtivo/);
    assert.match(fiscalTelemetry, /FiscalSoapTelemetryConfig/);
  });

  it('2. telemetria SOAP não faz boot do banco só para ler flags', () => {
    const telemetria = src('backend/services/fiscal/core/FiscalSoapTelemetryConfig.js');
    assert.match(telemetria, /if \(!require\.cache\[resolved\]\)/);
    assert.match(telemetria, /CDS_FORCAR_LOCAL === '1'/);
    const { getFiscalConfigSyncFlags } = require('../../backend/services/fiscal/core/FiscalSoapTelemetryConfig');
    const flags = getFiscalConfigSyncFlags();
    assert.equal(typeof flags.logDetalhado, 'boolean');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
  });

  it('3. cancelamento 110111 sem autorização não chama transporte nem PFX', async () => {
    let send = 0;
    const runtime = createCancelamentoRuntime({
      platform: new FiscalWebServices({
        transportOptions: {
          httpClient: async () => {
            send += 1;
            return { statusCode: 200, body: SOAP_OK };
          }
        }
      }),
      metrics: new CancelamentoMetrics()
    });
    const r = await runtime.enviarCancelamento({
      chave: chaveValida(),
      ambiente: 2,
      empresaId: EMP,
      modelo: ModelType.NFCE,
      certificadoPath: 'C:\\ProgramData\\MercantilFiscal\\certs\\producao.pfx'
    });
    assert.equal(send, 0);
    assert.equal(r.success, false);
    assert.equal(r.bloqueadoAutorizacao, true);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.transmissionState, 'NOT_SENT');
  });

  it('4. DistDFe não cobre cancelamento 110111; produção não autoriza', () => {
    const soDist = criarAutorizacaoTesteIsolado({
      empresaId: EMP,
      tiposConsulta: [TIPOS_CONSULTA_SEFAZ.DIST_NSU, TIPOS_CONSULTA_SEFAZ.CONS_CH_NFE]
    });
    const cruzado = avaliarAutorizacaoTransmissao({
      autorizacao: soDist,
      empresaId: EMP,
      tipoConsulta: TIPOS_CONSULTA_SEFAZ.CANCELAMENTO_110111
    });
    assert.equal(cruzado.ok, false);
    assert.equal(cruzado.codigo, CODIGOS_AUTORIZACAO_SEFAZ.TIPO_NAO_COBERTO);

    const prod = avaliarAutorizacaoTransmissao({
      autorizacao: { modo: 'PRODUCAO', token: 'x', empresaId: EMP, tiposConsulta: ['110111'] },
      empresaId: EMP,
      tipoConsulta: '110111'
    });
    assert.equal(prod.ok, false);
    assert.equal(prod.codigo, CODIGOS_AUTORIZACAO_SEFAZ.PRODUCAO_INDISPONIVEL);
  });

  it('5. legado de cancelamento sem autorização não chama httpClient', async () => {
    let http = 0;
    const r = await enviarCancelamentoLegado({
      ambiente: 2,
      empresaId: EMP,
      certificadoPath: 'C:\\ProgramData\\MercantilFiscal\\certs\\producao.pfx',
      httpClient: async () => {
        http += 1;
        return { statusCode: 200, body: SOAP_OK };
      }
    });
    assert.equal(http, 0);
    assert.equal(r.bloqueadoAutorizacao, true);
    assert.equal(r.consultaExecutada, false);
  });

  it('6. autorização de teste exercita cancelamento mockado sem rede', async () => {
    let send = 0;
    const runtime = createCancelamentoRuntime({
      platform: new FiscalWebServices({
        transportOptions: {
          httpClient: async () => {
            send += 1;
            return { statusCode: 200, body: SOAP_OK };
          }
        }
      }),
      metrics: new CancelamentoMetrics()
    });
    const r = await runtime.enviarCancelamento(anexarAutorizacaoTesteCancelamento({
      chave: chaveValida(),
      ambiente: 2,
      empresaId: EMP,
      modelo: ModelType.NFCE
    }));
    assert.equal(send, 1);
    assert.equal(r.success, true);
    assert.notEqual(r.bloqueadoAutorizacao, true);
  });

  it('7. falha antes do SOAP não grava CIENCIA_ENVIADA', async () => {
    const { service, eventos } = criarServicoCiencia({
      prepararEnvelopeAssinado: () => {
        throw new Error('envelope indisponível');
      },
      enviarManifestacao: async () => {
        throw new Error('SOAP não deveria ser chamado');
      }
    });
    const r = await service._enviarCiencia(
      { id: 21, chave: chaveValida(21), status: 'RESUMO_RECEBIDO', empresaId: EMP },
      contexto(EMP),
      {}
    );
    assert.equal(r.sucesso, false);
    assert.equal(r.transmissaoExecutada, false);
    const tipos = eventos.map((e) => e.tipo);
    assert.equal(tipos.includes(TIPOS_EVENTO.CIENCIA_SOLICITADA), true);
    assert.equal(tipos.includes(TIPOS_EVENTO.CIENCIA_ENVIADA), false);
    assert.equal(tipos.includes(TIPOS_EVENTO.MANIFESTACAO_ACEITA), false);
  });

  it('8. bloqueio de autorização 210210 não grava CIENCIA_ENVIADA', async () => {
    let soap = 0;
    const { service, eventos } = criarServicoCiencia({
      enviarManifestacao: async () => {
        soap += 1;
        return {
          success: false,
          bloqueadoAutorizacao: true,
          consultaExecutada: false,
          codigo: CODIGOS_AUTORIZACAO_SEFAZ.NAO_AUTORIZADA
        };
      }
    });
    const r = await service._enviarCiencia(
      { id: 21, chave: chaveValida(21), status: 'RESUMO_RECEBIDO', empresaId: EMP },
      contexto(EMP),
      {}
    );
    assert.equal(soap, 1);
    assert.equal(r.bloqueadoAutorizacao, true);
    const tipos = eventos.map((e) => e.tipo);
    assert.equal(tipos.includes(TIPOS_EVENTO.CIENCIA_SOLICITADA), true);
    assert.equal(tipos.includes(TIPOS_EVENTO.CIENCIA_ENVIADA), false);
  });

  it('9. falha de transporte após o envio registra CIENCIA_ENVIADA sem aceite', async () => {
    const { service, eventos } = criarServicoCiencia({
      enviarManifestacao: async () => {
        const err = new Error('ECONNRESET mock');
        err.consultaExecutada = true;
        err.transmissaoExecutada = true;
        throw err;
      }
    });
    const r = await service._enviarCiencia(
      { id: 21, chave: chaveValida(21), status: 'RESUMO_RECEBIDO', empresaId: EMP },
      contexto(EMP),
      {}
    );
    assert.equal(r.sucesso, false);
    const tipos = eventos.map((e) => e.tipo);
    assert.equal(tipos.includes(TIPOS_EVENTO.CIENCIA_SOLICITADA), true);
    assert.equal(tipos.includes(TIPOS_EVENTO.CIENCIA_ENVIADA), true);
    assert.equal(tipos.includes(TIPOS_EVENTO.MANIFESTACAO_ACEITA), false);
    const enviada = eventos.find((e) => e.tipo === TIPOS_EVENTO.CIENCIA_ENVIADA);
    assert.equal(enviada.resultado, 'FALHA_TRANSPORTE');
    assert.equal(enviada.detalhe.transmissaoExecutada, true);
  });

  it('10. resposta de sucesso confirma CIENCIA_ENVIADA e MANIFESTACAO_ACEITA', async () => {
    const { service, eventos } = criarServicoCiencia({
      enviarManifestacao: async () => ({
        success: true,
        body: SOAP_OK,
        source: 'PLATFORM',
        fallbackUtilizado: false,
        statusCode: 200,
        tempoTotalMs: 4,
        cStat: '135'
      })
    });
    const r = await service._enviarCiencia(
      { id: 21, chave: chaveValida(21), status: 'RESUMO_RECEBIDO', empresaId: EMP },
      contexto(EMP),
      { autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({
        empresaId: EMP,
        tiposConsulta: ['210210']
      }) }
    );
    assert.equal(r.sucesso, true);
    const tipos = eventos.map((e) => e.tipo);
    assert.equal(tipos.includes(TIPOS_EVENTO.CIENCIA_SOLICITADA), true);
    assert.equal(tipos.includes(TIPOS_EVENTO.CIENCIA_ENVIADA), true);
    assert.equal(tipos.includes(TIPOS_EVENTO.MANIFESTACAO_ACEITA), true);
    const enviada = eventos.find((e) => e.tipo === TIPOS_EVENTO.CIENCIA_ENVIADA);
    assert.equal(enviada.detalhe.transmissaoExecutada, true);
    assert.equal(enviada.detalhe.respostaRecebida, true);
  });

  it('11. motor XML legado true não inicia scheduler nem ciclo involuntário', async () => {
    const cfg = lerConfigDeMapa({ [CHAVES.ATIVA]: true });
    assert.equal(cfg.ativa, false);
    assert.equal(cfg.valorLegadoPersistido, true);
    assert.equal(cfg.autorizaTransmissaoSefaz, false);

    let consultou = 0;
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: {
        listar: async () => [{
          id: 21,
          chave: chaveValida(21),
          status: 'XML_INDISPONIVEL',
          empresaId: EMP,
          createdAt: '2026-10-01T00:00:00Z'
        }],
        buscarPorId: async (id) => ({ id, chave: chaveValida(21), status: 'XML_INDISPONIVEL', empresaId: EMP })
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
      consultarNotaPorChave: async () => {
        consultou += 1;
        return { cStat: '137' };
      }
    });
    const boot = await motor.iniciar({ delayMs: 60000 });
    assert.equal(boot.iniciado, false);
    assert.equal(boot.motivo, 'legado_nao_autoriza_ciclo');
    assert.equal(motor.estaAtivo(), false);

    const ciclo = await motor.executarCiclo();
    motor.parar({ silencioso: true });
    assert.equal(ciclo.ignorado, true);
    assert.equal(ciclo.motivo, 'desativado');
    assert.equal(consultou, 0);
  });

  it('12. rotas de cancelamento NFC-e passam pelo runtime barrado', () => {
    const fiscal = src('backend/rotas/fiscal.js');
    assert.match(fiscal, /cancelarNfce/);
    const venda = src('backend/services/vendas/VendaCancelamentoService.js');
    assert.match(venda, /cancelarNfceAutorizadaVenda/);
    const runtime = src('backend/services/fiscal/cancelamentoRuntime.js');
    assert.match(runtime, /exigirAutorizacaoTransmissao/);
    const legado = src('backend/services/fiscal/cancelamentoLegado.js');
    assert.match(legado, /exigirAutorizacaoTransmissao/);
    const nfce = src('backend/services/fiscal/cancelarNfce.js');
    assert.match(nfce, /autorizacaoTransmissaoSefaz/);
    assert.equal(/criarAutorizacaoTesteIsolado/.test(nfce), false);
  });

  it('13. política MANUAL/AUTOMATICA e scheduler de manifestação inalterados no envio', () => {
    const svc = src('backend/motores/central-entradas/services/CentralManifestacaoDfeService.js');
    assert.match(svc, /POLITICAS_MANIFESTACAO/);
    assert.match(svc, /AUTOMATICA_CIENCIA/);
    const sched = src('backend/motores/central-entradas/services/CentralManifestacaoScheduler.js');
    assert.equal(/autorizacaoTransmissaoSefaz\s*:/.test(sched), false);
    assert.equal(/criarAutorizacaoTesteIsolado/.test(sched), false);
  });
});

describe('P0.10 isolamento', () => {
  it('banco desta suíte, se carregado, não é o oficial', () => {
    assert.match(isolamento.dbDir, /Temp|tmp/i);
    assert.equal(/ProgramData[\\/]+MercantilFiscal[\\/]+dados/i.test(isolamento.dbDir), false);
    assert.equal(/ProgramData[\\/]+MercantilFiscal[\\/]+dados/i.test(process.env.DB_DIR || ''), false);
    const aberto = isolamento.comprobarSeCarregado();
    if (aberto) {
      assert.equal(/ProgramData[\\/]+MercantilFiscal[\\/]+dados/i.test(aberto), false);
      assert.ok(String(aberto).toLowerCase().includes(isolamento.dbDir.toLowerCase())
        || String(aberto).includes('Temp')
        || String(aberto).includes('tmp'));
    }
  });
});
