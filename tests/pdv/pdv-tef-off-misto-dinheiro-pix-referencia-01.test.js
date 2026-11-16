'use strict';

/**
 * PIX/cartão com TEF off (confirmação operacional) devem entrar na referência fiscal
 * junto com dinheiro, para não zerar valor_fiscal_referencia no misto.
 */
const assert = require('assert');
const {
  calcularReferenciasConfirmadas,
  parcelaEfetivamenteConfirmada,
  validarReferenciaFiscalFinalComComplemento
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');

function test() {
  const dinheiro = {
    forma_pagamento: 'dinheiro',
    valor: 10,
    status_autorizacao: 'informada',
    confirmacao_manual: 1,
    confirmacao_modalidade: 'manual',
    tipo_recebimento: 'nao_fiscal'
  };
  const pixOperacional = {
    forma_pagamento: 'pix',
    valor: 29.99,
    status_autorizacao: 'confirmada',
    confirmacao_manual: 1,
    confirmacao_modalidade: 'manual',
    confirmacao_operacional_externa: true
  };
  assert.equal(parcelaEfetivamenteConfirmada(pixOperacional), true);
  const refs = calcularReferenciasConfirmadas([dinheiro, pixOperacional]);
  assert.equal(refs.valor_fiscal_referencia, 29.99);
  assert.equal(refs.valor_nao_fiscal_referencia, 10);

  // Recebimento já classificado (emissão NFC-e).
  const pixRecebimento = {
    forma_pagamento: 'pix',
    valor: 29.99,
    status: 'aprovado',
    tipo_recebimento: 'fiscal',
    tef_transacao_id: null
  };
  assert.equal(parcelaEfetivamenteConfirmada(pixRecebimento), true);
  assert.equal(
    calcularReferenciasConfirmadas([dinheiro, pixRecebimento]).valor_fiscal_referencia,
    29.99
  );

  // Sem carimbo TEF e sem operacional: não conta (guarda autoritativa).
  assert.equal(
    parcelaEfetivamenteConfirmada({
      forma_pagamento: 'pix',
      valor: 29.99,
      status_autorizacao: 'aprovada',
      aprovado: true
    }),
    false
  );

  // Snapshot persistido com fiscal=0 (bug legado) não bloqueia se pagamentos confirmam eletrônico.
  const validacao = validarReferenciaFiscalFinalComComplemento({
    pagamentos: [dinheiro, pixRecebimento],
    itens: [
      { valor_fiscal: 8.67, valor_nao_fiscal: 0 },
      { valor_fiscal: 12.52, valor_nao_fiscal: 0 },
      { valor_fiscal: 8.80, valor_nao_fiscal: 10 }
    ],
    venda: {
      total: 39.99,
      desconto: 0,
      valor_fiscal: 29.99,
      valor_nao_fiscal: 10
    },
    referenciaPersistida: {
      valor_fiscal_referencia: 0,
      valor_nao_fiscal_referencia: 10,
      valor_fiscal_referencia_inicial: 0,
      valor_nao_fiscal_referencia_inicial: 10,
      complemento_dinheiro_utilizado: 0,
      desconto_ajuste: 0
    }
  });
  assert.equal(validacao.ok, true, JSON.stringify(validacao));
  assert.equal(validacao.referencia_final.valor_fiscal_referencia, 29.99);
  assert.equal(validacao.referencia_final.valor_nao_fiscal_referencia, 10);

  console.log('OK pdv-tef-off-misto-dinheiro-pix-referencia-01');
}

test();
