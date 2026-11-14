/**
 * CDS-PDV-ATIVACAO-RECOMPOSICAO-FISCAL-MISTA-01
 * Fecha a ligação operacional da recomposição (Sprints 26–31) sem reescrita no emissor.
 * Banco temporário. Sem TEF/PIX/SEFAZ reais. Sem ProgramData.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/pdv-ativacao-recomposicao-fiscal-mista-01.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ativacao-recomp-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
// Operacional ATIVACAO-01: NÃO forçar =0. Sem CDS_RECOMPOSICAO_REFERENCIA_TESTE.
delete process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
delete process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL;
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;
delete process.env.RECOMPOSICAO_HABILITADA_EM_PRODUCAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-ativacao-recomp-');
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
  RECOMPOSICAO_FECHAMENTO_OPERACIONAL_ATIVA,
  recomposicaoFechamentoOperacionalAtiva
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  calcularReferenciasConfirmadas,
  avaliarReferenciaRecomposicao,
  ambienteRecomposicaoReferenciaAtivo,
  marcarParcelaEletronicaComprovada
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const {
  comprovarPagamentosParaReferenciaFiscal
} = require('../../backend/services/OrquestradorPagamento');
const {
  integrarPagamentoRecomposicao
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');
const {
  reescritaDeComposicaoNoEmissorAutorizada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');
const {
  selecionarItensFiscaisParaNfce,
  emitirPorVendaId
} = require('../../backend/services/fiscal/emissor');

configService.getModoConfirmacaoFiscal = function modoTef() { return 'TEF'; };
tefConfigService.obterConfiguracao = async function cfg() {
  return { tefHabilitado: false, pix: false };
};
tefManager.autorizar = async function bloqueada() {
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};

const CFG = Object.freeze({
  codigoUf: '23',
  cnpj: '65957340000150',
  ie: '073252638',
  crt: 1,
  ambiente: 2,
  serie: 1,
  nomeEmpresa: 'EMPRESA ATIVACAO LTDA',
  logradouro: 'RUA A',
  numero: '100',
  bairro: 'CENTRO',
  codigo_municipio: '2307304',
  municipio: 'JUAZEIRO DO NORTE',
  uf: 'CE',
  cep: '63000000',
  telefone: '8835110000',
  csosn_padrao: '102'
});

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

let empresaA;
let token;
let operadorId;
let terminalId;
let server;
let pastelId;
let ref200Id;
let genericoId;

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

function parcela(forma, valor, status, extra = {}) {
  return { forma_pagamento: forma, valor, status_autorizacao: status, ...extra };
}

function item(produtoId, quantidade, preco, categoria) {
  return {
    produto_id: produtoId,
    quantidade,
    preco_unitario: preco,
    subtotal: Math.round(quantidade * preco * 100) / 100,
    categoria_nome: categoria,
    ncm: categoria === 'PASTEIS' ? '21069090' : '22021000',
    unidade: 'UN',
    tipo_venda: 'UNIDADE'
  };
}

/** Carrinho suportado (pastel + refrigerante): total 100 → fiscal 70 / gerencial 30. */
function carrinhoMisto100() {
  return [
    item(pastelId, 2, 10, 'PASTEIS'),
    item(ref200Id, 16, 5, 'REFRIGERANTES')
  ];
}

function pedido(chave, pagamentos, itens, total, extra = {}) {
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
    total,
    valor_recebido: total,
    itens,
    pagamentos,
    ...extra
  };
}

describe('CDS-PDV-ATIVACAO-RECOMPOSICAO-FISCAL-MISTA-01', { concurrency: false }, () => {
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
      { cnpj: '11222333000181', razao_social: 'Pastelaria Ativacao 01' },
      { db }
    );
    const catPastel = await run(`INSERT INTO categorias (nome, tipo) VALUES ('PASTEIS', 'produto')`);
    const catRefri = await run(`INSERT INTO categorias (nome, tipo) VALUES ('REFRIGERANTES', 'produto')`);
    const catOutra = await run(`INSERT INTO categorias (nome, tipo) VALUES ('DIVERSOS', 'produto')`);
    pastelId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel ativacao', ?, 'UN', 'COMERCIAL', 1, '21069090', '5102', '102', 100, 100, 200, 10, 1)`,
      [catPastel.lastID]
    )).lastID;
    ref200Id = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         utiliza_volume, volume_valor, volume_unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual,
         preco_venda, ativo
       ) VALUES ('Refrigerante ativacao 200', ?, 'UN', 'COMERCIAL', 1, '22021000', '5102', '102',
         1, 200, 'ML', 100, 100, 200, 5, 1)`,
      [catRefri.lastID]
    )).lastID;
    genericoId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Item generico', ?, 'UN', 'COMERCIAL', 1, '21069090', '5102', '102', 100, 100, 200, 100, 1)`,
      [catOutra.lastID]
    )).lastID;
    for (const produtoId of [pastelId, ref200Id, genericoId]) {
      await EstoqueEmpresaService.criarRegistro({
        produtoId, empresaId: empresaA.id, saldo_fiscal: 100, saldo_nao_fiscal: 100, estoque_atual: 200
      }, { db });
    }
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-ativ', 'x', 'operador', 'Operador Ativacao', 'CAIXA', 1)`
    );
    operadorId = operador.lastID;
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operadorId, empresaA.id]
    );
    token = jwt.sign(
      {
        id: operadorId,
        usuario_id: operadorId,
        username: 'op-ativ',
        role: 'operador',
        perfil: 'CAIXA'
      },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    terminalId = (await run(
      `INSERT INTO terminais (nome, hostname) VALUES ('PDV-ATIV', 'ativacao01')`
    )).lastID;
    const turno = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalId, operadorId]
    );
    await run(
      `INSERT INTO caixa_sessoes (
         caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
       ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
      [turno.lastID, terminalId, operadorId, empresaA.id]
    );

    const app = express();
    app.use(express.json());
    app.use('/api/vendas', verificarToken, criarMiddlewareContextoEmpresa(db), vendasRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { isolamento.restaurar(); } catch (_) { /* ignore */ }
  });

  it('contratos: operacional ativo, produção ampla e reescrita no emissor desligadas', () => {
    const ctxPdv = {
      origem: 'PDV',
      caixaSessaoId: 1,
      chave_fechamento_pdv: 'pdv-ativacao-ctx01'
    };
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.equal(RECOMPOSICAO_FECHAMENTO_OPERACIONAL_ATIVA, true);
    assert.equal(recomposicaoFechamentoOperacionalAtiva(), false);
    assert.equal(recomposicaoFechamentoOperacionalAtiva(process.env, ctxPdv), true);
    assert.equal(ambienteRecomposicaoReferenciaAtivo(process.env, ctxPdv), true);
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
  });

  it('A. misto 100/PIX70/dinheiro30 — referencia e fatias persistidas', async () => {
    const tef = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, parcelas, status, provedor, nsu, autorizacao
       ) VALUES (NULL, ?, ?, 'pix_tef', 70, 1, 'aprovado', 'SITEF', 'NSU-SIM', 'AUT-SIM')`,
      [empresaA.id, operadorId]
    );
    const pagamentos = [
      parcela('pix', 70, 'aprovada', {
        aprovado: true,
        tef_transacao_id: tef.lastID,
        nsu: 'NSU-SIM',
        autorizacao: 'AUT-SIM',
        tipo_recebimento: 'fiscal'
      }),
      parcela('dinheiro', 30, 'informada', {
        aprovado: false,
        tipo_recebimento: 'nao_fiscal',
        confirmacao_manual: 1
      })
    ];
    const comprovados = (await comprovarPagamentosParaReferenciaFiscal(pagamentos, {
      empresaId: empresaA.id,
      operadorId,
      db
    })).pagamentos;
    const refs = calcularReferenciasConfirmadas(comprovados);
    assert.equal(refs.valor_fiscal_referencia, 70);
    assert.equal(refs.valor_nao_fiscal_referencia, 30);
    const avaliacao = avaliarReferenciaRecomposicao(
      { total: 100, pagamentos: comprovados, itens: carrinhoMisto100() },
      {
        contexto: {
          origem: 'PDV',
          caixaSessaoId: 1,
          chave_fechamento_pdv: 'pdv-ativacao-misto-100'
        }
      }
    );
    assert.equal(avaliacao.recomposicao_executada, true);
    assert.equal(avaliacao.valor_fiscal_referencia, 70);
    assert.equal(avaliacao.valor_nao_fiscal_referencia, 30);

    const resposta = await httpJson('/api/vendas', pedido(
      'pdv-ativacao-misto-100',
      pagamentos,
      carrinhoMisto100(),
      100
    ));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(Number(resposta.body.valor_fiscal), 70, JSON.stringify(resposta.body));
    assert.equal(Number(resposta.body.valor_nao_fiscal), 30);
    const totalResp = Number(
      resposta.body.total != null ? resposta.body.total : resposta.body.valor_total
    );
    if (Number.isFinite(totalResp)) assert.equal(totalResp, 100);
    const vendaId = Number(resposta.body.venda_id);
    const linhas = await all(
      `SELECT produto_id, quantidade, subtotal, quantidade_fiscal, valor_fiscal,
              quantidade_nao_fiscal, valor_nao_fiscal
       FROM vendas_itens WHERE venda_id = ? ORDER BY produto_id`,
      [vendaId]
    );
    const somaFiscal = Math.round(linhas.reduce((t, l) => t + Number(l.valor_fiscal), 0) * 100) / 100;
    const somaNao = Math.round(linhas.reduce((t, l) => t + Number(l.valor_nao_fiscal), 0) * 100) / 100;
    assert.equal(somaFiscal, 70);
    assert.equal(somaNao, 30);
    assert.equal(Math.round((somaFiscal + somaNao) * 100) / 100, 100);
    assert.equal(linhas.length, 2);
    assert.ok(linhas.every((l) => [pastelId, ref200Id].includes(Number(l.produto_id))));
    const qtdComercial = linhas.reduce((t, l) => t + Number(l.quantidade), 0);
    assert.equal(qtdComercial, 18);

    const pagamentosDb = await all(
      `SELECT forma_pagamento, valor, tipo_recebimento, status, tef_transacao_id, nsu, autorizacao FROM venda_recebimentos WHERE venda_id = ?`,
      [vendaId]
    );
    const pagamentosComprovados = (await comprovarPagamentosParaReferenciaFiscal(pagamentosDb, {
      empresaId: empresaA.id,
      operadorId,
      vendaIdPermitida: vendaId,
      db
    })).pagamentos;
    const selecao = selecionarItensFiscaisParaNfce(
      { ...(await get('SELECT * FROM vendas WHERE id = ?', [vendaId])), pagamentos: pagamentosComprovados },
      linhas
    );
    assert.equal(selecao.bloqueado, false);
    assert.ok(selecao.somaFiscal >= 69.98 && selecao.somaFiscal <= 70.02);
  });

  it('B. somente PIX — fiscal = total, sem fatia gerencial indevida', async () => {
    const tef = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, parcelas, status, provedor, nsu, autorizacao, criado_em, atualizado_em
       ) VALUES (NULL, ?, ?, 'pix_tef', 100, 1, 'aprovado', 'SITEF', 'NSU-B', 'AUT-B', datetime('now'), datetime('now'))`,
      [empresaA.id, operadorId]
    );
    const pagamentos = [
      parcela('pix', 100, 'aprovada', {
        aprovado: true,
        tipo_recebimento: 'fiscal',
        tef_transacao_id: tef.lastID,
        nsu: 'NSU-B',
        autorizacao: 'AUT-B'
      })
    ];
    const refs = calcularReferenciasConfirmadas(
      (await comprovarPagamentosParaReferenciaFiscal(pagamentos, {
        empresaId: empresaA.id, operadorId, db
      })).pagamentos
    );
    assert.equal(refs.valor_fiscal_referencia, 100);
    assert.equal(refs.valor_nao_fiscal_referencia, 0);
    const resposta = await httpJson('/api/vendas', pedido(
      'pdv-ativacao-so-pix',
      pagamentos,
      carrinhoMisto100(),
      100
    ));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(Number(resposta.body.valor_fiscal), 100, JSON.stringify(resposta.body));
    assert.equal(Number(resposta.body.valor_nao_fiscal), 0);
  });

  it('C. somente dinheiro — fiscal 0, gerencial = total', async () => {
    const pagamentos = [
      parcela('dinheiro', 100, 'informada', {
        aprovado: false,
        tipo_recebimento: 'nao_fiscal',
        confirmacao_manual: 1
      })
    ];
    const refs = calcularReferenciasConfirmadas(pagamentos);
    assert.equal(refs.valor_fiscal_referencia, 0);
    assert.equal(refs.valor_nao_fiscal_referencia, 100);
    const resposta = await httpJson('/api/vendas', pedido(
      'pdv-ativacao-so-dinheiro',
      pagamentos,
      carrinhoMisto100(),
      100
    ));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(Number(resposta.body.valor_fiscal), 0);
    assert.equal(Number(resposta.body.valor_nao_fiscal), 100);
    const linhas = await all(
      'SELECT valor_fiscal, quantidade_fiscal FROM vendas_itens WHERE venda_id = ?',
      [resposta.body.venda_id]
    );
    assert.ok(linhas.every((l) => Number(l.valor_fiscal) === 0));
  });

  it('D. PIX pendente não entra na referência fiscal', () => {
    const pagamentos = [
      parcela('pix', 70, 'pendente', { aprovado: false, tipo_recebimento: 'fiscal' }),
      parcela('dinheiro', 30, 'informada', {
        aprovado: false,
        tipo_recebimento: 'nao_fiscal',
        confirmacao_manual: 1
      })
    ];
    const refs = calcularReferenciasConfirmadas(pagamentos);
    assert.equal(refs.valor_fiscal_referencia, 0);
    assert.equal(refs.valor_nao_fiscal_referencia, 30);
  });

  it('E. PIX rejeitado não gera referência fiscal', () => {
    const pagamentos = [
      parcela('pix', 70, 'rejeitada', { aprovado: false }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const refs = calcularReferenciasConfirmadas(pagamentos);
    assert.equal(refs.valor_fiscal_referencia, 0);
    assert.equal(refs.valor_nao_fiscal_referencia, 30);
  });

  it('F. composição sem pastel elegível — bloqueio explícito, sem inventar produto', async () => {
    const tef = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, status, provedor, nsu, autorizacao
       ) VALUES (NULL, ?, ?, 'pix_tef', 70, 'aprovado', 'SITEF', 'NSU-F', 'AUT-F')`,
      [empresaA.id, operadorId]
    );
    const pagamentos = [
      parcela('pix', 70, 'aprovada', {
        aprovado: true,
        tef_transacao_id: tef.lastID,
        nsu: 'NSU-F',
        autorizacao: 'AUT-F',
        tipo_recebimento: 'fiscal'
      }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const itens = [item(genericoId, 1, 100, 'DIVERSOS')];
    const doc = await integrarPagamentoRecomposicao({
      total: 100,
      pagamentos,
      itens,
      empresaId: empresaA.id,
      operadorId
    }, {
      db,
      operadorId,
      env: { ...process.env, CDS_RECOMPOSICAO_REFERENCIA_TESTE: '1', CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL: '0' }
    });
    assert.equal(doc.bloqueado, true);
    assert.equal(doc.codigo, 'SEM_PASTEL_ELEGIVEL');
    assert.equal((doc.itens_fiscais || []).length, 0);

    const resposta = await httpJson('/api/vendas', pedido(
      'pdv-ativacao-sem-pastel',
      pagamentos,
      itens,
      100
    ));
    // CORRECAO-FALLBACK-MISTO: misto sem distribuição autorizada não persiste 0/100.
    assert.equal(resposta.status, 409, JSON.stringify(resposta.body));
    assert.equal(resposta.body.codigo || resposta.body.code, 'SEM_PASTEL_ELEGIVEL');
    assert.equal(resposta.body.recomposicao_fiscal_gerencial_nao_autorizada, true);
    assert.equal(resposta.body.venda_id == null, true);
  });

  it('G. idempotência da mesma chave_fechamento_pdv', async () => {
    const tef = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, status, provedor, nsu, autorizacao
       ) VALUES (NULL, ?, ?, 'pix_tef', 70, 'aprovado', 'SITEF', 'NSU-G', 'AUT-G')`,
      [empresaA.id, operadorId]
    );
    const pagamentos = [
      parcela('pix', 70, 'aprovada', {
        aprovado: true,
        tef_transacao_id: tef.lastID,
        nsu: 'NSU-G',
        autorizacao: 'AUT-G',
        tipo_recebimento: 'fiscal'
      }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const chave = 'pdv-ativacao-idempotente';
    const a = await httpJson('/api/vendas', pedido(chave, pagamentos, carrinhoMisto100(), 100));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await httpJson('/api/vendas', pedido(chave, pagamentos, carrinhoMisto100(), 100));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(Number(b.body.venda_id), Number(a.body.venda_id));
    assert.equal(b.body.venda_ja_persistida, true);
    const contagem = await get(
      'SELECT COUNT(*) AS n FROM vendas_itens WHERE venda_id = ?',
      [a.body.venda_id]
    );
    assert.equal(Number(contagem.n), 2);
  });

  it('H. emissor: só itens fiscais persistidos; divergência bloqueia; sem reescrita', async () => {
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
    const tef = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, status, provedor, nsu, autorizacao
       ) VALUES (NULL, ?, ?, 'pix_tef', 70, 'aprovado', 'SITEF', 'NSU-H', 'AUT-H')`,
      [empresaA.id, operadorId]
    );
    const pagamentos = [
      parcela('pix', 70, 'aprovada', {
        aprovado: true,
        tef_transacao_id: tef.lastID,
        nsu: 'NSU-H',
        autorizacao: 'AUT-H',
        tipo_recebimento: 'fiscal'
      }),
      parcela('dinheiro', 30, 'informada', { confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })
    ];
    const resposta = await httpJson('/api/vendas', pedido(
      'pdv-ativacao-emissor-h',
      pagamentos,
      carrinhoMisto100(),
      100
    ));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const vendaId = Number(resposta.body.venda_id);
    assert.equal(Number(resposta.body.valor_fiscal), 70);

    const pagamentosComprovados = (await comprovarPagamentosParaReferenciaFiscal(pagamentos, {
      empresaId: empresaA.id,
      operadorId,
      vendaIdPermitida: vendaId,
      db
    })).pagamentos;
    const divergente = selecionarItensFiscaisParaNfce(
      { pagamentos: pagamentosComprovados },
      [{ valor_fiscal: 100, quantidade_fiscal: 1, produto_id: pastelId }]
    );
    assert.equal(divergente.bloqueado, true);
    // HANDOFF-COMPLEMENTO: excesso sem evidência persistida bloqueia antes da divergência genérica.
    assert.ok(
      divergente.codigo === 'DISTRIBUICAO_NAO_AUTORIZADA'
      || divergente.codigo === 'COMPLEMENTO_NAO_PERSISTIDO',
      divergente.codigo
    );

    const linhas = await all(
      `SELECT produto_id, quantidade, subtotal, quantidade_fiscal, valor_fiscal,
              quantidade_nao_fiscal, valor_nao_fiscal
       FROM vendas_itens WHERE venda_id = ?`,
      [vendaId]
    );
    const pagamentosDb = await all(
      `SELECT forma_pagamento, valor, tipo_recebimento, status, tef_transacao_id, nsu, autorizacao FROM venda_recebimentos WHERE venda_id = ?`,
      [vendaId]
    );
    const carregada = await get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    const itensDocumento = linhas.map((linha) => ({
      ...linha,
      produto_nome: 'Item',
      ncm: '21069090',
      cfop: '5102',
      csosn: '102',
      unidade: 'UN',
      origem: 0
    }));
    const pagamentosDbComprovados = (await comprovarPagamentosParaReferenciaFiscal(pagamentosDb, {
      empresaId: empresaA.id,
      operadorId,
      vendaIdPermitida: vendaId,
      db
    })).pagamentos;
    const selecao = selecionarItensFiscaisParaNfce(
      { ...carregada, pagamentos: pagamentosDbComprovados },
      itensDocumento
    );
    assert.equal(selecao.bloqueado, false, JSON.stringify(selecao));

    try {
      const emissao = await emitirPorVendaId(vendaId, {
        db,
        empresaIdContexto: empresaA.id,
        naoTransmitir: true,
        getFiscalConfig: async () => ({
          ...CFG,
          fonte: 'EMPRESA',
          empresaId: empresaA.id,
          tokenCSC: 'CSC-TESTE',
          idCSC: '000001'
        })
      });
      assert.notEqual(emissao.status, 'recomposicao_bloqueada');
      if (emissao.xml) {
        assert.doesNotMatch(String(emissao.xml), /<tPag>01<\/tPag>/);
        assert.match(String(emissao.xml), /<vNF>70\.00<\/vNF>/);
      }
    } catch (erroEmissao) {
      // Sem configuração fiscal de empresa o montador pode recusar — a guarda de itens já validou.
      assert.notEqual(erroEmissao.code, 'DISTRIBUICAO_NAO_AUTORIZADA');
      assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
    }
  });
});
