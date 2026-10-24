/**
 * Sprint 2C — políticas do adaptador converterParaMl sobre o MUC (banco :memory:, somente leitura).
 * Execução: node tests/vendas/saldo-fiscal-conversao-muc.test.js
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const Svc = require('../../backend/services/vendas/SaldoFiscalCategoriaService');

const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function cb(e) { return e ? rej(e) : res({ lastID: this.lastID }); }));
const all = (db, sql) => new Promise((res, rej) => db.all(sql, [], (e, r) => (e ? rej(e) : res(r))));

async function rejeita(promise, code) {
  try { await promise; } catch (e) {
    assert.strictEqual(e.code, code, `esperado ${code}, obtido ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`esperava erro ${code}`);
  return null;
}

async function main() {
  const db = await new Promise((res, rej) => { const d = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(d))); });
  await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, unidade TEXT, saldo_fiscal REAL DEFAULT 0)`);
  await garantirSchemaProdutoConversaoAsync(db);
  const prod = async (utiliza, relacoes = [], unidade = 'UN') => {
    const id = (await run(db, `INSERT INTO produtos (nome, unidade) VALUES ('p', ?)`, [unidade])).lastID;
    await run(db, 'UPDATE produtos SET utiliza_conversao = ?, unidade_estoque = ? WHERE id = ?', [utiliza, unidade, id]);
    for (const [o, d, f] of relacoes) {
      await run(db, 'INSERT INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator) VALUES (?, ?, ?, ?)', [id, o, d, f]);
    }
    return id;
  };
  const conv = (produtoId, quantidade, unidade, extra = {}) => Svc.converterParaMl({ produtoId, quantidade, unidade, ...extra }, { db });
  const snap = async () => JSON.stringify([
    await all(db, 'SELECT * FROM produtos'), await all(db, 'SELECT * FROM muc_produto_relacoes')
  ]);
  // 1. relação única válida
  const p1 = await prod(1, [['UN', 'ML', 1000]]);
  assert.strictEqual((await conv(p1, 2, 'UN')).quantidadeMl, 2000);
  // 2. UN->ML sem relação
  await rejeita(conv(await prod(1, []), 1, 'UN'), 'CONVERSAO_INVALIDA');
  // 3. fardo sem conteúdo configurado
  await rejeita(conv(p1, 1, 'FARDO'), 'CONVERSAO_NAO_DISPONIVEL');
  await rejeita(conv(p1, 1, 'FARDO', { apresentacoes: [{ unidade_comercial: 'FARDO', quantidade_conteudo: 0 }] }), 'CONVERSAO_NAO_DISPONIVEL');
  // 4. relação incompatível (UN->KG não leva a ML)
  await rejeita(conv(await prod(1, [['UN', 'KG', 1]]), 1, 'UN'), 'CONVERSAO_NAO_DISPONIVEL');
  // 5. ciclo
  await rejeita(conv(await prod(1, [['UN', 'ML', 1000], ['ML', 'UN', 0.001]]), 1, 'UN'), 'CONVERSAO_CICLO');
  // 6. dois caminhos, mesmo resultado
  const p6 = await prod(1, [['UN', 'ML', 1000], ['UN', 'L', 1]]);
  assert.strictEqual((await conv(p6, 1, 'UN')).quantidadeMl, 1000);
  // 7. dois caminhos, resultados diferentes
  await rejeita(conv(await prod(1, [['UN', 'L', 1], ['UN', 'ML', 500]]), 1, 'UN'), 'CONVERSAO_AMBIGUA');
  // 7b. relação duplicada na mesma direção é barrada pelo UNIQUE do schema (o MUC ignoraria a duplicata)
  const p7b = await prod(1, [['UN', 'ML', 1000]]);
  await assert.rejects(
    run(db, 'INSERT INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator) VALUES (?, ?, ?, ?)', [p7b, 'UN', 'ML', 500]),
    /UNIQUE/
  );
  assert.strictEqual((await conv(p7b, 1, 'UN')).quantidadeMl, 1000);
  // 8. fracionário
  const e8 = await rejeita(conv(await prod(1, [['UN', 'ML', 333.5]]), 1, 'UN'), 'CONVERSAO_FRACIONARIA');
  assert.strictEqual(e8.quantidade_convertida, 333.5);
  // 9. litro -> ml
  assert.strictEqual((await conv(await prod(1, []), 2, 'L')).quantidadeMl, 2000);
  assert.strictEqual((await conv(await prod(0, [], 'ML'), 1.5, 'L').catch((e) => e.code)), 'CONVERSAO_NAO_DISPONIVEL');
  assert.strictEqual((await conv(await prod(0, [], 'ML'), 1500, 'ML')).quantidadeMl, 1500);
  // 10. quantidade inválida
  for (const q of [0, -1, NaN, Infinity, 'abc', null, undefined, true]) {
    await rejeita(conv(p1, q, 'UN'), 'QUANTIDADE_INVALIDA');
  }
  await rejeita(conv(p1, 1, ''), 'UNIDADE_INVALIDA');
  await rejeita(conv(0, 1, 'UN'), 'PRODUTO_INVALIDO');
  await rejeita(conv(99999, 1, 'UN'), 'PRODUTO_INEXISTENTE');
  await rejeita(conv(p1, 1, 'XYZ'), 'CONVERSAO_INVALIDA');

  // Precisão: fração de ml entre 1e-9 e 0.5e-9 é absorvida pelo arredondamento de 9 casas do MUC
  const pPrec = await prod(1, [['UN', 'ML', 1000]]);
  const antes = await snap();
  const quase = await conv(pPrec, 1.0000000000004, 'UN').then((r) => r.quantidadeMl, (e) => e.code);
  console.log('   precisão: 1.0000000000004 UN ->', quase, '(esperado 1000: fração < 1e-9 ml é absorvida pelo MUC)');
  assert.strictEqual(quase, 1000);
  // fração visível (>= 1e-9) continua rejeitada
  await rejeita(conv(pPrec, 1.000001, 'UN'), 'CONVERSAO_FRACIONARIA');

  // somente leitura
  assert.strictEqual(await snap(), antes);
  console.log('saldo-fiscal-conversao-muc: todos os testes passaram');
  await new Promise((r) => db.close(r));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
