/**
 * Sprint 27 — empresa da transação TEF e valor em reais.
 * Sem banco oficial, sem TEF real e sem emissão fiscal.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-27-tef-empresa-valor.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ValorMonetarioPdv = require('../../frontend/pdv/js/valorMonetarioPdv');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');
const { resolverEmpresaAutorizadaTef } = require('../../backend/services/tef/tefEmpresaContexto');
const SimulatedGatewayAdapter = require('../../backend/services/tef/adapters/SimulatedGatewayAdapter');
const tefContrato = require('../../backend/services/tef/tefContrato');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

function contextoOficial() {
  const sandbox = {
    console,
    localStorage: {
      dados: new Map(),
      getItem(chave) { return this.dados.has(chave) ? this.dados.get(chave) : null; },
      setItem(chave, valor) { this.dados.set(chave, String(valor)); },
      removeItem(chave) { this.dados.delete(chave); }
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/cds-empresa-contexto.js'), 'utf8'),
    sandbox
  );
  return sandbox.CdsEmpresaContexto;
}

function negar(mensagem) {
  const erro = new Error(mensagem || 'Usuário não está autorizado a usar esta empresa.');
  erro.code = 'EMPRESA_NAO_AUTORIZADA';
  return erro;
}

describe('sprint 27 — empresa e valor do TEF', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
  });

  it('1. empresa ativa do contexto oficial entra no cabeçalho e é aceita', async () => {
    const contexto = contextoOficial();
    contexto.persistir({ id: 7, nome_fantasia: 'Operação' });
    const headers = contexto.headersJson();
    assert.equal(headers['X-Empresa-Id'], '7');
    const pedido = { user: { id: 3 }, headers };
    const resolvido = await resolverEmpresaAutorizadaTef(pedido, {
      exigirEmpresaAutorizada: async (_usuario, empresaId) => {
        assert.equal(empresaId, 7);
        return { empresaId };
      },
      consultarEmpresasDoCaixaAberto: async () => {
        throw new Error('não deveria cair no caixa');
      }
    });
    assert.equal(resolvido.empresaId, 7);
    assert.equal(resolvido.codigo, null);
  });

  it('2. empresa ausente mantém o bloqueio', async () => {
    const contexto = contextoOficial();
    const headers = contexto.headersJson();
    assert.equal(headers['X-Empresa-Id'], undefined);
    const resolvido = await resolverEmpresaAutorizadaTef(
      { user: { id: 3 }, headers },
      {
        exigirEmpresaAutorizada: async () => { throw new Error('não deveria autorizar'); },
        consultarEmpresasDoCaixaAberto: async () => []
      }
    );
    assert.equal(resolvido.empresaId, null);
    assert.equal(resolvido.codigo, 'TEF_EMPRESA_AUSENTE');

    const varias = await resolverEmpresaAutorizadaTef(
      { user: { id: 3 }, headers: {} },
      {
        exigirEmpresaAutorizada: async (_usuario, empresaId) => ({ empresaId }),
        consultarEmpresasDoCaixaAberto: async () => [{ empresa_id: 1 }, { empresa_id: 2 }]
      }
    );
    assert.equal(varias.empresaId, null);
    assert.equal(varias.codigo, 'TEF_EMPRESA_AUSENTE');
  });

  it('3. empresa não autorizada mantém o bloqueio', async () => {
    const resolvido = await resolverEmpresaAutorizadaTef(
      { user: { id: 3 }, headers: { 'x-empresa-id': '9' } },
      {
        exigirEmpresaAutorizada: async () => { throw negar(); },
        consultarEmpresasDoCaixaAberto: async () => [{ empresa_id: 1 }]
      }
    );
    assert.equal(resolvido.empresaId, null);
    assert.equal(resolvido.codigo, 'EMPRESA_NAO_AUTORIZADA');
  });

  it('4 e 5. empresa autorizada entrega R$ 20,00 ao simulador', async () => {
    const resolvido = await resolverEmpresaAutorizadaTef(
      { user: { id: 3 }, headers: { 'x-empresa-id': '7' } },
      {
        exigirEmpresaAutorizada: async (_usuario, empresaId) => ({ empresaId }),
        consultarEmpresasDoCaixaAberto: async () => []
      }
    );
    assert.equal(resolvido.empresaId, 7);
    const valor = ValorMonetarioPdv.ler('20,00');
    assert.equal(valor, 20);
    const adapter = new SimulatedGatewayAdapter({}, { nome: 'Stone', adquirente: 'STONE' });
    const bruto = await adapter.autorizarPagamento({
      tipo: 'cartao_debito',
      valor,
      resultado_simulado: 'aprovado'
    });
    const resposta = tefContrato.paraRespostaApi(bruto, bruto.transacaoId);
    assert.equal(resposta.aprovado, true);
    assert.equal(bruto.modo, 'simulacao');
    assert.equal(ValorMonetarioPdv.arredondar(valor), 20);

    const tela = InteracaoPagamentoMisto.criar({ totalVenda: 50, sequencial: PagamentoSequencial });
    const chamadas = [];
    tela.escolherForma('cartao_debito');
    const passo = await tela.confirmarValor(valor, {
      autorizarTef: async (_forma, valorParcela, chave) => {
        chamadas.push({ valor: valorParcela, chave });
        return resposta;
      }
    });
    assert.equal(chamadas[0].valor, 20);
    assert.match(chamadas[0].chave, /20\.00$/);
    assert.equal(passo.parcelas[0].valor, 20);
    assert.equal(passo.parcelas[0].status_autorizacao, 'aprovada');
  });

  it('6. R$ 0,20 informado permanece R$ 0,20', () => {
    assert.equal(ValorMonetarioPdv.ler('0,20'), 0.2);
    assert.equal(ValorMonetarioPdv.ler('20'), 20);
    assert.equal(ValorMonetarioPdv.ler('20,00'), 20);
    assert.equal(ValorMonetarioPdv.limitarAoRestante(80, 50), 50);
  });

  it('7 e 8. recusa e timeout não aprovam; a parcela só entra depois do retorno', async () => {
    const tela = InteracaoPagamentoMisto.criar({ totalVenda: 50, sequencial: PagamentoSequencial });
    tela.escolherForma('cartao_debito');
    let liberar;
    const espera = new Promise((resolve) => { liberar = resolve; });
    const envio = tela.confirmarValor(20, {
      autorizarTef: async () => {
        await espera;
        return { aprovado: true, status: 'aprovado', transacao_id: 11, nsu: 'NSU', autorizacao: 'AUT' };
      }
    });
    await Promise.resolve();
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    liberar();
    const aprovado = await envio;
    assert.equal(aprovado.parcelas.length, 1);

    tela.escolherForma('cartao_credito');
    const recusa = await tela.confirmarValor(10, {
      autorizarTef: async () => ({ aprovado: false, status: 'negado' })
    });
    assert.equal(recusa.codigo, 'TEF_REJEITADO');
    const timeout = await tela.confirmarValor(10, {
      autorizarTef: async () => ({ sucesso: false, aprovado: false, codigo: 'TIMEOUT', tipo_erro: 'timeout' })
    });
    assert.equal(timeout.codigo, 'TIMEOUT');
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    assert.equal(PagamentoSequencial.snapshot()[0].tef_transacao_id, 11);
  });

  it('9 e 10. misto usa a mesma lista e não reautoriza a parcela aprovada', async () => {
    const tela = InteracaoPagamentoMisto.criar({ totalVenda: 30, sequencial: PagamentoSequencial });
    tela.escolherForma('cartao_debito');
    await tela.confirmarValor(20, {
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 4, nsu: 'NSU', autorizacao: 'AUT' })
    });
    tela.escolherForma('dinheiro');
    const dinheiro = await tela.confirmarValor(10, { formaUsaTef: () => false });
    assert.equal(dinheiro.podeFinalizar, true);
    assert.equal(dinheiro.parcelas[1].status_autorizacao, 'informada');
    const repetidas = [];
    await PagamentoSequencial.autorizarParcelasPendentes(PagamentoSequencial.exportar(), {
      tefHabilitado: true,
      formaUsaTef: (forma) => PagamentoSequencial.formaExigeAutorizador(forma),
      autorizarTef: async () => {
        repetidas.push(1);
        return { aprovado: true, status: 'aprovado', transacao_id: 99 };
      }
    });
    assert.equal(repetidas.length, 0);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    const fonte = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');
    assert.match(fonte, /headers:\s*headersPedidoPdv\(\)/);
    assert.match(fonte, /valor:\s*valorReais/);
  });
});
