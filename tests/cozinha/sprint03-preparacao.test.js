/**
 * Sprint 03 — Motor de preparação e conclusão de rodada.
 * Banco temporário apenas. Sem banco oficial.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/cozinha/sprint03-preparacao.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s03-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional
} = require('../../backend/utils/cozinhaSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const CozinhaPreparacao = require('../../backend/services/cozinha/CozinhaPreparacaoService');
const CozinhaKdsPainel = require('../../backend/services/cozinha/CozinhaKdsPainelService');
const {
  classificarItemCozinha
} = require('../../backend/services/cozinha/cozinhaClassificacaoItem');

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
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function open(arquivo) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo || ':memory:', (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (e) => (e ? reject(e) : resolve(db)));
      });
    });
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function schemaErp(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave VARCHAR(100) UNIQUE NOT NULL,
      valor TEXT, tipo VARCHAR(50), descricao TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS mesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      numero INTEGER NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS mesa_atendimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      mesa_id INTEGER NOT NULL,
      estado TEXT NOT NULL,
      operador_abertura_id INTEGER NOT NULL DEFAULT 1,
      aberto_em TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo_operacional TEXT DEFAULT 'COMERCIAL',
      comercializavel INTEGER DEFAULT 0,
      categoria_id INTEGER,
      utiliza_ficha_tecnica INTEGER DEFAULT 0,
      permite_personalizacao_ingredientes INTEGER DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS ficha_tecnica (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      ativo INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(50),
      data_pedido DATE DEFAULT '2026-01-01',
      total DECIMAL(10,2) DEFAULT 0,
      status TEXT DEFAULT 'PEDIDO',
      empresa_id INTEGER,
      mesa_id INTEGER,
      mesa_atendimento_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario DECIMAL(10,2) DEFAULT 0,
      subtotal DECIMAL(10,2) DEFAULT 0,
      classificacao_operacional_snapshot TEXT,
      produto_nome_snapshot TEXT,
      observacao TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      insumo_id INTEGER NOT NULL,
      insumo_nome_snapshot TEXT NOT NULL,
      quantidade_snapshot REAL NOT NULL,
      unidade_snapshot TEXT NOT NULL,
      classificacao_comercial_snapshot TEXT NOT NULL,
      selecionado INTEGER NOT NULL,
      preco_adicional_snapshot REAL DEFAULT 0
    )
  `);
  const info = await garantirSchemaCozinha(db);
  assert.equal(info.operacional, true);
  assert.equal(isCozinhaOperacional(), true);
}

async function seedInfra(db, empresaId = 1) {
  const catRef = await run(db, `INSERT INTO categorias (nome) VALUES ('Refrigerantes')`);
  const catOut = await run(db, `INSERT INTO categorias (nome) VALUES ('Diversos')`);

  const pastel = await run(db, `
    INSERT INTO produtos (
      nome, tipo_operacional, comercializavel, categoria_id,
      utiliza_ficha_tecnica, permite_personalizacao_ingredientes
    ) VALUES ('Pastel do Cheff', 'COMERCIAL', 0, ?, 1, 1)
  `, [catOut.lastID]);
  await run(db, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [pastel.lastID]);

  const carneSol = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, comercializavel)
    VALUES ('Carne de Sol', 'INSUMO', 0)
  `);

  const fanta = await run(db, `
    INSERT INTO produtos (
      nome, tipo_operacional, comercializavel, categoria_id
    ) VALUES ('Fanta Lata 350 ML', 'INSUMO', 1, ?)
  `, [catRef.lastID]);

  const outro = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, comercializavel, categoria_id)
    VALUES ('Produto Generico', 'COMERCIAL', 0, ?)
  `, [catOut.lastID]);

  const mesa = await run(db, `
    INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 10, 1)
  `, [empresaId]);
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado)
    VALUES (?, ?, 'OCUPADA')
  `, [empresaId, mesa.lastID]);
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual)
    VALUES (?, ?, 0)
  `, [empresaId, `U-${empresaId}`]);

  return {
    empresaId,
    mesaId: mesa.lastID,
    atendimentoId: at.lastID,
    unidadeId: un.lastID,
    prodPastelId: pastel.lastID,
    prodCarneSolId: carneSol.lastID,
    prodFantaId: fanta.lastID,
    prodOutroId: outro.lastID,
    catRefrigeranteId: catRef.lastID
  };
}

async function criarPedidoItem(db, infra, {
  produtoId,
  nome,
  classifSnapshot,
  qty = 1,
  comPersonalizacao = false,
  personalizacaoNome = 'Carne de Sol'
}) {
  const ped = await run(db, `
    INSERT INTO pedidos (
      codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total
    ) VALUES (?, 'PEDIDO', ?, ?, ?, 10)
  `, [
    `P-${infra.empresaId}-${Date.now()}-${Math.random()}`,
    infra.empresaId,
    infra.mesaId,
    infra.atendimentoId
  ]);
  const item = await run(db, `
    INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, subtotal,
      classificacao_operacional_snapshot, produto_nome_snapshot
    ) VALUES (?, ?, ?, 10, 10, ?, ?)
  `, [ped.lastID, produtoId, qty, classifSnapshot, nome]);

  if (comPersonalizacao) {
    await run(db, `
      INSERT INTO pedido_item_ingredientes (
        pedido_id, pedido_item_id, empresa_id, insumo_id,
        insumo_nome_snapshot, quantidade_snapshot, unidade_snapshot,
        classificacao_comercial_snapshot, selecionado, preco_adicional_snapshot
      ) VALUES (?, ?, ?, ?, ?, 1.000, 'UN', 'ADICIONAL', 1, 0)
    `, [
      ped.lastID,
      item.lastID,
      infra.empresaId,
      infra.prodCarneSolId,
      personalizacaoNome
    ]);
  }

  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (
      empresa_id, atendimento_id, numero_comanda, pedido_id, operador_lancamento_id
    ) VALUES (?, ?, ?, ?, 1)
  `, [
    infra.empresaId,
    infra.atendimentoId,
    Math.floor(Math.random() * 9000) + 1,
    ped.lastID
  ]);

  return {
    pedidoId: ped.lastID,
    pedidoItemId: item.lastID,
    comandaId: cmd.lastID
  };
}

function entradaDespacho(infra, itens, chave) {
  return {
    empresaId: infra.empresaId,
    operadorId: 7,
    idempotencyKey: chave,
    unidade_id: infra.unidadeId,
    mesa_id: infra.mesaId,
    atendimento_id: infra.atendimentoId,
    itens
  };
}

async function despacharItens(db, infra, linhas, chave) {
  const itens = linhas.map((l) => ({
    pedido_id: l.pedidoId,
    pedido_item_id: l.pedidoItemId,
    comanda_id: l.comandaId,
    qty_solicitada: l.qty || '1.000'
  }));
  return CozinhaDespacho.despacharLote(entradaDespacho(infra, itens, chave), { db });
}

async function deixarItemPronto(db, infra, itemId, chave) {
  const contexto = {
    empresaId: infra.empresaId,
    operadorId: 7,
    unidade_id: infra.unidadeId,
    itemId
  };
  await CozinhaPreparacao.iniciarPreparacao({
    ...contexto,
    idempotencyKey: `${chave}-inicio`
  }, { db });
  return CozinhaPreparacao.marcarItemPronto({
    ...contexto,
    idempotencyKey: `${chave}-pronto`
  }, { db });
}

describe('Sprint 03 — Preparação / conclusão de rodada', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  describe('Classificação operacional', () => {
    it('PASTEL por utiliza_ficha_tecnica; BEBIDA por categoria; OUTRO sem evidência', () => {
      const pastel = classificarItemCozinha({
        tipo_operacional: 'COMERCIAL',
        classificacao_operacional_snapshot: 'COMERCIAL',
        utiliza_ficha_tecnica: 1
      });
      assert.equal(pastel.tipo, 'PASTEL');
      assert.equal(pastel.motivo, 'comercial_utiliza_ficha_tecnica');

      const soPersonalizacao = classificarItemCozinha({
        tipo_operacional: 'COMERCIAL',
        classificacao_operacional_snapshot: 'COMERCIAL',
        utiliza_ficha_tecnica: 0,
        qtd_ingredientes_pedido: 2,
        permite_personalizacao_ingredientes: 1
      });
      assert.equal(soPersonalizacao.tipo, 'OUTRO');

      const bebida = classificarItemCozinha({
        tipo_operacional: 'INSUMO',
        classificacao_operacional_snapshot: 'INSUMO',
        comercializavel: 1,
        categoria_nome: 'Refrigerantes'
      });
      assert.equal(bebida.tipo, 'BEBIDA');

      const outro = classificarItemCozinha({
        tipo_operacional: 'COMERCIAL',
        classificacao_operacional_snapshot: 'COMERCIAL',
        utiliza_ficha_tecnica: 0
      });
      assert.equal(outro.tipo, 'OUTRO');

      const insumoSemCat = classificarItemCozinha({
        tipo_operacional: 'INSUMO',
        classificacao_operacional_snapshot: 'INSUMO',
        comercializavel: 1,
        categoria_nome: 'Embalagens'
      });
      assert.equal(insumoSemCat.tipo, 'OUTRO');
    });
  });

  describe('Estados e transições', () => {
    it('1) item inicia em AGUARDANDO após despacho', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId,
        nome: 'Pastel do Cheff',
        classifSnapshot: 'COMERCIAL',
        comPersonalizacao: true
      });
      const out = await despacharItens(db, infra, [pastel], 's03-1-aguardando');
      assert.equal(out.itens[0].estado_preparacao, 'AGUARDANDO');
      assert.equal(out.itens[0].tipo_item, 'PASTEL');
      await close(db);
    });

    it('2) pastel passa para EM_PREPARACAO', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId,
        nome: 'Pastel do Cheff',
        classifSnapshot: 'COMERCIAL',
        comPersonalizacao: true
      });
      const out = await despacharItens(db, infra, [pastel], 's03-2-desp');
      const prep = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: infra.empresaId,
        operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId: out.itens[0].id,
        idempotencyKey: 's03-2-iniciar'
      }, { db });
      assert.equal(prep.item.estado_preparacao, 'EM_PREPARACAO');
      const row = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [out.itens[0].id]);
      assert.equal(row.estado_preparacao, 'EM_PREPARACAO');
      await close(db);
    });

    it('3) pastel passa para PRONTO', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId,
        nome: 'Pastel do Cheff',
        classifSnapshot: 'COMERCIAL',
        comPersonalizacao: true
      });
      const out = await despacharItens(db, infra, [pastel], 's03-3-desp');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: infra.empresaId, operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId: out.itens[0].id, idempotencyKey: 's03-3-ini'
      }, { db });
      const pronto = await CozinhaPreparacao.marcarItemPronto({
        empresaId: infra.empresaId, operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId: out.itens[0].id, idempotencyKey: 's03-3-pronto'
      }, { db });
      assert.equal(pronto.item.estado_preparacao, 'PRONTO');
      assert.equal(pronto.rodada.estado_preparacao, 'PRONTA');
      await close(db);
    });

    it('4) não permite transição inválida AGUARDANDO→PRONTO', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId,
        nome: 'Pastel do Cheff',
        classifSnapshot: 'COMERCIAL',
        comPersonalizacao: true
      });
      const out = await despacharItens(db, infra, [pastel], 's03-4-desp');
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: infra.empresaId, operadorId: 7,
        unidade_id: infra.unidadeId,
          itemId: out.itens[0].id, idempotencyKey: 's03-4-bad'
        }, { db }),
        (err) => {
          assert.equal(err.codigo, 'TRANSICAO_INVALIDA');
          return true;
        }
      );
      const row = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [out.itens[0].id]);
      assert.equal(row.estado_preparacao, 'AGUARDANDO');
      await close(db);
    });
  });

  describe('Controle independente e conclusão', () => {
    it('aceita os sete motivos padronizados em cancelamentos operacionais', async () => {
      const db = await open();
      try {
        await schemaErp(db);
        const infra = await seedInfra(db);
        const motivos = [
          'PRAZO_EXCEDIDO', 'CLIENTE_DESISTIU', 'CANCELAMENTO_IFOOD', 'PEDIDO_DUPLICADO',
          'ERRO_LANCAMENTO', 'FALTA_PRODUTO', 'OUTRO'
        ];
        for (const motivo of motivos) {
          const pedido = await criarPedidoItem(db, infra, { produtoId: infra.prodPastelId, nome: motivo, classifSnapshot: 'COMERCIAL' });
          const despacho = await despacharItens(db, infra, [pedido], `g1-motivo-${motivo}`);
          const resultado = await CozinhaPreparacao.cancelarRodada({
            empresaId: 1, unidade_id: infra.unidadeId, operadorId: 7, rodadaId: despacho.rodada.id,
            motivo, justificativa: motivo === 'OUTRO' ? 'Detalhe' : null,
            idempotencyKey: `g1-motivo-cancelar-${motivo}`
          }, { db });
          assert.equal(resultado.rodada.cancelamento_motivo, motivo);
        }
      } finally { await close(db); }
    });

    it('não inventa histórico de rodada pronta quando há item restante bloqueador', async () => {
      const db = await open();
      try {
        await schemaErp(db);
        const infra = await seedInfra(db);
        const pastel = await criarPedidoItem(db, infra, { produtoId: infra.prodPastelId, nome: 'Pastel', classifSnapshot: 'COMERCIAL' });
        const outro = await criarPedidoItem(db, infra, { produtoId: infra.prodOutroId, nome: 'Outro', classifSnapshot: 'COMERCIAL' });
        const despacho = await despacharItens(db, infra, [pastel, outro], 'g1-mudanca-regra');
        const id = despacho.itens.find((item) => item.tipo_item === 'PASTEL').id;
        const base = { empresaId: 1, unidade_id: infra.unidadeId, operadorId: 7 };
        await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId: id, idempotencyKey: 'g1-mudanca-inicio' }, { db });
        await CozinhaPreparacao.marcarItemPronto({ ...base, itemId: id, idempotencyKey: 'g1-mudanca-pronto' }, { db });
        const resultado = await CozinhaPreparacao.cancelarItem({
          ...base, itemId: id, idempotencyKey: 'g1-mudanca-cancelar', motivo: 'FALTA_PRODUTO'
        }, { db });
        assert.equal(resultado.rodada.estado_preparacao, 'AGUARDANDO');
        const ativo = await CozinhaKdsPainel.listarPainelPreparacao({ ...base, fila: 'ativa' }, { db });
        assert.equal(ativo.rodadas[0].rodada_pronta_em, null);
        const historico = await CozinhaKdsPainel.listarPainelPreparacao({ ...base, historico: 'cancelados' }, { db });
        assert.equal(historico.rodadas[0].itens[0].rodada_pronta_em_cancelamento, null);
      } finally { await close(db); }
    });

    it('cancelamento individual preserva produção e encerra rodada ao cancelar último item', async () => {
      const db = await open();
      try {
        await schemaErp(db);
        const infra = await seedInfra(db);
        await run(db, 'ALTER TABLE produtos ADD COLUMN estoque_atual REAL');
        await run(db, 'UPDATE produtos SET estoque_atual=23 WHERE id=?', [infra.prodPastelId]);
        const p1 = await criarPedidoItem(db, infra, { produtoId: infra.prodPastelId, nome: 'Pastel A', classifSnapshot: 'COMERCIAL' });
        const p2 = await criarPedidoItem(db, infra, { produtoId: infra.prodPastelId, nome: 'Pastel B', classifSnapshot: 'COMERCIAL' });
        const despacho = await despacharItens(db, infra, [p1, p2], 'g1-individual-despacho');
        const [a, b] = despacho.itens.map((item) => item.id);
        const base = { empresaId: 1, unidade_id: infra.unidadeId, operadorId: 7 };
        await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId: a, idempotencyKey: 'g1-individual-inicio' }, { db });
        await CozinhaPreparacao.marcarItemPronto({ ...base, itemId: a, idempotencyKey: 'g1-individual-pronto' }, { db });
        await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId: b, idempotencyKey: 'g1-individual-inicio-b' }, { db });
        await run(db, 'UPDATE cozinha_itens SET qty_preparada_millis=400 WHERE id=?', [b]);
        const antes = await get(db, 'SELECT qty_solicitada_millis,qty_preparada_millis,qty_cancelada_millis FROM cozinha_itens WHERE id=?', [a]);
        const parcialAntes = await get(db, 'SELECT qty_solicitada_millis,qty_preparada_millis,qty_cancelada_millis FROM cozinha_itens WHERE id=?', [b]);
        const estoqueFila = await get(db, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila');
        const entrada = { ...base, itemId: a, motivo: 'OUTRO', justificativa: 'Produto inadequado', idempotencyKey: 'g1-item-a' };
        await assert.rejects(() => CozinhaPreparacao.cancelarItem({ ...entrada, justificativa: '  ' }, { db }),
          (err) => err.codigo === 'JUSTIFICATIVA_OBRIGATORIA');
        await assert.rejects(() => CozinhaPreparacao.cancelarItem({ ...entrada, motivo: 'INVALIDO' }, { db }),
          (err) => err.codigo === 'MOTIVO_CANCELAMENTO_INVALIDO');
        await assert.rejects(() => CozinhaPreparacao.cancelarItem({ ...entrada, unidade_id: infra.unidadeId + 1 }, { db }),
          (err) => err.codigo === 'UNIDADE_ISOLAMENTO');
        await assert.rejects(() => CozinhaPreparacao.cancelarItem({ ...entrada, empresaId: 2 }, { db }),
          (err) => err.codigo === 'ITEM_NAO_ENCONTRADO');
        await assert.rejects(() => CozinhaPreparacao.cancelarItem({ ...entrada, idempotencyKey: 'g1-item-falha' },
          { db, simularFalha: 'antes_commit' }), (err) => err.codigo === 'FALHA_SIMULADA');
        assert.equal((await get(db, 'SELECT estado_preparacao FROM cozinha_itens WHERE id=?', [a])).estado_preparacao, 'PRONTO');
        const cancelado = await CozinhaPreparacao.cancelarItem(entrada, { db });
        assert.equal(cancelado.item.estado_anterior, 'PRONTO');
        assert.equal(cancelado.item.cancelamento_por, 7);
        assert.match(cancelado.item.cancelamento_em, /Z$/);
        assert.equal(cancelado.rodada.estado_preparacao, 'EM_PREPARACAO');
        assert.equal((await CozinhaPreparacao.cancelarItem(entrada, { db })).repetida, true);
        await assert.rejects(() => CozinhaPreparacao.cancelarItem({ ...entrada, justificativa: 'Outra' }, { db }),
          (err) => err.codigo === 'IDEMPOTENCY_PAYLOAD_DIVERGENTE');
        await assert.rejects(() => CozinhaPreparacao.cancelarItem({ ...entrada, idempotencyKey: 'g1-item-duplicado' }, { db }),
          (err) => err.codigo === 'ITEM_CANCELADO');
        assert.deepEqual(await get(db, 'SELECT qty_solicitada_millis,qty_preparada_millis,qty_cancelada_millis FROM cozinha_itens WHERE id=?', [a]), antes);
        assert.equal((await get(db, 'SELECT estado_preparacao FROM cozinha_itens WHERE id=?', [b])).estado_preparacao, 'EM_PREPARACAO');
        const ultimo = await CozinhaPreparacao.cancelarItem({ ...base, itemId: b, motivo: 'CLIENTE_DESISTIU', idempotencyKey: 'g1-item-b' }, { db });
        assert.equal(ultimo.rodada.estado_preparacao, 'CANCELADA');
        assert.deepEqual(await get(db, 'SELECT qty_solicitada_millis,qty_preparada_millis,qty_cancelada_millis FROM cozinha_itens WHERE id=?', [b]), parcialAntes);
        const historico = await CozinhaKdsPainel.listarPainelPreparacao({ ...base, historico: 'cancelados' }, { db });
        const itemHistorico = historico.rodadas[0].itens.find((item) => item.id === a);
        assert.equal(itemHistorico.estado_anterior, 'PRONTO');
        assert.equal(itemHistorico.cancelamento_justificativa, 'Produto inadequado');
        assert.ok(itemHistorico.iniciado_em);
        assert.ok(itemHistorico.pronto_em);
        assert.equal((await get(db, "SELECT COUNT(*) AS n FROM cozinha_eventos_outbox WHERE tipo='ITEM_CANCELADO'")).n, 2);
        assert.equal((await get(db, "SELECT COUNT(*) AS n FROM cozinha_eventos_outbox WHERE tipo='RODADA_CANCELADA'")).n, 1);
        assert.deepEqual(await get(db, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila'), estoqueFila);
        assert.equal((await get(db, 'SELECT estoque_atual FROM produtos WHERE id=?', [infra.prodPastelId])).estoque_atual, 23);
        assert.equal((await get(db, 'SELECT status FROM pedidos WHERE id=?', [p1.pedidoId])).status, 'PEDIDO');
        assert.equal((await get(db, 'SELECT estado FROM mesa_atendimentos WHERE id=?', [infra.atendimentoId])).estado, 'OCUPADA');
      } finally { await close(db); }
    });

    it('cancelamento da rodada registra estado dos itens e bloqueia duplicação e retirada', async () => {
      const db = await open();
      try {
        await schemaErp(db);
        const infra = await seedInfra(db);
        const p1 = await criarPedidoItem(db, infra, { produtoId: infra.prodPastelId, nome: 'Pastel A', classifSnapshot: 'COMERCIAL' });
        const p2 = await criarPedidoItem(db, infra, { produtoId: infra.prodPastelId, nome: 'Pastel B', classifSnapshot: 'COMERCIAL' });
        const despacho = await despacharItens(db, infra, [p1, p2], 'g1-rodada-despacho');
        const [a] = despacho.itens.map((item) => item.id);
        const base = { empresaId: 1, unidade_id: infra.unidadeId, operadorId: 7 };
        await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId: a, idempotencyKey: 'g1-rodada-inicio' }, { db });
        const entrada = { ...base, rodadaId: despacho.rodada.id, motivo: 'FALTA_PRODUTO', idempotencyKey: 'g1-rodada' };
        await run(db, "UPDATE cozinha_rodadas SET retirada_estado='RETIRADA' WHERE id=?", [despacho.rodada.id]);
        await assert.rejects(() => CozinhaPreparacao.cancelarRodada(entrada, { db }), (err) => err.codigo === 'RODADA_JA_RETIRADA');
        await assert.rejects(() => CozinhaPreparacao.cancelarItem({ ...base, itemId: a, motivo: 'FALTA_PRODUTO', idempotencyKey: 'g1-retirado' }, { db }),
          (err) => err.codigo === 'RODADA_JA_RETIRADA');
        await run(db, "UPDATE cozinha_rodadas SET retirada_estado='PENDENTE' WHERE id=?", [despacho.rodada.id]);
        const resultado = await CozinhaPreparacao.cancelarRodada(entrada, { db });
        assert.equal(resultado.rodada.cancelamento_etapa, 'EM_PREPARACAO');
        assert.equal(resultado.rodada.cancelamento_por, 7);
        assert.match(resultado.rodada.cancelamento_em, /Z$/);
        assert.equal((await CozinhaPreparacao.cancelarRodada(entrada, { db })).repetida, true);
        await assert.rejects(() => CozinhaPreparacao.cancelarRodada({ ...entrada, idempotencyKey: 'g1-rodada-duplicada' }, { db }),
          (err) => err.codigo === 'RODADA_JA_CANCELADA');
        const historico = await CozinhaKdsPainel.listarPainelPreparacao({ ...base, historico: 'cancelados' }, { db });
        assert.equal(historico.rodadas[0].itens.find((item) => item.id === a).estado_anterior, 'EM_PREPARACAO');
        assert.equal(historico.rodadas[0].itens.find((item) => item.id !== a).estado_anterior, 'AGUARDANDO');
        assert.equal((await get(db, "SELECT COUNT(*) AS n FROM cozinha_eventos_outbox WHERE tipo='RODADA_CANCELADA'")).n, 1);
        assert.equal((await CozinhaKdsPainel.listarPainelPreparacao({ ...base, fila: 'ativa' }, { db })).rodadas.length, 0);
      } finally { await close(db); }
    });

    it('retorna somente o item selecionado, preserva histórico e permite reiniciar', async () => {
      const db = await open();
      try {
        await schemaErp(db);
        const infra = await seedInfra(db);
        const p1 = await criarPedidoItem(db, infra, {
          produtoId: infra.prodPastelId, nome: 'Pastel 1', classifSnapshot: 'COMERCIAL'
        });
        const p2 = await criarPedidoItem(db, infra, {
          produtoId: infra.prodPastelId, nome: 'Pastel 2', classifSnapshot: 'COMERCIAL'
        });
        const out = await despacharItens(db, infra, [p1, p2], 'retorno-despacho');
        const [idA, idB] = out.itens.map((item) => item.id);
        const base = { empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId };
        const iniciar = (itemId, key) => CozinhaPreparacao.iniciarPreparacao({
          ...base, itemId, idempotencyKey: key
        }, { db });
        const voltar = (itemId, key, extra = {}) => CozinhaPreparacao.voltarParaAguardando({
          ...base, itemId, idempotencyKey: key, ...extra
        }, { db });
        await iniciar(idA, 'retorno-inicio-a');
        await iniciar(idB, 'retorno-inicio-b');
        await assert.rejects(() => voltar(idA, 'retorno-inicio-a'),
          (err) => err.codigo === 'IDEMPOTENCY_OPERACAO_DIVERGENTE');
        await assert.rejects(() => voltar(idA, 'retorno-unidade', { unidade_id: infra.unidadeId + 1 }),
          (err) => err.codigo === 'UNIDADE_ISOLAMENTO');
        await assert.rejects(() => voltar(idA, 'retorno-empresa', { empresaId: 2 }),
          (err) => err.codigo === 'ITEM_NAO_ENCONTRADO');
        await assert.rejects(() => CozinhaPreparacao.voltarParaAguardando({
          ...base, itemId: idA, idempotencyKey: 'retorno-falha'
        }, { db, simularFalha: 'antes_commit' }), (err) => err.codigo === 'FALHA_SIMULADA');
        assert.equal((await get(db, 'SELECT estado_preparacao FROM cozinha_itens WHERE id=?', [idA])).estado_preparacao, 'EM_PREPARACAO');
        assert.equal((await get(db, "SELECT COUNT(*) AS n FROM cozinha_idempotencia WHERE idempotency_key='retorno-falha'")).n, 0);

        const resultado = await voltar(idA, 'retorno-a');
        assert.equal(resultado.item.estado_preparacao, 'AGUARDANDO');
        assert.equal(resultado.rodada.estado_preparacao, 'EM_PREPARACAO');
        assert.equal((await voltar(idA, 'retorno-a')).repetida, true);
        await assert.rejects(() => voltar(idB, 'retorno-a'), (err) => err.codigo === 'IDEMPOTENCY_PAYLOAD_DIVERGENTE');
        const painel = await CozinhaKdsPainel.listarPainelPreparacao({
          empresaId: 1, unidadeId: infra.unidadeId
        }, { db });
        const itens = painel.rodadas[0].itens;
        const itemA = itens.find((item) => item.id === idA);
        const itemB = itens.find((item) => item.id === idB);
        assert.equal(itemA.iniciado_em, null);
        assert.equal(itemA.operador_inicio_id, null);
        assert.equal(itemB.estado_preparacao, 'EM_PREPARACAO');
        assert.ok(itemB.iniciado_em);
        assert.equal((await get(db, "SELECT COUNT(*) AS n FROM cozinha_eventos_outbox WHERE tipo='PREPARACAO_REVERTIDA'")).n, 1);
        await voltar(idB, 'retorno-b');
        assert.equal((await get(db, 'SELECT estado_preparacao FROM cozinha_rodadas WHERE id=?', [out.rodada.id])).estado_preparacao, 'AGUARDANDO');
        await assert.rejects(() => voltar(idA, 'retorno-invalido'), (err) => err.codigo === 'TRANSICAO_INVALIDA');
        const reinicio = await iniciar(idA, 'retorno-reinicio');
        const novoPainel = await CozinhaKdsPainel.listarPainelPreparacao({ empresaId: 1, unidadeId: infra.unidadeId }, { db });
        const itemReiniciado = novoPainel.rodadas[0].itens.find((item) => item.id === idA);
        assert.equal(itemReiniciado.iniciado_em, reinicio.iniciado_em);
        assert.equal(itemReiniciado.operador_inicio_id, 7);
        assert.equal((await get(db, "SELECT COUNT(*) AS n FROM cozinha_eventos_outbox WHERE tipo='PREPARACAO_INICIADA'")).n, 3);
        await run(db, "UPDATE cozinha_rodadas SET retirada_estado='RETIRADA' WHERE id=?", [out.rodada.id]);
        await assert.rejects(() => voltar(idA, 'retorno-retirada'), (err) => err.codigo === 'RETIRADA_ESTADO_INVALIDO');
        await run(db, "UPDATE cozinha_rodadas SET estado_preparacao='CANCELADA' WHERE id=?", [out.rodada.id]);
        await assert.rejects(() => voltar(idA, 'retorno-cancelada'), (err) => err.codigo === 'RODADA_CANCELADA');
      } finally {
        await close(db);
      }
    });

    it('retorna a rodada para EM_PREPARACAO quando item exigível volta a aguardar', async () => {
      const db = await open();
      try {
        await schemaErp(db);
        const infra = await seedInfra(db);
        const pastel = await criarPedidoItem(db, infra, {
          produtoId: infra.prodPastelId, nome: 'Pastel', classifSnapshot: 'COMERCIAL'
        });
        const outro = await criarPedidoItem(db, infra, {
          produtoId: infra.prodOutroId, nome: 'Outro', classifSnapshot: 'COMERCIAL'
        });
        const out = await despacharItens(db, infra, [pastel, outro], 'retorno-pronta-desp');
        const base = { empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId };
        const idPastel = out.itens.find((item) => item.tipo_item === 'PASTEL').id;
        const idOutro = out.itens.find((item) => item.tipo_item === 'OUTRO').id;
        await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId: idOutro, idempotencyKey: 'retorno-pronta-outro' }, { db });
        await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId: idPastel, idempotencyKey: 'retorno-pronta-pastel' }, { db });
        await CozinhaPreparacao.marcarItemPronto({ ...base, itemId: idPastel, idempotencyKey: 'retorno-pronta-final' }, { db });
        const resultado = await CozinhaPreparacao.voltarParaAguardando({
          ...base, itemId: idOutro, idempotencyKey: 'retorno-pronta-voltar'
        }, { db });
        assert.equal(resultado.rodada.estado_preparacao, 'EM_PREPARACAO');
      } finally {
        await close(db);
      }
    });

    it('5-7) dois pastéis independentes; um pronto não conclui; todos concluem', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const p1 = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel 1',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const p2 = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel 2',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const out = await despacharItens(db, infra, [p1, p2], 's03-5-desp');
      assert.equal(out.itens.length, 2);
      const idA = out.itens[0].id;
      const idB = out.itens[1].id;

      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: idA, idempotencyKey: 's03-5-ini-a'
      }, { db });
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: idB, idempotencyKey: 's03-5-ini-b'
      }, { db });

      const r1 = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: idA, idempotencyKey: 's03-5-pronto-a'
      }, { db });
      assert.equal(r1.item.estado_preparacao, 'PRONTO');
      assert.notEqual(r1.rodada.estado_preparacao, 'PRONTA');

      const consulta = await CozinhaPreparacao.consultarPreparacaoRodada({
        empresaId: 1, rodadaId: out.rodada.id
      }, { db });
      assert.equal(consulta.conclusao.pronta, false);
      assert.ok(consulta.conclusao.pendentes.includes(idB));

      const r2 = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: idB, idempotencyKey: 's03-5-pronto-b'
      }, { db });
      assert.equal(r2.rodada.estado_preparacao, 'PRONTA');

      const rod = await get(db, `SELECT estado_preparacao FROM cozinha_rodadas WHERE id=?`, [out.rodada.id]);
      assert.equal(rod.estado_preparacao, 'PRONTA');
      const eventos = await all(db, `
        SELECT tipo FROM cozinha_eventos_outbox WHERE tipo='RODADA_PRONTA'
      `);
      assert.equal(eventos.length, 1);
      await close(db);
    });

    it('8-9) bebida entrega antes dos pastéis e não bloqueia rodada', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel do Cheff',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const bebida = await criarPedidoItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta Lata 350 ML',
        classifSnapshot: 'INSUMO', qty: 2
      });
      const out = await despacharItens(db, infra, [
        { ...pastel, qty: '1.000' },
        { ...bebida, qty: '2.000' }
      ], 's03-8-desp');

      const itemPastel = out.itens.find((i) => i.tipo_item === 'PASTEL');
      const itemBebida = out.itens.find((i) => i.tipo_item === 'BEBIDA');
      assert.ok(itemPastel);
      assert.ok(itemBebida);

      await deixarItemPronto(db, infra, itemBebida.id, 's03-8-bebida');
      const ent = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId: itemBebida.id, qty_entregue: '2.000',
        idempotencyKey: 's03-8-bebida'
      }, { db });
      assert.equal(ent.success, true);
      assert.equal(ent.entrega.qty_restante, '0.000');

      let consulta = await CozinhaPreparacao.consultarPreparacaoRodada({
        empresaId: 1, rodadaId: out.rodada.id
      }, { db });
      assert.equal(consulta.conclusao.pronta, false);

      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: itemPastel.id, idempotencyKey: 's03-8-ini'
      }, { db });
      const pronto = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: itemPastel.id, idempotencyKey: 's03-8-pronto'
      }, { db });
      assert.equal(pronto.rodada.estado_preparacao, 'PRONTA');
      await close(db);
    });

    it('10-11) entrega parcial e bloqueio acima da quantidade', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const bebida = await criarPedidoItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta Lata 350 ML',
        classifSnapshot: 'INSUMO', qty: 3
      });
      const out = await despacharItens(db, infra, [
        { ...bebida, qty: '3.000' }
      ], 's03-10-desp');
      const item = out.itens[0];
      assert.equal(item.tipo_item, 'BEBIDA');

      await deixarItemPronto(db, infra, item.id, 's03-10-bebida');
      const p1 = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId: item.id,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's03-10-p1'
      }, { db });
      assert.equal(p1.entrega.qty_entregue, '1.000');
      assert.equal(p1.entrega.qty_restante, '2.000');

      const p2 = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId: item.id,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.500', idempotencyKey: 's03-10-p2'
      }, { db });
      assert.equal(p2.entrega.qty_restante, '0.500');

      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId: item.id,
        unidade_id: infra.unidadeId,
          qty_entregue: '1.000', idempotencyKey: 's03-10-excede'
        }, { db }),
        (err) => {
          assert.equal(err.codigo, 'QTY_ENTREGA_EXCEDE');
          return true;
        }
      );

      const total = await get(db, `
        SELECT COALESCE(SUM(qty_entregue_millis),0) AS t FROM cozinha_bebida_entregas
        WHERE cozinha_item_id=?
      `, [item.id]);
      assert.equal(Number(total.t), 2500);
      await close(db);
    });

    it('12) OUTRO bloqueia rodada com PASTEL até ficar pronto', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const outro = await criarPedidoItem(db, infra, {
        produtoId: infra.prodOutroId, nome: 'Produto Generico',
        classifSnapshot: 'COMERCIAL'
      });
      const out = await despacharItens(db, infra, [pastel, outro], 's03-12-desp');
      const itemPastel = out.itens.find((i) => i.tipo_item === 'PASTEL');
      const itemOutro = out.itens.find((i) => i.tipo_item === 'OUTRO');
      assert.ok(itemPastel && itemOutro);

      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: itemPastel.id, idempotencyKey: 's03-12-ini'
      }, { db });
      const pronto = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: itemPastel.id, idempotencyKey: 's03-12-pronto'
      }, { db });
      assert.equal(pronto.rodada.estado_preparacao, 'EM_PREPARACAO');
      const outroRow = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [itemOutro.id]);
      assert.equal(outroRow.estado_preparacao, 'AGUARDANDO');
      const consulta = await CozinhaPreparacao.consultarPreparacaoRodada({
        empresaId: 1, rodadaId: out.rodada.id
      }, { db });
      assert.equal(consulta.conclusao.pronta, false);
      assert.ok(consulta.conclusao.pendentes.includes(itemOutro.id));

      await deixarItemPronto(db, infra, itemOutro.id, 's03-12-outro');
      const rodada = await get(db, 'SELECT estado_preparacao FROM cozinha_rodadas WHERE id=?', [out.rodada.id]);
      assert.equal(rodada.estado_preparacao, 'PRONTA');
      await close(db);
    });

    it('13) OUTRO bloqueia rodada sem PASTEL até ficar pronto', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const outro = await criarPedidoItem(db, infra, {
        produtoId: infra.prodOutroId, nome: 'Produto Generico',
        classifSnapshot: 'COMERCIAL'
      });
      const bebida = await criarPedidoItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta',
        classifSnapshot: 'INSUMO', qty: 1
      });
      const out = await despacharItens(db, infra, [outro, bebida], 's03-13-desp');
      const itemOutro = out.itens.find((i) => i.tipo_item === 'OUTRO');
      const itemBebida = out.itens.find((i) => i.tipo_item === 'BEBIDA');

      await deixarItemPronto(db, infra, itemBebida.id, 's03-13-bebida');
      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId: itemBebida.id,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's03-13-beb'
      }, { db });

      let consulta = await CozinhaPreparacao.consultarPreparacaoRodada({
        empresaId: 1, rodadaId: out.rodada.id
      }, { db });
      assert.equal(consulta.conclusao.pronta, false);
      assert.ok(consulta.conclusao.pendentes.includes(itemOutro.id));

      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: itemOutro.id, idempotencyKey: 's03-13-ini'
      }, { db });
      const pronto = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: itemOutro.id, idempotencyKey: 's03-13-pronto'
      }, { db });
      assert.equal(pronto.rodada.estado_preparacao, 'PRONTA');
      await close(db);
    });
  });

  describe('Personalização e separação item/ingrediente', () => {
    it('14-15) personalização vinculada ao pastel; ingrediente não é item independente', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId,
        nome: 'Pastel do Cheff',
        classifSnapshot: 'COMERCIAL',
        comPersonalizacao: true,
        personalizacaoNome: 'Carne de Sol'
      });
      const bebida = await criarPedidoItem(db, infra, {
        produtoId: infra.prodFantaId,
        nome: 'Fanta Lata 350 ML',
        classifSnapshot: 'INSUMO'
      });
      const out = await despacharItens(db, infra, [pastel, bebida], 's03-14-desp');
      assert.equal(out.itens.length, 2);
      assert.ok(out.itens.every((i) => i.tipo_item === 'PASTEL' || i.tipo_item === 'BEBIDA'));
      assert.ok(!out.itens.some((i) => (i.produto_nome_snapshot || '').includes('Carne de Sol')));

      const pastelItem = out.itens.find((i) => i.tipo_item === 'PASTEL');
      const consulta = await CozinhaPreparacao.consultarPreparacaoRodada({
        empresaId: 1, rodadaId: out.rodada.id
      }, { db });
      const det = consulta.itens.find((i) => i.id === pastelItem.id);
      assert.equal(det.ingredientes.length, 1);
      assert.equal(det.ingredientes[0].insumo_nome_snapshot, 'Carne de Sol');

      const totalItens = await all(db, `SELECT id, produto_nome_snapshot FROM cozinha_itens`);
      assert.equal(totalItens.length, 2);
      await close(db);
    });
  });

  describe('Isolamento, autorização, transação e idempotência', () => {
    it('16) isolamento entre empresas', async () => {
      const db = await open();
      await schemaErp(db);
      const e1 = await seedInfra(db, 1);
      const e2 = await seedInfra(db, 2);
      const pastel1 = await criarPedidoItem(db, e1, {
        produtoId: e1.prodPastelId, nome: 'Pastel E1',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const out1 = await despacharItens(db, e1, [pastel1], 's03-16-e1');

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 2, operadorId: 7,
          unidade_id: e2.unidadeId,
          itemId: out1.itens[0].id, idempotencyKey: 's03-16-cross'
        }, { db }),
        (err) => {
          assert.equal(err.codigo, 'ITEM_NAO_ENCONTRADO');
          return true;
        }
      );

      const pastel2 = await criarPedidoItem(db, e2, {
        produtoId: e2.prodPastelId, nome: 'Pastel E2',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const out2 = await despacharItens(db, e2, [pastel2], 's03-16-e2');
      const ok = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 2, operadorId: 9,
        unidade_id: e2.unidadeId,
        itemId: out2.itens[0].id, idempotencyKey: 's03-16-ok'
      }, { db });
      assert.equal(ok.item.empresa_id, 2);

      await assert.rejects(
        () => CozinhaPreparacao.consultarPreparacaoRodada({
          empresaId: 1, rodadaId: out2.rodada.id
        }, { db }),
        (err) => err.codigo === 'RODADA_NAO_ENCONTRADA'
      );
      await close(db);
    });

    it('17) usuário/sessão sem operador não altera preparação', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const out = await despacharItens(db, infra, [pastel], 's03-17-desp');
      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: null,
        unidade_id: infra.unidadeId,
          itemId: out.itens[0].id, idempotencyKey: 's03-17-no-op'
        }, { db }),
        (err) => {
          assert.equal(err.codigo, 'SESSAO_INVALIDA');
          return true;
        }
      );
      await close(db);
    });

    it('18) falha transacional não deixa estado parcial', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const out = await despacharItens(db, infra, [pastel], 's03-18-desp');
      const itemId = out.itens[0].id;

      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7,
        unidade_id: infra.unidadeId,
          itemId, idempotencyKey: 's03-18-fail'
        }, { db }),
        (err) => err.codigo === 'TRANSICAO_INVALIDA'
      );

      const item = await get(db, `SELECT * FROM cozinha_itens WHERE id=?`, [itemId]);
      assert.equal(item.estado_preparacao, 'AGUARDANDO');
      const eventos = await all(db, `
        SELECT * FROM cozinha_eventos_outbox WHERE idempotency_key='s03-18-fail'
      `);
      assert.equal(eventos.length, 0);

      const bebida = await criarPedidoItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta',
        classifSnapshot: 'INSUMO', qty: 1
      });
      const outB = await despacharItens(db, infra, [{ ...bebida, qty: '1.000' }], 's03-18-beb');
      await deixarItemPronto(db, infra, outB.itens[0].id, 's03-18-pronta');
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7,
        unidade_id: infra.unidadeId,
          itemId: outB.itens[0].id, qty_entregue: '5.000',
          idempotencyKey: 's03-18-excede'
        }, { db }),
        (err) => err.codigo === 'QTY_ENTREGA_EXCEDE'
      );
      const entregas = await all(db, `SELECT * FROM cozinha_bebida_entregas`);
      assert.equal(entregas.length, 0);
      await close(db);
    });

    it('19) operação repetida não duplica entrega nem evento', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const bebida = await criarPedidoItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta',
        classifSnapshot: 'INSUMO', qty: 2
      });
      const out = await despacharItens(db, infra, [{ ...bebida, qty: '2.000' }], 's03-19-desp');
      const itemId = out.itens[0].id;

      await deixarItemPronto(db, infra, itemId, 's03-19-pronta');
      const a = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's03-19-idem'
      }, { db });
      const b = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's03-19-idem'
      }, { db });
      assert.equal(b.repetida, true);
      assert.equal(a.entrega.id, b.entrega.id);

      const entregas = await all(db, `
        SELECT * FROM cozinha_bebida_entregas WHERE cozinha_item_id=?
      `, [itemId]);
      assert.equal(entregas.length, 1);

      const eventos = await all(db, `
        SELECT * FROM cozinha_eventos_outbox
        WHERE idempotency_key = 's03-19-idem:EVENTO'
      `);
      assert.equal(eventos.length, 1);
      const idempBeb = await all(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='s03-19-idem'
      `);
      assert.equal(idempBeb.length, 1);
      assert.equal(idempBeb[0].situacao, 'CONCLUIDA');

      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel Idem',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const outP = await despacharItens(db, infra, [pastel], 's03-19-pastel');
      const pastelId = outP.itens[0].id;
      const ini1 = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: pastelId, idempotencyKey: 's03-19-ini'
      }, { db });
      const ini2 = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: pastelId, idempotencyKey: 's03-19-ini'
      }, { db });
      assert.equal(ini1.item.estado_preparacao, 'EM_PREPARACAO');
      assert.equal(ini2.repetida, true);
      const evIni = await all(db, `
        SELECT * FROM cozinha_eventos_outbox WHERE idempotency_key='s03-19-ini:EVENTO'
      `);
      assert.equal(evIni.length, 1);
      const idempIni = await all(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='s03-19-ini'
      `);
      assert.equal(idempIni.length, 1);
      await close(db);
    });
  });

  describe('Regressão Sprint 01 e Sprint 02', () => {
    it('20) regressão S01 — schema operacional e FK composta id+empresa', async () => {
      const db = await open();
      await schemaErp(db);
      assert.equal(isCozinhaOperacional(), true);
      const tabs = await all(db, `
        SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cozinha_%'
      `);
      const nomes = new Set(tabs.map((t) => t.name));
      for (const t of [
        'cozinha_rodadas', 'cozinha_itens', 'cozinha_item_ingredientes',
        'cozinha_bebida_entregas', 'cozinha_eventos_outbox', 'cozinha_idempotencia'
      ]) {
        assert.ok(nomes.has(t), `faltando ${t}`);
      }

      const infra1 = await seedInfra(db, 1);
      const infra2 = await seedInfra(db, 2);
      const pastel1 = await criarPedidoItem(db, infra1, {
        produtoId: infra1.prodPastelId, nome: 'P1',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const pastel2 = await criarPedidoItem(db, infra2, {
        produtoId: infra2.prodPastelId, nome: 'P2',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const o1 = await despacharItens(db, infra1, [pastel1], 's03-20-e1');
      const o2 = await despacharItens(db, infra2, [pastel2], 's03-20-e2');
      assert.equal(o1.rodada.empresa_id, 1);
      assert.equal(o2.rodada.empresa_id, 2);
      assert.notEqual(o1.rodada.id, o2.rodada.id);

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: infra2.empresaId, operadorId: 7,
        unidade_id: infra2.unidadeId,
          itemId: o1.itens[0].id, idempotencyKey: 's03-20-cross'
        }, { db }),
        (err) => err.codigo === 'ITEM_NAO_ENCONTRADO'
      );
      await close(db);
    });

    it('21) regressão S02 — despacho FIFO, personalização e estados iniciais', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const a = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel A',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const b = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel B',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const r1 = await despacharItens(db, infra, [a], 's03-21-a');
      const r2 = await despacharItens(db, infra, [b], 's03-21-b');
      assert.equal(r1.rodada.sequencia_global, 1);
      assert.equal(r2.rodada.sequencia_global, 2);
      assert.equal(r1.rodada.estado_preparacao, 'AGUARDANDO');
      assert.equal(r1.itens[0].estado_preparacao, 'AGUARDANDO');

      const ings = await all(db, `
        SELECT * FROM cozinha_item_ingredientes WHERE cozinha_item_id=?
      `, [r1.itens[0].id]);
      assert.equal(ings.length, 1);

      const replay = await despacharItens(db, infra, [a], 's03-21-a');
      assert.equal(replay.repetida, true);
      assert.equal(replay.rodada.id, r1.rodada.id);

      const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
      assert.equal(rods.length, 2);
      await close(db);
    });
  });
});
