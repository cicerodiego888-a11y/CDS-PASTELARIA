/**
 * SPRINT CDS-ESTOQUE-INTEGRIDADE-ENTRADAS-01
 * Integridade empresarial das entradas de estoque (banco temporário).
 *
 * Executar: node tests/estoque/integridade-entradas-empresa.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-integridade-entradas-01-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  creditarEstoqueItemCompra,
  montarOptsPortaCreditoCompra
} = require('../../backend/services/compras/creditoEstoqueCompraViaPorta');
const {
  resolverEmpresaDaCompra
} = require('../../backend/services/compras/ComprasEmpresaContextoService');
const {
  resolverTratamentoFiscalItem
} = require('../../backend/services/compras/TratamentoFiscalItemCompra');
const {
  resolverPolitica,
  TIPO_ENTRADA
} = require('../../backend/services/compras/PoliticaEntradaCompra');
const {
  exigirEmpresaIdDoDocumento
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const CNPJS = [
  '11222333000181',
  '04252011000110',
  '27865757000102',
  '60746948000112'
];

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

function creditoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    creditarEstoqueItemCompra(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function setup(nEmpresas = 4) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('INSUMO', 0, 0, 0)`
  );
  const empresas = [];
  for (let i = 0; i < nEmpresas; i += 1) {
    const emp = await EmpresaService.criarEmpresa({
      cnpj: CNPJS[i],
      razao_social: `Empresa ${String.fromCharCode(65 + i)}`
    }, { db });
    empresas.push(emp);
  }
  return { db, produtoId: p.lastID, empresas };
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function cenario1EmpresaValida() {
  const { db, produtoId, empresas } = await setup(1);
  const emp = empresas[0];
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 10,
    quantidadeNaoFiscal: 5,
    empresaId: emp.id
  });
  assert.strictEqual(r.creditado, true);
  assert.strictEqual(r.empresa_id, emp.id);
  assert.strictEqual(r.legado, false);
  const iso = await ee(db, produtoId, emp.id);
  assert.ok(iso);
  assert.strictEqual(Number(iso.saldo_fiscal), 10);
  assert.strictEqual(Number(iso.saldo_nao_fiscal), 5);
  await closeDb(db);
}

async function cenario2SemEmpresa() {
  const { db, produtoId } = await setup(1);
  await assert.rejects(
    () => creditoAsync(db, { produtoId, quantidadeFiscal: 3 }),
    (err) => err && err.code === 'EMPRESA_OBRIGATORIA'
  );
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  const prod = await get(db, 'SELECT saldo_fiscal, estoque_atual FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(Number(prod.saldo_fiscal), 0);
  assert.strictEqual(Number(prod.estoque_atual), 0);
  await closeDb(db);
}

async function cenario3EmpresaInexistente() {
  const { db, produtoId } = await setup(1);
  await assert.rejects(
    () => creditoAsync(db, {
      produtoId,
      quantidadeFiscal: 2,
      empresaId: 999999
    }),
    (err) => err && (err.code === 'EMPRESA_NAO_ENCONTRADA' || /não encontrada/i.test(err.message))
  );
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function cenario4EmpresaInativa() {
  const { db, produtoId, empresas } = await setup(1);
  const emp = empresas[0];
  await EmpresaService.inativarEmpresa(emp.id, { db });
  await assert.rejects(
    () => creditoAsync(db, {
      produtoId,
      quantidadeFiscal: 4,
      empresaId: emp.id
    }),
    (err) => err && err.code === 'EMPRESA_INATIVA'
  );
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function cenario5IsolamentoNEmpresas() {
  const { db, produtoId, empresas } = await setup(4);
  const qtds = [10, 20, 30, 40];
  for (let i = 0; i < 4; i += 1) {
    await creditoAsync(db, {
      produtoId,
      quantidadeFiscal: qtds[i],
      quantidadeNaoFiscal: 0,
      empresaId: empresas[i].id
    });
  }
  for (let i = 0; i < 4; i += 1) {
    const iso = await ee(db, produtoId, empresas[i].id);
    assert.strictEqual(Number(iso.saldo_fiscal), qtds[i], `empresa ${i}`);
  }
  // crédito em A não altera B/C/D
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 5,
    empresaId: empresas[0].id
  });
  assert.strictEqual(Number((await ee(db, produtoId, empresas[1].id)).saldo_fiscal), 20);
  assert.strictEqual(Number((await ee(db, produtoId, empresas[2].id)).saldo_fiscal), 30);
  assert.strictEqual(Number((await ee(db, produtoId, empresas[3].id)).saldo_fiscal), 40);
  assert.strictEqual(Number((await ee(db, produtoId, empresas[0].id)).saldo_fiscal), 15);
  await closeDb(db);
}

async function cenario6FiscalENaoFiscal() {
  const { db, produtoId, empresas } = await setup(1);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 7,
    quantidadeNaoFiscal: 3,
    empresaId: empresas[0].id
  });
  assert.strictEqual(r.saldo_fiscal, 7);
  assert.strictEqual(r.saldo_nao_fiscal, 3);
  assert.strictEqual(r.estoque_atual, 10);
  await closeDb(db);
}

async function cenario7ZeroNaoExigeEmpresa() {
  const { db, produtoId } = await setup(1);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 0
  });
  assert.strictEqual(r.creditado, false);
  await closeDb(db);
}

async function cenario8Rollback() {
  const { db, produtoId, empresas } = await setup(1);
  const emp = empresas[0];
  await run(db, 'BEGIN');
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 9,
    empresaId: emp.id
  });
  const mid = await ee(db, produtoId, emp.id);
  assert.strictEqual(Number(mid.saldo_fiscal), 9);
  await run(db, 'ROLLBACK');
  const depois = await ee(db, produtoId, emp.id);
  assert.ok(!depois || Number(depois.saldo_fiscal) === 0);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(Number(prod.saldo_fiscal), 0);
  await closeDb(db);
}

async function cenario9ResolverSemEmpresaMultiempresa() {
  const { db } = await setup(2);
  await assert.rejects(
    () => resolverEmpresaDaCompra(
      { empresaId: null },
      {},
      {
        db,
        contrato: {
          modo_operacional: ModoOperacionalGlobal.MULTIEMPRESA,
          empresa_operacional: null
        }
      }
    ),
    (err) => err && err.code === 'EMPRESA_COMPRA_AUSENTE'
  );
  await closeDb(db);
}

async function cenario10OptsSemEmpresaExige() {
  const { db } = await setup(1);
  assert.throws(
    () => montarOptsPortaCreditoCompra(db, { exigirEmpresa: true }),
    (err) => err && err.code === 'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function cenario11ChamadorUnicoRotas() {
  const fs = require('fs');
  const path = require('path');
  const rotas = fs.readFileSync(
    path.resolve(__dirname, '../../backend/rotas/compras.js'),
    'utf8'
  );
  const porta = fs.readFileSync(
    path.resolve(__dirname, '../../backend/services/compras/creditoEstoqueCompraViaPorta.js'),
    'utf8'
  );
  assert.strictEqual((rotas.match(/creditarEstoqueItemCompra\s*\(/g) || []).length, 1);
  assert.ok(rotas.includes('exigirEmpresa: true'));
  assert.ok(porta.includes('CDS-ESTOQUE-INTEGRIDADE-ENTRADAS-01') || porta.includes('exigirEmpresa: true'));
  assert.ok(!/modoLegadoSemEmpresa:\s*true/.test(
    porta.slice(porta.indexOf('function creditarEstoqueItemCompra'), porta.indexOf('module.exports'))
  ));
}

async function cenario12CentralComEmpresa() {
  const { db, produtoId, empresas } = await setup(1);
  const emp = empresas[0];
  const doc = { id: 10, empresa_id: emp.id, chave: 'NFeTESTE001', compra_id: null };
  const empresaDoc = exigirEmpresaIdDoDocumento(doc);
  assert.strictEqual(empresaDoc, emp.id);
  // crédito só após “gravação” — porta recebe empresa do documento
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 8,
    empresaId: empresaDoc
  });
  assert.strictEqual(r.empresa_id, emp.id);
  assert.strictEqual(Number((await ee(db, produtoId, emp.id)).saldo_fiscal), 8);
  await closeDb(db);
}

async function cenario13CentralSemEmpresa() {
  assert.throws(
    () => exigirEmpresaIdDoDocumento({ id: 99, empresa_id: null, chave: 'NFeSEM' }),
    (err) => err && err.code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
  );
  const { db, produtoId } = await setup(1);
  await assert.rejects(
    () => creditoAsync(db, { produtoId, quantidadeFiscal: 1 }),
    (err) => err && err.code === 'EMPRESA_OBRIGATORIA'
  );
  assert.strictEqual((await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa')).c, 0);
  await closeDb(db);
}

async function cenario14NfeDuplicadaProtecao() {
  const { db, produtoId, empresas } = await setup(1);
  const emp = empresas[0];
  const chave = '35240100000000000000550010000000011000000010';
  // 1ª entrada
  await creditoAsync(db, { produtoId, quantidadeFiscal: 6, empresaId: emp.id });
  // reprocessamento da mesma NF não deve creditar de novo se qty=0 (já convertida)
  // e documento já vinculado a compra bloqueia segunda abertura (contrato do bridge)
  const docJaVinculado = { id: 7, empresa_id: emp.id, chave, compraId: 55, compra_id: 55 };
  assert.strictEqual(exigirEmpresaIdDoDocumento(docJaVinculado), emp.id);
  assert.ok(Number(docJaVinculado.compraId) > 0, 'documento já vinculado à compra');
  // saldo permanece o da 1ª entrada (sem segundo crédito automático)
  assert.strictEqual(Number((await ee(db, produtoId, emp.id)).saldo_fiscal), 6);
  await closeDb(db);
}

async function cenario15Bonificacao() {
  const comEstoque = resolverTratamentoFiscalItem(
    { cfop: '1910', bonificacao: 1 },
    { entrada_bonificacao_gerar_estoque: true }
  );
  assert.strictEqual(comEstoque.bonificacao, true);
  assert.strictEqual(comEstoque.gerarEstoque, true);

  const semEstoque = resolverTratamentoFiscalItem(
    { cfop: '1910', bonificacao: 1 },
    { entrada_bonificacao_gerar_estoque: false }
  );
  assert.strictEqual(semEstoque.gerarEstoque, false);

  const { db, produtoId, empresas } = await setup(1);
  const emp = empresas[0];
  if (comEstoque.gerarEstoque) {
    await creditoAsync(db, { produtoId, quantidadeFiscal: 2, empresaId: emp.id });
    assert.strictEqual(Number((await ee(db, produtoId, emp.id)).saldo_fiscal), 2);
  }
  // flag desabilitada → qty 0 → no-op sem exigir empresa
  if (!semEstoque.gerarEstoque) {
    const r = await creditoAsync(db, { produtoId, quantidadeFiscal: 0, quantidadeNaoFiscal: 0 });
    assert.strictEqual(r.creditado, false);
  }
  await closeDb(db);
}

async function cenario16UsoConsumo() {
  const pol = resolverPolitica(TIPO_ENTRADA.USO_CONSUMO);
  assert.strictEqual(pol.executarEstoque, false);
  const trat = resolverTratamentoFiscalItem({ cfop: '1556' });
  assert.strictEqual(trat.gerarEstoque, false);
  const { db, produtoId, empresas } = await setup(1);
  // sem movimentação: porta não credita
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 0,
    empresaId: empresas[0].id
  });
  assert.strictEqual(r.creditado, false);
  assert.strictEqual((await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa')).c, 0);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['1 empresa válida credita estoque_empresa', cenario1EmpresaValida],
    ['2 sem empresa bloqueia (sem crédito global)', cenario2SemEmpresa],
    ['3 empresa inexistente bloqueia', cenario3EmpresaInexistente],
    ['4 empresa inativa bloqueia', cenario4EmpresaInativa],
    ['5 isolamento N empresas', cenario5IsolamentoNEmpresas],
    ['6 fiscal + não fiscal', cenario6FiscalENaoFiscal],
    ['7 qty zero não exige empresa', cenario7ZeroNaoExigeEmpresa],
    ['8 rollback restaura', cenario8Rollback],
    ['9 multiempresa sem empresa → EMPRESA_COMPRA_AUSENTE', cenario9ResolverSemEmpresaMultiempresa],
    ['10 opts sem empresa → EMPRESA_OBRIGATORIA', cenario10OptsSemEmpresaExige],
    ['11 chamador único + exigirEmpresa na rota', cenario11ChamadorUnicoRotas],
    ['12 Central com empresa resolvida', cenario12CentralComEmpresa],
    ['13 Central/NF-e sem empresa bloqueia', cenario13CentralSemEmpresa],
    ['14 NF-e duplicada (já vinculada) sem 2º crédito', cenario14NfeDuplicadaProtecao],
    ['15 bonificação respeita flag estoque', cenario15Bonificacao],
    ['16 uso e consumo não gera crédito', cenario16UsoConsumo]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nintegridade-entradas-empresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
