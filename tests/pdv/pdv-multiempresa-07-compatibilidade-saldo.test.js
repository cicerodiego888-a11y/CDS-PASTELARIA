/**
 * PDV-MULTIEMPRESA-07 — Compatibilidade saldo × tipo da venda (auditoria).
 * Isolamento: sqlite :memory: — sem banco oficial / SEFAZ.
 * Executar: node --test tests/pdv/pdv-multiempresa-07-compatibilidade-saldo.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const { distribuirQuantidadeVenda } = require('../../backend/services/distribuidorEstoqueVenda');
const {
  avaliarSelecaoEmpresaPdv,
  resolverTipoSaldoParaCapacidade,
  CODIGOS_BLOQUEIO
} = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL_B = '11222333000262';
const CNPJ_FILIAL_C = '11222333000343';

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
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz M07' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B M07' },
    { db }
  );
  const filialC = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C M07' },
    { db }
  );
  return { db, matriz, filialB, filialC };
}

async function criarProduto(db, nome, tipo = 'COMERCIAL') {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, controla_estoque, saldo_fiscal, estoque_atual)
     VALUES (?, ?, 'UN', 1, 0, 0)`,
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

async function avaliar(db, itens, { emitir = true, vendaFiscal } = {}) {
  const body = {
    itens,
    emitir_fiscal: emitir,
    origem: 'PDV'
  };
  if (vendaFiscal !== undefined) body.venda_fiscal = vendaFiscal;
  return avaliarSelecaoEmpresaPdv({ body, itens, usuarioId: 1 }, deps(db));
}

function temGargalo(out, codigo) {
  for (const emp of (out.capacidade && out.capacidade.porEmpresa) || []) {
    for (const g of emp.gargalos || []) {
      if (g.codigoMotivo === codigo || g.codigoMotivoLegado === codigo) return true;
    }
  }
  return false;
}

describe('PDV-MULTIEMPRESA-07 compatibilidade saldo × tipo venda', { concurrency: false }, () => {
  it('origem autoritativa: venda_fiscal prevalece; emitir_fiscal é fallback', () => {
    assert.equal(resolverTipoSaldoParaCapacidade({ venda_fiscal: true, emitir_fiscal: false }).tipoSaldo, TipoSaldo.FISCAL);
    assert.equal(resolverTipoSaldoParaCapacidade({ venda_fiscal: false, emitir_fiscal: true }).tipoSaldo, TipoSaldo.NAO_FISCAL);
    assert.equal(resolverTipoSaldoParaCapacidade({ emitir_fiscal: true }).tipoSaldo, TipoSaldo.FISCAL);
    assert.equal(resolverTipoSaldoParaCapacidade({ emitir_fiscal: false }).tipoSaldo, TipoSaldo.NAO_FISCAL);
    assert.equal(resolverTipoSaldoParaCapacidade({}).indeterminado, true);
  });

  it('1) estoque exclusivamente fiscal + venda fiscal → aprova', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'SóFiscal');
    await setEstoque(db, prod, matriz.id, 5, 0);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await avaliar(db, [{ produto_id: prod, quantidade: 3 }], { emitir: true });
    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio));
    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.equal(out.tipoSaldo, TipoSaldo.FISCAL);
    await closeDb(db);
  });

  it('2) estoque exclusivamente fiscal + venda não fiscal → bloqueio', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'SóFiscalBloq');
    await setEstoque(db, prod, matriz.id, 10, 0);
    await setEstoque(db, prod, filialB.id, 10, 0);
    await setEstoque(db, prod, filialC.id, 10, 0);

    const out = await avaliar(db, [{ produto_id: prod, quantidade: 2 }], { emitir: false });
    assert.ok(out.bloqueio);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    assert.ok(temGargalo(out, 'ESTOQUE_INSUFICIENTE_NAO_FISCAL'));
    // M08: Motor F×NF alinhado — também bloqueia (bucket exclusivo).
    const motor = distribuirQuantidadeVenda(2, 10, 0, false);
    assert.equal(motor.sucesso, false);
    assert.equal(motor.bucketExclusivo, 'NAO_FISCAL');
    await closeDb(db);
  });

  it('3) estoque exclusivamente não fiscal + venda não fiscal → aprova', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'SóNF');
    await setEstoque(db, prod, matriz.id, 0, 5);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await avaliar(db, [{ produto_id: prod, quantidade: 3 }], { emitir: false });
    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio));
    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.equal(out.tipoSaldo, TipoSaldo.NAO_FISCAL);
    await closeDb(db);
  });

  it('4) estoque exclusivamente não fiscal + venda fiscal → bloqueio', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'SóNFBloq');
    await setEstoque(db, prod, matriz.id, 0, 10);
    await setEstoque(db, prod, filialB.id, 0, 10);
    await setEstoque(db, prod, filialC.id, 0, 10);

    const out = await avaliar(db, [{ produto_id: prod, quantidade: 2 }], { emitir: true });
    assert.ok(out.bloqueio);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    assert.ok(temGargalo(out, 'ESTOQUE_INSUFICIENTE_FISCAL'));
    const motor = distribuirQuantidadeVenda(2, 0, 10, true);
    assert.equal(motor.sucesso, false);
    assert.equal(motor.bucketExclusivo, 'FISCAL');
    await closeDb(db);
  });

  it('5) ambos saldos: capacidade exige só o bucket da operação (não o total)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Ambos');
    // F=3 NF=3 — total 6 >= 5, mas bucket fiscal sozinho < 5
    await setEstoque(db, prod, matriz.id, 3, 3);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const fiscal = await avaliar(db, [{ produto_id: prod, quantidade: 5 }], { emitir: true });
    assert.ok(fiscal.bloqueio);
    assert.ok(temGargalo(fiscal, 'ESTOQUE_INSUFICIENTE_FISCAL'));

    const okF = await avaliar(db, [{ produto_id: prod, quantidade: 3 }], { emitir: true });
    assert.equal(okF.bloqueio, null);
    assert.equal(okF.tipoSaldo, TipoSaldo.FISCAL);

    const okNf = await avaliar(db, [{ produto_id: prod, quantidade: 3 }], { emitir: false });
    assert.equal(okNf.bloqueio, null);
    assert.equal(okNf.tipoSaldo, TipoSaldo.NAO_FISCAL);

    // M08: Motor também exige bucket fiscal integral (não usa total 6).
    const motor = distribuirQuantidadeVenda(5, 3, 3, true);
    assert.equal(motor.sucesso, false);
    assert.equal(motor.bucketExclusivo, 'FISCAL');
    await closeDb(db);
  });

  it('6) quantidade > saldo do bucket exigido → bloqueio', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Excede');
    await setEstoque(db, prod, matriz.id, 2, 100);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await avaliar(db, [{ produto_id: prod, quantidade: 3 }], { emitir: true });
    assert.ok(out.bloqueio);
    assert.ok(temGargalo(out, 'ESTOQUE_INSUFICIENTE_FISCAL'));
    await closeDb(db);
  });

  it('7) carrinho misto com tipo_saldo explícito por item', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const f = await criarProduto(db, 'ItemF');
    const nf = await criarProduto(db, 'ItemNF');
    await setEstoque(db, f, matriz.id, 4, 0);
    await setEstoque(db, nf, matriz.id, 0, 4);
    await setEstoque(db, f, filialB.id, 0, 0);
    await setEstoque(db, nf, filialB.id, 0, 0);
    await setEstoque(db, f, filialC.id, 0, 0);
    await setEstoque(db, nf, filialC.id, 0, 0);

    const ok = await avaliar(db, [
      { produto_id: f, quantidade: 2, tipo_saldo: 'FISCAL' },
      { produto_id: nf, quantidade: 2, tipo_saldo: 'NAO_FISCAL' }
    ], { emitir: true });
    assert.equal(ok.bloqueio, null, JSON.stringify(ok.bloqueio));

    const falha = await avaliar(db, [
      { produto_id: f, quantidade: 2, tipo_saldo: 'NAO_FISCAL' },
      { produto_id: nf, quantidade: 2, tipo_saldo: 'FISCAL' }
    ], { emitir: true });
    assert.ok(falha.bloqueio);
    await closeDb(db);
  });

  it('8) ficha técnica: capacidade preserva total F+NF dos insumos (contrato vigente)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const acabado = await criarProduto(db, 'ComFicha', 'COMERCIAL');
    const insumo = await criarProduto(db, 'Insumo', 'INSUMO');
    await run(db, `UPDATE produtos SET utiliza_ficha_tecnica=1 WHERE id=?`, [acabado]);
    await FichaTecnicaService.salvar(acabado, {
      ativo: 1,
      itens: [{ insumo_id: insumo, quantidade: 1, unidade: 'UN' }]
    }, { db });
    // Só saldo não fiscal no insumo — ficha deve aceitar (total F+NF).
    await setEstoque(db, insumo, matriz.id, 0, 5);
    await setEstoque(db, acabado, matriz.id, 0, 0);
    await setEstoque(db, insumo, filialB.id, 0, 0);
    await setEstoque(db, acabado, filialB.id, 0, 0);
    await setEstoque(db, insumo, filialC.id, 0, 0);
    await setEstoque(db, acabado, filialC.id, 0, 0);

    const out = await avaliar(db, [{ produto_id: acabado, quantidade: 2 }], { emitir: true });
    assert.equal(out.bloqueio, null, JSON.stringify(out.bloqueio || out.capacidade));
    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('9) nenhuma soma entre CNPJs', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'NaoSoma');
    await setEstoque(db, prod, matriz.id, 2, 0);
    await setEstoque(db, prod, filialB.id, 2, 0);
    await setEstoque(db, prod, filialC.id, 2, 0);

    const out = await avaliar(db, [{ produto_id: prod, quantidade: 5 }], { emitir: true });
    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('10) revalidação na finalização: 2ª avaliação após baixa sintética', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'Reval');
    await setEstoque(db, prod, matriz.id, 1, 0);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const r1 = await avaliar(db, [{ produto_id: prod, quantidade: 1 }], { emitir: true });
    assert.equal(r1.selecionada.empresaId, matriz.id);

    await setEstoque(db, prod, matriz.id, 0, 0);
    const r2 = await avaliar(db, [{ produto_id: prod, quantidade: 1 }], { emitir: true });
    assert.ok(r2.bloqueio);
    assert.equal(r2.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('item_fiscal isolado não escolhe bucket', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const prod = await criarProduto(db, 'ItemFiscalFlag');
    await setEstoque(db, prod, matriz.id, 0, 5);
    await setEstoque(db, prod, filialB.id, 0, 0);
    await setEstoque(db, prod, filialC.id, 0, 0);

    const out = await avaliar(db, [
      { produto_id: prod, quantidade: 1, item_fiscal: 1 }
    ], { emitir: true });
    assert.ok(out.bloqueio);
    assert.ok(temGargalo(out, 'ESTOQUE_INSUFICIENTE_FISCAL'));
    await closeDb(db);
  });
});
