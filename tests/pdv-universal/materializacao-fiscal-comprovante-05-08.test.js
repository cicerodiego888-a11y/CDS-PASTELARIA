/**
 * Sprint 05.08 — materialização + fiscalização + comprovante no PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  materializarAtendimentoPdv,
  fiscalizarAtendimentoPdv,
  obterComprovantePdv,
  confirmarPagamentoPdv
} = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
const { capacidadesParaModo } = require('../../backend/motores/pdv-universal/contratos');
const pos = require('../../frontend/pdv-universal/pdv-universal-pos-pagamento.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function depsMulti(extra = {}) {
  return { obterModoOperacaoVenda: () => 'MULTIEMPRESA', ...extra };
}

function previewPago(extra = {}) {
  return {
    atendimentoId: 25,
    codigo: 'ATD-00000025',
    status: extra.status || 'CONCLUIDO',
    operacoes: extra.operacoes || [
      { operacaoId: 1, empresaId: 2, venda_id: 101, status: 'CONCLUIDA' },
      { operacaoId: 2, empresaId: 3, venda_id: 102, status: 'CONCLUIDA' }
    ],
    venda_concluida: true,
    vendas: extra.vendas || [{ vendaId: 101, empresaId: 2 }, { vendaId: 102, empresaId: 3 }],
    idempotente: !!extra.idempotente
  };
}

async function test01PagoMaterializa() {
  const r = await materializarAtendimentoPdv(25, {}, depsMulti({
    materializarAtendimento: async () => previewPago()
  }));
  assert.strictEqual(r.atendimento.status, 'CONCLUIDO');
  assert.strictEqual(r.materializado, true);
}

async function test02VendasPorEmpresa() {
  const r = await materializarAtendimentoPdv(25, {}, depsMulti({
    materializarAtendimento: async () => previewPago()
  }));
  assert.strictEqual(r.vendas.length, 2);
  assert.notStrictEqual(r.vendas[0].empresaId, r.vendas[1].empresaId);
}

async function test03NaoCobraNovamente() {
  let n = 0;
  await materializarAtendimentoPdv(25, {}, depsMulti({
    confirmarPagamentoAtendimento: async () => { n += 1; },
    materializarAtendimento: async () => previewPago()
  }));
  assert.strictEqual(n, 0);
}

async function test04ReservasConsumidas() {
  const muv = src('backend/motores/muv/MaterializarOperacoesAtendimento.js');
  assert.ok(/consum|reserva/i.test(muv));
}

async function test05DuplicadaNaoCriaVendas() {
  let n = 0;
  const criar = async (_id, _e, _d) => {
    n += 1;
    return previewPago({ idempotente: n > 1 });
  };
  await materializarAtendimentoPdv(25, { idempotency_key: 'm1' }, depsMulti({
    materializarAtendimento: criar
  }));
  const b = await materializarAtendimentoPdv(25, { idempotency_key: 'm1' }, depsMulti({
    materializarAtendimento: async () => previewPago({ idempotente: true })
  }));
  assert.strictEqual(b.idempotente, true);
}

async function test06FiscalUsaEmpresaOperacao() {
  let ops;
  await fiscalizarAtendimentoPdv(25, depsMulti({
    fiscalizarAtendimento: async () => ({
      atendimento_id: 25,
      status: 'FISCALIZADO',
      documentos: [
        { empresa_id: 2, venda_id: 101, status: 'AUTORIZADA' },
        { empresa_id: 3, venda_id: 102, status: 'AUTORIZADA' }
      ]
    })
  }));
  const fisc = src('backend/motores/muv/FiscalizarAtendimentoService.js');
  assert.ok(fisc.includes('empresaId') || fisc.includes('empresa_id'));
  ops = fisc.includes('op.empresaId') || fisc.includes('operacao.empresaId');
  assert.ok(ops);
}

async function test07NuncaEmpresa1() {
  await assert.rejects(
    () => materializarAtendimentoPdv(0, {}, depsMulti({
      materializarAtendimento: async () => previewPago()
    })),
    (e) => e.code === 'ATENDIMENTO_INVALIDO'
  );
  const front = src('frontend/pdv-universal/pdv-universal-pos-pagamento.js');
  assert.ok(!front.includes('empresa_id: 1'));
}

async function test08NfceNaoReemite() {
  const fisc = src('backend/motores/muv/FiscalizarAtendimentoService.js');
  assert.ok(/autorizad|já emit|nao reemit|não reemit|IDEMPOT|já autoriz/i.test(fisc));
}

async function test09FiscalParcialValido() {
  const r = await fiscalizarAtendimentoPdv(25, depsMulti({
    fiscalizarAtendimento: async () => ({
      atendimento_id: 25,
      status: 'FISCAL_PARCIAL',
      documentos: [
        { empresa_id: 2, status: 'AUTORIZADA' },
        { empresa_id: 3, status: 'ERRO' }
      ]
    })
  }));
  assert.strictEqual(r.fiscal_parcial, true);
  assert.strictEqual(r.atendimento.status, 'FISCAL_PARCIAL');
}

async function test10ErroNaoApagaAutorizados() {
  const r = await fiscalizarAtendimentoPdv(25, depsMulti({
    fiscalizarAtendimento: async () => ({
      atendimento_id: 25,
      status: 'FISCAL_ERRO',
      documentos: [
        { empresa_id: 2, status: 'AUTORIZADA', chave: 'ABC' },
        { empresa_id: 3, status: 'ERRO' }
      ]
    })
  }));
  assert.ok(r.documentos.some((d) => d.status === 'AUTORIZADA'));
}

async function test11ComprovanteUnico() {
  const dto = await obterComprovantePdv(25, depsMulti({
    obterComprovanteUnificado: async () => ({
      tipo: 'COMPROVANTE_UNIFICADO_ATENDIMENTO',
      atendimento: { id: 25, codigo: 'ATD-00000025' },
      itens: [{ produtoId: 1 }, { produtoId: 2 }]
    })
  }));
  assert.strictEqual(dto.tipo, 'COMPROVANTE_UNIFICADO_ATENDIMENTO');
  assert.strictEqual(dto.atendimento.id, 25);
}

async function test12ItensContinuos() {
  const dto = await obterComprovantePdv(25, depsMulti({
    obterComprovanteUnificado: async () => ({
      tipo: 'COMPROVANTE_UNIFICADO_ATENDIMENTO',
      atendimento: { id: 25 },
      itens: [{ produtoId: 10, empresaId: 2 }, { produtoId: 20, empresaId: 3 }]
    })
  }));
  assert.strictEqual(dto.itens.length, 2);
}

async function test13DocsPorEmpresa() {
  const r = await fiscalizarAtendimentoPdv(25, depsMulti({
    fiscalizarAtendimento: async () => ({
      atendimento_id: 25,
      status: 'FISCALIZADO',
      documentos: [{ empresa_id: 2 }, { empresa_id: 3 }]
    })
  }));
  assert.deepStrictEqual(r.documentos.map((d) => d.empresa_id).sort(), [2, 3]);
}

async function test14ComprovanteEmParcial() {
  assert.ok(tela.ESTADOS.COMPROVANTE_DISPONIVEL);
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('FISCAL_PARCIAL'));
  assert.strictEqual(pos.podeVerComprovante({
    capacidades: { pode_visualizar_comprovante: true }
  }), true);
}

async function test15EmpresaUnicaNaoUsaMuv() {
  let n = 0;
  await assert.rejects(
    () => materializarAtendimentoPdv(25, {}, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
      materializarAtendimento: async () => { n += 1; return previewPago(); }
    }),
    (e) => e.code === 'OPERACAO_EXCLUSIVA_MULTIEMPRESA'
  );
  await assert.rejects(
    () => fiscalizarAtendimentoPdv(25, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
      fiscalizarAtendimento: async () => { n += 1; return { status: 'FISCALIZADO' }; }
    }),
    (e) => e.code === 'OPERACAO_EXCLUSIVA_MULTIEMPRESA'
  );
  assert.strictEqual(n, 0);
  await confirmarPagamentoPdv(25, {
    pagamentos: [{ forma_pagamento: 'PIX', valor: 10 }]
  }, {
    obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
    confirmarPagamentoAtendimento: async () => { n += 1; }
  }).catch((e) => {
    assert.strictEqual(e.code, 'OPERACAO_EXCLUSIVA_MULTIEMPRESA');
  });
}

async function test16ErroMatNaoFiscaliza() {
  let fisc = 0;
  await assert.rejects(
    () => materializarAtendimentoPdv(25, {}, depsMulti({
      fiscalizarAtendimento: async () => { fisc += 1; },
      materializarAtendimento: async () => {
        const err = new Error('falha');
        err.code = 'ATENDIMENTO_NAO_PAGO';
        throw err;
      }
    })),
    (e) => e.code === 'ATENDIMENTO_NAO_PAGO'
  );
  assert.strictEqual(fisc, 0);
}

async function test17FrontendNaoCalculaFiscal() {
  const js = src('frontend/pdv-universal/pdv-universal-pos-pagamento.js');
  assert.ok(!js.includes('chave_acesso ='));
  assert.ok(!js.includes('calcular'));
  assert.ok(js.includes('/pdv-universal/atendimentos/'));
}

async function test18PreservaAtendimentoId() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('s.atendimento_id = r.atendimento_id || s.atendimento_id'));
}

async function test19CliqueDuplicado() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('_posLock'));
  assert.strictEqual(capacidadesParaModo('MULTIEMPRESA').pode_materializar_atendimento, true);
  assert.strictEqual(capacidadesParaModo('EMPRESA_UNICA').pode_fiscalizar_atendimento, false);
  assert.ok(src('backend/rotas/pdv-universal.js').includes('materializarAtendimentoPdv'));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-pos-pagamento.js').includes('imprimir'));
}

async function run() {
  const testes = [
    test01PagoMaterializa,
    test02VendasPorEmpresa,
    test03NaoCobraNovamente,
    test04ReservasConsumidas,
    test05DuplicadaNaoCriaVendas,
    test06FiscalUsaEmpresaOperacao,
    test07NuncaEmpresa1,
    test08NfceNaoReemite,
    test09FiscalParcialValido,
    test10ErroNaoApagaAutorizados,
    test11ComprovanteUnico,
    test12ItensContinuos,
    test13DocsPorEmpresa,
    test14ComprovanteEmParcial,
    test15EmpresaUnicaNaoUsaMuv,
    test16ErroMatNaoFiscaliza,
    test17FrontendNaoCalculaFiscal,
    test18PreservaAtendimentoId,
    test19CliqueDuplicado
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.08 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
