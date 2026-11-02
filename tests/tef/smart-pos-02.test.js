/**
 * SMART-POS-02 — simulador pelo TefManager, no banco temporário.
 * Não abre o banco oficial, não cobra adquirente e não transmite NFC-e.
 *
 * Executar: node --test --test-concurrency=1 tests/tef/smart-pos-02.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-smartpos02-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const db = require('../../backend/database');
const tefManager = require('../../backend/services/tef/TefManager');
const tef = require('../../backend/services/tef');
const tefFactory = require('../../backend/services/tef/tefFactory');
const tefContrato = require('../../backend/services/tef/tefContrato');
const contrato = require('../../backend/services/tef/smartPosContrato');
const OrquestradorPagamento = require('../../backend/services/OrquestradorPagamento');

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function esperarTabela(nome) {
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    const row = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [nome]);
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('tabela ausente: ' + nome);
}

function pedido(extra = {}) {
  return {
    tipo: 'pix',
    valor: 20,
    empresa_id: 4,
    operador_id: 8,
    parcelas: 1,
    idempotency_key: 'smart-pos-02-' + Math.random().toString(16).slice(2),
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

before(async () => {
  await db.whenReady;
  await esperarTabela('tef_transacoes');
  await esperarTabela('tef_configuracao');
  await esperarTabela('tef_locks');
  await run(`
    INSERT INTO tef_configuracao (habilitado, provedor, ambiente, terminal_codigo, atualizado_em)
    VALUES (1, 'smart_pos_simulador', 'simulacao', 'terminal-teste', datetime('now'))
  `);
});

describe('seleção só em teste', () => {
  it('recusa o simulador fora do ambiente de teste e mantém o SiTef', () => {
    const sitef = tefFactory.criarAdapter({ provedor: 'sitef', ambiente: 'simulacao' });
    assert.equal(sitef.nome, 'CliSiTef');
    const isolamento = process.env.CDS_TEST_ISOLATION;
    const bloqueio = process.env.CDS_BLOQUEAR_BANCO_OFICIAL;
    delete process.env.CDS_TEST_ISOLATION;
    delete process.env.CDS_BLOQUEAR_BANCO_OFICIAL;
    try {
      assert.throws(
        () => tefFactory.criarAdapter({ provedor: 'smart_pos_simulador', ambiente: 'simulacao' }),
        /não suportado/
      );
    } finally {
      process.env.CDS_TEST_ISOLATION = isolamento;
      process.env.CDS_BLOQUEAR_BANCO_OFICIAL = bloqueio;
    }
  });
});

describe('núcleo TEF', () => {
  it('PIX, débito e crédito aprovados ficam gravados como simulação', async () => {
    for (const tipo of ['pix', 'debito', 'credito']) {
      const resposta = await tef.iniciarPagamento(pedido({
        tipo,
        idempotency_key: 'mod-' + tipo
      }));
      assert.equal(resposta.status, 'aprovado');
      assert.equal(resposta.simulado, true);
      assert.equal(resposta.modo, 'simulacao');
      assert.equal(resposta.nsu, null);
      assert.equal(contrato.podeContabilizarComoRecebimentoReal(resposta), false);
      const row = await get(`SELECT status, provedor, adquirente, nsu, autorizacao, valor, tipo FROM tef_transacoes WHERE id = ?`, [resposta.transacao_id]);
      assert.equal(row.status, 'aprovado');
      assert.equal(row.provedor, 'smart_pos_simulador');
      assert.equal(row.adquirente, 'SIMULADOR');
      assert.equal(row.nsu, null);
      assert.equal(row.autorizacao, null);
      assert.equal(Number(row.valor), 20);
    }
  });

  it('recusa, pendência, timeout e falha não aprovam e não geram segunda cobrança no retry', async () => {
    const recusa = await tefManager.autorizar(pedido({ resultado_simulado: 'recusado', idempotency_key: 'recusa' }));
    assert.equal(recusa.status, 'negado');
    assert.equal(recusa.aprovado, false);
    const pendente = await tefManager.autorizar(pedido({ resultado_simulado: 'pendente', idempotency_key: 'pendente' }));
    assert.equal(pendente.status, 'pendente');
    const timeout = await tefManager.autorizar(pedido({ resultado_simulado: 'timeout', idempotency_key: 'timeout' }));
    assert.equal(timeout.status, 'timeout');
    assert.equal(timeout.simulado, true);
    const falha = await tefManager.autorizar(pedido({ resultado_simulado: 'falha', idempotency_key: 'falha' }));
    assert.equal(falha.status, 'erro');
    assert.equal(falha.codigo, 'FALHA_COMUNICACAO');
    for (const chave of ['recusa', 'pendente', 'timeout', 'falha']) {
      const contagem = await get(`SELECT COUNT(*) AS total FROM tef_transacoes WHERE idempotency_key = ?`, [chave]);
      assert.equal(contagem.total, 1);
    }
  });

  it('consulta a transação gravada de novo em outro processo', async () => {
    const criada = await tefManager.autorizar(pedido({ idempotency_key: 'consulta-processo' }));
    const consulta = await tefManager.consultar(criada.transacao_id);
    assert.equal(consulta.status, 'aprovado');
    assert.equal(consulta.dados.simulado, true);
    assert.equal(consulta.nsu, null);
    const filho = spawnSync(process.execPath, ['-e', `
      process.env.DB_DIR = ${JSON.stringify(dbDir)};
      process.env.CDS_TEST_ISOLATION = '1';
      process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
      process.env.CDS_FORCAR_LOCAL = '1';
      delete process.env.CDS_ALLOW_OFFICIAL_DB;
      const tef = require(${JSON.stringify(path.join(__dirname, '../../backend/services/tef'))});
      tef.consultarPagamento(${Number(criada.transacao_id)}).then((resultado) => {
        process.stdout.write('\\n' + JSON.stringify({
          status: resultado.status,
          simulado: resultado.dados && resultado.dados.simulado,
          nsu: resultado.nsu
        }));
        process.exit(0);
      }).catch((erro) => {
        process.stderr.write(erro && erro.stack ? erro.stack : String(erro));
        process.exit(1);
      });
    `], { encoding: 'utf8', timeout: 40000 });
    assert.equal(filho.status, 0, filho.stderr || filho.stdout);
    const linha = String(filho.stdout || '').trim().split('\n').pop();
    const lido = JSON.parse(linha);
    assert.equal(lido.status, 'aprovado');
    assert.equal(lido.simulado, true);
    assert.equal(lido.nsu, null);
  });

  it('repete a chave, isola empresa e operador e não aceita atalho de aprovação', async () => {
    const primeira = await tefManager.autorizar(pedido({ idempotency_key: 'chave-unica' }));
    const repetida = await tefManager.autorizar(pedido({
      idempotency_key: 'chave-unica',
      resultado_simulado: 'recusado',
      aprovado: true,
      nsu: 'NSU-FALSO',
      autorizacao: 'AUT-FALSA'
    }));
    assert.equal(repetida.codigo, 'TRANSACAO_DUPLICADA');
    assert.equal(repetida.transacao_id, primeira.transacao_id);
    assert.equal(repetida.simulado, true);
    assert.equal(repetida.nsu, null);
    const contagem = await get(`SELECT COUNT(*) AS total FROM tef_transacoes WHERE idempotency_key = 'chave-unica'`);
    assert.equal(contagem.total, 1);
    const outraEmpresa = await tefManager.autorizar(pedido({ idempotency_key: 'chave-unica', empresa_id: 9 }));
    assert.equal(outraEmpresa.codigo, 'TEF_EMPRESA_DIVERGENTE');
    const outroOperador = await tefManager.autorizar(pedido({ idempotency_key: 'chave-unica', operador_id: 3 }));
    assert.equal(outroOperador.codigo, 'TEF_OPERADOR_DIVERGENTE');
    assert.equal(outroOperador.transacao_id, undefined);
    const forcada = await tefManager.autorizar(pedido({
      idempotency_key: 'sem-atalho',
      resultado_simulado: 'recusado',
      aprovado: true,
      nsu: 'NSU-FALSO',
      autorizacao: 'AUT-FALSA'
    }));
    assert.equal(forcada.status, 'negado');
    const gravada = await get(`SELECT nsu, autorizacao, status FROM tef_transacoes WHERE id = ?`, [forcada.transacao_id]);
    assert.equal(gravada.nsu, null);
    assert.equal(gravada.autorizacao, null);
    assert.equal(gravada.status, 'negado');
  });

  it('cancela a pendente e recusa cancelar a que já entrou em venda', async () => {
    const aberta = await tefManager.autorizar(pedido({
      resultado_simulado: 'pendente',
      idempotency_key: 'cancelar-aberta'
    }));
    const cancelada = await tefManager.cancelar(aberta.transacao_id);
    assert.equal(cancelada.status, 'cancelado');
    const row = await get(`SELECT status, venda_id FROM tef_transacoes WHERE id = ?`, [aberta.transacao_id]);
    assert.equal(row.status, 'cancelado');
    assert.equal(row.venda_id, null);
    const aprovada = await tefManager.autorizar(pedido({ idempotency_key: 'ja-vinculada' }));
    await run(`UPDATE tef_transacoes SET venda_id = 70 WHERE id = ?`, [aprovada.transacao_id]);
    const reuso = await tefManager.autorizar(pedido({ idempotency_key: 'ja-vinculada', aprovado: true }));
    assert.equal(reuso.codigo, 'TEF_JA_VINCULADO');
    const cancelamento = await tefManager.cancelar(aprovada.transacao_id);
    assert.equal(cancelamento.codigo, 'TRANSACAO_JA_VINCULADA');
    assert.equal(cancelamento.sucesso, false);
    const preservada = await get(`SELECT status, venda_id FROM tef_transacoes WHERE id = ?`, [aprovada.transacao_id]);
    assert.equal(preservada.status, 'aprovado');
    assert.equal(preservada.venda_id, 70);
  });

  it('a consulta pública não devolve NSU', async () => {
    await tefManager.autorizar(pedido({ idempotency_key: 'publica-pix' }));
    const lida = await tefManager.acompanharPorCorrelacao('publica-pix', 4, 8);
    const publica = tefContrato.respostaAcompanhamentoPublica(lida);
    assert.equal(publica.aprovado, true);
    assert.equal(JSON.stringify(publica).includes('nsu'), false);
    assert.equal(JSON.stringify(publica).includes('autorizacao'), false);
  });
});

describe('pagamento sequencial e fechamento', () => {
  it('o formato aprovado é reconhecido e a simulação não quita a venda', async () => {
    const sequencial = carregarSequencial();
    const aprovado = await tefManager.autorizar(pedido({ idempotency_key: 'formato-seq' }));
    assert.equal(sequencial.classificarRetornoAutorizador({
      aprovado: aprovado.aprovado,
      status: aprovado.status,
      transacao_id: aprovado.transacao_id
    }), 'aprovado');
    assert.equal(contrato.podeContabilizarComoRecebimentoReal(aprovado), false);
    const prova = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([{
      tef_transacao_id: aprovado.transacao_id,
      forma_pagamento: 'pix',
      valor: 20,
      idempotency_key: 'formato-seq'
    }], 4, 8);
    assert.equal(prova.sucesso, false);
    assert.equal(prova.codigo, 'SIMULACAO_NAO_E_RECEBIMENTO');
    const deNovo = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([{
      tef_transacao_id: aprovado.transacao_id,
      forma_pagamento: 'pix',
      valor: 20,
      idempotency_key: 'formato-seq'
    }], 4, 8);
    assert.equal(deNovo.sucesso, false);
    const vendas = await get(`SELECT COUNT(*) AS total FROM vendas`);
    assert.equal(vendas.total, 0);
    const solta = await get(`SELECT venda_id FROM tef_transacoes WHERE id = ?`, [aprovado.transacao_id]);
    assert.equal(solta.venda_id, null);

    const recusa = await tefManager.autorizar(pedido({ resultado_simulado: 'recusado', idempotency_key: 'seq-recusa' }));
    const pendente = await tefManager.autorizar(pedido({ resultado_simulado: 'pendente', idempotency_key: 'seq-pendente' }));
    const timeout = await tefManager.autorizar(pedido({ resultado_simulado: 'timeout', idempotency_key: 'seq-timeout' }));
    const falha = await tefManager.autorizar(pedido({ resultado_simulado: 'falha', idempotency_key: 'seq-falha' }));
    const negada = await sequencial.adicionar({
      forma: 'pix', valor: 20, totalVenda: 80,
      autorizarTef: async () => ({ aprovado: false, status: recusa.status })
    });
    const emEspera = await sequencial.adicionar({
      forma: 'cartao_debito', valor: 15, totalVenda: 80,
      autorizarTef: async () => ({ aprovado: false, status: pendente.status, transacao_id: pendente.transacao_id })
    });
    const estourou = await sequencial.adicionar({
      forma: 'cartao_credito', valor: 15, totalVenda: 80,
      autorizarTef: async () => ({ aprovado: false, status: timeout.status, codigo: timeout.codigo, tipo_erro: timeout.tipo_erro })
    });
    const caiu = await sequencial.adicionar({
      forma: 'pix', valor: 10, totalVenda: 80,
      autorizarTef: async () => { throw new Error(falha.mensagem); }
    });
    assert.equal(negada.ok, false);
    assert.equal(emEspera.codigo, 'PENDENTE');
    assert.equal(estourou.codigo, 'TIMEOUT');
    assert.equal(caiu.codigo, 'TEF_FALHA');
    assert.equal(sequencial.soma(), 0);
    for (const id of [recusa.transacao_id, pendente.transacao_id, timeout.transacao_id, falha.transacao_id]) {
      const fechamento = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([{
        tef_transacao_id: id,
        forma_pagamento: 'pix',
        valor: 20
      }], 4, 8);
      assert.equal(fechamento.sucesso, false);
    }
    const inexistente = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([{
      tef_transacao_id: 999999,
      forma_pagamento: 'pix',
      valor: 20
    }], 4, 8);
    assert.equal(inexistente.sucesso, false);
    await run(
      `INSERT INTO tef_transacoes (empresa_id, operador_id, tipo, valor, status, provedor, venda_id, idempotency_key)
       VALUES (4, 8, 'pix_tef', 20, 'aprovado', 'sitef', 80, 'sitef-ja-usada')`
    );
    const vinculada = await get(`SELECT id FROM tef_transacoes WHERE idempotency_key = 'sitef-ja-usada'`);
    const outraVenda = await OrquestradorPagamento.comprovarTransacoesTefAprovadas([{
      tef_transacao_id: vinculada.id,
      forma_pagamento: 'pix',
      valor: 20
    }], 4, 8);
    assert.equal(outraVenda.sucesso, false);
    assert.match(outraVenda.erro, /já vinculada/);
  });
});
