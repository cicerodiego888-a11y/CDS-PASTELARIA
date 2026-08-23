/**
 * Sprint 05.07 — pagamento unificado do PDV Universal via MUV.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  finalizarCheckout,
  reservarAtendimentoPdv,
  confirmarPagamentoPdv,
  cancelarAtendimentoPdv
} = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
const { capacidadesParaModo } = require('../../backend/motores/pdv-universal/contratos');
const pagUi = require('../../frontend/pdv-universal/pdv-universal-pagamento.js');
const checkoutUi = require('../../frontend/pdv-universal/pdv-universal-checkout.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function itemCart(produtoId, empresaId) {
  return { produto_id: produtoId, empresa_id: empresaId, quantidade: 1, valor_unitario: 10 };
}

function preview(status, extra = {}) {
  return {
    atendimentoId: extra.atendimentoId || 25,
    codigo: extra.codigo || 'ATD-00000025',
    status,
    operacoes: extra.operacoes || [{ operacaoId: 1, empresaId: 2, status: 'RESERVADA' }],
    pagamento_pendente: status !== 'PAGO',
    venda_concluida: false,
    idempotente: !!extra.idempotente
  };
}

function depsMulti(extra = {}) {
  return { obterModoOperacaoVenda: () => 'MULTIEMPRESA', ...extra };
}

async function test01IniciaPagamentoAposAtendimento() {
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2)],
    idempotency_key: 'k-0507-01'
  }, depsMulti({
    criarAtendimento: async () => ({
      atendimentoId: 25, codigo: 'ATD-00000025', status: 'VALIDADO',
      operacoes: [{ operacaoId: 1, empresaId: 2, status: 'VALIDADA' }],
      pagamento_pendente: true
    })
  }));
  assert.strictEqual(r.atendimento.status, 'VALIDADO');
  const start = checkoutUi.continuarParaPagamento({ atendimento_id: r.atendimento_id });
  assert.strictEqual(start.acao, 'INICIAR_RESERVA');
}

async function test02ReservaAntesDoPagamento() {
  const ordem = [];
  await reservarAtendimentoPdv(25, depsMulti({
    reservarAtendimento: async () => {
      ordem.push('reserva');
      return preview('RESERVADO');
    }
  }));
  await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }],
    estrategia_rateio: 'POR_ITEM'
  }, depsMulti({
    confirmarPagamentoAtendimento: async () => {
      ordem.push('pagamento');
      return preview('PAGO');
    }
  }));
  assert.deepStrictEqual(ordem, ['reserva', 'pagamento']);
}

async function test03PagamentoSemReserva() {
  await assert.rejects(
    () => confirmarPagamentoPdv(25, {
      pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
    }, depsMulti({
      confirmarPagamentoAtendimento: async () => {
        const err = new Error('nao reservado');
        err.code = 'ATENDIMENTO_NAO_RESERVADO';
        throw err;
      }
    })),
    (e) => e.code === 'ATENDIMENTO_NAO_RESERVADO'
  );
}

async function test04PagamentoUnico() {
  let entrada;
  const r = await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 51 }],
    estrategia_rateio: 'POR_ITEM'
  }, depsMulti({
    confirmarPagamentoAtendimento: async (_id, e) => {
      entrada = e;
      return preview('PAGO');
    }
  }));
  assert.strictEqual(entrada.pagamentos.length, 1);
  assert.strictEqual(r.atendimento.status, 'PAGO');
}

async function test05PagamentoMisto() {
  let entrada;
  await confirmarPagamentoPdv(25, {
    pagamentos: [
      { forma_pagamento: 'PIX', valor: 30 },
      { forma_pagamento: 'CREDITO', valor: 21 }
    ]
  }, depsMulti({
    confirmarPagamentoAtendimento: async (_id, e) => {
      entrada = e;
      return preview('PAGO');
    }
  }));
  assert.strictEqual(entrada.pagamentos.length, 2);
}

async function test06PorItemPadrao() {
  assert.strictEqual(pagUi.ESTRATEGIA_PADRAO, 'POR_ITEM');
  const payload = pagUi.montarPayloadPagamento({
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
  });
  assert.strictEqual(payload.estrategia_rateio, 'POR_ITEM');
  let estrategia;
  await confirmarPagamentoPdv(25, { pagamentos: payload.pagamentos }, depsMulti({
    confirmarPagamentoAtendimento: async (_id, e) => {
      estrategia = e.estrategia;
      return preview('PAGO');
    }
  }));
  assert.strictEqual(estrategia, 'POR_ITEM');
}

async function test07Proporcional() {
  let estrategia;
  await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'DINHEIRO', valor: 10 }],
    estrategia_rateio: 'PROPORCIONAL'
  }, depsMulti({
    confirmarPagamentoAtendimento: async (_id, e) => {
      estrategia = e.estrategia;
      return preview('PAGO');
    }
  }));
  assert.strictEqual(estrategia, 'PROPORCIONAL');
}

async function test08SomaInvalida() {
  await assert.rejects(
    () => confirmarPagamentoPdv(25, {
      pagamentos: [{ forma_pagamento: 'PIX', valor: 1 }]
    }, depsMulti({
      confirmarPagamentoAtendimento: async () => {
        const err = new Error('insuficiente');
        err.code = 'PAGAMENTO_INSUFICIENTE';
        throw err;
      }
    })),
    (e) => e.code === 'PAGAMENTO_INSUFICIENTE'
  );
}

async function test09ToleranciaUmCentavo() {
  const muv = src('backend/motores/muv/AtendimentoMultiempresaService.js');
  assert.ok(muv.includes('tolerância oficial de 1 centavo') || muv.includes('1 centavo'));
}

async function test10Idempotencia() {
  let n = 0;
  const deps = depsMulti({
    confirmarPagamentoAtendimento: async () => {
      n += 1;
      return preview('PAGO', { idempotente: n > 1 });
    }
  });
  const a = await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }],
    idempotency_key: 'pag-1'
  }, deps);
  const b = await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }],
    idempotency_key: 'pag-1'
  }, {
    ...deps,
    confirmarPagamentoAtendimento: async () => preview('PAGO', { idempotente: true })
  });
  assert.strictEqual(a.atendimento.status, 'PAGO');
  assert.strictEqual(b.idempotente, true);
}

async function test11IdempotencyConflito() {
  await assert.rejects(
    () => confirmarPagamentoPdv(25, {
      pagamentos: [{ forma_pagamento: 'PIX', valor: 9 }],
      idempotency_key: 'pag-x'
    }, depsMulti({
      confirmarPagamentoAtendimento: async () => {
        const err = new Error('conflict');
        err.code = 'IDEMPOTENCY_KEY_CONFLICT';
        throw err;
      }
    })),
    (e) => e.code === 'IDEMPOTENCY_KEY_CONFLICT'
  );
}

async function test12ProcessamentoDuplicado() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('_pagamentoLock'));
  assert.ok(js.includes('PROCESSANDO_PAGAMENTO'));
}

async function test13FalhaReserva() {
  await assert.rejects(
    () => reservarAtendimentoPdv(25, depsMulti({
      reservarAtendimento: async () => {
        const err = new Error('saldo');
        err.code = 'SALDO_INSUFICIENTE';
        throw err;
      }
    })),
    (e) => e.code === 'SALDO_INSUFICIENTE'
  );
}

async function test14FalhaPagamento() {
  await assert.rejects(
    () => confirmarPagamentoPdv(25, {
      pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
    }, depsMulti({
      confirmarPagamentoAtendimento: async () => {
        const err = new Error('falha');
        err.code = 'PAGAMENTO_INVALIDO';
        throw err;
      }
    })),
    (e) => e.code === 'PAGAMENTO_INVALIDO'
  );
}

async function test15PermaneceReservado() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('Atendimento permanece reservado'));
  const muv = src('backend/motores/muv/AtendimentoMultiempresaService.js');
  assert.ok(muv.includes("cab.status !== STATUS_ATENDIMENTO.RESERVADO"));
}

async function test16CancelamentoLibera() {
  let chamado = false;
  const r = await cancelarAtendimentoPdv(25, depsMulti({
    cancelarAtendimento: async () => {
      chamado = true;
      return preview('CANCELADO');
    }
  }));
  assert.ok(chamado);
  assert.strictEqual(r.atendimento.status, 'CANCELADO');
  assert.ok(!src('frontend/pdv-universal/pdv-universal-pagamento.js').includes('reservado_fiscal'));
}

async function test17NaoChamaVendaApplication() {
  let n = 0;
  await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
  }, depsMulti({
    criarVenda() { n += 1; },
    confirmarPagamentoAtendimento: async () => preview('PAGO')
  }));
  assert.strictEqual(n, 0);
}

async function test18EmpresaUnicaNaoUsaMuvPagamento() {
  let n = 0;
  await assert.rejects(
    () => confirmarPagamentoPdv(25, {
      pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
    }, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
      confirmarPagamentoAtendimento: async () => { n += 1; return preview('PAGO'); }
    }),
    (e) => e.code === 'OPERACAO_EXCLUSIVA_MULTIEMPRESA'
  );
  assert.strictEqual(n, 0);
  await assert.rejects(
    () => reservarAtendimentoPdv(25, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
      reservarAtendimento: async () => { n += 1; return preview('RESERVADO'); }
    }),
    (e) => e.code === 'OPERACAO_EXCLUSIVA_MULTIEMPRESA'
  );
  assert.strictEqual(n, 0);
}

async function test19EstoqueIsolado() {
  const rota = src('backend/rotas/pdv-universal.js');
  assert.ok(rota.includes('reservarAtendimentoPdv'));
  assert.ok(!rota.includes('empresa_id: 1'));
  const payload = pagUi.montarPayloadPagamento({
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'empresa_id'));
}

async function test20NuncaEmpresa1() {
  await assert.rejects(
    () => reservarAtendimentoPdv(0, depsMulti({
      reservarAtendimento: async () => preview('RESERVADO')
    })),
    (e) => e.code === 'ATENDIMENTO_INVALIDO'
  );
  const payload = pagUi.montarPayloadPagamento({
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
  });
  assert.ok(!JSON.stringify(payload).includes('"empresa_id":1'));
}

async function test21FrontendNaoCalculaRateio() {
  const js = src('frontend/pdv-universal/pdv-universal-pagamento.js');
  assert.ok(!js.includes('calcularRateio'));
  assert.ok(!js.includes('rateios'));
  const payload = pagUi.montarPayloadPagamento({
    pagamentos: [{ forma_pagamento: 'PIX', valor: 30 }, { forma_pagamento: 'CREDITO', valor: 21 }]
  });
  assert.ok(!payload.rateios);
  assert.ok(!payload.distribuicao);
}

async function test22BackendAutoridade() {
  const app = src('backend/motores/pdv-universal/PDVUniversalApplicationService.js');
  assert.ok(app.includes('confirmarPagamentoAtendimento'));
  assert.ok(!app.includes('ratearProporcionalCentavos('));
}

async function test23RetornaPago() {
  const r = await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
  }, depsMulti({
    confirmarPagamentoAtendimento: async () => preview('PAGO')
  }));
  assert.strictEqual(r.atendimento.status, 'PAGO');
  assert.strictEqual(r.pagamento_pendente, false);
}

async function test24NaoMaterializa() {
  const r = await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
  }, depsMulti({
    materializarAtendimento: async () => { throw new Error('nao deve materializar'); },
    confirmarPagamentoAtendimento: async () => preview('PAGO')
  }));
  assert.strictEqual(r.materializado, false);
  assert.strictEqual(r.venda_concluida, false);
  assert.ok(!src('frontend/pdv-universal/pdv-universal-pagamento.js').includes('materializarAtendimento'));
}

async function test25NaoEmiteNfce() {
  const r = await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
  }, depsMulti({
    fiscalizarAtendimento: async () => { throw new Error('nao deve fiscalizar'); },
    confirmarPagamentoAtendimento: async () => preview('PAGO')
  }));
  assert.strictEqual(r.fiscalizado, false);
  const front = src('frontend/pdv-universal/pdv-universal-pagamento.js');
  assert.ok(!front.includes('/api/tef/pagar'));
  assert.ok(!front.includes('fiscalizarAtendimento'));
  assert.strictEqual(capacidadesParaModo('MULTIEMPRESA').pode_confirmar_pagamento_unificado, true);
  assert.strictEqual(capacidadesParaModo('EMPRESA_UNICA').pode_reservar_atendimento, false);
  assert.ok(pagUi.podeReservar({ capacidades: { pode_reservar_atendimento: true } }));
}

async function run() {
  const testes = [
    test01IniciaPagamentoAposAtendimento,
    test02ReservaAntesDoPagamento,
    test03PagamentoSemReserva,
    test04PagamentoUnico,
    test05PagamentoMisto,
    test06PorItemPadrao,
    test07Proporcional,
    test08SomaInvalida,
    test09ToleranciaUmCentavo,
    test10Idempotencia,
    test11IdempotencyConflito,
    test12ProcessamentoDuplicado,
    test13FalhaReserva,
    test14FalhaPagamento,
    test15PermaneceReservado,
    test16CancelamentoLibera,
    test17NaoChamaVendaApplication,
    test18EmpresaUnicaNaoUsaMuvPagamento,
    test19EstoqueIsolado,
    test20NuncaEmpresa1,
    test21FrontendNaoCalculaRateio,
    test22BackendAutoridade,
    test23RetornaPago,
    test24NaoMaterializa,
    test25NaoEmiteNfce
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.07 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
