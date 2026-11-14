'use strict';

/**
 * CDS-FISCAL-PEDIDO-FECHAMENTO-AUDIT-01
 * Auditoria somente leitura do fechamento após a composição do pedido.
 * Não grava estoque, não transmite NFC-e e não abre o banco oficial.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
const { distribuirItensVendaComValorFiscalEfetivo } = require('../../backend/services/distribuidorEstoqueVenda');
const { buildNfceXml } = require('../../backend/services/fiscal/xmlBuilder');
const { determinarModeloDeTotais } = require('../../backend/services/fiscal/modeloTotais');
const { gerarDanfeHtml } = require('../../backend/services/fiscal/danfe');
const {
  itensFiscaisInteirosParaReferencia
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');
const {
  calcularReferenciasConfirmadas,
  avaliarReferenciaRecomposicao
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID });
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function fecharDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function prepararDb() {
  const db = await abrirDb();
  await run(db, 'CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
  await run(db, `CREATE TABLE categorias (
    id INTEGER PRIMARY KEY, nome TEXT NOT NULL, tipo TEXT DEFAULT 'produto'
  )`);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, categoria_id INTEGER, nome TEXT, ativo INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP, tipo_operacional TEXT DEFAULT 'COMERCIAL',
    utiliza_volume INTEGER DEFAULT 0, volume_valor REAL, volume_unidade TEXT, unidade TEXT,
    utiliza_conversao INTEGER DEFAULT 0, unidade_estoque TEXT, controla_estoque INTEGER DEFAULT 1,
    preco_venda REAL NOT NULL, preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0,
    produto_fracionado INTEGER DEFAULT 0, vendido_por_peso INTEGER DEFAULT 0,
    venda_atacado INTEGER DEFAULT 0
  )`);
  await run(db, `CREATE TABLE promocoes (
    id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original REAL, preco_promocional REAL,
    data_inicio TEXT, data_fim TEXT, status TEXT DEFAULT 'ativa'
  )`);
  await run(db, `CREATE TABLE produto_atacado (
    id INTEGER PRIMARY KEY, produto_id INTEGER, quantidade_minima INTEGER, preco_atacado REAL
  )`);
  await run(db, `CREATE TABLE estoque_empresa (
    id INTEGER PRIMARY KEY, produto_id INTEGER, empresa_id INTEGER,
    saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0,
    estoque_atual REAL DEFAULT 0, reservado_fiscal REAL DEFAULT 0,
    reservado_nao_fiscal REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY, codigo TEXT, cliente_id INTEGER, empresa_id INTEGER,
    status TEXT, total REAL, desconto REAL DEFAULT 0, frete REAL DEFAULT 0,
    created_at TEXT, updated_at TEXT
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY, pedido_id INTEGER, produto_id INTEGER,
    quantidade REAL, preco_unitario REAL, subtotal REAL
  )`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY, pedido_id INTEGER, total REAL, desconto REAL,
    valor_fiscal REAL, valor_nao_fiscal REAL
  )`);
  await run(db, `CREATE TABLE vendas_itens (
    id INTEGER PRIMARY KEY, venda_id INTEGER, produto_id INTEGER,
    quantidade REAL, preco_unitario REAL, subtotal REAL,
    quantidade_fiscal REAL, quantidade_nao_fiscal REAL,
    valor_fiscal REAL, valor_nao_fiscal REAL
  )`);
  await run(db, 'INSERT INTO empresas (id) VALUES (1)');
  await run(db, `INSERT INTO categorias (id, nome) VALUES (43, 'Pasteis'), (44, 'Refrigerantes')`);
  await run(db, `INSERT INTO produtos (
    id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
    utiliza_volume, controla_estoque
  ) VALUES
    (747, 43, 'Pastel do Cheff', 13.67, NULL, NULL, 'un', 0, 1),
    (748, 44, 'Refrigerante Copo 200 ml', 8.00, 200, 'ML', 'un', 1, 1),
    (749, 44, 'Refrigerante Copo 300 ml', 15.12, 300, 'ML', 'un', 1, 1)`);
  await run(db, `INSERT INTO estoque_empresa (
    produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
  ) VALUES
    (748, 1, 40, 10, 50),
    (749, 1, 30, 5, 35)`);
  await run(db, `INSERT INTO pedidos (
    id, codigo, empresa_id, status, total, desconto, frete, created_at
  ) VALUES (65, 'PED-65', 1, 'PEDIDO', 21.99, 0, 0, '2026-11-11')`);
  await run(db, `INSERT INTO pedidos_itens (
    id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
  ) VALUES (1, 65, 747, 1, 21.99, 21.99)`);
  return db;
}

function nomes() {
  return {
    747: 'Pastel do Cheff',
    748: 'Refrigerante Copo 200 ml',
    749: 'Refrigerante Copo 300 ml'
  };
}

function fecharComposicao(composicao, pagamentos, vendaFiscal, saldos) {
  const antes = composicao.itens.map((item) => ({ ...item }));
  const entradas = composicao.itens.map((item) => {
    const saldo = saldos[item.produto_id] || { saldoFiscal: 10, saldoNaoFiscal: 0 };
    return {
      item: {
        ...item,
        produto_nome: nomes()[item.produto_id],
        categoria_nome: item.produto_id === 747 ? 'Pasteis' : 'Refrigerantes',
        preco_venda: item.produto_id === 747 ? 13.67 : item.preco_unitario
      },
      saldoFiscal: saldo.saldoFiscal,
      saldoNaoFiscal: saldo.saldoNaoFiscal
    };
  });
  const motor = distribuirItensVendaComValorFiscalEfetivo(entradas, vendaFiscal, {
    pagamentos,
    desconto: composicao.desconto,
    acrescimo: 0
  });
  return { antes, motor, pagamentosRecebidos: pagamentos.map((p) => ({ ...p })) };
}

function xmlDoFechamento(composicao, motor, pagamentos) {
  const venda = {
    total: composicao.valorFinalCentavos / 100,
    desconto: composicao.desconto,
    valor_fiscal: motor.valorFiscalLiquido,
    valor_nao_fiscal: motor.valorNaoFiscal,
    forma_pagamento: pagamentos[0].forma_pagamento,
    pagamentos
  };
  const itens = motor.itens.map((item) => ({
    produto_id: item.produto_id,
    produto_nome: nomes()[item.produto_id] || 'Item',
    quantidade: item.quantidade,
    quantidade_fiscal: item.quantidade_fiscal,
    quantidade_nao_fiscal: item.quantidade_nao_fiscal,
    preco_unitario: item.preco_unitario,
    subtotal: item.subtotal,
    valor_fiscal: item.valor_fiscal,
    valor_nao_fiscal: item.valor_nao_fiscal,
    produto_ncm: '19059090',
    cfop: '5102',
    unidade: 'UN',
    origem: 0,
    csosn: '102'
  }));
  const modelo = determinarModeloDeTotais({ itens, venda });
  const xml = buildNfceXml({
    config: {
      codigoUf: '23',
      cnpj: '65957340000150',
      ie: '073252638',
      crt: 1,
      ambiente: 2,
      serie: 1,
      nomeEmpresa: 'PASTELARIA HOMOLOGACAO LTDA',
      logradouro: 'RUA A',
      numero: '100',
      bairro: 'CENTRO',
      codigo_municipio: '2307304',
      municipio: 'JUAZEIRO DO NORTE',
      uf: 'CE',
      cep: '63000000',
      telefone: '8835110000',
      csosn_padrao: '102'
    },
    venda,
    itens,
    numero: 1
  });
  return { venda, itens, modelo, xml };
}

async function persistirEspelho(db, composicao, motor) {
  const venda = await run(db, `INSERT INTO vendas (
    pedido_id, total, desconto, valor_fiscal, valor_nao_fiscal
  ) VALUES (?, ?, ?, ?, ?)`, [
    composicao.pedidoId,
    composicao.valorFinalCentavos / 100,
    composicao.desconto,
    motor.valorFiscalLiquido,
    motor.valorNaoFiscal
  ]);
  for (const item of motor.itens) {
    await run(db, `INSERT INTO vendas_itens (
      venda_id, produto_id, quantidade, preco_unitario, subtotal,
      quantidade_fiscal, quantidade_nao_fiscal, valor_fiscal, valor_nao_fiscal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      venda.lastID,
      item.produto_id,
      item.quantidade,
      item.preco_unitario,
      item.subtotal,
      item.quantidade_fiscal,
      item.quantidade_nao_fiscal,
      item.valor_fiscal,
      item.valor_nao_fiscal
    ]);
  }
  return venda.lastID;
}

test('cenário 1 — fechamento reduz o unitário fiscal e o XML não reaplica o desconto', async () => {
  const db = await prepararDb();
  try {
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const pagamentos = [{ forma_pagamento: 'pix', valor: 21.99, status: 'aprovado', tipo_recebimento: 'fiscal' }];
    const fechamento = fecharComposicao(composicao, pagamentos, true, {
      747: { saldoFiscal: 5, saldoNaoFiscal: 5 },
      749: { saldoFiscal: 30, saldoNaoFiscal: 5 }
    });
    assert.equal(fechamento.motor.sucesso, true);
    const pastel = fechamento.motor.itens.find((item) => item.produto_id === 747);
    const copo = fechamento.motor.itens.find((item) => item.produto_id === 749);
    const documento = xmlDoFechamento(composicao, fechamento.motor, pagamentos);
    const danfe = await gerarDanfeHtml({
      venda: {
        ...documento.venda,
        ambiente: 2,
        pagamentos
      },
      itens: documento.itens,
      empresa: { nome_fantasia: 'HOMOLOGACAO', cnpj: '65957340000150' },
      chave: '0'.repeat(44),
      numero: 1,
      serie: 1,
      nota: { ambiente: 2 }
    });
    const vendaId = await persistirEspelho(db, composicao, fechamento.motor);
    const gravado = await all(db, 'SELECT * FROM vendas_itens WHERE venda_id = ? ORDER BY produto_id', [vendaId]);
    const estoque = await all(db, 'SELECT produto_id, saldo_fiscal, saldo_nao_fiscal FROM estoque_empresa ORDER BY produto_id');

    console.log(JSON.stringify({
      cenario: 1,
      preparacao: {
        pastel: 21.99,
        refrigerante: 15.12,
        bruto: composicao.valorCompostoBrutoCentavos / 100,
        desconto: composicao.desconto,
        liquido: composicao.valorFinalCentavos / 100
      },
      antes: fechamento.antes.map((item) => ({
        produto_id: item.produto_id,
        preco_unitario: item.preco_unitario,
        subtotal: item.subtotal
      })),
      depois: fechamento.motor.itens.map((item) => ({
        produto_id: item.produto_id,
        preco_unitario: item.preco_unitario,
        subtotal: item.subtotal,
        quantidade_fiscal: item.quantidade_fiscal,
        quantidade_nao_fiscal: item.quantidade_nao_fiscal,
        valor_fiscal: item.valor_fiscal,
        valor_nao_fiscal: item.valor_nao_fiscal
      })),
      fator: fechamento.motor.liquidoComercial && fechamento.motor.liquidoComercial.fator,
      totalMotor: fechamento.motor.totalVenda,
      modelo: documento.modelo.modelo,
      vDesc: documento.xml.valores.vDesc,
      vNF: documento.xml.valores.vNF,
      vProd: documento.xml.valores.vProd,
      danfeTemDesconto: danfe.includes('15,12') || danfe.includes('15.12'),
      danfeTem2199: danfe.includes('21,99') || danfe.includes('21.99'),
      danfeTem687: danfe.includes('6,87') || danfe.includes('6.87')
    }));

    assert.equal(composicao.desconto, 15.12);
    assert.equal(composicao.valorFinalCentavos, 2199);
    assert.equal(pastel.preco_unitario, 21.99);
    assert.equal(pastel.subtotal, 21.99);
    assert.ok(pastel.valor_fiscal < 21.99);
    assert.ok(copo.valor_fiscal < 15.12);
    assert.equal(fechamento.motor.totalVenda, 21.99);
    assert.equal(documento.xml.valores.vNF, 21.99);
    assert.equal(documento.xml.valores.vDesc, 0);
    assert.equal(documento.modelo.modelo, 'MODELO_LIQUIDO');
    assert.equal(gravado.find((item) => item.produto_id === 747).preco_unitario, 21.99);
    assert.notEqual(gravado.find((item) => item.produto_id === 747).valor_fiscal, 21.99);
    assert.deepEqual(estoque, [
      { produto_id: 748, saldo_fiscal: 40, saldo_nao_fiscal: 10 },
      { produto_id: 749, saldo_fiscal: 30, saldo_nao_fiscal: 5 }
    ]);
    assert.match(danfe, /13[,.]03/);
    assert.doesNotMatch(danfe, /6[,.]87/);
    assert.match(danfe, /Desconto/);
  } finally {
    await fecharDb(db);
  }
});

test('cenário 2 — sem desconto técnico o fechamento não inventa desconto', async () => {
  const db = await prepararDb();
  try {
    await run(db, 'UPDATE produtos SET preco_venda = 13.67 WHERE id = 747');
    await run(db, 'UPDATE pedidos_itens SET preco_unitario = 13.67, subtotal = 13.67 WHERE id = 1');
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (2, 65, 748, 1, 8.32, 8.32)`);
    await run(db, 'UPDATE pedidos SET total = 21.99 WHERE id = 65');
    await run(db, 'UPDATE produtos SET preco_venda = 8.32 WHERE id = 748');
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const pagamentos = [{ forma_pagamento: 'pix', valor: 21.99, status: 'aprovado' }];
    const fechamento = fecharComposicao(composicao, pagamentos, true, {
      747: { saldoFiscal: 5, saldoNaoFiscal: 0 },
      748: { saldoFiscal: 40, saldoNaoFiscal: 10 }
    });
    const documento = xmlDoFechamento(composicao, fechamento.motor, pagamentos);
    const pastel = fechamento.motor.itens.find((item) => item.produto_id === 747);
    console.log(JSON.stringify({
      cenario: 2,
      desconto: composicao.desconto,
      pastelPreco: pastel.preco_unitario,
      pastelFiscal: pastel.valor_fiscal,
      totalMotor: fechamento.motor.totalVenda,
      vDesc: documento.xml.valores.vDesc,
      vNF: documento.xml.valores.vNF,
      vUnCom: documento.xml.xmlSemAssinatura.includes('<vUnCom>13.6700000000</vUnCom>')
    }));
    assert.equal(composicao.descontoCentavos, 0);
    assert.equal(pastel.preco_unitario, 13.67);
    assert.equal(pastel.valor_fiscal, 13.67);
    assert.equal(documento.xml.valores.vDesc, 0);
    assert.equal(documento.xml.valores.vNF, 21.99);
    assert.match(documento.xml.xmlSemAssinatura, /<vUnCom>13\.6700000000<\/vUnCom>/);
  } finally {
    await fecharDb(db);
  }
});

test('cenário 3 — bucket fiscal e não fiscal não se misturam e os saldos não são baixados', async () => {
  const db = await prepararDb();
  try {
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const pagamentos = [{ forma_pagamento: 'pix', valor: 21.99, status: 'aprovado' }];
    const fiscal = fecharComposicao(composicao, pagamentos, true, {
      747: { saldoFiscal: 5, saldoNaoFiscal: 9 },
      749: { saldoFiscal: 30, saldoNaoFiscal: 5 }
    });
    const naoFiscal = fecharComposicao(composicao, pagamentos, false, {
      747: { saldoFiscal: 5, saldoNaoFiscal: 9 },
      749: { saldoFiscal: 30, saldoNaoFiscal: 5 }
    });
    const bloqueio = fecharComposicao(composicao, pagamentos, true, {
      747: { saldoFiscal: 0, saldoNaoFiscal: 9 },
      749: { saldoFiscal: 30, saldoNaoFiscal: 5 }
    });
    const estoque = await all(db, 'SELECT produto_id, saldo_fiscal, saldo_nao_fiscal FROM estoque_empresa ORDER BY produto_id');
    console.log(JSON.stringify({
      cenario: 3,
      fiscal: fiscal.motor.itens.map((item) => ({
        produto_id: item.produto_id,
        qF: item.quantidade_fiscal,
        qNF: item.quantidade_nao_fiscal,
        vF: item.valor_fiscal,
        vNF: item.valor_nao_fiscal
      })),
      naoFiscal: naoFiscal.motor.sucesso ? naoFiscal.motor.itens.map((item) => ({
        produto_id: item.produto_id,
        qF: item.quantidade_fiscal,
        qNF: item.quantidade_nao_fiscal,
        vF: item.valor_fiscal,
        vNF: item.valor_nao_fiscal
      })) : naoFiscal.motor,
      bloqueio: bloqueio.motor.sucesso
    }));
    assert.equal(fiscal.motor.sucesso, true);
    assert.ok(fiscal.motor.itens.every((item) => item.quantidade_nao_fiscal === 0));
    assert.ok(fiscal.motor.itens.every((item) => item.valor_nao_fiscal === 0));
    assert.equal(naoFiscal.motor.sucesso, true);
    assert.ok(naoFiscal.motor.itens.every((item) => item.quantidade_fiscal === 0));
    assert.ok(naoFiscal.motor.itens.every((item) => item.valor_fiscal === 0));
    assert.equal(naoFiscal.motor.totalVenda, 21.99);
    assert.equal(bloqueio.motor.sucesso, false);
    assert.deepEqual(estoque, [
      { produto_id: 748, saldo_fiscal: 40, saldo_nao_fiscal: 10 },
      { produto_id: 749, saldo_fiscal: 30, saldo_nao_fiscal: 5 }
    ]);
  } finally {
    await fecharDb(db);
  }
});

test('cenário 4 — pagamento digital, dinheiro e misto não alteram o valor recebido', async () => {
  const db = await prepararDb();
  try {
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const saldos = {
      747: { saldoFiscal: 5, saldoNaoFiscal: 5 },
      749: { saldoFiscal: 30, saldoNaoFiscal: 5 }
    };
    const pix = [{ forma_pagamento: 'pix', valor: 21.99, status: 'aprovado' }];
    const dinheiro = [{ forma_pagamento: 'dinheiro', valor: 21.99, status: 'aprovado' }];
    const misto = [
      { forma_pagamento: 'pix', valor: 10, status: 'aprovado' },
      { forma_pagamento: 'dinheiro', valor: 11.99, status: 'aprovado' }
    ];
    const fechadoPix = fecharComposicao(composicao, pix, true, saldos);
    const fechadoDinheiro = fecharComposicao(composicao, dinheiro, true, saldos);
    const fechadoMisto = fecharComposicao(composicao, misto, true, saldos);
    const referencia = calcularReferenciasConfirmadas(misto);
    const avaliacaoPadrao = avaliarReferenciaRecomposicao({
      total: 21.99,
      pagamentos: misto,
      itens: composicao.itens
    }, { env: {} });
    const itensRecomposicao = fechadoMisto.motor.itens.map((item) => ({
      ...item,
      categoria_nome: item.produto_id === 747 ? 'Pasteis' : 'Refrigerantes',
      preco_venda: item.produto_id === 747 ? 13.67 : item.preco_unitario
    }));
    const reescrito = await itensFiscaisInteirosParaReferencia({
      itens: itensRecomposicao,
      pagamentos: misto,
      total: 21.99,
      db
    });
    console.log(JSON.stringify({
      cenario: 4,
      pixTotal: fechadoPix.motor.totalVenda,
      dinheiroTotal: fechadoDinheiro.motor.totalVenda,
      mistoTotal: fechadoMisto.motor.totalVenda,
      pagamentos: misto,
      referencia,
      recomposicaoPadraoExecutada: avaliacaoPadrao.recomposicao_executada,
      reescrito: reescrito && {
        desconto: reescrito.desconto,
        dinheiro_aplicado: reescrito.dinheiro_aplicado,
        valor_fiscal_liquido: reescrito.valor_fiscal_liquido,
        valor_produtos: reescrito.valor_produtos,
        itens: reescrito.itens.map((item) => ({
          produto_id: item.produto_id,
          quantidade: item.quantidade,
          preco_unitario: item.preco_unitario,
          valor_fiscal: item.valor_fiscal
        }))
      }
    }));
    assert.equal(fechadoPix.motor.totalVenda, 21.99);
    assert.equal(fechadoDinheiro.motor.totalVenda, 21.99);
    assert.equal(fechadoMisto.motor.totalVenda, 21.99);
    assert.deepEqual(fechadoMisto.pagamentosRecebidos, misto);
    assert.equal(avaliacaoPadrao.recomposicao_executada, false);
    assert.equal(referencia.valor_fiscal_referencia, 10);
    assert.equal(referencia.valor_nao_fiscal_referencia, 11.99);
    assert.ok(reescrito);
    assert.equal(reescrito.itens.some((item) => item.produto_id === 749), false);
    assert.equal(reescrito.itens[0].preco_unitario, 21.99);
    assert.notEqual(reescrito.desconto, composicao.desconto);
  } finally {
    await fecharDb(db);
  }
});

test('cenário 5 — duas unidades mantêm quantidade e o líquido do pedido', async () => {
  const db = await prepararDb();
  try {
    await run(db, 'UPDATE pedidos_itens SET quantidade = 2, preco_unitario = 21.99, subtotal = 43.98 WHERE id = 1');
    await run(db, 'UPDATE pedidos SET total = 43.98 WHERE id = 65');
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const pagamentos = [{ forma_pagamento: 'pix', valor: 43.98, status: 'aprovado' }];
    const saldos = {};
    for (const item of composicao.itens) {
      saldos[item.produto_id] = { saldoFiscal: 20, saldoNaoFiscal: 0 };
    }
    const fechamento = fecharComposicao(composicao, pagamentos, true, saldos);
    const pastel = fechamento.motor.itens.find((item) => item.produto_id === 747);
    const documento = xmlDoFechamento(composicao, fechamento.motor, pagamentos);
    console.log(JSON.stringify({
      cenario: 5,
      quantidade: pastel.quantidade,
      subtotal: pastel.subtotal,
      valorFiscal: pastel.valor_fiscal,
      desconto: composicao.desconto,
      totalMotor: fechamento.motor.totalVenda,
      vNF: documento.xml.valores.vNF,
      vDesc: documento.xml.valores.vDesc
    }));
    assert.equal(pastel.quantidade, 2);
    assert.equal(pastel.preco_unitario, 21.99);
    assert.equal(pastel.subtotal, 43.98);
    assert.equal(fechamento.motor.totalVenda, 43.98);
    assert.equal(documento.xml.valores.vNF, 43.98);
    assert.ok(pastel.valor_fiscal < 43.98);
  } finally {
    await fecharDb(db);
  }
});

test('cenário 6 — o unitário impresso do pastel fica abaixo do preço comercial', async () => {
  const db = await prepararDb();
  try {
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 65, empresaId: 1 }, { db });
    const pagamentos = [{ forma_pagamento: 'pix', valor: 21.99, status: 'aprovado' }];
    const fechamento = fecharComposicao(composicao, pagamentos, true, {
      747: { saldoFiscal: 5, saldoNaoFiscal: 0 },
      749: { saldoFiscal: 30, saldoNaoFiscal: 0 }
    });
    const pastel = fechamento.motor.itens.find((item) => item.produto_id === 747);
    const unitarioFiscal = pastel.valor_fiscal / pastel.quantidade_fiscal;
    const documento = xmlDoFechamento(composicao, fechamento.motor, pagamentos);
    console.log(JSON.stringify({
      cenario: 6,
      precoComercial: pastel.preco_unitario,
      unitarioFiscal,
      vUnCom: (documento.xml.xmlSemAssinatura.match(/<vUnCom>([^<]+)<\/vUnCom>/) || [])[1]
    }));
    assert.equal(pastel.preco_unitario, 21.99);
    assert.ok(unitarioFiscal < 21.99);
    assert.doesNotMatch(documento.xml.xmlSemAssinatura, /<vUnCom>21\.9900000000<\/vUnCom>/);
    assert.doesNotMatch(documento.xml.xmlSemAssinatura, /6\.87/);
  } finally {
    await fecharDb(db);
  }
});
