/**
 * Sprint 05.05 — checkout EMPRESA_UNICA do PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { finalizarCheckout } = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
const adapter = require('../../backend/services/pdv-universal/PDVUniversalVendaAdapter');
const { capacidadesParaModo } = require('../../backend/motores/pdv-universal/contratos');
const checkoutUi = require('../../frontend/pdv-universal/pdv-universal-checkout.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const EMP = { id: 2, razao_social: 'Empresa A', ativo: 1, cnpj: '11' };
const ITEM = { produto_id: 10, empresa_id: 2, quantidade: 2, valor_unitario: 5, subtotal: 10 };

function deps(modo, criarVenda) {
  return {
    obterModoOperacaoVenda: () => modo,
    listarEmpresasDisponiveis: async () => [EMP],
    criarVenda
  };
}

async function test01PermiteEmpresaUnica() {
  let n = 0;
  const r = await finalizarCheckout({
    user: { id: 1 },
    empresaId: 2,
    itens: [ITEM],
    pagamentos: [{ forma_pagamento: 'dinheiro', valor: 10 }]
  }, deps('EMPRESA_UNICA', (req, res) => {
    n += 1;
    res.json({ sucesso: true, venda_id: 88, status_pagamento: 'quitada' });
  }));
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.modo, 'EMPRESA_UNICA');
  assert.strictEqual(n, 1);
}

async function test02MultiempresaNaoLegado() {
  let n = 0;
  const r = await finalizarCheckout({ itens: [ITEM], empresaId: 2, user: { id: 1 } }, {
    obterModoOperacaoVenda: () => 'MULTIEMPRESA',
    criarVenda() { n += 1; },
    criarAtendimento: async () => ({
      atendimentoId: 9,
      codigo: 'ATD-00000009',
      status: 'VALIDADO',
      operacoes: [{ operacaoId: 1, empresaId: 2, status: 'VALIDADA' }],
      venda_concluida: false,
      pagamento_pendente: true
    })
  });
  assert.strictEqual(n, 0);
  assert.strictEqual(r.atendimento_id, 9);
  assert.ok(r.venda_id == null);
}

async function test03CarrinhoVazio() {
  await assert.rejects(
    () => finalizarCheckout({ user: { id: 1 }, empresaId: 2, itens: [] }, deps('EMPRESA_UNICA', () => {})),
    (e) => e.code === 'CARRINHO_VAZIO'
  );
}

async function test04SemEmpresa() {
  await assert.rejects(
    () => finalizarCheckout({
      user: { id: 1 },
      itens: [ITEM]
    }, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
      listarEmpresasDisponiveis: async () => [EMP, { id: 3, razao_social: 'B', ativo: 1 }],
      criarVenda() {}
    }),
    (e) => e.code === 'EMPRESA_OPERACIONAL_NAO_SELECIONADA'
  );
}

async function test05ItemSemEmpresa() {
  await assert.rejects(
    () => finalizarCheckout({
      user: { id: 1 },
      empresaId: 2,
      itens: [{ produto_id: 10, quantidade: 1, valor_unitario: 1 }]
    }, deps('EMPRESA_UNICA', () => {})),
    (e) => e.code === 'EMPRESA_OBRIGATORIA'
  );
}

async function test06EmpresaDivergente() {
  await assert.rejects(
    () => finalizarCheckout({
      user: { id: 1 },
      empresaId: 2,
      itens: [{ ...ITEM, empresa_id: 3 }]
    }, deps('EMPRESA_UNICA', () => {})),
    (e) => e.code === 'CARRINHO_EMPRESA_INCONSISTENTE'
  );
}

async function test07MultiplasEmpresas() {
  await assert.rejects(
    () => finalizarCheckout({
      user: { id: 1 },
      empresaId: 2,
      itens: [ITEM, { ...ITEM, produto_id: 11, empresa_id: 3 }]
    }, deps('EMPRESA_UNICA', () => {})),
    (e) => e.code === 'CARRINHO_EMPRESA_INCONSISTENTE'
  );
}

function test08AdapterContrato() {
  adapter.validarCarrinhoEmpresaUnica([ITEM], 2);
  const p = adapter.montarPayloadVendaOficial({
    itens: [ITEM],
    pagamentos: [{ forma_pagamento: 'pix', valor: 10 }]
  });
  assert.strictEqual(p.origem, 'PDV');
  assert.strictEqual(p.forma_pagamento, 'pix');
  assert.strictEqual(p.itens[0].produto_id, 10);
  assert.ok(!Object.prototype.hasOwnProperty.call(p.itens[0], 'quantidade_fiscal'));
}

async function test09DelegaVAS() {
  let porta = null;
  await finalizarCheckout({
    user: { id: 1 }, empresaId: 2, itens: [ITEM]
  }, deps('EMPRESA_UNICA', (req, res) => {
    porta = req.body.origem;
    res.json({ sucesso: true, venda_id: 1 });
  }));
  assert.strictEqual(porta, 'PDV');
}

async function test10UmaVez() {
  let n = 0;
  await finalizarCheckout({
    user: { id: 1 }, empresaId: 2, itens: [ITEM]
  }, deps('EMPRESA_UNICA', (req, res) => {
    n += 1;
    res.json({ sucesso: true, venda_id: 5 });
  }));
  assert.strictEqual(n, 1);
}

async function test11VendaIdReal() {
  const r = await finalizarCheckout({
    user: { id: 1 }, empresaId: 2, itens: [ITEM]
  }, deps('EMPRESA_UNICA', (req, res) => res.json({ sucesso: true, venda_id: 1540 })));
  assert.strictEqual(r.venda_id, 1540);
}

async function test12SemAtendimentoInventado() {
  const r = await finalizarCheckout({
    user: { id: 1 }, empresaId: 2, itens: [ITEM]
  }, deps('EMPRESA_UNICA', (req, res) => res.json({ sucesso: true, venda_id: 9 })));
  assert.strictEqual(r.atendimento_id, null);
}

async function test13ErroNucleo() {
  await assert.rejects(
    () => finalizarCheckout({
      user: { id: 1 }, empresaId: 2, itens: [ITEM]
    }, deps('EMPRESA_UNICA', (req, res) => res.status(400).json({ error: 'falhou', code: 'SALDO_INSUFICIENTE' }))),
    (e) => e.code === 'SALDO_INSUFICIENTE'
  );
}

async function test14PagamentoPreservado() {
  let pags;
  await finalizarCheckout({
    user: { id: 1 }, empresaId: 2, itens: [ITEM],
    pagamentos: [{ forma_pagamento: 'credito', valor: 10 }]
  }, deps('EMPRESA_UNICA', (req, res) => {
    pags = req.body.pagamentos;
    res.json({ sucesso: true, venda_id: 2, status_pagamento: 'quitada' });
  }));
  assert.strictEqual(pags[0].forma_pagamento, 'credito');
}

async function test15Misto() {
  const p = adapter.montarPayloadVendaOficial({
    itens: [ITEM],
    pagamentos: [
      { forma_pagamento: 'dinheiro', valor: 4 },
      { forma_pagamento: 'pix', valor: 6 }
    ]
  });
  assert.strictEqual(p.forma_pagamento, 'misto');
  assert.strictEqual(p.pagamentos.length, 2);
}

async function test16NaoAssumeEmpresa1() {
  await assert.rejects(
    () => finalizarCheckout({
      user: { id: 1 },
      itens: [{ ...ITEM, empresa_id: 1 }]
    }, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
      listarEmpresasDisponiveis: async () => [EMP, { id: 3, razao_social: 'B', ativo: 1 }],
      criarVenda() {}
    }),
    (e) => e.code === 'EMPRESA_OPERACIONAL_NAO_SELECIONADA' || e.code === 'CARRINHO_EMPRESA_INCONSISTENTE'
  );
}

async function test17Idempotencia() {
  let n = 0;
  const depsI = deps('EMPRESA_UNICA', (req, res) => {
    n += 1;
    res.json({ sucesso: true, venda_id: 44 });
  });
  const entrada = {
    user: { id: 1 }, empresaId: 2, itens: [ITEM], idempotency_key: 'k-unico-0505'
  };
  const a = await finalizarCheckout(entrada, depsI);
  const b = await finalizarCheckout(entrada, depsI);
  assert.strictEqual(a.venda_id, 44);
  assert.strictEqual(b.venda_id, 44);
  assert.strictEqual(n, 1);
}

function test18PdvLegado() {
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
  assert.ok(src('backend/rotas/vendas.js').includes('criarVenda'));
  const chk = src('frontend/pdv-universal/pdv-universal-checkout.js');
  assert.ok(chk.includes('/pdv-universal/checkout'));
  assert.ok(!/urlCheckout\(\)[\s\S]*vendas/.test(chk));
  assert.ok(!chk.includes('${baseApi()}/vendas'));
  assert.ok(!chk.includes("'/tef/pagar'"));
  assert.ok(!chk.includes('tef/pagar'));
  assert.strictEqual(capacidadesParaModo('EMPRESA_UNICA').checkout_empresa_unica, true);
  assert.strictEqual(capacidadesParaModo('MULTIEMPRESA').checkout_multiempresa, true);
  assert.ok(!checkoutUi.podeFinalizar({ capacidades: { checkout_empresa_unica: false, checkout_multiempresa: false } }, [ITEM]));
}

async function run() {
  const testes = [
    test01PermiteEmpresaUnica,
    test02MultiempresaNaoLegado,
    test03CarrinhoVazio,
    test04SemEmpresa,
    test05ItemSemEmpresa,
    test06EmpresaDivergente,
    test07MultiplasEmpresas,
    test08AdapterContrato,
    test09DelegaVAS,
    test10UmaVez,
    test11VendaIdReal,
    test12SemAtendimentoInventado,
    test13ErroNucleo,
    test14PagamentoPreservado,
    test15Misto,
    test16NaoAssumeEmpresa1,
    test17Idempotencia,
    test18PdvLegado
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
