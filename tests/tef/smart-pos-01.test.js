/**
 * SMART-POS-01 — contrato e simulador, sem adquirente e sem banco oficial.
 *
 * Executar: node --test --test-concurrency=1 tests/tef/smart-pos-01.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-smartpos01-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { criarAdapter } = require('../../backend/services/tef/tefFactory');
const contrato = require('../../backend/services/tef/smartPosContrato');
const tefContrato = require('../../backend/services/tef/tefContrato');

function adaptador() {
  return criarAdapter({
    provedor: 'smart_pos_simulador',
    ambiente: 'simulacao',
    terminal_id: 'terminal-teste'
  });
}

function pedido(extra = {}) {
  return {
    tipo: 'pix',
    valor: 20,
    empresa_id: 4,
    operador_id: 8,
    idempotency_key: 'chave-pix-20',
    resultado_simulado: 'aprovado',
    ...extra
  };
}

function carregarSequencial() {
  const contexto = { console };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  const fonte = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pagamentoSequencial.js'), 'utf8');
  vm.runInContext(fonte, contexto);
  return contexto.PagamentoSequencial;
}

describe('contrato e fábrica', () => {
  it('seleciona só o simulador quando o provedor é o de teste', () => {
    const adapter = adaptador();
    assert.equal(adapter.nome, 'smart_pos_simulador');
    assert.equal(adapter.simulado, true);
    const terminal = adapter.identificarTerminal();
    assert.equal(terminal.terminal_id, 'terminal-teste');
    assert.equal(terminal.fabricante, null);
    assert.equal(terminal.protocolo, null);
    assert.throws(
      () => criarAdapter({ provedor: 'smart_pos_itau', ambiente: 'simulacao' }),
      /não suportado/
    );
  });

  it('recusa modalidade, valor, empresa ou operador ausentes e ignora aprovação enviada pelo cliente', async () => {
    const adapter = adaptador();
    const semModalidade = await adapter.autorizarPagamento(pedido({ tipo: 'vale', resultado_simulado: 'aprovado' }));
    assert.equal(semModalidade.codigo, 'MODALIDADE_INVALIDA');
    const semValor = await adapter.autorizarPagamento(pedido({ valor: 0 }));
    assert.equal(semValor.codigo, 'VALOR_INVALIDO');
    const semEmpresa = await adapter.autorizarPagamento(pedido({ empresa_id: null }));
    assert.equal(semEmpresa.codigo, 'EMPRESA_AUSENTE');
    const semOperador = await adapter.autorizarPagamento(pedido({ operador_id: null }));
    assert.equal(semOperador.codigo, 'OPERADOR_AUSENTE');
    const atalho = await adapter.autorizarPagamento(pedido({ resultado_simulado: null, aprovado: true, nsu: 'NSU-FALSO' }));
    assert.equal(atalho.codigo, 'RESULTADO_SIMULADO_AUSENTE');
    assert.equal(atalho.sucesso, false);
    assert.equal(atalho.nsu, null);
  });
});

describe('estados simulados', () => {
  it('PIX, débito e crédito aprovados mantêm a solicitação e não são recebimento real', async () => {
    for (const tipo of ['pix', 'debito', 'credito']) {
      const adapter = adaptador();
      const resposta = await adapter.autorizarPagamento(pedido({
        tipo,
        idempotency_key: 'mod-' + tipo
      }));
      assert.equal(resposta.status, 'aprovado');
      assert.equal(resposta.transacaoId, 'sim-1');
      assert.equal(resposta.payloadRetorno.modalidade, contrato.normalizarModalidade(tipo));
      assert.equal(resposta.payloadRetorno.valor, 20);
      assert.equal(resposta.payloadRetorno.simulado, true);
      assert.equal(contrato.podeContabilizarComoRecebimentoReal({
        aprovado: true,
        status: resposta.status,
        transacao_id: resposta.transacaoId,
        modo: resposta.modo,
        simulado: true
      }), false);
    }
  });

  it('recusa, pendência, espera e solicitação não contam como recebidas', async () => {
    const casos = [
      ['recusado', 'negado', 'recusada'],
      ['pendente', 'pendente', 'processando'],
      ['aguardando_terminal', 'pendente', 'aguardando_terminal'],
      ['solicitada', 'pendente', 'solicitada']
    ];
    for (const [pedidoEstado, status, estado] of casos) {
      const adapter = adaptador();
      const resposta = await adapter.autorizarPagamento(pedido({
        resultado_simulado: pedidoEstado,
        idempotency_key: pedidoEstado
      }));
      assert.equal(resposta.sucesso, false);
      assert.equal(resposta.status, status);
      assert.equal(resposta.payloadRetorno.estado, estado);
    }
  });

  it('timeout e falha de comunicação não gravam aprovação', async () => {
    const timeout = adaptador();
    await assert.rejects(
      () => timeout.autorizarPagamento(pedido({ resultado_simulado: 'timeout' })),
      (erro) => erro.codigo === 'TIMEOUT'
    );
    assert.equal(timeout.registros.size, 0);
    const falha = adaptador();
    await assert.rejects(
      () => falha.autorizarPagamento(pedido({ resultado_simulado: 'falha' })),
      (erro) => erro.codigo === 'FALHA_COMUNICACAO'
    );
    assert.equal(falha.registros.size, 0);
  });

  it('cancela, repete a solicitação e consulta de novo sem outra cobrança', async () => {
    const adapter = adaptador();
    const primeira = await adapter.autorizarPagamento(pedido());
    const segunda = await adapter.autorizarPagamento(pedido({ resultado_simulado: 'recusado', nsu: 'OUTRO' }));
    assert.equal(segunda.codigo, 'SOLICITACAO_REPETIDA');
    assert.equal(segunda.transacaoId, primeira.transacaoId);
    assert.equal(adapter.registros.size, 1);
    const consulta = await adapter.consultarTransacao(primeira.transacaoId);
    const deNovo = await adapter.consultarTransacao(primeira.transacaoId);
    assert.equal(consulta.transacaoId, deNovo.transacaoId);
    assert.equal(consulta.status, 'aprovado');
    const cancelada = await adapter.cancelarPagamento(primeira.transacaoId);
    assert.equal(cancelada.status, 'cancelado');
    assert.equal(cancelada.sucesso, true);
    const apos = await adapter.consultarTransacao(primeira.transacaoId);
    assert.equal(apos.status, 'cancelado');
    assert.equal(apos.sucesso, false);
  });

  it('consulta inexistente e não reutiliza transação vinculada', async () => {
    const adapter = adaptador();
    const ausente = await adapter.consultarTransacao('nao-existe');
    assert.equal(ausente.dados.codigo, 'TRANSACAO_INEXISTENTE');
    const criada = await adapter.autorizarPagamento(pedido());
    const vinculo = adapter.vincularVenda(criada.transacaoId, 90);
    assert.equal(vinculo.ok, true);
    const repetida = await adapter.autorizarPagamento(pedido());
    assert.equal(repetida.codigo, 'TRANSACAO_JA_VINCULADA');
    assert.equal(repetida.sucesso, false);
    assert.equal(adapter.registros.size, 1);
    const publica = tefContrato.respostaAcompanhamentoPublica(tefContrato.classificarAcompanhamento({
      id: 90,
      status: 'aprovado',
      venda_id: 15,
      valor: 20,
      tipo: 'pix',
      nsu: 'NSU-SECRETO',
      autorizacao: 'AUT-SECRETA'
    }));
    assert.equal(publica.aprovado, false);
    assert.equal(publica.code, 'TRANSACAO_JA_VINCULADA');
    assert.equal(publica.transacao_id, undefined);
    assert.equal(JSON.stringify(publica).includes('NSU-SECRETO'), false);
  });

  it('isola empresa e operador', async () => {
    const adapter = adaptador();
    await adapter.autorizarPagamento(pedido());
    const outraEmpresa = await adapter.autorizarPagamento(pedido({ empresa_id: 9 }));
    assert.equal(outraEmpresa.codigo, 'TEF_EMPRESA_DIVERGENTE');
    assert.equal(outraEmpresa.nsu, null);
    const outroOperador = await adapter.autorizarPagamento(pedido({ operador_id: 3 }));
    assert.equal(outroOperador.codigo, 'TEF_OPERADOR_DIVERGENTE');
    assert.equal(outroOperador.nsu, null);
    assert.equal(adapter.registros.size, 1);
  });
});

describe('pagamento sequencial e estação', () => {
  it('o formato aprovado entra na sequência e os demais estados não', async () => {
    const sequencial = carregarSequencial();
    const adapter = adaptador();
    const aprovado = await adapter.autorizarPagamento(pedido({ idempotency_key: 'seq-pix' }));
    const debito = await adaptador().autorizarPagamento(pedido({
      tipo: 'debito',
      valor: 15,
      idempotency_key: 'seq-debito'
    }));
    await sequencial.adicionar({
      forma: 'pix',
      valor: 20,
      totalVenda: 50,
      autorizarTef: async () => ({
        aprovado: aprovado.sucesso === true,
        status: aprovado.status,
        transacao_id: aprovado.transacaoId
      })
    });
    await sequencial.adicionar({
      forma: 'cartao_debito',
      valor: 15,
      totalVenda: 50,
      autorizarTef: async () => ({
        aprovado: debito.sucesso === true,
        status: debito.status,
        transacao_id: debito.transacaoId
      })
    });
    const recusa = await adaptador().autorizarPagamento(pedido({
      resultado_simulado: 'recusado',
      idempotency_key: 'seq-recusa'
    }));
    const negada = await sequencial.adicionar({
      forma: 'cartao_credito',
      valor: 15,
      totalVenda: 50,
      autorizarTef: async () => ({ aprovado: false, status: recusa.status })
    });
    assert.equal(negada.ok, false);
    assert.equal(sequencial.soma(), 35);
    assert.equal(contrato.podeContabilizarComoRecebimentoReal({
      aprovado: true,
      status: 'aprovado',
      transacao_id: aprovado.transacaoId,
      modo: 'simulacao'
    }), false);
  });

  it('o celular continua na estação e identifica a simulação', () => {
    const contexto = {
      console,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      location: { origin: 'http://cds.test', replace() {} },
      document: {
        readyState: 'loading',
        getElementById() { return null; },
        addEventListener() {},
        querySelectorAll() { return []; }
      },
      fetch: async () => { throw new Error('não'); }
    };
    contexto.window = contexto;
    contexto.globalThis = contexto;
    vm.createContext(contexto);
    const raiz = path.join(__dirname, '../..');
    for (const arquivo of [
      'frontend/shared/js/tefFluxoPagamento.js',
      'frontend/pdv/js/pagamentoSequencial.js',
      'frontend/pdv/js/interacaoPagamentoMisto.js',
      'frontend/pdv/js/pdv-fechamento-oficial.js',
      'frontend/mobile-pdv/mobile-pdv.js'
    ]) {
      vm.runInContext(fs.readFileSync(path.join(raiz, arquivo), 'utf8'), contexto);
    }
    return contexto.MobilePdv.autorizarEletronico('pix', 10, 'chave', async () => {
      throw new Error('autorizador não pode ser chamado');
    }).then((retorno) => {
      assert.equal(retorno.codigo, 'TEF_ESTACAO');
      assert.equal(
        contexto.MobilePdv.textoSmartPosSimulado({ simulado: true, status: 'aprovado' }),
        'Simulação de Smart POS. Este resultado não é um recebimento real.'
      );
      const pagina = fs.readFileSync(path.join(raiz, 'frontend/mobile-pdv/mobile-pdv.js'), 'utf8');
      const html = fs.readFileSync(path.join(raiz, 'frontend/mobile-pdv/index.html'), 'utf8');
      assert.match(pagina, /mv-consultar-estacao/);
      assert.match(html, /confirmação gravada pela estação/);
      assert.match(html, /não é recebimento real/);
    });
  });
});
