'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('o histórico identifica origem, vendedor, terminal, caixa e data sem classificar legado como mobile/desktop', () => {
  const contexto = {
    console,
    API_URL: '/api',
    window: {},
    document: { getElementById() { return { id: 'vendaModal' }; } },
    bootstrap: { Modal: class { show() {} } },
    formatCurrency(valor) { return `R$ ${Number(valor || 0).toFixed(2)}`; },
    formatDate() { return '31/10/2026'; },
    formatDateTime() { return '31/10/2026 10:30'; },
    paginas: []
  };
  contexto.window = contexto;
  contexto.$ = function $(seletor) {
    return {
      html(valor) {
        if (valor !== undefined && String(seletor) === '#page-content') contexto.paginas.push(String(valor));
        if (valor !== undefined && String(seletor) === '#modal-container') contexto.modal = String(valor);
        return this;
      },
      val() { return ''; }
    };
  };

  vm.createContext(contexto);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/vendasHistoricoUi.js'), 'utf8'),
    contexto
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/vendas.js'), 'utf8'),
    contexto
  );
  vm.runInContext(`
    renderVendas([
      {
        id: 1, codigo: 'DESKTOP-1', data_venda: '2026-10-31', total: 10,
        forma_pagamento: 'dinheiro', status: 'concluida',
        origem_operacao: 'PDV_DESKTOP', operador_id: 7, operador_nome_snapshot: 'Ana'
      },
      {
        id: 2, codigo: 'MOBILE-1', data_venda: '2026-10-31', total: 12,
        forma_pagamento: 'pix', status: 'concluida',
        origem_operacao: 'PDV_MOBILE', operador_id: 8, operador_nome_snapshot: 'Bia'
      },
      {
        id: 3, codigo: 'LEGADO-1', data_venda: '2026-10-31', total: 8,
        forma_pagamento: 'dinheiro', status: 'concluida', origem: 'PDV',
        operador_id: 20, operador_nome_exibicao: 'Nome Atual'
      },
      {
        id: 4, codigo: 'USERNAME-1', data_venda: '2026-10-31', total: 8,
        forma_pagamento: 'dinheiro', status: 'concluida',
        operador_id: 21, operador_nome_exibicao: 'username-legado'
      },
      {
        id: 5, codigo: 'SEM-USUARIO-1', data_venda: '2026-10-31', total: 8,
        forma_pagamento: 'dinheiro', status: 'concluida', operador_id: 999
      }
    ]);
    showVendaModal({
      id: 2,
      codigo: 'MOBILE-1',
      data_venda: '2026-10-31',
      created_at: '2026-10-31 10:30:00',
      total: 12,
      forma_pagamento: 'pix',
      status: 'concluida',
      origem: 'PDV',
      origem_operacao: 'PDV_MOBILE',
      operador_id: 8,
      operador_nome_snapshot: 'Bia',
      operador_nome_exibicao: 'Bia',
      terminal_id: 4,
      terminal_tipo_snapshot: 'MOBILE',
      caixa_id: 21,
      caixa_sessao_id: 9,
      itens: [{ produto_id: 1, produto_nome: 'Pastel', preco_unitario: 12, quantidade: 1, subtotal: 12 }]
    });
  `, contexto);

  const lista = contexto.paginas[0];
  assert.match(lista, />DESKTOP</);
  assert.match(lista, />MOBILE</);
  assert.match(lista, /Não identificado/);
  assert.match(lista, /<td>Ana<\/td>/);
  assert.match(lista, /<td>Bia<\/td>/);
  assert.match(lista, /<td>Nome Atual<\/td>/);
  assert.match(lista, /<td>username-legado<\/td>/);
  assert.match(lista, /<td>ID #999<\/td>/);
  assert.doesNotMatch(lista, /Ana \(#7\)|Bia \(#8\)|PDV sem distinção histórica/);
  assert.match(contexto.modal, />MOBILE</);
  assert.match(contexto.modal, /Classificação persistida:<\/strong> PDV_MOBILE/);
  assert.match(contexto.modal, /Origem legada:<\/strong> PDV/);
  assert.match(contexto.modal, /Usuário ID #8/);
  assert.match(contexto.modal, /Terminal Mobile #4/);
  assert.match(contexto.modal, /Turno #21/);
  assert.match(contexto.modal, /#9/);
  assert.match(contexto.modal, /31\/10\/2026 10:30/);
});
