/**
 * MESAS-02 — atendimento de mesa, sem venda e sem banco oficial.
 *
 * Executar: node --test --test-concurrency=1 tests/pedidos/mesas-02-atendimento.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mesas02-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');
const MesaService = require('../../backend/services/pedido/MesaService');
const Atendimento = require('../../backend/services/pedido/MesaAtendimentoService');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
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

function open(arquivo) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo || ':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function base() {
  const db = await open();
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT, data_pedido TEXT, cliente_id INTEGER, total REAL DEFAULT 0,
    desconto REAL DEFAULT 0, status TEXT, operador_id INTEGER, venda_id INTEGER,
    empresa_id INTEGER, mesa_id INTEGER
  )`);
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, pedido_id INTEGER)`);
  await garantirSchemaMesas(db);
  return db;
}

async function mesa(db, empresaId, numero) {
  return (await MesaService.criar(empresaId, { numero }, { db })).mesa;
}

async function rejeita(fn, codigo) {
  await assert.rejects(fn, (err) => err && err.codigo === codigo, `esperado ${codigo}`);
}

describe('abertura', () => {
  it('abre atendimento em mesa livre e gera o horário no servidor', async () => {
    const db = await base();
    try {
      const livre = await mesa(db, 1, 1);
      const aberto = await Atendimento.abrir(1, livre.id, {
        operadorId: 8,
        clienteId: 5,
        aberto_em: '1999-01-01'
      }, { db });
      assert.equal(aberto.repetida, false);
      assert.equal(aberto.atendimento.estado, 'OCUPADA');
      assert.equal(aberto.atendimento.empresa_id, 1);
      assert.equal(aberto.atendimento.mesa_id, livre.id);
      assert.equal(aberto.atendimento.cliente_id, 5);
      assert.equal(aberto.atendimento.operador_abertura_id, 8);
      assert.notEqual(aberto.atendimento.aberto_em, '1999-01-01');
      assert.ok(aberto.atendimento.aberto_em);
      const vendas = await get(db, 'SELECT COUNT(*) AS total FROM vendas');
      assert.equal(vendas.total, 0);
    } finally { await close(db); }
  });

  it('recusa mesa inativa, inexistente e de outra empresa', async () => {
    const db = await base();
    try {
      const inativa = await mesa(db, 1, 2);
      await MesaService.atualizar(1, inativa.id, { ativo: false }, { db });
      await rejeita(() => Atendimento.abrir(1, inativa.id, { operadorId: 8 }, { db }), 'MESA_INATIVA');
      await rejeita(() => Atendimento.abrir(1, 999, { operadorId: 8 }, { db }), 'MESA_NAO_ENCONTRADA');
      const outra = await mesa(db, 1, 3);
      await rejeita(() => Atendimento.abrir(2, outra.id, { operadorId: 8 }, { db }), 'MESA_NAO_ENCONTRADA');
      const consulta = await assert.rejects(
        () => Atendimento.consultarAtivo(2, outra.id, { db }),
        (err) => err.codigo === 'MESA_NAO_ENCONTRADA'
      );
      assert.equal(consulta, undefined);
    } finally { await close(db); }
  });

  it('impede a segunda abertura e isola a mesma numeração em empresas diferentes', async () => {
    const db = await base();
    try {
      const a = await mesa(db, 1, 1);
      const b = await mesa(db, 2, 1);
      await Atendimento.abrir(1, a.id, { operadorId: 8 }, { db });
      await rejeita(() => Atendimento.abrir(1, a.id, { operadorId: 9 }, { db }), 'MESA_OCUPADA');
      const outraEmpresa = await Atendimento.abrir(2, b.id, { operadorId: 8 }, { db });
      assert.equal(outraEmpresa.atendimento.empresa_id, 2);
      assert.notEqual(outraEmpresa.atendimento.mesa_id, a.id);
      const situacao = await Atendimento.listarSituacao(1, { db });
      assert.equal(situacao.itens.length, 1);
      assert.equal(situacao.itens[0].situacao, 'OCUPADA');
      assert.equal(situacao.itens[0].atendimento.operador_abertura_id, 8);
      const alheia = JSON.stringify(await Atendimento.listarSituacao(2, { db }));
      assert.equal(alheia.includes('"empresa_id":1'), false);
    } finally { await close(db); }
  });
});

describe('concorrência e idempotência', () => {
  it('duas conexões disputando a mesma mesa deixam um único atendimento', async () => {
    const arquivo = path.join(dbDir, 'corrida.db');
    const a = await open(arquivo);
    const b = await open(arquivo);
    try {
      await run(a, 'PRAGMA busy_timeout = 8000');
      await run(b, 'PRAGMA busy_timeout = 8000');
      await garantirSchemaMesas(a);
      const livre = await mesa(a, 1, 8);
      const disputas = await Promise.allSettled([
        Atendimento.abrir(1, livre.id, { operadorId: 8 }, { db: a }),
        Atendimento.abrir(1, livre.id, { operadorId: 9 }, { db: b })
      ]);
      const vencedores = disputas.filter((item) => item.status === 'fulfilled');
      const recusas = disputas.filter((item) => item.status === 'rejected');
      assert.equal(vencedores.length, 1);
      assert.equal(recusas.length, 1);
      assert.equal(recusas[0].reason.codigo, 'MESA_OCUPADA');
      const total = await get(a, `SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE estado = 'OCUPADA'`);
      assert.equal(total.total, 1);
    } finally {
      await close(a);
      await close(b);
    }
  });

  it('repete a mesma chave e rejeita a chave em outro contexto', async () => {
    const db = await base();
    try {
      const primeira = await mesa(db, 1, 1);
      const segunda = await mesa(db, 1, 2);
      const outraEmpresa = await mesa(db, 2, 1);
      const abertura = await Atendimento.abrir(1, primeira.id, { operadorId: 8, idempotencyKey: 'abre-1' }, { db });
      const repetida = await Atendimento.abrir(1, primeira.id, { operadorId: 8, idempotencyKey: 'abre-1' }, { db });
      assert.equal(repetida.repetida, true);
      assert.equal(repetida.atendimento.id, abertura.atendimento.id);
      const contagem = await get(db, `SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE idempotency_key = 'abre-1'`);
      assert.equal(contagem.total, 1);
      await rejeita(
        () => Atendimento.abrir(1, segunda.id, { operadorId: 8, idempotencyKey: 'abre-1' }, { db }),
        'CHAVE_IDEMPOTENCIA_DIVERGENTE'
      );
      await rejeita(
        () => Atendimento.abrir(1, primeira.id, { operadorId: 3, idempotencyKey: 'abre-1' }, { db }),
        'CHAVE_IDEMPOTENCIA_DIVERGENTE'
      );
      await rejeita(
        () => Atendimento.abrir(2, outraEmpresa.id, { operadorId: 8, idempotencyKey: 'abre-1' }, { db }),
        'CHAVE_IDEMPOTENCIA_DIVERGENTE'
      );
    } finally { await close(db); }
  });
});

describe('consulta, encerramento e pedido legado', () => {
  it('mostra livre, ocupada e não revela atendimento de outra empresa', async () => {
    const db = await base();
    try {
      const ocupada = await mesa(db, 1, 1);
      const livre = await mesa(db, 1, 2);
      await Atendimento.abrir(1, ocupada.id, { operadorId: 8 }, { db });
      const painel = await Atendimento.listarSituacao(1, { db });
      const porNumero = new Map(painel.itens.map((item) => [item.numero, item.situacao]));
      assert.equal(porNumero.get(1), 'OCUPADA');
      assert.equal(porNumero.get(2), 'LIVRE');
      const atual = await Atendimento.consultarAtivo(1, ocupada.id, { db });
      assert.equal(atual.situacao, 'OCUPADA');
      assert.equal(atual.atendimento.mesa_id, ocupada.id);
      await rejeita(() => Atendimento.consultarAtivo(2, ocupada.id, { db }), 'MESA_NAO_ENCONTRADA');
      const vazia = await Atendimento.consultarAtivo(1, livre.id, { db });
      assert.equal(vazia.situacao, 'LIVRE');
      assert.equal(vazia.atendimento, null);
    } finally { await close(db); }
  });

  it('encerra sem venda e recusa repetir ou encerrar com pedido vinculado em aberto', async () => {
    const db = await base();
    try {
      const livre = await mesa(db, 1, 4);
      const aberto = await Atendimento.abrir(1, livre.id, { operadorId: 8 }, { db });
      const fim = await Atendimento.encerrar(1, livre.id, { operadorId: 9 }, { db });
      assert.equal(fim.situacao, 'LIVRE');
      assert.equal(fim.atendimento.estado, 'ENCERRADO');
      assert.equal(fim.atendimento.operador_encerramento_id, 9);
      assert.equal(fim.atendimento.aberto_em, aberto.atendimento.aberto_em);
      assert.ok(fim.atendimento.encerrado_em);
      const vendas = await get(db, 'SELECT COUNT(*) AS total FROM vendas');
      assert.equal(vendas.total, 0);
      await rejeita(() => Atendimento.encerrar(1, livre.id, { operadorId: 9 }, { db }), 'ATENDIMENTO_JA_ENCERRADO');
      const preservado = await get(db, 'SELECT encerrado_em, estado FROM mesa_atendimentos WHERE id = ?', [fim.atendimento.id]);
      assert.equal(preservado.encerrado_em, fim.atendimento.encerrado_em);
      assert.equal(preservado.estado, 'ENCERRADO');

      const deNovo = await Atendimento.abrir(1, livre.id, { operadorId: 8 }, { db });
      await run(db, `UPDATE mesa_atendimentos SET estado = 'FECHAMENTO' WHERE id = ?`, [deNovo.atendimento.id]);
      await rejeita(() => Atendimento.encerrar(1, livre.id, { operadorId: 8 }, { db }), 'ATENDIMENTO_EM_FECHAMENTO');

      const comPedido = await mesa(db, 1, 5);
      const atendimento = await Atendimento.abrir(1, comPedido.id, { operadorId: 8 }, { db });
      await run(db, `
        INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total)
        VALUES ('LEGADO-NAO', 'PEDIDO', 1, ?, ?, 10)
      `, [comPedido.id, atendimento.atendimento.id]);
      await rejeita(() => Atendimento.encerrar(1, comPedido.id, { operadorId: 8 }, { db }), 'ATENDIMENTO_COM_PEDIDO_ABERTO');
      const segueOcupada = await get(db, 'SELECT estado FROM mesa_atendimentos WHERE id = ?', [atendimento.atendimento.id]);
      assert.equal(segueOcupada.estado, 'OCUPADA');
    } finally { await close(db); }
  });

  it('não altera pedido legado que só tem mesa_id', async () => {
    const db = await base();
    try {
      const livre = await mesa(db, 1, 6);
      const antes = await run(db, `
        INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, total)
        VALUES ('ANTIGO', 'PEDIDO', 1, ?, 15)
      `, [livre.id]);
      const atendimento = await Atendimento.abrir(1, livre.id, { operadorId: 8 }, { db });
      await Atendimento.encerrar(1, livre.id, { operadorId: 8 }, { db });
      const pedido = await get(db, 'SELECT status, mesa_id, mesa_atendimento_id, venda_id FROM pedidos WHERE id = ?', [antes.lastID]);
      assert.equal(pedido.status, 'PEDIDO');
      assert.equal(pedido.mesa_id, livre.id);
      assert.equal(pedido.mesa_atendimento_id, null);
      assert.equal(pedido.venda_id, null);
      assert.notEqual(atendimento.atendimento.id, null);
      const painel = await Atendimento.listarSituacao(1, { db });
      assert.equal(painel.itens[0].situacao, 'LIVRE');
    } finally { await close(db); }
  });
});

describe('rotas', () => {
  it('usa a empresa do contexto e o operador da sessão', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '../../backend/rotas/mesas.js'), 'utf8');
    assert.match(fonte, /router\.get\('\/situacao'/);
    assert.match(fonte, /router\.post\('\/:id\/atendimento'/);
    assert.match(fonte, /router\.post\('\/:id\/atendimento\/encerrar'/);
    assert.match(fonte, /empresaIdDoReqPedido\(req\)/);
    assert.match(fonte, /operadorDaSessao\(req\)/);
    assert.doesNotMatch(fonte, /body\.empresa_id/);
    assert.doesNotMatch(fonte, /body\.operador_id/);
  });
});
