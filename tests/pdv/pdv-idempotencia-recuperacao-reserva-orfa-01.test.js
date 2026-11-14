/**
 * CDS-PDV-IDEMPOTENCIA-RECUPERACAO-RESERVA-ORFA-01
 * Recuperação segura de reservas órfãs (cenários A–I).
 * Banco temporário isolado. Sem TEF/PIX/SEFAZ reais. Sem EXE.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/pdv-idempotencia-recuperacao-reserva-orfa-01.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-idem-orfa-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_PDV_IDEMPOTENCIA_ORFAO_SEGUNDOS = '5';
delete process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
delete process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL;
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-idem-orfa-');
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
const {
  STATUS,
  garantirSchemaIdempotenciaPdv,
  reconciliarReservaOrfa,
  reivindicarReservaOrfa,
  avaliarIntegridadeVendaFechamento,
  marcarReservaConcluidaNaTransacao
} = require('../../backend/services/vendas/PdvFechamentoIdempotenciaService');

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

function parcela(forma, valor, status, extra = {}) {
  return { forma_pagamento: forma, valor, status_autorizacao: status, ...extra };
}
function pixOk(valor, extra = {}) {
  return parcela('pix', valor, 'aprovada', {
    aprovado: true,
    tef_transacao_id: extra.tef_transacao_id || 'sim-pix-1',
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

function httpJson(urlPath, body) {
  const payload = JSON.stringify(body);
  const endereco = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: endereco.port,
      path: urlPath,
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
function carrinho() {
  return [
    item(pastelId, 2, 10, 'PASTEIS'),
    item(ref200Id, 16, 5, 'REFRIGERANTES')
  ];
}
function pedido(chave, pagamentos, origem = 'PDV') {
  return {
    origem,
    terminal_id: terminalId,
    chave_fechamento_pdv: chave,
    venda_fiscal: true,
    emitir_fiscal: false,
    pagamento_sequencial: true,
    confirmacao_fiscal_manual: pagamentos.some((p) => p.forma_pagamento === 'dinheiro'),
    forma_pagamento: 'misto',
    desconto: 0,
    acrescimo: 0,
    total: 100,
    valor_recebido: 100,
    itens: carrinho(),
    pagamentos
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

async function seedVendaCompletaPorChave(chave, opts = {}) {
  const venda = await run(
    `INSERT INTO vendas (
       codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
       valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id, terminal_id,
       chave_fechamento_pdv, cancelada
     ) VALUES (?, date('now'), 100, 0, 0, 'misto', 'concluida',
       70, 30, 'quitada', ?, ?, ?, 0)`,
    [`VND-${chave}`, empresaA.id, terminalId, chave]
  );
  const vendaId = venda.lastID;
  if (opts.comItens !== false) {
    await run(
      `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
       VALUES (?, ?, 1, 100, 100)`,
      [vendaId, pastelId]
    );
  }
  if (opts.comRecebimentos !== false) {
    await run(
      `INSERT INTO venda_recebimentos (venda_id, tipo_recebimento, forma_pagamento, valor, status)
       VALUES (?, 'fiscal', 'pix', 70, 'aprovado'), (?, 'nao_fiscal', 'dinheiro', 30, 'aprovado')`,
      [vendaId, vendaId]
    );
  }
  if (opts.comPagamentos) {
    await run(
      `INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor) VALUES (?, 'pix', 70)`,
      [vendaId]
    );
  }
  return vendaId;
}

describe('CDS-PDV-IDEMPOTENCIA-RECUPERACAO-RESERVA-ORFA-01', { concurrency: false }, () => {
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
    await garantirSchemaIdempotenciaPdv(db);

    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Pastelaria Idem Orfa 01' },
      { db }
    );
    const catPastel = await run(`INSERT INTO categorias (nome, tipo) VALUES ('PASTEIS', 'produto')`);
    const catRefri = await run(`INSERT INTO categorias (nome, tipo) VALUES ('REFRIGERANTES', 'produto')`);
    pastelId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel idem', ?, 'UN', 'COMERCIAL', 1, '21069090', '5102', '102', 100, 100, 200, 10, 1)`,
      [catPastel.lastID]
    )).lastID;
    ref200Id = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         utiliza_volume, volume_valor, volume_unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual,
         preco_venda, ativo
       ) VALUES ('Refri idem 200', ?, 'UN', 'COMERCIAL', 1, '22021000', '5102', '102',
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
       VALUES ('op-idem-orfa', 'x', 'operador', 'Operador Idem', 'CAIXA', 1)`
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.lastID, empresaA.id]
    );
    token = jwt.sign(
      {
        id: operador.lastID,
        usuario_id: operador.lastID,
        username: 'op-idem-orfa',
        role: 'operador',
        perfil: 'CAIXA'
      },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    terminalId = (await run(
      `INSERT INTO terminais (nome, hostname) VALUES ('PDV-IDEM-ORFA', 'idemorfa01')`
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

  it('A. concorrência normal — mesma chave, uma venda', async () => {
    const tef = await inserirTef(70, 'NSU-ORFA-A');
    const pagamentos = [
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-ORFA-A', autorizacao: 'AUT-NSU-ORFA-A' }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const chave = 'pdv-orfa-concorrente-a01';
    const body = pedido(chave, pagamentos);
    const [a, b] = await Promise.all([httpJson('/api/vendas', body), httpJson('/api/vendas', body)]);
    const ok = [a, b].filter((r) => r.status === 200);
    const emAndamento = [a, b].filter((r) => r.status === 409 && r.body && r.body.code === 'FECHAMENTO_EM_ANDAMENTO');
    assert.ok(ok.length >= 1, JSON.stringify({ a, b }));
    assert.equal(ok.length + emAndamento.length, 2, JSON.stringify({ a: a.body, b: b.body }));
    if (ok.length === 2) {
      assert.equal(Number(ok[0].body.venda_id), Number(ok[1].body.venda_id));
    }
    const vendaId = Number(ok[0].body.venda_id);
    const contagem = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE chave_fechamento_pdv = ?`,
      [chave]
    );
    assert.equal(Number(contagem.n), 1);
    const reserva = await get(
      `SELECT venda_id FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chave]
    );
    assert.equal(Number(reserva.venda_id), vendaId);
  });

  it('B. crash antes da venda — reivindicação atômica após idade', async () => {
    const chave = 'pdv-orfa-crash-antes-venda-b01';
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, 0, ?, datetime('now', 'localtime', '-30 seconds'))`,
      [chave, STATUS.EM_ANDAMENTO]
    );
    const r1 = await reconciliarReservaOrfa(db, chave, process.env);
    assert.equal(r1.acao, 'criar_venda');
    assert.equal(r1.estado, STATUS.RECUPERACAO_NECESSARIA);

    // Segunda recuperação simultânea: reserva renovada — deve aguardar.
    const r2 = await reconciliarReservaOrfa(db, chave, process.env);
    assert.equal(r2.acao, 'aguardar');
    assert.equal(r2.code, 'FECHAMENTO_EM_ANDAMENTO');

    const vendas = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE chave_fechamento_pdv = ?`,
      [chave]
    );
    assert.equal(Number(vendas.n), 0);
  });

  it('C. crash após venda antes do UPDATE — vincula sem duplicar', async () => {
    const chave = 'pdv-orfa-crash-pos-venda-c01';
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, 0, ?, datetime('now', 'localtime', '-60 seconds'))`,
      [chave, STATUS.EM_ANDAMENTO]
    );
    const vendaId = await seedVendaCompletaPorChave(chave);
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas WHERE chave_fechamento_pdv = ?`, [chave]);
    assert.equal(Number(antes.n), 1);

    const r = await reconciliarReservaOrfa(db, chave, process.env);
    assert.equal(r.acao, 'retornar_venda');
    assert.equal(Number(r.vendaId), vendaId);
    assert.equal(r.recuperado, true);

    const reserva = await get(
      `SELECT venda_id, status_pagamento FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chave]
    );
    assert.equal(Number(reserva.venda_id), vendaId);

    const rRetry = await reconciliarReservaOrfa(db, chave, process.env);
    assert.equal(rRetry.acao, 'retornar_venda');
    assert.equal(Number(rRetry.vendaId), vendaId);

    const depois = await get(`SELECT COUNT(*) AS n FROM vendas WHERE chave_fechamento_pdv = ?`, [chave]);
    assert.equal(Number(depois.n), 1);
    const itens = await get(`SELECT COUNT(*) AS n FROM vendas_itens WHERE venda_id = ?`, [vendaId]);
    assert.equal(Number(itens.n), 1);
  });

  it('D. crash durante distribuição — bloqueia estado parcial', async () => {
    const chave = 'pdv-orfa-parcial-d01';
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, 0, ?, datetime('now', 'localtime', '-60 seconds'))`,
      [chave, STATUS.EM_ANDAMENTO]
    );
    const vendaId = await seedVendaCompletaPorChave(chave, {
      comItens: true,
      comRecebimentos: false,
      comPagamentos: false
    });
    const integridade = await avaliarIntegridadeVendaFechamento(db, vendaId);
    assert.equal(integridade.ok, false);
    assert.equal(integridade.motivo, 'distribuicao_ou_recebimentos_ausentes');

    const r = await reconciliarReservaOrfa(db, chave, process.env);
    assert.equal(r.acao, 'bloquear');
    assert.equal(r.code, 'FECHAMENTO_INCONSISTENTE');
    assert.equal(r.motivo, 'distribuicao_ou_recebimentos_ausentes');

    const reservas = await get(
      `SELECT venda_id FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chave]
    );
    assert.equal(Number(reservas.venda_id), 0);
  });

  it('E. duas recuperações simultâneas da mesma órfã', async () => {
    const chave = 'pdv-orfa-concorrente-e01';
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, 0, ?, datetime('now', 'localtime', '-40 seconds'))`,
      [chave, STATUS.EM_ANDAMENTO]
    );
    const [a, b] = await Promise.all([
      reivindicarReservaOrfa(db, chave, process.env),
      reivindicarReservaOrfa(db, chave, process.env)
    ]);
    const vencedoras = [a, b].filter(Boolean);
    assert.equal(vencedoras.length, 1, JSON.stringify({ a, b }));
  });

  it('F. reserva antiga sem venda — não apaga; reivindica com segurança', async () => {
    const chave = 'pdv-orfa-antiga-f01';
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, 0, ?, datetime('now', 'localtime', '-120 seconds'))`,
      [chave, STATUS.EM_ANDAMENTO]
    );
    const antes = await get(
      `SELECT COUNT(*) AS n FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chave]
    );
    assert.equal(Number(antes.n), 1);

    const r = await reconciliarReservaOrfa(db, chave, process.env);
    assert.equal(r.acao, 'criar_venda');
    const depois = await get(
      `SELECT chave, venda_id, status_pagamento FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chave]
    );
    assert.ok(depois, 'reserva não foi apagada por idade');
    assert.equal(Number(depois.venda_id), 0);
    assert.equal(depois.status_pagamento, STATUS.EM_ANDAMENTO);
  });

  it('G. venda concluída e retry — retorna original', async () => {
    const tef = await inserirTef(70, 'NSU-ORFA-G');
    const pagamentos = [
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-ORFA-G', autorizacao: 'AUT-NSU-ORFA-G' }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const chave = 'pdv-orfa-retry-g01';
    const first = await httpJson('/api/vendas', pedido(chave, pagamentos));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const vendaId = Number(first.body.venda_id || first.body.id);
    assert.ok(vendaId > 0);

    const second = await httpJson('/api/vendas', pedido(chave, pagamentos));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(Number(second.body.venda_id || second.body.id), vendaId);
    assert.equal(second.body.venda_ja_persistida, true);

    const contagem = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE chave_fechamento_pdv = ?`,
      [chave]
    );
    assert.equal(Number(contagem.n), 1);
  });

  it('H. chaves diferentes — sem bloqueio global', async () => {
    const tef1 = await inserirTef(70, 'NSU-ORFA-H1');
    const tef2 = await inserirTef(70, 'NSU-ORFA-H2');
    const pagamentos1 = [
      pixOk(70, { tef_transacao_id: tef1.lastID, nsu: 'NSU-ORFA-H1', autorizacao: 'AUT-NSU-ORFA-H1' }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const pagamentos2 = [
      pixOk(70, { tef_transacao_id: tef2.lastID, nsu: 'NSU-ORFA-H2', autorizacao: 'AUT-NSU-ORFA-H2' }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const [a, b] = await Promise.all([
      httpJson('/api/vendas', pedido('pdv-orfa-chave-h01', pagamentos1)),
      httpJson('/api/vendas', pedido('pdv-orfa-chave-h02', pagamentos2))
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.notEqual(Number(a.body.venda_id), Number(b.body.venda_id));
  });

  it('I. falha HTTP vs processo — DELETE só com venda_id=0; vínculo na TX', async () => {
    const chaveHttp = 'pdv-orfa-falha-http-i01';
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, 0, ?, datetime('now', 'localtime'))`,
      [chaveHttp, STATUS.EM_ANDAMENTO]
    );
    // Simula liberação de falha HTTP controlada (mesma cláusula do hook).
    await run(
      `DELETE FROM pdv_fechamento_idempotencia WHERE chave = ? AND venda_id = 0`,
      [chaveHttp]
    );
    const sumiu = await get(
      `SELECT COUNT(*) AS n FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chaveHttp]
    );
    assert.equal(Number(sumiu.n), 0);

    const chaveTx = 'pdv-orfa-vinculo-tx-i02';
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, 0, ?, datetime('now', 'localtime'))`,
      [chaveTx, STATUS.EM_ANDAMENTO]
    );
    const vendaId = await seedVendaCompletaPorChave(chaveTx);
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN IMMEDIATE', (errBegin) => {
          if (errBegin) return reject(errBegin);
          marcarReservaConcluidaNaTransacao(db, chaveTx, vendaId, 'quitada')
            .then(() => {
              db.run('COMMIT', (errCommit) => (errCommit ? reject(errCommit) : resolve()));
            })
            .catch((err) => {
              db.run('ROLLBACK', () => reject(err));
            });
        });
      });
    });
    const reserva = await get(
      `SELECT venda_id FROM pdv_fechamento_idempotencia WHERE chave = ?`,
      [chaveTx]
    );
    assert.equal(Number(reserva.venda_id), vendaId);

    // Reserva recente sem venda: não libera por TTL isolado.
    const chaveRecente = 'pdv-orfa-recente-i03';
    await run(
      `INSERT INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
       VALUES (?, 0, ?, datetime('now', 'localtime'))`,
      [chaveRecente, STATUS.EM_ANDAMENTO]
    );
    const recente = await reconciliarReservaOrfa(db, chaveRecente, process.env);
    assert.equal(recente.acao, 'aguardar');
    assert.equal(recente.code, 'FECHAMENTO_EM_ANDAMENTO');
  });

  it('regressão leve — contrato Sprint 1 / chave / schema preservados', () => {
    const rotas = fs.readFileSync(
      path.join(__dirname, '../../backend/rotas/vendas.js'),
      'utf8'
    );
    const svc = fs.readFileSync(
      path.join(__dirname, '../../backend/services/vendas/PdvFechamentoIdempotenciaService.js'),
      'utf8'
    );
    const orq = fs.readFileSync(
      path.join(__dirname, '../../backend/services/OrquestradorPagamento.js'),
      'utf8'
    );
    assert.match(rotas, /reconciliarReservaOrfa/);
    assert.match(rotas, /chave_fechamento_pdv/);
    assert.match(svc, /idx_vendas_chave_fechamento_pdv/);
    assert.doesNotMatch(svc, /DELETE FROM pdv_fechamento_idempotencia[\s\S]{0,80}datetime/);
    assert.match(orq, /comprovarPagamentosParaReferenciaFiscal/);
  });
});
