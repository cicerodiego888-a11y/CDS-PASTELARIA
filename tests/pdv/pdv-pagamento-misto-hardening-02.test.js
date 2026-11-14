'use strict';

/**
 * CDS-PDV-PAGAMENTO-MISTO-HARDENING-02
 * Vetor secundário (remap dinheiro) + preservação das suítes anteriores.
 * Banco: exclusivamente temporário.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pdv-misto-hard-02-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

require('../central-entradas/helpers/isolarBancoTeste').isolarBancoTeste('cds-pdv-misto-hard-02-');

const Orquestrador = require('../../backend/services/OrquestradorPagamento');
const midp = require('../../backend/services/midp/MotorInteligenteDistribuicaoPagamentos');
const {
  aplicarClassificacaoERegraStatusPagamentoVenda,
  aplicarClassificacaoTipoRecebimento,
  aplicarRegraStatusPagamentoVenda,
  calcularSaldoNaoFiscal,
  resolverStatusPagamentoVenda
} = require('../../backend/services/vendas/VendaPagamentoService');
const { resolverStatusPagamentoRespostaHttp } = require('../../backend/services/vendas/VendaFiscalService');

const PDV_JS = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');
const PAGAMENTO_SRC = fs.readFileSync(
  path.join(__dirname, '../../backend/services/vendas/VendaPagamentoService.js'),
  'utf8'
);

async function orquestrar(pagamentos, F, NF) {
  return Orquestrador.processarFluxoPagamentoVenda({
    totalFiscal: F,
    totalNaoFiscal: NF,
    formaPagamento: 'misto',
    pagamentos,
    tefHabilitado: false,
    modoConfirmacaoFiscal: 'MANUAL',
    confirmacaoFiscalManual: true,
    midpAtivo: false
  });
}

function fecharAposOrquestrador(resultado, F, NF) {
  assert.equal(resultado.sucesso, true, resultado.erro);
  return aplicarClassificacaoERegraStatusPagamentoVenda({
    valorFiscal: F,
    valorNaoFiscal: NF,
    statusPagamento: resultado.statusPagamento,
    recebimentos: resultado.recebimentos
  });
}

describe('CDS-PDV-PAGAMENTO-MISTO-HARDENING-02', { concurrency: false }, () => {
  it('01) dinheiro + PIX — dinheiro primeiro → quitada integral', async () => {
    const F = 70;
    const NF = 30;
    const r = await orquestrar([
      { forma_pagamento: 'dinheiro', valor: 30 },
      { forma_pagamento: 'pix', valor: 70 }
    ], F, NF);
    const final = fecharAposOrquestrador(r, F, NF);
    assert.equal(final.statusPagamento, 'quitada');
    const saldo = calcularSaldoNaoFiscal(
      { valor_nao_fiscal: NF },
      final.recebimentos.filter((x) => x.tipo_recebimento === 'nao_fiscal')
    );
    assert.equal(saldo.saldoPendente, 0);
    assert.equal(resolverStatusPagamentoRespostaHttp({ statusPagamento: final.statusPagamento }), 'quitada');
  });

  it('02) PIX + dinheiro — eletrônico primeiro → equivalente', async () => {
    const F = 70;
    const NF = 30;
    const a = fecharAposOrquestrador(await orquestrar([
      { forma_pagamento: 'dinheiro', valor: 30 },
      { forma_pagamento: 'pix', valor: 70 }
    ], F, NF), F, NF);
    const b = fecharAposOrquestrador(await orquestrar([
      { forma_pagamento: 'pix', valor: 70 },
      { forma_pagamento: 'dinheiro', valor: 30 }
    ], F, NF), F, NF);
    assert.equal(a.statusPagamento, b.statusPagamento);
    assert.equal(a.statusPagamento, 'quitada');
    const saldoA = calcularSaldoNaoFiscal(
      { valor_nao_fiscal: NF },
      a.recebimentos.filter((x) => x.tipo_recebimento === 'nao_fiscal')
    );
    const saldoB = calcularSaldoNaoFiscal(
      { valor_nao_fiscal: NF },
      b.recebimentos.filter((x) => x.tipo_recebimento === 'nao_fiscal')
    );
    assert.equal(saldoA.saldoPendente, saldoB.saldoPendente);
  });

  it('03) dinheiro no bucket fiscal MIDP → remapeado NF → status coerente', async () => {
    const F = 70;
    const NF = 30;
    // PIX insuficiente para cobrir F: MIDP coloca dinheiro no fiscal.
    const aloc = midp.distribuirPagamentos([
      { forma_pagamento: 'pix', valor: 40 },
      { forma_pagamento: 'dinheiro', valor: 30 }
    ], F, NF);
    assert.ok(aloc.recebimentosFiscal.some((r) => r.forma_pagamento === 'dinheiro'));
    assert.equal(aloc.saldoNaoFiscal, 30);

    const recebOrq = Orquestrador.montarRecebimentosParaGravar({
      distribuicao: aloc,
      statusPagamento: 'aguardando_nao_fiscal',
      totalFiscal: F,
      totalNaoFiscal: NF,
      resultadoFiscal: { sucesso: true }
    });
    // Sequência antiga (bug): status antes da classificação
    const antigo = aplicarRegraStatusPagamentoVenda({
      valorFiscal: F,
      valorNaoFiscal: NF,
      statusPagamento: 'aguardando_nao_fiscal',
      recebimentos: recebOrq
    });
    const antigoClassificado = aplicarClassificacaoTipoRecebimento(antigo.recebimentos);
    const saldoAntigo = calcularSaldoNaoFiscal(
      { valor_nao_fiscal: NF, status_pagamento: antigo.statusPagamento },
      antigoClassificado.filter((r) => r.tipo_recebimento === 'nao_fiscal')
    );
    assert.equal(antigo.statusPagamento, 'aguardando_nao_fiscal');
    assert.equal(saldoAntigo.saldoPendente, 0); // divergência histórica

    // Sequência corrigida: classificar → status
    const novo = aplicarClassificacaoERegraStatusPagamentoVenda({
      valorFiscal: F,
      valorNaoFiscal: NF,
      statusPagamento: 'aguardando_nao_fiscal',
      recebimentos: recebOrq
    });
    assert.equal(novo.statusPagamento, 'quitada');
    const nf = novo.recebimentos.filter((r) => r.tipo_recebimento === 'nao_fiscal');
    assert.ok(nf.some((r) => r.forma_pagamento === 'dinheiro'));
    const saldoNovo = calcularSaldoNaoFiscal({ valor_nao_fiscal: NF }, nf);
    assert.equal(saldoNovo.saldoPendente, 0);
    assert.equal(novo.statusPagamento, 'quitada'); // sem handoff indevido
  });

  it('04) classificação final respeitada pelo status (dinheiro→NF)', () => {
    assert.match(PAGAMENTO_SRC, /aplicarClassificacaoERegraStatusPagamentoVenda/);
    assert.match(PAGAMENTO_SRC, /classificar tipos finais ANTES da regra de status/);
    const r = aplicarClassificacaoERegraStatusPagamentoVenda({
      valorFiscal: 70,
      valorNaoFiscal: 30,
      statusPagamento: 'aguardando_nao_fiscal',
      recebimentos: [
        { forma_pagamento: 'pix', valor: 40, tipo_recebimento: 'fiscal', status: 'aprovado' },
        {
          forma_pagamento: 'dinheiro',
          valor: 30,
          tipo_recebimento: 'fiscal',
          status: 'aprovado',
          confirmacao_manual: 1,
          status_autorizacao: 'informada'
        }
      ]
    });
    assert.equal(r.statusPagamento, 'quitada');
    assert.ok(r.recebimentos.every((x) => {
      if (x.forma_pagamento === 'dinheiro') return x.tipo_recebimento === 'nao_fiscal';
      if (x.forma_pagamento === 'pix') return x.tipo_recebimento === 'fiscal';
      return true;
    }));
  });

  it('05) integralmente recebida termina quitada', async () => {
    const F = 60;
    const NF = 40;
    const final = fecharAposOrquestrador(await orquestrar([
      { forma_pagamento: 'pix', valor: 60 },
      { forma_pagamento: 'dinheiro', valor: 40 }
    ], F, NF), F, NF);
    assert.equal(final.statusPagamento, 'quitada');
  });

  it('06) NF realmente pendente mantém aguardando_nao_fiscal', async () => {
    const F = 70;
    const NF = 30;
    const r = await orquestrar([{ forma_pagamento: 'pix', valor: 70 }], F, NF);
    const final = fecharAposOrquestrador(r, F, NF);
    assert.equal(final.statusPagamento, 'aguardando_nao_fiscal');
    const saldo = calcularSaldoNaoFiscal(
      { valor_nao_fiscal: NF },
      final.recebimentos.filter((x) => x.tipo_recebimento === 'nao_fiscal')
    );
    assert.ok(saldo.saldoPendente > 0);
  });

  it('07) saldo zero nunca abre segunda etapa (contrato PDV)', () => {
    assert.match(PDV_JS, /SEM_PENDENCIA/);
    assert.match(PDV_JS, /Não há valor não fiscal pendente/);
    assert.equal(
      resolverStatusPagamentoVenda(30, [{ valor: 30 }], 'aguardando_nao_fiscal', { valorFiscal: 70 }),
      'quitada'
    );
  });

  it('08) sem POST NF com valor zero (contrato PDV)', () => {
    assert.doesNotMatch(
      PDV_JS,
      /onConfirm\(\{\s*forma_pagamento:[^}]*valor:\s*0/
    );
    assert.match(PDV_JS, /Valor do pagamento não fiscal deve ser maior que zero/);
  });
});
