/**
 * Sprint 05.06 — checkout MULTIEMPRESA do PDV Universal (ATENDIMENTO VALIDADO).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { finalizarCheckout } = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
const { capacidadesParaModo } = require('../../backend/motores/pdv-universal/contratos');
const atendimentoAdapter = require('../../backend/services/pdv-universal/PDVUniversalAtendimentoAdapter');
const { agruparItensPorEmpresa } = require('../../backend/motores/muv/contratos');
const checkoutUi = require('../../frontend/pdv-universal/pdv-universal-checkout.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function itemCart(produtoId, empresaId, quantidade = 1, valor = 10) {
  return {
    produto_id: produtoId,
    empresa_id: empresaId,
    quantidade,
    valor_unitario: valor
  };
}

function previewPadrao(over = {}) {
  return {
    atendimentoId: over.atendimentoId || 1,
    codigo: over.codigo || 'ATD-00000001',
    status: over.status || 'VALIDADO',
    operacoes: over.operacoes || [
      { operacaoId: 10, empresaId: 2, status: 'VALIDADA' },
      { operacaoId: 11, empresaId: 3, status: 'VALIDADA' }
    ],
    venda_concluida: false,
    pagamento_pendente: true
  };
}

function depsMulti(criarAtendimento, extra = {}) {
  return {
    obterModoOperacaoVenda: () => 'MULTIEMPRESA',
    criarVenda() {
      throw new Error('POST legado nao deve ser chamado');
    },
    criarAtendimento,
    ...extra
  };
}

async function test01CriaAtendimento() {
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2, 2)],
    idempotency_key: 'k-0506-01'
  }, depsMulti(async () => previewPadrao({ atendimentoId: 21, codigo: 'ATD-00000021' })));
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.modo_operacao_venda, 'MULTIEMPRESA');
  assert.strictEqual(r.atendimento_id, 21);
  assert.ok(String(r.atendimento.codigo).startsWith('ATD-'));
  assert.strictEqual(r.atendimento.status, 'VALIDADO');
}

async function test02UmaOperacaoPorEmpresa() {
  const cart = [
    itemCart(10, 2, 1),
    itemCart(20, 3, 1),
    itemCart(11, 2, 1)
  ];
  const itens = atendimentoAdapter.montarItensAtendimento(cart);
  const ops = agruparItensPorEmpresa(itens);
  assert.strictEqual(ops.length, 2);
  const r = await finalizarCheckout({
    itens: cart,
    idempotency_key: 'k-0506-02'
  }, depsMulti(async () => previewPadrao({
    operacoes: ops.map((op, i) => ({
      operacaoId: i + 1,
      empresaId: op.empresaId,
      status: 'VALIDADA'
    }))
  })));
  assert.strictEqual(r.operacoes.length, 2);
}

async function test03ItensEmpresaCorreta() {
  const itens = atendimentoAdapter.montarItensAtendimento([
    itemCart(10, 2, 1),
    itemCart(20, 3, 1)
  ]);
  const ops = agruparItensPorEmpresa(itens);
  const op2 = ops.find((o) => o.empresaId === 2);
  const op3 = ops.find((o) => o.empresaId === 3);
  assert.ok(op2.itens.every((i) => i.empresaId === 2 && i.produtoId === 10));
  assert.ok(op3.itens.every((i) => i.empresaId === 3 && i.produtoId === 20));
}

async function test04EmpresasNaoMisturam() {
  const ops = agruparItensPorEmpresa(atendimentoAdapter.montarItensAtendimento([
    itemCart(10, 2, 1),
    itemCart(20, 3, 1)
  ]));
  assert.ok(ops.every((op) => op.itens.every((i) => i.empresaId === op.empresaId)));
}

async function test05CarrinhoVazio() {
  await assert.rejects(
    () => finalizarCheckout({ itens: [] }, depsMulti(async () => previewPadrao())),
    (e) => e.code === 'CARRINHO_VAZIO'
  );
}

async function test06SemEmpresaItem() {
  await assert.rejects(
    () => finalizarCheckout({
      itens: [{ produto_id: 10, quantidade: 1, valor_unitario: 1 }]
    }, depsMulti(async () => previewPadrao())),
    (e) => e.code === 'EMPRESA_ITEM_OBRIGATORIA'
  );
}

async function test07NuncaAssumeEmpresa1() {
  await assert.rejects(
    () => finalizarCheckout({
      itens: [{ produto_id: 10, quantidade: 1, valor_unitario: 1 }]
    }, depsMulti(async (dados) => {
      if (dados.itens.some((i) => i.empresaId === 1)) {
        throw new Error('assumiu empresa 1');
      }
      return previewPadrao();
    })),
    (e) => e.code === 'EMPRESA_ITEM_OBRIGATORIA'
  );
}

async function test08EstoqueANaoAutorizaB() {
  await assert.rejects(
    () => finalizarCheckout({
      itens: [itemCart(10, 3, 1)],
      idempotency_key: 'k-0506-08'
    }, depsMulti(async (dados, d) => {
      const disp = await d.consultarDisponibilidade(dados.itens[0].produtoId, {
        empresaId: dados.itens[0].empresaId
      });
      if (Number(disp.disponivel_total) < dados.itens[0].quantidade) {
        const err = new Error('saldo');
        err.code = 'SALDO_INSUFICIENTE';
        throw err;
      }
      return previewPadrao();
    }, {
      consultarDisponibilidade: async (_id, opts) => ({
        disponivel_total: Number(opts.empresaId) === 2 ? 99 : 0
      })
    })),
    (e) => e.code === 'SALDO_INSUFICIENTE'
  );
}

async function test09SemEstoqueEmpresa() {
  await assert.rejects(
    () => finalizarCheckout({
      itens: [itemCart(10, 9, 1)],
      idempotency_key: 'k-0506-09'
    }, depsMulti(async (_dados, d) => {
      const disp = await d.consultarDisponibilidade(10, { empresaId: 9 });
      if (!disp || Number(disp.disponivel_total) <= 0) {
        const err = new Error('indisponivel');
        err.code = 'SALDO_INSUFICIENTE';
        throw err;
      }
      return previewPadrao();
    }, {
      consultarDisponibilidade: async () => ({ disponivel_total: 0 })
    })),
    (e) => e.code === 'SALDO_INSUFICIENTE'
  );
}

async function test10EstoqueInsuficiente() {
  await assert.rejects(
    () => finalizarCheckout({
      itens: [itemCart(10, 2, 99)],
      idempotency_key: 'k-0506-10'
    }, depsMulti(async (dados, d) => {
      const it = dados.itens[0];
      const disp = await d.consultarDisponibilidade(it.produtoId, { empresaId: it.empresaId });
      if (Number(disp.disponivel_total) < it.quantidade) {
        const err = new Error('saldo');
        err.code = 'SALDO_INSUFICIENTE';
        throw err;
      }
      return previewPadrao();
    }, {
      consultarDisponibilidade: async () => ({ disponivel_total: 2 })
    })),
    (e) => e.code === 'SALDO_INSUFICIENTE'
  );
}

async function test11RollbackTotal() {
  let persistiu = false;
  await assert.rejects(
    () => finalizarCheckout({
      itens: [itemCart(10, 2, 1), itemCart(20, 3, 1)],
      idempotency_key: 'k-0506-11'
    }, depsMulti(async () => {
      persistiu = true;
      const err = new Error('falha forçada');
      err.code = 'ATENDIMENTO_INVALIDO';
      throw err;
    })),
    (e) => e.code === 'ATENDIMENTO_INVALIDO'
  );
  assert.strictEqual(persistiu, true);
  const svc = src('backend/motores/muv/AtendimentoMultiempresaService.js');
  assert.ok(svc.includes('BEGIN IMMEDIATE'));
  assert.ok(svc.includes('ROLLBACK'));
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    idempotency_key: 'k-0506-11'
  }, depsMulti(async () => previewPadrao({ atendimentoId: 99 })));
  assert.strictEqual(r.atendimento_id, 99);
}

async function test12NaoCaiNoLegado() {
  let n = 0;
  await finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    idempotency_key: 'k-0506-12'
  }, {
    obterModoOperacaoVenda: () => 'MULTIEMPRESA',
    criarVenda() { n += 1; },
    criarAtendimento: async () => previewPadrao({ atendimentoId: 3 })
  });
  assert.strictEqual(n, 0);
  const chk = src('frontend/pdv-universal/pdv-universal-checkout.js');
  assert.ok(!chk.includes('${baseApi()}/vendas'));
}

async function test13EmpresaUnicaContinua() {
  let n = 0;
  const r = await finalizarCheckout({
    user: { id: 1 },
    empresaId: 2,
    itens: [itemCart(10, 2, 1, 5)],
    pagamentos: [{ forma_pagamento: 'dinheiro', valor: 5 }]
  }, {
    obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
    listarEmpresasDisponiveis: async () => [{ id: 2, razao_social: 'A', ativo: 1, cnpj: '1' }],
    criarVenda(req, res) {
      n += 1;
      res.json({ sucesso: true, venda_id: 77, status_pagamento: 'quitada' });
    }
  });
  assert.strictEqual(n, 1);
  assert.strictEqual(r.venda_id, 77);
}

async function test14NaoCriaVenda() {
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    idempotency_key: 'k-0506-14'
  }, depsMulti(async () => previewPadrao({ atendimentoId: 4 })));
  assert.ok(r.venda_id == null);
  assert.strictEqual(r.venda_concluida, false);
}

async function test15VendaConcluidaFalse() {
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    idempotency_key: 'k-0506-15'
  }, depsMulti(async () => previewPadrao({ atendimentoId: 5 })));
  assert.strictEqual(r.venda_concluida, false);
  assert.strictEqual(r.checkout_concluido, false);
}

async function test16PagamentoPendente() {
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    idempotency_key: 'k-0506-16'
  }, depsMulti(async () => previewPadrao({ atendimentoId: 6 })));
  assert.strictEqual(r.pagamento_pendente, true);
}

async function test17StatusValidado() {
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    idempotency_key: 'k-0506-17'
  }, depsMulti(async () => previewPadrao({ atendimentoId: 7 })));
  assert.strictEqual(r.atendimento.status, 'VALIDADO');
}

async function test18FrontendNaoEnviaAtendimentoId() {
  let body;
  await checkoutUi.finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    pagamentos: []
  }, async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ sucesso: true }) };
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(body, 'atendimento_id'));
  assert.ok(!Object.prototype.hasOwnProperty.call(body, 'venda_id'));
}

async function test19RespostaAtendimentoReal() {
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    idempotency_key: 'k-0506-19'
  }, depsMulti(async () => previewPadrao({ atendimentoId: 81, codigo: 'ATD-00000081' })));
  assert.strictEqual(r.atendimento.id, 81);
  assert.strictEqual(r.atendimento_id, 81);
}

async function test20VendaIdNaoEAtendimento() {
  const r = await finalizarCheckout({
    itens: [itemCart(10, 2, 1)],
    idempotency_key: 'k-0506-20'
  }, depsMulti(async () => previewPadrao({ atendimentoId: 90 })));
  assert.notStrictEqual(r.venda_id, r.atendimento_id);
  assert.ok(r.venda_id == null);
}

async function test21DuploSubmit() {
  let n = 0;
  const criar = async () => {
    n += 1;
    return previewPadrao({ atendimentoId: 11 });
  };
  const entrada = { itens: [itemCart(10, 2, 1)], idempotency_key: 'k-0506-duplo' };
  const a = await finalizarCheckout(entrada, depsMulti(criar));
  const b = await finalizarCheckout(entrada, depsMulti(criar));
  assert.strictEqual(a.atendimento_id, b.atendimento_id);
  assert.strictEqual(n, 1);
}

async function test22BotaoBloqueia() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('_checkoutLock'));
  assert.ok(js.includes('CHECKOUT_PROCESSANDO'));
  assert.ok(js.includes('finBtn.disabled = true'));
}

async function test23ErroMantemCarrinho() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('ERRO_CHECKOUT'));
  const catchBlock = js.split('catch (err)')[1] || '';
  assert.ok(!catchBlock.includes('api._cart.limpar()'));
}

async function test24TransicaoAtendimentoCriado() {
  const sessao = checkoutUi.aplicarResultadoCheckout({
    modo_operacao_venda: 'MULTIEMPRESA',
    atendimento: { id: 25, codigo: 'ATD-00000025', status: 'VALIDADO' },
    atendimento_id: 25,
    operacoes: [{ id: 1, empresa_id: 2, status: 'VALIDADA' }],
    pagamento_pendente: true
  });
  assert.strictEqual(sessao.estado, 'ATENDIMENTO_CRIADO');
  assert.strictEqual(sessao.atendimento_id, 25);
  assert.ok(tela.ESTADOS.ATENDIMENTO_CRIADO);
  assert.strictEqual(capacidadesParaModo('MULTIEMPRESA').checkout_multiempresa, true);
  assert.ok(checkoutUi.podeFinalizar({ capacidades: { checkout_multiempresa: true } }, [itemCart(1, 2)]));
}

async function test25ContinuarNaoPaga() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(!js.includes('confirmarPagamentoAtendimento'));
  const html = src('frontend/pdv-universal/index.html');
  assert.ok(html.includes('CONTINUAR PARA PAGAMENTO'));
  assert.ok(html.includes('AGUARDANDO PAGAMENTO'));
}

async function run() {
  const testes = [
    test01CriaAtendimento,
    test02UmaOperacaoPorEmpresa,
    test03ItensEmpresaCorreta,
    test04EmpresasNaoMisturam,
    test05CarrinhoVazio,
    test06SemEmpresaItem,
    test07NuncaAssumeEmpresa1,
    test08EstoqueANaoAutorizaB,
    test09SemEstoqueEmpresa,
    test10EstoqueInsuficiente,
    test11RollbackTotal,
    test12NaoCaiNoLegado,
    test13EmpresaUnicaContinua,
    test14NaoCriaVenda,
    test15VendaConcluidaFalse,
    test16PagamentoPendente,
    test17StatusValidado,
    test18FrontendNaoEnviaAtendimentoId,
    test19RespostaAtendimentoReal,
    test20VendaIdNaoEAtendimento,
    test21DuploSubmit,
    test22BotaoBloqueia,
    test23ErroMantemCarrinho,
    test24TransicaoAtendimentoCriado,
    test25ContinuarNaoPaga
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.06 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
