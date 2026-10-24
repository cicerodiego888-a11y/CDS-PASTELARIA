/**
 * Microsprint P0.8 — Ativação controlada da operação fiscal real (DistDFe).
 * Isolado: preload, mocks. Sem SOAP real, sem PFX real, sem banco oficial, sem NSU de produção.
 */
'use strict';

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p08-op-real-');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  MODO_OPERACAO_REAL,
  TIPOS_CONSULTA_SEFAZ,
  TIPOS_CONSULTA_DFE_SEFAZ,
  criarAutorizacaoOperacaoReal,
  criarAutorizacaoTesteIsolado,
  avaliarAutorizacaoTransmissao,
  CODIGOS_AUTORIZACAO_SEFAZ
} = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
const CentralOperacaoFiscalRealService = require(
  '../../backend/motores/central-entradas/services/CentralOperacaoFiscalRealService'
);

const ROOT = path.join(__dirname, '../..');
const EMP = 42;
const CNPJ = '38204469000115';
const SEED = 'seed-teste-isolado-p08-op-real';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function memConfigRepo() {
  const mapa = new Map();
  return {
    async buscarPorChave(chave) {
      if (!mapa.has(chave)) return null;
      return { chave, valor: JSON.stringify(mapa.get(chave)), tipo: 'json' };
    },
    parseValor(reg) {
      if (!reg) return null;
      return JSON.parse(reg.valor);
    },
    async salvar(chave, dados) {
      mapa.set(chave, dados);
      return dados;
    },
    _mapa: mapa
  };
}

function svcBase(overrides = {}) {
  const configRepository = overrides.configRepository || memConfigRepo();
  return new CentralOperacaoFiscalRealService({
    configRepository,
    exigirCertificadoAptoParaUsoFiscal: async () => ({ apto: true }),
    configuracaoService: {
      obterContextoOperacional: async () => ({
        ok: true,
        contexto: {
          empresaId: EMP,
          cnpj: CNPJ,
          ambiente: 1,
          nomeEmpresa: 'EMPRESA TESTE'
        }
      })
    },
    nsuService: {
      buscarPorCnpjAmbiente: async () => ({
        ultNsu: '000000000000010',
        maxNsu: '000000000000010'
      }),
      avaliarCooldown: () => ({ ativo: false })
    },
    ...overrides
  });
}

describe('P0.8 ativação controlada operação fiscal real', () => {
  it('1. isolamento ativo (sem banco oficial)', () => {
    assert.ok(isolamento);
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
  });

  it('2. OPERACAO_REAL autoriza DistDFe e rejeita 210210', () => {
    const auth = criarAutorizacaoOperacaoReal({
      empresaId: EMP,
      cnpj: CNPJ,
      tokenSeed: SEED,
      tiposConsulta: [...TIPOS_CONSULTA_DFE_SEFAZ],
      confirmacaoConsultaReal: true,
      confirmacaoAmbienteProducao: true
    });
    assert.equal(auth.modo, MODO_OPERACAO_REAL);
    assert.equal(auth.producao, true);
    assert.equal(auth.tiposConsulta.includes(TIPOS_CONSULTA_SEFAZ.MANIFESTACAO_210210), false);

    const okDist = avaliarAutorizacaoTransmissao({
      autorizacao: auth,
      empresaId: EMP,
      tipoConsulta: TIPOS_CONSULTA_SEFAZ.DIST_NSU
    });
    assert.equal(okDist.ok, true);

    const negManif = avaliarAutorizacaoTransmissao({
      autorizacao: auth,
      empresaId: EMP,
      tipoConsulta: TIPOS_CONSULTA_SEFAZ.MANIFESTACAO_210210
    });
    assert.equal(negManif.ok, false);
    assert.equal(negManif.codigo, CODIGOS_AUTORIZACAO_SEFAZ.TIPO_NAO_COBERTO);
  });

  it('3. flags soltas de produção sem OPERACAO_REAL continuam bloqueadas', () => {
    const r = avaliarAutorizacaoTransmissao({
      autorizacao: { producao: true, operacional: true, empresaId: EMP },
      empresaId: EMP,
      tipoConsulta: 'distNSU'
    });
    assert.equal(r.ok, false);
    assert.equal(r.codigo, CODIGOS_AUTORIZACAO_SEFAZ.PRODUCAO_INDISPONIVEL);
  });

  it('4. autorização expirada / token inválido / empresa divergente', () => {
    const auth = criarAutorizacaoOperacaoReal({
      empresaId: EMP,
      cnpj: CNPJ,
      tokenSeed: SEED,
      confirmacaoConsultaReal: true,
      confirmacaoAmbienteProducao: true
    });
    const expirada = { ...auth, emitidoEm: Date.now() - 20 * 60 * 1000, expiraEm: Date.now() - 1000 };
    assert.equal(
      avaliarAutorizacaoTransmissao({
        autorizacao: expirada,
        empresaId: EMP,
        tipoConsulta: 'distNSU'
      }).ok,
      false
    );
    assert.equal(
      avaliarAutorizacaoTransmissao({
        autorizacao: { ...auth, token: 'CDS_SEFAZ_AUTH_OPERACAO_REAL_invalido' },
        empresaId: EMP,
        tipoConsulta: 'distNSU'
      }).ok,
      false
    );
    assert.equal(
      avaliarAutorizacaoTransmissao({
        autorizacao: auth,
        empresaId: EMP + 1,
        tipoConsulta: 'distNSU'
      }).codigo,
      CODIGOS_AUTORIZACAO_SEFAZ.EMPRESA_DIVERGENTE
    );
  });

  it('5. TESTE_ISOLADO não vira produção', () => {
    const t = criarAutorizacaoTesteIsolado({ empresaId: EMP });
    assert.equal(t.producao, false);
    assert.equal(t.operacional, false);
    assert.equal(t.modo, 'TESTE_ISOLADO');
  });

  it('6. pré-voo bloqueia sem empresa e com cooldown', async () => {
    const svc = svcBase();
    const semEmp = await svc.executarPreVoo(null);
    assert.equal(semEmp.ok, false);
    assert.equal(semEmp.codigo, 'EMPRESA_OBRIGATORIA');

    const comCd = svcBase({
      nsuService: {
        buscarPorCnpjAmbiente: async () => ({ ultNsu: '1', maxNsu: '1' }),
        avaliarCooldown: () => ({
          ativo: true,
          proximaConsultaEm: new Date(Date.now() + 3600000).toISOString(),
          motivo: 'CONSUMO_INDEVIDO'
        })
      }
    });
    const cd = await comCd.executarPreVoo(EMP);
    assert.equal(cd.ok, false);
    assert.equal(cd.codigo, 'COOLDOWN_ATIVO');
  });

  it('7. habilitar exige admin + confirmações; emitir exige ativação', async () => {
    const svc = svcBase();
    await assert.rejects(
      () => svc.habilitar({
        empresaId: EMP,
        usuario: { id: 1, perfil: 'USUARIO' },
        confirmarAmbienteProducao: true,
        confirmarRisco: true
      }),
      (e) => e.code === 'ADMIN_OBRIGATORIO'
    );
    await assert.rejects(
      () => svc.habilitar({
        empresaId: EMP,
        usuario: { id: 1, perfil: 'ADMIN' },
        confirmarAmbienteProducao: false,
        confirmarRisco: true
      }),
      (e) => e.code === 'CONFIRMACAO_OBRIGATORIA'
    );

    const hab = await svc.habilitar({
      empresaId: EMP,
      usuario: { id: 9, perfil: 'ADMIN' },
      confirmarAmbienteProducao: true,
      confirmarRisco: true
    });
    assert.equal(hab.sucesso, true);
    assert.equal(hab.ativa, true);
    assert.equal(hab.tokenSeed, undefined);

    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: false,
        confirmacaoAmbienteProducao: true,
        usuario: { id: 9 }
      }),
      (e) => e.code === 'CONFIRMACAO_CONSULTA_OBRIGATORIA'
    );

    const emitido = await svc.emitirAutorizacaoConsultaReal({
      empresaId: EMP,
      confirmacaoConsultaReal: true,
      confirmacaoAmbienteProducao: true,
      usuario: { id: 9 }
    });
    assert.equal(emitido.autorizacao.modo, MODO_OPERACAO_REAL);
    assert.equal(emitido.autorizacao.manifestacaoAutomatica, false);
    assert.ok(
      avaliarAutorizacaoTransmissao({
        autorizacao: emitido.autorizacao,
        empresaId: EMP,
        tipoConsulta: 'distNSU'
      }).ok
    );
  });

  it('8. desabilitar remove autorização subsequente', async () => {
    const svc = svcBase();
    await svc.habilitar({
      empresaId: EMP,
      usuario: { id: 1, perfil: 'SUPER_ADMIN' },
      confirmarAmbienteProducao: true,
      confirmarRisco: true
    });
    await svc.desabilitar({ empresaId: EMP, usuario: { id: 1, perfil: 'ADMIN' } });
    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true
      }),
      (e) => e.code === 'OPERACAO_REAL_DESABILITADA'
    );
  });

  it('9. testar prontidão NÃO marca consulta SEFAZ', async () => {
    const svc = svcBase();
    const r = await svc.testarProntidaoSemConsulta(EMP);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.sefazConsultada, false);
    assert.equal(r.tipoTeste, 'PRONTIDAO_LOCAL');
  });

  it('10. diagnóstico padrão e sync não usam DistDFe sem forçar; UI distingue ações', () => {
    const diag = src('backend/motores/central-entradas/services/CentralDiagnosticoService.js');
    assert.match(diag, /forcarProbeDistDfe/);
    assert.match(diag, /PRONTIDAO_LOCAL/);
    assert.match(diag, /NÃO executa DistDFe/);

    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /Consultar DF-e \(produção\)/);
    assert.match(ui, /operacao-fiscal-real\/consultar-dfe/);
    assert.match(ui, /Não<\/strong> envia DistDFe/);

    const authSrc = src('backend/services/fiscal/autorizacaoTransmissaoSefaz.js');
    assert.match(authSrc, /MODO_OPERACAO_REAL/);
    assert.match(authSrc, /Manifestação 210210 NÃO é autorizada/);

    const orch = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
    assert.match(orch, /pularManifestacaoAutomatica/);
    assert.match(orch, /consultarDfeReal/);
  });

  it('11. estados documentais preservam separação (sem importação automática por DistDFe)', () => {
    const st = src('backend/motores/central-entradas/core/DocumentoFiscalStatus.js');
    assert.match(st, /RESUMO_RECEBIDO/);
    assert.match(st, /XML_COMPLETO/);
    assert.match(st, /XML_INDISPONIVEL/);
    assert.match(st, /IMPORTADA/);
    assert.match(st, /CANCELADA/);
  });
});
