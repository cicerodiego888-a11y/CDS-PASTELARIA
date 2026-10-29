/**
 * PDV-MULTIEMPRESA-09 — Homologação integrada pós-M08 (seletor + Motor F×NF).
 * Sem alteração de regras de produção. Isolamento :memory: / leitura estática.
 * Executar: node --test tests/pdv/pdv-multiempresa-09-homologacao-pos-m08.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  distribuirQuantidadeVenda,
  distribuirItensVendaComValorFiscalEfetivo
} = require('../../backend/services/distribuidorEstoqueVenda');
const {
  avaliarSelecaoEmpresaPdv,
  montarMensagemBloqueio,
  CODIGOS_BLOQUEIO
} = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL_B = '11222333000262';
const CNPJ_FILIAL_C = '11222333000343';
const ROOT = path.join(__dirname, '../..');

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
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz M09' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B M09' },
    { db }
  );
  const filialC = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C M09' },
    { db }
  );
  return { db, matriz, filialB, filialC };
}

async function criarProduto(db, nome, tipo = 'COMERCIAL') {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, controla_estoque)
     VALUES (?, ?, 'UN', 1)`,
    [nome, tipo]
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

async function selecao(db, itens, emitir) {
  const body = {
    itens,
    emitir_fiscal: emitir,
    venda_fiscal: emitir,
    origem: 'PDV'
  };
  return avaliarSelecaoEmpresaPdv({ body, itens, usuarioId: 1 }, deps(db));
}

function motorItem(qty, saldoF, saldoNf, vendaFiscal) {
  return distribuirItensVendaComValorFiscalEfetivo(
    [{
      item: { produto_id: 1, quantidade: qty, preco_unitario: 10, subtotal: qty * 10 },
      saldoFiscal: saldoF,
      saldoNaoFiscal: saldoNf
    }],
    vendaFiscal,
    { midpAtivo: false, pagamentos: [] }
  );
}

/** Espelha contrato HTTP 409 do preview selecao-empresa. */
function http409DeSelecao(out) {
  return {
    success: false,
    code: out.bloqueio && out.bloqueio.codigo,
    error: out.bloqueio && out.bloqueio.mensagem,
    mensagem: out.bloqueio && out.bloqueio.mensagem,
    selecao: out,
    venda_concluida: false
  };
}

describe('PDV-MULTIEMPRESA-09 homologação integrada pós-M08', { concurrency: false }, () => {
  it('C1 — venda fiscal + saldo fiscal suficiente: seletor e motor permitem', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'C1');
    await setEstoque(db, prod, matriz.id, 8, 0);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await selecao(db, [{ produto_id: prod, quantidade: 3 }], true);
    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio));
    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.equal(out.tipoSaldo, TipoSaldo.FISCAL);

    const motor = motorItem(3, 8, 0, true);
    assert.equal(motor.sucesso, true);
    assert.equal(motor.itens[0].quantidade_fiscal, 3);
    assert.equal(motor.itens[0].quantidade_nao_fiscal, 0);
    await closeDb(db);
  });

  it('C2 — venda fiscal + só NF: seletor e motor bloqueiam', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'C2');
    await setEstoque(db, prod, matriz.id, 0, 10);
    await setEstoque(db, prod, filialB.id, 0, 10);
    await setEstoque(db, prod, filialC.id, 0, 10);

    const out = await selecao(db, [{ produto_id: prod, quantidade: 2 }], true);
    assert.ok(out.bloqueio);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);

    const motor = motorItem(2, 0, 10, true);
    assert.equal(motor.sucesso, false);
    await closeDb(db);
  });

  it('C3 — venda não fiscal + saldo NF suficiente: permitem', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'C3');
    await setEstoque(db, prod, matriz.id, 0, 6);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await selecao(db, [{ produto_id: prod, quantidade: 4 }], false);
    assert.equal(out.bloqueio, null);
    assert.equal(out.tipoSaldo, TipoSaldo.NAO_FISCAL);

    const motor = motorItem(4, 0, 6, false);
    assert.equal(motor.sucesso, true);
    assert.equal(motor.itens[0].quantidade_nao_fiscal, 4);
    assert.equal(motor.itens[0].quantidade_fiscal, 0);
    await closeDb(db);
  });

  it('C4 — venda não fiscal + só fiscal: bloqueiam', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'C4');
    await setEstoque(db, prod, matriz.id, 10, 0);
    await setEstoque(db, prod, filialB.id, 10, 0);
    await setEstoque(db, prod, filialC.id, 10, 0);

    const out = await selecao(db, [{ produto_id: prod, quantidade: 2 }], false);
    assert.ok(out.bloqueio);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);

    const motor = motorItem(2, 10, 0, false);
    assert.equal(motor.sucesso, false);
    await closeDb(db);
  });

  it('C5 — qty > bucket: bloqueio sem distribuição parcial', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'C5');
    await setEstoque(db, prod, matriz.id, 2, 50);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await selecao(db, [{ produto_id: prod, quantidade: 5 }], true);
    assert.ok(out.bloqueio);

    const unit = distribuirQuantidadeVenda(5, 2, 50, true);
    assert.equal(unit.sucesso, false);
    assert.equal(unit.quantidadeFiscal, undefined);

    const pipe = motorItem(5, 2, 50, true);
    assert.equal(pipe.sucesso, false);
    assert.equal(pipe.itens, undefined);
    await closeDb(db);
  });

  it('C6 — carrinho misto (tipo_saldo por item) na mesma empresa', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const f = await criarProduto(db, 'C6F');
    const nf = await criarProduto(db, 'C6NF');
    await setEstoque(db, f, matriz.id, 5, 0);
    await setEstoque(db, nf, matriz.id, 0, 5);
    await setEstoque(db, f, filialB.id, 0, 0);
    await setEstoque(db, nf, filialB.id, 0, 0);
    await setEstoque(db, f, filialC.id, 0, 0);
    await setEstoque(db, nf, filialC.id, 0, 0);

    const ok = await selecao(db, [
      { produto_id: f, quantidade: 2, tipo_saldo: 'FISCAL' },
      { produto_id: nf, quantidade: 2, tipo_saldo: 'NAO_FISCAL' }
    ], true);
    assert.equal(ok.bloqueio, null);
    assert.equal(ok.selecionada.empresaId, matriz.id);

    const falha = await selecao(db, [
      { produto_id: f, quantidade: 2, tipo_saldo: 'NAO_FISCAL' },
      { produto_id: nf, quantidade: 2, tipo_saldo: 'FISCAL' }
    ], true);
    assert.ok(falha.bloqueio);
    await closeDb(db);
  });

  it('C7 — ficha técnica: total F+NF dos insumos preservado', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const acabado = await criarProduto(db, 'C7Acabado', 'COMERCIAL');
    const insumo = await criarProduto(db, 'C7Insumo', 'INSUMO');
    await run(db, `UPDATE produtos SET utiliza_ficha_tecnica=1 WHERE id=?`, [acabado]);
    await FichaTecnicaService.salvar(acabado, {
      ativo: 1,
      itens: [{ insumo_id: insumo, quantidade: 1, unidade: 'UN' }]
    }, { db });
    await setEstoque(db, insumo, matriz.id, 0, 4);
    await setEstoque(db, acabado, matriz.id, 0, 0);
    await setEstoque(db, insumo, filialB.id, 0, 0);
    await setEstoque(db, acabado, filialB.id, 0, 0);
    await setEstoque(db, insumo, filialC.id, 0, 0);
    await setEstoque(db, acabado, filialC.id, 0, 0);

    const out = await selecao(db, [{ produto_id: acabado, quantidade: 2 }], true);
    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio));
    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('C8 — nenhuma empresa atende; sem soma entre CNPJs', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'C8');
    await setEstoque(db, prod, matriz.id, 2, 0);
    await setEstoque(db, prod, filialB.id, 2, 0);
    await setEstoque(db, prod, filialC.id, 2, 0);

    const out = await selecao(db, [{ produto_id: prod, quantidade: 5 }], true);
    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    assert.ok((out.capacidade.porEmpresa || []).every((e) => e.atendeIntegralmente === false));
    await closeDb(db);
  });

  it('C9 — revalidação antes da finalização (2ª avaliação)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'C9');
    await setEstoque(db, prod, matriz.id, 1, 0);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const r1 = await selecao(db, [{ produto_id: prod, quantidade: 1 }], true);
    assert.equal(r1.selecionada.empresaId, matriz.id);

    await setEstoque(db, prod, matriz.id, 0, 0);
    const r2 = await selecao(db, [{ produto_id: prod, quantidade: 1 }], true);
    assert.ok(r2.bloqueio);
    assert.equal(r2.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);

    // Motor também falharia na finalização com o mesmo saldo.
    assert.equal(motorItem(1, 0, 0, true).sucesso, false);
    await closeDb(db);
  });

  it('C10 — mensagem PDV usa motivo efetivo do bloqueio (banner + HTTP 409)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'C10');
    await setEstoque(db, prod, matriz.id, 0, 5);
    await setEstoque(db, prod, filialB.id, 0, 5);
    await setEstoque(db, prod, filialC.id, 0, 5);

    const out = await selecao(db, [{ produto_id: prod, quantidade: 2 }], true);
    assert.ok(out.bloqueio);
    const msg = out.bloqueio.mensagem || montarMensagemBloqueio(out.capacidade);
    assert.match(msg, /não será dividida|Nenhuma empresa/i);
    assert.match(msg, /ESTOQUE_INSUFICIENTE_FISCAL/);
    assert.match(msg, /produto/);

    const http = http409DeSelecao({
      ...out,
      bloqueio: { codigo: out.bloqueio.codigo, mensagem: msg }
    });
    assert.equal(http.code, 'NENHUMA_EMPRESA_ATENDE');
    assert.equal(http.mensagem, msg);
    assert.ok(Array.isArray(http.selecao.capacidade.porEmpresa));

    // Contrato UI (leitura estática): banner e fetch propagam data.mensagem
    const pdvSrc = fs.readFileSync(path.join(ROOT, 'frontend/pdv/js/pdv.js'), 'utf8');
    assert.match(pdvSrc, /renderBannerSelecaoEmpresaPdv/);
    assert.match(pdvSrc, /mensagem:\s*data\.mensagem\s*\|\|\s*data\.error/);
    assert.match(pdvSrc, /el\.textContent\s*=\s*estado\.mensagem\s*\|\|\s*estado\.error/);
    assert.match(pdvSrc, /showNotification\(data\.mensagem\s*\|\|\s*data\.error/);

    // Simula o que o banner exibe no 409
    const textoBanner = http.mensagem || http.error || 'fallback';
    assert.equal(textoBanner, msg);
    assert.match(textoBanner, /ESTOQUE_INSUFICIENTE_FISCAL/);
    await closeDb(db);
  });

  it('canal Entrega: contrato chama distribuidor compartilhado (bucket exclusivo)', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/entrega/CriarVendaEntregaService.js'),
      'utf8'
    );
    assert.match(src, /distribuirItensVendaComValorFiscalEfetivo/);
    assert.match(src, /parseVendaFiscalFlag\(body\.emitir_fiscal\)/);
    // Mesmo núcleo: bloqueio cruzado
    const r = motorItem(2, 0, 10, true);
    assert.equal(r.sucesso, false);
  });

  it('canal Faturamento/expedição: núcleo venda + venda_fiscal; motor exclusivo', () => {
    const fat = fs.readFileSync(
      path.join(ROOT, 'backend/services/faturamento/FaturamentoService.js'),
      'utf8'
    );
    assert.match(fat, /VendaApplicationService/);
    assert.match(fat, /venda_fiscal/);
    assert.match(fat, /emitir_fiscal:\s*false/);
    // Distribuição ocorre no núcleo (VendaPagamentoService), não no FaturamentoService
    const pag = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.match(pag, /distribuirItensVendaComValorFiscalEfetivo/);
    const r = motorItem(5, 3, 3, true);
    assert.equal(r.sucesso, false);
  });
});
