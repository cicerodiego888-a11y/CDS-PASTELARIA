'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-validacao-fiscal-valor-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
const { montarItemPedidoPastel } = require('../../backend/services/vendas/VendaPorValorPasteisService');
const { distribuirItensVendaComValorFiscalEfetivo } = require('../../backend/services/distribuidorEstoqueVenda');
const { buildNfceXml } = require('../../backend/services/fiscal/xmlBuilder');
const { determinarModeloDeTotais } = require('../../backend/services/fiscal/modeloTotais');
const { gerarDanfeHtml } = require('../../backend/services/fiscal/danfe');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO,
  calcularMargemToleranciaDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const {
  devePreservarItensComposicaoPedido,
  reescritaDeComposicaoNoEmissorAutorizada,
  decisaoEmissaoComposicaoPreservada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');

const OBS = 'VENDA_POR_VALOR_PASTEIS';

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
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
function centavos(valor) {
  return Math.round(Number(valor) * 100);
}

async function prepararCatalogo() {
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
    venda_atacado INTEGER DEFAULT 0, saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0,
    estoque_atual REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE promocoes (
    id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original REAL, preco_promocional REAL,
    data_inicio TEXT, data_fim TEXT, status TEXT DEFAULT 'ativa'
  )`);
  await run(db, `CREATE TABLE produto_atacado (
    id INTEGER PRIMARY KEY, produto_id INTEGER, quantidade_minima INTEGER, preco_atacado REAL
  )`);
  await run(db, `CREATE TABLE estoque_empresa (
    produto_id INTEGER, empresa_id INTEGER, saldo_fiscal REAL, saldo_nao_fiscal REAL,
    estoque_atual REAL, reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY, codigo TEXT, empresa_id INTEGER, status TEXT, total REAL,
    desconto REAL DEFAULT 0, frete REAL DEFAULT 0, observacao TEXT, created_at TEXT
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER, produto_id INTEGER,
    quantidade REAL, preco_unitario REAL, subtotal REAL
  )`);
  await run(db, 'INSERT INTO empresas (id) VALUES (1)');
  await run(db, `INSERT INTO categorias (id, nome) VALUES (43, 'Pasteis'), (44, 'Refrigerantes')`);
  await run(db, `INSERT INTO produtos (
    id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade, utiliza_volume
  ) VALUES
    (747, 43, 'Pastel do Cheff', 8.99, NULL, NULL, 'un', 0),
    (748, 44, 'Refrigerante Copo 200 ml', 12.99, 200, 'ML', 'un', 1),
    (749, 44, 'Refrigerante Copo 300 ml', 19.80, 300, 'ML', 'un', 1),
    (750, 44, 'Refrigerante Copo 500 ml', 32.99, 500, 'ML', 'un', 1)`);
  await run(db, `INSERT INTO estoque_empresa (
    produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
  ) VALUES
    (747, 1, 20, 20, 40),
    (748, 1, 40, 40, 80),
    (749, 1, 40, 40, 80),
    (750, 1, 40, 40, 80)`);
  return db;
}

async function inserirVendaPorValor(db, pedidoId, valor, quantidade) {
  const item = montarItemPedidoPastel(747, quantidade, centavos(valor));
  await run(db, `INSERT INTO pedidos (
    id, codigo, empresa_id, status, total, desconto, frete, observacao, created_at
  ) VALUES (?, ?, 1, 'PEDIDO', ?, 0, 0, ?, '2026-11-12')`,
  [pedidoId, `PED-${pedidoId}`, valor, OBS]);
  await run(db, `INSERT INTO pedidos_itens (
    pedido_id, produto_id, quantidade, preco_unitario, subtotal
  ) VALUES (?, ?, ?, ?, ?)`,
  [pedidoId, 747, item.quantidade, item.preco_unitario, item.subtotal]);
}

const NOMES = {
  747: 'Pastel do Cheff',
  748: 'Refrigerante Copo 200 ml',
  749: 'Refrigerante Copo 300 ml',
  750: 'Refrigerante Copo 500 ml'
};

function distribuir(composicao, pagamentos, vendaFiscal) {
  const entradas = composicao.itens.map((item) => ({
    item,
    saldoFiscal: 40,
    saldoNaoFiscal: 40
  }));
  return distribuirItensVendaComValorFiscalEfetivo(entradas, vendaFiscal, {
    pagamentos,
    desconto: composicao.desconto,
    acrescimo: 0,
    preservarItensComposicaoPedido: devePreservarItensComposicaoPedido({
      pedidoId: composicao.pedidoId,
      itens: composicao.itens,
      desconto: composicao.desconto,
      acrescimo: 0,
      total: composicao.valorFinalCentavos / 100
    })
  });
}

function itensParaDocumento(motor) {
  return motor.itens
    .filter((item) => Number(item.quantidade_fiscal) > 0)
    .map((item) => ({
      produto_id: item.produto_id,
      produto_nome: NOMES[item.produto_id] || `Produto ${item.produto_id}`,
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
}

function montarXml(composicao, motor, pagamentos) {
  const venda = {
    total: composicao.valorFinalCentavos / 100,
    desconto: composicao.desconto,
    valor_fiscal: motor.valorFiscalLiquido,
    pagamentos
  };
  const itens = itensParaDocumento(motor);
  const modelo = determinarModeloDeTotais({ itens, venda });
  const documento = buildNfceXml({
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
    numero: 68
  });
  return { modelo, documento, itens, venda };
}

function lerDets(xml) {
  const blocos = xml.match(/<det nItem="\d+">[\s\S]*?<\/det>/g) || [];
  return blocos.map((bloco) => ({
    cProd: (bloco.match(/<cProd>([^<]+)<\/cProd>/) || [])[1],
    xProd: (bloco.match(/<xProd>([^<]+)<\/xProd>/) || [])[1],
    qCom: (bloco.match(/<qCom>([^<]+)<\/qCom>/) || [])[1],
    vUnCom: (bloco.match(/<vUnCom>([^<]+)<\/vUnCom>/) || [])[1],
    vProd: (bloco.match(/<vProd>([^<]+)<\/vProd>/) || [])[1],
    vDesc: (bloco.match(/<vDesc>([^<]+)<\/vDesc>/) || [])[1] || '0.00',
    ncm: (bloco.match(/<NCM>([^<]+)<\/NCM>/) || [])[1],
    cfop: (bloco.match(/<CFOP>([^<]+)<\/CFOP>/) || [])[1],
    csosn: (bloco.match(/<CSOSN>([^<]+)<\/CSOSN>/) || [])[1]
  }));
}

function lerTotais(xml) {
  const bloco = (xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/) || [''])[0];
  const tag = (nome) => Number((bloco.match(new RegExp(`<${nome}>([^<]+)</${nome}>`)) || [])[1]);
  return { vProd: tag('vProd'), vDesc: tag('vDesc'), vNF: tag('vNF') };
}

test('pedido 68 preserva a distribuição do payload ao XML e ao DANFE', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirVendaPorValor(db, 68, 61.98, 2);
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 68, empresaId: 1 }, { db });
    const repetida = await prepararComposicaoPedidoPdv({ pedidoId: 68, empresaId: 1 }, { db });
    const pedido = await all(db, 'SELECT total, desconto, observacao FROM pedidos WHERE id = 68');
    const linhas = await all(db, 'SELECT produto_id, quantidade, subtotal FROM pedidos_itens WHERE pedido_id = 68');
    const pix = [{ forma_pagamento: 'pix', valor: 61.98, status: 'aprovada', aprovado: true }];
    const preservar = devePreservarItensComposicaoPedido({
      pedidoId: 68,
      itens: composicao.itens,
      desconto: composicao.desconto,
      acrescimo: 0,
      total: 61.98
    });
    const motor = distribuir(composicao, pix, true);
    const fiscal = montarXml(composicao, motor, pix);
    const danfe = await gerarDanfeHtml({
      venda: { ...fiscal.venda, ambiente: 2, pagamentos: pix },
      itens: fiscal.itens,
      empresa: { nome_fantasia: 'HOMOLOGACAO', cnpj: '65957340000150' },
      numero: 68,
      serie: 1,
      nota: { ambiente: 2 }
    });
    const dets = lerDets(fiscal.documento.xmlSemAssinatura);
    const totais = lerTotais(fiscal.documento.xmlSemAssinatura);
    const decisao = decisaoEmissaoComposicaoPreservada(pix);
    const pastel = composicao.itens.find((item) => item.produto_id === 747);
    const copos = composicao.itens.filter((item) => item.produto_id !== 747);
    const coposCentavos = copos.reduce((soma, item) => soma + centavos(item.subtotal), 0);

    assert.equal(pedido[0].total, 61.98);
    assert.equal(pedido[0].desconto, 0);
    assert.deepEqual(linhas, [{ produto_id: 747, quantidade: 2, subtotal: 61.98 }]);
    assert.equal(pastel.subtotal, 17.98);
    assert.equal(pastel.quantidade, 2);
    assert.equal(coposCentavos, 4578);
    assert.equal(composicao.descontoCentavos, 178);
    assert.equal(composicao.valorFinalCentavos, 6198);
    assert.equal(centavos(pastel.subtotal) + coposCentavos - composicao.descontoCentavos, 6198);
    assert.equal(repetida.fingerprint, composicao.fingerprint);
    assert.deepEqual(repetida.itens, composicao.itens);
    assert.equal(preservar, true);
    assert.equal(motor.preservouItensComposicaoPedido, true);
    assert.equal(motor.itens.find((item) => item.produto_id === 747).valor_fiscal, 17.98);
    assert.equal(motor.itens.find((item) => item.produto_id === 747).preco_unitario, 8.99);
    assert.equal(motor.valorFiscalLiquido, 61.98);
    assert.equal(motor.totalVenda, 61.98);
    assert.equal(motor.itens.length, 3);
    assert.equal(fiscal.modelo.modelo, 'MODELO_BRUTO');
    assert.equal(fiscal.documento.valores.vProd, 63.76);
    assert.equal(fiscal.documento.valores.vDesc, 1.78);
    assert.equal(fiscal.documento.valores.vNF, 61.98);
    assert.equal(totais.vProd, 63.76);
    assert.equal(totais.vDesc, 1.78);
    assert.equal(totais.vNF, 61.98);
    assert.equal(dets.length, 3);
    assert.equal(dets[0].qCom, '2.0000');
    assert.equal(dets[0].vUnCom, '8.9900000000');
    assert.equal(dets[0].vProd, '17.98');
    assert.equal(
      dets.reduce((soma, det) => soma + centavos(det.vProd), 0),
      6376
    );
    assert.equal(
      dets.reduce((soma, det) => soma + centavos(det.vDesc), 0),
      178
    );
    assert.equal(decisao.emitirNfce, true);
    assert.equal(decisao.valorFiscal, 61.98);
    assert.equal(decisao.valorNaoFiscal, 0);
    assert.match(danfe, /17\.98/);
    assert.match(danfe, /25\.98/);
    assert.match(danfe, /19\.80/);
    assert.match(danfe, /R\$ 1,78/);
    assert.match(danfe, /R\$ 61,98/);
    assert.equal((danfe.match(/R\$ 1,78/g) || []).length, 1);
    assert.equal((danfe.match(/R\$ 45,78/g) || []).length, 0);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
  } finally {
    await fecharDb(db);
  }
});

test('combinação exata fecha sem desconto técnico', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirVendaPorValor(db, 81, 30.97, 2);
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 81, empresaId: 1 }, { db });
    const pix = [{ forma_pagamento: 'pix', valor: 30.97, status: 'aprovada', aprovado: true }];
    const motor = distribuir(composicao, pix, true);
    const fiscal = montarXml(composicao, motor, pix);
    const totais = lerTotais(fiscal.documento.xmlSemAssinatura);
    const danfe = await gerarDanfeHtml({
      venda: { ...fiscal.venda, ambiente: 2 },
      itens: fiscal.itens,
      empresa: { nome_fantasia: 'HOMOLOGACAO', cnpj: '65957340000150' },
      numero: 81,
      serie: 1,
      nota: { ambiente: 2 }
    });
    assert.equal(composicao.descontoCentavos, 0);
    assert.equal(composicao.itens.find((item) => item.produto_id === 747).subtotal, 17.98);
    assert.equal(motor.itens.find((item) => item.produto_id === 747).valor_fiscal, 17.98);
    assert.equal(fiscal.modelo.modelo, 'MODELO_LIQUIDO');
    assert.equal(totais.vProd, 30.97);
    assert.equal(totais.vDesc, 0);
    assert.equal(totais.vNF, 30.97);
    assert.match(danfe, /17\.98/);
    assert.match(danfe, /R\$ 30,97/);
    assert.doesNotMatch(danfe, /R\$ 12,99[\s\S]*Desconto:\s*R\$ 12,99/);
  } finally {
    await fecharDb(db);
  }
});

test('quantidades 1, 2 e 3 mantêm o pastel fiscal no cadastro', async () => {
  const db = await prepararCatalogo();
  try {
    const casos = [
      { id: 91, valor: 21.98, quantidade: 1 },
      { id: 92, valor: 61.98, quantidade: 2 },
      { id: 93, valor: 50, quantidade: 3 }
    ];
    for (const caso of casos) {
      await inserirVendaPorValor(db, caso.id, caso.valor, caso.quantidade);
      const composicao = await prepararComposicaoPedidoPdv({ pedidoId: caso.id, empresaId: 1 }, { db });
      const catalogo = Math.round(8.99 * caso.quantidade * 100);
      const pastel = composicao.itens.find((item) => item.produto_id === 747);
      const copos = composicao.itens
        .filter((item) => item.produto_id !== 747)
        .reduce((soma, item) => soma + centavos(item.subtotal), 0);
      const pix = [{ forma_pagamento: 'pix', valor: caso.valor, status: 'aprovada', aprovado: true }];
      const motor = distribuir(composicao, pix, true);
      const fiscalPastel = motor.itens.find((item) => item.produto_id === 747);
      const linhas = await all(db, 'SELECT COUNT(*) AS n FROM pedidos_itens WHERE pedido_id = ?', [caso.id]);
      assert.equal(centavos(pastel.subtotal), catalogo, `qtd ${caso.quantidade}`);
      assert.equal(composicao.descontoCentavos, copos - composicao.valorResidualCentavos);
      assert.equal(centavos(pastel.subtotal) + copos - composicao.descontoCentavos, centavos(caso.valor));
      assert.equal(fiscalPastel.valor_fiscal, pastel.subtotal);
      assert.notEqual(fiscalPastel.valor_fiscal, caso.valor);
      assert.equal(linhas[0].n, 1);
      assert.equal(motor.itens.filter((item) => item.produto_id === 748).length <= 1, true);
    }
  } finally {
    await fecharDb(db);
  }
});

test('pedido comercial com pastel unifica residual e preserva total 61,98', async () => {
  const db = await prepararCatalogo();
  try {
    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, created_at
    ) VALUES (96, 'PED-NORMAL', 1, 'PEDIDO', 61.98, 0, 0, '2026-11-12')`);
    await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (96, 747, 2, 21.99, 43.98), (96, 748, 1, 18.00, 18.00)`);
    const normal = await prepararComposicaoPedidoPdv({ pedidoId: 96, empresaId: 1 }, { db });
    const pix = [{ forma_pagamento: 'pix', valor: normal.valorFinalCentavos / 100, status: 'aprovada', aprovado: true }];
    const motor = distribuir(normal, pix, true);
    assert.equal(normal.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(normal.valorFinalCentavos, 6198);
    assert.equal(normal.valorResidualCentavos, 4400);
    assert.equal(normal.valorPastelCentavos, 1798);
    assert.equal(motor.itens.find((item) => item.produto_id === 747).valor_fiscal, 17.98);
    assert.equal(motor.valorFiscalLiquido, normal.valorFinalCentavos / 100);
  } finally {
    await fecharDb(db);
  }
});

test('dinheiro, PIX e misto não alteram a classificação nem a margem de 20%', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirVendaPorValor(db, 68, 61.98, 2);
    const composicao = await prepararComposicaoPedidoPdv({ pedidoId: 68, empresaId: 1 }, { db });
    const dinheiro = [{ forma_pagamento: 'dinheiro', valor: 61.98, status: 'informada', confirmacao_manual: 1 }];
    const pix = [{ forma_pagamento: 'pix', valor: 61.98, status: 'aprovada', aprovado: true }];
    const misto = [
      { forma_pagamento: 'pix', valor: 30, status: 'aprovada', aprovado: true },
      { forma_pagamento: 'dinheiro', valor: 31.98, status: 'informada', confirmacao_manual: 1 }
    ];
    const soDinheiro = decisaoEmissaoComposicaoPreservada(dinheiro);
    const soPix = decisaoEmissaoComposicaoPreservada(pix);
    const mistura = decisaoEmissaoComposicaoPreservada(misto);
    const margem = calcularMargemToleranciaDinheiro(dinheiro);
    const motorDinheiro = distribuir(composicao, dinheiro, false);
    const motorPix = distribuir(composicao, pix, true);
    assert.equal(PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO, 0.2);
    assert.equal(margem.margem_maxima, 12.4);
    assert.equal(margem.nao_e_desconto, true);
    assert.equal(soDinheiro.valorFiscal, 0);
    assert.equal(soDinheiro.valorNaoFiscal, 61.98);
    assert.equal(soDinheiro.emitirNfce, false);
    assert.equal(soPix.valorFiscal, 61.98);
    assert.equal(soPix.valorNaoFiscal, 0);
    assert.equal(soPix.emitirNfce, true);
    assert.equal(mistura.valorFiscal, 30);
    assert.equal(mistura.valorNaoFiscal, 31.98);
    assert.equal(mistura.emitirNfce, false);
    assert.equal(mistura.codigo, 'COMPOSICAO_PEDIDO_MISTA_SEM_NFC');
    assert.equal(motorDinheiro.itens.find((item) => item.produto_id === 747).valor_nao_fiscal, 17.98);
    assert.equal(motorDinheiro.itens.find((item) => item.produto_id === 747).valor_fiscal, 0);
    assert.equal(motorDinheiro.valorNaoFiscalLiquido, 61.98);
    assert.equal(motorPix.itens.find((item) => item.produto_id === 747).valor_fiscal, 17.98);
    assert.equal(composicao.descontoCentavos, 178);
  } finally {
    await fecharDb(db);
  }
});
