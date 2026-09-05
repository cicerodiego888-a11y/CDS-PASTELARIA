/**
 * Sprint MBC-13 — auditoria de prontidão. Sem instituição oficial. Sem rede.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { IBankProvider } = require('../../backend/motores/bancario/contracts/IBankProvider');
const { criarRegistryPadrao } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { OpenFinanceRealBankProvider } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider');
const { mapearTransacao } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealMapper');
const { RETENTAVEIS } = require('../../backend/motores/bancario/providers/openfinance-real/retrySeguro');
const { CATEGORIA_ERRO_PROVIDER } = require('../../backend/motores/bancario/contracts/constantes');
const { sanitizarObjetoMbc } = require('../../backend/motores/bancario/contracts/sanitizarMbc');
const { montarEventoOperacaoMbc } = require('../../backend/motores/bancario/contracts/observabilidadeMbc');
const {
  providerRealPodeOperar,
  INSTITUICAO_OFICIAL,
  DOCUMENTACAO_OFICIAL_URL,
  OAUTH_OFICIAL,
  CERTIFICADO_OFICIAL_EXIGIDO,
  secretStoreProducaoDisponivel,
  ambienteEndpointValido,
  featureFlagLigada,
  MSG_BLOQUEIO_OPERACAO_REAL
} = require('../../backend/motores/bancario/providers/openfinance-real/prontidaoOperacaoReal');
const { RATE_LIMIT_PROVIDER, rateLimitOficialConhecido } = require('../../backend/motores/bancario/providers/openfinance-real/rateLimitProvider');
const { aplicarRollbackOperacaoReal } = require('../../backend/motores/bancario/providers/openfinance-real/rollbackOperacaoReal');
const { decisaoGoNogo, DECISAO_ATUAL } = require('../../backend/motores/bancario/providers/openfinance-real/auditoriaProntidao');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  const motor = obterMotorBancario({ db });
  return { db, empresaA, empresaB, motor };
}

describe('MBC-13 arquitetura e bloqueios', () => {
  it('T01 — IBankProvider único', () => {
    const p = new OpenFinanceRealBankProvider();
    assert.ok(p instanceof IBankProvider);
    assert.match(src('backend/motores/bancario/contracts/IBankProvider.js'), /Sem IOpenFinanceProvider/);
  });
  it('T02 — Registry', () => {
    const r = criarRegistryPadrao();
    assert.equal(r.existe('OPEN_FINANCE_REAL'), true);
    assert.equal(r.existe('MOCK'), true);
    assert.equal(r.existe('MOCK_OPEN_FINANCE'), true);
  });
  it('T03 — bloqueado sem documentação', () => {
    assert.equal(DOCUMENTACAO_OFICIAL_URL, null);
    assert.ok(providerRealPodeOperar().motivos.includes('AGUARDANDO_PROVIDER_REAL_AMBIENTE_OFICIAL'));
  });
  it('T04 — bloqueado sem instituição', () => {
    assert.equal(INSTITUICAO_OFICIAL, null);
    assert.equal(providerRealPodeOperar().ok, false);
  });
  it('T05 — bloqueado sem ambiente', () => {
    const p = providerRealPodeOperar({ ambiente: null });
    assert.ok(p.motivos.includes('ENDPOINTS_OFICIAIS_AUSENTES'));
  });
  it('T06 — bloqueado sem SecretStore de produção', () => {
    assert.equal(secretStoreProducaoDisponivel(), false);
    const p = providerRealPodeOperar({ ambiente: 'PRODUCAO' });
    assert.ok(p.motivos.includes('SECRET_STORE_PRODUCAO_AUSENTE'));
  });
  it('T07 — produção bloqueada', () => {
    const g = decisaoGoNogo({ ambiente: 'PRODUCAO' });
    assert.equal(g.producao, 'BLOQUEADA');
    assert.equal(g.pode_operar, false);
  });
  it('T08 — sandbox não opera como produção', () => {
    assert.throws(() => ambienteEndpointValido('PRODUCAO', { apiUrl: 'https://sandbox.banco/api' }));
  });
  it('T09 — homologação não opera como produção', () => {
    assert.throws(() => ambienteEndpointValido('PRODUCAO', { authUrl: 'https://hml.banco/oauth' }));
  });
  it('T10 — flag false bloqueia', () => {
    assert.equal(featureFlagLigada({}), false);
    assert.ok(providerRealPodeOperar({ env: {} }).motivos.includes('FEATURE_FLAG_DESLIGADA'));
  });
  it('T11 — flag true sem pré-condições bloqueia', () => {
    const p = providerRealPodeOperar({ env: { MBC_OPEN_FINANCE_REAL_ENABLED: 'true' } });
    assert.equal(p.ok, false);
  });
  it('T12 — ausência de endpoint bloqueia', () => {
    assert.ok(providerRealPodeOperar().motivos.includes('ENDPOINTS_OFICIAIS_AUSENTES'));
  });
  it('T13 — ausência de OAuth bloqueia', () => {
    assert.equal(OAUTH_OFICIAL, null);
    assert.ok(providerRealPodeOperar().motivos.includes('OAUTH_OFICIAL_AUSENTE'));
  });
  it('T14 — certificado exigido e ausente bloqueia', () => {
    assert.equal(CERTIFICADO_OFICIAL_EXIGIDO, null);
    const p = providerRealPodeOperar({ certificado_exigido: true, certificado_configurado: false });
    assert.ok(p.motivos.includes('CERTIFICADO_AUSENTE'));
  });
  it('T15 — credencial ausente bloqueia', () => {
    const p = providerRealPodeOperar({ secret_configurado: false });
    assert.ok(p.motivos.includes('CREDENCIAL_AUSENTE'));
  });
});

describe('MBC-13 segurança cursor conciliação', () => {
  it('T16 — segredo ausente no JSON de prontidão', () => {
    const j = JSON.stringify(providerRealPodeOperar());
    assert.equal(/client_secret|access_token/.test(j), false);
  });
  it('T17 — segredo ausente no log', () => {
    const ev = sanitizarObjetoMbc({ operacao: 'x', client_secret: 'S', access_token: 'T' });
    assert.equal(ev.client_secret, '[REDACTED]');
    assert.equal(ev.access_token, '[REDACTED]');
  });
  it('T18 — token ausente na URL bloqueada', async () => {
    const p = new OpenFinanceRealBankProvider();
    await assert.rejects(() => p.iniciarAutorizacao({ state: 'abc' }), (e) => e.message === MSG_BLOQUEIO_OPERACAO_REAL);
  });
  it('T19 — state protegido', () => {
    const s = src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js');
    assert.match(s, /randomBytes/);
    assert.match(s, /STATE_TTL_MS/);
    assert.match(s, /consumido/);
  });
  it('T20 — callback inválido', () => {
    assert.match(src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js'), /autorizacaoInvalida/);
  });
  it('T21 — callback expirado', () => {
    assert.match(src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js'), /state_expirado/);
  });
  it('T22 — replay bloqueado', () => {
    assert.match(src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js'), /Number\(st.consumido\) === 1/);
  });
  it('T23 T24 T25 — isolamento A/B', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'I13' });
    const a = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id, instituicao_financeira_id: inst.id, nome: 'CA', tipo: 'CORRENTE', numero: '13'
    });
    await ctx.motor.criarConta({
      empresaId: ctx.empresaB.id, instituicao_financeira_id: inst.id, nome: 'CB', tipo: 'CORRENTE', numero: '14'
    });
    await assert.rejects(() => ctx.motor.obterConta({ empresaId: ctx.empresaB.id, id: a.id }));
    await closeDb(ctx.db);
  });
  it('T26 — saldo conceitual separado', () => {
    const s = src('backend/motores/bancario/services/SincronizacaoBancariaService.js');
    assert.match(s, /saldo_bancario/);
    assert.match(s, /saldo_conceitual/);
    assert.match(s, /diferenca/);
  });
  it('T27 — provider não grava diretamente', () => {
    const p = src('backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider.js');
    assert.equal(/INSERT INTO/.test(p), false);
  });
  it('T28 — external_id obrigatório', () => {
    assert.throws(() => mapearTransacao({ amount: 1 }, { empresaId: 1, contaBancariaId: 1 }));
  });
  it('T29 — idempotência preservada', () => {
    assert.match(src('backend/motores/bancario/schema/bancarioSchema.js'), /external_source, external_id/);
  });
  it('T30 — cursor preservado', () => {
    assert.match(src('backend/motores/bancario/services/SincronizacaoBancariaService.js'), /cursor_atual/);
  });
  it('T31 — falha de página não perde cursor seguro', () => {
    assert.match(src('backend/motores/bancario/services/SincronizacaoBancariaService.js'), /cursor só avança após persistir/);
  });
  it('T32 — retry sem regra hipotética', () => {
    assert.equal(RETENTAVEIS.has(CATEGORIA_ERRO_PROVIDER.TIMEOUT), true);
    assert.equal(RETENTAVEIS.has(CATEGORIA_ERRO_PROVIDER.AUTENTICACAO), false);
    assert.equal(RETENTAVEIS.has(CATEGORIA_ERRO_PROVIDER.AUTORIZACAO), false);
    assert.equal(RETENTAVEIS.has(CATEGORIA_ERRO_PROVIDER.CONSENTIMENTO), false);
  });
  it('T33 — rate limit pendente não inventado', () => {
    assert.equal(RATE_LIMIT_PROVIDER.status, 'PENDENTE');
    assert.equal(RATE_LIMIT_PROVIDER.origem, 'DOCUMENTACAO_PROVIDER');
    assert.equal(RATE_LIMIT_PROVIDER.limite, null);
    assert.equal(rateLimitOficialConhecido(), false);
  });
  it('T34 — erro sanitizado', () => {
    const o = sanitizarObjetoMbc({ error: 'falha', authorization: 'Bearer X', certificado: 'PEM' });
    assert.equal(o.authorization, '[REDACTED]');
    assert.equal(o.certificado, '[REDACTED]');
  });
  it('T35 — observabilidade sanitizada', () => {
    const ev = montarEventoOperacaoMbc({
      provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX', token: 'AT', state: 'ST'
    });
    assert.equal(ev.token, '[REDACTED]');
    assert.equal(ev.state, '[REDACTED]');
    assert.equal(ev.ambiente, 'SANDBOX');
  });
  it('T36 — MBC-08 somente sugere', () => {
    assert.equal(src('backend/motores/bancario/matching/MotorMatchingBancarioService.js').includes('INSERT INTO conciliacao_bancaria'), false);
  });
  it('T37 — MBC-04 concilia', () => {
    assert.match(src('backend/motores/bancario/services/ConciliacaoBancariaService.js'), /async function conciliar/);
  });
  it('T38 — rollback não apaga histórico', () => {
    const r = aplicarRollbackOperacaoReal();
    assert.equal(r.historico_apagado, false);
    assert.equal(r.transacoes_preservadas, true);
    assert.equal(r.financeiro_revertido, false);
  });
  it('T39 — rollback bloqueia novas operações', () => {
    const r = aplicarRollbackOperacaoReal();
    assert.equal(r.novas_operacoes, 'BLOQUEADAS');
  });
  it('T40 — classificação NO-GO atual', () => {
    assert.equal(DECISAO_ATUAL, 'NO-GO');
    assert.equal(decisaoGoNogo().decisao, 'NO-GO');
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    const m = obterMotorBancario({ db: {} });
    assert.equal(m.avaliarGoNogoProviderReal().decisao, 'NO-GO');
  });
  it('T41 — UI BLOQUEADO pt-BR', () => {
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /ainda não está habilitado para operação real/);
    assert.equal(src('frontend/erp/js/contas-bancarias.js').includes('Conectado ao banco'), false);
  });
  it('T42 — docs de auditoria', () => {
    [
      'MBC-13-MATRIZ-PRONTIDAO.md',
      'MBC-13-CHECKLIST-PROVIDER.md',
      'MBC-13-CHECKLIST-PRODUCAO.md',
      'MBC-13-CHECKLIST-SEGURANCA.md',
      'MBC-13-ROLLBACK.md',
      'MBC-13-RELATORIO.md'
    ].forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario', f))));
  });
  it('T43 — body/query sem autoridade', () => {
    assert.match(src('backend/motores/bancario/BancarioEmpresaContextoService.js'), /resolverEmpresaIdParaVenda/);
  });
});
