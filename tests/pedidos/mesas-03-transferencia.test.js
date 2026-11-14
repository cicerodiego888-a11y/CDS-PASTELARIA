/**
 * MESAS-03 — transferência atômica de atendimento, sem venda e sem banco oficial.
 *
 * Executar: node --test --test-concurrency=1 tests/pedidos/mesas-03-transferencia.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mesas03-'));
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
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id INTEGER, produto_id INTEGER, quantidade REAL, preco_unitario REAL, subtotal REAL
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

async function ocupar(db, empresaId, mesaId, operadorId, clienteId) {
  return Atendimento.abrir(empresaId, mesaId, { operadorId, clienteId }, { db });
}

describe('transferência', () => {
  it('move o mesmo atendimento para a mesa livre e preserva abertura, cliente e pedido', async () => {
    const db = await base();
    try {
      const origem = await mesa(db, 1, 1);
      const destino = await mesa(db, 1, 5);
      const aberto = await ocupar(db, 1, origem.id, 8, 5);
      const pedido = await run(db, `
        INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total, desconto)
        VALUES ('P-1', 'PEDIDO', 1, ?, ?, 40, 0)
      `, [origem.id, aberto.atendimento.id]);
      await run(db, `
        INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
        VALUES (?, 3, 4, 10, 40)
      `, [pedido.lastID]);

      const resultado = await Atendimento.transferir(1, origem.id, {
        mesaDestinoId: destino.id,
        operadorId: 9,
        aberto_em: '1999-01-01'
      }, { db });

      assert.equal(resultado.repetida, false);
      assert.equal(resultado.atendimento.id, aberto.atendimento.id);
      assert.equal(resultado.atendimento.mesa_id, destino.id);
      assert.equal(resultado.atendimento.estado, 'OCUPADA');
      assert.equal(resultado.atendimento.cliente_id, 5);
      assert.equal(resultado.atendimento.operador_abertura_id, 8);
      assert.equal(resultado.atendimento.aberto_em, aberto.atendimento.aberto_em);
      assert.notEqual(resultado.atendimento.aberto_em, '1999-01-01');
      assert.equal(resultado.origem.situacao, 'LIVRE');
      assert.equal(resultado.destino.situacao, 'OCUPADA');
      assert.equal(resultado.destino.numero, 5);
      assert.equal(resultado.transferencia.mesa_origem_id, origem.id);
      assert.equal(resultado.transferencia.mesa_destino_id, destino.id);
      assert.equal(resultado.transferencia.operador_id, 9);
      assert.equal(resultado.transferencia.atendimento_id, aberto.atendimento.id);
      assert.ok(resultado.transferencia.transferido_em);

      const origemLivre = await Atendimento.consultarAtivo(1, origem.id, { db });
      const destinoOcupado = await Atendimento.consultarAtivo(1, destino.id, { db });
      assert.equal(origemLivre.situacao, 'LIVRE');
      assert.equal(origemLivre.atendimento, null);
      assert.equal(destinoOcupado.situacao, 'OCUPADA');
      assert.equal(destinoOcupado.atendimento.id, aberto.atendimento.id);

      const pedidoDepois = await get(db, 'SELECT * FROM pedidos WHERE id = ?', [pedido.lastID]);
      assert.equal(pedidoDepois.mesa_atendimento_id, aberto.atendimento.id);
      assert.equal(pedidoDepois.mesa_id, origem.id);
      assert.equal(pedidoDepois.total, 40);
      assert.equal(pedidoDepois.status, 'PEDIDO');
      const pedidos = await get(db, 'SELECT COUNT(*) AS total FROM pedidos');
      const itens = await get(db, 'SELECT COUNT(*) AS total, SUM(subtotal) AS soma FROM pedidos_itens');
      assert.equal(pedidos.total, 1);
      assert.equal(itens.total, 1);
      assert.equal(itens.soma, 40);
      const vendas = await get(db, 'SELECT COUNT(*) AS total FROM vendas');
      assert.equal(vendas.total, 0);
      const atendimentos = await get(db, `SELECT COUNT(*) AS total FROM mesa_atendimentos`);
      assert.equal(atendimentos.total, 1);

      const indice = await get(db, `SELECT sql FROM sqlite_master WHERE name = 'ux_mesa_atendimentos_ativo'`);
      assert.match(indice.sql, /OCUPADA/);
      assert.match(indice.sql, /FECHAMENTO/);
    } finally { await close(db); }
  });

  it('acumula o histórico e mantém a transferência anterior intacta', async () => {
    const db = await base();
    try {
      const origem = await mesa(db, 1, 1);
      const meio = await mesa(db, 1, 5);
      const fim = await mesa(db, 1, 8);
      const aberto = await ocupar(db, 1, origem.id, 8, 4);
      const primeira = await Atendimento.transferir(1, origem.id, { mesaDestinoId: meio.id, operadorId: 9 }, { db });
      const segunda = await Atendimento.transferir(1, meio.id, { mesaDestinoId: fim.id, operadorId: 11 }, { db });
      assert.equal(segunda.atendimento.id, aberto.atendimento.id);
      assert.equal(segunda.atendimento.aberto_em, aberto.atendimento.aberto_em);
      assert.equal(segunda.atendimento.cliente_id, 4);
      assert.equal(segunda.atendimento.operador_abertura_id, 8);
      assert.equal(segunda.atendimento.mesa_id, fim.id);

      const anterior = await get(db, 'SELECT * FROM mesa_atendimento_transferencias WHERE id = ?', [primeira.transferencia.id]);
      assert.equal(anterior.mesa_origem_id, origem.id);
      assert.equal(anterior.mesa_destino_id, meio.id);
      assert.equal(anterior.operador_id, 9);
      assert.equal(anterior.transferido_em, primeira.transferencia.transferido_em);
      assert.equal(anterior.atendimento_id, aberto.atendimento.id);
      const total = await get(db, 'SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias');
      assert.equal(total.total, 2);
      const painel = await Atendimento.listarSituacao(1, { db });
      const porNumero = new Map(painel.itens.map((item) => [item.numero, item.situacao]));
      assert.equal(porNumero.get(1), 'LIVRE');
      assert.equal(porNumero.get(5), 'LIVRE');
      assert.equal(porNumero.get(8), 'OCUPADA');
    } finally { await close(db); }
  });

  it('recusa destino ocupado, inativo, inexistente, de outra empresa ou igual à origem', async () => {
    const db = await base();
    try {
      const origem = await mesa(db, 1, 1);
      const ocupada = await mesa(db, 1, 2);
      const inativa = await mesa(db, 1, 3);
      const outra = await mesa(db, 2, 9);
      await ocupar(db, 1, origem.id, 8);
      await ocupar(db, 1, ocupada.id, 8);
      await MesaService.atualizar(1, inativa.id, { ativo: false }, { db });
      const antes = await get(db, 'SELECT mesa_id, aberto_em FROM mesa_atendimentos WHERE mesa_id = ?', [origem.id]);

      await rejeita(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: ocupada.id, operadorId: 9 }, { db }),
        'MESA_OCUPADA'
      );
      await rejeita(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: inativa.id, operadorId: 9 }, { db }),
        'MESA_INATIVA'
      );
      await rejeita(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: 999, operadorId: 9 }, { db }),
        'MESA_NAO_ENCONTRADA'
      );
      await rejeita(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: outra.id, operadorId: 9 }, { db }),
        'MESA_NAO_ENCONTRADA'
      );
      await rejeita(
        () => Atendimento.transferir(2, outra.id, { mesaDestinoId: origem.id, operadorId: 9 }, { db }),
        'MESA_NAO_ENCONTRADA'
      );
      await rejeita(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: origem.id, operadorId: 9 }, { db }),
        'MESA_DESTINO_IGUAL'
      );

      const depois = await get(db, 'SELECT mesa_id, aberto_em, estado FROM mesa_atendimentos WHERE mesa_id = ?', [origem.id]);
      assert.equal(depois.mesa_id, antes.mesa_id);
      assert.equal(depois.aberto_em, antes.aberto_em);
      assert.equal(depois.estado, 'OCUPADA');
      const historico = await get(db, 'SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias');
      assert.equal(historico.total, 0);
      const alheia = await get(db, 'SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE empresa_id = 2');
      assert.equal(alheia.total, 0);
    } finally { await close(db); }
  });

  it('recusa origem livre, inativa, em fechamento ou encerrada', async () => {
    const db = await base();
    try {
      const livre = await mesa(db, 1, 1);
      const destino = await mesa(db, 1, 2);
      await rejeita(
        () => Atendimento.transferir(1, livre.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db }),
        'MESA_LIVRE'
      );

      const inativa = await mesa(db, 1, 3);
      await ocupar(db, 1, inativa.id, 8);
      await MesaService.atualizar(1, inativa.id, { ativo: false }, { db });
      await rejeita(
        () => Atendimento.transferir(1, inativa.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db }),
        'MESA_INATIVA'
      );
      const segue = await get(db, `SELECT mesa_id, estado FROM mesa_atendimentos WHERE mesa_id = ?`, [inativa.id]);
      assert.equal(segue.estado, 'OCUPADA');

      const fechamento = await mesa(db, 1, 4);
      const emFechamento = await ocupar(db, 1, fechamento.id, 8);
      await run(db, `UPDATE mesa_atendimentos SET estado = 'FECHAMENTO' WHERE id = ?`, [emFechamento.atendimento.id]);
      await rejeita(
        () => Atendimento.transferir(1, fechamento.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db }),
        'ATENDIMENTO_EM_FECHAMENTO'
      );
      const parado = await get(db, 'SELECT mesa_id, estado FROM mesa_atendimentos WHERE id = ?', [emFechamento.atendimento.id]);
      assert.equal(parado.mesa_id, fechamento.id);
      assert.equal(parado.estado, 'FECHAMENTO');

      const encerrada = await mesa(db, 1, 6);
      await ocupar(db, 1, encerrada.id, 8);
      await Atendimento.encerrar(1, encerrada.id, { operadorId: 8 }, { db });
      await rejeita(
        () => Atendimento.transferir(1, encerrada.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db }),
        'ATENDIMENTO_JA_ENCERRADO'
      );
      const historico = await get(db, 'SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias');
      assert.equal(historico.total, 0);
    } finally { await close(db); }
  });

  it('desfaz a troca de mesa quando o histórico não grava', async () => {
    const db = await base();
    try {
      const origem = await mesa(db, 1, 1);
      const destino = await mesa(db, 1, 5);
      const aberto = await ocupar(db, 1, origem.id, 8, 5);
      await run(db, `
        CREATE TRIGGER bloquear_historico_teste
        BEFORE INSERT ON mesa_atendimento_transferencias
        BEGIN
          SELECT RAISE(ABORT, 'historico_falhou');
        END
      `);
      await assert.rejects(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db }),
        (err) => err && !err.codigo
      );
      const atendimento = await get(db, 'SELECT mesa_id, estado, aberto_em, cliente_id FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
      assert.equal(atendimento.mesa_id, origem.id);
      assert.equal(atendimento.estado, 'OCUPADA');
      assert.equal(atendimento.aberto_em, aberto.atendimento.aberto_em);
      assert.equal(atendimento.cliente_id, 5);
      const historico = await get(db, 'SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias');
      assert.equal(historico.total, 0);
      const destinoLivre = await Atendimento.consultarAtivo(1, destino.id, { db });
      assert.equal(destinoLivre.situacao, 'LIVRE');
    } finally { await close(db); }
  });
});

describe('concorrência e idempotência', () => {
  it('duas transferências para o mesmo destino deixam uma única ocupação', async () => {
    const arquivo = path.join(dbDir, 'destino.db');
    const a = await open(arquivo);
    const b = await open(arquivo);
    try {
      await run(a, 'PRAGMA busy_timeout = 8000');
      await run(b, 'PRAGMA busy_timeout = 8000');
      await garantirSchemaMesas(a);
      const origemA = await mesa(a, 1, 1);
      const origemB = await mesa(a, 1, 2);
      const destino = await mesa(a, 1, 5);
      const primeiro = await ocupar(a, 1, origemA.id, 8);
      const segundo = await ocupar(a, 1, origemB.id, 8);
      const disputas = await Promise.allSettled([
        Atendimento.transferir(1, origemA.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db: a }),
        Atendimento.transferir(1, origemB.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db: b })
      ]);
      const vencedores = disputas.filter((item) => item.status === 'fulfilled');
      const recusas = disputas.filter((item) => item.status === 'rejected');
      assert.equal(vencedores.length, 1);
      assert.equal(recusas.length, 1);
      assert.equal(recusas[0].reason.codigo, 'MESA_OCUPADA');
      const ativos = await get(a, `SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE estado = 'OCUPADA'`);
      assert.equal(ativos.total, 2);
      const noDestino = await get(a, `SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE mesa_id = ? AND estado = 'OCUPADA'`, [destino.id]);
      assert.equal(noDestino.total, 1);
      const historico = await get(a, 'SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias');
      assert.equal(historico.total, 1);
      const ids = [primeiro.atendimento.id, segundo.atendimento.id].sort();
      const gravados = await get(a, `SELECT COUNT(DISTINCT id) AS total FROM mesa_atendimentos WHERE id IN (?, ?)`, ids);
      assert.equal(gravados.total, 2);
    } finally {
      await close(a);
      await close(b);
    }
  });

  it('duas transferências do mesmo atendimento geram um único histórico', async () => {
    const arquivo = path.join(dbDir, 'origem.db');
    const a = await open(arquivo);
    const b = await open(arquivo);
    try {
      await run(a, 'PRAGMA busy_timeout = 8000');
      await run(b, 'PRAGMA busy_timeout = 8000');
      await garantirSchemaMesas(a);
      const origem = await mesa(a, 1, 1);
      const destinoA = await mesa(a, 1, 5);
      const destinoB = await mesa(a, 1, 6);
      const aberto = await ocupar(a, 1, origem.id, 8, 5);
      const disputas = await Promise.allSettled([
        Atendimento.transferir(1, origem.id, { mesaDestinoId: destinoA.id, operadorId: 9 }, { db: a }),
        Atendimento.transferir(1, origem.id, { mesaDestinoId: destinoB.id, operadorId: 9 }, { db: b })
      ]);
      const vencedores = disputas.filter((item) => item.status === 'fulfilled');
      const recusas = disputas.filter((item) => item.status === 'rejected');
      assert.equal(vencedores.length, 1);
      assert.equal(recusas.length, 1);
      assert.ok(['MESA_LIVRE', 'ATENDIMENTO_CONCORRENTE', 'MESA_OCUPADA'].includes(recusas[0].reason.codigo));
      const historico = await get(a, 'SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias WHERE atendimento_id = ?', [aberto.atendimento.id]);
      assert.equal(historico.total, 1);
      const row = await get(a, 'SELECT id, mesa_id, estado, aberto_em, cliente_id, operador_abertura_id FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
      assert.equal(row.estado, 'OCUPADA');
      assert.equal(row.aberto_em, aberto.atendimento.aberto_em);
      assert.equal(row.cliente_id, 5);
      assert.equal(row.operador_abertura_id, 8);
      assert.ok([destinoA.id, destinoB.id].includes(row.mesa_id));
      const origemLivre = await get(a, `SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE mesa_id = ? AND estado IN ('OCUPADA', 'FECHAMENTO')`, [origem.id]);
      assert.equal(origemLivre.total, 0);
      const ativos = await get(a, `SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE estado = 'OCUPADA'`);
      assert.equal(ativos.total, 1);
    } finally {
      await close(a);
      await close(b);
    }
  });

  it('repete a mesma chave e rejeita contexto divergente', async () => {
    const db = await base();
    try {
      const origem = await mesa(db, 1, 1);
      const destino = await mesa(db, 1, 5);
      const outroDestino = await mesa(db, 1, 6);
      const empresaB1 = await mesa(db, 2, 1);
      const empresaB2 = await mesa(db, 2, 2);
      const aberto = await ocupar(db, 1, origem.id, 8, 5);
      const primeira = await Atendimento.transferir(1, origem.id, {
        mesaDestinoId: destino.id,
        operadorId: 9,
        idempotencyKey: 'tf-1'
      }, { db });
      const repetida = await Atendimento.transferir(1, origem.id, {
        mesaDestinoId: destino.id,
        operadorId: 9,
        idempotencyKey: 'tf-1'
      }, { db });
      assert.equal(repetida.repetida, true);
      assert.equal(repetida.transferencia.id, primeira.transferencia.id);
      assert.equal(repetida.atendimento.id, aberto.atendimento.id);
      assert.equal(repetida.atendimento.mesa_id, destino.id);
      assert.equal(repetida.atendimento.aberto_em, aberto.atendimento.aberto_em);
      const contagem = await get(db, `SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias WHERE idempotency_key = 'tf-1'`);
      assert.equal(contagem.total, 1);

      await rejeita(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: outroDestino.id, operadorId: 9, idempotencyKey: 'tf-1' }, { db }),
        'CHAVE_IDEMPOTENCIA_DIVERGENTE'
      );
      await rejeita(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: destino.id, operadorId: 3, idempotencyKey: 'tf-1' }, { db }),
        'CHAVE_IDEMPOTENCIA_DIVERGENTE'
      );
      await rejeita(
        () => Atendimento.transferir(2, empresaB1.id, { mesaDestinoId: empresaB2.id, operadorId: 9, idempotencyKey: 'tf-1' }, { db }),
        'CHAVE_IDEMPOTENCIA_DIVERGENTE'
      );

      const deNovo = await ocupar(db, 1, origem.id, 8);
      await rejeita(
        () => Atendimento.transferir(1, origem.id, { mesaDestinoId: destino.id, operadorId: 9, idempotencyKey: 'tf-1' }, { db }),
        'CHAVE_IDEMPOTENCIA_DIVERGENTE'
      );
      const novoParado = await get(db, 'SELECT mesa_id FROM mesa_atendimentos WHERE id = ?', [deNovo.atendimento.id]);
      assert.equal(novoParado.mesa_id, origem.id);
      const historico = await get(db, 'SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias');
      assert.equal(historico.total, 1);
    } finally { await close(db); }
  });

  it('a mesma chave disputada por duas conexões grava uma transferência', async () => {
    const arquivo = path.join(dbDir, 'chave.db');
    const a = await open(arquivo);
    const b = await open(arquivo);
    try {
      await run(a, 'PRAGMA busy_timeout = 8000');
      await run(b, 'PRAGMA busy_timeout = 8000');
      await garantirSchemaMesas(a);
      const origem = await mesa(a, 1, 1);
      const destino = await mesa(a, 1, 5);
      const aberto = await ocupar(a, 1, origem.id, 8);
      const disputas = await Promise.allSettled([
        Atendimento.transferir(1, origem.id, { mesaDestinoId: destino.id, operadorId: 9, idempotencyKey: 'tf-race' }, { db: a }),
        Atendimento.transferir(1, origem.id, { mesaDestinoId: destino.id, operadorId: 9, idempotencyKey: 'tf-race' }, { db: b })
      ]);
      assert.equal(disputas.filter((item) => item.status === 'rejected').length, 0);
      const historico = await get(a, `SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias WHERE idempotency_key = 'tf-race'`);
      assert.equal(historico.total, 1);
      const row = await get(a, 'SELECT mesa_id FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
      assert.equal(row.mesa_id, destino.id);
      const repetidas = disputas.filter((item) => item.value && item.value.repetida).length;
      assert.ok(repetidas <= 1);
    } finally {
      await close(a);
      await close(b);
    }
  });
});

describe('pedido legado e rotas', () => {
  it('não altera pedido legado sem atendimento e não revela outra empresa', async () => {
    const db = await base();
    try {
      const origem = await mesa(db, 1, 1);
      const destino = await mesa(db, 1, 5);
      const legado = await run(db, `
        INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, total)
        VALUES ('ANTIGO', 'PEDIDO', 1, ?, 15)
      `, [origem.id]);
      const aberto = await ocupar(db, 1, origem.id, 8);
      await Atendimento.transferir(1, origem.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db });
      const pedido = await get(db, 'SELECT status, mesa_id, mesa_atendimento_id, venda_id, total FROM pedidos WHERE id = ?', [legado.lastID]);
      assert.equal(pedido.status, 'PEDIDO');
      assert.equal(pedido.mesa_id, origem.id);
      assert.equal(pedido.mesa_atendimento_id, null);
      assert.equal(pedido.venda_id, null);
      assert.equal(pedido.total, 15);
      assert.notEqual(aberto.atendimento.id, null);
      const vendas = await get(db, 'SELECT COUNT(*) AS total FROM vendas');
      assert.equal(vendas.total, 0);
    } finally { await close(db); }
  });

  it('a rota usa a empresa do contexto, o operador da sessão e a mesa de destino', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '../../backend/rotas/mesas.js'), 'utf8');
    assert.match(fonte, /router\.post\('\/:id\/atendimento\/transferir'/);
    assert.match(fonte, /mesa_destino_id/);
    assert.match(fonte, /empresaIdDoReqPedido\(req\)/);
    assert.match(fonte, /operadorDaSessao\(req\)/);
    assert.match(fonte, /chaveIdempotencia\(req\)/);
    assert.doesNotMatch(fonte, /body\.empresa_id/);
    assert.doesNotMatch(fonte, /body\.operador_id/);
    const servico = fs.readFileSync(path.join(__dirname, '../../backend/services/pedido/MesaAtendimentoService.js'), 'utf8');
    const corpo = servico.slice(servico.indexOf('async function transferir'));
    assert.doesNotMatch(corpo, /INSERT INTO mesa_atendimentos/i);
    assert.doesNotMatch(corpo, /UPDATE pedidos/i);
    assert.doesNotMatch(corpo, /INSERT INTO vendas/i);
  });
});
