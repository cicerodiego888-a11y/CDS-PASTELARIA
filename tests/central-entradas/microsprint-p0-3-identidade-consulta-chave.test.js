/**
 * Microsprint P0.3 — Barreira de identidade fiscal na consulta por chave.
 * Isolado: sem database.js oficial, sem SOAP real, sem PFX de produção.
 *
 * node --test tests/central-entradas/microsprint-p0-3-identidade-consulta-chave.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-identidade-chave-');

const fs = require('fs');
const pfxLeituras = [];
const origReadSync = fs.readFileSync.bind(fs);
fs.readFileSync = function readFileSyncGuardado(...args) {
  const alvo = String(args[0] || '');
  if (/\.pfx$/i.test(alvo) || /ProgramData[\\/]MercantilFiscal/i.test(alvo)) {
    pfxLeituras.push(alvo);
    throw new Error(`P0.3 bloqueou leitura de PFX/produção: ${alvo}`);
  }
  return origReadSync(...args);
};

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');
const sqlite3 = require('sqlite3').verbose();

const { gerarChaveAcesso } = require('../../backend/services/fiscal/utils');
const { consultarNotaPorChave } = require('../../backend/services/fiscal/distribuicaoDFe');
const { anexarAutorizacaoTesteSefaz } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
const {
  resolverIdentidadeConsultaChave,
  CODIGOS_IDENTIDADE_CONSULTA_CHAVE: COD
} = require('../../backend/services/fiscal/identidadeConsultaChave');
const CentralSincronizacaoService = require(
  '../../backend/motores/central-entradas/services/CentralSincronizacaoService'
);
const CentralNsuRepository = require(
  '../../backend/motores/central-entradas/repositories/CentralNsuRepository'
);
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { responderErroDocumentoCentral } = require(
  '../../backend/services/central-entradas/CentralEntradasEmpresaContextoService'
);

const CNPJ_MATRIZ = '38204469000115';
const CNPJ_FILIAL2 = '38204469000387';
const CNPJ_FILIAL3 = '38204469000204';
const EMP_MATRIZ = 11;
const EMP_FILIAL2 = 22;
const EMP_FILIAL3 = 33;

const IDENTIDADE_SRC = fs.readFileSync(
  path.join(__dirname, '../../backend/services/fiscal/identidadeConsultaChave.js'),
  'utf8'
);
const DFE_SRC = fs.readFileSync(
  path.join(__dirname, '../../backend/services/fiscal/distribuicaoDFe.js'),
  'utf8'
);
const SYNC_SRC = fs.readFileSync(
  path.join(__dirname, '../../backend/motores/central-entradas/services/CentralSincronizacaoService.js'),
  'utf8'
);

function chaveValida(numero = 541601) {
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

function contextoEmpresa(empresaId, extra = {}) {
  const cnpj = {
    [EMP_MATRIZ]: CNPJ_MATRIZ,
    [EMP_FILIAL2]: CNPJ_FILIAL2,
    [EMP_FILIAL3]: CNPJ_FILIAL3
  }[empresaId];
  return {
    empresaId,
    cnpj,
    ambiente: 1,
    codigoUf: '23',
    certificadoPath: `C:\\certs\\mock-empresa-${empresaId}.pfx`,
    certificadoSenha: 'mock-nao-abrir',
    modo: ModoOperacionalGlobal.MULTIEMPRESA,
    ...extra
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
    + '<dhEmi>2026-10-17T10:00:00-03:00</dhEmi></ide>'
    + '<emit><CNPJ>12345678000195</CNPJ><xNome>FORN</xNome></emit>'
    + `<dest><CNPJ>${CNPJ_MATRIZ}</CNPJ></dest>`
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
        cnpj: String(params.xmlConsulta || '').match(/<CNPJ>(\d+)<\/CNPJ>/)?.[1] || null,
        chave: String(params.xmlConsulta || '').match(/<chNFe>(\d+)<\/chNFe>/)?.[1] || null,
        tipo: /consChNFe/.test(params.xmlConsulta || '') ? 'consChNFe' : 'distNSU',
        cert: params.certificadoPath,
        ambiente: params.ambiente
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
      const documento = { id: docs.size + 1, chave, empresaId };
      docs.set(key, documento);
      return { novo: true, duplicado: false, ignorado: false, documento };
    }
  };
}

function assertIdentidade(err, codigo) {
  assert.equal(err.code, codigo);
  assert.equal(err.identidadeFiscalIncompleta, true);
  assert.equal(err.consultaExecutada, false);
  assert.equal(err.sefazConsultada, false);
  assert.equal(err.rejeicaoSefaz, false);
  assert.equal(err.pfxAberto, false);
  assert.match(String(err.message), /A SEFAZ não foi consultada/);
  assert.doesNotMatch(String(err.message), /nota não encontrada na SEFAZ/i);
  assert.doesNotMatch(String(err.message), /cStat\s*217/i);
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function criarDbNsu() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await run(db, `
    CREATE TABLE central_entradas_nsu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ambiente INTEGER NOT NULL DEFAULT 1,
      ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
      max_nsu TEXT NOT NULL DEFAULT '000000000000000',
      data_sincronizacao DATETIME,
      cooldown_ate DATETIME,
      ultimo_cstat TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ambiente)
    )
  `);
  await run(
    db,
    `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate)
     VALUES (?, 1, '000000000000101', '000000000000200', NULL)`,
    [CNPJ_MATRIZ]
  );
  return db;
}

describe('P0.3 identidade fiscal da consulta por chave', () => {
  beforeEach(() => {
    pfxLeituras.length = 0;
  });

  it('fonte: identidade não abre PFX nem chama DistDFe; consChNFe não usa getFiscalConfig direto', () => {
    assert.equal(/require\(['"]fs['"]\)/.test(IDENTIDADE_SRC), false);
    assert.equal(/require\([^)]*certificateService/.test(IDENTIDADE_SRC), false);
    assert.equal(/require\([^)]*distribuicaoDFe/.test(IDENTIDADE_SRC), false);
    assert.equal(/SoapTransport|node-forge/.test(IDENTIDADE_SRC), false);
    assert.equal(/fs\.readFileSync/.test(IDENTIDADE_SRC), false);
    const fn = DFE_SRC.slice(
      DFE_SRC.indexOf('async function consultarNotaPorChave'),
      DFE_SRC.indexOf('module.exports')
    );
    assert.match(fn, /resolverIdentidadeConsultaChave/);
    assert.equal(/await getFiscalConfig\(/.test(fn), false);
    assert.match(SYNC_SRC, /resolverIdentidadeConsultaChave/);
  });

  it('1. empresa e contexto válidos: caminho interno autorizado, SOAP mock, sem PFX', async () => {
    const soap = criarSoapSpy(xmlRetorno('137'));
    const getFiscalConfig = async () => {
      throw new Error('getFiscalConfig global não deveria ser chamado');
    };
    const r = await consultarNotaPorChave(chaveValida(), anexarAutorizacaoTesteSefaz({
      contextoCentral: contextoEmpresa(EMP_MATRIZ),
      modo: ModoOperacionalGlobal.MULTIEMPRESA,
      empresaId: EMP_MATRIZ,
      getFiscalConfig,
      enviarDistribuicaoDfe: soap.enviar,
      persistenciaService: persistenciaMem(EMP_MATRIZ)
    }));
    assert.equal(r.sucesso, true);
    assert.equal(r.cStat, '137');
    assert.equal(soap.chamadas.length, 1);
    assert.equal(soap.chamadas[0].tipo, 'consChNFe');
    assert.equal(soap.chamadas[0].cnpj, CNPJ_MATRIZ);
    assert.equal(soap.chamadas[0].cert, `C:\\certs\\mock-empresa-${EMP_MATRIZ}.pfx`);
    assert.equal(pfxLeituras.length, 0);
  });

  it('2. empresaId ausente no MULTIEMPRESA: bloqueio', async () => {
    const soap = criarSoapSpy();
    const getFiscalConfig = async () => ({ cnpj: CNPJ_FILIAL2 });
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: {
          ...contextoEmpresa(EMP_MATRIZ),
          empresaId: null
        },
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        getFiscalConfig,
        enviarDistribuicaoDfe: soap.enviar
      }),
      (err) => {
        assertIdentidade(err, COD.EMPRESA_CENTRAL_AUSENTE);
        return true;
      }
    );
    assert.equal(soap.chamadas.length, 0);
    assert.equal(pfxLeituras.length, 0);
  });

  it('3. contexto ausente no MULTIEMPRESA: bloqueio', async () => {
    const soap = criarSoapSpy();
    let fiscalCalls = 0;
    const getFiscalConfig = async () => {
      fiscalCalls += 1;
      return { cnpj: CNPJ_MATRIZ, fiscal_ambiente: 1, certificadoPath: 'x.pfx', certificadoSenha: 's' };
    };
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP_MATRIZ,
        getFiscalConfig,
        enviarDistribuicaoDfe: soap.enviar
      }),
      (err) => {
        assertIdentidade(err, COD.IDENTIDADE_FISCAL_AUSENTE);
        return true;
      }
    );
    assert.equal(fiscalCalls, 0);
    assert.equal(soap.chamadas.length, 0);
  });

  it('4. CNPJ ausente ou inconsistente: bloqueio', async () => {
    const soap = criarSoapSpy();
    const getFiscalConfig = async () => ({ cnpj: CNPJ_FILIAL2 });
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contextoEmpresa(EMP_MATRIZ, { cnpj: '' }),
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP_MATRIZ,
        getFiscalConfig,
        enviarDistribuicaoDfe: soap.enviar
      }),
      (err) => {
        assertIdentidade(err, COD.CNPJ_NAO_CONFIGURADO);
        return true;
      }
    );
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contextoEmpresa(EMP_MATRIZ),
        cnpj: CNPJ_FILIAL3,
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP_MATRIZ,
        getFiscalConfig,
        enviarDistribuicaoDfe: soap.enviar
      }),
      (err) => {
        assertIdentidade(err, COD.IDENTIDADE_FISCAL_INCONSISTENTE);
        return true;
      }
    );
    assert.equal(soap.chamadas.length, 0);
  });

  it('5. ambiente ausente ou inconsistente: bloqueio', async () => {
    const soap = criarSoapSpy();
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contextoEmpresa(EMP_MATRIZ, { ambiente: null }),
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP_MATRIZ,
        enviarDistribuicaoDfe: soap.enviar
      }),
      (err) => {
        assertIdentidade(err, COD.AMBIENTE_NAO_CONFIGURADO);
        return true;
      }
    );
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contextoEmpresa(EMP_MATRIZ, { ambiente: 1 }),
        ambiente: 2,
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP_MATRIZ,
        enviarDistribuicaoDfe: soap.enviar
      }),
      (err) => {
        assertIdentidade(err, COD.IDENTIDADE_FISCAL_INCONSISTENTE);
        return true;
      }
    );
    assert.equal(soap.chamadas.length, 0);
  });

  it('6. certificado não configurado: bloqueio sem abrir arquivo', async () => {
    const soap = criarSoapSpy();
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        contextoCentral: contextoEmpresa(EMP_MATRIZ, { certificadoPath: '', certificadoSenha: '' }),
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP_MATRIZ,
        enviarDistribuicaoDfe: soap.enviar
      }),
      (err) => {
        assertIdentidade(err, COD.CERTIFICADO);
        return true;
      }
    );
    assert.equal(pfxLeituras.length, 0);
    assert.equal(soap.chamadas.length, 0);
  });

  it('7–9. falha de identidade: getFiscalConfig, SOAP, cursor, cooldown, estoque e financeiro intactos', async () => {
    const db = await criarDbNsu();
    const repo = new CentralNsuRepository({ db });
    const antes = await get(db, 'SELECT ult_nsu, max_nsu, cooldown_ate FROM central_entradas_nsu WHERE cnpj = ?', [CNPJ_MATRIZ]);
    const soap = criarSoapSpy();
    let fiscalCalls = 0;
    let estoque = 0;
    let compras = 0;
    const getFiscalConfig = async () => {
      fiscalCalls += 1;
      return { cnpj: CNPJ_MATRIZ, fiscal_ambiente: 1, certificadoPath: 'prod.pfx', certificadoSenha: 'x' };
    };
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(), {
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: EMP_MATRIZ,
        getFiscalConfig,
        enviarDistribuicaoDfe: soap.enviar,
        nsuRepository: repo
      }),
      (err) => {
        assertIdentidade(err, COD.IDENTIDADE_FISCAL_AUSENTE);
        return true;
      }
    );
    const depois = await get(db, 'SELECT ult_nsu, max_nsu, cooldown_ate FROM central_entradas_nsu WHERE cnpj = ?', [CNPJ_MATRIZ]);
    assert.equal(fiscalCalls, 0);
    assert.equal(soap.chamadas.length, 0);
    assert.equal(pfxLeituras.length, 0);
    assert.equal(depois.ult_nsu, antes.ult_nsu);
    assert.equal(depois.max_nsu, antes.max_nsu);
    assert.equal(depois.cooldown_ate, antes.cooldown_ate);
    assert.equal(estoque, 0);
    assert.equal(compras, 0);
    db.close();
  });

  it('10. EMPRESA_SIMPLES explícito continua autorizado via getFiscalConfig, sem herança no MULTIEMPRESA', async () => {
    const soap = criarSoapSpy(xmlRetorno('137'));
    let fiscalCalls = 0;
    const getFiscalConfig = async () => {
      fiscalCalls += 1;
      return {
        cnpj: CNPJ_MATRIZ,
        fiscal_ambiente: 1,
        certificadoPath: 'C:\\certs\\simples.pfx',
        certificadoSenha: 'mock'
      };
    };
    const r = await consultarNotaPorChave(chaveValida(8), anexarAutorizacaoTesteSefaz({
      modo: ModoOperacionalGlobal.EMPRESA_SIMPLES,
      permitirConfigFiscalGlobal: true,
      empresaId: EMP_MATRIZ,
      getFiscalConfig,
      enviarDistribuicaoDfe: soap.enviar,
      persistenciaService: persistenciaMem(EMP_MATRIZ)
    }));
    assert.equal(r.sucesso, true);
    assert.equal(fiscalCalls, 1);
    assert.equal(soap.chamadas[0].cnpj, CNPJ_MATRIZ);

    fiscalCalls = 0;
    soap.chamadas.length = 0;
    await assert.rejects(
      () => consultarNotaPorChave(chaveValida(9), {
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        permitirConfigFiscalGlobal: true,
        getFiscalConfig,
        enviarDistribuicaoDfe: soap.enviar
      }),
      (err) => {
        assertIdentidade(err, COD.IDENTIDADE_FISCAL_AUSENTE);
        return true;
      }
    );
    assert.equal(fiscalCalls, 0);
    assert.equal(soap.chamadas.length, 0);
  });

  it('11. isolamento Matriz / Filial 2 / Filial 3', async () => {
    const soap = criarSoapSpy(xmlRetorno('137'));
    for (const emp of [EMP_MATRIZ, EMP_FILIAL2, EMP_FILIAL3]) {
      const r = await consultarNotaPorChave(chaveValida(emp), anexarAutorizacaoTesteSefaz({
        contextoCentral: contextoEmpresa(emp),
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        empresaId: emp,
        getFiscalConfig: async () => {
          throw new Error('fallback global');
        },
        enviarDistribuicaoDfe: soap.enviar,
        persistenciaService: persistenciaMem(emp)
      }));
      assert.equal(r.sucesso, true);
    }
    assert.equal(soap.chamadas.length, 3);
    assert.deepEqual(soap.chamadas.map((c) => c.cnpj), [CNPJ_MATRIZ, CNPJ_FILIAL2, CNPJ_FILIAL3]);
    assert.deepEqual(
      soap.chamadas.map((c) => c.cert),
      [
        `C:\\certs\\mock-empresa-${EMP_MATRIZ}.pfx`,
        `C:\\certs\\mock-empresa-${EMP_FILIAL2}.pfx`,
        `C:\\certs\\mock-empresa-${EMP_FILIAL3}.pfx`
      ]
    );
    assert.equal(pfxLeituras.length, 0);
  });

  it('12. repetição da mesma chave não duplica documento', async () => {
    const chave = chaveValida(12);
    const persistencia = persistenciaMem(EMP_MATRIZ);
    const soap = criarSoapSpy(xmlRetorno138(chave));
    const deps = anexarAutorizacaoTesteSefaz({
      contextoCentral: contextoEmpresa(EMP_MATRIZ),
      modo: ModoOperacionalGlobal.MULTIEMPRESA,
      empresaId: EMP_MATRIZ,
      enviarDistribuicaoDfe: soap.enviar,
      persistenciaService: persistencia
    });
    const a = await consultarNotaPorChave(chave, deps);
    const b = await consultarNotaPorChave(chave, deps);
    assert.equal(a.notasNovas, 1);
    assert.equal(a.notasDuplicadas, 0);
    assert.equal(b.notasNovas, 0);
    assert.equal(b.notasDuplicadas, 1);
  });

  it('buscarPorChave MULTIEMPRESA: empresaId, contexto, CNPJ, ambiente e certificado bloqueiam antes do Gate/SOAP', async () => {
    const sefaz = [];
    const fiscal = [];
    const nsuWrites = [];
    function montar(contextoFactory) {
      return new CentralSincronizacaoService({
        pularGateConsultaChave: true,
        documentosRepository: {
          buscarPorChave: async () => null
        },
        consultarNotaPorChave: async (chave, deps) => {
          sefaz.push({ chave, cnpj: deps.contextoCentral?.cnpj });
          return { cStat: '137', notasNovas: 0 };
        },
        configuracaoService: {
          obterContextoOperacional: async (opcoes) => contextoFactory(opcoes)
        }
      });
    }

    await assert.rejects(
      () => montar(() => ({ ok: true, contexto: contextoEmpresa(EMP_MATRIZ) }))
        .buscarPorChave(chaveValida(), { modo: ModoOperacionalGlobal.MULTIEMPRESA }),
      (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE' && err.consultaExecutada === false
    );

    await assert.rejects(
      () => montar(() => ({
        ok: false,
        codigoErro: 'CONFIG_FISCAL',
        mensagem: 'Contexto fiscal ausente'
      })).buscarPorChave(chaveValida(), {
        empresaId: EMP_MATRIZ,
        modo: ModoOperacionalGlobal.MULTIEMPRESA
      }),
      (err) => err.code === 'CONFIG_FISCAL' && err.consultaExecutada === false && err.rejeicaoSefaz === false
    );

    await assert.rejects(
      () => montar(() => ({
        ok: true,
        contexto: contextoEmpresa(EMP_MATRIZ, { cnpj: '' })
      })).buscarPorChave(chaveValida(), {
        empresaId: EMP_MATRIZ,
        modo: ModoOperacionalGlobal.MULTIEMPRESA
      }),
      (err) => {
        assertIdentidade(err, COD.CNPJ_NAO_CONFIGURADO);
        return true;
      }
    );

    await assert.rejects(
      () => montar(() => ({
        ok: true,
        contexto: contextoEmpresa(EMP_MATRIZ, { ambiente: undefined })
      })).buscarPorChave(chaveValida(), {
        empresaId: EMP_MATRIZ,
        modo: ModoOperacionalGlobal.MULTIEMPRESA
      }),
      (err) => {
        assertIdentidade(err, COD.AMBIENTE_NAO_CONFIGURADO);
        return true;
      }
    );

    await assert.rejects(
      () => montar(() => ({
        ok: true,
        contexto: contextoEmpresa(EMP_MATRIZ, { certificadoPath: null })
      })).buscarPorChave(chaveValida(), {
        empresaId: EMP_MATRIZ,
        modo: ModoOperacionalGlobal.MULTIEMPRESA
      }),
      (err) => {
        assertIdentidade(err, COD.CERTIFICADO);
        return true;
      }
    );

    const ok = montar(() => ({ ok: true, contexto: contextoEmpresa(EMP_FILIAL2) }));
    const r = await ok.buscarPorChave(chaveValida(22), {
      empresaId: EMP_FILIAL2,
      modo: ModoOperacionalGlobal.MULTIEMPRESA
    });
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.sefazConsultada, false);
    assert.equal(r.codigo, 'CONSULTA_SEFAZ_NAO_AUTORIZADA');
    assert.equal(sefaz.length, 0);
    assert.equal(fiscal.length, 0);
    assert.equal(nsuWrites.length, 0);
    assert.equal(pfxLeituras.length, 0);
  });

  it('erro HTTP de identidade não é “nota não encontrada na SEFAZ”', () => {
    const err = Object.assign(new Error('CNPJ da empresa não está configurado para consulta por chave. A SEFAZ não foi consultada.'), {
      code: 'CNPJ_NAO_CONFIGURADO',
      identidadeFiscalIncompleta: true
    });
    let status;
    let body;
    responderErroDocumentoCentral({
      status(code) {
        status = code;
        return {
          json(payload) {
            body = payload;
            return payload;
          }
        };
      }
    }, err);
    assert.equal(status, 400);
    assert.equal(body.code, 'CNPJ_NAO_CONFIGURADO');
    assert.equal(body.consultaExecutada, false);
    assert.equal(body.sefazConsultada, false);
    assert.equal(body.identidadeFiscalIncompleta, true);
    assert.doesNotMatch(body.error, /não encontrada na SEFAZ/i);
  });

  it('resolver: modo omitido não herda getFiscalConfig (fail-closed)', async () => {
    let fiscalCalls = 0;
    await assert.rejects(
      () => resolverIdentidadeConsultaChave({
        getFiscalConfig: async () => {
          fiscalCalls += 1;
          return { cnpj: CNPJ_MATRIZ };
        }
      }, {
        getFiscalConfig: async () => {
          fiscalCalls += 1;
          return { cnpj: CNPJ_MATRIZ };
        }
      }),
      (err) => {
        assertIdentidade(err, COD.IDENTIDADE_FISCAL_AUSENTE);
        return true;
      }
    );
    assert.equal(fiscalCalls, 0);
  });

  it('isolamento do banco: database.js oficial não foi aberto', () => {
    const aberto = isolamento.comprobarSeCarregado();
    assert.equal(pfxLeituras.length, 0);
    if (aberto) {
      assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(aberto), false);
    }
  });
});
