/**
 * Sprint 05.34 — integração de entrega no PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const Entrega = require('../../frontend/pdv-universal/pdv-universal-entrega.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01BalcaoMantemFluxoAtual() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const fin = js.slice(js.indexOf('finBtn.addEventListener'), js.indexOf('function pintarModalTef'));
  assert.ok(fin.includes("modalidadeAtual() === 'ENTREGA'"));
  assert.ok(fin.includes('Checkout.finalizarCheckout'));
  assert.ok(checkout.urlCheckout().endsWith('/pdv-universal/checkout'));
}

function test02ModoEntregaAtivaContexto() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes("definirModalidade('ENTREGA')"));
  assert.ok(js.includes('api._modalidadeAtendimento'));
  assert.ok(js.includes('pdvu-modalidade-entrega'));
  assert.strictEqual(Entrega.MODALIDADES.ENTREGA, 'ENTREGA');
}

async function test03ClienteContratoExistente() {
  let url = '';
  await Entrega.listarClientes(async (u) => {
    url = u;
    return {
      ok: true,
      json: async () => [{ id: 1, nome: 'João', cep: '12345678', rua: 'Rua A' }]
    };
  });
  assert.ok(url.includes('/clientes'));
}

function test04EnderecoContratoExistente() {
  const end = Entrega.enderecoDeCliente({
    telefone: '11999',
    cep: '12345678',
    rua: 'Rua B',
    numero: '10',
    bairro: 'Centro',
    cidade: 'SP',
    uf: 'SP'
  });
  assert.strictEqual(end.endereco_entrega, 'Rua B');
  assert.strictEqual(end.numero_entrega, '10');
  assert.ok(end.cep_entrega.includes('12345'));
}

function test05PayloadEstruturaLegado() {
  const payload = Entrega.montarPayloadVendaEntrega({
    itens: [{
      produto_id: 5,
      quantidade: 2,
      valor_unitario: 10,
      subtotal: 20,
      descricao: 'Item'
    }],
    totais: { total: 20, desconto_valor: 0 },
    form: {
      endereco_entrega: 'Rua X',
      cliente_id: '3',
      pagamento_previsto: 'PIX',
      taxa_entrega: '5'
    }
  });
  assert.strictEqual(payload.tipo_venda, 'ENTREGA');
  assert.strictEqual(payload.endereco_entrega, 'Rua X');
  assert.strictEqual(payload.cliente_id, '3');
  assert.strictEqual(payload.total, 25);
  assert.strictEqual(payload.emitir_fiscal, false);
  assert.deepStrictEqual(payload.pagamentos, []);
  assert.strictEqual(payload.itens[0].produto_id, 5);
}

function test06NenhumEndpointNovo() {
  const ent = src('frontend/pdv-universal/pdv-universal-entrega.js');
  assert.ok(ent.includes('/vendas'));
  assert.ok(ent.includes('/clientes'));
  assert.ok(!ent.includes('/pdv-universal/entrega'));
  assert.ok(!ent.includes('/entregas/criar'));
}

function test07CheckoutBalcaoIntacto() {
  const chk = src('frontend/pdv-universal/pdv-universal-checkout.js');
  assert.ok(chk.includes('/pdv-universal/checkout'));
  assert.ok(!chk.includes('tipo_venda'));
  assert.ok(!chk.includes('ENTREGA'));
}

async function test08ErroNaoLimpaCarrinho() {
  const c = Cart.criarCarrinho();
  c.adicionarItem({
    produto_id: 1,
    empresa_id: 1,
    descricao: 'P',
    quantidade: 1,
    valor_unitario: 10
  });
  try {
    await Entrega.criarVendaEntrega({
      itens: c.obterItens(),
      totais: { total: 10 },
      form: { endereco_entrega: '' }
    });
    assert.fail('deveria falhar');
  } catch (err) {
    assert.strictEqual(err.code, 'ENTREGA_DADOS_INVALIDOS');
  }
  assert.strictEqual(c.localizar(1, 1).quantidade, 1);
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const conf = js.slice(js.indexOf('async function confirmarEntregaOperacional'), js.indexOf('const btnModBalcao'));
  assert.ok(conf.includes('catch (err)'));
  assert.ok(!conf.match(/catch \(err\)[\s\S]*?_cart\.limpar/));
}

function test09CancelamentoVoltaBalcao() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('fecharModalEntrega(true)'));
  assert.ok(js.includes("definirModalidade('BALCAO')"));
}

function test10MultiempresaBloqueia() {
  const gate = Entrega.entregaDisponivelNoModo({ modo_operacao: 'MULTIEMPRESA' });
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.code, 'ENTREGA_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADA');
  assert.strictEqual(Entrega.entregaDisponivelNoModo({ modo_operacao: 'EMPRESA_UNICA' }).ok, true);
}

async function test11CriarVendaChamaPostVendas() {
  let url = '';
  let body = null;
  await Entrega.criarVendaEntrega({
    itens: [{ produto_id: 2, quantidade: 1, valor_unitario: 15, subtotal: 15, descricao: 'A' }],
    totais: { total: 15, desconto_valor: 0 },
    form: { endereco_entrega: 'Av. 1', pagamento_previsto: 'DINHEIRO' }
  }, async (u, op) => {
    url = u;
    body = JSON.parse(op.body);
    return { ok: true, json: async () => ({ message: 'ok', venda_id: 99 }) };
  });
  assert.ok(url.endsWith('/vendas'));
  assert.strictEqual(body.tipo_venda, 'ENTREGA');
  assert.strictEqual(body.endereco_entrega, 'Av. 1');
}

async function run() {
  const testes = [
    test01BalcaoMantemFluxoAtual,
    test02ModoEntregaAtivaContexto,
    test03ClienteContratoExistente,
    test04EnderecoContratoExistente,
    test05PayloadEstruturaLegado,
    test06NenhumEndpointNovo,
    test07CheckoutBalcaoIntacto,
    test08ErroNaoLimpaCarrinho,
    test09CancelamentoVoltaBalcao,
    test10MultiempresaBloqueia,
    test11CriarVendaChamaPostVendas
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
