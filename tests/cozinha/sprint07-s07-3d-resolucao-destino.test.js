/**
 * Sprint 07 · S07-3D — Resolução automática do destino dos pedidos.
 * Banco temporário. Sem migration no oficial. Sem despacho / iFood real / S07-3E+.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-3d-resolucao-destino.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-3d-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-3d-resolucao';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const {
  garantirSchemaCozinhaRoteamento
} = require('../../backend/services/cozinha/cozinhaRoteamentoSchema');
const {
  garantirSchemaCozinhaCanais
} = require('../../backend/services/cozinha/cozinhaCanaisSchema');
const {
  garantirSchemaDestinoCozinhaPedidos
} = require('../../backend/utils/pedidosDestinoCozinhaSchema');
const { garantirSchemaOrigemPedidos } = require('../../backend/utils/pedidosOrigemSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const Canais = require('../../backend/services/cozinha/CozinhaCanaisService');
const Resolucao = require('../../backend/services/cozinha/CozinhaResolucaoDestinoService');
const repo = require('../../backend/services/pedido/PedidoRepository');
const EntradaPedido = require('../../backend/services/pedido/EntradaPedidoService');
const Roteamento = require('../../backend/services/cozinha/CozinhaRoteamentoConfigService');
const ui = require('../../frontend/erp/js/cozinha-roteamento.js');
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
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function prepararBase(db, { comCanais = true, comDestinoPedido = true } = {}) {
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
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      data_pedido TEXT,
      cliente_id INTEGER,
      total REAL DEFAULT 0,
      desconto REAL DEFAULT 0,
      frete REAL DEFAULT 0,
      status TEXT,
      representante_id INTEGER,
      representante_nome TEXT,
      observacao TEXT,
      operador_id INTEGER,
      empresa_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
      subtotal REAL
    )
  `);
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaCozinha(db);
  await garantirSchemaCozinhaRoteamento(db);
  if (comCanais) await garantirSchemaCozinhaCanais(db);
  await garantirSchemaOrigemPedidos(db);
  if (comDestinoPedido) await garantirSchemaDestinoCozinhaPedidos(db);

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
    VALUES ('admin_r3d', 'hash', 'admin', 'ADMIN', 1, 'Admin')
  `);
  const op = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('op_r3d', 'hash', 'operador', 'USUARIO', 1, 'Op')
  `);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [admin.lastID, emp1.lastID]);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [op.lastID, emp1.lastID]);

  const unA = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-01', 1)`, [emp1.lastID]);
  const unB = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-DELIVERY', 1)`, [emp1.lastID]);
  const unInativa = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-OFF', 0)`, [emp1.lastID]);
  const unOutra = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-X', 1)`, [emp2.lastID]);

  return {
    emp1: emp1.lastID,
    emp2: emp2.lastID,
    adminId: admin.lastID,
    opId: op.lastID,
    unA: unA.lastID,
    unB: unB.lastID,
    unInativa: unInativa.lastID,
    unOutra: unOutra.lastID
  };
}

function userAdmin(ctx) {
  return { id: ctx.adminId, username: 'admin_r3d', role: 'admin', perfil: 'ADMIN', permissoes: [] };
}

async function garantirLojaComDestino(db, ctx, unidadeId) {
  await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
  const lista = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
  const loja = lista.canais.find((c) => c.codigo === 'LOJA');
  assert.ok(loja, 'canal LOJA');
  await Canais.definirDestinoCanal({
    user: userAdmin(ctx),
    empresaId: ctx.emp1,
    canalIdRaw: loja.id,
    unidadeIdRaw: unidadeId,
    bodyEmpresaIdIgnored: 999
  }, { db });
  return loja;
}

async function configurarCozinhaPadrao(db, empresaId, unidadeId, modo = 'COZINHA_PADRAO') {
  await run(db, `
    INSERT OR REPLACE INTO cozinha_roteamento_config (empresa_id, modo, unidade_padrao_id)
    VALUES (?, ?, ?)
  `, [empresaId, modo, unidadeId]);
}

async function inserirCanalIntegracao(db, empresaId, codigo, nome, { ativo = 1 } = {}) {
  const r = await run(db, `
    INSERT INTO cozinha_canais (
      empresa_id, codigo, nome, origem_tipo, ativo, created_at, updated_at
    ) VALUES (?, ?, ?, 'INTEGRACAO', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [empresaId, codigo, nome, ativo]);
  return r.lastID;
}

describe('S07-3D — isolamento do banco', () => {
  it('usa DB_DIR temporário e bloqueia oficial', () => {
    assert.ok(String(process.env.DB_DIR).includes('cds-cozinha-s07-3d-'));
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB, undefined);
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(process.env.DB_DIR)), false);
  });
});

describe('S07-3D — resolução de destino (serviço)', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('1) origem LOJA (via EQUIPE) com destino configurado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await garantirLojaComDestino(db, ctx, ctx.unA);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'EQUIPE',
      bodyEmpresaIdIgnored: ctx.emp2,
      unidadeDestinoArbitrariaIgnored: ctx.unB
    }, { db });

    assert.equal(out.status, Resolucao.STATUS_RESOLUCAO.RESOLVIDO);
    assert.equal(out.canal_codigo, 'LOJA');
    assert.equal(out.destino.unidade_id, ctx.unA);
    assert.equal(out.despacho, false);
    assert.notEqual(out.destino.unidade_id, ctx.unB);
    await close(db);
  });

  it('2) origem IFOOD com destino configurado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const canalId = await inserirCanalIntegracao(db, ctx.emp1, 'IFOOD', 'iFood');
    await run(db, `
      INSERT INTO cozinha_canal_destinos (empresa_id, canal_id, unidade_cozinha_id)
      VALUES (?, ?, ?)
    `, [ctx.emp1, canalId, ctx.unB]);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'IFOOD'
    }, { db });

    assert.equal(out.status, 'RESOLVIDO');
    assert.equal(out.canal_codigo, 'IFOOD');
    assert.equal(out.destino.unidade_id, ctx.unB);
    assert.equal(out.despacho, false);
    await close(db);
  });

  it('3) dois canais apontam para a mesma cozinha', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await garantirLojaComDestino(db, ctx, ctx.unB);
    const canalId = await inserirCanalIntegracao(db, ctx.emp1, 'WHATSAPP', 'WhatsApp');
    await run(db, `
      INSERT INTO cozinha_canal_destinos (empresa_id, canal_id, unidade_cozinha_id)
      VALUES (?, ?, ?)
    `, [ctx.emp1, canalId, ctx.unB]);

    const loja = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA'
    }, { db });
    const wa = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'WHATSAPP'
    }, { db });

    assert.equal(loja.destino.unidade_id, ctx.unB);
    assert.equal(wa.destino.unidade_id, ctx.unB);
    await close(db);
  });

  it('4) canal sem destino → pendência, sem fallback', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA'
    }, { db });

    assert.equal(out.status, 'DESTINO_NAO_CONFIGURADO');
    assert.equal(out.pendente, true);
    assert.equal(out.destino, null);
    assert.equal(out.success, false);
    await close(db);
  });

  it('COZINHA_PADRAO usa a unidade padrão configurada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    await configurarCozinhaPadrao(db, ctx.emp1, ctx.unA);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA'
    }, { db });

    assert.equal(out.status, 'RESOLVIDO');
    assert.equal(out.destino.unidade_id, ctx.unA);
    await close(db);
  });

  it('COZINHA_PADRAO bloqueia unidade inativa e unidade de outra empresa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    await configurarCozinhaPadrao(db, ctx.emp1, ctx.unInativa);
    const inativa = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA'
    }, { db });
    assert.equal(inativa.status, 'UNIDADE_DESTINO_INVALIDA');

    await run(db, 'PRAGMA foreign_keys = OFF');
    await configurarCozinhaPadrao(db, ctx.emp1, ctx.unOutra);
    await run(db, 'PRAGMA foreign_keys = ON');
    const outraEmpresa = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA'
    }, { db });
    assert.equal(outraEmpresa.status, 'UNIDADE_DESTINO_INVALIDA');
    assert.equal(outraEmpresa.destino, null);
    await close(db);
  });

  it('destino explícito do canal prevalece sobre a cozinha padrão', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await garantirLojaComDestino(db, ctx, ctx.unB);
    await configurarCozinhaPadrao(db, ctx.emp1, ctx.unA);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA'
    }, { db });

    assert.equal(out.status, 'RESOLVIDO');
    assert.equal(out.destino.unidade_id, ctx.unB);
    await close(db);
  });

  it('canal manual mantém seu destino específico mesmo com COZINHA_PADRAO', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const criado = await Canais.criarCanal({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      nomeRaw: 'Balcão'
    }, { db });
    await Canais.definirDestinoCanal({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      canalIdRaw: criado.canal.id,
      unidadeIdRaw: ctx.unB
    }, { db });
    await configurarCozinhaPadrao(db, ctx.emp1, ctx.unA);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: criado.canal.codigo
    }, { db });

    assert.equal(criado.canal.origem_tipo, 'MANUAL');
    assert.equal(out.status, 'RESOLVIDO');
    assert.equal(out.destino.unidade_id, ctx.unB);
    await close(db);
  });

  it('5) canal inexistente', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await garantirSchemaCozinhaCanais(db);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'PEDIDO_ONLINE'
    }, { db });

    assert.equal(out.status, 'CANAL_INEXISTENTE');
    assert.equal(out.destino, null);
    await close(db);
  });

  it('6) canal inativo', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const canalId = await inserirCanalIntegracao(db, ctx.emp1, 'IFOOD', 'iFood', { ativo: 0 });
    await run(db, `
      INSERT INTO cozinha_canal_destinos (empresa_id, canal_id, unidade_cozinha_id)
      VALUES (?, ?, ?)
    `, [ctx.emp1, canalId, ctx.unA]);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'IFOOD'
    }, { db });

    assert.equal(out.status, 'CANAL_INATIVO');
    assert.equal(out.destino, null);
    await close(db);
  });

  it('7) unidade de destino inativa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const canalId = await inserirCanalIntegracao(db, ctx.emp1, 'IFOOD', 'iFood');
    await run(db, `
      INSERT INTO cozinha_canal_destinos (empresa_id, canal_id, unidade_cozinha_id)
      VALUES (?, ?, ?)
    `, [ctx.emp1, canalId, ctx.unInativa]);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'IFOOD'
    }, { db });

    assert.equal(out.status, 'UNIDADE_DESTINO_INVALIDA');
    assert.equal(out.destino, null);
    await close(db);
  });

  it('8) unidade de outra empresa (isolamento)', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const canalId = await inserirCanalIntegracao(db, ctx.emp1, 'IFOOD', 'iFood');
    // FK composta impede vínculo cruzado; simula inconsistência com FK off.
    await run(db, 'PRAGMA foreign_keys = OFF');
    await run(db, `
      INSERT INTO cozinha_canal_destinos (empresa_id, canal_id, unidade_cozinha_id)
      VALUES (?, ?, ?)
    `, [ctx.emp1, canalId, ctx.unOutra]);
    await run(db, 'PRAGMA foreign_keys = ON');

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'IFOOD'
    }, { db });

    assert.equal(out.status, 'UNIDADE_DESTINO_INVALIDA');
    assert.equal(out.destino, null);
    await close(db);
  });

  it('9) empresa do frontend ignorada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await garantirLojaComDestino(db, ctx, ctx.unA);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA',
      bodyEmpresaIdIgnored: ctx.emp2
    }, { db });

    assert.equal(out.empresa_id, ctx.emp1);
    assert.equal(out.destino.unidade_id, ctx.unA);
    await close(db);
  });

  it('10) destino arbitrário do frontend ignorado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await garantirLojaComDestino(db, ctx, ctx.unA);

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA',
      unidadeDestinoArbitrariaIgnored: ctx.unB,
      destinoArbitrarioIgnored: { unidade_id: ctx.unB }
    }, { db });

    assert.equal(out.destino.unidade_id, ctx.unA);
    assert.notEqual(out.destino.unidade_id, ctx.unB);
    await close(db);
  });

  it('11) destino resolvido preservado após alteração do roteamento', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const loja = await garantirLojaComDestino(db, ctx, ctx.unA);

    const pedidoId = (await run(db, `
      INSERT INTO pedidos (codigo, data_pedido, total, status, empresa_id, origem_canal)
      VALUES ('PED-3D-1', date('now'), 10, 'PEDIDO', ?, 'EQUIPE')
    `, [ctx.emp1])).lastID;

    const resolucao = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'EQUIPE'
    }, { db });
    assert.equal(resolucao.destino.unidade_id, ctx.unA);

    await repo.persistirResolucaoDestinoCozinha(pedidoId, ctx.emp1, resolucao, { db });

    await Canais.definirDestinoCanal({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      canalIdRaw: loja.id,
      unidadeIdRaw: ctx.unB
    }, { db });

    const nova = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA'
    }, { db });
    assert.equal(nova.destino.unidade_id, ctx.unB);

    // tentativa de regravar NÃO sobrescreve snapshot RESOLVIDO
    await repo.persistirResolucaoDestinoCozinha(pedidoId, ctx.emp1, nova, { db });
    const ped = await get(db, `
      SELECT unidade_cozinha_destino_id, cozinha_resolucao_status, cozinha_canal_codigo, origem_canal
      FROM pedidos WHERE id = ?
    `, [pedidoId]);

    assert.equal(Number(ped.unidade_cozinha_destino_id), ctx.unA);
    assert.equal(ped.cozinha_resolucao_status, 'RESOLVIDO');
    assert.equal(ped.cozinha_canal_codigo, 'LOJA');
    assert.equal(ped.origem_canal, 'EQUIPE');
    await close(db);
  });

  it('snapshot da cozinha padrão não muda após alterar a configuração', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    await configurarCozinhaPadrao(db, ctx.emp1, ctx.unA);
    const pedidoId = (await run(db, `
      INSERT INTO pedidos (codigo, data_pedido, total, status, empresa_id, origem_canal)
      VALUES ('PED-3F-PADRAO', date('now'), 10, 'PEDIDO', ?, 'EQUIPE')
    `, [ctx.emp1])).lastID;

    const primeira = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'EQUIPE'
    }, { db });
    await repo.persistirResolucaoDestinoCozinha(pedidoId, ctx.emp1, primeira, { db });
    await configurarCozinhaPadrao(db, ctx.emp1, ctx.unB);
    const posterior = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'EQUIPE'
    }, { db });
    await repo.persistirResolucaoDestinoCozinha(pedidoId, ctx.emp1, posterior, { db });

    const snapshot = await get(db, `
      SELECT unidade_cozinha_destino_id, cozinha_resolucao_status
      FROM pedidos WHERE id = ?
    `, [pedidoId]);
    assert.equal(Number(snapshot.unidade_cozinha_destino_id), ctx.unA);
    assert.equal(snapshot.cozinha_resolucao_status, 'RESOLVIDO');
    await close(db);
  });

  it('12) schema de canais indisponível', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db, { comCanais: false, comDestinoPedido: true });

    const out = await Resolucao.resolverDestinoPedido({
      empresaId: ctx.emp1,
      canalCodigo: 'LOJA'
    }, { db });

    assert.equal(out.status, 'SCHEMA_CANAIS_INDISPONIVEL');
    assert.equal(out.pendente, true);
    assert.equal(out.destino, null);
    assert.equal(out.despacho, false);
    await close(db);
  });
});

describe('S07-3D — mapeamento e contrato', () => {
  it('EQUIPE mapeia para LOJA; IFOOD permanece IFOOD', () => {
    assert.equal(Resolucao.normalizarCanalCozinha('EQUIPE'), 'LOJA');
    assert.equal(Resolucao.normalizarCanalCozinha('equipe'), 'LOJA');
    assert.equal(Resolucao.normalizarCanalCozinha('IFOOD'), 'IFOOD');
    assert.equal(Resolucao.normalizarCanalCozinha('PEDIDO_ONLINE'), 'PEDIDO_ONLINE');
    assert.equal(Resolucao.MAPA_ADAPTADOR_PARA_CANAL_COZINHA.EQUIPE, 'LOJA');
  });

  it('não exporta despacho nem chama CozinhaDespachoService', () => {
    assert.equal(typeof Resolucao.resolverDestinoPedido, 'function');
    assert.equal(Resolucao.despacharLote, undefined);
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/services/cozinha/CozinhaResolucaoDestinoService.js'),
      'utf8'
    );
    assert.equal(src.includes('CozinhaDespachoService'), false);
    assert.equal(src.includes('despacharLote'), false);
  });
});

describe('S07-3D — regressões S07-3A / 3B / 3C (fumaça)', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('3A — serviço de roteamento ainda obtém configuração', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    marcarCozinhaOperacional(true);
    const out = await Roteamento.obterConfiguracao({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.equal(out.success, true);
    assert.equal(out.empresa_id, ctx.emp1);
    await close(db);
  });

  it('3B — UI de roteamento exporta API esperada', () => {
    assert.ok(ui && typeof ui === 'object');
    assert.ok(Object.keys(ui).length > 0);
  });

  it('3C — LOJA + destino via CanaisService', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const loja = await garantirLojaComDestino(db, ctx, ctx.unA);
    assert.equal(loja.codigo, 'LOJA');
    const lista = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    const atual = lista.canais.find((c) => c.codigo === 'LOJA');
    assert.equal(atual.destino.unidade_id, ctx.unA);
    await close(db);
  });
});

describe('S07-3D — fluxo integrado POST /api/pedidos (real)', () => {
  let server;
  let baseUrl;
  let dbHttp;
  let empresaId;
  let unidadeId;
  let produtoId;
  let tokenOp;
  let recursoFnOriginal;
  let configAntes;

  function requestJson(method, urlPath, { token, body, headers } = {}) {
    const u = new URL(urlPath, baseUrl);
    const payload = body != null ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Empresa-Id': String(empresaId),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(headers || {})
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
      if (payload) req.write(payload);
      req.end();
    });
  }

  before(async () => {
    recursoFnOriginal = configService.recursoHabilitado;
    assert.equal(typeof recursoFnOriginal, 'function');

    dbHttp = require('../../backend/database');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DB timeout')), 90000);
      dbHttp.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });

    for (let i = 0; i < 100; i += 1) {
      const row = await get(dbHttp, `
        SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_notificacoes'
      `);
      const st = getCozinhaSchemaStatus();
      if (row && row.name === 'cozinha_notificacoes' && (st.operacional || st.erro)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    let schemaOut = null;
    let ultimoErro = null;
    for (let t = 0; t < 8; t += 1) {
      try {
        schemaOut = await garantirSchemaCozinha(dbHttp);
        ultimoErro = null;
        break;
      } catch (err) {
        ultimoErro = err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!schemaOut || !schemaOut.operacional) {
      throw ultimoErro || new Error('Schema Cozinha não operacional');
    }

    await garantirSchemaCozinhaRoteamento(dbHttp);
    await garantirSchemaCozinhaCanais(dbHttp);
    await garantirSchemaOrigemPedidos(dbHttp);
    await garantirSchemaDestinoCozinhaPedidos(dbHttp);
    await garantirSchemaEstoqueEmpresaAsync(dbHttp);
    assert.equal(isCozinhaOperacional(), true);

    configAntes = configService.readConfig();
    configService.saveConfig({
      tipoImplantacao: 'ERP_SEM_FISCAL',
      modoOperacao: 'LOCAL',
      modulo_pedidos: true,
      habilitar_expedicao: false,
      habilitar_faturamento: false
    });
    assert.strictEqual(configService.recursoHabilitado, recursoFnOriginal);
    assert.equal(configService.recursoHabilitado('pedidos'), true);

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('66778899000155', 'Emp R3D Int', 'R3D', 1)
    `);
    empresaId = emp.lastID;

    const op = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_r3d_http', 'hash', 'operador', 'USUARIO', 1, 'Op Integrado')
    `);
    const admin = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_r3d_http', 'hash', 'admin', 'ADMIN', 1, 'Admin Integrado')
    `);
    await run(dbHttp, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [op.lastID, empresaId]);
    await run(dbHttp, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [admin.lastID, empresaId]);

    const un = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3D-PRINCIPAL', 1)
    `, [empresaId]);
    unidadeId = un.lastID;

    const adminUser = {
      id: admin.lastID, username: 'admin_r3d_http', role: 'admin', perfil: 'ADMIN', permissoes: []
    };
    await Canais.listarCanais({ user: adminUser, empresaId }, { db: dbHttp });
    const lista = await Canais.listarCanais({ user: adminUser, empresaId }, { db: dbHttp });
    const loja = lista.canais.find((c) => c.codigo === 'LOJA');
    assert.ok(loja, 'canal LOJA S07-3C');
    await Canais.definirDestinoCanal({
      user: adminUser,
      empresaId,
      canalIdRaw: loja.id,
      unidadeIdRaw: unidadeId,
      bodyEmpresaIdIgnored: 99999
    }, { db: dbHttp });

    const prod = await run(dbHttp, `
      INSERT INTO produtos (nome, nome_comercial, preco_venda, preco_pedido, unidade, unidade_estoque, ativo)
      VALUES ('Pastel S07-3D', 'Pastel S07-3D', 12.5, 12.5, 'UN', 'UN', 1)
    `);
    produtoId = prod.lastID;
    await EstoqueEmpresaService.criarRegistro({
      produtoId,
      empresaId,
      saldo_fiscal: 50,
      saldo_nao_fiscal: 0,
      estoque_atual: 50,
      reservado_fiscal: 0
    }, { db: dbHttp });

    tokenOp = jwt.sign({
      id: op.lastID, username: 'op_r3d_http', role: 'operador', perfil: 'USUARIO', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const pedidosRoutes = require('../../backend/rotas/pedidos');
    const app = express();
    app.use(express.json());
    app.use('/api/pedidos', verificarToken, exigirRecurso('pedidos'), pedidosRoutes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    assert.strictEqual(configService.recursoHabilitado, recursoFnOriginal);
    if (configAntes) {
      try {
        configService.saveConfig({
          modulo_pedidos: configAntes.modulo_pedidos,
          habilitar_expedicao: configAntes.habilitar_expedicao,
          habilitar_faturamento: configAntes.habilitar_faturamento,
          tipoImplantacao: configAntes.tipoImplantacao,
          modoOperacao: configAntes.modoOperacao
        });
      } catch (_e) { /* temp dir */ }
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('POST /api/pedidos: EQUIPE→LOJA, destino S07-3C gravado, sem despacho', async () => {
    assert.ok(String(process.env.DB_DIR).includes('cds-cozinha-s07-3d-'));
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB, undefined);

    const rodadasAntes = await get(dbHttp, `SELECT COUNT(*) AS n FROM cozinha_rodadas`).catch(() => ({ n: 0 }));
    const itensAntes = await get(dbHttp, `SELECT COUNT(*) AS n FROM cozinha_itens`).catch(() => ({ n: 0 }));

    const res = await requestJson('POST', '/api/pedidos', {
      token: tokenOp,
      headers: { 'Idempotency-Key': `s07-3d-int-${Date.now()}` },
      body: {
        itens: [{
          produto_id: produtoId,
          quantidade: 2,
          preco_unitario: 12.5,
          desconto_percentual: 0,
          subtotal: 25
        }],
        total: 25,
        origem_canal: 'IFOOD',
        canal: 'IFOOD',
        empresa_id: 99999,
        unidade_cozinha_destino_id: 88888,
        unidade_id: 88888,
        destino: { unidade_id: 88888 }
      }
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.ok(res.body.pedido && res.body.pedido.id);

    const pedido = res.body.pedido;
    assert.equal(pedido.origem_canal, 'EQUIPE', 'adaptador servidor EQUIPE preservado');
    assert.equal(Number(pedido.empresa_id), empresaId);
    assert.equal(Number(pedido.total), 25);
    assert.equal(pedido.itens.length, 1);
    assert.equal(Number(pedido.itens[0].quantidade), 2);
    assert.equal(Number(pedido.itens[0].produto_id), produtoId);

    assert.equal(pedido.cozinha_canal_codigo, 'LOJA', 'mapeamento EQUIPE→LOJA');
    assert.equal(Number(pedido.unidade_cozinha_destino_id), unidadeId, 'destino S07-3C gravado');
    assert.equal(pedido.cozinha_resolucao_status, 'RESOLVIDO');

    const lido = await repo.obterPorId(pedido.id, { db: dbHttp });
    assert.equal(lido.origem_canal, 'EQUIPE');
    assert.equal(lido.cozinha_canal_codigo, 'LOJA');
    assert.equal(Number(lido.unidade_cozinha_destino_id), unidadeId);
    assert.equal(lido.cozinha_resolucao_status, 'RESOLVIDO');
    assert.equal(Number(lido.total), 25);

    const rodadasDepois = await get(dbHttp, `SELECT COUNT(*) AS n FROM cozinha_rodadas`).catch(() => ({ n: 0 }));
    const itensDepois = await get(dbHttp, `SELECT COUNT(*) AS n FROM cozinha_itens`).catch(() => ({ n: 0 }));
    assert.equal(Number(rodadasDepois.n), Number(rodadasAntes.n || 0), 'sem despacho (rodadas)');
    assert.equal(Number(itensDepois.n), Number(itensAntes.n || 0), 'sem despacho (itens KDS)');
  });

  it('observabilidade: falha de resolução loga estruturado e não cancela pedido', async () => {
    const original = Resolucao.resolverDestinoPedido;
    const logs = [];
    const warnOriginal = console.warn;
    console.warn = (...args) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    Resolucao.resolverDestinoPedido = async () => {
      const err = new Error('falha forçada de resolução');
      err.codigo = 'RESOLUCAO_FORCADA_ERRO';
      throw err;
    };
    try {
      const out = await EntradaPedido.receber({
        canal: EntradaPedido.CanalOrigem.EQUIPE,
        body: {
          itens: [{
            produto_id: produtoId,
            quantidade: 1,
            preco_unitario: 12.5,
            desconto_percentual: 0,
            subtotal: 12.5
          }],
          total: 12.5
        },
        empresaId,
        operadorId: null,
        chaveIdempotencia: `s07-3d-obs-${Date.now()}`,
        db: dbHttp
      });
      assert.equal(out.success, true);
      assert.ok(out.pedido.id);
      assert.equal(out.pedido.origem_canal, 'EQUIPE');
      assert.equal(Number(out.pedido.total), 12.5);
      // Sem destino inventado a partir da falha
      assert.notEqual(out.pedido.cozinha_resolucao_status, 'RESOLVIDO');
      assert.ok(
        out.pedido.unidade_cozinha_destino_id == null
        || Number(out.pedido.unidade_cozinha_destino_id) !== 88888
      );

      const logLinha = logs.find((l) => l.includes('COZINHA_RESOLUCAO_DESTINO_FALHA'));
      assert.ok(logLinha, `log estruturado ausente: ${logs.join(' | ')}`);
      const payload = JSON.parse(logLinha);
      assert.equal(payload.evento, 'COZINHA_RESOLUCAO_DESTINO_FALHA');
      assert.equal(payload.codigo, 'RESOLUCAO_FORCADA_ERRO');
      assert.equal(Number(payload.pedido_id), Number(out.pedido.id));
      assert.equal(Number(payload.empresa_id), Number(empresaId));
      assert.equal(payload.origem_canal, 'EQUIPE');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'cliente_nome'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'cpf'), false);
    } finally {
      Resolucao.resolverDestinoPedido = original;
      console.warn = warnOriginal;
    }
  });

  it('código de PedidoOperacional não usa catch silencioso na resolução', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/services/pedido/PedidoOperacionalService.js'),
      'utf8'
    );
    assert.match(src, /COZINHA_RESOLUCAO_DESTINO_FALHA/);
    assert.match(src, /console\.warn\(JSON\.stringify/);
    assert.equal(/catch\s*\(\s*_\s*\)\s*\{\s*\/\*\s*preservação/.test(src), false);
    assert.equal(src.includes('despacharLote'), false);
  });
});

after(() => {
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
});
