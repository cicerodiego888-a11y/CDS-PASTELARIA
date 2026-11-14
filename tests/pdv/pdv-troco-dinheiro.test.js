/**
 * Troco do pagamento em dinheiro no PDV.
 * Sem banco oficial, sem TEF real e sem NFC-e.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/pdv-troco-dinheiro.test.js
 */
'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const ValorMonetarioPdv = require('../../frontend/pdv/js/valorMonetarioPdv');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');
const { registroFinanceiroParcela } = require('../../backend/services/vendas/registroTrocoDinheiro');
const {
  avaliarReferenciaRecomposicao
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');

const FONTE_PDV = fs.readFileSync(
  path.join(__dirname, '../../frontend/pdv/js/pdv.js'),
  'utf8'
);
const FONTE_VENDA = fs.readFileSync(
  path.join(__dirname, '../../backend/services/vendas/VendaPagamentoService.js'),
  'utf8'
);

function tela(total) {
  PagamentoSequencial.reset();
  return InteracaoPagamentoMisto.criar({
    totalVenda: total,
    sequencial: PagamentoSequencial
  });
}

function referencia(total, pagamentos) {
  return avaliarReferenciaRecomposicao({ total, pagamentos });
}

describe('pagamento em dinheiro com troco', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
  });

  it('aceita dinheiro igual ao saldo e grava troco zero', async () => {
    const venda = tela(8.99);
    venda.escolherForma('dinheiro');
    const passo = await venda.confirmarValor(8.99, { formaUsaTef: () => false });
    assert.equal(passo.ok, true);
    assert.equal(passo.parcela.valor, 8.99);
    assert.equal(passo.parcela.valor_entregue, 8.99);
    assert.equal(passo.parcela.troco, 0);
    assert.equal(passo.restante, 0);
    assert.equal(passo.podeFinalizar, true);
  });

  it('separa entregue, aplicado e troco quando o dinheiro supera o saldo', async () => {
    const venda = tela(48.99);
    venda.escolherForma('pix');
    await venda.confirmarValor(40, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 1, nsu: 'N', autorizacao: 'A' })
    });
    venda.escolherForma('dinheiro');
    const passo = await venda.confirmarValor(9, { formaUsaTef: () => false });
    assert.equal(passo.ok, true);
    assert.equal(passo.parcela.valor_entregue, 9);
    assert.equal(passo.parcela.valor, 8.99);
    assert.equal(passo.parcela.troco, 0.01);
    assert.equal(passo.restante, 0);
    assert.equal(PagamentoSequencial.soma(), 48.99);
  });

  it('calcula troco de um centavo e de valores maiores em centavos inteiros', () => {
    const centavo = ValorMonetarioPdv.separarDinheiro(9, 8.99);
    assert.equal(centavo.aplicado, 8.99);
    assert.equal(centavo.troco, 0.01);
    const maior = ValorMonetarioPdv.separarDinheiro(50, 8.99);
    assert.equal(maior.aplicado, 8.99);
    assert.equal(maior.troco, 41.01);
    assert.equal(Math.round(maior.troco * 100), 4101);
  });

  it('aceita dinheiro inferior ao saldo e mantém a venda em aberto', async () => {
    const venda = tela(48.99);
    venda.escolherForma('dinheiro');
    const passo = await venda.confirmarValor(40, { formaUsaTef: () => false });
    assert.equal(passo.parcela.valor, 40);
    assert.equal(passo.parcela.troco, 0);
    assert.equal(passo.restante, 8.99);
    assert.equal(passo.podeFinalizar, false);
  });

  it('quita a venda pelo valor devido e não soma o troco como receita', async () => {
    const venda = tela(48.99);
    venda.escolherForma('dinheiro');
    await venda.confirmarValor(50, { formaUsaTef: () => false });
    const exportado = PagamentoSequencial.exportar();
    assert.equal(exportado[0].valor, 48.99);
    assert.equal(exportado[0].valor_entregue, 50);
    assert.equal(exportado[0].troco, 1.01);
    assert.equal(PagamentoSequencial.soma(), 48.99);
    const registro = registroFinanceiroParcela(exportado[0]);
    assert.deepEqual(registro, { valor: 48.99, valor_entregue: 50, troco: 1.01 });
    assert.equal(registro.valor, 48.99);
  });

  it('recusa valor inválido e não confirma duas vezes a mesma etapa', () => {
    assert.equal(ValorMonetarioPdv.separarDinheiro(0, 8.99).codigo, 'VALOR_INVALIDO');
    assert.equal(ValorMonetarioPdv.separarDinheiro(-1, 8.99).codigo, 'VALOR_INVALIDO');
    const aberto = ValorMonetarioPdv.decidirConfirmacaoDinheiro(
      { restante: 8.99, confirmacaoAberta: false, emRegistro: false },
      9
    );
    assert.equal(aberto.acao, 'aguardar_confirmacao');
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    const repetido = ValorMonetarioPdv.decidirConfirmacaoDinheiro(
      { restante: 8.99, confirmacaoAberta: true, emRegistro: true },
      9
    );
    assert.equal(repetido.acao, 'ignorada');
    assert.equal(repetido.codigo, 'CONFIRMACAO_DUPLICADA');
  });

  it('exige confirmação antes do registro e o voltar não grava a parcela', () => {
    const decisao = ValorMonetarioPdv.decidirConfirmacaoDinheiro(
      { restante: 8.99, confirmacaoAberta: false, emRegistro: false },
      9
    );
    assert.equal(decisao.acao, 'aguardar_confirmacao');
    assert.equal(decisao.conta.entregue, 9);
    assert.equal(decisao.conta.restante, 8.99);
    assert.equal(decisao.conta.aplicado, 8.99);
    assert.equal(decisao.conta.troco, 0.01);
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    const trecho = FONTE_PDV.slice(
      FONTE_PDV.indexOf('let trocoEmRegistro'),
      FONTE_PDV.indexOf('function escolherFormaDireta')
    );
    assert.match(trecho, /DINHEIRO ENTREGUE/);
    assert.match(trecho, /SALDO RESTANTE/);
    assert.match(trecho, /VALOR APLICADO/);
    assert.match(trecho, /TROCO/);
    assert.match(trecho, /btnVoltarTrocoDireto/);
    assert.match(trecho, /Confirmar pagamento/);
    assert.match(trecho, /if \(trocoEmRegistro\) return/);
  });

  it('mantém PIX, débito e crédito bloqueados acima do saldo', async () => {
    for (const forma of ['pix', 'cartao_debito', 'cartao_credito']) {
      PagamentoSequencial.reset();
      const venda = tela(10);
      venda.escolherForma(forma);
      const acima = await venda.confirmarValor(10.01, { formaUsaTef: () => false });
      assert.equal(acima.codigo, 'VALOR_ACIMA_DO_RESTANTE');
      assert.equal(PagamentoSequencial.snapshot().length, 0);
    }
    const trecho = FONTE_PDV.slice(
      FONTE_PDV.indexOf('function confirmarValorDireto'),
      FONTE_PDV.indexOf('function escolherFormaDireta')
    );
    assert.match(trecho, /excedeRestante\(valor, interacao\.visao\(\)\.restante\)/);
  });

  it('mantém a mesma referência com dinheiro aplicado primeiro ou por último', async () => {
    const tef = {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 4, nsu: 'N', autorizacao: 'A' })
    };

    const primeiro = tela(48.99);
    primeiro.escolherForma('dinheiro');
    await primeiro.confirmarValor(8.99, { formaUsaTef: () => false });
    primeiro.escolherForma('pix');
    await primeiro.confirmarValor(40, tef);
    const referenciaPrimeiro = referencia(48.99, PagamentoSequencial.exportar());

    const ultimo = tela(48.99);
    ultimo.escolherForma('pix');
    await ultimo.confirmarValor(40, tef);
    ultimo.escolherForma('dinheiro');
    await ultimo.confirmarValor(9, { formaUsaTef: () => false });
    const lista = PagamentoSequencial.exportar();
    assert.equal(lista.find((p) => p.forma_pagamento === 'dinheiro').valor, 8.99);
    assert.equal(lista.find((p) => p.forma_pagamento === 'dinheiro').troco, 0.01);
    const referenciaUltimo = referencia(48.99, lista);

    assert.equal(referenciaPrimeiro.valor_fiscal_referencia, 40);
    assert.equal(referenciaPrimeiro.valor_nao_fiscal_referencia, 8.99);
    assert.equal(referenciaUltimo.valor_fiscal_referencia, 40);
    assert.equal(referenciaUltimo.valor_nao_fiscal_referencia, 8.99);
    assert.equal(
      referenciaPrimeiro.valor_fiscal_referencia + referenciaPrimeiro.valor_nao_fiscal_referencia,
      48.99
    );
  });

  it('grava o aplicado na coluna de pagamento e o troco em coluna própria', async () => {
    const registro = registroFinanceiroParcela({
      forma_pagamento: 'dinheiro',
      valor: 8.99,
      valor_entregue: 9,
      troco: 0.01
    });
    assert.match(FONTE_VENDA, /registroFinanceiroParcela\(pagamento\)/);
    assert.match(FONTE_VENDA, /valor_entregue, troco/);
    const db = new sqlite3.Database(':memory:');
    await new Promise((resolve, reject) => {
      db.run(`
        CREATE TABLE venda_pagamentos (
          id INTEGER PRIMARY KEY,
          venda_id INTEGER,
          forma_pagamento TEXT,
          valor DECIMAL(10,2),
          valor_entregue DECIMAL(10,2),
          troco DECIMAL(10,2)
        )
      `, (erro) => (erro ? reject(erro) : resolve()));
    });
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor, valor_entregue, troco)
         VALUES (?, ?, ?, ?, ?)`,
        [1, 'dinheiro', registro.valor, registro.valor_entregue, registro.troco],
        (erro) => (erro ? reject(erro) : resolve())
      );
    });
    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT valor, valor_entregue, troco, (SELECT SUM(valor) FROM venda_pagamentos) AS total_aplicado
         FROM venda_pagamentos WHERE venda_id = 1`,
        (erro, linha) => (erro ? reject(erro) : resolve(linha))
      );
    });
    assert.equal(row.valor, 8.99);
    assert.equal(row.valor_entregue, 9);
    assert.equal(row.troco, 0.01);
    assert.equal(row.total_aplicado, 8.99);
    db.close();
  });

  it('recusa troco que aumentaria o valor aplicado', () => {
    assert.throws(
      () => registroFinanceiroParcela({ valor: 9, valor_entregue: 9, troco: 0.01 }),
      (erro) => erro.code === 'TROCO_DIVERGENTE'
    );
  });
});
