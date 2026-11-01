/**
 * Abertura do cupom fiscal envia a empresa já selecionada no PDV.
 * Não usa banco, não emite NFC-e e não chama a SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/cupom-fiscal-contexto-empresa.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function carregar() {
  const memoria = new Map();
  const chamadas = [];
  const abertos = [];
  const contexto = {
    console,
    API_URL: 'http://pdv.test/api',
    localStorage: {
      getItem(chave) { return memoria.has(chave) ? memoria.get(chave) : null; },
      setItem(chave, valor) { memoria.set(chave, String(valor)); },
      removeItem(chave) { memoria.delete(chave); }
    },
    fetch: async (url, opcoes) => {
      chamadas.push({ url: String(url), headers: { ...(opcoes && opcoes.headers) } });
      if (String(url).includes('/fiscal/danfe/')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<html>danfe</html>'
        };
      }
      return { ok: true, status: 200, json: async () => ({ caminho: 'cupom' }) };
    },
    electronAPI: {
      abrirComprovante(html) { abertos.push(String(html)); }
    }
  };
  contexto.window = contexto;
  vm.createContext(contexto);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/cds-empresa-contexto.js'), 'utf8'),
    contexto
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/fiscalImpressao.js'), 'utf8'),
    contexto
  );
  return { contexto, memoria, chamadas, abertos };
}

describe('cupom fiscal envia X-Empresa-Id da empresa selecionada', () => {
  it('a abertura do DANFE leva o identificador da empresa e o token', async () => {
    const { contexto, chamadas, abertos } = carregar();
    contexto.localStorage.setItem('token', 'tok-pdv');
    contexto.CdsEmpresaContexto.persistir({
      id: 7,
      cnpj: '65957340000150',
      razao_social: 'Esquinao',
      nome_fantasia: 'Esquinao'
    });

    await contexto.imprimirDANFEFiscal(100001);

    const danfe = chamadas.find((chamada) => chamada.url.includes('/fiscal/danfe/venda/100001'));
    assert.ok(danfe);
    assert.equal(danfe.headers['X-Empresa-Id'], '7');
    assert.equal(danfe.headers.Authorization, 'Bearer tok-pdv');
    assert.equal(abertos.length, 1);
    assert.match(abertos[0], /danfe/);
  });

  it('sem empresa selecionada a chamada segue sem inventar o identificador 1', async () => {
    const { contexto, chamadas } = carregar();
    contexto.localStorage.setItem('token', 'tok-pdv');
    contexto.electronAPI = { abrirComprovante() {} };

    await contexto.imprimirDANFEFiscal(44);

    const danfe = chamadas.find((chamada) => chamada.url.includes('/fiscal/danfe/venda/44'));
    assert.ok(danfe);
    assert.equal(danfe.headers['X-Empresa-Id'], undefined);
    assert.equal(Object.values(danfe.headers).includes('1'), false);
  });
});
