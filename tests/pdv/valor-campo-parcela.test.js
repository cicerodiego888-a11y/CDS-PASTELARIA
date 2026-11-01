/**
 * Campo de valor da parcela direta.
 * O total da venda é só o limite. O texto digitado é o valor enviado.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/valor-campo-parcela.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ValorMonetarioPdv = require('../../frontend/pdv/js/valorMonetarioPdv');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');

const TOTAL = 50;
const FONTE_PDV = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');

function inserir(texto, posicao, caractere) {
  return texto.slice(0, posicao) + caractere + texto.slice(posicao);
}

function digitar(inicial, teclas) {
  let texto = inicial;
  let posicao = inicial.length;
  for (const tecla of teclas) {
    if (tecla === 'Backspace') {
      if (posicao > 0) {
        texto = texto.slice(0, posicao - 1) + texto.slice(posicao);
        posicao -= 1;
      }
      continue;
    }
    if (tecla === 'Home') {
      posicao = 0;
      continue;
    }
    texto = inserir(texto, posicao, tecla);
    posicao += 1;
  }
  return texto;
}

function aprovar(id) {
  return { aprovado: true, status: 'aprovado', transacao_id: id, nsu: 'NSU', autorizacao: 'AUT' };
}

async function confirmarComoPdv(interacao, texto, autorizarTef) {
  const valor = ValorMonetarioPdv.ler(texto);
  if (ValorMonetarioPdv.excedeRestante(valor, interacao.visao().restante)) {
    return { ok: false, codigo: 'VALOR_ACIMA_DO_RESTANTE', enviado: null, texto };
  }
  let enviado = null;
  const resultado = await interacao.confirmarValor(valor, {
    formaUsaTef: (forma) => PagamentoSequencial.formaExigeAutorizador(forma),
    autorizarTef: async (forma, valorParcela) => {
      enviado = valorParcela;
      return autorizarTef(forma, valorParcela);
    }
  });
  return { ...resultado, enviado, texto };
}

describe('campo de valor da parcela — total só como limite', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
  });

  it('abrir Débito deixa o campo vazio e não grava o total da venda', () => {
    const inicio = FONTE_PDV.indexOf('function garantirModalValorDireto');
    const fim = FONTE_PDV.indexOf('function escolherFormaDireta');
    const trecho = FONTE_PDV.slice(inicio, fim);
    assert.equal(digitar('', ''), '');
    assert.match(trecho, /if \(opcoes\.limparValor\) \$\('#valorParcelaDireta'\)\.val\(''\)/);
    assert.match(trecho, /placeholder="0,00"/);
    assert.doesNotMatch(trecho, /val\('0,00'\)/);
    assert.doesNotMatch(trecho, /formatar\(restante\)/);
    assert.doesNotMatch(trecho, /input\.value\s*=/);
    assert.match(trecho, /excedeRestante\(valor, interacao\.visao\(\)\.restante\)/);
    assert.match(trecho, /confirmarValor\(valor,/);
    assert.doesNotMatch(trecho, /valor\s*\+\s*totalVenda|valor\s*\+\s*.*restante/);
  });

  it('digitar 20 sobre o 0,00 antigo virava 200 e a máscara gravava os R$ 50,00', () => {
    const concatenado = digitar('0,00', ['Home', '2', '0']);
    assert.equal(concatenado, '200,00');
    assert.equal(ValorMonetarioPdv.ler(concatenado), 200);
    const reescritoPelaMascaraAntiga = ValorMonetarioPdv.excedeRestante(200, TOTAL)
      ? ValorMonetarioPdv.formatar(TOTAL)
      : concatenado;
    assert.equal(ValorMonetarioPdv.ler(reescritoPelaMascaraAntiga), TOTAL);
  });

  it('20,00, 10,00, 0,20 e 50,00 são enviados sem somar o total; 60,00 fica bloqueado', async () => {
    const tabela = [
      ['20,00', 20, false],
      ['10,00', 10, false],
      ['0,20', 0.2, false],
      ['50,00', 50, false],
      ['60,00', 60, true]
    ];

    for (const [texto, esperado, bloqueado] of tabela) {
      PagamentoSequencial.reset();
      const digitado = digitar('', texto);
      assert.equal(digitado, texto);
      const valor = ValorMonetarioPdv.ler(digitado);
      assert.equal(valor, esperado);
      assert.notEqual(valor, esperado + TOTAL);
      assert.equal(ValorMonetarioPdv.excedeRestante(valor, TOTAL), bloqueado);

      const tela = InteracaoPagamentoMisto.criar({ totalVenda: TOTAL, sequencial: PagamentoSequencial });
      tela.escolherForma('cartao_debito');
      const resultado = await confirmarComoPdv(tela, digitado, async () => aprovar(1));
      if (bloqueado) {
        assert.equal(resultado.codigo, 'VALOR_ACIMA_DO_RESTANTE');
        assert.equal(resultado.enviado, null);
        assert.equal(resultado.texto, '60,00');
        assert.equal(PagamentoSequencial.snapshot().length, 0);
        assert.equal(tela.visao().informado, 0);
        assert.equal(tela.visao().restante, TOTAL);
      } else {
        assert.equal(resultado.ok, true);
        assert.equal(resultado.enviado, esperado);
        assert.equal(resultado.parcela.valor, esperado);
      }
    }
  });

  it('débito de 20,00 aprovado deixa recebido 20,00 e saldo 30,00', async () => {
    const tela = InteracaoPagamentoMisto.criar({ totalVenda: TOTAL, sequencial: PagamentoSequencial });
    const aberto = digitar('', '');
    assert.equal(aberto, '');
    tela.escolherForma('cartao_debito');
    const texto = digitar(aberto, '20,00');
    const resultado = await confirmarComoPdv(tela, texto, async () => aprovar(21));
    assert.equal(resultado.enviado, 20);
    assert.notEqual(resultado.enviado, 70);
    assert.notEqual(resultado.enviado, TOTAL);
    assert.equal(tela.visao().informado, 20);
    assert.equal(tela.visao().restante, 30);
    assert.equal(PagamentoSequencial.exportar()[0].valor, 20);
  });

  it('apagar, substituir, fechar e reabrir não reaproveitam o total', async () => {
    let texto = digitar('', '20,00');
    assert.equal(ValorMonetarioPdv.ler(texto), 20);
    texto = digitar(texto, ['Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace']);
    assert.equal(texto, '');
    assert.equal(ValorMonetarioPdv.ler(texto), 0);

    texto = digitar(texto, '60,00');
    assert.equal(texto, '60,00');
    texto = digitar('', '10,00');
    assert.equal(ValorMonetarioPdv.ler(texto), 10);

    texto = '';
    assert.equal(digitar(texto, '0,20'), '0,20');
    assert.equal(ValorMonetarioPdv.ler('0,20'), 0.2);

    const tela = InteracaoPagamentoMisto.criar({ totalVenda: TOTAL, sequencial: PagamentoSequencial });
    tela.escolherForma('cartao_debito');
    tela.cancelarValor();
    assert.equal(tela.visao().solicitarValor, false);
    tela.escolherForma('cartao_debito');
    const reaberto = digitar('', '20,00');
    const resultado = await confirmarComoPdv(tela, reaberto, async () => aprovar(22));
    assert.equal(resultado.enviado, 20);
    assert.equal(tela.visao().restante, 30);
  });
});
