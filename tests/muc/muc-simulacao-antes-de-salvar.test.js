'use strict';

// Banco temporário isolado: o banco oficial nunca é aberto.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-muc-simulacao-'));
process.env.DB_DIR = tmpDir;

const ROOT = path.join(__dirname, '../..');
let ok = 0;
async function caso(nome, fn) {
  await fn();
  ok += 1;
  console.log(`OK - ${nome}`);
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
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* não JSON */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const dbGet = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

async function main() {
  const front = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/produto-embalagens.js'), 'utf8');
  await caso('frontend: botão cobre cadastro novo e produto salvo, sem fechar nem alterar o formulário', () => {
    assert.ok(front.includes('/produtos/conversao/simular'), 'rota sem ID');
    assert.ok(front.includes('/produtos/${produtoId}/conversao/simular'), 'rota de produto salvo mantida');
    assert.ok(!front.includes('Salve o produto antes de simular'), 'sem exigência de ID');
    const trecho = front.slice(front.indexOf("on('click.relMuc', function onSimular"), front.indexOf("on('change.relMuc', atualizarVisibilidadeConversaoMuc"));
    assert.ok(!/\.modal\(|\.val\([^)]/.test(trecho), 'simulação não altera campos nem fecha o modal');
    assert.ok(trecho.includes('Origem:') && trecho.includes('Resultado:') && trecho.includes('Unidade de estoque:'), 'exibe origem, resultado e unidade de estoque');
    assert.ok(trecho.includes('Relação aplicada: 1'), 'exibe cada relação aplicada pelo MUC');
    assert.ok(trecho.includes('r.mensagem'), 'exibe mensagem da simulação retornada pela API');
    assert.ok(trecho.includes('configuracao:'), 'envia configuração pendente ao simular produto salvo');
    assert.ok(trecho.includes('configuracaoMucPendente()'), 'usa configuração persistida quando o formulário não mudou');
    assert.ok(trecho.includes('Simulação — alterações não salvas'), 'distingue a simulação pendente da persistida');
    assert.ok(front.includes('Quantidade de origem') && front.includes('Unidade de origem'), 'identifica explicitamente as unidades de entrada');
    assert.match(front, /id="simular_qtd_muc"[^>]*value="1"/, 'inicia a quantidade da simulação em 1');
    assert.match(front, /id="simular_un_muc"[^>]*list="unidades_origem_simular_muc"/, 'permite selecionar ou informar a unidade de origem');
    assert.ok(front.includes('atualizarUnidadesOrigemSimulacao'), 'atualiza sugestões com as relações e apresentações do formulário');
    assert.ok(front.includes('simulacaoOrigemPersonalizada'), 'preserva a unidade quando o operador escolhe outra origem');
    assert.ok(front.includes('atualizarUnidadesOrigemSimulacao(alterouRelacao)'), 'sincroniza a origem padrão ao editar relações');
    assert.ok(front.includes('primeiraOrigem && String(primeiraOrigem.unidade_origem).trim().toUpperCase()'), 'prioriza a origem da primeira relação configurada');
    assert.ok(front.includes('muc-ajuda') && front.includes('Como preencher?'));
    assert.ok(front.includes('/erp/assets/muc-relacao-preenchida.svg'));
    assert.ok(front.includes('statusConfiguracaoMuc'), 'indica alterações de conversão não salvas');
    assert.ok(front.includes('recarregarConfiguracaoPersistida'), 'recarrega a configuração confirmada pelo backend');
    assert.ok(fs.readFileSync(path.join(ROOT, 'frontend/erp/js/produtos.js'), 'utf8')
      .includes('ProdutoEmbalagensUI.recarregarConfiguracaoPersistida'), 'cadastro confirma a configuração após salvar');
  });

  const db = require('../../backend/database');
  await new Promise((r) => setTimeout(r, 4000));
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, nome: 'teste', role: 'admin' }; next(); });
  app.use('/produtos', require('../../backend/rotas/produtos'));
  const server = app.listen(0);
  const port = server.address().port;

  const rel = (o, d, f) => ({ unidade_origem: o, unidade_destino: d, de: o, para: d, fator: f });
  const fardo = { tipo: 'FD', quantidade: 12, unidade: 'UN', ativa: 1, compra: 1, venda: 1, estoque: 1 };
  const sim = (extra) => request(port, 'POST', '/produtos/conversao/simular', {
    quantidade: 1, unidade: 'FARDO', unidade_estoque: 'ML', relacoes: [rel('UN', 'ML', 1000)], apresentacoes: [fardo], ...extra
  });
  const simUnKg = (quantidade) => sim({
    quantidade,
    unidade: 'UN',
    unidadeOrigem: 'UN',
    unidadeDestino: 'KG',
    unidade_estoque: 'KG',
    relacoes: [rel('UN', 'KG', 5)],
    apresentacoes: []
  });
  const contagens = async () => ({
    produtos: (await dbGet(db, 'SELECT COUNT(*) n FROM produtos')).n,
    relacoes: (await dbGet(db, 'SELECT COUNT(*) n FROM muc_produto_relacoes')).n,
    estoque: (await dbGet(db, 'SELECT COALESCE(SUM(estoque_atual),0) n FROM produtos')).n,
    embalagens: (await dbGet(db, "SELECT COUNT(*) n FROM sqlite_master WHERE name='produto_embalagens'")).n
      ? (await dbGet(db, 'SELECT COUNT(*) n FROM produto_embalagens')).n : 0
  });

  try {
    const antes = await contagens();

    await caso('novo produto comercial: 1 FARDO (12 UN, 1 UN = 1000 ML) = 12000 ML', async () => {
      const r = await sim({ tipo_operacional: 'COMERCIAL', nome: 'Coca-Cola 1 L' });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 12000);
      assert.strictEqual(r.body.unidade, 'ML');
      assert.strictEqual(r.body.quantidade_origem, 1);
      assert.strictEqual(r.body.unidade_origem, 'FARDO');
      assert.strictEqual(r.body.unidade_estoque, 'ML');
      assert.deepStrictEqual(r.body.caminho, ['FARDO', 'UN', 'ML']);
      assert.strictEqual(r.body.persistido, false);
    });
    await caso('novo insumo: mesma simulação', async () => {
      const r = await sim({ tipo_operacional: 'INSUMO', nome: 'Leite', quantidade: 2.5 });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 30000);
    });
    await caso('conversão encadeada com aliases (FD/un/ml em minúsculas)', async () => {
      const r = await sim({ unidade: 'fd', unidade_estoque: 'ml', relacoes: [rel('un', 'ml', 1000)] });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 12000);
    });
    await caso('relação explícita 1 UN = 5 KG resulta em 5 KG', async () => {
      const r = await simUnKg(1);
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 5);
      assert.strictEqual(r.body.unidade, 'KG');
      assert.deepStrictEqual(r.body.caminho, ['UN', 'KG']);
      assert.deepStrictEqual(
        r.body.etapas.map(({ de, para, fator }) => ({ de, para, fator })),
        [{ de: 'UN', para: 'KG', fator: 5 }]
      );
    });
    await caso('1 UN = 350 G exibe a relação configurada e converte para o estoque em KG', async () => {
      const r = await sim({
        quantidade: 1,
        unidade: 'UN',
        unidadeOrigem: 'UN',
        unidadeDestino: 'KG',
        unidade_estoque: 'KG',
        relacoes: [rel('UN', 'G', 350)],
        apresentacoes: []
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 0.35);
      assert.strictEqual(r.body.unidade, 'KG');
      assert.deepStrictEqual(r.body.caminho, ['UN', 'G', 'KG']);
      assert.deepStrictEqual(
        r.body.etapas.slice(0, 1).map(({ de, para, fator }) => ({ de, para, fator })),
        [{ de: 'UN', para: 'G', fator: 350 }]
      );
    });
    await caso('relação explícita 2 UN = 10 KG', async () => {
      const r = await simUnKg(2);
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 10);
      assert.strictEqual(r.body.unidade, 'KG');
    });
    await caso('relação explícita KG → ML: 5 KG resulta em 4.250 ML', async () => {
      const r = await sim({
        quantidade: 5,
        unidade: 'KG',
        unidadeOrigem: 'kg',
        unidadeDestino: 'ML',
        unidade_estoque: 'ML',
        relacoes: [rel('kg', 'ml', 850)],
        apresentacoes: []
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 4250);
      assert.strictEqual(r.body.unidade, 'ML');
      assert.deepStrictEqual(r.body.caminho, ['KG', 'ML']);
    });
    await caso('relação explícita KG → L: 5 KG resulta em 4,25 L', async () => {
      const r = await sim({
        quantidade: 5,
        unidade: 'KG',
        unidadeOrigem: 'KG',
        unidadeDestino: 'L',
        unidade_estoque: 'L',
        relacoes: [rel('KG', 'LTRO', 0.850)],
        apresentacoes: []
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 4.25);
      assert.strictEqual(r.body.unidade, 'L');
    });
    await caso('entrada na unidade de estoque informa que não precisa converter', async () => {
      const r = await sim({
        quantidade: 5,
        unidade: 'KG',
        unidadeOrigem: 'KG',
        unidadeDestino: 'KG',
        unidade_estoque: 'KG',
        relacoes: [rel('KG', 'ML', 850)],
        apresentacoes: []
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 5);
      assert.strictEqual(r.body.unidade, 'KG');
      assert.match(r.body.mensagem, /já está na unidade de estoque/i);
    });
    await caso('relação explícita pode ser usada no sentido inverso pelo MUC', async () => {
      const r = await sim({
        quantidade: 850,
        unidade: 'ML',
        unidadeOrigem: 'ML',
        unidadeDestino: 'KG',
        unidade_estoque: 'KG',
        relacoes: [rel('KG', 'ML', 850)],
        apresentacoes: []
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 1);
      assert.deepStrictEqual(r.body.caminho, ['ML', 'KG']);
    });
    await caso('unidades sem relação retornam erro explícito de caminho ausente', async () => {
      const r = await sim({
        quantidade: 5,
        unidade: 'KG',
        unidadeOrigem: 'KG',
        unidadeDestino: 'ML',
        unidade_estoque: 'ML',
        relacoes: [],
        apresentacoes: []
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'CONVERSAO_NAO_DISPONIVEL');
      assert.match(r.body.error, /caminho de conversão.*cadastre uma relação/i);
    });
    await caso('relação ausente rejeitada', async () => {
      const r = await sim({ relacoes: [] });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'CONVERSAO_NAO_DISPONIVEL');
    });
    await caso('fator inválido rejeitado', async () => {
      for (const f of [0, -5, null]) {
        const r = await sim({ relacoes: [rel('UN', 'ML', f)] });
        assert.strictEqual(r.status, 400, `fator ${f}`);
        assert.strictEqual(r.body.code, 'FATOR_INVALIDO');
      }
    });
    await caso('unidade desconhecida rejeitada', async () => {
      const r = await sim({ relacoes: [rel('UN', 'mililitros', 1000)] });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'UNIDADE_INVALIDA');
      const o = await sim({ unidade: 'XPTO' });
      assert.strictEqual(o.status, 400);
    });
    await caso('relação ambígua (mesma origem/destino, fatores diferentes) rejeitada', async () => {
      const r = await sim({ relacoes: [rel('UN', 'ML', 1000), rel('UN', 'ML', 500)] });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'RELACAO_AMBIGUA');
    });
    await caso('quantidade e origem obrigatórias', async () => {
      assert.strictEqual((await sim({ quantidade: 0 })).status, 400);
      assert.strictEqual((await sim({ unidade: '' })).status, 400);
    });
    await caso('simulações não criam registros nem alteram estoque', async () => {
      assert.deepStrictEqual(await contagens(), antes);
    });

    await caso('produto existente: simulação por ID continua funcionando', async () => {
      const c = await request(port, 'POST', '/produtos', {
        nome: 'Coca existente', unidade: 'ML', unidade_estoque: 'ML', utiliza_conversao: 1,
        preco_compra: 1, preco_venda: 5, tipo_operacional: 'COMERCIAL',
        relacoes: [rel('UN', 'ML', 1000)], embalagens: [fardo]
      });
      assert.strictEqual(c.status, 200, c.raw);
      const antesSim = await contagens();
      const r = await request(port, 'POST', `/produtos/${c.body.id}/conversao/simular`, { quantidade: 1, unidade: 'FARDO', unidadeOrigem: 'FARDO', unidadeDestino: 'ML' });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(Number(r.body.quantidade), 12000);
      assert.strictEqual(r.body.estoqueAlterado, false);
      assert.deepStrictEqual(await contagens(), antesSim);
      const rels = await dbAll(db, 'SELECT fator FROM muc_produto_relacoes WHERE produto_id = ?', [c.body.id]);
      assert.strictEqual(rels.length, 1);
    });
    await caso('produto salvo: simulação retorna origem, destino e relação persistida', async () => {
      const c = await request(port, 'POST', '/produtos', {
        nome: 'Insumo com relação por densidade cadastrada',
        unidade: 'ML',
        unidade_estoque: 'ML',
        utiliza_conversao: 1,
        preco_compra: 1,
        preco_venda: 5,
        tipo_operacional: 'COMERCIAL',
        relacoes: [rel('KG', 'ML', 850)]
      });
      assert.strictEqual(c.status, 200, c.raw);
      const r = await request(port, 'POST', `/produtos/${c.body.id}/conversao/simular`, {
        quantidade: 5,
        unidade: 'KG',
        unidadeOrigem: 'KG',
        unidadeDestino: 'ML'
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 4250);
      assert.strictEqual(r.body.quantidade_origem, 5);
      assert.strictEqual(r.body.unidade_origem, 'KG');
      assert.strictEqual(r.body.unidade_estoque, 'ML');
      assert.strictEqual(r.body.persistido, true);
      const cfg = await request(port, 'GET', `/produtos/${c.body.id}/conversao`);
      assert.strictEqual(cfg.status, 200, cfg.raw);
      assert.strictEqual(cfg.body.unidade_estoque, 'ML');
      assert.deepStrictEqual(cfg.body.relacoes.map((item) => item.fator), [850]);
      const produto = await request(port, 'GET', `/produtos/${c.body.id}`);
      assert.strictEqual(produto.status, 200, produto.raw);
      assert.strictEqual(produto.body.unidade_estoque, 'ML');
      assert.deepStrictEqual(produto.body.relacoes.map((item) => item.fator), [850]);
    });
    await caso('produto salvo e reaberto: 1 UN = 5 KG é aplicado em 1 UN e 2 UN', async () => {
      const c = await request(port, 'POST', '/produtos', {
        nome: 'Produto teste MUC UN para KG',
        unidade: 'KG',
        unidade_estoque: 'KG',
        utiliza_conversao: 1,
        preco_compra: 1,
        preco_venda: 5,
        tipo_operacional: 'COMERCIAL',
        relacoes: [rel('UN', 'KG', 5)]
      });
      assert.strictEqual(c.status, 200, c.raw);
      const cfg = await request(port, 'GET', `/produtos/${c.body.id}/conversao`);
      assert.strictEqual(cfg.status, 200, cfg.raw);
      assert.deepStrictEqual(cfg.body.relacoes.map((item) => item.fator), [5]);
      for (const [quantidade, esperado] of [[1, 5], [2, 10]]) {
        const r = await request(port, 'POST', `/produtos/${c.body.id}/conversao/simular`, {
          quantidade,
          unidade: 'UN',
          unidadeOrigem: 'UN',
          unidadeDestino: 'KG'
        });
        assert.strictEqual(r.status, 200, r.raw);
        assert.strictEqual(r.body.quantidade, esperado);
        assert.strictEqual(r.body.persistido, true);
        assert.strictEqual(r.body.estoqueAlterado, false);
      }
    });
    await caso('produto salvo: simula configuração pendente sem persistir mudanças', async () => {
      const c = await request(port, 'POST', '/produtos', {
        nome: 'Produto teste MUC pendente',
        unidade: 'ML',
        unidade_estoque: 'ML',
        utiliza_conversao: 1,
        preco_compra: 1,
        preco_venda: 5,
        tipo_operacional: 'COMERCIAL',
        relacoes: [rel('UN', 'ML', 1000)]
      });
      assert.strictEqual(c.status, 200, c.raw);
      const antesSim = await contagens();
      const r = await request(port, 'POST', `/produtos/${c.body.id}/conversao/simular`, {
        quantidade: 5,
        unidade: 'UN',
        unidadeOrigem: 'UN',
        unidadeDestino: 'KG',
        configuracao: {
          utiliza_conversao: 1,
          unidade_estoque: 'KG',
          relacoes: [rel('UN', 'KG', 5)],
          apresentacoes: []
        }
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.quantidade, 25);
      assert.strictEqual(r.body.unidade, 'KG');
      assert.strictEqual(r.body.persistido, false);
      assert.strictEqual(r.body.estoqueAlterado, false);
      assert.deepStrictEqual(await contagens(), antesSim);
      const cfg = await request(port, 'GET', `/produtos/${c.body.id}/conversao`);
      assert.strictEqual(cfg.status, 200, cfg.raw);
      assert.strictEqual(cfg.body.unidade_estoque, 'ML');
      assert.deepStrictEqual(cfg.body.relacoes.map((item) => item.fator), [1000]);
    });
  } finally {
    server.close();
    await new Promise((r) => db.close(() => r()));
  }
  console.log(`Simulação MUC antes de salvar: ${ok} casos OK — banco temporário isolado.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* limpeza best-effort */ }
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  });
