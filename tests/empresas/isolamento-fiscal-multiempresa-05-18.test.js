'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  salvarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_e) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  const a = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_A,
    razao_social: 'Empresa A 05.18',
    nome_fantasia: 'A'
  }, { db });
  const b = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_B,
    razao_social: 'Empresa B 05.18',
    nome_fantasia: 'B'
  }, { db });
  assert.notStrictEqual(b.id, a.id);
  assert.ok(Number.isInteger(a.id) && a.id > 0);
  assert.ok(Number.isInteger(b.id) && b.id > 0);
  return { db, a, b };
}

function semSegredos(dto) {
  const json = JSON.stringify(dto);
  assert.ok(!json.includes('CSC-A-SECRETO'));
  assert.ok(!json.includes('CSC-B-SECRETO'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_path'));
}

async function test01IsolamentoCscECert() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2,
    uf: 'CE',
    serie: 1,
    numero_atual: 10,
    token_csc: 'CSC-A-SECRETO',
    id_csc: 'ID-A',
    certificado_path: `C:/certs/certificado-empresa-${ctx.a.id}.pfx`,
    certificado_senha: 'senha-a',
    ws_autorizacao: 'https://sefaz.local/a'
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, {
    ambiente: 1,
    uf: 'SP',
    serie: 2,
    numero_atual: 20,
    token_csc: 'CSC-B-SECRETO',
    id_csc: 'ID-B',
    certificado_path: `C:/certs/certificado-empresa-${ctx.b.id}.pfx`,
    certificado_senha: 'senha-b',
    ws_autorizacao: 'https://sefaz.local/b'
  }, { db: ctx.db });

  const dtoA = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  const dtoB = await obterConfiguracaoFiscalEmpresa(ctx.b.id, { db: ctx.db });
  semSegredos(dtoA);
  semSegredos(dtoB);
  assert.strictEqual(dtoA.empresa_id, ctx.a.id);
  assert.strictEqual(dtoB.empresa_id, ctx.b.id);
  assert.notStrictEqual(dtoA.uf, dtoB.uf);
  assert.notStrictEqual(dtoA.serie, dtoB.serie);
  assert.notStrictEqual(dtoA.certificado_nome, dtoB.certificado_nome);
  assert.strictEqual(dtoA.csc_configurado, true);
  assert.strictEqual(dtoB.csc_configurado, true);

  const rowA = await get(ctx.db, 'SELECT token_csc, certificado_path FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.a.id]);
  const rowB = await get(ctx.db, 'SELECT token_csc, certificado_path FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.b.id]);
  assert.strictEqual(rowA.token_csc, 'CSC-A-SECRETO');
  assert.strictEqual(rowB.token_csc, 'CSC-B-SECRETO');
  assert.notStrictEqual(rowA.certificado_path, rowB.certificado_path);

  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { token_csc: 'CSC-A-NOVO' }, { db: ctx.db });
  const rowA2 = await get(ctx.db, 'SELECT token_csc FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.a.id]);
  const rowB2 = await get(ctx.db, 'SELECT token_csc FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.b.id]);
  assert.strictEqual(rowA2.token_csc, 'CSC-A-NOVO');
  assert.strictEqual(rowB2.token_csc, 'CSC-B-SECRETO');

  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    certificado_path: `C:/certs/certificado-empresa-${ctx.a.id}-novo.pfx`
  }, { db: ctx.db });
  const rowA3 = await get(ctx.db, 'SELECT certificado_path FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.a.id]);
  const rowB3 = await get(ctx.db, 'SELECT certificado_path FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.b.id]);
  assert.ok(String(rowA3.certificado_path).includes(`-${ctx.a.id}-novo`));
  assert.ok(String(rowB3.certificado_path).includes(`certificado-empresa-${ctx.b.id}.pfx`));

  await closeDb(ctx.db);
}

async function test02PutVazioNaoApagaCsc() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2,
    serie: 1,
    token_csc: 'CSC-A-SECRETO',
    id_csc: 'ID-A'
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { serie: 7 }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT token_csc, serie FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.a.id]);
  assert.strictEqual(row.token_csc, 'CSC-A-SECRETO');
  assert.strictEqual(Number(row.serie), 7);
  await closeDb(ctx.db);
}

async function test03NaoAssumeEmpresaUm() {
  const ctx = await setup();
  assert.ok(ctx.a.id > 0);
  assert.ok(ctx.b.id > 0);
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, {
    ambiente: 2,
    serie: 3,
    token_csc: 'CSC-B-SECRETO',
    id_csc: 'ID-B'
  }, { db: ctx.db });
  const row1 = await get(ctx.db, 'SELECT token_csc FROM empresas_configuracao_fiscal WHERE empresa_id = 1');
  assert.strictEqual(row1, null);
  await closeDb(ctx.db);
}

async function main() {
  const testes = [
    ['01 isolamento CSC e certificado A≠B', test01IsolamentoCscECert],
    ['02 PUT parcial preserva CSC', test02PutVazioNaoApagaCsc],
    ['03 sem fallback empresa 1', test03NaoAssumeEmpresaUm]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nisolamento-fiscal-multiempresa-05-18: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
