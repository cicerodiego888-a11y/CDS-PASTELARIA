/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 17
 * Integração operacional da proposta validada com o distribuidor oficial F×NF.
 *
 * Executar:
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-17.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  ENV_DIAGNOSTICO_ATIVO,
  ENV_DIAGNOSTICO_CANDIDATO,
  ENV_HOMOLOGACAO_ATIVA,
  ENV_APLICAR_DISTRIBUICAO,
  ENV_DISTRIBUICAO_OFICIAL,
  CONTRATO_DISTRIBUICAO_OFICIAL,
  obterAutorizacaoDistribuicaoOficialInterna,
  executarAtivacaoControladaRecomposicaoNoFechamento
} = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');
const {
  distribuirItensVendaComValorFiscalEfetivo
} = require('../../backend/services/distribuidorEstoqueVenda');
const { debitarEstoqueItemVenda } = require('../../backend/services/vendas/debitoEstoqueVendaViaPorta');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const ROOT = path.join(__dirname, '../..');

const PAGAMENTOS_50 = Object.freeze([
  Object.freeze({ forma_pagamento: 'debito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'credito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'dinheiro', valor: 10 })
]);

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

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_err) { resolve(); }
  });
}

async function criarAmbiente(opcoes = {}) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  await garantirSchemaEstoqueEmpresaAsync(db);
  const empresaA = await run(db, `INSERT INTO empresas (cnpj, razao_social) VALUES ('11111111000191', 'Empresa A')`);
  const empresaB = await run(db, `INSERT INTO empresas (cnpj, razao_social) VALUES ('22222222000172', 'Empresa B')`);
  const saldoFiscal = opcoes.saldoFiscal != null ? opcoes.saldoFiscal : 10;
  const saldoNaoFiscal = opcoes.saldoNaoFiscal != null ? opcoes.saldoNaoFiscal : 10;
  let produtoId = opcoes.produtoIdAusente === true ? 999999 : null;
  if (!opcoes.produtoIdAusente) {
    const produto = await run(
      db,
      `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
       VALUES ('Refrigerante teste', ?, ?, ?)`,
      [saldoFiscal, saldoNaoFiscal, saldoFiscal + saldoNaoFiscal]
    );
    produtoId = produto.lastID;
    await EstoqueEmpresaService.criarRegistro({
      produtoId,
      empresaId: empresaA.lastID,
      saldoFiscal,
      saldoNaoFiscal,
      db
    }, { db });
    await EstoqueEmpresaService.criarRegistro({
      produtoId,
      empresaId: empresaB.lastID,
      saldoFiscal: 3,
      saldoNaoFiscal: 3,
      db
    }, { db });
  }
  return {
    db,
    produtoId,
    empresaA: empresaA.lastID,
    empresaB: empresaB.lastID,
    saldoFiscal,
    saldoNaoFiscal
  };
}

async function saldoEmpresa(db, produtoId, empresaId) {
  const row = await get(
    db,
    `SELECT saldo_fiscal, saldo_nao_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?`,
    [produtoId, empresaId]
  );
  return row
    ? { saldo_fiscal: Number(row.saldo_fiscal), saldo_nao_fiscal: Number(row.saldo_nao_fiscal) }
    : null;
}

function contarDistribuidor() {
  const chamadas = [];
  function distribuir(entradas, vendaFiscal, opcoes) {
    chamadas.push({
      entradas: JSON.parse(JSON.stringify(entradas)),
      vendaFiscal,
      desconto: opcoes && opcoes.desconto,
      acrescimo: opcoes && opcoes.acrescimo,
      pagamentos: opcoes && opcoes.pagamentos
    });
    return distribuirItensVendaComValorFiscalEfetivo(entradas, vendaFiscal, opcoes);
  }
  return { distribuir, chamadas };
}

async function executar(opcoes = {}) {
  const ambiente = opcoes.ambiente || await criarAmbiente(opcoes);
  const produtoId = opcoes.produtoId != null ? opcoes.produtoId : ambiente.produtoId;
  const quantidade = opcoes.quantidade != null ? opcoes.quantidade : 5;
  const preco = opcoes.preco != null ? opcoes.preco : 10;
  const subtotal = opcoes.subtotal != null ? opcoes.subtotal : round2(quantidade * preco);
  const total = opcoes.total != null ? opcoes.total : 50;
  const pagamentos = (opcoes.pagamentos || PAGAMENTOS_50).map((p) => ({ ...p }));
  const candidato = opcoes.candidato != null ? opcoes.candidato : 40;
  const contador = opcoes.contador || contarDistribuidor();
  const env = opcoes.env != null ? opcoes.env : { [ENV_DISTRIBUICAO_OFICIAL]: '1' };
  const out = await executarAtivacaoControladaRecomposicaoNoFechamento({
    totalComercial: total,
    pagamentos,
    itens: [{
      produto_id: produtoId,
      quantidade,
      subtotal,
      preco_unitario: preco,
      unidade: 'UN'
    }],
    diagnosticoInterno: {
      valor_fiscal_candidato: candidato,
      modelos: [modeloPrecoFixo(
        produtoId,
        Math.round((opcoes.precoModelo != null ? opcoes.precoModelo : preco) * 100),
        opcoes.quantidadeMaxima || 10
      )],
      capacidade_por_categoria: { REFRIGERANTE: opcoes.capacidadeMl != null ? opcoes.capacidadeMl : 100 },
      fonte_modelos: 'PedidoPdvComposicaoService.carregarModelosRefrigerante'
    },
    env,
    harnessDistribuicaoOficial: opcoes.harnessDistribuicaoOficial,
    harnessAplicar: opcoes.harnessAplicar,
    empresaId: opcoes.omitirEmpresa === true ? null : ambiente.empresaA,
    db: ambiente.db,
    aplicarSaldo: opcoes.aplicarSaldo !== false,
    jaEmTransacao: opcoes.jaEmTransacao === true,
    deps: {
      distribuir: contador.distribuir,
      debitarEstoqueItemVenda: opcoes.debitar || debitarEstoqueItemVenda
    },
    body: opcoes.body || null
  });
  return { ambiente, out, pagamentos, contador, produtoId };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-17', { concurrency: false }, () => {
  it('1) ativação desabilitada por padrão e produção permanece desligada', async () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.equal(CONTRATO_DISTRIBUICAO_OFICIAL.producao_habilitada, false);
    assert.equal(CONTRATO_DISTRIBUICAO_OFICIAL.funcao, 'distribuirItensVendaComValorFiscalEfetivo');
    const auth = obterAutorizacaoDistribuicaoOficialInterna({});
    assert.equal(auth.ativa, false);
    assert.equal(auth.permite_aplicar_distribuicao_oficial, false);
    assert.equal(auth.producao, false);

    const { ambiente, out, contador } = await executar({
      env: {},
      aplicarSaldo: true
    });
    try {
      assert.equal(out.distribuicao_aplicada, false);
      assert.equal(out.modo.modo_efetivo, 'DIAGNOSTICO');
      assert.equal(contador.chamadas.length, 0);
      const saldo = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      assert.equal(saldo.saldo_fiscal, 10);
      assert.equal(saldo.saldo_nao_fiscal, 10);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('2) ativação somente pelo backend; body e flag legada não habilitam', () => {
    const porBody = obterAutorizacaoDistribuicaoOficialInterna({
      valor_fiscal: 40,
      habilitar_recomposicao: true,
      distribuir: true,
      [ENV_APLICAR_DISTRIBUICAO]: '1'
    });
    assert.equal(porBody.ativa, false);
    assert.equal(porBody.flag_legada_detectada, true);

    const porEnv = obterAutorizacaoDistribuicaoOficialInterna({
      [ENV_DISTRIBUICAO_OFICIAL]: '1'
    });
    assert.equal(porEnv.ativa, true);
    assert.equal(porEnv.fonte, 'backend_env');
    assert.equal(porEnv.producao, false);

    const porHarness = obterAutorizacaoDistribuicaoOficialInterna({}, { ativa: true });
    assert.equal(porHarness.ativa, true);
    assert.equal(porHarness.fonte, 'harness_teste');

    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.ok(src.includes('encaminharPropostaValidadaAoDistribuidorOficial'));
    assert.ok(src.includes('req.__cdsRecomposicaoDistribuicaoOficial'));
    assert.equal(src.includes('req.body.__cdsRecomposicaoDistribuicaoOficial'), false);
    assert.ok(src.includes('aplicarSaldo: false'));
    assert.ok(src.includes('diagnóstico isolado de recomposição'));
    const pdv = fs.readFileSync(path.join(ROOT, 'frontend/pdv/js/pdv.js'), 'utf8');
    assert.equal(pdv.includes('CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR'), false);
  });

  it('3–8) proposta válida chega ao distribuidor e aplica F×NF no banco isolado', async () => {
    const pagamentosAntes = PAGAMENTOS_50.map((p) => ({ ...p }));
    const motorLegado = distribuirItensVendaComValorFiscalEfetivo(
      [{
        item: { produto_id: 1, quantidade: 5, preco_unitario: 10, subtotal: 50, unidade: 'UN' },
        saldoFiscal: 10,
        saldoNaoFiscal: 10
      }],
      true,
      { pagamentos: pagamentosAntes.map((p) => ({ ...p })), desconto: 0, acrescimo: 0 }
    );
    const snapMotor = JSON.stringify(motorLegado);
    const { ambiente, out, pagamentos, contador, produtoId } = await executar({
      env: {
        [ENV_DISTRIBUICAO_OFICIAL]: '1',
        [ENV_DIAGNOSTICO_ATIVO]: '1',
        [ENV_DIAGNOSTICO_CANDIDATO]: '40'
      }
    });
    try {
      assert.equal(out.diagnostico.evento, 'composicao_encontrada');
      assert.equal(out.relatorio_operacional.proposta_calculada, true);
      assert.equal(out.relatorio_operacional.proposta_validada, true);
      assert.equal(out.distribuicao_aplicada, true);
      assert.notEqual(out.relatorio_operacional.proposta_validada, false);
      assert.equal(out.aplicacao_oficial.saldo_aplicado, true);
      assert.equal(JSON.stringify(motorLegado), snapMotor);

      const proposta = out.diagnostico.mapeamento_composicao.itens_proposta[0];
      assert.equal(proposta.produto_id, produtoId);
      assert.equal(proposta.quantidade, 4);
      assert.equal(out.diagnostico.proposta.proposta.valor_composicao_simulada, 40);
      assert.equal(out.diagnostico.proposta.proposta.total_comercial, 50);
      assert.equal(out.diagnostico.proposta.proposta.margem_matematica, 2);

      assert.ok(contador.chamadas.length >= 2);
      assert.equal(contador.chamadas[0].vendaFiscal, true);
      assert.equal(contador.chamadas[0].entradas[0].item.quantidade, proposta.quantidade);
      assert.equal(contador.chamadas[0].entradas[0].item.produto_id, produtoId);
      assert.equal(contador.chamadas[0].desconto, 0);
      assert.equal(contador.chamadas[0].acrescimo, 0);
      assert.equal(contador.chamadas.some((c) => c.vendaFiscal === false), true);

      const linha = out.aplicacao_oficial.resultado_oficial.itens[0];
      assert.equal(linha.produto_id, produtoId);
      assert.equal(linha.quantidade, 5);
      assert.equal(linha.quantidade_fiscal, proposta.quantidade);
      assert.equal(linha.quantidade_fiscal, 4);
      assert.equal(linha.quantidade_nao_fiscal, 1);
      assert.equal(linha.valor_fiscal, 40);
      assert.equal(linha.valor_nao_fiscal, 10);
      assert.equal(linha.subtotal, 50);
      assert.equal(out.aplicacao_oficial.resultado_oficial.totalVenda, 50);
      assert.equal(out.aplicacao_oficial.resultado_oficial.valorFiscalEfetivo, 40);
      assert.equal(out.aplicacao_oficial.resultado_oficial.valorNaoFiscal, 10);
      assert.equal(out.aplicacao_oficial.desconto_enviado_ao_distribuidor, 0);
      assert.equal(out.aplicacao_oficial.margem_nao_convertida_em_desconto, true);
      assert.equal(out.aplicacao_oficial.resultado_oficial.origem, 'distribuirItensVendaComValorFiscalEfetivo');

      assert.deepEqual(pagamentos, pagamentosAntes);
      assert.deepEqual(
        contador.chamadas[0].pagamentos.map((p) => ({ forma_pagamento: p.forma_pagamento, valor: p.valor })),
        pagamentosAntes
      );

      const antes = out.aplicacao_oficial.saldos_antes[0];
      const depois = out.aplicacao_oficial.saldos_depois[0];
      assert.equal(antes.empresa_id, ambiente.empresaA);
      assert.equal(antes.saldo_fiscal, 10);
      assert.equal(antes.saldo_nao_fiscal, 10);
      assert.equal(depois.saldo_fiscal, 6);
      assert.equal(depois.saldo_nao_fiscal, 9);

      const saldoA = await saldoEmpresa(ambiente.db, produtoId, ambiente.empresaA);
      const saldoB = await saldoEmpresa(ambiente.db, produtoId, ambiente.empresaB);
      const produto = await get(ambiente.db, 'SELECT saldo_fiscal, saldo_nao_fiscal FROM produtos WHERE id = ?', [produtoId]);
      assert.equal(saldoA.saldo_fiscal, 6);
      assert.equal(saldoA.saldo_nao_fiscal, 9);
      assert.equal(produto.saldo_fiscal, 6);
      assert.equal(produto.saldo_nao_fiscal, 9);
      assert.equal(saldoB.saldo_fiscal, 3);
      assert.equal(saldoB.saldo_nao_fiscal, 3);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('candidato 41,90 respeita a margem de R$ 2 sem virar desconto', async () => {
    const { ambiente, out, pagamentos } = await executar({ candidato: 41.9 });
    try {
      assert.equal(out.diagnostico.status_simulacao, 'COMPATIVEL_MARGEM');
      assert.equal(out.distribuicao_aplicada, true);
      assert.equal(out.diagnostico.proposta.proposta.margem_matematica, 2);
      assert.equal(out.diagnostico.proposta.proposta.valor_composicao_simulada, 40);
      assert.ok(Math.abs(out.diagnostico.proposta.proposta.diferenca_composicao - 1.9) < 0.001);
      const linha = out.aplicacao_oficial.resultado_oficial.itens[0];
      assert.equal(linha.quantidade_fiscal, out.diagnostico.mapeamento_composicao.itens_proposta[0].quantidade);
      assert.equal(linha.valor_fiscal, 40);
      assert.equal(linha.valor_nao_fiscal, 10);
      assert.equal(out.aplicacao_oficial.resultado_oficial.totalVenda, 50);
      assert.equal(out.aplicacao_oficial.desconto_enviado_ao_distribuidor, 0);
      assert.deepEqual(pagamentos.map((p) => p.valor), [20, 20, 10]);
      const saldo = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      assert.equal(saldo.saldo_fiscal, 6);
      assert.equal(saldo.saldo_nao_fiscal, 9);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('9) candidato 35 incompatível não aplica e não mexe no saldo', async () => {
    const { ambiente, out, contador } = await executar({ candidato: 35 });
    try {
      assert.equal(out.diagnostico.evento, 'composicao_incompativel');
      assert.equal(out.relatorio_operacional.proposta_calculada, false);
      assert.equal(out.relatorio_operacional.proposta_validada, false);
      assert.equal(out.distribuicao_aplicada, false);
      assert.equal(out.aplicacao_oficial, null);
      assert.equal(contador.chamadas.length, 0);
      const saldo = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      assert.equal(saldo.saldo_fiscal, 10);
      assert.equal(saldo.saldo_nao_fiscal, 10);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('saldo insuficiente impede a distribuição sem baixa', async () => {
    const { ambiente, out, contador } = await executar({
      saldoFiscal: 2,
      saldoNaoFiscal: 10
    });
    try {
      assert.equal(out.relatorio_operacional.proposta_validada, true);
      assert.equal(out.distribuicao_aplicada, false);
      assert.equal(out.aplicacao_oficial.saldo_aplicado, false);
      assert.equal(out.aplicacao_oficial.codigo, 'SALDO_INSUFICIENTE');
      assert.equal(contador.chamadas.length >= 1, true);
      assert.equal(contador.chamadas[0].vendaFiscal, true);
      assert.equal(out.aplicacao_oficial.chamadas_distribuidor[0].sucesso, false);
      const saldo = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      assert.equal(saldo.saldo_fiscal, 2);
      assert.equal(saldo.saldo_nao_fiscal, 10);
      assert.equal(out.aplicacao_oficial.saldos_antes[0].saldo_fiscal, 2);
      assert.equal(out.aplicacao_oficial.saldos_depois[0].saldo_fiscal, 2);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('produto inexistente ou quantidade incompatível impede a aplicação', async () => {
    const ausente = await executar({ produtoIdAusente: true, produtoId: 999999 });
    try {
      assert.equal(ausente.out.distribuicao_aplicada, false);
      assert.equal(ausente.out.aplicacao_oficial.codigo, 'PRODUTO_INEXISTENTE');
      assert.equal(ausente.contador.chamadas.length, 0);
    } finally {
      await closeDb(ausente.ambiente.db);
    }

    const qtd = await executar({ quantidade: 2, subtotal: 50, preco: 25, precoModelo: 10 });
    try {
      assert.equal(qtd.out.diagnostico.mapeamento_composicao.itens_proposta[0].quantidade, 4);
      assert.equal(qtd.out.distribuicao_aplicada, false);
      assert.equal(qtd.out.aplicacao_oficial.codigo, 'QUANTIDADE_ACIMA_DA_VENDIDA');
      assert.equal(qtd.contador.chamadas.length, 0);
      const saldo = await saldoEmpresa(qtd.ambiente.db, qtd.produtoId, qtd.ambiente.empresaA);
      assert.equal(saldo.saldo_fiscal, 10);
      assert.equal(saldo.saldo_nao_fiscal, 10);
    } finally {
      await closeDb(qtd.ambiente.db);
    }
  });

  it('contexto de empresa ausente impede a aplicação', async () => {
    const { ambiente, out, contador } = await executar({ omitirEmpresa: true });
    try {
      assert.equal(out.relatorio_operacional.proposta_validada, true);
      assert.equal(out.distribuicao_aplicada, false);
      assert.equal(out.aplicacao_oficial.codigo, 'EMPRESA_AUSENTE');
      assert.equal(contador.chamadas.length, 0);
      const saldo = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      assert.equal(saldo.saldo_fiscal, 10);
      assert.equal(saldo.saldo_nao_fiscal, 10);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('10) falha depois do débito faz rollback e não deixa saldo parcial', async () => {
    const debitarQueFalha = (db, dados, cb) => {
      debitarEstoqueItemVenda(db, dados, (err) => {
        if (err) return cb(err);
        const falha = new Error('falha após débito');
        falha.code = 'FALHA_APOS_DEBITO';
        cb(falha);
      });
    };
    const { ambiente, out } = await executar({ debitar: debitarQueFalha });
    try {
      assert.equal(out.distribuicao_aplicada, false);
      assert.equal(out.aplicacao_oficial.codigo, 'FALHA_APOS_DEBITO');
      assert.equal(out.aplicacao_oficial.rollback, true);
      assert.equal(out.aplicacao_oficial.saldo_aplicado, false);
      const saldo = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      const produto = await get(
        ambiente.db,
        'SELECT saldo_fiscal, saldo_nao_fiscal FROM produtos WHERE id = ?',
        [ambiente.produtoId]
      );
      assert.equal(saldo.saldo_fiscal, 10);
      assert.equal(saldo.saldo_nao_fiscal, 10);
      assert.equal(produto.saldo_fiscal, 10);
      assert.equal(produto.saldo_nao_fiscal, 10);
      assert.equal(out.aplicacao_oficial.saldos_depois[0].saldo_fiscal, 10);
      assert.equal(out.aplicacao_oficial.saldos_depois[0].saldo_nao_fiscal, 10);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('rollback do chamador desfaz a baixa confirmada na mesma transação', async () => {
    const ambiente = await criarAmbiente();
    try {
      await run(ambiente.db, 'BEGIN');
      const { out } = await executar({
        ambiente,
        jaEmTransacao: true,
        aplicarSaldo: true
      });
      assert.equal(out.distribuicao_aplicada, true);
      const durante = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      assert.equal(durante.saldo_fiscal, 6);
      assert.equal(durante.saldo_nao_fiscal, 9);
      await run(ambiente.db, 'ROLLBACK');
      const apos = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      assert.equal(apos.saldo_fiscal, 10);
      assert.equal(apos.saldo_nao_fiscal, 10);
    } finally {
      await closeDb(ambiente.db);
    }
  });

  it('11) fluxo legado permanece quando a recomposição está desativada', async () => {
    const legado = distribuirItensVendaComValorFiscalEfetivo(
      [{
        item: { produto_id: 7, quantidade: 5, preco_unitario: 10, subtotal: 50, unidade: 'UN' },
        saldoFiscal: 10,
        saldoNaoFiscal: 10
      }],
      true,
      {
        pagamentos: PAGAMENTOS_50.map((p) => ({ ...p })),
        desconto: 0,
        acrescimo: 0,
        midpAtivo: false
      }
    );
    assert.equal(legado.sucesso, true);
    assert.equal(legado.itens[0].quantidade_fiscal, 5);
    assert.equal(legado.itens[0].quantidade_nao_fiscal, 0);
    assert.equal(legado.totalVenda, 50);

    const { ambiente, out, contador } = await executar({
      env: {
        [ENV_HOMOLOGACAO_ATIVA]: '1',
        [ENV_DIAGNOSTICO_ATIVO]: '1',
        [ENV_DIAGNOSTICO_CANDIDATO]: '40'
      }
    });
    try {
      assert.equal(out.relatorio_operacional.proposta_validada, true);
      assert.equal(out.distribuicao_aplicada, false);
      assert.equal(contador.chamadas.length, 0);
      const saldo = await saldoEmpresa(ambiente.db, ambiente.produtoId, ambiente.empresaA);
      assert.equal(saldo.saldo_fiscal, 10);
    } finally {
      await closeDb(ambiente.db);
    }

    const bloqueada = await executar({
      env: {
        [ENV_DISTRIBUICAO_OFICIAL]: '1',
        [ENV_APLICAR_DISTRIBUICAO]: '1'
      },
      harnessAplicar: { tentar: true }
    });
    try {
      assert.equal(bloqueada.out.modo.modo_efetivo, 'APLICACAO_BLOQUEADA');
      assert.equal(bloqueada.out.distribuicao_aplicada, false);
      assert.equal(bloqueada.contador.chamadas.length, 0);
    } finally {
      await closeDb(bloqueada.ambiente.db);
    }
  });
});
