/**
 * Microsprint P0 — CNPJ do emitente na sincronização da Central.
 * Isolado: sem SEFAZ, sem certificado de produção, sem banco oficial.
 *
 * node --test tests/central-entradas/microsprint-cnpj-emitente.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-microsprint-cnpj-emitente-');

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cnpj-emit-'));
process.env.DB_DIR = DB_DIR;
process.env.CDS_FORCAR_LOCAL = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CentralConfiguracaoService = require('../../backend/motores/central-entradas/services/CentralConfiguracaoService');
const CentralSincronizacaoService = require('../../backend/motores/central-entradas/services/CentralSincronizacaoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { validarConfigFiscal } = require('../../backend/services/fiscal/distribuicaoDFe');

const EMP_A = 11;
const EMP_B = 22;
const CNPJ_A = '11111111000191';
const CNPJ_B = '22222222000182';
const CNPJ_PONTUADO = '11.111.111/0001-91';
const CERT_PATH = path.join(DB_DIR, 'empresa.pfx');
fs.writeFileSync(CERT_PATH, 'fake-pfx');

function repoStub() {
  return {
    ensureDefaults: async () => {},
    listarTodas: async () => [],
    parseValor: (reg) => reg && reg.valor
  };
}

function criarConfig(deps = {}) {
  const svc = new CentralConfiguracaoService({
    configuracaoRepository: repoStub(),
    syncConfigService: { obterResumo: async () => ({ syncMaxDocumentos: 10 }) },
    getFiscalConfig: async () => ({
      certificadoPath: CERT_PATH,
      certificadoSenha: 'x',
      cnpj: '',
      ambiente: 2,
      codigoUf: '23',
      uf: 'CE'
    }),
    ...deps
  });
  svc._resolverEndpointDfe = () => 'https://example.invalid/NFeDistribuicaoDFe';
  return svc;
}

describe('CNPJ do emitente — contexto operacional', () => {
  it('empresa com CNPJ válido em dígitos obtém o emitente correto', async () => {
    const cfg = criarConfig({
      obterCnpjEmpresa: async ({ empresaId }) => (empresaId === EMP_A ? CNPJ_A : ''),
      obterFiscalEmpresa: async () => ({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        cnpj: '',
        ambiente: 2,
        codigoUf: '23',
        uf: 'CE'
      })
    });
    const r = await cfg.obterContextoOperacional({
      empresaId: EMP_A,
      permitirFallbackGlobal: false
    });
    assert.equal(r.ok, true);
    assert.equal(r.contexto.cnpj, CNPJ_A);
    assert.equal(r.contexto.empresaId, EMP_A);
    assert.equal(r.contexto.origemCnpj, 'empresas');
  });

  it('CNPJ pontuado no cadastro é normalizado só na validação', async () => {
    let persistido = CNPJ_PONTUADO;
    const cfg = criarConfig({
      obterCnpjEmpresa: async () => persistido,
      obterFiscalEmpresa: async () => ({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        cnpj: CNPJ_PONTUADO,
        ambiente: 2,
        codigoUf: '23',
        uf: 'CE'
      })
    });
    const r = await cfg.obterContextoOperacional({
      empresaId: EMP_A,
      permitirFallbackGlobal: false
    });
    assert.equal(r.ok, true);
    assert.equal(r.contexto.cnpj, CNPJ_A);
    assert.equal(persistido, CNPJ_PONTUADO);
  });

  it('CNPJ ausente informa a empresa e não cai no CNPJ global vazio', async () => {
    const cfg = criarConfig({
      obterCnpjEmpresa: async () => '',
      obterFiscalEmpresa: async () => ({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        cnpj: '',
        ambiente: 2,
        codigoUf: '23',
        uf: 'CE'
      })
    });
    const r = await cfg.obterContextoOperacional({
      empresaId: EMP_A,
      permitirFallbackGlobal: false
    });
    assert.equal(r.ok, false);
    assert.equal(r.codigoErro, 'CNPJ');
    assert.match(r.mensagem, /empresa 11/i);
    assert.match(r.mensagem, /cadastro da empresa/i);
  });

  it('empresaId ausente ou inválido não usa CNPJ de outra empresa', async () => {
    const cfg = criarConfig({
      obterCnpjEmpresa: async () => CNPJ_B,
      obterFiscalEmpresa: async () => ({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        cnpj: CNPJ_B,
        ambiente: 2
      })
    });
    const semId = await cfg.obterContextoOperacional({ permitirFallbackGlobal: false });
    assert.equal(semId.ok, false);
    assert.equal(semId.codigoErro, 'EMPRESA_CENTRAL_AUSENTE');

    const invalido = await cfg.obterContextoOperacional({
      empresaId: 'abc',
      permitirFallbackGlobal: false
    });
    assert.equal(invalido.ok, false);
    assert.equal(invalido.codigoErro, 'EMPRESA_CENTRAL_INVALIDA');
  });

  it('duas empresas isolam CNPJs distintos', async () => {
    const cfg = criarConfig({
      obterCnpjEmpresa: async ({ empresaId }) => (empresaId === EMP_A ? CNPJ_A : CNPJ_B),
      obterFiscalEmpresa: async ({ empresaId }) => ({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        cnpj: empresaId === EMP_A ? CNPJ_A : CNPJ_B,
        ambiente: 2,
        codigoUf: '23',
        uf: 'CE'
      })
    });
    const a = await cfg.obterContextoOperacional({ empresaId: EMP_A, permitirFallbackGlobal: false });
    const b = await cfg.obterContextoOperacional({ empresaId: EMP_B, permitirFallbackGlobal: false });
    assert.equal(a.contexto.cnpj, CNPJ_A);
    assert.equal(b.contexto.cnpj, CNPJ_B);
    assert.notEqual(a.contexto.cnpj, b.contexto.cnpj);
  });

  it('cadastro fiscal existe mas o CNPJ do sync vinha vazio: usa empresas.cnpj', async () => {
    const cfg = criarConfig({
      obterCnpjEmpresa: async () => CNPJ_A,
      obterFiscalEmpresa: async () => ({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        ambiente: 2,
        codigoUf: '23',
        uf: 'CE'
      }),
      getFiscalConfig: async () => ({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        cnpj: '',
        ambiente: 2
      })
    });
    const r = await cfg.obterContextoOperacional({
      empresaId: EMP_A,
      permitirFallbackGlobal: true
    });
    assert.equal(r.ok, true);
    assert.equal(r.contexto.cnpj, CNPJ_A);
    assert.notEqual(r.contexto.cnpj, '');
  });
});

describe('CNPJ do emitente — sincronização manual e automática', () => {
  function criarSync(captura) {
    const configuracao = criarConfig({
      obterCnpjEmpresa: async ({ empresaId }) => (Number(empresaId) === EMP_A ? CNPJ_A : CNPJ_B),
      obterFiscalEmpresa: async ({ empresaId }) => ({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        cnpj: '',
        ambiente: 2,
        codigoUf: '23',
        uf: 'CE'
      })
    });
    return new CentralSincronizacaoService({
      gate: null,
      configuracaoService: configuracao,
      nsuService: {
        buscarPorCnpjAmbiente: async () => null,
        avaliarCooldown: () => ({ ativo: false })
      },
      sincronizarDistribuicaoDFe: async (deps) => {
        captura.push({
          origem: deps.origemGate || 'distNSU',
          cnpj: deps.contextoCentral.cnpj,
          empresaId: deps.contextoCentral.empresaId
        });
        return { sucesso: true, consultaExecutada: true, notasNovas: 0, errosPersistencia: [] };
      }
    });
  }

  it('sincronização por empresa (manual) envia o CNPJ da empresa selecionada', async () => {
    const captura = [];
    const sinc = criarSync(captura);
    const r = await sinc._sincronizarEmpresa(
      { empresaId: EMP_A, cnpj: CNPJ_A },
      { modo: ModoOperacionalGlobal.MULTIEMPRESA }
    );
    assert.equal(r.sucesso, true);
    assert.equal(captura.length, 1);
    assert.equal(captura[0].cnpj, CNPJ_A);
    assert.equal(captura[0].empresaId, EMP_A);
  });

  it('sincronização automática / lote usa o mesmo CNPJ da empresa do alvo', async () => {
    const captura = [];
    const sinc = criarSync(captura);
    const r = await sinc._sincronizarEmpresa(
      { empresaId: EMP_B, cnpj: CNPJ_B },
      { modo: ModoOperacionalGlobal.MULTIEMPRESA, origem: 'background' }
    );
    assert.equal(r.codigoErro || null, null);
    assert.equal(captura[0].cnpj, CNPJ_B);
    assert.equal(captura[0].empresaId, EMP_B);
  });

  it('empresa B não herda CNPJ da empresa A no DistDFe', async () => {
    const captura = [];
    const sinc = criarSync(captura);
    await sinc._sincronizarEmpresa({ empresaId: EMP_A }, { modo: ModoOperacionalGlobal.MULTIEMPRESA });
    await sinc._sincronizarEmpresa({ empresaId: EMP_B }, { modo: ModoOperacionalGlobal.MULTIEMPRESA });
    assert.equal(captura[0].cnpj, CNPJ_A);
    assert.equal(captura[1].cnpj, CNPJ_B);
  });
});

describe('CNPJ do emitente — DistDFe', () => {
  it('validarConfigFiscal aceita CNPJ pontuado e rejeita ausente', () => {
    assert.doesNotThrow(() => validarConfigFiscal({
      certificadoPath: CERT_PATH,
      certificadoSenha: 'x',
      cnpj: CNPJ_PONTUADO
    }));
    assert.throws(
      () => validarConfigFiscal({
        certificadoPath: CERT_PATH,
        certificadoSenha: 'x',
        cnpj: ''
      }),
      /CNPJ do emitente não configurado/
    );
  });
});
