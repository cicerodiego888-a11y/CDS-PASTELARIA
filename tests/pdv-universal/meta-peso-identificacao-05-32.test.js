/**
 * Sprint 05.32 — meta.peso do pipeline POST /produtos/identificar no carrinho Universal.
 */
'use strict';

const assert = require('assert');
const Ident = require('../../frontend/pdv-universal/pdv-universal-identificacao.js');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');

const EAN_ETIQUETA = '2001234567890';

function mipFracionado(overrides) {
  return Object.assign({
    encontrado: true,
    produtoId: 123,
    produto: {
      id: 123,
      nome: 'Queijo',
      preco_venda: 40,
      produto_fracionado: 1,
      produto_pesavel: 1
    },
    meta: { peso: 0.75 },
    strategy: 'PLU'
  }, overrides || {});
}

async function test01FracionadoMetaPesoValido() {
  const res = await Ident.identificarEntradaPdv('123', {}, {
    identificar: async () => mipFracionado(),
    consultar: async () => []
  });
  assert.strictEqual(res.tipo, Ident.TIPOS.UNICO);
  assert.strictEqual(res.quantidade, 0.75);
  assert.strictEqual(res.meta.quantidadeOrigem, 'META_PESO');
}

async function test02FracionadoMetaPesoDecimalTresCasas() {
  const res = await Ident.identificarEntradaPdv('123', {}, {
    identificar: async () => mipFracionado({ meta: { peso: 0.7505 } }),
    consultar: async () => []
  });
  assert.strictEqual(res.quantidade, 0.751);
}

async function test03NaoFracionadoIgnoraMetaPeso() {
  const res = await Ident.identificarEntradaPdv('99', {}, {
    identificar: async () => mipFracionado({
      produtoId: 99,
      produto: { id: 99, nome: 'Refri', preco_venda: 5, produto_fracionado: 0 },
      meta: { peso: 0.5 }
    }),
    consultar: async () => []
  });
  assert.strictEqual(res.quantidade, 1);
  assert.strictEqual(res.meta.quantidadeOrigem, undefined);
}

async function test04MetaPesoAusente() {
  const res = await Ident.identificarEntradaPdv('123', {}, {
    identificar: async () => mipFracionado({ meta: { plu: '123' } }),
    consultar: async () => []
  });
  assert.strictEqual(res.quantidade, 1);
}

async function test05MetaPesoInvalido() {
  assert.strictEqual(Ident.parseMetaPeso('abc'), null);
  const res = await Ident.identificarEntradaPdv('123', {}, {
    identificar: async () => mipFracionado({ meta: { peso: 'invalido' } }),
    consultar: async () => []
  });
  assert.strictEqual(res.quantidade, 1);
}

async function test06MetaPesoZeroOuNegativo() {
  assert.strictEqual(Ident.parseMetaPeso(0), null);
  assert.strictEqual(Ident.parseMetaPeso(-1), null);
  const res = await Ident.identificarEntradaPdv('123', {}, {
    identificar: async () => mipFracionado({ meta: { peso: 0 } }),
    consultar: async () => []
  });
  assert.strictEqual(res.quantidade, 1);
}

async function test07EtiquetaPrioridadeSobreMetaPeso() {
  const res = await Ident.identificarEntradaPdv(EAN_ETIQUETA, {}, {
    interpretarEtiqueta: async () => ({
      success: true,
      sucesso: true,
      resultado: { plu: '123', pluRaw: '123', peso: 0.453, tipoPayload: 'PESO' }
    }),
    identificar: async () => mipFracionado({ meta: { peso: 0.999 } }),
    consultar: async () => []
  });
  assert.strictEqual(res.quantidade, 0.453);
  assert.strictEqual(res.meta.quantidadeOrigem, 'ETIQUETA_PESO');
}

function test08IdentidadeProdutoEmpresa() {
  const c = Cart.criarCarrinho();
  c.adicionarItem({
    produto_id: 123,
    empresa_id: 1,
    descricao: 'A',
    quantidade: 0.75,
    valor_unitario: 10,
    produto_fracionado: 1
  });
  c.adicionarItem({
    produto_id: 123,
    empresa_id: 2,
    descricao: 'B',
    quantidade: 0.5,
    valor_unitario: 10,
    produto_fracionado: 1
  });
  assert.strictEqual(c.localizar(123, 1).quantidade, 0.75);
  assert.strictEqual(c.localizar(123, 2).quantidade, 0.5);
  assert.strictEqual(c.obterItens().length, 2);
}

async function run() {
  const testes = [
    test01FracionadoMetaPesoValido,
    test02FracionadoMetaPesoDecimalTresCasas,
    test03NaoFracionadoIgnoraMetaPeso,
    test04MetaPesoAusente,
    test05MetaPesoInvalido,
    test06MetaPesoZeroOuNegativo,
    test07EtiquetaPrioridadeSobreMetaPeso,
    test08IdentidadeProdutoEmpresa
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
