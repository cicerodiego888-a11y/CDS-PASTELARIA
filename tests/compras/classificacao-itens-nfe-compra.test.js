'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-classificacao-nfe-'));
process.env.DB_DIR = dbDir;

let ok = 0;
let falhas = 0;

async function test(nome, fn) {
  try {
    await fn();
    ok += 1;
    console.log(`  OK    ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`  FAIL  ${nome}\n        ${err.stack || err.message}`);
  }
}

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method,
      headers: data ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      } : {}
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
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

const dbGet = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
});

const dbRun = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function onRun(err) {
    return err ? reject(err) : resolve(this);
  });
});

async function main() {
  const db = require('../../backend/database');
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const express = require('express');
  const comprasRouter = require('../../backend/rotas/compras');
  const CentralComprasBridgeService = require('../../backend/motores/central-entradas/services/CentralComprasBridgeService');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, nome: 'Teste classificação NF-e', role: 'admin' };
    next();
  });
  app.use('/compras', comprasRouter);
  const server = app.listen(0);
  const port = server.address().port;
  const xmlTeste = fs.readFileSync(
    path.join(__dirname, '../shared/nfe/fixtures/nfe-proc-sample.xml'),
    'utf8'
  );

  let produtoSeq = 0;
  let nfSeq = 0;
  await dbRun(db, `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo)
                   VALUES (1, '12345678000195', 'Empresa Teste', 'Empresa Teste', 1)`);

  async function criarProduto(tipo, extra = {}) {
    produtoSeq += 1;
    const codigo = `NFE-T${produtoSeq}`;
    const r = await dbRun(db, `
      INSERT INTO produtos (
        codigo, codigo_barras, nome, unidade, preco_compra, preco_venda,
        lucro_percentual, estoque_atual, estoque_minimo, tipo_operacional,
        saldo_fiscal, saldo_nao_fiscal, produto_fracionado, vendido_por_peso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, ?, ?)
    `, [
      codigo,
      `789000000${String(produtoSeq).padStart(4, '0')}`,
      extra.nome || `Produto NF-e ${produtoSeq}`,
      extra.unidade || 'UN',
      extra.preco_compra ?? 1,
      extra.preco_venda ?? (tipo === 'INSUMO' ? 0 : 8),
      extra.lucro ?? (tipo === 'INSUMO' ? 0 : 40),
      tipo,
      extra.fracionado ? 1 : 0,
      extra.fracionado ? 1 : 0
    ]);
    return r.lastID;
  }

  function item(produtoId, tipo, opcoes = {}) {
    const quantidade = Number(opcoes.quantidade ?? 2);
    const preco = Number(opcoes.preco_unitario ?? 5);
    return {
      produto_id: produtoId,
      tipo_operacional: tipo,
      criar_produto: false,
      produto_nome: opcoes.produto_nome || `Item ${tipo}`,
      codigo_barras: opcoes.codigo_barras || '',
      unidade: opcoes.unidade || 'UN',
      quantidade,
      quantidade_comercial: Number(opcoes.quantidade_comercial ?? quantidade),
      quantidade_convertida: Number(opcoes.quantidade_convertida ?? quantidade),
      quantidade_embalagens: Number(opcoes.quantidade_embalagens ?? quantidade),
      quantidade_por_embalagem: Number(opcoes.quantidade_por_embalagem || 0),
      quantidade_fiscal: Number(opcoes.quantidade_fiscal ?? 0),
      quantidade_nao_fiscal: Number(opcoes.quantidade_nao_fiscal ?? quantidade),
      nfe_item_n: opcoes.nfe_item_n,
      nfe_item_original: opcoes.nfe_item_original,
      miip_resultado: opcoes.miip_resultado,
      mip_resultado: opcoes.mip_resultado,
      miip_sugestao: opcoes.miip_sugestao,
      compra_em: opcoes.compra_em || '',
      valor_total_embalagem: Number(opcoes.valor_total_embalagem || 0),
      preco_unitario: preco,
      subtotal: Number(opcoes.subtotal ?? quantidade * preco),
      margem_lucro: tipo === 'INSUMO' ? 0 : 40,
      preco_venda_sugerido: tipo === 'INSUMO' ? 0 : 8,
      atualizar_preco_venda: tipo === 'INSUMO' ? 0 : 1,
      produto_fracionado: opcoes.produto_fracionado ? 1 : 0,
      vendido_por_peso: opcoes.produto_fracionado ? 1 : 0,
      data_validade: opcoes.data_validade || null
    };
  }

  function payloadCompra(itens, extra = {}) {
    nfSeq += 1;
    const total = Number(extra.total
      ?? itens.reduce((soma, current) => soma + Number(current.subtotal || 0), 0));
    return {
      data_compra: '2026-10-20',
      fornecedor: 'Distribuidora Teste Ltda',
      fornecedor_cnpj: '12345678000199',
      numero_nf: String(nfSeq),
      valor_produtos: total,
      valor_total_nota: total,
      total,
      itens,
      condicao_pagamento: 'avista',
      forma_pagamento: 'dinheiro',
      tipo_entrada: 'REVENDA',
      origem_compra: 'CENTRAL_NFE',
      xml: xmlTeste,
      ...extra
    };
  }

  async function postarCompra(itens, extra = {}) {
    return request(port, 'POST', '/compras', payloadCompra(itens, extra));
  }

  try {
    await test('payload do bridge preserva campos originais dos itens do XML', async () => {
      const parseOriginal = {
        itens: [{
          produto_nome: 'Insumo do XML',
          codigo_fornecedor: 'ABC002',
          codigo_barras: '7891234567891',
          ncm: '20098990',
          unidade: 'CX',
          quantidade: 5,
          preco_unitario: 12,
          subtotal: 60,
          quantidade_fiscal: 5,
          quantidade_nao_fiscal: 0
        }]
      };
      const bridge = new CentralComprasBridgeService({
        documentosRepository: {
          buscarPorId: async () => ({
            id: 77,
            empresaId: 1,
            empresa_id: 1,
            chave: '35260112345678000199550010000000011000000001',
            status: 'PRONTA_PARA_COMPRA',
            parseJson: parseOriginal,
            xml: xmlTeste
          })
        }
      });
      const payload = await bridge.montarPayloadAbrirCompra(77);
      assert.deepStrictEqual(payload.dadosCompra.itens, parseOriginal.itens);
      assert.strictEqual(payload.dadosCompra.chave_acesso, '35260112345678000199550010000000011000000001');
      assert.strictEqual(parseOriginal.itens[0].quantidade, 5);
      assert.strictEqual(parseOriginal.itens[0].preco_unitario, 12);
      assert.strictEqual(parseOriginal.itens[0].quantidade_fiscal, 5);
    });

    await test('NF-e somente COMERCIAL vincula cadastro existente sem duplicar produto', async () => {
      const id = await criarProduto('COMERCIAL');
      const antes = await dbGet(db, 'SELECT COUNT(*) AS n FROM produtos');
      const response = await postarCompra([item(id, 'COMERCIAL')]);
      assert.strictEqual(response.status, 200, response.raw);
      const depois = await dbGet(db, 'SELECT COUNT(*) AS n FROM produtos');
      assert.strictEqual(depois.n, antes.n);
      const estoque = await dbGet(db, 'SELECT estoque_atual FROM produtos WHERE id = ?', [id]);
      assert.strictEqual(Number(estoque.estoque_atual), 2);
    });

    await test('NF-e somente INSUMO atualiza custo e mantém venda/markup zerados', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 2, preco_venda: 0, lucro: 0 });
      const response = await postarCompra([item(id, 'INSUMO', { preco_unitario: 7 })]);
      assert.strictEqual(response.status, 200, response.raw);
      const produto = await dbGet(db, 'SELECT * FROM produtos WHERE id = ?', [id]);
      assert.strictEqual(Number(produto.preco_compra), 7);
      assert.strictEqual(Number(produto.preco_venda), 0);
      assert.strictEqual(Number(produto.lucro_percentual), 0);
      assert.strictEqual(produto.tipo_operacional, 'INSUMO');
    });

    await test('NF-e mista aplica a classificação por item e credita cada cadastro uma vez', async () => {
      const comercial = await criarProduto('COMERCIAL');
      const insumo = await criarProduto('INSUMO', { preco_compra: 2 });
      const chave = '35261012345678000199550010000000011000000011';
      const response = await postarCompra([
        item(comercial, 'COMERCIAL', {
          quantidade: 3,
          nfe_item_n: 1,
          nfe_item_original: {
            $: { nItem: '1' },
            prod: { cProd: 'REF-2L', cEAN: '7899999999999', xProd: 'Refrigerante 2L' }
          }
        }),
        item(insumo, 'INSUMO', {
          quantidade: 4,
          preco_unitario: 6,
          nfe_item_n: 2,
          nfe_item_original: {
            $: { nItem: '2' },
            prod: { cProd: 'FAR-1KG', cEANTrib: '7891234567895', xProd: 'Farinha 1kg' }
          }
        })
      ], { chave_acesso: chave });
      assert.strictEqual(response.status, 200, response.raw);
      const comercialAtual = await dbGet(db, 'SELECT estoque_atual FROM produtos WHERE id = ?', [comercial]);
      const insumoAtual = await dbGet(db, 'SELECT estoque_atual, preco_compra, preco_venda FROM produtos WHERE id = ?', [insumo]);
      assert.strictEqual(Number(comercialAtual.estoque_atual), 3);
      assert.strictEqual(Number(insumoAtual.estoque_atual), 4);
      assert.strictEqual(Number(insumoAtual.preco_compra), 6);
      assert.strictEqual(Number(insumoAtual.preco_venda), 0);

      const itensPersistidos = await new Promise((resolve, reject) => {
        db.all(`
          SELECT ci.produto_id, ci.nfe_item_n, ci.tipo_operacional,
                 ci.nfe_item_original_json, ci.dados_roteamento_json, c.chave_acesso
          FROM compras_itens ci
          JOIN compras c ON c.id = ci.compra_id
          WHERE c.chave_acesso = ?
          ORDER BY ci.nfe_item_n
        `, [chave], (err, rows) => (err ? reject(err) : resolve(rows)));
      });
      assert.strictEqual(itensPersistidos.length, 2);
      assert.strictEqual(itensPersistidos[0].chave_acesso, chave);
      assert.strictEqual(Number(itensPersistidos[0].nfe_item_n), 1);
      assert.strictEqual(itensPersistidos[0].tipo_operacional, 'COMERCIAL');
      assert.strictEqual(JSON.parse(itensPersistidos[0].nfe_item_original_json).prod.cProd, 'REF-2L');
      assert.strictEqual(JSON.parse(itensPersistidos[0].dados_roteamento_json).resolucao, 'PRODUTO_EXISTENTE');
      assert.strictEqual(Number(itensPersistidos[1].nfe_item_n), 2);
      assert.strictEqual(itensPersistidos[1].tipo_operacional, 'INSUMO');
      assert.strictEqual(JSON.parse(itensPersistidos[1].nfe_item_original_json).prod.cProd, 'FAR-1KG');
      assert.strictEqual(JSON.parse(itensPersistidos[1].dados_roteamento_json).tipo_operacional, 'INSUMO');
    });

    await test('cadastro de INSUMO escolhido como novo é criado dentro da transação, sem preço de venda', async () => {
      const novo = item(null, 'INSUMO', {
        produto_nome: 'Farinha nova',
        codigo_barras: '7899999999001',
        preco_unitario: 3,
        quantidade: 2
      });
      novo.criar_produto = true;
      const response = await postarCompra([novo]);
      assert.strictEqual(response.status, 200, response.raw);
      const produto = await dbGet(db, 'SELECT * FROM produtos WHERE codigo_barras = ?', ['7899999999001']);
      assert.ok(produto);
      assert.strictEqual(produto.tipo_operacional, 'INSUMO');
      assert.strictEqual(Number(produto.preco_venda), 0);
      assert.strictEqual(Number(produto.lucro_percentual), 0);
      assert.strictEqual(Number(produto.preco_compra), 3);
      assert.strictEqual(Number(produto.estoque_atual), 2);
    });

    await test('novo COMERCIAL explícito permanece elegível e usa regra comercial atual', async () => {
      const novo = item(null, 'COMERCIAL', {
        produto_nome: 'Refrigerante novo',
        codigo_barras: '7899999999002',
        preco_unitario: 5,
        quantidade: 2
      });
      novo.criar_produto = true;
      const response = await postarCompra([novo]);
      assert.strictEqual(response.status, 200, response.raw);
      const produto = await dbGet(db, 'SELECT * FROM produtos WHERE codigo_barras = ?', ['7899999999002']);
      assert.ok(produto);
      assert.strictEqual(produto.tipo_operacional, 'COMERCIAL');
      assert.strictEqual(Number(produto.preco_venda), 7);
      assert.strictEqual(Number(produto.lucro_percentual), 40);
      assert.strictEqual(Number(produto.estoque_atual), 2);
    });

    await test('classificação ausente bloqueia confirmação antes de qualquer gravação', async () => {
      const id = await criarProduto('COMERCIAL');
      const antes = await dbGet(db, 'SELECT COUNT(*) AS n FROM compras');
      const response = await postarCompra([item(id, '')]);
      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.body.code, 'CLASSIFICACAO_ITEM_NFE_OBRIGATORIA');
      const depois = await dbGet(db, 'SELECT COUNT(*) AS n FROM compras');
      const produto = await dbGet(db, 'SELECT estoque_atual FROM produtos WHERE id = ?', [id]);
      assert.strictEqual(depois.n, antes.n);
      assert.strictEqual(Number(produto.estoque_atual), 0);
    });

    await test('tipo escolhido sem vínculo ou criação explícita bloqueia confirmação', async () => {
      const novo = item(null, 'COMERCIAL', {
        produto_nome: 'Item sem cadastro',
        codigo_barras: '7899999999004'
      });
      const antes = await dbGet(db, 'SELECT COUNT(*) AS n FROM compras');
      const response = await postarCompra([novo]);
      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.body.code, 'VINCULO_ITEM_NFE_OBRIGATORIO');
      const depois = await dbGet(db, 'SELECT COUNT(*) AS n FROM compras');
      const cadastro = await dbGet(db, 'SELECT id FROM produtos WHERE codigo_barras = ?', ['7899999999004']);
      assert.strictEqual(depois.n, antes.n);
      assert.strictEqual(cadastro, null);
    });

    await test('cadastro de tipo divergente é rejeitado sem converter o tipo existente', async () => {
      const id = await criarProduto('COMERCIAL');
      const response = await postarCompra([item(id, 'INSUMO')]);
      assert.strictEqual(response.status, 400, response.raw);
      const produto = await dbGet(db, 'SELECT tipo_operacional, estoque_atual FROM produtos WHERE id = ?', [id]);
      assert.strictEqual(produto.tipo_operacional, 'COMERCIAL');
      assert.strictEqual(Number(produto.estoque_atual), 0);
    });

    await test('vínculo confirmado diferente de sugestão MIIP registra origem explícita', async () => {
      const selecionado = await criarProduto('COMERCIAL');
      const sugerido = await criarProduto('COMERCIAL');
      const chave = '35261012345678000199550010000000011000000012';
      const response = await postarCompra([
        item(selecionado, 'COMERCIAL', {
          miip_resultado: {
            associadoAutomaticamente: true,
            motor: 'motor_associacao_fornecedor',
            produtoEncontrado: { id: sugerido }
          }
        })
      ], { chave_acesso: chave });
      assert.strictEqual(response.status, 200, response.raw);

      const row = await dbGet(db, `
        SELECT ci.dados_roteamento_json
        FROM compras_itens ci
        JOIN compras c ON c.id = ci.compra_id
        WHERE c.chave_acesso = ?
      `, [chave]);
      assert.strictEqual(
        JSON.parse(row.dados_roteamento_json).origem_correspondencia,
        'VINCULO_EXPLICITO'
      );
    });

    await test('embalagem conserva conversão e credita quantidade convertida sem duplicar', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1 });
      const pacote = item(id, 'INSUMO', {
        produto_nome: 'Farinha',
        unidade: 'UN',
        compra_em: 'CAIXA',
        quantidade: 20,
        quantidade_comercial: 2,
        quantidade_convertida: 20,
        quantidade_embalagens: 2,
        quantidade_por_embalagem: 10,
        quantidade_fiscal: 0,
        quantidade_nao_fiscal: 20,
        valor_total_embalagem: 100,
        preco_unitario: 50,
        subtotal: 100
      });
      const response = await postarCompra([pacote]);
      assert.strictEqual(response.status, 200, response.raw);
      const produto = await dbGet(db, 'SELECT estoque_atual, saldo_fiscal, saldo_nao_fiscal, preco_compra FROM produtos WHERE id = ?', [id]);
      assert.strictEqual(Number(produto.estoque_atual), 20);
      assert.strictEqual(Number(produto.saldo_fiscal), 0);
      assert.strictEqual(Number(produto.saldo_nao_fiscal), 20);
      assert.strictEqual(Number(produto.preco_compra), 5);
    });

    await test('conversão de embalagem de insumo fracionado conserva custo por unidade convertida', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1, fracionado: true });
      const pacote = item(id, 'INSUMO', {
        produto_nome: 'Farinha fracionada',
        unidade: 'KG',
        compra_em: 'SACO',
        quantidade: 20,
        quantidade_comercial: 2,
        quantidade_convertida: 20,
        quantidade_embalagens: 2,
        quantidade_por_embalagem: 10,
        quantidade_fiscal: 0,
        quantidade_nao_fiscal: 20,
        valor_total_embalagem: 100,
        preco_unitario: 5,
        subtotal: 100,
        produto_fracionado: true
      });
      const response = await postarCompra([pacote]);
      assert.strictEqual(response.status, 200, response.raw);
      const produto = await dbGet(db, 'SELECT estoque_atual, preco_compra, preco_venda FROM produtos WHERE id = ?', [id]);
      assert.strictEqual(Number(produto.estoque_atual), 20);
      assert.strictEqual(Number(produto.preco_compra), 5);
      assert.strictEqual(Number(produto.preco_venda), 0);
    });

    await test('reprocessamento da mesma chave não duplica entrada, estoque ou cadastro', async () => {
      const produtoId = await criarProduto('COMERCIAL');
      const chave = '35261012345678000199550010000000011000000001';
      const body = payloadCompra([item(produtoId, 'COMERCIAL')], { chave_acesso: chave });
      const primeiro = await request(port, 'POST', '/compras', body);
      assert.strictEqual(primeiro.status, 200, primeiro.raw);
      const segundo = await request(port, 'POST', '/compras', body);
      assert.strictEqual(segundo.status, 400);
      const produto = await dbGet(db, 'SELECT estoque_atual FROM produtos WHERE id = ?', [produtoId]);
      const compras = await dbGet(db, 'SELECT COUNT(*) AS n FROM compras WHERE chave_acesso = ?', [chave]);
      assert.strictEqual(Number(produto.estoque_atual), 2);
      assert.strictEqual(compras.n, 1);
    });

    await test('entrada simplificada Uso e Consumo permanece fora da classificação de catálogo', async () => {
      const antes = await dbGet(db, 'SELECT COUNT(*) AS n FROM produtos');
      const response = await postarCompra([], {
        total: 12.5,
        valor_total_nota: 12.5,
        tipo_entrada: 'USO_CONSUMO'
      });
      assert.strictEqual(response.status, 200, response.raw);
      assert.strictEqual(response.body.uso_consumo, true);
      const depois = await dbGet(db, 'SELECT COUNT(*) AS n FROM produtos');
      assert.strictEqual(depois.n, antes.n);
    });

    await test('falha posterior reverte compra, estoque e cadastro novo da mesma transação', async () => {
      const invalido = await criarProduto('INSUMO');
      await dbRun(db, 'UPDATE produtos SET controlar_validade = 1 WHERE id = ?', [invalido]);
      const novo = item(null, 'COMERCIAL', {
        produto_nome: 'Cadastro transacional',
        codigo_barras: '7899999999003',
        preco_unitario: 4
      });
      novo.criar_produto = true;
      const body = payloadCompra([novo, item(invalido, 'INSUMO', { data_validade: null })], {
        chave_acesso: '35261012345678000199550010000000011000000002'
      });
      const response = await request(port, 'POST', '/compras', body);
      assert.ok(response.status >= 400, response.raw);
      const novoProduto = await dbGet(db, 'SELECT id FROM produtos WHERE codigo_barras = ?', ['7899999999003']);
      const compra = await dbGet(db, 'SELECT id FROM compras WHERE chave_acesso = ?', [body.chave_acesso]);
      const saldo = await dbGet(db, 'SELECT estoque_atual, preco_compra FROM produtos WHERE id = ?', [invalido]);
      assert.strictEqual(novoProduto, null);
      assert.strictEqual(compra, null);
      assert.strictEqual(Number(saldo.estoque_atual), 0);
      assert.strictEqual(Number(saldo.preco_compra), 1);
    });

    console.log(`\n--- Resultado: ${ok} OK, ${falhas} falha(s) ---`);
    if (falhas > 0) process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => db.close(resolve));
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
