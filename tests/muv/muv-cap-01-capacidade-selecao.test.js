/**
 * MUV-CAP-01 — Capacidade por empresa + seleção pura (cenários 1–4 e 7).
 * Executar: node --test tests/muv/muv-cap-01-capacidade-selecao.test.js
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
  selecionarEmpresaCapacidade,
  CODIGOS_BLOQUEIO,
  hashCarrinho
} = require('../../backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa');
const {
  JUSTIFICATIVAS
} = require('../../backend/motores/muv/capacidade/selecionarEmpresaCapacidade');

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
      updated_at DATETIME
    )
  `);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);

  const matriz = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B' },
    { db }
  );
  const filialC = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C' },
    { db }
  );
  return { db, matriz, filialB, filialC };
}

async function criarProduto(db, nome, tipo, unidade = 'UN', opts = {}) {
  const ins = await run(
    db,
    `INSERT INTO produtos (
       nome, tipo_operacional, unidade, controla_estoque, utiliza_ficha_tecnica,
       saldo_fiscal, estoque_atual
     ) VALUES (?, ?, ?, ?, ?, 0, 0)`,
    [
      nome,
      tipo,
      unidade,
      opts.controla_estoque != null ? opts.controla_estoque : 1,
      opts.utiliza_ficha_tecnica != null ? opts.utiliza_ficha_tecnica : null
    ]
  );
  return ins.lastID;
}

async function estoque(db, produtoId, empresaId, saldoFiscal) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: 0,
    estoque_atual: saldoFiscal
  }, { db });
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

describe('MUV-CAP-01 seleção pura', () => {
  it('seleciona matriz quando matriz e filiais são capazes', () => {
    const r = selecionarEmpresaCapacidade({
      matrizId: 1,
      ordemAvaliacao: [1, 2, 3],
      porEmpresa: [
        { empresaId: 1, tipo: 'MATRIZ', elegivel: true, atendeIntegralmente: true },
        { empresaId: 2, tipo: 'FILIAL', elegivel: true, atendeIntegralmente: true },
        { empresaId: 3, tipo: 'FILIAL', elegivel: true, atendeIntegralmente: true }
      ]
    });
    assert.equal(r.selecionada.empresaId, 1);
    assert.equal(r.selecionada.justificativa, JUSTIFICATIVAS.MATRIZ_ATENDE);
    assert.equal(r.bloqueio, null);
  });

  it('seleciona filial por id ASC quando matriz não atende', () => {
    const r = selecionarEmpresaCapacidade({
      matrizId: 1,
      ordemAvaliacao: [1, 2, 3],
      porEmpresa: [
        { empresaId: 1, tipo: 'MATRIZ', elegivel: true, atendeIntegralmente: false },
        { empresaId: 3, tipo: 'FILIAL', elegivel: true, atendeIntegralmente: true },
        { empresaId: 2, tipo: 'FILIAL', elegivel: true, atendeIntegralmente: true }
      ]
    });
    assert.equal(r.selecionada.empresaId, 2);
    assert.equal(r.selecionada.justificativa, JUSTIFICATIVAS.FILIAL_ORDEM_ID);
  });

  it('bloqueia quando nenhuma atende', () => {
    const r = selecionarEmpresaCapacidade({
      matrizId: 1,
      ordemAvaliacao: [1, 2],
      porEmpresa: [
        { empresaId: 1, elegivel: true, atendeIntegralmente: false },
        { empresaId: 2, elegivel: true, atendeIntegralmente: false }
      ]
    });
    assert.equal(r.selecionada, null);
    assert.equal(r.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
  });
});

describe('MUV-CAP-01 capacidade (cenários 1–4 e 7)', () => {
  it('Cenário 1 — matriz suficiente seleciona matriz', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 0 });
    await estoque(db, pastel, matriz.id, 10);
    await estoque(db, pastel, filialB.id, 2);
    await estoque(db, pastel, filialC.id, 1);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA'
    }, depsBase(db));

    assert.equal(out.matrizId, matriz.id);
    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.equal(out.selecionada.justificativa, JUSTIFICATIVAS.MATRIZ_ATENDE);
    assert.equal(out.bloqueio, null);
    assert.equal(out.meta.aviso, 'CONSULTA_NAO_RESERVA');
    assert.ok(out.meta.hashCarrinho);

    const eeAntes = await new Promise((resolve, reject) => {
      db.get(
        'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
        [pastel, matriz.id],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });
    assert.equal(Number(eeAntes.saldo_fiscal), 10);
    await closeDb(db);
  });

  it('Cenário 2 — matriz incapaz e filial capaz seleciona filial', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 0 });
    await estoque(db, pastel, matriz.id, 0);
    await estoque(db, pastel, filialB.id, 5);
    await estoque(db, pastel, filialC.id, 5);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 2 }],
      modoOperacional: 'MULTIEMPRESA'
    }, depsBase(db));

    assert.equal(out.selecionada.empresaId, filialB.id);
    assert.equal(out.selecionada.justificativa, JUSTIFICATIVAS.FILIAL_ORDEM_ID);
    assert.ok(filialB.id < filialC.id);
    await closeDb(db);
  });

  it('Cenário 3 — estoque agregado suficiente, nenhuma empresa capaz → bloqueio', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 0 });
    await estoque(db, pastel, matriz.id, 2);
    await estoque(db, pastel, filialB.id, 2);
    await estoque(db, pastel, filialC.id, 2);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 5 }],
      modoOperacional: 'MULTIEMPRESA'
    }, depsBase(db));

    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    const capazes = out.porEmpresa.filter((e) => e.atendeIntegralmente);
    assert.equal(capazes.length, 0);
    const soma = 2 + 2 + 2;
    assert.ok(soma >= 5, 'soma agregada bastaria — política não soma');
    await closeDb(db);
  });

  it('Cenário 4 — ficha técnica: falta de ingrediente torna empresa incapaz', async () => {
    const { db, matriz, filialB } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'UN');
    await salvarFicha(db, pastel, [
      { insumo_id: massa, quantidade: 1, unidade: 'UN' },
      { insumo_id: queijo, quantidade: 1, unidade: 'UN' }
    ]);

    await estoque(db, massa, matriz.id, 10);
    await estoque(db, queijo, matriz.id, 0);
    await estoque(db, massa, filialB.id, 10);
    await estoque(db, queijo, filialB.id, 10);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA'
    }, depsBase(db));

    const avMatriz = out.porEmpresa.find((e) => e.empresaId === matriz.id);
    assert.equal(avMatriz.atendeIntegralmente, false);
    assert.ok(avMatriz.gargalos.some((g) => g.codigoMotivo === 'INSUMO_INSUFICIENTE' && g.insumoId === queijo));

    assert.equal(out.selecionada.empresaId, filialB.id);
    await closeDb(db);
  });

  it('Cenário 7 — nenhuma empresa elegível → bloqueio com motivo explícito', async () => {
    const { db, matriz, filialB } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 0 });
    await estoque(db, pastel, matriz.id, 10);
    await estoque(db, pastel, filialB.id, 10);

    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      usuarioId: 99
    }, {
      ...depsBase(db),
      listarEmpresasPermitidasIds: async () => []
    });

    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ELEGIVEL);
    assert.ok(out.porEmpresa.every((e) => e.elegivel === false));
    assert.ok(out.porEmpresa.every((e) => e.motivosInelegibilidade.includes('SEM_ACESSO')));
    await closeDb(db);
  });

  it('hash do carrinho muda quando quantidade muda', () => {
    const a = hashCarrinho([{ produtoId: 1, quantidade: 1 }]);
    const b = hashCarrinho([{ produtoId: 1, quantidade: 2 }]);
    assert.notEqual(a, b);
  });

  it('EMPRESA_SIMPLES → seletor não aplica', async () => {
    const { db } = await setupBase();
    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: 1, quantidade: 1 }],
      modoOperacional: 'EMPRESA_SIMPLES'
    }, depsBase(db));
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.SELETOR_AUTOMATICO_NAO_APLICA);
    assert.equal(out.selecionada, null);
    await closeDb(db);
  });
});
