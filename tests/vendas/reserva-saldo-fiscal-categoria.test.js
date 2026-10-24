/**
 * Sprint 2D — reservas do saldo fiscal compartilhado por Pedido.
 * Unitários em SQLite :memory:; concorrência em arquivo temporário com conexões independentes.
 * Execução: node tests/vendas/reserva-saldo-fiscal-categoria.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaSaldoFiscalCategoriaAsync } = require('../../backend/services/vendas/saldoFiscalCategoriaSchema');
const { garantirSchemaReservaSaldoFiscalCategoriaAsync } = require('../../backend/services/vendas/reservaSaldoFiscalCategoriaSchema');
const Saldo = require('../../backend/services/vendas/SaldoFiscalCategoriaService');
const Res = require('../../backend/services/vendas/ReservaSaldoFiscalCategoriaService');

const conexoes = [];
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function cb(e) { return e ? rej(e) : res({ lastID: this.lastID, changes: this.changes }); }));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r || null))));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
const fechar = (db) => new Promise((res) => db.close(() => res()));

function abrir(arquivo, busyMs = 30000) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo, (err) => {
      if (err) return reject(err);
      conexoes.push(db);
      db.serialize(() => {
        if (arquivo !== ':memory:') db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA foreign_keys=ON');
        db.run(`PRAGMA busy_timeout=${busyMs}`, () => resolve(db));
      });
    });
  });
}

async function rejeita(promise, code) {
  try { await promise; } catch (e) {
    assert.strictEqual(e.code, code, `esperado ${code}, obtido ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`esperava erro ${code}`);
  return null;
}
async function rejeitaSql(promise, trecho) {
  try { await promise; } catch (e) {
    assert.ok(String(e.message).includes(trecho), `esperado "${trecho}" em: ${e.message}`);
    return;
  }
  assert.fail(`esperava erro SQL contendo ${trecho}`);
}

let seq = 0;
const key = (p = 'k') => `${p}-${++seq}`;
const REF = { tipo: 'PEDIDO', id: 'ref' };
const rp = (empresaId, categoriaFiscal, pedidoId, extra = {}) => ({
  empresaId, categoriaFiscal, pedidoId, usuarioId: 1, motivo: 'Reserva de teste', referencia: REF, idempotencyKey: key(), ...extra
});
const mov = (empresaId, categoriaFiscal, ml) => ({
  empresaId, categoriaFiscal, usuarioId: 1, motivo: 'abertura', referencia: { tipo: 'CONF', id: '1' },
  idempotencyKey: key('ab'), quantidadeMl: ml, confirmado: true
});

async function montar(db) {
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0)`);
  await run(db, `CREATE TABLE estoque_empresa (id INTEGER PRIMARY KEY, produto_id INTEGER, empresa_id INTEGER, saldo_fiscal REAL)`);
  await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'AGUARDANDO_FATURAMENTO', venda_id INTEGER, empresa_id INTEGER REFERENCES empresas(id))`);
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY, total REAL)`);
  const A = (await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A' }, { db })).id;
  const B = (await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'B' }, { db })).id;
  const ped = async (empresa, status = 'PEDIDO') => (await run(db, 'INSERT INTO pedidos (total, status, empresa_id) VALUES (100, ?, ?)', [status, empresa])).lastID;
  return { A, B, ped };
}

async function snapshotOperacional(db) {
  return JSON.stringify({
    produtos: await all(db, 'SELECT * FROM produtos ORDER BY id'),
    estoque: await all(db, 'SELECT * FROM estoque_empresa ORDER BY id'),
    pedidos: await all(db, 'SELECT * FROM pedidos ORDER BY id'),
    vendas: await all(db, 'SELECT * FROM vendas ORDER BY id'),
    movimentos2B: await all(db, 'SELECT * FROM saldo_fiscal_categoria_movimentos ORDER BY id')
  });
}

async function verificarInvariantes(db, empresaId, categoria) {
  const s = await get(db, 'SELECT * FROM saldo_fiscal_categoria_empresa WHERE empresa_id=? AND categoria_fiscal=?', [empresaId, categoria]);
  assert.ok(s.saldo_atual_ml >= 0 && s.saldo_reservado_ml >= 0 && s.saldo_reservado_ml <= s.saldo_atual_ml, 'invariante de saldo');
  const soma = (await get(db, `SELECT COALESCE(SUM(quantidade_reservada_ml),0) t FROM saldo_fiscal_categoria_reservas WHERE empresa_id=? AND categoria_fiscal=? AND status='ATIVA'`, [empresaId, categoria])).t;
  assert.strictEqual(soma, s.saldo_reservado_ml, 'soma das reservas ativas != saldo_reservado_ml');
  const evs = await all(db, 'SELECT * FROM saldo_fiscal_categoria_reserva_eventos WHERE empresa_id=? AND categoria_fiscal=? ORDER BY id', [empresaId, categoria]);
  assert.strictEqual(evs.reduce((a, e) => a + e.delta_ml, 0), s.saldo_reservado_ml, 'soma dos deltas != reservado');
  let corrente = 0;
  for (const e of evs) { assert.strictEqual(e.reservado_anterior_ml, corrente, 'encadeamento de eventos'); corrente = e.reservado_posterior_ml; }
  assert.strictEqual(corrente, s.saldo_reservado_ml);
  const ativas = await all(db, `SELECT pedido_id, COUNT(*) n FROM saldo_fiscal_categoria_reservas WHERE empresa_id=? AND categoria_fiscal=? AND status='ATIVA' GROUP BY pedido_id`, [empresaId, categoria]);
  assert.ok(ativas.every((r) => r.n === 1), 'reserva ativa duplicada');
  return s;
}

async function testesUnitarios() {
  const db = await abrir(':memory:');
  const { A, B, ped } = await montar(db);
  await run(db, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('P', 11, 4, 15)`);
  await run(db, `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal) VALUES (1, ${A}, 9)`);
  await run(db, `INSERT INTO vendas (total) VALUES (100)`);

  // Serviço não cria schema: ausente => erro estruturado, sem criar nada
  const p0 = await ped(A);
  await rejeita(Res.reservar(rp(A, 'REFRIGERANTE', p0, { quantidadeMl: 1 }), { db }), 'SCHEMA_RESERVA_AUSENTE');
  await garantirSchemaSaldoFiscalCategoriaAsync(db);
  await rejeita(Res.reservar(rp(A, 'REFRIGERANTE', p0, { quantidadeMl: 1 }), { db }), 'SCHEMA_RESERVA_AUSENTE');
  assert.strictEqual((await all(db, `SELECT name FROM sqlite_master WHERE name LIKE '%reserva%'`)).length, 0, 'serviço não pode criar schema');

  // ---------- Schema ----------
  await garantirSchemaReservaSaldoFiscalCategoriaAsync(db);
  await garantirSchemaReservaSaldoFiscalCategoriaAsync(db);
  const nomes = (await all(db, `SELECT name FROM sqlite_master WHERE name LIKE '%saldo_fiscal%reserva%'`)).map((r) => r.name);
  for (const n of ['saldo_fiscal_categoria_reservas', 'saldo_fiscal_categoria_reserva_eventos', 'uq_saldo_fiscal_reserva_ativa_pedido',
    'trg_saldo_fiscal_reserva_ev_no_update', 'trg_saldo_fiscal_reserva_ev_no_delete', 'trg_saldo_fiscal_reserva_no_delete']) assert.ok(nomes.includes(n), n);
  await Saldo.registrarAbertura(mov(A, 'REFRIGERANTE', 10000), { db });
  await Saldo.registrarAbertura(mov(A, 'AGUA', 5000), { db });
  await Saldo.registrarAbertura(mov(B, 'REFRIGERANTE', 3000), { db });
  const antesOperacional = await snapshotOperacional(db);

  const insRes = (e, c, p, q, st = 'ATIVA', extra = '') =>
    run(db, `INSERT INTO saldo_fiscal_categoria_reservas (empresa_id, categoria_fiscal, pedido_id, quantidade_reservada_ml, status, idempotency_key ${extra ? ', liberada_em, motivo_liberacao' : ''})
             VALUES (${e}, '${c}', ${p}, ${q}, '${st}', '${key('raw')}' ${extra})`);
  await rejeitaSql(insRes(A, 'REFRIGERANTE', 1, 0), 'CHECK');
  await rejeitaSql(insRes(A, 'REFRIGERANTE', 1, -5), 'CHECK');
  await rejeitaSql(insRes(A, 'REFRIGERANTE', 1, 1.5), 'CHECK');
  await rejeitaSql(insRes(A, 'SUCO', 1, 5), 'CHECK');
  await rejeitaSql(insRes(A, 'REFRIGERANTE', 1, 5, 'CONSUMIDA'), 'CHECK');
  await rejeitaSql(insRes(999, 'REFRIGERANTE', 1, 5), 'FOREIGN KEY');
  await rejeitaSql(insRes(B, 'AGUA', 1, 5), 'FOREIGN KEY'); // B não possui saldo AGUA
  await insRes(A, 'REFRIGERANTE', 777, 5);
  await rejeitaSql(insRes(A, 'REFRIGERANTE', 777, 5), 'UNIQUE');
  await run(db, 'DELETE FROM saldo_fiscal_categoria_reservas WHERE 0'); // no-op permitido
  await rejeitaSql(run(db, 'DELETE FROM saldo_fiscal_categoria_reservas'), 'HISTORICO_IMUTAVEL');
  await rejeitaSql(run(db, `UPDATE saldo_fiscal_categoria_reservas SET pedido_id = 9`), 'RESERVA_IDENTIDADE_IMUTAVEL');
  await rejeitaSql(run(db, `UPDATE saldo_fiscal_categoria_empresa SET saldo_reservado_ml = 5 WHERE empresa_id = ${A} AND categoria_fiscal = 'AGUA'`).then(() =>
    run(db, `UPDATE saldo_fiscal_categoria_empresa SET saldo_reservado_ml = 999999 WHERE empresa_id = ${A} AND categoria_fiscal = 'AGUA'`)), 'CHECK');
  // limpeza das linhas cruas de teste (via SQL de teste; a tabela de reservas proíbe DELETE, então recria-se o ambiente)
  await fechar(db);

  // ---------- Ambiente limpo para os cenários funcionais ----------
  const d = await abrir(':memory:');
  const amb = await montar(d);
  const { A: EA, B: EB } = amb;
  await run(d, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('P', 11, 4, 15)`);
  await run(d, `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal) VALUES (1, ${EA}, 9)`);
  await run(d, `INSERT INTO vendas (total) VALUES (100)`);
  await garantirSchemaSaldoFiscalCategoriaAsync(d);
  await garantirSchemaReservaSaldoFiscalCategoriaAsync(d);
  await Saldo.registrarAbertura(mov(EA, 'REFRIGERANTE', 10000), { db: d });
  await Saldo.registrarAbertura(mov(EA, 'AGUA', 5000), { db: d });
  await Saldo.registrarAbertura(mov(EB, 'REFRIGERANTE', 3000), { db: d });
  await Saldo.garantirSaldo({ empresaId: EB, categoriaFiscal: 'AGUA' }, { db: d });
  const base0 = await snapshotOperacional(d);
  const pA1 = await amb.ped(EA); const pA2 = await amb.ped(EA); const pB1 = await amb.ped(EB);
  const pFat = await amb.ped(EA, 'FATURADO'); const pCan = await amb.ped(EA, 'CANCELADO'); const pOrc = await amb.ped(EA, 'ORCAMENTO');
  const pSem = (await run(d, `INSERT INTO pedidos (total, status, empresa_id) VALUES (1, 'PEDIDO', NULL)`)).lastID;

  // Reserva válida
  const k1 = key('r');
  const r1 = await Res.reservar(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 3000, idempotencyKey: k1 }), { db: d });
  assert.strictEqual(r1.idempotente, false);
  assert.strictEqual(r1.reserva.status, 'ATIVA');
  assert.strictEqual(r1.reserva.quantidadeReservadaMl, 3000);
  assert.strictEqual(r1.saldo.saldoReservadoMl, 3000);
  assert.strictEqual(r1.saldo.saldoAtualMl, 10000);
  assert.strictEqual(r1.saldo.saldoDisponivelMl, 7000);
  assert.strictEqual(r1.evento.tipo, 'RESERVA');
  assert.strictEqual(r1.evento.deltaMl, 3000);
  console.log('ok reserva válida');

  // Idempotência
  const rep = await Res.reservar(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 3000, idempotencyKey: k1 }), { db: d });
  assert.strictEqual(rep.idempotente, true);
  assert.strictEqual(rep.reserva.id, r1.reserva.id);
  assert.strictEqual(rep.evento.id, r1.evento.id);
  assert.strictEqual((await verificarInvariantes(d, EA, 'REFRIGERANTE')).saldo_reservado_ml, 3000);
  for (const alt of [{ quantidadeMl: 3001 }, { pedidoId: pA2 }, { categoriaFiscal: 'AGUA' }, { motivo: 'outro' },
    { referencia: { tipo: 'PEDIDO', id: 'outra' } }, { usuarioId: 2 }, { usuarioId: undefined, origemSistemica: 'JOB' }]) {
    await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 3000, idempotencyKey: k1, ...alt }), { db: d }), 'IDEMPOTENCY_CONFLITO');
  }
  console.log('ok idempotência e conflito de payload');

  // Validações de entrada
  for (const q of [0, -1, 1.5, '10', NaN, null, undefined]) {
    await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: q }), { db: d }), 'QUANTIDADE_INVALIDA');
  }
  await rejeita(Res.reservar(rp(EA, 'SUCO', pA2, { quantidadeMl: 1 }), { db: d }), 'CATEGORIA_FISCAL_INVALIDA');
  await rejeita(Res.reservar(rp(EA, undefined, pA2, { quantidadeMl: 1 }), { db: d }), 'CATEGORIA_FISCAL_OBRIGATORIA');
  await rejeita(Res.reservar(rp(999, 'REFRIGERANTE', pA2, { quantidadeMl: 1 }), { db: d }), 'EMPRESA_NAO_ENCONTRADA');
  await rejeita(Res.reservar(rp(undefined, 'REFRIGERANTE', pA2, { quantidadeMl: 1 }), { db: d }), 'EMPRESA_OBRIGATORIA');
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', undefined, { quantidadeMl: 1 }), { db: d }), 'PEDIDO_OBRIGATORIO');
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 1, idempotencyKey: ' ' }), { db: d }), 'IDEMPOTENCY_KEY_OBRIGATORIA');
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 1, motivo: '' }), { db: d }), 'MOTIVO_OBRIGATORIO');
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 1, usuarioId: undefined }), { db: d }), 'OPERADOR_OBRIGATORIO');
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 1, origemSistemica: 'X' }), { db: d }), 'OPERADOR_AMBIGUO');
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 1, referencia: null }), { db: d }), 'REFERENCIA_OBRIGATORIA');
  console.log('ok validações de entrada');

  // Contexto do Pedido
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', 99999, { quantidadeMl: 1 }), { db: d }), 'PEDIDO_NAO_ENCONTRADO');
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pB1, { quantidadeMl: 1 }), { db: d }), 'PEDIDO_EMPRESA_DIVERGENTE');
  await rejeita(Res.reservar(rp(EB, 'REFRIGERANTE', pA1, { quantidadeMl: 1 }), { db: d }), 'PEDIDO_EMPRESA_DIVERGENTE');
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pSem, { quantidadeMl: 1 }), { db: d }), 'PEDIDO_SEM_EMPRESA');
  for (const p of [pFat, pCan, pOrc]) await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', p, { quantidadeMl: 1 }), { db: d }), 'PEDIDO_STATUS_INVALIDO');
  console.log('ok validação de Pedido/empresa/status');

  // Saldo
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 7001 }), { db: d }), 'SALDO_INSUFICIENTE');
  assert.strictEqual((await verificarInvariantes(d, EA, 'REFRIGERANTE')).saldo_reservado_ml, 3000);
  await Saldo.garantirSaldo({ empresaId: EA, categoriaFiscal: 'AGUA' }, { db: d });
  const dSemSaldo = await get(d, `SELECT COUNT(*) n FROM saldo_fiscal_categoria_empresa WHERE empresa_id=${EB} AND categoria_fiscal='AGUA'`);
  assert.strictEqual(dSemSaldo.n, 1);
  // saldo inexistente: usa empresa sem linha de saldo
  const EC = (await EmpresaService.criarEmpresa({ cnpj: '45723174000110', razao_social: 'C' }, { db: d })).id;
  const pC = await amb.ped(EC);
  await rejeita(Res.reservar(rp(EC, 'AGUA', pC, { quantidadeMl: 1 }), { db: d }), 'SALDO_NAO_ENCONTRADO');
  assert.strictEqual((await get(d, 'SELECT COUNT(*) n FROM saldo_fiscal_categoria_empresa WHERE empresa_id = ?', [EC])).n, 0, 'não abre nem cria saldo');
  await Res.reservar(rp(EB, 'AGUA', pB1, { quantidadeMl: 1 }), { db: d }).then(() => assert.fail('saldo zero deveria rejeitar'), (e) => assert.strictEqual(e.code, 'SALDO_INSUFICIENTE'));
  console.log('ok saldo insuficiente / não inicializado / sem abertura automática');

  // Segunda reserva ativa para o mesmo Pedido/categoria
  await rejeita(Res.reservar(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 100 }), { db: d }), 'RESERVA_ATIVA_EXISTENTE');
  assert.strictEqual((await verificarInvariantes(d, EA, 'REFRIGERANTE')).saldo_reservado_ml, 3000);

  // Isolamento por empresa e categoria
  await Res.reservar(rp(EA, 'AGUA', pA1, { quantidadeMl: 1000 }), { db: d });
  await Res.reservar(rp(EB, 'REFRIGERANTE', pB1, { quantidadeMl: 3000 }), { db: d });
  assert.strictEqual((await Saldo.obterSaldo({ empresaId: EA, categoriaFiscal: 'REFRIGERANTE' }, { db: d })).saldoReservadoMl, 3000);
  assert.strictEqual((await Saldo.obterSaldo({ empresaId: EA, categoriaFiscal: 'AGUA' }, { db: d })).saldoReservadoMl, 1000);
  assert.strictEqual((await Saldo.obterSaldo({ empresaId: EB, categoriaFiscal: 'REFRIGERANTE' }, { db: d })).saldoReservadoMl, 3000);
  for (const [e, c] of [[EA, 'REFRIGERANTE'], [EA, 'AGUA'], [EB, 'REFRIGERANTE']]) await verificarInvariantes(d, e, c);
  console.log('ok isolamento por empresa e categoria');

  // Ajuste
  const ka = key('aj');
  const a1 = await Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 5000, idempotencyKey: ka }), { db: d });
  assert.strictEqual(a1.reserva.quantidadeReservadaMl, 5000);
  assert.strictEqual(a1.saldo.saldoReservadoMl, 5000);
  assert.strictEqual(a1.evento.tipo, 'AJUSTE_RESERVA');
  assert.strictEqual(a1.evento.deltaMl, 2000);
  assert.strictEqual((await Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 5000, idempotencyKey: ka }), { db: d })).idempotente, true);
  await rejeita(Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 4000, idempotencyKey: ka }), { db: d }), 'IDEMPOTENCY_CONFLITO');
  await rejeita(Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 5000 }), { db: d }), 'RESERVA_SEM_ALTERACAO');
  await rejeita(Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 10001 }), { db: d }), 'SALDO_INSUFICIENTE');
  const a2 = await Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 1200 }), { db: d });
  assert.strictEqual(a2.saldo.saldoReservadoMl, 1200);
  assert.strictEqual(a2.saldo.saldoAtualMl, 10000, 'redução não altera saldo atual');
  assert.strictEqual(a2.evento.deltaMl, -3800);
  for (const q of [0, -3, 2.5]) await rejeita(Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: q }), { db: d }), 'QUANTIDADE_INVALIDA');
  await rejeita(Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 10 }), { db: d }), 'RESERVA_NAO_ENCONTRADA');
  await rejeita(Res.ajustarReserva(rp(EB, 'REFRIGERANTE', pA1, { quantidadeMl: 10 }), { db: d }), 'PEDIDO_EMPRESA_DIVERGENTE');
  await rejeita(Res.ajustarReserva(rp(EA, 'AGUA', pA2, { quantidadeMl: 10 }), { db: d }), 'RESERVA_NAO_ENCONTRADA');
  await verificarInvariantes(d, EA, 'REFRIGERANTE');
  console.log('ok ajuste (aumento, redução, rejeições, idempotência)');

  // Saldo 2B não pode reduzir abaixo do reservado
  await rejeita(Saldo.ajustar({ empresaId: EA, categoriaFiscal: 'REFRIGERANTE', tipo: 'AJUSTE_SAIDA', quantidadeMl: 9000, usuarioId: 1, motivo: 'x', referencia: REF, idempotencyKey: key() }, { db: d }), 'SALDO_INSUFICIENTE');

  // Liberação
  const kl = key('lib');
  const l1 = await Res.liberarReserva(rp(EA, 'REFRIGERANTE', pA1, { idempotencyKey: kl, motivo: 'Cliente desistiu' }), { db: d });
  assert.strictEqual(l1.idempotente, false);
  assert.strictEqual(l1.reserva.status, 'LIBERADA');
  assert.strictEqual(l1.reserva.quantidadeReservadaMl, 0);
  assert.ok(l1.reserva.liberadaEm);
  assert.strictEqual(l1.reserva.motivoLiberacao, 'Cliente desistiu');
  assert.strictEqual(l1.saldo.saldoReservadoMl, 0);
  assert.strictEqual(l1.saldo.saldoAtualMl, 10000, 'liberação não altera saldo atual');
  assert.strictEqual(l1.evento.tipo, 'LIBERACAO_RESERVA');
  assert.strictEqual(l1.evento.deltaMl, -1200);
  const lrep = await Res.liberarReserva(rp(EA, 'REFRIGERANTE', pA1, { idempotencyKey: kl, motivo: 'Cliente desistiu' }), { db: d });
  assert.strictEqual(lrep.idempotente, true);
  assert.strictEqual(lrep.evento.id, l1.evento.id);
  await rejeita(Res.liberarReserva({ ...rp(EA, 'REFRIGERANTE', pA1, { idempotencyKey: kl, motivo: 'Cliente desistiu' }), pedidoId: pA2 }, { db: d }), 'IDEMPOTENCY_CONFLITO');
  await rejeita(Res.liberarReserva(rp(EA, 'REFRIGERANTE', pA1), { db: d }), 'RESERVA_JA_LIBERADA');
  await rejeita(Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 10 }), { db: d }), 'RESERVA_JA_LIBERADA');
  await rejeita(Res.liberarReserva(rp(EA, 'REFRIGERANTE', pA2), { db: d }), 'RESERVA_NAO_ENCONTRADA');
  await rejeita(Res.liberarReserva(rp(EB, 'REFRIGERANTE', pA1), { db: d }), 'PEDIDO_EMPRESA_DIVERGENTE');
  await rejeita(Res.liberarReserva(rp(EA, 'AGUA', pA2), { db: d }), 'RESERVA_NAO_ENCONTRADA');
  // A água do mesmo pedido segue ativa e intacta
  assert.strictEqual((await Res.obterReserva({ empresaId: EA, categoriaFiscal: 'AGUA', pedidoId: pA1 }, { db: d })).quantidadeReservadaMl, 1000);
  // liberar permanece possível para Pedido cancelado (sem checar status)
  await run(d, `UPDATE pedidos SET status = 'CANCELADO' WHERE id = ${pA1}`);
  const lAgua = await Res.liberarReserva(rp(EA, 'AGUA', pA1, { motivo: 'Pedido cancelado' }), { db: d });
  assert.strictEqual(lAgua.reserva.status, 'LIBERADA');
  await rejeita(Res.reservar(rp(EA, 'AGUA', pA1, { quantidadeMl: 10 }), { db: d }), 'PEDIDO_STATUS_INVALIDO');
  await run(d, `UPDATE pedidos SET status = 'PEDIDO' WHERE id = ${pA1}`);
  // Reserva liberada não é reativada por repetição; nova reserva exige nova chave e cria nova linha
  assert.strictEqual((await Res.reservar(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 3000, idempotencyKey: k1 }), { db: d })).idempotente, true);
  assert.strictEqual((await Res.obterReserva({ empresaId: EA, categoriaFiscal: 'REFRIGERANTE', pedidoId: pA1 }, { db: d })).status, 'LIBERADA');
  const nova = await Res.reservar(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 500 }), { db: d });
  assert.notStrictEqual(nova.reserva.id, r1.reserva.id);
  await verificarInvariantes(d, EA, 'REFRIGERANTE');
  console.log('ok liberação, repetição, nova chave rejeitada, isolamentos');

  // Consulta
  assert.strictEqual(await Res.obterReserva({ empresaId: EB, categoriaFiscal: 'REFRIGERANTE', pedidoId: pA1 }, { db: d }), null, 'outra empresa não enxerga a reserva');
  assert.strictEqual(await Res.obterReserva({ empresaId: EB, categoriaFiscal: 'REFRIGERANTE', pedidoId: pA1, reservaId: r1.reserva.id }, { db: d }), null);
  const lista = await Res.listarReservasAtivas({ empresaId: EA, categoriaFiscal: 'REFRIGERANTE', limite: 1 }, { db: d });
  assert.strictEqual(lista.itens.length, 1);
  assert.ok(lista.itens.every((r) => r.empresaId === EA && r.categoriaFiscal === 'REFRIGERANTE' && r.status === 'ATIVA'));
  await rejeita(Res.listarReservasAtivas({ categoriaFiscal: 'AGUA' }, { db: d }), 'EMPRESA_OBRIGATORIA');
  await rejeita(Res.listarReservasAtivas({ empresaId: EA }, { db: d }), 'CATEGORIA_FISCAL_OBRIGATORIA');
  console.log('ok consulta e listagem filtradas por empresa/categoria');

  // Histórico imutável
  const ev = await get(d, 'SELECT id FROM saldo_fiscal_categoria_reserva_eventos LIMIT 1');
  await rejeitaSql(run(d, `UPDATE saldo_fiscal_categoria_reserva_eventos SET motivo='x' WHERE id=${ev.id}`), 'HISTORICO_IMUTAVEL');
  await rejeitaSql(run(d, `DELETE FROM saldo_fiscal_categoria_reserva_eventos WHERE id=${ev.id}`), 'HISTORICO_IMUTAVEL');
  await rejeitaSql(run(d, `UPDATE saldo_fiscal_categoria_reservas SET quantidade_reservada_ml = 5 WHERE id = ${r1.reserva.id}`), 'RESERVA_LIBERADA_FINAL');
  await rejeitaSql(run(d, `UPDATE saldo_fiscal_categoria_reservas SET status = 'ATIVA' WHERE id = ${r1.reserva.id}`), 'RESERVA_LIBERADA_FINAL');
  console.log('ok histórico e reserva liberada protegidos por SQL direto');

  // Inconsistência detectada bloqueia a operação
  await run(d, `UPDATE saldo_fiscal_categoria_empresa SET saldo_reservado_ml = saldo_reservado_ml + 1 WHERE empresa_id=${EB} AND categoria_fiscal='REFRIGERANTE'`).catch(() => {});
  const EbRef = await get(d, `SELECT saldo_atual_ml a, saldo_reservado_ml r FROM saldo_fiscal_categoria_empresa WHERE empresa_id=${EB} AND categoria_fiscal='REFRIGERANTE'`);
  if (EbRef.r === 3000) { // reservado == atual: o +1 foi barrado pelo CHECK; usa a água de A
    await run(d, `UPDATE saldo_fiscal_categoria_empresa SET saldo_reservado_ml = 7 WHERE empresa_id=${EA} AND categoria_fiscal='AGUA'`);
    await rejeita(Res.reservar(rp(EA, 'AGUA', pA2, { quantidadeMl: 1 }), { db: d }), 'RESERVA_INCONSISTENTE');
    await run(d, `UPDATE saldo_fiscal_categoria_empresa SET saldo_reservado_ml = 0 WHERE empresa_id=${EA} AND categoria_fiscal='AGUA'`);
  }
  console.log('ok inconsistência saldo reservado × reservas bloqueia operação');

  // Atomicidade: falha na gravação do evento reverte saldo e reserva
  await run(d, `CREATE TRIGGER trg_teste_falha BEFORE INSERT ON saldo_fiscal_categoria_reserva_eventos
    WHEN NEW.motivo = 'forcar-falha' BEGIN SELECT RAISE(ABORT, 'falha-forcada'); END`);
  const snapSaldo = async () => JSON.stringify([
    await all(d, 'SELECT * FROM saldo_fiscal_categoria_empresa ORDER BY id'),
    await all(d, 'SELECT * FROM saldo_fiscal_categoria_reservas ORDER BY id'),
    await all(d, 'SELECT * FROM saldo_fiscal_categoria_reserva_eventos ORDER BY id')
  ]);
  const ativaPA1 = await Res.obterReserva({ empresaId: EA, categoriaFiscal: 'REFRIGERANTE', pedidoId: pA1 }, { db: d });
  assert.strictEqual(ativaPA1.status, 'ATIVA');
  let antes = await snapSaldo();
  const kf = key('falha');
  await assert.rejects(Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 100, motivo: 'forcar-falha', idempotencyKey: kf }), { db: d }), /falha-forcada/);
  await assert.rejects(Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 900, motivo: 'forcar-falha' }), { db: d }), /falha-forcada/);
  await assert.rejects(Res.liberarReserva(rp(EA, 'REFRIGERANTE', pA1, { motivo: 'forcar-falha' }), { db: d }), /falha-forcada/);
  assert.strictEqual(await snapSaldo(), antes, 'rollback completo');
  await run(d, 'DROP TRIGGER trg_teste_falha');
  const depoisRb = await Res.reservar(rp(EA, 'REFRIGERANTE', pA2, { quantidadeMl: 100, idempotencyKey: kf }), { db: d });
  assert.strictEqual(depoisRb.idempotente, false, 'repetição após rollback é operação nova');
  await verificarInvariantes(d, EA, 'REFRIGERANTE');
  console.log('ok atomicidade: falha de gravação reverte saldo, reserva e evento');

  // Transação externa
  await run(d, 'BEGIN IMMEDIATE');
  await run(d, `UPDATE pedidos SET total = 123 WHERE id = ${pA1}`);
  await rejeita(Res.ajustarReserva(rp(EA, 'REFRIGERANTE', pA1, { quantidadeMl: 600 }), { db: d }), 'TRANSACAO_EXTERNA_ATIVA');
  assert.strictEqual((await get(d, `SELECT total FROM pedidos WHERE id=${pA1}`)).total, 123, 'transação do chamador intacta');
  await run(d, 'ROLLBACK');
  assert.strictEqual((await get(d, `SELECT total FROM pedidos WHERE id=${pA1}`)).total, 100);
  console.log('ok transação externa rejeitada sem tocar a do chamador');

  // Não regressão: nenhum dado operacional alterado (pedidos tiveram status/total restaurados)
  await run(d, `UPDATE pedidos SET status = 'PEDIDO' WHERE id = ${pA1}`);
  const depOperacional = JSON.parse(await snapshotOperacional(d));
  const baseOperacional = JSON.parse(base0);
  assert.deepStrictEqual(depOperacional.produtos, baseOperacional.produtos);
  assert.deepStrictEqual(depOperacional.estoque, baseOperacional.estoque);
  assert.deepStrictEqual(depOperacional.vendas, baseOperacional.vendas);
  assert.deepStrictEqual(depOperacional.movimentos2B, baseOperacional.movimentos2B, 'ledger 2B inalterado por reservas');
  const saldoAtualAll = await all(d, 'SELECT empresa_id, categoria_fiscal, saldo_atual_ml FROM saldo_fiscal_categoria_empresa ORDER BY id');
  assert.deepStrictEqual(saldoAtualAll.filter((r) => r.empresa_id === EA && r.categoria_fiscal === 'REFRIGERANTE').map((r) => r.saldo_atual_ml), [10000]);
  console.log('ok não regressão: produtos, estoque_empresa, vendas, ledger 2B e saldo atual inalterados');
  await fechar(d);
}

async function testesConcorrencia() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reserva-saldo-fiscal-'));
  const arquivo = path.join(dir, 'teste.db');
  try {
    const c = [await abrir(arquivo), await abrir(arquivo), await abrir(arquivo), await abrir(arquivo)];
    const { A, B, ped } = await montar(c[0]);
    await garantirSchemaSaldoFiscalCategoriaAsync(c[0]);
    await garantirSchemaReservaSaldoFiscalCategoriaAsync(c[0]);
    await Promise.all(c.slice(1).map((db) => garantirSchemaReservaSaldoFiscalCategoriaAsync(db)));
    await run(c[0], `INSERT INTO produtos (nome, saldo_fiscal) VALUES ('P', 5)`);
    await Saldo.registrarAbertura(mov(A, 'REFRIGERANTE', 1000), { db: c[0] });
    await Saldo.registrarAbertura(mov(A, 'AGUA', 1000), { db: c[0] });
    await Saldo.registrarAbertura(mov(B, 'REFRIGERANTE', 1000), { db: c[0] });
    const P = []; for (let i = 0; i < 14; i += 1) P.push(await ped(A));
    const PB = await ped(B);
    const ok = (rs) => rs.filter((r) => r.status === 'fulfilled');
    const falhas = (rs) => rs.filter((r) => r.status === 'rejected');
    const R = Promise.allSettled.bind(Promise);

    // 1. duas reservas que excedem
    let rs = await R([
      Res.reservar(rp(A, 'REFRIGERANTE', P[0], { quantidadeMl: 700 }), { db: c[0] }),
      Res.reservar(rp(A, 'REFRIGERANTE', P[1], { quantidadeMl: 700 }), { db: c[1] })
    ]);
    assert.strictEqual(ok(rs).length, 1);
    assert.strictEqual(falhas(rs)[0].reason.code, 'SALDO_INSUFICIENTE');
    assert.strictEqual((await verificarInvariantes(c[2], A, 'REFRIGERANTE')).saldo_reservado_ml, 700);
    console.log('ok conc 1: reservas excedentes (uma só)');

    // 2. duas reservas que cabem exatamente (300 + 0 restante): libera, depois 2 x 500
    const pend = (await get(c[2], `SELECT pedido_id FROM saldo_fiscal_categoria_reservas WHERE status='ATIVA' AND empresa_id=${A} AND categoria_fiscal='REFRIGERANTE'`)).pedido_id;
    await Res.liberarReserva(rp(A, 'REFRIGERANTE', pend), { db: c[0] });
    rs = await R([
      Res.reservar(rp(A, 'REFRIGERANTE', P[2], { quantidadeMl: 500 }), { db: c[0] }),
      Res.reservar(rp(A, 'REFRIGERANTE', P[3], { quantidadeMl: 500 }), { db: c[1] })
    ]);
    assert.strictEqual(ok(rs).length, 2);
    const s2 = await verificarInvariantes(c[2], A, 'REFRIGERANTE');
    assert.strictEqual(s2.saldo_reservado_ml, 1000);
    console.log('ok conc 2: duas reservas que cabem exatamente');

    // 3. criação inicial do mesmo Pedido (chaves diferentes e mesma chave)
    rs = await R([
      Res.reservar(rp(A, 'AGUA', P[4], { quantidadeMl: 200 }), { db: c[0] }),
      Res.reservar(rp(A, 'AGUA', P[4], { quantidadeMl: 200 }), { db: c[1] }),
      Res.reservar(rp(A, 'AGUA', P[4], { quantidadeMl: 200 }), { db: c[2] })
    ]);
    assert.strictEqual(ok(rs).length, 1);
    assert.ok(falhas(rs).every((f) => f.reason.code === 'RESERVA_ATIVA_EXISTENTE'));
    assert.strictEqual((await verificarInvariantes(c[3], A, 'AGUA')).saldo_reservado_ml, 200);
    console.log('ok conc 3: criação inicial do mesmo Pedido (uma reserva)');

    // 4. duas alterações da mesma reserva (chaves diferentes, quantidades diferentes)
    rs = await R([
      Res.ajustarReserva(rp(A, 'AGUA', P[4], { quantidadeMl: 400 }), { db: c[0] }),
      Res.ajustarReserva(rp(A, 'AGUA', P[4], { quantidadeMl: 600 }), { db: c[1] })
    ]);
    assert.strictEqual(ok(rs).length, 2, JSON.stringify(falhas(rs).map((f) => f.reason.message)));
    const final4 = (await get(c[2], `SELECT quantidade_reservada_ml q FROM saldo_fiscal_categoria_reservas WHERE pedido_id=${P[4]} AND status='ATIVA'`)).q;
    assert.ok([400, 600].includes(final4));
    assert.strictEqual((await verificarInvariantes(c[3], A, 'AGUA')).saldo_reservado_ml, final4);
    console.log('ok conc 4: alterações concorrentes serializadas (sem perda de atualização)');

    // 5. duas liberações da mesma reserva
    rs = await R([
      Res.liberarReserva(rp(A, 'AGUA', P[4]), { db: c[0] }),
      Res.liberarReserva(rp(A, 'AGUA', P[4]), { db: c[1] })
    ]);
    assert.strictEqual(ok(rs).length, 1);
    assert.strictEqual(falhas(rs)[0].reason.code, 'RESERVA_JA_LIBERADA');
    assert.strictEqual((await verificarInvariantes(c[2], A, 'AGUA')).saldo_reservado_ml, 0);
    assert.strictEqual((await all(c[2], `SELECT id FROM saldo_fiscal_categoria_reserva_eventos WHERE tipo='LIBERACAO_RESERVA' AND pedido_id=${P[4]}`)).length, 1);
    console.log('ok conc 5: liberação concorrente (uma só)');

    // 6. mesma chave idempotente em 4 conexões
    const k6 = key('mesma');
    const p6 = rp(A, 'AGUA', P[5], { quantidadeMl: 300, idempotencyKey: k6 });
    rs = await R(c.map((db) => Res.reservar({ ...p6 }, { db })));
    assert.strictEqual(ok(rs).length, 4);
    const v = ok(rs).map((r) => r.value);
    assert.strictEqual(v.filter((x) => !x.idempotente).length, 1);
    assert.strictEqual(new Set(v.map((x) => x.evento.id)).size, 1);
    assert.strictEqual((await verificarInvariantes(c[2], A, 'AGUA')).saldo_reservado_ml, 300);
    // mesma chave com payload diferente
    const k6b = key('dif');
    rs = await R([
      Res.reservar(rp(A, 'AGUA', P[6], { quantidadeMl: 100, idempotencyKey: k6b }), { db: c[0] }),
      Res.reservar(rp(A, 'AGUA', P[6], { quantidadeMl: 150, idempotencyKey: k6b }), { db: c[1] })
    ]);
    assert.strictEqual(ok(rs).length, 1);
    assert.strictEqual(falhas(rs)[0].reason.code, 'IDEMPOTENCY_CONFLITO');
    await verificarInvariantes(c[2], A, 'AGUA');
    console.log('ok conc 6: mesma chave (1 criada, repetições idempotentes; payload diferente conflita)');

    // 7 e 8. empresas e categorias distintas
    const antesA = (await verificarInvariantes(c[3], A, 'REFRIGERANTE')).saldo_reservado_ml;
    const antesAgua = (await verificarInvariantes(c[3], A, 'AGUA')).saldo_reservado_ml;
    rs = await R([
      Res.reservar(rp(B, 'REFRIGERANTE', PB, { quantidadeMl: 1000 }), { db: c[0] }),
      Res.liberarReserva(rp(A, 'REFRIGERANTE', P[2]), { db: c[1] }),
      Res.reservar(rp(A, 'AGUA', P[7], { quantidadeMl: 400 }), { db: c[2] })
    ]);
    assert.strictEqual(ok(rs).length, 3, JSON.stringify(falhas(rs).map((f) => f.reason.message)));
    assert.strictEqual((await verificarInvariantes(c[3], B, 'REFRIGERANTE')).saldo_reservado_ml, 1000);
    assert.strictEqual((await verificarInvariantes(c[3], A, 'REFRIGERANTE')).saldo_reservado_ml, antesA - 500);
    assert.strictEqual((await verificarInvariantes(c[3], A, 'AGUA')).saldo_reservado_ml, antesAgua + 400);
    console.log('ok conc 7/8: empresas e categorias distintas sem estado compartilhado');

    // Carga: 12 reservas de 100 (pedidos distintos) sobre disponível 600 de AGUA em 4 conexões
    const dispAgua = (await Saldo.obterSaldo({ empresaId: A, categoriaFiscal: 'AGUA' }, { db: c[0] })).saldoDisponivelMl;
    const pedidosCarga = [];
    for (let i = 0; i < 12; i += 1) pedidosCarga.push(await ped(A));
    rs = await R(pedidosCarga.map((p, i) => Res.reservar(rp(A, 'AGUA', p, { quantidadeMl: 100 }), { db: c[i % 4] })));
    assert.strictEqual(ok(rs).length, Math.floor(dispAgua / 100));
    assert.ok(falhas(rs).every((f) => f.reason.code === 'SALDO_INSUFICIENTE'));
    const sf = await verificarInvariantes(c[3], A, 'AGUA');
    assert.ok(sf.saldo_reservado_ml <= sf.saldo_atual_ml);
    console.log(`ok carga: 12 reservas concorrentes, ${ok(rs).length} aplicadas, reservado=${sf.saldo_reservado_ml}`);

    // Dados operacionais intactos
    assert.deepStrictEqual(await all(c[0], 'SELECT saldo_fiscal FROM produtos'), [{ saldo_fiscal: 5 }]);
  } finally {
    for (const db of conexoes.splice(0)) await fechar(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await testesUnitarios();
    await testesConcorrencia();
    console.log('reserva-saldo-fiscal-categoria: todos os testes passaram');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    for (const db of conexoes.splice(0)) await fechar(db);
  }
})();
