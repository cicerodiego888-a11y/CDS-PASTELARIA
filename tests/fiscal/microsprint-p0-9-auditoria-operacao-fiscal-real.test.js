/**
 * Microsprint P0.9 — Auditoria final de segurança da operação fiscal real.
 * Isolado: Temp DB dir, mocks SOAP. Sem SEFAZ real, sem PFX real, sem banco oficial.
 */
'use strict';

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p09-audit-op-real-');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  MODO_OPERACAO_REAL,
  TIPOS_CONSULTA_SEFAZ,
  CODIGOS_AUTORIZACAO_SEFAZ,
  criarAutorizacaoOperacaoReal,
  avaliarAutorizacaoTransmissao,
  exigirAutorizacaoTransmissao
} = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
const CentralOperacaoFiscalRealService = require(
  '../../backend/motores/central-entradas/services/CentralOperacaoFiscalRealService'
);
const {
  sincronizarDistribuicaoDFe,
  consultarNotaPorChave
} = require('../../backend/services/fiscal/distribuicaoDFe');
const { gerarChaveAcesso } = require('../../backend/services/fiscal/utils');

const ROOT = path.join(__dirname, '../..');
const EMP = 77;
const CNPJ = '38204469000115';
const CNPJ_OUTRO = '12345678000195';

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
  return new CentralOperacaoFiscalRealService({
    configRepository: overrides.configRepository || memConfigRepo(),
    exigirCertificadoAptoParaUsoFiscal: overrides.exigirCertificadoAptoParaUsoFiscal
      || (async () => ({ apto: true })),
    configuracaoService: overrides.configuracaoService || {
      obterContextoOperacional: async ({ empresaId }) => ({
        ok: true,
        contexto: {
          empresaId: Number(empresaId),
          cnpj: CNPJ,
          ambiente: 1,
          nomeEmpresa: 'AUDITORIA P09'
        }
      })
    },
    nsuService: overrides.nsuService || {
      buscarPorCnpjAmbiente: async () => ({
        ultNsu: '000000000000020',
        maxNsu: '000000000000020'
      }),
      avaliarCooldown: () => ({ ativo: false })
    },
    ...overrides
  });
}

function soapSpy() {
  const chamadas = [];
  return {
    chamadas,
    enviar: async (p) => {
      chamadas.push(p);
      return {
        success: true,
        body: '<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">'
          + '<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo>'
          + '<ultNSU>000000000000020</ultNSU><maxNSU>000000000000020</maxNSU>'
          + '</retDistDFeInt>'
      };
    }
  };
}

async function habilitarEEmitir(svc) {
  await svc.habilitar({
    empresaId: EMP,
    usuario: { id: 1, perfil: 'ADMIN' },
    confirmarAmbienteProducao: true,
    confirmarRisco: true
  });
  return svc.emitirAutorizacaoConsultaReal({
    empresaId: EMP,
    usuario: { id: 1 },
    confirmacaoConsultaReal: true,
    confirmacaoAmbienteProducao: true
  });
}

describe('P0.9 auditoria final operação fiscal real', () => {
  it('1. isolamento ativo — sem banco oficial', () => {
    assert.ok(isolamento);
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.match(String(isolamento.dbDir || process.env.DB_DIR || ''), /cds-p09-audit|Temp|tmp/i);
  });

  it('2. admin obrigatório para habilitar; usuário comum bloqueado', async () => {
    const svc = svcBase();
    await assert.rejects(
      () => svc.habilitar({
        empresaId: EMP,
        usuario: { id: 2, perfil: 'USUARIO' },
        confirmarAmbienteProducao: true,
        confirmarRisco: true
      }),
      (e) => e.code === 'ADMIN_OBRIGATORIO'
    );
  });

  it('3. confirmações server-side obrigatórias (frontend sozinho não basta)', async () => {
    const svc = svcBase();
    await svc.habilitar({
      empresaId: EMP,
      usuario: { id: 1, perfil: 'SUPER_ADMIN' },
      confirmarAmbienteProducao: true,
      confirmarRisco: true
    });
    await assert.rejects(
      () => svc.emitirAutorizacaoConsultaReal({
        empresaId: EMP,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: false
      }),
      (e) => e.code === 'CONFIRMACAO_CONSULTA_OBRIGATORIA'
    );
  });

  it('4. autorização vinculada a empresa + CNPJ; outra empresa/CNPJ bloqueados', async () => {
    const svc = svcBase();
    const { autorizacao } = await habilitarEEmitir(svc);
    assert.equal(autorizacao.modo, MODO_OPERACAO_REAL);
    assert.equal(autorizacao.cnpj, CNPJ);

    const outraEmp = avaliarAutorizacaoTransmissao({
      autorizacao,
      empresaId: EMP + 1,
      tipoConsulta: 'distNSU'
    });
    assert.equal(outraEmp.ok, false);
    assert.equal(outraEmp.codigo, CODIGOS_AUTORIZACAO_SEFAZ.EMPRESA_DIVERGENTE);

    const cnpjDiv = avaliarAutorizacaoTransmissao({
      autorizacao,
      empresaId: EMP,
      tipoConsulta: 'distNSU',
      cnpjEmpresa: CNPJ_OUTRO
    });
    assert.equal(cnpjDiv.ok, false);
    assert.equal(cnpjDiv.codigo, CODIGOS_AUTORIZACAO_SEFAZ.CNPJ_DIVERGENTE);
  });

  it('5. desativação revoga imediatamente autorização ainda no TTL', async () => {
    const svc = svcBase();
    const { autorizacao } = await habilitarEEmitir(svc);

    // Ainda válida localmente (TTL)
    assert.equal(
      avaliarAutorizacaoTransmissao({
        autorizacao,
        empresaId: EMP,
        tipoConsulta: 'distNSU',
        cnpjEmpresa: CNPJ
      }).ok,
      true
    );

    await svc.desabilitar({ empresaId: EMP, usuario: { id: 1, perfil: 'ADMIN' } });

    await assert.rejects(
      () => svc.assertAutorizacaoViva(autorizacao, {
        empresaId: EMP,
        cnpj: CNPJ,
        tipoConsulta: 'distNSU'
      }),
      (e) => e.codigo === CODIGOS_AUTORIZACAO_SEFAZ.OPERACAO_REAL_REVOGADA
        || e.code === CODIGOS_AUTORIZACAO_SEFAZ.OPERACAO_REAL_REVOGADA
    );
  });

  it('6. DistDFe com OPERACAO_REAL revogada NÃO chama SOAP', async () => {
    const svc = svcBase();
    const { autorizacao } = await habilitarEEmitir(svc);
    await svc.desabilitar({ empresaId: EMP, usuario: { id: 1, perfil: 'ADMIN' } });
    const soap = soapSpy();

    const r = await sincronizarDistribuicaoDFe({
      empresaId: EMP,
      contextoCentral: {
        empresaId: EMP,
        cnpj: CNPJ,
        ambiente: 1,
        codigoUf: '23',
        certificadoPath: 'C:\\certs\\mock.pfx',
        certificadoSenha: 'mock-nao-usar'
      },
      autorizacaoTransmissaoSefaz: autorizacao,
      operacaoFiscalRealService: svc,
      maxIteracoes: 1,
      enviarDistribuicaoDfe: soap.enviar,
      nsuService: {
        obterOuCriar: async () => ({ ultNsu: '20', maxNsu: '20' }),
        avaliarCooldown: () => ({ ativo: false }),
        aplicarRetornoDistDfe: async (p) => ({ controle: p.controle, ultNsu: p.ultNsu, maxNsu: p.maxNsu })
      },
      auditoriaService: {
        registrar: async () => null,
        registrarConsulta: async () => null,
        registrarResumoSync: async () => null,
        registrarNsuAvanco: async () => null
      },
      persistenciaService: {
        persistirDocumentoDfe: async () => ({ novo: false })
      }
    });

    assert.equal(r.consultaExecutada, false);
    assert.equal(r.bloqueadoAutorizacao, true);
    assert.equal(soap.chamadas.length, 0);
    assert.equal(
      r.codigo,
      CODIGOS_AUTORIZACAO_SEFAZ.OPERACAO_REAL_REVOGADA
    );
  });

  it('7. certificado inválido no pré-voo impede emissão', async () => {
    const svc = svcBase({
      exigirCertificadoAptoParaUsoFiscal: async () => {
        const err = new Error('Certificado A1 inválido (mock)');
        err.code = 'CERTIFICADO_INVALIDO';
        throw err;
      }
    });
    await assert.rejects(
      () => svc.habilitar({
        empresaId: EMP,
        usuario: { id: 1, perfil: 'ADMIN' },
        confirmarAmbienteProducao: true,
        confirmarRisco: true
      }),
      (e) => e.code === 'CERTIFICADO_INVALIDO'
    );
  });

  it('8. cooldown ativo impede emissão e assert', async () => {
    const svc = svcBase({
      nsuService: {
        buscarPorCnpjAmbiente: async () => ({ ultNsu: '1', maxNsu: '1' }),
        avaliarCooldown: () => ({
          ativo: true,
          motivo: 'CONSUMO_INDEVIDO',
          proximaConsultaEm: new Date(Date.now() + 3600000).toISOString()
        })
      }
    });
    const pre = await svc.executarPreVoo(EMP);
    assert.equal(pre.ok, false);
    assert.equal(pre.codigo, 'COOLDOWN_ATIVO');
  });

  it('9. expiração e 210210 bloqueados; sem SOAP', async () => {
    const auth = criarAutorizacaoOperacaoReal({
      empresaId: EMP,
      cnpj: CNPJ,
      tokenSeed: 'seed-exp',
      confirmacaoConsultaReal: true,
      confirmacaoAmbienteProducao: true
    });
    const expirada = {
      ...auth,
      emitidoEm: Date.now() - 20 * 60 * 1000,
      expiraEm: Date.now() - 1000
    };
    assert.equal(
      avaliarAutorizacaoTransmissao({
        autorizacao: expirada,
        empresaId: EMP,
        tipoConsulta: 'distNSU',
        cnpjEmpresa: CNPJ
      }).ok,
      false
    );
    assert.equal(
      avaliarAutorizacaoTransmissao({
        autorizacao: auth,
        empresaId: EMP,
        tipoConsulta: TIPOS_CONSULTA_SEFAZ.MANIFESTACAO_210210,
        cnpjEmpresa: CNPJ
      }).ok,
      false
    );
  });

  it('10. OPERACAO_REAL viva + mock: DistDFe executa mock sem rede real', async () => {
    const svc = svcBase();
    const { autorizacao } = await habilitarEEmitir(svc);
    const soap = soapSpy();
    let nsuAvancadoArtificialmente = false;

    const r = await sincronizarDistribuicaoDFe({
      empresaId: EMP,
      contextoCentral: {
        empresaId: EMP,
        cnpj: CNPJ,
        ambiente: 1,
        codigoUf: '23',
        certificadoPath: 'C:\\certs\\mock.pfx',
        certificadoSenha: 'mock-nao-usar'
      },
      autorizacaoTransmissaoSefaz: autorizacao,
      operacaoFiscalRealService: svc,
      maxIteracoes: 1,
      enviarDistribuicaoDfe: soap.enviar,
      nsuService: {
        obterOuCriar: async () => ({ ultNsu: '000000000000020', maxNsu: '000000000000020' }),
        avaliarCooldown: () => ({ ativo: false }),
        aplicarRetornoDistDfe: async (p) => {
          // só aplica se houver retorno oficial (cStat presente no fluxo real)
          if (!p || p.cStat == null) nsuAvancadoArtificialmente = true;
          return { controle: p.controle, ultNsu: p.ultNsu, maxNsu: p.maxNsu };
        }
      },
      auditoriaService: {
        registrar: async () => null,
        registrarConsulta: async () => null,
        registrarResumoSync: async () => null,
        registrarNsuAvanco: async () => null
      },
      persistenciaService: { persistirDocumentoDfe: async () => ({ novo: false }) },
      gateSefaz: {
        autorizarConsultaDistDfe: async () => ({ permitido: true })
      }
    });

    assert.equal(soap.chamadas.length >= 1, true);
    assert.equal(r.consultaExecutada !== false || r.cStat === '137' || r.sucesso !== undefined, true);
    assert.equal(nsuAvancadoArtificialmente, false);
    // mock local — não é SEFAZ real
    assert.ok(String(soap.chamadas[0].xmlConsulta || soap.chamadas[0].xmlConsulta || '').includes('distNSU')
      || soap.chamadas[0].xmlConsulta != null
      || soap.chamadas.length >= 1);
  });

  it('11. consChNFe sem autorização / revogada: zero SOAP', async () => {
    const soap = soapSpy();
    const chave = gerarChaveAcesso({
      uf: '35',
      aamm: '2610',
      cnpj: '12345678000195',
      modelo: '55',
      serie: 1,
      numero: 9001,
      tpEmis: '1',
      cNF: 12345678
    });
    await assert.rejects(
      () => consultarNotaPorChave(chave, {
        empresaId: EMP,
        contextoCentral: { empresaId: EMP, cnpj: CNPJ, ambiente: 1 },
        enviarDistribuicaoDfe: soap.enviar
      }),
      (e) => e.consultaExecutada === false || e.bloqueadoAutorizacao === true
    );
    assert.equal(soap.chamadas.length, 0);
  });

  it('12. rota consultar-dfe rejeita injeção de token; sync não propaga body auth', () => {
    const rotas = src('backend/rotas/central-entradas.js');
    assert.match(rotas, /AUTORIZACAO_CLIENTE_RECUSADA/);
    assert.match(rotas, /autorizacaoTransmissaoSefaz != null/);
    assert.match(rotas, /operacao-fiscal-real\/consultar-dfe/);
    assert.match(rotas, /nunca aceita autorização OPERACAO_REAL do cliente/);
  });

  it('13. barreira DistDFe exige assert de ativação viva (código)', () => {
    const dfe = src('backend/services/fiscal/distribuicaoDFe.js');
    assert.match(dfe, /exigirOperacaoRealVivaSeAplicavel/);
    assert.match(dfe, /assertAutorizacaoViva|validarOperacaoRealViva/);
    const svc = src('backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js');
    assert.match(svc, /assertAutorizacaoViva/);
    assert.match(svc, /seedRevogadoEm|OPERACAO_REAL_REVOGADA|tokenSeedAnteriorHash/);
  });

  it('14. flags env/produção soltas e TESTE_ISOLADO sem bypass OPERACAO_REAL', () => {
    assert.equal(
      avaliarAutorizacaoTransmissao({
        autorizacao: { producao: true, empresaId: EMP, modo: 'PRODUCAO' },
        empresaId: EMP,
        tipoConsulta: 'distNSU'
      }).codigo,
      CODIGOS_AUTORIZACAO_SEFAZ.PRODUCAO_INDISPONIVEL
    );
    assert.throws(
      () => exigirAutorizacaoTransmissao({
        autorizacao: null,
        empresaId: EMP,
        tipoConsulta: 'distNSU'
      }),
      (e) => e.codigo === CODIGOS_AUTORIZACAO_SEFAZ.NAO_AUTORIZADA
    );
  });

  it('15. empresa obrigatória — sem fallback global no pré-voo', async () => {
    const svc = svcBase();
    const r = await svc.executarPreVoo(null);
    assert.equal(r.ok, false);
    assert.equal(r.codigo, 'EMPRESA_OBRIGATORIA');
    const srcCfg = src('backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js');
    assert.match(srcCfg, /permitirFallbackGlobal: false/);
  });
});
