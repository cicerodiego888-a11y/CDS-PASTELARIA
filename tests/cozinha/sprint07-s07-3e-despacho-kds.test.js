/**
 * Sprint 07 · S07-3E — Despacho controlado pedido → KDS.
 * Banco temporário. Sem migration no oficial. Sem alterar S06 / iFood / PDV.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-3e-despacho-kds.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { describe, it, after, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-3e-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-3e';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional
} = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaCozinhaCanais } = require('../../backend/services/cozinha/cozinhaCanaisSchema');
const { garantirSchemaCozinhaRoteamento } = require('../../backend/services/cozinha/cozinhaRoteamentoSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const { garantirSchemaDestinoCozinhaPedidos } = require('../../backend/utils/pedidosDestinoCozinhaSchema');
const { garantirSchemaOrigemPedidos } = require('../../backend/utils/pedidosOrigemSchema');
const {
  garantirSchemaDespachoPedidoCozinha
} = require('../../backend/utils/pedidosDespachoCozinhaSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const Canais = require('../../backend/services/cozinha/CozinhaCanaisService');
const Resolucao = require('../../backend/services/cozinha/CozinhaResolucaoDestinoService');
const DespachoPedido = require('../../backend/services/cozinha/CozinhaDespachoPedidoService');
const CozinhaKdsPainel = require('../../backend/services/cozinha/CozinhaKdsPainelService');
const repo = require('../../backend/services/pedido/PedidoRepository');
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
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (e) => (e ? reject(e) : resolve(db)));
      });
    });
  });
}
function openTempFile() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(dbDir, 's07-3e-http.sqlite'), (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (busyErr) => (busyErr ? reject(busyErr) : resolve(db)));
      });
    });
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function prepararBase(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'operador',
      perfil TEXT DEFAULT 'USUARIO',
      ativo INTEGER DEFAULT 1,
      nome TEXT
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
      cliente_id INTEGER,
      operador_abertura_id INTEGER NOT NULL DEFAULT 1,
      aberto_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      idempotency_key TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      nome TEXT NOT NULL
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      nome_comercial TEXT,
      codigo TEXT,
      preco_venda REAL NOT NULL DEFAULT 10,
      preco_pedido REAL,
      saldo_fiscal REAL DEFAULT 50,
      saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      estoque_atual REAL DEFAULT 50,
      unidade TEXT,
      unidade_estoque TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      tipo_operacional TEXT DEFAULT 'COMERCIAL',
      utiliza_ficha_tecnica INTEGER DEFAULT 1,
      permite_personalizacao_ingredientes INTEGER DEFAULT 0,
      comercializavel INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      data_pedido TEXT DEFAULT '2026-11-18',
      cliente_id INTEGER,
      cliente_nome TEXT,
      total REAL DEFAULT 0,
      desconto REAL DEFAULT 0,
      frete REAL DEFAULT 0,
      status TEXT DEFAULT 'PEDIDO',
      representante_id INTEGER,
      representante_nome TEXT,
      observacao TEXT,
      empresa_id INTEGER,
      operador_id INTEGER,
      venda_id INTEGER,
      mesa_id INTEGER,
      mesa_atendimento_id INTEGER,
      origem_canal TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER,
      quantidade REAL,
      preco_unitario REAL,
      desconto_percentual REAL DEFAULT 0,
      subtotal REAL,
      tipo_venda TEXT DEFAULT 'PESO',
      produto_nome_snapshot TEXT,
      classificacao_operacional_snapshot TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      insumo_id INTEGER,
      insumo_nome_snapshot TEXT NOT NULL,
      quantidade_snapshot REAL NOT NULL,
      unidade_snapshot TEXT NOT NULL,
      classificacao_comercial_snapshot TEXT NOT NULL,
      selecionado INTEGER NOT NULL,
      preco_adicional_snapshot REAL DEFAULT 0
    )
  `);

  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaCozinha(db);
  await garantirSchemaCozinhaCanais(db);
  await garantirSchemaCozinhaRoteamento(db);
  await garantirSchemaOrigemPedidos(db);
  await garantirSchemaDestinoCozinhaPedidos(db);
  await garantirSchemaDespachoPedidoCozinha(db);
  await garantirSchemaMesas(db);
  await new Promise((resolve, reject) => {
    const sql = fs.readFileSync(path.join(__dirname, '../../backend/migrations/s07-comanda-impressao.sql'), 'utf8');
    db.exec(sql, (err) => err ? reject(err) : resolve());
  });
  marcarCozinhaOperacional(true);

  const emp1 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11111111000111', 'Empresa 1', 'E1', 1)
  `);
  const emp2 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('22222222000122', 'Empresa 2', 'E2', 1)
  `);
  const admin = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('admin_r3e', 'hash', 'admin', 'ADMIN', 1, 'Admin')
  `);
  const op = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('op_r3e', 'hash', 'operador', 'USUARIO', 1, 'Op')
  `);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [admin.lastID, emp1.lastID]);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [op.lastID, emp1.lastID]);

  const unA = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual) VALUES (?, 'COZ-A', 1, 0)`, [emp1.lastID]);
  const unB = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual) VALUES (?, 'COZ-B', 1, 0)`, [emp1.lastID]);
  const unOff = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual) VALUES (?, 'COZ-OFF', 0, 0)`, [emp1.lastID]);
  const unOutra = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual) VALUES (?, 'COZ-X', 1, 0)`, [emp2.lastID]);

  const mesa = await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 7, 1)`, [emp1.lastID]);
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
    VALUES (?, ?, 'OCUPADA', ?)
  `, [emp1.lastID, mesa.lastID, op.lastID]);

  const produtoData = {
    nome: 'Pastel carne',
    nome_comercial: 'Pastel carne',
    preco_venda: 10,
    preco_pedido: 10,
    unidade: 'UN',
    unidade_estoque: 'UN',
    ativo: 1,
    tipo_operacional: 'COMERCIAL',
    utiliza_ficha_tecnica: 0,
    comercializavel: 1
  };
  const colunasProduto = new Set((await all(db, 'PRAGMA table_info(produtos)')).map((c) => c.name));
  const camposProduto = Object.keys(produtoData).filter((campo) => colunasProduto.has(campo));
  const prod = await run(db, `
    INSERT INTO produtos (${camposProduto.join(', ')})
    VALUES (${camposProduto.map(() => '?').join(', ')})
  `, camposProduto.map((campo) => produtoData[campo]));

  return {
    emp1: emp1.lastID,
    emp2: emp2.lastID,
    adminId: admin.lastID,
    opId: op.lastID,
    unA: unA.lastID,
    unB: unB.lastID,
    unOff: unOff.lastID,
    unOutra: unOutra.lastID,
    mesaId: mesa.lastID,
    atendimentoId: at.lastID,
    produtoId: prod.lastID
  };
}

function userAdmin(ctx) {
  return { id: ctx.adminId, username: 'admin_r3e', role: 'admin', perfil: 'ADMIN', permissoes: [] };
}

async function configurarLoja(db, ctx, unidadeId) {
  await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
  const lista = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
  const loja = lista.canais.find((c) => c.codigo === 'LOJA');
  await Canais.definirDestinoCanal({
    user: userAdmin(ctx),
    empresaId: ctx.emp1,
    canalIdRaw: loja.id,
    unidadeIdRaw: unidadeId
  }, { db });
  return loja;
}

async function criarPedidoResolvido(db, ctx, {
  unidadeId = ctx.unA,
  resolvido = true,
  mesa = true,
  unidadeDestinoOverride = null,
  statusPedido = 'PEDIDO'
} = {}) {
  if (resolvido) await configurarLoja(db, ctx, unidadeId);

  const ped = await run(db, `
    INSERT INTO pedidos (
      codigo, data_pedido, total, status, empresa_id, operador_id,
      mesa_id, mesa_atendimento_id, origem_canal
    ) VALUES ('PED-3E', date('now'), 20, ?, ?, ?, ?, ?, 'EQUIPE')
  `, [
    statusPedido,
    ctx.emp1,
    ctx.opId,
    mesa ? ctx.mesaId : null,
    mesa ? ctx.atendimentoId : null
  ]);
  const pedidoId = ped.lastID;
  await run(db, `
    INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, subtotal,
      produto_nome_snapshot, classificacao_operacional_snapshot
    ) VALUES (?, ?, 2, 10, 20, 'Pastel carne', 'COMERCIAL')
  `, [pedidoId, ctx.produtoId]);

  if (resolvido) {
    const resolucao = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'EQUIPE'
    }, { db });
    assert.equal(resolucao.status, 'RESOLVIDO');
    await repo.persistirResolucaoDestinoCozinha(pedidoId, ctx.emp1, resolucao, { db });
    if (unidadeDestinoOverride != null) {
      await run(db, `
        UPDATE pedidos SET unidade_cozinha_destino_id = ? WHERE id = ?
      `, [unidadeDestinoOverride, pedidoId]);
    }
  } else {
    await run(db, `
      UPDATE pedidos
      SET cozinha_resolucao_status = 'DESTINO_NAO_CONFIGURADO',
          cozinha_canal_codigo = 'LOJA',
          unidade_cozinha_destino_id = NULL
      WHERE id = ?
    `, [pedidoId]);
  }

  return pedidoId;
}

describe('S07-3E — isolamento', () => {
  it('DB_DIR temporário e flags oficiais', () => {
    assert.ok(String(process.env.DB_DIR).includes('cds-cozinha-s07-3e-'));
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB, undefined);
  });
});

describe('S07-3E — despacho controlado', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('bloqueia despacho explicitamente se a migration da comanda estiver ausente', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx);
    await run(db, 'DROP TRIGGER cozinha_comanda_snapshot_liberar', []);
    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });
    assert.equal(out.status, 'BLOQUEADO');
    assert.equal(out.codigo, 'SCHEMA_COMANDA_INDISPONIVEL');
    assert.equal((await all(db, 'SELECT id FROM cozinha_rodadas', [])).length, 0);
    await close(db);
  });

  it('snapshot aguarda confirmação S07-3E antes de ficar disponível', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx);
    const item = await get(db, 'SELECT id FROM pedidos_itens WHERE pedido_id = ?', [pedidoId]);
    const comanda = await run(db, `
      INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, pedido_id)
      VALUES (?, ?, 1, ?)
    `, [ctx.emp1, ctx.atendimentoId, pedidoId]);
    const chave = 'snapshot-aguardando';
    await run(db, `
      INSERT INTO cozinha_pedido_despachos (empresa_id, pedido_id, unidade_id, status, idempotency_key)
      VALUES (?, ?, ?, 'EM_ANDAMENTO', ?)
    `, [ctx.emp1, pedidoId, ctx.unA, chave]);
    const rodada = await CozinhaDespacho.despacharLote({
      empresaId: ctx.emp1, operadorId: ctx.opId, idempotencyKey: chave,
      unidade_id: ctx.unA, mesa_id: ctx.mesaId, atendimento_id: ctx.atendimentoId,
      itens: [{ pedido_id: pedidoId, pedido_item_id: item.id, comanda_id: comanda.lastID, quantidade: 2 }]
    }, { db, omitirEnfileiramentoImpressao: true, pedidoSnapshotComandaId: pedidoId });
    const snapshot = await get(db, 'SELECT * FROM cozinha_comanda_snapshots WHERE pedido_id = ?', [pedidoId]);
    assert.equal(snapshot.disponibilidade, 'AGUARDANDO_DESPACHO');
    const servico = require('../../backend/services/cozinha/CozinhaComandaSnapshotService');
    await assert.rejects(servico.obter(db, ctx.emp1, ctx.unA, snapshot.id), /indisponível/);
    await run(db, `
      UPDATE cozinha_pedido_despachos SET status = 'CONCLUIDO', rodada_id = ? WHERE pedido_id = ?
    `, [rodada.rodada.id, pedidoId]);
    assert.equal((await servico.obter(db, ctx.emp1, ctx.unA, snapshot.id)).id, snapshot.id);
    await close(db);
  });

  it('snapshot imutável acompanha a rodada, preserva dados e não duplica no reprocessamento', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx);
    const entrada = { empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId };
    const out = await DespachoPedido.despacharPedidoResolvido(entrada, { db });
    assert.equal(out.status, 'CONCLUIDO');
    const snapshot = await get(db, 'SELECT * FROM cozinha_comanda_snapshots WHERE rodada_id = ?', [out.rodada_id]);
    assert.equal(snapshot.disponibilidade, 'DISPONIVEL');
    const original = JSON.parse(snapshot.conteudo_json);
    assert.equal(original.mesa_numero, 7);
    assert.equal(original.garcom, 'Op');
    assert.equal(original.itens.length, 1);
    assert.equal(original.itens[0].qty_solicitada_millis, 2000);
    await run(db, 'UPDATE mesas SET numero = 88 WHERE id = ?', [ctx.mesaId]);
    await run(db, "UPDATE usuarios SET nome = 'Outro' WHERE id = ?", [ctx.opId]);
    await assert.rejects(run(db, "UPDATE cozinha_comanda_snapshots SET conteudo_json = '{}' WHERE id = ?", [snapshot.id]), /imutavel/);
    const repetido = await DespachoPedido.despacharPedidoResolvido(entrada, { db });
    assert.equal(repetido.repetida, true);
    const registros = await all(db, 'SELECT * FROM cozinha_comanda_snapshots WHERE pedido_id = ?', [pedidoId]);
    assert.equal(registros.length, 1);
    assert.equal(registros[0].conteudo_json, snapshot.conteudo_json);
    const sql = fs.readFileSync(path.join(__dirname, '../../backend/migrations/s07-comanda-impressao.sql'), 'utf8');
    await new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
    assert.equal((await get(db, 'SELECT conteudo_json FROM cozinha_comanda_snapshots WHERE id = ?', [snapshot.id])).conteudo_json, snapshot.conteudo_json);
    assert.equal((await all(db, 'PRAGMA foreign_key_check(cozinha_comanda_snapshots)', [])).length, 0);
    await assert.rejects(run(db, `
      INSERT INTO cozinha_comanda_tentativas (snapshot_id, empresa_id, unidade_id, operador_id)
      VALUES (?, ?, ?, ?)
    `, [snapshot.id, ctx.emp2, ctx.unOutra, ctx.opId]), /FOREIGN KEY/);
    await close(db);
  });

  it('congela ingredientes personalizados e sinaliza composição sem evidência confiável', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await run(db, 'ALTER TABLE pedidos_itens ADD COLUMN personalizacao_ingredientes_snapshot INTEGER DEFAULT 0');
    await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [ctx.produtoId]);
    const pedidoId = await criarPedidoResolvido(db, ctx);
    const item = await get(db, 'SELECT id FROM pedidos_itens WHERE pedido_id = ?', [pedidoId]);
    await run(db, 'UPDATE pedidos_itens SET personalizacao_ingredientes_snapshot = 1 WHERE id = ?', [item.id]);
    for (const [insumoId, nome, classificacao, selecionado] of [
      [1, 'Massa', 'OBRIGATORIO_OCULTO', 1],
      [2, 'Queijo', 'OPCIONAL_COM_ADICIONAL', 1],
      [3, 'Cebola', 'OPCIONAL', 0]
    ]) {
      await run(db, `INSERT INTO pedido_item_ingredientes
        (pedido_id, pedido_item_id, empresa_id, insumo_id, insumo_nome_snapshot, quantidade_snapshot,
         unidade_snapshot, classificacao_comercial_snapshot, selecionado)
        VALUES (?, ?, ?, ?, ?, 0.1, 'kg', ?, ?)`,
      [pedidoId, item.id, ctx.emp1, insumoId, nome, classificacao, selecionado]);
    }
    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });
    assert.equal(out.status, 'CONCLUIDO');
    const snapshot = await get(db, 'SELECT conteudo_json FROM cozinha_comanda_snapshots WHERE rodada_id = ?', [out.rodada_id]);
    const congelado = JSON.parse(snapshot.conteudo_json).itens[0];
    assert.equal(congelado.tipo_item, 'PASTEL');
    assert.equal(congelado.composicao_confiavel, true);
    assert.deepEqual(congelado.ingredientes.map((ing) => [ing.nome, ing.selecionado]),
      [['Massa', 1], ['Queijo', 1], ['Cebola', 0]]);
    await run(db, "UPDATE pedido_item_ingredientes SET insumo_nome_snapshot = 'Alterado' WHERE pedido_item_id = ?", [item.id]);
    assert.equal((await get(db, 'SELECT conteudo_json FROM cozinha_comanda_snapshots WHERE rodada_id = ?', [out.rodada_id])).conteudo_json, snapshot.conteudo_json);

    const outro = await criarPedidoResolvido(db, ctx);
    const itemOutro = await get(db, 'SELECT id FROM pedidos_itens WHERE pedido_id = ?', [outro]);
    await run(db, 'UPDATE pedidos_itens SET personalizacao_ingredientes_snapshot = 1 WHERE id = ?', [itemOutro.id]);
    await run(db, `INSERT INTO pedido_item_ingredientes
      (pedido_id, pedido_item_id, empresa_id, insumo_id, insumo_nome_snapshot, quantidade_snapshot,
       unidade_snapshot, classificacao_comercial_snapshot, selecionado)
      VALUES (?, ?, ?, 1, 'Massa', 0.1, 'kg', 'OBRIGATORIO_OCULTO', 0)`,
    [outro, itemOutro.id, ctx.emp1]);
    await run(db, `INSERT INTO pedido_item_ingredientes
      (pedido_id, pedido_item_id, empresa_id, insumo_id, insumo_nome_snapshot, quantidade_snapshot,
       unidade_snapshot, classificacao_comercial_snapshot, selecionado)
      VALUES (?, ?, ?, 2, 'Queijo', 0.1, 'kg', 'OPCIONAL', 1)`,
    [outro, itemOutro.id, ctx.emp1]);
    const resultado = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId: outro, operadorId: ctx.opId
    }, { db });
    const incompleto = JSON.parse((await get(db, 'SELECT conteudo_json FROM cozinha_comanda_snapshots WHERE rodada_id = ?', [resultado.rodada_id])).conteudo_json).itens[0];
    assert.equal(incompleto.composicao_confiavel, false);
    assert.deepEqual(incompleto.ingredientes, []);
    await close(db);
  });

  it('rollback após snapshot desfaz rodada e snapshot, e mantém despacho sem conclusão', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx);
    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db, simularFalhaAposSnapshot: true });
    assert.equal(out.status, 'FALHA');
    assert.equal((await all(db, 'SELECT id FROM cozinha_rodadas', [])).length, 0);
    assert.equal((await all(db, 'SELECT id FROM cozinha_comanda_snapshots', [])).length, 0);
    await close(db);
  });

  it('disponibilidade exige despacho correspondente e pedido adicional contém apenas seus itens', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const primeiro = await criarPedidoResolvido(db, ctx);
    const a = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId: primeiro, operadorId: ctx.opId
    }, { db });
    const segundo = await criarPedidoResolvido(db, ctx);
    await run(db, "UPDATE pedidos_itens SET produto_nome_snapshot = 'Pastel adicional' WHERE pedido_id = ?", [segundo]);
    const b = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId: segundo, operadorId: ctx.opId
    }, { db });
    assert.equal(b.status, 'CONCLUIDO');
    const adicional = await get(db, 'SELECT * FROM cozinha_comanda_snapshots WHERE rodada_id = ?', [b.rodada_id]);
    const itens = JSON.parse(adicional.conteudo_json).itens;
    assert.equal(itens.length, 1);
    assert.equal(itens[0].nome, 'Pastel adicional');
    assert.notEqual(a.rodada_id, b.rodada_id);
    const servico = require('../../backend/services/cozinha/CozinhaComandaSnapshotService');
    await assert.rejects(servico.obter(db, ctx.emp2, ctx.unA, adicional.id), /indisponível/);
    await assert.rejects(servico.obter(db, ctx.emp1, ctx.unB, adicional.id), /indisponível/);
    await run(db, "UPDATE cozinha_pedido_despachos SET status = 'FALHA' WHERE pedido_id = ?", [segundo]);
    await assert.rejects(servico.obter(db, ctx.emp1, ctx.unA, adicional.id), /indisponível/);
    await close(db);
  });

  it('1) RESOLVIDO despacha para a unidade correta', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, { unidadeId: ctx.unA });

    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1,
      pedidoId,
      operadorId: ctx.opId,
      bodyEmpresaIdIgnored: ctx.emp2,
      unidadeDestinoArbitrariaIgnored: ctx.unB
    }, { db });

    assert.equal(out.success, true);
    assert.equal(out.status, 'CONCLUIDO');
    assert.equal(out.unidade_id, ctx.unA);
    assert.ok(out.rodada_id);

    const rodada = await get(db, `SELECT * FROM cozinha_rodadas WHERE id = ?`, [out.rodada_id]);
    assert.equal(Number(rodada.unidade_id), ctx.unA);
    assert.equal(Number(rodada.empresa_id), ctx.emp1);

    const itens = await all(db, `SELECT * FROM cozinha_itens WHERE pedido_id = ?`, [pedidoId]);
    assert.equal(itens.length, 1);
    assert.equal(Number(itens[0].unidade_id), ctx.unA);

    const ped = await get(db, `
      SELECT cozinha_despacho_status, cozinha_despacho_rodada_id, total, origem_canal
      FROM pedidos WHERE id = ?
    `, [pedidoId]);
    assert.equal(ped.cozinha_despacho_status, 'CONCLUIDO');
    assert.equal(Number(ped.cozinha_despacho_rodada_id), out.rodada_id);
    assert.equal(Number(ped.total), 20);
    assert.equal(ped.origem_canal, 'EQUIPE');
    await close(db);
  });

  it('2) sem resolução não despacha', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, { resolvido: false });

    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });

    assert.equal(out.success, false);
    assert.equal(out.bloqueado, true);
    assert.equal(out.codigo, DespachoPedido.CODIGOS.RESOLUCAO_OBRIGATORIA);
    const n = await get(db, `SELECT COUNT(*) AS n FROM cozinha_itens WHERE pedido_id = ?`, [pedidoId]);
    assert.equal(Number(n.n), 0);
    await close(db);
  });

  it('3) destino inválido bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, {
      unidadeId: ctx.unA,
      unidadeDestinoOverride: 999999
    });

    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });

    assert.equal(out.success, false);
    assert.equal(out.bloqueado, true);
    assert.ok(
      out.codigo === DespachoPedido.CODIGOS.DESTINO_INVALIDO
      || out.codigo === 'UNIDADE_NAO_ENCONTRADA'
    );
    await close(db);
  });

  it('4) unidade inativa bloqueada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    // força destino inativo sem passar por definirDestinoCanal (que exige ativa)
    await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    const lista = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    const loja = lista.canais.find((c) => c.codigo === 'LOJA');
    await run(db, 'PRAGMA foreign_keys = OFF');
    await run(db, `
      INSERT INTO cozinha_canal_destinos (empresa_id, canal_id, unidade_cozinha_id)
      VALUES (?, ?, ?)
    `, [ctx.emp1, loja.id, ctx.unOff]);
    await run(db, 'PRAGMA foreign_keys = ON');

    const ped = await run(db, `
      INSERT INTO pedidos (
        codigo, total, status, empresa_id, operador_id, mesa_id, mesa_atendimento_id,
        origem_canal, cozinha_canal_codigo, unidade_cozinha_destino_id, cozinha_resolucao_status
      ) VALUES ('P', 10, 'PEDIDO', ?, ?, ?, ?, 'EQUIPE', 'LOJA', ?, 'RESOLVIDO')
    `, [ctx.emp1, ctx.opId, ctx.mesaId, ctx.atendimentoId, ctx.unOff]);
    await run(db, `
      INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (?, ?, 1, 10, 10)
    `, [ped.lastID, ctx.produtoId]);

    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId: ped.lastID, operadorId: ctx.opId
    }, { db });

    assert.equal(out.success, false);
    assert.equal(out.codigo, DespachoPedido.CODIGOS.UNIDADE_INATIVA);
    await close(db);
  });

  it('5) unidade de outra empresa bloqueada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, {
      unidadeId: ctx.unA,
      unidadeDestinoOverride: ctx.unOutra
    });

    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });

    assert.equal(out.success, false);
    assert.equal(out.codigo, DespachoPedido.CODIGOS.UNIDADE_EMPRESA);
    await close(db);
  });

  it('6 e 7) empresa/destino do frontend ignorados', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, { unidadeId: ctx.unA });

    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1,
      pedidoId,
      operadorId: ctx.opId,
      bodyEmpresaIdIgnored: ctx.emp2,
      unidadeDestinoArbitrariaIgnored: ctx.unB,
      destinoArbitrarioIgnored: { unidade_id: ctx.unB }
    }, { db });

    assert.equal(out.success, true);
    assert.equal(out.unidade_id, ctx.unA);
    assert.notEqual(out.unidade_id, ctx.unB);
    await close(db);
  });

  it('8) requisição repetida não duplica', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, { unidadeId: ctx.unA });

    const a = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });
    const b = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });

    assert.equal(a.success, true);
    assert.equal(b.success, true);
    assert.equal(b.repetida, true);
    assert.equal(a.rodada_id, b.rodada_id);

    const nRod = await get(db, `SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE empresa_id = ?`, [ctx.emp1]);
    const nItens = await get(db, `SELECT COUNT(*) AS n FROM cozinha_itens WHERE pedido_id = ?`, [pedidoId]);
    assert.equal(Number(nRod.n), 1);
    assert.equal(Number(nItens.n), 1);
    await close(db);
  });

  it('9) chamadas concorrentes não duplicam', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, { unidadeId: ctx.unA });

    const resultados = await Promise.all([
      DespachoPedido.despacharPedidoResolvido({
        empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
      }, { db }),
      DespachoPedido.despacharPedidoResolvido({
        empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
      }, { db })
    ]);

    const ok = resultados.filter((r) => r.success);
    assert.ok(ok.length >= 1);
    const nRod = await get(db, `SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE empresa_id = ?`, [ctx.emp1]);
    const nItens = await get(db, `SELECT COUNT(*) AS n FROM cozinha_itens WHERE pedido_id = ?`, [pedidoId]);
    assert.equal(Number(nRod.n), 1);
    assert.equal(Number(nItens.n), 1);
    const nSnapshots = await get(db, 'SELECT COUNT(*) AS n FROM cozinha_comanda_snapshots WHERE pedido_id = ?', [pedidoId]);
    assert.equal(Number(nSnapshots.n), 1);

    const ctrl = await get(db, `
      SELECT status FROM cozinha_pedido_despachos WHERE empresa_id = ? AND pedido_id = ?
    `, [ctx.emp1, pedidoId]);
    assert.equal(ctrl.status, 'CONCLUIDO');
    await close(db);
  });

  it('10 e 11) falha real após claim preserva pedido e permite retry sem duplicação', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, { unidadeId: ctx.unA });
    await run(db, `
      CREATE TRIGGER falha_rodada_s07_3e
      BEFORE INSERT ON cozinha_rodadas
      BEGIN
        SELECT RAISE(ABORT, 'falha real pós-claim');
      END
    `);

    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });

    assert.equal(out.success, false);
    assert.equal(out.status, 'FALHA');
    assert.match(out.mensagem, /falha real pós-claim/);

    const ped = await get(db, `
      SELECT id, total, status, cozinha_despacho_status FROM pedidos WHERE id = ?
    `, [pedidoId]);
    assert.equal(Number(ped.id), pedidoId);
    assert.equal(Number(ped.total), 20);
    assert.equal(ped.status, 'PEDIDO');
    assert.notEqual(ped.cozinha_despacho_status, 'CONCLUIDO');

    const ctrl = await get(db, `
      SELECT status FROM cozinha_pedido_despachos WHERE empresa_id = ? AND pedido_id = ?
    `, [ctx.emp1, pedidoId]);
    assert.equal(ctrl.status, 'FALHA');

    await run(db, 'DROP TRIGGER falha_rodada_s07_3e');
    const chave = DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId);
    const idemRollback = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_idempotencia WHERE idempotency_key = ?
    `, [chave]);
    assert.equal(Number(idemRollback.n), 0, 'falha desfaz o registro interno da tentativa do lote');
    const retry = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });
    assert.equal(retry.success, true);
    assert.equal(retry.status, 'CONCLUIDO');
    const rodadas = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE idempotency_key_despacho = ?
    `, [DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId)]);
    const itens = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_itens WHERE pedido_id = ?
    `, [pedidoId]);
    assert.equal(Number(rodadas.n), 1);
    assert.equal(Number(itens.n), 1);
    await close(db);
  });

  it('12) reprocessamento seguro após falha', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, { unidadeId: ctx.unA });

    // Simula falha prévia persistida
    await run(db, `
      INSERT INTO cozinha_pedido_despachos (
        empresa_id, pedido_id, unidade_id, status, idempotency_key, codigo_falha
      ) VALUES (?, ?, ?, 'FALHA', ?, 'FALHA_ANTERIOR')
    `, [ctx.emp1, pedidoId, ctx.unA, DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId)]);
    await run(db, `
      UPDATE pedidos SET cozinha_despacho_status = 'FALHA', cozinha_despacho_codigo = 'FALHA_ANTERIOR'
      WHERE id = ?
    `, [pedidoId]);

    const out = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });

    assert.equal(out.success, true);
    assert.equal(out.status, 'CONCLUIDO');
    assert.ok(out.rodada_id);
    const ctrl = await get(db, `
      SELECT status, rodada_id FROM cozinha_pedido_despachos WHERE empresa_id = ? AND pedido_id = ?
    `, [ctx.emp1, pedidoId]);
    assert.equal(ctrl.status, 'CONCLUIDO');
    await close(db);
  });

  it('15) duas retomadas concorrentes de FALHA têm um único proprietário', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx);
    const chave = DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId);
    await run(db, `
      INSERT INTO cozinha_pedido_despachos (
        empresa_id, pedido_id, unidade_id, status, idempotency_key
      ) VALUES (?, ?, ?, 'FALHA', ?)
    `, [ctx.emp1, pedidoId, ctx.unA, chave]);
    const args = { empresaId: ctx.emp1, pedidoId, unidadeId: ctx.unA, chave };

    const [a, b] = await Promise.all([
      DespachoPedido.reivindicarDespacho(db, args),
      DespachoPedido.reivindicarDespacho(db, args)
    ]);
    const reivindicados = [a, b].filter((r) => r.acao === 'REIVINDICADO');
    const concorrentes = [a, b].filter((r) => r.acao === 'EM_ANDAMENTO');
    assert.equal(reivindicados.length, 1);
    assert.equal(concorrentes.length, 1);
    assert.ok(reivindicados[0].claimToken);
    assert.notEqual(concorrentes[0].claimToken, reivindicados[0].claimToken);
    const persistido = await get(db, `
      SELECT status, claim_token FROM cozinha_pedido_despachos
      WHERE empresa_id = ? AND pedido_id = ?
    `, [ctx.emp1, pedidoId]);
    assert.equal(persistido.status, 'EM_ANDAMENTO');
    assert.equal(persistido.claim_token, reivindicados[0].claimToken);
    const colunas = await all(db, 'PRAGMA table_info(cozinha_pedido_despachos)');
    assert.ok(colunas.some((coluna) => coluna.name === 'claim_token'));
    const migration = fs.readFileSync(
      path.join(__dirname, '../../backend/migrations/s07-3e-pedido-despacho-kds.sql'),
      'utf8'
    );
    assert.match(migration, /claim_token TEXT/i);
    await close(db);
  });

  it('16) recupera claim abandonado e reconhece rodada já persistida sem duplicar', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoAtivoId = await criarPedidoResolvido(db, ctx, { unidadeId: ctx.unA });
    const chaveAtivo = DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoAtivoId);
    await run(db, `
      INSERT INTO cozinha_pedido_despachos (
        empresa_id, pedido_id, unidade_id, status, idempotency_key,
        claim_token, updated_at
      ) VALUES (?, ?, ?, 'EM_ANDAMENTO', ?, 'claim-antigo', CURRENT_TIMESTAMP)
    `, [ctx.emp1, pedidoAtivoId, ctx.unA, chaveAtivo]);
    const aindaAtivo = await DespachoPedido.reivindicarDespacho(db, {
      empresaId: ctx.emp1,
      pedidoId: pedidoAtivoId,
      unidadeId: ctx.unA,
      chave: chaveAtivo,
      staleEmAndamentoMs: DespachoPedido.STALE_EM_ANDAMENTO_MS_PADRAO
    });
    assert.equal(aindaAtivo.acao, 'EM_ANDAMENTO');
    assert.equal(aindaAtivo.registro.claim_token, 'claim-antigo');
    await run(db, `
      UPDATE cozinha_pedido_despachos
      SET updated_at = '2000-01-01 00:00:00'
      WHERE empresa_id = ? AND pedido_id = ?
    `, [ctx.emp1, pedidoAtivoId]);

    const despachoOriginal = CozinhaDespacho.despacharLote;
    let sinalizarDespachoIniciado;
    let liberarDespacho;
    const despachoIniciado = new Promise((resolve) => {
      sinalizarDespachoIniciado = resolve;
    });
    const despachoLiberado = new Promise((resolve) => {
      liberarDespacho = resolve;
    });
    CozinhaDespacho.despacharLote = async (...args) => {
      sinalizarDespachoIniciado();
      await despachoLiberado;
      return despachoOriginal(...args);
    };
    let resultadoAntigo;
    let novoProprietario;
    try {
      const despachoAntigo = DespachoPedido.despacharPedidoResolvido({
        empresaId: ctx.emp1, pedidoId: pedidoAtivoId, operadorId: ctx.opId
      }, { db });
      await despachoIniciado;
      novoProprietario = await DespachoPedido.reivindicarDespacho(db, {
        empresaId: ctx.emp1,
        pedidoId: pedidoAtivoId,
        unidadeId: ctx.unA,
        chave: chaveAtivo,
        staleEmAndamentoMs: 0
      });
      assert.equal(novoProprietario.acao, 'REIVINDICADO');
      assert.notEqual(novoProprietario.claimToken, 'claim-antigo');
      liberarDespacho();
      resultadoAntigo = await despachoAntigo;
    } finally {
      liberarDespacho();
      CozinhaDespacho.despacharLote = despachoOriginal;
    }

    assert.equal(resultadoAntigo.success, false);
    assert.equal(resultadoAntigo.codigo, 'DESPACHO_CLAIM_PERDIDO');
    const aposExecucaoAntiga = await get(db, `
      SELECT d.status, d.claim_token, p.cozinha_despacho_status
      FROM cozinha_pedido_despachos d
      JOIN pedidos p ON p.id = d.pedido_id
      WHERE d.empresa_id = ? AND d.pedido_id = ?
    `, [ctx.emp1, pedidoAtivoId]);
    assert.equal(aposExecucaoAntiga.status, 'EM_ANDAMENTO');
    assert.equal(aposExecucaoAntiga.claim_token, novoProprietario.claimToken);
    assert.notEqual(aposExecucaoAntiga.cozinha_despacho_status, 'CONCLUIDO');

    const pedidoId = await criarPedidoResolvido(db, ctx);
    const chave = DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId);
    await run(db, `
      INSERT INTO cozinha_pedido_despachos (
        empresa_id, pedido_id, unidade_id, status, idempotency_key,
        claim_token, updated_at
      ) VALUES (?, ?, ?, 'EM_ANDAMENTO', ?, 'claim-interrompido', '2000-01-01 00:00:00')
    `, [ctx.emp1, pedidoId, ctx.unA, chave]);

    const recuperado = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db, staleEmAndamentoMs: 0 });
    assert.equal(recuperado.success, true);
    assert.equal(recuperado.status, 'CONCLUIDO');
    assert.ok(recuperado.rodada_id);
    const rodadasAntes = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE idempotency_key_despacho = ?
    `, [chave]);

    await run(db, `
      UPDATE cozinha_pedido_despachos
      SET status = 'EM_ANDAMENTO', updated_at = '2000-01-01 00:00:00'
      WHERE empresa_id = ? AND pedido_id = ?
    `, [ctx.emp1, pedidoId]);
    const posCommit = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db, staleEmAndamentoMs: 0 });
    const rodadasDepois = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE idempotency_key_despacho = ?
    `, [chave]);
    const itens = await get(db, `SELECT COUNT(*) AS n FROM cozinha_itens WHERE pedido_id = ?`, [pedidoId]);
    assert.equal(posCommit.success, true);
    assert.equal(posCommit.repetida, true);
    assert.equal(posCommit.rodada_id, recuperado.rodada_id);
    assert.equal(Number(rodadasAntes.n), 1);
    assert.equal(Number(rodadasDepois.n), 1);
    assert.equal(Number(itens.n), 1);
    const concluiuSemDuplicar = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId: pedidoAtivoId, operadorId: ctx.opId
    }, { db, staleEmAndamentoMs: 0 });
    const rodadasAtivo = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE idempotency_key_despacho = ?
    `, [chaveAtivo]);
    assert.equal(concluiuSemDuplicar.success, true);
    assert.equal(concluiuSemDuplicar.repetida, true);
    assert.equal(Number(rodadasAtivo.n), 1);
    await close(db);
  });

  it('13) pedido aparece só na unidade correta', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const pedidoId = await criarPedidoResolvido(db, ctx, { unidadeId: ctx.unA });

    await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db });

    const painelA = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: ctx.emp1,
      unidadeId: ctx.unA
    }, { db });
    const painelB = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: ctx.emp1,
      unidadeId: ctx.unB
    }, { db });

    const itensA = (painelA.itens || painelA.pedidos || painelA.rodadas || []).length
      || (Array.isArray(painelA) ? painelA.length : 0);
    // API retorna estrutura com itens agrupados — validar via SQL direto também
    const naA = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_itens WHERE empresa_id = ? AND unidade_id = ? AND pedido_id = ?
    `, [ctx.emp1, ctx.unA, pedidoId]);
    const naB = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_itens WHERE empresa_id = ? AND unidade_id = ? AND pedido_id = ?
    `, [ctx.emp1, ctx.unB, pedidoId]);
    assert.equal(Number(naA.n), 1);
    assert.equal(Number(naB.n), 0);
    void itensA;
    void painelB;
    await close(db);
  });

  it('14) UNIQUE(empresa_id, pedido_id) na persistência de despacho', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await garantirSchemaDespachoPedidoCozinha(db);
    await run(db, `
      INSERT INTO cozinha_pedido_despachos (
        empresa_id, pedido_id, status, idempotency_key
      ) VALUES (?, 1, 'CONCLUIDO', 'k1')
    `, [ctx.emp1]);
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_pedido_despachos (
          empresa_id, pedido_id, status, idempotency_key
        ) VALUES (?, 1, 'EM_ANDAMENTO', 'k2')
      `, [ctx.emp1]),
      (err) => /UNIQUE/i.test(String(err.message))
    );
    await close(db);
  });
});

describe('S07-3F — integração HTTP ERP → KDS', () => {
  let dbHttp;
  let server;
  let baseUrl;
  let ctx;
  let recursoHabilitadoOriginal;
  let tokenOperador;
  let dbModulePath;
  let dbModuleCache;
  let dbModuleOriginalExports;
  let dbModuleWasCached;

  function postPedido(body, chaveIdempotencia) {
    const url = new URL('/api/pedidos', baseUrl);
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Empresa-Id': String(ctx.emp1),
          Authorization: `Bearer ${tokenOperador}`,
          'Idempotency-Key': chaveIdempotencia
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(raw); } catch (_err) { json = { raw }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  function postPreparacao(pedidoId, chaveIdempotencia) {
    const url = new URL(`/api/pedidos/${pedidoId}/preparacao/enviar`, baseUrl);
    const payload = '{}';
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Empresa-Id': String(ctx.emp1),
          Authorization: `Bearer ${tokenOperador}`,
          'Idempotency-Key': chaveIdempotencia
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(raw); } catch (_err) { json = { raw }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  before(async () => {
    dbHttp = await openTempFile();
    ctx = await prepararBase(dbHttp);
    await garantirSchemaEstoqueEmpresaAsync(dbHttp);
    await EstoqueEmpresaService.criarRegistro({
      produtoId: ctx.produtoId,
      empresaId: ctx.emp1,
      saldo_fiscal: 50,
      saldo_nao_fiscal: 0,
      estoque_atual: 50,
      reservado_fiscal: 0
    }, { db: dbHttp });
    await configurarLoja(dbHttp, ctx, ctx.unA);

    recursoHabilitadoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = function recursoHabilitadoComPedidos(recurso) {
      if (recurso === 'pedidos') return true;
      return recursoHabilitadoOriginal(recurso);
    };

    dbModulePath = require.resolve('../../backend/database');
    dbModuleCache = require.cache[dbModulePath] || null;
    dbModuleWasCached = Boolean(dbModuleCache);
    if (dbModuleCache) {
      dbModuleOriginalExports = dbModuleCache.exports;
      dbModuleCache.exports = dbHttp;
    } else {
      const Module = require('module');
      dbModuleCache = new Module(dbModulePath, module);
      dbModuleCache.filename = dbModulePath;
      dbModuleCache.loaded = true;
      dbModuleCache.exports = dbHttp;
      require.cache[dbModulePath] = dbModuleCache;
    }
    const { verificarToken } = require('../../backend/middleware/auth');
    const router = require('../../backend/rotas/pedidos');
    const app = express();
    app.use(express.json());
    app.use('/api/pedidos', verificarToken, router);
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    tokenOperador = jwt.sign({
      id: ctx.opId,
      username: 'op_r3e',
      role: 'operador',
      perfil: 'USUARIO',
      permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  after(async () => {
    if (recursoHabilitadoOriginal) {
      configService.recursoHabilitado = recursoHabilitadoOriginal;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (dbModulePath && dbModuleCache) {
      if (dbModuleWasCached) dbModuleCache.exports = dbModuleOriginalExports;
      else delete require.cache[dbModulePath];
    }
    if (dbHttp) await close(dbHttp);
  });

  it('comanda HTTP exige vínculo e unidade, registra tentativas e bloqueia concorrência', async () => {
    const pedidoId = await criarPedidoResolvido(dbHttp, ctx);
    const despacho = await DespachoPedido.despacharPedidoResolvido({
      empresaId: ctx.emp1, pedidoId, operadorId: ctx.opId
    }, { db: dbHttp });
    assert.equal(despacho.status, 'CONCLUIDO');
    const authUnidade = require('../../backend/services/cozinha/cozinhaAuthUnidade');
    await authUnidade.garantirTabelaOperadorUnidades(dbHttp);
    const chamar = (metodo, caminho, token, empresa, body) => new Promise((resolve, reject) => {
      const payload = body == null ? null : JSON.stringify(body);
      const url = new URL(caminho, baseUrl);
      const req = http.request(url, {
        method: metodo,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-Empresa-Id': String(empresa),
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      }, (res) => {
        let texto = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { texto += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(texto) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    const caminho = `/api/pedidos/${pedidoId}/comanda-kds`;
    assert.equal((await chamar('GET', caminho, null, ctx.emp1)).status, 401);
    assert.equal((await chamar('GET', caminho, tokenOperador, ctx.emp1)).status, 403);
    await run(dbHttp, `
      INSERT INTO cozinha_operador_unidades (empresa_id, operador_id, unidade_id, ativo)
      VALUES (?, ?, ?, 1)
    `, [ctx.emp1, ctx.opId, ctx.unA]);
    const tokenOutraUnidade = jwt.sign({
      id: ctx.opId, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: ctx.unB
    }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await chamar('GET', caminho, tokenOutraUnidade, ctx.emp1)).status, 403);
    assert.equal((await chamar('GET', caminho, tokenOperador, ctx.emp2)).status, 403);
    const ref = await chamar('GET', caminho, tokenOperador, ctx.emp1);
    assert.equal(ref.status, 200);
    const base = `/api/pedidos/comanda-kds/${ref.body.snapshot_id}/tentativas`;
    const tentativa = await chamar('POST', base, tokenOperador, ctx.emp1, {});
    assert.equal(tentativa.status, 201);
    assert.equal(tentativa.body.snapshot.pedido_id, pedidoId);
    assert.equal(ref.body.html, require('../../electron-comanda-kds').htmlComanda(tentativa.body.snapshot));
    assert.equal((await chamar('POST', base, tokenOperador, ctx.emp1, {})).status, 409);
    const final = await chamar('POST', `${base}/${tentativa.body.tentativa_id}`, tokenOperador, ctx.emp1, {
      estado: 'FALHA', detalhe: 'simulada'
    });
    assert.equal(final.status, 200);
    const retry = await chamar('POST', base, tokenOperador, ctx.emp1, {});
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body.snapshot, tentativa.body.snapshot);
    assert.equal((await chamar('POST', `${base}/${retry.body.tentativa_id}`, tokenOperador, ctx.emp1, {
      estado: 'ACEITA_PELO_SPOOLER'
    })).status, 200);
  });

  it('envia pedido faturado sem alterar estado comercial e reprocessa sem duplicar rodada', async () => {
    const criado = await postPedido({
      mesa_id: ctx.mesaId,
      total: 20,
      itens: [{ produto_id: ctx.produtoId, quantidade: 2, preco_unitario: 10, subtotal: 20 }]
    }, `s07-3f-faturado-${Date.now()}`);
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    const pedidoId = Number(criado.body.pedido.id);
    await run(dbHttp, "UPDATE pedidos SET status = 'FATURADO' WHERE id = ?", [pedidoId]);
    const envio = await postPreparacao(pedidoId, `s07-3f-faturado-envio-${Date.now()}`);
    assert.equal(envio.status, 200, JSON.stringify(envio.body));
    assert.equal(envio.body.despacho.status, 'CONCLUIDO', JSON.stringify(envio.body.despacho));
    const repetido = await postPreparacao(pedidoId, `s07-3f-faturado-retry-${Date.now()}`);
    assert.equal(repetido.body.despacho.status, 'CONCLUIDO');
    assert.equal(repetido.body.despacho.repetida, true);
    assert.equal((await get(dbHttp, 'SELECT status FROM pedidos WHERE id = ?', [pedidoId])).status, 'FATURADO');
    assert.equal((await get(dbHttp, 'SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE idempotency_key_despacho = ?', [
      DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId)
    ])).n, 1);
    assert.equal((await get(dbHttp, 'SELECT COUNT(*) AS n FROM cozinha_comanda_snapshots WHERE pedido_id = ?', [pedidoId])).n, 1);
  });

  it('POST /api/pedidos cria sem despacho; envio explícito despacha e leitura KDS isola unidades', async () => {
    assert.ok(String(process.env.DB_DIR).includes('cds-cozinha-s07-3e-'));
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB, undefined);

    const response = await postPedido({
      mesa_id: ctx.mesaId,
      total: 20,
      empresa_id: ctx.emp2,
      unidade_cozinha_destino_id: ctx.unB,
      itens: [{
        produto_id: ctx.produtoId,
        quantidade: 2,
        preco_unitario: 10,
        desconto_percentual: 0,
        subtotal: 20
      }]
    }, `s07-3e-http-${Date.now()}`);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.success, true);
    const pedidoId = Number(response.body.pedido && response.body.pedido.id);
    assert.ok(Number.isInteger(pedidoId) && pedidoId > 0);

    const antesDoEnvio = await get(dbHttp, `
      SELECT cozinha_resolucao_status, unidade_cozinha_destino_id, cozinha_despacho_status
      FROM pedidos WHERE id = ?
    `, [pedidoId]);
    assert.equal(antesDoEnvio.cozinha_resolucao_status, 'RESOLVIDO');
    assert.equal(Number(antesDoEnvio.unidade_cozinha_destino_id), ctx.unA);
    assert.equal(antesDoEnvio.cozinha_despacho_status, null, 'criação comercial não despacha');
    const prepInicial = await get(dbHttp, `
      SELECT estado, enviado_em FROM pedido_preparacoes WHERE empresa_id = ? AND pedido_id = ?
    `, [ctx.emp1, pedidoId]);
    assert.equal(prepInicial.estado, 'NAO_ENVIADO');
    assert.equal(prepInicial.enviado_em, null);

    const envio = await postPreparacao(pedidoId, `s07-3f-envio-${Date.now()}`);
    assert.equal(envio.status, 200, JSON.stringify(envio.body));
    assert.equal(envio.body.success, true);
    assert.equal(envio.body.preparacao.estado, 'EM_PREPARACAO');
    assert.equal(envio.body.despacho.status, 'CONCLUIDO');
    assert.equal(Number(envio.body.despacho.unidade_id), ctx.unA);

    const observer = await openTempFile();
    try {
      const pedido = await get(observer, `
        SELECT id, status, empresa_id, operador_id, mesa_id, mesa_atendimento_id,
               total, origem_canal, cozinha_resolucao_status,
               unidade_cozinha_destino_id, cozinha_despacho_status,
               cozinha_despacho_rodada_id
        FROM pedidos WHERE id = ?
      `, [pedidoId]);
      assert.ok(pedido, 'pedido permanece persistido após resposta da rota/COMMIT');
      assert.equal(pedido.status, 'PEDIDO');
      assert.equal(Number(pedido.empresa_id), ctx.emp1);
      assert.equal(Number(pedido.total), 20);
      assert.equal(pedido.origem_canal, 'EQUIPE');
      assert.equal(pedido.cozinha_resolucao_status, 'RESOLVIDO');
      assert.equal(Number(pedido.unidade_cozinha_destino_id), ctx.unA);
      assert.equal(pedido.cozinha_despacho_status, 'CONCLUIDO');
      const preparacao = await get(observer, `
        SELECT estado, enviado_em FROM pedido_preparacoes WHERE empresa_id = ? AND pedido_id = ?
      `, [ctx.emp1, pedidoId]);
      assert.equal(preparacao.estado, 'EM_PREPARACAO');
      assert.ok(preparacao.enviado_em);

      const despacho = await get(observer, `
        SELECT status, unidade_id, rodada_id
        FROM cozinha_pedido_despachos WHERE empresa_id = ? AND pedido_id = ?
      `, [ctx.emp1, pedidoId]);
      assert.equal(despacho.status, 'CONCLUIDO');
      assert.equal(Number(despacho.unidade_id), ctx.unA);
      assert.equal(Number(despacho.rodada_id), Number(pedido.cozinha_despacho_rodada_id));

      const rodada = await get(observer, `
        SELECT id, empresa_id, unidade_id, idempotency_key_despacho
        FROM cozinha_rodadas WHERE id = ?
      `, [despacho.rodada_id]);
      assert.equal(Number(rodada.empresa_id), ctx.emp1);
      assert.equal(Number(rodada.unidade_id), ctx.unA);
      assert.equal(
        rodada.idempotency_key_despacho,
        DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId)
      );
      const itens = await all(observer, `
        SELECT id, pedido_id, unidade_id, rodada_id
        FROM cozinha_itens WHERE pedido_id = ?
      `, [pedidoId]);
      assert.equal(itens.length, 1);
      assert.equal(Number(itens[0].unidade_id), ctx.unA);
      assert.equal(Number(itens[0].rodada_id), Number(rodada.id));

      const painelA = await CozinhaKdsPainel.listarPainelPreparacao({
        empresaId: ctx.emp1, unidadeId: ctx.unA
      }, { db: observer });
      const painelB = await CozinhaKdsPainel.listarPainelPreparacao({
        empresaId: ctx.emp1, unidadeId: ctx.unB
      }, { db: observer });
      assert.ok(painelA.rodadas.some((r) => Number(r.id) === Number(rodada.id)));
      assert.equal(painelB.rodadas.some((r) => Number(r.id) === Number(rodada.id)), false);

      const filaImpressao = await get(observer, `
        SELECT COUNT(*) AS n FROM cozinha_impressao_fila WHERE rodada_id = ?
      `, [rodada.id]);
      assert.equal(Number(filaImpressao.n), 0, 'despacho KDS não cria job que um worker S06 possa imprimir');

      const retry = await postPreparacao(pedidoId, `s07-3f-retry-${Date.now()}`);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.despacho.status, 'CONCLUIDO');
      assert.equal(retry.body.despacho.repetida, true);
      const rodadaCount = await get(observer, `
        SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE idempotency_key_despacho = ?
      `, [DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId)]);
      const itemCount = await get(observer, `SELECT COUNT(*) AS n FROM cozinha_itens WHERE pedido_id = ?`, [pedidoId]);
      assert.equal(Number(rodadaCount.n), 1);
      assert.equal(Number(itemCount.n), 1);
    } finally {
      await close(observer);
    }
  });

  it('falha de despacho mantém pedido comercial e preparação persistidos', async () => {
    const loja = await get(dbHttp, `
      SELECT id FROM cozinha_canais WHERE empresa_id = ? AND codigo = 'LOJA'
    `, [ctx.emp1]);
    await run(dbHttp, `
      DELETE FROM cozinha_canal_destinos WHERE empresa_id = ? AND canal_id = ?
    `, [ctx.emp1, loja.id]);

    const response = await postPedido({
      mesa_id: ctx.mesaId,
      total: 10,
      itens: [{
        produto_id: ctx.produtoId,
        quantidade: 1,
        preco_unitario: 10,
        desconto_percentual: 0,
        subtotal: 10
      }]
    }, `s07-3f-falha-${Date.now()}`);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const pedidoId = Number(response.body.pedido.id);

    const envio = await postPreparacao(pedidoId, `s07-3f-falha-envio-${Date.now()}`);
    assert.equal(envio.status, 200, JSON.stringify(envio.body));
    assert.equal(envio.body.preparacao.estado, 'EM_PREPARACAO');
    assert.equal(envio.body.despacho.status, 'BLOQUEADO');
    assert.equal(envio.body.despacho.codigo, 'DESPACHO_REQUER_RESOLVIDO');

    const pedido = await get(dbHttp, `
      SELECT status, cozinha_resolucao_status, cozinha_despacho_status
      FROM pedidos WHERE empresa_id = ? AND id = ?
    `, [ctx.emp1, pedidoId]);
    assert.equal(pedido.status, 'PEDIDO');
    assert.equal(pedido.cozinha_resolucao_status, 'DESTINO_NAO_CONFIGURADO');
    assert.equal(pedido.cozinha_despacho_status, 'BLOQUEADO');
    const rodadas = await get(dbHttp, `
      SELECT COUNT(*) AS n FROM cozinha_rodadas WHERE idempotency_key_despacho = ?
    `, [DespachoPedido.chaveIdempotenciaPedido(ctx.emp1, pedidoId)]);
    assert.equal(Number(rodadas.n), 0);
    const impressao = await get(dbHttp, `
      SELECT COUNT(*) AS n FROM cozinha_impressao_fila
    `);
    assert.equal(Number(impressao.n), 0);
  });

  it('envio explícito resolve snapshot pendente com a cozinha padrão atual', async () => {
    await run(dbHttp, `
      INSERT OR REPLACE INTO cozinha_roteamento_config (empresa_id, modo, unidade_padrao_id)
      VALUES (?, 'COZINHA_PADRAO', ?)
    `, [ctx.emp1, ctx.unA]);
    const response = await postPedido({
      mesa_id: ctx.mesaId,
      total: 10,
      itens: [{
        produto_id: ctx.produtoId,
        quantidade: 1,
        preco_unitario: 10,
        desconto_percentual: 0,
        subtotal: 10
      }]
    }, `s07-3f-snapshot-pendente-${Date.now()}`);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const pedidoId = Number(response.body.pedido.id);

    await run(dbHttp, `
      UPDATE pedidos
      SET cozinha_resolucao_status = 'DESTINO_NAO_CONFIGURADO',
          unidade_cozinha_destino_id = NULL
      WHERE empresa_id = ? AND id = ?
    `, [ctx.emp1, pedidoId]);

    const envio = await postPreparacao(pedidoId, `s07-3f-resolver-e-enviar-${Date.now()}`);
    assert.equal(envio.status, 200, JSON.stringify(envio.body));
    assert.equal(envio.body.despacho.status, 'CONCLUIDO');
    assert.equal(Number(envio.body.despacho.unidade_id), ctx.unA);

    const snapshot = await get(dbHttp, `
      SELECT cozinha_resolucao_status, unidade_cozinha_destino_id, cozinha_despacho_status
      FROM pedidos WHERE empresa_id = ? AND id = ?
    `, [ctx.emp1, pedidoId]);
    assert.equal(snapshot.cozinha_resolucao_status, 'RESOLVIDO');
    assert.equal(Number(snapshot.unidade_cozinha_destino_id), ctx.unA);
    assert.equal(snapshot.cozinha_despacho_status, 'CONCLUIDO');
  });
});

describe('regressões S06 / S07 (fumaça)', () => {
  it('não altera CozinhaImpressaoFilaService (S06 congelada)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/services/cozinha/CozinhaImpressaoFilaService.js'),
      'utf8'
    );
    assert.ok(src.includes('enfileirarDaRodada'));
    const despachoPedido = fs.readFileSync(
      path.join(__dirname, '../../backend/services/cozinha/CozinhaDespachoPedidoService.js'),
      'utf8'
    );
    assert.equal(despachoPedido.includes('CozinhaImpressaoFilaService'), false);
    assert.equal(despachoPedido.includes('enfileirarDaRodada'), false);
  });

  it('S07-3D resolução permanece independente', () => {
    assert.equal(typeof Resolucao.resolverDestinoPedido, 'function');
    assert.equal(Resolucao.normalizarCanalCozinha('EQUIPE'), 'LOJA');
  });

  it('S07-3C canais LOJA ainda funciona', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const loja = await configurarLoja(db, ctx, ctx.unB);
    assert.equal(loja.codigo, 'LOJA');
    await close(db);
  });
});

after(() => {
  const db = require.cache[require.resolve('../../backend/database')];
  if (db && db.exports && typeof db.exports.close === 'function') {
    db.exports.close(() => {
      try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    });
    return;
  }
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
