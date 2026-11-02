/**
 * PDV-MOBILE-06 — entrada única e preservação do estado.
 * Não abre o banco oficial e não executa cobrança.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const raiz = path.join(__dirname, '../..');

function ler(relativo) {
  return fs.readFileSync(path.join(raiz, relativo), 'utf8');
}

function storageFalso() {
  const dados = new Map();
  return {
    getItem(chave) { return dados.has(chave) ? dados.get(chave) : null; },
    setItem(chave, valor) { dados.set(chave, String(valor)); },
    removeItem(chave) { dados.delete(chave); }
  };
}

describe('entrada /mobile/', () => {
  it('publica a tela inicial e mantém as rotas antigas', () => {
    const servidor = ler('backend/server.js');
    const inicio = ler('frontend/mobile/index.html');
    const pedido = ler('frontend/mobile-pedido/index.html');
    const pdv = ler('frontend/mobile-pdv/index.html');
    const licenca = ler('backend/middleware/licencaMiddleware.js');
    assert.match(servidor, /\/mobile', '\/mobile\/'/);
    assert.match(servidor, /\/mobile-pedido', '\/mobile-pedido\/'/);
    assert.match(servidor, /\/mobile-pdv', '\/mobile-pdv\/'/);
    assert.match(inicio, /href="\/mobile-pedido\/"/);
    assert.match(inicio, /href="\/mobile-pdv\/"/);
    assert.match(inicio, /CDS Sistemas/);
    assert.match(pedido, /href="\/mobile\/"/);
    assert.match(pdv, /href="\/mobile\/"/);
    assert.match(licenca, /LICENCA_AUSENTE/);
    assert.doesNotMatch(inicio, /CDS_ALLOW_OFFICIAL_DB|licencaMiddleware\s*=/);
    const acesso = require('../../frontend/shared/js/pdv-acesso-oficial');
    assert.equal(acesso.destinoNavegacaoSeguro('/mobile/'), '/mobile/');
    assert.equal(acesso.destinoNavegacaoSeguro('/mobile-pedido/'), '/mobile-pedido/');
  });
});

describe('estado operacional da aba', () => {
  it('preserva pedido e pagamento e não descarta a operação de outro operador', () => {
    const memoria = storageFalso();
    const local = storageFalso();
    local.setItem('user', JSON.stringify({ id: 8, nome: 'Operador A' }));
    global.sessionStorage = memoria;
    global.localStorage = local;
    delete require.cache[require.resolve('../../frontend/shared/js/cds-mobile-operacao.js')];
    require('../../frontend/shared/js/cds-mobile-operacao.js');
    const operacao = global.CdsMobileOperacao;
    operacao.salvarPedido({
      etapa: 'carrinho',
      cliente: { id: 3, nome: 'Ana' },
      itens: [{ editor_id: 1, nome: 'Pastel', quantidade: 2, subtotal: 20 }],
      sequencia: 1,
      desconto: 0,
      observacao: 'sem cebola'
    });
    operacao.salvarPdv({
      itens: [{ produto_id: 4, quantidade: 1, subtotal: 10, nome: 'Refrigerante' }],
      total: 10,
      pagamento: { parcelas: [{ local_id: 1, forma_pagamento: 'pix', valor: 10, status_autorizacao: 'pendente' }] }
    });
    const pedido = operacao.lerPedido();
    const pdv = operacao.lerPdv();
    assert.equal(operacao.pedidoEmAndamento(pedido.registro), true);
    assert.equal(pedido.registro.estado.itens[0].nome, 'Pastel');
    assert.equal(pdv.registro.pagamento.parcelas[0].status_autorizacao, 'pendente');

    local.setItem('user', JSON.stringify({ id: 9, nome: 'Operador B' }));
    const bloqueio = operacao.salvarPedido({ etapa: 'cliente', itens: [] });
    assert.equal(bloqueio.codigo, 'OPERADOR_DIVERGENTE');
    local.setItem('user', JSON.stringify({ id: 8, nome: 'Operador A' }));
    assert.equal(operacao.lerPedido().registro.estado.itens.length, 1);

    const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
    PagamentoSequencial.reset();
    const parcelas = PagamentoSequencial.reidratar(pdv.registro.pagamento);
    assert.equal(parcelas.length, 1);
    assert.equal(parcelas[0].status_autorizacao, 'pendente');
    assert.equal(parcelas[0].valor, 10);
    PagamentoSequencial.reset();
    assert.equal(PagamentoSequencial.snapshot().length, 0);
  });
});
