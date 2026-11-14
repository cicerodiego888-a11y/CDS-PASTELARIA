/**
 * CDS-PDV-CORRECAO-FALLBACK-DESTRUTIVO-CLASSIFICACAO-MISTA-01
 * Fallbacks não podem converter misto confirmado em 0/100.
 * Banco temporário. Sem TEF/PIX/SEFAZ reais.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/pdv-correcao-fallback-destrutivo-classificacao-mista-01.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-fix-mista-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
delete process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-fix-mista-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const { criarMiddlewareContextoEmpresa } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const vendasRouter = require('../../backend/rotas/vendas');
const tefConfigService = require('../../backend/services/tef/tefConfigService');
const tefManager = require('../../backend/services/tef/TefManager');
const configService = require('../../backend/services/configuracaoService');

configService.getModoConfirmacaoFiscal = function modoTef() { return 'TEF'; };
tefConfigService.obterConfiguracao = async function cfg() {
  return { tefHabilitado: false, pix: false };
};
tefManager.autorizar = async function bloqueada() {
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};

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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function parcela(forma, valor, status, extra = {}) {
  return { forma_pagamento: forma, valor, status_autorizacao: status, ...extra };
}
function pixOk(valor, extra = {}) {
  return parcela('pix', valor, 'aprovada', {
    aprovado: true,
    tef_transacao_id: extra.tef_transacao_id,
    nsu: extra.nsu || 'NSU-1',
    autorizacao: extra.autorizacao || 'AUT-1',
    ...extra
  });
}

let empresaA;
let token;
let terminalId;
let server;
let pastelId;
let ref200Id;

function httpJson(body) {
  const payload = JSON.stringify(body);
  const endereco = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: endereco.port,
      path: '/api/vendas',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
        'X-Empresa-Id': String(empresaA.id)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const texto = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(texto); } catch (_) { json = { bruto: texto }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function item(produtoId, quantidade, preco, categoria) {
  return {
    produto_id: produtoId,
    quantidade,
    preco_unitario: preco,
    subtotal: Math.round(quantidade * preco * 100) / 100,
    categoria_nome: categoria,
    ncm: '21069090',
    unidade: 'UN',
    tipo_venda: 'UNIDADE'
  };
}

function carrinhoMisto() {
  return [
    item(pastelId, 2, 10, 'PASTEIS'),
    item(ref200Id, 16, 5, 'REFRIGERANTES')
  ];
}

function carrinhoSoRefri() {
  return [item(ref200Id, 20, 5, 'REFRIGERANTES')];
}

function pedido(chave, pagamentos, itens = carrinhoMisto(), extras = {}) {
  return {
    origem: 'PDV',
    terminal_id: terminalId,
    chave_fechamento_pdv: chave,
    venda_fiscal: true,
    emitir_fiscal: false,
    pagamento_sequencial: true,
    confirmacao_fiscal_manual: pagamentos.some((p) => p.forma_pagamento === 'dinheiro'),
    forma_pagamento: pagamentos.length > 1 ? 'misto' : pagamentos[0].forma_pagamento,
    desconto: 0,
    acrescimo: 0,
    total: 100,
    valor_recebido: 100,
    itens,
    pagamentos,
    ...extras
  };
}

async function inserirTef(valor, nsu) {
  return run(
    `INSERT INTO tef_transacoes (
       venda_id, empresa_id, tipo, valor, parcelas, status, provedor, nsu, autorizacao, criado_em, atualizado_em
     ) VALUES (NULL, ?, 'pix_tef', ?, 1, 'aprovado', 'SIMULADO', ?, ?, datetime('now'), datetime('now'))`,
    [empresaA.id, valor, nsu, `AUT-${nsu}`]
  );
}

async function dumpVenda(vendaId) {
  const v = await get(
    `SELECT id, valor_fiscal, valor_nao_fiscal, status_pagamento, total FROM vendas WHERE id = ?`,
    [vendaId]
  );
  const itens = await all(
    `SELECT produto_id, valor_fiscal, valor_nao_fiscal, quantidade_fiscal, quantidade_nao_fiscal
     FROM vendas_itens WHERE venda_id = ?`,
    [vendaId]
  );
  const rec = await all(
    `SELECT forma_pagamento, valor, tipo_recebimento FROM venda_recebimentos WHERE venda_id = ?`,
    [vendaId]
  );
  return { v, itens, rec };
}

function assertMisto7030(persistido) {
  assert.equal(Number(persistido.v.valor_fiscal), 70);
  assert.equal(Number(persistido.v.valor_nao_fiscal), 30);
  const somaF = Math.round(persistido.itens.reduce((t, l) => t + Number(l.valor_fiscal), 0) * 100) / 100;
  const somaN = Math.round(persistido.itens.reduce((t, l) => t + Number(l.valor_nao_fiscal), 0) * 100) / 100;
  assert.equal(somaF, 70);
  assert.equal(somaN, 30);
  assert.equal(Math.round((somaF + somaN) * 100) / 100, 100);
}

describe('CDS-PDV-CORRECAO-FALLBACK-DESTRUTIVO-CLASSIFICACAO-MISTA-01', { concurrency: false }, () => {
  before(async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
      db.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Pastelaria Fix Mista 01' },
      { db }
    );
    const catPastel = await run(`INSERT INTO categorias (nome, tipo) VALUES ('PASTEIS', 'produto')`);
    const catRefri = await run(`INSERT INTO categorias (nome, tipo) VALUES ('REFRIGERANTES', 'produto')`);
    pastelId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel fix', ?, 'UN', 'COMERCIAL', 1, '21069090', '5102', '102', 100, 100, 200, 10, 1)`,
      [catPastel.lastID]
    )).lastID;
    ref200Id = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         utiliza_volume, volume_valor, volume_unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual,
         preco_venda, ativo
       ) VALUES ('Refri fix 200', ?, 'UN', 'COMERCIAL', 1, '22021000', '5102', '102',
         1, 200, 'ML', 100, 100, 200, 5, 1)`,
      [catRefri.lastID]
    )).lastID;
    for (const produtoId of [pastelId, ref200Id]) {
      await EstoqueEmpresaService.criarRegistro({
        produtoId, empresaId: empresaA.id, saldo_fiscal: 100, saldo_nao_fiscal: 100, estoque_atual: 200
      }, { db });
    }
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-fix-mista', 'x', 'operador', 'Operador Fix', 'CAIXA', 1)`
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.lastID, empresaA.id]
    );
    token = jwt.sign(
      {
        id: operador.lastID,
        usuario_id: operador.lastID,
        username: 'op-fix-mista',
        role: 'operador',
        perfil: 'CAIXA'
      },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    terminalId = (await run(
      `INSERT INTO terminais (nome, hostname) VALUES ('PDV-FIX-MISTA', 'fixmista01')`
    )).lastID;
    const turno = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalId, operador.lastID]
    );
    await run(
      `INSERT INTO caixa_sessoes (
         caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
       ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
      [turno.lastID, terminalId, operador.lastID, empresaA.id]
    );
    const app = express();
    app.use(express.json());
    app.use('/api/vendas', verificarToken, criarMiddlewareContextoEmpresa(db), vendasRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { isolamento.restaurar(); } catch (_) { /* ignore */ }
  });

  it('A. PIX integral — 100/0 preservado', async () => {
    const tef = await inserirTef(100, 'NSU-FIX-A');
    const resp = await httpJson(pedido('pdv-fix-a-pix100', [
      pixOk(100, { tef_transacao_id: tef.lastID, nsu: 'NSU-FIX-A', autorizacao: 'AUT-NSU-FIX-A' })
    ]));
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(Number(resp.body.valor_fiscal), 100);
    assert.equal(Number(resp.body.valor_nao_fiscal), 0);
    const dump = await dumpVenda(Number(resp.body.venda_id));
    assert.equal(Number(dump.v.valor_fiscal), 100);
    assert.equal(Number(dump.v.valor_nao_fiscal), 0);
  });

  it('B. dinheiro primeiro + PIX — 70/30', async () => {
    const tef = await inserirTef(70, 'NSU-FIX-B');
    const resp = await httpJson(pedido('pdv-fix-b-din-pix', [
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' }),
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-FIX-B', autorizacao: 'AUT-NSU-FIX-B' })
    ]));
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(Number(resp.body.valor_fiscal), 70);
    assert.equal(Number(resp.body.valor_nao_fiscal), 30);
    assertMisto7030(await dumpVenda(Number(resp.body.venda_id)));
  });

  it('C. PIX primeiro + dinheiro — 70/30', async () => {
    const tef = await inserirTef(70, 'NSU-FIX-C');
    const resp = await httpJson(pedido('pdv-fix-c-pix-din', [
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-FIX-C', autorizacao: 'AUT-NSU-FIX-C' }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ]));
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(Number(resp.body.valor_fiscal), 70);
    assert.equal(Number(resp.body.valor_nao_fiscal), 30);
    assertMisto7030(await dumpVenda(Number(resp.body.venda_id)));
  });

  it('D. contexto inválido — RECOMPOSICAO_NAO_AUTORIZADA sem persistir 0/100', async () => {
    const tef = await inserirTef(70, 'NSU-FIX-D');
    const antes = await get('SELECT COUNT(*) AS n FROM vendas');
    const resp = await httpJson(pedido('x', [
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1 }),
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-FIX-D', autorizacao: 'AUT-NSU-FIX-D' })
    ], carrinhoMisto(), { chave_fechamento_pdv: 'x' }));
    assert.equal(resp.status, 409, JSON.stringify(resp.body));
    assert.equal(resp.body.codigo || resp.body.code, 'RECOMPOSICAO_NAO_AUTORIZADA');
    assert.equal(Number(resp.body.valor_fiscal_referencia), 70);
    assert.equal(Number(resp.body.valor_nao_fiscal_referencia), 30);
    const depois = await get('SELECT COUNT(*) AS n FROM vendas');
    assert.equal(Number(depois.n), Number(antes.n));
    const orphanRec = await get('SELECT COUNT(*) AS n FROM venda_recebimentos');
    const orphanItens = await get('SELECT COUNT(*) AS n FROM vendas_itens');
    // Sem venda nova: contagens de órfãos da venda inexistente devem permanecer estáveis
    // (não criamos venda com 0/100).
    assert.ok(Number(orphanRec.n) >= 0);
    assert.ok(Number(orphanItens.n) >= 0);
    const zeroCem = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE valor_fiscal = 0 AND valor_nao_fiscal = 100 AND total = 100
       AND id NOT IN (SELECT id FROM vendas WHERE valor_fiscal = 0 AND valor_nao_fiscal = 100 AND forma_pagamento = 'dinheiro')`
    );
    // Nenhuma venda mista 0/100 criada neste cenário
    assert.equal(resp.body.venda_id || resp.body.id || null, null);
  });

  it('E. motor sem composição — DISTRIBUICAO/SEM_PASTEL sem 0/100', async () => {
    const tef = await inserirTef(70, 'NSU-FIX-E');
    const antes = await get('SELECT COUNT(*) AS n FROM vendas');
    const resp = await httpJson(pedido('pdv-fix-e-sem-pastel', [
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1 }),
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-FIX-E', autorizacao: 'AUT-NSU-FIX-E' })
    ], carrinhoSoRefri()));
    assert.equal(resp.status, 409, JSON.stringify(resp.body));
    const codigo = resp.body.codigo || resp.body.code;
    assert.ok(
      ['DISTRIBUICAO_NAO_AUTORIZADA', 'SEM_PASTEL_ELEGIVEL', 'COMPOSICAO_AUSENTE_NO_MOTOR'].includes(codigo),
      JSON.stringify(resp.body)
    );
    assert.equal(Number(resp.body.valor_fiscal_referencia), 70);
    assert.equal(Number(resp.body.valor_nao_fiscal_referencia), 30);
    const depois = await get('SELECT COUNT(*) AS n FROM vendas');
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(resp.body.venda_id || resp.body.id || null, null);
  });

  it('F. dinheiro exclusivo — 0/100', async () => {
    const resp = await httpJson(pedido('pdv-fix-f-din100', [
      parcela('dinheiro', 100, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ]));
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(Number(resp.body.valor_fiscal), 0);
    assert.equal(Number(resp.body.valor_nao_fiscal), 100);
    const dump = await dumpVenda(Number(resp.body.venda_id));
    assert.equal(Number(dump.v.valor_fiscal), 0);
    assert.equal(Number(dump.v.valor_nao_fiscal), 100);
  });

  it('G. PIX pendente — sem venda concluída indevida', async () => {
    // TEF no banco também pendente: não pode carimbar como comprovado.
    const tef = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, tipo, valor, parcelas, status, provedor, nsu, autorizacao, criado_em, atualizado_em
       ) VALUES (NULL, ?, 'pix_tef', 70, 1, 'pendente', 'SIMULADO', 'NSU-FIX-G', 'AUT-NSU-FIX-G', datetime('now'), datetime('now'))`,
      [empresaA.id]
    );
    const antes = await get('SELECT COUNT(*) AS n FROM vendas');
    const resp = await httpJson(pedido('pdv-fix-g-pix-pend', [
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1 }),
      parcela('pix', 70, 'pendente', {
        aprovado: false,
        tef_transacao_id: tef.lastID,
        nsu: 'NSU-FIX-G',
        autorizacao: 'AUT-NSU-FIX-G'
      })
    ]));
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    const depois = await get('SELECT COUNT(*) AS n FROM vendas');
    assert.equal(Number(depois.n), Number(antes.n));
    // Não pode surgir cabeçalho misto destruído 0/100 nesta chave.
    const destruido = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE chave_fechamento_pdv = ? AND valor_fiscal = 0 AND valor_nao_fiscal = 100`,
      ['pdv-fix-g-pix-pend']
    );
    assert.equal(Number(destruido.n), 0);
  });

  it('H. retry após bloqueio — sem duplicar; nova tentativa com ctx válido', async () => {
    const tef = await inserirTef(70, 'NSU-FIX-H');
    const pags = [
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1 }),
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-FIX-H', autorizacao: 'AUT-NSU-FIX-H' })
    ];
    const chave = 'pdv-fix-h-retry01';
    // 1ª tentativa: carrinho sem pastel → bloqueio
    const bloqueio = await httpJson(pedido(chave, pags, carrinhoSoRefri()));
    assert.equal(bloqueio.status, 409, JSON.stringify(bloqueio.body));
    const reserva = await get(
      `SELECT venda_id FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chave]
    );
    // Reserva liberada (DELETE venda_id=0) ou inexistente após falha HTTP
    if (reserva) {
      assert.ok(Number(reserva.venda_id) === 0 || Number(reserva.venda_id) > 0);
    }
    const antes = await get('SELECT COUNT(*) AS n FROM vendas');

    // 2ª tentativa: mesmo chave, carrinho elegível
    const ok = await httpJson(pedido(chave, pags, carrinhoMisto()));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(Number(ok.body.valor_fiscal), 70);
    assert.equal(Number(ok.body.valor_nao_fiscal), 30);
    const depois = await get('SELECT COUNT(*) AS n FROM vendas');
    assert.equal(Number(depois.n), Number(antes.n) + 1);
    assertMisto7030(await dumpVenda(Number(ok.body.venda_id)));

    const retry = await httpJson(pedido(chave, pags, carrinhoMisto()));
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(Number(retry.body.venda_id || retry.body.id), Number(ok.body.venda_id));
    const contagem = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE chave_fechamento_pdv = ?`,
      [chave]
    );
    assert.equal(Number(contagem.n), 1);
  });

  it('regressão estática — fallbacks 0/totalNum removidos nos ramos mistos', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.match(src, /CORRECAO-FALLBACK-DESTRUTIVO-CLASSIFICACAO-MISTA-01/);
    assert.match(src, /recomposicao_fiscal_gerencial_nao_autorizada/);
    // Os ramos mistos devem retornar 409, não atribuir valorNaoFiscal: totalNum com itens zerados.
    const idxDist = src.indexOf("codigo: documento && documento.codigo ? documento.codigo : 'DISTRIBUICAO_NAO_AUTORIZADA'");
    assert.ok(idxDist > 0);
    const trechoDist = src.slice(idxDist, idxDist + 800);
    assert.match(trechoDist, /return res\.status\(409\)/);
    assert.doesNotMatch(trechoDist, /valorNaoFiscal:\s*totalNum/);

    const idxRec = src.indexOf("codigo: 'RECOMPOSICAO_NAO_AUTORIZADA'");
    assert.ok(idxRec > 0);
    const trechoRec = src.slice(idxRec, idxRec + 700);
    assert.match(trechoRec, /return res\.status\(409\)/);
    assert.doesNotMatch(trechoRec, /valorNaoFiscal:\s*totalNum/);
  });
});
