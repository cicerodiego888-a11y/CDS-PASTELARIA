/**
 * Sprint 2B — saldo fiscal compartilhado por empresa e categoria. SQLite :memory: isolado.
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const {
  garantirSchemaSaldoFiscalCategoriaAsync
} = require('../../backend/services/vendas/saldoFiscalCategoriaSchema');
const Svc = require('../../backend/services/vendas/SaldoFiscalCategoriaService');

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
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r || []))));
}
async function rejeita(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.strictEqual(e.code, code, `esperado ${code}, obtido ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`esperava erro ${code}`);
  return null;
}
async function rejeitaSql(promise, trecho) {
  try {
    await promise;
  } catch (e) {
    assert.ok(String(e.message).includes(trecho), `esperado "${trecho}" em: ${e.message}`);
    return;
  }
  assert.fail(`esperava erro SQL contendo ${trecho}`);
}

let seq = 0;
const key = (p = 'k') => `${p}-${++seq}`;
const REF = { tipo: 'CONFERENCIA', id: 'INV-2026-01' };

function base(empresaId, categoriaFiscal, extra = {}) {
  return {
    empresaId,
    categoriaFiscal,
    usuarioId: 1,
    motivo: 'Saldo conferido',
    referencia: REF,
    idempotencyKey: key(),
    ...extra
  };
}

async function main() {
  const db = await openDb();
  await run(db, 'PRAGMA foreign_keys = ON');
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, unidade TEXT,
    saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0)`);
  await garantirSchemaProdutoConversaoAsync(db);
  await run(db, `CREATE TABLE estoque_empresa (id INTEGER PRIMARY KEY, produto_id INTEGER, empresa_id INTEGER, saldo_fiscal REAL)`);
  await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY, total REAL)`);
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY, total REAL)`);

  const A = (await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A' }, { db })).id;
  const B = (await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'B' }, { db })).id;

  const prod = async (nome, unidade, utiliza, relacoes = []) => {
    const id = (await run(db, `INSERT INTO produtos (nome, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
                               VALUES (?, ?, 11, 4, 15)`, [nome, unidade])).lastID;
    await run(db, 'UPDATE produtos SET utiliza_conversao = ?, unidade_estoque = ? WHERE id = ?', [utiliza, unidade, id]);
    for (const [o, d, f] of relacoes) {
      await run(db, 'INSERT INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator) VALUES (?, ?, ?, ?)', [id, o, d, f]);
    }
    return id;
  };
  await run(db, `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal) VALUES (1, ${A}, 9)`);
  await run(db, `INSERT INTO pedidos (total) VALUES (100)`);
  await run(db, `INSERT INTO vendas (total) VALUES (100)`);
  const prodUnMl = await prod('Refri 1L', 'UN', 1, [['UN', 'ML', 1000]]);
  const prodSemRel = await prod('Refri sem relação', 'UN', 1, []);
  const prodSemConv = await prod('Refri sem conversão', 'UN', 0, []);
  const prodMl = await prod('Água ML', 'ML', 0, []);
  const prodFrac = await prod('Refri fracionado', 'UN', 1, [['UN', 'ML', 333.5]]);
  const prodAmbiguo = await prod('Refri ambíguo', 'UN', 1, [['UN', 'L', 1], ['UN', 'ML', 500]]);
  const prodCiclo = await prod('Refri ciclo', 'UN', 1, [['UN', 'ML', 1000], ['ML', 'UN', 0.001]]);
  const prodKg = await prod('Item em KG', 'KG', 1, []);

  const snapshot = async () => ({
    produtos: await all(db, 'SELECT * FROM produtos ORDER BY id'),
    estoque: await all(db, 'SELECT * FROM estoque_empresa ORDER BY id'),
    pedidos: await all(db, 'SELECT * FROM pedidos'),
    vendas: await all(db, 'SELECT * FROM vendas')
  });
  const antes = await snapshot();

  // ---------- Schema ----------
  await garantirSchemaSaldoFiscalCategoriaAsync(db);
  await garantirSchemaSaldoFiscalCategoriaAsync(db);
  const objs = await all(db, `SELECT name, type FROM sqlite_master WHERE name LIKE '%saldo_fiscal%'`);
  const nomes = objs.map((o) => o.name);
  for (const n of [
    'saldo_fiscal_categoria_empresa', 'saldo_fiscal_categoria_movimentos',
    'uq_saldo_fiscal_mov_estorno', 'uq_saldo_fiscal_mov_abertura',
    'idx_saldo_fiscal_mov_empresa_categoria_data', 'trg_saldo_fiscal_mov_no_update', 'trg_saldo_fiscal_mov_no_delete'
  ]) assert.ok(nomes.includes(n), `objeto ausente: ${n}`);
  assert.strictEqual((await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_empresa')).n, 0, 'schema não cria linhas');
  const ins = (e, c, extra = '') => run(db, `INSERT INTO saldo_fiscal_categoria_empresa (empresa_id, categoria_fiscal${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (${e}, '${c}'${extra ? ', ' + extra.split('=')[1] : ''})`);
  await ins(A, 'REFRIGERANTE');
  await rejeitaSql(ins(A, 'REFRIGERANTE'), 'UNIQUE');
  await rejeitaSql(ins(A, 'SUCO'), 'CHECK');
  await rejeitaSql(ins(B, 'AGUA', 'saldo_atual_ml=-1'), 'CHECK');
  await rejeitaSql(ins(B, 'AGUA', 'saldo_atual_ml=1.5'), 'CHECK');
  await rejeitaSql(ins(999, 'AGUA'), 'FOREIGN KEY');
  await rejeitaSql(run(db, `UPDATE saldo_fiscal_categoria_empresa SET saldo_reservado_ml = 5 WHERE empresa_id = ${A}`), 'CHECK');
  await run(db, 'DELETE FROM saldo_fiscal_categoria_empresa');
  console.log('ok schema idempotente, unicidade, CHECKs e FK');

  // ---------- Garantir saldo / consulta ----------
  assert.strictEqual(await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'AGUA' }, { db }), null);
  assert.strictEqual((await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_empresa')).n, 0, 'consulta não cria dados');
  await rejeita(Svc.obterSaldo({ categoriaFiscal: 'AGUA' }, { db }), 'EMPRESA_OBRIGATORIA');
  await rejeita(Svc.obterSaldo({ empresaId: null, categoriaFiscal: 'AGUA' }, { db }), 'EMPRESA_OBRIGATORIA');
  await rejeita(Svc.obterSaldo({ empresaId: 999, categoriaFiscal: 'AGUA' }, { db }), 'EMPRESA_NAO_ENCONTRADA');
  await rejeita(Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'SUCO' }, { db }), 'CATEGORIA_FISCAL_INVALIDA');
  await rejeita(Svc.garantirSaldo({ empresaId: A }, { db }), 'CATEGORIA_FISCAL_OBRIGATORIA');
  const s0 = await Svc.garantirSaldo({ empresaId: A, categoriaFiscal: 'refrigerante' }, { db });
  assert.deepStrictEqual(s0, {
    empresaId: A, categoriaFiscal: 'REFRIGERANTE', unidadeBase: 'ML', saldoAtualMl: 0, saldoReservadoMl: 0,
    saldoDisponivelMl: 0, estoqueMinimoMl: 0, ativo: true
  });
  await Svc.garantirSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db });
  assert.strictEqual((await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_empresa')).n, 1);
  assert.strictEqual((await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos')).n, 0, 'sem movimento ao garantir');
  console.log('ok garantirSaldo/obterSaldo');

  // ---------- Abertura ----------
  const k1 = key('abertura');
  const ab = { ...base(A, 'REFRIGERANTE'), quantidadeMl: 10000, confirmado: true, idempotencyKey: k1 };
  await rejeita(Svc.registrarAbertura({ ...ab, confirmado: false }, { db }), 'CONFIRMACAO_OBRIGATORIA');
  await rejeita(Svc.registrarAbertura({ ...ab, confirmado: undefined }, { db }), 'CONFIRMACAO_OBRIGATORIA');
  await rejeita(Svc.registrarAbertura({ ...ab, motivo: ' ' }, { db }), 'MOTIVO_OBRIGATORIO');
  await rejeita(Svc.registrarAbertura({ ...ab, referencia: null }, { db }), 'REFERENCIA_OBRIGATORIA');
  await rejeita(Svc.registrarAbertura({ ...ab, referencia: { tipo: 'X' } }, { db }), 'REFERENCIA_OBRIGATORIA');
  await rejeita(Svc.registrarAbertura({ ...ab, usuarioId: undefined }, { db }), 'OPERADOR_OBRIGATORIO');
  await rejeita(Svc.registrarAbertura({ ...ab, idempotencyKey: '' }, { db }), 'IDEMPOTENCY_KEY_OBRIGATORIA');
  for (const q of [0, -5, 1.5, '100', null, undefined, NaN]) {
    await rejeita(Svc.registrarAbertura({ ...ab, quantidadeMl: q }, { db }), 'QUANTIDADE_INVALIDA');
  }
  assert.strictEqual((await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos')).n, 0);
  const r1 = await Svc.registrarAbertura(ab, { db });
  assert.strictEqual(r1.idempotente, false);
  assert.strictEqual(r1.saldo.saldoAtualMl, 10000);
  assert.strictEqual(r1.movimento.tipo, 'ABERTURA');
  assert.strictEqual(r1.movimento.saldoAnteriorMl, 0);
  assert.strictEqual(r1.movimento.saldoPosteriorMl, 10000);
  const r1b = await Svc.registrarAbertura(ab, { db });
  assert.strictEqual(r1b.idempotente, true);
  assert.strictEqual(r1b.movimento.id, r1.movimento.id);
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoAtualMl, 10000);
  await rejeita(Svc.registrarAbertura({ ...ab, quantidadeMl: 999 }, { db }), 'IDEMPOTENCY_CONFLITO');
  await rejeita(Svc.registrarAbertura({ ...ab, motivo: 'outro' }, { db }), 'IDEMPOTENCY_CONFLITO');
  await rejeita(Svc.registrarAbertura({ ...ab, idempotencyKey: key() }, { db }), 'ABERTURA_JA_REGISTRADA');
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoAtualMl, 10000);
  // abertura sistêmica em outra empresa/categoria
  const rs = await Svc.registrarAbertura({
    ...base(B, 'AGUA'), usuarioId: undefined, origemSistemica: 'IMPORTACAO_AUTORIZADA', quantidadeMl: 5000, confirmado: true
  }, { db });
  assert.strictEqual(rs.movimento.origem, 'SISTEMA');
  await rejeita(Svc.registrarAbertura({ ...base(A, 'AGUA'), quantidadeMl: 1, confirmado: true, usuarioId: 1, origemSistemica: 'X' }, { db }), 'OPERADOR_AMBIGUO');
  console.log('ok abertura');

  // ---------- Ajustes ----------
  const e1 = await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 2500 }, { db });
  assert.strictEqual(e1.saldo.saldoAtualMl, 12500);
  assert.strictEqual(e1.movimento.direcao, 1);
  const kS = key('saida');
  const sPayload = { ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_SAIDA', quantidadeMl: 4000, idempotencyKey: kS };
  const s1 = await Svc.ajustar(sPayload, { db });
  assert.strictEqual(s1.saldo.saldoAtualMl, 8500);
  assert.strictEqual(s1.movimento.direcao, -1);
  assert.strictEqual(s1.movimento.saldoAnteriorMl, 12500);
  const s1b = await Svc.ajustar(sPayload, { db });
  assert.strictEqual(s1b.idempotente, true);
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoAtualMl, 8500);
  await rejeita(Svc.ajustar({ ...sPayload, quantidadeMl: 1 }, { db }), 'IDEMPOTENCY_CONFLITO');
  await rejeita(Svc.ajustar({ ...sPayload, tipo: 'AJUSTE_ENTRADA' }, { db }), 'IDEMPOTENCY_CONFLITO');
  const ex = await rejeita(Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_SAIDA', quantidadeMl: 8501 }, { db }), 'SALDO_INSUFICIENTE');
  assert.strictEqual(ex.saldo_disponivel_ml, 8500);
  await rejeita(Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'CONSUMO', quantidadeMl: 1 }, { db }), 'TIPO_AJUSTE_INVALIDO');
  await rejeita(Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'ESTORNO', quantidadeMl: 1 }, { db }), 'TIPO_AJUSTE_INVALIDO');
  for (const q of [0, -1, 0.5]) {
    await rejeita(Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: q }, { db }), 'QUANTIDADE_INVALIDA');
  }
  await rejeita(Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1, motivo: '' }, { db }), 'MOTIVO_OBRIGATORIO');
  await rejeita(Svc.ajustar({ ...base(A, 'AGUA'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1 }, { db }), 'SALDO_NAO_ENCONTRADO');
  await rejeita(Svc.registrarAbertura({ ...base(A, 'AGUA'), quantidadeMl: 1, confirmado: true, idempotencyKey: kS }, { db }), 'IDEMPOTENCY_CONFLITO');
  console.log('ok ajustes');

  // saída respeita saldo reservado (invariante) — reserva simulada diretamente no banco de teste
  await run(db, `UPDATE saldo_fiscal_categoria_empresa SET saldo_reservado_ml = 8000 WHERE empresa_id = ${A} AND categoria_fiscal = 'REFRIGERANTE'`);
  await rejeita(Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_SAIDA', quantidadeMl: 501 }, { db }), 'SALDO_INSUFICIENTE');
  const sOk = await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_SAIDA', quantidadeMl: 500 }, { db });
  assert.strictEqual(sOk.saldo.saldoAtualMl, 8000);
  assert.strictEqual(sOk.saldo.saldoDisponivelMl, 0);
  await run(db, `UPDATE saldo_fiscal_categoria_empresa SET saldo_reservado_ml = 0 WHERE empresa_id = ${A} AND categoria_fiscal = 'REFRIGERANTE'`);
  await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 500 }, { db });
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoAtualMl, 8500);
  console.log('ok saldo reservado respeitado');

  // ---------- Atomicidade ----------
  await run(db, `CREATE TRIGGER trg_teste_falha BEFORE INSERT ON saldo_fiscal_categoria_movimentos
                 WHEN NEW.motivo = 'forcar-falha' BEGIN SELECT RAISE(ABORT, 'falha-forcada'); END`);
  const movsAntes = (await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos')).n;
  await rejeitaSql(Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 777, motivo: 'forcar-falha' }, { db }), 'falha-forcada');
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoAtualMl, 8500, 'saldo revertido');
  assert.strictEqual((await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos')).n, movsAntes);
  await run(db, 'DROP TRIGGER trg_teste_falha');
  // a conexão continua utilizável após rollback
  await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1 }, { db });
  await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_SAIDA', quantidadeMl: 1 }, { db });
  console.log('ok atomicidade (falha na inserção do movimento reverte o saldo)');

  // ---------- Concorrência (mesma conexão serializada) ----------
  const disp = (await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoDisponivelMl;
  const metade = Math.floor(disp / 2) + 1;
  const rs2 = await Promise.allSettled([
    Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_SAIDA', quantidadeMl: metade }, { db }),
    Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_SAIDA', quantidadeMl: metade }, { db })
  ]);
  assert.strictEqual(rs2.filter((r) => r.status === 'fulfilled').length, 1);
  assert.strictEqual(rs2.find((r) => r.status === 'rejected').reason.code, 'SALDO_INSUFICIENTE');
  const kc = key('conc');
  const mesmo = { ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 10, idempotencyKey: kc };
  const rs3 = await Promise.all([Svc.ajustar(mesmo, { db }), Svc.ajustar(mesmo, { db }), Svc.ajustar(mesmo, { db })]);
  assert.strictEqual(rs3.filter((r) => !r.idempotente).length, 1);
  assert.strictEqual(new Set(rs3.map((r) => r.movimento.id)).size, 1);
  console.log('ok concorrência e idempotência concorrente');

  // ---------- Estornos ----------
  const antesEst = (await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoAtualMl;
  const origemRow = await get(db, 'SELECT * FROM saldo_fiscal_categoria_movimentos WHERE id = ?', [s1.movimento.id]);
  const kE = key('estorno');
  const estP = { ...base(A, 'REFRIGERANTE'), movimentoId: s1.movimento.id, idempotencyKey: kE, motivo: 'Erro de digitação' };
  const est = await Svc.estornar(estP, { db });
  assert.strictEqual(est.movimento.tipo, 'ESTORNO');
  assert.strictEqual(est.movimento.movimentoEstornadoId, s1.movimento.id);
  assert.strictEqual(est.movimento.direcao, 1);
  assert.strictEqual(est.movimento.quantidadeMl, 4000);
  assert.strictEqual(est.saldo.saldoAtualMl, antesEst + 4000);
  assert.deepStrictEqual(await get(db, 'SELECT * FROM saldo_fiscal_categoria_movimentos WHERE id = ?', [s1.movimento.id]), origemRow, 'original preservado');
  const estB = await Svc.estornar(estP, { db });
  assert.strictEqual(estB.idempotente, true);
  assert.strictEqual(estB.movimento.id, est.movimento.id);
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoAtualMl, antesEst + 4000);
  await rejeita(Svc.estornar({ ...estP, motivo: 'outro' }, { db }), 'IDEMPOTENCY_CONFLITO');
  await rejeita(Svc.estornar({ ...estP, idempotencyKey: key() }, { db }), 'ESTORNO_DUPLICADO');
  await rejeita(Svc.estornar({ ...estP, idempotencyKey: key(), movimentoId: est.movimento.id }, { db }), 'MOVIMENTO_NAO_ESTORNAVEL');
  await rejeita(Svc.estornar({ ...estP, idempotencyKey: key(), movimentoId: r1.movimento.id }, { db }), 'MOVIMENTO_NAO_ESTORNAVEL');
  await rejeita(Svc.estornar({ ...estP, idempotencyKey: key(), movimentoId: 99999 }, { db }), 'MOVIMENTO_NAO_ENCONTRADO');
  await rejeita(Svc.estornar({ ...estP, idempotencyKey: key(), movimentoId: 'abc' }, { db }), 'MOVIMENTO_INVALIDO');
  // outra empresa e outra categoria
  await rejeita(Svc.estornar({ ...base(B, 'AGUA'), movimentoId: e1.movimento.id }, { db }), 'MOVIMENTO_NAO_ENCONTRADO');
  await Svc.garantirSaldo({ empresaId: A, categoriaFiscal: 'AGUA' }, { db });
  await rejeita(Svc.estornar({ ...base(A, 'AGUA'), movimentoId: e1.movimento.id }, { db }), 'MOVIMENTO_OUTRA_CATEGORIA');
  // estorno de entrada que deixaria saldo negativo
  const entGrande = await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 3000 }, { db });
  const dispAtual = (await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoDisponivelMl;
  await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_SAIDA', quantidadeMl: dispAtual - 100 }, { db });
  await rejeita(Svc.estornar({ ...base(A, 'REFRIGERANTE'), movimentoId: entGrande.movimento.id }, { db }), 'SALDO_INSUFICIENTE');
  // concorrência: dois estornos do mesmo movimento
  const saidaC = await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 50 }, { db });
  await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 5000 }, { db });
  const rs4 = await Promise.allSettled([
    Svc.estornar({ ...base(A, 'REFRIGERANTE'), movimentoId: saidaC.movimento.id }, { db }),
    Svc.estornar({ ...base(A, 'REFRIGERANTE'), movimentoId: saidaC.movimento.id }, { db })
  ]);
  assert.strictEqual(rs4.filter((r) => r.status === 'fulfilled').length, 1);
  assert.strictEqual(rs4.find((r) => r.status === 'rejected').reason.code, 'ESTORNO_DUPLICADO');
  console.log('ok estornos');

  // ---------- Ledger imutável e consistente ----------
  await rejeitaSql(run(db, `UPDATE saldo_fiscal_categoria_movimentos SET motivo = 'x' WHERE id = ${r1.movimento.id}`), 'LEDGER_IMUTAVEL');
  await rejeitaSql(run(db, `DELETE FROM saldo_fiscal_categoria_movimentos WHERE id = ${r1.movimento.id}`), 'LEDGER_IMUTAVEL');
  await rejeitaSql(run(db, `INSERT INTO saldo_fiscal_categoria_movimentos
    (empresa_id, categoria_fiscal, tipo, direcao, quantidade_ml, saldo_anterior_ml, saldo_posterior_ml, origem,
     referencia_tipo, referencia_id, idempotency_key, usuario_id, motivo)
    VALUES (${A}, 'REFRIGERANTE', 'AJUSTE_ENTRADA', 1, 10, 0, 999, 'MANUAL', 'X', '1', 'inconsistente', 1, 'm')`), 'CHECK');
  await rejeitaSql(run(db, `INSERT INTO saldo_fiscal_categoria_movimentos
    (empresa_id, categoria_fiscal, tipo, direcao, quantidade_ml, saldo_anterior_ml, saldo_posterior_ml, origem,
     referencia_tipo, referencia_id, movimento_estornado_id, idempotency_key, usuario_id, motivo)
    VALUES (${A}, 'AGUA', 'ESTORNO', -1, 10, 10, 0, 'MANUAL', 'X', '1', ${e1.movimento.id}, 'estorno-cruzado', 1, 'm')`), 'ESTORNO_INCONSISTENTE');
  for (const cat of ['REFRIGERANTE', 'AGUA']) {
    for (const emp of [A, B]) {
      const saldo = await Svc.obterSaldo({ empresaId: emp, categoriaFiscal: cat }, { db });
      if (!saldo) continue;
      const movs = await Svc.listarMovimentos({ empresaId: emp, categoriaFiscal: cat }, { db });
      const soma = movs.reduce((acc, m) => acc + m.direcao * m.quantidadeMl, 0);
      assert.strictEqual(saldo.saldoAtualMl, soma, `ledger = saldo (${emp}/${cat})`);
      let prev = 0;
      for (const m of movs) {
        assert.strictEqual(m.saldoAnteriorMl, prev);
        prev = m.saldoPosteriorMl;
      }
      assert.strictEqual(prev, saldo.saldoAtualMl);
    }
  }
  console.log('ok ledger imutável e consistente com o saldo');

  // ---------- Isolamento ----------
  const sA = await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db });
  const sB = await Svc.obterSaldo({ empresaId: B, categoriaFiscal: 'AGUA' }, { db });
  assert.strictEqual(sB.saldoAtualMl, 5000);
  assert.strictEqual(await Svc.obterSaldo({ empresaId: B, categoriaFiscal: 'REFRIGERANTE' }, { db }), null);
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'AGUA' }, { db })).saldoAtualMl, 0);
  await Svc.ajustar({ ...base(B, 'AGUA'), tipo: 'AJUSTE_SAIDA', quantidadeMl: 1000 }, { db });
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'REFRIGERANTE' }, { db })).saldoAtualMl, sA.saldoAtualMl);
  assert.strictEqual((await Svc.obterSaldo({ empresaId: A, categoriaFiscal: 'AGUA' }, { db })).saldoAtualMl, 0);
  // mesma chave de idempotência pode existir em empresas distintas
  const kShare = key('mesma');
  await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1, idempotencyKey: kShare }, { db });
  await Svc.ajustar({ ...base(B, 'AGUA'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1, idempotencyKey: kShare }, { db });
  assert.strictEqual((await Svc.listarMovimentos({ empresaId: B, categoriaFiscal: 'REFRIGERANTE' }, { db })).length, 0);
  console.log('ok isolamento empresa/categoria');

  // ---------- Conversão via MUC ----------
  const c1 = await Svc.converterParaMl({ produtoId: prodUnMl, quantidade: 2, unidade: 'UN' }, { db });
  assert.strictEqual(c1.quantidadeMl, 2000);
  assert.strictEqual(c1.unidadeDestino, 'ML');
  assert.strictEqual(c1.unidadeOrigem, 'UN');
  assert.strictEqual(c1.quantidadeOrigem, 2);
  assert.strictEqual(c1.produtoId, prodUnMl);
  assert.ok(c1.caminho.length >= 1);
  const c2 = await Svc.converterParaMl({
    produtoId: prodUnMl, quantidade: 1, unidade: 'FARDO',
    apresentacoes: [{ tipo: 'FARDO', unidade: 'UN', quantidade: 12 }]
  }, { db });
  assert.strictEqual(c2.quantidadeMl, 12000);
  const c3 = await Svc.converterParaMl({ produtoId: prodUnMl, quantidade: 1.5, unidade: 'L' }, { db });
  assert.strictEqual(c3.quantidadeMl, 1500);
  assert.strictEqual((await Svc.converterParaMl({ produtoId: prodMl, quantidade: 350, unidade: 'ML' }, { db })).quantidadeMl, 350);
  await rejeita(Svc.converterParaMl({ produtoId: prodSemRel, quantidade: 1,   unidade: 'UN' }, { db }), 'CONVERSAO_INVALIDA');
  await rejeita(Svc.converterParaMl({ produtoId: prodSemConv, quantidade: 1, unidade: 'UN' }, { db }), 'CONVERSAO_NAO_DISPONIVEL');
  await rejeita(Svc.converterParaMl({
    produtoId: prodSemRel, quantidade: 1, unidade: 'FARDO', apresentacoes: [{ tipo: 'FARDO', unidade: 'UN', quantidade: 12 }]
  }, { db }), 'CONVERSAO_NAO_DISPONIVEL');
  await rejeita(Svc.converterParaMl({ produtoId: prodKg, quantidade: 1, unidade: 'KG' }, { db }), 'CONVERSAO_INVALIDA');
  await rejeita(Svc.converterParaMl({ produtoId: prodUnMl, quantidade: 1, unidade: 'XYZ' }, { db }), 'CONVERSAO_INVALIDA');
  await rejeita(Svc.converterParaMl({ produtoId: prodUnMl, quantidade: 0, unidade: 'UN' }, { db }), 'QUANTIDADE_INVALIDA');
  await rejeita(Svc.converterParaMl({ produtoId: prodUnMl, quantidade: 1, unidade: '' }, { db }), 'UNIDADE_INVALIDA');
  await rejeita(Svc.converterParaMl({ produtoId: 99999, quantidade: 1, unidade: 'UN' }, { db }), 'PRODUTO_INEXISTENTE');
  const fr = await rejeita(Svc.converterParaMl({ produtoId: prodFrac, quantidade: 1, unidade: 'UN' }, { db }), 'CONVERSAO_FRACIONARIA');
  assert.strictEqual(fr.quantidade_convertida, 333.5);
  assert.strictEqual((await Svc.converterParaMl({ produtoId: prodFrac, quantidade: 2, unidade: 'UN' }, { db })).quantidadeMl, 667);
  await rejeita(Svc.converterParaMl({ produtoId: prodAmbiguo, quantidade: 1, unidade: 'UN' }, { db }), 'CONVERSAO_AMBIGUA');
  await rejeita(Svc.converterParaMl({ produtoId: prodCiclo, quantidade: 1, unidade: 'UN' }, { db }), 'CONVERSAO_CICLO');
  console.log('ok conversão via MUC');

  // conversão alimenta o movimento com rastreabilidade do produto; conversão não grava
  const movsPre = (await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos')).n;
  const salPre = await all(db, 'SELECT * FROM saldo_fiscal_categoria_empresa ORDER BY id');
  await Svc.converterParaMl({ produtoId: prodUnMl, quantidade: 3, unidade: 'UN' }, { db });
  assert.strictEqual((await get(db, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_movimentos')).n, movsPre);
  assert.deepStrictEqual(await all(db, 'SELECT * FROM saldo_fiscal_categoria_empresa ORDER BY id'), salPre);
  const conv = await Svc.converterParaMl({ produtoId: prodUnMl, quantidade: 4, unidade: 'UN' }, { db });
  const comConv = await Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: conv.quantidadeMl, conversao: conv }, { db });
  assert.strictEqual(comConv.movimento.produtoId, prodUnMl);
  assert.strictEqual(comConv.movimento.quantidadeOrigem, 4);
  assert.strictEqual(comConv.movimento.unidadeOrigem, 'UN');
  assert.ok(comConv.movimento.metadados.conversao.caminho.length >= 1);
  await rejeita(Svc.ajustar({ ...base(A, 'REFRIGERANTE'), tipo: 'AJUSTE_ENTRADA', quantidadeMl: 1, conversao: conv }, { db }), 'CONVERSAO_INCONSISTENTE');
  console.log('ok conversão rastreada no movimento');

  // ---------- Não regressão ----------
  assert.deepStrictEqual(await snapshot(), antes, 'produtos, estoque_empresa, pedidos e vendas inalterados');

  await new Promise((r) => db.close(() => r()));
  console.log('saldo-fiscal-categoria: todos os testes passaram');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
