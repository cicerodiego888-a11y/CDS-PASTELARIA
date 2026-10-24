const assert = require('assert');
const {
  determinarStatusPagamento,
  montarRecebimentosParaGravar,
  distribuirRecebimentosOutros,
  isPagamentoIntegralConfirmado,
  validarCoberturaOutrosTef
} = require('../backend/services/OrquestradorPagamento');

function test(name, fn) {
  try {
    fn();
    console.log(`OK ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('Cenário 1 — venda mista com fiscal processado aguarda não fiscal', () => {
  const status = determinarStatusPagamento({
    totalFiscal: 71.2,
    totalNaoFiscal: 35.6,
    fiscalProcessado: true,
    recebimentosNaoFiscalConfirmados: []
  });

  assert.strictEqual(status, 'aguardando_nao_fiscal');
});

test('Cenário 1 — venda mista não usa plano do distribuidor como quitada', () => {
  const status = determinarStatusPagamento({
    totalFiscal: 71.2,
    totalNaoFiscal: 35.6,
    fiscalProcessado: true,
    recebimentosNaoFiscalConfirmados: [
      { tipo_recebimento: 'nao_fiscal', valor: 35.6 }
    ]
  });

  assert.strictEqual(status, 'quitada');
});

test('Cenário 2 — venda totalmente fiscal quitada após processamento', () => {
  const status = determinarStatusPagamento({
    totalFiscal: 71.2,
    totalNaoFiscal: 0,
    fiscalProcessado: true,
    recebimentosNaoFiscalConfirmados: []
  });

  assert.strictEqual(status, 'quitada');
});

test('Cenário 3 — venda totalmente não fiscal quitada com recebimento confirmado', () => {
  const status = determinarStatusPagamento({
    totalFiscal: 0,
    totalNaoFiscal: 35.6,
    fiscalProcessado: true,
    recebimentosNaoFiscalConfirmados: [
      { tipo_recebimento: 'nao_fiscal', valor: 35.6 }
    ]
  });

  assert.strictEqual(status, 'quitada');
});

test('Cenário 3 — venda totalmente não fiscal pendente sem recebimento', () => {
  const status = determinarStatusPagamento({
    totalFiscal: 0,
    totalNaoFiscal: 35.6,
    fiscalProcessado: true,
    recebimentosNaoFiscalConfirmados: []
  });

  assert.strictEqual(status, 'pendente');
});

test('Montagem — venda mista grava somente recebimentos fiscais na 1ª etapa', () => {
  const recebimentos = montarRecebimentosParaGravar({
    distribuicao: {
      recebimentosFiscal: [
        { forma_pagamento: 'pix', valor: 71.2, tipo_recebimento: 'fiscal' }
      ],
      recebimentosNaoFiscal: [
        { forma_pagamento: 'pix', valor: 35.6, tipo_recebimento: 'nao_fiscal' }
      ]
    },
    statusPagamento: 'aguardando_nao_fiscal',
    totalFiscal: 71.2,
    totalNaoFiscal: 35.6
  });

  assert.strictEqual(recebimentos.length, 1);
  assert.strictEqual(recebimentos[0].tipo_recebimento, 'fiscal');
  assert.strictEqual(recebimentos[0].valor, 71.2);
});

test('Montagem — venda mista quitada grava fiscal + não fiscal', () => {
  const recebimentos = montarRecebimentosParaGravar({
    distribuicao: {
      recebimentosFiscal: [
        { forma_pagamento: 'dinheiro', valor: 4, tipo_recebimento: 'fiscal' }
      ],
      recebimentosNaoFiscal: [
        { forma_pagamento: 'dinheiro', valor: 23.44, tipo_recebimento: 'nao_fiscal' }
      ]
    },
    statusPagamento: 'quitada',
    totalFiscal: 4,
    totalNaoFiscal: 23.44
  });

  assert.strictEqual(recebimentos.length, 2);
  assert.strictEqual(recebimentos[0].tipo_recebimento, 'fiscal');
  assert.strictEqual(recebimentos[0].valor, 4);
  assert.strictEqual(recebimentos[1].tipo_recebimento, 'nao_fiscal');
  assert.strictEqual(recebimentos[1].valor, 23.44);
});

test('Montagem — venda somente não fiscal grava recebimento não fiscal', () => {
  const recebimentos = montarRecebimentosParaGravar({
    distribuicao: {
      recebimentosFiscal: [],
      recebimentosNaoFiscal: [
        { forma_pagamento: 'dinheiro', valor: 35.6, tipo_recebimento: 'nao_fiscal' }
      ]
    },
    statusPagamento: 'quitada',
    totalFiscal: 0,
    totalNaoFiscal: 35.6
  });

  assert.strictEqual(recebimentos.length, 1);
  assert.strictEqual(recebimentos[0].tipo_recebimento, 'nao_fiscal');
});

test('Outros — excedente à distribuição de produtos é registrado separadamente', () => {
  const resultado = distribuirRecebimentosOutros(
    [{ forma_pagamento: 'dinheiro', valor: 21 }],
    [{ forma_pagamento: 'dinheiro', valor: 16 }],
    [],
    5
  );

  assert.strictEqual(resultado.recebimentosOutros.length, 1);
  assert.deepStrictEqual(resultado.recebimentosOutros[0], {
    forma_pagamento: 'dinheiro',
    valor: 5,
    tipo_recebimento: 'outros'
  });
  assert.strictEqual(resultado.saldoOutros, 0);
});

test('Outros — venda a prazo não cria recebimento antes da baixa', () => {
  const resultado = distribuirRecebimentosOutros(
    [{ forma_pagamento: 'boleto', valor: 21 }],
    [{ forma_pagamento: 'boleto', valor: 16 }],
    [],
    5
  );

  assert.strictEqual(resultado.recebimentosOutros.length, 0);
  assert.strictEqual(resultado.saldoOutros, 5);
});

test('Outros — saldo pendente impede pagamento integral', () => {
  assert.strictEqual(isPagamentoIntegralConfirmado({
    totalPagamentos: 21,
    totalLiquidoEsperado: 21,
    saldoFiscal: 0,
    saldoNaoFiscal: 0,
    saldoOutros: 5
  }), false);
});

test('Outros — complemento de TEF exige uma forma sem TEF separada', () => {
  const somenteTef = distribuirRecebimentosOutros(
    [{ forma_pagamento: 'cartao_credito', valor: 21 }],
    [{ forma_pagamento: 'cartao_credito', valor: 16 }],
    [],
    5
  );
  assert.strictEqual(somenteTef.saldoOutros, 5);
  assert.ok(validarCoberturaOutrosTef(
    somenteTef,
    [{ forma_pagamento: 'cartao_credito', valor: 21 }]
  ));

  const comSeparacao = distribuirRecebimentosOutros(
    [
      { forma_pagamento: 'cartao_credito', valor: 16 },
      { forma_pagamento: 'dinheiro', valor: 5 }
    ],
    [{ forma_pagamento: 'cartao_credito', valor: 16 }],
    [],
    5
  );
  assert.strictEqual(comSeparacao.saldoOutros, 0);
  assert.strictEqual(validarCoberturaOutrosTef(
    comSeparacao,
    [
      { forma_pagamento: 'cartao_credito', valor: 16 },
      { forma_pagamento: 'dinheiro', valor: 5 }
    ]
  ), null);
});

test('Montagem — parcela Outros é persistida sem ser classificada F/NF', () => {
  const recebimentos = montarRecebimentosParaGravar({
    distribuicao: {
      recebimentosFiscal: [
        { forma_pagamento: 'dinheiro', valor: 16, tipo_recebimento: 'fiscal' }
      ],
      recebimentosNaoFiscal: [],
      recebimentosOutros: [
        { forma_pagamento: 'dinheiro', valor: 5, tipo_recebimento: 'outros' }
      ]
    },
    statusPagamento: 'quitada',
    totalFiscal: 16,
    totalNaoFiscal: 0
  });

  assert.deepStrictEqual(
    recebimentos.map((r) => [r.tipo_recebimento, r.valor]),
    [['fiscal', 16], ['outros', 5]]
  );
});

console.log('Todos os testes do OrquestradorPagamento passaram.');
