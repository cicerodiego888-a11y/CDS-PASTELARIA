/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 08
 * Auditoria de isolamento: simulação não entra no fluxo oficial.
 *
 * Isolamento: asserts estáticos + execução em memória com Module._load guard.
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-08.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '../..');

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

const {
  simularIntegracaoRecomposicaoFiscal
} = require('../../backend/services/vendas/RecomposicaoFiscalIntegracaoSimulacaoService');

/** Oficiais que NÃO devem referenciar a simulação (exceto hook diagnóstico em VendaPagamento). */
const OFICIAIS_SEM_SIMULACAO = [
  'backend/rotas/vendas.js',
  'backend/services/vendas/VendaApplicationService.js',
  'backend/services/vendas/VendaFiscalService.js',
  'backend/services/OrquestradorPagamento.js',
  'frontend/pdv/js/pdv.js'
];

const SIMULACAO_MARKERS = [
  'RecomposicaoFiscalIntegracaoSimulacaoService',
  'simularIntegracaoRecomposicaoFiscal',
  'RecomposicaoFiscalContratoService',
  'RecomposicaoFiscalToleranciaDinheiroSimulacaoService',
  'RecomposicaoFiscalComposicaoMotorSimulacaoService',
  'RECOMPOSICAO_HABILITADA_EM_PRODUCAO'
];

/** Em VendaPagamentoService só o hook diagnóstico da Sprint 10 é permitido. */
const MARKERS_PROIBIDOS_EM_VENDA_PAGAMENTO = [
  'simularIntegracaoRecomposicaoFiscal',
  'RECOMPOSICAO_HABILITADA_EM_PRODUCAO = true',
  'emitirFiscalSeSolicitado'
];

function modeloPrecoFixo(produtoId, precoCentavos, quantidadeMaxima = 10) {
  return {
    produtoId,
    nome: `Produto ${produtoId}`,
    categoriaFiscal: 'REFRIGERANTE',
    volumeMlPorUnidade: 1,
    quantidadeMaxima,
    cotador: {
      precoUnitarioMinimoInterno: precoCentavos / 100,
      cotar(quantidade) {
        return {
          subtotalCentavos: precoCentavos * quantidade,
          precoUnitarioInterno: precoCentavos / 100,
          regrasAplicadas: [],
          fingerprint: `fix-${produtoId}-${quantidade}`
        };
      }
    }
  };
}

function baseEntrada(overrides = {}) {
  return {
    total_comercial: 50,
    pagamentos: [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ],
    itens: [{ produto_id: 1, quantidade: 5, subtotal: 50 }],
    modelos: [modeloPrecoFixo(1, 1000, 5)],
    capacidade_por_categoria: { REFRIGERANTE: 100 },
    valor_fiscal_candidato: 40,
    ...overrides
  };
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-08', { concurrency: false }, () => {
  it('arquivos oficiais (exceto hook diagnóstico) não referenciam a simulação', () => {
    for (const rel of OFICIAIS_SEM_SIMULACAO) {
      const full = path.join(ROOT, rel);
      assert.ok(fs.existsSync(full), `arquivo ausente: ${rel}`);
      const src = fs.readFileSync(full, 'utf8');
      for (const marker of SIMULACAO_MARKERS) {
        assert.equal(
          src.includes(marker),
          false,
          `${rel} referencia indevidamente ${marker}`
        );
      }
    }

    const vendaPagamento = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.ok(
      vendaPagamento.includes('executarDiagnosticoRecomposicaoNoFechamento'),
      'hook diagnóstico Sprint 10 deve existir em criarVenda'
    );
    assert.ok(
      vendaPagamento.includes('[cds-recomposicao-diagnostico]'),
      'log diagnóstico esperado'
    );
    for (const marker of MARKERS_PROIBIDOS_EM_VENDA_PAGAMENTO) {
      if (marker === 'emitirFiscalSeSolicitado') {
        // VendaPagamento já usava emitirFiscal via VendaFiscalService antes da Sprint 10;
        // garantir apenas que o bloco diagnóstico não chama emissão.
        const iDiagBlk = vendaPagamento.indexOf('diagnóstico isolado de recomposição');
        const trechoDiag = vendaPagamento.slice(
          iDiagBlk,
          vendaPagamento.indexOf('const resultadoMotor = distribuirItensVendaComValorFiscalEfetivo', iDiagBlk)
        );
        assert.equal(trechoDiag.includes('emitirFiscal'), false);
        assert.equal(trechoDiag.includes('TefManager'), false);
        continue;
      }
      assert.equal(
        vendaPagamento.includes(marker),
        false,
        `VendaPagamentoService não deve conter ${marker}`
      );
    }
  });

  it('flag de produção permanece desabilitada (constante do contrato)', () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });

  it('tentativa de ativação operacional via parâmetros do cliente é bloqueada', async () => {
    await assert.rejects(
      () => simularIntegracaoRecomposicaoFiscal(baseEntrada({ habilitar_em_producao: true })),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );
    await assert.rejects(
      () => simularIntegracaoRecomposicaoFiscal(baseEntrada({ autorizacao_producao: true })),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );
    await assert.rejects(
      () => simularIntegracaoRecomposicaoFiscal(baseEntrada({ execucao_operacional: true })),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );
  });

  it('ausência de composição / erro de contrato não ativam persistência nem NFC-e', async () => {
    const semModelo = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
      modelos: [],
      valor_fiscal_candidato: 40
    }));
    assert.equal(semModelo.status_simulacao, 'SEM_COMPOSICAO');
    assert.equal(semModelo.persistencia_executada, false);
    assert.equal(semModelo.emissao_fiscal_autorizada, false);
    assert.equal(semModelo.habilitado_em_producao, false);
    assert.equal(semModelo.total_comercial, 50);
    assert.equal(semModelo.valor_fiscal_oficialmente_autorizado, null);

    await assert.rejects(
      () => simularIntegracaoRecomposicaoFiscal(baseEntrada({
        pagamentos: [
          { forma_pagamento: 'debito', valor: 10 },
          { forma_pagamento: 'credito', valor: 10 }
        ]
      })),
      (err) => err && err.code === 'SOMA_PAGAMENTOS_DIVERGENTE'
    );
  });

  it('execução diagnóstica preserva total comercial e não carrega módulos operacionais', async () => {
    const proibidos = [
      'TefManager',
      'tefContrato',
      'OrquestradorPagamento',
      'VendaPagamentoService',
      'VendaApplicationService',
      'VendaFiscalService',
      'fiscal/emissor',
      'nfeCentralService',
      path.normalize('backend/database.js'),
      path.normalize('backend\\database.js')
    ];
    const carregados = [];
    const originalLoad = Module._load;
    Module._load = function patched(request, parent, isMain) {
      const req = String(request);
      const parentPath = parent && parent.filename ? String(parent.filename) : '';
      // Só audita cargas a partir dos serviços de recomposição nesta execução
      if (/RecomposicaoFiscal/i.test(parentPath) || /RecomposicaoFiscal/i.test(req)) {
        for (const p of proibidos) {
          if (req.includes(p) || path.normalize(req).includes(p)) {
            carregados.push({ request: req, parent: parentPath });
          }
        }
      }
      return originalLoad.apply(this, arguments);
    };

    try {
      const r = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
        valor_fiscal_candidato: 41.9
      }));
      assert.equal(r.total_comercial, 50);
      assert.equal(r.total_pagamentos, 50);
      assert.equal(r.persistencia_executada, false);
      assert.equal(r.emissao_fiscal_autorizada, false);
      assert.equal(r.aplicou_desconto_automatico, false);
      assert.equal(r.valor_fiscal_oficial_determinado_por_esta_simulacao, false);
      assert.deepEqual(carregados, []);
    } finally {
      Module._load = originalLoad;
    }
  });
});
