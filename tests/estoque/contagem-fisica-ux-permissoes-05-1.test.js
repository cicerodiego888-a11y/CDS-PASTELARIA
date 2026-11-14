/**
 * SPRINT CDS-ESTOQUE-CONTAGEM-UX-PERMISSOES-05.1
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/estoque/contagem-fisica-ux-permissoes-05-1.test.js
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-contagem-ux-05-1-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { JWT_SECRET, verificarToken } = require('../../backend/middleware/auth');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const {
  buscarProdutosParaContagem
} = require('../../backend/services/estoque/EstoqueContagemProdutoBuscaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  garantirSchemaUsuarioEmpresasAsync
} = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaEstoqueContagemFisicaAsync } = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const {
  garantirSchemaEstoqueContagemPeriodicidadeAsync
} = require('../../backend/services/estoque/estoqueContagemPeriodicidadeSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const { exigirSnapshotItensOficiais } = require('../../backend/services/estoque/contagemFisicaSnapshotOficial');
const {
  obterPeriodicidade,
  salvarPeriodicidade,
  listarHistoricoContagens
} = require('../../backend/services/estoque/EstoqueContagemPeriodicidadeService');
const estoqueRotasModulo = require('../../backend/rotas/estoque');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

const ROOT = path.resolve(__dirname, '../..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'frontend/erp/index.html'), 'utf8');
const ACCESS_JS = fs.readFileSync(path.join(ROOT, 'frontend/shared/js/access-control.js'), 'utf8');
const CONTAGEM_UI = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/contagem-estoque.js'), 'utf8');
const GESTAO_UI = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/gestao-empresas-fiscal.js'), 'utf8');
const ROTAS = fs.readFileSync(path.join(ROOT, 'backend/rotas/estoque.js'), 'utf8');
const AUTH_MW = fs.readFileSync(path.join(ROOT, 'backend/middleware/auth.js'), 'utf8');
const BUSCA_SRC = fs.readFileSync(
  path.join(ROOT, 'backend/services/estoque/EstoqueContagemProdutoBuscaService.js'),
  'utf8'
);

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

function tokenPara(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

function httpJson(port, method, urlPath, { token, empresaId, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        Authorization: token ? `Bearer ${token}` : '',
        'Content-Type': 'application/json',
        ...(empresaId != null ? { 'X-Empresa-Id': String(empresaId) } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function simularPodeAjustarEstoque(user) {
  const perfil = String(user.perfil || user.nivel || '').trim().toUpperCase();
  return user.role === 'admin' || perfil === 'SUPER_ADMIN' || perfil === 'ADMIN';
}

function simularUsuarioTemPermissaoContagem(user) {
  // Espelha access-control após 05.1: contagem-estoque → podeAjustarEstoque
  return simularPodeAjustarEstoque(user);
}

function simularMenuVisivel(user) {
  return simularUsuarioTemPermissaoContagem(user);
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await garantirSchemaEstoqueContagemPeriodicidadeAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      nome_busca TEXT,
      codigo TEXT,
      codigo_barras TEXT,
      unidade TEXT,
      unidade_comercial TEXT,
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
  await run(db, `
    CREATE TABLE produtos_ajustes_estoque (
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
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function inserirProduto(db, dados) {
  const r = await run(
    db,
    `INSERT INTO produtos (nome, nome_busca, codigo, codigo_barras, unidade_comercial, tipo_operacional, ativo)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [
      dados.nome,
      (dados.nome || '').toLowerCase(),
      dados.codigo || null,
      dados.codigo_barras || null,
      dados.unidade || 'UN',
      dados.tipo_operacional || 'COMERCIAL'
    ]
  );
  return r.lastID;
}

describe('CDS-ESTOQUE-CONTAGEM-UX-PERMISSOES-05.1', { concurrency: false }, () => {
  let db;
  let empresaA;
  let empresaB;
  let server;
  let port;
  let tokenAdmin;
  let tokenOperador;

  before(async () => {
    ({ db, empresaA, empresaB } = await setupBase());
    tokenAdmin = tokenPara({ id: 1, username: 'admin', role: 'admin', perfil: 'ADMIN' });
    tokenOperador = tokenPara({ id: 2, username: 'op', role: 'operador', perfil: 'USUARIO' });

    // Vínculo: operador tem empresa, mas sem perfil de ajuste → 403 AJUSTE_ESTOQUE.
    await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });

    const app = express();
    app.use(express.json());
    // Espelha server.js: verificarToken antes das rotas de estoque.
    const router = estoqueRotasModulo.criarRotasEstoque(db);
    app.use('/api/estoque', verificarToken, router);
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb(db);
  });

  it('01 operador autorizado visualiza Contagem Física no menu', () => {
    assert.match(INDEX_HTML, /data-nav-group="estoque"/);
    assert.match(INDEX_HTML, /data-page="contagem-estoque"/);
    assert.match(INDEX_HTML, />Contagem Física</);
    assert.equal(simularMenuVisivel({ role: 'admin', perfil: 'ADMIN' }), true);
    assert.equal(simularMenuVisivel({ role: 'operador', perfil: 'ADMIN' }), true);
    assert.equal(simularMenuVisivel({ role: 'operador', perfil: 'SUPER_ADMIN' }), true);
    assert.match(ACCESS_JS, /page === 'contagem-estoque'/);
    assert.match(ACCESS_JS, /podeAjustarEstoque/);
  });

  it('02 operador sem permissão não visualiza a opção', () => {
    assert.equal(simularMenuVisivel({ role: 'operador', perfil: 'USUARIO', permissoes: ['produtos'] }), false);
    assert.equal(simularMenuVisivel({ role: 'operador', perfil: 'CAIXA' }), false);
    // Página não mapeia mais para produtos.
    assert.doesNotMatch(ACCESS_JS, /'contagem-estoque':\s*'produtos'/);
  });

  it('03 acesso direto sem permissão é rejeitado', () => {
    assert.match(CONTAGEM_UI, /Acesso não autorizado/);
    assert.match(CONTAGEM_UI, /podeAcessarContagem|podeAjustarEstoque/);
    assert.equal(simularUsuarioTemPermissaoContagem({ role: 'operador', perfil: 'USUARIO' }), false);
  });

  it('04 API rejeita confirmação sem autorização', async () => {
    const r = await httpJson(port, 'POST', '/api/estoque/contagem-fisica', {
      token: tokenOperador,
      empresaId: empresaA.id,
      body: { itens: [] }
    });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'AJUSTE_ESTOQUE_NAO_AUTORIZADO');
    assert.match(AUTH_MW, /AJUSTE_ESTOQUE_NAO_AUTORIZADO/);
    assert.match(ROTAS, /exigirPerfilAjusteEstoque/);
  });

  it('05 empresa selecionada respeita o contexto do usuário', async () => {
    assert.match(CONTAGEM_UI, /X-Empresa-Id|CdsEmpresaContexto/);
    assert.match(ROTAS, /criarMiddlewareContextoEmpresa|exigirContexto/);
    const r = await httpJson(port, 'GET', '/api/estoque/contagem-fisica/produtos-busca?q=x', {
      token: tokenAdmin
      // sem X-Empresa-Id
    });
    assert.ok(r.status === 400 || r.status === 403 || r.status === 422);
  });

  it('06 administrador autorizado consegue acessar', async () => {
    assert.equal(simularMenuVisivel({ role: 'admin', perfil: 'ADMIN' }), true);
    const r = await httpJson(port, 'GET', '/api/estoque/contagem-fisica/historico?limite=5', {
      token: tokenAdmin,
      empresaId: empresaA.id
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  it('07 busca pelo nome completo', async () => {
    await inserirProduto(db, { nome: 'Coca-Cola 2L', codigo: 'CC2L', codigo_barras: '7891000100103' });
    const out = await buscarProdutosParaContagem(db, 'Coca-Cola 2L');
    assert.ok(out.itens.some((p) => p.nome === 'Coca-Cola 2L'));
  });

  it('08 busca parcial pelo nome', async () => {
    const out = await buscarProdutosParaContagem(db, 'Coca');
    assert.ok(out.itens.length >= 1);
    assert.ok(out.itens.every((p) => /coca/i.test(p.nome)));
  });

  it('09 busca pelo código de barras', async () => {
    const out = await buscarProdutosParaContagem(db, '7891000100103');
    assert.equal(out.itens.length, 1);
    assert.equal(out.itens[0].codigo_barras, '7891000100103');
  });

  it('10 busca pelo código interno', async () => {
    const out = await buscarProdutosParaContagem(db, 'CC2L');
    assert.ok(out.itens.some((p) => p.codigo === 'CC2L'));
    assert.equal(out.itens[0].codigo_interno, out.itens[0].codigo);
  });

  it('11 produto selecionado utiliza o ID correto internamente', async () => {
    const out = await buscarProdutosParaContagem(db, 'CC2L');
    const hit = out.itens[0];
    assert.ok(Number.isInteger(hit.id) && hit.id > 0);
    assert.equal(hit.produto_id, hit.id);
    assert.match(CONTAGEM_UI, /produto_id:\s*produtoId|produtoSelecionado\.id/);
    assert.match(CONTAGEM_UI, /Pesquisar produto/);
    assert.doesNotMatch(CONTAGEM_UI, /Produto ID/);
  });

  it('12 produto inexistente não pode ser incluído', async () => {
    const out = await buscarProdutosParaContagem(db, 'produto-inexistente-xyz-999');
    assert.equal(out.total, 0);
    assert.match(CONTAGEM_UI, /Nenhum produto encontrado/);
    assert.match(CONTAGEM_UI, /Selecione um produto na pesquisa/);
  });

  it('13 múltiplos resultados permitem seleção correta', async () => {
    await inserirProduto(db, { nome: 'Coca-Cola 1L', codigo: 'CC1L', codigo_barras: '7891000100104' });
    await inserirProduto(db, { nome: 'Coca-Cola Lata 350ml', codigo: 'CCLATA', codigo_barras: '7891000100105' });
    const out = await buscarProdutosParaContagem(db, 'Coca-Cola');
    assert.ok(out.itens.length >= 3);
    const umL = out.itens.find((p) => p.codigo === 'CC1L');
    assert.ok(umL);
    assert.equal(umL.nome, 'Coca-Cola 1L');
    assert.match(CONTAGEM_UI, /data-cef-prod-id/);
  });

  it('14 produto duplicado é tratado corretamente', () => {
    assert.match(CONTAGEM_UI, /Produto já está na lista/);
    assert.match(CONTAGEM_UI, /linhas\.some/);
  });

  it('15 busca não mistura indevidamente empresas', async () => {
    // Catálogo compartilhado: busca lê produtos; estoque continua isolado por empresa.
    assert.match(BUSCA_SRC, /FROM produtos/);
    assert.doesNotMatch(BUSCA_SRC, /consulta-pdv|origemPdvExigeVendavel/);
    const pid = await inserirProduto(db, { nome: 'Farinha Especial', codigo: 'FAR01' });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: pid,
      empresaId: empresaA.id,
      saldo_fiscal: 5,
      saldo_nao_fiscal: 0,
      estoque_atual: 5
    }, { db });
    const saldoB = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: pid,
      empresaId: empresaB.id,
      db
    });
    assert.equal(saldoB, null);
  });

  it('16 preview continua retornando snapshot', async () => {
    const pid = await inserirProduto(db, { nome: 'Item Preview', codigo: 'PRV1' });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: pid,
      empresaId: empresaA.id,
      saldo_fiscal: 10,
      saldo_nao_fiscal: 2,
      estoque_atual: 12
    }, { db });
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 9,
      quantidade_nao_fiscal_contada: 2
    });
    assert.equal(preview.saldo_fiscal_esperado, 10);
    assert.equal(preview.saldo_nao_fiscal_esperado, 2);
    assert.equal(preview.diferenca_fiscal, -1);
  });

  it('17 confirmação continua exigindo snapshot', () => {
    assert.match(ROTAS, /exigirSnapshotItensOficiais/);
    assert.match(CONTAGEM_UI, /saldo_fiscal_esperado/);
    assert.match(CONTAGEM_UI, /saldo_nao_fiscal_esperado/);
  });

  it('18 snapshot desatualizado continua bloqueado', async () => {
    const pid = await inserirProduto(db, { nome: 'Item Conflito', codigo: 'CNF1' });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: pid,
      empresaId: empresaA.id,
      saldo_fiscal: 20,
      saldo_nao_fiscal: 0,
      estoque_atual: 20
    }, { db });
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'ux-18',
        itens: exigirSnapshotItensOficiais([{
          produto_id: pid,
          quantidade_fiscal_contada: 10,
          quantidade_nao_fiscal_contada: 0,
          saldo_fiscal_esperado: 99,
          saldo_nao_fiscal_esperado: 0
        }])
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
  });

  it('19 alertas da Central continuam funcionando', () => {
    assert.match(CONTAGEM_UI, /pendencias-entrada/);
    assert.match(CONTAGEM_UI, /EXISTEM ENTRADAS PENDENTES|cef-alerta-pendencias/);
    assert.match(ROTAS, /pendencias-entrada/);
  });

  it('20 periodicidade continua funcionando', async () => {
    const cfg = await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'QUINZENAL' });
    assert.equal(cfg.periodicidade, 'QUINZENAL');
    assert.equal((await obterPeriodicidade(db, empresaA.id)).intervalo_dias, 15);
    assert.match(CONTAGEM_UI, /status-periodicidade/);
    assert.match(CONTAGEM_UI, /Salvar periodicidade/);
  });

  it('21 histórico continua sendo apresentado', async () => {
    const hist = await listarHistoricoContagens(db, empresaA.id, { limite: 10 });
    assert.equal(hist.ok, true);
    assert.match(CONTAGEM_UI, /cef-historico-tbody|Histórico recente/);
  });

  it('22 saldos fiscais e não fiscais continuam separados', async () => {
    const pid = await inserirProduto(db, { nome: 'Item Dual', codigo: 'DUAL1' });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: pid,
      empresaId: empresaA.id,
      saldo_fiscal: 7,
      saldo_nao_fiscal: 3,
      estoque_atual: 10
    }, { db });
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 7,
      quantidade_nao_fiscal_contada: 1
    });
    assert.equal(preview.diferenca_fiscal, 0);
    assert.equal(preview.diferenca_nao_fiscal, -2);
  });

  it('23 nenhuma alteração indevida de estoque ocorre durante a pesquisa', async () => {
    const pid = await inserirProduto(db, { nome: 'Item Estavel', codigo: 'EST1', codigo_barras: '111' });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: pid,
      empresaId: empresaA.id,
      saldo_fiscal: 4,
      saldo_nao_fiscal: 1,
      estoque_atual: 5
    }, { db });
    const antes = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: pid,
      empresaId: empresaA.id,
      db
    });
    await buscarProdutosParaContagem(db, 'Item Estavel');
    await buscarProdutosParaContagem(db, '111');
    const depois = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: pid,
      empresaId: empresaA.id,
      db
    });
    assert.equal(depois.saldo_fiscal, antes.saldo_fiscal);
    assert.equal(depois.saldo_nao_fiscal, antes.saldo_nao_fiscal);
    assert.doesNotMatch(BUSCA_SRC, /UPDATE|INSERT|DELETE/);
  });

  it('fonte: botão removido da empresa e menu Estoque presente', () => {
    assert.doesNotMatch(GESTAO_UI, /gef-abrir-contagem/);
    assert.doesNotMatch(GESTAO_UI, /Abrir contagem física/);
    assert.match(GESTAO_UI, /Estoque → Contagem Física/);
    assert.match(INDEX_HTML, /data-nav-group="estoque"/);
  });

  it('rota produtos-busca protegida e antes de :id', () => {
    assert.match(ROTAS, /contagem-fisica\/produtos-busca/);
    const iBusca = ROTAS.indexOf("'/contagem-fisica/produtos-busca'");
    const iId = ROTAS.indexOf("'/contagem-fisica/:id'");
    assert.ok(iBusca > 0 && iId > iBusca);
  });
});
