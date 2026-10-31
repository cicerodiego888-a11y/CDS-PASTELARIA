/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 19
 * Paridade de desconto e acréscimo na ponte autorizada F×NF.
 *
 * Executar:
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-19.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  encaminharPropostaValidadaAoDistribuidorOficial,
  obterAutorizacaoDistribuicaoOficialInterna
} = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');
const {
  distribuirItensVendaComValorFiscalEfetivo
} = require('../../backend/services/distribuidorEstoqueVenda');
const {
  calcularValorFiscalLiquido
} = require('../../backend/services/vendas/valorFiscalLiquido');

const ROOT = path.join(__dirname, '../..');
const PRODUTO = 1;
const PAGAMENTOS = Object.freeze([
  Object.freeze({ forma_pagamento: 'debito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'credito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'dinheiro', valor: 10 })
]);

function autorizacao() {
  return obterAutorizacaoDistribuicaoOficialInterna({}, { ativa: true });
}

function base(extra = {}) {
  return {
    env: {},
    autorizacao: autorizacao(),
    validacao: {
      composicao_validada_em_homologacao: true,
      itens_composicao: [{ produto_id: PRODUTO, quantidade: 4, subtotal: 40 }]
    },
    itensVendidos: [{
      produto_id: PRODUTO,
      quantidade: 5,
      preco_unitario: 10,
      subtotal: 50,
      unidade: 'UN'
    }],
    pagamentos: PAGAMENTOS.map((p) => ({ ...p })),
    totalComercial: 50,
    empresaId: 1,
    saldosPorProduto: { [PRODUTO]: { saldoFiscal: 10, saldoNaoFiscal: 10 } },
    aplicarSaldo: false,
    ...extra
  };
}

function distribuirRegistrando(registro) {
  return (entradas, vendaFiscal, opcoes) => {
    registro.push({
      vendaFiscal,
      desconto: Number(opcoes.desconto || 0),
      acrescimo: Number(opcoes.acrescimo || 0),
      quantidade: entradas[0].item.quantidade
    });
    return distribuirItensVendaComValorFiscalEfetivo(entradas, vendaFiscal, opcoes);
  };
}

function motorLegado(desconto, acrescimo) {
  return distribuirItensVendaComValorFiscalEfetivo(
    [{
      item: {
        produto_id: PRODUTO,
        quantidade: 5,
        preco_unitario: 10,
        subtotal: 50,
        unidade: 'UN'
      },
      saldoFiscal: 10,
      saldoNaoFiscal: 10
    }],
    true,
    {
      pagamentos: PAGAMENTOS.map((p) => ({ ...p })),
      desconto,
      acrescimo,
      midpAtivo: false,
      politicaFiscalComercial: null
    }
  );
}

async function aplicar(desconto, acrescimo, extra = {}) {
  const registro = [];
  const out = await encaminharPropostaValidadaAoDistribuidorOficial(base({
    desconto,
    acrescimo,
    deps: { distribuir: distribuirRegistrando(registro) },
    ...extra
  }));
  return { out, registro };
}

function assertQuantidadesPreservadas(linha) {
  assert.equal(linha.quantidade, 5);
  assert.equal(linha.quantidade_fiscal, 4);
  assert.equal(linha.quantidade_nao_fiscal, 1);
  assert.equal(linha.subtotal, 50);
}

describe('Sprint 19 — desconto e acréscimo na ponte F×NF', () => {
  it('sem desconto e sem acréscimo preserva 40/10 e quantidades 4 e 1', async () => {
    const { out, registro } = await aplicar(0, 0);
    assert.equal(out.distribuicao_aplicada, true);
    const linha = out.resultado_oficial.itens[0];
    assertQuantidadesPreservadas(linha);
    assert.equal(linha.valor_fiscal, 40);
    assert.equal(linha.valor_nao_fiscal, 10);
    assert.equal(out.resultado_oficial.totalVenda, 50);
    assert.equal(out.desconto_enviado_ao_distribuidor, 0);
    assert.equal(out.acrescimo_enviado_ao_distribuidor, 0);
    assert.equal(registro[0].desconto, 0);
    assert.equal(registro[1].desconto, 0);
    assert.equal(registro[0].acrescimo, 0);
    assert.equal(registro[1].acrescimo, 0);
  });

  it('desconto comercial é rateado uma vez entre fiscal e não fiscal', async () => {
    const desconto = 5;
    const rateio = calcularValorFiscalLiquido({
      valorFiscalBruto: 40,
      valorNaoFiscalBruto: 10,
      desconto,
      acrescimo: 0
    });
    const legado = motorLegado(desconto, 0);
    const { out, registro } = await aplicar(desconto, 0);
    const linha = out.resultado_oficial.itens[0];

    assert.equal(out.distribuicao_aplicada, true);
    assertQuantidadesPreservadas(linha);
    assert.equal(linha.valor_fiscal, 36);
    assert.equal(linha.valor_nao_fiscal, 9);
    assert.equal(linha.valor_fiscal, rateio.valorFiscalLiquido);
    assert.equal(linha.valor_nao_fiscal, rateio.valorNaoFiscalLiquido);
    assert.equal(out.resultado_oficial.totalVenda, rateio.totalLiquido);
    assert.equal(out.resultado_oficial.totalVenda, legado.totalVenda);
    assert.equal(out.resultado_oficial.valorFiscalBruto, 40);
    assert.equal(out.resultado_oficial.valorNaoFiscalBruto, 10);
    assert.equal(out.desconto_enviado_ao_distribuidor, 5);
    assert.equal(registro[0].desconto + registro[1].desconto, 5);
    assert.ok(registro[0].desconto < 5);
    assert.ok(registro[1].desconto < 5);
    assert.ok(registro[0].desconto > 0);
    assert.ok(registro[1].desconto > 0);
    assert.notEqual(out.resultado_oficial.totalVenda, 40);
    assert.deepEqual(
      out.resultado_oficial.itens[0].quantidade_fiscal,
      4
    );
    assert.equal(legado.itens[0].quantidade_fiscal, 5);
    assert.deepEqual(
      PAGAMENTOS.map((p) => p.valor),
      [20, 20, 10]
    );
  });

  it('acréscimo segue o mesmo rateio oficial sem alterar quantidades', async () => {
    const acrescimo = 2;
    const rateio = calcularValorFiscalLiquido({
      valorFiscalBruto: 40,
      valorNaoFiscalBruto: 10,
      desconto: 0,
      acrescimo
    });
    const legado = motorLegado(0, acrescimo);
    const { out, registro } = await aplicar(0, acrescimo);
    const linha = out.resultado_oficial.itens[0];

    assert.equal(out.distribuicao_aplicada, true);
    assertQuantidadesPreservadas(linha);
    assert.equal(linha.valor_fiscal, rateio.valorFiscalLiquido);
    assert.equal(linha.valor_nao_fiscal, rateio.valorNaoFiscalLiquido);
    assert.equal(out.resultado_oficial.totalVenda, legado.totalVenda);
    assert.equal(out.resultado_oficial.totalVenda, 52);
    assert.equal(registro[0].desconto, 0);
    assert.equal(registro[1].desconto, 0);
    assert.equal(Math.round((registro[0].acrescimo + registro[1].acrescimo) * 100) / 100, 2);
    assert.ok(registro[0].acrescimo < 2);
    assert.ok(registro[1].acrescimo < 2);
  });

  it('desconto e acréscimo simultâneos equivalem ao líquido do Motor legado', async () => {
    const desconto = 5;
    const acrescimo = 2;
    const rateio = calcularValorFiscalLiquido({
      valorFiscalBruto: 40,
      valorNaoFiscalBruto: 10,
      desconto,
      acrescimo
    });
    const legado = motorLegado(desconto, acrescimo);
    const { out, registro } = await aplicar(desconto, acrescimo);
    const linha = out.resultado_oficial.itens[0];
    const somaDesconto = Math.round(registro.reduce((s, c) => s + c.desconto, 0) * 100) / 100;
    const somaAcrescimo = Math.round(registro.reduce((s, c) => s + c.acrescimo, 0) * 100) / 100;

    assert.equal(out.distribuicao_aplicada, true);
    assertQuantidadesPreservadas(linha);
    assert.equal(linha.valor_fiscal, rateio.valorFiscalLiquido);
    assert.equal(linha.valor_nao_fiscal, rateio.valorNaoFiscalLiquido);
    assert.equal(out.resultado_oficial.totalVenda, 47);
    assert.equal(out.resultado_oficial.totalVenda, legado.totalVenda);
    assert.equal(out.desconto_enviado_ao_distribuidor, 5);
    assert.equal(out.acrescimo_enviado_ao_distribuidor, 2);
    assert.equal(Math.round((50 - somaDesconto + somaAcrescimo) * 100) / 100, 47);
    assert.ok(somaDesconto < 10);
    assert.notEqual(registro[0].desconto, 5);
    assert.notEqual(registro[1].desconto, 5);
  });

  it('falha do distribuidor mantém o resultado do Motor legado', async () => {
    const legado = motorLegado(5, 0);
    const snap = JSON.stringify(legado);
    const out = await encaminharPropostaValidadaAoDistribuidorOficial(base({
      desconto: 5,
      deps: {
        distribuir() {
          return { sucesso: false, erro: { mensagem: 'saldo insuficiente' } };
        }
      }
    }));
    let resultadoParaFechamento = legado;
    if (
      out.distribuicao_aplicada === true
      && out.resultado_oficial
      && out.resultado_oficial.sucesso === true
    ) {
      resultadoParaFechamento = out.resultado_oficial;
    }
    assert.equal(out.distribuicao_aplicada, false);
    assert.equal(out.resultado_oficial, null);
    assert.equal(resultadoParaFechamento, legado);
    assert.equal(JSON.stringify(legado), snap);
    assert.equal(legado.itens[0].quantidade_fiscal, 5);
  });

  it('resultado que ignora o rateio não substitui o Motor legado', async () => {
    const legado = motorLegado(5, 0);
    const out = await encaminharPropostaValidadaAoDistribuidorOficial(base({
      desconto: 5,
      deps: {
        distribuir(entradas, vendaFiscal) {
          const item = entradas[0].item;
          const bruto = item.quantidade * item.preco_unitario;
          return {
            sucesso: true,
            itens: [{
              quantidade_fiscal: vendaFiscal ? item.quantidade : 0,
              quantidade_nao_fiscal: vendaFiscal ? 0 : item.quantidade,
              valor_fiscal: vendaFiscal ? bruto : 0,
              valor_nao_fiscal: vendaFiscal ? 0 : bruto
            }]
          };
        }
      }
    }));
    let resultadoParaFechamento = legado;
    if (out.distribuicao_aplicada === true && out.resultado_oficial && out.resultado_oficial.sucesso === true) {
      resultadoParaFechamento = out.resultado_oficial;
    }
    assert.equal(out.distribuicao_aplicada, false);
    assert.equal(out.codigo, 'VALOR_INCOMPATIVEL');
    assert.equal(resultadoParaFechamento.totalVenda, legado.totalVenda);
    assert.equal(resultadoParaFechamento.itens[0].quantidade_fiscal, 5);
  });

  it('sem autorização o distribuidor não é chamado e o desconto não entra', async () => {
    const registro = [];
    const out = await encaminharPropostaValidadaAoDistribuidorOficial(base({
      desconto: 5,
      acrescimo: 2,
      autorizacao: { ativa: false },
      deps: { distribuir: distribuirRegistrando(registro) }
    }));
    assert.equal(out.distribuicao_aplicada, false);
    assert.equal(out.codigo, 'AUTORIZACAO_AUSENTE');
    assert.equal(out.desconto_enviado_ao_distribuidor, 0);
    assert.equal(out.resultado_oficial, null);
    assert.equal(registro.length, 0);
  });

  it('criarVenda encaminha o mesmo desconto e acréscimo do Motor legado', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    const inicio = src.indexOf('encaminharPropostaValidadaAoDistribuidorOficial({');
    assert.ok(inicio > 0);
    const trecho = src.slice(inicio, inicio + 700);
    assert.ok(trecho.includes('desconto: Number(desconto || 0)'));
    assert.ok(trecho.includes('acrescimo: Number(acrescimo || 0)'));
    assert.ok(trecho.includes('aplicarSaldo: false'));
    const motor = src.indexOf('const resultadoMotor = distribuirItensVendaComValorFiscalEfetivo');
    const chamadaMotor = src.slice(motor, motor + 400);
    assert.ok(chamadaMotor.includes('desconto: Number(desconto || 0)'));
    assert.ok(chamadaMotor.includes('acrescimo: Number(acrescimo || 0)'));
    const preview = src.indexOf('function preCalcularDistribuicao');
    const ponteNoPreview = src.slice(preview, src.indexOf('function criarVenda'));
    assert.equal(ponteNoPreview.includes('encaminharPropostaValidadaAoDistribuidorOficial'), false);
  });
});
