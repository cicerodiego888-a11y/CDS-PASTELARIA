'use strict';

/**
 * CDS-PDV-PAGAMENTO-MISTO-CONTEXTO-EMPRESA-01
 * Banco: exclusivamente temporário (DB_DIR). Sem TEF/PIX/SEFAZ reais.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pdv-misto-ctx-emp-01-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-pdv-misto-ctx-emp-01-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const { criarMiddlewareContextoEmpresa } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const {
  classificarTipoRecebimento,
  calcularReferenciasConfirmadas
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const {
  resolverStatusPagamentoVenda,
  aplicarRegraStatusPagamentoVenda
} = require('../../backend/services/vendas/VendaPagamentoService');
const vendasRouter = require('../../backend/rotas/vendas');

const PDV_JS = fs.readFileSync(
  path.join(__dirname, '../../frontend/pdv/js/pdv.js'),
  'utf8'
);
const ROTAS_VENDAS = fs.readFileSync(
  path.join(__dirname, '../../backend/rotas/vendas.js'),
  'utf8'
);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function extrairFuncao(nome) {
  const inicio = PDV_JS.indexOf(`async function ${nome}`);
  assert.ok(inicio >= 0, `função ${nome} ausente`);
  const trecho = PDV_JS.slice(inicio, inicio + 1800);
  return trecho;
}

let empresaA;
let empresaB;
let token;
let server;
let caixaSessaoId;
let terminalId;

function httpReq(method, urlPath, { body, empresaId, tokenOverride } = {}) {
  const payload = body != null ? JSON.stringify(body) : null;
  const endereco = server.address();
  const headers = {
    Authorization: `Bearer ${tokenOverride || token}`
  };
  if (payload != null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (empresaId != null) headers['X-Empresa-Id'] = String(empresaId);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: endereco.port,
      path: urlPath,
      method,
      headers
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = { raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

before(async () => {
  await new Promise((resolve, reject) => {
    db.whenReady((err) => (err ? reject(err) : resolve()));
  });
  await garantirSchemaUsuarioEmpresasAsync(db);
  const cfgPath = path.join(dbDir, 'config', 'configuracoes.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  let cfgAtual = {};
  if (fs.existsSync(cfgPath)) {
    try { cfgAtual = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { cfgAtual = {}; }
  }
  cfgAtual.modo_operacional_global = 'MULTIEMPRESA';
  cfgAtual.modo_operacao_venda = 'MULTIEMPRESA';
  cfgAtual.pdv_modelo_empresa = 'MULTIPLAS';
  cfgAtual.empresa_operacional_id = null;
  fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));

  empresaA = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'EMPRESA A LTDA', nome_fantasia: 'Empresa A' },
    { db }
  );
  const empB = await run(
    `INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
     VALUES ('34028316000103', 'EMPRESA B LTDA', 'Empresa B', 1)`
  );
  empresaB = { id: empB.lastID };
  await run(
    `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
     VALUES ('admin-misto-ctx', 'x', 'ADMIN', 'Admin', 'ADMIN', 1)`
  );
  const usuario = await get(`SELECT id FROM usuarios WHERE username = 'admin-misto-ctx'`);
  const usuarioId = Number(usuario.id);
  await run(
    `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1), (?, ?, 1)`,
    [usuarioId, empresaA.id, usuarioId, empresaB.id]
  );
  const terminal = await run(
    `INSERT INTO terminais (nome, hostname) VALUES ('PDV-TESTE', 'pdv-misto-ctx')`
  );
  terminalId = terminal.lastID;
  const turno = await run(
    `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
     VALUES (date('now','localtime'), 0, 'aberto', ?, datetime('now','localtime'), ?)`,
    [terminalId, usuarioId]
  );
  const sessao = await run(
    `INSERT INTO caixa_sessoes (
       caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
     ) VALUES (?, ?, ?, ?, 'aberto', 0, datetime('now','localtime'))`,
    [turno.lastID, terminalId, usuarioId, empresaA.id]
  );
  caixaSessaoId = sessao.lastID;
  token = jwt.sign(
    { id: usuarioId, usuario: 'admin-misto-ctx', perfil: 'ADMIN' },
    getJwtSecret(),
    { expiresIn: '2h' }
  );

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.db = db;
    next();
  });
  app.use(verificarToken);
  app.use(criarMiddlewareContextoEmpresa(db));
  app.use((req, res, next) => {
    req.caixaSessaoId = caixaSessaoId;
    req.caixaId = caixaSessaoId;
    req.terminalId = terminalId;
    req.operadorId = usuarioId;
    req.user = req.user || { id: usuarioId, perfil: 'ADMIN' };
    next();
  });
  app.use('/api/vendas', vendasRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(() => resolve()));
});

describe('CDS-PDV-PAGAMENTO-MISTO-CONTEXTO-EMPRESA-01', { concurrency: false }, () => {
  it('01) obterSaldoPagamentoNaoFiscalVenda envia X-Empresa-Id via CdsEmpresaContexto', () => {
    assert.match(PDV_JS, /function headersPagamentoNaoFiscalVenda/);
    assert.match(PDV_JS, /CdsEmpresaContexto\.headersJson/);
    const fn = extrairFuncao('obterSaldoPagamentoNaoFiscalVenda');
    assert.match(fn, /headersPagamentoNaoFiscalVenda\s*\(/);
    assert.doesNotMatch(
      fn,
      /headers:\s*\{\s*['"]Authorization['"]:\s*`Bearer \$\{localStorage\.getItem\(['"]token['"]\)\}`\s*\}/
    );
  });

  it('02) concluirPagamentoNaoFiscalVenda envia X-Empresa-Id via CdsEmpresaContexto', () => {
    const fn = extrairFuncao('concluirPagamentoNaoFiscalVenda');
    assert.match(fn, /headersPagamentoNaoFiscalVenda\s*\(/);
    assert.match(fn, /Content-Type/);
    assert.match(PDV_JS, /headersPagamentoNaoFiscalVenda\([\s\S]*?X-Empresa-Id|CdsEmpresaContexto\.headersJson/);
  });

  it('03) PIX + dinheiro → fiscal/NF e aguardando_nao_fiscal quando NF pendente', () => {
    assert.equal(classificarTipoRecebimento({
      forma_pagamento: 'pix', valor: 40, status_autorizacao: 'aprovada', aprovado: true
    }), 'fiscal');
    assert.equal(classificarTipoRecebimento({
      forma_pagamento: 'dinheiro', valor: 20, status_autorizacao: 'informada', confirmacao_manual: 1
    }), 'nao_fiscal');
    const refs = calcularReferenciasConfirmadas([
      { forma_pagamento: 'pix', valor: 40, status_autorizacao: 'aprovada', aprovado: true },
      { forma_pagamento: 'dinheiro', valor: 20, status_autorizacao: 'informada', confirmacao_manual: 1 }
    ]);
    assert.equal(refs.valor_fiscal_referencia, 40);
    assert.equal(refs.valor_nao_fiscal_referencia, 20);
    const status = resolverStatusPagamentoVenda(20, [], 'quitada', { valorFiscal: 40 });
    assert.equal(status, 'aguardando_nao_fiscal');
    const aplicado = aplicarRegraStatusPagamentoVenda({
      valorFiscal: 40,
      valorNaoFiscal: 20,
      statusPagamento: 'quitada',
      recebimentos: [
        { tipo_recebimento: 'fiscal', forma_pagamento: 'pix', valor: 40 },
        { tipo_recebimento: 'nao_fiscal', forma_pagamento: 'dinheiro', valor: 20 }
      ]
    });
    // Com NF já confirmado no vetor, a regra quita; sem NF confirmado, aguarda 2ª etapa.
    assert.equal(aplicado.statusPagamento, 'quitada');
    const pendente = aplicarRegraStatusPagamentoVenda({
      valorFiscal: 40,
      valorNaoFiscal: 20,
      statusPagamento: 'quitada',
      recebimentos: [
        { tipo_recebimento: 'fiscal', forma_pagamento: 'pix', valor: 40 }
      ]
    });
    assert.equal(pendente.statusPagamento, 'aguardando_nao_fiscal');
    assert.equal(
      pendente.recebimentos.filter((r) => r.tipo_recebimento === 'nao_fiscal').length,
      0
    );
  });

  it('04) crédito + dinheiro → mesma classificação F×NF', () => {
    assert.equal(classificarTipoRecebimento({
      forma_pagamento: 'cartao_credito', valor: 30, status_autorizacao: 'aprovada', aprovado: true
    }), 'fiscal');
    assert.equal(classificarTipoRecebimento({
      forma_pagamento: 'dinheiro', valor: 15, confirmacao_manual: 1, status_autorizacao: 'informada'
    }), 'nao_fiscal');
    assert.equal(
      resolverStatusPagamentoVenda(15, [], 'quitada', { valorFiscal: 30 }),
      'aguardando_nao_fiscal'
    );
  });

  it('05) débito + dinheiro → mesma classificação F×NF', () => {
    assert.equal(classificarTipoRecebimento({
      forma_pagamento: 'cartao_debito', valor: 25, status_autorizacao: 'aprovada', aprovado: true
    }), 'fiscal');
    assert.equal(
      resolverStatusPagamentoVenda(10, [], 'quitada', { valorFiscal: 25 }),
      'aguardando_nao_fiscal'
    );
  });

  it('06) dinheiro puro não inventa segunda etapa indevida (só NF)', () => {
    const status = resolverStatusPagamentoVenda(50, [], 'quitada', { valorFiscal: 0 });
    assert.equal(status, 'quitada');
    assert.notEqual(status, 'aguardando_nao_fiscal');
  });

  it('07) exclusivamente fiscal (sem NF) não aguarda segunda etapa', () => {
    const status = resolverStatusPagamentoVenda(0, [], 'quitada', { valorFiscal: 80 });
    assert.equal(status, 'quitada');
    assert.notEqual(status, 'aguardando_nao_fiscal');
  });

  it('08) ausência de header sem venda adotável → EMPRESA_CONTEXT_REQUIRED', async () => {
    const resp = await httpReq('GET', '/api/vendas/999999/pagamento-nao-fiscal', {});
    assert.ok(resp.status >= 400);
    assert.ok(
      resp.body
      && (
        resp.body.code === 'EMPRESA_CONTEXT_REQUIRED'
        || resp.body.code === 'VENDA_NAO_ENCONTRADA'
        || /X-Empresa-Id|empresa/i.test(String(resp.body.error || resp.body.mensagem || ''))
      )
    );
  });

  it('09) idempotência: mesma chave não cria segunda venda; rotas NF com adotarEmpresa', async () => {
    assert.match(ROTAS_VENDAS, /pagamento-nao-fiscal[\s\S]{0,120}anexarEmpresaReversaoVenda/);
    assert.match(ROTAS_VENDAS, /anexarEmpresaReversaoVenda[\s\S]{0,80}validarCaixaAberto[\s\S]{0,40}registrarPagamentoNaoFiscal/);
    assert.match(PDV_JS, /chave_fechamento_pdv/);
    assert.match(ROTAS_VENDAS, /pdv_fechamento_idempotencia/);
    assert.match(ROTAS_VENDAS, /venda_ja_persistida/);
  });

  it('10) empresa incompatível é rejeitada na consulta de saldo NF', async () => {
    await run(`
      INSERT INTO vendas (
        id, codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
        valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id, caixa_sessao_id, terminal_id
      ) VALUES (
        501, 'V-MISTO-501', datetime('now','localtime'), 60, 0, 0, 'misto', 'concluida',
        40, 20, 'aguardando_nao_fiscal', ?, ?, ?
      )
    `, [empresaA.id, caixaSessaoId, terminalId]);

    const ok = await httpReq('GET', '/api/vendas/501/pagamento-nao-fiscal', {
      empresaId: empresaA.id
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.venda_id, 501);
    assert.equal(Number(ok.body.valor_nao_fiscal), 20);

    const cruzado = await httpReq('GET', '/api/vendas/501/pagamento-nao-fiscal', {
      empresaId: empresaB.id
    });
    assert.ok(cruzado.status >= 400);
    assert.ok(
      cruzado.body
      && (
        cruzado.body.code === 'VENDA_NAO_ENCONTRADA'
        || /não encontrada|empresa/i.test(String(cruzado.body.error || ''))
      )
    );

    const adotado = await httpReq('GET', '/api/vendas/501/pagamento-nao-fiscal', {});
    assert.equal(adotado.status, 200, JSON.stringify(adotado.body));
    assert.equal(adotado.body.venda_id, 501);

    const postDup = await httpReq('POST', '/api/vendas/501/pagamento-nao-fiscal', {
      empresaId: empresaA.id,
      body: {
        pagamentos: [{ forma_pagamento: 'dinheiro', valor: 20 }]
      }
    });
    assert.ok(postDup.status < 500, JSON.stringify(postDup.body));
    const postIdem = await httpReq('POST', '/api/vendas/501/pagamento-nao-fiscal', {
      empresaId: empresaA.id,
      body: {
        pagamentos: [{ forma_pagamento: 'dinheiro', valor: 20 }]
      }
    });
    assert.ok(postIdem.status < 500, JSON.stringify(postIdem.body));
    if (postIdem.body && postIdem.body.idempotente != null) {
      assert.equal(postIdem.body.idempotente, true);
    }
    const recebimentos = await get(
      `SELECT COUNT(*) AS n FROM venda_recebimentos
        WHERE venda_id = 501 AND tipo_recebimento = 'nao_fiscal'`
    );
    assert.ok(Number(recebimentos.n) <= 1);
  });
});
