/**
 * PDV-MULTIEMPRESA-08 — Motor F×NF com bucket exclusivo (Opção A).
 * Isolamento: sem DB oficial / SEFAZ.
 * Executar: node --test tests/pdv/pdv-multiempresa-08-motor-bucket-exclusivo.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  distribuirQuantidadeVenda,
  distribuirItemVenda,
  distribuirItensVendaComValorFiscalEfetivo
} = require('../../backend/services/distribuidorEstoqueVenda');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const { avaliarSelecaoEmpresaPdv, CODIGOS_BLOQUEIO } = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

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
      resolve({ lastID: this.lastID });
    });
  });
}
function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

describe('PDV-MULTIEMPRESA-08 Motor F×NF bucket exclusivo', { concurrency: false }, () => {
  it('1) fiscal com saldo fiscal suficiente', () => {
    const r = distribuirQuantidadeVenda(4, 10, 0, true);
    assert.equal(r.sucesso, true);
    assert.equal(r.quantidadeFiscal, 4);
    assert.equal(r.quantidadeNaoFiscal, 0);
    assert.equal(r.bucketExclusivo, 'FISCAL');
  });

  it('2) fiscal com apenas saldo não fiscal → bloqueio', () => {
    const r = distribuirQuantidadeVenda(4, 0, 10, true);
    assert.equal(r.sucesso, false);
    assert.equal(r.bucketExclusivo, 'FISCAL');
    assert.match(String(r.mensagem), /fiscal insuficiente/i);
  });

  it('3) não fiscal com saldo não fiscal suficiente', () => {
    const r = distribuirQuantidadeVenda(3, 0, 8, false);
    assert.equal(r.sucesso, true);
    assert.equal(r.quantidadeFiscal, 0);
    assert.equal(r.quantidadeNaoFiscal, 3);
    assert.equal(r.bucketExclusivo, 'NAO_FISCAL');
  });

  it('4) não fiscal com apenas saldo fiscal → bloqueio', () => {
    const r = distribuirQuantidadeVenda(3, 8, 0, false);
    assert.equal(r.sucesso, false);
    assert.equal(r.bucketExclusivo, 'NAO_FISCAL');
  });

  it('5) quantidade superior ao bucket permitido', () => {
    const r = distribuirQuantidadeVenda(5, 2, 100, true);
    assert.equal(r.sucesso, false);
    assert.equal(r.disponivelBucket, 2);
  });

  it('6) ambos buckets; insuficiência no exigido (não usa total)', () => {
    const r = distribuirQuantidadeVenda(5, 3, 3, true);
    assert.equal(r.sucesso, false);
    assert.equal(r.estoqueTotal, 6);
    assert.equal(r.disponivelBucket, 3);
  });

  it('7) falha de validação sem distribuição parcial incompatível', () => {
    const item = { produto_id: 1, quantidade: 5, preco_unitario: 10 };
    const r = distribuirItemVenda(item, 2, 10, true);
    assert.equal(r.sucesso, false);
    assert.equal(r.quantidadeFiscal, undefined);

    const pipe = distribuirItensVendaComValorFiscalEfetivo(
      [{ item, saldoFiscal: 2, saldoNaoFiscal: 10 }],
      true,
      { midpAtivo: false, pagamentos: [] }
    );
    assert.equal(pipe.sucesso, false);
  });

  it('8) pipeline com buckets suficientes: faixa colapsa (sem cruzamento MIDP)', () => {
    const item = { produto_id: 1, quantidade: 4, preco_unitario: 10, subtotal: 40 };
    const out = distribuirItensVendaComValorFiscalEfetivo(
      [{ item, saldoFiscal: 10, saldoNaoFiscal: 10 }],
      true,
      {
        midpAtivo: true,
        pagamentos: [
          { forma_pagamento: 'pix', valor: 20 },
          { forma_pagamento: 'dinheiro', valor: 20 }
        ]
      }
    );
    assert.equal(out.sucesso, true);
    assert.equal(out.itens[0].quantidade_fiscal, 4);
    assert.equal(out.itens[0].quantidade_nao_fiscal, 0);
    assert.equal(out.valorFiscalMinimo, out.valorFiscalMaximo);
  });

  it('9) cenário clássico MIDP 105/55/55 fiscal → bloqueio (não divide buckets)', () => {
    const item = { produto_id: 1, quantidade: 105, preco_unitario: 10, subtotal: 1050 };
    const out = distribuirItensVendaComValorFiscalEfetivo(
      [{ item, saldoFiscal: 55, saldoNaoFiscal: 55 }],
      true,
      {
        midpAtivo: true,
        pagamentos: [
          { forma_pagamento: 'pix', valor: 500 },
          { forma_pagamento: 'dinheiro', valor: 550 }
        ]
      }
    );
    assert.equal(out.sucesso, false);
  });

  it('10) ficha + seletor: contrato total F+NF dos insumos preservado', async () => {
    const db = await openDb();
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaEstoqueEmpresaAsync(db);
    await run(db, `
      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, ativo INTEGER DEFAULT 1,
        unidade TEXT DEFAULT 'UN', tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
        saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0,
        reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0,
        controla_estoque INTEGER DEFAULT 1, utiliza_ficha_tecnica INTEGER, updated_at DATETIME
      )
    `);
    await garantirColunaTipoOperacionalAsync(db);
    await garantirSchemaFichaTecnicaAsync(db);
    await garantirSchemaProdutoConversaoAsync(db);
    const matriz = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz M08' },
      { db }
    );
    await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B M08' },
      { db }
    );
    const acabado = await run(
      db,
      `INSERT INTO produtos (nome, tipo_operacional, controla_estoque, utiliza_ficha_tecnica)
       VALUES ('Pastel','COMERCIAL',1,1)`
    );
    const insumo = await run(
      db,
      `INSERT INTO produtos (nome, tipo_operacional, controla_estoque) VALUES ('Massa','INSUMO',1)`
    );
    await FichaTecnicaService.salvar(acabado.lastID, {
      ativo: 1,
      itens: [{ insumo_id: insumo.lastID, quantidade: 1, unidade: 'UN' }]
    }, { db });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: insumo.lastID,
      empresaId: matriz.id,
      saldo_fiscal: 0,
      saldo_nao_fiscal: 5,
      estoque_atual: 5
    }, { db });

    const out = await avaliarSelecaoEmpresaPdv({
      body: {
        itens: [{ produto_id: acabado.lastID, quantidade: 2 }],
        emitir_fiscal: true,
        origem: 'PDV'
      },
      itens: [{ produto_id: acabado.lastID, quantidade: 2 }],
      usuarioId: 1
    }, { db, usarAutorizacaoUsuario: false, verificarFiscalValido: async () => true });

    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio));
    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.equal(out.tipoSaldo, TipoSaldo.FISCAL);
    await closeDb(db);
  });

  it('seletor e motor bloqueiam o mesmo caso cruzado', async () => {
    const db = await openDb();
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaEstoqueEmpresaAsync(db);
    await run(db, `
      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, ativo INTEGER DEFAULT 1,
        unidade TEXT DEFAULT 'UN', tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
        saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0,
        reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0,
        controla_estoque INTEGER DEFAULT 1, utiliza_ficha_tecnica INTEGER, updated_at DATETIME
      )
    `);
    await garantirColunaTipoOperacionalAsync(db);
    await garantirSchemaFichaTecnicaAsync(db);
    await garantirSchemaProdutoConversaoAsync(db);
    const matriz = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz Align' },
      { db }
    );
    await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial Align' },
      { db }
    );
    const prod = await run(
      db,
      `INSERT INTO produtos (nome, tipo_operacional, controla_estoque) VALUES ('SKU','COMERCIAL',1)`
    );
    await EstoqueEmpresaService.criarRegistro({
      produtoId: prod.lastID,
      empresaId: matriz.id,
      saldo_fiscal: 0,
      saldo_nao_fiscal: 10,
      estoque_atual: 10
    }, { db });

    const motor = distribuirQuantidadeVenda(2, 0, 10, true);
    assert.equal(motor.sucesso, false);

    const sel = await avaliarSelecaoEmpresaPdv({
      body: {
        itens: [{ produto_id: prod.lastID, quantidade: 2 }],
        emitir_fiscal: true,
        origem: 'PDV'
      },
      itens: [{ produto_id: prod.lastID, quantidade: 2 }],
      usuarioId: 1
    }, { db, usarAutorizacaoUsuario: false, verificarFiscalValido: async () => true });
    assert.ok(sel.bloqueio);
    assert.equal(sel.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });
});
