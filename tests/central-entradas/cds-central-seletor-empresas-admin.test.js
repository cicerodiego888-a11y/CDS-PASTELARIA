/**
 * Seletor de empresas — ADMIN operacional sem role admin.
 * Banco em memória. Não grava vínculo e não abre o banco oficial.
 * Executar: node --test --test-concurrency=1 tests/central-entradas/cds-central-seletor-empresas-admin.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
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

async function montar() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await run(db, `CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT)`);
  await run(db, `INSERT INTO usuarios (id, username) VALUES (1, 'super'), (2, 'diego'), (3, 'comum'), (4, 'semvinculo')`);
  const empresaA = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_A,
    razao_social: 'Empresa A',
    nome_fantasia: 'A'
  }, { db });
  const empresaB = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_B,
    razao_social: 'Empresa B',
    nome_fantasia: 'B'
  }, { db });
  await run(
    db,
    `INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo) VALUES ('00000000000000', 'Inativa', 'Inativa', 0)`
  );
  const inativa = await get(db, `SELECT id FROM empresas WHERE razao_social = 'Inativa'`);
  await UsuarioEmpresaService.vincularUsuarioEmpresa(3, { empresaId: empresaA.id }, { db });
  return {
    db,
    empresaA,
    empresaB,
    inativaId: Number(inativa.id),
    superAdmin: { id: 1, role: 'admin', perfil: 'SUPER_ADMIN' },
    diego: { id: 2, role: 'operador', perfil: 'ADMIN' },
    comum: { id: 3, role: 'operador', perfil: 'USUARIO' },
    semVinculo: { id: 4, role: 'operador', perfil: 'USUARIO' }
  };
}

function idsDe(lista) {
  return lista.map((empresa) => Number(empresa.id)).sort((a, b) => a - b);
}

describe('Seletor de empresas do ADMIN', () => {
  it('SUPER ADMIN vê as empresas ativas e não vê a inativa', async () => {
    const ctx = await montar();
    const lista = await EmpresaService.listarEmpresasDisponiveis({ db: ctx.db, user: ctx.superAdmin });
    assert.deepEqual(idsDe(lista), [ctx.empresaA.id, ctx.empresaB.id].sort((a, b) => a - b));
    assert.ok(!idsDe(lista).includes(ctx.inativaId));
    const selecionada = await EmpresaService.selecionarEmpresaContexto(ctx.empresaB.id, {
      db: ctx.db,
      user: ctx.superAdmin
    });
    assert.equal(selecionada.id, ctx.empresaB.id);
    ctx.db.close();
  });

  it('ADMIN com role operador vê as mesmas empresas ativas, sem vínculo gravado', async () => {
    const ctx = await montar();
    const lista = await EmpresaService.listarEmpresasDisponiveis({ db: ctx.db, user: ctx.diego });
    assert.deepEqual(idsDe(lista), [ctx.empresaA.id, ctx.empresaB.id].sort((a, b) => a - b));
    const vinculos = await get(
      ctx.db,
      `SELECT COUNT(*) AS total FROM usuario_empresas WHERE usuario_id = ?`,
      [ctx.diego.id]
    );
    assert.equal(Number(vinculos.total), 0);
    const selecionada = await EmpresaService.selecionarEmpresaContexto(ctx.empresaA.id, {
      db: ctx.db,
      user: ctx.diego
    });
    assert.equal(selecionada.id, ctx.empresaA.id);
    const trocada = await EmpresaService.selecionarEmpresaContexto(ctx.empresaB.id, {
      db: ctx.db,
      user: ctx.diego
    });
    assert.equal(trocada.id, ctx.empresaB.id);
    await assert.rejects(
      () => EmpresaService.selecionarEmpresaContexto(ctx.inativaId, { db: ctx.db, user: ctx.diego }),
      (err) => err && err.code === 'EMPRESA_INATIVA'
    );
    ctx.db.close();
  });

  it('usuário comum fica nos próprios vínculos e quem não tem vínculo não recebe empresa', async () => {
    const ctx = await montar();
    const doComum = await EmpresaService.listarEmpresasDisponiveis({ db: ctx.db, user: ctx.comum });
    assert.deepEqual(idsDe(doComum), [ctx.empresaA.id]);
    await assert.rejects(
      () => EmpresaService.selecionarEmpresaContexto(ctx.empresaB.id, { db: ctx.db, user: ctx.comum }),
      (err) => err && err.code === 'EMPRESA_NAO_AUTORIZADA'
    );

    const vazio = await EmpresaService.listarEmpresasDisponiveis({ db: ctx.db, user: ctx.semVinculo });
    assert.deepEqual(vazio, []);
    await assert.rejects(
      () => EmpresaService.selecionarEmpresaContexto(ctx.empresaA.id, { db: ctx.db, user: ctx.semVinculo }),
      (err) => err && err.code === 'EMPRESA_NAO_AUTORIZADA'
    );
    ctx.db.close();
  });

  it('visão consolidada do ADMIN reúne só as ativas; a do usuário comum não passa do vínculo', async () => {
    const ctx = await montar();
    const admin = await UsuarioEmpresaService.listarEmpresasPermitidas(ctx.diego, { db: ctx.db });
    const comum = await UsuarioEmpresaService.listarEmpresasPermitidas(ctx.comum, { db: ctx.db });
    assert.deepEqual(idsDe(admin), [ctx.empresaA.id, ctx.empresaB.id].sort((a, b) => a - b));
    assert.deepEqual(idsDe(comum), [ctx.empresaA.id]);
    assert.ok(!idsDe(admin).includes(ctx.inativaId));
    ctx.db.close();
  });

  it('a tela mostra “0 empresas ativas” quando a lista autorizada vem vazia', () => {
    const fonte = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/central-entradas.js'),
      'utf8'
    );
    const bloco = fonte.slice(
      fonte.indexOf('function renderAreaEmpresasCentral'),
      fonte.indexOf('async function aplicarVistaEmpresaCentral')
    );
    assert.ok(bloco.includes('Todas as empresas'));
    assert.ok(bloco.includes("empresa${n === 1 ? '' : 's'} ativas"));
    assert.ok(bloco.includes('empresasParaAreaCentral()'));
    assert.equal(bloco.includes("role === 'admin'"), false);
  });
});
