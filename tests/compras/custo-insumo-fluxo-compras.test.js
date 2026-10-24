'use strict';

// Banco isolado em diretório temporário: o banco oficial nunca é aberto.
// Executar: node tests/compras/custo-insumo-fluxo-compras.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-custo-insumo-'));
process.env.DB_DIR = tmpDir;

let ok = 0;
let falhas = 0;
async function test(nome, fn) {
  try {
    await fn();
    ok += 1;
    console.log(`  OK    ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`  FAIL  ${nome}\n        ${err.message}`);
  }
}

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

const dbGet = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbRun = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function cb(e) { return e ? rej(e) : res(this); }));

async function main() {
  const db = require('../../backend/database');
  await new Promise((r) => setTimeout(r, 4000));
  const express = require('express');
  const configService = require('../../backend/services/configuracaoService');
  const comprasRouter = require('../../backend/rotas/compras');
  const ProdutoConversaoConfigService = require('../../backend/services/produtos/ProdutoConversaoConfigService');
  const { ProdutoEmbalagemService } = require('../../backend/services/produto-embalagem/ProdutoEmbalagemService');
  const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
  const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
  const {
    consumirFichaTecnicaDaVenda
  } = require('../../backend/services/produtos/FichaTecnicaConsumoService');
  const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, nome: 'teste', role: 'admin' }; next(); });
  app.use('/compras', comprasRouter);
  const server = app.listen(0);
  const port = server.address().port;

  let seq = 0;
  await dbRun(db, `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo)
                   VALUES (1, '12345678000195', 'Empresa Teste', 'Empresa Teste', 1)`);
  await dbRun(db, `INSERT OR IGNORE INTO usuarios (id, username, password_hash, role)
                   VALUES (1, 'teste', 'teste', 'admin')`);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await dbRun(db, `INSERT OR IGNORE INTO usuario_empresas (usuario_id, empresa_id, ativo)
                   VALUES (1, 1, 1)`);
  async function criarProduto(tipo, extra = {}) {
    seq += 1;
    const r = await dbRun(db, `
      INSERT INTO produtos (codigo, codigo_barras, nome, unidade, preco_compra, preco_venda, lucro_percentual,
                            estoque_atual, estoque_minimo, tipo_operacional, saldo_fiscal, saldo_nao_fiscal)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0)
    `, [`T${seq}`, `789000000${seq}`, `Produto teste ${seq}`, extra.unidade || 'UN',
      extra.preco_compra ?? 1, extra.preco_venda ?? 0, extra.lucro ?? 0, tipo]);
    return r.lastID;
  }
  const produto = (id) => dbGet(db, 'SELECT * FROM produtos WHERE id = ?', [id]);

  let nf = 0;
  function payloadCompra(itens, extra = {}) {
    nf += 1;
    const total = Number(extra.total ?? (itens.reduce((s, i) => s + Number(i.subtotal || 0), 0) || 1));
    return {
      data_compra: '2026-10-19', fornecedor: 'Fornecedor Teste', numero_nf: String(nf),
      valor_produtos: total, valor_total_nota: total, total, itens,
      condicao_pagamento: 'avista', forma_pagamento: 'dinheiro', tipo_entrada: 'REVENDA',
      ...extra
    };
  }
  function item(produtoId, o = {}) {
    const q = o.quantidade ?? 10;
    const pu = o.preco_unitario ?? 5;
    return {
      produto_id: produtoId, produto_nome: 'Item', unidade: o.unidade || 'UN',
      quantidade_comercial: q, quantidade_embalagens: q, preco_unitario: pu,
      subtotal: o.subtotal ?? q * pu, quantidade_fiscal: 0, quantidade_nao_fiscal: q,
      atualizar_preco_venda: o.atualizar_preco_venda ?? 1, margem_lucro: o.margem_lucro ?? 40,
      preco_venda_sugerido: o.preco_venda_sugerido ?? 99, ...o.extra
    };
  }
  async function comprar(itens, extra) {
    const r = await request(port, 'POST', '/compras', payloadCompra(itens, extra));
    assert.ok(r.status < 300, `POST compra: ${r.status} ${r.raw}`);
    return r.body.id;
  }

  try {
    await test('1. Compra confirmada de INSUMO atualiza o custo', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 2 });
      await comprar([item(id, { quantidade: 10, preco_unitario: 5 })]);
      const p = await produto(id);
      assert.strictEqual(Number(p.preco_compra), 5);
    });

    await test('4. INSUMO com atualizar preço de venda habilitado não altera venda/markup nem unidade', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 2, preco_venda: 0, lucro: 0, unidade: 'UN' });
      await comprar([item(id, { unidade: 'UN', atualizar_preco_venda: 1, margem_lucro: 40, preco_venda_sugerido: 99 })]);
      const p = await produto(id);
      assert.strictEqual(Number(p.preco_venda), 0);
      assert.strictEqual(Number(p.lucro_percentual), 0);
      assert.strictEqual(p.unidade, 'UN');
      assert.strictEqual(p.tipo_operacional, 'INSUMO');
      assert.strictEqual(Number(p.preco_compra), 5);
      const ci = await dbGet(db, 'SELECT preco_venda_sugerido FROM compras_itens WHERE produto_id = ? ORDER BY id DESC', [id]);
      assert.strictEqual(Number(ci.preco_venda_sugerido), 0);
    });

    await test('5. COMERCIAL mantém atualização de preço e markup (e respeita opção desligada)', async () => {
      const id = await criarProduto('COMERCIAL', { preco_compra: 2, preco_venda: 3, lucro: 50 });
      await comprar([item(id, { atualizar_preco_venda: 1, margem_lucro: 40 })]);
      let p = await produto(id);
      assert.strictEqual(Number(p.preco_compra), 5);
      assert.strictEqual(Number(p.preco_venda), 7);
      assert.strictEqual(Number(p.lucro_percentual), 40);

      const id2 = await criarProduto('COMERCIAL', { preco_compra: 2, preco_venda: 3, lucro: 50 });
      await comprar([item(id2, { atualizar_preco_venda: 0, margem_lucro: 40 })]);
      p = await produto(id2);
      assert.strictEqual(Number(p.preco_compra), 5);
      assert.strictEqual(Number(p.preco_venda), 3);
      assert.strictEqual(Number(p.lucro_percentual), 50);
    });

    await test('2/3. Compra não confirmada (rollback) não atualiza o custo', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 2 });
      await dbRun(db, 'UPDATE produtos SET controlar_validade = 1 WHERE id = ?', [id]);
      const r = await request(port, 'POST', '/compras', payloadCompra([item(id)]));
      assert.ok(r.status >= 400, `esperava erro, veio ${r.status}`);
      const p = await produto(id);
      assert.strictEqual(Number(p.preco_compra), 2);
      assert.strictEqual(Number(p.estoque_atual), 0);
      const c = await dbGet(db, 'SELECT COUNT(*) AS n FROM compras_itens WHERE produto_id = ?', [id]);
      assert.strictEqual(c.n, 0);
    });

    let idCancelar;
    let compraCancelar;
    await test('3. Compra cancelada não altera custo nem venda do insumo', async () => {
      idCancelar = await criarProduto('INSUMO', { preco_compra: 2 });
      compraCancelar = await comprar([item(idCancelar, { quantidade: 4, preco_unitario: 6 })]);
      const antes = await produto(idCancelar);
      assert.strictEqual(Number(antes.preco_compra), 6);
      const r = await request(port, 'POST', `/compras/${compraCancelar}/cancelar`, { motivo: 'teste' });
      assert.ok(r.status < 300, `cancelar: ${r.status} ${r.raw}`);
      const depois = await produto(idCancelar);
      assert.strictEqual(Number(depois.preco_compra), Number(antes.preco_compra));
      assert.strictEqual(Number(depois.preco_venda), 0);
      assert.strictEqual(Number(depois.estoque_atual), 0);
      const c = await dbGet(db, 'SELECT status FROM compras WHERE id = ?', [compraCancelar]);
      assert.strictEqual(c.status, 'cancelada');
      const again = await request(port, 'POST', `/compras/${compraCancelar}/cancelar`, {});
      assert.strictEqual(again.status, 400);
    });

    await test('6. Bonificação: custo preservado por padrão (config atualizar_custo=false)', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 5 });
      await comprar([item(id, { quantidade: 10, preco_unitario: 0, subtotal: 0, extra: { bonificacao: 1 } })], { tipo_entrada: 'REVENDA' });
      const p = await produto(id);
      assert.strictEqual(Number(p.preco_compra), 5);
      assert.strictEqual(Number(p.estoque_atual), 10);
    });

    const original = configService.getPadraoFiscal;
    try {
      configService.getPadraoFiscal = () => ({ ...original(), entrada_bonificacao_atualizar_custo: true });

      await test('6. Bonificação com atualizar_custo=true e valor apurável: custo = valor/quantidade (não zero)', async () => {
        const id = await criarProduto('INSUMO', { preco_compra: 5 });
        await comprar([item(id, { quantidade: 10, preco_unitario: 3, subtotal: 30, extra: { bonificacao: 1 } })]);
        const p = await produto(id);
        assert.strictEqual(Number(p.preco_compra), 3);
      });

      await test('6. Bonificação com atualizar_custo=true e valor zero: não zera o custo', async () => {
        const id = await criarProduto('INSUMO', { preco_compra: 5 });
        await comprar([item(id, { quantidade: 10, preco_unitario: 0, subtotal: 0, extra: { bonificacao: 1 } })]);
        const p = await produto(id);
        assert.strictEqual(Number(p.preco_compra), 5);
        assert.strictEqual(Number(p.estoque_atual), 10);
      });

      await test('6. Compra mista (paga + bonificada) do mesmo insumo: custo da última linha com valor apurável', async () => {
        const id = await criarProduto('INSUMO', { preco_compra: 1 });
        await comprar([
          item(id, { quantidade: 10, preco_unitario: 4, subtotal: 40 }),
          item(id, { quantidade: 5, preco_unitario: 0, subtotal: 0, extra: { bonificacao: 1 } })
        ]);
        const p = await produto(id);
        assert.strictEqual(Number(p.preco_compra), 4);
        assert.strictEqual(Number(p.estoque_atual), 15);
      });
    } finally {
      configService.getPadraoFiscal = original;
    }

    await test('6. Compra mista com padrão: bonificação não altera o custo da linha paga', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1 });
      await comprar([
        item(id, { quantidade: 10, preco_unitario: 4, subtotal: 40 }),
        item(id, { quantidade: 5, preco_unitario: 0, subtotal: 0, extra: { bonificacao: 1 } })
      ]);
      const p = await produto(id);
      assert.strictEqual(Number(p.preco_compra), 4);
      assert.strictEqual(Number(p.estoque_atual), 15);
    });

    await test('7. Embalagem comercial (sem fracionamento): custo por embalagem e unidade preservados', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1, unidade: 'UN' });
      await comprar([{
        produto_id: id, produto_nome: 'Farinha', unidade: 'UN', compra_em: 'CAIXA',
        quantidade_embalagens: 2, quantidade_comercial: 2, quantidade_por_embalagem: 10,
        valor_total_embalagem: 100, preco_unitario: 50, subtotal: 100,
        quantidade_fiscal: 0, quantidade_nao_fiscal: 20, atualizar_preco_venda: 1
      }]);
      const p = await produto(id);
      assert.strictEqual(Number(p.preco_compra), 50);
      assert.strictEqual(p.unidade, 'UN');
      assert.strictEqual(Number(p.preco_venda), 0);
      assert.strictEqual(Number(p.estoque_atual), 20);
      assert.strictEqual(Number(p.saldo_fiscal), 0);
      assert.strictEqual(Number(p.saldo_nao_fiscal), 20);
    });

    await test('7b. Produto fracionado (conversão): custo unitário = valor / quantidade convertida', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1, unidade: 'UN' });
      await comprar([{
        produto_id: id, produto_nome: 'Farinha', unidade: 'UN', compra_em: 'CAIXA', produto_fracionado: 1,
        quantidade_embalagens: 2, quantidade_comercial: 2, quantidade_por_embalagem: 10,
        valor_total_embalagem: 100, preco_unitario: 5, subtotal: 100,
        quantidade_fiscal: 0, quantidade_nao_fiscal: 20, atualizar_preco_venda: 1
      }]);
      const p = await produto(id);
      assert.strictEqual(Number(p.preco_compra), 5);
      assert.strictEqual(Number(p.preco_venda), 0);
      assert.strictEqual(Number(p.estoque_atual), 20);
    });

    const embalagem = (f, nf) => ({
      produto_nome: 'Farinha', unidade: 'UN', compra_em: 'CAIXA',
      quantidade_embalagens: 2, quantidade_comercial: 2, quantidade_por_embalagem: 10,
      valor_total_embalagem: 100, preco_unitario: 50, subtotal: 100,
      quantidade_fiscal: f, quantidade_nao_fiscal: nf
    });
    for (const [f, nf] of [[20, 0], [5, 15], [0, 20]]) {
      await test(`10. Estoque de embalagem credita exatamente 20 (fiscal ${f} / não fiscal ${nf}) e o cancelamento zera`, async () => {
        const id = await criarProduto('INSUMO', { preco_compra: 1 });
        const compraId = await comprar([{ produto_id: id, ...embalagem(f, nf) }]);
        const p = await produto(id);
        assert.strictEqual(Number(p.estoque_atual), 20);
        assert.strictEqual(Number(p.saldo_fiscal), f);
        assert.strictEqual(Number(p.saldo_nao_fiscal), nf);
        const ci = await dbGet(db, 'SELECT quantidade, quantidade_fiscal, quantidade_nao_fiscal FROM compras_itens WHERE compra_id = ?', [compraId]);
        assert.strictEqual(Number(ci.quantidade), 20);
        assert.strictEqual(Number(ci.quantidade_fiscal) + Number(ci.quantidade_nao_fiscal), 20);
        const r = await request(port, 'POST', `/compras/${compraId}/cancelar`, {});
        assert.ok(r.status < 300, `cancelar: ${r.status} ${r.raw}`);
        const depois = await produto(id);
        assert.strictEqual(Number(depois.estoque_atual), 0);
        assert.strictEqual(Number(depois.saldo_fiscal), 0);
        assert.strictEqual(Number(depois.saldo_nao_fiscal), 0);
      });
    }

    await test('10. Unidade comum: estoque creditado = quantidade informada (fiscal e não fiscal)', async () => {
      for (const [f, nf] of [[10, 0], [0, 10], [4, 6]]) {
        const id = await criarProduto('COMERCIAL', { preco_compra: 1 });
        await comprar([item(id, { quantidade: 10, preco_unitario: 5, extra: { quantidade_fiscal: f, quantidade_nao_fiscal: nf } })]);
        const p = await produto(id);
        assert.strictEqual(Number(p.estoque_atual), 10);
        assert.strictEqual(Number(p.saldo_fiscal), f);
        assert.strictEqual(Number(p.saldo_nao_fiscal), nf);
      }
    });

    await test('11. MUC: 3 PCT cadastrado como 50 UN entram como 150 UN e consomem 2 UN sem dupla conversão', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1, unidade: 'UN' });
      const apresentacao = {
        tipo: 'PCT',
        descricao: 'Pacote com 50 folhas',
        quantidade: 50,
        unidade: 'UN',
        principal: 1,
        compra: 1,
        venda: 0,
        estoque: 1,
        ativa: 1
      };
      const servicoEmbalagem = new ProdutoEmbalagemService(db);
      const apresentacoesSalvas = await new Promise((resolve, reject) => {
        servicoEmbalagem.sincronizarEmbalagensProduto(
          id,
          [apresentacao],
          'UN',
          { id: 1, nome: 'teste' },
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
        utiliza_conversao: 1,
        unidade_estoque: 'UN',
        apresentacoes: [apresentacao]
      });
      const embalagemId = Number(apresentacoesSalvas[0].id);
      const compraId = await comprar([{
        produto_id: id,
        produto_apresentacao_id: embalagemId,
        produto_nome: 'Massa para pastel',
        unidade: 'UN',
        unidade_comercial: 'PCT',
        compra_em: 'PCT',
        quantidade_embalagens: 3,
        quantidade_comercial: 3,
        quantidade: 150,
        quantidade_convertida: 150,
        quantidade_por_embalagem: 50,
        valor_total_embalagem: 75,
        preco_unitario: 0.5,
        custo_unitario_final: 0.5,
        subtotal: 75,
        quantidade_fiscal: 0,
        quantidade_nao_fiscal: 150,
        atualizar_preco_venda: 0
      }], { empresa_id: 1, total: 75 });

      const produtoInsumo = await produto(id);
      const itemCompra = await dbGet(
        db,
        `SELECT quantidade, quantidade_fiscal, quantidade_nao_fiscal, preco_unitario, subtotal
         FROM compras_itens WHERE compra_id = ? AND produto_id = ?`,
        [compraId, id]
      );
      const saldoAntes = await EstoqueEmpresaService.consultarSaldo(
        { produtoId: id, empresaId: 1 },
        { db }
      );
      assert.strictEqual(Number(itemCompra.quantidade), 150);
      assert.strictEqual(Number(itemCompra.quantidade_fiscal), 0);
      assert.strictEqual(Number(itemCompra.quantidade_nao_fiscal), 150);
      assert.strictEqual(Number(produtoInsumo.preco_compra), 0.5);
      assert.strictEqual(Number(itemCompra.preco_unitario), 0.5);
      assert.strictEqual(Number(itemCompra.subtotal), 75);
      assert.strictEqual(Number(saldoAntes.estoque_atual), 150);

      const produtoComercialId = await criarProduto('COMERCIAL', { unidade: 'UN' });
      await FichaTecnicaService.salvar(produtoComercialId, {
        ativo: 1,
        itens: [{ insumo_id: id, quantidade: 2, unidade: 'UN' }]
      }, { db });
      const venda = await dbRun(
        db,
        `INSERT INTO vendas (data_venda, total, empresa_id)
         VALUES (DATE('now'), 0, 1)`
      );
      const consumo = await consumirFichaTecnicaDaVenda({
        vendaId: venda.lastID,
        empresaId: 1,
        itens: [{ produto_id: produtoComercialId, quantidade: 1 }],
        db
      });
      const saldoDepois = await EstoqueEmpresaService.consultarSaldo(
        { produtoId: id, empresaId: 1 },
        { db }
      );
      assert.strictEqual(consumo.consumido, true);
      assert.strictEqual(Number(consumo.itens[0].quantidade), 2);
      assert.strictEqual(Number(saldoDepois.estoque_atual), 148);
    });

    await test('12. MUC: compra por PCT sem apresentação persistida é rejeitada sem movimentar estoque', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1, unidade: 'UN' });
      await dbRun(
        db,
        'UPDATE produtos SET utiliza_conversao = 1, unidade_estoque = ? WHERE id = ?',
        ['UN', id]
      );
      const r = await request(port, 'POST', '/compras', payloadCompra([{
        produto_id: id,
        produto_nome: 'Massa sem conversão cadastrada',
        unidade: 'UN',
        compra_em: 'PCT',
        quantidade_embalagens: 3,
        quantidade_comercial: 3,
        quantidade: 150,
        quantidade_convertida: 150,
        quantidade_por_embalagem: 50,
        valor_total_embalagem: 75,
        preco_unitario: 0.5,
        subtotal: 75,
        quantidade_fiscal: 0,
        quantidade_nao_fiscal: 150
      }], { empresa_id: 1, total: 75 }));
      assert.strictEqual(r.status, 400, `conversão não cadastrada: ${r.status} ${r.raw}`);
      const erroConversao = String(r.body?.error || r.body?.message || r.raw);
      assert.match(erroConversao, /Conversão não disponível: PACOTE → UN/);
      const p = await produto(id);
      const ci = await dbGet(db, 'SELECT COUNT(*) AS n FROM compras_itens WHERE produto_id = ?', [id]);
      const saldo = await EstoqueEmpresaService.consultarSaldo(
        { produtoId: id, empresaId: 1 },
        { db }
      );
      assert.strictEqual(ci.n, 0);
      assert.strictEqual(Number(saldo?.estoque_atual || 0), 0);
      assert.strictEqual(Number(p.preco_compra), 1);
    });

    await test('8.  Confirmação repetida (mesma chave de acesso) não duplica efeitos', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1 });
      const chave = '35261012345678000195550010000000011000000011';
      await comprar([item(id, { quantidade: 10, preco_unitario: 5 })], { chave_acesso: chave });
      const antes = await produto(id);
      const r = await request(port, 'POST', '/compras', payloadCompra([item(id, { quantidade: 10, preco_unitario: 9 })], { chave_acesso: chave }));
      assert.strictEqual(r.status, 400, r.raw);
      const depois = await produto(id);
      assert.strictEqual(Number(depois.preco_compra), Number(antes.preco_compra));
      assert.strictEqual(Number(depois.estoque_atual), Number(antes.estoque_atual));
      const c = await dbGet(db, 'SELECT COUNT(*) AS n FROM compras_itens WHERE produto_id = ?', [id]);
      assert.strictEqual(c.n, 1);
    });

    await test('9. Cancelamento de compra com estoque consumido é bloqueado sem alterar custo', async () => {
      const id = await criarProduto('INSUMO', { preco_compra: 1 });
      const compraId = await comprar([item(id, { quantidade: 10, preco_unitario: 5 })]);
      await dbRun(db, 'UPDATE produtos SET estoque_atual = 0, saldo_nao_fiscal = 0 WHERE id = ?', [id]);
      const r = await request(port, 'POST', `/compras/${compraId}/cancelar`, {});
      assert.ok(r.status >= 400, `esperava bloqueio, veio ${r.status} ${r.raw}`);
      const p = await produto(id);
      assert.strictEqual(Number(p.preco_compra), 5);
      const c = await dbGet(db, 'SELECT status FROM compras WHERE id = ?', [compraId]);
      assert.notStrictEqual(c.status, 'cancelada');
    });
  } finally {
    server.close();
    await new Promise((r) => db.close(() => r()));
  }
  console.log(`\nResultado: ${ok} OK, ${falhas} falha(s) — banco temporário isolado.`);
  if (falhas) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* limpeza best-effort */ }
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  });
