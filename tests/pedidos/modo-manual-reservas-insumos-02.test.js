/**
 * SPRINT CDS-ESTOQUE-MODO-MANUAL-RESERVAS-02
 * Reservas de insumos no modo MANUAL não devem existir desde a abertura.
 *
 * Executar: node tests/pedidos/modo-manual-reservas-insumos-02.test.js
 * Isolamento: DB_DIR temporário. Sem banco oficial.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-modo-manual-reservas-02-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const PedidoOperacionalService = require('../../backend/services/pedido/PedidoOperacionalService');
const PedidoConsumoEstoqueService = require('../../backend/services/pedido/PedidoConsumoEstoqueService');
const PedidoRepository = require('../../backend/services/pedido/PedidoRepository');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EmpresaModoEstoqueService = require('../../backend/services/empresas/EmpresaModoEstoqueService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  garantirSchemaEmpresasConfiguracaoEstoqueAsync
} = require('../../backend/services/empresas/empresasConfiguracaoEstoqueSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const reservasPublico = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const MTS = require('../../backend/motores/mts');
const PedidoEstoqueAuditoria = require('../../backend/motores/comercial/PedidoEstoqueAuditoria');

const CNPJS = ['11222333000181', '04252011000110', '27865757000102'];

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
  unidade = 'UN',
  tipo = 'COMERCIAL',
  saldoFiscal = 0,
  controlaEstoque = 1,
  precoVenda = 10
}) {
  const r = await run(
    db,
    `INSERT INTO produtos (
      nome, unidade, tipo_operacional, controla_estoque, saldo_fiscal,
      saldo_nao_fiscal, estoque_atual, preco_venda, preco_pedido
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [nome, unidade, tipo, controlaEstoque, saldoFiscal, saldoFiscal, precoVenda, precoVenda]
  );
  return r.lastID;
}

async function adicionarSaldoEmpresa(db, produtoId, empresaId, saldoFiscal) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: 0,
    estoque_atual: saldoFiscal
  }, { db });
}

async function setup(nEmpresas = 1) {
  const db = await openDb();
  await run(db, 'PRAGMA foreign_keys = ON');
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      nome TEXT NOT NULL,
      preco_venda REAL NOT NULL DEFAULT 0,
      preco_pedido REAL,
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
      utiliza_ficha_tecnica INTEGER DEFAULT 0,
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
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      status TEXT,
      cancelada INTEGER DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE promocoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      preco_original REAL,
      preco_promocional REAL,
      desconto_percentual REAL,
      data_inicio DATE,
      data_fim DATE,
      status TEXT DEFAULT 'ativa'
    )
  `);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);
  await PedidoConsumoEstoqueService.garantirSchema(db);
  await reservasPublico.garantirSchemaReservas(db);
  await MTS.garantirSchema(db);
  await PedidoEstoqueAuditoria.garantirSchema(db);

  const empresas = [];
  for (let i = 0; i < nEmpresas; i += 1) {
    empresas.push(await EmpresaService.criarEmpresa({
      cnpj: CNPJS[i],
      razao_social: `Empresa ${String.fromCharCode(65 + i)}`
    }, { db }));
  }
  return { db, empresas, empresa: empresas[0] };
}

async function criarPedido(db, empresaId, itens, chave = crypto.randomUUID()) {
  return PedidoOperacionalService.criar({
    tipo: 'pedido',
    status: 'PEDIDO',
    desconto: 0,
    frete: 0,
    total: itens.reduce((t, i) => t + i.subtotal, 0),
    itens
  }, 7, {
    db,
    empresaId,
    chaveIdempotencia: chave,
    exigirChaveIdempotencia: true
  });
}

async function finalizarConsumo(db, empresaId, pedidoId) {
  await run(db, 'BEGIN IMMEDIATE');
  try {
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaId]);
    const pedido = await PedidoRepository.obterPorId(pedidoId, { db });
    const resultado = await PedidoConsumoEstoqueService.registrarConsumo({
      db,
      pedidoId,
      empresaId,
      itens: pedido.itens,
      vendaId: venda.lastID,
      jaEmTransacao: true
    });
    await run(db, 'COMMIT');
    return { vendaId: venda.lastID, resultado };
  } catch (err) {
    await run(db, 'ROLLBACK');
    throw err;
  }
}

async function reservasAtivas(db, pedidoId) {
  try {
    return await all(
      db,
      `SELECT * FROM pedido_estoque_reservas
        WHERE pedido_id = ? AND status = 'ATIVA'`,
      [pedidoId]
    );
  } catch (err) {
    if (/no such table/i.test(String(err.message || ''))) return [];
    throw err;
  }
}

async function saldoInsumo(db, produtoId, empresaId) {
  const row = await get(
    db,
    'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
  return Number(row?.saldo_fiscal || 0);
}

async function montarPastelComFicha(db, empresaId, opts = {}) {
  const insumosDefs = opts.insumos || [
    { nome: 'Massa', qtd: 2, saldo: 100 },
    { nome: 'Queijo', qtd: 1, saldo: 50 }
  ];
  const pastel = await criarProduto(db, {
    nome: opts.nomePastel || 'Pastel',
    unidade: 'UN',
    tipo: 'COMERCIAL',
    saldoFiscal: 0,
    controlaEstoque: 0
  });
  const insumos = [];
  for (const def of insumosDefs) {
    const id = await criarProduto(db, {
      nome: def.nome,
      unidade: 'UN',
      tipo: 'INSUMO',
      saldoFiscal: def.saldo
    });
    await adicionarSaldoEmpresa(db, id, empresaId, def.saldo);
    insumos.push({ id, quantidade: def.qtd, saldo: def.saldo });
  }
  await FichaTecnicaService.salvar(pastel, {
    ativo: 1,
    itens: insumos.map((i) => ({
      insumo_id: i.id,
      quantidade: i.quantidade,
      unidade: 'UN'
    }))
  }, { db });
  await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [pastel]);
  return { pastel, insumos };
}

async function t1AutomaticoReservaEConsome() {
  const { db, empresa } = await setup(1);
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'AUTOMATICO');
  const { pastel, insumos } = await montarPastelComFicha(db, empresa.id, {
    insumos: [{ nome: 'MassaA', qtd: 2, saldo: 100 }]
  });
  const criado = await criarPedido(db, empresa.id, [{
    produto_id: pastel,
    quantidade: 3,
    preco_unitario: 10,
    subtotal: 30
  }]);
  const pedidoId = criado.pedido?.id || criado.id;
  const reservas = await reservasAtivas(db, pedidoId);
  assert.ok(reservas.length > 0, 'AUTOMATICO deve reservar insumos');
  const fin = await finalizarConsumo(db, empresa.id, pedidoId);
  assert.notStrictEqual(fin.resultado.modo_estoque, 'MANUAL');
  assert.strictEqual(await saldoInsumo(db, insumos[0].id, empresa.id), 100 - 6);
  await closeDb(db);
}

async function t2ManualSemReservaSemDebito() {
  const { db, empresa } = await setup(1);
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'MANUAL');
  const { pastel, insumos } = await montarPastelComFicha(db, empresa.id, {
    insumos: [{ nome: 'MassaM', qtd: 2, saldo: 80 }]
  });
  const criado = await criarPedido(db, empresa.id, [{
    produto_id: pastel,
    quantidade: 2,
    preco_unitario: 10,
    subtotal: 20
  }]);
  const pedidoId = criado.pedido?.id || criado.id;
  assert.strictEqual((await reservasAtivas(db, pedidoId)).length, 0);
  const fin = await finalizarConsumo(db, empresa.id, pedidoId);
  assert.strictEqual(fin.resultado.modo_estoque, 'MANUAL');
  assert.strictEqual(fin.resultado.consumido, false);
  assert.strictEqual(fin.resultado.sem_baixa_fisica, true);
  assert.strictEqual(await saldoInsumo(db, insumos[0].id, empresa.id), 80);
  const itensConsumo = await all(
    db,
    `SELECT * FROM pedido_estoque_consumo_itens WHERE pedido_id = ?`,
    [pedidoId]
  );
  assert.strictEqual(itensConsumo.length, 0);
  assert.strictEqual(await PedidoConsumoEstoqueService.jaConsumido(pedidoId, { db }), false);
  await closeDb(db);
}

async function t3ProdutoComercialPreservado() {
  const { db, empresa } = await setup(1);
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'MANUAL');
  const refri = await criarProduto(db, {
    nome: 'Refrigerante',
    unidade: 'UN',
    tipo: 'COMERCIAL',
    saldoFiscal: 40,
    controlaEstoque: 1
  });
  await adicionarSaldoEmpresa(db, refri, empresa.id, 40);
  const criado = await criarPedido(db, empresa.id, [{
    produto_id: refri,
    quantidade: 2,
    preco_unitario: 5,
    subtotal: 10
  }]);
  const pedidoId = criado.pedido?.id || criado.id;
  // MANUAL não desliga reserva de produto comercial simples (regras próprias).
  const reservas = await reservasAtivas(db, pedidoId);
  assert.ok(reservas.some((r) => Number(r.produto_id) === refri));
  await closeDb(db);
}

async function t4VariosInsumosManual() {
  const { db, empresa } = await setup(1);
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'MANUAL');
  const { pastel, insumos } = await montarPastelComFicha(db, empresa.id);
  const criado = await criarPedido(db, empresa.id, [{
    produto_id: pastel,
    quantidade: 1,
    preco_unitario: 12,
    subtotal: 12
  }]);
  const pedidoId = criado.pedido?.id || criado.id;
  assert.strictEqual((await reservasAtivas(db, pedidoId)).length, 0);
  await finalizarConsumo(db, empresa.id, pedidoId);
  for (const ins of insumos) {
    assert.strictEqual(await saldoInsumo(db, ins.id, empresa.id), ins.saldo);
  }
  await closeDb(db);
}

async function t5VariosPedidosManual() {
  const { db, empresa } = await setup(1);
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'MANUAL');
  const { pastel, insumos } = await montarPastelComFicha(db, empresa.id, {
    insumos: [{ nome: 'MassaV', qtd: 1, saldo: 200 }]
  });
  const p1 = await criarPedido(db, empresa.id, [{
    produto_id: pastel, quantidade: 1, preco_unitario: 10, subtotal: 10
  }]);
  const p2 = await criarPedido(db, empresa.id, [{
    produto_id: pastel, quantidade: 2, preco_unitario: 10, subtotal: 20
  }]);
  const id1 = p1.pedido?.id || p1.id;
  const id2 = p2.pedido?.id || p2.id;
  assert.strictEqual((await reservasAtivas(db, id1)).length, 0);
  assert.strictEqual((await reservasAtivas(db, id2)).length, 0);
  await finalizarConsumo(db, empresa.id, id1);
  assert.strictEqual((await reservasAtivas(db, id2)).length, 0);
  assert.strictEqual(await saldoInsumo(db, insumos[0].id, empresa.id), 200);
  await closeDb(db);
}

async function t6IdempotenciaManual() {
  const { db, empresa } = await setup(1);
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'MANUAL');
  const { pastel, insumos } = await montarPastelComFicha(db, empresa.id, {
    insumos: [{ nome: 'MassaI', qtd: 3, saldo: 90 }]
  });
  const criado = await criarPedido(db, empresa.id, [{
    produto_id: pastel, quantidade: 1, preco_unitario: 10, subtotal: 10
  }]);
  const pedidoId = criado.pedido?.id || criado.id;
  const fin1 = await finalizarConsumo(db, empresa.id, pedidoId);
  const fin2 = await (async () => {
    await run(db, 'BEGIN IMMEDIATE');
    try {
      const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresa.id]);
      const pedido = await PedidoRepository.obterPorId(pedidoId, { db });
      const resultado = await PedidoConsumoEstoqueService.registrarConsumo({
        db,
        pedidoId,
        empresaId: empresa.id,
        itens: pedido.itens,
        vendaId: fin1.vendaId,
        jaEmTransacao: true
      });
      await run(db, 'COMMIT');
      return resultado;
    } catch (err) {
      await run(db, 'ROLLBACK');
      throw err;
    }
  })();
  assert.strictEqual(fin2.idempotente, true);
  assert.strictEqual(fin2.ja_consumido, true);
  assert.strictEqual(await saldoInsumo(db, insumos[0].id, empresa.id), 90);
  const consumos = await all(db, 'SELECT * FROM pedido_estoque_consumos WHERE pedido_id = ?', [pedidoId]);
  assert.strictEqual(consumos.length, 1);
  assert.strictEqual(Number(consumos[0].sem_baixa_fisica), 1);
  const itens = await all(db, 'SELECT * FROM pedido_estoque_consumo_itens WHERE pedido_id = ?', [pedidoId]);
  assert.strictEqual(itens.length, 0);
  await closeDb(db);
}

async function t7CancelamentoManual() {
  const { db, empresa } = await setup(1);
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'MANUAL');
  const { pastel } = await montarPastelComFicha(db, empresa.id, {
    insumos: [{ nome: 'MassaC', qtd: 1, saldo: 40 }]
  });
  const criado = await criarPedido(db, empresa.id, [{
    produto_id: pastel, quantidade: 1, preco_unitario: 10, subtotal: 10
  }]);
  const pedidoId = criado.pedido?.id || criado.id;
  assert.strictEqual((await reservasAtivas(db, pedidoId)).length, 0);
  await PedidoOperacionalService.cancelar(pedidoId, { db, empresaId: empresa.id });
  assert.strictEqual((await reservasAtivas(db, pedidoId)).length, 0);
  await closeDb(db);
}

async function t8EmpresasIndependentes() {
  const { db, empresas } = await setup(3);
  const [empA, empB, empC] = empresas;
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empA.id, 'AUTOMATICO');
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empB.id, 'MANUAL');
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empC.id, 'MANUAL');

  async function pastelNaEmpresa(empresaId, nome) {
    return montarPastelComFicha(db, empresaId, {
      nomePastel: nome,
      insumos: [{ nome: `Insumo-${nome}`, qtd: 2, saldo: 100 }]
    });
  }

  const a = await pastelNaEmpresa(empA.id, 'PastelA');
  const b = await pastelNaEmpresa(empB.id, 'PastelB');
  const c = await pastelNaEmpresa(empC.id, 'PastelC');

  const pedA = await criarPedido(db, empA.id, [{
    produto_id: a.pastel, quantidade: 1, preco_unitario: 10, subtotal: 10
  }]);
  const pedB = await criarPedido(db, empB.id, [{
    produto_id: b.pastel, quantidade: 1, preco_unitario: 10, subtotal: 10
  }]);
  const pedC = await criarPedido(db, empC.id, [{
    produto_id: c.pastel, quantidade: 1, preco_unitario: 10, subtotal: 10
  }]);

  const idA = pedA.pedido?.id || pedA.id;
  const idB = pedB.pedido?.id || pedB.id;
  const idC = pedC.pedido?.id || pedC.id;

  assert.ok((await reservasAtivas(db, idA)).length > 0);
  assert.strictEqual((await reservasAtivas(db, idB)).length, 0);
  assert.strictEqual((await reservasAtivas(db, idC)).length, 0);

  await finalizarConsumo(db, empA.id, idA);
  await finalizarConsumo(db, empB.id, idB);
  await finalizarConsumo(db, empC.id, idC);

  assert.strictEqual(await saldoInsumo(db, a.insumos[0].id, empA.id), 98);
  assert.strictEqual(await saldoInsumo(db, b.insumos[0].id, empB.id), 100);
  assert.strictEqual(await saldoInsumo(db, c.insumos[0].id, empC.id), 100);
  await closeDb(db);
}

async function t9MudancaModoPedidoAberto() {
  const { db, empresa } = await setup(1);
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'AUTOMATICO');
  const { pastel, insumos } = await montarPastelComFicha(db, empresa.id, {
    insumos: [{ nome: 'MassaX', qtd: 2, saldo: 60 }]
  });
  const criado = await criarPedido(db, empresa.id, [{
    produto_id: pastel, quantidade: 1, preco_unitario: 10, subtotal: 10
  }]);
  const pedidoId = criado.pedido?.id || criado.id;
  assert.ok((await reservasAtivas(db, pedidoId)).length > 0);

  // Regra adotada: modo é consultado no momento da operação (reserva/fechamento).
  // Mudança para MANUAL + re-reserva libera insumos; fechamento não debita.
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, 'MANUAL');
  await run(db, 'BEGIN IMMEDIATE');
  try {
    const pedido = await PedidoRepository.obterPorId(pedidoId, { db });
    const r = await PedidoConsumoEstoqueService.reservarConsumo({
      db,
      pedidoId,
      empresaId: empresa.id,
      itens: pedido.itens,
      jaEmTransacao: true
    });
    assert.strictEqual(r.modo_estoque, 'MANUAL');
    assert.strictEqual(r.reservas.length, 0);
    await run(db, 'COMMIT');
  } catch (err) {
    await run(db, 'ROLLBACK');
    throw err;
  }
  assert.strictEqual((await reservasAtivas(db, pedidoId)).length, 0);
  await finalizarConsumo(db, empresa.id, pedidoId);
  assert.strictEqual(await saldoInsumo(db, insumos[0].id, empresa.id), 60);
  await closeDb(db);
}

async function t10FonteReservarConsultaModo() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../backend/services/pedido/PedidoConsumoEstoqueService.js'),
    'utf8'
  );
  const trecho = src.slice(
    src.indexOf('async function reservarConsumo'),
    src.indexOf('async function solicitarEstorno')
  );
  assert.match(trecho, /empresaPermiteBaixaAutomaticaEstoque/);
  assert.match(trecho, /FICHA_TECNICA/);
  assert.match(trecho, /MANUAL/);
  assert.match(src, /sem_baixa_fisica/);
}

async function main() {
  const originalHabilitado = configService.recursoHabilitado;
  configService.recursoHabilitado = () => true;

  const testes = [
    ['1 AUTOMATICO reserva e consome', t1AutomaticoReservaEConsome],
    ['2 MANUAL sem reserva nem débito', t2ManualSemReservaSemDebito],
    ['3 produto comercial preserva reserva', t3ProdutoComercialPreservado],
    ['4 vários insumos MANUAL', t4VariosInsumosManual],
    ['5 vários pedidos MANUAL isolados', t5VariosPedidosManual],
    ['6 idempotência sem consumo falso', t6IdempotenciaManual],
    ['7 cancelamento MANUAL sem residual', t7CancelamentoManual],
    ['8 empresas independentes N modos', t8EmpresasIndependentes],
    ['9 mudança de modo em pedido aberto', t9MudancaModoPedidoAberto],
    ['10 fonte: reservarConsulta modo', t10FonteReservarConsultaModo]
  ];

  let ok = 0;
  try {
    for (const [nome, fn] of testes) {
      await fn();
      ok += 1;
      console.log(`  OK  ${nome}`);
    }
    console.log(`\nmodo-manual-reservas-insumos-02: ${ok}/${testes.length} OK`);
  } finally {
    configService.recursoHabilitado = originalHabilitado;
  }
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
