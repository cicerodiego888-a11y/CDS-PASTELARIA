'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PedidoOperacionalService = require('../../backend/services/pedido/PedidoOperacionalService');
const PedidoConsumoEstoqueService = require('../../backend/services/pedido/PedidoConsumoEstoqueService');
const PedidoRepository = require('../../backend/services/pedido/PedidoRepository');
const PedidoService = require('../../backend/services/pedido/PedidoService');
const pedidoReservaPonteNucleo = require('../../backend/services/estoque/pedidoReservaPonteNucleo');
const VendaPagamentoService = require('../../backend/services/vendas/VendaPagamentoService');
const MotorComercial = require('../../backend/motores/comercial');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const estoqueSaldosPublico = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const reservasPublico = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const MTS = require('../../backend/motores/mts');
const PedidoEstoqueAuditoria = require('../../backend/motores/comercial/PedidoEstoqueAuditoria');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const { garantirSchemaFichaPersonalizacaoAsync } = require('../../backend/services/produtos/personalizacaoIngredientesSchema');

const CNPJ = '11222333000181';

function openDb(filename = ':memory:') {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (err) => (err ? reject(err) : resolve(db)));
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
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function criarProduto(db, {
  nome,
  unidade,
  tipo = 'COMERCIAL',
  controlaEstoque = 1,
  saldoFiscal = 0,
  saldoNaoFiscal = 0,
  utilizaVolume = 0,
  volumeValor = null,
  volumeUnidade = null
}) {
  const produto = await run(
    db,
    `INSERT INTO produtos (
      nome, unidade, tipo_operacional, controla_estoque, saldo_fiscal,
      saldo_nao_fiscal, estoque_atual, utiliza_volume, volume_valor, volume_unidade
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      nome,
      unidade,
      tipo,
      controlaEstoque,
      saldoFiscal,
      saldoNaoFiscal,
      saldoFiscal + saldoNaoFiscal,
      utilizaVolume,
      volumeValor,
      volumeUnidade
    ]
  );
  return produto.lastID;
}

async function adicionarSaldoEmpresa(db, produtoId, empresaId, saldoFiscal, saldoNaoFiscal = 0) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: saldoNaoFiscal,
    estoque_atual: saldoFiscal + saldoNaoFiscal
  }, { db });
}

async function garantirSchemasConsumo(db) {
  await PedidoConsumoEstoqueService.garantirSchema(db);
  await reservasPublico.garantirSchemaReservas(db);
  await MTS.garantirSchema(db);
  await PedidoEstoqueAuditoria.garantirSchema(db);
}

async function setup(filename) {
  const db = await openDb(filename);
  await run(db, 'PRAGMA foreign_keys = ON');
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      nome TEXT NOT NULL,
      nome_comercial TEXT,
      unidade TEXT NOT NULL,
      tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
      ativo INTEGER NOT NULL DEFAULT 1,
      controla_estoque INTEGER NOT NULL DEFAULT 1,
      saldo_fiscal REAL NOT NULL DEFAULT 0,
      saldo_nao_fiscal REAL NOT NULL DEFAULT 0,
      reservado_fiscal REAL NOT NULL DEFAULT 0,
      reservado_nao_fiscal REAL NOT NULL DEFAULT 0,
      estoque_atual REAL NOT NULL DEFAULT 0,
      utiliza_conversao INTEGER NOT NULL DEFAULT 0,
      unidade_estoque TEXT,
      utiliza_volume INTEGER NOT NULL DEFAULT 0,
      volume_valor REAL,
      volume_unidade TEXT,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      data_pedido TEXT,
      cliente_id INTEGER,
      total REAL NOT NULL,
      desconto REAL DEFAULT 0,
      frete REAL DEFAULT 0,
      status TEXT NOT NULL,
      venda_id INTEGER,
      representante_id INTEGER,
      representante_nome TEXT,
      observacao TEXT,
      operador_id INTEGER,
      empresa_id INTEGER NOT NULL,
      updated_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL,
      desconto_percentual REAL DEFAULT 0,
      subtotal REAL NOT NULL,
      tipo_venda TEXT DEFAULT 'PESO',
      classificacao_operacional_snapshot TEXT,
      produto_codigo_snapshot TEXT,
      produto_nome_snapshot TEXT,
      produto_nome_pedido_snapshot TEXT,
      produto_unidade_snapshot TEXT,
      preco_venda_snapshot REAL,
      preco_pedido_snapshot REAL,
      preco_sugerido_snapshot REAL,
      origem_preco_sugerido TEXT
    )
  `);
  await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT, nome TEXT)');
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaFichaPersonalizacaoAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);
  const empresa = await EmpresaService.criarEmpresa({
    cnpj: CNPJ,
    razao_social: 'Empresa de teste'
  }, { db });
  return { db, empresa };
}

async function criarPedido(db, empresaId, itens, chave = crypto.randomUUID(), supervisorToken = null) {
  const body = {
    tipo: 'pedido',
    status: 'PEDIDO',
    desconto: 0,
    frete: 0,
    total: itens.reduce((total, item) => total + item.subtotal, 0),
    itens
  };
  if (supervisorToken != null) body.supervisor_token = supervisorToken;
  return PedidoOperacionalService.criar(body, 7, {
    db,
    empresaId,
    chaveIdempotencia: chave,
    exigirChaveIdempotencia: true
  });
}

const crypto = require('crypto');

describe('Consumo de estoque por Pedido', { concurrency: false }, () => {
  it('rejeita ficha ativa vazia sem persistir pedido e permite retry após corrigir a ficha', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Pastel do Cheff',
        unidade: 'UN',
        saldoFiscal: 5
      });
      const insumo = await criarProduto(db, {
        nome: 'Massa',
        unidade: 'G',
        tipo: 'INSUMO',
        saldoFiscal: 100
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      await adicionarSaldoEmpresa(db, insumo, empresa.id, 100);

      await assert.rejects(
        FichaTecnicaService.salvar(produto, { ativo: 1, itens: [] }, { db }),
        (err) => err && err.code === 'FICHA_TECNICA_VAZIA' && err.statusCode === 400
      );

      await run(db, 'INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)', [produto]);
      const itens = [{ produto_id: produto, quantidade: 2, preco_unitario: 5, subtotal: 10 }];
      const chave = crypto.randomUUID();
      await assert.rejects(
        criarPedido(db, empresa.id, itens, chave),
        (err) => err && err.code === 'FICHA_TECNICA_VAZIA'
          && err.statusCode === 400
          && /não possui ingredientes/.test(err.message)
      );

      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 0);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedido_estoque_consumos')).total), 0);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 5);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: insumo, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 100);

      await FichaTecnicaService.salvar(produto, {
        ativo: 1,
        itens: [{ insumo_id: insumo, quantidade: 4, unidade: 'G' }]
      }, { db });
      const resultado = await criarPedido(db, empresa.id, itens, chave);
      assert.equal(resultado.pedido.total, 10);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 1);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedido_estoque_consumos')).total), 1);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 5);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: insumo, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 92);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('distingue produto sem ficha de ficha inativa', async () => {
    const { db } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Produto sem ficha',
        unidade: 'UN'
      });
      const semFicha = await FichaTecnicaService.obterPorProdutoId(produto, { db });
      assert.equal(semFicha.existe, false);
      assert.equal(Number(semFicha.ativo), 0);
      assert.deepEqual(semFicha.itens, []);

      const insumo = await criarProduto(db, {
        nome: 'Insumo de ficha inativa',
        unidade: 'G',
        tipo: 'INSUMO'
      });
      const inativa = await FichaTecnicaService.salvar(produto, {
        ativo: 0,
        itens: [{ insumo_id: insumo, quantidade: 2, unidade: 'G' }]
      }, { db });
      assert.equal(inativa.existe, true);
      assert.equal(Number(inativa.ativo), 0);
      assert.equal(inativa.itens.length, 1);

      const segundoInsumo = await criarProduto(db, {
        nome: 'Segundo insumo válido',
        unidade: 'G',
        tipo: 'INSUMO'
      });
      const ativa = await FichaTecnicaService.salvar(produto, {
        ativo: 1,
        itens: [
          { insumo_id: insumo, quantidade: 2, unidade: 'G' },
          { insumo_id: segundoInsumo, quantidade: 3, unidade: 'G' }
        ]
      }, { db });
      assert.equal(ativa.existe, true);
      assert.equal(Number(ativa.ativo), 1);
      assert.deepEqual(
        ativa.itens.map((item) => Number(item.insumo_id)),
        [insumo, segundoInsumo]
      );
    } finally {
      await closeDb(db);
    }
  });

  it('produto configurado sem ficha não consome componentes de ficha antiga', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Refrigerante sem consumo de ficha',
        unidade: 'UN',
        saldoFiscal: 5
      });
      const insumo = await criarProduto(db, {
        nome: 'Ingrediente legado',
        unidade: 'UN',
        tipo: 'INSUMO',
        saldoFiscal: 20
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      await adicionarSaldoEmpresa(db, insumo, empresa.id, 20);
      await FichaTecnicaService.salvar(produto, {
        ativo: 1,
        itens: [{ insumo_id: insumo, quantidade: 2, unidade: 'UN' }]
      }, { db });
      await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 0 WHERE id = ?', [produto]);

      const pedido = await criarPedido(db, empresa.id, [
        { produto_id: produto, quantidade: 1, preco_unitario: 4, subtotal: 4 }
      ]);
      assert.equal(pedido.pedido.total, 4);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: insumo, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 20);

      const cocaCola = await criarProduto(db, {
        nome: 'Coca Cola 2L',
        unidade: 'UN',
        saldoFiscal: 5
      });
      await adicionarSaldoEmpresa(db, cocaCola, empresa.id, 5);
      await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 0 WHERE id = ?', [cocaCola]);
      const pedidoSimples = await criarPedido(db, empresa.id, [
        { produto_id: cocaCola, quantidade: 1, preco_unitario: 8, subtotal: 8 }
      ]);
      assert.equal(pedidoSimples.pedido.total, 8);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('produto configurado para usar ficha sem cabeçalho é rejeitado sem gravar pedido', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Produto com ficha obrigatória ausente',
        unidade: 'UN',
        saldoFiscal: 5
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [produto]);

      await assert.rejects(
        criarPedido(db, empresa.id, [
          { produto_id: produto, quantidade: 1, preco_unitario: 4, subtotal: 4 }
        ]),
        (err) => err && err.code === 'FICHA_TECNICA_NAO_ENCONTRADA'
      );
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 0);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 5);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('produto configurado com ficha válida consome seus ingredientes', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Produto com ficha configurada',
        unidade: 'UN',
        saldoFiscal: 5
      });
      const insumo = await criarProduto(db, {
        nome: 'Componente obrigatório',
        unidade: 'G',
        tipo: 'INSUMO',
        saldoFiscal: 30
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      await adicionarSaldoEmpresa(db, insumo, empresa.id, 30);
      await FichaTecnicaService.salvar(produto, {
        ativo: 1,
        itens: [{ insumo_id: insumo, quantidade: 3, unidade: 'G' }]
      }, { db });
      await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [produto]);

      await criarPedido(db, empresa.id, [
        { produto_id: produto, quantidade: 2, preco_unitario: 4, subtotal: 8 }
      ]);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: insumo, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 24);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('rejeita referência órfã sem ignorar ingredientes válidos e faz rollback do pedido', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Produto com ficha inconsistente',
        unidade: 'UN',
        saldoFiscal: 5
      });
      const insumo = await criarProduto(db, {
        nome: 'Insumo válido',
        unidade: 'G',
        tipo: 'INSUMO',
        saldoFiscal: 100
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      await adicionarSaldoEmpresa(db, insumo, empresa.id, 100);
      const ficha = await run(
        db,
        'INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)',
        [produto]
      );
      await run(
        db,
        'INSERT INTO ficha_tecnica_itens (ficha_tecnica_id, insumo_id, quantidade, unidade) VALUES (?, ?, ?, ?)',
        [ficha.lastID, insumo, 4, 'G']
      );
      await run(db, 'PRAGMA foreign_keys = OFF');
      const orphan = await run(
        db,
        'INSERT INTO ficha_tecnica_itens (ficha_tecnica_id, insumo_id, quantidade, unidade) VALUES (?, ?, ?, ?)',
        [ficha.lastID, 999999, 1, 'G']
      );
      await run(db, 'PRAGMA foreign_keys = ON');

      await assert.rejects(
        FichaTecnicaService.obterPorProdutoId(produto, { db }),
        (err) => err && err.code === 'FICHA_TECNICA_INTEGRIDADE'
          && err.message.includes(`item ${orphan.lastID}`)
          && err.message.includes('insumo 999999')
      );
      await assert.rejects(
        criarPedido(db, empresa.id, [
          { produto_id: produto, quantidade: 1, preco_unitario: 5, subtotal: 5 }
        ]),
        (err) => err && err.code === 'FICHA_TECNICA_INTEGRIDADE'
          && err.message.includes(`item ${orphan.lastID}`)
      );

      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 0);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos_itens')).total), 0);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedido_estoque_consumos')).total), 0);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: insumo, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 100);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('compartilha a ficha do produto sem compartilhar saldo entre empresas', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const outraEmpresa = await EmpresaService.criarEmpresa({
        cnpj: '04252011000110',
        razao_social: 'Outra empresa'
      }, { db });
      const produto = await criarProduto(db, {
        nome: 'Pastel',
        unidade: 'UN',
        saldoFiscal: 10
      });
      const insumo = await criarProduto(db, {
        nome: 'Massa',
        unidade: 'G',
        tipo: 'INSUMO',
        saldoFiscal: 50
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 3);
      await adicionarSaldoEmpresa(db, produto, outraEmpresa.id, 7);
      await adicionarSaldoEmpresa(db, insumo, empresa.id, 20);
      await adicionarSaldoEmpresa(db, insumo, outraEmpresa.id, 30);
      await FichaTecnicaService.salvar(produto, {
        ativo: 1,
        itens: [{ insumo_id: insumo, quantidade: 3, unidade: 'G' }]
      }, { db });

      const itens = [{ produto_id: produto, quantidade: 2, preco_unitario: 5, subtotal: 10 }];
      await criarPedido(db, empresa.id, itens);
      await criarPedido(db, outraEmpresa.id, itens);

      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: insumo, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 14);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: insumo, empresaId: outraEmpresa.id },
        { db }
      )).saldo_fiscal), 24);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 3);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: outraEmpresa.id },
        { db }
      )).saldo_fiscal), 7);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('persiste a personalização, recalcula adicionais e consome somente ingredientes selecionados', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, { nome: 'Pastel fiscal', unidade: 'UN', saldoFiscal: 5 });
      const massa = await criarProduto(db, { nome: 'Massa', unidade: 'UN', tipo: 'INSUMO', saldoFiscal: 50 });
      const queijo = await criarProduto(db, { nome: 'Queijo', unidade: 'UN', tipo: 'INSUMO', saldoFiscal: 30 });
      const azeitona = await criarProduto(db, { nome: 'Azeitona', unidade: 'UN', tipo: 'INSUMO', saldoFiscal: 20 });
      await run(db, 'UPDATE produtos SET nome_comercial = ?, permite_personalizacao_ingredientes = 1 WHERE id = ?', [
        'Pastel da Casa',
        produto
      ]);
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      await adicionarSaldoEmpresa(db, massa, empresa.id, 50);
      await adicionarSaldoEmpresa(db, queijo, empresa.id, 30);
      await adicionarSaldoEmpresa(db, azeitona, empresa.id, 20);
      await FichaTecnicaService.salvar(produto, {
        ativo: 1,
        itens: [
          { insumo_id: massa, quantidade: 2, unidade: 'UN', classificacao_comercial: 'OBRIGATORIO_OCULTO' },
          { insumo_id: queijo, quantidade: 1, unidade: 'UN', classificacao_comercial: 'OPCIONAL_COM_ADICIONAL', preco_adicional: 1.5 },
          { insumo_id: azeitona, quantidade: 1, unidade: 'UN', classificacao_comercial: 'OPCIONAL' }
        ]
      }, { db });

      const item = {
        produto_id: produto,
        quantidade: 2,
        preco_unitario: 999,
        subtotal: 1998,
        preco_base_unitario: 4,
        ingredientes_selecionados: [queijo]
      };
      const orcamento = await PedidoOperacionalService.criar({
        tipo: 'orcamento',
        total: 11,
        itens: [item]
      }, 7, { db, empresaId: empresa.id });
      let pedido = await PedidoRepository.obterPorId(orcamento.pedido.id, { db });
      assert.equal(pedido.status, 'ORCAMENTO');
      assert.equal(pedido.itens[0].produto_nome, 'Pastel da Casa');
      assert.equal(Number(pedido.itens[0].personalizacao_ingredientes_snapshot), 1);
      assert.equal(Number(pedido.itens[0].preco_unitario), 5.5);
      assert.equal(Number(pedido.itens[0].preco_base_unitario_snapshot), 4);
      assert.equal(Number(pedido.itens[0].preco_adicionais_unitario_snapshot), 1.5);
      assert.equal(pedido.itens[0].ingredientes_personalizados.length, 3);
      assert.equal(
        Number(pedido.itens[0].ingredientes_personalizados.find((row) => Number(row.insumo_id) === queijo).selecionado),
        1
      );
      assert.equal(
        Number(pedido.itens[0].ingredientes_personalizados.find((row) => Number(row.insumo_id) === azeitona).selecionado),
        0
      );

      await PedidoOperacionalService.atualizar(orcamento.pedido.id, {
        total: 11,
        itens: [{
          id: pedido.itens[0].id,
          produto_id: produto,
          quantidade: 2,
          preco_unitario: 5.5,
          subtotal: 11,
          preco_base_unitario: 4,
          ingredientes_selecionados: [queijo]
        }]
      }, { db, empresaId: empresa.id });
      await PedidoOperacionalService.converterParaPedido(
        orcamento.pedido.id,
        {},
        7,
        { db, empresaId: empresa.id }
      );

      pedido = await PedidoRepository.obterPorId(orcamento.pedido.id, { db });
      assert.equal(Number(pedido.total), 11);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: massa, empresaId: empresa.id }, { db }
      )).saldo_fiscal), 46);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: queijo, empresaId: empresa.id }, { db }
      )).saldo_fiscal), 28);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: azeitona, empresaId: empresa.id }, { db }
      )).saldo_fiscal), 20);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id }, { db }
      )).saldo_fiscal), 5);
      assert.equal(Number((await get(
        db,
        'SELECT COUNT(*) AS total FROM pedido_estoque_consumo_itens WHERE pedido_id = ?',
        [orcamento.pedido.id]
      )).total), 2);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('consome e reserva corretamente 0,2 g de ingrediente com estoque em KG', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Pastel com consumo subgrama',
        unidade: 'UN'
      });
      const carne = await criarProduto(db, {
        nome: 'Carne de Sol',
        unidade: 'KG',
        tipo: 'INSUMO',
        saldoFiscal: 0.001
      });
      await run(
        db,
        'UPDATE produtos SET permite_personalizacao_ingredientes = 1 WHERE id = ?',
        [produto]
      );
      await adicionarSaldoEmpresa(db, carne, empresa.id, 0.001);
      await FichaTecnicaService.salvar(produto, {
        ativo: 1,
        itens: [{
          insumo_id: carne,
          quantidade: 0.2,
          unidade: 'G',
          classificacao_comercial: 'OPCIONAL_COM_ADICIONAL',
          preco_adicional: 0.5
        }]
      }, { db });

      const pedido = await criarPedido(db, empresa.id, [{
        produto_id: produto,
        quantidade: 1,
        preco_unitario: 1.5,
        subtotal: 1.5,
        preco_base_unitario: 1,
        ingredientes_selecionados: [carne]
      }]);
      const consumo = await get(
        db,
        `SELECT quantidade, quantidade_fiscal, unidade
         FROM pedido_estoque_consumo_itens
         WHERE pedido_id = ? AND insumo_id = ?`,
        [pedido.pedido.id, carne]
      );
      assert.equal(Number(consumo.quantidade), 0.0002);
      assert.equal(Number(consumo.quantidade_fiscal), 0.0002);
      assert.equal(String(consumo.unidade).toUpperCase(), 'KG');
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: carne, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 0.0008);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: carne, empresaId: empresa.id },
        { db }
      )).reservado_fiscal), 0);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('rejeita seleção inválida e reverte pedido e snapshots se o consumo não puder ser concluído', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, { nome: 'Produto personalizável', unidade: 'UN' });
      const massa = await criarProduto(db, { nome: 'Massa', unidade: 'UN', tipo: 'INSUMO' });
      const recheio = await criarProduto(db, { nome: 'Recheio', unidade: 'UN', tipo: 'INSUMO' });
      await run(db, 'UPDATE produtos SET permite_personalizacao_ingredientes = 1 WHERE id = ?', [produto]);
      await adicionarSaldoEmpresa(db, produto, empresa.id, 0);
      await adicionarSaldoEmpresa(db, massa, empresa.id, 0);
      await adicionarSaldoEmpresa(db, recheio, empresa.id, 0);
      await FichaTecnicaService.salvar(produto, {
        ativo: 1,
        itens: [
          { insumo_id: massa, quantidade: 1, unidade: 'UN', classificacao_comercial: 'OBRIGATORIO_OCULTO' },
          { insumo_id: recheio, quantidade: 1, unidade: 'UN', classificacao_comercial: 'OPCIONAL' }
        ]
      }, { db });

      const chave = crypto.randomUUID();
      const criarPersonalizado = (selecionados) => PedidoOperacionalService.criar({
        tipo: 'pedido',
        total: 2,
        itens: [{
          produto_id: produto,
          quantidade: 1,
          preco_unitario: 2,
          subtotal: 2,
          preco_base_unitario: 2,
          ingredientes_selecionados: selecionados
        }]
      }, 7, {
        db,
        empresaId: empresa.id,
        chaveIdempotencia: chave,
        exigirChaveIdempotencia: true
      });

      await assert.rejects(
        criarPersonalizado([999999]),
        (err) => err && err.code === 'INGREDIENTE_NAO_PERSONALIZAVEL'
      );
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 0);

      await assert.rejects(criarPersonalizado([recheio]));
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 0);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos_itens')).total), 0);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedido_item_ingredientes')).total), 0);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedido_estoque_consumos')).total), 0);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: massa, empresaId: empresa.id }, { db }
      )).saldo_fiscal), 0);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: recheio, empresaId: empresa.id }, { db }
      )).saldo_fiscal), 0);

      await run(
        db,
        `UPDATE estoque_empresa
            SET saldo_fiscal = 1, estoque_atual = 1
          WHERE empresa_id = ? AND produto_id IN (?, ?)`,
        [empresa.id, massa, recheio]
      );
      await run(
        db,
        `UPDATE produtos
            SET saldo_fiscal = 1, estoque_atual = 1
          WHERE id IN (?, ?)`,
        [massa, recheio]
      );
      const recuperado = await criarPersonalizado([recheio]);
      const repetido = await criarPersonalizado([recheio]);
      assert.equal(repetido.idempotente, true);
      assert.equal(repetido.pedido.id, recuperado.pedido.id);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 1);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedido_item_ingredientes')).total), 2);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: massa, empresaId: empresa.id }, { db }
      )).saldo_fiscal), 0);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: recheio, empresaId: empresa.id }, { db }
      )).saldo_fiscal), 0);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('consome ingrediente da ficha e volume comercial convertido, sem baixar o produto com ficha', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const pastel = await criarProduto(db, {
        nome: 'Pastel do Cheff',
        unidade: 'UN',
        saldoFiscal: 20
      });
      const queijo = await criarProduto(db, {
        nome: 'Queijo',
        unidade: 'G',
        tipo: 'INSUMO',
        saldoFiscal: 1000
      });
      const carne = await criarProduto(db, {
        nome: 'Carne',
        unidade: 'G',
        tipo: 'INSUMO',
        saldoFiscal: 500
      });
      const refrigerante = await criarProduto(db, {
        nome: 'Refrigerante 2 L',
        unidade: 'ML',
        saldoFiscal: 6000,
        utilizaVolume: 1,
        volumeValor: 2,
        volumeUnidade: 'L'
      });
      await adicionarSaldoEmpresa(db, pastel, empresa.id, 20);
      await adicionarSaldoEmpresa(db, queijo, empresa.id, 1000);
      await adicionarSaldoEmpresa(db, carne, empresa.id, 500);
      await adicionarSaldoEmpresa(db, refrigerante, empresa.id, 6000);
      await FichaTecnicaService.salvar(pastel, {
        ativo: 1,
        itens: [
          { insumo_id: queijo, quantidade: 50, unidade: 'G' },
          { insumo_id: carne, quantidade: 20, unidade: 'G' }
        ]
      }, { db });

      const resultado = await criarPedido(db, empresa.id, [
        { produto_id: pastel, quantidade: 2, preco_unitario: 21.99, subtotal: 43.98 },
        { produto_id: refrigerante, quantidade: 1, preco_unitario: 18, subtotal: 18 }
      ]);
      assert.equal(resultado.pedido.total, 61.98);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo({ produtoId: queijo, empresaId: empresa.id }, { db })).saldo_fiscal), 900);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo({ produtoId: carne, empresaId: empresa.id }, { db })).saldo_fiscal), 460);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo({ produtoId: refrigerante, empresaId: empresa.id }, { db })).saldo_fiscal), 4000);
      assert.equal(Number((await get(
        db,
        'SELECT saldo_fiscal FROM produtos WHERE id = ?',
        [pastel]
      )).saldo_fiscal), 20);

      const detalhes = await all(
        db,
        'SELECT produto_id, insumo_id, origem_requisito, quantidade, unidade FROM pedido_estoque_consumo_itens WHERE pedido_id = ? ORDER BY id',
        [resultado.pedido.id]
      );
      assert.equal(detalhes.length, 3);
      assert.equal(detalhes[0].origem_requisito, 'FICHA_TECNICA');
      assert.equal(Number(detalhes[0].insumo_id), queijo);
      assert.equal(Number(detalhes[0].quantidade), 100);
      assert.equal(String(detalhes[0].unidade).toUpperCase(), 'G');
      assert.equal(detalhes[1].origem_requisito, 'FICHA_TECNICA');
      assert.equal(Number(detalhes[1].insumo_id), carne);
      assert.equal(Number(detalhes[1].quantidade), 40);
      assert.equal(detalhes[2].origem_requisito, 'PRODUTO_SIMPLES');
      assert.equal(Number(detalhes[2].quantidade), 2000);
      assert.equal(String(detalhes[2].unidade).toUpperCase(), 'ML');

      const creditoVenda = await pedidoReservaPonteNucleo.obterCreditoReservaPedido(
        resultado.pedido.id,
        { db }
      );
      assert.equal(creditoVenda.consumo_confirmado, true);
      assert.equal(Number(creditoVenda.por_produto[refrigerante]), 2000);
      assert.equal(Number(creditoVenda.por_produto[pastel]), 2);
      const pagamentoSource = fs.readFileSync(
        path.resolve(__dirname, '../../backend/services/vendas/VendaPagamentoService.js'),
        'utf8'
      );
      assert.match(
        pagamentoSource,
        /const pedidoJaConsumido = Boolean\(creditoReserva && creditoReserva\.consumo_confirmado\);\s*opcoesBaixaEstoque\.pedidoJaConsumido = pedidoJaConsumido;/
      );
      assert.match(
        pagamentoSource,
        /if \(opcoes\.pedidoJaConsumido\)\s*\{\s*return callback\(null\);\s*\}/
      );
      const faturamentoSource = fs.readFileSync(
        path.resolve(__dirname, '../../backend/services/faturamento/FaturamentoService.js'),
        'utf8'
      );
      const inicioFinalizacao = faturamentoSource.indexOf('async function finalizarPedidoComVenda');
      const proximaFuncao = faturamentoSource.indexOf('\nasync function ', inicioFinalizacao + 1);
      assert.ok(inicioFinalizacao >= 0 && proximaFuncao > inicioFinalizacao);
      assert.match(
        faturamentoSource.slice(inicioFinalizacao, proximaFuncao),
        /BEGIN IMMEDIATE[\s\S]*?consumirReservasPedidoNaVenda\(pedidoId, vendaId, \{\s*db: transacaoDb,[\s\S]*?COMMIT[\s\S]*?ROLLBACK/
      );
      for (const produtoId of [refrigerante, pastel]) {
        await new Promise((resolve, reject) => {
          VendaPagamentoService.reduzirEstoqueDistribuido(
            1,
            produtoId,
            produtoId === refrigerante ? 1 : 2,
            0,
            (err) => (err ? reject(err) : resolve()),
            { db, pedidoJaConsumido: creditoVenda.consumo_confirmado }
          );
        });
      }
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: refrigerante, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 4000);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: pastel, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 20);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: queijo, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 900);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: carne, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 460);

      const reservasAtivas = await get(
        db,
        `SELECT COUNT(*) AS total FROM pedido_estoque_reservas
         WHERE pedido_id = ? AND status = 'ATIVA'`,
        [resultado.pedido.id]
      );
      assert.equal(Number(reservasAtivas.total), 0);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('mantém a baixa normal para Pedido histórico sem ledger de consumo', async () => {
    const { db, empresa } = await setup();
    try {
      await garantirSchemasConsumo(db);
      await run(db, 'ALTER TABLE produtos ADD COLUMN controlar_validade INTEGER NOT NULL DEFAULT 0');
      const produto = await criarProduto(db, {
        nome: 'Produto legado',
        unidade: 'UN',
        saldoFiscal: 8
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 8);

      const creditoLegado = await pedidoReservaPonteNucleo.obterCreditoReservaPedido(999, { db });
      assert.equal(creditoLegado.consumo_confirmado, false);
      await new Promise((resolve, reject) => {
        VendaPagamentoService.reduzirEstoqueDistribuido(
          null,
          produto,
          2,
          0,
          (err) => (err ? reject(err) : resolve()),
          {
            db,
            empresaId: empresa.id,
            usuarioId: 7,
            exigirEmpresa: true,
            pedidoJaConsumido: creditoLegado.consumo_confirmado
          }
        );
      });

      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 6);
    } finally {
      await closeDb(db);
    }
  });

  it('reconhece o mesmo POST idempotente sem repetir débito', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Água',
        unidade: 'UN',
        saldoFiscal: 5
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      const itens = [{ produto_id: produto, quantidade: 2, preco_unitario: 3, subtotal: 6 }];
      const chave = crypto.randomUUID();
      const primeiro = await criarPedido(db, empresa.id, itens, chave);
      const segundo = await criarPedido(db, empresa.id, itens, chave);
      await assert.rejects(
        criarPedido(db, empresa.id, [
          { produto_id: produto, quantidade: 1, preco_unitario: 3, subtotal: 3 }
        ], chave),
        (err) => err && err.codigo === 'CHAVE_IDEMPOTENCIA_REUTILIZADA'
      );
      await run(db, 'BEGIN IMMEDIATE');
      const pedidoPersistido = await PedidoRepository.obterPorId(primeiro.pedido.id, { db });
      const repeticaoConsumo = await PedidoConsumoEstoqueService.registrarConsumo({
        db,
        pedidoId: primeiro.pedido.id,
        empresaId: empresa.id,
        itens: pedidoPersistido.itens,
        jaEmTransacao: true
      });
      await run(db, 'COMMIT');
      const saldo = await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      );
      assert.equal(segundo.idempotente, true);
      assert.equal(segundo.pedido.id, primeiro.pedido.id);
      assert.equal(repeticaoConsumo.ja_consumido, true);
      assert.equal(Number(saldo.saldo_fiscal), 3);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 1);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('usa apresentação principal de venda e bloqueia conversão sem relação MUC', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      await run(db, `
        CREATE TABLE produto_embalagens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          produto_id INTEGER NOT NULL,
          tipo TEXT NOT NULL,
          quantidade REAL NOT NULL DEFAULT 1,
          unidade TEXT,
          ativa INTEGER NOT NULL DEFAULT 1,
          compra INTEGER NOT NULL DEFAULT 1,
          venda INTEGER NOT NULL DEFAULT 1,
          principal INTEGER NOT NULL DEFAULT 0
        )
      `);
      const produto = await criarProduto(db, {
        nome: 'Garrafa 2 L',
        unidade: 'ML',
        saldoFiscal: 5000
      });
      await run(
        db,
        `UPDATE produtos SET utiliza_conversao = 1, unidade_estoque = 'ML' WHERE id = ?`,
        [produto]
      );
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5000);
      await run(
        db,
        `INSERT INTO produto_embalagens
          (produto_id, tipo, quantidade, unidade, venda, principal)
         VALUES (?, 'UN', 2000, 'ML', 1, 1)`,
        [produto]
      );
      const pedido = await criarPedido(db, empresa.id, [
        { produto_id: produto, quantidade: 2, preco_unitario: 8, subtotal: 16 }
      ]);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 1000);
      const linha = await get(
        db,
        'SELECT quantidade, unidade FROM pedido_estoque_consumo_itens WHERE pedido_id = ?',
        [pedido.pedido.id]
      );
      assert.equal(Number(linha.quantidade), 4000);
      assert.equal(String(linha.unidade).toUpperCase(), 'ML');

      const produtoSemRelacao = await criarProduto(db, {
        nome: 'Embalagem sem conversão',
        unidade: 'ML',
        saldoFiscal: 5000
      });
      await run(
        db,
        `UPDATE produtos SET utiliza_conversao = 1, unidade_estoque = 'ML' WHERE id = ?`,
        [produtoSemRelacao]
      );
      await adicionarSaldoEmpresa(db, produtoSemRelacao, empresa.id, 5000);
      await run(
        db,
        `INSERT INTO produto_embalagens
          (produto_id, tipo, quantidade, unidade, venda, principal)
         VALUES (?, 'UN', 0, NULL, 1, 1)`,
        [produtoSemRelacao]
      );
      await assert.rejects(
        criarPedido(db, empresa.id, [
          { produto_id: produtoSemRelacao, quantidade: 1, preco_unitario: 8, subtotal: 8 }
        ]),
        (err) => err && err.codigo === 'CONVERSAO_NAO_DISPONIVEL'
      );
      assert.equal(Number((await get(
        db,
        'SELECT saldo_fiscal FROM produtos WHERE id = ?',
        [produtoSemRelacao]
      )).saldo_fiscal), 5000);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('transfere MTS sob autorização, rejeita supervisor inválido e reconhece retry', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    const confirmarOriginal = MotorComercial.confirmarPedidoFiscal;
    configService.recursoHabilitado = () => true;
    MotorComercial.confirmarPedidoFiscal = (params, deps = {}) => confirmarOriginal(params, {
      ...deps,
      verificarSupervisorToken: async (token) => {
        if (token === 'rejeitado') throw new Error('Token inválido no teste.');
        return { id: 99, username: 'supervisor-teste', perfil: 'SUPERVISOR' };
      }
    });
    const { db, empresa } = await setup();
    try {
      await garantirSchemasConsumo(db);
      const produtoFinal = await criarProduto(db, {
        nome: 'Pastel com três insumos',
        unidade: 'UN',
        saldoFiscal: 5
      });
      const insumos = [
        { nome: 'Insumo A', quantidade: 2 },
        { nome: 'Insumo B', quantidade: 3 },
        { nome: 'Insumo C', quantidade: 4 }
      ];
      const produtosInsumos = [];
      for (const insumo of insumos) {
        const produto = await criarProduto(db, {
          nome: insumo.nome,
          unidade: 'G',
          tipo: 'INSUMO',
          saldoNaoFiscal: 20
        });
        await adicionarSaldoEmpresa(db, produto, empresa.id, 0, 20);
        produtosInsumos.push({ ...insumo, produto });
      }
      await FichaTecnicaService.salvar(produtoFinal, {
        ativo: 1,
        itens: produtosInsumos.map((insumo) => ({
          insumo_id: insumo.produto,
          quantidade: insumo.quantidade,
          unidade: 'G'
        }))
      }, { db });

      const itens = [
        { produto_id: produtoFinal, quantidade: 1, preco_unitario: 30, subtotal: 30 }
      ];
      const chave = crypto.randomUUID();
      await assert.rejects(
        criarPedido(db, empresa.id, itens, crypto.randomUUID()),
        (err) => err && err.codigo === 'REQUER_AUTORIZACAO_SUPERVISOR'
      );
      await assert.rejects(
        criarPedido(db, empresa.id, itens, crypto.randomUUID(), 'rejeitado'),
        (err) => err && err.codigo === 'AUTORIZACAO_REJEITADA'
      );
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 0);
      for (const insumo of produtosInsumos) {
        const saldo = await EstoqueEmpresaService.consultarSaldo(
          { produtoId: insumo.produto, empresaId: empresa.id },
          { db }
        );
        assert.equal(Number(saldo.saldo_fiscal), 0);
        assert.equal(Number(saldo.saldo_nao_fiscal), 20);
      }

      const criado = await criarPedido(db, empresa.id, itens, chave, 'aprovado');
      const repetido = await criarPedido(db, empresa.id, itens, chave, 'aprovado');
      assert.equal(repetido.idempotente, true);
      assert.equal(repetido.pedido.id, criado.pedido.id);
      const movimentos = await all(
        db,
        'SELECT produto_id, origem, destino, quantidade FROM movimentos_transferencia_saldos ORDER BY produto_id'
      );
      assert.equal(movimentos.length, 3);
      for (const insumo of produtosInsumos) {
        const movimento = movimentos.find((row) => Number(row.produto_id) === insumo.produto);
        assert.ok(movimento);
        assert.equal(movimento.origem, TipoSaldo.NAO_FISCAL);
        assert.equal(movimento.destino, TipoSaldo.FISCAL);
        assert.equal(Number(movimento.quantidade), insumo.quantidade);
        const saldo = await EstoqueEmpresaService.consultarSaldo(
          { produtoId: insumo.produto, empresaId: empresa.id },
          { db }
        );
        assert.equal(Number(saldo.saldo_fiscal), 0);
        assert.equal(Number(saldo.saldo_nao_fiscal), 20 - insumo.quantidade);
        assert.equal(Number(saldo.reservado_fiscal), 0);
      }
      assert.equal(Number((await get(
        db,
        'SELECT COUNT(*) AS total FROM pedido_estoque_consumo_itens WHERE pedido_id = ?',
        [criado.pedido.id]
      )).total), 3);
      assert.equal(Number((await get(
        db,
        `SELECT COUNT(*) AS total FROM pedido_estoque_reservas
         WHERE pedido_id = ? AND status = 'ATIVA'`,
        [criado.pedido.id]
      )).total), 0);
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 1);
      assert.equal(Number((await get(
        db,
        'SELECT COUNT(*) AS total FROM movimentos_transferencia_saldos'
      )).total), 3);
    } finally {
      MotorComercial.confirmarPedidoFiscal = confirmarOriginal;
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('reverte todas as alterações após falha em cada débito de insumo', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    const confirmarOriginal = MotorComercial.confirmarPedidoFiscal;
    const debitarOriginal = estoqueSaldosPublico.debitarSaldo;
    configService.recursoHabilitado = () => true;

    try {
      for (const falharAposDebito of [1, 2, 3]) {
        const { db, empresa } = await setup();
        let debitosFiscais = 0;
        MotorComercial.confirmarPedidoFiscal = (params, deps = {}) => confirmarOriginal(params, {
          ...deps,
          verificarSupervisorToken: async () => ({
            id: 99,
            username: 'supervisor-teste',
            perfil: 'SUPERVISOR'
          })
        });
        estoqueSaldosPublico.debitarSaldo = async (produtoId, tipo, quantidade, opts) => {
          const resultado = await debitarOriginal(produtoId, tipo, quantidade, opts);
          if (tipo === TipoSaldo.FISCAL) {
            debitosFiscais += 1;
            if (debitosFiscais === falharAposDebito) {
              throw Object.assign(new Error(`Falha injetada após débito ${debitosFiscais}.`), {
                code: 'FALHA_DEBITO_INJETADA'
              });
            }
          }
          return resultado;
        };
        try {
          await garantirSchemasConsumo(db);
          const produtoFinal = await criarProduto(db, {
            nome: `Pastel rollback ${falharAposDebito}`,
            unidade: 'UN'
          });
          const insumos = [];
          for (const [indice, quantidade] of [2, 3, 4].entries()) {
            const produto = await criarProduto(db, {
              nome: `Insumo rollback ${indice + 1}`,
              unidade: 'G',
              tipo: 'INSUMO',
              saldoNaoFiscal: 20
            });
            await adicionarSaldoEmpresa(db, produto, empresa.id, 0, 20);
            insumos.push({ produto, quantidade });
          }
          await FichaTecnicaService.salvar(produtoFinal, {
            ativo: 1,
            itens: insumos.map((insumo) => ({
              insumo_id: insumo.produto,
              quantidade: insumo.quantidade,
              unidade: 'G'
            }))
          }, { db });

          await assert.rejects(
            criarPedido(
              db,
              empresa.id,
              [{ produto_id: produtoFinal, quantidade: 1, preco_unitario: 30, subtotal: 30 }],
              crypto.randomUUID(),
              'aprovado'
            ),
            (err) => err && err.code === 'FALHA_DEBITO_INJETADA'
          );
          assert.equal(debitosFiscais, falharAposDebito);
          assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM pedidos_itens'
          )).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM pedido_estoque_consumos'
          )).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM pedido_estoque_consumo_itens'
          )).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM pedido_operacao_idempotencia'
          )).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM movimentos_transferencia_saldos'
          )).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM pedido_estoque_reservas'
          )).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM auditoria_pedido_estoque_fiscal'
          )).total), 0);
          for (const insumo of insumos) {
            const global = await get(
              db,
              'SELECT saldo_fiscal, saldo_nao_fiscal FROM produtos WHERE id = ?',
              [insumo.produto]
            );
            assert.equal(Number(global.saldo_fiscal), 0);
            assert.equal(Number(global.saldo_nao_fiscal), 20);
            const empresarial = await EstoqueEmpresaService.consultarSaldo(
              { produtoId: insumo.produto, empresaId: empresa.id },
              { db }
            );
            assert.equal(Number(empresarial.saldo_fiscal), 0);
            assert.equal(Number(empresarial.saldo_nao_fiscal), 20);
            assert.equal(Number(empresarial.reservado_fiscal), 0);
          }
        } finally {
          await closeDb(db);
        }
      }
    } finally {
      estoqueSaldosPublico.debitarSaldo = debitarOriginal;
      MotorComercial.confirmarPedidoFiscal = confirmarOriginal;
      configService.recursoHabilitado = originalHabilitado;
    }
  });

  it('consome orçamento convertido e estorna o consumo ao cancelar o pedido', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const outraEmpresa = await EmpresaService.criarEmpresa({
        cnpj: '22333444000181',
        razao_social: 'Outra empresa de teste'
      }, { db });
      const produto = await criarProduto(db, {
        nome: 'Pão de queijo',
        unidade: 'UN',
        saldoFiscal: 5
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      await adicionarSaldoEmpresa(db, produto, outraEmpresa.id, 7);
      const orcamento = await PedidoOperacionalService.criar({
        tipo: 'orcamento',
        status: 'ORCAMENTO',
        total: 6,
        itens: [{ produto_id: produto, quantidade: 2, preco_unitario: 3, subtotal: 6 }]
      }, 7, {
        db,
        empresaId: empresa.id,
        chaveIdempotencia: crypto.randomUUID(),
        exigirChaveIdempotencia: true
      });
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 5);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: outraEmpresa.id },
        { db }
      )).saldo_fiscal), 7);

      const convertido = await PedidoOperacionalService.converterParaPedido(
        orcamento.pedido.id,
        {},
        7,
        { db, empresaId: empresa.id }
      );
      const repetido = await PedidoOperacionalService.converterParaPedido(
        orcamento.pedido.id,
        {},
        7,
        { db, empresaId: empresa.id }
      );
      assert.equal(convertido.pedido.status, 'PEDIDO');
      assert.equal(repetido.ja_convertido, true);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 3);

      await assert.rejects(
        PedidoOperacionalService.atualizar(orcamento.pedido.id, {}, { db, empresaId: empresa.id }),
        (err) => err && err.codigo === 'PEDIDO_CONSUMO_ESTOQUE_IMUTAVEL'
      );
      const chaveCancelamento = crypto.randomUUID();
      const cancelado = await PedidoOperacionalService.cancelar(orcamento.pedido.id, {
        db,
        empresaId: empresa.id,
        chaveIdempotencia: chaveCancelamento
      });
      const repetidoCancelamento = await PedidoOperacionalService.cancelar(orcamento.pedido.id, {
        db,
        empresaId: empresa.id,
        chaveIdempotencia: chaveCancelamento
      });
      assert.equal(cancelado.pedido.status, 'CANCELADO');
      assert.equal(cancelado.estorno.ja_estornado, false);
      assert.equal(repetidoCancelamento.estorno.idempotente, true);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 5);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: outraEmpresa.id },
        { db }
      )).saldo_fiscal), 7);
      assert.equal(Number((await get(
        db,
        'SELECT COUNT(*) AS total FROM pedido_estoque_estorno_itens'
      )).total), 1);

      const pedidoSeguinte = await criarPedido(db, empresa.id, [
        { produto_id: produto, quantidade: 1, preco_unitario: 3, subtotal: 3 }
      ]);
      await assert.rejects(
        PedidoOperacionalService.cancelar(pedidoSeguinte.pedido.id, {
          db,
          empresaId: empresa.id,
          chaveIdempotencia: chaveCancelamento
        }),
        (err) => err && err.codigo === 'CHAVE_IDEMPOTENCIA_REUTILIZADA'
      );
      assert.equal((await PedidoRepository.obterPorId(pedidoSeguinte.pedido.id, { db })).status, 'PEDIDO');
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 4);
      await PedidoOperacionalService.cancelar(pedidoSeguinte.pedido.id, {
        db,
        empresaId: empresa.id,
        chaveIdempotencia: crypto.randomUUID()
      });
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 5);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('reverte todos os créditos e mantém o Pedido íntegro quando cada crédito falha', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    const creditarOriginal = estoqueSaldosPublico.creditarSaldo;
    const confirmarOriginal = MotorComercial.confirmarPedidoFiscal;
    configService.recursoHabilitado = () => true;
    MotorComercial.confirmarPedidoFiscal = (params, deps = {}) => confirmarOriginal(params, {
      ...deps,
      verificarSupervisorToken: async () => ({
        id: 99,
        username: 'supervisor-teste',
        perfil: 'SUPERVISOR'
      })
    });
    try {
      for (let falharAposCredito = 1; falharAposCredito <= 3; falharAposCredito += 1) {
        const { db, empresa } = await setup();
        try {
          const produtoFinal = await criarProduto(db, {
            nome: `Produto com três insumos ${falharAposCredito}`,
            unidade: 'UN'
          });
          const insumos = [];
          for (let indice = 0; indice < 3; indice += 1) {
            const produto = await criarProduto(db, {
              nome: `Insumo ${falharAposCredito}-${indice}`,
              unidade: 'G',
              tipo: 'INSUMO',
              saldoNaoFiscal: 20
            });
            await adicionarSaldoEmpresa(db, produto, empresa.id, 0, 20);
            insumos.push({ produto, quantidade: indice + 1 });
          }
          await FichaTecnicaService.salvar(produtoFinal, {
            ativo: 1,
            itens: insumos.map((item) => ({
              insumo_id: item.produto,
              quantidade: item.quantidade,
              unidade: 'G'
            }))
          }, { db });
          const pedido = await criarPedido(
            db,
            empresa.id,
            [{ produto_id: produtoFinal, quantidade: 1, preco_unitario: 10, subtotal: 10 }],
            crypto.randomUUID(),
            'aprovado'
          );
          const saldosAntes = [];
          for (const item of insumos) {
            saldosAntes.push(await EstoqueEmpresaService.consultarSaldo(
              { produtoId: item.produto, empresaId: empresa.id },
              { db }
            ));
          }
          const consumosAntes = await all(
            db,
            'SELECT * FROM pedido_estoque_consumos WHERE pedido_id = ? ORDER BY id',
            [pedido.pedido.id]
          );
          const itensConsumoAntes = await all(
            db,
            'SELECT * FROM pedido_estoque_consumo_itens WHERE pedido_id = ? ORDER BY id',
            [pedido.pedido.id]
          );
          const reservasAntes = await all(
            db,
            'SELECT * FROM pedido_estoque_reservas WHERE pedido_id = ? ORDER BY id',
            [pedido.pedido.id]
          );
          let creditos = 0;
          estoqueSaldosPublico.creditarSaldo = async (...args) => {
            const resultado = await creditarOriginal(...args);
            creditos += 1;
            if (creditos === falharAposCredito) {
              const err = new Error(`Falha injetada após crédito ${creditos}`);
              err.code = 'FALHA_CREDITO_INJETADA';
              throw err;
            }
            return resultado;
          };
          await assert.rejects(
            PedidoOperacionalService.cancelar(pedido.pedido.id, {
              db,
              empresaId: empresa.id,
              chaveIdempotencia: crypto.randomUUID()
            }),
            (err) => err && err.code === 'FALHA_CREDITO_INJETADA'
          );
          assert.equal(creditos, falharAposCredito);
          assert.equal((await PedidoRepository.obterPorId(pedido.pedido.id, { db })).status, 'PEDIDO');
          assert.deepEqual(await all(
            db,
            'SELECT * FROM pedido_estoque_consumos WHERE pedido_id = ? ORDER BY id',
            [pedido.pedido.id]
          ), consumosAntes);
          assert.deepEqual(await all(
            db,
            'SELECT * FROM pedido_estoque_consumo_itens WHERE pedido_id = ? ORDER BY id',
            [pedido.pedido.id]
          ), itensConsumoAntes);
          assert.deepEqual(await all(
            db,
            'SELECT * FROM pedido_estoque_reservas WHERE pedido_id = ? ORDER BY id',
            [pedido.pedido.id]
          ), reservasAntes);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM pedido_estoque_estornos'
          )).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM pedido_estoque_estorno_itens'
          )).total), 0);
          assert.equal(Number((await get(
            db,
            'SELECT COUNT(*) AS total FROM pedido_estoque_estorno_solicitacoes'
          )).total), 0);
          for (let indice = 0; indice < insumos.length; indice += 1) {
            const depois = await EstoqueEmpresaService.consultarSaldo(
              { produtoId: insumos[indice].produto, empresaId: empresa.id },
              { db }
            );
            assert.equal(Number(depois.saldo_nao_fiscal), Number(saldosAntes[indice].saldo_nao_fiscal));
          }
        } finally {
          estoqueSaldosPublico.creditarSaldo = creditarOriginal;
          await closeDb(db);
        }
      }
    } finally {
      estoqueSaldosPublico.creditarSaldo = creditarOriginal;
      MotorComercial.confirmarPedidoFiscal = confirmarOriginal;
      configService.recursoHabilitado = originalHabilitado;
    }
  });

  it('bloqueia cancelamento de pedido consumido com venda ou documento fiscal vinculado', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      await run(db, `
        CREATE TABLE vendas (
          id INTEGER PRIMARY KEY,
          empresa_id INTEGER,
          status TEXT,
          cancelada INTEGER DEFAULT 0
        )
      `);
      await run(db, 'CREATE TABLE nfe_notas (id INTEGER PRIMARY KEY, venda_id INTEGER, status TEXT)');
      await run(db, 'CREATE TABLE nfce_notas (id INTEGER PRIMARY KEY, venda_id INTEGER, status TEXT)');
      const produto = await criarProduto(db, {
        nome: 'Produto faturável',
        unidade: 'UN',
        saldoFiscal: 4
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 4);
      const pedido = await criarPedido(db, empresa.id, [
        { produto_id: produto, quantidade: 1, preco_unitario: 8, subtotal: 8 }
      ]);
      await run(db, 'INSERT INTO vendas (id, empresa_id, status) VALUES (51, ?, ?)', [
        empresa.id,
        'concluida'
      ]);
      await run(db, 'INSERT INTO nfce_notas (id, venda_id, status) VALUES (81, 51, ?)', ['autorizada']);
      await run(db, 'UPDATE pedidos SET venda_id = 51 WHERE id = ?', [pedido.pedido.id]);

      await assert.rejects(
        PedidoOperacionalService.cancelar(pedido.pedido.id, {
          db,
          empresaId: empresa.id,
          chaveIdempotencia: crypto.randomUUID()
        }),
        (err) => err && err.codigo === 'PEDIDO_VENDA_DOCUMENTO_FISCAL_VINCULADO'
      );
      assert.equal((await PedidoRepository.obterPorId(pedido.pedido.id, { db })).status, 'PEDIDO');
      assert.equal(Number((await get(
        db,
        'SELECT COUNT(*) AS total FROM pedido_estoque_estornos'
      )).total), 0);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 3);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('preserva o cancelamento legado de orçamento sem consumo registrado', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Produto de orçamento',
        unidade: 'UN',
        saldoFiscal: 2
      });
      const orcamento = await PedidoOperacionalService.criar({
        tipo: 'orcamento',
        status: 'ORCAMENTO',
        total: 5,
        itens: [{ produto_id: produto, quantidade: 1, preco_unitario: 5, subtotal: 5 }]
      }, 7, {
        db,
        empresaId: empresa.id,
        chaveIdempotencia: crypto.randomUUID(),
        exigirChaveIdempotencia: true
      });
      const cancelado = await PedidoOperacionalService.cancelar(orcamento.pedido.id, {
        db,
        empresaId: empresa.id
      });
      assert.equal(cancelado.pedido.status, 'CANCELADO');
      assert.equal(await PedidoConsumoEstoqueService.jaConsumido(orcamento.pedido.id, { db }), false);
      assert.equal(Number((await get(
        db,
        'SELECT COUNT(*) AS total FROM pedido_estoque_estornos'
      )).total), 0);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('mantém a entrada antiga de faturamento integrada ao consumo e à idempotência', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Refrigerante lata',
        unidade: 'UN',
        saldoFiscal: 4
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 4);
      const body = {
        total: 6,
        itens: [{ produto_id: produto, quantidade: 2, preco_unitario: 3, subtotal: 6 }]
      };
      const chaveIdempotencia = crypto.randomUUID();
      const primeiro = await PedidoService.criarPedido(body, 7, {
        db,
        empresaId: empresa.id,
        chaveIdempotencia,
        exigirChaveIdempotencia: true
      });
      const repetido = await PedidoService.criarPedido(body, 7, {
        db,
        empresaId: empresa.id,
        chaveIdempotencia,
        exigirChaveIdempotencia: true
      });
      assert.equal(primeiro.pedido.status, 'AGUARDANDO_FATURAMENTO');
      assert.equal(repetido.idempotente, true);
      assert.equal(repetido.pedido.id, primeiro.pedido.id);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 2);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('reverte Pedido, reservas e saldo se o ledger falhar após o débito', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const { db, empresa } = await setup();
    try {
      const produto = await criarProduto(db, {
        nome: 'Água',
        unidade: 'UN',
        saldoFiscal: 5
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 5);
      await PedidoConsumoEstoqueService.garantirSchema(db);
      await run(db, `
        CREATE TRIGGER falhar_ledger_pedido
        BEFORE INSERT ON pedido_estoque_consumos
        BEGIN
          SELECT RAISE(ABORT, 'falha injetada no ledger');
        END
      `);
      await assert.rejects(
        criarPedido(db, empresa.id, [
          { produto_id: produto, quantidade: 2, preco_unitario: 3, subtotal: 6 }
        ]),
        /falha injetada no ledger/
      );
      assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM pedidos')).total), 0);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 5);
      assert.equal(Number((await get(
        db,
        'SELECT reservado_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
        [produto, empresa.id]
      )).reservado_fiscal), 0);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      await closeDb(db);
    }
  });

  it('bloqueia débito usando saldo agregado de outra empresa', async () => {
    const { db, empresa } = await setup();
    try {
      const empresaB = await EmpresaService.criarEmpresa({
        cnpj: '04252011000110',
        razao_social: 'Outra empresa'
      }, { db });
      const produto = await criarProduto(db, {
        nome: 'Produto multiempresa',
        unidade: 'UN',
        saldoFiscal: 10
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 0);
      await adicionarSaldoEmpresa(db, produto, empresaB.id, 10);
      await assert.rejects(
        estoqueSaldosPublico.debitarSaldo(produto, TipoSaldo.FISCAL, 1, {
          db,
          empresaId: empresa.id
        }),
        (err) => err && err.code === 'SALDO_INSUFICIENTE'
      );
      assert.equal(Number((await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produto])).saldo_fiscal), 10);
      assert.equal(Number((await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      )).saldo_fiscal), 0);
    } finally {
      await closeDb(db);
    }
  });

  it('serializa débitos concorrentes no piso de saldo da mesma empresa', async () => {
    const originalHabilitado = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    const dbPath = path.join(os.tmpdir(), `cds-pedido-consumo-concorrencia-${process.pid}-${Date.now()}.db`);
    let db;
    let dbConcorrente;
    try {
      const setupResult = await setup(dbPath);
      db = setupResult.db;
      const { empresa } = setupResult;
      dbConcorrente = await openDb(dbPath);
      await run(dbConcorrente, 'PRAGMA foreign_keys = ON');
      const produto = await criarProduto(db, {
        nome: 'Estoque concorrente',
        unidade: 'UN',
        saldoFiscal: 10
      });
      await adicionarSaldoEmpresa(db, produto, empresa.id, 10);

      const tentativas = await Promise.allSettled([db, dbConcorrente].map((conexao) =>
        estoqueSaldosPublico.executarEmTransacao(
          (txDb) => estoqueSaldosPublico.debitarSaldo(
            produto,
            TipoSaldo.FISCAL,
            7,
            { db: txDb, empresaId: empresa.id }
          ),
          { db: conexao }
        )
      ));
      assert.equal(tentativas.filter((resultado) => resultado.status === 'fulfilled').length, 1);
      assert.equal(tentativas.filter((resultado) => resultado.status === 'rejected').length, 1);
      const saldo = await EstoqueEmpresaService.consultarSaldo(
        { produtoId: produto, empresaId: empresa.id },
        { db }
      );
      assert.equal(Number(saldo.saldo_fiscal), 3);
    } finally {
      configService.recursoHabilitado = originalHabilitado;
      if (dbConcorrente) await closeDb(dbConcorrente);
      if (db) await closeDb(db);
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-journal`, { force: true });
    }
  });
});
