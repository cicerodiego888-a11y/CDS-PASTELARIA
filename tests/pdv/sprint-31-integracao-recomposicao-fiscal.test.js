/**
 * Sprint 31 — referência financeira, distribuição F×NF e XML da NFC-e.
 * Banco temporário. Sem TEF, PIX, adquirente ou SEFAZ reais.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-31-integracao-recomposicao-fiscal.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint31-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
// Regressão Sprint 31: isola autorização via env/harness (sem fechamento operacional ATIVACAO-01).
process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL = '0';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;
delete process.env.RECOMPOSICAO_HABILITADA_EM_PRODUCAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint31-');
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
  avaliarReferenciaRecomposicao,
  marcarParcelaEletronicaComprovada
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const {
  comprovarPagamentosParaReferenciaFiscal
} = require('../../backend/services/OrquestradorPagamento');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const vendasRouter = require('../../backend/rotas/vendas');
const { emitirPorVendaId, selecionarItensFiscaisParaNfce } = require('../../backend/services/fiscal/emissor');
const { buildNfceXml, resolverPagamentosNfce } = require('../../backend/services/fiscal/xmlBuilder');

configService.getModoConfirmacaoFiscal = function modoTef() { return 'TEF'; };
tefConfigService.obterConfiguracao = async function cfg() { return { tefHabilitado: false, pix: false }; };
tefManager.autorizar = async function bloqueada() {
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};

const CFG = Object.freeze({
  codigoUf: '23',
  cnpj: '11222333000181',
  ie: '073252638',
  crt: 1,
  ambiente: 2,
  serie: 1,
  nomeEmpresa: 'EMPRESA TESTE LTDA',
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
let empresaB;
let operadorId;
let token;
let terminalId;
let seqTef31 = 0;
let server;
let pastelId;
let ref200Id;
let ref300Id;
let semModeloId;
const evidencia = {};

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
  return {
    forma_pagamento: forma,
    valor,
    status_autorizacao: status,
    ...extra
  };
}

async function exportarReal(linhas) {
  PagamentoSequencial.reset();
  const autorizarTef = async (forma) => ({
    aprovado: true,
    status: 'aprovado',
    transacao_id: `sim-${forma}`
  });
  for (const linha of linhas) {
    const retorno = await PagamentoSequencial.adicionar({
      forma: linha.forma,
      valor: linha.valor,
      totalVenda: 60,
      autorizarTef: linha.autorizar || autorizarTef
    });
    if (linha.esperarOk === false) {
      assert.equal(retorno.ok, false);
    }
  }
  return PagamentoSequencial.exportar();
}

function referenciaDe(pagamentos, total = 60) {
  return avaliarReferenciaRecomposicao({
    total,
    pagamentos,
    pagamento_sequencial: true
  });
}

function pedido(chave, pagamentos, itens, total, extra = {}) {
  return {
    origem: 'PDV',
    terminal_id: terminalId,
    chave_fechamento_pdv: chave,
    venda_fiscal: true,
    emitir_fiscal: false,
    pagamento_sequencial: true,
    confirmacao_fiscal_manual: pagamentos.some((pagamento) => pagamento.forma_pagamento === 'dinheiro'),
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

function carrinhoPrincipal() {
  return [
    item(pastelId, 2, 10, 'PASTEIS'),
    item(ref200Id, 8, 5, 'REFRIGERANTES')
  ];
}

async function pagamentosPrincipais(dinheiro = {}) {
  const eletronicos = [
    { forma: 'pix', valor: 20, tipo: 'pix_tef', nsu: 'NSU-SIM', aut: 'AUT-SIM' },
    { forma: 'cartao_debito', valor: 20, tipo: 'cartao_debito', nsu: 'NSU-DEB', aut: 'AUT-DEB' },
    { forma: 'cartao_credito', valor: 10, tipo: 'cartao_credito', nsu: 'NSU-CRE', aut: 'AUT-CRE' }
  ];
  const lista = [];
  for (const item of eletronicos) {
    seqTef31 += 1;
    const nsu = `${item.nsu}-${seqTef31}`;
    const aut = `${item.aut}-${seqTef31}`;
    const tef = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, status, provedor, nsu, autorizacao
       ) VALUES (NULL, ?, ?, ?, ?, 'aprovado', 'SITEF', ?, ?)`,
      [empresaA.id, operadorId, item.tipo, item.valor, nsu, aut]
    );
    lista.push(marcarParcelaEletronicaComprovada(parcela(item.forma, item.valor, 'aprovada', {
      aprovado: true,
      tef_transacao_id: tef.lastID,
      nsu,
      autorizacao: aut,
      tipo_recebimento: 'fiscal'
    })));
  }
  lista.push(parcela('dinheiro', 10, 'informada', {
    aprovado: false,
    tipo_recebimento: 'nao_fiscal',
    confirmacao_manual: 1,
    ...dinheiro
  }));
  return lista;
}

describe('Sprint 31 — integração da referência fiscal', { concurrency: false }, () => {
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
      { cnpj: '11222333000181', razao_social: 'Pastelaria Sprint 31 A' },
      { db }
    );
    empresaB = await EmpresaService.criarEmpresa(
      { cnpj: '11444777000161', razao_social: 'Pastelaria Sprint 31 B' },
      { db }
    );
    await run('UPDATE empresas SET ativo = 0 WHERE id = ?', [empresaB.id]);
    const catPastel = await run(`INSERT INTO categorias (nome, tipo) VALUES ('PASTEIS', 'produto')`);
    const catRefri = await run(`INSERT INTO categorias (nome, tipo) VALUES ('REFRIGERANTES', 'produto')`);
    const catOutra = await run(`INSERT INTO categorias (nome, tipo) VALUES ('DOCES', 'produto')`);
    pastelId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel de teste', ?, 'UN', 'COMERCIAL', 1, '21069090', '5102', '102', 20, 20, 40, 10, 1)`,
      [catPastel.lastID]
    )).lastID;
    ref200Id = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         utiliza_volume, volume_valor, volume_unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual,
         preco_venda, ativo
       ) VALUES ('Refrigerante teste 200', ?, 'UN', 'COMERCIAL', 1, '22021000', '5102', '102',
         1, 200, 'ML', 20, 20, 40, 5, 1)`,
      [catRefri.lastID]
    )).lastID;
    ref300Id = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         utiliza_volume, volume_valor, volume_unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual,
         preco_venda, ativo
       ) VALUES ('Item fora do modelo', ?, 'UN', 'COMERCIAL', 1, '22021000', '5102', '102',
         0, NULL, NULL, 20, 20, 40, 5, 1)`,
      [catOutra.lastID]
    )).lastID;
    semModeloId = (await run(
      `INSERT INTO produtos (
         nome, categoria_id, unidade, tipo_operacional, controla_estoque, ncm,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Doce sem modelo', ?, 'UN', 'COMERCIAL', 1, '19059090', 10, 10, 20, 10, 1)`,
      [catOutra.lastID]
    )).lastID;
    for (const produtoId of [pastelId, ref200Id, ref300Id, semModeloId]) {
      await EstoqueEmpresaService.criarRegistro({
        produtoId, empresaId: empresaA.id, saldo_fiscal: 20, saldo_nao_fiscal: 20, estoque_atual: 40
      }, { db });
    }
    await EstoqueEmpresaService.criarRegistro({
      produtoId: ref200Id, empresaId: empresaB.id, saldo_fiscal: 50, saldo_nao_fiscal: 50, estoque_atual: 100
    }, { db });
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op31', 'x', 'operador', 'Operador 31', 'CAIXA', 1)`
    );
    operadorId = operador.lastID;
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operadorId, empresaA.id]
    );
    token = jwt.sign(
      { id: operadorId, usuario_id: operadorId, username: 'op31', role: 'operador', perfil: 'CAIXA' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    terminalId = (await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-31', 'sprint31')`)).lastID;
    const turno = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalId, operador.lastID]
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
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT31_EVIDENCIA ${JSON.stringify(evidencia)}`);
  });

  it('1 a 8. exportar real separa dinheiro confirmado e ignora parcela eletrônica incompleta', async () => {
    const exportado = await exportarReal([
      { forma: 'pix', valor: 20, status: 'aprovada' },
      { forma: 'cartao_debito', valor: 20, status: 'aprovada' },
      { forma: 'cartao_credito', valor: 10, status: 'aprovada' },
      { forma: 'dinheiro', valor: 10, status: 'informada' }
    ]);
    const dinheiro = exportado.find((linha) => linha.forma_pagamento === 'dinheiro');
    assert.equal(dinheiro.tipo_recebimento, 'nao_fiscal');
    assert.equal(dinheiro.confirmacao_manual, 1);
    assert.equal(dinheiro.aprovado, undefined);
    // Payload do frontend sozinho não autoriza referência fiscal.
    assert.equal(referenciaDe(exportado).valor_fiscal_referencia, 0);
    const carimbados = exportado.map((linha) => (
      linha.forma_pagamento === 'dinheiro'
        ? linha
        : marcarParcelaEletronicaComprovada(linha)
    ));
    const ref = referenciaDe(carimbados);
    assert.equal(ref.valor_fiscal_referencia, 50);
    assert.equal(ref.valor_nao_fiscal_referencia, 10);

    const manualAntigo = referenciaDe(await pagamentosPrincipais());
    assert.equal(manualAntigo.valor_fiscal_referencia, 50);
    assert.equal(manualAntigo.valor_nao_fiscal_referencia, 10);

    const soDinheiro = referenciaDe([
      parcela('dinheiro', 60, 'informada', { aprovado: false, confirmacao_manual: 1 })
    ]);
    assert.equal(soDinheiro.valor_fiscal_referencia, 0);
    assert.equal(soDinheiro.valor_nao_fiscal_referencia, 60);

    const soEletronico = referenciaDe([
      marcarParcelaEletronicaComprovada(
        parcela('pix', 60, 'aprovada', { aprovado: true, nsu: 'NSU-SIM', autorizacao: 'AUT-SIM' })
      )
    ]);
    assert.equal(soEletronico.valor_fiscal_referencia, 60);
    assert.equal(soEletronico.valor_nao_fiscal_referencia, 0);

    const pendente = referenciaDe([
      marcarParcelaEletronicaComprovada(
        parcela('pix', 20, 'aprovada', { aprovado: true, nsu: 'NSU-SIM', autorizacao: 'AUT-SIM' })
      ),
      parcela('cartao_debito', 20, 'pendente', { aprovado: false }),
      parcela('dinheiro', 20, 'informada', { aprovado: false, confirmacao_manual: 1 })
    ]);
    assert.equal(pendente.valor_fiscal_referencia, 20);
    assert.equal(pendente.valor_nao_fiscal_referencia, 20);

    const rejeitada = referenciaDe([
      parcela('pix', 50, 'rejeitada', { aprovado: false }),
      parcela('dinheiro', 10, 'informada', { aprovado: false, confirmacao_manual: 1 })
    ]);
    assert.equal(rejeitada.valor_fiscal_referencia, 0);
    assert.equal(rejeitada.valor_nao_fiscal_referencia, 10);
  });

  it('1 e 2. dinheiro integral fica fora da NFC-e e venda eletrônica permanece fiscal', async () => {
    const dinheiro = await httpJson('/api/vendas', pedido(
      'pdv-sprint31-so-dinheiro',
      [parcela('dinheiro', 60, 'informada', { aprovado: false, confirmacao_manual: 1, tipo_recebimento: 'nao_fiscal' })],
      carrinhoPrincipal(),
      60
    ));
    assert.equal(dinheiro.status, 200, JSON.stringify(dinheiro.body));
    assert.equal(Number(dinheiro.body.valor_fiscal), 0);
    assert.equal(Number(dinheiro.body.valor_nao_fiscal), 60);
    const tef = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, parcelas, status, provedor, nsu, autorizacao, criado_em, atualizado_em
       ) VALUES (NULL, ?, ?, 'pix_tef', 60, 1, 'aprovado', 'SITEF', 'NSU-SIM-60', 'AUT-SIM-60', datetime('now'), datetime('now'))`,
      [empresaA.id, operadorId]
    );
    const eletronica = await httpJson('/api/vendas', pedido(
      'pdv-sprint31-so-eletronica',
      [parcela('pix', 60, 'aprovada', {
        aprovado: true,
        tipo_recebimento: 'fiscal',
        tef_transacao_id: tef.lastID,
        nsu: 'NSU-SIM-60',
        autorizacao: 'AUT-SIM-60'
      })],
      carrinhoPrincipal(),
      60
    ));
    assert.equal(eletronica.status, 200, JSON.stringify(eletronica.body));
    assert.equal(Number(eletronica.body.valor_fiscal), 60);
    assert.equal(Number(eletronica.body.valor_nao_fiscal), 0);
  });

  it('13. sem autorização do distribuidor a venda permanece e o fiscal fica bloqueado', async () => {
    delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
    const antes = await get('SELECT COUNT(*) AS n FROM vendas');
    const resposta = await httpJson('/api/vendas', pedido(
      'pdv-sprint31-sem-autorizacao',
      (await pagamentosPrincipais()),
      carrinhoPrincipal(),
      60
    ));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(resposta.body.documento_fiscal.bloqueado, true);
    assert.ok(resposta.body.documento_fiscal.codigo);
    assert.equal(Number(resposta.body.valor_fiscal), 0);
    const itens = await all(
      'SELECT quantidade_fiscal, valor_fiscal FROM vendas_itens WHERE venda_id = ?',
      [resposta.body.venda_id]
    );
    assert.ok(itens.every((linha) => Number(linha.quantidade_fiscal) === 0));
    const depois = await get('SELECT COUNT(*) AS n FROM vendas');
    assert.equal(Number(depois.n), Number(antes.n) + 1);
    evidencia.semAutorizacao = resposta.body.documento_fiscal.codigo;

    const anterior = process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
    delete process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
    const semAmbiente = await httpJson('/api/vendas', pedido(
      'pdv-sprint31-sem-ambiente',
      (await pagamentosPrincipais()),
      carrinhoPrincipal(),
      60
    ));
    process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = anterior;
    assert.equal(semAmbiente.status, 200, JSON.stringify(semAmbiente.body));
    assert.equal(semAmbiente.body.documento_fiscal.codigo, 'RECOMPOSICAO_NAO_AUTORIZADA');
    assert.equal(Number(semAmbiente.body.valor_fiscal), 0);
  });

  it('cenário principal, 14, 17 e 18. distribuição autorizada persiste e a NFC-e usa só o fiscal', async () => {
    process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR = '1';
    const chave = 'pdv-sprint31-principal';
    const resposta = await httpJson('/api/vendas', pedido(
      chave,
      (await pagamentosPrincipais()),
      carrinhoPrincipal(),
      60
    ));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(resposta.body.documento_fiscal, null);
    assert.equal(Number(resposta.body.valor_fiscal), 50);
    assert.equal(Number(resposta.body.valor_nao_fiscal), 10);
    const vendaId = Number(resposta.body.venda_id);

    const linhas = await all(
      `SELECT produto_id, quantidade, subtotal, quantidade_fiscal, valor_fiscal,
              quantidade_nao_fiscal, valor_nao_fiscal
       FROM vendas_itens WHERE venda_id = ? ORDER BY produto_id`,
      [vendaId]
    );
    const somaFiscal = linhas.reduce((total, linha) => total + Number(linha.valor_fiscal), 0);
    const somaNao = linhas.reduce((total, linha) => total + Number(linha.valor_nao_fiscal), 0);
    assert.equal(Math.round(somaFiscal * 100) / 100, 50);
    assert.equal(Math.round(somaNao * 100) / 100, 10);
    assert.ok(linhas.some((linha) => Number(linha.quantidade_nao_fiscal) > 0));

    const repetida = await httpJson('/api/vendas', pedido(
      chave,
      (await pagamentosPrincipais()),
      carrinhoPrincipal(),
      60
    ));
    assert.equal(Number(repetida.body.venda_id), vendaId);
    assert.equal(repetida.body.venda_ja_persistida, true);
    const contagem = await get('SELECT COUNT(*) AS n FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    assert.equal(Number(contagem.n), linhas.length);

    const carregada = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM vendas WHERE id = ?', [vendaId], (err, row) => (err ? reject(err) : resolve(row)));
    });
    const pagamentos = await all(
      `SELECT forma_pagamento, valor, tipo_recebimento, status,
              tef_transacao_id, nsu, autorizacao
       FROM venda_recebimentos WHERE venda_id = ?`,
      [vendaId]
    );
    const itensDocumento = linhas.map((linha) => ({
      ...linha,
      produto_nome: 'Item teste',
      ncm: linha.produto_id === pastelId ? '21069090' : '22021000',
      cfop: '5102',
      csosn: '102',
      unidade: 'UN',
      origem: 0
    }));
    const pagamentosComprovados = (await comprovarPagamentosParaReferenciaFiscal(pagamentos, {
      empresaId: empresaA.id,
      operadorId,
      vendaIdPermitida: vendaId,
      db
    })).pagamentos;
    const selecao = selecionarItensFiscaisParaNfce({
      ...carregada,
      pagamentos: pagamentosComprovados
    }, itensDocumento);
    assert.equal(selecao.bloqueado, false);
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
    assert.equal(emissao.transmitido, false, JSON.stringify(emissao));
    assert.equal(emissao.status, 'xml_preparado');
    const xml = emissao.xml;
    assert.match(xml, /<vNF>50\.00<\/vNF>/);
    assert.doesNotMatch(xml, /<tPag>01<\/tPag>/);
    const vPag = [...xml.matchAll(/<vPag>([\d.]+)<\/vPag>/g)].map((achado) => Number(achado[1]));
    assert.equal(Math.round(vPag.reduce((a, b) => a + b, 0) * 100) / 100, 50);

    const comercial = itensDocumento.map((linha) => ({
      ...linha,
      quantidade_fiscal: linha.quantidade,
      valor_fiscal: linha.subtotal,
      quantidade_nao_fiscal: 0,
      valor_nao_fiscal: 0
    }));
    const bloqueioComercial = selecionarItensFiscaisParaNfce({
      ...carregada,
      pagamentos: pagamentosComprovados
    }, comercial);
    assert.equal(bloqueioComercial.bloqueado, true);
    assert.equal(bloqueioComercial.codigo, 'DISTRIBUICAO_NAO_AUTORIZADA');

    evidencia.principal = {
      vendaId,
      valorFiscal: Number(resposta.body.valor_fiscal),
      valorNaoFiscal: Number(resposta.body.valor_nao_fiscal),
      linhas,
      pagamentos,
      vNF: 50,
      vPag
    };
  });

  it('9 a 12 e 16. bloqueios de composição, empresa e divergência não montam NFC-e', async () => {
    const semPastel = await httpJson('/api/vendas', pedido(
      'pdv-sprint31-sem-pastel',
      (await pagamentosPrincipais()),
      [item(ref200Id, 12, 5, 'REFRIGERANTES')],
      60
    ));
    assert.equal(semPastel.body.documento_fiscal.codigo, 'SEM_PASTEL_ELEGIVEL');
    assert.equal(Number(semPastel.body.valor_fiscal), 0);

    await run(
      `UPDATE estoque_empresa SET saldo_fiscal = 0 WHERE empresa_id = ? AND produto_id = ?`,
      [empresaA.id, ref200Id]
    );
    const semSaldo = await httpJson('/api/vendas', pedido(
      'pdv-sprint31-sem-saldo',
      (await pagamentosPrincipais()),
      carrinhoPrincipal(),
      60
    ));
    assert.equal(semSaldo.body.documento_fiscal.bloqueado, true);
    assert.equal(Number(semSaldo.body.valor_fiscal), 0);
    const outraEmpresa = await get(
      'SELECT saldo_fiscal FROM estoque_empresa WHERE empresa_id = ? AND produto_id = ?',
      [empresaB.id, ref200Id]
    );
    assert.equal(Number(outraEmpresa.saldo_fiscal), 50);

    await run('UPDATE produtos SET ativo = 0 WHERE id = ?', [ref200Id]);
    const tefSemModelo = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, status, provedor, nsu, autorizacao
       ) VALUES (NULL, ?, ?, 'pix_tef', 15, 'aprovado', 'SITEF', 'NSU-SEM-MOD', 'AUT-SEM-MOD')`,
      [empresaA.id, operadorId]
    );
    const semModelo = await httpJson('/api/vendas', pedido(
      'pdv-sprint31-sem-modelo',
      [
        parcela('pix', 15, 'aprovada', {
          aprovado: true,
          tef_transacao_id: tefSemModelo.lastID,
          nsu: 'NSU-SEM-MOD',
          autorizacao: 'AUT-SEM-MOD'
        }),
        parcela('dinheiro', 5, 'informada', { aprovado: false, confirmacao_manual: 1 })
      ],
      [item(pastelId, 1, 10, 'PASTEIS'), item(semModeloId, 1, 10, 'DOCES')],
      20
    ));
    assert.equal(semModelo.status, 200, JSON.stringify(semModelo.body));
    assert.equal(semModelo.body.documento_fiscal.bloqueado, true);
    assert.equal(semModelo.body.documento_fiscal.codigo, 'COMPOSICAO_AUSENTE_NO_MOTOR');

    const divergente = selecionarItensFiscaisParaNfce({
      total: 60,
      pagamentos: (await pagamentosPrincipais())
    }, [{ produto_id: 1, quantidade: 1, subtotal: 60, quantidade_fiscal: 1, valor_fiscal: 60 }]);
    assert.equal(divergente.codigo, 'DISTRIBUICAO_NAO_AUTORIZADA');

    const pagamentosXml = resolverPagamentosNfce({
      valor_fiscal: 50,
      valor_nao_fiscal: 10,
      pagamentos: (await pagamentosPrincipais())
    }, 50);
    assert.equal(pagamentosXml.pagamentos.some((pagamento) => pagamento.forma_pagamento === 'dinheiro'), false);
    assert.equal(pagamentosXml.somaPagamentos, 50);
  });
});

