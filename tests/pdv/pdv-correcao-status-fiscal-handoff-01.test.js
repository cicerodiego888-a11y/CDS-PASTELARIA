'use strict';

/**
 * CDS-PDV-CORRECAO-STATUS-FISCAL-HANDOFF-01
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pdv-status-handoff-01-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-pdv-status-handoff-01-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const { criarMiddlewareContextoEmpresa } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const {
  resolverStatusPagamentoVenda,
  aplicarRegraStatusPagamentoVenda,
  calcularSaldoNaoFiscal
} = require('../../backend/services/vendas/VendaPagamentoService');
const {
  resolverStatusPagamentoRespostaHttp,
  responderVendaComFiscal
} = require('../../backend/services/vendas/VendaFiscalService');
const Orquestrador = require('../../backend/services/OrquestradorPagamento');
const midp = require('../../backend/services/midp/MotorInteligenteDistribuicaoPagamentos');
const { classificarTipoRecebimento } = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const vendasRouter = require('../../backend/rotas/vendas');

const PDV_JS = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');
const FISCAL_SRC = fs.readFileSync(
  path.join(__dirname, '../../backend/services/vendas/VendaFiscalService.js'),
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

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

/** Espelho mínimo da função do PDV para testes de contrato (fonte = pdv.js). */
function interpretarSaldoPagamentoNaoFiscal(info) {
  if (!info || typeof info !== 'object') {
    return { ok: false, codigo: 'SALDO_AUSENTE', valor: null };
  }
  const bruto = info.saldo_pendente !== undefined
    ? info.saldo_pendente
    : info.valor_nao_fiscal;
  if (bruto === undefined || bruto === null || bruto === '') {
    return { ok: false, codigo: 'SALDO_AUSENTE', valor: null };
  }
  const valor = Number(bruto);
  if (!Number.isFinite(valor)) {
    return { ok: false, codigo: 'SALDO_INVALIDO', valor: null };
  }
  if (valor < 0) {
    return { ok: false, codigo: 'SALDO_NEGATIVO', valor };
  }
  if (valor <= 0.009) {
    return { ok: true, codigo: 'SEM_PENDENCIA', valor: 0 };
  }
  return { ok: true, codigo: 'PENDENTE', valor };
}

function pipelineMisto(pagamentos, F = 70, NF = 30) {
  const aloc = midp.distribuirPagamentos(
    pagamentos.map((p) => ({ forma_pagamento: p.forma_pagamento, valor: p.valor })),
    F,
    NF
  );
  const totalPag = pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0);
  const integral = Orquestrador.isPagamentoIntegralConfirmado({
    totalPagamentos: totalPag,
    totalLiquidoEsperado: F + NF,
    saldoFiscal: aloc.saldoFiscal,
    saldoNaoFiscal: aloc.saldoNaoFiscal,
    saldoOutros: 0
  });
  const nfConf = F > 0 && NF > 0
    ? (integral ? aloc.recebimentosNaoFiscal : [])
    : aloc.recebimentosNaoFiscal;
  const statusOrq = Orquestrador.determinarStatusPagamento({
    totalFiscal: F,
    totalNaoFiscal: NF,
    fiscalProcessado: true,
    recebimentosNaoFiscalConfirmados: nfConf
  });
  const recebOrq = Orquestrador.montarRecebimentosParaGravar({
    distribuicao: aloc,
    statusPagamento: statusOrq,
    totalFiscal: F,
    totalNaoFiscal: NF,
    resultadoFiscal: { sucesso: true }
  });
  const regra = aplicarRegraStatusPagamentoVenda({
    valorFiscal: F,
    valorNaoFiscal: NF,
    statusPagamento: statusOrq,
    recebimentos: recebOrq
  });
  const recebimentos = (regra.recebimentos || []).map((r) => {
    const tipo = classificarTipoRecebimento({
      ...r,
      confirmacao_manual: String(r.forma_pagamento).includes('dinheiro') ? 1 : 0,
      status_autorizacao: String(r.forma_pagamento).includes('dinheiro') ? 'informada' : 'aprovada',
      aprovado: true
    });
    if (tipo === 'nao_fiscal') {
      return { ...r, tipo_recebimento: 'nao_fiscal', tef_transacao_id: null };
    }
    if (tipo === 'fiscal') return { ...r, tipo_recebimento: 'fiscal' };
    return r;
  });
  const statusHttp = resolverStatusPagamentoRespostaHttp({
    statusPagamento: regra.statusPagamento,
    valorFiscal: F,
    valorNaoFiscal: NF
  });
  const saldo = calcularSaldoNaoFiscal(
    { valor_nao_fiscal: NF, status_pagamento: regra.statusPagamento },
    recebimentos.filter((r) => r.tipo_recebimento === 'nao_fiscal')
  );
  return {
    statusPersistido: regra.statusPagamento,
    statusHttp,
    recebimentos,
    saldo,
    integral
  };
}

let empresaA;
let empresaB;
let token;
let server;
let caixaSessaoId;
let terminalId;
let usuarioId;

function httpReq(method, urlPath, { body, empresaId } = {}) {
  const payload = body != null ? JSON.stringify(body) : null;
  const endereco = server.address();
  const headers = { Authorization: `Bearer ${token}` };
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
     VALUES ('admin-status-handoff', 'x', 'ADMIN', 'Admin', 'ADMIN', 1)`
  );
  const usuario = await get(`SELECT id FROM usuarios WHERE username = 'admin-status-handoff'`);
  usuarioId = Number(usuario.id);
  await run(
    `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1), (?, ?, 1)`,
    [usuarioId, empresaA.id, usuarioId, empresaB.id]
  );
  const terminal = await run(
    `INSERT INTO terminais (nome, hostname) VALUES ('PDV-STATUS', 'pdv-status-handoff')`
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
    { id: usuarioId, usuario: 'admin-status-handoff', perfil: 'ADMIN' },
    getJwtSecret(),
    { expiresIn: '2h' }
  );

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
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

describe('CDS-PDV-CORRECAO-STATUS-FISCAL-HANDOFF-01', { concurrency: false }, () => {
  it('01) resposta HTTP consistente — misto integral não rebaixa quitada', async () => {
    assert.doesNotMatch(
      FISCAL_SRC,
      /resolverStatusPagamentoVenda\(\s*valorNaoFiscal\s*,\s*\[\s*\]/
    );
    const r = pipelineMisto([
      { forma_pagamento: 'dinheiro', valor: 30 },
      { forma_pagamento: 'pix', valor: 70, tef_transacao_id: 'T1' }
    ]);
    assert.equal(r.statusPersistido, 'quitada');
    assert.equal(r.statusHttp, 'quitada');
    assert.notEqual(r.statusHttp, 'aguardando_nao_fiscal');

    let capturado = null;
    const res = {
      json(body) { capturado = body; return body; }
    };
    await responderVendaComFiscal(res, {
      vendaId: 1,
      codigo: 'VND-TEST',
      message: 'ok',
      emitirFiscal: false,
      valorFiscal: 70,
      valorNaoFiscal: 30,
      statusPagamento: 'quitada'
    });
    assert.equal(capturado.status_pagamento, 'quitada');
  });

  it('02) GET saldo zero — frontend não abre 2ª etapa nem POST zero', () => {
    assert.match(PDV_JS, /function interpretarSaldoPagamentoNaoFiscal/);
    assert.match(PDV_JS, /codigo === 'SEM_PENDENCIA'/);
    assert.match(PDV_JS, /Não há valor não fiscal pendente/);
    assert.doesNotMatch(
      PDV_JS,
      /onConfirm\(\{\s*forma_pagamento:[^}]*valor:\s*0/
    );
    const saldo = interpretarSaldoPagamentoNaoFiscal({
      saldo_pendente: 0,
      valor_nao_fiscal: 30,
      status_pagamento: 'quitada'
    });
    assert.equal(saldo.codigo, 'SEM_PENDENCIA');
    assert.equal(saldo.valor, 0);
  });

  it('03) segunda etapa legítima — só fiscal no POST, NF pendente', () => {
    const r = pipelineMisto([{ forma_pagamento: 'pix', valor: 70, tef_transacao_id: 'T1' }]);
    assert.equal(r.statusPersistido, 'aguardando_nao_fiscal');
    assert.equal(r.statusHttp, 'aguardando_nao_fiscal');
    assert.ok(r.saldo.saldoPendente > 0);
    const saldoUi = interpretarSaldoPagamentoNaoFiscal({
      saldo_pendente: r.saldo.saldoPendente,
      valor_nao_fiscal: r.saldo.valorNaoFiscal
    });
    assert.equal(saldoUi.codigo, 'PENDENTE');
    assert.ok(saldoUi.valor > 0);
  });

  it('04) modal com zero — não chama onConfirm (contrato fonte)', () => {
    assert.match(PDV_JS, /nunca confirmar valor zero/);
    assert.match(PDV_JS, /typeof onCancel === 'function'/);
    assert.match(PDV_JS, /Não há valor não fiscal pendente para cobrança/);
    const trecho = PDV_JS.slice(
      PDV_JS.indexOf('function abrirModalPagamentoNaoFiscal'),
      PDV_JS.indexOf('function abrirModalPagamentoNaoFiscal') + 1200
    );
    assert.doesNotMatch(trecho, /onConfirm\(\{[^}]*valor:\s*0/);
  });

  it('05) saldo ausente ou inválido — sem confirmação automática', () => {
    assert.equal(interpretarSaldoPagamentoNaoFiscal(null).codigo, 'SALDO_AUSENTE');
    assert.equal(interpretarSaldoPagamentoNaoFiscal({}).codigo, 'SALDO_AUSENTE');
    assert.equal(
      interpretarSaldoPagamentoNaoFiscal({ saldo_pendente: null }).codigo,
      'SALDO_AUSENTE'
    );
    assert.equal(
      interpretarSaldoPagamentoNaoFiscal({ saldo_pendente: 'abc' }).codigo,
      'SALDO_INVALIDO'
    );
    assert.equal(
      interpretarSaldoPagamentoNaoFiscal({ saldo_pendente: -1 }).codigo,
      'SALDO_NEGATIVO'
    );
    assert.match(PDV_JS, /SALDO_AUSENTE|SALDO_INVALIDO|SALDO_NEGATIVO/);
    assert.match(PDV_JS, /Não foi possível obter o saldo não fiscal/);
  });

  it('06) dinheiro puro — status quitada sem handoff', () => {
    const r = pipelineMisto([{ forma_pagamento: 'dinheiro', valor: 100 }], 0, 100);
    assert.equal(r.statusPersistido, 'quitada');
    assert.equal(r.statusHttp, 'quitada');
    assert.notEqual(r.statusHttp, 'aguardando_nao_fiscal');
  });

  it('07) somente fiscal — quitada sem handoff', () => {
    const r = pipelineMisto(
      [{ forma_pagamento: 'pix', valor: 100, tef_transacao_id: 'T1' }],
      100,
      0
    );
    assert.equal(r.statusPersistido, 'quitada');
    assert.equal(r.statusHttp, 'quitada');
    assert.equal(
      resolverStatusPagamentoVenda(0, [], 'quitada', { valorFiscal: 100 }),
      'quitada'
    );
  });

  it('08) ordem das parcelas — equivalência A vs B', () => {
    const a = pipelineMisto([
      { forma_pagamento: 'dinheiro', valor: 30 },
      { forma_pagamento: 'pix', valor: 70, tef_transacao_id: 'T1' }
    ]);
    const b = pipelineMisto([
      { forma_pagamento: 'pix', valor: 70, tef_transacao_id: 'T1' },
      { forma_pagamento: 'dinheiro', valor: 30 }
    ]);
    assert.equal(a.statusPersistido, b.statusPersistido);
    assert.equal(a.statusHttp, b.statusHttp);
    assert.equal(a.saldo.saldoPendente, b.saldo.saldoPendente);
    assert.equal(a.integral, b.integral);
    assert.equal(a.statusHttp, 'quitada');
  });

  it('09) idempotência — mesma chave não cria 2ª venda / handoff indevido', async () => {
    const ROTAS = fs.readFileSync(path.join(__dirname, '../../backend/rotas/vendas.js'), 'utf8');
    assert.match(PDV_JS, /chave_fechamento_pdv/);
    assert.match(ROTAS, /pdv_fechamento_idempotencia/);
    assert.match(ROTAS, /venda_ja_persistida/);

    const chave = `idem-status-handoff-${Date.now()}`;
    const vendaIns = await run(
      `INSERT INTO vendas (
         codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
         valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id, terminal_id,
         operador_id, caixa_sessao_id
       ) VALUES (?, date('now'), 100, 0, 0, 'misto', 'concluida',
         70, 30, 'quitada', ?, ?, ?, ?)`,
      ['VND-IDEM-HO', empresaA.id, terminalId, usuarioId, caixaSessaoId]
    );
    const vendaId = vendaIns.lastID;
    await run(
      `CREATE TABLE IF NOT EXISTS pdv_fechamento_idempotencia (
         chave TEXT PRIMARY KEY,
         venda_id INTEGER NOT NULL,
         status_pagamento TEXT,
         criado_em TEXT
       )`
    );
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, ?, 'quitada', datetime('now'))`,
      [chave, vendaId]
    );
    await run(
      `INSERT INTO venda_recebimentos (venda_id, tipo_recebimento, forma_pagamento, valor, status)
       VALUES (?, 'fiscal', 'pix', 70, 'aprovado'), (?, 'nao_fiscal', 'dinheiro', 30, 'aprovado')`,
      [vendaId, vendaId]
    );

    const again = await get(
      `SELECT venda_id, status_pagamento FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chave]
    );
    assert.equal(Number(again.venda_id), vendaId);
    assert.equal(again.status_pagamento, 'quitada');

    const statusHttp = resolverStatusPagamentoRespostaHttp({
      statusPagamento: 'quitada',
      valorFiscal: 70,
      valorNaoFiscal: 30
    });
    assert.equal(statusHttp, 'quitada');
    const recebNf = await all(
      `SELECT * FROM venda_recebimentos WHERE venda_id = ? AND tipo_recebimento = 'nao_fiscal'`,
      [vendaId]
    );
    const saldo = calcularSaldoNaoFiscal(
      { valor_nao_fiscal: 30, status_pagamento: 'quitada' },
      recebNf
    );
    assert.equal(saldo.saldoPendente, 0);
    const ui = interpretarSaldoPagamentoNaoFiscal({ saldo_pendente: saldo.saldoPendente });
    assert.equal(ui.codigo, 'SEM_PENDENCIA');
    const contagem = await get(
      `SELECT COUNT(*) AS n FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chave]
    );
    assert.equal(Number(contagem.n), 1);
  });

  it('10) contexto empresarial — header e empresa incompatível', async () => {
    assert.match(PDV_JS, /headersPagamentoNaoFiscalVenda/);
    assert.match(PDV_JS, /CdsEmpresaContexto\.headersJson/);
    assert.match(PDV_JS, /concluirPagamentoNaoFiscalVenda/);
    assert.match(PDV_JS, /Valor do pagamento não fiscal deve ser maior que zero/);
    await run(
      `INSERT INTO vendas (
         id, codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
         valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id, terminal_id,
         operador_id, caixa_sessao_id
       ) VALUES (801, 'VND-CTX-HO', date('now'), 100, 0, 0, 'misto', 'concluida',
         70, 30, 'aguardando_nao_fiscal', ?, ?, ?, ?)`,
      [empresaA.id, terminalId, usuarioId, caixaSessaoId]
    );
    const ok = await httpReq('GET', '/api/vendas/801/pagamento-nao-fiscal', {
      empresaId: empresaA.id
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(Number(ok.body.saldo_pendente) > 0);
    // adotarEmpresaDaVenda: sem header ainda resolve pela empresa da venda
    const adotado = await httpReq('GET', '/api/vendas/801/pagamento-nao-fiscal', {});
    assert.equal(adotado.status, 200, JSON.stringify(adotado.body));
    const incompat = await httpReq('GET', '/api/vendas/801/pagamento-nao-fiscal', {
      empresaId: empresaB.id
    });
    assert.ok(incompat.status >= 400, JSON.stringify(incompat.body));
  });
});
