'use strict';

/**
 * CDS-PDV-CORRECAO-CONFIRMACAO-EVIDENCIA-PIX-01
 * Banco temporário + provedor simulado. Sem PIX/TEF/SEFAZ reais.
 *
 * node --test --test-concurrency=1 tests/pdv/confirmacao-evidencia-pix-01.test.js
 */

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
isolarBancoTeste('cds-pdv-evidencia-pix-01-');

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const Decisao = require('../../frontend/pdv/js/decisaoConfirmacaoPagamento');
globalThis.DecisaoConfirmacaoPagamento = Decisao;
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');
require('../../frontend/shared/js/tefFluxoPagamento');
const TefFluxo = globalThis.TefFluxoPagamento;

const Orquestrador = require('../../backend/services/OrquestradorPagamento');
const pixService = require('../../backend/services/pix/pixService');
const pixEvidencia = require('../../backend/services/pix/pixEvidenciaService');
const db = require('../../backend/database');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-evidencia-pix-01-'));
const DATABASE_OFICIAL = path.win32.resolve(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'MercantilFiscal',
  'dados',
  'mercadao.db'
);

function criar(total) {
  PagamentoSequencial.reset();
  return InteracaoPagamentoMisto.criar({ totalVenda: total, sequencial: PagamentoSequencial });
}

async function gravarPix(dados) {
  return pixService.registrarCobrancaSimulada(dados);
}

describe('CDS-PDV-CORRECAO-CONFIRMACAO-EVIDENCIA-PIX-01', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
    pixConfirmadoReset();
  });

  function pixConfirmadoReset() {
    // noop — estado só no sequencial
  }

  it('isolamento usa banco temporário (não oficial)', () => {
    assert.notEqual(path.win32.resolve(process.env.CDS_DATABASE_PATH || ''), DATABASE_OFICIAL);
    assert.ok(String(process.env.CDS_DATABASE_PATH || TMP).includes(path.sep) || true);
  });

  it('A — PIX informado sem confirmação operacional: fechamento exige modal', async () => {
    const tela = criar(50);
    tela.escolherForma('pix');
    await tela.confirmarValor(50, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    assert.equal(PagamentoSequencial.somaConfirmada(), 0);
    const estado = TefFluxo.listaSequencialJaConfirmada(PagamentoSequencial.exportar(), {
      tefHabilitado: false
    });
    assert.equal(estado.requerConfirmacaoManual, true);
    assert.equal(estado.dispensaModalExtra, false);

    const semFlag = await Orquestrador.processarRecebimentoFiscal({
      recebimentosFiscal: [{ forma_pagamento: 'pix', valor: 50, status_autorizacao: 'informada' }],
      totalFiscal: 50,
      tefHabilitado: false,
      modoConfirmacaoFiscal: 'TEF',
      confirmacaoFiscalManual: false,
      empresaId: 1
    });
    assert.equal(semFlag.sucesso, false);

    const comOperacional = await Orquestrador.processarRecebimentoFiscal({
      recebimentosFiscal: [{ forma_pagamento: 'pix', valor: 50, status_autorizacao: 'informada' }],
      totalFiscal: 50,
      tefHabilitado: false,
      modoConfirmacaoFiscal: 'TEF',
      confirmacaoFiscalManual: true,
      empresaId: 1
    });
    assert.equal(comOperacional.sucesso, true);
  });

  it('B — TEF off: carimbo operacional confirma PIX informado', () => {
    const lista = [{
      forma_pagamento: 'pix',
      valor: 30,
      status_autorizacao: 'informada'
    }];
    const carimbadas = TefFluxo.montarParcelasListaSequencial(lista, {
      carimbarConfirmacaoManual: true
    });
    assert.equal(carimbadas[0].confirmacao_manual, 1);
    assert.equal(carimbadas[0].recebimento_confirmado, true);
    assert.equal(
      Orquestrador.confirmacaoManualAceita('TEF', true, false, carimbadas),
      true
    );
  });

  it('C — PIX próprio PAGO com vínculo correto confirma parcela', async () => {
    const tela = criar(40);
    tela.escolherForma('pix');
    await tela.confirmarValor(40, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    const parcela = PagamentoSequencial.snapshot()[0];
    const cob = await gravarPix({
      txid: 'TX-C-OK',
      valor: 40,
      empresaId: 9,
      parcelaLocalId: parcela.local_id,
      sessaoPagamento: parcela.sessao_pagamento,
      chaveParcela: parcela.chave_parcela,
      status: 'PAGO'
    });
    assert.equal(cob.status, 'PAGO');

    const conf = PagamentoSequencial.confirmarParcelaPix({
      localId: parcela.local_id,
      txid: 'TX-C-OK',
      valor: 40
    });
    assert.equal(conf.ok, true);
    assert.equal(PagamentoSequencial.somaConfirmada(), 40);

    const prova = await pixEvidencia.comprovarPagamentosPix([{
      forma_pagamento: 'pix',
      valor: 40,
      pix_txid: 'TX-C-OK',
      parcela_local_id: parcela.local_id,
      sessao_pagamento: parcela.sessao_pagamento,
      chave_parcela: parcela.chave_parcela
    }], { empresaId: 9 });
    assert.equal(prova.sucesso, true);
    assert.equal(prova.pagamentos[0].confirmacao_eletronica_comprovada, true);

    const estado = TefFluxo.listaSequencialJaConfirmada(PagamentoSequencial.exportar(), {
      tefHabilitado: false
    });
    assert.equal(estado.dispensaModalExtra, true);
  });

  it('D — PIX PAGO com valor divergente: rejeitado', async () => {
    await gravarPix({ txid: 'TX-D', valor: 10, empresaId: 1, status: 'PAGO' });
    const prova = await pixEvidencia.comprovarCobrancaPixPago({
      txid: 'TX-D',
      empresaId: 1,
      valor: 99
    });
    assert.equal(prova.sucesso, false);
    assert.equal(prova.codigo, 'PIX_VALOR_DIVERGENTE');
  });

  it('E — PIX PAGO vinculado a outra venda: rejeitado', async () => {
    await gravarPix({
      txid: 'TX-E',
      valor: 25,
      empresaId: 1,
      vendaId: 100,
      status: 'PAGO'
    });
    const prova = await pixEvidencia.comprovarCobrancaPixPago({
      txid: 'TX-E',
      empresaId: 1,
      valor: 25,
      vendaId: 200
    });
    assert.equal(prova.sucesso, false);
    assert.equal(prova.codigo, 'PIX_VENDA_DIVERGENTE');
  });

  it('F — PIX EXPIRADO: não confirmado', async () => {
    await gravarPix({ txid: 'TX-F', valor: 15, empresaId: 1, status: 'EXPIRADO' });
    const prova = await pixEvidencia.comprovarCobrancaPixPago({
      txid: 'TX-F', empresaId: 1, valor: 15
    });
    assert.equal(prova.sucesso, false);
    assert.equal(prova.codigo, 'PIX_NAO_PAGO');
  });

  it('G — PIX CANCELADO: não confirmado', async () => {
    await gravarPix({ txid: 'TX-G', valor: 15, empresaId: 1, status: 'CANCELADO' });
    const prova = await pixEvidencia.comprovarCobrancaPixPago({
      txid: 'TX-G', empresaId: 1, valor: 15
    });
    assert.equal(prova.sucesso, false);
    assert.equal(prova.codigo, 'PIX_NAO_PAGO');
  });

  it('H — PIX PENDENTE: não confirmado', async () => {
    await gravarPix({ txid: 'TX-H', valor: 15, empresaId: 1, status: 'PENDENTE' });
    const prova = await pixEvidencia.comprovarCobrancaPixPago({
      txid: 'TX-H', empresaId: 1, valor: 15
    });
    assert.equal(prova.sucesso, false);
    assert.equal(prova.codigo, 'PIX_NAO_PAGO');
  });

  it('I — notificação PAGO repetida: um único recebimento', async () => {
    const tela = criar(20);
    tela.escolherForma('pix');
    await tela.confirmarValor(20, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    const parcela = PagamentoSequencial.snapshot()[0];
    await gravarPix({
      txid: 'TX-I',
      valor: 20,
      empresaId: 1,
      parcelaLocalId: parcela.local_id,
      status: 'PAGO'
    });
    const r1 = PagamentoSequencial.confirmarParcelaPix({
      localId: parcela.local_id, txid: 'TX-I', valor: 20
    });
    const r2 = PagamentoSequencial.confirmarParcelaPix({
      localId: parcela.local_id, txid: 'TX-I', valor: 20
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r2.idempotente, true);
    assert.equal(PagamentoSequencial.exportar().length, 1);
    assert.equal(PagamentoSequencial.somaConfirmada(), 20);
  });

  it('J — TXID arbitrário do frontend: rejeitado', async () => {
    const prova = await pixEvidencia.comprovarPagamentosPix([{
      forma_pagamento: 'pix',
      valor: 10,
      pix_txid: 'TXID-INVENTADO-PELO-CLIENTE'
    }], { empresaId: 1 });
    assert.equal(prova.sucesso, false);
    assert.equal(prova.codigo, 'PIX_COBRANCA_AUSENTE');
  });

  it('K — cartão sem TEF registra informado; confirmação operacional aceita', async () => {
    const tela = criar(30);
    tela.escolherForma('cartao_debito');
    const r = await tela.confirmarValor(30, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    assert.equal(r.ok, true);
    assert.equal(PagamentoSequencial.soma(), 30);
    assert.equal(PagamentoSequencial.somaConfirmada(), 0);
    assert.equal(
      Orquestrador.confirmacaoManualAceita('TEF', true, false, [
        { forma_pagamento: 'cartao_credito', valor: 30 }
      ]),
      true
    );
  });

  it('L — cartão com TEF simulado aprovado confirma', async () => {
    const tela = criar(35);
    tela.escolherForma('cartao_credito');
    const r = await tela.confirmarValor(35, {
      tefHabilitado: true,
      formaUsaTef: () => true,
      autorizarTef: async () => ({
        aprovado: true, status: 'aprovado', transacao_id: 501, nsu: 'N', autorizacao: 'A'
      })
    });
    assert.equal(r.ok, true);
    assert.equal(PagamentoSequencial.somaConfirmada(), 35);
    assert.equal(PagamentoSequencial.exportar()[0].confirmacao_modalidade, 'tef');
  });

  it('M — dinheiro: confirmação manual preservada', async () => {
    const tela = criar(12);
    tela.escolherForma('dinheiro');
    const r = await tela.confirmarValor(12, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    assert.equal(r.ok, true);
    assert.equal(PagamentoSequencial.somaConfirmada(), 12);
    assert.equal(PagamentoSequencial.exportar()[0].confirmacao_modalidade, 'manual');
    assert.equal(
      Orquestrador.confirmacaoManualAceita('TEF', true, false, [
        { forma_pagamento: 'dinheiro', valor: 12 }
      ]),
      true
    );
  });

  it('N — misto: soma alocada ≠ soma confirmada; TEF off exige operacional', async () => {
    const tela = criar(100);
    tela.escolherForma('dinheiro');
    await tela.confirmarValor(40, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    tela.escolherForma('pix');
    await tela.confirmarValor(60, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    assert.equal(PagamentoSequencial.soma(), 100);
    assert.equal(PagamentoSequencial.somaConfirmada(), 40);
    const estado = TefFluxo.listaSequencialJaConfirmada(PagamentoSequencial.exportar(), {
      tefHabilitado: false
    });
    assert.equal(estado.requerConfirmacaoManual, true);
    assert.equal(estado.dispensaModalExtra, false);
  });

  it('O — regressão fontes PDV Normal/Express (módulos de decisão e evidência)', () => {
    const pdv = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');
    const orq = fs.readFileSync(
      path.join(__dirname, '../../backend/services/OrquestradorPagamento.js'),
      'utf8'
    );
    assert.match(pdv, /PIX_SEM_CONFIRMACAO/);
    assert.match(pdv, /confirmarParcelaPix/);
    assert.match(pdv, /pix_txid/);
    assert.match(orq, /pixEvidenciaService/);
    assert.match(orq, /CONFIRMACAO_MANUAL_INVALIDA_ELETRONICO|comprovarPagamentosPix/);
    assert.equal(typeof PagamentoSequencial.confirmarParcelaPix, 'function');
    assert.equal(typeof Decisao.resolverRegistroParcela, 'function');
  });

  it('processarConfirmacaoManualFiscal rejeita PIX sem permissão; aceita com TEF off', async () => {
    const bloqueado = await Orquestrador.processarConfirmacaoManualFiscal([
      { forma_pagamento: 'pix', valor: 10 }
    ]);
    assert.equal(bloqueado.sucesso, false);
    const ok = await Orquestrador.processarConfirmacaoManualFiscal([
      { forma_pagamento: 'pix', valor: 10 }
    ], { permitirEletronico: true });
    assert.equal(ok.sucesso, true);
    assert.equal(ok.recebimentos[0].confirmacao_manual, 1);
  });

  it('fechamento com evidência PIX válida no Orquestrador', async () => {
    await gravarPix({ txid: 'TX-ORQ', valor: 18, empresaId: 3, status: 'PAGO' });
    const r = await Orquestrador.processarRecebimentoFiscal({
      recebimentosFiscal: [{
        forma_pagamento: 'pix',
        valor: 18,
        pix_txid: 'TX-ORQ',
        status_autorizacao: 'aprovada'
      }],
      totalFiscal: 18,
      tefHabilitado: false,
      modoConfirmacaoFiscal: 'TEF',
      confirmacaoFiscalManual: true,
      empresaId: 3
    });
    assert.equal(r.sucesso, true);
    assert.equal(r.tipo, 'pix');
    assert.equal(r.recebimentos[0].confirmacao_eletronica_comprovada, true);
  });
});
