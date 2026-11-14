'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-audit-emissor-valor-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.RECOMPOSICAO_HABILITADA_EM_PRODUCAO;

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { emitirPorVendaId } = require('../../backend/services/fiscal/emissor');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  reescritaDeComposicaoNoEmissorAutorizada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');
const {
  PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO,
  calcularMargemToleranciaDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');

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
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}
function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function prepararDb() {
  const db = await abrirDb();
  await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, cpf_cnpj TEXT)');
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY, empresa_id INTEGER, cliente_id INTEGER,
    total REAL, desconto REAL, valor_fiscal REAL, status_pagamento TEXT, forma_pagamento TEXT
  )`);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, nome TEXT, ncm TEXT, cfop TEXT, csosn TEXT, origem INTEGER,
    cest TEXT, codigo_barras TEXT, unidade TEXT, preco_venda REAL,
    produto_fracionado INTEGER, vendido_por_peso INTEGER
  )`);
  await run(db, `CREATE TABLE vendas_itens (
    id INTEGER PRIMARY KEY, venda_id INTEGER, produto_id INTEGER,
    quantidade REAL, quantidade_fiscal REAL, quantidade_nao_fiscal REAL,
    preco_unitario REAL, subtotal REAL, valor_fiscal REAL, valor_nao_fiscal REAL
  )`);
  await run(db, `CREATE TABLE venda_recebimentos (
    id INTEGER PRIMARY KEY, venda_id INTEGER, forma_pagamento TEXT, valor REAL,
    tipo_recebimento TEXT, tef_transacao_id INTEGER, nsu TEXT, autorizacao TEXT, status TEXT
  )`);
  await run(db, `CREATE TABLE venda_pagamentos (
    id INTEGER PRIMARY KEY, venda_id INTEGER, forma_pagamento TEXT, valor REAL
  )`);
  await run(db, 'CREATE TABLE tef_transacoes (id INTEGER PRIMARY KEY, venda_id INTEGER)');
  await run(db, `CREATE TABLE nfce_notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, numero INTEGER, serie INTEGER,
    chave_acesso TEXT, ambiente INTEGER, status TEXT, xml_enviado TEXT, xml_retorno TEXT,
    protocolo TEXT, recibo TEXT, qr_code_url TEXT, danfe_html TEXT, empresa_id INTEGER,
    created_at TEXT, updated_at TEXT
  )`);
  await run(db, `INSERT INTO produtos (
    id, nome, ncm, cfop, csosn, origem, unidade, preco_venda, produto_fracionado, vendido_por_peso
  ) VALUES
    (747, 'Pastel do Cheff', '19059090', '5102', '102', 0, 'UN', 30.99, 0, 0),
    (748, 'Refrigerante Copo 200 ml', '19059090', '5102', '102', 0, 'UN', 12.99, 0, 0),
    (749, 'Refrigerante Copo 300 ml', '19059090', '5102', '102', 0, 'UN', 19.80, 0, 0)`);
  return db;
}

function configArtificial() {
  return {
    fonte: 'EMPRESA',
    empresaId: 1,
    ambiente: 2,
    serie: 1,
    uf: 'CE',
    codigoUf: '23',
    cnpj: '65957340000150',
    ie: '073252638',
    nomeEmpresa: 'PASTELARIA HOMOLOGACAO LTDA',
    tokenCSC: 'CSC-ARTIFICIAL-ISOLADO',
    idCSC: '000001',
    crt: 1,
    logradouro: 'RUA A',
    numero: '100',
    numeroEndereco: '100',
    bairro: 'CENTRO',
    codigo_municipio: '2307304',
    municipio: 'JUAZEIRO DO NORTE',
    municipioNome: 'JUAZEIRO DO NORTE',
    cep: '63000000',
    telefone: '8835110000',
    csosn_padrao: '102',
    certificadoPath: '',
    certificadoSenha: ''
  };
}

function emitir(db, vendaId) {
  return emitirPorVendaId(vendaId, {
    db,
    empresaId: 1,
    naoTransmitir: true,
    getFiscalConfig: async () => configArtificial()
  });
}

async function vendaBase(db, id, { total, desconto, valorFiscal }) {
  await run(db, `INSERT INTO vendas (
    id, empresa_id, cliente_id, total, desconto, valor_fiscal, status_pagamento, forma_pagamento
  ) VALUES (?, 1, NULL, ?, ?, ?, 'quitada', 'pix')`, [id, total, desconto, valorFiscal]);
}

async function item(db, id, vendaId, produtoId, campos) {
  await run(db, `INSERT INTO vendas_itens (
    id, venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal,
    preco_unitario, subtotal, valor_fiscal, valor_nao_fiscal
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    id, vendaId, produtoId,
    campos.quantidade,
    campos.quantidadeFiscal,
    campos.quantidadeNaoFiscal,
    campos.preco,
    campos.subtotal,
    campos.valorFiscal,
    campos.valorNaoFiscal
  ]);
}

function tag(xml, nome) {
  const bloco = (xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/) || [''])[0];
  return Number((bloco.match(new RegExp(`<${nome}>([^<]+)</${nome}>`)) || [])[1]);
}

test('emissor lê a venda fechada do pedido 68 e não restaura o comercial', async () => {
  const db = await prepararDb();
  try {
    await vendaBase(db, 68, { total: 61.98, desconto: 1.78, valorFiscal: 61.98 });
    await item(db, 1, 68, 747, {
      quantidade: 2, quantidadeFiscal: 2, quantidadeNaoFiscal: 0,
      preco: 8.99, subtotal: 17.98, valorFiscal: 17.98, valorNaoFiscal: 0
    });
    await item(db, 2, 68, 748, {
      quantidade: 2, quantidadeFiscal: 2, quantidadeNaoFiscal: 0,
      preco: 12.99, subtotal: 25.98, valorFiscal: 25.98, valorNaoFiscal: 0
    });
    await item(db, 3, 68, 749, {
      quantidade: 1, quantidadeFiscal: 1, quantidadeNaoFiscal: 0,
      preco: 19.8, subtotal: 19.8, valorFiscal: 19.8, valorNaoFiscal: 0
    });
    await run(db, `INSERT INTO venda_recebimentos (
      id, venda_id, forma_pagamento, valor, tipo_recebimento, status
    ) VALUES (1, 68, 'pix', 61.98, 'fiscal', 'aprovado')`);

    const primeira = await emitir(db, 68);
    const segunda = await emitir(db, 68);
    const notas = await get(db, 'SELECT COUNT(*) AS n FROM nfce_notas WHERE venda_id = 68');
    const desconto = await get(db, 'SELECT desconto FROM vendas WHERE id = 68');

    assert.equal(primeira.success, true);
    assert.equal(primeira.status, 'xml_preparado');
    assert.equal(primeira.transmitido, false);
    assert.equal(primeira.valores.vProd, 63.76);
    assert.equal(primeira.valores.vDesc, 1.78);
    assert.equal(primeira.valores.vNF, 61.98);
    assert.match(primeira.xml, /<cProd>747<\/cProd>/);
    assert.match(primeira.xml, /<vUnCom>8\.9900000000<\/vUnCom>/);
    assert.match(primeira.xml, /<vProd>17\.98<\/vProd>/);
    assert.doesNotMatch(primeira.xml, /<vUnCom>30\.9900000000<\/vUnCom>/);
    assert.doesNotMatch(primeira.xml, /<vProd>61\.98<\/vProd>/);
    assert.equal(tag(primeira.xml, 'vProd'), 63.76);
    assert.equal(tag(primeira.xml, 'vDesc'), 1.78);
    assert.equal(tag(primeira.xml, 'vNF'), 61.98);
    assert.equal(segunda.valores.vNF, 61.98);
    assert.equal(segunda.valores.vDesc, 1.78);
    assert.equal(notas.n, 0);
    assert.equal(desconto.desconto, 1.78);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
  } finally {
    await fecharDb(db);
  }
});

test('emissão já autorizada é recuperada sem recalcular', async () => {
  const db = await prepararDb();
  try {
    await vendaBase(db, 68, { total: 61.98, desconto: 1.78, valorFiscal: 61.98 });
    await item(db, 1, 68, 747, {
      quantidade: 2, quantidadeFiscal: 2, quantidadeNaoFiscal: 0,
      preco: 8.99, subtotal: 17.98, valorFiscal: 17.98, valorNaoFiscal: 0
    });
    await run(db, `INSERT INTO nfce_notas (
      venda_id, numero, serie, chave_acesso, ambiente, status, danfe_html, empresa_id
    ) VALUES (68, 7, 1, '0', 2, 'autorizada', 'DANFE-PERSISTIDO-68', 1)`);
    const recuperada = await emitir(db, 68);
    const notas = await get(db, 'SELECT COUNT(*) AS n FROM nfce_notas WHERE venda_id = 68');
    assert.equal(recuperada.success, true);
    assert.equal(recuperada.reused, true);
    assert.equal(recuperada.notaId, 1);
    assert.equal(recuperada.danfeHtml, 'DANFE-PERSISTIDO-68');
    assert.equal(recuperada.xml, undefined);
    assert.equal(notas.n, 1);
  } finally {
    await fecharDb(db);
  }
});

test('composição normal entra no emissor com desconto de R$ 27,78', async () => {
  const db = await prepararDb();
  try {
    await vendaBase(db, 96, { total: 61.98, desconto: 27.78, valorFiscal: 61.98 });
    await item(db, 1, 96, 747, {
      quantidade: 2, quantidadeFiscal: 2, quantidadeNaoFiscal: 0,
      preco: 21.99, subtotal: 43.98, valorFiscal: 43.98, valorNaoFiscal: 0
    });
    await item(db, 2, 96, 748, {
      quantidade: 2, quantidadeFiscal: 2, quantidadeNaoFiscal: 0,
      preco: 12.99, subtotal: 25.98, valorFiscal: 25.98, valorNaoFiscal: 0
    });
    await item(db, 3, 96, 749, {
      quantidade: 1, quantidadeFiscal: 1, quantidadeNaoFiscal: 0,
      preco: 19.8, subtotal: 19.8, valorFiscal: 19.8, valorNaoFiscal: 0
    });
    await run(db, `INSERT INTO venda_recebimentos (
      id, venda_id, forma_pagamento, valor, tipo_recebimento, status
    ) VALUES (2, 96, 'pix', 61.98, 'fiscal', 'aprovado')`);
    const out = await emitir(db, 96);
    assert.equal(out.status, 'xml_preparado');
    assert.match(out.xml, /<vUnCom>21\.9900000000<\/vUnCom>/);
    assert.equal(out.valores.vDesc, 27.78);
    assert.equal(out.valores.vProd, 89.76);
    assert.equal(out.valores.vNF, 61.98);
  } finally {
    await fecharDb(db);
  }
});

test('combinação exata sai com desconto zero', async () => {
  const db = await prepararDb();
  try {
    await vendaBase(db, 81, { total: 30.97, desconto: 0, valorFiscal: 30.97 });
    await item(db, 1, 81, 747, {
      quantidade: 2, quantidadeFiscal: 2, quantidadeNaoFiscal: 0,
      preco: 8.99, subtotal: 17.98, valorFiscal: 17.98, valorNaoFiscal: 0
    });
    await item(db, 2, 81, 748, {
      quantidade: 1, quantidadeFiscal: 1, quantidadeNaoFiscal: 0,
      preco: 12.99, subtotal: 12.99, valorFiscal: 12.99, valorNaoFiscal: 0
    });
    await run(db, `INSERT INTO venda_recebimentos (
      id, venda_id, forma_pagamento, valor, tipo_recebimento, status
    ) VALUES (3, 81, 'pix', 30.97, 'fiscal', 'aprovado')`);
    const out = await emitir(db, 81);
    assert.equal(out.valores.vDesc, 0);
    assert.equal(out.valores.vProd, 30.97);
    assert.equal(out.valores.vNF, 30.97);
  } finally {
    await fecharDb(db);
  }
});

test('dinheiro confirmado não monta NFC-e e o PIX puro monta', async () => {
  const db = await prepararDb();
  try {
    await vendaBase(db, 70, { total: 61.98, desconto: 1.78, valorFiscal: 0 });
    await item(db, 1, 70, 747, {
      quantidade: 2, quantidadeFiscal: 0, quantidadeNaoFiscal: 2,
      preco: 8.99, subtotal: 17.98, valorFiscal: 0, valorNaoFiscal: 17.98
    });
    await run(db, `INSERT INTO venda_recebimentos (
      id, venda_id, forma_pagamento, valor, tipo_recebimento, status
    ) VALUES (4, 70, 'dinheiro', 61.98, 'nao_fiscal', 'aprovado')`);
    const dinheiro = await emitir(db, 70);
    assert.equal(dinheiro.status, 'sem_itens_fiscais');
    assert.equal(dinheiro.xml, undefined);

    const margem = calcularMargemToleranciaDinheiro([
      { forma_pagamento: 'dinheiro', valor: 61.98, status: 'informada', confirmacao_manual: 1 }
    ]);
    assert.equal(PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO, 0.2);
    assert.equal(margem.margem_maxima, 12.4);
    assert.equal(margem.nao_e_desconto, true);
  } finally {
    await fecharDb(db);
  }
});

test('venda mista permanece sem NFC-e e não reescreve o desconto', async () => {
  const db = await prepararDb();
  try {
    await vendaBase(db, 71, { total: 61.98, desconto: 1.78, valorFiscal: 61.98 });
    await item(db, 1, 71, 747, {
      quantidade: 2, quantidadeFiscal: 2, quantidadeNaoFiscal: 0,
      preco: 8.99, subtotal: 17.98, valorFiscal: 17.98, valorNaoFiscal: 0
    });
    await item(db, 2, 71, 748, {
      quantidade: 2, quantidadeFiscal: 2, quantidadeNaoFiscal: 0,
      preco: 12.99, subtotal: 25.98, valorFiscal: 25.98, valorNaoFiscal: 0
    });
    await item(db, 3, 71, 749, {
      quantidade: 1, quantidadeFiscal: 1, quantidadeNaoFiscal: 0,
      preco: 19.8, subtotal: 19.8, valorFiscal: 19.8, valorNaoFiscal: 0
    });
    await run(db, `INSERT INTO venda_recebimentos (
      id, venda_id, forma_pagamento, valor, tipo_recebimento, status
    ) VALUES
      (5, 71, 'pix', 30, 'fiscal', 'aprovado'),
      (6, 71, 'dinheiro', 31.98, 'nao_fiscal', 'aprovado')`);
    const out = await emitir(db, 71);
    const desconto = await get(db, 'SELECT desconto FROM vendas WHERE id = 71');
    const notas = await get(db, 'SELECT COUNT(*) AS n FROM nfce_notas WHERE venda_id = 71');
    assert.equal(out.success, false);
    assert.equal(out.status, 'recomposicao_bloqueada');
    assert.equal(out.code, 'DISTRIBUICAO_NAO_AUTORIZADA');
    assert.equal(desconto.desconto, 1.78);
    assert.equal(notas.n, 0);
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
  } finally {
    await fecharDb(db);
  }
});
