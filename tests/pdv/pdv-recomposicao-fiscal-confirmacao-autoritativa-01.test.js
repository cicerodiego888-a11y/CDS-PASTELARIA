/**
 * CDS-PDV-RECOMPOSICAO-FISCAL-CONFIRMACAO-AUTORITATIVA-01
 * Referência fiscal só com TEF persistido. Banco temporário. Sem TEF/PIX/SEFAZ reais.
 *
 * node --test --test-concurrency=1 tests/pdv/pdv-recomposicao-fiscal-confirmacao-autoritativa-01.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-conf-aut-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL = '0';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-conf-aut-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const {
  comprovarPagamentosParaReferenciaFiscal
} = require('../../backend/services/OrquestradorPagamento');
const {
  calcularReferenciasConfirmadas,
  parcelaEfetivamenteConfirmada,
  evidenciaConfirmacaoEletronica,
  avaliarReferenciaRecomposicao,
  marcarParcelaEletronicaComprovada
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  reescritaDeComposicaoNoEmissorAutorizada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');

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

async function inserirTef({
  empresaId,
  operadorId = null,
  tipo = 'pix_tef',
  valor = 70,
  status = 'aprovado',
  nsu = 'NSU-OK',
  autorizacao = 'AUT-OK',
  vendaId = null,
  provedor = 'SITEF'
}) {
  const r = await run(
    `INSERT INTO tef_transacoes (
       venda_id, empresa_id, operador_id, tipo, valor, status, provedor, nsu, autorizacao
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [vendaId, empresaId, operadorId, tipo, valor, status, provedor, nsu, autorizacao]
  );
  return r.lastID;
}

let empresaA;
let empresaB;
let operadorId;

describe('CDS-PDV-RECOMPOSICAO-FISCAL-CONFIRMACAO-AUTORITATIVA-01', { concurrency: false }, () => {
  before(async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
      db.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: '65957340000150', razao_social: 'Pastelaria Conf Aut A' },
      { db }
    );
    empresaB = await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Pastelaria Conf Aut B' },
      { db }
    );
    const op = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-conf', 'x', 'operador', 'Op Conf', 'CAIXA', 1)`
    );
    operadorId = op.lastID;
  });

  after(() => {
    try { isolamento.restaurar(); } catch (_) { /* ignore */ }
  });

  it('A. pagamento válido persistido entra na referência fiscal', async () => {
    const tefId = await inserirTef({
      empresaId: empresaA.id,
      operadorId,
      valor: 70,
      nsu: 'NSU-A',
      autorizacao: 'AUT-A'
    });
    const comprovacao = await comprovarPagamentosParaReferenciaFiscal([
      { forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', tef_transacao_id: tefId },
      { forma_pagamento: 'dinheiro', valor: 30, status_autorizacao: 'informada', confirmacao_manual: 1 }
    ], { empresaId: empresaA.id, operadorId, db });
    const pix = comprovacao.pagamentos.find((p) => p.forma_pagamento === 'pix');
    assert.equal(pix.confirmacao_eletronica_comprovada, true);
    assert.equal(evidenciaConfirmacaoEletronica(pix), true);
    const refs = calcularReferenciasConfirmadas(comprovacao.pagamentos);
    assert.equal(refs.valor_fiscal_referencia, 70);
    assert.equal(refs.valor_nao_fiscal_referencia, 30);
  });

  it('B. payload adulterado não aumenta a referência fiscal', async () => {
    const tefId = await inserirTef({
      empresaId: empresaA.id,
      operadorId,
      valor: 50,
      nsu: 'NSU-B',
      autorizacao: 'AUT-B',
      tipo: 'pix_tef'
    });
    const casos = [
      [{ forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', aprovado: true }],
      [{ forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', tef_transacao_id: 999999 }],
      [{ forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', nsu: 'INV', autorizacao: 'X' }],
      [{ forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', nsu: 'NSU-B', autorizacao: 'FAKE' }],
      [{ forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', nsu: 'FAKE', autorizacao: 'AUT-B' }],
      [{ forma_pagamento: 'pix', valor: 99, status_autorizacao: 'aprovada', tef_transacao_id: tefId }],
      [{ forma_pagamento: 'cartao_debito', valor: 50, status_autorizacao: 'aprovada', tef_transacao_id: tefId }],
      [{
        forma_pagamento: 'pix',
        valor: 50,
        status_autorizacao: 'aprovada',
        tef_transacao_id: tefId,
        // empresa divergente via contexto
      }]
    ];
    for (const pagamentos of casos.slice(0, 7)) {
      const r = await comprovarPagamentosParaReferenciaFiscal(pagamentos, {
        empresaId: empresaA.id,
        operadorId,
        db
      });
      assert.equal(
        calcularReferenciasConfirmadas(r.pagamentos).valor_fiscal_referencia,
        0,
        JSON.stringify(pagamentos)
      );
    }
    const outraEmpresa = await comprovarPagamentosParaReferenciaFiscal([
      { forma_pagamento: 'pix', valor: 50, status_autorizacao: 'aprovada', tef_transacao_id: tefId }
    ], { empresaId: empresaB.id, operadorId, db });
    assert.equal(
      calcularReferenciasConfirmadas(outraEmpresa.pagamentos).valor_fiscal_referencia,
      0
    );
    assert.equal(parcelaEfetivamenteConfirmada({
      forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', aprovado: true
    }), false);
    assert.equal(parcelaEfetivamenteConfirmada({
      forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', nsu: 'A', autorizacao: 'B'
    }), false);
  });

  it('C. estados inválidos ficam fora da referência', async () => {
    const statuses = ['pendente', 'negado', 'cancelado', 'estornado', 'rejeitada'];
    for (const status of statuses) {
      const id = await inserirTef({
        empresaId: empresaA.id,
        operadorId,
        valor: 40,
        status,
        nsu: `NSU-${status}`,
        autorizacao: `AUT-${status}`
      });
      const r = await comprovarPagamentosParaReferenciaFiscal([
        { forma_pagamento: 'pix', valor: 40, status_autorizacao: 'aprovada', tef_transacao_id: id }
      ], { empresaId: empresaA.id, operadorId, db });
      assert.equal(
        calcularReferenciasConfirmadas(r.pagamentos).valor_fiscal_referencia,
        0,
        status
      );
    }
    const inexistente = await comprovarPagamentosParaReferenciaFiscal([
      { forma_pagamento: 'pix', valor: 40, status_autorizacao: 'aprovada', tef_transacao_id: 888888 }
    ], { empresaId: empresaA.id, operadorId, db });
    assert.equal(calcularReferenciasConfirmadas(inexistente.pagamentos).valor_fiscal_referencia, 0);
  });

  it('D. anti-reuso: transação vinculada a outra venda', async () => {
    const id = await inserirTef({
      empresaId: empresaA.id,
      operadorId,
      valor: 70,
      nsu: 'NSU-REUSO',
      autorizacao: 'AUT-REUSO',
      vendaId: 55
    });
    const r = await comprovarPagamentosParaReferenciaFiscal([
      { forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', tef_transacao_id: id }
    ], { empresaId: empresaA.id, operadorId, db });
    assert.equal(calcularReferenciasConfirmadas(r.pagamentos).valor_fiscal_referencia, 0);

    const mesmaVenda = await comprovarPagamentosParaReferenciaFiscal([
      { forma_pagamento: 'pix', valor: 70, status_autorizacao: 'aprovada', tef_transacao_id: id }
    ], { empresaId: empresaA.id, operadorId, vendaIdPermitida: 55, db });
    assert.equal(calcularReferenciasConfirmadas(mesmaVenda.pagamentos).valor_fiscal_referencia, 70);
  });

  it('E. misto 100 = 70 fiscal + 30 gerencial (NSU+AUT inequívocos)', async () => {
    await inserirTef({
      empresaId: empresaA.id,
      operadorId,
      valor: 70,
      nsu: 'NSU-MISTO',
      autorizacao: 'AUT-MISTO',
      tipo: 'pix_tef'
    });
    const comprovacao = await comprovarPagamentosParaReferenciaFiscal([
      {
        forma_pagamento: 'pix',
        valor: 70,
        status_autorizacao: 'aprovada',
        nsu: 'NSU-MISTO',
        autorizacao: 'AUT-MISTO'
      },
      {
        forma_pagamento: 'dinheiro',
        valor: 30,
        status_autorizacao: 'informada',
        confirmacao_manual: 1
      }
    ], { empresaId: empresaA.id, operadorId, db });
    const refs = calcularReferenciasConfirmadas(comprovacao.pagamentos);
    assert.equal(refs.valor_fiscal_referencia, 70);
    assert.equal(refs.valor_nao_fiscal_referencia, 30);
    assert.equal(refs.valor_fiscal_referencia + refs.valor_nao_fiscal_referencia, 100);
    const avaliacao = avaliarReferenciaRecomposicao({
      total: 100,
      pagamentos: comprovacao.pagamentos,
      itens: []
    }, {
      env: process.env,
      contexto: {
        caixaSessaoId: 1,
        canalVendaHttp: 'PDV',
        chave_fechamento_pdv: 'chave-misto-01'
      }
    });
    // ambiente teste =1; operacional off — referência de teste ativa
    assert.equal(avaliacao.valor_fiscal_referencia, 70);
    assert.equal(avaliacao.valor_nao_fiscal_referencia, 30);
  });

  it('F. regressões exclusivas e proteção do emissor', async () => {
    const soDinheiro = calcularReferenciasConfirmadas([
      { forma_pagamento: 'dinheiro', valor: 100, status_autorizacao: 'informada', confirmacao_manual: 1 }
    ]);
    assert.equal(soDinheiro.valor_fiscal_referencia, 0);
    assert.equal(soDinheiro.valor_nao_fiscal_referencia, 100);

    const tefPix = await inserirTef({
      empresaId: empresaA.id,
      operadorId,
      valor: 100,
      nsu: 'NSU-SO-PIX',
      autorizacao: 'AUT-SO-PIX'
    });
    const soPix = await comprovarPagamentosParaReferenciaFiscal([
      { forma_pagamento: 'pix', valor: 100, status_autorizacao: 'aprovada', tef_transacao_id: tefPix }
    ], { empresaId: empresaA.id, operadorId, db });
    assert.equal(calcularReferenciasConfirmadas(soPix.pagamentos).valor_fiscal_referencia, 100);

    const recusado = await inserirTef({
      empresaId: empresaA.id,
      operadorId,
      valor: 100,
      status: 'negado',
      nsu: 'NSU-NEG',
      autorizacao: 'AUT-NEG'
    });
    const rNeg = await comprovarPagamentosParaReferenciaFiscal([
      { forma_pagamento: 'pix', valor: 100, status_autorizacao: 'aprovada', tef_transacao_id: recusado }
    ], { empresaId: empresaA.id, operadorId, db });
    assert.equal(calcularReferenciasConfirmadas(rNeg.pagamentos).valor_fiscal_referencia, 0);

    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
    assert.equal(
      evidenciaConfirmacaoEletronica(marcarParcelaEletronicaComprovada({
        forma_pagamento: 'pix', valor: 1, status_autorizacao: 'aprovado'
      })),
      true
    );
  });
});
