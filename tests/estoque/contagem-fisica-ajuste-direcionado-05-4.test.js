/**
 * SPRINT CDS-ESTOQUE-AJUSTE-DIRECIONADO-05.4
 *
 * Banco em memória. Não abre o banco oficial.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/estoque/contagem-fisica-ajuste-direcionado-05-4.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ajuste-direcionado-05-4-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const { exigirSnapshotItensOficiais } = require('../../backend/services/estoque/contagemFisicaSnapshotOficial');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaEstoqueContagemFisicaAsync } = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const {
  garantirSchemaEstoqueContagemPeriodicidadeAsync
} = require('../../backend/services/estoque/estoqueContagemPeriodicidadeSchema');
const {
  garantirSchemaProdutoConversaoAsync
} = require('../../backend/services/produtos/produtoConversaoSchema');
const ProdutoConversaoConfigService = require('../../backend/services/produtos/ProdutoConversaoConfigService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  converterQuantidadeContagem
} = require('../../backend/services/estoque/EstoqueContagemConversaoService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const ROOT = path.resolve(__dirname, '../..');
const UI = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/contagem-estoque.js'), 'utf8');

require('../../frontend/erp/js/contagem-estoque.js');
const ui = globalThis.__cdsContagemEstoqueTest;

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
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await garantirSchemaEstoqueContagemPeriodicidadeAsync(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      nome_busca TEXT,
      codigo TEXT,
      codigo_barras TEXT,
      unidade TEXT DEFAULT 'UN',
      unidade_comercial TEXT DEFAULT 'UN',
      unidade_estoque TEXT,
      utiliza_conversao INTEGER DEFAULT 0,
      utiliza_volume INTEGER DEFAULT 0,
      volume_valor REAL,
      volume_unidade TEXT,
      tipo_operacional TEXT DEFAULT 'COMERCIAL',
      ativo INTEGER DEFAULT 1,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await garantirSchemaProdutoConversaoAsync(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produto_embalagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'UN',
      descricao TEXT,
      quantidade REAL NOT NULL,
      unidade TEXT NOT NULL,
      gtin TEXT,
      principal INTEGER DEFAULT 0,
      compra INTEGER DEFAULT 1,
      venda INTEGER DEFAULT 1,
      estoque INTEGER DEFAULT 0,
      ativa INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      motivo TEXT,
      ajuste_fiscal REAL,
      ajuste_nao_fiscal REAL,
      saldo_fiscal_antes REAL,
      saldo_fiscal_depois REAL,
      saldo_nao_fiscal_antes REAL,
      saldo_nao_fiscal_depois REAL,
      estoque_total_antes REAL,
      estoque_total_depois REAL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const empresa = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_A, razao_social: 'Matriz' },
    { db }
  );
  const empresaB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_B, razao_social: 'Outra' },
    { db }
  );
  return { db, empresa, empresaB };
}

async function criarCoca(db, extras = {}) {
  const nome = extras.nome || 'Coca-Cola 1,5 L';
  const codigo = extras.codigo || '64896';
  const fatorMl = extras.fatorMl || 1500;
  const r = await run(
    db,
    `INSERT INTO produtos (
      nome, nome_busca, codigo, codigo_barras, unidade, unidade_comercial,
      unidade_estoque, utiliza_conversao, ativo
    ) VALUES (?, ?, ?, ?, 'UN', 'UN', 'ML', 1, 1)`,
    [nome, nome.toLowerCase(), codigo, extras.codigo_barras || null]
  );
  const id = r.lastID;
  await run(
    db,
    `INSERT INTO produto_embalagens
      (produto_id, tipo, quantidade, unidade, principal, venda, compra, estoque, ativa)
     VALUES (?, 'UN', ?, 'ML', 1, 1, 1, 1, 1)`,
    [id, fatorMl]
  );
  await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
    utiliza_conversao: 1,
    unidade_estoque: 'ML',
    apresentacoes: [{
      tipo: 'UN',
      quantidade: fatorMl,
      unidade: 'ML',
      principal: 1,
      venda: 1,
      compra: 1,
      ativa: 1
    }],
    relacoes: [{ unidade_origem: 'L', unidade_destino: 'ML', fator: 1000 }]
  }).catch(async () => {
    await run(
      db,
      `UPDATE produtos SET utiliza_conversao = 1, unidade_estoque = 'ML', unidade = 'ML' WHERE id = ?`,
      [id]
    );
  });
  await run(
    db,
    `INSERT OR IGNORE INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator)
     VALUES (?, 'UN', 'ML', ?)`,
    [id, fatorMl]
  );
  return id;
}

async function saldo(db, empresaId, produtoId, f, nf) {
  await run(
    db,
    `UPDATE produtos
        SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?
      WHERE id = ?`,
    [f, nf, f + nf, produtoId]
  );
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: f,
    saldo_nao_fiscal: nf,
    estoque_atual: f + nf
  }, { db });
}

async function lerSaldo(db, empresaId, produtoId) {
  const row = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
    produtoId,
    empresaId,
    db
  });
  return {
    fiscal: Number(row.saldoFiscal != null ? row.saldoFiscal : row.saldo_fiscal),
    naoFiscal: Number(row.saldoNaoFiscal != null ? row.saldoNaoFiscal : row.saldo_nao_fiscal)
  };
}

async function previewAjuste(db, empresaId, produtoId, extra = {}) {
  return EstoqueContagemFisicaService.previsualizarContagem(Object.assign({
    db,
    empresaId,
    produtoId,
    operacao: 'AJUSTE_DIRECIONADO',
    tipo_ajuste: 'BAIXA',
    quantidade_fiscal_informada: 10,
    quantidade_nao_fiscal_informada: 0
  }, extra));
}

function itemDePreview(preview, extra = {}) {
  const item = {
    produto_id: preview.produto_id,
    operacao: 'AJUSTE_DIRECIONADO',
    tipo_ajuste: preview.tipo_ajuste,
    quantidade_fiscal_informada: preview.quantidade_fiscal_informada,
    unidade_informada: preview.unidade_informada,
    omitir_nao_fiscal: !!preview.omitir_nao_fiscal,
    modo_fiscal: preview.modo_fiscal,
    saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
    saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
  };
  if (!preview.omitir_nao_fiscal) {
    item.quantidade_nao_fiscal_informada = preview.quantidade_nao_fiscal_informada;
  }
  return Object.assign(item, extra);
}

async function confirmarPreview(db, empresa, preview, extra = {}) {
  const itens = extra.itens || [itemDePreview(preview)];
  return EstoqueContagemFisicaService.registrarContagemFisica({
    db,
    empresaId: empresa.id,
    modo_fiscal: extra.modo_fiscal != null ? extra.modo_fiscal : preview.modo_fiscal,
    chaveIdempotencia: extra.chave || ('ajuste-' + Date.now() + '-' + Math.random().toString(16).slice(2)),
    usuarioId: 7,
    usuarioNome: 'Operador',
    itens: exigirSnapshotItensOficiais(itens)
  });
}

describe('CDS-ESTOQUE-AJUSTE-DIRECIONADO-05.4', { concurrency: false }, () => {
  it('01 nova operação inicia em OFF', () => {
    const estado = ui.estadoInicialAjusteDirecionado();
    assert.equal(estado.ligado, false);
    assert.equal(estado.tipo, 'BAIXA');
    assert.equal(estado.operacao, 'AJUSTE_DIRECIONADO');
    assert.match(UI, /tipoAjusteForm = 'BAIXA'/);
    assert.match(UI, /operacaoForm = 'AJUSTE_DIRECIONADO'/);
  });

  it('02 OFF identifica BAIXA', () => {
    assert.equal(ui.rotuloTipoAjuste('BAIXA'), 'BAIXA DE ESTOQUE');
    assert.equal(ui.rotuloTipoAjuste('OFF'), 'BAIXA DE ESTOQUE');
    assert.match(UI, /BAIXA DE ESTOQUE/);
    assert.match(UI, /fa-sign-out-alt/);
    assert.match(UI, /Tipo de ajuste/);
  });

  it('03 ON identifica ACRÉSCIMO', () => {
    assert.equal(ui.rotuloTipoAjuste('ACRESCIMO'), 'ACRÉSCIMO DE ESTOQUE');
    assert.equal(ui.rotuloTipoAjuste('ON'), 'ACRÉSCIMO DE ESTOQUE');
    assert.match(UI, /ACRÉSCIMO DE ESTOQUE/);
    assert.match(UI, /fa-sign-in-alt/);
    assert.match(UI, /is-on/);
  });

  it('04 alternar OFF/ON recalcula o saldo previsto sem alterar os demais itens', () => {
    // Quantidade = contado; previsto = contado; movimento = |saldo − contado|.
    assert.equal(ui.calcularSaldoPrevisto(24000, 9000, 'BAIXA'), 9000);
    assert.equal(ui.calcularMovimentoAjuste(24000, 9000, 'BAIXA'), 15000);
    assert.equal(ui.calcularSaldoPrevisto(24000, 39000, 'ACRESCIMO'), 39000);
    assert.equal(ui.calcularMovimentoAjuste(24000, 39000, 'ACRESCIMO'), 15000);
    const baixa = ui.snapshotDaLinha({
      produto_id: 1,
      operacao: 'AJUSTE_DIRECIONADO',
      tipo_ajuste: 'BAIXA',
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0,
      saldo_fiscal_previsto: 9000,
      saldo_nao_fiscal_previsto: 0,
      quantidade_fiscal_contada: 9000,
      quantidade_nao_fiscal_contada: 0,
      quantidade_fiscal_movimento: 15000,
      diferenca_fiscal: -15000,
      diferenca_nao_fiscal: 0
    }, { nome: 'Coca-Cola 1,5 L' });
    const agua = ui.snapshotDaLinha({
      produto_id: 2,
      operacao: 'AJUSTE_DIRECIONADO',
      tipo_ajuste: 'ACRESCIMO',
      saldo_fiscal_esperado: 5000,
      saldo_nao_fiscal_esperado: 0,
      saldo_fiscal_previsto: 15000,
      saldo_nao_fiscal_previsto: 0,
      quantidade_fiscal_contada: 15000,
      quantidade_nao_fiscal_contada: 0,
      quantidade_fiscal_movimento: 10000,
      diferenca_fiscal: 10000,
      diferenca_nao_fiscal: 0
    }, { nome: 'Água 500 ml' });
    const editado = ui.atualizarLinhaPorPreview([baixa, agua], 0, {
      produto_id: 1,
      operacao: 'AJUSTE_DIRECIONADO',
      tipo_ajuste: 'ACRESCIMO',
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0,
      saldo_fiscal_previsto: 39000,
      saldo_nao_fiscal_previsto: 0,
      quantidade_fiscal_contada: 39000,
      quantidade_nao_fiscal_contada: 0,
      quantidade_fiscal_movimento: 15000,
      diferenca_fiscal: 15000,
      diferenca_nao_fiscal: 0
    }, { nome: 'Coca-Cola 1,5 L' });
    assert.equal(editado.ok, true);
    assert.equal(editado.linhas[0].tipo_ajuste, 'ACRESCIMO');
    assert.equal(editado.linhas[0].saldo_fiscal_previsto, 39000);
    assert.equal(editado.linhas[1].tipo_ajuste, 'ACRESCIMO');
    assert.equal(editado.linhas[1].produto_id, 2);
    assert.equal(editado.linhas[1].saldo_fiscal_previsto, 15000);
  });

  it('05 nova operação volta ao padrão OFF e o seletor não é preferência permanente', () => {
    const inicio = ui.estadoInicialAjusteDirecionado();
    assert.equal(inicio.ligado, false);
    assert.match(UI, /function resetarAjusteDirecionado\(\) \{[\s\S]*tipoAjusteForm = 'BAIXA'/);
    assert.match(UI, /function loadContagemEstoque\(\) \{[\s\S]*tipoAjusteForm = 'BAIXA'/);
    assert.doesNotMatch(UI, /localStorage\.setItem\([^)]*tipoAjuste|localStorage\.setItem\([^)]*ajusteDirecionado/i);
  });

  it('06 e 29 baixa converte 10 UN de Coca-Cola 1,5 L para 15.000 ML', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await previewAjuste(db, empresa.id, id, { tipo_ajuste: 'OFF' });
    assert.equal(preview.operacao, 'AJUSTE_DIRECIONADO');
    assert.equal(preview.tipo_ajuste, 'BAIXA');
    assert.equal(preview.quantidade_fiscal_informada, 10);
    assert.equal(preview.unidade_informada, 'UN');
    assert.equal(preview.quantidade_fiscal_convertida, 15000);
    assert.equal(preview.unidade_base, 'ML');
    assert.equal(preview.movimentou_estoque, false);
    await closeDb(db);
  });

  it('07 e 08 baixa usa quantidade contada e baixa a diferença até o saldo previsto', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    // 10 UN contadas = 15.000 ML → baixa 9.000; previsto = 15.000
    const preview = await previewAjuste(db, empresa.id, id);
    assert.equal(preview.saldo_fiscal_anterior, 24000);
    assert.equal(preview.quantidade_fiscal_contada, 15000);
    assert.equal(preview.quantidade_fiscal_movimento, 9000);
    assert.equal(preview.diferenca_fiscal, -9000);
    assert.equal(preview.saldo_fiscal_previsto, 15000);
    assert.equal(ui.calcularSaldoPrevisto(24000, 15000, 'OFF'), 15000);
    assert.equal(ui.calcularMovimentoAjuste(24000, 15000, 'OFF'), 9000);
    await closeDb(db);
  });

  it('09 contado acima do saldo na baixa é rejeitado', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    // 20 UN = 30.000 ML contados > 24.000 → incompatível com BAIXA
    const preview = await previewAjuste(db, empresa.id, id, {
      quantidade_fiscal_informada: 20,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.saldo_insuficiente, true);
    assert.equal(preview.saldo_disponivel_fiscal, 24000);
    assert.equal(preview.quantidade_solicitada_fiscal, 30000);
    assert.equal(preview.saldo_fiscal_previsto, 30000);
    const antes = await lerSaldo(db, empresa.id, id);
    await assert.rejects(
      () => confirmarPreview(db, empresa, preview, { chave: 'baixa-insuficiente' }),
      (err) => err
        && err.code === 'SALDO_INSUFICIENTE'
        && err.saldo_disponivel === 24000
        && err.quantidade_solicitada === 30000
    );
    const depois = await lerSaldo(db, empresa.id, id);
    assert.deepEqual(depois, antes);
    const n = await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas');
    assert.equal(Number(n.n), 0);
    await closeDb(db);
  });

  it('10 consulta e pré-visualização não movimentam estoque', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 1000);
    const antes = await lerSaldo(db, empresa.id, id);
    const consulta = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db,
      empresaId: empresa.id,
      produtoId: id
    });
    const preview = await previewAjuste(db, empresa.id, id);
    assert.equal(consulta.movimentou_estoque, false);
    assert.equal(preview.movimentou_estoque, false);
    assert.equal(preview.saldo_fiscal_esperado, 24000);
    assert.ok('ultima_origem_saldo' in consulta);
    assert.equal(consulta.ultima_origem_saldo, null);
    const depois = await lerSaldo(db, empresa.id, id);
    assert.deepEqual(depois, antes);
    const contagens = await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas');
    const ajustes = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque');
    assert.equal(Number(contagens.n), 0);
    assert.equal(Number(ajustes.n), 0);
    await closeDb(db);
  });

  it('11 e 12 acréscimo usa contado acima do saldo', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    // Contado 26 UN = 39.000 ML → acréscimo 15.000
    const preview = await previewAjuste(db, empresa.id, id, {
      tipo_ajuste: 'ON',
      quantidade_fiscal_informada: 26,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.tipo_ajuste, 'ACRESCIMO');
    assert.equal(preview.quantidade_fiscal_convertida, 39000);
    assert.equal(preview.quantidade_fiscal_movimento, 15000);
    assert.equal(preview.diferenca_fiscal, 15000);
    assert.equal(preview.saldo_fiscal_previsto, 39000);
    const antes = await lerSaldo(db, empresa.id, id);
    assert.equal(antes.fiscal, 24000);
    await closeDb(db);
  });

  it('13 saldo previsto do acréscimo é o contado', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await previewAjuste(db, empresa.id, id, {
      tipo_ajuste: 'ACRESCIMO',
      quantidade_fiscal_informada: 26,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.saldo_fiscal_anterior, 24000);
    assert.equal(preview.saldo_fiscal_previsto, 39000);
    assert.equal(ui.calcularSaldoPrevisto(preview.saldo_fiscal_anterior, preview.quantidade_fiscal_convertida, 'ON'), 39000);
    await closeDb(db);
  });

  it('14 acréscimo não altera o saldo antes da confirmação', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 500);
    await previewAjuste(db, empresa.id, id, {
      tipo_ajuste: 'ACRESCIMO',
      quantidade_nao_fiscal_informada: 1
    });
    const depois = await lerSaldo(db, empresa.id, id);
    assert.deepEqual(depois, { fiscal: 24000, naoFiscal: 500 });
    await closeDb(db);
  });

  it('15 F12 OFF permite baixa fiscal e não fiscal separadas', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 10000);
    // Contado F 10 UN=15.000 → previsto 15.000 (baixa 9.000)
    // Contado NF 2 UN=3.000 → previsto 3.000 (baixa 7.000)
    const preview = await previewAjuste(db, empresa.id, id, {
      tipo_ajuste: 'BAIXA',
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 2,
      modo_fiscal: '0'
    });
    assert.equal(preview.omitir_nao_fiscal, false);
    assert.equal(preview.quantidade_fiscal_convertida, 15000);
    assert.equal(preview.quantidade_nao_fiscal_convertida, 3000);
    assert.equal(preview.saldo_fiscal_previsto, 15000);
    assert.equal(preview.saldo_nao_fiscal_previsto, 3000);
    const conf = await confirmarPreview(db, empresa, preview, { chave: 'baixa-fxnf' });
    const depois = await lerSaldo(db, empresa.id, id);
    assert.deepEqual(depois, { fiscal: 15000, naoFiscal: 3000 });
    assert.equal(conf.itens[0].tipo_ajuste, 'BAIXA');
    assert.equal(conf.itens[0].diferenca_fiscal, -9000);
    assert.equal(conf.itens[0].diferenca_nao_fiscal, -7000);
    await closeDb(db);
  });

  it('16 F12 OFF permite acréscimo fiscal e não fiscal separados', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 10000);
    // Contado F 26 UN=39.000; NF 8 UN=12.000 → previstos 39.000 / 12.000
    const preview = await previewAjuste(db, empresa.id, id, {
      tipo_ajuste: 'ACRESCIMO',
      quantidade_fiscal_informada: 26,
      quantidade_nao_fiscal_informada: 8
    });
    assert.equal(preview.saldo_fiscal_previsto, 39000);
    assert.equal(preview.saldo_nao_fiscal_previsto, 12000);
    await confirmarPreview(db, empresa, preview, { chave: 'entrada-fxnf' });
    const depois = await lerSaldo(db, empresa.id, id);
    assert.deepEqual(depois, { fiscal: 39000, naoFiscal: 12000 });
    await closeDb(db);
  });

  it('17 F12 ON oculta o campo não fiscal', () => {
    assert.match(UI, /id="cef-wrap-qnf"/);
    assert.match(UI, /f12On[\s\S]{0,80}d-none|cef-wrap-qnf.*d-none/);
    assert.match(UI, /F12 ON — somente quantidade fiscal/);
  });

  it('card exibe última entrada/ajuste e labels de quantidade contada', () => {
    assert.match(UI, /ultima_origem_saldo/);
    assert.match(UI, /Última entrada \(compra\/NF\)/);
    assert.match(UI, /Último ajuste manual/);
    assert.match(UI, /Quantidade fiscal contada|Quantidade física encontrada \(contada\)/);
    assert.match(UI, /saldo atual − contado|saldo físico contado/);
  });

  it('18 e 19 F12 ON preserva o saldo não fiscal e não gera ajuste não fiscal', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 10000);
    const preview = await previewAjuste(db, empresa.id, id, {
      tipo_ajuste: 'BAIXA',
      quantidade_fiscal_informada: 10,
      modo_fiscal: '1',
      omitir_nao_fiscal: true
    });
    assert.equal(preview.omitir_nao_fiscal, true);
    assert.equal(preview.quantidade_nao_fiscal_convertida, null);
    assert.equal(preview.saldo_nao_fiscal_previsto, 10000);
    assert.equal(preview.diferenca_nao_fiscal, null);
    assert.equal(preview.saldo_fiscal_previsto, 15000);
    assert.equal(preview.diferenca_fiscal, -9000);
    await confirmarPreview(db, empresa, preview, { chave: 'f12-preserva-nf', modo_fiscal: '1' });
    const depois = await lerSaldo(db, empresa.id, id);
    assert.deepEqual(depois, { fiscal: 15000, naoFiscal: 10000 });
    const ajustes = await all(db, 'SELECT ajuste_fiscal, ajuste_nao_fiscal, motivo FROM produtos_ajustes_estoque');
    assert.equal(ajustes.length, 1);
    assert.equal(Number(ajustes[0].ajuste_fiscal), -9000);
    assert.equal(Number(ajustes[0].ajuste_nao_fiscal), 0);
    assert.match(String(ajustes[0].motivo), /^AJUSTE_DIRECIONADO_BAIXA/);
    await closeDb(db);
  });

  it('20 snapshot desatualizado rejeita o lote sem recalcular no saldo novo', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await previewAjuste(db, empresa.id, id, { tipo_ajuste: 'BAIXA' });
    await run(
      db,
      `UPDATE estoque_empresa
          SET saldo_fiscal = 20000, saldo_nao_fiscal = 0, estoque_atual = 20000
        WHERE produto_id = ? AND empresa_id = ?`,
      [id, empresa.id]
    );
    await run(
      db,
      `UPDATE produtos SET saldo_fiscal = 20000, saldo_nao_fiscal = 0, estoque_atual = 20000 WHERE id = ?`,
      [id]
    );
    await assert.rejects(
      () => confirmarPreview(db, empresa, preview, { chave: 'snapshot-velho' }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    const depois = await lerSaldo(db, empresa.id, id);
    assert.deepEqual(depois, { fiscal: 20000, naoFiscal: 0 });
    await closeDb(db);
  });

  it('21 retry com a mesma chave não duplica ajustes', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await previewAjuste(db, empresa.id, id, {
      tipo_ajuste: 'ACRESCIMO',
      quantidade_fiscal_informada: 26
    });
    const primeira = await confirmarPreview(db, empresa, preview, { chave: 'mesma-chave' });
    const segunda = await confirmarPreview(db, empresa, preview, { chave: 'mesma-chave' });
    assert.equal(segunda.id, primeira.id);
    const depois = await lerSaldo(db, empresa.id, id);
    assert.deepEqual(depois, { fiscal: 39000, naoFiscal: 0 });
    const ajustes = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque');
    assert.equal(Number(ajustes.n), 1);
    await closeDb(db);
  });

  it('22 falha em um item reverte o lote inteiro', async () => {
    const { db, empresa } = await setup();
    const coca = await criarCoca(db, { nome: 'Coca-Cola 1,5 L', codigo: 'COCA22' });
    const agua = await criarCoca(db, { nome: 'Água 500 ml', codigo: 'AGUA22', fatorMl: 500 });
    await saldo(db, empresa.id, coca, 24000, 0);
    await saldo(db, empresa.id, agua, 5000, 0);
    const baixa = await previewAjuste(db, empresa.id, coca, { tipo_ajuste: 'BAIXA' });
    const entrada = await previewAjuste(db, empresa.id, agua, {
      tipo_ajuste: 'ACRESCIMO',
      quantidade_fiscal_informada: 20,
      quantidade_nao_fiscal_informada: 0
    });
    const itemRuim = itemDePreview(entrada);
    itemRuim.saldo_fiscal_esperado = 1;
    await assert.rejects(
      () => confirmarPreview(db, empresa, baixa, {
        chave: 'lote-reverte',
        itens: [itemDePreview(baixa), itemRuim]
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.deepEqual(await lerSaldo(db, empresa.id, coca), { fiscal: 24000, naoFiscal: 0 });
    assert.deepEqual(await lerSaldo(db, empresa.id, agua), { fiscal: 5000, naoFiscal: 0 });
    const n = await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas');
    assert.equal(Number(n.n), 0);
    await closeDb(db);
  });

  it('23 a 26 consulta, inclusão, edição e remoção não movimentam estoque', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 1000);
    await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db,
      empresaId: empresa.id,
      produtoId: id
    });
    const preview = await previewAjuste(db, empresa.id, id);
    const inclusao = ui.incluirNaLista([], preview, { nome: 'Coca-Cola 1,5 L' });
    const edicao = ui.atualizarLinhaPorPreview(inclusao.linhas, 0, Object.assign({}, preview, {
      quantidade_fiscal_informada: 4,
      quantidade_fiscal_convertida: 6000,
      quantidade_fiscal_contada: 6000,
      quantidade_fiscal_movimento: 18000,
      diferenca_fiscal: -18000,
      saldo_fiscal_previsto: 6000
    }), { nome: 'Coca-Cola 1,5 L' });
    const remocao = ui.removerDaLista(edicao.linhas, 0);
    assert.equal(inclusao.ok, true);
    assert.equal(edicao.ok, true);
    assert.equal(remocao.length, 0);
    assert.deepEqual(await lerSaldo(db, empresa.id, id), { fiscal: 24000, naoFiscal: 1000 });
    const ajustes = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque');
    assert.equal(Number(ajustes.n), 0);
    assert.match(UI, /fetch\('\/api\/estoque\/contagem-fisica'/);
    assert.equal((UI.match(/fetch\('\/api\/estoque\/contagem-fisica'/g) || []).length, 1);
    await closeDb(db);
  });

  it('27 histórico identifica BAIXA e ACRÉSCIMO', async () => {
    const { db, empresa } = await setup();
    const coca = await criarCoca(db, { nome: 'Coca-Cola 1,5 L', codigo: 'COCA27' });
    const agua = await criarCoca(db, { nome: 'Água 500 ml', codigo: 'AGUA27', fatorMl: 500 });
    await saldo(db, empresa.id, coca, 24000, 0);
    await saldo(db, empresa.id, agua, 5000, 0);
    const baixa = await previewAjuste(db, empresa.id, coca, { tipo_ajuste: 'BAIXA' });
    const entrada = await previewAjuste(db, empresa.id, agua, {
      tipo_ajuste: 'ACRESCIMO',
      quantidade_fiscal_informada: 20,
      quantidade_nao_fiscal_informada: 0
    });
    const conf = await confirmarPreview(db, empresa, baixa, {
      chave: 'historico-tipos',
      itens: [itemDePreview(baixa), itemDePreview(entrada)]
    });
    const tipos = conf.itens.map((item) => item.tipo_ajuste).sort();
    assert.deepEqual(tipos, ['ACRESCIMO', 'BAIXA']);
    const cocaItem = conf.itens.find((item) => item.produto_id === coca);
    const aguaItem = conf.itens.find((item) => item.produto_id === agua);
    assert.equal(cocaItem.saldo_fiscal_anterior, 24000);
    assert.equal(cocaItem.quantidade_fiscal_contada, 15000);
    assert.equal(aguaItem.saldo_fiscal_anterior, 5000);
    assert.equal(aguaItem.quantidade_fiscal_contada, 10000);
    const motivos = await all(db, 'SELECT motivo, ajuste_fiscal FROM produtos_ajustes_estoque ORDER BY id');
    assert.match(String(motivos[0].motivo), /AJUSTE_DIRECIONADO_BAIXA/);
    assert.match(String(motivos[1].motivo), /AJUSTE_DIRECIONADO_ACRESCIMO/);
    assert.equal(Number(motivos[0].ajuste_fiscal), -9000);
    assert.equal(Number(motivos[1].ajuste_fiscal), 5000);
    await closeDb(db);
  });

  it('consulta saldo atual prioriza a data mais recente entre compra/NF e ajuste', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    await run(db, `
      CREATE TABLE IF NOT EXISTS compras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER,
        data_entrada TEXT,
        data_emissao TEXT,
        data_compra TEXT,
        created_at TEXT
      )
    `);
    await run(db, `
      CREATE TABLE IF NOT EXISTS compras_itens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        compra_id INTEGER,
        produto_id INTEGER
      )
    `);
    await run(
      db,
      `INSERT INTO compras (empresa_id, data_entrada) VALUES (?, ?)`,
      [empresa.id, '2026-11-08']
    );
    const compra = await get(db, 'SELECT id FROM compras ORDER BY id DESC LIMIT 1');
    await run(
      db,
      `INSERT INTO compras_itens (compra_id, produto_id) VALUES (?, ?)`,
      [compra.id, id]
    );
    await run(
      db,
      `INSERT INTO produtos_ajustes_estoque (produto_id, motivo, ajuste_fiscal, criado_em)
       VALUES (?, 'AJUSTE_DIRECIONADO_BAIXA', -4, ?)`,
      [id, '2026-11-14 10:00:00']
    );
    const consulta = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db,
      empresaId: empresa.id,
      produtoId: id
    });
    assert.ok(consulta.ultima_origem_saldo);
    assert.equal(consulta.ultima_origem_saldo.origem, 'AJUSTE');
    assert.match(String(consulta.ultima_origem_saldo.data), /^2026-11-14/);
    await run(db, `DELETE FROM produtos_ajustes_estoque`);
    const soCompra = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
      db,
      empresaId: empresa.id,
      produtoId: id
    });
    assert.equal(soCompra.ultima_origem_saldo.origem, 'COMPRA');
    assert.match(String(soCompra.ultima_origem_saldo.data), /^2026-11-08/);
    await closeDb(db);
  });

  it('28 empresa A não altera estoque da empresa B', async () => {
    const { db, empresa, empresaB } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    await saldo(db, empresaB.id, id, 8000, 400);
    await run(
      db,
      `UPDATE produtos SET saldo_fiscal = 24000, saldo_nao_fiscal = 0, estoque_atual = 24000 WHERE id = ?`,
      [id]
    );
    const preview = await previewAjuste(db, empresa.id, id, { tipo_ajuste: 'BAIXA' });
    await confirmarPreview(db, empresa, preview, { chave: 'isola-empresa' });
    assert.deepEqual(await lerSaldo(db, empresa.id, id), { fiscal: 15000, naoFiscal: 0 });
    assert.deepEqual(await lerSaldo(db, empresaB.id, id), { fiscal: 8000, naoFiscal: 400 });
    await closeDb(db);
  });

  it('30 produto sem conversão confiável é rejeitado', async () => {
    const { db, empresa } = await setup();
    const r = await run(
      db,
      `INSERT INTO produtos (nome, codigo, unidade, unidade_estoque, utiliza_conversao, ativo)
       VALUES ('Sem Fator', 'SF54', 'UN', 'ML', 1, 1)`
    );
    await assert.rejects(
      () => previewAjuste(db, empresa.id, r.lastID, { tipo_ajuste: 'BAIXA' }),
      (err) => err && /CONVERSAO_PRODUTO_INCOMPLETA|CONVERSAO/.test(err.code)
    );
    const n = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque');
    assert.equal(Number(n.n), 0);
    await closeDb(db);
  });

  it('31 unidade comercial igual à unidade-base respeita identidade 1:1', async () => {
    const { db, empresa } = await setup();
    const r = await run(
      db,
      `INSERT INTO produtos (
        nome, codigo, unidade, unidade_comercial, unidade_estoque, utiliza_conversao, ativo
      ) VALUES ('Guardanapo', 'G1', 'UN', 'UN', 'UN', 0, 1)`
    );
    await saldo(db, empresa.id, r.lastID, 40, 0);
    const preview = await previewAjuste(db, empresa.id, r.lastID, {
      tipo_ajuste: 'ACRESCIMO',
      quantidade_fiscal_informada: 50,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.quantidade_fiscal_convertida, 50);
    assert.equal(preview.fator_total, 1);
    assert.equal(preview.saldo_fiscal_previsto, 50);
    assert.equal(preview.quantidade_fiscal_movimento, 10);
    await closeDb(db);
  });

  it('32 precisão do ajuste direcionado respeita o conversor oficial', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { nome: 'Xarope', codigo: 'XAR32', fatorMl: 333.333333 });
    await saldo(db, empresa.id, id, 1000, 0);
    const direto = await converterQuantidadeContagem(db, id, 3, { unidadeOrigem: 'UN' });
    const preview = await previewAjuste(db, empresa.id, id, {
      tipo_ajuste: 'BAIXA',
      quantidade_fiscal_informada: 3,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.quantidade_fiscal_convertida, direto.quantidade_convertida);
    assert.equal(preview.quantidade_fiscal_contada, direto.quantidade_convertida);
    assert.equal(preview.saldo_fiscal_previsto, direto.quantidade_convertida);
    assert.equal(preview.diferenca_fiscal, -preview.quantidade_fiscal_movimento);
    assert.ok(preview.quantidade_fiscal_movimento >= 0);
    await closeDb(db);
  });

  it('contagem física absoluta continua usando a quantidade como saldo final', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { nome: 'Coca Absoluta', codigo: 'ABS54' });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresa.id,
      produtoId: id,
      operacao: 'CONTAGEM_FISICA',
      quantidade_fiscal_informada: 10,
      quantidade_nao_fiscal_informada: 0
    });
    assert.equal(preview.operacao, undefined);
    assert.equal(preview.quantidade_fiscal_contada, 15000);
    assert.equal(preview.diferenca_fiscal, -9000);
    const conf = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresa.id,
      chaveIdempotencia: 'absoluta-inalterada',
      itens: exigirSnapshotItensOficiais([{
        produto_id: id,
        operacao: 'CONTAGEM_FISICA',
        quantidade_fiscal_informada: 10,
        quantidade_nao_fiscal_informada: 0,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }])
    });
    assert.equal(conf.itens[0].tipo_ajuste, null);
    assert.deepEqual(await lerSaldo(db, empresa.id, id), { fiscal: 15000, naoFiscal: 0 });
    await closeDb(db);
  });

  it('resumo separa baixas e acréscimos por unidade-base', () => {
    const resumo = ui.resumoDirecionado([
      {
        tipo_ajuste: 'BAIXA',
        unidade_base: 'ML',
        diferenca_fiscal: -15000,
        diferenca_nao_fiscal: -3000,
        omitir_nao_fiscal: false
      },
      {
        tipo_ajuste: 'ACRESCIMO',
        unidade_base: 'ML',
        diferenca_fiscal: 10000,
        diferenca_nao_fiscal: 0,
        omitir_nao_fiscal: false
      },
      {
        tipo_ajuste: 'ACRESCIMO',
        unidade_base: 'UN',
        diferenca_fiscal: 4,
        diferenca_nao_fiscal: 0,
        omitir_nao_fiscal: true
      }
    ]);
    assert.equal(resumo.produtos, 3);
    assert.equal(resumo.baixas, 1);
    assert.equal(resumo.acrescimos, 2);
    assert.equal(resumo.por_unidade.ML.baixa_fiscal, 15000);
    assert.equal(resumo.por_unidade.ML.baixa_nao_fiscal, 3000);
    assert.equal(resumo.por_unidade.ML.acrescimo_fiscal, 10000);
    assert.equal(resumo.por_unidade.UN.acrescimo_fiscal, 4);
    assert.equal(resumo.por_unidade.UN.acrescimo_nao_fiscal, 0);
  });

  it('inclusão bloqueia baixa com saldo insuficiente e a confirmação envia o tipo do item', () => {
    const preview = {
      produto_id: 9,
      operacao: 'AJUSTE_DIRECIONADO',
      tipo_ajuste: 'BAIXA',
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0,
      saldo_insuficiente: true,
      quantidade_fiscal_contada: 30000,
      quantidade_nao_fiscal_contada: 0
    };
    const bloqueio = ui.incluirNaLista([], preview, { nome: 'Coca-Cola 1,5 L' });
    assert.equal(bloqueio.ok, false);
    assert.equal(bloqueio.code, 'SALDO_INSUFICIENTE');
    assert.equal(bloqueio.linhas.length, 0);
    const linha = ui.snapshotDaLinha(Object.assign({}, preview, { saldo_insuficiente: false }), { nome: 'Coca' });
    const api = ui.itemConfirmacaoApi(linha);
    assert.equal(api.tipo_ajuste, 'BAIXA');
    assert.equal(api.operacao, 'AJUSTE_DIRECIONADO');
    assert.deepEqual(ui.itemConfirmacao(linha), {
      produto_id: 9,
      quantidade_fiscal_contada: 30000,
      quantidade_nao_fiscal_contada: 0,
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0
    });
  });
});
