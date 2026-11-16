/**
 * CDS-PDV-ESTOQUE-PRODUTOS-COMERCIAIS-FISCAIS-01
 * Comercial sem saldo próprio; insumos da ficha continuam validando/baixando.
 * Banco temporário (:memory: + DB_DIR). Sem banco oficial / sem NFC-e real.
 *
 * Executar: node --test tests/pdv/cds-pdv-estoque-produtos-comerciais-fiscais-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-comerciais-fiscais-01-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  ehProdutoComercialSemSaldoProprio,
  produtoExigeValidacaoSaldoProprio,
  saldosParaDistribuicaoVenda
} = require('../../backend/services/estoque/produtoControlaEstoque');
const {
  avaliarCapacidadeCarrinho,
  CODIGOS_BLOQUEIO
} = require('../../backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const { reduzirEstoqueDistribuido } = require('../../backend/services/vendas/VendaPagamentoService');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL_B = '11222333000262';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
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
      controlar_validade INTEGER DEFAULT 0,
      utiliza_ficha_tecnica INTEGER,
      utiliza_conversao INTEGER DEFAULT 0,
      unidade_estoque TEXT,
      updated_at DATETIME
    )
  `);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);

  const matriz = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz CDS-01' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B CDS-01' },
    { db }
  );
  return { db, matriz, filialB };
}

async function criarProduto(db, nome, tipo, opts = {}) {
  const ins = await run(
    db,
    `INSERT INTO produtos (
       nome, tipo_operacional, unidade, controla_estoque, utiliza_ficha_tecnica,
       saldo_fiscal, estoque_atual
     ) VALUES (?, ?, 'UN', ?, ?, 0, 0)`,
    [
      nome,
      tipo,
      opts.controla_estoque != null ? opts.controla_estoque : 1,
      opts.utiliza_ficha_tecnica != null ? opts.utiliza_ficha_tecnica : null
    ]
  );
  return ins.lastID;
}

async function setEstoque(db, produtoId, empresaId, fiscal, naoFiscal = 0) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: fiscal,
    saldo_nao_fiscal: naoFiscal,
    estoque_atual: fiscal + naoFiscal
  }, { db });
}

async function salvarFicha(db, comercialId, itens) {
  await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [comercialId]);
  return FichaTecnicaService.salvar(comercialId, { ativo: 1, itens }, { db });
}

function depsBase(db) {
  return {
    db,
    usarAutorizacaoUsuario: false,
    verificarFiscalValido: async () => true
  };
}

describe('CDS-PDV-ESTOQUE-PRODUTOS-COMERCIAIS-FISCAIS-01', () => {
  it('predicado: comercial sem saldo próprio; insumo exige', () => {
    assert.equal(ehProdutoComercialSemSaldoProprio({ tipo_operacional: 'COMERCIAL' }), true);
    assert.equal(ehProdutoComercialSemSaldoProprio({}), true);
    assert.equal(ehProdutoComercialSemSaldoProprio({ tipo_operacional: 'INSUMO' }), false);
    assert.equal(produtoExigeValidacaoSaldoProprio({
      tipo_operacional: 'COMERCIAL',
      controla_estoque: 1
    }), false);
    assert.equal(produtoExigeValidacaoSaldoProprio({
      tipo_operacional: 'INSUMO',
      controla_estoque: 1
    }), true);
    const virt = saldosParaDistribuicaoVenda(
      { tipo_operacional: 'COMERCIAL', controla_estoque: 1 },
      3,
      0,
      0
    );
    assert.deepEqual(virt, { saldoFiscal: 3, saldoNaoFiscal: 3 });
  });

  it('comercial sem saldo próprio (zero): capacidade permite venda', async () => {
    const { db, matriz, filialB } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', { controla_estoque: 1 });
    await setEstoque(db, pastel, matriz.id, 0, 0);
    await setEstoque(db, pastel, filialB.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 2 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.ok(out.selecionada, 'deve selecionar empresa mesmo com saldo próprio zero');
    assert.equal(out.bloqueio, null);
    const av = out.porEmpresa.find((e) => e.empresaId === out.selecionada.empresaId);
    assert.equal(av.atendeIntegralmente, true);
    assert.equal(av.gargalos.length, 0);
    await closeDb(db);
  });

  it('comercial sem ficha e sem estoque próprio: não gera ESTOQUE_INSUFICIENTE', async () => {
    const { db, matriz, filialB } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel Sem Ficha', 'COMERCIAL', {
      controla_estoque: 1,
      utiliza_ficha_tecnica: 0
    });
    await setEstoque(db, pastel, matriz.id, 0, 0);
    await setEstoque(db, pastel, filialB.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.ok(out.selecionada);
    for (const emp of out.porEmpresa.filter((e) => e.elegivel)) {
      assert.ok(!emp.gargalos.some((g) => /ESTOQUE_INSUFICIENTE/i.test(g.codigoMotivo)));
    }
    await closeDb(db);
  });

  it('composição com insumos suficientes: venda permitida', async () => {
    const { db, matriz, filialB } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel Ficha', 'COMERCIAL', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 1, unidade: 'UN' }]);
    await setEstoque(db, massa, matriz.id, 10, 0);
    await setEstoque(db, massa, filialB.id, 0, 0);
    await setEstoque(db, pastel, matriz.id, 0, 0);
    await setEstoque(db, pastel, filialB.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 3 }],
      modoOperacional: 'MULTIEMPRESA'
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('composição com insumo insuficiente: bloqueio legítimo', async () => {
    const { db, matriz, filialB } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel Ficha2', 'COMERCIAL', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa2', 'INSUMO');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 2, unidade: 'UN' }]);
    await setEstoque(db, massa, matriz.id, 1, 0);
    await setEstoque(db, massa, filialB.id, 1, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 2 }],
      modoOperacional: 'MULTIEMPRESA'
    }, depsBase(db));

    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    const g = out.porEmpresa.flatMap((e) => e.gargalos);
    assert.ok(g.some((x) => x.codigoMotivo === 'INSUMO_INSUFICIENTE'));
    await closeDb(db);
  });

  it('empresas diferentes: estoque de insumos isolado', async () => {
    const { db, matriz, filialB } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel Iso', 'COMERCIAL', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa Iso', 'INSUMO');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 1, unidade: 'UN' }]);
    await setEstoque(db, massa, matriz.id, 0, 0);
    await setEstoque(db, massa, filialB.id, 5, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 2 }],
      modoOperacional: 'MULTIEMPRESA'
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, filialB.id);
    const avM = out.porEmpresa.find((e) => e.empresaId === matriz.id);
    assert.equal(avM.atendeIntegralmente, false);
    await closeDb(db);
  });

  it('baixa: comercial não debita saldo próprio', async () => {
    const { db, matriz } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel Baixa', 'COMERCIAL', { controla_estoque: 1 });
    await setEstoque(db, pastel, matriz.id, 5, 0);

    await new Promise((resolve, reject) => {
      reduzirEstoqueDistribuido(
        1,
        pastel,
        2,
        0,
        (err) => (err ? reject(err) : resolve()),
        { db, empresaId: matriz.id, baixaAutomatica: true }
      );
    });

    const saldo = await get(
      db,
      `SELECT saldo_fiscal, saldo_nao_fiscal FROM estoque_empresa
       WHERE produto_id = ? AND empresa_id = ?`,
      [pastel, matriz.id]
    );
    assert.equal(Number(saldo.saldo_fiscal), 5);
    await closeDb(db);
  });

  it('baixa: insumo ainda passa pela baixa (não é tratado como comercial)', async () => {
    const { db, matriz } = await setupBase();
    const massa = await criarProduto(db, 'Massa Baixa', 'INSUMO', { controla_estoque: 1 });
    // Sem saldo no caminho da porta → falha prova que a baixa do próprio SKU foi tentada.
    await new Promise((resolve, reject) => {
      reduzirEstoqueDistribuido(
        2,
        massa,
        1,
        0,
        (err) => {
          if (err && (err.code === 'SALDO_INSUFICIENTE' || /insuficiente/i.test(String(err.message)))) {
            return resolve();
          }
          if (!err) return reject(new Error('insumo não deveria concluir baixa sem saldo'));
          reject(err);
        },
        { db, empresaId: matriz.id, baixaAutomatica: true }
      );
    });
    assert.equal(produtoExigeValidacaoSaldoProprio({
      tipo_operacional: 'INSUMO',
      controla_estoque: 1
    }), true);
    await closeDb(db);
  });
});

