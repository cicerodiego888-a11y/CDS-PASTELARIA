/**
 * PDV-SEL-01 — Integração do seletor automático (T01–T17 + concorrência).
 * Banco: SQLite :memory: isolado. Sem SEFAZ / banco oficial.
 * Executar: node --test tests/pdv/pdv-sel-01-selecao-empresa.test.js
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
  avaliarSelecaoEmpresaPdv,
  aplicarSelecaoEmpresaNaVendaPdv,
  resolverTipoSaldoParaCapacidade,
  hashCarrinho,
  CODIGOS_BLOQUEIO
} = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');
const {
  avaliarCapacidadeCarrinho
} = require('../../backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa');
const { JUSTIFICATIVAS } = require('../../backend/motores/muv/capacidade/selecionarEmpresaCapacidade');
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
      updated_at DATETIME
    )
  `);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);
  const matriz = await EmpresaService.criarEmpresa({ cnpj: CNPJ_MATRIZ, razao_social: 'Matriz' }, { db });
  const filialB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B' }, { db });
  const filialC = await EmpresaService.criarEmpresa({ cnpj: CNPJ_FILIAL_C, razao_social: 'Filial C' }, { db });
  return { db, matriz, filialB, filialC };
}

async function criarProduto(db, nome, tipo, unidade = 'UN', opts = {}) {
  const ins = await run(
    db,
    `INSERT INTO produtos (
       nome, tipo_operacional, unidade, controla_estoque, utiliza_ficha_tecnica
     ) VALUES (?, ?, ?, ?, ?)`,
    [
      nome,
      tipo,
      unidade,
      opts.controla_estoque != null ? opts.controla_estoque : 1,
      opts.utiliza_ficha_tecnica != null ? opts.utiliza_ficha_tecnica : 0
    ]
  );
  return ins.lastID;
}

async function estoque(db, produtoId, empresaId, saldoFiscal, saldoNaoFiscal = null) {
  // Por padrão espelha o saldo nos dois tipos — R08 escolhe FISCAL ou NAO_FISCAL conforme emitir_fiscal.
  const nf = saldoNaoFiscal == null ? saldoFiscal : saldoNaoFiscal;
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: nf,
    estoque_atual: Number(saldoFiscal) + Number(nf)
  }, { db });
}

const deps = (db) => ({
  db,
  usarAutorizacaoUsuario: false,
  verificarFiscalValido: async () => true
});

describe('PDV-SEL-01 seleção integrada', () => {
  it('T01 — matriz e filiais atendem → selecionar matriz', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 10);
    await estoque(db, p, filialB.id, 10);
    await estoque(db, p, filialC.id, 10);
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 1 }],
      body: { emitir_fiscal: false }
    }, deps(db));
    assert.equal(out.selecionada.empresaId, matriz.id);
    assert.equal(out.justificativa, JUSTIFICATIVAS.MATRIZ_ATENDE);
    await closeDb(db);
  });

  it('T02 — matriz não atende; duas filiais atendem → menor id', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 0);
    await estoque(db, p, filialB.id, 5);
    await estoque(db, p, filialC.id, 5);
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 2 }],
      body: { emitir_fiscal: false }
    }, deps(db));
    assert.equal(out.selecionada.empresaId, filialB.id);
    assert.ok(filialB.id < filialC.id);
    await closeDb(db);
  });

  it('T03 — só soma entre empresas atende → bloquear', async () => {
    const { db, matriz, filialB, filialC } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 2);
    await estoque(db, p, filialB.id, 2);
    await estoque(db, p, filialC.id, 2);
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 5 }],
      body: { emitir_fiscal: false }
    }, deps(db));
    assert.equal(out.selecionada, null);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('T04 — ficha sem ingrediente → gargalo', async () => {
    const { db, matriz, filialB } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', { utiliza_ficha_tecnica: 1 });
    const massa = await criarProduto(db, 'Massa', 'INSUMO');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO');
    await run(db, 'UPDATE produtos SET utiliza_ficha_tecnica = 1 WHERE id = ?', [pastel]);
    await FichaTecnicaService.salvar(pastel, {
      ativo: 1,
      itens: [
        { insumo_id: massa, quantidade: 1, unidade: 'UN' },
        { insumo_id: queijo, quantidade: 1, unidade: 'UN' }
      ]
    }, { db });
    await estoque(db, massa, matriz.id, 10);
    await estoque(db, queijo, matriz.id, 0);
    await estoque(db, massa, filialB.id, 10);
    await estoque(db, queijo, filialB.id, 10);
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: pastel, quantidade: 1 }],
      body: { emitir_fiscal: false }
    }, deps(db));
    const avM = out.capacidade.porEmpresa.find((e) => e.empresaId === matriz.id);
    assert.equal(avM.atendeIntegralmente, false);
    assert.ok(avM.gargalos.some((g) => g.insumoId === queijo));
    assert.equal(out.selecionada.empresaId, filialB.id);
    await closeDb(db);
  });

  it('T05 — estoque muda após consulta → revalidação falha', async () => {
    const { db, matriz, filialB } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 1, 0);
    await estoque(db, p, filialB.id, 0, 0);
    const prev = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 1 }],
      body: { emitir_fiscal: true }
    }, deps(db));
    assert.equal(prev.selecionada.empresaId, matriz.id);
    await EstoqueEmpresaService.aplicarEfeitoSaldo({
      produtoId: p,
      empresaId: matriz.id,
      deltaSaldoFiscal: -1,
      deltaSaldoNaoFiscal: 0
    }, { db });
    const depois = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 1 }],
      body: { emitir_fiscal: true }
    }, deps(db));
    assert.equal(depois.selecionada, null);
    assert.equal(depois.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('T06 — carrinho muda → hash invalida snapshot', async () => {
    const a = hashCarrinho([{ produtoId: 1, quantidade: 1 }]);
    const b = hashCarrinho([{ produtoId: 1, quantidade: 2 }]);
    assert.notEqual(a, b);
  });

  it('T07 — matriz ausente → bloqueio R04', async () => {
    const db = await openDb();
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaEstoqueEmpresaAsync(db);
    await run(db, `
      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, ativo INTEGER DEFAULT 1,
        unidade TEXT DEFAULT 'UN', tipo_operacional TEXT DEFAULT 'COMERCIAL',
        controla_estoque INTEGER DEFAULT 1, utiliza_ficha_tecnica INTEGER DEFAULT 0,
        saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0,
        reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0
      )`);
    await EmpresaService.criarEmpresa({ cnpj: CNPJ_FILIAL_B, razao_social: 'Só Filial' }, { db });
    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: 1, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL
    }, deps(db));
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.MATRIZ_AUSENTE);
    await closeDb(db);
  });

  it('T08 — caixa incompatível → bloqueio sem trocar empresa', async () => {
    const { db, matriz, filialB } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 0);
    await estoque(db, p, filialB.id, 5);
    const req = {
      body: { itens: [{ produto_id: p, quantidade: 1 }], emitir_fiscal: false, origem: 'PDV' },
      user: { id: 1 },
      headers: { 'x-empresa-id': String(matriz.id) },
      caixaSessao: { id: 9, empresa_id: matriz.id, status: 'aberto' }
    };
    await assert.rejects(
      () => aplicarSelecaoEmpresaNaVendaPdv(
        req,
        { origem: 'PDV' },
        { itens: [{ produto_id: p, quantidade: 1 }] },
        deps(db)
      ),
      (err) => err.code === CODIGOS_BLOQUEIO.CAIXA_INCOMPATIVEL
    );
    assert.notEqual(Number(req.empresaIdVendaSelecionada || 0), filialB.id);
    await closeDb(db);
  });

  it('T09 — exigirFiscalValido marca empresa sem fiscal como inelegível', async () => {
    const { db, matriz, filialB } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 10);
    await estoque(db, p, filialB.id, 10);
    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: p, quantidade: 1 }],
      modoOperacional: 'MULTIEMPRESA',
      tipoSaldo: TipoSaldo.FISCAL,
      exigirFiscalValido: true
    }, {
      ...deps(db),
      verificarFiscalValido: async ({ empresaId }) => Number(empresaId) !== Number(matriz.id)
    });
    const avM = out.porEmpresa.find((e) => e.empresaId === matriz.id);
    assert.equal(avM.elegivel, false);
    assert.ok(avM.motivosInelegibilidade.includes('FISCAL_INVALIDO'));
    assert.equal(out.selecionada.empresaId, filialB.id);
    await closeDb(db);
  });

  it('T10 — sem emissão fiscal imediata não exige fiscal completo', async () => {
    const saldo = resolverTipoSaldoParaCapacidade({ emitir_fiscal: false });
    assert.equal(saldo.exigirFiscalValido, false);
    assert.equal(saldo.tipoSaldo, TipoSaldo.NAO_FISCAL);
  });

  it('T11 — X-Empresa-Id diverge → servidor prevalece', async () => {
    const { db, matriz, filialB } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 0);
    await estoque(db, p, filialB.id, 5);
    const req = {
      body: {
        itens: [{ produto_id: p, quantidade: 1 }],
        emitir_fiscal: false,
        origem: 'PDV',
        empresa_id: matriz.id
      },
      user: { id: 1 },
      headers: { 'x-empresa-id': String(matriz.id) },
      caixaSessao: { id: 1, empresa_id: filialB.id, status: 'aberto' }
    };
    const sel = await aplicarSelecaoEmpresaNaVendaPdv(
      req,
      { origem: 'PDV' },
      { itens: [{ produto_id: p, quantidade: 1 }] },
      deps(db)
    );
    assert.equal(sel.empresaId, filialB.id);
    assert.equal(req.empresaId, filialB.id);
    assert.equal(req.headers['x-empresa-id'], String(filialB.id));
    assert.equal(req.body.empresa_id, undefined);
    await closeDb(db);
  });

  it('T12 — usuário sem acesso → inelegível', async () => {
    const { db, matriz, filialB } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 10);
    await estoque(db, p, filialB.id, 10);
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 1 }],
      body: { emitir_fiscal: false },
      usuarioId: 99
    }, {
      ...deps(db),
      listarEmpresasPermitidasIds: async () => []
    });
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ELEGIVEL);
    await closeDb(db);
  });

  it('T13 — produto sem controle de estoque não restringe só por saldo', async () => {
    const { db, matriz } = await setupBase();
    const p = await criarProduto(db, 'Serviço', 'COMERCIAL', 'UN', { controla_estoque: 0 });
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 100 }],
      body: { emitir_fiscal: false }
    }, deps(db));
    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('T14 — EMPRESA_SIMPLES → seletor não aplica', async () => {
    const { db } = await setupBase();
    const out = await avaliarCapacidadeCarrinho({
      itens: [{ produtoId: 1, quantidade: 1 }],
      modoOperacional: 'EMPRESA_SIMPLES',
      tipoSaldo: TipoSaldo.FISCAL
    }, deps(db));
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.SELETOR_AUTOMATICO_NAO_APLICA);
    await closeDb(db);
  });

  it('T15 — peso/volume usa precisão existente (roundStockQuantity via hash/capacidade)', async () => {
    const { db, matriz } = await setupBase();
    const p = await criarProduto(db, 'Queijo', 'COMERCIAL', 'KG');
    await estoque(db, p, matriz.id, 1.5);
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 1.25, unidade: 'KG' }],
      body: { emitir_fiscal: false }
    }, deps(db));
    assert.equal(out.selecionada.empresaId, matriz.id);
    const out2 = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 1.6, unidade: 'KG' }],
      body: { emitir_fiscal: false }
    }, deps(db));
    assert.equal(out2.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('T16 — empresa aplicada no request permanece única (integridade de contexto)', async () => {
    const { db, matriz } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 5);
    const req = {
      body: { itens: [{ produto_id: p, quantidade: 1 }], emitir_fiscal: true, origem: 'PDV' },
      headers: { 'x-empresa-id': '999' },
      caixaSessao: { id: 1, empresa_id: matriz.id, status: 'aberto' }
    };
    const sel = await aplicarSelecaoEmpresaNaVendaPdv(
      req,
      { origem: 'PDV' },
      { itens: [{ produto_id: p, quantidade: 1 }] },
      deps(db)
    );
    assert.equal(sel.empresaId, matriz.id);
    assert.equal(req.selecaoEmpresaPdv.empresaId, matriz.id);
    assert.equal(req.empresaId, matriz.id);
    await closeDb(db);
  });

  it('T17 — tipo saldo indeterminado bloqueia (não presume)', async () => {
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: 1, quantidade: 1 }],
      body: {}
    }, {});
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.TIPO_SALDO_INDETERMINADO);
  });

  it('Concorrência — duas revalidações: apenas capacidade residual impede a segunda', async () => {
    const { db, matriz } = await setupBase();
    const p = await criarProduto(db, 'Pastel', 'COMERCIAL');
    await estoque(db, p, matriz.id, 1, 0);
    const r1 = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 1 }],
      body: { emitir_fiscal: true }
    }, deps(db));
    assert.ok(r1.selecionada);
    // Simula consumo oficial (baixa) entre as consultas — sem inventar reserva paralela.
    await EstoqueEmpresaService.aplicarEfeitoSaldo({
      produtoId: p,
      empresaId: matriz.id,
      deltaSaldoFiscal: -1,
      deltaSaldoNaoFiscal: 0
    }, { db });
    const r2 = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId: p, quantidade: 1 }],
      body: { emitir_fiscal: true }
    }, deps(db));
    assert.equal(r2.selecionada, null);
    assert.equal(r2.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });
});
