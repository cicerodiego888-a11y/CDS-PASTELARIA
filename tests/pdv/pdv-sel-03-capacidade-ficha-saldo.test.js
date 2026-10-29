/**
 * PDV-SEL-03 — Diagnóstico/correção: capacidade de ficha alinhada ao consumo real.
 * Isolamento: sqlite :memory: (sem CDS_ALLOW_OFFICIAL_DB).
 * Executar: node --test tests/pdv/pdv-sel-03-capacidade-ficha-saldo.test.js
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
const {
  avaliarCapacidadeCarrinho,
  CODIGOS_BLOQUEIO,
  lerDisponivelFichaInsumo
} = require('../../backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa');
const {
  avaliarSelecaoEmpresaPdv
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
      resolve({ lastID: this.lastID, changes: this.changes });
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
      utiliza_conversao INTEGER DEFAULT 0,
      unidade_estoque TEXT,
      updated_at DATETIME
    )
  `);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);

  const matriz = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz SEL03' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B SEL03' },
    { db }
  );
  const filialC = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C SEL03' },
    { db }
  );
  return { db, matriz, filialB, filialC };
}

async function criarProduto(db, nome, tipo, unidade = 'UN', opts = {}) {
  const ins = await run(
    db,
    `INSERT INTO produtos (
       nome, tipo_operacional, unidade, controla_estoque, utiliza_ficha_tecnica,
       utiliza_conversao, unidade_estoque, saldo_fiscal, estoque_atual
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      nome,
      tipo,
      unidade,
      opts.controla_estoque != null ? opts.controla_estoque : 1,
      opts.utiliza_ficha_tecnica != null ? opts.utiliza_ficha_tecnica : null,
      opts.utiliza_conversao != null ? opts.utiliza_conversao : 0,
      opts.unidade_estoque != null ? opts.unidade_estoque : null
    ]
  );
  return ins.lastID;
}

async function setEstoque(db, produtoId, empresaId, fiscal, naoFiscal = 0) {
  const existe = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?`,
      [produtoId, empresaId],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
  if (existe) {
    await run(
      db,
      `UPDATE estoque_empresa
       SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?,
           reservado_fiscal = 0, reservado_nao_fiscal = 0
       WHERE produto_id = ? AND empresa_id = ?`,
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

async function salvarFicha(db, comercialId, itens) {
  await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [comercialId]);
  return FichaTecnicaService.salvar(comercialId, { ativo: 1, itens }, { db });
}

const depsBase = (db) => ({
  db,
  usarAutorizacaoUsuario: false,
  verificarFiscalValido: async () => true
});

describe('PDV-SEL-03 capacidade ficha × saldo', { concurrency: false }, () => {
  it('helper lerDisponivelFichaInsumo soma fiscal + não fiscal', () => {
    assert.equal(lerDisponivelFichaInsumo({
      controla_estoque: 1,
      disponivel_fiscal: 1,
      disponivel_nao_fiscal: 3
    }), 4);
    assert.equal(lerDisponivelFichaInsumo(null), null);
  });

  it('matriz capaz: ficha com estoque só não fiscal (emitir_fiscal/tipoSaldo FISCAL)', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel 747', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa 752', 'INSUMO', 'UN');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 4, unidade: 'UN' }]);

    // Sintoma do campo: necessário 4, disponível fiscal 0, mas há 4 no não fiscal.
    await setEstoque(db, massa, matriz.id, 0, 4);
    await setEstoque(db, massa, filialB.id, 0, 0);
    await setEstoque(db, massa, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    const avM = out.porEmpresa.find((e) => e.empresaId === matriz.id);
    assert.equal(avM.elegivel, true);
    assert.equal(avM.atendeIntegralmente, true, JSON.stringify(avM.gargalos));
    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.equal(out.bloqueio, null);
    await closeDb(db);
  });

  it('filial capaz quando matriz não tem insumo suficiente', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO', 'UN');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 2, unidade: 'UN' }]);

    await setEstoque(db, massa, matriz.id, 0, 1);
    await setEstoque(db, massa, filialB.id, 0, 10);
    await setEstoque(db, massa, filialC.id, 0, 10);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, filialB.id);
    const avM = out.porEmpresa.find((e) => e.empresaId === matriz.id);
    assert.equal(avM.atendeIntegralmente, false);
    assert.ok(avM.gargalos.some((g) => g.codigoMotivo === 'INSUMO_INSUFICIENTE' && g.insumoId === massa));
    await closeDb(db);
  });

  it('insumo realmente insuficiente em todas as empresas → bloqueio claro', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO', 'UN');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 4, unidade: 'UN' }]);

    await setEstoque(db, massa, matriz.id, 1, 1);
    await setEstoque(db, massa, filialB.id, 0, 2);
    await setEstoque(db, massa, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    for (const emp of out.porEmpresa) {
      assert.equal(emp.atendeIntegralmente, false);
      const g = emp.gargalos.find((x) => x.insumoId === massa);
      assert.ok(g, `empresa ${emp.empresaId} deveria ter gargalo`);
      assert.equal(g.codigoMotivo, 'INSUMO_INSUFICIENTE');
      assert.equal(g.necessario, 4);
      assert.ok(g.disponivel < 4);
      assert.equal(g.baseConsulta, 'TOTAL_FICHA');
    }
    await closeDb(db);
  });

  it('estoques de empresas diferentes não são somados', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO', 'UN');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 5, unidade: 'UN' }]);

    await setEstoque(db, massa, matriz.id, 3, 0);
    await setEstoque(db, massa, filialB.id, 3, 0);
    await setEstoque(db, massa, filialC.id, 3, 0);
    // Agregado 9 >= 5, mas nenhuma empresa sozinha atende.

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA'
    }, depsBase(db));

    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('produto sem ficha: tipoSaldo FISCAL não usa saldo não fiscal', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel NF', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 0 });
    await setEstoque(db, pastel, matriz.id, 0, 10);
    await setEstoque(db, pastel, filialB.id, 0, 0);
    await setEstoque(db, pastel, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada, null);
    const avM = out.porEmpresa.find((e) => e.empresaId === matriz.id);
    assert.ok(avM.gargalos.some((g) => (
      (g.codigoMotivo === 'ESTOQUE_INSUFICIENTE_FISCAL' || g.codigoMotivo === 'ESTOQUE_INSUFICIENTE')
      && g.tipoSaldo === TipoSaldo.FISCAL
    )));
    await closeDb(db);
  });

  it('produto sem ficha: tipoSaldo NAO_FISCAL usa saldo não fiscal', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel NF2', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 0 });
    await setEstoque(db, pastel, matriz.id, 0, 10);
    await setEstoque(db, pastel, filialB.id, 0, 0);
    await setEstoque(db, pastel, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.NAO_FISCAL
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('falha de consulta não vira saldo zero silencioso', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO', 'UN');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 1, unidade: 'UN' }]);
    await setEstoque(db, massa, matriz.id, 10, 0);
    await setEstoque(db, massa, filialB.id, 10, 0);
    await setEstoque(db, massa, filialC.id, 10, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA'
    }, {
      ...depsBase(db),
      consultarDisponibilidade: async () => {
        const err = new Error('falha simulada de consulta');
        err.code = 'ERRO_CONSULTA_DISPONIBILIDADE';
        throw err;
      }
    });

    assert.equal(out.selecionada, null);
    for (const emp of out.porEmpresa.filter((e) => e.elegivel)) {
      assert.equal(emp.atendeIntegralmente, false);
      const g = emp.gargalos[0];
      assert.equal(g.codigoMotivo, 'ERRO_CONSULTA_DISPONIBILIDADE');
      assert.equal(g.disponivel, null);
    }
    await closeDb(db);
  });

  it('seleção PDV revalida: emitir_fiscal true + ficha com saldo não fiscal seleciona matriz', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO', 'UN');
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 4, unidade: 'UN' }]);
    await setEstoque(db, massa, matriz.id, 2, 2);
    await setEstoque(db, massa, filialB.id, 0, 0);
    await setEstoque(db, massa, filialC.id, 0, 0);

    const r1 = await avaliarSelecaoEmpresaPdv({
      body: { emitir_fiscal: true, itens: [{ produto_id: pastel, quantidade: 1 }] },
      itens: [{ produto_id: pastel, quantidade: 1 }],
      usuarioId: 1
    }, depsBase(db));
    assert.equal(r1.bloqueio, null);
    assert.equal(r1.selecionada.empresaId, matriz.id);

    // Após “consumo” residual insuficiente → bloqueio na revalidação
    await setEstoque(db, massa, matriz.id, 0, 1);
    const r2 = await avaliarSelecaoEmpresaPdv({
      body: { emitir_fiscal: true, itens: [{ produto_id: pastel, quantidade: 1 }] },
      itens: [{ produto_id: pastel, quantidade: 1 }],
      usuarioId: 1
    }, depsBase(db));
    assert.ok(r2.bloqueio);
    assert.equal(r2.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    assert.match(r2.bloqueio.mensagem, /insumo/);
    await closeDb(db);
  });

  it('insumo suficiente após conversão UN→KG via MUC', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const farinha = await criarProduto(db, 'Farinha', 'INSUMO', 'KG', {
      utiliza_conversao: 0,
      unidade_estoque: 'KG'
    });
    // Ficha em G; estoque em KG. 400 g = 0.4 kg por unidade → 1 pastel precisa 0.4 kg.
    await salvarFicha(db, pastel, [{ insumo_id: farinha, quantidade: 400, unidade: 'G' }]);
    await setEstoque(db, farinha, matriz.id, 0, 1); // 1 kg não fiscal
    await setEstoque(db, farinha, filialB.id, 0, 0);
    await setEstoque(db, farinha, filialC.id, 0, 0);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, depsBase(db));

    assert.equal(out.bloqueio, null, JSON.stringify(out.porEmpresa));
    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });
});
