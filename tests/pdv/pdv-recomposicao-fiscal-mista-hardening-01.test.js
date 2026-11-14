/**
 * CDS-PDV-RECOMPOSICAO-FISCAL-MISTA-HARDENING-01
 * Confirmação autoritativa, cancelados, isolamento PDV, pipeline e idempotência.
 * Banco temporário. Sem TEF/PIX/SEFAZ reais.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/pdv-recomposicao-fiscal-mista-hardening-01.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-hard-recomp-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
delete process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL;
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-hard-recomp-');
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
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  recomposicaoFechamentoOperacionalAtiva,
  contextoFechamentoPdvAutorizado
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  calcularReferenciasConfirmadas,
  parcelaEfetivamenteConfirmada,
  evidenciaConfirmacaoEletronica
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const {
  obterAutorizacaoDistribuicaoOficialInterna
} = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');
const {
  reescritaDeComposicaoNoEmissorAutorizada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');

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

describe('CDS-PDV-RECOMPOSICAO-FISCAL-MISTA-HARDENING-01', { concurrency: false }, () => {
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
      { cnpj: '11222333000181', razao_social: 'Pastelaria Hardening 01' },
      { db }
    );
    const catPastel = await run(`INSERT INTO categorias (nome, tipo) VALUES ('PASTEIS', 'produto')`);
    const catRefri = await run(`INSERT INTO categorias (nome, tipo) VALUES ('REFRIGERANTES', 'produto')`);
    pastelId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel hard', ?, 'UN', 'COMERCIAL', 1, '21069090', '5102', '102', 100, 100, 200, 10, 1)`,
      [catPastel.lastID]
    )).lastID;
    ref200Id = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         utiliza_volume, volume_valor, volume_unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual,
         preco_venda, ativo
       ) VALUES ('Refri hard 200', ?, 'UN', 'COMERCIAL', 1, '22021000', '5102', '102',
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
       VALUES ('op-hard', 'x', 'operador', 'Operador Hard', 'CAIXA', 1)`
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.lastID, empresaA.id]
    );
    token = jwt.sign(
      {
        id: operador.lastID,
        usuario_id: operador.lastID,
        username: 'op-hard',
        role: 'operador',
        perfil: 'CAIXA'
      },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    terminalId = (await run(
      `INSERT INTO terminais (nome, hostname) VALUES ('PDV-HARD', 'hardening01')`
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

  it('A. confirmação eletrônica autoritativa e cancelados', () => {
    const { marcarParcelaEletronicaComprovada } = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
    assert.equal(parcelaEfetivamenteConfirmada(pixOk(70)), false);
    assert.equal(evidenciaConfirmacaoEletronica(pixOk(70)), false);
    assert.equal(parcelaEfetivamenteConfirmada(marcarParcelaEletronicaComprovada(pixOk(70))), true);
    assert.equal(evidenciaConfirmacaoEletronica(marcarParcelaEletronicaComprovada(pixOk(70))), true);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('pix', 70, 'aprovada', { aprovado: true })), false);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('pix', 70, '', { aprovado: true, tef_transacao_id: 1 })), false);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('pix', 70, 'pendente', { tef_transacao_id: 1 })), false);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('pix', 70, 'rejeitada', { tef_transacao_id: 1 })), false);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('pix', 70, 'cancelado', { aprovado: true, tef_transacao_id: 1 })), false);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('pix', 70, 'cancelada', { tef_transacao_id: 1 })), false);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('cartao_debito', 20, 'aprovada', { tef_transacao_id: 2 })), false);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('cartao_credito', 10, 'aprovada', { nsu: 'N', autorizacao: 'A' })), false);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1 })), true);
    assert.equal(parcelaEfetivamenteConfirmada(parcela('dinheiro', 30, 'pendente')), false);
    const refs = calcularReferenciasConfirmadas([
      marcarParcelaEletronicaComprovada(pixOk(70)),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1 })
    ]);
    assert.equal(refs.valor_fiscal_referencia, 70);
    assert.equal(refs.valor_nao_fiscal_referencia, 30);
    assert.equal(
      calcularReferenciasConfirmadas([parcela('pix', 70, 'aprovada', { aprovado: true })]).valor_fiscal_referencia,
      0
    );
  });

  it('B. isolamento do contexto PDV e Electron pin', () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
    assert.equal(contextoFechamentoPdvAutorizado({}), false);
    assert.equal(contextoFechamentoPdvAutorizado({ origem: 'PDV' }), false);
    assert.equal(contextoFechamentoPdvAutorizado({
      origem: 'PDV',
      caixaSessaoId: 9,
      chave_fechamento_pdv: 'pdv-hard-isol-01'
    }), true);
    assert.equal(recomposicaoFechamentoOperacionalAtiva(process.env, null), false);
    assert.equal(recomposicaoFechamentoOperacionalAtiva(process.env, {
      origem: 'MOBILE',
      caixaSessaoId: 9,
      chave_fechamento_pdv: 'pdv-hard-isol-02'
    }), false);
    const envHerdado0 = { ...process.env, CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL: '0' };
    assert.equal(recomposicaoFechamentoOperacionalAtiva(envHerdado0, {
      origem: 'PDV', caixaSessaoId: 1, chave_fechamento_pdv: 'pdv-hard-isol-03'
    }), false);
    const envPin1 = { ...process.env, CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL: '1' };
    assert.equal(recomposicaoFechamentoOperacionalAtiva(envPin1, {
      origem: 'PDV', caixaSessaoId: 1, chave_fechamento_pdv: 'pdv-hard-isol-04'
    }), true);
    const authSemCtx = obterAutorizacaoDistribuicaoOficialInterna(process.env, null, null);
    assert.equal(authSemCtx.ativa, false);
    const authComCtx = obterAutorizacaoDistribuicaoOficialInterna(process.env, null, {
      origem: 'PDV', caixaSessaoId: 1, chave_fechamento_pdv: 'pdv-hard-isol-05'
    });
    assert.equal(authComCtx.ativa, true);
    assert.equal(authComCtx.fonte, 'fechamento_operacional');
  });

  it('C. pipeline diagnóstico não autoriza sozinho sem harness/env', () => {
    const auth = obterAutorizacaoDistribuicaoOficialInterna(
      { ...process.env, CDS_RECOMPOSICAO_HOMOLOGACAO: '1' },
      null,
      null
    );
    assert.equal(auth.fonte === 'fechamento_operacional', false);
    const harness = obterAutorizacaoDistribuicaoOficialInterna(process.env, { ativa: true }, null);
    assert.equal(harness.fonte, 'harness_teste');
    assert.equal(harness.ativa, true);
  });

  async function inserirTef(valor, nsu) {
    return run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, tipo, valor, parcelas, status, provedor, nsu, autorizacao, criado_em, atualizado_em
       ) VALUES (NULL, ?, 'pix_tef', ?, 1, 'aprovado', 'SIMULADO', ?, ?, datetime('now'), datetime('now'))`,
      [empresaA.id, valor, nsu, `AUT-${nsu}`]
    );
  }

  it('D. PDV oficial aplica; origem genérica sem caixa não herda', async () => {
    const tef = await inserirTef(70, 'NSU-HARD-D');
    const pagamentos = [
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-HARD-D', autorizacao: 'AUT-NSU-HARD-D' }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const ok = await httpJson('/api/vendas', pedido('pdv-hard-oficial-01', pagamentos, 'PDV'));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(Number(ok.body.valor_fiscal), 70, JSON.stringify(ok.body));

    const generica = await httpJson('/api/vendas', {
      ...pedido('pdv-hard-generica-01', pagamentos, 'API'),
      terminal_id: null
    });
    if (generica.status === 200) {
      assert.notEqual(Number(generica.body.valor_fiscal), 70);
    } else {
      assert.ok(generica.status >= 400);
    }
  });

  it('E. idempotência concorrente da mesma chave', async () => {
    const tef = await inserirTef(70, 'NSU-HARD-E');
    const pagamentos = [
      pixOk(70, { tef_transacao_id: tef.lastID, nsu: 'NSU-HARD-E', autorizacao: 'AUT-NSU-HARD-E' }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const chave = 'pdv-hard-concorrente-01';
    const body = pedido(chave, pagamentos);
    const [a, b] = await Promise.all([
      httpJson('/api/vendas', body),
      httpJson('/api/vendas', body)
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    const emAndamento = [a, b].filter((r) => r.status === 409 && r.body && r.body.code === 'FECHAMENTO_EM_ANDAMENTO');
    assert.ok(ok.length >= 1, JSON.stringify({ a, b }));
    // Segunda pode ser 200 idempotente ou 409 em andamento; nunca duas vendas.
    assert.equal(ok.length + emAndamento.length, 2, JSON.stringify({ a: a.body, b: b.body }));
    if (ok.length === 2) {
      assert.equal(Number(ok[0].body.venda_id), Number(ok[1].body.venda_id));
    }
    const vendaId = Number(ok[0].body.venda_id);
    const contagem = await get('SELECT COUNT(*) AS n FROM vendas WHERE id = ?', [vendaId]);
    assert.equal(Number(contagem.n), 1);
    const itens = await get('SELECT COUNT(*) AS n FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    assert.equal(Number(itens.n), 2);
    const chaveRow = await get(
      'SELECT venda_id FROM pdv_fechamento_idempotencia WHERE chave = ?',
      [chave]
    );
    assert.equal(Number(chaveRow.venda_id), vendaId);
  });
});
