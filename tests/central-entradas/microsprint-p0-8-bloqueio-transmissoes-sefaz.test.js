/**
 * Microsprint P0.8 — Barreira central de transmissões SEFAZ.
 * Isolado: preload, banco Temp, mocks. Sem SOAP real, sem PFX, sem banco oficial.
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p08-sefaz-auth-');

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { gerarChaveAcesso } = require('../../backend/services/fiscal/utils');
const {
  consultarNotaPorChave,
  sincronizarDistribuicaoDFe
} = require('../../backend/services/fiscal/distribuicaoDFe');
const {
  criarAutorizacaoTesteIsolado,
  anexarAutorizacaoTesteSefaz,
  TOKEN_TESTE_ISOLADO,
  ESTADOS_CONSULTA_SEFAZ,
  CODIGOS_AUTORIZACAO_SEFAZ
} = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
const {
  SefazTransmissaoMutex,
  obterMutexTransmissaoSefaz
} = require('../../backend/services/fiscal/SefazTransmissaoMutex');
const CentralSincronizacaoService = require(
  '../../backend/motores/central-entradas/services/CentralSincronizacaoService'
);
const MotorRecuperacaoXmlService = require(
  '../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService'
);
const {
  CHAVES,
  DEFAULTS,
  lerConfigDeMapa
} = require('../../backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const ROOT = path.join(__dirname, '../..');
const EMP = 11;
const CNPJ = '38204469000115';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function chaveValida(numero = 800800) {
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

function xmlRetorno(cStat, extra = '') {
  return `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">`
    + `<cStat>${cStat}</cStat><xMotivo>${cStat === '137' ? 'Nenhum documento localizado' : 'Documento localizado'}</xMotivo>`
    + extra
    + '</retDistDFeInt>';
}

function xmlRetorno138(chave) {
  const xml = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
    + `<NFe><infNFe Id="NFe${chave}" versao="4.00">`
    + '<ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>1</nNF>'
    + '<dhEmi>2026-10-18T10:00:00-03:00</dhEmi></ide>'
    + '<emit><CNPJ>12345678000195</CNPJ><xNome>FORN</xNome></emit>'
    + `<dest><CNPJ>${CNPJ}</CNPJ></dest>`
    + '<total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>'
    + '</infNFe></NFe></nfeProc>';
  const zip = zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
  return xmlRetorno('138', `<loteDistDFeInt><docZip NSU="000000000000001" schema="procNFe_v4.00.xsd">${zip}</docZip></loteDistDFeInt>`);
}

function criarSoapSpy(body = xmlRetorno('137')) {
  const chamadas = [];
  return {
    chamadas,
    enviar: async (params) => {
      chamadas.push({
        xml: params.xmlConsulta || '',
        tipo: /consChNFe/.test(params.xmlConsulta || '') ? 'consChNFe' : 'distNSU'
      });
      const xml = typeof body === 'function' ? body(params) : body;
      return { success: true, body: xml, statusCode: 200, endpoint: 'mock://sefaz' };
    }
  };
}

function persistenciaMem(empresaId) {
  const docs = new Map();
  return {
    _empresaId: empresaId,
    persistirDocumentoDfe: async (dados) => {
      const chave = String(dados.xml || '').match(/NFe(\d{44})/)?.[1] || '';
      const key = `${empresaId}:${chave}`;
      if (docs.has(key)) {
        return { novo: false, duplicado: true, ignorado: false, documento: docs.get(key) };
      }
      const documento = { id: docs.size + 1, chave, empresaId, xml: dados.xml };
      docs.set(key, documento);
      return { novo: true, duplicado: false, ignorado: false, documento };
    },
    _documentosRepository: {
      buscarPorChave: async (chave, emp) => docs.get(`${emp}:${chave}`) || null
    }
  };
}

function depsConsulta(extra = {}) {
  return anexarAutorizacaoTesteSefaz({
    contextoCentral: contexto(EMP),
    modo: ModoOperacionalGlobal.MULTIEMPRESA,
    empresaId: EMP,
    persistenciaService: persistenciaMem(EMP),
    ...extra
  });
}

afterEach(() => {
  obterMutexTransmissaoSefaz().resetParaTeste();
});

describe('P0.8 barreira SOAP DistDFe/consChNFe', () => {
  it('1. GET /buscar-chave não chama SOAP', async () => {
    const rota = src('backend/rotas/central-entradas.js');
    const bloco = rota.slice(
      rota.indexOf("router.get('/buscar-chave'"),
      rota.indexOf("router.post('/upload'")
    );
    assert.match(bloco, /buscarPorChave\(chave,/);
    assert.equal(/consultarNotaPorChave/.test(bloco), false);

    const sefaz = [];
    const sync = new CentralSincronizacaoService({
      pularGateConsultaChave: true,
      documentosRepository: { buscarPorChave: async () => null },
      consultarNotaPorChave: async () => {
        sefaz.push('soap');
        throw new Error('SOAP não deveria ser chamado');
      },
      configuracaoService: {
        obterContextoOperacional: async () => ({ ok: true, contexto: contexto(EMP) })
      }
    });
    const r = await sync.buscarPorChave(chaveValida(), {
      empresaId: EMP,
      modo: ModoOperacionalGlobal.MULTIEMPRESA
    });
    assert.equal(sefaz.length, 0);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.sefazConsultada, false);
    assert.equal(r.recuperacaoConcluida, false);
    assert.equal(r.codigo, 'CONSULTA_SEFAZ_NAO_AUTORIZADA');
    assert.equal(r.estadoConsulta, ESTADOS_CONSULTA_SEFAZ.NAO_EXECUTADA);
  });

  it('2. abertura da Central / DistDFe sem autorização não chama SOAP', async () => {
    const soap = criarSoapSpy();
    const r = await sincronizarDistribuicaoDFe({
      contextoCentral: contexto(EMP),
      empresaId: EMP,
      maxIteracoes: 1,
      enviarDistribuicaoDfe: soap.enviar,
      persistenciaService: persistenciaMem(EMP),
      nsuService: {
        obterOuCriar: async () => ({ ultNsu: '0', maxNsu: '0' }),
        avaliarCooldown: () => ({ ativo: false }),
        aplicarRetornoDistDfe: async () => {
          throw new Error('NSU não deveria avançar');
        }
      },
      auditoriaService: {
        registrar: async () => null,
        registrarConsulta: async () => null,
        registrarResumoSync: async () => null,
        registrarNsuAvanco: async () => null
      }
    });
    assert.equal(soap.chamadas.length, 0);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.sucesso, false);
    assert.equal(r.codigo, CODIGOS_AUTORIZACAO_SEFAZ.NAO_AUTORIZADA);

    const orch = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
    assert.match(orch, /async sincronizarAoAbrir/);
    assert.match(orch, /origem: ORIGENS\.ABRIR_CENTRAL/);
  });

  it('3. Motor XML inicia desativado sem configuração explícita', async () => {
    assert.equal(DEFAULTS.ativa, false);
    assert.equal(lerConfigDeMapa({}).ativa, false);
    assert.equal(lerConfigDeMapa({ [CHAVES.ATIVA]: 'false' }).ativa, false);
    assert.equal(lerConfigDeMapa({ [CHAVES.ATIVA]: 'talvez' }).ativa, false);
    assert.equal(lerConfigDeMapa({ [CHAVES.ATIVA]: 1 }).ativa, false);
    assert.equal(lerConfigDeMapa({ [CHAVES.ATIVA]: true }).ativa, false);
    assert.equal(lerConfigDeMapa({ [CHAVES.ATIVA]: true }).valorLegadoPersistido, true);

    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: { listar: async () => [] },
      historicoRepository: { inserir: async () => null },
      eventosRepository: { inserir: async () => null },
      configRepository: {
        parseValor: (reg) => reg && reg.valor,
        listarTodas: async () => [],
        buscarPorChave: async () => null,
        salvar: async () => null,
        ensureDefaults: async () => null
      },
      consultarNotaPorChave: async () => {
        throw new Error('SOAP do motor não deveria executar');
      }
    });
    const r = await motor.iniciar({ delayMs: 60000, forcar: true });
    assert.equal(r.iniciado, false);
    assert.equal(motor.estaAtivo(), false);
    motor.parar({ silencioso: true });
  });

  it('4. scheduler não contorna a autorização', async () => {
    const soap = criarSoapSpy();
    const motor = new MotorRecuperacaoXmlService({
      documentosRepository: {
        listar: async () => [{
          id: 9,
          chave: chaveValida(9),
          status: 'XML_INDISPONIVEL',
          empresaId: EMP,
          createdAt: '2026-10-01T00:00:00Z'
        }],
        buscarPorId: async (id) => ({
          id,
          chave: chaveValida(9),
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
    assert.ok(rel.consultados === 0 || rel.falhas >= 1 || rel.ignorado || Array.isArray(rel.itens));
  });

  it('5. consultarNotaPorChave falha fechada sem autorização', async () => {
    const soap = criarSoapSpy();
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contexto(EMP),
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP,
        enviarDistribuicaoDfe: soap.enviar,
        persistenciaService: persistenciaMem(EMP)
      }),
      (err) => err.code === CODIGOS_AUTORIZACAO_SEFAZ.NAO_AUTORIZADA && err.consultaExecutada === false
    );
    assert.equal(soap.chamadas.length, 0);
  });

  it('6. autorização de teste exercita o caminho mockado sem rede', async () => {
    const soap = criarSoapSpy(xmlRetorno('137'));
    const r = await consultarNotaPorChave(chaveValida(), depsConsulta({
      enviarDistribuicaoDfe: soap.enviar
    }));
    assert.equal(soap.chamadas.length, 1);
    assert.equal(soap.chamadas[0].tipo, 'consChNFe');
    assert.equal(r.consultaExecutada, true);
    assert.equal(r.estadoConsulta, ESTADOS_CONSULTA_SEFAZ.SEM_DOCUMENTO);
    assert.equal(r.recuperacaoConcluida, false);
    assert.equal(r.sucesso, true);
    assert.equal(TOKEN_TESTE_ISOLADO.startsWith('CDS_SEFAZ_AUTH_TESTE_ISOLADO'), true);
  });

  it('não aceita env, KV nem modo produção como autorização', async () => {
    process.env.CDS_AUTORIZAR_CONSULTA_CHAVE = '1';
    process.env.CDS_SEFAZ_AUTH = TOKEN_TESTE_ISOLADO;
    const soap = criarSoapSpy();
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contexto(EMP),
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP,
        autorizacaoTransmissaoSefaz: {
          modo: 'PRODUCAO',
          token: TOKEN_TESTE_ISOLADO,
          empresaId: EMP,
          tiposConsulta: ['consChNFe']
        },
        enviarDistribuicaoDfe: soap.enviar,
        persistenciaService: persistenciaMem(EMP)
      }),
      (err) => err.code === CODIGOS_AUTORIZACAO_SEFAZ.PRODUCAO_INDISPONIVEL
    );
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contexto(EMP),
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP,
        autorizacaoTransmissaoSefaz: { recuperacao_xml_ativa: true, empresaId: EMP },
        enviarDistribuicaoDfe: soap.enviar,
        persistenciaService: persistenciaMem(EMP)
      }),
      (err) => err.consultaExecutada === false
    );
    delete process.env.CDS_AUTORIZAR_CONSULTA_CHAVE;
    delete process.env.CDS_SEFAZ_AUTH;
    assert.equal(soap.chamadas.length, 0);
  });

  it('7. falha de persistência impede sucesso de recuperação', async () => {
    const chave = chaveValida(71);
    const soap = criarSoapSpy(xmlRetorno138(chave));
    const persist = {
      _empresaId: EMP,
      persistirDocumentoDfe: async () => {
        const err = new Error('SQLITE_BUSY simulado');
        err.code = 'SQLITE_BUSY';
        throw err;
      },
      _documentosRepository: { buscarPorChave: async () => null }
    };
    const r = await consultarNotaPorChave(chave, depsConsulta({
      enviarDistribuicaoDfe: soap.enviar,
      persistenciaService: persist
    }));
    assert.equal(r.consultaExecutada, true);
    assert.equal(r.respostaRecebida, true);
    assert.equal(r.sucesso, false);
    assert.equal(r.recuperacaoConcluida, false);
    assert.equal(r.persistenciaCompleta, false);
    assert.equal(r.estadoConsulta, ESTADOS_CONSULTA_SEFAZ.PERSISTENCIA_PENDENTE);
    assert.equal(r.codigo, 'PERSISTENCIA_DFE_INCOMPLETA');
    assert.equal(r.errosPersistencia[0].chave, chave);
  });

  it('8. persistência durável com identidade correta conclui a recuperação', async () => {
    const chave = chaveValida(81);
    const persist = persistenciaMem(EMP);
    const soap = criarSoapSpy(xmlRetorno138(chave));
    const r = await consultarNotaPorChave(chave, depsConsulta({
      enviarDistribuicaoDfe: soap.enviar,
      persistenciaService: persist
    }));
    assert.equal(r.sucesso, true);
    assert.equal(r.recuperacaoConcluida, true);
    assert.equal(r.persistenciaCompleta, true);
    assert.equal(r.estadoConsulta, ESTADOS_CONSULTA_SEFAZ.RECUPERACAO_CONCLUIDA);
    assert.equal(r.empresaId, EMP);
    assert.equal(r.xmlPersistido, true);
    const local = await persist._documentosRepository.buscarPorChave(chave, EMP);
    assert.equal(local.empresaId, EMP);
    assert.ok(String(local.xml).includes(chave));
  });

  it('9. repetição não duplica documentos', async () => {
    const chave = chaveValida(91);
    const persist = persistenciaMem(EMP);
    const soap = criarSoapSpy(xmlRetorno138(chave));
    const deps = depsConsulta({
      enviarDistribuicaoDfe: soap.enviar,
      persistenciaService: persist
    });
    const a = await consultarNotaPorChave(chave, deps);
    const b = await consultarNotaPorChave(chave, deps);
    assert.equal(a.notasNovas, 1);
    assert.equal(b.notasNovas, 0);
    assert.equal(b.notasDuplicadas, 1);
    assert.equal(a.recuperacaoConcluida, true);
    assert.equal(b.recuperacaoConcluida, true);
  });

  it('10. DistDFe e consChNFe respeitam o mutex compartilhado', async () => {
    const mutex = new SefazTransmissaoMutex();
    let liberar;
    const espera = new Promise((resolve) => {
      liberar = resolve;
    });
    const soapDist = criarSoapSpy(xmlRetorno('137'));
    const pDist = sincronizarDistribuicaoDFe(anexarAutorizacaoTesteSefaz({
      contextoCentral: contexto(EMP),
      empresaId: EMP,
      maxIteracoes: 1,
      mutexTransmissaoSefaz: mutex,
      enviarDistribuicaoDfe: async () => {
        await espera;
        return soapDist.enviar({ xmlConsulta: '<distNSU/>' });
      },
      persistenciaService: persistenciaMem(EMP),
      nsuService: {
        obterOuCriar: async () => ({ ultNsu: '0', maxNsu: '0' }),
        avaliarCooldown: () => ({ ativo: false }),
        aplicarRetornoDistDfe: async (p) => ({ controle: p.controle, ultNsu: p.ultNsu, maxNsu: p.maxNsu })
      },
      auditoriaService: {
        registrar: async () => null,
        registrarConsulta: async () => null,
        registrarResumoSync: async () => null,
        registrarNsuAvanco: async () => null
      }
    }));

    for (let i = 0; i < 40 && !mutex.estaOcupado(); i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(mutex.estaOcupado(), true);
    const soapCons = criarSoapSpy();
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(10), depsConsulta({
        mutexTransmissaoSefaz: mutex,
        enviarDistribuicaoDfe: soapCons.enviar
      })),
      (err) => err.code === 'TRANSMISSAO_SEFAZ_EM_ANDAMENTO' && err.consultaExecutada === false
    );
    assert.equal(soapCons.chamadas.length, 0);
    liberar();
    const dist = await pDist;
    assert.equal(dist.consultaExecutada, true);

    const a = mutex.comLock('distNSU', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: 1 };
    });
    const b = await mutex.comLock('consChNFe', async () => ({ ok: 2 }));
    assert.equal(b.ok, false);
    assert.equal(b.consultaExecutada, false);
    assert.equal(b.codigo, 'TRANSMISSAO_SEFAZ_EM_ANDAMENTO');
    await a;
  });

  it('11. identidade e Gate não provocam SOAP', async () => {
    const soap = criarSoapSpy();
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        enviarDistribuicaoDfe: soap.enviar,
        autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP, tipoConsulta: 'consChNFe' })
      }),
      (err) => err.consultaExecutada === false
    );
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), depsConsulta({
        enviarDistribuicaoDfe: soap.enviar,
        gateSefaz: {
          autorizarConsultaDistDfe: async () => ({
            permitido: false,
            codigo: 'GATE_BLOQUEADO',
            mensagem: 'Gate recusou'
          })
        }
      })),
      (err) => err.bloqueadoGate === true && err.consultaExecutada === false
    );
    assert.equal(soap.chamadas.length, 0);
  });

  it('12. cursor 656 / NSU: barreira não rebobina e GET não toca NSU', () => {
    const dfe = src('backend/services/fiscal/distribuicaoDFe.js');
    const nsu = src('backend/motores/central-entradas/services/CentralNsuService.js');
    assert.match(dfe, /exigirAutorizacaoTransmissao/);
    assert.match(dfe, /cStat\) === '656'/);
    assert.match(nsu, /CONSUMO_INDEVIDO|656/);
    const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
    const fn = sync.slice(sync.indexOf('async buscarPorChave'), sync.lastIndexOf('module.exports'));
    assert.equal(/this\._consultarNotaPorChave/.test(fn), false);
  });
});
