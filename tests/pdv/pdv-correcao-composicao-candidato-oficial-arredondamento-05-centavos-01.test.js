/**
 * CDS-PDV-CORRECAO-COMPOSICAO-CANDIDATO-OFICIAL-ARREDONDAMENTO-05-CENTAVOS-01
 *
 * Diferença necessária → ceil ao múltiplo de R$ 0,05 (cap margem/dinheiro).
 * Atualiza o candidato fiscal oficial. Complemento ≠ desconto de ajuste.
 * Banco temporário. Sem TEF/PIX/SEFAZ reais. Sem ProgramData.
 *
 * Executar:
 * node --test --test-concurrency=1 tests/pdv/pdv-correcao-composicao-candidato-oficial-arredondamento-05-centavos-01.test.js
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ceil05-'));
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL = '0';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-ceil05-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const {
  ceilComplementoMoeda5Centavos,
  pisoComplementoMoeda5Centavos,
  ehComplementoMoeda5Centavos,
  complementoMaximoPermitidoCentavos,
  calcularMargemToleranciaDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const {
  avaliarCandidatoComComplementoDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalComposicaoMotorSimulacaoService');
const {
  integrarPagamentoRecomposicao,
  apresentacaoComposicaoFiscal
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');
const {
  marcarParcelaEletronicaComprovada,
  calcularReferenciasConfirmadas,
  gravarReferenciaRecomposicao,
  carregarReferenciaRecomposicao,
  validarReferenciaFiscalFinalComComplemento
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const { formaPagamentoUsaTEF } = require('../../backend/services/tef/tefFluxoPagamento');
const {
  reescritaDeComposicaoNoEmissorAutorizada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');
const {
  selecionarItensFiscaisParaNfce
} = require('../../backend/services/fiscal/emissor');

const ENV_TESTE = Object.freeze({
  CDS_RECOMPOSICAO_REFERENCIA_TESTE: '1',
  CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL: '0'
});
const HARNESS = Object.freeze({ ativa: true });
const CFG = Object.freeze({
  codigoUf: '23',
  cnpj: '65957340000150',
  ie: '073252638',
  crt: 1,
  ambiente: 2,
  serie: 1,
  nomeEmpresa: 'EMPRESA CEIL05 LTDA',
  logradouro: 'RUA A',
  numero: '100',
  bairro: 'CENTRO',
  codigo_municipio: '2307304',
  municipio: 'JUAZEIRO DO NORTE',
  uf: 'CE',
  cep: '63000000',
  telefone: '8835110000',
  csosn_padrao: '102'
});

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function carimbar(pagamentos) {
  return (pagamentos || []).map((pagamento) => {
    if (!formaPagamentoUsaTEF(pagamento && pagamento.forma_pagamento)) return pagamento;
    const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
    if (status !== 'aprovada' && status !== 'aprovado') return pagamento;
    const temId = pagamento.tef_transacao_id != null && String(pagamento.tef_transacao_id).trim() !== '';
    const temNsu = String(pagamento.nsu || '').trim() && String(pagamento.autorizacao || '').trim();
    if (!temId && !temNsu) return pagamento;
    return marcarParcelaEletronicaComprovada(pagamento);
  });
}

function modeloPrecoFixo(produtoId, precoCentavos, quantidadeMaxima, categoria) {
  return {
    produtoId,
    nome: `Produto ${produtoId}`,
    categoriaFiscal: categoria,
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

function itemBase(dados) {
  return {
    produto_ncm: '19059090',
    cfop: '5102',
    csosn: '102',
    unidade: 'UN',
    origem: 0,
    ...dados
  };
}

const PASTEL = itemBase({
  produto_id: 1,
  produto_nome: 'Pastel do Cheff',
  categoria_nome: 'PASTEIS',
  quantidade: 3,
  preco_unitario: 8.99,
  subtotal: 26.97,
  produto_ncm: '19059090'
});
// Preço alinhado ao modelo residual 19,01 (15,01 + complemento ceil 4,00).
const REF = itemBase({
  produto_id: 2,
  produto_nome: 'Refrigerante Copo 200ML',
  categoria_nome: 'REFRIGERANTES',
  quantidade: 1,
  preco_unitario: 19.01,
  subtotal: 19.01,
  produto_ncm: '22021000'
});
const EXTRA = itemBase({
  produto_id: 3,
  produto_nome: 'Extra comercial',
  categoria_nome: 'DIVERSOS',
  quantidade: 1,
  preco_unitario: 16,
  subtotal: 16,
  produto_ncm: '21069090'
});

const MSG_ANTIGA = 'A diferença NÃO foi convertida em desconto nem alterou o candidato oficial';

describe('CEIL-05 — fórmula centralizada', { concurrency: false }, () => {
  it('exemplos obrigatórios da sprint', () => {
    const mapa = [
      [396, 400], [393, 395], [391, 395], [390, 390],
      [387, 390], [384, 385], [236, 240], [239, 240],
      [148, 150], [183, 185]
    ];
    for (const [diff, esperado] of mapa) {
      assert.equal(ceilComplementoMoeda5Centavos(diff), esperado, String(diff));
      assert.equal(ehComplementoMoeda5Centavos(esperado), true);
    }
  });

  it('G. margem 5,03 → complemento máximo 5,00 (piso da margem)', () => {
    const margem = calcularMargemToleranciaDinheiro([
      { forma_pagamento: 'dinheiro', valor: 25.17 }
    ]);
    const info = complementoMaximoPermitidoCentavos([
      { forma_pagamento: 'dinheiro', valor: 25.17 }
    ]);
    assert.equal(margem.margem_maxima, 5.03);
    assert.equal(info.complemento_maximo, 5);
    assert.equal(pisoComplementoMoeda5Centavos(503), 500);
    assert.ok(ceilComplementoMoeda5Centavos(503) >= 500);
    assert.ok(info.complemento_maximo <= margem.margem_maxima);
  });
});

describe('CEIL-05 — motor candidato oficial', { concurrency: false }, () => {
  const cap = { R: 200 };

  it('A. diferença 3,96 / margem 4,00 → complemento 4,00 e candidato oficial 45,98', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 41.98,
      margemMaxima: 4,
      dinheiroConfirmado: 20,
      modelos: [
        modeloPrecoFixo(10, 4594, 1, 'R'),
        modeloPrecoFixo(11, 4, 2, 'R')
      ],
      capacidadePorCategoria: cap
    });
    assert.equal(r.distribuicao_possivel, true, r.motivo);
    assert.equal(r.complemento_dinheiro, 4);
    assert.equal(r.valor_fiscal_candidato_oficial, 45.98);
    assert.equal(r.valor_fiscal_residual_final, 45.98);
    assert.equal(r.candidato_oficial_atualizado, true);
    assert.equal(r.composicao_encontrada, 45.98);
    assert.equal(r.desconto_ajuste, 0);
    assert.ok(!String(r.motivo || '').includes(MSG_ANTIGA));
  });

  it('B. diferença 3,93 → complemento 3,95', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 41.98,
      margemMaxima: 4,
      dinheiroConfirmado: 20,
      modelos: [
        modeloPrecoFixo(10, 4591, 1, 'R'),
        modeloPrecoFixo(11, 2, 2, 'R')
      ],
      capacidadePorCategoria: cap
    });
    assert.equal(ceilComplementoMoeda5Centavos(393), 395);
    assert.equal(r.distribuicao_possivel, true, r.motivo);
    assert.equal(r.complemento_dinheiro, 3.95);
    assert.equal(r.valor_fiscal_candidato_oficial, 45.93);
  });

  it('C. diferença 3,91 → complemento 3,95', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 41.98,
      margemMaxima: 4,
      dinheiroConfirmado: 20,
      modelos: [
        modeloPrecoFixo(10, 4589, 1, 'R'),
        modeloPrecoFixo(11, 4, 2, 'R')
      ],
      capacidadePorCategoria: cap
    });
    assert.equal(ceilComplementoMoeda5Centavos(391), 395);
    assert.equal(r.distribuicao_possivel, true, r.motivo);
    assert.equal(r.complemento_dinheiro, 3.95);
    assert.equal(r.valor_fiscal_candidato_oficial, 45.93);
  });

  it('D. diferença 3,90 → complemento 3,90', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 41.98,
      margemMaxima: 4,
      dinheiroConfirmado: 20,
      modelos: [modeloPrecoFixo(10, 4588, 1, 'R')],
      capacidadePorCategoria: cap
    });
    assert.equal(r.distribuicao_possivel, true, r.motivo);
    assert.equal(r.complemento_dinheiro, 3.9);
    assert.equal(r.valor_fiscal_candidato_oficial, 45.88);
    assert.equal(r.desconto_ajuste, 0);
  });

  it('E. diferença 2,36 → complemento 2,40', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 41.98,
      margemMaxima: 4,
      dinheiroConfirmado: 20,
      modelos: [
        modeloPrecoFixo(10, 4434, 1, 'R'),
        modeloPrecoFixo(11, 4, 2, 'R')
      ],
      capacidadePorCategoria: cap
    });
    assert.equal(ceilComplementoMoeda5Centavos(236), 240);
    assert.equal(r.distribuicao_possivel, true, r.motivo);
    assert.equal(r.complemento_dinheiro, 2.4);
    assert.equal(r.valor_fiscal_candidato_oficial, 44.38);
  });

  it('F. margem 3,95 com diferença 3,96 — teto 3,95 + desconto (não usa ceil 4,00)', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 41.98,
      margemMaxima: 3.95,
      dinheiroConfirmado: 20,
      modelos: [
        modeloPrecoFixo(10, 4594, 1, 'R'),
        modeloPrecoFixo(11, 4, 2, 'R')
      ],
      capacidadePorCategoria: cap
    });
    assert.equal(ceilComplementoMoeda5Centavos(396), 400);
    assert.equal(r.distribuicao_possivel, true, r.motivo);
    assert.notEqual(r.complemento_dinheiro, 4);
    assert.equal(r.complemento_dinheiro, 3.95);
    assert.equal(r.valor_fiscal_candidato_oficial, 45.93);
    assert.equal(r.desconto_ajuste, 0.01);
    assert.equal(r.modo, 'acima_teto_20_com_desconto');
    assert.ok(!String(r.motivo || '').includes(MSG_ANTIGA));
  });

  it('I. só eletrônico — sem complemento', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 41.98,
      margemMaxima: 0,
      dinheiroConfirmado: 0,
      modelos: [modeloPrecoFixo(10, 4198, 1, 'R')],
      capacidadePorCategoria: cap
    });
    assert.equal(r.distribuicao_possivel, true);
    assert.equal(r.complemento_dinheiro, 0);
    assert.equal(r.candidato_oficial_atualizado, false);
  });

  it('J. ceil sem alvo no catálogo → fallback piso + desconto (16,99→19,80)', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 16.99,
      margemMaxima: 4,
      dinheiroConfirmado: 20,
      modelos: [modeloPrecoFixo(3, 1980, 1, 'R')],
      capacidadePorCategoria: cap
    });
    assert.equal(r.distribuicao_possivel, true, r.motivo);
    assert.equal(r.complemento_dinheiro, 2.8);
    assert.equal(r.desconto_ajuste, 0.01);
    assert.equal(r.valor_fiscal_candidato_oficial, 19.79);
    assert.equal(r.composicao_encontrada, 19.8);
  });

  it('K. ultrapassa 20% → teto 20% + elegível mais próximo + desconto', () => {
    // eletrônico 26,99 (pix 6,99+crédito 10+débito 10); dinheiro 10 → máx 2,00
    // bebidas: 12,99 e 19,80; mínimo acima = 12,99+19,80 = 32,79 > 28,99
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 26.99,
      margemMaxima: 2,
      dinheiroConfirmado: 10,
      modelos: [
        modeloPrecoFixo(2, 1299, 3, 'R'),
        modeloPrecoFixo(3, 1980, 2, 'R')
      ],
      capacidadePorCategoria: cap
    });
    assert.equal(r.distribuicao_possivel, true, r.motivo);
    assert.equal(r.complemento_dinheiro, 2);
    assert.equal(r.valor_fiscal_candidato_oficial, 28.99);
    assert.equal(r.composicao_encontrada, 32.79);
    assert.equal(r.desconto_ajuste, 3.8);
    assert.equal(r.modo, 'acima_teto_20_com_desconto');
    assert.equal(r.codigo, 'OK_COMPOSICAO_TETO_20_COM_DESCONTO');
  });
});

describe('CEIL-05 — integração fiscal/gerencial cenário tela', { concurrency: false }, () => {
  function pagamentosCenarioA(ordem = 'dinheiro_primeiro') {
    const eletronico = marcarParcelaEletronicaComprovada({
      forma_pagamento: 'pix',
      valor: 41.98,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-CEIL-A',
      autorizacao: 'AUT-CEIL-A',
      tef_transacao_id: 9101
    });
    const dinheiro = {
      forma_pagamento: 'dinheiro',
      valor: 20,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    };
    return ordem === 'pix_primeiro' ? [eletronico, dinheiro] : [dinheiro, eletronico];
  }

  async function integrarCenarioA(pagamentos) {
    // Pastel 26,97 fiscal fixo → residual eletrônico 15,01.
    // Modelos atingem 19,01 (15,01+4,00) após ceil do sinal 18,97 (3×12,99? usamos preços sintéticos).
    // Residual candidato = 41,98 − 26,97 = 15,01; complemento 4,00 → residual final 19,01;
    // fiscal final = 26,97 + 19,01 = 45,98; gerencial = 16,00.
    return integrarPagamentoRecomposicao({
      total: 61.98,
      empresaId: 9,
      pagamentos: carimbar(pagamentos),
      itens: [PASTEL, REF, EXTRA],
      saldosPorProduto: {
        1: { saldoFiscal: 5, saldoNaoFiscal: 5 },
        2: { saldoFiscal: 10, saldoNaoFiscal: 10 },
        3: { saldoFiscal: 5, saldoNaoFiscal: 5 }
      },
      configFiscal: CFG
    }, {
      env: ENV_TESTE,
      harnessDistribuicaoOficial: HARNESS,
      modelos: [modeloPrecoFixo(2, 1901, 2, 'REFRIGERANTE')],
      capacidade_por_categoria: { REFRIGERANTE: 500 },
      pagamentosJaComprovados: true
    });
  }

  it('A. tela real — fiscal 45,98 / gerencial 16,00 / sem mensagem antiga', async () => {
    const doc = await integrarCenarioA(pagamentosCenarioA('dinheiro_primeiro'));
    assert.equal(doc.bloqueado, false, JSON.stringify(doc));
    const ref = doc.referencia;
    assert.equal(ref.valor_fiscal_referencia_inicial, 41.98);
    assert.equal(ref.valor_nao_fiscal_referencia_inicial, 20);
    assert.equal(ref.complemento_dinheiro_utilizado, 4);
    assert.equal(ref.valor_fiscal_referencia, 45.98);
    assert.equal(ref.valor_nao_fiscal_referencia, 16);
    assert.equal(round2(ref.valor_fiscal_referencia + ref.valor_nao_fiscal_referencia), 61.98);
    assert.ok(!String(doc.motivo || '').includes(MSG_ANTIGA));
    const apres = apresentacaoComposicaoFiscal(doc);
    assert.equal(apres.complemento_dinheiro_utilizado, 4);
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
  });

  it('H. ordem inversa PIX→dinheiro — equivalente ao A', async () => {
    const a = await integrarCenarioA(pagamentosCenarioA('dinheiro_primeiro'));
    const b = await integrarCenarioA(pagamentosCenarioA('pix_primeiro'));
    assert.equal(a.bloqueado, false);
    assert.equal(b.bloqueado, false);
    assert.equal(a.referencia.valor_fiscal_referencia, b.referencia.valor_fiscal_referencia);
    assert.equal(a.referencia.valor_nao_fiscal_referencia, b.referencia.valor_nao_fiscal_referencia);
    assert.equal(a.referencia.complemento_dinheiro_utilizado, b.referencia.complemento_dinheiro_utilizado);
  });

  it('J. somente dinheiro — sem complemento fiscal', async () => {
    const refs = calcularReferenciasConfirmadas([{
      forma_pagamento: 'dinheiro',
      valor: 61.98,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    }]);
    assert.equal(refs.valor_fiscal_referencia, 0);
    assert.equal(refs.valor_nao_fiscal_referencia, 61.98);
  });

  it('K. eletrônico pendente — não entra na referência', () => {
    const refs = calcularReferenciasConfirmadas(carimbar([
      {
        forma_pagamento: 'pix',
        valor: 41.98,
        status_autorizacao: 'pendente',
        nsu: 'X',
        autorizacao: 'Y'
      },
      {
        forma_pagamento: 'dinheiro',
        valor: 20,
        status_autorizacao: 'informada',
        confirmacao_manual: 1
      }
    ]));
    assert.equal(refs.valor_fiscal_referencia, 0);
  });
});

describe('CEIL-05 — persistência / emissor / idempotência', { concurrency: false }, () => {
  const EmpresaService = require('../../backend/services/empresas/EmpresaService');
  const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');

  let empresaId;
  let produtoPastelId;
  let produtoRefriId;

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  function all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  const avaliacaoPersistida = Object.freeze({
    recomposicao_executada: true,
    total_financeiro: 61.98,
    valor_fiscal_referencia: 45.98,
    valor_nao_fiscal_referencia: 16,
    valor_fiscal_referencia_inicial: 41.98,
    valor_nao_fiscal_referencia_inicial: 20,
    complemento_dinheiro_utilizado: 4,
    desconto_ajuste: 0,
    origem_recomposicao: 'recomposicao_complemento_20',
    avaliacao_motor: {
      codigo: 'OK_COMPOSICAO_ACIMA_COM_COMPLEMENTO',
      distribuicao_possivel: true
    }
  });

  before(async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
      db.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    await garantirSchemaUsuarioEmpresasAsync(db);
    try {
      const emp = await EmpresaService.criarEmpresa(
        { cnpj: '65957340000150', razao_social: 'CEIL05 HANDOFF LTDA' },
        { db }
      );
      empresaId = emp.id;
    } catch (erro) {
      if (erro && erro.code === 'CNPJ_EMPRESA_DUPLICADO' && erro.empresa_id) {
        empresaId = erro.empresa_id;
      } else {
        throw erro;
      }
    }
    const p1 = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel Ceil', 'UN', 'COMERCIAL', 1, '19059090', '5102', '102', 100, 100, 200, 8.99, 1)`
    );
    const p2 = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Refri Ceil', 'UN', 'COMERCIAL', 1, '22021000', '5102', '102', 100, 100, 200, 19.01, 1)`
    );
    produtoPastelId = p1.lastID;
    produtoRefriId = p2.lastID;
  });

  after(() => {
    try { isolamento.cleanup(); } catch (_) { /* ignore */ }
  });

  it('L. persistência + handoff emissor reconhece fiscal final', async () => {
    const venda = await run(
      `INSERT INTO vendas (
        codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
        valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id
      ) VALUES ('CEIL-L', datetime('now'), 61.98, 3.96, 0, 'misto', 'concluida', 45.98, 16, 'quitada', ?)`,
      [empresaId]
    );
    const vendaId = venda.lastID;
    const pix = marcarParcelaEletronicaComprovada({
      forma_pagamento: 'pix',
      valor: 41.98,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-L',
      autorizacao: 'AUT-L',
      tef_transacao_id: 9201
    });
    const dinheiro = {
      forma_pagamento: 'dinheiro',
      valor: 20,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    };
    await gravarReferenciaRecomposicao(db, vendaId, avaliacaoPersistida);
    const ref = await carregarReferenciaRecomposicao(db, vendaId);
    assert.equal(Number(ref.complemento_dinheiro_utilizado), 4);
    assert.equal(Number(ref.valor_fiscal_referencia), 45.98);

    await run(
      `INSERT INTO vendas_itens (
        venda_id, produto_id, quantidade, preco_unitario, subtotal,
        quantidade_fiscal, quantidade_nao_fiscal, valor_fiscal, valor_nao_fiscal, item_fiscal
      ) VALUES (?, ?, 3, 8.99, 26.97, 3, 0, 26.97, 0, 1)`,
      [vendaId, produtoPastelId]
    );
    await run(
      `INSERT INTO vendas_itens (
        venda_id, produto_id, quantidade, preco_unitario, subtotal,
        quantidade_fiscal, quantidade_nao_fiscal, valor_fiscal, valor_nao_fiscal, item_fiscal
      ) VALUES (?, ?, 2, 19.01, 35.01, 1, 1, 19.01, 16, 1)`,
      [vendaId, produtoRefriId]
    );

    const vendaObj = {
      id: vendaId,
      total: 61.98,
      valor_fiscal: 45.98,
      valor_nao_fiscal: 16,
      pagamentos: [pix, dinheiro],
      __referencia_composicao_persistida: ref
    };
    const itens = await all('SELECT * FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    const validacao = validarReferenciaFiscalFinalComComplemento({
      venda: vendaObj,
      itens,
      pagamentos: [pix, dinheiro],
      referenciaPersistida: ref
    });
    assert.equal(validacao.ok, true, JSON.stringify(validacao));
    const sel = selecionarItensFiscaisParaNfce(vendaObj, itens);
    assert.equal(sel.bloqueado, false, JSON.stringify(sel));
    assert.equal(sel.complemento_dinheiro_utilizado, 4);
    assert.equal(sel.somaFiscal, 45.98);
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
  });

  it('M. segunda gravação na mesma venda não cria segunda linha (UNIQUE)', async () => {
    const venda = await run(
      `INSERT INTO vendas (
        codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
        valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id
      ) VALUES ('CEIL-M', datetime('now'), 61.98, 0, 0, 'misto', 'concluida', 45.98, 16, 'quitada', ?)`,
      [empresaId]
    );
    const vendaId = venda.lastID;
    await gravarReferenciaRecomposicao(db, vendaId, avaliacaoPersistida);
    let segundaFalhou = false;
    try {
      await gravarReferenciaRecomposicao(db, vendaId, avaliacaoPersistida);
    } catch (erro) {
      segundaFalhou = /UNIQUE|constraint/i.test(String(erro && erro.message || erro));
    }
    const rows = await all(
      'SELECT * FROM venda_composicao_referencia WHERE venda_id = ?',
      [vendaId]
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].complemento_dinheiro_utilizado), 4);
    assert.equal(segundaFalhou, true);
  });
});
