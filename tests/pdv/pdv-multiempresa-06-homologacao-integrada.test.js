/**
 * PDV-MULTIEMPRESA-06 — Homologação integrada do seletor (CAP+SEL+M04+M05).
 * Ambiente isolado :memory: — sem banco oficial / SEFAZ.
 * Executar: node --test tests/pdv/pdv-multiempresa-06-homologacao-integrada.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite3 = require('sqlite3').verbose();

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  avaliarSelecaoEmpresaPdv,
  validarCaixaDaEmpresaSelecionada,
  CODIGOS_BLOQUEIO
} = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL_B = '11222333000262';
const CNPJ_FILIAL_C = '11222333000343';

const pdvSource = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');
const fnMatch = pdvSource.match(
  /function montarItensSelecaoEmpresaPreviewPdv\(itensCarrinho\) \{[\s\S]*?\n\}/
);
assert.ok(fnMatch, 'preview M05 deve existir no worktree');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(
  `${fnMatch[0]}\nmodule.exports = { montarItensSelecaoEmpresaPreviewPdv };`,
  sandbox
);
const { montarItensSelecaoEmpresaPreviewPdv } = sandbox.module.exports;

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID });
    });
  });
}
function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      ativo INTEGER DEFAULT 1,
      unidade TEXT DEFAULT 'UN',
      tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      utiliza_ficha_tecnica INTEGER,
      updated_at DATETIME
    )
  `);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);
  const matriz = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz M06' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B M06' },
    { db }
  );
  const filialC = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C M06' },
    { db }
  );
  return { db, matriz, filialB, filialC };
}

async function criarProduto(db, nome) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, controla_estoque, saldo_fiscal, estoque_atual)
     VALUES (?, 'COMERCIAL', 'UN', 1, 0, 0)`,
    [nome]
  );
  return ins.lastID;
}

async function setEstoque(db, produtoId, empresaId, fiscal, naoFiscal = 0) {
  const existe = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM estoque_empresa WHERE produto_id=? AND empresa_id=?`,
      [produtoId, empresaId],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
  if (existe) {
    await run(
      db,
      `UPDATE estoque_empresa SET saldo_fiscal=?, saldo_nao_fiscal=?, estoque_atual=?,
         reservado_fiscal=0, reservado_nao_fiscal=0
       WHERE produto_id=? AND empresa_id=?`,
      [fiscal, naoFiscal, fiscal + naoFiscal, produtoId, empresaId]
    );
  } else {
    await EstoqueEmpresaService.criarRegistro({
      produtoId,
      empresaId,
      saldo_fiscal: fiscal,
      saldo_nao_fiscal: naoFiscal,
      estoque_atual: fiscal + naoFiscal
    }, { db });
  }
}

function deps(db) {
  return { db, usarAutorizacaoUsuario: false, verificarFiscalValido: async () => true };
}

async function previewSelecao(db, carrinhoLike, { emitir = true } = {}) {
  const itens = montarItensSelecaoEmpresaPreviewPdv(carrinhoLike);
  const body = {
    itens,
    emitir_fiscal: emitir,
    venda_fiscal: emitir,
    origem: 'PDV'
  };
  const out = await avaliarSelecaoEmpresaPdv({
    body,
    itens,
    usuarioId: 1
  }, deps(db));
  return { body, out };
}

describe('PDV-MULTIEMPRESA-06 homologação integrada', { concurrency: false }, () => {
  it('C1 — carrinho homogêneo: matriz com capacidade', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Homogeneo');
    await setEstoque(db, prod, matriz.id, 10, 10);
    await setEstoque(db, prod, filialB.id, 10, 10);
    await setEstoque(db, prod, filialC.id, 10, 10);

    const { out } = await previewSelecao(db, [{ id: prod, quantidade: 2 }]);
    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio));
    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.ok(out.hashCarrinho);
    await closeDb(db);
  });

  it('C2 — matriz incapaz → filial (id ASC)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Filial');
    await setEstoque(db, prod, matriz.id, 0, 0);
    await setEstoque(db, prod, filialB.id, 5, 5);
    await setEstoque(db, prod, filialC.id, 5, 5);

    const { out } = await previewSelecao(db, [{ id: prod, quantidade: 2 }]);
    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio));
    assert.equal(out.selecionada.empresaId, filialB.id);
    assert.ok(filialB.id < filialC.id);
    await closeDb(db);
  });

  it('C3 — carrinho misto com tipo_saldo explícito por item', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const f = await criarProduto(db, 'Fiscal');
    const nf = await criarProduto(db, 'NaoFiscal');
    await setEstoque(db, f, matriz.id, 3, 0);
    await setEstoque(db, nf, matriz.id, 0, 4);
    await setEstoque(db, f, filialB.id, 0, 0);
    await setEstoque(db, nf, filialB.id, 0, 0);
    await setEstoque(db, f, filialC.id, 0, 0);
    await setEstoque(db, nf, filialC.id, 0, 0);

    const { body, out } = await previewSelecao(db, [
      { id: f, quantidade: 2, tipo_saldo: 'FISCAL' },
      { id: nf, quantidade: 3, tipo_saldo: 'NAO_FISCAL' }
    ]);
    assert.ok(body.itens.every((i) => i.tipo_saldo));
    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio || out.capacidade));
    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('C4 — sem campos por item: fallback operacional (emitir_fiscal)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Fallback');
    await setEstoque(db, prod, matriz.id, 0, 5);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const preview = montarItensSelecaoEmpresaPreviewPdv([
      { id: prod, quantidade: 1, item_fiscal: 1 }
    ]);
    assert.equal(preview[0].tipo_saldo, undefined);

    const bloqueioFiscal = await avaliarSelecaoEmpresaPdv({
      body: { itens: preview, emitir_fiscal: true, venda_fiscal: true, origem: 'PDV' },
      itens: preview,
      usuarioId: 1
    }, deps(db));
    assert.ok(bloqueioFiscal.bloqueio);
    assert.equal(bloqueioFiscal.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);

    const okNf = await avaliarSelecaoEmpresaPdv({
      body: { itens: preview, emitir_fiscal: false, venda_fiscal: false, origem: 'PDV' },
      itens: preview,
      usuarioId: 1
    }, deps(db));
    assert.equal(okNf.bloqueio, null);
    assert.equal(okNf.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('C5 — HTTP 409 equivalente: nenhuma empresa atende (evidência de bloqueio)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Bloqueio');
    await setEstoque(db, prod, matriz.id, 1, 1);
    await setEstoque(db, prod, filialB.id, 1, 1);
    await setEstoque(db, prod, filialC.id, 1, 1);

    const { body, out } = await previewSelecao(db, [{ id: prod, quantidade: 5 }]);
    assert.ok(out.bloqueio);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    assert.match(String(out.bloqueio.mensagem), /não será dividida|Nenhuma empresa/i);

    // Contrato HTTP 409 do preview (rotas/vendas.js)
    const httpBody = {
      success: false,
      code: out.bloqueio.codigo,
      error: out.bloqueio.mensagem,
      mensagem: out.bloqueio.mensagem,
      selecao: out,
      venda_concluida: false
    };
    assert.equal(httpBody.code, 'NENHUMA_EMPRESA_ATENDE');
    assert.ok(Array.isArray(httpBody.selecao.capacidade.porEmpresa));
    assert.ok(httpBody.selecao.capacidade.porEmpresa.every((e) => e.atendeIntegralmente === false));
    assert.ok(body.itens[0].produto_id > 0);
    // Classificação: bloqueio LEGÍTIMO (estoque insuficiente por empresa; soma agregada 3 < 5? 1+1+1=3 < 5)
    await closeDb(db);
  });

  it('C6 — ausência de soma entre CNPJs', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'NaoSoma');
    await setEstoque(db, prod, matriz.id, 2, 0);
    await setEstoque(db, prod, filialB.id, 2, 0);
    await setEstoque(db, prod, filialC.id, 2, 0);
    // Agregado 6 >= 5, nenhuma empresa sozinha atende.
    const { out } = await previewSelecao(db, [{ id: prod, quantidade: 5 }]);
    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('C7 — revalidação: consulta não reserva; 2ª avaliação após baixa sintética', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Reval');
    await setEstoque(db, prod, matriz.id, 1, 0);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const r1 = await previewSelecao(db, [{ id: prod, quantidade: 1 }]);
    assert.equal(r1.out.selecionada.empresaId, matriz.id);

    await setEstoque(db, prod, matriz.id, 0, 0);
    const r2 = await previewSelecao(db, [{ id: prod, quantidade: 1 }]);
    assert.ok(r2.out.bloqueio);
    assert.equal(r2.out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('C8 — caixa compatível com empresa selecionada', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Caixa');
    await setEstoque(db, prod, matriz.id, 5, 5);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const { out } = await previewSelecao(db, [{ id: prod, quantidade: 1 }]);
    assert.equal(out.selecionada.empresaId, matriz.id);

    // Compatível
    assert.doesNotThrow(() => validarCaixaDaEmpresaSelecionada(
      { caixaSessao: { id: 1, empresa_id: matriz.id, status: 'aberto' } },
      matriz.id,
      { exigirCaixa: true }
    ));

    // Incompatível (caixa de outra empresa)
    let err = null;
    try {
      validarCaixaDaEmpresaSelecionada(
        { caixaSessao: { id: 2, empresa_id: filialB.id, status: 'aberto' } },
        matriz.id,
        { exigirCaixa: true }
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, CODIGOS_BLOQUEIO.CAIXA_INCOMPATIVEL);
    assert.equal(err.statusCode, 409);

    // Ausente
    err = null;
    try {
      validarCaixaDaEmpresaSelecionada({}, matriz.id, { exigirCaixa: true });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, CODIGOS_BLOQUEIO.CAIXA_INCOMPATIVEL);
    await closeDb(db);
  });
});
