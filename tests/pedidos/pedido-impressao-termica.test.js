'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI_PATH = path.join(__dirname, '../../frontend/erp/js/pedidos.js');
const UI = fs.readFileSync(UI_PATH, 'utf8');

function criarContexto(overrides = {}) {
  const window = {
    screen: { availWidth: 1280, availHeight: 800 },
    ...overrides.window
  };
  const contexto = {
    window,
    document: {
      createElement() {
        let html = '';
        return {
          set textContent(value) {
            html = String(value)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
          },
          get innerHTML() {
            return html;
          }
        };
      }
    },
    API_URL: 'http://localhost:3001/api',
    CdsEmpresaContexto: { headersJson: () => ({ 'X-Empresa-Id': '1' }) },
    BrandService: { meta: () => ({ nome: 'CDS Sistemas' }) },
    ...overrides.contexto
  };
  vm.runInNewContext(UI, contexto);
  return { contexto, window };
}

function criarPedidoExemplo() {
  return {
    id: 91,
    codigo: 'P-0091',
    data_pedido: '2026-06-17',
    cliente_nome: 'Cliente de Teste',
    desconto: 0,
    frete: 0,
    total: 55.98,
    itens: [
      {
        quantidade: 1,
        produto_nome: 'Pastel do Cheff',
        produto_nome_fiscal: 'Pastel do Cheff fiscal',
        produto_codigo: 'PST-01',
        subtotal: 21.99,
        ingredientes_personalizados: [{ nome: 'Carne de sol adicional' }],
        preco_base_unitario_snapshot: 18.99
      },
      {
        quantidade: 1,
        produto_nome: 'Pastel do Cheff',
        produto_codigo: 'PST-01',
        subtotal: 24.99,
        ingredientes_personalizados: [{ nome: 'Frango e mussarela' }]
      },
      {
        quantidade: 1,
        produto_nome: 'Cajuína São Geraldo 1L',
        produto_codigo: 'BEB-01',
        subtotal: 9
      }
    ]
  };
}

describe('Impressão térmica resumida de Pedidos', () => {
  it('mantém as linhas separadas e imprime apenas quantidade, nome comercial e subtotal', () => {
    const { window } = criarContexto();
    const html = window.montarHtmlImpressaoPedidoTermico(criarPedidoExemplo());

    assert.equal((html.match(/class="item-row"/g) || []).length, 3);
    assert.equal((html.match(/Pastel do Cheff/g) || []).length, 2);
    assert.match(html, /item-nome">Cajuína São Geraldo 1L<\/span>/);
    assert.match(html, /item-valor">R\$\s*21,99<\/span>/);
    assert.match(html, /item-valor">R\$\s*24,99<\/span>/);
    assert.match(html, /item-valor">R\$\s*9,00<\/span>/);
    assert.match(html, /<span>Total<\/span><span>R\$\s*55,98<\/span>/);
    assert.match(html, /Pedido P-0091/);
    assert.match(html, /Cliente de Teste/);
    assert.match(html, /danfe-80/);
    assert.doesNotMatch(html, /Carne de sol|Frango e mussarela|PST-01|preço-base|ficha técnica/i);
  });

  it('preserva o gerador e a chamada A4 legados do faturamento', async () => {
    const urls = [];
    let escrito = '';
    const { window } = criarContexto({
      window: {
        open() {
          return {
            document: {
              open() {},
              write(html) { escrito = html; },
              close() {}
            },
            focus() {}
          };
        }
      },
      contexto: {
        fetch: async (url) => {
          urls.push(url);
          return { ok: true, json: async () => ({ pedido: criarPedidoExemplo() }) };
        }
      }
    });
    const html = window.montarHtmlImpressaoPedido(criarPedidoExemplo());
    const resultado = await window.imprimirPedidoPorId(91);

    assert.match(html, /size:A4/i);
    assert.equal(resultado.ok, true);
    assert.match(escrito, /size:A4/i);
    assert.deepEqual(urls, ['http://localhost:3001/api/pedidos/91']);
    assert.match(UI, /imprimirPedidoPorId\(pedidoId, 'termico'\)/);
  });

  it('envia o layout térmico à impressora de cupom configurada no Electron', async () => {
    const pedido = criarPedidoExemplo();
    const urls = [];
    let impressao;
    const { window } = criarContexto({
      window: {
        electronAPI: {
          abrirComprovante(html, opcoes) {
            impressao = { html, opcoes };
          }
        }
      },
      contexto: {
        fetch: async (url) => {
          urls.push(url);
          if (url.endsWith('/pedidos/91')) {
            return { ok: true, json: async () => ({ pedido }) };
          }
          if (url.endsWith('/configuracoes/impressora_cupom')) {
            return { ok: true, json: async () => ({ sucesso: true, caminho: 'Impressora Térmica Teste' }) };
          }
          throw new Error(`URL inesperada no teste: ${url}`);
        }
      }
    });

    const resultado = await window.imprimirPedidoPorId(91, 'termico');

    assert.equal(resultado.ok, true);
    assert.deepEqual(urls, [
      'http://localhost:3001/api/pedidos/91',
      'http://localhost:3001/api/configuracoes/impressora_cupom'
    ]);
    assert.equal(impressao.opcoes.deviceName, 'Impressora Térmica Teste');
    assert.match(impressao.html, /danfe-80/);
    assert.doesNotMatch(impressao.html, /Carne de sol adicional|Frango e mussarela/);
  });
});
