/**
 * Integração etiqueta balança — PDV Universal → POST /equipamentos/etiquetas/interpretar (A.1).
 */
'use strict';

const assert = require('assert');
const Ident = require('../../frontend/pdv-universal/pdv-universal-identificacao.js');
const cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');

const EAN_ETIQUETA = '2001234567890';

function test01DetectaEanEtiqueta() {
  assert.strictEqual(Ident.codigoEhEtiquetaBalanca(EAN_ETIQUETA), true);
  assert.strictEqual(Ident.codigoEhEtiquetaBalanca('7891000100103'), false);
}

function test02UrlInterpretarOficial() {
  assert.ok(Ident.urlInterpretarEtiqueta().endsWith('/equipamentos/etiquetas/interpretar'));
}

async function test03FluxoPesoAplicaQuantidade() {
  const resolucao = await Ident.identificarEntradaPdv(EAN_ETIQUETA, {}, {
    interpretarEtiqueta: async () => ({
      success: true,
      sucesso: true,
      semLayoutAtivo: false,
      resultado: {
        plu: '123',
        pluRaw: '00123',
        peso: 0.453,
        tipoPayload: 'PESO'
      }
    }),
    identificar: async (plu) => ({
      encontrado: true,
      produtoId: 5,
      produto: {
        id: 5,
        nome: 'Queijo',
        preco_venda: 40,
        produto_fracionado: 1,
        plu: String(plu)
      },
      strategy: 'PLU'
    }),
    consultar: async () => []
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.UNICO);
  assert.strictEqual(resolucao.metodo, 'ETIQUETA_BALANCA');
  assert.strictEqual(resolucao.quantidade, 0.453);
  assert.strictEqual(resolucao.produtos[0].id, 5);
  assert.strictEqual(resolucao.meta.quantidadeOrigem, 'ETIQUETA_PESO');
}

async function test04FluxoValorCalculaPeso() {
  const qty = Ident.quantidadeOperacionalDeEtiqueta(
    { resultado: { tipoPayload: 'VALOR', valorTotal: 20, peso: null } },
    { preco_venda: 40 }
  );
  assert.strictEqual(qty.ok, true);
  assert.strictEqual(qty.quantidade, 0.5);
  assert.strictEqual(qty.origem, 'ETIQUETA_VALOR');
}

async function test05SemLayoutAtivoErro() {
  const resolucao = await Ident.identificarEntradaPdv(EAN_ETIQUETA, {}, {
    interpretarEtiqueta: async () => ({
      success: true,
      sucesso: false,
      semLayoutAtivo: true,
      mensagem: 'Nenhuma balança configurada para o PDV.'
    }),
    identificar: async () => { throw new Error('nao deve chamar'); },
    consultar: async () => []
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.ERRO);
  assert.ok(resolucao.mensagem.includes('balança'));
}

async function test06PluRawPreferido() {
  let pluIdentificar = null;
  await Ident.identificarEntradaPdv(EAN_ETIQUETA, {}, {
    interpretarEtiqueta: async () => ({
      success: true,
      sucesso: true,
      resultado: { plu: 12, pluRaw: '00012', peso: 1, tipoPayload: 'PESO' }
    }),
    identificar: async (plu) => {
      pluIdentificar = plu;
      return {
        encontrado: true,
        produtoId: 1,
        produto: { id: 1, nome: 'X', preco_venda: 10, produto_fracionado: 1 }
      };
    },
    consultar: async () => []
  });
  assert.strictEqual(pluIdentificar, '00012');
}

async function test07CarrinhoRecebeQuantidadeEtiqueta() {
  const c = cart.criarCarrinho();
  const resolucao = await Ident.identificarEntradaPdv(EAN_ETIQUETA, {}, {
    interpretarEtiqueta: async () => ({
      success: true,
      sucesso: true,
      resultado: { plu: '1', peso: 0.5, tipoPayload: 'PESO' }
    }),
    identificar: async () => ({
      encontrado: true,
      produtoId: 99,
      produto: { id: 99, nome: 'P', preco_venda: 20, produto_fracionado: 1 }
    }),
    consultar: async () => []
  });
  c.adicionarItem({
    produto_id: resolucao.produtos[0].id,
    empresa_id: 1,
    descricao: resolucao.produtos[0].nome,
    quantidade: resolucao.quantidade,
    valor_unitario: 20,
    produto_fracionado: 1
  });
  const item = c.localizar(99, 1);
  assert.strictEqual(item.quantidade, 0.5);
  assert.strictEqual(item.subtotal, 10);
}

async function test08ChamarInterpretarContrato() {
  let url = '';
  let body = null;
  await Ident.chamarInterpretarEtiqueta(EAN_ETIQUETA, {}, async (u, op) => {
    url = u;
    body = JSON.parse(op.body);
    return {
      ok: true,
      json: async () => ({ success: true, sucesso: true, resultado: { plu: '1', peso: 1 } })
    };
  });
  assert.ok(url.endsWith('/equipamentos/etiquetas/interpretar'));
  assert.strictEqual(body.codigo, EAN_ETIQUETA);
}

async function run() {
  const testes = [
    test01DetectaEanEtiqueta,
    test02UrlInterpretarOficial,
    test03FluxoPesoAplicaQuantidade,
    test04FluxoValorCalculaPeso,
    test05SemLayoutAtivoErro,
    test06PluRawPreferido,
    test07CarrinhoRecebeQuantidadeEtiqueta,
    test08ChamarInterpretarContrato
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
