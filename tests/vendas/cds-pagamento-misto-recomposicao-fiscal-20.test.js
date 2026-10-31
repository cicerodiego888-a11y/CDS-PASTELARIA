/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 20
 * Homologação do fechamento integrado: baixa automática e manual.
 *
 * Executar:
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-20.test.js
 *
 * Isolamento: DB_DIR temporário + sqlite :memory:. Sem banco oficial / SEFAZ.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-recomposicao-20-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  garantirSchemaEmpresasConfiguracaoEstoqueAsync
} = require('../../backend/services/empresas/empresasConfiguracaoEstoqueSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EmpresaModoEstoqueService = require('../../backend/services/empresas/EmpresaModoEstoqueService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaVendaFichaConsumoAsync } = require('../../backend/services/produtos/vendaFichaConsumoSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  consumirFichaTecnicaDaVenda
} = require('../../backend/services/produtos/FichaTecnicaConsumoService');
const {
  reduzirEstoqueDistribuido
} = require('../../backend/services/vendas/VendaPagamentoService');
const {
  encaminharPropostaValidadaAoDistribuidorOficial,
  obterAutorizacaoDistribuicaoOficialInterna
} = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');
const {
  distribuirItensVendaComValorFiscalEfetivo
} = require('../../backend/services/distribuidorEstoqueVenda');
const {
  calcularValorFiscalLiquido
} = require('../../backend/services/vendas/valorFiscalLiquido');

const CNPJ_A = '11222333000181';
const PAGAMENTOS = Object.freeze([
  Object.freeze({ forma_pagamento: 'debito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'credito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'dinheiro', valor: 10 })
]);

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_err) { resolve(); }
  });
}

function reduzirAsync(vendaItemId, produtoId, qF, qNf, opcoes) {
  return new Promise((resolve, reject) => {
    reduzirEstoqueDistribuido(vendaItemId, produtoId, qF, qNf, (err) => {
      if (err) reject(err);
      else resolve();
    }, opcoes);
  });
}

async function saldoEmpresa(db, produtoId, empresaId) {
  const row = await get(
    db,
    'SELECT saldo_fiscal, saldo_nao_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
  return {
    saldo_fiscal: Number(row.saldo_fiscal),
    saldo_nao_fiscal: Number(row.saldo_nao_fiscal)
  };
}

async function preparar(modo) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);
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
      controlar_validade INTEGER DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, 'CREATE TABLE vendas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER)');
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaVendaFichaConsumoAsync(db);

  const empresa = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_A, razao_social: 'Empresa homologacao' },
    { db }
  );
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresa.id, modo);

  const produto = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual, controla_estoque, controlar_validade)
     VALUES ('Refrigerante', 'COMERCIAL', 'UN', 10, 10, 20, 1, 0)`
  );
  const insumo = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual, controla_estoque, controlar_validade)
     VALUES ('Massa', 'INSUMO', 'UN', 10, 0, 10, 1, 0)`
  );
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produto.lastID,
    empresaId: empresa.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 10,
    estoque_atual: 20
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: insumo.lastID,
    empresaId: empresa.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 0,
    estoque_atual: 10
  }, { db });
  await FichaTecnicaService.salvar(produto.lastID, {
    ativo: 1,
    itens: [{ insumo_id: insumo.lastID, quantidade: 1, unidade: 'UN' }]
  }, { db });
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresa.id]);

  return {
    db,
    empresaId: empresa.id,
    produtoId: produto.lastID,
    insumoId: insumo.lastID,
    vendaId: venda.lastID
  };
}

function motorLegado(produtoId) {
  return distribuirItensVendaComValorFiscalEfetivo(
    [{
      item: {
        produto_id: produtoId,
        quantidade: 5,
        preco_unitario: 10,
        subtotal: 50,
        unidade: 'UN'
      },
      saldoFiscal: 10,
      saldoNaoFiscal: 10
    }],
    true,
    {
      pagamentos: PAGAMENTOS.map((p) => ({ ...p })),
      desconto: 5,
      acrescimo: 0,
      midpAtivo: false,
      politicaFiscalComercial: null
    }
  );
}

async function distribuirAutorizada(ambiente, extra = {}) {
  const pagamentos = PAGAMENTOS.map((p) => ({ ...p }));
  const out = await encaminharPropostaValidadaAoDistribuidorOficial({
    env: {},
    autorizacao: obterAutorizacaoDistribuicaoOficialInterna({}, { ativa: true }),
    validacao: {
      composicao_validada_em_homologacao: true,
      itens_composicao: [{ produto_id: ambiente.produtoId, quantidade: 4, subtotal: 40 }]
    },
    itensVendidos: [{
      produto_id: ambiente.produtoId,
      quantidade: 5,
      preco_unitario: 10,
      subtotal: 50,
      unidade: 'UN'
    }],
    pagamentos,
    totalComercial: 50,
    desconto: 5,
    acrescimo: 0,
    empresaId: ambiente.empresaId,
    db: ambiente.db,
    saldosPorProduto: {
      [ambiente.produtoId]: { saldoFiscal: 10, saldoNaoFiscal: 10 }
    },
    aplicarSaldo: false,
    ...extra
  });
  return { out, pagamentos };
}

async function opcoesComoCriarVenda(db, empresaId) {
  const permite = await EmpresaModoEstoqueService.empresaPermiteBaixaAutomaticaEstoque(db, empresaId);
  return {
    db,
    empresaId,
    baixaAutomatica: permite === true,
    modoEstoque: permite ? 'AUTOMATICO' : 'MANUAL',
    origem: 'baixa_venda',
    exigirEmpresa: true
  };
}

describe('Sprint 20 — fechamento integrado e modo de baixa', () => {
  it('A) baixa automática debita uma vez: fiscal 6 e não fiscal 9', async () => {
    const ambiente = await preparar('AUTOMATICO');
    try {
      const antes = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaId);
      const cfgAntes = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(ambiente.db, ambiente.empresaId);
      const { out, pagamentos } = await distribuirAutorizada(ambiente);
      const linha = out.resultado_oficial.itens[0];
      const rateio = calcularValorFiscalLiquido({
        valorFiscalBruto: 40,
        valorNaoFiscalBruto: 10,
        desconto: 5,
        acrescimo: 0
      });

      assert.equal(out.distribuicao_aplicada, true);
      assert.equal(out.saldo_aplicado, false);
      assert.equal(linha.quantidade_fiscal, 4);
      assert.equal(linha.quantidade_nao_fiscal, 1);
      assert.equal(linha.valor_fiscal, rateio.valorFiscalLiquido);
      assert.equal(linha.valor_nao_fiscal, rateio.valorNaoFiscalLiquido);
      assert.equal(linha.valor_fiscal, 36);
      assert.equal(linha.valor_nao_fiscal, 9);
      assert.equal(out.resultado_oficial.totalVenda, 45);
      assert.equal(out.resultado_oficial.totalVendaBruto, 50);
      assert.equal(out.total_comercial, 50);
      assert.equal(out.desconto_enviado_ao_distribuidor, 5);
      assert.equal(out.acrescimo_enviado_ao_distribuidor, 0);
      assert.equal(out.margem_nao_convertida_em_desconto, true);
      assert.deepEqual(pagamentos.map((p) => p.valor), [20, 20, 10]);

      const opcoes = await opcoesComoCriarVenda(ambiente.db, ambiente.empresaId);
      assert.equal(opcoes.baixaAutomatica, true);
      assert.equal(opcoes.modoEstoque, 'AUTOMATICO');
      await reduzirAsync(
        1,
        ambiente.produtoId,
        linha.quantidade_fiscal,
        linha.quantidade_nao_fiscal,
        opcoes
      );

      const depois = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaId);
      assert.deepEqual(antes, { saldo_fiscal: 10, saldo_nao_fiscal: 10 });
      assert.deepEqual(depois, { saldo_fiscal: 6, saldo_nao_fiscal: 9 });

      const ficha = await consumirFichaTecnicaDaVenda({
        vendaId: ambiente.vendaId,
        empresaId: ambiente.empresaId,
        itens: [{ produto_id: ambiente.produtoId, quantidade: linha.quantidade }],
        db: ambiente.db
      });
      assert.equal(ficha.consumido, true);
      const insumo = await saldoEmpresa(ambiente.db, ambiente.insumoId, ambiente.empresaId);
      assert.equal(insumo.saldo_fiscal, 5);
      const repetida = await consumirFichaTecnicaDaVenda({
        vendaId: ambiente.vendaId,
        empresaId: ambiente.empresaId,
        itens: [{ produto_id: ambiente.produtoId, quantidade: linha.quantidade }],
        db: ambiente.db
      });
      assert.equal(repetida.ja_consumido, true);
      const insumoDepois = await saldoEmpresa(ambiente.db, ambiente.insumoId, ambiente.empresaId);
      const produtoDepois = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaId);
      assert.equal(insumoDepois.saldo_fiscal, 5);
      assert.deepEqual(produtoDepois, { saldo_fiscal: 6, saldo_nao_fiscal: 9 });

      const cfgDepois = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(ambiente.db, ambiente.empresaId);
      assert.equal(cfgDepois.modo, 'AUTOMATICO');
      assert.equal(cfgDepois.modo, cfgAntes.modo);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('B) baixa manual não consome estoque no fechamento', async () => {
    const ambiente = await preparar('MANUAL');
    try {
      const { out } = await distribuirAutorizada(ambiente);
      const linha = out.resultado_oficial.itens[0];
      assert.equal(out.distribuicao_aplicada, true);
      assert.equal(out.saldo_aplicado, false);
      assert.equal(linha.quantidade_fiscal, 4);
      assert.equal(linha.quantidade_nao_fiscal, 1);
      assert.equal(linha.valor_fiscal, 36);
      assert.equal(linha.valor_nao_fiscal, 9);

      const opcoes = await opcoesComoCriarVenda(ambiente.db, ambiente.empresaId);
      assert.equal(opcoes.baixaAutomatica, false);
      assert.equal(opcoes.modoEstoque, 'MANUAL');
      await reduzirAsync(
        1,
        ambiente.produtoId,
        linha.quantidade_fiscal,
        linha.quantidade_nao_fiscal,
        opcoes
      );
      const produto = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaId);
      assert.deepEqual(produto, { saldo_fiscal: 10, saldo_nao_fiscal: 10 });

      const ficha = await consumirFichaTecnicaDaVenda({
        vendaId: ambiente.vendaId,
        empresaId: ambiente.empresaId,
        itens: [{ produto_id: ambiente.produtoId, quantidade: 5 }],
        db: ambiente.db
      });
      assert.equal(ficha.consumido, false);
      assert.equal(ficha.modo_estoque, 'MANUAL');
      const insumo = await saldoEmpresa(ambiente.db, ambiente.insumoId, ambiente.empresaId);
      assert.equal(insumo.saldo_fiscal, 10);
      assert.equal(insumo.saldo_nao_fiscal, 0);

      const cfg = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(ambiente.db, ambiente.empresaId);
      assert.equal(cfg.modo, 'MANUAL');
      assert.equal(cfg.permite_baixa_automatica, false);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('C) sem autorização a baixa segue o Motor legado e a configuração permanece', async () => {
    const ambiente = await preparar('AUTOMATICO');
    try {
      const legado = motorLegado(ambiente.produtoId);
      const out = await encaminharPropostaValidadaAoDistribuidorOficial({
        env: {},
        autorizacao: { ativa: false },
        validacao: {
          composicao_validada_em_homologacao: true,
          itens_composicao: [{ produto_id: ambiente.produtoId, quantidade: 4, subtotal: 40 }]
        },
        itensVendidos: [{
          produto_id: ambiente.produtoId,
          quantidade: 5,
          preco_unitario: 10,
          subtotal: 50,
          unidade: 'UN'
        }],
        pagamentos: PAGAMENTOS.map((p) => ({ ...p })),
        totalComercial: 50,
        desconto: 5,
        acrescimo: 0,
        empresaId: ambiente.empresaId,
        saldosPorProduto: {
          [ambiente.produtoId]: { saldoFiscal: 10, saldoNaoFiscal: 10 }
        },
        aplicarSaldo: false,
        db: ambiente.db
      });
      assert.equal(out.distribuicao_aplicada, false);
      assert.equal(out.codigo, 'AUTORIZACAO_AUSENTE');
      let resultadoParaFechamento = legado;
      if (out.distribuicao_aplicada === true && out.resultado_oficial && out.resultado_oficial.sucesso === true) {
        resultadoParaFechamento = out.resultado_oficial;
      }
      const linha = resultadoParaFechamento.itens[0];
      assert.equal(linha.quantidade_fiscal, 5);
      assert.equal(linha.quantidade_nao_fiscal, 0);
      assert.equal(resultadoParaFechamento.totalVenda, 45);

      const opcoes = await opcoesComoCriarVenda(ambiente.db, ambiente.empresaId);
      await reduzirAsync(
        1,
        ambiente.produtoId,
        linha.quantidade_fiscal,
        linha.quantidade_nao_fiscal,
        opcoes
      );
      const produto = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaId);
      assert.deepEqual(produto, { saldo_fiscal: 5, saldo_nao_fiscal: 10 });
      const cfg = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(ambiente.db, ambiente.empresaId);
      assert.equal(cfg.modo, 'AUTOMATICO');
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('C) falha da ponte mantém o resultado legado na baixa automática', async () => {
    const ambiente = await preparar('AUTOMATICO');
    try {
      const legado = motorLegado(ambiente.produtoId);
      const out = await encaminharPropostaValidadaAoDistribuidorOficial({
        env: {},
        autorizacao: obterAutorizacaoDistribuicaoOficialInterna({}, { ativa: true }),
        validacao: {
          composicao_validada_em_homologacao: true,
          itens_composicao: [{ produto_id: ambiente.produtoId, quantidade: 4, subtotal: 40 }]
        },
        itensVendidos: [{
          produto_id: ambiente.produtoId,
          quantidade: 5,
          preco_unitario: 10,
          subtotal: 50,
          unidade: 'UN'
        }],
        pagamentos: PAGAMENTOS.map((p) => ({ ...p })),
        totalComercial: 50,
        desconto: 5,
        acrescimo: 0,
        empresaId: ambiente.empresaId,
        saldosPorProduto: {
          [ambiente.produtoId]: { saldoFiscal: 10, saldoNaoFiscal: 10 }
        },
        aplicarSaldo: false,
        db: ambiente.db,
        deps: {
          distribuir() {
            return { sucesso: false, erro: { mensagem: 'falha isolada' } };
          }
        }
      });
      assert.equal(out.distribuicao_aplicada, false);
      let resultadoParaFechamento = legado;
      if (out.distribuicao_aplicada === true && out.resultado_oficial && out.resultado_oficial.sucesso === true) {
        resultadoParaFechamento = out.resultado_oficial;
      }
      assert.equal(resultadoParaFechamento, legado);
      const linha = resultadoParaFechamento.itens[0];
      await reduzirAsync(
        1,
        ambiente.produtoId,
        linha.quantidade_fiscal,
        linha.quantidade_nao_fiscal,
        await opcoesComoCriarVenda(ambiente.db, ambiente.empresaId)
      );
      const produto = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaId);
      assert.deepEqual(produto, { saldo_fiscal: 5, saldo_nao_fiscal: 10 });
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('C/D) a ponte não força baixa nem altera a configuração do operador', () => {
    const pagamento = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    const inicioPonte = pagamento.indexOf('encaminharPropostaValidadaAoDistribuidorOficial({');
    const trechoPonte = pagamento.slice(inicioPonte, inicioPonte + 900);
    assert.ok(trechoPonte.includes('aplicarSaldo: false'));
    assert.equal(trechoPonte.includes('aplicarSaldo: true'), false);
    assert.ok(trechoPonte.includes('desconto: Number(desconto || 0)'));
    assert.ok(trechoPonte.includes('acrescimo: Number(acrescimo || 0)'));

    const inicioInserir = pagamento.indexOf('async function inserirItensDaVenda');
    const fimInserir = pagamento.indexOf('async function consumirPedidoNaVenda');
    const inserir = pagamento.slice(inicioInserir, fimInserir);
    assert.equal(inserir.split('reduzirEstoqueDistribuido(').length - 1, 1);

    const inicioBaixa = pagamento.indexOf('function reduzirEstoqueDistribuido');
    const baixa = pagamento.slice(inicioBaixa, inicioBaixa + 700);
    assert.ok(baixa.includes("opcoes.baixaAutomatica === false || opcoes.modoEstoque === 'MANUAL'"));

    const inicioFicha = pagamento.indexOf('async function aposBaixaItensDaVenda');
    const ficha = pagamento.slice(inicioFicha, inicioFicha + 500);
    assert.ok(ficha.includes("opcoesBaixaEstoque.baixaAutomatica === false || opcoesBaixaEstoque.modoEstoque === 'MANUAL'"));

    const adaptador = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService.js'),
      'utf8'
    );
    assert.equal(adaptador.includes('salvarModoEstoqueEmpresa'), false);
    assert.equal(adaptador.includes('EmpresaModoEstoqueService'), false);
  });
});
