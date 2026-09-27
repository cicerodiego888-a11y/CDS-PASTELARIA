/**
 * Sprint MBC-14.3 — visão multiempresa de contas bancárias.
 * Executar: node --test tests/bancario/motor-bancario-14-3.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { resolverEmpresaIdParaBancario } = require('../../backend/motores/bancario/BancarioEmpresaContextoService');
const { criarRouter } = require('../../backend/rotas/bancario');
const { ERROS } = require('../../backend/motores/bancario/contracts/constantes');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_C = '11111111000191';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_A, razao_social: 'Pastelaria do Cheff - Filial 2', nome_fantasia: 'Pastelaria do Cheff - Filial 2'
  }, { db });
  const empresaB = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_B, razao_social: 'Pastelaria do Cheff - Filial 3', nome_fantasia: 'Pastelaria do Cheff - Filial 3'
  }, { db });
  const empresaC = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_C, razao_social: 'Empresa C', nome_fantasia: 'Empresa C'
  }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  const motor = obterMotorBancario({ db });
  const inst = await motor.criarInstituicao({ nome: 'Itaú', codigo: '341' });
  const contaA = await motor.criarConta({
    empresaId: empresaA.id,
    instituicao_financeira_id: inst.id,
    nome: 'Conta Filial 2',
    tipo: 'CORRENTE',
    numero: '56789',
    principal: true
  });
  const contaB = await motor.criarConta({
    empresaId: empresaB.id,
    instituicao_financeira_id: inst.id,
    nome: 'Conta Filial 3',
    tipo: 'CORRENTE',
    numero: '11111',
    principal: true
  });
  const contaC = await motor.criarConta({
    empresaId: empresaC.id,
    instituicao_financeira_id: inst.id,
    nome: 'Conta C',
    tipo: 'CORRENTE',
    numero: '99999'
  });
  const depsMulti = {
    db,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA
  };
  return { db, empresaA, empresaB, empresaC, motor, inst, contaA, contaB, contaC, depsMulti };
}

function listenApp(ctx, { userId, empresaId }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: userId };
    if (empresaId != null) req.empresaId = empresaId;
    next();
  });
  app.use('/api/bancario', criarRouter({
    db: ctx.db,
    auth: (_req, _res, next) => next(),
    resolverEmpresaIdParaBancario: (req, d) => resolverEmpresaIdParaBancario(req, { ...ctx.depsMulti, ...d })
  }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        async json(method, urlPath, body) {
          const res = await fetch('http://127.0.0.1:' + port + urlPath, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body != null ? JSON.stringify(body) : undefined
          });
          const data = await res.json().catch(() => ({}));
          return { status: res.status, data };
        },
        close() {
          return new Promise((r) => server.close(() => r()));
        }
      });
    });
  });
}

describe('MBC-14.3 listagem e isolamento', () => {
  it('T01 — listar empresa individual', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas');
    assert.equal(out.status, 200);
    assert.equal(out.data.visao, 'empresa');
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    assert.equal(out.data.contas.length, 1);
    assert.equal(out.data.contas[0].id, ctx.contaA.id);
    assert.equal(out.data.contas[0].empresa_cnpj, CNPJ_A);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T02 — listar todas as empresas', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas?escopo=todas');
    assert.equal(out.status, 200);
    assert.equal(out.data.visao, 'todas');
    assert.equal(out.data.empresa_id, undefined);
    const ids = out.data.contas.map((c) => c.id).sort();
    assert.deepEqual(ids, [ctx.contaA.id, ctx.contaB.id].sort());
    const b = out.data.contas.find((c) => c.id === ctx.contaB.id);
    assert.equal(b.empresa_nome.includes('Filial 3'), true);
    assert.equal(b.empresa_cnpj, CNPJ_B);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T03 — isolamento empresa A', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const lista = await api.json('GET', '/api/bancario/contas');
    assert.equal(lista.data.contas.some((c) => c.id === ctx.contaB.id), false);
    const obt = await api.json('GET', '/api/bancario/contas/' + ctx.contaB.id);
    assert.equal(obt.status, 404);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T04 — isolamento empresa B', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaB.id });
    const lista = await api.json('GET', '/api/bancario/contas');
    assert.equal(lista.data.contas.length, 1);
    assert.equal(lista.data.contas[0].id, ctx.contaB.id);
    const obt = await api.json('GET', '/api/bancario/contas/' + ctx.contaA.id);
    assert.equal(obt.status, 404);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T05 — todas mostra somente empresas autorizadas', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas?escopo=todas');
    assert.equal(out.data.contas.some((c) => c.empresa_id === ctx.empresaC.id), false);
    assert.equal(out.data.contas.some((c) => c.id === ctx.contaC.id), false);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T06 — filtro por empresa', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas?escopo=todas&empresa_id=' + ctx.empresaB.id);
    assert.equal(out.status, 200);
    assert.equal(out.data.visao, 'todas');
    assert.equal(out.data.contas.length, 1);
    assert.equal(out.data.contas[0].id, ctx.contaB.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T07 — empresa não autorizada retorna 403', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas?escopo=todas&empresa_id=' + ctx.empresaC.id);
    assert.equal(out.status, 403);
    assert.equal(out.data.code, 'EMPRESA_NAO_AUTORIZADA');
    await api.close();
    await closeDb(ctx.db);
  });

  it('T08 — empresa enviada no body não supera contexto/autorização', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/contas', {
      instituicao_financeira_id: ctx.inst.id,
      nome: 'Forjada',
      tipo: 'CORRENTE',
      numero: '77',
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 201);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    const todas = await api.json('GET', '/api/bancario/contas?escopo=todas');
    assert.equal(todas.data.contas.filter((c) => c.nome === 'Forjada').length, 1);
    assert.equal(todas.data.contas.find((c) => c.nome === 'Forjada').empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T09 — empresa enviada na query não supera contexto/autorização', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas?empresa_id=' + ctx.empresaB.id);
    assert.equal(out.status, 200);
    assert.equal(out.data.visao, 'empresa');
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    assert.equal(out.data.contas.every((c) => c.empresa_id === ctx.empresaA.id), true);
    await api.close();
    await closeDb(ctx.db);
  });
});

describe('MBC-14.3 criação, edição e principal', () => {
  it('T10 — criar conta em empresa individual', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/contas', {
      instituicao_financeira_id: ctx.inst.id,
      nome: 'Nova A',
      tipo: 'POUPANCA',
      numero: '200'
    });
    assert.equal(out.status, 201);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    assert.ok(out.data.empresa_cnpj);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T11 — criar conta em TODAS exige empresa', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/contas?escopo=todas', {
      instituicao_financeira_id: ctx.inst.id,
      nome: 'Sem empresa',
      tipo: 'CORRENTE',
      numero: '201'
    });
    assert.equal(out.status, 400);
    assert.equal(out.data.code, ERROS.EMPRESA_OBRIGATORIA);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T12 — criar conta em empresa autorizada', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/contas?escopo=todas', {
      instituicao_financeira_id: ctx.inst.id,
      nome: 'Nova B',
      tipo: 'CORRENTE',
      numero: '202',
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 201);
    assert.equal(out.data.empresa_id, ctx.empresaB.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T13 — tentativa de criar em empresa não autorizada', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/contas?escopo=todas', {
      instituicao_financeira_id: ctx.inst.id,
      nome: 'Hack C',
      tipo: 'CORRENTE',
      numero: '203',
      empresa_id: ctx.empresaC.id
    });
    assert.equal(out.status, 403);
    assert.equal(out.data.code, 'EMPRESA_NAO_AUTORIZADA');
    await api.close();
    await closeDb(ctx.db);
  });

  it('T14 — edição mostra empresa/CNPJ', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas/' + ctx.contaA.id);
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    assert.equal(out.data.empresa_cnpj, CNPJ_A);
    assert.ok(out.data.empresa_nome);
    const todas = await api.json('GET', '/api/bancario/contas/' + ctx.contaB.id + '?escopo=todas');
    assert.equal(todas.status, 200);
    assert.equal(todas.data.empresa_id, ctx.empresaB.id);
    assert.equal(todas.data.empresa_cnpj, CNPJ_B);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T15 — não permitir alteração de empresa da conta', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('PUT', '/api/bancario/contas/' + ctx.contaA.id, {
      nome: 'Renomeada',
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    assert.equal(out.data.nome, 'Renomeada');
    await api.close();
    await closeDb(ctx.db);
  });

  it('T16 — principal independente por empresa', async () => {
    const ctx = await setup();
    const a = await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: ctx.contaA.id });
    const b = await ctx.motor.obterConta({ empresaId: ctx.empresaB.id, id: ctx.contaB.id });
    assert.equal(a.principal, true);
    assert.equal(b.principal, true);
    const extraA = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: ctx.inst.id,
      nome: 'Segunda A',
      tipo: 'CORRENTE',
      numero: '300',
      principal: true
    });
    const a1 = await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: ctx.contaA.id });
    const a2 = await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: extraA.id });
    const b2 = await ctx.motor.obterConta({ empresaId: ctx.empresaB.id, id: ctx.contaB.id });
    assert.equal(a1.principal, false);
    assert.equal(a2.principal, true);
    assert.equal(b2.principal, true);
    await closeDb(ctx.db);
  });
});

describe('MBC-14.3 frontend, fallback e regressão', () => {
  it('T17 — troca de contexto limpa dados anteriores', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /cds-empresa-contexto-alterado/);
    assert.match(js, /function onEmpresa/);
    assert.match(js, /vistaTodas = false/);
    assert.match(js, /filtroEmpresaId = ''/);
    assert.match(js, /renderLista\(\[\]\)/);
    assert.match(js, /limparPainelTransacoes/);
    assert.match(js, /Contas bancárias de todas as empresas/);
    assert.match(js, /Contas bancárias da empresa atual/);
    assert.doesNotMatch(js, /Cadastro da empresa atual/);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Empresa \/ CNPJ/);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Todas as empresas/);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /id="mbcModalConta"[^>]*data-bs-backdrop="static"/);
    assert.match(src('frontend/erp/js/contas-bancarias.js'), /backdrop: 'static'/);
  });

  it('T18 — nenhuma empresa utiliza fallback empresa_id=1', () => {
    const arquivos = [
      'backend/motores/bancario/BancarioEmpresaContextoService.js',
      'backend/motores/bancario/services/ContaBancariaService.js',
      'backend/rotas/bancario.js',
      'frontend/erp/js/contas-bancarias.js'
    ];
    arquivos.forEach((rel) => {
      const t = src(rel);
      assert.doesNotMatch(t, /empresa_id\s*=\s*1(?!\d)/);
      assert.doesNotMatch(t, /empresaId\s*=\s*1(?![.\d])/);
      assert.doesNotMatch(t, /empresa_id:\s*1(?!\d)/);
      assert.doesNotMatch(t, /COALESCE\s*\(\s*[^)]*empresa[^)]*,\s*1\s*\)/i);
    });
  });

  it('sprint e docs oficiais', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-14.3-VISAO-MULTIEMPRESA-CONTAS.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/IMPLEMENTACAO_MBC_14_3_RELATORIO.md')));
    assert.doesNotMatch(src('backend/motores/bancario/schema/bancarioSchema.js'), /TODAS/);
  });

  it('regressão estrutural MBC-01 a MBC-14.2', () => {
    assert.match(src('backend/motores/bancario/schema/bancarioSchema.js'), /conta_bancaria/);
    assert.match(src('backend/motores/bancario/schema/bancarioSchema.js'), /empresa_id INTEGER NOT NULL/);
    assert.doesNotMatch(src('backend/rotas/bancario.js'), /INSERT INTO financeiro/);
    assert.equal(src('frontend/erp/js/contas-bancarias.js').includes('CLOUDFLARE'), false);
    assert.equal(src('frontend/erp/js/contas-bancarias.js').includes('access_token'), false);
    assert.match(src('backend/server.js'), /\/api\/bancario/);
    assert.match(src('backend/mercado-pago/oauth-callback-server.js'), /127\.0\.0\.1/);
  });
});
