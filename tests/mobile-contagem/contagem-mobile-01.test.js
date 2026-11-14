/**
 * CDS-ESTOQUE-CONTAGEM-MOBILE-01
 * Banco em memória nos casos que gravam. Não abre o banco oficial.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/mobile-contagem/contagem-mobile-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-contagem-mobile-01-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const raiz = path.resolve(__dirname, '../..');
function ler(rel) { return fs.readFileSync(path.join(raiz, rel), 'utf8'); }

const HTML = ler('frontend/mobile-contagem/index.html');
const CSS = ler('frontend/mobile-contagem/mobile-contagem.css');
const JS = ler('frontend/mobile-contagem/mobile-contagem.js');
const HUB = ler('frontend/mobile/index.html');
const SERVIDOR = ler('backend/server.js');
const DESKTOP = ler('frontend/erp/js/contagem-estoque.js');

require('../../frontend/erp/js/contagem-estoque.js');
require('../../frontend/mobile-contagem/mobile-contagem.js');
const ui = globalThis.__cdsContagemEstoqueTest;
const mobile = globalThis.MobileContagem;
const acesso = require('../../frontend/shared/js/pdv-acesso-oficial');

const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const { exigirSnapshotItensOficiais } = require('../../backend/services/estoque/contagemFisicaSnapshotOficial');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaEstoqueContagemFisicaAsync } = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const ProdutoConversaoConfigService = require('../../backend/services/produtos/ProdutoConversaoConfigService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID });
    });
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_e) { resolve(); } });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, nome_busca TEXT, codigo TEXT,
    unidade TEXT, unidade_comercial TEXT, unidade_estoque TEXT, utiliza_conversao INTEGER,
    ativo INTEGER DEFAULT 1, saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0,
    estoque_atual REAL DEFAULT 0, reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0,
    updated_at DATETIME
  )`);
  await garantirSchemaProdutoConversaoAsync(db);
  await run(db, `CREATE TABLE produto_embalagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER, tipo TEXT, quantidade REAL,
    unidade TEXT, principal INTEGER, compra INTEGER, venda INTEGER, estoque INTEGER, ativa INTEGER
  )`);
  await run(db, `CREATE TABLE produtos_ajustes_estoque (
    id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER, usuario_id INTEGER, usuario_nome TEXT,
    motivo TEXT, ajuste_fiscal REAL, ajuste_nao_fiscal REAL, saldo_fiscal_antes REAL, saldo_fiscal_depois REAL,
    saldo_nao_fiscal_antes REAL, saldo_nao_fiscal_depois REAL, estoque_total_antes REAL, estoque_total_depois REAL
  )`);
  const empresa = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'Matriz' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'Outra' }, { db });
  return { db, empresa, empresaB };
}

async function criarCoca(db, extras = {}) {
  const nome = extras.nome || 'Coca-Cola 1,5 L';
  const fator = extras.fatorMl || 1500;
  const r = await run(db, `INSERT INTO produtos (
    nome, nome_busca, codigo, unidade, unidade_comercial, unidade_estoque, utiliza_conversao, ativo
  ) VALUES (?, ?, ?, 'UN', 'UN', 'ML', 1, 1)`, [nome, nome.toLowerCase(), extras.codigo || '64896']);
  await run(db, `INSERT INTO produto_embalagens (produto_id, tipo, quantidade, unidade, principal, venda, compra, estoque, ativa)
    VALUES (?, 'UN', ?, 'ML', 1, 1, 1, 1, 1)`, [r.lastID, fator]);
  await ProdutoConversaoConfigService.salvarConfiguracao(db, r.lastID, {
    utiliza_conversao: 1,
    unidade_estoque: 'ML',
    apresentacoes: [{ tipo: 'UN', quantidade: fator, unidade: 'ML', principal: 1, venda: 1, compra: 1, ativa: 1 }]
  }).catch(() => {});
  await run(db, `INSERT OR IGNORE INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator) VALUES (?, 'UN', 'ML', ?)`, [r.lastID, fator]);
  return r.lastID;
}

async function saldo(db, empresaId, produtoId, f, nf) {
  await run(db, 'UPDATE produtos SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ? WHERE id = ?', [f, nf, f + nf, produtoId]);
  await EstoqueEmpresaService.criarRegistro({ produtoId, empresaId, saldo_fiscal: f, saldo_nao_fiscal: nf, estoque_atual: f + nf }, { db });
}

async function lerSaldo(db, empresaId, produtoId) {
  const row = await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  return {
    fiscal: Number(row.saldoFiscal != null ? row.saldoFiscal : row.saldo_fiscal),
    naoFiscal: Number(row.saldoNaoFiscal != null ? row.saldoNaoFiscal : row.saldo_nao_fiscal)
  };
}

async function previewOficial(db, empresaId, corpo) {
  return EstoqueContagemFisicaService.previsualizarContagem(Object.assign({ db, empresaId }, corpo));
}

function itemOficial(preview) {
  const linha = ui.snapshotDaLinha(preview, { nome: 'Coca-Cola 1,5 L', codigo: '64896' });
  return mobile.montarConfirmacao([linha], { f12On: !!preview.omitir_nao_fiscal, chave: 'mobile-teste' }).body.itens[0];
}

describe('CDS-ESTOQUE-CONTAGEM-MOBILE-01', { concurrency: false }, () => {
  it('1 o hub e a rota oficial abrem a Contagem Física', () => {
    assert.match(HUB, /id="mi-contagem"/);
    assert.match(HUB, /href="\/mobile-contagem\/"/);
    assert.match(HUB, /Contagem Física/);
    assert.match(SERVIDOR, /\/mobile-contagem', '\/mobile-contagem\/'/);
    assert.equal(acesso.destinoNavegacaoSeguro('/mobile-contagem'), '/mobile-contagem');
    assert.match(HTML, /href="\/mobile\/"/);
    assert.match(HTML, /mobile-pedido\.css/);
    assert.match(HTML, /id="mc-empresa"/);
  });

  it('2 usuário sem permissão de ajuste não opera a contagem', () => {
    assert.equal(mobile.podeOperar({ perfil: 'OPERADOR', role: 'operador' }), false);
    assert.equal(mobile.podeOperar({ perfil: 'ADMIN', role: 'operador' }), true);
    assert.equal(mobile.podeOperar({ role: 'admin' }), true);
    assert.match(ler('frontend/mobile/mobile-inicio.js'), /mi-contagem/);
    assert.match(JS, /podeOperar\(\)/);
    assert.match(HTML, /Acesso não autorizado/);
    assert.match(ler('backend/middleware/auth.js'), /exigirPerfilAjusteEstoque/);
  });

  it('3 a 5 pesquisa, saldo e inclusão usam as APIs oficiais e não confirmam', () => {
    assert.match(JS, /\/api\/estoque\/contagem-fisica\/produtos-busca/);
    assert.match(JS, /\/api\/estoque\/contagem-fisica\/saldo-atual/);
    assert.match(JS, /\/api\/estoque\/contagem-fisica\/preview/);
    const incluir = JS.slice(JS.indexOf('async function incluir'), JS.indexOf('async function salvarEdicao'));
    assert.doesNotMatch(incluir, /montarConfirmacao|CONFIRMAR/);
    const preview = {
      produto_id: 1, saldo_fiscal_esperado: 24000, saldo_nao_fiscal_esperado: 0,
      quantidade_fiscal_contada: 15000, quantidade_nao_fiscal_contada: 0,
      tipo_ajuste: 'BAIXA', operacao: 'AJUSTE_DIRECIONADO'
    };
    const incluso = ui.incluirNaLista([], preview, { nome: 'Coca-Cola 1,5 L' });
    assert.equal(incluso.ok, true);
    assert.equal(incluso.linhas.length, 1);
  });

  it('6 e 7 OFF é baixa e ON é acréscimo, com conversão oficial', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db);
    await saldo(db, empresa.id, id, 24000, 0);
    const baixa = mobile.corpoPreview({ id, unidade_comercial: 'UN' }, 10, 0, { tipoAjuste: 'BAIXA', f12On: false });
    const entrada = mobile.corpoPreview({ id, unidade_comercial: 'UN' }, 10, 0, { tipoAjuste: 'ON', f12On: false });
    const pBaixa = await previewOficial(db, empresa.id, baixa);
    const pEntrada = await previewOficial(db, empresa.id, entrada);
    assert.equal(pBaixa.tipo_ajuste, 'BAIXA');
    assert.equal(pBaixa.quantidade_fiscal_convertida, 15000);
    assert.equal(pBaixa.saldo_fiscal_previsto, 9000);
    assert.equal(pEntrada.tipo_ajuste, 'ACRESCIMO');
    assert.equal(pEntrada.saldo_fiscal_previsto, 39000);
    assert.equal(await lerSaldo(db, empresa.id, id).then((s) => s.fiscal), 24000);
    await closeDb(db);
  });

  it('8 cada item preserva o próprio tipo', () => {
    const baixa = ui.snapshotDaLinha({
      produto_id: 1, operacao: 'AJUSTE_DIRECIONADO', tipo_ajuste: 'BAIXA',
      saldo_fiscal_esperado: 24000, saldo_nao_fiscal_esperado: 0,
      saldo_fiscal_previsto: 9000, quantidade_fiscal_contada: 15000, quantidade_nao_fiscal_contada: 0,
      diferenca_fiscal: -15000, diferenca_nao_fiscal: 0
    }, { nome: 'Coca' });
    const agua = ui.snapshotDaLinha({
      produto_id: 2, operacao: 'AJUSTE_DIRECIONADO', tipo_ajuste: 'ACRESCIMO',
      saldo_fiscal_esperado: 5000, saldo_nao_fiscal_esperado: 0,
      saldo_fiscal_previsto: 15000, quantidade_fiscal_contada: 10000, quantidade_nao_fiscal_contada: 0,
      diferenca_fiscal: 10000, diferenca_nao_fiscal: 0
    }, { nome: 'Água' });
    const editado = ui.atualizarLinhaPorPreview([baixa, agua], 1, {
      produto_id: 2, tipo_ajuste: 'BAIXA', operacao: 'AJUSTE_DIRECIONADO',
      saldo_fiscal_esperado: 5000, saldo_nao_fiscal_esperado: 0, saldo_fiscal_previsto: 3000,
      quantidade_fiscal_contada: 2000, quantidade_nao_fiscal_contada: 0,
      diferenca_fiscal: -2000, diferenca_nao_fiscal: 0
    }, { nome: 'Água' });
    assert.equal(editado.linhas[0].tipo_ajuste, 'BAIXA');
    assert.equal(editado.linhas[0].saldo_fiscal_previsto, 9000);
    assert.equal(editado.linhas[1].tipo_ajuste, 'BAIXA');
    assert.equal(mobile.contextoDaLinha(editado.linhas[0]).tipoAjuste, 'BAIXA');
  });

  it('9 editar e remover não geram confirmação', () => {
    const editar = JS.slice(JS.indexOf('async function salvarEdicao'), JS.indexOf('function pintarRevisao'));
    const remover = JS.slice(JS.indexOf('data-mc-rm'), JS.indexOf('data-mc-edit'));
    assert.doesNotMatch(editar, /montarConfirmacao/);
    assert.doesNotMatch(remover, /montarConfirmacao/);
    const linhas = [{ produto_id: 1 }, { produto_id: 2 }];
    assert.equal(ui.removerDaLista(linhas, 0).length, 1);
  });

  it('10 a conversão exibida vem do backend, sem multiplicar no mobile', () => {
    assert.doesNotMatch(JS, /quantidade\s*\*\s*fator|fator\s*\*\s*q/);
    assert.match(JS, /textoConversao/);
    const texto = ui.textoConversao({
      quantidade_fiscal_informada: 10, quantidade_fiscal_contada: 15000,
      unidade_informada: 'UN', unidade_base: 'ML', fator_total: 1500
    }, 'fiscal');
    assert.match(texto, /10/);
    assert.match(texto, /1\.500|1500/);
    assert.match(texto, /15\.000|15000/);
  });

  it('11 contagem física absoluta informa a quantidade encontrada', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'ABS' });
    await saldo(db, empresa.id, id, 24000, 0);
    const corpo = mobile.corpoPreview({ id, unidade_comercial: 'UN' }, 10, 0, { operacao: 'CONTAGEM_FISICA', f12On: false });
    assert.equal(corpo.operacao, 'CONTAGEM_FISICA');
    assert.equal(corpo.tipo_ajuste, undefined);
    const preview = await previewOficial(db, empresa.id, corpo);
    assert.equal(preview.quantidade_fiscal_contada, 15000);
    assert.equal(preview.diferenca_fiscal, -9000);
    const conf = await EstoqueContagemFisicaService.registrarContagemFisica({
      db, empresaId: empresa.id, chaveIdempotencia: 'mobile-abs',
      itens: exigirSnapshotItensOficiais([itemOficial(preview)])
    });
    assert.equal(conf.itens[0].tipo_ajuste, null);
    assert.equal((await lerSaldo(db, empresa.id, id)).fiscal, 15000);
    await closeDb(db);
  });

  it('12 e 13 F12 ON omite o não fiscal e F12 OFF envia os dois', () => {
    const on = mobile.corpoPreview({ id: 1, unidade_comercial: 'UN' }, 10, 2, { tipoAjuste: 'BAIXA', f12On: true });
    const off = mobile.corpoPreview({ id: 1, unidade_comercial: 'UN' }, 10, 2, { tipoAjuste: 'BAIXA', f12On: false });
    assert.equal(on.omitir_nao_fiscal, true);
    assert.equal(on.quantidade_nao_fiscal_informada, undefined);
    assert.equal(off.quantidade_fiscal_informada, 10);
    assert.equal(off.quantidade_nao_fiscal_informada, 2);
    assert.match(HTML, /id="mc-wrap-qnf"/);
  });

  it('14 snapshot desatualizado é tratado sem nova movimentação silenciosa', async () => {
    assert.match(JS, /CONTAGEM_DESATUALIZADA/);
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'SNAP' });
    await saldo(db, empresa.id, id, 24000, 0);
    const corpo = mobile.corpoPreview({ id, unidade_comercial: 'UN' }, 10, 0, { tipoAjuste: 'BAIXA' });
    const preview = await previewOficial(db, empresa.id, corpo);
    await run(db, 'UPDATE estoque_empresa SET saldo_fiscal = 20000, estoque_atual = 20000 WHERE produto_id = ? AND empresa_id = ?', [id, empresa.id]);
    await run(db, 'UPDATE produtos SET saldo_fiscal = 20000, estoque_atual = 20000 WHERE id = ?', [id]);
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db, empresaId: empresa.id, chaveIdempotencia: 'mobile-stale',
        itens: exigirSnapshotItensOficiais([itemOficial(preview)])
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.equal((await lerSaldo(db, empresa.id, id)).fiscal, 20000);
    await closeDb(db);
  });

  it('15 a confirmação envia chave de idempotência e o retry não duplica', async () => {
    const linha = ui.snapshotDaLinha({
      produto_id: 1, tipo_ajuste: 'BAIXA', operacao: 'AJUSTE_DIRECIONADO',
      quantidade_fiscal_informada: 10, quantidade_fiscal_contada: 15000,
      quantidade_nao_fiscal_informada: 0, quantidade_nao_fiscal_contada: 0,
      saldo_fiscal_esperado: 24000, saldo_nao_fiscal_esperado: 0, unidade_informada: 'UN'
    }, { nome: 'Coca' });
    const pedido = mobile.montarConfirmacao([linha], { chave: 'chave-1', f12On: false, observacao: '' });
    assert.equal(pedido.url, '/api/estoque/contagem-fisica');
    assert.equal(pedido.headers['Idempotency-Key'], 'chave-1');
    assert.equal(pedido.body.itens[0].tipo_ajuste, 'BAIXA');
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'IDEM' });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await previewOficial(db, empresa.id, mobile.corpoPreview({ id, unidade_comercial: 'UN' }, 10, 0, { tipoAjuste: 'ACRESCIMO' }));
    const item = itemOficial(preview);
    const a = await EstoqueContagemFisicaService.registrarContagemFisica({
      db, empresaId: empresa.id, chaveIdempotencia: 'mobile-retry', itens: exigirSnapshotItensOficiais([item])
    });
    const b = await EstoqueContagemFisicaService.registrarContagemFisica({
      db, empresaId: empresa.id, chaveIdempotencia: 'mobile-retry', itens: exigirSnapshotItensOficiais([item])
    });
    assert.equal(b.id, a.id);
    assert.equal((await lerSaldo(db, empresa.id, id)).fiscal, 39000);
    await closeDb(db);
  });

  it('16 falha de um item reverte o lote', async () => {
    const { db, empresa } = await setup();
    const coca = await criarCoca(db, { nome: 'Coca', codigo: 'C16' });
    const agua = await criarCoca(db, { nome: 'Água', codigo: 'A16', fatorMl: 500 });
    await saldo(db, empresa.id, coca, 24000, 0);
    await saldo(db, empresa.id, agua, 5000, 0);
    const p1 = await previewOficial(db, empresa.id, mobile.corpoPreview({ id: coca, unidade_comercial: 'UN' }, 10, 0, { tipoAjuste: 'BAIXA' }));
    const p2 = await previewOficial(db, empresa.id, mobile.corpoPreview({ id: agua, unidade_comercial: 'UN' }, 4, 0, { tipoAjuste: 'ACRESCIMO' }));
    const ruim = itemOficial(p2);
    ruim.produto_id = agua;
    ruim.saldo_fiscal_esperado = 1;
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db, empresaId: empresa.id, chaveIdempotencia: 'mobile-lote',
        itens: exigirSnapshotItensOficiais([Object.assign(itemOficial(p1), { produto_id: coca }), ruim])
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.equal((await lerSaldo(db, empresa.id, coca)).fiscal, 24000);
    assert.equal((await lerSaldo(db, empresa.id, agua)).fiscal, 5000);
    await closeDb(db);
  });

  it('17 baixa acima do saldo é bloqueada antes da inclusão', async () => {
    const { db, empresa } = await setup();
    const id = await criarCoca(db, { codigo: 'INS' });
    await saldo(db, empresa.id, id, 24000, 0);
    const preview = await previewOficial(db, empresa.id, mobile.corpoPreview({ id, unidade_comercial: 'UN' }, 20, 0, { tipoAjuste: 'BAIXA' }));
    assert.equal(preview.saldo_insuficiente, true);
    const incluso = ui.incluirNaLista([], preview, { nome: 'Coca' });
    assert.equal(incluso.ok, false);
    assert.equal(incluso.code, 'SALDO_INSUFICIENTE');
    await closeDb(db);
  });

  it('18 a empresa A não altera a empresa B', async () => {
    const { db, empresa, empresaB } = await setup();
    const id = await criarCoca(db, { codigo: 'ISO' });
    await saldo(db, empresa.id, id, 24000, 0);
    await saldo(db, empresaB.id, id, 8000, 400);
    await run(db, 'UPDATE produtos SET saldo_fiscal = 24000, saldo_nao_fiscal = 0, estoque_atual = 24000 WHERE id = ?', [id]);
    const preview = await previewOficial(db, empresa.id, mobile.corpoPreview({ id, unidade_comercial: 'UN' }, 10, 0, { tipoAjuste: 'BAIXA' }));
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db, empresaId: empresa.id, chaveIdempotencia: 'mobile-iso',
      itens: exigirSnapshotItensOficiais([itemOficial(preview)])
    });
    assert.equal((await lerSaldo(db, empresa.id, id)).fiscal, 9000);
    assert.deepEqual(await lerSaldo(db, empresaB.id, id), { fiscal: 8000, naoFiscal: 400 });
    await closeDb(db);
  });

  it('19 sucesso limpa a lista, volta o switch para OFF e mostra o retorno', () => {
    const estado = { linhas: [{ produto_id: 1 }], tipo: 'ACRESCIMO', operacao: 'CONTAGEM_FISICA', chave: 'k', confirmando: true };
    mobile.aplicarSucesso(estado);
    assert.deepEqual(estado.linhas, []);
    assert.equal(estado.tipo, 'BAIXA');
    assert.equal(estado.operacao, 'AJUSTE_DIRECIONADO');
    assert.equal(estado.chave, null);
    assert.match(JS, /Contagem confirmada/);
    assert.match(JS, /Confirmando…/);
    assert.doesNotMatch(JS, /setTimeout\(\s*confirmar|setInterval/);
  });

  it('20 não há movimentação de estoque no código anterior à confirmação e o desktop permanece', () => {
    assert.match(JS, /const CONFIRMAR = '\/api\/estoque\/contagem-fisica'/);
    assert.doesNotMatch(JS, /fetch\(CONFIRMAR/);
    assert.match(JS, /postJson\(pedido\.url/);
    assert.match(CSS, /overflow-x:\s*hidden/);
    assert.match(CSS, /min-height:\s*52px/);
    assert.match(CSS, /mc-card/);
    assert.doesNotMatch(HTML, /<table/);
    assert.match(DESKTOP, /id="cef-switch-ajuste"/);
    assert.doesNotMatch(DESKTOP, /mc-app|mobile-contagem/);
  });
});
