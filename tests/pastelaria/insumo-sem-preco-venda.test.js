'use strict';

// Banco isolado em diretório temporário: o banco oficial nunca é aberto.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-insumo-sem-preco-'));
process.env.DB_DIR = tmpDir;

const ROOT = path.join(__dirname, '../..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* resposta não JSON */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
}

async function main() {
  // Frontend: campos de venda ocultos apenas para INSUMO e sem derivar venda do custo.
  const front = src('frontend/erp/js/produtos.js');
  assert.ok((front.match(/data-campo-venda-comercial/g) || []).length >= 5, 'campos de venda marcados');
  assert.ok(front.includes("prop('hidden', insumo)"), 'oculta via hidden quando INSUMO');
  assert.ok(front.includes("$('#produtoModal [data-campo-produto-comercial]').prop('hidden', insumo)"),
    'oculta Nome comercial e Preço do Pedido somente para INSUMO');
  assert.ok(front.includes("if (!cadastroEhInsumo()) {\n        data.nome_comercial =")
    && front.includes("data.preco_pedido = $('#preco_pedido').val()"),
  'envia Nome comercial e Preço do Pedido somente para produto comercial');
  assert.ok(front.includes("prop('required', !insumo)"), 'preco_venda não obrigatório para INSUMO');
  assert.ok(front.includes('if (cadastroEhInsumo()) {\n        // Sem preço de venda/markup'), 'sem derivar venda do custo');
  assert.ok(front.includes("preco_venda: cadastroEhInsumo() ? 0"), 'payload de insumo com preco_venda 0');
  assert.ok(front.includes("data.tipo_operacional !== 'INSUMO' && data.preco_venda <= 0"), 'COMERCIAL continua exigindo preço');
  assert.ok(front.includes("tipo_operacional: ($('#tipo_operacional').val() || 'COMERCIAL').trim()"), 'payload usa o tipo selecionado no formulário');

  const db = require('../../backend/database');
  await new Promise((r) => setTimeout(r, 4000));
  const express = require('express');
  const router = require('../../backend/rotas/produtos');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, nome: 'teste', role: 'admin' }; next(); });
  app.use('/produtos', router);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // INSUMO sem preço de venda e sem markup
    const novo = await request(port, 'POST', '/produtos', {
      nome: 'Massa insumo', unidade: 'KG', tipo_operacional: 'INSUMO',
      preco_compra: 4.5, estoque_minimo: 1, saldo_fiscal_inicial: 0, saldo_nao_fiscal_inicial: 10
    });
    assert.ok(novo.status < 300, `POST insumo: ${novo.status} ${novo.raw}`);
    const id = novo.body.id || novo.body.produto?.id;
    assert.ok(id, 'id do insumo');
    let row = await dbGet(db, 'SELECT * FROM produtos WHERE id = ?', [id]);
    assert.strictEqual(row.tipo_operacional, 'INSUMO');
    assert.strictEqual(Number(row.preco_venda), 0);
    assert.strictEqual(Number(row.preco_compra), 4.5);
    assert.strictEqual(Number(row.estoque_atual), 10);
    assert.strictEqual(Number(row.utiliza_ficha_tecnica), 0);
    const fichaInsumo = await dbGet(db, 'SELECT id FROM ficha_tecnica WHERE produto_id = ?', [id]);
    assert.ok(!fichaInsumo, 'criar INSUMO não cria ficha técnica automaticamente');

    // INSUMO com preco_venda enviado manualmente: ignorado
    const forcado = await request(port, 'POST', '/produtos', {
      nome: 'Farinha insumo', unidade: 'KG', tipo_operacional: 'INSUMO',
      preco_compra: 5, preco_venda: 99, lucro_percentual: 50
    });
    assert.ok(forcado.status < 300, `POST insumo forçado: ${forcado.raw}`);
    const rowForcado = await dbGet(db, 'SELECT preco_venda, lucro_percentual FROM produtos WHERE id = ?', [forcado.body.id || forcado.body.produto?.id]);
    assert.strictEqual(Number(rowForcado.preco_venda), 0);

    const tipoInvalido = await request(port, 'POST', '/produtos', {
      nome: 'Tipo inválido', unidade: 'UN', tipo_operacional: 'REFRIGERANTE',
      preco_compra: 1, preco_venda: 2
    });
    assert.strictEqual(tipoInvalido.status, 400, tipoInvalido.raw);
    assert.strictEqual(tipoInvalido.body.code, 'TIPO_OPERACIONAL_INVALIDO');

    // Edição do insumo: custo muda, venda não é preenchida
    const edit = await request(port, 'PUT', `/produtos/${id}`, {
      nome: 'Massa insumo 2', preco_compra: 6, preco_venda: 50, lucro_percentual: 10, tipo_operacional: 'INSUMO'
    });
    assert.ok(edit.status < 300, `PUT insumo: ${edit.status} ${edit.raw}`);
    row = await dbGet(db, 'SELECT * FROM produtos WHERE id = ?', [id]);
    assert.strictEqual(Number(row.preco_compra), 6);
    assert.strictEqual(Number(row.preco_venda), 0);
    assert.strictEqual(row.nome, 'Massa insumo 2');

    await new Promise((resolve, reject) => db.run(
      'UPDATE produtos SET nome_comercial = ?, preco_pedido = ? WHERE id = ?',
      ['Nome comercial legado', 12.75, id],
      (err) => (err ? reject(err) : resolve())
    ));
    const editSemCamposComerciais = await request(port, 'PUT', `/produtos/${id}`, {
      nome: 'Massa insumo preservada',
      tipo_operacional: 'INSUMO',
      preco_compra: 6.5
    });
    assert.ok(editSemCamposComerciais.status < 300,
      `PUT insumo sem campos comerciais: ${editSemCamposComerciais.raw}`);
    row = await dbGet(db, 'SELECT nome_comercial, preco_pedido FROM produtos WHERE id = ?', [id]);
    assert.strictEqual(row.nome_comercial, 'Nome comercial legado');
    assert.strictEqual(Number(row.preco_pedido), 12.75);

    // Listagem de insumos continua funcionando sem preço de venda
    const lista = await request(port, 'GET', '/produtos?tipo_operacional=INSUMO');
    assert.strictEqual(lista.status, 200, lista.raw);
    const itens = Array.isArray(lista.body) ? lista.body : (lista.body.produtos || lista.body.itens || []);
    assert.ok(itens.some((p) => p.id === id), 'insumo listado');

    // COMERCIAL preserva preço e markup enviados
    const com = await request(port, 'POST', '/produtos', {
      nome: 'Pastel comercial', unidade: 'UN', tipo_operacional: 'COMERCIAL',
      nome_comercial: 'Pastel da Casa',
      preco_compra: 2, preco_venda: 8, preco_pedido: 6.5, lucro_percentual: 300,
      utiliza_ficha_tecnica: 1
    });
    assert.ok(com.status < 300, `POST comercial: ${com.raw}`);
    const rowCom = await dbGet(db,
      'SELECT nome_comercial, preco_venda, preco_pedido, lucro_percentual, utiliza_ficha_tecnica FROM produtos WHERE id = ?',
      [com.body.id || com.body.produto?.id]);
    assert.strictEqual(rowCom.nome_comercial, 'Pastel da Casa');
    assert.strictEqual(Number(rowCom.preco_venda), 8);
    assert.strictEqual(Number(rowCom.preco_pedido), 6.5);
    assert.strictEqual(Number(rowCom.lucro_percentual), 300);
    assert.strictEqual(Number(rowCom.utiliza_ficha_tecnica), 1);

    const personalizacaoSemFicha = await request(port, 'POST', '/produtos', {
      nome: 'Produto incompatível',
      unidade: 'UN',
      tipo_operacional: 'COMERCIAL',
      preco_venda: 5,
      utiliza_ficha_tecnica: 0,
      permite_personalizacao_ingredientes: 1
    });
    assert.strictEqual(personalizacaoSemFicha.status, 400, personalizacaoSemFicha.raw);
    assert.strictEqual(personalizacaoSemFicha.body.code, 'PERSONALIZACAO_EXIGE_FICHA_TECNICA');

    const editCom = await request(port, 'PUT', `/produtos/${com.body.id || com.body.produto?.id}`, {
      nome_comercial: 'Pastel revisado',
      preco_venda: 9,
      preco_pedido: 7.25,
      lucro_percentual: 350,
      utiliza_ficha_tecnica: 0
    });
    assert.ok(editCom.status < 300, `PUT comercial: ${editCom.raw}`);
    const rowCom2 = await dbGet(db,
      'SELECT nome_comercial, preco_venda, preco_pedido, utiliza_ficha_tecnica FROM produtos WHERE id = ?',
      [com.body.id || com.body.produto?.id]);
    assert.strictEqual(rowCom2.nome_comercial, 'Pastel revisado');
    assert.strictEqual(Number(rowCom2.preco_venda), 9);
    assert.strictEqual(Number(rowCom2.preco_pedido), 7.25);
    assert.strictEqual(Number(rowCom2.utiliza_ficha_tecnica), 0);

    // Compra: fluxo existente já grava preco_compra a partir da compra registrada
    const compras = src('backend/rotas/compras.js');
    assert.ok(/UPDATE produtos\s+SET\s+preco_compra = \?/.test(compras), 'compra atualiza preco_compra');
  } finally {
    server.close();
    await new Promise((r) => db.close(() => r()));
  }
  console.log('Insumo sem preço de venda OK — banco temporário isolado.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* limpeza best-effort */ }
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  });
