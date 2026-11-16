/**
 * Preserva vProd do XML no subtotal (evita gap por arredondamento a 2 casas).
 * Executar: node tests/compras/subtotal-xml-vprod-precisao.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../../frontend/erp/js/compras.js'),
  'utf8'
);

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `função ${name} não encontrada`);
  let i = start + `function ${name}`.length;
  let paren = 0;
  let seenParen = false;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') {
      paren += 1;
      seenParen = true;
    } else if (ch === ')') {
      paren -= 1;
    } else if (ch === '{' && seenParen && paren === 0) {
      break;
    }
  }
  let depth = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`não fechou ${name}`);
}

const resolverSrc = extractFunction('resolverSubtotalFinanceiroItemCompra');
// eslint-disable-next-line no-new-func
const resolverSubtotalFinanceiroItemCompra = new Function(
  `${resolverSrc}; return resolverSubtotalFinanceiroItemCompra;`
)();

let ok = 0;
let falhas = 0;
function test(nome, fn) {
  try {
    fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`  FALHOU  ${nome}`);
    console.error(`         ${err.message}`);
  }
}

console.log('\n=== Subtotal XML / precisão vProd ===\n');

test('preserva vProd quando qtd/preço XML intactos (Fanta)', () => {
  const r = resolverSubtotalFinanceiroItemCompra({
    quantidade: 36,
    preco_unitario: 2.806111,
    subtotal_xml: 101.02,
    quantidade_xml: 36,
    preco_unitario_xml: 2.806111
  });
  assert.strictEqual(r, 101.02);
});

test('não usa q×p arredondado a 2 casas (36×2.81)', () => {
  const errado = Number((36 * 2.81).toFixed(2));
  assert.strictEqual(errado, 101.16);
  const r = resolverSubtotalFinanceiroItemCompra({
    quantidade: 36,
    preco_unitario: 2.806111,
    subtotal_xml: 101.02,
    quantidade_xml: 36,
    preco_unitario_xml: 2.806111
  });
  assert.notStrictEqual(r, errado);
});

test('preserva vProd mesmo se unitário foi arredondado a 2 casas na UI', () => {
  const r = resolverSubtotalFinanceiroItemCompra({
    quantidade: 36,
    preco_unitario: 2.81,
    subtotal_xml: 101.02,
    quantidade_xml: 36,
    preco_unitario_xml: 2.806111
  });
  assert.strictEqual(r, 101.02);
});

test('recalcula só se operador marcar preço editado manual', () => {
  const r = resolverSubtotalFinanceiroItemCompra({
    quantidade: 36,
    preco_unitario: 2.81,
    subtotal_xml: 101.02,
    quantidade_xml: 36,
    preco_unitario_xml: 2.806111,
    preco_editado_manual: 1
  });
  assert.strictEqual(r, 101.16);
});

test('soma Coca-Cola NF fecha 1804.76', () => {
  const itens = [
    { q: 36, u: 2.806111, s: 101.02 },
    { q: 36, u: 4.800833, s: 172.83 },
    { q: 48, u: 8.121667, s: 389.84 },
    { q: 204, u: 3.522451, s: 718.58 },
    { q: 54, u: 7.823889, s: 422.49 }
  ];
  const soma = itens.reduce((acc, i) => acc + resolverSubtotalFinanceiroItemCompra({
    quantidade: i.q,
    preco_unitario: Number(i.u.toFixed(6)),
    subtotal_xml: i.s,
    quantidade_xml: i.q,
    preco_unitario_xml: Number(i.u.toFixed(6))
  }), 0);
  assert.strictEqual(Number(soma.toFixed(2)), 1804.76);
});

test('helpers genéricos de XML / precisão', () => {
  assert.match(src, /function extrairTotaisXmlItemCompra/);
  assert.match(src, /subtotal_xml/);
  assert.match(src, /preco_unitario_xml/);
  assert.match(src, /quantidade_xml/);
  assert.match(src, /preco_editado_manual/);
  assert.match(src, /xmlAtivo \? 6 : 2/);
});

console.log(`\nResultado: ${ok} ok, ${falhas} falhas\n`);
process.exit(falhas ? 1 : 0);
