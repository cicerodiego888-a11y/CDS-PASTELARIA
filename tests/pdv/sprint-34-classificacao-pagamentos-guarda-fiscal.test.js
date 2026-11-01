/**
 * Sprint 34 — classificação dos pagamentos e guarda fiscal.
 * A natureza da parcela não depende da autorização da distribuição.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-34-classificacao-pagamentos-guarda-fiscal.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint34-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;
delete process.env.RECOMPOSICAO_HABILITADA_EM_PRODUCAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint34-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const { criarMiddlewareContextoEmpresa } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const configService = require('../../backend/services/configuracaoService');
const tefConfigService = require('../../backend/services/tef/tefConfigService');
const tefManager = require('../../backend/services/tef/TefManager');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  classificarTipoRecebimento,
  calcularReferenciasConfirmadas
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const { selecionarItensFiscaisParaNfce, emitirPorVendaId } = require('../../backend/services/fiscal/emissor');
const { resolverPagamentosNfce } = require('../../backend/services/fiscal/xmlBuilder');
const vendasRouter = require('../../backend/rotas/vendas');

configService.getModoConfirmacaoFiscal = function modoTef() { return 'TEF'; };
tefConfigService.obterConfiguracao = async function cfg() { return { tefHabilitado: false, pix: false }; };
tefManager.autorizar = async function bloqueada() {
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};

const CFG = Object.freeze({
  codigoUf: '23', cnpj: '11222333000181', ie: '073252638', crt: 1, ambiente: 2, serie: 1,
  nomeEmpresa: 'EMPRESA TESTE LTDA', logradouro: 'RUA A', numero: '100', bairro: 'CENTRO',
  codigo_municipio: '2307304', municipio: 'JUAZEIRO DO NORTE', uf: 'CE', cep: '63000000',
  telefone: '8835110000', csosn_padrao: '102', fonte: 'EMPRESA', tokenCSC: 'CSC-TESTE', idCSC: '000001'
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) { if (err) reject(err); else resolve(this); });
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
let empresaA;
let token;
let terminalId;
let server;
let pastelId;
let refId;

function httpJson(urlPath, body) {
  const payload = JSON.stringify(body);
  const endereco = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: endereco.port, path: urlPath, method: 'POST',
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

describe('Sprint 34 — classificação independente da distribuição', { concurrency: false }, () => {
  it('1 a 9. a forma define o tipo e o estado não transforma eletrônico em dinheiro', () => {
    const dinheiro = parcela('dinheiro', 10, 'informada', { aprovado: false, confirmacao_manual: 1 });
    const pix = parcela('pix', 20, 'aprovada', { aprovado: true });
    const debito = parcela('cartao_debito', 20, 'aprovada', { aprovado: true });
    const credito = parcela('cartao_credito', 10, 'aprovada', { aprovado: true });
    assert.equal(classificarTipoRecebimento(pix), 'fiscal');
    assert.equal(classificarTipoRecebimento(debito), 'fiscal');
    assert.equal(classificarTipoRecebimento(credito), 'fiscal');
    assert.equal(classificarTipoRecebimento(dinheiro), 'nao_fiscal');
    const assinatura = (lista) => lista
      .map((pagamento) => `${pagamento.forma_pagamento}:${classificarTipoRecebimento(pagamento)}`)
      .sort()
      .join('|');
    assert.equal(
      assinatura([dinheiro, pix, debito, credito]),
      assinatura([pix, debito, credito, dinheiro])
    );
    assert.equal(classificarTipoRecebimento(parcela('pix', 20, 'pendente', { aprovado: false })), null);
    assert.equal(classificarTipoRecebimento(parcela('cartao_debito', 20, 'rejeitada', { aprovado: false })), null);
    assert.equal(classificarTipoRecebimento(parcela('prazo', 10, 'informada')), null);
    const soDinheiro = calcularReferenciasConfirmadas([parcela('dinheiro', 60, 'informada', { confirmacao_manual: 1 })]);
    assert.equal(soDinheiro.valor_fiscal_referencia, 0);
    assert.equal(soDinheiro.valor_nao_fiscal_referencia, 60);
    const soEletronico = calcularReferenciasConfirmadas([parcela('pix', 60, 'aprovada', { aprovado: true })]);
    assert.equal(soEletronico.valor_fiscal_referencia, 60);
    assert.equal(soEletronico.valor_nao_fiscal_referencia, 0);
    const pendente = calcularReferenciasConfirmadas([
      parcela('pix', 20, 'pendente', { aprovado: false }),
      dinheiro
    ]);
    assert.equal(pendente.valor_fiscal_referencia, 0);
    assert.equal(pendente.valor_nao_fiscal_referencia, 10);
  });

  it('11. separação pela forma bloqueia o carrinho integral mesmo sem totais gravados', () => {
    const pagamentos = [
      parcela('pix', 20, 'aprovada', { aprovado: true }),
      parcela('cartao_debito', 20, 'aprovada', { aprovado: true }),
      parcela('cartao_credito', 10, 'aprovada', { aprovado: true }),
      parcela('dinheiro', 10, 'informada', { aprovado: false, confirmacao_manual: 1 })
    ];
    const venda = { valor_fiscal: 0, valor_nao_fiscal: 0, total: 60, pagamentos };
    const resolvido = resolverPagamentosNfce(venda, 60);
    assert.equal(resolvido.separacaoExigida, true);
    assert.equal(resolvido.pagamentos.some((pagamento) => pagamento.forma_pagamento === 'dinheiro'), false);
    const selecao = selecionarItensFiscaisParaNfce(venda, [{
      produto_id: 1, quantidade: 1, subtotal: 60, quantidade_fiscal: 1, valor_fiscal: 60
    }]);
    assert.equal(selecao.bloqueado, true);
    assert.equal(selecao.codigo, 'DISTRIBUICAO_NAO_AUTORIZADA');
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });

  before(async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
      db.whenReady((err) => { clearTimeout(timer); if (err) reject(err); else resolve(); });
    });
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Pastelaria Sprint 34' },
      { db }
    );
    const catPastel = await run(`INSERT INTO categorias (nome, tipo) VALUES ('PASTEIS', 'produto')`);
    const catRefri = await run(`INSERT INTO categorias (nome, tipo) VALUES ('REFRIGERANTES', 'produto')`);
    pastelId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel sprint 34', ?, 'UN', 'COMERCIAL', 1, '21069090', '5102', '102', 100, 100, 200, 10, 1)`,
      [catPastel.lastID]
    )).lastID;
    refId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         utiliza_volume, volume_valor, volume_unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual,
         preco_venda, ativo
       ) VALUES ('Refrigerante sprint 34', ?, 'UN', 'COMERCIAL', 1, '22021000', '5102', '102',
         1, 200, 'ML', 100, 100, 200, 5, 1)`,
      [catRefri.lastID]
    )).lastID;
    for (const produtoId of [pastelId, refId]) {
      await EstoqueEmpresaService.criarRegistro({
        produtoId, empresaId: empresaA.id, saldo_fiscal: 100, saldo_nao_fiscal: 100, estoque_atual: 200
      }, { db });
      await run(
        `UPDATE produtos SET saldo_fiscal = 100, saldo_nao_fiscal = 100, estoque_atual = 200 WHERE id = ?`,
        [produtoId]
      );
    }
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op34', 'x', 'operador', 'Operador 34', 'CAIXA', 1)`
    );
    await run(`INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [operador.lastID, empresaA.id]);
    token = jwt.sign(
      { id: operador.lastID, usuario_id: operador.lastID, username: 'op34', role: 'operador', perfil: 'CAIXA' },
      getJwtSecret(), { expiresIn: '2h' }
    );
    terminalId = (await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-34', 'sprint34')`)).lastID;
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
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function pedido(chave, pagamentos) {
    return {
      origem: 'PDV', terminal_id: terminalId, chave_fechamento_pdv: chave,
      venda_fiscal: true, emitir_fiscal: false, pagamento_sequencial: true,
      confirmacao_fiscal_manual: true, forma_pagamento: 'misto', desconto: 0, acrescimo: 0,
      total: 60, valor_recebido: 60,
      itens: [
        { produto_id: pastelId, quantidade: 2, preco_unitario: 10, subtotal: 20, categoria_nome: 'PASTEIS', ncm: '21069090', unidade: 'UN' },
        { produto_id: refId, quantidade: 8, preco_unitario: 5, subtotal: 40, categoria_nome: 'REFRIGERANTES', ncm: '22021000', unidade: 'UN' }
      ],
      pagamentos
    };
  }

  const mistos = [
    parcela('dinheiro', 10, 'informada', { aprovado: false, confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' }),
    parcela('pix', 20, 'aprovada', { aprovado: true, tipo_recebimento: 'fiscal' }),
    parcela('cartao_debito', 20, 'aprovada', { aprovado: true, tipo_recebimento: 'fiscal' }),
    parcela('cartao_credito', 10, 'aprovada', { aprovado: true, tipo_recebimento: 'fiscal' })
  ];

  it('1 e 12. sem autorização a classificação permanece e a nota fecha na emissão', async () => {
    delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
    const resposta = await httpJson('/api/vendas', pedido('pdv-sprint34-sem-auth', mistos));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(resposta.body.documento_fiscal.bloqueado, true);
    assert.equal(Number(resposta.body.valor_fiscal), 0);
    const recebimentos = await all(
      `SELECT forma_pagamento, valor, tipo_recebimento FROM venda_recebimentos WHERE venda_id = ?`,
      [resposta.body.venda_id]
    );
    const porForma = Object.fromEntries(recebimentos.map((linha) => [linha.forma_pagamento, linha.tipo_recebimento]));
    assert.equal(porForma.pix, 'fiscal');
    assert.equal(porForma.cartao_debito, 'fiscal');
    assert.equal(porForma.cartao_credito, 'fiscal');
    assert.equal(porForma.dinheiro, 'nao_fiscal');
    const repetida = await httpJson('/api/vendas', pedido('pdv-sprint34-sem-auth', mistos));
    assert.equal(Number(repetida.body.venda_id), Number(resposta.body.venda_id));
    assert.equal(repetida.body.venda_ja_persistida, true);
    const emissao = await emitirPorVendaId(resposta.body.venda_id, {
      db, empresaIdContexto: empresaA.id, naoTransmitir: true,
      getFiscalConfig: async () => ({ ...CFG, empresaId: empresaA.id })
    }).catch((erro) => erro);
    assert.equal(emissao.status, 'xml_preparado', emissao.message || emissao.status);
    assert.equal(Number(emissao.valores.vNF), 50);
    assert.equal(Number(emissao.valores.vDesc), 0);
    assert.equal(emissao.xml.includes('<tPag>01</tPag>'), false);
  });

  it('10. com autorização o XML usa só o fiscal e o dinheiro fica de fora', async () => {
    process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR = '1';
    const resposta = await httpJson('/api/vendas', pedido('pdv-sprint34-autorizada', mistos));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(Number(resposta.body.valor_fiscal), 50);
    assert.equal(Number(resposta.body.valor_nao_fiscal), 10);
    const recebimentos = await all(
      `SELECT forma_pagamento, tipo_recebimento FROM venda_recebimentos WHERE venda_id = ?`,
      [resposta.body.venda_id]
    );
    const porForma = Object.fromEntries(recebimentos.map((linha) => [linha.forma_pagamento, linha.tipo_recebimento]));
    assert.equal(porForma.dinheiro, 'nao_fiscal');
    assert.equal(porForma.pix, 'fiscal');
    const emissao = await emitirPorVendaId(resposta.body.venda_id, {
      db, empresaIdContexto: empresaA.id, naoTransmitir: true,
      getFiscalConfig: async () => ({ ...CFG, empresaId: empresaA.id })
    });
    assert.equal(emissao.transmitido, false, JSON.stringify(emissao));
    assert.match(emissao.xml, /<vNF>50\.00<\/vNF>/);
    assert.match(emissao.xml, /<vProd>50\.00<\/vProd>/);
    assert.doesNotMatch(emissao.xml, /<tPag>01<\/tPag>/);
    const quantidades = [...emissao.xml.matchAll(/<qCom>([\d.]+)<\/qCom>/g)].map((achado) => Number(achado[1]));
    assert.ok(quantidades.every((quantidade) => Number.isInteger(quantidade)));
  });
});
