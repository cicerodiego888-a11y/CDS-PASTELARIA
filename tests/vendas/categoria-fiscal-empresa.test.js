/**
 * Sprint 1 Motor de Vendas — categoria fiscal lógica por empresa. Banco :memory:.
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const Svc = require('../../backend/services/vendas/CategoriaFiscalEmpresaService');

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
  return new Promise((resolve, reject) => db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r || null))));
}
async function rejeita(p, code) {
  try {
    await p;
  } catch (e) {
    assert.strictEqual(e.code, code, `esperado ${code}, obtido ${e.code}`);
    return;
  }
  assert.fail(`esperava erro ${code}`);
}

async function main() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, categoria TEXT, unidade TEXT,
    tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
    saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0)`);
  const ins = (nome, cat, un, tipo) =>
    run(db, `INSERT INTO produtos (nome, categoria, unidade, tipo_operacional, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
             VALUES (?, ?, ?, ?, 7, 3, 10)`, [nome, cat, un, tipo]).then((r) => r.lastID);
  const coca = await ins('Coca-Cola 2L', 'Refrigerantes', 'ML', 'COMERCIAL');
  const fanta = await ins('Fanta Laranja Lata', 'Refrigerantes', 'ML', 'COMERCIAL');
  const agua = await ins('Água Mineral 500ml', 'Águas', 'ML', 'COMERCIAL');
  const semVinculo = await ins('Refrigerante Genérico Cajuína', 'Refrigerantes', 'ML', 'COMERCIAL');
  const insumo = await ins('Xarope Cola', 'Refrigerantes', 'ML', 'INSUMO');
  const A = (await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A' }, { db })).id;
  const B = (await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'B' }, { db })).id;
  const antes = await get(db, 'SELECT * FROM produtos WHERE id = ?', [coca]);
  const totalAntes = await get(db, 'SELECT COUNT(*) n FROM produtos');

  // 1 categorias REFRIGERANTE e AGUA; padrão não elegível
  const v1 = await Svc.definirVinculo({ empresaId: A, produtoId: coca, categoriaFiscal: 'refrigerante' }, { db });
  assert.strictEqual(v1.categoria_fiscal, 'REFRIGERANTE');
  assert.strictEqual(v1.elegivel_composicao, false);
  await Svc.definirVinculo({ empresaId: A, produtoId: fanta, categoriaFiscal: 'REFRIGERANTE', elegivelComposicao: true }, { db });
  await Svc.definirVinculo({ empresaId: A, produtoId: agua, categoriaFiscal: 'AGUA', elegivelComposicao: true }, { db });
  await rejeita(Svc.definirVinculo({ empresaId: A, produtoId: coca, categoriaFiscal: 'SUCO' }, { db }), 'CATEGORIA_FISCAL_INVALIDA');
  await rejeita(Svc.definirVinculo({ empresaId: A, produtoId: coca }, { db }), 'CATEGORIA_FISCAL_OBRIGATORIA');
  console.log('ok categorias REFRIGERANTE/AGUA e validação');

  // 2 vínculo existente mas elegibilidade desativada => não elegível; ativar/desativar
  assert.strictEqual(await Svc.produtoEhElegivel({ empresaId: A, produtoId: coca }, { db }), false);
  await Svc.definirElegibilidade({ empresaId: A, produtoId: coca, elegivelComposicao: true }, { db });
  assert.strictEqual(await Svc.produtoEhElegivel({ empresaId: A, produtoId: coca }, { db }), true);
  await Svc.definirElegibilidade({ empresaId: A, produtoId: coca, elegivelComposicao: false }, { db });
  assert.strictEqual(await Svc.produtoEhElegivel({ empresaId: A, produtoId: coca }, { db }), false);
  await rejeita(Svc.definirElegibilidade({ empresaId: A, produtoId: semVinculo, elegivelComposicao: true }, { db }), 'VINCULO_NAO_ENCONTRADO');
  console.log('ok ativar/desativar elegibilidade');

  // 3 produto sem categoria explícita (nome/marca/categoria comercial iguais) não é elegível
  assert.strictEqual(await Svc.produtoEhElegivel({ empresaId: A, produtoId: semVinculo }, { db }), false);
  assert.strictEqual(await Svc.obterVinculo({ empresaId: A, produtoId: semVinculo }, { db }), null);
  console.log('ok sem vínculo explícito não elegível');

  // 4 insumo não vira elegível
  await rejeita(Svc.definirVinculo({ empresaId: A, produtoId: insumo, categoriaFiscal: 'REFRIGERANTE', elegivelComposicao: true }, { db }), 'INSUMO_NAO_ELEGIVEL');
  assert.strictEqual(await Svc.produtoEhElegivel({ empresaId: A, produtoId: insumo }, { db }), false);
  // insumo reclassificado depois do vínculo deixa de ser elegível
  await run(db, `UPDATE produtos SET tipo_operacional='INSUMO' WHERE id = ?`, [fanta]);
  assert.strictEqual(await Svc.produtoEhElegivel({ empresaId: A, produtoId: fanta }, { db }), false);
  await run(db, `UPDATE produtos SET tipo_operacional='COMERCIAL' WHERE id = ?`, [fanta]);
  console.log('ok insumo não elegível');

  // 5 isolamento por empresa
  assert.strictEqual(await Svc.produtoEhElegivel({ empresaId: B, produtoId: fanta }, { db }), false);
  await Svc.definirVinculo({ empresaId: B, produtoId: fanta, categoriaFiscal: 'AGUA', elegivelComposicao: true }, { db });
  assert.strictEqual((await Svc.obterVinculo({ empresaId: A, produtoId: fanta }, { db })).categoria_fiscal, 'REFRIGERANTE');
  assert.strictEqual((await Svc.obterVinculo({ empresaId: B, produtoId: fanta }, { db })).categoria_fiscal, 'AGUA');
  await Svc.removerVinculo({ empresaId: B, produtoId: fanta }, { db });
  assert.ok(await Svc.obterVinculo({ empresaId: A, produtoId: fanta }, { db }));
  await rejeita(Svc.obterVinculo({ produtoId: fanta }, { db }), 'EMPRESA_OBRIGATORIA');
  await rejeita(Svc.obterVinculo({ empresaId: 999, produtoId: fanta }, { db }), 'EMPRESA_NAO_ENCONTRADA');
  console.log('ok isolamento por empresa');

  // 6 AGUA não compartilha grupo REFRIGERANTE
  const refri = (await Svc.listarElegiveis({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).map((x) => x.produto_id);
  const aguas = (await Svc.listarElegiveis({ empresaId: A, categoriaFiscal: 'AGUA' }, { db })).map((x) => x.produto_id);
  assert.deepStrictEqual(refri, [fanta]);
  assert.deepStrictEqual(aguas, [agua]);
  console.log('ok AGUA separada de REFRIGERANTE');

  // 7 vínculo único por empresa+produto (atualiza, não duplica)
  await Svc.definirVinculo({ empresaId: A, produtoId: agua, categoriaFiscal: 'AGUA', elegivelComposicao: true }, { db });
  const cnt = await get(db, 'SELECT COUNT(*) n FROM produto_categoria_fiscal_empresa WHERE empresa_id = ? AND produto_id = ?', [A, agua]);
  assert.strictEqual(cnt.n, 1);

  // 8 campos operacionais e saldos inalterados; nenhum produto criado
  const depois = await get(db, 'SELECT * FROM produtos WHERE id = ?', [coca]);
  assert.deepStrictEqual(depois, antes);
  assert.strictEqual((await get(db, 'SELECT COUNT(*) n FROM produtos')).n, totalAntes.n);
  console.log('ok produtos e saldos inalterados');

  await new Promise((r) => db.close(() => r()));
  console.log('categoria-fiscal-empresa: todos os testes passaram');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
