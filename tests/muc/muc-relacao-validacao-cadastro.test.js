'use strict';

// Banco temporário isolado: o banco oficial nunca é aberto.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-relacao-muc-'));
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

// Carrega o módulo de frontend real com um jQuery mínimo (somente o necessário para validar).
function carregarUI() {
  const win = {};
  const stub = () => ({ length: 0, trigger() {}, find() { return stub(); }, each() {}, eq() { return stub(); } });
  const sandbox = { window: win, $: stub, jQuery: stub, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/erp/js/produto-embalagens.js'), 'utf8'), sandbox);
  return win.ProdutoEmbalagensUI;
}

async function main() {
  const UI = carregarUI();
  const rel = (o, d, f) => ({ unidade_origem: o, unidade_destino: d, de: o, para: d, fator: f });

  await caso('frontend: relação válida é normalizada e mantida', () => {
    const v = UI.validarRelacoesFormulario([rel('un', 'ml', 1000)]);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(JSON.stringify(v.relacoes.map((r) => [r.unidade_origem, r.unidade_destino, r.fator])), '[["UN","ML",1000]]');
  });
  await caso('frontend: fator decimal com vírgula é convertido sem multiplicação indevida', () => {
    const v = UI.validarRelacoesFormulario([rel('KG', 'L', '0,850')]);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.relacoes[0].fator, 0.85);
  });
  await caso('frontend: lista vazia é válida (sem relações)', () => {
    assert.strictEqual(JSON.stringify(UI.validarRelacoesFormulario([])), '{"ok":true,"relacoes":[]}');
  });
  await caso('frontend: rejeita origem ausente indicando o campo', () => {
    const v = UI.validarRelacoesFormulario([rel('', 'ML', 1000)]);
    assert.ok(!v.ok && v.campo === 'origem' && /Relação 1/.test(v.mensagem));
  });
  await caso('frontend: rejeita destino ausente indicando o campo', () => {
    const v = UI.validarRelacoesFormulario([rel('UN', '', 1000)]);
    assert.ok(!v.ok && v.campo === 'destino');
  });
  await caso('frontend: rejeita fator inválido (0, negativo, vazio)', () => {
    for (const f of [0, -1, '', NaN]) {
      const v = UI.validarRelacoesFormulario([rel('UN', 'ML', f)]);
      assert.ok(!v.ok && v.campo === 'fator', `fator ${f}`);
    }
  });
  await caso('frontend: rejeita unidade desconhecida com o campo correto', () => {
    const v = UI.validarRelacoesFormulario([rel('UN', 'mililitros', 1000)]);
    assert.ok(!v.ok && v.campo === 'destino' && /mililitros/.test(v.mensagem));
  });
  await caso('frontend: origem = destino rejeitada', () => {
    assert.ok(!UI.validarRelacoesFormulario([rel('ML', 'ml', 5)]).ok);
  });
  await caso('frontend: saveProduto usa a validação e não descarta relações', () => {
    const f = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/produtos.js'), 'utf8');
    assert.ok(f.includes('ProdutoEmbalagensUI.validarRelacoesFormulario()'));
    assert.ok(f.includes('data.relacoes = validacaoRel.relacoes;'));
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

  const base = (nome, extra = {}) => ({
    nome, unidade: 'ML', unidade_estoque: 'ML', utiliza_conversao: 1, preco_compra: 1,
    preco_venda: 5, tipo_operacional: 'COMERCIAL', ...extra
  });
  const fardo = { tipo: 'FD', quantidade: 12, unidade: 'UN', ativa: 1, compra: 1, venda: 1, estoque: 1 };
  const relOk = { id: null, ...rel('UN', 'ML', 1000) };
  const cfg = async (id) => dbAll(db, 'SELECT unidade_origem, unidade_destino, fator FROM muc_produto_relacoes WHERE produto_id = ?', [id]);

  try {
    await caso('backend: cadastro sem conversão', async () => {
      const r = await request(port, 'POST', '/produtos', { nome: 'Sem conv', unidade: 'UN', preco_compra: 1, preco_venda: 3, utiliza_conversao: 0, relacoes: [] });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual((await cfg(r.body.id)).length, 0);
    });
    await caso('backend: cadastro com relação MUC válida (payload do frontend)', async () => {
      const r = await request(port, 'POST', '/produtos', base('Coca 1L', { relacoes: [relOk] }));
      assert.strictEqual(r.status, 200, r.raw);
      const rows = await cfg(r.body.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(Number(rows[0].fator), 1000);
    });
    await caso('backend: embalagem comercial + relação válida', async () => {
      const r = await request(port, 'POST', '/produtos', base('Coca fardo', { relacoes: [relOk], embalagens: [fardo] }));
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual((await cfg(r.body.id)).length, 1);
    });
    await caso('backend: INSUMO com relação válida', async () => {
      const r = await request(port, 'POST', '/produtos', base('Insumo leite', { tipo_operacional: 'INSUMO', preco_venda: 0, relacoes: [relOk] }));
      assert.strictEqual(r.status, 200, r.raw);
      const row = await dbGet(db, 'SELECT tipo_operacional, preco_venda FROM produtos WHERE id = ?', [r.body.id]);
      assert.strictEqual(row.tipo_operacional, 'INSUMO');
      assert.strictEqual(Number(row.preco_venda), 0);
    });
    await caso('backend: continua rejeitando relação sem origem/destino e fator inválido', async () => {
      const semDestino = await request(port, 'POST', '/produtos', base('Inv1', { relacoes: [{ ...relOk, unidade_destino: '', para: '' }] }));
      assert.strictEqual(semDestino.status, 400);
      assert.strictEqual(semDestino.body.code, 'UNIDADE_INVALIDA');
      const semOrigem = await request(port, 'POST', '/produtos', base('Inv2', { relacoes: [{ ...relOk, unidade_origem: '', de: '' }] }));
      assert.strictEqual(semOrigem.status, 400);
      const fator = await request(port, 'POST', '/produtos', base('Inv3', { relacoes: [{ ...relOk, fator: 0 }] }));
      assert.strictEqual(fator.status, 400);
      assert.strictEqual(fator.body.code, 'FATOR_INVALIDO');
      const desconhecida = await request(port, 'POST', '/produtos', base('Inv4', { relacoes: [{ ...relOk, unidade_destino: 'mililitros', para: 'mililitros' }] }));
      assert.strictEqual(desconhecida.status, 400);
      assert.ok(/desconhecida/.test(desconhecida.body.error), desconhecida.body.error);
    });
    await caso('backend: edição de produto existente com relação', async () => {
      const c = await request(port, 'POST', '/produtos', base('Edit', { relacoes: [relOk] }));
      assert.strictEqual(c.status, 200, c.raw);
      const id = c.body.id;
      const existente = (await cfg(id))[0];
      const put = await request(port, 'PUT', `/produtos/${id}`, base('Edit 2', { relacoes: [{ ...rel('UN', 'ML', 500) }] }));
      assert.strictEqual(put.status, 200, put.raw);
      const rows = await cfg(id);
      assert.ok(existente && rows.some((x) => Number(x.fator) === 500));
      const ruim = await request(port, 'PUT', `/produtos/${id}`, base('Edit 3', { relacoes: [{ ...rel('UN', '', 500) }] }));
      assert.strictEqual(ruim.status, 400);
    });
    await caso('simulação antes de salvar: 1 FARDO (12 UN, 1 UN = 1000 ML) = 12000 ML, sem persistência', async () => {
      const antes = {
        produtos: (await dbGet(db, 'SELECT COUNT(*) n FROM produtos')).n,
        rel: (await dbGet(db, 'SELECT COUNT(*) n FROM muc_produto_relacoes')).n,
        mov: (await dbGet(db, "SELECT COUNT(*) n FROM sqlite_master WHERE name='movimentacoes_estoque'")).n
          ? (await dbGet(db, 'SELECT COUNT(*) n FROM movimentacoes_estoque')).n : 0,
        estoque: (await dbGet(db, 'SELECT COALESCE(SUM(estoque_atual),0) n FROM produtos')).n
      };
      const r = await request(port, 'POST', '/produtos/conversao/simular', {
        quantidade: 1, unidade: 'FARDO', unidade_estoque: 'ML', relacoes: [relOk], apresentacoes: [fardo]
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(Number(r.body.quantidade), 12000);
      assert.strictEqual(r.body.unidade, 'ML');
      assert.strictEqual(r.body.persistido, false);
      assert.strictEqual(r.body.estoqueAlterado, false);
      const depois = {
        produtos: (await dbGet(db, 'SELECT COUNT(*) n FROM produtos')).n,
        rel: (await dbGet(db, 'SELECT COUNT(*) n FROM muc_produto_relacoes')).n,
        mov: antes.mov ? (await dbGet(db, 'SELECT COUNT(*) n FROM movimentacoes_estoque')).n : 0,
        estoque: (await dbGet(db, 'SELECT COALESCE(SUM(estoque_atual),0) n FROM produtos')).n
      };
      assert.deepStrictEqual(depois, antes);
    });
    await caso('simulação: 1 UN = 1000 ML e relação inválida é rejeitada sem persistir', async () => {
      const r = await request(port, 'POST', '/produtos/conversao/simular', { quantidade: 2, unidade: 'UN', unidade_estoque: 'ML', relacoes: [relOk] });
      assert.strictEqual(Number(r.body.quantidade), 2000);
      const ruim = await request(port, 'POST', '/produtos/conversao/simular', { quantidade: 1, unidade: 'UN', unidade_estoque: 'ML', relacoes: [{ ...relOk, unidade_destino: '', para: '' }] });
      assert.strictEqual(ruim.status, 400);
      const sem = await request(port, 'POST', '/produtos/conversao/simular', { quantidade: 1, unidade: 'FARDO', unidade_estoque: 'ML', relacoes: [relOk] });
      assert.strictEqual(sem.status, 400);
    });
  } finally {
    server.close();
    await new Promise((r) => db.close(() => r()));
  }
  console.log(`Relação MUC: ${ok} casos OK — banco temporário isolado.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* limpeza best-effort */ }
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  });
