/**
 * Sprint 04.09 — gestão administrativa da configuração fiscal por empresa.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  STATUS_FISCAL_ADMIN,
  salvarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa,
  obterStatusFiscalEmpresa,
  listarStatusFiscalEmpresas,
  removerConfiguracaoFiscalEmpresa,
  validarConfiguracaoFiscalEmpresa,
  exigirEmpresaAlvoAdministrativo,
  incrementaNumeroFiscalEmpresa
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { getFiscalConfig, incrementaNumeroFiscal } = require('../../backend/services/fiscal/configService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_C = '65957340000150';

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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava ${code}`);
  } catch (err) {
    if (err.message === `Esperava ${code}`) throw err;
    assert.strictEqual(err.code || err.codigo, code, err.message);
  }
}

function configCompleta(tag) {
  return {
    ambiente: 2,
    serie: 1,
    token_csc: `CSC-SECRETO-${tag}`,
    id_csc: `ID-${tag}`,
    certificado_path: `C:/certs/certificado-empresa-${tag}.pfx`,
    certificado_senha: `senha-secreta-${tag}`,
    ws_autorizacao: `https://sefaz.local/${tag}/auth`
  };
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE configuracoes (chave TEXT PRIMARY KEY, valor TEXT, tipo TEXT, descricao TEXT, updated_at DATETIME)`);
  await run(db, `
    CREATE TABLE nfce_notas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER, numero INTEGER, serie INTEGER, ambiente INTEGER, empresa_id INTEGER
    )
  `);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  const c = await EmpresaService.criarEmpresa({ cnpj: CNPJ_C, razao_social: 'C' }, { db });
  return { db, a, b, c };
}

function semSegredos(dto) {
  const json = JSON.stringify(dto);
  assert.ok(!json.includes('senha-secreta'));
  assert.ok(!json.includes('CSC-SECRETO'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_path'));
}

async function test01SalvaA() {
  const ctx = await setup();
  const dto = await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  assert.strictEqual(dto.empresa_id, ctx.a.id);
  assert.strictEqual(dto.status, STATUS_FISCAL_ADMIN.PRONTA);
  await closeDb(ctx.db);
}

async function test02BNaoRecebeA() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  const b = await obterConfiguracaoFiscalEmpresa(ctx.b.id, { db: ctx.db });
  assert.strictEqual(b.configurada, false);
  assert.strictEqual(b.csc_configurado, false);
  await closeDb(ctx.db);
}

async function test03CNaoRecebeAB() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, configCompleta('b'), { db: ctx.db });
  const c = await obterConfiguracaoFiscalEmpresa(ctx.c.id, { db: ctx.db });
  assert.strictEqual(c.configurada, false);
  await closeDb(ctx.db);
}

async function test04UpdateANaoMudaB() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, configCompleta('b'), { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { serie: 9 }, { db: ctx.db });
  const a = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  const b = await obterConfiguracaoFiscalEmpresa(ctx.b.id, { db: ctx.db });
  assert.strictEqual(a.serie, 9);
  assert.strictEqual(b.serie, 1);
  assert.strictEqual(b.certificado_nome, 'certificado-empresa-b.pfx');
  await closeDb(ctx.db);
}

async function test05ParcialSalva() {
  const ctx = await setup();
  const dto = await salvarConfiguracaoFiscalEmpresa(ctx.b.id, {
    ambiente: 2,
    serie: 1,
    token_csc: 'CSC-PARCIAL',
    id_csc: '1'
  }, { db: ctx.db });
  assert.strictEqual(dto.configurada, true);
  await closeDb(ctx.db);
}

async function test06ParcialIncompleta() {
  const ctx = await setup();
  const st = await salvarConfiguracaoFiscalEmpresa(ctx.b.id, {
    ambiente: 2, serie: 1, token_csc: 'X', id_csc: '1'
  }, { db: ctx.db });
  assert.strictEqual(st.status, STATUS_FISCAL_ADMIN.INCOMPLETA);
  assert.strictEqual(st.campos.certificado, false);
  await closeDb(ctx.db);
}

async function test07CompletaPronta() {
  const ctx = await setup();
  const dto = await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  assert.strictEqual(dto.status, 'PRONTA');
  assert.ok(dto.campos.ambiente && dto.campos.csc && dto.campos.certificado && dto.campos.sefaz);
  await closeDb(ctx.db);
}

async function test08Invalida() {
  const ctx = await setup();
  await assertRejects(
    salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ambiente: 9 }, { db: ctx.db }),
    'CONFIGURACAO_FISCAL_EMPRESA_INVALIDA'
  );
  assert.strictEqual(validarConfiguracaoFiscalEmpresa(ctx.a.id, { serie: 1 }).valida, true);
  await closeDb(ctx.db);
}

async function test09SemConfigNaoUsaGlobal() {
  const ctx = await setup();
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ambiente', '2')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_token_csc', 'GLOBAL-CSC')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('cnpj', '00000000000000')`);
  await assertRejects(
    getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false }),
    'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE'
  );
  await closeDb(ctx.db);
}

async function test10SemEmpresa1() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/services/fiscal/empresasConfiguracaoFiscal.js'),
    'utf8'
  );
  assert.ok(!src.includes('empresaId === 1') && !src.includes('empresa_id = 1'));
}

async function test11SemOutraEmpresa() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, configCompleta('b'), { db: ctx.db });
  await assertRejects(
    getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false }),
    'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE'
  );
  await closeDb(ctx.db);
}

async function test12GetSemSenha() {
  const ctx = await setup();
  const dto = await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  semSegredos(dto);
  await closeDb(ctx.db);
}

async function test13GetSemCscCompleto() {
  const ctx = await setup();
  const dto = await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  const json = JSON.stringify(dto);
  assert.ok(!json.includes('CSC-SECRETO-a'));
  assert.strictEqual(dto.csc_configurado, true);
  await closeDb(ctx.db);
}

async function test14GetSemSegredoCert() {
  const ctx = await setup();
  const dto = await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  assert.strictEqual(dto.certificado_nome, 'certificado-empresa-a.pfx');
  assert.ok(!JSON.stringify(dto).includes('senha-secreta-a'));
  await closeDb(ctx.db);
}

async function test15RotaBodyDivergente() {
  assert.throws(
    () => exigirEmpresaAlvoAdministrativo(2, { empresa_id: 3 }),
    (err) => err.code === 'EMPRESA_CONFIGURACAO_DIVERGENTE'
  );
}

async function test16ResolveA() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  const cfg = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.fonte, 'EMPRESA');
  assert.strictEqual(cfg.cnpj, CNPJ_A);
  assert.strictEqual(cfg.tokenCSC, 'CSC-SECRETO-a');
  await closeDb(ctx.db);
}

async function test17ResolveB() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, configCompleta('b'), { db: ctx.db });
  const cfg = await getFiscalConfig({ empresaId: ctx.b.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.cnpj, CNPJ_B);
  assert.strictEqual(cfg.certificadoPath, 'C:/certs/certificado-empresa-b.pfx');
  await closeDb(ctx.db);
}

async function test18ResolveC() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.c.id, configCompleta('c'), { db: ctx.db });
  const cfg = await getFiscalConfig({ empresaId: ctx.c.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.cnpj, CNPJ_C);
  await closeDb(ctx.db);
}

async function test19EmpresaUnicaGlobal() {
  const ctx = await setup();
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ambiente', '2')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('nome_empresa', 'Legado')`);
  const cfg = await getFiscalConfig({ db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.fonte, 'GLOBAL');
  await closeDb(ctx.db);
}

async function test20NumeracaoIsolada() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ...configCompleta('a'), numero_atual: 100 }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, { ...configCompleta('b'), numero_atual: 100 }, { db: ctx.db });
  const nA = await incrementaNumeroFiscalEmpresa(ctx.a.id, ctx.db);
  const nB = await incrementaNumeroFiscalEmpresa(ctx.b.id, ctx.db);
  assert.strictEqual(nA, 100);
  assert.strictEqual(nB, 100);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_numero_atual', '7')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_serie', '1')`);
  await run(ctx.db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ambiente', '2')`);
  const nG = await incrementaNumeroFiscal({ db: ctx.db });
  assert.strictEqual(nG, 7);
  await closeDb(ctx.db);
}

async function test21RollbackPersistencia() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ambiente: 2, serie: 1 }, { db: ctx.db });
  await assertRejects(
    salvarConfiguracaoFiscalEmpresa(ctx.a.id, { serie: 5, token_csc: 'NOVO' }, {
      db: ctx.db,
      aposPersistir() {
        const err = new Error('falha composta');
        err.code = 'CONFIGURACAO_FISCAL_EMPRESA_INVALIDA';
        throw err;
      }
    }),
    'CONFIGURACAO_FISCAL_EMPRESA_INVALIDA'
  );
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.strictEqual(dto.serie, 1);
  assert.strictEqual(dto.csc_configurado, false);
  await closeDb(ctx.db);
}

async function test22ListarStatus() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  const lista = await listarStatusFiscalEmpresas({ db: ctx.db });
  assert.strictEqual(lista.length, 3);
  assert.strictEqual(lista.find((x) => x.empresa_id === ctx.a.id).status, 'PRONTA');
  assert.strictEqual(lista.find((x) => x.empresa_id === ctx.b.id).status, 'INCOMPLETA');
  await closeDb(ctx.db);
}

async function test23Remover() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  await removerConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.strictEqual(dto.configurada, false);
  await closeDb(ctx.db);
}

async function test24Desativada() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, configCompleta('a'), { db: ctx.db });
  await EmpresaService.inativarEmpresa(ctx.a.id, { db: ctx.db });
  const st = await obterStatusFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.strictEqual(st.status, STATUS_FISCAL_ADMIN.DESATIVADA);
  await closeDb(ctx.db);
}

async function test25RotasEmpresas() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/rotas/empresas.js'),
    'utf8'
  );
  assert.ok(src.includes('/:empresaId/configuracao-fiscal'));
  assert.ok(src.includes('/configuracao-fiscal/status'));
  assert.ok(!src.includes('CertificadoMultiempresaService'));
}

async function test26MuvSemSegredo() {
  const fs = require('fs');
  const dir = path.join(__dirname, '../../backend/motores/muv');
  function arquivosJs(base, prefix = '') {
    const out = [];
    for (const nome of fs.readdirSync(base)) {
      const full = path.join(base, nome);
      const rel = prefix ? `${prefix}/${nome}` : nome;
      if (fs.statSync(full).isDirectory()) out.push(...arquivosJs(full, rel));
      else if (nome.endsWith('.js')) out.push({ rel, full });
    }
    return out;
  }
  for (const arq of arquivosJs(dir)) {
    const src = fs.readFileSync(arq.full, 'utf8');
    assert.ok(!/token_csc|certificado_senha|fiscal_token_csc/.test(src), arq.rel);
  }
}

async function main() {
  const testes = [
    ['01 salva A', test01SalvaA],
    ['02 B não recebe A', test02BNaoRecebeA],
    ['03 C não recebe A/B', test03CNaoRecebeAB],
    ['04 update A não altera B', test04UpdateANaoMudaB],
    ['05 parcial salva', test05ParcialSalva],
    ['06 parcial INCOMPLETA', test06ParcialIncompleta],
    ['07 completa PRONTA', test07CompletaPronta],
    ['08 inválida explícita', test08Invalida],
    ['09 sem config não usa global', test09SemConfigNaoUsaGlobal],
    ['10 sem empresa 1', test10SemEmpresa1],
    ['11 sem config de outra', test11SemOutraEmpresa],
    ['12 GET sem senha', test12GetSemSenha],
    ['13 GET sem CSC completo', test13GetSemCscCompleto],
    ['14 GET sem segredo do certificado', test14GetSemSegredoCert],
    ['15 rota 2 + body 3 rejeitado', test15RotaBodyDivergente],
    ['16 operação A resolve A', test16ResolveA],
    ['17 operação B resolve B', test17ResolveB],
    ['18 operação C resolve C', test18ResolveC],
    ['19 EMPRESA_UNICA global', test19EmpresaUnicaGlobal],
    ['20 numeração isolada', test20NumeracaoIsolada],
    ['21 rollback persistência composta', test21RollbackPersistencia],
    ['22 listar status', test22ListarStatus],
    ['23 remover', test23Remover],
    ['24 empresa inativa DESATIVADA', test24Desativada],
    ['25 rotas oficiais empresas', test25RotasEmpresas],
    ['26 MUV sem CSC/senha', test26MuvSemSegredo]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nconfiguracao-fiscal-multiempresa-04-09: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
