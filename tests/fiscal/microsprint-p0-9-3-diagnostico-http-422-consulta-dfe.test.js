/**
 * Microsprint P0.9.3 — Diagnóstico HTTP 422 na consulta DF-e (operação fiscal real).
 * Isolado: preload, mocks. Sem SOAP real, sem PFX real, sem banco oficial, sem mutar NSU/cooldown de produção.
 */
'use strict';

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p093-http422-');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CentralOperacaoFiscalRealService = require(
  '../../backend/motores/central-entradas/services/CentralOperacaoFiscalRealService'
);
const {
  ETAPAS_BLOQUEIO,
  etapaPorCodigoPreVoo,
  montarErroConsultaDfe,
  formatarHorarioLiberacao
} = CentralOperacaoFiscalRealService;
const CentralNsuService = require(
  '../../backend/motores/central-entradas/services/CentralNsuService'
);

const ROOT = path.join(__dirname, '../..');
const EMP = 42;
const CNPJ = '38204469000115';
const SEED = 'seed-teste-isolado-p093-http422';

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

async function seedAtivacao(svc, extras = {}) {
  await svc._gravarAtivacao(EMP, {
    ativa: true,
    empresaId: EMP,
    tokenSeed: SEED,
    cnpj: CNPJ,
    tiposPermitidos: ['distNSU'],
    ativadaEm: new Date().toISOString(),
    ...extras
  });
}

describe('P0.9.3 diagnóstico HTTP 422 consulta DF-e', () => {
  it('1. isolamento ativo (sem banco oficial)', () => {
    assert.ok(isolamento);
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
  });

  it('2. mapeamento código → etapa estável', () => {
    assert.equal(etapaPorCodigoPreVoo('COOLDOWN_ATIVO'), ETAPAS_BLOQUEIO.COOLDOWN);
    assert.equal(etapaPorCodigoPreVoo('FILA_ESGOTADA'), ETAPAS_BLOQUEIO.COOLDOWN);
    assert.equal(etapaPorCodigoPreVoo('ESTADO_NSU_INCONSISTENTE'), ETAPAS_BLOQUEIO.COOLDOWN);
    assert.equal(etapaPorCodigoPreVoo('AMBIENTE_NAO_PRODUCAO'), ETAPAS_BLOQUEIO.AMBIENTE);
    assert.equal(etapaPorCodigoPreVoo('CERTIFICADO_INVALIDO'), ETAPAS_BLOQUEIO.CERTIFICADO);
    assert.equal(etapaPorCodigoPreVoo('CNPJ_AUSENTE'), ETAPAS_BLOQUEIO.CNPJ);
    assert.equal(etapaPorCodigoPreVoo('NSU_INDISPONIVEL'), ETAPAS_BLOQUEIO.NSU);
    assert.equal(etapaPorCodigoPreVoo('EMPRESA_OBRIGATORIA'), ETAPAS_BLOQUEIO.EMPRESA);
  });

  it('3. montarErroConsultaDfe expõe codigo, etapa e proximaConsultaEm (sem seed)', () => {
    const liberacao = '2026-10-18T18:00:00.000Z';
    const err = montarErroConsultaDfe({
      codigo: 'COOLDOWN_ATIVO',
      mensagem: 'Cooldown SEFAZ ativo — consulta real bloqueada.',
      mensagemAmigavel: 'Nova consulta a partir de 18/10/2026.',
      statusCode: 422,
      etapa: ETAPAS_BLOQUEIO.COOLDOWN,
      preVoo: {
        ok: false,
        codigo: 'COOLDOWN_ATIVO',
        proximaConsultaEm: liberacao,
        nsu: { ultNsu: '10', cooldownAtivo: true, proximaConsultaEm: liberacao }
      }
    });
    assert.equal(err.statusCode, 422);
    assert.equal(err.codigo, 'COOLDOWN_ATIVO');
    assert.equal(err.code, 'COOLDOWN_ATIVO');
    assert.equal(err.etapa, 'cooldown');
    assert.equal(err.proximaConsultaEm, liberacao);
    assert.equal(err.consultaExecutada, false);
    assert.equal(err.sefazConsultada, false);
    assert.equal(err.tokenSeed, undefined);
    assert.doesNotMatch(JSON.stringify(err.preVoo), /tokenSeed|senha|password/i);
  });

  it('4. HTTP 422 — COOLDOWN_ATIVO (causa raiz mais provável com UI “habilitada”)', async () => {
    const liberacao = new Date(Date.now() + 45 * 60 * 1000).toISOString();
    const svc = svcBase({
      nsuService: {
        buscarPorCnpjAmbiente: async () => ({
          ultNsu: '000000000000010',
          maxNsu: '000000000000010',
          ultimoCstat: '137',
          dataSincronizacao: new Date().toISOString()
        }),
        avaliarCooldown: () => ({
          ativo: true,
          motivo: 'FILA_ESGOTADA',
          proximaConsultaEm: liberacao
        })
      }
    });
    await seedAtivacao(svc);

    const status = await svc.obterStatus(EMP);
    assert.equal(status.ativa, true);
    assert.equal(status.preVoo.ok, false);
    assert.equal(status.preVoo.codigo, 'FILA_ESGOTADA');
    assert.equal(status.preVoo.etapa, 'cooldown');
    assert.equal(status.preVoo.proximaConsultaEm, liberacao);

    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true,
        usuario: { id: 1 }
      }),
      (e) => {
        assert.equal(e.statusCode, 422);
        assert.equal(e.codigo, 'FILA_ESGOTADA');
        assert.equal(e.etapa, 'cooldown');
        assert.equal(e.proximaConsultaEm, liberacao);
        assert.match(e.mensagemAmigavel || e.message, /fila esgotada|cooldown|Nova consulta|bloqueada/i);
        assert.equal(e.consultaExecutada, false);
        return true;
      }
    );
  });

  it('5. HTTP 422 — AMBIENTE_NAO_PRODUCAO', async () => {
    const svc = svcBase({
      configuracaoService: {
        obterContextoOperacional: async () => ({
          ok: true,
          contexto: { empresaId: EMP, cnpj: CNPJ, ambiente: 2, nomeEmpresa: 'HOM' }
        })
      }
    });
    // habilitar também exige produção — seedamos ativação diretamente
    await svc._gravarAtivacao(EMP, {
      ativa: true,
      empresaId: EMP,
      tokenSeed: SEED,
      cnpj: CNPJ,
      tiposPermitidos: ['distNSU']
    });

    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true
      }),
      (e) => e.statusCode === 422
        && e.codigo === 'AMBIENTE_NAO_PRODUCAO'
        && e.etapa === 'ambiente'
    );
  });

  it('6. HTTP 422 — CERTIFICADO_INVALIDO', async () => {
    const svc = svcBase({
      exigirCertificadoAptoParaUsoFiscal: async () => {
        const err = new Error('Certificado A1 vencido ou inválido.');
        err.code = 'CERTIFICADO_INVALIDO';
        throw err;
      }
    });
    await svc._gravarAtivacao(EMP, {
      ativa: true,
      empresaId: EMP,
      tokenSeed: SEED,
      cnpj: CNPJ
    });

    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true
      }),
      (e) => e.statusCode === 422
        && e.codigo === 'CERTIFICADO_INVALIDO'
        && e.etapa === 'certificado'
    );
  });

  it('7. HTTP 422 — CNPJ_AUSENTE', async () => {
    const svc = svcBase({
      configuracaoService: {
        obterContextoOperacional: async () => ({
          ok: true,
          contexto: { empresaId: EMP, cnpj: null, ambiente: 1 }
        })
      }
    });
    await svc._gravarAtivacao(EMP, {
      ativa: true,
      empresaId: EMP,
      tokenSeed: SEED,
      cnpj: CNPJ
    });

    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true
      }),
      (e) => e.statusCode === 422
        && e.codigo === 'CNPJ_AUSENTE'
        && e.etapa === 'cnpj'
    );
  });

  it('8. HTTP 422 — NSU_INDISPONIVEL', async () => {
    const svc = svcBase({
      nsuService: {
        buscarPorCnpjAmbiente: async () => {
          throw new Error('Falha simulada ao ler NSU');
        },
        avaliarCooldown: () => ({ ativo: false })
      }
    });
    await svc._gravarAtivacao(EMP, {
      ativa: true,
      empresaId: EMP,
      tokenSeed: SEED,
      cnpj: CNPJ
    });

    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true
      }),
      (e) => e.statusCode === 422
        && e.codigo === 'NSU_INDISPONIVEL'
        && e.etapa === 'nsu'
    );
  });

  it('9. HTTP 400 — confirmação ausente; HTTP 403 — operação desabilitada', async () => {
    const svc = svcBase();
    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: false,
        confirmacaoAmbienteProducao: true
      }),
      (e) => e.statusCode === 400
        && e.codigo === 'CONFIRMACAO_CONSULTA_OBRIGATORIA'
        && e.etapa === 'confirmacao'
    );

    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true
      }),
      (e) => e.statusCode === 403
        && e.codigo === 'OPERACAO_REAL_DESABILITADA'
        && e.etapa === 'ativacao'
    );
  });

  it('10. habilitar NÃO bloqueia por cooldown; emitir/consulta sim (HTTP 422)', async () => {
    const liberacao = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const svc = svcBase({
      nsuService: {
        buscarPorCnpjAmbiente: async () => ({
          ultNsu: '000000000000010',
          maxNsu: '000000000000010'
        }),
        avaliarCooldown: () => ({
          ativo: true,
          motivo: 'FILA_ESGOTADA',
          proximaConsultaEm: liberacao
        })
      }
    });

    const preConsulta = await svc.executarPreVoo(EMP, { exigirProducao: true });
    assert.equal(preConsulta.ok, false);
    assert.equal(preConsulta.codigo, 'FILA_ESGOTADA');

    const preAtivacao = await svc.executarPreVoo(EMP, {
      exigirProducao: true,
      bloquearPorCooldown: false
    });
    assert.equal(preAtivacao.ok, true);
    assert.equal(preAtivacao.avisoCooldown, true);

    const hab = await svc.habilitar({
      empresaId: EMP,
      usuario: { id: 1, perfil: 'SUPER_ADMIN' },
      confirmarAmbienteProducao: true,
      confirmarRisco: true
    });
    assert.equal(hab.sucesso, true);
    assert.equal(hab.avisoCooldown, true);
    assert.equal(hab.proximaConsultaEm, liberacao);
    assert.match(hab.mensagem, /Cooldown|cooldown/i);

    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true,
        usuario: { id: 1 }
      }),
      (e) => e.statusCode === 422 && e.codigo === 'FILA_ESGOTADA'
    );
  });

  it('11. montarMensagemCooldown distingue FILA sticky e cooldown 656 com horário', () => {
    const iso = '2026-10-18T21:30:00.000Z';
    const msgFila = CentralNsuService.montarMensagemCooldown({
      motivo: 'FILA_ESGOTADA',
      proximaConsultaEm: iso
    });
    assert.match(msgFila, /fila esgotada/i);
    assert.match(msgFila, /liberação operacional/i);
    assert.doesNotMatch(msgFila, /2026-10-18T21:30:00/);
    const msgCd = CentralNsuService.montarMensagemCooldown({
      motivo: 'COOLDOWN_EXPLICITO',
      proximaConsultaEm: iso
    });
    assert.match(msgCd, /Nova consulta a partir de/);
    const label = formatarHorarioLiberacao(iso);
    assert.ok(label);
    assert.match(label, /\d/);
  });

  it('12. rota consultar-dfe/habilitar usa responderErroConsultaDfeReal com codigo/etapa', () => {
    const rotas = src('backend/rotas/central-entradas.js');
    assert.match(rotas, /function responderErroConsultaDfeReal/);
    assert.match(rotas, /operacao-fiscal-real\/habilitar/);
    assert.match(rotas, /habilitarOperacaoFiscalReal[\s\S]{0,800}responderErroConsultaDfeReal\(res,\s*error\)/);
    assert.match(rotas, /consultar-dfe[\s\S]{0,1200}responderErroConsultaDfeReal\(res,\s*error\)/);
    assert.match(rotas, /responderErroConsultaDfeReal\(res,\s*error\)/);
    assert.match(rotas, /etapa:\s*error\.etapa/);
    assert.match(rotas, /proximaConsultaEm/);
    assert.match(rotas, /AUTORIZACAO_CLIENTE_RECUSADA/);
    assert.doesNotMatch(rotas, /autorizacaoTransmissaoSefaz:\s*body/);
  });

  it('13. UI propaga codigo/mensagemAmigavel e bloqueia botão no pré-voo', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /err\.codigo\s*=\s*data\.codigo\s*\|\|\s*data\.code/);
    assert.match(ui, /function atualizarBotaoConsultarDfeRealCentral/);
    assert.match(ui, /pre\.ok\s*===\s*false/);
    assert.match(ui, /Cooldown SEFAZ/);
    assert.match(ui, /classificarMensagemBloqueioFiscalCentral/);
    assert.match(ui, /centralCfgOpRealConsultar/);
  });

  it('14. log técnico de bloqueio não inclui token/senha', () => {
    const svcSrc = src('backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js');
    assert.match(svcSrc, /CONSULTA_DFE_BLOQUEADA/);
    assert.match(svcSrc, /logBloqueioConsultaDfe/);
    assert.match(svcSrc, /etapa:/);
    // payload do log lista campos explícitos — sem tokenSeed
    assert.match(svcSrc, /Sem tokens, senhas ou seed/);
  });
});
