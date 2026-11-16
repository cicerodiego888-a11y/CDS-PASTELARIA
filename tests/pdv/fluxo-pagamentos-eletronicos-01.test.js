'use strict';

/**
 * CDS-PDV-CORRECAO-FLUXO-PAGAMENTOS-ELETRONICOS-01
 * Banco temporário + mocks. Sem PIX/TEF/SEFAZ reais.
 *
 * node --test --test-concurrency=1 tests/pdv/fluxo-pagamentos-eletronicos-01.test.js
 */

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
isolarBancoTeste('cds-pdv-eletronicos-01-');

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const Decisao = require('../../frontend/pdv/js/decisaoConfirmacaoPagamento');
// Injeta no global para o sequencial (mesmo padrão do browser).
globalThis.DecisaoConfirmacaoPagamento = Decisao;
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');
require('../../frontend/shared/js/tefFluxoPagamento');
const TefFluxo = globalThis.TefFluxoPagamento;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-eletronicos-01-'));
const DATABASE_OFICIAL = path.win32.resolve(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'MercantilFiscal',
  'dados',
  'mercadao.db'
);

function criar(total) {
  PagamentoSequencial.reset();
  return InteracaoPagamentoMisto.criar({ totalVenda: total, sequencial: PagamentoSequencial });
}

describe('CDS-PDV-CORRECAO-FLUXO-PAGAMENTOS-ELETRONICOS-01', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
  });

  describe('Cenário 1 — TEF desativado', () => {
    it('dinheiro registra e confirma sem TEF', async () => {
      let tef = 0;
      const tela = criar(50);
      tela.escolherForma('dinheiro');
      const ok = await tela.confirmarValor(50, {
        tefHabilitado: false,
        pixIntegracaoHabilitada: true,
        formaUsaTef: () => false,
        autorizarTef: async () => { tef += 1; }
      });
      assert.equal(ok.ok, true);
      assert.equal(tef, 0);
      assert.equal(PagamentoSequencial.somaConfirmada(), 50);
      assert.equal(PagamentoSequencial.exportar()[0].confirmacao_modalidade, 'manual');
    });

    it('PIX registra informado sem TEF e não marca recebimento confirmado', async () => {
      let tef = 0;
      const tela = criar(56.98);
      tela.escolherForma('pix');
      const ok = await tela.confirmarValor(56.98, {
        tefHabilitado: false,
        pixIntegracaoHabilitada: true,
        formaUsaTef: () => false,
        autorizarTef: async () => { tef += 1; return { aprovado: true, transacao_id: 1 }; }
      });
      assert.equal(ok.ok, true);
      assert.equal(tef, 0);
      assert.equal(PagamentoSequencial.soma(), 56.98);
      assert.equal(PagamentoSequencial.somaConfirmada(), 0);
      assert.equal(PagamentoSequencial.temEletronicaAguardandoConfirmacao(), true);
      const exp = PagamentoSequencial.exportar()[0];
      assert.equal(exp.tipo_recebimento, 'fiscal');
      assert.equal(exp.confirmacao_manual, 0);
      assert.equal(exp.recebimento_confirmado, false);
      assert.equal(exp.confirmacao_modalidade, null);
    });

    it('débito com TEF off registra informado sem chamar TEF', async () => {
      let tef = 0;
      const tela = criar(50);
      tela.escolherForma('cartao_debito');
      const r = await tela.confirmarValor(50, {
        tefHabilitado: false,
        pixIntegracaoHabilitada: true,
        formaUsaTef: () => false,
        autorizarTef: async () => { tef += 1; }
      });
      assert.equal(r.ok, true);
      assert.equal(tef, 0);
      assert.equal(PagamentoSequencial.soma(), 50);
      assert.equal(PagamentoSequencial.somaConfirmada(), 0);
      assert.equal(
        InteracaoPagamentoMisto.modoConfirmacaoDireta('cartao_debito', { tefHabilitado: false }),
        'informado'
      );
    });

    it('crédito com TEF off registra informado sem chamar TEF', async () => {
      const tela = criar(50);
      tela.escolherForma('cartao_credito');
      const r = await tela.confirmarValor(30, {
        tefHabilitado: false,
        pixIntegracaoHabilitada: true,
        formaUsaTef: () => false
      });
      assert.equal(r.ok, true);
      assert.equal(PagamentoSequencial.soma(), 30);
      assert.equal(PagamentoSequencial.somaConfirmada(), 0);
    });

    it('voucher informa sem TEF e não confirma sozinho', async () => {
      const politica = Decisao.resolverRegistroParcela({
        forma: 'voucher',
        tefHabilitado: false
      });
      assert.equal(politica.ok, true);
      assert.equal(politica.usaTef, false);
      assert.equal(politica.confirmaNoRegistro, false);
      assert.equal(politica.requerConfirmacaoPosterior, true);

      const tela = criar(20);
      tela.escolherForma('voucher');
      let tef = 0;
      const ok = await tela.confirmarValor(20, {
        tefHabilitado: false,
        pixIntegracaoHabilitada: true,
        formaUsaTef: () => false,
        autorizarTef: async () => { tef += 1; }
      });
      assert.equal(ok.ok, true);
      assert.equal(tef, 0);
      assert.equal(PagamentoSequencial.somaConfirmada(), 0);
    });
  });

  describe('Cenário 2 — TEF habilitado', () => {
    it('aprovação simulada registra TEF', async () => {
      const tela = criar(40);
      tela.escolherForma('cartao_debito');
      const ok = await tela.confirmarValor(40, {
        tefHabilitado: true,
        formaUsaTef: () => true,
        autorizarTef: async () => ({
          aprovado: true, status: 'aprovado', transacao_id: 77, nsu: 'N1', autorizacao: 'A1'
        })
      });
      assert.equal(ok.ok, true);
      assert.equal(PagamentoSequencial.somaConfirmada(), 40);
      assert.equal(PagamentoSequencial.exportar()[0].tef_transacao_id, 77);
      assert.equal(PagamentoSequencial.exportar()[0].confirmacao_modalidade, 'tef');
    });

    it('provedor/TEF desabilitado no autorizador não registra', async () => {
      const tela = criar(40);
      tela.escolherForma('pix');
      const r = await tela.confirmarValor(40, {
        tefHabilitado: true,
        formaUsaTef: () => true,
        autorizarTef: async () => ({
          aprovado: false, codigo: 'TEF_DESABILITADO', status: 'negado',
          mensagem: 'TEF está desabilitado na configuração.'
        })
      });
      assert.equal(r.codigo, 'TEF_DESABILITADO');
      assert.equal(PagamentoSequencial.snapshot().length, 0);
    });

    it('recusa simulada não gera recebimento', async () => {
      const tela = criar(40);
      tela.escolherForma('cartao_credito');
      const r = await tela.confirmarValor(40, {
        tefHabilitado: true,
        formaUsaTef: () => true,
        autorizarTef: async () => ({ aprovado: false, status: 'negado' })
      });
      assert.equal(r.codigo, 'TEF_REJEITADO');
      assert.equal(PagamentoSequencial.somaConfirmada(), 0);
    });

    it('comunicação interrompida não aprova', async () => {
      const tela = criar(40);
      tela.escolherForma('cartao_debito');
      const r = await tela.confirmarValor(20, {
        tefHabilitado: true,
        formaUsaTef: () => true,
        autorizarTef: async () => { throw new Error('socket closed'); }
      });
      assert.equal(r.codigo, 'TEF_FALHA');
      assert.equal(PagamentoSequencial.soma(), 0);
    });

    it('pendente não contabiliza recebimento', async () => {
      const tela = criar(40);
      tela.escolherForma('pix');
      const r = await tela.confirmarValor(40, {
        tefHabilitado: true,
        formaUsaTef: () => true,
        autorizarTef: async () => ({ status: 'pendente', aprovado: false })
      });
      assert.equal(r.codigo, 'PENDENTE');
      assert.equal(PagamentoSequencial.somaConfirmada(), 0);
      assert.equal(PagamentoSequencial.soma(), 0);
    });
  });

  describe('Cenário 3 — Integridade financeira', () => {
    it('acima do saldo e saldo zerado', async () => {
      const tela = criar(30);
      tela.escolherForma('dinheiro');
      await tela.confirmarValor(30, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
      const escolha = tela.escolherForma('pix');
      assert.equal(escolha.ok, false);
      assert.equal(escolha.codigo, 'VENDA_QUITADA');
    });

    it('recusa não altera saldo alocado anterior', async () => {
      const tela = criar(50);
      tela.escolherForma('dinheiro');
      await tela.confirmarValor(20, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
      tela.escolherForma('cartao_debito');
      await tela.confirmarValor(20, {
        tefHabilitado: true,
        formaUsaTef: () => true,
        autorizarTef: async () => ({ aprovado: false, status: 'negado' })
      });
      assert.equal(PagamentoSequencial.soma(), 20);
      assert.equal(PagamentoSequencial.somaConfirmada(), 20);
    });

    it('PIX sem integração e sem TEF registra informado para confirmação operacional', async () => {
      const tela = criar(20);
      tela.escolherForma('pix');
      const r = await tela.confirmarValor(20, {
        tefHabilitado: false,
        pixIntegracaoHabilitada: false,
        formaUsaTef: () => false
      });
      assert.equal(r.ok, true);
      assert.equal(PagamentoSequencial.soma(), 20);
      assert.equal(PagamentoSequencial.somaConfirmada(), 0);
    });

    it('fechamento sequencial TEF off exige confirmação operacional para PIX informado', () => {
      const lista = [{
        forma_pagamento: 'pix',
        valor: 56.98,
        status_autorizacao: 'informada'
      }];
      const estado = TefFluxo.listaSequencialJaConfirmada(lista, { tefHabilitado: false });
      assert.equal(estado.dispensaModalExtra, false);
      assert.equal(estado.requerConfirmacaoManual, true);

      const comCarimbo = TefFluxo.montarParcelasListaSequencial(lista, {
        carimbarConfirmacaoManual: true
      })[0];
      assert.equal(comCarimbo.confirmacao_manual, 1);
      assert.equal(comCarimbo.recebimento_confirmado, true);
      assert.equal(comCarimbo.confirmacao_modalidade, 'manual');
    });
  });

  describe('Cenário 4 — Integridade fiscal', () => {
    it('PIX confirmado via TEF é fiscal confirmado', async () => {
      const tela = criar(10);
      tela.escolherForma('pix');
      await tela.confirmarValor(10, {
        tefHabilitado: true,
        formaUsaTef: () => true,
        autorizarTef: async () => ({
          aprovado: true, status: 'aprovado', transacao_id: 9, nsu: 'N', autorizacao: 'A'
        })
      });
      const exp = PagamentoSequencial.exportar()[0];
      assert.equal(exp.tipo_recebimento, 'fiscal');
      assert.equal(exp.recebimento_confirmado, true);
      assert.equal(exp.confirmacao_modalidade, 'tef');
    });

    it('dinheiro preserva não fiscal', async () => {
      const tela = criar(10);
      tela.escolherForma('dinheiro');
      await tela.confirmarValor(10, { tefHabilitado: false, pixIntegracaoHabilitada: true, formaUsaTef: () => false });
      assert.equal(PagamentoSequencial.exportar()[0].tipo_recebimento, 'nao_fiscal');
    });

    it('persistência temporária não inventa TEF para PIX informado', async () => {
      assert.notStrictEqual(
        path.win32.resolve(TMP).toLowerCase(),
        path.win32.dirname(DATABASE_OFICIAL).toLowerCase()
      );
      const filename = path.join(TMP, 'fiscal.db');
      const db = await new Promise((resolve, reject) => {
        const c = new sqlite3.Database(filename, (e) => (e ? reject(e) : resolve(c)));
      });
      await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE venda_pagamentos (
          id INTEGER PRIMARY KEY, forma TEXT, valor REAL,
          confirmacao_manual INTEGER, confirmacao_modalidade TEXT,
          tipo_recebimento TEXT, tef_transacao_id INTEGER, recebimento_confirmado INTEGER
        )`, (e) => (e ? reject(e) : resolve()));
      });
      const tela = criar(15);
      tela.escolherForma('pix');
      await tela.confirmarValor(15, {
        tefHabilitado: false,
        pixIntegracaoHabilitada: true,
        formaUsaTef: () => false
      });
      const exp = PagamentoSequencial.exportar()[0];
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO venda_pagamentos
            (forma, valor, confirmacao_manual, confirmacao_modalidade, tipo_recebimento, tef_transacao_id, recebimento_confirmado)
           VALUES (?,?,?,?,?,?,?)`,
          [
            exp.forma_pagamento, exp.valor, exp.confirmacao_manual,
            exp.confirmacao_modalidade, exp.tipo_recebimento, exp.tef_transacao_id,
            exp.recebimento_confirmado ? 1 : 0
          ],
          (e) => (e ? reject(e) : resolve())
        );
      });
      const row = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM venda_pagamentos WHERE id = 1', (e, r) => (e ? reject(e) : resolve(r)));
      });
      assert.equal(row.forma, 'pix');
      assert.equal(row.tipo_recebimento, 'fiscal');
      assert.equal(Number(row.confirmacao_manual), 0);
      assert.equal(row.tef_transacao_id, null);
      assert.equal(Number(row.recebimento_confirmado), 0);
      await new Promise((resolve, reject) => db.close((e) => (e ? reject(e) : resolve())));
    });
  });

  describe('Cenário 5 — Regressão fontes', () => {
    it('PDV carrega módulo de decisão e consulta TEF no registro', () => {
      const html = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/index.html'), 'utf8');
      assert.match(html, /decisaoConfirmacaoPagamento\.js/);
      const pdv = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');
      assert.match(pdv, /pixIntegracaoHabilitada/);
      assert.match(pdv, /requerConfirmacaoManual/);
      assert.match(pdv, /carimbarConfirmacaoManual/);
      assert.match(pdv, /confirmarParcelaPix/);
      assert.match(pdv, /montarOpcoesConfirmacaoFiscalManual/);
      assert.match(pdv, /Recebido via/);
      assert.match(pdv, /Complemento em dinheiro \(NFC-e\)/);
      assert.doesNotMatch(pdv, /atualizarDisponibilidadeCartoesDireto/);
      assert.doesNotMatch(pdv, /prop\('disabled',\s*!tefOn\)/);
    });

    it('política central cobre modalidades obrigatórias', () => {
      const formas = ['dinheiro', 'pix', 'cartao_debito', 'cartao_credito', 'voucher'];
      for (const forma of formas) {
        const off = Decisao.resolverRegistroParcela({
          forma,
          tefHabilitado: false,
          pixIntegracaoHabilitada: forma === 'pix'
        });
        const on = Decisao.resolverRegistroParcela({ forma, tefHabilitado: true });
        assert.ok(off.modo || off.codigo, forma);
        assert.ok(on.modo || on.codigo, forma);
        if (forma === 'cartao_debito' || forma === 'cartao_credito') {
          assert.equal(off.ok, true);
          assert.equal(off.usaTef, false);
          assert.equal(off.modo, 'informado');
          assert.equal(on.usaTef, true);
        }
        if (forma === 'pix') {
          assert.equal(off.ok, true);
          assert.equal(off.usaTef, false);
          assert.equal(off.modo, 'pix_proprio');
          assert.equal(off.confirmaNoRegistro, false);
          assert.equal(on.usaTef, true);
          const semIntegracao = Decisao.resolverRegistroParcela({
            forma: 'pix',
            tefHabilitado: false,
            pixIntegracaoHabilitada: false
          });
          assert.equal(semIntegracao.ok, true);
          assert.equal(semIntegracao.modo, 'informado');
        }
      }
    });
  });
});
