/**
 * Sprint 2C — concorrência entre conexões SQLite independentes, contrato transacional,
 * idempotência semântica e política de conversão MUC. Usa apenas bancos temporários (arquivo em os.tmpdir()).
 * Execução: node tests/vendas/saldo-fiscal-categoria-concorrencia.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const { garantirSchemaSaldoFiscalCategoriaAsync } = require('../../backend/services/vendas/saldoFiscalCategoriaSchema');
const Svc = require('../../backend/services/vendas/SaldoFiscalCategoriaService');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saldo-fiscal-conc-'));
const arquivo = path.join(dir, 'teste.db');
const conexoes = [];

function abrir(busyMs = 30000) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo, (err) => {
      if (err) return reject(err);
      conexoes.push(db);
      db.serialize(() => {
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA foreign_keys=ON');
        db.run(`PRAGMA busy_timeout=${busyMs}`, () => resolve(db));
      });
    });
  });
}
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function cb(e) { return e ? rej(e) : res({ lastID: this.lastID, changes: this.changes }); }));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r || null))));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
const fechar = (db) => new Promise((res) => db.close(() => res()));

async function rejeita(promise, code) {
  try { await promise; } catch (e) {
    assert.strictEqual(e.code, code, `esperado ${code}, obtido ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`esperava erro ${code}`);
  return null;
}
const resultados = (promessas) => Promise.allSettled(promessas);
const ok = (rs) => rs.filter((r) => r.status === 'fulfilled');
const falhas = (rs) => rs.filter((r) => r.status === 'rejected');

let seq = 0;
const key = (p = 'k') => `${p}-${++seq}`;
const REF = { tipo: 'CONFERENCIA', id: 'INV-1' };
const base = (empresaId, categoriaFiscal, extra = {}) => ({
  empresaId, categoriaFiscal, usuarioId: 1, motivo: 'Conferido', referencia: REF, idempotencyKey: key(), ...extra
});

async function verificarLedger(db, empresaId, categoria) {
  const saldo = await get(db, 'SELECT * FROM saldo_fiscal_categoria_empresa WHERE empresa_id=? AND categoria_fiscal=?', [empresaId, categoria]);
  const movs = await all(db, 'SELECT * FROM saldo_fiscal_categoria_movimentos WHERE empresa_id=? AND categoria_fiscal=? ORDER BY id', [empresaId, categoria]);
  const soma = movs.reduce((a, m) => a + m.direcao * m.quantidade_ml, 0);
  assert.ok(saldo.saldo_atual_ml >= 0, 'saldo negativo');
  assert.strictEqual(soma, saldo.saldo_atual_ml, 'ledger != saldo');
  let corrente = 0;
  for (const m of movs) {
    assert.strictEqual(m.saldo_anterior_ml, corrente, 'encadeamento quebrado');
    corrente = m.saldo_posterior_ml;
  }
  assert.strictEqual(corrente, saldo.saldo_atual_ml);
  const chaves = new Set(movs.map((m) => m.idempotency_key));
  assert.strictEqual(chaves.size, movs.length, 'chave duplicada');
  return { saldo, movs };
}

async function main() {
  const c = [await abrir(), await abrir(), await abrir(), await abrir()];
  await garantirSchemaEmpresasAsync(c[0]);
  await run(c[0], `CREATE TABLE produtos (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, unidade TEXT,
    saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0)`);
  await garantirSchemaProdutoConversaoAsync(c[0]);
  const A = (await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A' }, { db: c[0] })).id;
  const B = (await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'B' }, { db: c[0] })).id;
  await run(c[0], `INSERT INTO produtos (nome, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('P', 'UN', 7, 3, 5)`);
  const prodAntes = await all(c[0], 'SELECT * FROM produtos');

  // Schema criado concorrentemente por conexões distintas (primeira chamada real)
  await Promise.all(c.map((db) => garantirSchemaSaldoFiscalCategoriaAsync(db)));
  console.log('ok schema criado/verificado por 4 conexões concorrentes');

  const abrirSaldo = async (db, e, cat, ml) => Svc.registrarAbertura(base(e, cat, { quantidadeMl: ml, confirmado: true }), { db });

  // 1. Duas entradas simultâneas
  await abrirSaldo(c[0], A, 'REFRIGERANTE', 1000);
  let rs = await resultados([
    Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 300 }), { db: c[0] }),
    Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 500 }), { db: c[1] })
  ]);
  assert.strictEqual(ok(rs).length, 2, JSON.stringify(falhas(rs).map((f) => f.reason.message)));
  let { saldo } = await verificarLedger(c[2], A, 'REFRIGERANTE');
  assert.strictEqual(saldo.saldo_atual_ml, 1800, 'atualização perdida');
  console.log('ok 1: duas entradas simultâneas (sem perda de atualização)');

  // 2. Duas saídas cujo total excede
  rs = await resultados([
    Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_SAIDA', quantidadeMl: 1000 }), { db: c[0] }),
    Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_SAIDA', quantidadeMl: 1000 }), { db: c[1] })
  ]);
  assert.strictEqual(ok(rs).length, 1);
  assert.strictEqual(falhas(rs)[0].reason.code, 'SALDO_INSUFICIENTE');
  ({ saldo } = await verificarLedger(c[2], A, 'REFRIGERANTE'));
  assert.strictEqual(saldo.saldo_atual_ml, 800);
  console.log('ok 2: saídas excedentes (uma aplicada, outra SALDO_INSUFICIENTE, sem saldo negativo)');

  // 3. Duas aberturas simultâneas
  rs = await resultados([abrirSaldo(c[0], A, 'AGUA', 5000), abrirSaldo(c[1], A, 'AGUA', 7000)]);
  assert.strictEqual(ok(rs).length, 1);
  assert.strictEqual(falhas(rs)[0].reason.code, 'ABERTURA_JA_REGISTRADA');
  const ab = await verificarLedger(c[2], A, 'AGUA');
  assert.strictEqual(ab.movs.length, 1);
  console.log('ok 3: abertura simultânea (uma só)');

  // 4. Dois estornos do mesmo movimento (chaves diferentes)
  const mov = (await Svc.ajustar(base(A, 'AGUA', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 250 }), { db: c[0] })).movimento;
  rs = await resultados([
    Svc.estornar(base(A, 'AGUA', { movimentoId: mov.id }), { db: c[0] }),
    Svc.estornar(base(A, 'AGUA', { movimentoId: mov.id }), { db: c[1] })
  ]);
  assert.strictEqual(ok(rs).length, 1);
  assert.strictEqual(falhas(rs)[0].reason.code, 'ESTORNO_DUPLICADO');
  const est = await verificarLedger(c[2], A, 'AGUA');
  assert.strictEqual(est.movs.filter((m) => m.movimento_estornado_id === mov.id).length, 1);
  assert.strictEqual(est.saldo.saldo_atual_ml, ab.saldo.saldo_atual_ml);
  await rejeita(Svc.estornar(base(A, 'AGUA', { movimentoId: mov.id }), { db: c[3] }), 'ESTORNO_DUPLICADO');
  console.log('ok 4: estorno concorrente e por segunda chave (um só)');

  // 5. Mesma chave, mesmo payload, conexões distintas
  const k5 = key('mesma');
  const p5 = base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 100, idempotencyKey: k5 });
  rs = await resultados(c.map((db) => Svc.ajustar({ ...p5 }, { db })));
  assert.strictEqual(ok(rs).length, 4, JSON.stringify(falhas(rs).map((f) => f.reason.message)));
  const vals = ok(rs).map((r) => r.value);
  assert.strictEqual(vals.filter((v) => v.idempotente === false).length, 1, 'exatamente um movimento novo');
  assert.strictEqual(vals.filter((v) => v.idempotente === true).length, 3);
  assert.strictEqual(new Set(vals.map((v) => v.movimento.id)).size, 1);
  ({ saldo } = await verificarLedger(c[2], A, 'REFRIGERANTE'));
  assert.strictEqual(saldo.saldo_atual_ml, 900);
  console.log('ok 5: mesma chave/payload em 4 conexões (1 criado, 3 repetições)');

  // 6. Mesma chave, payloads diferentes
  const k6 = key('dif');
  rs = await resultados([
    Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 10, idempotencyKey: k6 }), { db: c[0] }),
    Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 20, idempotencyKey: k6 }), { db: c[1] })
  ]);
  assert.strictEqual(ok(rs).length, 1);
  assert.strictEqual(falhas(rs)[0].reason.code, 'IDEMPOTENCY_CONFLITO');
  await verificarLedger(c[2], A, 'REFRIGERANTE');
  console.log('ok 6: mesma chave com payloads diferentes (conflito explícito)');

  // 7 e 8. Empresas e categorias distintas simultâneas
  const antesA = (await get(c[3], `SELECT saldo_atual_ml s FROM saldo_fiscal_categoria_empresa WHERE empresa_id=${A} AND categoria_fiscal='REFRIGERANTE'`)).s;
  await abrirSaldo(c[0], B, 'REFRIGERANTE', 1000);
  rs = await resultados([
    Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_SAIDA', quantidadeMl: 400 }), { db: c[0] }),
    Svc.ajustar(base(B, 'REFRIGERANTE', { tipo: 'AJUSTE_SAIDA', quantidadeMl: 400 }), { db: c[1] }),
    Svc.ajustar(base(A, 'AGUA', { tipo: 'AJUSTE_SAIDA', quantidadeMl: 400 }), { db: c[2] })
  ]);
  assert.strictEqual(ok(rs).length, 3);
  assert.strictEqual((await verificarLedger(c[3], A, 'REFRIGERANTE')).saldo.saldo_atual_ml, antesA - 400);
  const saldoB = (await verificarLedger(c[3], B, 'REFRIGERANTE')).saldo.saldo_atual_ml;
  assert.strictEqual(saldoB, 600);
  assert.strictEqual((await verificarLedger(c[3], A, 'AGUA')).saldo.saldo_atual_ml, ab.saldo.saldo_atual_ml - 400);
  console.log('ok 7/8: empresas e categorias diferentes sem estado compartilhado');

  // Carga: 12 saídas de 100 sobre saldo 500 -> exatamente 5 aplicadas
  await abrirSaldo(c[0], B, 'AGUA', 500);
  rs = await resultados(Array.from({ length: 12 }, (_, i) =>
    Svc.ajustar(base(B, 'AGUA', { tipo: 'AJUSTE_SAIDA', quantidadeMl: 100 }), { db: c[i % 4] })));
  assert.strictEqual(ok(rs).length, 5);
  assert.ok(falhas(rs).every((f) => f.reason.code === 'SALDO_INSUFICIENTE'));
  assert.strictEqual((await verificarLedger(c[3], B, 'AGUA')).saldo.saldo_atual_ml, 0);
  console.log('ok carga: 12 saídas concorrentes, 5 aplicadas, saldo 0');

  // ---------- Transações ----------
  // Transação externa ativa na mesma conexão
  const dbTx = c[3];
  await run(dbTx, 'BEGIN IMMEDIATE');
  await run(dbTx, `UPDATE produtos SET nome = 'tx-externa' WHERE id = 1`);
  const antesMov = (await get(dbTx, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos')).n;
  await rejeita(Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1 }), { db: dbTx }), 'TRANSACAO_EXTERNA_ATIVA');
  assert.strictEqual((await get(dbTx, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos')).n, antesMov, 'nenhuma escrita');
  assert.strictEqual((await get(dbTx, 'SELECT nome FROM produtos WHERE id = 1')).nome, 'tx-externa', 'transação do chamador intacta (sem ROLLBACK)');
  await run(dbTx, 'COMMIT'); // o chamador ainda controla sua transação
  assert.strictEqual((await get(c[0], 'SELECT nome FROM produtos WHERE id = 1')).nome, 'tx-externa');
  await run(c[3], `UPDATE produtos SET nome = 'P' WHERE id = 1`);
  // após o erro a conexão continua utilizável
  await Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1 }), { db: dbTx });
  console.log('ok transação externa rejeitada sem escrita e sem tocar a transação do chamador');

  // SQLITE_BUSY explícito (outra conexão segura o lock de escrita; busy_timeout=0)
  const rapido = await abrir(0);
  await run(c[0], 'BEGIN IMMEDIATE');
  await rejeita(Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1 }), { db: rapido }), 'SALDO_OCUPADO');
  await run(c[0], 'ROLLBACK');
  await Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1 }), { db: rapido });
  console.log('ok SQLITE_BUSY vira SALDO_OCUPADO e a conexão segue utilizável');

  // Exceção no meio não deixa a conexão em transação
  await run(c[1], `CREATE TRIGGER trg_teste_falha BEFORE INSERT ON saldo_fiscal_categoria_movimentos
    WHEN NEW.motivo = 'forcar-falha' BEGIN SELECT RAISE(ABORT, 'falha-forcada'); END`);
  const antesSaldo = (await get(c[2], `SELECT saldo_atual_ml s FROM saldo_fiscal_categoria_empresa WHERE empresa_id=${A} AND categoria_fiscal='REFRIGERANTE'`)).s;
  await assert.rejects(Svc.ajustar(base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 9, motivo: 'forcar-falha' }), { db: c[0] }), /falha-forcada/);
  assert.strictEqual((await get(c[2], `SELECT saldo_atual_ml s FROM saldo_fiscal_categoria_empresa WHERE empresa_id=${A} AND categoria_fiscal='REFRIGERANTE'`)).s, antesSaldo);
  await run(c[0], 'BEGIN IMMEDIATE'); // prova que a conexão não ficou em transação
  await run(c[0], 'ROLLBACK');
  await run(c[1], 'DROP TRIGGER trg_teste_falha');
  console.log('ok falha interna: rollback total e conexão fora de transação');

  // ---------- Ledger: proteção por SQL direto ----------
  const m1 = await get(c[2], 'SELECT id FROM saldo_fiscal_categoria_movimentos LIMIT 1');
  for (const sql of [
    `UPDATE saldo_fiscal_categoria_movimentos SET motivo='x' WHERE id=${m1.id}`,
    `DELETE FROM saldo_fiscal_categoria_movimentos WHERE id=${m1.id}`
  ]) {
    await assert.rejects(run(c[2], sql), /LEDGER_IMUTAVEL/);
  }
  console.log('ok ledger imutável por SQL direto (UPDATE/DELETE)');

  // ---------- Idempotência semântica ----------
  await run(c[0], `INSERT INTO produtos (nome, unidade) VALUES ('Q', 'UN')`);
  const sem = base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 50 });
  const r0 = await Svc.ajustar(sem, { db: c[0] });
  assert.strictEqual(r0.idempotente, false);
  assert.strictEqual((await Svc.ajustar({ ...sem }, { db: c[1] })).idempotente, true);
  for (const alt of [
    { usuarioId: 2 },
    { usuarioId: undefined, origemSistemica: 'JOB' },
    { motivo: 'Outro motivo' },
    { referencia: { tipo: 'CONFERENCIA', id: 'INV-2' } },
    { referencia: { tipo: 'DOCUMENTO', id: 'INV-1' } },
    { tipo: 'AJUSTE_SAIDA' },
    { categoriaFiscal: 'AGUA' },
    { quantidadeMl: 51 },
    { conversao: { produtoId: 1, quantidadeOrigem: 50, unidadeOrigem: 'ML', quantidadeMl: 50 } }
  ]) {
    await rejeita(Svc.ajustar({ ...sem, ...alt }, { db: c[2] }), 'IDEMPOTENCY_CONFLITO');
  }
  // mesma chave em outra empresa é outra operação
  assert.strictEqual((await Svc.ajustar({ ...sem, empresaId: B }, { db: c[2] })).idempotente, false);
  // idempotência com conversão: mesma conversão repete; produto diferente conflita
  const conv = { produtoId: 1, quantidadeOrigem: 50, unidadeOrigem: 'ML', quantidadeMl: 50 };
  const sc = base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 50, conversao: conv });
  assert.strictEqual((await Svc.ajustar(sc, { db: c[0] })).idempotente, false);
  assert.strictEqual((await Svc.ajustar(sc, { db: c[1] })).idempotente, true);
  await rejeita(Svc.ajustar({ ...sc, conversao: { ...conv, produtoId: 2 } }, { db: c[2] }), 'IDEMPOTENCY_CONFLITO');
  await rejeita(Svc.ajustar({ ...sc, conversao: undefined }, { db: c[2] }), 'IDEMPOTENCY_CONFLITO');
  // chave obrigatória
  await rejeita(Svc.ajustar({ ...sem, idempotencyKey: '  ' }, { db: c[0] }), 'IDEMPOTENCY_KEY_OBRIGATORIA');
  await verificarLedger(c[3], A, 'REFRIGERANTE');
  console.log('ok idempotência semântica (operador, motivo, referência, tipo, categoria, quantidade, conversão)');

  // Rollback seguido de repetição não deixa estado parcial
  await run(c[1], `CREATE TRIGGER trg_teste_falha BEFORE INSERT ON saldo_fiscal_categoria_movimentos
    WHEN NEW.motivo = 'forcar-falha' BEGIN SELECT RAISE(ABORT, 'falha-forcada'); END`);
  const kf = key('rb');
  const pf = base(A, 'REFRIGERANTE', { tipo: 'AJUSTE_ENTRADA', quantidadeMl: 7, motivo: 'forcar-falha', idempotencyKey: kf });
  await assert.rejects(Svc.ajustar(pf, { db: c[0] }), /falha-forcada/);
  assert.strictEqual((await get(c[2], 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos WHERE idempotency_key=?', [kf])).n, 0);
  await run(c[1], 'DROP TRIGGER trg_teste_falha');
  const rep = await Svc.ajustar(pf, { db: c[0] });
  assert.strictEqual(rep.idempotente, false, 'após rollback a repetição é uma operação nova');
  await verificarLedger(c[3], A, 'REFRIGERANTE');
  console.log('ok repetição após rollback sem estado parcial');

  // Produtos intocados
  assert.deepStrictEqual(await all(c[0], 'SELECT * FROM produtos WHERE id = 1'), prodAntes);

  for (const db of conexoes) await fechar(db);
  conexoes.length = 0;
  console.log('saldo-fiscal-categoria-concorrencia: todos os testes passaram');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    for (const db of conexoes) await fechar(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
