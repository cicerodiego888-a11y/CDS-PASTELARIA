/**
 * Sprint 03.06 — Auditoria do ciclo da ficha técnica (Pastelaria).
 * Observa o comportamento atual. Não corrige GAPS.
 * Executar: node tests/pastelaria/auditoria-ciclo-ficha-tecnica-03-06.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const {
  DDL_CAB,
  DDL_ITENS,
  garantirSchemaVendaFichaConsumoAsync
} = require('../../backend/services/produtos/vendaFichaConsumoSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const { consumirFichaTecnicaDaVenda } = require('../../backend/services/produtos/FichaTecnicaConsumoService');
const MotorUM = require('../../backend/services/unidades/MotorUnidadesMedida');
const {
  exigirOperacaoReversaoDaVenda,
  exigirVendaDaEmpresa
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
const { creditarEstoqueItemVenda } = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try {
      db.close(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(
    db,
    `CREATE TABLE produtos (
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
      updated_at DATETIME
    )`
  );
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, status TEXT DEFAULT 'concluida', cancelada INTEGER DEFAULT 0)`);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaVendaFichaConsumoAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Pastelaria Matriz' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Pastelaria Filial' }, { db });
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, tipo, unidade, saldoProdutos) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [nome, tipo, unidade, saldoProdutos, saldoProdutos]
  );
  return ins.lastID;
}

async function estoque(db, produtoId, empresaId, saldoFiscal) {
  await EstoqueEmpresaService.criarRegistro(
    {
      produtoId,
      empresaId,
      saldo_fiscal: saldoFiscal,
      saldo_nao_fiscal: 0,
      estoque_atual: saldoFiscal
    },
    { db }
  );
}

async function ee(db, produtoId, empresaId) {
  return get(db, 'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [
    produtoId,
    empresaId
  ]);
}

async function setupPastel() {
  const ctx = await setupBase();
  const { db, empresaA, empresaB } = ctx;
  const comercialId = await criarProduto(db, 'Pastel de carne', 'COMERCIAL', 'UN', 40);
  const massaId = await criarProduto(db, 'Massa', 'INSUMO', 'UN', 100);
  const carneId = await criarProduto(db, 'Carne', 'INSUMO', 'KG', 10);
  await estoque(db, comercialId, empresaA.id, 40);
  await estoque(db, comercialId, empresaB.id, 40);
  await estoque(db, massaId, empresaA.id, 100);
  await estoque(db, massaId, empresaB.id, 100);
  await estoque(db, carneId, empresaA.id, 10);
  await estoque(db, carneId, empresaB.id, 10);
  await FichaTecnicaService.salvar(
    comercialId,
    {
      ativo: 1,
      itens: [
        { insumo_id: massaId, quantidade: 1, unidade: 'UN' },
        { insumo_id: carneId, quantidade: 80, unidade: 'G' }
      ]
    },
    { db }
  );
  const vendaA = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  const vendaB = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaB.id]);
  return {
    ...ctx,
    comercialId,
    massaId,
    carneId,
    vendaA: vendaA.lastID,
    vendaB: vendaB.lastID
  };
}

const consumoSrc = src('backend/services/produtos/FichaTecnicaConsumoService.js');
const cancelSrc = src('backend/services/vendas/VendaCancelamentoService.js');
const devolSrc = src('backend/services/vendas/VendaDevolucaoService.js');
const pagSrc = src('backend/services/vendas/VendaPagamentoService.js');
const rotasSrc = src('backend/rotas/vendas.js');
const appSrc = src('backend/services/vendas/VendaApplicationService.js');
const schemaSrc = src('backend/services/produtos/vendaFichaConsumoSchema.js');
const pdvSrc = src('frontend/pdv/js/pdv.js');

describe('03.06 T01–T07 consumo da venda', () => {
  it('T01 — consumo nasce após baixa dos itens, na transação da venda', () => {
    assert.match(rotasSrc, /router\.post\('\/', validarCaixaSeOrigemPdv, criarVenda\)/);
    assert.match(appSrc, /VendaPagamentoService\.criarVenda/);
    assert.match(pagSrc, /aposBaixaItensDaVenda/);
    assert.match(pagSrc, /consumirFichaTecnicaDaVendaCb/);
    assert.match(pagSrc, /BEGIN IMMEDIATE/);
    assert.match(pagSrc, /fichaErr[\s\S]{0,80}ROLLBACK/);
  });

  it('T02–T03 — quantidade e conversão ML/L ou G/KG no snapshot', async () => {
    const { db, comercialId, carneId, empresaA, vendaA } = await setupPastel();
    const { obterMuc } = require('../../backend/motores/muc/public');
    const esperadoKg = obterMuc(null).converterQuantidade({
      quantidade: 80, unidadeOrigem: 'G', unidadeDestino: 'KG'
    }).quantidade;
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }],
      db
    });
    const linha = await get(
      db,
      'SELECT * FROM venda_ficha_consumo_itens WHERE venda_id = ? AND insumo_id = ?',
      [vendaA, carneId]
    );
    assert.ok(linha);
    assert.equal(Number(linha.quantidade), Number(esperadoKg.toFixed(3)) || Number(linha.quantidade));
    assert.equal(String(linha.unidade).toUpperCase(), 'KG');
    assert.equal(Number(linha.quantidade_ficha), 80);
    assert.equal(String(linha.unidade_ficha).toUpperCase(), 'G');
    const sal = await ee(db, carneId, empresaA.id);
    assert.ok(Number(sal.saldo_fiscal) < 10);
    await closeDb(db);
  });

  it('T04 — vínculo com venda_id UNIQUE no cabeçalho', () => {
    assert.match(schemaSrc, /venda_id INTEGER NOT NULL UNIQUE/);
    assert.match(consumoSrc, /INSERT INTO venda_ficha_consumo \(venda_id, empresa_id\)/);
  });

  it('T05 — vínculo com produto da linha, sem venda_item_id', async () => {
    assert.doesNotMatch(DDL_ITENS, /venda_item_id/);
    const { db, comercialId, empresaA, vendaA } = await setupPastel();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }],
      db
    });
    const linhas = await all(db, 'SELECT * FROM venda_ficha_consumo_itens WHERE venda_id = ?', [vendaA]);
    assert.ok(linhas.every((l) => Number(l.produto_id) === comercialId));
    assert.ok(linhas.every((l) => l.venda_item_id == null));
    await closeDb(db);
  });

  it('T06 — vínculo com insumo_id', async () => {
    const { db, comercialId, massaId, carneId, empresaA, vendaA } = await setupPastel();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }],
      db
    });
    const ids = (await all(db, 'SELECT insumo_id FROM venda_ficha_consumo_itens WHERE venda_id = ?', [vendaA])).map(
      (r) => Number(r.insumo_id)
    );
    assert.ok(ids.includes(massaId) && ids.includes(carneId));
    await closeDb(db);
  });

  it('T07 — empresa_id do consumo = empresa da venda, A não toca B', async () => {
    const { db, comercialId, carneId, empresaA, empresaB, vendaA } = await setupPastel();
    const bAntes = await ee(db, carneId, empresaB.id);
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }],
      db
    });
    const cab = await get(db, 'SELECT empresa_id FROM venda_ficha_consumo WHERE venda_id = ?', [vendaA]);
    assert.equal(Number(cab.empresa_id), empresaA.id);
    const bDepois = await ee(db, carneId, empresaB.id);
    assert.equal(Number(bDepois.saldo_fiscal), Number(bAntes.saldo_fiscal));
    await closeDb(db);
  });
});

describe('03.06 T08–T11 cancelamento e devolução atuais', () => {
  it('T08 — crédito só do item comercial não estorna insumo; cancelamento de produção passa pela ficha', async () => {
    assert.match(cancelSrc, /estornarConsumoFichaTecnicaDaVendaCb/);
    assert.match(cancelSrc, /devolverEstoqueEEstornarFichaDaVenda/);
    assert.match(cancelSrc, /devolverEstoqueItensVenda/);
    assert.match(cancelSrc, /montarOpcoesRetornoEstoqueDaVenda\(venda/);
    const { db, comercialId, carneId, empresaA, vendaA } = await setupPastel();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }],
      db
    });
    const carneAposConsumo = await ee(db, carneId, empresaA.id);
    await new Promise((resolve, reject) => {
      creditarEstoqueItemVenda(
        db,
        {
          produtoId: comercialId,
          quantidadeFiscal: 1,
          quantidadeNaoFiscal: 0,
          empresaId: empresaA.id,
          exigirEmpresa: true,
          origem: 'cancelamento_venda'
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
    const carneAposCreditoComercial = await ee(db, carneId, empresaA.id);
    assert.equal(Number(carneAposCreditoComercial.saldo_fiscal), Number(carneAposConsumo.saldo_fiscal));
    const cab = await get(db, 'SELECT * FROM venda_ficha_consumo WHERE venda_id = ?', [vendaA]);
    assert.ok(cab);
    await closeDb(db);
  });

  it('T09 — devolução de produção chama estorno proporcional da ficha', () => {
    assert.match(devolSrc, /estornarConsumoFichaTecnicaDaDevolucaoCb/);
    assert.match(devolSrc, /function devolverParcial/);
    assert.match(devolSrc, /INSERT INTO vendas_devolucoes/);
    assert.match(devolSrc, /devolverEstoqueParcialItem/);
  });

  it('T10 — devolução parcial existe e persiste quantidade por item', () => {
    assert.match(devolSrc, /quantidade_ja_devolvida/);
    assert.match(devolSrc, /qtdDevolver > qtdDisponivel/);
    assert.match(devolSrc, /venda_item_id/);
    assert.match(rotasSrc, /router\.post\('\/:id\/devolver'/);
  });

  it('T11 — devolução total = soma das parciais até qtd vendida; cancelamento é total da venda', () => {
    assert.match(cancelSrc, /status !== 'concluida'/);
    assert.doesNotMatch(cancelSrc, /cancelarParcial|cancelamento parcial/i);
    assert.match(devolSrc, /permite devolver no máximo/);
  });
});

describe('03.06 T12–T14 ficha, itens, sem ficha', () => {
  it('T12 — snapshot sobrevive à alteração posterior da ficha', async () => {
    const { db, comercialId, carneId, empresaA, vendaA } = await setupPastel();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }],
      db
    });
    const antes = await get(
      db,
      'SELECT quantidade, quantidade_ficha FROM venda_ficha_consumo_itens WHERE venda_id = ? AND insumo_id = ?',
      [vendaA, carneId]
    );
    await FichaTecnicaService.salvar(
      comercialId,
      {
        ativo: 1,
        itens: [{ insumo_id: carneId, quantidade: 500, unidade: 'G' }]
      },
      { db }
    );
    const depois = await get(
      db,
      'SELECT quantidade, quantidade_ficha FROM venda_ficha_consumo_itens WHERE venda_id = ? AND insumo_id = ?',
      [vendaA, carneId]
    );
    assert.equal(Number(depois.quantidade_ficha), Number(antes.quantidade_ficha));
    assert.equal(Number(depois.quantidade), Number(antes.quantidade));
    assert.equal(Number(depois.quantidade_ficha), 80);
    await closeDb(db);
  });

  it('T13 — múltiplos itens: com ficha vs sem ficha', async () => {
    const { db, comercialId, empresaA, vendaA } = await setupPastel();
    const aguaId = await criarProduto(db, 'Água', 'COMERCIAL', 'UN', 20);
    await estoque(db, aguaId, empresaA.id, 20);
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA,
      empresaId: empresaA.id,
      itens: [
        { produto_id: comercialId, quantidade: 1 },
        { produto_id: aguaId, quantidade: 1 }
      ],
      db
    });
    const linhas = await all(db, 'SELECT DISTINCT produto_id FROM venda_ficha_consumo_itens WHERE venda_id = ?', [
      vendaA
    ]);
    assert.equal(linhas.length, 1);
    assert.equal(Number(linhas[0].produto_id), comercialId);
    await closeDb(db);
  });

  it('T14 — venda só sem ficha não cria cabeçalho de consumo', async () => {
    const ctx = await setupBase();
    const { db, empresaA } = ctx;
    const id = await criarProduto(db, 'Refrigerante', 'COMERCIAL', 'UN', 10);
    await estoque(db, id, empresaA.id, 10);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    const r = await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID,
      empresaId: empresaA.id,
      itens: [{ produto_id: id, quantidade: 1 }],
      db
    });
    assert.equal(r.consumido, false);
    const cab = await get(db, 'SELECT id FROM venda_ficha_consumo WHERE venda_id = ?', [venda.lastID]);
    assert.equal(cab, null);
    await closeDb(db);
  });
});

describe('03.06 T15–T19 ownership, transação, duplo', () => {
  it('T15 — cancelar venda A com caller B falha (VENDA_NAO_ENCONTRADA)', () => {
    assert.match(cancelSrc, /exigirOperacaoReversaoDaVenda\(venda, req\.empresaId\)/);
    const vendaA = { id: 9, empresa_id: 11 };
    assert.throws(() => exigirOperacaoReversaoDaVenda(vendaA, 22), (e) => e.code === 'VENDA_NAO_ENCONTRADA');
    assert.doesNotThrow(() => exigirOperacaoReversaoDaVenda(vendaA, 11));
  });

  it('T16 — devolver venda A com caller B falha', () => {
    assert.match(devolSrc, /exigirOperacaoReversaoDaVenda\(venda, req\.empresaId\)/);
    const vendaA = { id: 9, empresa_id: 11 };
    assert.throws(() => exigirVendaDaEmpresa(vendaA, 22), (e) => e.code === 'VENDA_NAO_ENCONTRADA');
  });

  it('T17 — cancel e devolução usam BEGIN IMMEDIATE; estorno de ficha só no cancelamento', () => {
    assert.match(cancelSrc, /BEGIN IMMEDIATE/);
    assert.match(devolSrc, /BEGIN IMMEDIATE/);
    assert.match(cancelSrc, /ROLLBACK/);
    assert.match(devolSrc, /ROLLBACK/);
    assert.match(cancelSrc, /estornarConsumoFichaTecnicaDaVendaCb/);
    assert.match(devolSrc, /estornarConsumoFichaTecnicaDaDevolucaoCb/);
  });

  it('T18 — rollback cobre crédito comercial e estorno da ficha no mesmo BEGIN', () => {
    assert.match(cancelSrc, /devolverEstoqueEEstornarFichaDaVenda[\s\S]{0,160}ROLLBACK/);
    assert.match(devolSrc, /estoqueErr[\s\S]{0,80}ROLLBACK/);
    assert.match(consumoSrc, /function estornarConsumoFichaTecnicaDaVenda/);
  });

  it('T19 — proteção duplo: consumo UNIQUE; cancel já cancelada; devolução > vendido', () => {
    assert.match(consumoSrc, /ja_consumido/);
    assert.match(cancelSrc, /Venda já cancelada|Apenas vendas concluídas/);
    assert.match(devolSrc, /Venda cancelada não pode receber devolução/);
    assert.match(devolSrc, /permite devolver no máximo/);
  });
});

describe('03.06 T20–T25 financeiro, caixa, fiscal, escopo, matriz', () => {
  it('T20 — financeiro de cancel/devolução já existe e não fala de ficha', () => {
    const fin = src('backend/services/vendas/VendaFinanceiroService.js');
    assert.match(cancelSrc, /cancelarFinanceiroVenda/);
    assert.match(devolSrc, /recalcularFinanceiroDevolucaoVenda/);
    assert.doesNotMatch(fin, /venda_ficha_consumo|FichaTecnica/);
  });

  it('T21 — caixa: middleware de sessão; sem movimento extra de ficha', () => {
    assert.match(rotasSrc, /validarCaixaAbertoCancelamentoVenda/);
    assert.match(rotasSrc, /validarCaixaAbertoDevolucaoVenda/);
    assert.match(cancelSrc, /sessao_id: req\.caixaSessaoId/);
    assert.doesNotMatch(cancelSrc, /INSERT INTO caixa/);
  });

  it('T22 — fiscal NFC-e no cancelamento antes do BEGIN local', () => {
    assert.match(cancelSrc, /cancelarNfceAutorizadaVenda/);
    assert.match(rotasSrc, /emitir-nfe-devolucao/);
    assert.doesNotMatch(cancelSrc, /FichaTecnicaService/);
    const idxFiscal = cancelSrc.indexOf('cancelarNfceAutorizadaVenda');
    const idxBegin = cancelSrc.indexOf('BEGIN IMMEDIATE');
    assert.ok(idxFiscal >= 0 && idxBegin > idxFiscal);
  });

  it('T23 — PDV Normal → POST /api/vendas; PDV Universal congelado neste fluxo', () => {
    assert.match(pdvSrc, /url: `\$\{API_URL\}\/vendas`/);
    assert.doesNotMatch(consumoSrc, /pdv-universal|PDVUniversal/);
    assert.doesNotMatch(pagSrc, /require\('\.\.\/\.\.\/motores\/pdv-universal/);
    const uni = src('backend/rotas/pdv-universal.js');
    assert.match(uni, /CONGELADO|congelado/i);
  });

  it('T24 — fluxo de ficha sem cubas/Açaíteria', () => {
    assert.doesNotMatch(consumoSrc, /cuba|açaí|acai|topping|complemento/i);
    assert.doesNotMatch(schemaSrc, /cuba|açaí|acai/i);
  });

  it('T25 — matriz: estorno determinístico PARCIAL; GAPS P0 confirmados', () => {
    assert.doesNotMatch(DDL_ITENS, /estornado|status|ficha_id|venda_item_id|quantidade_fiscal/);
    assert.match(DDL_ITENS, /quantidade REAL NOT NULL/);
    assert.match(DDL_ITENS, /unidade TEXT NOT NULL/);
    assert.match(DDL_CAB, /empresa_id INTEGER NOT NULL/);
    const gapped = !cancelSrc.includes('venda_ficha_consumo') && !devolSrc.includes('venda_ficha_consumo');
    assert.equal(gapped, true);
  });
});
