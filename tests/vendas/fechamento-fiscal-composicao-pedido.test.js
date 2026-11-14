'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-fechamento-fiscal-comp-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
const { distribuirItensVendaComValorFiscalEfetivo } = require('../../backend/services/distribuidorEstoqueVenda');
const { buildNfceXml } = require('../../backend/services/fiscal/xmlBuilder');
const { determinarModeloDeTotais } = require('../../backend/services/fiscal/modeloTotais');
const { gerarDanfeHtml } = require('../../backend/services/fiscal/danfe');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  calcularMargemToleranciaDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const {
  devePreservarItensComposicaoPedido,
  reescritaDeComposicaoNoEmissorAutorizada,
  decisaoEmissaoComposicaoPreservada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function prepararDb() {
  const db = await abrirDb();
  await run(db, 'CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
  await run(db, 'CREATE TABLE categorias (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, tipo TEXT DEFAULT \'produto\')');
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, categoria_id INTEGER, nome TEXT, ativo INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP, tipo_operacional TEXT DEFAULT 'COMERCIAL',
    utiliza_volume INTEGER DEFAULT 0, volume_valor REAL, volume_unidade TEXT, unidade TEXT,
    utiliza_conversao INTEGER DEFAULT 0, unidade_estoque TEXT, controla_estoque INTEGER DEFAULT 1,
    preco_venda REAL NOT NULL, preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0,
    produto_fracionado INTEGER DEFAULT 0, vendido_por_peso INTEGER DEFAULT 0, venda_atacado INTEGER DEFAULT 0
  )`);
  await run(db, `CREATE TABLE promocoes (
    id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original REAL, preco_promocional REAL,
    data_inicio TEXT, data_fim TEXT, status TEXT DEFAULT 'ativa'
  )`);
  await run(db, 'CREATE TABLE produto_atacado (id INTEGER PRIMARY KEY, produto_id INTEGER, quantidade_minima INTEGER, preco_atacado REAL)');
  await run(db, `CREATE TABLE estoque_empresa (
    produto_id INTEGER, empresa_id INTEGER, saldo_fiscal REAL, saldo_nao_fiscal REAL, estoque_atual REAL,
    reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY, codigo TEXT, empresa_id INTEGER, status TEXT, total REAL,
    desconto REAL DEFAULT 0, frete REAL DEFAULT 0, observacao TEXT, created_at TEXT
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY, pedido_id INTEGER, produto_id INTEGER,
    quantidade REAL, preco_unitario REAL, subtotal REAL
  )`);
  await run(db, 'INSERT INTO empresas (id) VALUES (1)');
  await run(db, "INSERT INTO categorias (id, nome) VALUES (43, 'Pasteis'), (44, 'Refrigerantes')");
  await run(db, `INSERT INTO produtos (
    id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade, utiliza_volume
  ) VALUES
    (747, 43, 'Pastel do Cheff', 13.67, NULL, NULL, 'un', 0),
    (748, 44, 'Refrigerante Copo 200 ml', 8.00, 200, 'ML', 'un', 1),
    (749, 44, 'Refrigerante Copo 300 ml', 15.12, 300, 'ML', 'un', 1)`);
  await run(db, `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
    VALUES (748, 1, 40, 10, 50), (749, 1, 30, 5, 35)`);
  await run(db, `INSERT INTO pedidos (id, codigo, empresa_id, status, total, desconto, frete, observacao, created_at)
    VALUES (65, 'PED-65', 1, 'PEDIDO', 21.99, 0, 0, 'VENDA_POR_VALOR_PASTEIS', '2026-11-11')`);
  await run(db, `INSERT INTO pedidos_itens (id, pedido_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (1, 65, 747, 1, 21.99, 21.99)`);
  return db;
}

function distribuir(composicao, pagamentos, vendaFiscal, saldos, preservar) {
  const entradas = composicao.itens.map((item) => ({
    item,
    saldoFiscal: (saldos[item.produto_id] || {}).saldoFiscal,
    saldoNaoFiscal: (saldos[item.produto_id] || {}).saldoNaoFiscal
  }));
  return distribuirItensVendaComValorFiscalEfetivo(entradas, vendaFiscal, {
    pagamentos,
    desconto: composicao.desconto,
    acrescimo: 0,
    preservarItensComposicaoPedido: preservar
  });
}

function xml(composicao, motor, pagamentos) {
  const venda = {
    total: composicao.valorFinalCentavos / 100,
    desconto: composicao.desconto,
    valor_fiscal: motor.valorFiscalLiquido,
    pagamentos
  };
  const itens = motor.itens.filter((item) => Number(item.quantidade_fiscal) > 0).map((item) => ({
    produto_id: item.produto_id,
    produto_nome: item.produto_id === 747 ? 'Pastel do Cheff' : 'Refrigerante',
    quantidade: item.quantidade,
    quantidade_fiscal: item.quantidade_fiscal,
    quantidade_nao_fiscal: item.quantidade_nao_fiscal,
    preco_unitario: item.preco_unitario,
    valor_fiscal: item.valor_fiscal,
    valor_nao_fiscal: item.valor_nao_fiscal,
    produto_ncm: '19059090',
    cfop: '5102',
    unidade: 'UN',
    origem: 0,
    csosn: '102'
  }));
  const modelo = determinarModeloDeTotais({ itens, venda });
  const documento = buildNfceXml({
    config: {
      codigoUf: '23', cnpj: '65957340000150', ie: '073252638', crt: 1, ambiente: 2, serie: 1,
      nomeEmpresa: 'PASTELARIA HOMOLOGACAO LTDA', logradouro: 'RUA A', numero: '100',
      bairro: 'CENTRO', codigo_municipio: '2307304', municipio: 'JUAZEIRO DO NORTE',
      uf: 'CE', cep: '63000000', telefone: '8835110000', csosn_padrao: '102'
    },
    venda, itens, numero: 1
  });
  return { modelo, documento, itens, venda };
}

const saldosCheios = {
  747: { saldoFiscal: 5, saldoNaoFiscal: 5 },
  748: { saldoFiscal: 40, saldoNaoFiscal: 10 },
  749: { saldoFiscal: 30, saldoNaoFiscal: 5 }
};

test('cenário 1 — PIX preserva o preço comercial e o desconto aparece uma vez', async () => {
  const db = await prepararDb();
  try {
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const pix = [{ forma_pagamento: 'pix', valor: 21.99, status: 'aprovado' }];
    assert.equal(devePreservarItensComposicaoPedido({
      pedidoId: 65,
      itens: composicao.itens,
      desconto: composicao.desconto,
      acrescimo: 0,
      total: 21.99
    }), true);
    const motor = distribuir(composicao, pix, true, saldosCheios, true);
    const pastel = motor.itens.find((item) => item.produto_id === 747);
    const copo = motor.itens.find((item) => item.produto_id === 749);
    const fiscal = xml(composicao, motor, pix);
    const danfe = await gerarDanfeHtml({
      venda: { ...fiscal.venda, ambiente: 2, pagamentos: pix },
      itens: fiscal.itens,
      empresa: { nome_fantasia: 'HOMOLOGACAO', cnpj: '65957340000150' },
      numero: 1,
      serie: 1,
      nota: { ambiente: 2 }
    });
    const decisao = decisaoEmissaoComposicaoPreservada(pix);
    assert.equal(pastel.preco_unitario, 13.67);
    assert.equal(pastel.valor_fiscal, 13.67);
    assert.equal(copo.quantidade, 1);
    assert.equal(copo.valor_fiscal, 15.12);
    assert.equal(motor.valorFiscalLiquido, 21.99);
    assert.equal(motor.totalVenda, 21.99);
    assert.equal(fiscal.modelo.modelo, 'MODELO_BRUTO');
    assert.equal(fiscal.documento.valores.vProd, 28.79);
    assert.equal(fiscal.documento.valores.vDesc, 6.8);
    assert.equal(fiscal.documento.valores.vNF, 21.99);
    assert.match(fiscal.documento.xmlSemAssinatura, /<vUnCom>13\.6700000000<\/vUnCom>/);
    assert.equal(decisao.emitirNfce, true);
    assert.equal(decisao.valorFiscal, 21.99);
    assert.equal(decisao.valorNaoFiscal, 0);
    assert.match(danfe, /21,99/);
    assert.match(danfe, /15\.12/);
    assert.match(danfe, /6,80/);
    assert.doesNotMatch(danfe, /6,87/);
  } finally {
    await fecharDb(db);
  }
});

test('cenário 2 — dinheiro integral não cria referência fiscal', async () => {
  const dinheiro = [{ forma_pagamento: 'dinheiro', valor: 21.99, status: 'aprovado', confirmacao_manual: 1 }];
  const decisao = decisaoEmissaoComposicaoPreservada(dinheiro);
  assert.equal(decisao.valorFiscal, 0);
  assert.equal(decisao.valorNaoFiscal, 21.99);
  assert.equal(decisao.somenteNaoFiscal, true);
  assert.equal(decisao.emitirNfce, false);
});

test('cenários 3, 4 e 5 — misto independe da ordem e não troca a composição', async () => {
  const db = await prepararDb();
  try {
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const dinheiroPrimeiro = [
      { forma_pagamento: 'dinheiro', valor: 11.99, status: 'aprovado', confirmacao_manual: 1 },
      { forma_pagamento: 'pix', valor: 10, status: 'aprovado' }
    ];
    const pixPrimeiro = [dinheiroPrimeiro[1], dinheiroPrimeiro[0]];
    const a = decisaoEmissaoComposicaoPreservada(dinheiroPrimeiro);
    const b = decisaoEmissaoComposicaoPreservada(pixPrimeiro);
    const motor = distribuir(composicao, dinheiroPrimeiro, true, saldosCheios, true);
    assert.deepEqual(a.referencias, b.referencias);
    assert.equal(a.valorFiscal, 10);
    assert.equal(a.valorNaoFiscal, 11.99);
    assert.equal(a.emitirNfce, false);
    assert.equal(a.codigo, 'COMPOSICAO_PEDIDO_MISTA_SEM_NFC');
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
    assert.equal(motor.itens.find((item) => item.produto_id === 749).quantidade, 1);
    assert.equal(motor.itens.find((item) => item.produto_id === 747).valor_fiscal, 13.67);
    assert.equal(composicao.desconto, 6.8);
    assert.notEqual(composicao.desconto, 9.59);
  } finally {
    await fecharDb(db);
  }
});

test('cenário 6 — pendente, recusado e falha não entram na referência fiscal', () => {
  const pagamentos = [
    { forma_pagamento: 'debito', valor: 20, status: 'aprovado' },
    { forma_pagamento: 'credito', valor: 20, status: 'aprovado' },
    { forma_pagamento: 'dinheiro', valor: 10, status: 'aprovado', confirmacao_manual: 1 },
    { forma_pagamento: 'pix', valor: 30, status: 'pendente' },
    { forma_pagamento: 'pix', valor: 15, status: 'rejeitado' },
    { forma_pagamento: 'debito', valor: 8, status: 'falha' }
  ];
  const decisao = decisaoEmissaoComposicaoPreservada(pagamentos);
  assert.equal(decisao.valorFiscal, 40);
  assert.equal(decisao.valorNaoFiscal, 10);
  assert.equal(decisao.valorFiscal + decisao.valorNaoFiscal, 50);
});

test('cenário 7 — a margem de 20% não vira desconto nem autoriza reescrita', () => {
  const pagamentos = [
    { forma_pagamento: 'pix', valor: 10, status: 'aprovado' },
    { forma_pagamento: 'dinheiro', valor: 11.99, status: 'aprovado', confirmacao_manual: 1 }
  ];
  const margem = calcularMargemToleranciaDinheiro(pagamentos);
  const decisao = decisaoEmissaoComposicaoPreservada(pagamentos);
  assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
  assert.equal(margem.nao_e_desconto, true);
  assert.equal(margem.percentual, 0.2);
  assert.equal(margem.margem_maxima, 2.4);
  assert.equal(decisao.codigo, 'COMPOSICAO_PEDIDO_MISTA_SEM_NFC');
  assert.equal(Object.hasOwn(decisao, 'desconto'), false);
});

test('cenário 8 — duas unidades preservam quantidade e subtotal comercial', async () => {
  const db = await prepararDb();
  try {
    await run(db, 'UPDATE pedidos_itens SET quantidade = 2, subtotal = 43.98 WHERE id = 1');
    await run(db, 'UPDATE pedidos SET total = 43.98 WHERE id = 65');
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const pix = [{ forma_pagamento: 'pix', valor: 43.98, status: 'aprovado' }];
    const motor = distribuir(composicao, pix, true, saldosCheios, true);
    const pastel = motor.itens.find((item) => item.produto_id === 747);
    assert.equal(pastel.quantidade, 2);
    assert.equal(pastel.preco_unitario, 13.67);
    assert.equal(pastel.subtotal, 27.34);
    assert.equal(pastel.valor_fiscal, 27.34);
    assert.equal(motor.totalVenda, 43.98);
    assert.ok(composicao.itens.some((item) => item.produto_id !== 747));
  } finally {
    await fecharDb(db);
  }
});

test('cenário 9 — buckets exclusivos e saldo insuficiente bloqueiam sem baixa', async () => {
  const db = await prepararDb();
  try {
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const pix = [{ forma_pagamento: 'pix', valor: 21.99, status: 'aprovado' }];
    const fiscal = distribuir(composicao, pix, true, saldosCheios, true);
    const naoFiscal = distribuir(composicao, pix, false, saldosCheios, true);
    const bloqueio = distribuir(composicao, pix, true, {
      747: { saldoFiscal: 0, saldoNaoFiscal: 9 },
      749: { saldoFiscal: 30, saldoNaoFiscal: 5 }
    }, true);
    const estoque = await all(db, 'SELECT produto_id, saldo_fiscal, saldo_nao_fiscal FROM estoque_empresa ORDER BY produto_id');
    assert.ok(fiscal.itens.every((item) => item.quantidade_nao_fiscal === 0 && item.valor_nao_fiscal === 0));
    assert.ok(naoFiscal.itens.every((item) => item.quantidade_fiscal === 0 && item.valor_fiscal === 0));
    assert.equal(naoFiscal.valorFiscalLiquido, 0);
    assert.equal(naoFiscal.valorNaoFiscalLiquido, 21.99);
    assert.equal(bloqueio.sucesso, false);
    assert.deepEqual(estoque, [
      { produto_id: 748, saldo_fiscal: 40, saldo_nao_fiscal: 10 },
      { produto_id: 749, saldo_fiscal: 30, saldo_nao_fiscal: 5 }
    ]);
  } finally {
    await fecharDb(db);
  }
});

test('cenário 10 — venda sem pedido continua com o rateio proporcional', () => {
  assert.equal(devePreservarItensComposicaoPedido({
    pedidoId: null,
    itens: [{ subtotal: 21.99 }, { subtotal: 15.12 }],
    desconto: 15.12,
    acrescimo: 0,
    total: 21.99
  }), false);
  const motor = distribuirItensVendaComValorFiscalEfetivo([
    { item: { produto_id: 747, quantidade: 1, preco_unitario: 21.99, subtotal: 21.99 }, saldoFiscal: 5, saldoNaoFiscal: 0 },
    { item: { produto_id: 749, quantidade: 1, preco_unitario: 15.12, subtotal: 15.12 }, saldoFiscal: 5, saldoNaoFiscal: 0 }
  ], true, {
    pagamentos: [{ forma_pagamento: 'pix', valor: 21.99, status: 'aprovado' }],
    desconto: 15.12,
    acrescimo: 0
  });
  const pastel = motor.itens.find((item) => item.produto_id === 747);
  const copo = motor.itens.find((item) => item.produto_id === 749);
  assert.equal(pastel.valor_fiscal, 13.03);
  assert.equal(copo.valor_fiscal, 8.96);
  assert.equal(motor.preservouItensComposicaoPedido, false);
});
