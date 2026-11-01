/**
 * Sprint 21I — reimpressão do cupom não fiscal com a empresa ativa.
 * Banco temporário. Não fecha venda, não chama TEF nem SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-i-reimpressao-empresa.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint21i-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint21i-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const vendasRouter = require('../../backend/rotas/vendas');

const CNPJ_A = '11222333000181';
const CNPJ_B = '11222333000262';

let empresaA;
let empresaB;
let produtoId;
let token;
let server;
let contexto;
const chamadas = [];
const avisos = [];
const cupons = [];

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function whenReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
    db.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

async function criarVenda({ empresaId, codigo, total, fiscal, naoFiscal, pagamentos, recebimentos, item }) {
  const venda = await run(`
    INSERT INTO vendas (
      codigo, data_venda, total, desconto, forma_pagamento, status, status_pagamento,
      valor_fiscal, valor_nao_fiscal, empresa_id
    ) VALUES (?, date('now','localtime'), ?, 0, 'cartao_credito', 'concluida', 'quitada', ?, ?, ?)
  `, [codigo, total, fiscal, naoFiscal, empresaId]);
  await run(`
    INSERT INTO vendas_itens (
      venda_id, produto_id, quantidade, preco_unitario, subtotal,
      valor_fiscal, valor_nao_fiscal, quantidade_fiscal, quantidade_nao_fiscal
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `, [
    venda.lastID,
    produtoId,
    total,
    total,
    item.fiscal,
    item.naoFiscal,
    item.qtdFiscal,
    item.qtdNaoFiscal
  ]);
  for (const pagamento of pagamentos) {
    await run(`
      INSERT INTO venda_pagamentos (
        venda_id, forma_pagamento, valor, tef_nsu, tef_autorizacao
      ) VALUES (?, ?, ?, ?, ?)
    `, [venda.lastID, pagamento.forma, pagamento.valor, pagamento.nsu || null, pagamento.autorizacao || null]);
  }
  for (const recebimento of recebimentos) {
    await run(`
      INSERT INTO venda_recebimentos (
        venda_id, tipo_recebimento, forma_pagamento, valor, nsu, autorizacao, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'aprovado')
    `, [
      venda.lastID,
      recebimento.tipo,
      recebimento.forma,
      recebimento.valor,
      recebimento.nsu || null,
      recebimento.autorizacao || null
    ]);
  }
  return venda.lastID;
}

function selecionarEmpresa(empresa) {
  contexto.CdsEmpresaContexto.persistir({
    id: empresa.id,
    cnpj: empresa.cnpj,
    razao_social: empresa.razao_social,
    nome_fantasia: empresa.nome_fantasia
  });
}

describe('Sprint 21I — reimpressão com empresa ativa', { concurrency: false }, () => {
  let idMista;
  let idEmpresaB;

  before(async () => {
    await whenReady();
    const cfgPath = path.join(dbDir, 'config', 'configuracoes.json');
    const cfgAtual = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfgAtual.modo_operacional_global = 'MULTIEMPRESA';
    cfgAtual.modo_operacao_venda = 'MULTIEMPRESA';
    cfgAtual.pdv_modelo_empresa = 'MULTIPLAS';
    fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Pastelaria A 21I', nome_fantasia: 'Pastelaria A' },
      { db }
    );
    empresaB = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_B, razao_social: 'Pastelaria B 21I', nome_fantasia: 'Pastelaria B' },
      { db }
    );
    produtoId = (await run(
      `INSERT INTO produtos (nome, unidade, preco_venda, ativo) VALUES ('Pastel de carne', 'UN', 10, 1)`
    )).lastID;
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo, troca_senha_obrigatoria)
       VALUES ('op21i', 'x', 'operador', 'Operador 21I', 'CAIXA', 1, 0)`
    );
    for (const empresa of [empresaA, empresaB]) {
      await run(
        `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
        [operador.lastID, empresa.id]
      );
    }
    token = jwt.sign(
      { id: operador.lastID, usuario_id: operador.lastID, username: 'op21i', role: 'operador', perfil: 'CAIXA' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    idMista = await criarVenda({
      empresaId: empresaA.id,
      codigo: 'H-MISTA',
      total: 10,
      fiscal: 6,
      naoFiscal: 4,
      item: { fiscal: 6, naoFiscal: 4, qtdFiscal: 1, qtdNaoFiscal: 1 },
      pagamentos: [{ forma: 'cartao_credito', valor: 10, nsu: 'NSU-COMERCIAL', autorizacao: 'AUT-COMERCIAL' }],
      recebimentos: [
        { tipo: 'fiscal', forma: 'cartao_credito', valor: 6, nsu: 'NSU-FISCAL', autorizacao: 'AUT-FISCAL' },
        { tipo: 'nao_fiscal', forma: 'cartao_credito', valor: 4, nsu: 'NSU-MISTA', autorizacao: 'AUT-MISTA' }
      ]
    });
    idEmpresaB = await criarVenda({
      empresaId: empresaB.id,
      codigo: 'H-OUTRA',
      total: 22,
      fiscal: 0,
      naoFiscal: 22,
      item: { fiscal: 0, naoFiscal: 22, qtdFiscal: 0, qtdNaoFiscal: 1 },
      pagamentos: [{ forma: 'cartao_credito', valor: 22, nsu: 'NSU-EMPRESA-B', autorizacao: 'AUT-EMPRESA-B' }],
      recebimentos: [{ tipo: 'nao_fiscal', forma: 'cartao_credito', valor: 22, nsu: 'NSU-EMPRESA-B', autorizacao: 'AUT-EMPRESA-B' }]
    });

    const app = express();
    app.use('/api/vendas', verificarToken, vendasRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);

    const memoria = new Map();
    contexto = {
      console,
      API_URL: `http://127.0.0.1:${server.address().port}/api`,
      localStorage: {
        getItem(chave) { return memoria.has(chave) ? memoria.get(chave) : null; },
        setItem(chave, valor) { memoria.set(chave, String(valor)); },
        removeItem(chave) { memoria.delete(chave); }
      },
      showNotification(mensagem) { avisos.push(String(mensagem)); },
      fetch: async (url, opcoes) => {
        chamadas.push({
          url: String(url),
          headers: { ...(opcoes && opcoes.headers) }
        });
        return fetch(url, opcoes);
      },
      open() {
        const documento = {
          html: '',
          open() {},
          close() {},
          write(html) { this.html += String(html); }
        };
        cupons.push(documento);
        return { document: documento, focus() {}, print() {} };
      }
    };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/cds-empresa-contexto.js'), 'utf8'),
      contexto
    );
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/fiscalImpressao.js'), 'utf8'),
      contexto
    );
    contexto.localStorage.setItem('token', token);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('I1 I2 I5 I6 I7 — empresa A reimprime H-MISTA com header, total 4,00 e NSU', async () => {
    chamadas.length = 0;
    avisos.length = 0;
    cupons.length = 0;
    selecionarEmpresa(empresaA);
    await contexto.reimprimirCupomNaoFiscalHistorico(idMista);

    const consulta = chamadas.find((chamada) => String(chamada.url).includes(`/vendas/${idMista}`));
    assert.ok(consulta, JSON.stringify(chamadas.map((c) => c.url)));
    assert.equal(consulta.headers['X-Empresa-Id'], String(empresaA.id));
    assert.equal(consulta.headers.Authorization, `Bearer ${token}`);
    assert.equal(cupons.length, 1);
    const html = cupons[0].html;
    assert.match(html, /Total: R\$ 4,00/);
    assert.match(html, /R\$ 4,00/);
    assert.equal(html.includes('NSU:'), false);
    assert.equal(html.includes('NSU-MISTA'), false);
    assert.equal(html.includes('Aut.:'), false);
    assert.equal(html.includes('Total: R$ 10,00'), false);
    assert.equal(html.includes('Total: R$ 14,00'), false);
    assert.equal(html.includes('Total: R$ 20,00'), false);
    assert.equal(html.includes('NSU-EMPRESA-B'), false);
    assert.equal(avisos.length, 0);
  });

  it('I3 — empresa B reimprime a própria venda com o header da empresa B', async () => {
    chamadas.length = 0;
    cupons.length = 0;
    selecionarEmpresa(empresaB);
    await contexto.reimprimirCupomNaoFiscalHistorico(idEmpresaB);

    const consulta = chamadas.find((chamada) => String(chamada.url).includes(`/vendas/${idEmpresaB}`));
    assert.ok(consulta);
    assert.equal(consulta.headers['X-Empresa-Id'], String(empresaB.id));
    assert.equal(consulta.headers.Authorization, `Bearer ${token}`);
    assert.equal(cupons.length, 1);
    assert.equal(cupons[0].html.includes('NSU:'), false);
    assert.equal(cupons[0].html.includes('NSU-EMPRESA-B'), false);
    assert.match(cupons[0].html, /Total: R\$ 22,00/);
    assert.equal(cupons[0].html.includes('NSU-MISTA'), false);
  });

  it('I4 — empresa ativa A não recebe a venda da empresa B', async () => {
    chamadas.length = 0;
    avisos.length = 0;
    cupons.length = 0;
    selecionarEmpresa(empresaA);
    await contexto.reimprimirCupomNaoFiscalHistorico(idEmpresaB);

    const consulta = chamadas.find((chamada) => String(chamada.url).includes(`/vendas/${idEmpresaB}`));
    assert.ok(consulta);
    assert.equal(consulta.headers['X-Empresa-Id'], String(empresaA.id));
    assert.equal(cupons.length, 0);
    assert.equal(avisos.some((aviso) => aviso.includes('NSU-EMPRESA-B')), false);
    assert.equal(avisos.length > 0, true);
  });

  it('I8 — sem empresa ativa não consulta a venda', async () => {
    chamadas.length = 0;
    avisos.length = 0;
    cupons.length = 0;
    contexto.CdsEmpresaContexto.limpar();
    await contexto.reimprimirCupomNaoFiscalHistorico(idMista);

    assert.equal(chamadas.length, 0);
    assert.equal(cupons.length, 0);
    assert.deepEqual(avisos, [
      'Selecione a empresa no seletor da barra lateral para continuar.'
    ]);
  });
});
