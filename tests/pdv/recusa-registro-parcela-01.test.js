'use strict';

/**
 * CDS-PDV-CORRECAO-RECUSA-REGISTRO-PARCELA-01
 * Banco temporário + mocks. Sem PIX real, sem TEF real, sem SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/recusa-registro-parcela-01.test.js
 */

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
isolarBancoTeste('cds-pdv-parcela-01-');

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const DecisaoConfirmacaoPagamento = require('../../frontend/pdv/js/decisaoConfirmacaoPagamento');
globalThis.DecisaoConfirmacaoPagamento = DecisaoConfirmacaoPagamento;
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-parcela-01-'));
const DATABASE_OFICIAL = path.win32.resolve(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'MercantilFiscal',
  'dados',
  'mercadao.db'
);

function criarTela(total) {
  PagamentoSequencial.reset();
  return InteracaoPagamentoMisto.criar({
    totalVenda: total,
    sequencial: PagamentoSequencial
  });
}

async function abrirBancoTemp() {
  const filename = path.join(TMP, `parcela-${Date.now()}.db`);
  assert.notStrictEqual(
    path.win32.resolve(filename).toLowerCase(),
    DATABASE_OFICIAL.toLowerCase()
  );
  const db = await new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(filename, (err) => (err ? reject(err) : resolve(conn)));
  });
  await new Promise((resolve, reject) => {
    db.run(`CREATE TABLE venda_recebimentos (
      id INTEGER PRIMARY KEY,
      venda_id INTEGER,
      forma_pagamento TEXT,
      valor REAL,
      status TEXT,
      confirmacao_manual INTEGER,
      confirmacao_modalidade TEXT,
      tipo_recebimento TEXT
    )`, (err) => (err ? reject(err) : resolve()));
  });
  return { db, filename };
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('CDS-PDV-CORRECAO-RECUSA-REGISTRO-PARCELA-01', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
  });

  it('A — PIX válido com TEF off registra parcela (cenário 56,98)', async () => {
    const total = 56.98;
    const tela = criarTela(total);
    assert.equal(InteracaoPagamentoMisto.modoConfirmacaoDireta('pix', { tefHabilitado: false, pixIntegracaoHabilitada: true }), 'pix_proprio');
    tela.escolherForma('pix');
    let chamadasTef = 0;
    const passo = await tela.confirmarValor(56.98, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false,
      autorizarTef: async () => {
        chamadasTef += 1;
        return { aprovado: false, codigo: 'TEF_DESABILITADO', status: 'negado' };
      }
    });
    assert.equal(passo.ok, true);
    assert.equal(chamadasTef, 0, 'PIX sem TEF não pode chamar autorizador');
    assert.equal(PagamentoSequencial.soma(), 56.98);
    assert.equal(passo.podeFinalizar, true);
    assert.equal(PagamentoSequencial.somaConfirmada(), 0, 'PIX informado não é recebimento confirmado');
    const exportado = PagamentoSequencial.exportar()[0];
    assert.equal(exportado.forma_pagamento, 'pix');
    assert.equal(exportado.confirmacao_manual, 0);
    assert.equal(exportado.confirmacao_modalidade, null);
    assert.equal(exportado.recebimento_confirmado, false);
    assert.equal(exportado.tipo_recebimento, 'fiscal');
    assert.equal(exportado.tef_transacao_id, null);
  });

  it('B — dinheiro registra sem TEF', async () => {
    const tela = criarTela(56.98);
    tela.escolherForma('dinheiro');
    let chamadasTef = 0;
    const passo = await tela.confirmarValor(56.98, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false,
      autorizarTef: async () => { chamadasTef += 1; }
    });
    assert.equal(passo.ok, true);
    assert.equal(chamadasTef, 0);
    assert.equal(PagamentoSequencial.soma(), 56.98);
  });

  it('C — valor acima do saldo é recusado sem alterar recebido', async () => {
    const tela = criarTela(56.98);
    tela.escolherForma('pix');
    await tela.confirmarValor(30, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    const antes = PagamentoSequencial.soma();
    tela.escolherForma('pix');
    const recusa = await tela.confirmarValor(40, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    assert.equal(recusa.ok, false);
    assert.equal(recusa.codigo, 'VALOR_ACIMA_DO_RESTANTE');
    assert.equal(PagamentoSequencial.soma(), antes);
  });

  it('D — saldo zerado não registra nova parcela', async () => {
    const tela = criarTela(56.98);
    tela.escolherForma('pix');
    await tela.confirmarValor(56.98, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    const escolha = tela.escolherForma('pix');
    assert.equal(escolha.ok, false);
    assert.equal(escolha.codigo, 'VENDA_QUITADA');
    assert.equal(PagamentoSequencial.soma(), 56.98);
  });

  it('E — rejeição do autorizador (TEF on) não registra parcela', async () => {
    const tela = criarTela(56.98);
    tela.escolherForma('pix');
    const recusa = await tela.confirmarValor(56.98, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: false, status: 'negado', mensagem: 'Negado pelo simulador' })
    });
    assert.equal(recusa.ok, false);
    assert.equal(recusa.codigo, 'TEF_REJEITADO');
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    assert.equal(PagamentoSequencial.soma(), 0);
  });

  it('F — falha de comunicação do autorizador não altera saldo', async () => {
    const tela = criarTela(56.98);
    tela.escolherForma('cartao_debito');
    const falha = await tela.confirmarValor(20, {
      tefHabilitado: true,
      formaUsaTef: () => true,
      autorizarTef: async () => {
        throw new Error('Falha de persistência simulada no autorizador');
      }
    });
    assert.equal(falha.ok, false);
    assert.equal(falha.codigo, 'TEF_FALHA');
    assert.match(falha.mensagem || '', /persistência simulada/i);
    assert.equal(PagamentoSequencial.soma(), 0);
  });

  it('G — repetição da mesma solicitação com TEF off não duplica se saldo já quitado', async () => {
    const tela = criarTela(56.98);
    tela.escolherForma('pix');
    await tela.confirmarValor(56.98, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    const segunda = tela.escolherForma('pix');
    assert.equal(segunda.ok, false);
    assert.equal(PagamentoSequencial.snapshot().length, 1);
  });

  it('H — parcela recusada não altera saldo recebido', async () => {
    const tela = criarTela(56.98);
    tela.escolherForma('dinheiro');
    await tela.confirmarValor(20, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
    const recebido = PagamentoSequencial.soma();
    tela.escolherForma('pix');
    await tela.confirmarValor(50, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: false, status: 'negado' })
    });
    assert.equal(PagamentoSequencial.soma(), recebido);
  });

  it('I — TEF desabilitado: retorno TEF_DESABILITADO não vira RECUSADO genérico se chamado', async () => {
    const tipo = PagamentoSequencial.classificarRetornoAutorizador({
      aprovado: false,
      codigo: 'TEF_DESABILITADO',
      status: 'negado',
      mensagem: 'TEF está desabilitado na configuração.'
    });
    assert.equal(tipo, 'tef_desabilitado');

    const tela = criarTela(10);
    tela.escolherForma('pix');
    const resultado = await tela.confirmarValor(10, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({
        aprovado: false,
        codigo: 'TEF_DESABILITADO',
        status: 'negado',
        mensagem: 'TEF está desabilitado na configuração.'
      })
    });
    assert.equal(resultado.codigo, 'TEF_DESABILITADO');
    assert.notEqual(resultado.codigo, 'RECUSADO');
    assert.equal(PagamentoSequencial.soma(), 0);
  });

  it('J — classificação fiscal preservada (PIX informado = fiscal, sem carimbo manual)', async () => {
    const tela = criarTela(56.98);
    tela.escolherForma('pix');
    await tela.confirmarValor(56.98, {
      tefHabilitado: false,
      pixIntegracaoHabilitada: true,
      formaUsaTef: () => false
    });
    const linha = PagamentoSequencial.exportar()[0];
    assert.equal(linha.tipo_recebimento, 'fiscal');
    assert.equal(linha.confirmacao_modalidade, null);
    assert.equal(linha.confirmacao_manual, 0);
    assert.equal(linha.recebimento_confirmado, false);

    const { db } = await abrirBancoTemp();
    try {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO venda_recebimentos
            (venda_id, forma_pagamento, valor, status, confirmacao_manual, confirmacao_modalidade, tipo_recebimento)
           VALUES (1, ?, ?, 'informado', ?, ?, ?)`,
          [
            linha.forma_pagamento,
            linha.valor,
            linha.confirmacao_manual,
            linha.confirmacao_modalidade,
            linha.tipo_recebimento
          ],
          function onRun(err) {
            if (err) reject(err);
            else resolve(this);
          }
        );
      });
      const row = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM venda_recebimentos WHERE id = 1', (err, r) => (err ? reject(err) : resolve(r)));
      });
      assert.equal(row.forma_pagamento, 'pix');
      assert.equal(row.tipo_recebimento, 'fiscal');
      assert.equal(row.confirmacao_modalidade, null);
      assert.equal(Number(row.confirmacao_manual), 0);
    } finally {
      await close(db);
    }
  });

  it('fonte: PDV consulta TEF antes de exigir autorizador no registro direto', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../frontend/pdv/js/pdv.js'),
      'utf8'
    );
    assert.match(src, /registrarParcelaDireta/);
    assert.match(src, /obterTefHabilitadoConfig\(\)/);
    assert.match(src, /modoConfirmacaoDireta\(forma,\s*\{/);
    assert.match(src, /tefHabilitado/);
    assert.match(src, /pixIntegracaoHabilitada/);
    assert.match(src, /TEF_DESABILITADO/);
    assert.match(src, /limparValor:\s*false/);
  });
});
