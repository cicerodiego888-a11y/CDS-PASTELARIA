/**
 * Sprint 07 · S07-0 — GET /api/cozinha/preparacao/painel
 * Banco temporário / :memory:. Sem banco oficial. Sem impressão física.
 *
 *   CDS_BLOQUEAR_BANCO_OFICIAL=1 CDS_TEST_ISOLATION=1 \
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-0-painel-kds.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const express = require('express');
const jwt = require('jsonwebtoken');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-0-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-0-painel';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional
} = require('../../backend/utils/cozinhaSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const CozinhaPreparacao = require('../../backend/services/cozinha/CozinhaPreparacaoService');
const CozinhaKdsPainel = require('../../backend/services/cozinha/CozinhaKdsPainelService');
const cozinhaRoutes = require('../../backend/rotas/cozinha');
const { verificarToken } = require('../../backend/middleware/auth');
const { exigirRecurso } = require('../../backend/middleware/validarRecursoImplantacao');
const configService = require('../../backend/services/configuracaoService');

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
function open(caminho = ':memory:') {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(caminho, (err) => {
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
  marcarCozinhaOperacional(true);
  assert.equal(isCozinhaOperacional(), true);
}

async function seedUnidade(db, empresaId, codigo, mesaNumero) {
  const mesa = await run(db, `
    INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, ?, 1)
  `, [empresaId, mesaNumero]);
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado)
    VALUES (?, ?, 'OCUPADA')
  `, [empresaId, mesa.lastID]);
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
    VALUES (?, ?, 0, 1)
  `, [empresaId, codigo]);
  const cat = await run(db, `INSERT INTO categorias (nome) VALUES ('Pastelaria')`);
  const pastel = await run(db, `
    INSERT INTO produtos (
      nome, tipo_operacional, comercializavel, categoria_id,
      utiliza_ficha_tecnica, permite_personalizacao_ingredientes
    ) VALUES ('Pastel Carne', 'COMERCIAL', 0, ?, 1, 0)
  `, [cat.lastID]);
  await run(db, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [pastel.lastID]);
  return {
    empresaId,
    mesaId: mesa.lastID,
    atendimentoId: at.lastID,
    unidadeId: un.lastID,
    prodPastelId: pastel.lastID
  };
}

async function despacharPastel(db, infra, { observacao = null, chave, numeroComanda } = {}) {
  const ped = await run(db, `
    INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total, data_pedido)
    VALUES (?, 'PEDIDO', ?, ?, ?, 99.90, date('now'))
  `, [`P-${chave}`, infra.empresaId, infra.mesaId, infra.atendimentoId]);
  const item = await run(db, `
    INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, subtotal,
      classificacao_operacional_snapshot, produto_nome_snapshot, observacao
    ) VALUES (?, ?, 2, 15.50, 31.00, 'PASTEL', 'Pastel Carne', ?)
  `, [ped.lastID, infra.prodPastelId, observacao]);
  const nCmd = numeroComanda != null
    ? Number(numeroComanda)
    : (Math.abs(String(chave).split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 9000) + 1;
  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (
      empresa_id, atendimento_id, numero_comanda, pedido_id, operador_lancamento_id
    ) VALUES (?, ?, ?, ?, 1)
  `, [infra.empresaId, infra.atendimentoId, nCmd, ped.lastID]);

  const out = await CozinhaDespacho.despacharLote({
    empresaId: infra.empresaId,
    operadorId: 1,
    idempotencyKey: `despacho-${chave}`,
    unidade_id: infra.unidadeId,
    mesa_id: infra.mesaId,
    atendimento_id: infra.atendimentoId,
    itens: [{
      pedido_id: ped.lastID,
      pedido_item_id: item.lastID,
      comanda_id: cmd.lastID,
      qty_solicitada: 2
    }]
  }, { db });

  return {
    despacho: out,
    pedidoId: ped.lastID,
    pedidoItemId: item.lastID,
    comandaId: cmd.lastID,
    numeroComanda: nCmd
  };
}

function assertSemFinanceiroFiscal(obj) {
  const json = JSON.stringify(obj).toLowerCase();
  for (const proibido of [
    'preco_unitario',
    'subtotal',
    'pagamento',
    'nfce',
    'cfop',
    'csosn',
    'imposto',
    '99.90',
    '15.50',
    '9.99'
  ]) {
    assert.equal(json.includes(proibido), false, `vazou campo: ${proibido}`);
  }
  // "total" de paginação é contagem de rodadas — não valor financeiro.
  assert.equal(typeof obj.total, 'number');
  assert.equal(obj.financeiro, false);
  assert.equal(obj.fiscal, false);
  assert.equal(obj.impressao_fisica, false);
}

describe('Sprint 07 S07-0 — painel KDS (serviço)', () => {
  it('projeta todos os eventos reais de preparação, retorno, reinício e cancelamento', async () => {
    const db = await open();
    try {
      await schemaErp(db);
      const infra = await seedUnidade(db, 1, 'TEMPOS', 10);
      const d = await despacharPastel(db, infra, { chave: 'tempos-reais' });
      const itemId = d.despacho.itens[0].id;
      const base = { empresaId: 1, unidadeId: infra.unidadeId, operadorId: 7, itemId };
      await CozinhaPreparacao.iniciarPreparacao({ ...base, idempotencyKey: 'tempos-inicio1' }, { db });
      await CozinhaPreparacao.voltarParaAguardando({ ...base, idempotencyKey: 'tempos-volta' }, { db });
      await CozinhaPreparacao.iniciarPreparacao({ ...base, idempotencyKey: 'tempos-inicio2' }, { db });
      await CozinhaPreparacao.cancelarItem({ ...base, motivo: 'FALTA_PRODUTO', idempotencyKey: 'tempos-cancelar' }, { db });
      const tempos = [
        ['tempos-inicio1:EVENTO', '$.iniciado_em', '2026-01-01T20:02:00Z'],
        ['tempos-volta:EVENTO', '$.revertido_em', '2026-01-01T20:05:00Z'],
        ['tempos-inicio2:EVENTO', '$.iniciado_em', '2026-01-01T20:08:00Z'],
        ['tempos-cancelar:ITEM_CANCELADO', '$.cancelamento_em', '2026-01-01T20:10:00Z']
      ];
      await run(db, 'UPDATE cozinha_rodadas SET enviada_em=? WHERE id=?', ['2026-01-01T20:00:00Z', d.despacho.rodada.id]);
      await run(db, 'UPDATE cozinha_itens SET cancelado_em=? WHERE id=?', ['2026-01-01T20:10:00Z', itemId]);
      for (const [chave, campo, valor] of tempos) {
        await run(db, 'UPDATE cozinha_eventos_outbox SET payload_json=json_set(payload_json, ?, ?) WHERE idempotency_key=?',
          [campo, valor, chave]);
      }
      const painel = await CozinhaKdsPainel.listarPainelPreparacao({
        empresaId: 1, unidadeId: infra.unidadeId, historico: 'cancelados', paginacao: 'cursor'
      }, { db });
      const rodada = painel.rodadas[0];
      const item = rodada.itens[0];
      assert.deepEqual(item.eventos_preparacao.map((e) => e.tipo),
        ['PREPARACAO_INICIADA', 'PREPARACAO_REVERTIDA', 'PREPARACAO_INICIADA', 'ITEM_CANCELADO']);
      const kds = require('../../frontend/erp/js/cozinha-kds');
      const calculado = kds.calcularTemposItem({ ...rodada, historico_cancelamento: true }, item,
        new Date('2026-01-01T21:00:00Z'));
      assert.equal(calculado.espera, 300);
      assert.equal(calculado.preparo, 300);
      assert.equal(calculado.chegada, 600);
    } finally { await close(db); }
  });

  it('mantém snapshot dos históricos após novos eventos, alteração de rodada e reabertura', async () => {
    const dbPath = path.join(dbDir, 'g1-snapshot.db');
    let db = await open(dbPath);
    try {
      await schemaErp(db);
      const infra = await seedUnidade(db, 1, 'SNAP', 3);
      const base = { empresaId: 1, unidadeId: infra.unidadeId, operadorId: 7 };
      const a = await despacharPastel(db, infra, { chave: 'snapshot-a' });
      const b = await despacharPastel(db, infra, { chave: 'snapshot-b' });
      const segundo = await run(db, `
        INSERT INTO cozinha_itens (empresa_id, unidade_id, rodada_id, comanda_id, pedido_id,
          pedido_item_id, sequencia_global, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot)
        SELECT empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global+1000, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot
        FROM cozinha_itens WHERE id=?`, [b.despacho.itens[0].id]);
      await CozinhaPreparacao.cancelarItem({ ...base, itemId: b.despacho.itens[0].id,
        motivo: 'FALTA_PRODUTO', idempotencyKey: 'snapshot-b-item' }, { db });
      await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: a.despacho.rodada.id,
        motivo: 'CLIENTE_DESISTIU', idempotencyKey: 'snapshot-a-cancelar' }, { db });

      async function retirar(chave) {
        const d = await despacharPastel(db, infra, { chave });
        const itemId = d.despacho.itens[0].id;
        await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId, idempotencyKey: `${chave}-ini` }, { db });
        await CozinhaPreparacao.marcarItemPronto({ ...base, itemId, idempotencyKey: `${chave}-pronto` }, { db });
        await CozinhaPreparacao.confirmarRetirada({ ...base, rodadaId: d.despacho.rodada.id,
          idempotencyKey: `${chave}-retirada` }, { db });
        return d.despacho.rodada.id;
      }
      const retirada1 = await retirar('snapshot-r1');
      const retirada2 = await retirar('snapshot-r2');
      const consultar = (historico, cursor) => CozinhaKdsPainel.listarPainelPreparacao({
        ...base, historico, paginacao: 'cursor', limite: 1, cursor
      }, { db });
      const cancelados1 = await consultar('cancelados');
      const retirados1 = await consultar('retirados');
      assert.equal(cancelados1.total, 2);
      assert.equal(retirados1.total, 2);
      assert.equal(cancelados1.rodadas[0].id, a.despacho.rodada.id);
      assert.equal(retirados1.rodadas[0].id, retirada2);

      await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: b.despacho.rodada.id,
        motivo: 'OUTRO', justificativa: 'Somente na rodada', idempotencyKey: 'snapshot-b-rodada' }, { db });
      const novo = await despacharPastel(db, infra, { chave: 'snapshot-novo' });
      await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: novo.despacho.rodada.id,
        motivo: 'ERRO_LANCAMENTO', idempotencyKey: 'snapshot-novo-cancelar' }, { db });
      const retiradaNova = await retirar('snapshot-r3');
      await close(db);
      db = await open(dbPath);
      const cancelados2 = await consultar('cancelados', cancelados1.cursor_proximo);
      const retirados2 = await consultar('retirados', retirados1.cursor_proximo);
      assert.equal(cancelados2.rodadas[0].id, b.despacho.rodada.id);
      assert.equal(cancelados2.rodadas[0].itens.length, 1);
      assert.equal(cancelados2.rodadas[0].itens[0].cancelamento_justificativa, null);
      assert.equal(cancelados2.rodadas[0].cancelamento_evento, null);
      assert.equal(retirados2.rodadas[0].id, retirada1);
      assert.equal(cancelados2.cursor_proximo, null);
      assert.equal(retirados2.cursor_proximo, null);
      const atualizados = await CozinhaKdsPainel.listarPainelPreparacao({
        ...base, historico: 'cancelados', paginacao: 'cursor', limite: 10
      }, { db });
      const historicoB = atualizados.rodadas.find((r) => r.id === b.despacho.rodada.id);
      assert.equal(atualizados.total, 3);
      assert.equal(historicoB.itens.find((i) => i.id === b.despacho.itens[0].id).cancelamento_justificativa, null);
      assert.equal(historicoB.itens.find((i) => i.id === segundo.lastID).cancelamento_justificativa, 'Somente na rodada');
      assert.equal(historicoB.cancelamento_evento.justificativa, 'Somente na rodada');
      assert.equal((await consultar('retirados')).rodadas[0].id, retiradaNova);
      const outra = await seedUnidade(db, 2, 'OUTRA', 7);
      await assert.rejects(() => CozinhaKdsPainel.listarPainelPreparacao({
        empresaId: 2, unidadeId: outra.unidadeId, historico: 'cancelados', paginacao: 'cursor',
        cursor: cancelados1.cursor_proximo
      }, { db }), (err) => err.codigo === 'CURSOR_INVALIDO');
    } finally {
      await close(db);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('serializa retirada concorrente com cancelamento sem duplicar eventos', async () => {
    const dbPath = path.join(dbDir, 'g1-concorrencia.db');
    const db = await open(dbPath);
    let outraConexao;
    try {
      await schemaErp(db);
      const infra = await seedUnidade(db, 1, 'CORRIDA', 4);
      const d = await despacharPastel(db, infra, { chave: 'corrida-g1' });
      const base = { empresaId: 1, unidadeId: infra.unidadeId, operadorId: 7 };
      const itemId = d.despacho.itens[0].id;
      const rodadaId = d.despacho.rodada.id;
      await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId, idempotencyKey: 'corrida-iniciar' }, { db });
      await CozinhaPreparacao.marcarItemPronto({ ...base, itemId, idempotencyKey: 'corrida-pronto' }, { db });
      outraConexao = await open(dbPath);
      const resultados = await Promise.allSettled([
        CozinhaPreparacao.confirmarRetirada({ ...base, rodadaId, idempotencyKey: 'corrida-retirar' }, { db }),
        CozinhaPreparacao.cancelarRodada({ ...base, rodadaId, motivo: 'CLIENTE_DESISTIU', idempotencyKey: 'corrida-cancelar' }, { db: outraConexao })
      ]);
      assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(resultados.filter((r) => r.status === 'rejected').length, 1);
      assert.ok(['RODADA_CANCELADA', 'RODADA_JA_RETIRADA'].includes(
        resultados.find((r) => r.status === 'rejected').reason.codigo));
      const eventos = await get(db, `SELECT COUNT(*) AS n FROM cozinha_eventos_outbox
        WHERE tipo IN ('RETIRADA_CONFIRMADA', 'RODADA_CANCELADA')`);
      assert.equal(eventos.n, 1);
      assert.equal((await get(db, 'SELECT status FROM pedidos WHERE id=?', [d.pedidoId])).status, 'PEDIDO');
      assert.equal((await get(db, 'SELECT estado FROM mesa_atendimentos WHERE id=?', [infra.atendimentoId])).estado, 'OCUPADA');
    } finally {
      if (outraConexao) await close(outraConexao);
      await close(db);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('sinaliza rodada legada sem evento em vez de inventar histórico', async () => {
    const db = await open();
    try {
      await schemaErp(db);
      const infra = await seedUnidade(db, 1, 'LEGADO', 6);
      const d = await despacharPastel(db, infra, { chave: 'sem-evento' });
      const base = { empresaId: 1, unidadeId: infra.unidadeId, operadorId: 7 };
      await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: d.despacho.rodada.id,
        motivo: 'FALTA_PRODUTO', idempotencyKey: 'sem-evento-cancelar' }, { db });
      await run(db, "DELETE FROM cozinha_eventos_outbox WHERE tipo='RODADA_CANCELADA'");
      const cursor = await CozinhaKdsPainel.listarPainelPreparacao({
        ...base, historico: 'cancelados', paginacao: 'cursor'
      }, { db });
      assert.equal(cursor.registros_sem_evento, 1);
      assert.equal(cursor.rodadas.length, 0);
      const legado = await CozinhaKdsPainel.listarPainelPreparacao({ ...base, historico: 'cancelados' }, { db });
      assert.equal(legado.rodadas[0].id, d.despacho.rodada.id);
    } finally { await close(db); }
  });

  it('consulta lacunas legadas de retirada, rodada e item sem misturar justificativas', async () => {
    const db = await open();
    try {
      await schemaErp(db);
      const infra = await seedUnidade(db, 1, 'LEGADO-DETALHE', 16);
      const base = { empresaId: 1, unidadeId: infra.unidadeId, operadorId: 7 };
      const retirada = await despacharPastel(db, infra, { chave: 'legado-retirada' });
      const itemRetirado = retirada.despacho.itens[0].id;
      await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId: itemRetirado, idempotencyKey: 'leg-ret-inicio' }, { db });
      await CozinhaPreparacao.marcarItemPronto({ ...base, itemId: itemRetirado, idempotencyKey: 'leg-ret-pronto' }, { db });
      await CozinhaPreparacao.confirmarRetirada({ ...base, rodadaId: retirada.despacho.rodada.id,
        idempotencyKey: 'leg-retirada' }, { db });
      await run(db, "DELETE FROM cozinha_eventos_outbox WHERE idempotency_key='leg-retirada:EVENTO'");
      await run(db, `UPDATE cozinha_rodadas SET enviada_em='2026-01-01T20:00:00Z',
        retirada_em='2026-01-01T20:14:00Z' WHERE id=?`, [retirada.despacho.rodada.id]);
      await run(db, `UPDATE cozinha_eventos_outbox SET payload_json=json_set(payload_json, '$.iniciado_em', ?)
        WHERE idempotency_key='leg-ret-inicio:EVENTO'`, ['2026-01-01T20:02:00Z']);
      await run(db, `UPDATE cozinha_eventos_outbox SET payload_json=json_set(payload_json, '$.pronto_em', ?)
        WHERE idempotency_key='leg-ret-pronto:EVENTO'`, ['2026-01-01T20:12:00Z']);
      await run(db, `UPDATE cozinha_eventos_outbox SET payload_json=json_set(payload_json, '$.em', ?)
        WHERE tipo='RODADA_PRONTA' AND json_extract(payload_json, '$.rodada_id')=?`,
      ['2026-01-01T20:12:00Z', retirada.despacho.rodada.id]);

      const cancelada = await despacharPastel(db, infra, { chave: 'legado-rodada' });
      await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: cancelada.despacho.rodada.id,
        motivo: 'OUTRO', justificativa: 'Motivo da rodada', idempotencyKey: 'leg-rodada' }, { db });
      await run(db, "DELETE FROM cozinha_eventos_outbox WHERE idempotency_key='leg-rodada:RODADA_CANCELADA'");

      const parcial = await despacharPastel(db, infra, { chave: 'legado-parcial' });
      const primeiro = parcial.despacho.itens[0].id;
      const segundo = await run(db, `
        INSERT INTO cozinha_itens (empresa_id, unidade_id, rodada_id, comanda_id, pedido_id,
          pedido_item_id, sequencia_global, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot)
        SELECT empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global+1000, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot
        FROM cozinha_itens WHERE id=?`, [primeiro]);
      await CozinhaPreparacao.cancelarItem({ ...base, itemId: primeiro, motivo: 'FALTA_PRODUTO',
        idempotencyKey: 'leg-item' }, { db });
      await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: parcial.despacho.rodada.id,
        motivo: 'OUTRO', justificativa: 'Somente na rodada parcial', idempotencyKey: 'leg-parcial' }, { db });
      await run(db, "DELETE FROM cozinha_eventos_outbox WHERE idempotency_key='leg-item:ITEM_CANCELADO'");

      const completo = await despacharPastel(db, infra, { chave: 'legado-completo' });
      await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: completo.despacho.rodada.id,
        motivo: 'CLIENTE_DESISTIU', idempotencyKey: 'leg-completo' }, { db });

      const eventosAntes = await get(db, 'SELECT COUNT(*) AS n FROM cozinha_eventos_outbox');
      const out = await CozinhaKdsPainel.listarHistoricoLegado({ ...base, limite: 20 }, { db });
      assert.deepEqual(await get(db, 'SELECT COUNT(*) AS n FROM cozinha_eventos_outbox'), eventosAntes);
      assert.deepEqual(out.registros.map((r) => r.id),
        [parcial.despacho.rodada.id, cancelada.despacho.rodada.id, retirada.despacho.rodada.id]);
      const retirado = out.registros.find((r) => r.id === retirada.despacho.rodada.id);
      assert.equal(retirado.retirada_sem_evento, 1);
      assert.equal(retirado.retirada_por, 7);
      assert.ok(retirado.retirada_em);
      assert.deepEqual(retirado.itens[0].eventos_preparacao.map((e) => e.tipo),
        ['PREPARACAO_INICIADA', 'ITEM_PRONTO']);
      const kds = require('../../frontend/erp/js/cozinha-kds');
      const tempoRetirado = kds.calcularTemposItem(retirado, retirado.itens[0], new Date());
      assert.equal(tempoRetirado.periodos.valido, true);
      assert.equal(tempoRetirado.espera, 120);
      assert.equal(tempoRetirado.preparo, 600);
      const htmlLegado = kds.htmlPainel({ mostrarLegado: true, legado: [retirado],
        rodadas: [], paginasLegado: { indice: 0 } }, new Date('2026-01-01T21:00:00Z'));
      assert.match(htmlLegado, /Espera: 00:02:00/);
      assert.match(htmlLegado, /Preparação: 00:10:00/);
      assert.match(htmlLegado, /Espera do garçom: 00:02:00/);
      const rodada = out.registros.find((r) => r.id === cancelada.despacho.rodada.id);
      assert.equal(rodada.cancelamento_sem_evento, 1);
      assert.equal(rodada.cancelamento_justificativa, 'Motivo da rodada');
      assert.equal(rodada.itens[0].cancelamento_sem_evento, 1);
      assert.equal(rodada.itens[0].cancelamento_justificativa, null);
      const misto = out.registros.find((r) => r.id === parcial.despacho.rodada.id);
      assert.equal(misto.cancelamento_sem_evento, 0);
      assert.equal(misto.itens.find((i) => i.id === primeiro).cancelamento_sem_evento, 1);
      assert.equal(misto.itens.find((i) => i.id === primeiro).cancelamento_justificativa, null);
      assert.equal(misto.itens.find((i) => i.id === segundo.lastID).cancelamento_sem_evento, 0);
      assert.equal(misto.itens.find((i) => i.id === segundo.lastID).cancelamento_justificativa, 'Somente na rodada parcial');
      assert.equal(misto.cancelamento_justificativa, 'Somente na rodada parcial');
      assert.equal(misto.itens[0].qty_solicitada, '2.000');
      await run(db, `UPDATE cozinha_eventos_outbox
        SET payload_json=json_remove(payload_json, '$.iniciado_em')
        WHERE idempotency_key='leg-ret-inicio:EVENTO'`);
      const semHorario = await CozinhaKdsPainel.listarHistoricoLegado({ ...base, limite: 20 }, { db });
      const itemSemHorario = semHorario.registros.find((r) => r.id === retirado.id).itens[0];
      assert.equal(itemSemHorario.eventos_preparacao[0].em, null);
      assert.equal(kds.calcularTemposItem(retirado, itemSemHorario, new Date()).preparo, null);
      assertSemFinanceiroFiscal({ ...out, total: out.registros.length,
        financeiro: false, fiscal: false, impressao_fisica: false });
    } finally { await close(db); }
  });

  it('pagina legados com inserção concorrente, isolamento e reabertura do banco', async () => {
    const dbPath = path.join(dbDir, 'g1-legado-snapshot.db');
    let db = await open(dbPath);
    try {
      await schemaErp(db);
      const infra = await seedUnidade(db, 1, 'LEGADO-SNAPSHOT', 17);
      const outraUnidade = await seedUnidade(db, 1, 'LEGADO-U2', 18);
      const outraEmpresa = await seedUnidade(db, 2, 'LEGADO-E2', 19);
      const base = { empresaId: 1, unidadeId: infra.unidadeId, operadorId: 7 };
      async function criarLegado(chave) {
        const d = await despacharPastel(db, infra, { chave });
        await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: d.despacho.rodada.id,
          motivo: 'CLIENTE_DESISTIU', idempotencyKey: `cancelar-${chave}` }, { db });
        await run(db, 'DELETE FROM cozinha_eventos_outbox WHERE idempotency_key=?',
          [`cancelar-${chave}:RODADA_CANCELADA`]);
        return d.despacho.rodada.id;
      }
      const primeiro = await criarLegado('leg-snap-1');
      const parcial = await despacharPastel(db, infra, { chave: 'leg-snap-parcial' });
      const itemParcial = parcial.despacho.itens[0].id;
      const itemRestante = await run(db, `
        INSERT INTO cozinha_itens (empresa_id, unidade_id, rodada_id, comanda_id, pedido_id,
          pedido_item_id, sequencia_global, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot)
        SELECT empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global+3000, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot
        FROM cozinha_itens WHERE id=?`, [itemParcial]);
      await CozinhaPreparacao.cancelarItem({ ...base, itemId: itemParcial, motivo: 'FALTA_PRODUTO',
        idempotencyKey: 'leg-snap-parcial-item' }, { db });
      await run(db, "DELETE FROM cozinha_eventos_outbox WHERE idempotency_key='leg-snap-parcial-item:ITEM_CANCELADO'");
      const segundo = await criarLegado('leg-snap-2');
      const ativa = await despacharPastel(db, infra, { chave: 'leg-snap-ativa' });
      const consultar = (cursor, contexto = base) =>
        CozinhaKdsPainel.listarHistoricoLegado({ ...contexto, limite: 1, cursor }, { db });
      const pagina1 = await consultar();
      assert.equal(pagina1.registros[0].id, segundo);
      assert.ok(pagina1.cursor_proximo);
      await CozinhaPreparacao.cancelarRodada({ ...base, rodadaId: parcial.despacho.rodada.id,
        motivo: 'OUTRO', justificativa: 'Rodada posterior', idempotencyKey: 'leg-snap-parcial-rodada' }, { db });
      const novo = await criarLegado('leg-snap-novo');
      const novoItem = await run(db, `
        INSERT INTO cozinha_itens (empresa_id, unidade_id, rodada_id, comanda_id, pedido_id,
          pedido_item_id, sequencia_global, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot)
        SELECT empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global+2000, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot
        FROM cozinha_itens WHERE id=?`, [ativa.despacho.itens[0].id]);
      await CozinhaPreparacao.cancelarItem({ ...base, itemId: novoItem.lastID,
        motivo: 'FALTA_PRODUTO', idempotencyKey: 'leg-snap-item-novo' }, { db });
      await run(db, "DELETE FROM cozinha_eventos_outbox WHERE idempotency_key='leg-snap-item-novo:ITEM_CANCELADO'");
      await close(db);
      const consultaReiniciada = `
        const path = require('path');
        const sqlite3 = require('sqlite3');
        const service = require('./backend/services/cozinha/CozinhaKdsPainelService');
        if (process.env.CDS_BLOQUEAR_BANCO_OFICIAL !== '1' || process.env.CDS_TEST_ISOLATION !== '1'
          || process.env.CDS_FORCAR_LOCAL !== '1' || process.env.CDS_ALLOW_OFFICIAL_DB
          || !path.resolve(process.argv[1]).startsWith(path.resolve(process.env.DB_DIR) + path.sep)) {
          throw new Error('Isolamento do subprocesso inválido');
        }
        const db = new sqlite3.Database(process.argv[1]);
        service.listarHistoricoLegado({ empresaId: 1, unidadeId: Number(process.argv[2]),
          limite: 1, cursor: process.argv[3] }, { db })
          .then((out) => process.stdout.write(JSON.stringify(out)))
          .catch((err) => { console.error(err); process.exitCode = 1; })
          .finally(() => db.close());
      `;
      const pagina2 = JSON.parse(execFileSync(process.execPath,
        ['-e', consultaReiniciada, dbPath, String(infra.unidadeId), pagina1.cursor_proximo],
        { cwd: path.resolve(__dirname, '..', '..'), env: process.env, encoding: 'utf8', timeout: 10000 }));
      db = await open(dbPath);
      assert.deepEqual(pagina2.registros.map((r) => r.id), [parcial.despacho.rodada.id]);
      assert.equal(pagina2.registros[0].itens.find((i) => i.id === itemParcial).cancelamento_sem_evento, 1);
      assert.equal(pagina2.registros[0].itens.find((i) => i.id === itemRestante.lastID).cancelamento_sem_evento, 0);
      const pagina3 = await consultar(pagina2.cursor_proximo);
      assert.deepEqual(pagina3.registros.map((r) => r.id), [primeiro]);
      assert.equal(pagina3.cursor_proximo, null);
      const atualizados = await CozinhaKdsPainel.listarHistoricoLegado({ ...base, limite: 20 }, { db });
      assert.deepEqual(atualizados.registros.map((r) => r.id),
        [novo, ativa.despacho.rodada.id, segundo, parcial.despacho.rodada.id, primeiro]);
      assert.equal((await consultar(null, { empresaId: 1, unidadeId: outraUnidade.unidadeId })).registros.length, 0);
      assert.equal((await consultar(null, { empresaId: 2, unidadeId: outraEmpresa.unidadeId })).registros.length, 0);
      await assert.rejects(() => consultar(pagina1.cursor_atual,
        { empresaId: 1, unidadeId: outraUnidade.unidadeId }), (err) => err.codigo === 'CURSOR_INVALIDO');
      await assert.rejects(() => consultar(pagina1.cursor_atual,
        { empresaId: 2, unidadeId: outraEmpresa.unidadeId }), (err) => err.codigo === 'CURSOR_INVALIDO');
      await assert.rejects(() => consultar('invalido'), (err) => err.codigo === 'CURSOR_INVALIDO');
    } finally {
      await close(db);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('mantém item cancelado separado dos itens retirados da mesma rodada', async () => {
    const db = await open();
    try {
      await schemaErp(db);
      const infra = await seedUnidade(db, 1, 'MISTO', 5);
      const d = await despacharPastel(db, infra, { chave: 'misto-g1' });
      const itemCancelado = d.despacho.itens[0].id;
      const copia = await run(db, `
        INSERT INTO cozinha_itens (empresa_id, unidade_id, rodada_id, comanda_id, pedido_id,
          pedido_item_id, sequencia_global, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot)
        SELECT empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global+1000, tipo_item, qty_solicitada_millis, produto_id, produto_nome_snapshot
        FROM cozinha_itens WHERE id=?`, [itemCancelado]);
      const base = { empresaId: 1, unidadeId: infra.unidadeId, operadorId: 7 };
      await CozinhaPreparacao.cancelarItem({ ...base, itemId: itemCancelado, motivo: 'FALTA_PRODUTO', idempotencyKey: 'misto-cancelar' }, { db });
      await CozinhaPreparacao.iniciarPreparacao({ ...base, itemId: copia.lastID, idempotencyKey: 'misto-iniciar' }, { db });
      await CozinhaPreparacao.marcarItemPronto({ ...base, itemId: copia.lastID, idempotencyKey: 'misto-pronto' }, { db });
      await CozinhaPreparacao.confirmarRetirada({ ...base, rodadaId: d.despacho.rodada.id, idempotencyKey: 'misto-retirar' }, { db });
      const retirados = await CozinhaKdsPainel.listarPainelPreparacao({ ...base, historico: 'retirados', paginacao: 'cursor' }, { db });
      const cancelados = await CozinhaKdsPainel.listarPainelPreparacao({ ...base, historico: 'cancelados', paginacao: 'cursor' }, { db });
      assert.deepEqual(retirados.rodadas[0].itens.map((i) => i.id), [copia.lastID]);
      assert.deepEqual(cancelados.rodadas[0].itens.map((i) => i.id), [itemCancelado]);
      assert.equal(cancelados.rodadas[0].itens[0].estado_preparacao, 'CANCELADO');
      assert.equal(cancelados.rodadas[0].retirada_estado, 'RETIRADA');
      assert.equal(cancelados.rodadas[0].cancelamento_evento, null);
    } finally { await close(db); }
  });

  it('1) lista rodadas da unidade autenticada (FIFO + mesa/comanda/obs)', async () => {
    const db = await open();
    await schemaErp(db);
    const infra = await seedUnidade(db, 1, 'U-A', 12);
    const d1 = await despacharPastel(db, infra, { observacao: 'Sem cebola', chave: 'a1' });
    await despacharPastel(db, infra, { observacao: 'Bem passado', chave: 'a2' });

    const painel = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId
    }, { db });

    assert.equal(painel.success, true);
    assert.equal(painel.empresa_id, infra.empresaId);
    assert.equal(painel.unidade_id, infra.unidadeId);
    assert.ok(painel.total >= 2);
    assert.equal(painel.rodadas.length, 2);
    assert.ok(painel.rodadas[0].sequencia_global < painel.rodadas[1].sequencia_global);
    assert.equal(painel.rodadas[0].mesa_numero, '12');
    assert.equal(painel.rodadas[0].atendimento_id, infra.atendimentoId);
    assert.equal(painel.rodadas[0].itens[0].numero_comanda, d1.numeroComanda);
    assert.equal(painel.rodadas[0].itens[0].observacoes_snapshot, 'Sem cebola');
    assert.equal(painel.rodadas[0].itens[0].produto_nome_snapshot, 'Pastel Carne');
    assert.equal(painel.rodadas[0].itens[0].tipo_item, 'PASTEL');
    assert.equal(painel.rodadas[0].itens[0].estado_preparacao, 'AGUARDANDO');
    assert.equal(painel.ordenacao, 'FIFO_SEQUENCIA_GLOBAL');
    assertSemFinanceiroFiscal(painel);
    await close(db);
  });

  it('2+3) isolamento empresa e unidade', async () => {
    const db = await open();
    await schemaErp(db);
    const a = await seedUnidade(db, 1, 'U-1A', 1);
    const bEmp = await seedUnidade(db, 2, 'U-2A', 2);
    const a2 = await seedUnidade(db, 1, 'U-1B', 3);
    await despacharPastel(db, a, { chave: 'iso-a', observacao: 'A' });
    await despacharPastel(db, bEmp, { chave: 'iso-b', observacao: 'B' });
    await despacharPastel(db, a2, { chave: 'iso-a2', observacao: 'A2' });

    const painelA = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: a.empresaId,
      unidadeId: a.unidadeId
    }, { db });
    assert.equal(painelA.rodadas.length, 1);
    assert.equal(painelA.rodadas[0].itens[0].observacoes_snapshot, 'A');
    assert.equal(painelA.rodadas[0].unidade_id, a.unidadeId);

    const painelA2 = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: a2.empresaId,
      unidadeId: a2.unidadeId
    }, { db });
    assert.equal(painelA2.rodadas.length, 1);
    assert.equal(painelA2.rodadas[0].itens[0].observacoes_snapshot, 'A2');

    const painelB = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: bEmp.empresaId,
      unidadeId: bEmp.unidadeId
    }, { db });
    assert.equal(painelB.rodadas.length, 1);
    assert.equal(painelB.rodadas[0].empresa_id, 2);

    await assert.rejects(
      () => CozinhaKdsPainel.listarPainelPreparacao({
        empresaId: a.empresaId,
        unidadeId: bEmp.unidadeId
      }, { db }),
      (err) => err.codigo === 'UNIDADE_NAO_AUTORIZADA'
    );
    await close(db);
  });

  it('4+5+6) filtros AGUARDANDO / EM_PREPARACAO / PRONTO', async () => {
    const db = await open();
    await schemaErp(db);
    const infra = await seedUnidade(db, 1, 'U-F', 5);
    const d1 = await despacharPastel(db, infra, { chave: 'f1', observacao: 'aguardando' });
    const d2 = await despacharPastel(db, infra, { chave: 'f2', observacao: 'prep' });
    const d3 = await despacharPastel(db, infra, { chave: 'f3', observacao: 'pronto' });
    const pedidoId = d3.despacho.itens[0].pedido_id;
    const pedidoAntes = await get(db, `SELECT status, total FROM pedidos WHERE id=?`, [pedidoId]);
    const atendimentoAntes = await get(db, `
      SELECT estado FROM mesa_atendimentos WHERE id=?
    `, [infra.atendimentoId]);
    const filaExiste = await get(db, `
      SELECT name FROM sqlite_master WHERE type='table' AND name='equipamentos_fila'
    `);
    const filaAntes = filaExiste
      ? await get(db, `SELECT COUNT(*) AS n FROM equipamentos_fila`)
      : null;

    const item2 = d2.despacho.itens[0].id;
    const item3 = d3.despacho.itens[0].id;

    await CozinhaPreparacao.iniciarPreparacao({
      empresaId: infra.empresaId,
      operadorId: 1,
      idempotencyKey: 'ini-f2',
      itemId: item2,
      unidade_id: infra.unidadeId
    }, { db });

    await CozinhaPreparacao.iniciarPreparacao({
      empresaId: infra.empresaId,
      operadorId: 1,
      idempotencyKey: 'ini-f3',
      itemId: item3,
      unidade_id: infra.unidadeId
    }, { db });
    await CozinhaPreparacao.marcarItemPronto({
      empresaId: infra.empresaId,
      operadorId: 1,
      idempotencyKey: 'pronto-f3',
      itemId: item3,
      unidade_id: infra.unidadeId
    }, { db });

    const aguardando = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      estado_item: 'AGUARDANDO'
    }, { db });
    assert.equal(aguardando.rodadas.length, 1);
    assert.equal(aguardando.rodadas[0].itens[0].estado_preparacao, 'AGUARDANDO');
    assert.equal(aguardando.rodadas[0].itens[0].observacoes_snapshot, 'aguardando');

    const prep = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      estado_item: 'EM_PREPARACAO'
    }, { db });
    assert.equal(prep.rodadas.length, 1);
    assert.equal(prep.rodadas[0].itens[0].estado_preparacao, 'EM_PREPARACAO');
    assert.equal(prep.rodadas[0].itens[0].operador_inicio_id, 1);
    assert.ok(prep.rodadas[0].itens[0].iniciado_em);

    const pronto = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      estado_item: 'PRONTO'
    }, { db });
    assert.equal(pronto.rodadas.length, 1);
    assert.equal(pronto.rodadas[0].itens[0].estado_preparacao, 'PRONTO');
    assert.equal(pronto.rodadas[0].itens[0].operador_pronto_id, 1);
    assert.ok(pronto.rodadas[0].itens[0].pronto_em);
    assert.ok(d1.despacho.rodada && d1.despacho.rodada.id);

    assert.deepEqual(await get(db, `SELECT status, total FROM pedidos WHERE id=?`, [pedidoId]), pedidoAntes);
    assert.deepEqual(await get(db, `
      SELECT estado FROM mesa_atendimentos WHERE id=?
    `, [infra.atendimentoId]), atendimentoAntes);
    if (filaAntes) {
      const filaDepois = await get(db, `SELECT COUNT(*) AS n FROM equipamentos_fila`);
      assert.equal(filaDepois.n, filaAntes.n);
    }
    await close(db);
  });

  it('9+14) ordenação FIFO + limite/offset', async () => {
    const db = await open();
    await schemaErp(db);
    const infra = await seedUnidade(db, 1, 'U-P', 8);
    for (let i = 0; i < 5; i += 1) {
      await despacharPastel(db, infra, { chave: `p-${i}`, observacao: `ord-${i}` });
    }
    const page1 = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      limite: 2,
      offset: 0
    }, { db });
    assert.equal(page1.limite, 2);
    assert.equal(page1.offset, 0);
    assert.equal(page1.total, 5);
    assert.equal(page1.rodadas.length, 2);
    assert.equal(page1.rodadas[0].itens[0].observacoes_snapshot, 'ord-0');
    assert.equal(page1.rodadas[1].itens[0].observacoes_snapshot, 'ord-1');

    const page2 = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      limite: 2,
      offset: 2
    }, { db });
    assert.equal(page2.rodadas.length, 2);
    assert.equal(page2.rodadas[0].itens[0].observacoes_snapshot, 'ord-2');
    assert.ok(page1.rodadas[0].sequencia_global < page2.rodadas[0].sequencia_global);

    const capped = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      limite: 999
    }, { db });
    assert.equal(capped.limite, 100);
    await close(db);
  });

  it('10) unidade ausente/inválida', async () => {
    const db = await open();
    await schemaErp(db);
    await assert.rejects(
      () => CozinhaKdsPainel.listarPainelPreparacao({ empresaId: 1 }, { db }),
      (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
    );
    await assert.rejects(
      () => CozinhaKdsPainel.listarPainelPreparacao({ empresaId: 1, unidadeId: -1 }, { db }),
      (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
    );
    await close(db);
  });

  it('11) empresa ausente/inválida', async () => {
    const db = await open();
    await schemaErp(db);
    await assert.rejects(
      () => CozinhaKdsPainel.listarPainelPreparacao({ unidadeId: 1 }, { db }),
      (err) => err.codigo === 'EMPRESA_CONTEXT_REQUIRED'
    );
    await close(db);
  });
});

describe('Sprint 07 S07-0 — painel KDS (HTTP)', () => {
  let server;
  let baseUrl;
  let recursoOriginal;
  let dbHttp;
  let empresaId;
  let unidadeId;
  let unidadeOutra;
  let tokenOk;
  let tokenSemUnidade;
  let tokenOutraUnidade;
  let tokenSemEmpresa;
  let itemCozinhaHttpId;
  let rodadaHttpId;
  let pedidoHttpId;

  function requestJson(method, urlPath, { token, headers = {}, empresaHeader, body } = {}) {
    const u = new URL(urlPath, baseUrl);
    const emp = empresaHeader != null ? empresaHeader : empresaId;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...headers,
          ...(body != null ? { 'Content-Type': 'application/json' } : {}),
          ...(emp != null ? { 'X-Empresa-Id': String(emp) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch (_e) { json = { raw }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.end(body != null ? JSON.stringify(body) : undefined);
    });
  }

  before(async () => {
    dbHttp = require('../../backend/database');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DB timeout')), 60000);
      dbHttp.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    // Aguarda estabilização do init assíncrono do database.js (recriação v0→v3).
    for (let i = 0; i < 80; i += 1) {
      const row = await get(dbHttp, `
        SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_comandas'
      `);
      if (row && row.name === 'cozinha_comandas') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await garantirSchemaCozinha(dbHttp);
    marcarCozinhaOperacional(true);
    const confirm = await get(dbHttp, `
      SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_comandas'
    `);
    assert.ok(confirm, 'schema cozinha deve estar pronto antes do seed HTTP');

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    await run(dbHttp, `
      INSERT OR IGNORE INTO usuarios (id, username, password_hash, role, perfil, ativo)
      VALUES (70, 'kds_op', 'hash', 'operador', 'USUARIO', 1)
    `);
    await run(dbHttp, `
      INSERT OR IGNORE INTO usuarios (id, username, password_hash, role, perfil, ativo)
      VALUES (71, 'kds_noemp', 'hash', 'operador', 'USUARIO', 1)
    `);

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('99887766000155', 'Empresa KDS S07', 'KDS S07', 1)
    `);
    empresaId = emp.lastID;
    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo)
      VALUES (70, ?, 1)
    `, [empresaId]);

    const mesa = await run(dbHttp, `
      INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 21, 1)
    `, [empresaId]);
    const at = await run(dbHttp, `
      INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
      VALUES (?, ?, 'OCUPADA', 70)
    `, [empresaId, mesa.lastID]);
    const un = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'KDS-HTTP', 0, 1)
    `, [empresaId]);
    unidadeId = un.lastID;
    const un2 = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'KDS-HTTP-B', 0, 1)
    `, [empresaId]);
    unidadeOutra = un2.lastID;

    const cat = await run(dbHttp, `INSERT INTO categorias (nome) VALUES ('KDS-HTTP')`);
    const prod = await run(dbHttp, `
      INSERT INTO produtos (
        nome, tipo_operacional, comercializavel, categoria_id, utiliza_ficha_tecnica, preco_venda
      ) VALUES ('Pastel HTTP', 'COMERCIAL', 0, ?, 1, 0)
    `, [cat.lastID]);
    await run(dbHttp, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [prod.lastID]);

    const ped = await run(dbHttp, `
      INSERT INTO pedidos (
        codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total, data_pedido
      ) VALUES ('PHTTP', 'PEDIDO', ?, ?, ?, 10, date('now'))
    `, [empresaId, mesa.lastID, at.lastID]);
    pedidoHttpId = ped.lastID;
    const pit = await run(dbHttp, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal,
        classificacao_operacional_snapshot, produto_nome_snapshot
      ) VALUES (?, ?, 1, 9.99, 9.99, 'PASTEL', 'Pastel HTTP')
    `, [ped.lastID, prod.lastID]);
    const cmd = await run(dbHttp, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, 3, ?, 70)
    `, [empresaId, at.lastID, ped.lastID]);

    const despachoHttp = await CozinhaDespacho.despacharLote({
      empresaId,
      operadorId: 70,
      idempotencyKey: 'http-s07-0-despacho',
      unidade_id: unidadeId,
      mesa_id: mesa.lastID,
      atendimento_id: at.lastID,
      itens: [{
        pedido_id: ped.lastID,
        pedido_item_id: pit.lastID,
        comanda_id: cmd.lastID,
        qty_solicitada: 1
      }]
    }, { db: dbHttp });
    itemCozinhaHttpId = despachoHttp.itens[0].id;
    rodadaHttpId = despachoHttp.rodada.id;
    await run(dbHttp, `
      UPDATE cozinha_itens
      SET observacoes_snapshot = 'Obs HTTP'
      WHERE id = ? AND empresa_id = ?
    `, [itemCozinhaHttpId, empresaId]);

    tokenOk = jwt.sign(
      { id: 70, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: unidadeId },
      process.env.JWT_SECRET
    );
    tokenSemUnidade = jwt.sign(
      { id: 70, role: 'operador', perfil: 'USUARIO' },
      process.env.JWT_SECRET
    );
    tokenOutraUnidade = jwt.sign(
      { id: 70, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: unidadeOutra },
      process.env.JWT_SECRET
    );
    tokenSemEmpresa = jwt.sign(
      { id: 71, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: unidadeId },
      process.env.JWT_SECRET
    );

    const app = express();
    app.use(express.json());
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((r) => server.close(() => r()));
  });

  it('HTTP: lista painel da unidade autenticada', async () => {
    const r = await requestJson('GET', '/api/cozinha/preparacao/painel', { token: tokenOk });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.unidade_id, unidadeId);
    assert.equal(r.body.empresa_id, empresaId);
    assert.ok(r.body.rodadas.length >= 1);
    assert.equal(r.body.rodadas[0].itens[0].observacoes_snapshot, 'Obs HTTP');
    assert.equal(r.body.rodadas[0].itens[0].numero_comanda, 3);
    assertSemFinanceiroFiscal(r.body);
  });

  it('HTTP: retorno exige sessão e unidade autorizada e persiste no painel', async () => {
    const rota = `/api/cozinha/itens/${itemCozinhaHttpId}/aguardando`;
    const semToken = await requestJson('POST', rota, {
      body: { idempotency_key: 'http-retorno-sem-token' }
    });
    assert.equal(semToken.status, 401);
    const inicio = await requestJson('POST', `/api/cozinha/itens/${itemCozinhaHttpId}/iniciar`, {
      token: tokenOk, body: { idempotency_key: 'http-retorno-inicio' }
    });
    assert.equal(inicio.status, 200);
    const outraUnidade = await requestJson('POST', rota, {
      token: tokenOutraUnidade, body: { idempotency_key: 'http-retorno-outra-unidade' }
    });
    assert.equal(outraUnidade.status, 409);
    assert.equal(outraUnidade.body.codigo, 'UNIDADE_ISOLAMENTO');
    const retorno = await requestJson('POST', rota, {
      token: tokenOk, body: { idempotency_key: 'http-retorno' }
    });
    assert.equal(retorno.status, 200);
    assert.equal(retorno.body.item.estado_preparacao, 'AGUARDANDO');
    const painel = await requestJson('GET', '/api/cozinha/preparacao/painel', { token: tokenOk });
    const item = painel.body.rodadas.flatMap((r) => r.itens).find((i) => i.id === itemCozinhaHttpId);
    assert.equal(item.estado_preparacao, 'AGUARDANDO');
    assert.equal(item.iniciado_em, null);
  });

  it('HTTP: confirma retirada autenticada, isolada e sem duplicar evento ou impressão', async () => {
    const rota = `/api/cozinha/rodadas/${rodadaHttpId}/retirada`;
    const antesDePronta = await requestJson('POST', rota, {
      token: tokenOk,
      body: { idempotency_key: 'http-retirada-antes-pronta' }
    });
    assert.equal(antesDePronta.status, 409);
    assert.equal(antesDePronta.body.codigo, 'RODADA_NAO_PRONTA');

    const unidadeDivergente = await requestJson('POST', rota, {
      token: tokenOutraUnidade,
      body: { idempotency_key: 'http-retirada-unidade-divergente' }
    });
    assert.equal(unidadeDivergente.status, 409);
    assert.equal(unidadeDivergente.body.codigo, 'UNIDADE_ISOLAMENTO');

    const inicio = await requestJson('POST', `/api/cozinha/itens/${itemCozinhaHttpId}/iniciar`, {
      token: tokenOk,
      body: { idempotency_key: 'http-retirada-inicio' }
    });
    assert.equal(inicio.status, 200);
    const pronto = await requestJson('POST', `/api/cozinha/itens/${itemCozinhaHttpId}/pronto`, {
      token: tokenOk,
      body: { idempotency_key: 'http-retirada-pronto' }
    });
    assert.equal(pronto.status, 200);

    const filaAntes = await get(dbHttp, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila');
    const [a, b] = await Promise.all([
      requestJson('POST', rota, {
        token: tokenOk,
        body: { idempotency_key: 'http-retirada-concorrente-a' }
      }),
      requestJson('POST', rota, {
        token: tokenOk,
        body: { idempotency_key: 'http-retirada-concorrente-b' }
      })
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.success, true);
    assert.equal(b.body.success, true);
    assert.equal([a.body, b.body].filter((r) => !r.repetida).length, 1);
    const repetida = await requestJson('POST', rota, {
      token: tokenOk,
      body: { idempotency_key: 'http-retirada-concorrente-a' }
    });
    assert.equal(repetida.status, 200);
    assert.equal(repetida.body.repetida, true);

    const eventos = await get(dbHttp, `
      SELECT COUNT(*) AS n FROM cozinha_eventos_outbox
      WHERE tipo='RETIRADA_CONFIRMADA'
        AND CAST(json_extract(payload_json, '$.rodada.id') AS INTEGER)=?
    `, [rodadaHttpId]);
    assert.equal(eventos.n, 1);
    const comercial = await get(dbHttp, `
      SELECT p.status, ma.estado AS atendimento_estado
      FROM pedidos p
      JOIN mesa_atendimentos ma ON ma.id=p.mesa_atendimento_id
      WHERE p.id=?
    `, [pedidoHttpId]);
    assert.equal(comercial.status, 'PEDIDO');
    assert.equal(comercial.atendimento_estado, 'OCUPADA');
    const filaDepois = await get(dbHttp, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila');
    assert.equal(filaDepois.n, filaAntes.n);
  });

  it('HTTP: cancelamentos e históricos são separados e isolados por unidade', async () => {
    await run(dbHttp, 'ALTER TABLE pedidos_itens ADD COLUMN observacao TEXT');
    const origem = await get(dbHttp, `
      SELECT r.mesa_id, r.atendimento_id, i.produto_id
      FROM cozinha_itens i JOIN cozinha_rodadas r ON r.id=i.rodada_id
      WHERE i.id=?
    `, [itemCozinhaHttpId]);
    const infra = {
      empresaId, unidadeId, mesaId: origem.mesa_id, atendimentoId: origem.atendimento_id,
      prodPastelId: origem.produto_id
    };
    const itemTeste = await despacharPastel(dbHttp, infra, { chave: 'http-g1-item', numeroComanda: 9971 });
    const rodadaTeste = await despacharPastel(dbHttp, infra, { chave: 'http-g1-rodada', numeroComanda: 9972 });
    const idItem = itemTeste.despacho.itens[0].id;
    const idRodada = rodadaTeste.despacho.rodada.id;
    const filaAntes = await get(dbHttp, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila');
    const rotaItem = `/api/cozinha/itens/${idItem}/cancelar`;
    const outra = await requestJson('POST', rotaItem, {
      token: tokenOutraUnidade, body: { idempotency_key: 'g1-outra', motivo: 'FALTA_PRODUTO' }
    });
    assert.equal(outra.status, 409);
    const justificativaInvalida = await requestJson('POST', rotaItem, {
      token: tokenOk, body: { idempotency_key: 'g1-sem-justificativa', motivo: 'OUTRO', justificativa: '  ' }
    });
    assert.equal(justificativaInvalida.status, 400);
    const cancelado = await requestJson('POST', rotaItem, {
      token: tokenOk, body: { idempotency_key: 'g1-cancelar-item', motivo: 'OUTRO', justificativa: 'Teste operacional' }
    });
    assert.equal(cancelado.status, 200);
    assert.equal(cancelado.body.item.estado_preparacao, 'CANCELADO');
    assert.equal(cancelado.body.rodada.estado_preparacao, 'CANCELADA');
    const repetido = await requestJson('POST', rotaItem, {
      token: tokenOk, body: { idempotency_key: 'g1-cancelar-item', motivo: 'OUTRO', justificativa: 'Teste operacional' }
    });
    assert.equal(repetido.body.repetida, true);
    const cancelamentoRodada = await requestJson('POST', `/api/cozinha/rodadas/${idRodada}/cancelar`, {
      token: tokenOk, body: { idempotency_key: 'g1-cancelar-rodada', motivo: 'FALTA_PRODUTO' }
    });
    assert.equal(cancelamentoRodada.status, 200);
    const painel = await requestJson('GET', '/api/cozinha/preparacao/painel?historicos=1&limite=100', { token: tokenOk });
    assert.equal(painel.status, 200);
    assert.ok(painel.body.historico_retirados.rodadas.some((r) => r.id === rodadaHttpId));
    const registro = painel.body.historico_cancelados.rodadas.flatMap((r) => r.itens).find((i) => i.id === idItem);
    assert.equal(registro.cancelamento_justificativa, 'Teste operacional');
    assert.equal(registro.estado_anterior, 'AGUARDANDO');
    assert.equal(registro.cancelamento_por, 70);
    assert.ok(!painel.body.rodadas.some((r) => r.id === idRodada));
    const painelCursor = await requestJson('GET',
      '/api/cozinha/preparacao/painel?historicos=1&paginacao=cursor&limite=100', { token: tokenOk });
    assert.equal(painelCursor.status, 200);
    const rodadaCancelada = painelCursor.body.historico_cancelados.rodadas.find((r) => r.id === idRodada);
    assert.ok(rodadaCancelada);
    assert.equal(rodadaCancelada.cancelamento_evento.motivo, 'FALTA_PRODUTO');
    assert.ok(rodadaCancelada.itens.some((item) => item.estado_preparacao === 'CANCELADO'));
    const pagina1 = await requestJson('GET', '/api/cozinha/preparacao/painel?historico=cancelados&limite=1&offset=0', { token: tokenOk });
    const pagina2 = await requestJson('GET', '/api/cozinha/preparacao/painel?historico=cancelados&limite=1&offset=1', { token: tokenOk });
    assert.equal(pagina1.body.total, 2);
    assert.notEqual(pagina1.body.rodadas[0].id, pagina2.body.rodadas[0].id);
    const cursor1 = await requestJson('GET', '/api/cozinha/preparacao/painel?historico=cancelados&paginacao=cursor&limite=1', { token: tokenOk });
    const cursor2 = await requestJson('GET', `/api/cozinha/preparacao/painel?historico=cancelados&paginacao=cursor&limite=1&cursor=${encodeURIComponent(cursor1.body.cursor_proximo)}`, { token: tokenOk });
    assert.equal(cursor1.status, 200);
    assert.equal(cursor2.status, 200);
    assert.notEqual(cursor1.body.rodadas[0].id, cursor2.body.rodadas[0].id);
    assert.equal(cursor2.body.cursor_proximo, null);
    const outroPainel = await requestJson('GET', '/api/cozinha/preparacao/painel?historicos=1', { token: tokenOutraUnidade });
    assert.equal(outroPainel.body.historico_cancelados.total, 0);
    assert.equal(outroPainel.body.historico_retirados.total, 0);
    await run(dbHttp, "DELETE FROM cozinha_eventos_outbox WHERE idempotency_key='g1-cancelar-rodada:RODADA_CANCELADA'");
    const legadoHttp = await requestJson('GET', '/api/cozinha/preparacao/painel?historico=legado&limite=1', { token: tokenOk });
    assert.equal(legadoHttp.status, 200);
    assert.equal(legadoHttp.body.registros[0].id, idRodada);
    const legadoOutraUnidade = await requestJson('GET', '/api/cozinha/preparacao/painel?historico=legado', { token: tokenOutraUnidade });
    assert.deepEqual(legadoOutraUnidade.body.registros, []);
    const legadoEmpresaDivergente = await requestJson('GET',
      '/api/cozinha/preparacao/painel?historico=legado&empresa_id=999999', { token: tokenOk });
    assert.equal(legadoEmpresaDivergente.status, 409);
    const legadoSemToken = await requestJson('GET', '/api/cozinha/preparacao/painel?historico=legado');
    assert.equal(legadoSemToken.status, 401);
    assert.deepEqual(await get(dbHttp, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila'), filaAntes);
    assert.equal((await get(dbHttp, 'SELECT status FROM pedidos WHERE id=?', [itemTeste.despacho.itens[0].pedido_id])).status, 'PEDIDO');
    assert.equal((await get(dbHttp, 'SELECT estado FROM mesa_atendimentos WHERE id=?', [origem.atendimento_id])).estado, 'OCUPADA');
  });

  it('HTTP: unidade ausente na sessão', async () => {
    const r = await requestJson('GET', '/api/cozinha/preparacao/painel', { token: tokenSemUnidade });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'UNIDADE_OBRIGATORIA');
  });

  it('12) HTTP: unidade divergente / não enxerga dados da outra unidade', async () => {
    const rDiv = await requestJson(
      'GET',
      `/api/cozinha/preparacao/painel?unidade_id=${unidadeId}`,
      { token: tokenOutraUnidade }
    );
    assert.equal(rDiv.status, 409);
    assert.equal(rDiv.body.codigo, 'UNIDADE_ISOLAMENTO');

    const rOkOutra = await requestJson('GET', '/api/cozinha/preparacao/painel', {
      token: tokenOutraUnidade
    });
    assert.equal(rOkOutra.status, 200);
    assert.equal(rOkOutra.body.unidade_id, unidadeOutra);
    assert.equal(rOkOutra.body.rodadas.length, 0);
  });

  it('HTTP: empresa_id do cliente divergente recusada', async () => {
    const r = await requestJson(
      'GET',
      '/api/cozinha/preparacao/painel?empresa_id=999999',
      { token: tokenOk }
    );
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'EMPRESA_ISOLAMENTO');
  });

  it('HTTP: operador sem vínculo de empresa', async () => {
    const r = await requestJson('GET', '/api/cozinha/preparacao/painel', {
      token: tokenSemEmpresa,
      empresaHeader: empresaId
    });
    assert.ok(r.status === 400 || r.status === 403 || r.status === 401);
  });

  it('HTTP: filtro estado_item=AGUARDANDO', async () => {
    const r = await requestJson(
      'GET',
      '/api/cozinha/preparacao/painel?estado_item=AGUARDANDO&limite=10',
      { token: tokenOk }
    );
    assert.equal(r.status, 200);
    assert.ok(r.body.rodadas.every((rod) =>
      rod.itens.every((it) => it.estado_preparacao === 'AGUARDANDO')));
  });
});
