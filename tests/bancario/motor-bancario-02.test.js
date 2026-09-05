/**
 * Sprint MBC-02 — instituições e contas bancárias.
 * Executar: node --test tests/bancario/motor-bancario-02.test.js
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

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
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
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  const motor = obterMotorBancario({ db });
  const depsMulti = {
    db,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA
  };
  return { db, empresaA, empresaB, motor, depsMulti };
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

describe('MBC-02 instituições', () => {
  it('T01 — criar instituição', async () => {
    const ctx = await setup();
    const criada = await ctx.motor.criarInstituicao({ nome: 'Sicredi', nome_reduzido: 'Sicredi', codigo: '748' });
    assert.equal(criada.nome, 'Sicredi');
    assert.equal(criada.codigo, '748');
    assert.equal(criada.ativo, true);
    await closeDb(ctx.db);
  });

  it('T02 — listar instituições', async () => {
    const ctx = await setup();
    await ctx.motor.criarInstituicao({ nome: 'Sicredi', codigo: '748' });
    const lista = await ctx.motor.listarInstituicoes();
    assert.equal(lista.length, 1);
    await closeDb(ctx.db);
  });

  it('T03 — consultar instituição', async () => {
    const ctx = await setup();
    const criada = await ctx.motor.criarInstituicao({ nome: 'Sicredi', codigo: '748' });
    const obt = await ctx.motor.obterInstituicao({ id: criada.id });
    assert.equal(obt.id, criada.id);
    await closeDb(ctx.db);
  });

  it('T04 — atualizar instituição', async () => {
    const ctx = await setup();
    const criada = await ctx.motor.criarInstituicao({ nome: 'Sicredi', codigo: '748' });
    const upd = await ctx.motor.atualizarInstituicao({ id: criada.id, nome: 'Sicredi RS' });
    assert.equal(upd.nome, 'Sicredi RS');
    await closeDb(ctx.db);
  });

  it('T05 — rejeitar nome vazio', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.criarInstituicao({ nome: '   ' }),
      (err) => err.code === ERROS.NOME_OBRIGATORIO && err.statusCode === 400
    );
    await closeDb(ctx.db);
  });

  it('T06 — rejeitar código duplicado', async () => {
    const ctx = await setup();
    await ctx.motor.criarInstituicao({ nome: 'A', codigo: '001' });
    await assert.rejects(
      () => ctx.motor.criarInstituicao({ nome: 'B', codigo: '001' }),
      (err) => err.code === ERROS.CODIGO_DUPLICADO && err.statusCode === 409
    );
    await closeDb(ctx.db);
  });

  it('T07 — permitir código NULL', async () => {
    const ctx = await setup();
    const a = await ctx.motor.criarInstituicao({ nome: 'Sem código' });
    const b = await ctx.motor.criarInstituicao({ nome: 'Também sem' });
    assert.equal(a.codigo, null);
    assert.equal(b.codigo, null);
    await closeDb(ctx.db);
  });

  it('T08 — impedir exclusão de instituição vinculada', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'BB', codigo: '001' });
    await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'Conta A',
      tipo: 'CORRENTE',
      numero: '123'
    });
    await assert.rejects(
      () => ctx.motor.excluirInstituicao({ id: inst.id }),
      (err) => err.code === ERROS.CONFLITO_EXCLUSAO && err.statusCode === 409
    );
    await closeDb(ctx.db);
  });
});

describe('MBC-02 contas', () => {
  it('T09 — criar conta', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Itaú', codigo: '341' });
    const conta = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'Conta Principal',
      tipo: 'CORRENTE',
      agencia: '1234',
      numero: '56789',
      digito: '0'
    });
    assert.equal(conta.empresa_id, ctx.empresaA.id);
    assert.equal(conta.numero, '56789');
    await closeDb(ctx.db);
  });

  it('T10 — listar contas da empresa', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Itaú', codigo: '341' });
    await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'Conta Principal',
      tipo: 'CORRENTE',
      numero: '56789'
    });
    const lista = await ctx.motor.listarContas({ empresaId: ctx.empresaA.id });
    assert.equal(lista.length, 1);
    await closeDb(ctx.db);
  });

  it('T11 — consultar conta', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Itaú', codigo: '341' });
    const conta = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'Conta Principal',
      tipo: 'CORRENTE',
      numero: '56789'
    });
    const obt = await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(obt.nome, 'Conta Principal');
    await closeDb(ctx.db);
  });

  it('T12 — atualizar conta', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Itaú', codigo: '341' });
    const conta = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'Conta Principal',
      tipo: 'CORRENTE',
      numero: '56789'
    });
    const upd = await ctx.motor.atualizarConta({
      empresaId: ctx.empresaA.id,
      id: conta.id,
      nome: 'Conta Operacional'
    });
    assert.equal(upd.nome, 'Conta Operacional');
    await closeDb(ctx.db);
  });

  it('T13 T14 — ativar e desativar (desativar tira principal)', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Caixa', codigo: '104' });
    const conta = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'C1',
      tipo: 'POUPANCA',
      numero: '1',
      principal: true
    });
    assert.equal(conta.principal, true);
    const off = await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(off.ativa, false);
    assert.equal(off.principal, false);
    const on = await ctx.motor.ativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(on.ativa, true);
    assert.equal(on.principal, false);
    await closeDb(ctx.db);
  });

  it('T15 T16 — uma principal por empresa', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Bradesco', codigo: '237' });
    const c1 = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'C1',
      tipo: 'CORRENTE',
      numero: '1',
      principal: true
    });
    const c2 = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'C2',
      tipo: 'PAGAMENTO',
      numero: '2',
      principal: true
    });
    const a = await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: c1.id });
    const b = await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: c2.id });
    assert.equal(a.principal, false);
    assert.equal(b.principal, true);
    await ctx.motor.definirContaPrincipal({ empresaId: ctx.empresaA.id, id: c1.id });
    const a2 = await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: c1.id });
    const b2 = await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: c2.id });
    assert.equal(a2.principal, true);
    assert.equal(b2.principal, false);
    await closeDb(ctx.db);
  });

  it('T17 T22 — empresa A não enxerga conta da B (404)', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Santander', codigo: '033' });
    const contaB = await ctx.motor.criarConta({
      empresaId: ctx.empresaB.id,
      instituicao_financeira_id: inst.id,
      nome: 'Só B',
      tipo: 'CORRENTE',
      numero: '999'
    });
    const listaA = await ctx.motor.listarContas({ empresaId: ctx.empresaA.id });
    assert.equal(listaA.length, 0);
    await assert.rejects(
      () => ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: contaB.id }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA && err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T19 T20 — instituição inexistente e inativa rejeitadas', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.criarConta({
        empresaId: ctx.empresaA.id,
        instituicao_financeira_id: 99999,
        nome: 'X',
        tipo: 'CORRENTE',
        numero: '1'
      }),
      (err) => err.code === ERROS.INSTITUICAO_NAO_ENCONTRADA
    );
    const inst = await ctx.motor.criarInstituicao({ nome: 'Inativa', codigo: '999' });
    await ctx.motor.atualizarInstituicao({ id: inst.id, ativo: false });
    await assert.rejects(
      () => ctx.motor.criarConta({
        empresaId: ctx.empresaA.id,
        instituicao_financeira_id: inst.id,
        nome: 'X',
        tipo: 'CORRENTE',
        numero: '1'
      }),
      (err) => err.code === ERROS.INSTITUICAO_INATIVA && err.statusCode === 400
    );
    await closeDb(ctx.db);
  });

  it('tipo inválido', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Nubank' });
    await assert.rejects(
      () => ctx.motor.criarConta({
        empresaId: ctx.empresaA.id,
        instituicao_financeira_id: inst.id,
        nome: 'X',
        tipo: 'INVESTIMENTO',
        numero: '1'
      }),
      (err) => err.code === ERROS.TIPO_INVALIDO
    );
    await closeDb(ctx.db);
  });
});

describe('MBC-02 HTTP multiempresa', () => {
  it('T18 — usuário sem autorização recebe 403', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 2, empresaId: ctx.empresaB.id });
    const out = await api.json('GET', '/api/bancario/contas');
    assert.equal(out.status, 403);
    assert.equal(out.data.code, 'EMPRESA_NAO_AUTORIZADA');
    await api.close();
    await closeDb(ctx.db);
  });

  it('T21 — empresa_id do body não escapa do contexto', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Inter' });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/contas', {
      instituicao_financeira_id: inst.id,
      nome: 'Forjada',
      tipo: 'CORRENTE',
      numero: '77',
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 201);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T23 T24 — edição e principal de outra empresa são 404', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Sicoob' });
    const contaB = await ctx.motor.criarConta({
      empresaId: ctx.empresaB.id,
      instituicao_financeira_id: inst.id,
      nome: 'B',
      tipo: 'CORRENTE',
      numero: '8'
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const put = await api.json('PUT', '/api/bancario/contas/' + contaB.id, { nome: 'Hack' });
    assert.equal(put.status, 404);
    const prin = await api.json('PATCH', '/api/bancario/contas/' + contaB.id + '/principal');
    assert.equal(prin.status, 404);
    const aindaB = await ctx.motor.obterConta({ empresaId: ctx.empresaB.id, id: contaB.id });
    assert.equal(aindaB.nome, 'B');
    assert.equal(aindaB.principal, false);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T25 — exclusão segura com dependência futura', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'Banrisul' });
    const conta = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'Livre',
      tipo: 'OUTRA',
      numero: '10'
    });
    await ctx.motor.excluirConta({ empresaId: ctx.empresaA.id, id: conta.id });
    await assert.rejects(
      () => ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA
    );
    const c2 = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'Com dep',
      tipo: 'CORRENTE',
      numero: '11'
    });
    await run(
      ctx.db,
      `INSERT INTO transacao_bancaria (
        empresa_id, conta_bancaria_id, data_transacao, valor, direcao, tipo
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [ctx.empresaA.id, c2.id, '2026-09-01T10:00:00', 10, 'entrada', 'OUTROS']
    );
    await assert.rejects(
      () => ctx.motor.excluirConta({ empresaId: ctx.empresaA.id, id: c2.id }),
      (err) => err.code === ERROS.CONFLITO_EXCLUSAO && err.statusCode === 409
    );
    await closeDb(ctx.db);
  });
});

describe('MBC-02 invariantes', () => {
  it('schema sem credenciais; financeiro/vendas não alterados por esta rota', () => {
    const schema = src('backend/motores/bancario/schema/bancarioSchema.js');
    assert.match(schema, /instituicao_financeira/);
    assert.match(schema, /conta_bancaria/);
    assert.match(schema, /empresa_id INTEGER NOT NULL/);
    assert.doesNotMatch(schema, /client_secret|access_token|refresh_token|oauth/i);
    assert.doesNotMatch(src('backend/rotas/bancario.js'), /INSERT INTO financeiro/);
    assert.match(src('backend/server.js'), /\/api\/bancario/);
    assert.match(src('backend/rotas/bancario.js'), /empresaId/);
    assert.doesNotMatch(src('backend/motores/bancario/services/ContaBancariaService.js'), /empresa_id = 1/);
  });
});
