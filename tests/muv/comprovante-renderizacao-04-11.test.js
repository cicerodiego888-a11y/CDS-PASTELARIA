/**
 * Sprint 04.11 — renderização TEXT/HTML do comprovante unificado.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { TIPO_COMPROVANTE } = require('../../backend/motores/muv/ComprovanteUnificadoAtendimentoService');
const {
  renderizar,
  resolverSaidaHttp
} = require('../../backend/motores/muv/comprovante/ComprovanteRenderer');

function dtoBase(extra = {}) {
  return {
    tipo: TIPO_COMPROVANTE,
    atendimento: {
      id: 1,
      codigo: 'ATD-00000001',
      status: 'CONCLUIDO',
      created_at: '2026-08-22 19:30'
    },
    estabelecimento: { nome: 'PASTELARIA XYZ' },
    cabecalho: { codigo: 'ATD-00000001', dataHora: '2026-08-22 19:30' },
    itens: [
      { itemId: 1, produtoId: 10, descricao: 'Suco de Laranja', quantidade: 2, valorTotal: 12 },
      { itemId: 2, produtoId: 11, descricao: 'Coca-Cola 200ml', quantidade: 6, valorTotal: 18 },
      { itemId: 3, produtoId: 12, descricao: 'Pastel de Carne', quantidade: 3, valorTotal: 21 }
    ],
    totais: { atendimento: 51, itens: 51, pagamentos: 51 },
    pagamento: { unificado: true, total: 51, formas: [{ formaPagamento: 'pix', valor: 51 }] },
    pagamentos: [{ formaPagamento: 'pix', valor: 51 }],
    documentos_fiscais: [],
    fiscal: { status: 'PENDENTE' },
    rateios: [{ empresaId: 1, valor: 12 }],
    ...extra
  };
}

function docsAbc() {
  return [
    {
      empresa_id: 1, empresa_nome: 'Empresa A', status: 'AUTORIZADA',
      documento: { tipo: 'NFC-e', numero: 123, chave: 'CHAVE-A', qr_code_url: 'https://qr/a' }
    },
    {
      empresa_id: 2, empresa_nome: 'Empresa B', status: 'AUTORIZADA',
      documento: { tipo: 'NFC-e', numero: 456, chave: 'CHAVE-B', qr_code_url: 'https://qr/b' }
    },
    {
      empresa_id: 3, empresa_nome: 'Empresa C', status: 'AUTORIZADA',
      documento: { tipo: 'NFC-e', numero: 789, chave: 'CHAVE-C', qr_code_url: 'https://qr/c' }
    }
  ];
}

function assertRejectsSync(fn, code) {
  try {
    fn();
    throw new Error(`Esperava ${code}`);
  } catch (err) {
    if (err.message === `Esperava ${code}`) throw err;
    assert.strictEqual(err.code, code, err.message);
  }
}

function test01TextBasico() {
  const r = renderizar(dtoBase(), { format: 'TEXT' });
  assert.strictEqual(r.format, 'TEXT');
  assert.ok(r.conteudo.includes('COMPROVANTE DE ATENDIMENTO'));
  assert.ok(r.conteudo.includes('ATD-00000001'));
  assert.ok(r.conteudo.includes('TOTAL DO ATENDIMENTO'));
}

function test02HtmlBasico() {
  const r = renderizar(dtoBase(), { format: 'HTML' });
  assert.strictEqual(r.format, 'HTML');
  assert.ok(r.conteudo.includes('<!DOCTYPE html>'));
  assert.ok(r.conteudo.includes('Comprovante de atendimento'));
}

function test03FormatoInvalido() {
  assertRejectsSync(() => renderizar(dtoBase(), { format: 'PDF' }), 'COMPROVANTE_FORMATO_INVALIDO');
}

function test04DtoInvalido() {
  assertRejectsSync(() => renderizar({ tipo: 'X' }, { format: 'TEXT' }), 'COMPROVANTE_DTO_INVALIDO');
  assertRejectsSync(() => renderizar(null, { format: 'TEXT' }), 'COMPROVANTE_DTO_INVALIDO');
}

function test05LarguraDefault() {
  const r = renderizar(dtoBase(), { format: 'TEXT' });
  const linhas = r.conteudo.split('\n');
  assert.ok(linhas[0].length === 40);
}

function test06Largura32() {
  const r = renderizar(dtoBase(), { format: 'TEXT', largura: 32 });
  assert.strictEqual(r.conteudo.split('\n')[0].length, 32);
}

function test07Largura40() {
  const r = renderizar(dtoBase(), { format: 'TEXT', largura: 40 });
  assert.strictEqual(r.conteudo.split('\n')[0].length, 40);
}

function test08Largura48() {
  const r = renderizar(dtoBase(), { format: 'TEXT', largura: 48 });
  assert.strictEqual(r.conteudo.split('\n')[0].length, 48);
}

function test09DescricaoLonga() {
  const dto = dtoBase({
    itens: [{
      itemId: 1, produtoId: 1,
      descricao: 'Pastel de carne com queijo e orégano especial da casa',
      quantidade: 1, valorTotal: 10
    }]
  });
  const r = renderizar(dto, { format: 'TEXT', largura: 32 });
  assert.ok(r.conteudo.includes('R$ 10,00'));
  assert.ok(r.conteudo.split('\n').some((l) => l.includes('Pastel')));
}

function test10MultiplosItens() {
  const r = renderizar(dtoBase(), { format: 'TEXT' });
  assert.ok(r.conteudo.includes('2x Suco de Laranja'));
  assert.ok(r.conteudo.includes('6x Coca-Cola 200ml'));
  assert.ok(r.conteudo.includes('3x Pastel de Carne'));
}

function test11PagamentoUnico() {
  const r = renderizar(dtoBase(), { format: 'TEXT' });
  assert.ok(r.conteudo.includes('PIX'));
  assert.ok(r.conteudo.includes('R$ 51,00'));
}

function test12PagamentoMisto() {
  const dto = dtoBase({
    pagamento: {
      unificado: true, total: 51,
      formas: [{ formaPagamento: 'pix', valor: 30 }, { formaPagamento: 'credito', valor: 21 }]
    },
    pagamentos: [{ formaPagamento: 'pix', valor: 30 }, { formaPagamento: 'credito', valor: 21 }]
  });
  const r = renderizar(dto, { format: 'TEXT' });
  assert.ok(r.conteudo.includes('PIX'));
  assert.ok(r.conteudo.includes('CREDITO'));
  assert.ok(r.conteudo.includes('R$ 30,00'));
  assert.ok(r.conteudo.includes('R$ 21,00'));
}

function test13SemDocumentos() {
  const r = renderizar(dtoBase(), { format: 'TEXT' });
  assert.ok(r.conteudo.includes('Nenhum documento fiscal disponível.'));
}

function test14DocsCompletos() {
  const r = renderizar(dtoBase({
    documentos_fiscais: docsAbc(),
    fiscal: { status: 'FISCALIZADO' }
  }), { format: 'TEXT' });
  assert.ok(r.conteudo.includes('Empresa A'));
  assert.ok(r.conteudo.includes('CHAVE-A'));
  assert.ok(r.conteudo.includes('Empresa C'));
}

function test15Parcial() {
  const docs = docsAbc();
  docs[2].status = 'REJEITADA';
  const r = renderizar(dtoBase({
    documentos_fiscais: docs,
    fiscal: { status: 'FISCAL_PARCIAL' }
  }), { format: 'TEXT' });
  assert.ok(r.conteudo.includes('FISCAL_PARCIAL'));
  assert.ok(r.conteudo.includes('CHAVE-A'));
  assert.ok(r.conteudo.includes('REJEITADA'));
}

function test16ErroFiscal() {
  const r = renderizar(dtoBase({
    documentos_fiscais: [{
      empresa_id: 1, empresa_nome: 'Empresa A', status: 'ERRO',
      documento: { tipo: 'NFC-e', numero: null }
    }],
    fiscal: { status: 'FISCAL_ERRO' }
  }), { format: 'TEXT' });
  assert.ok(r.conteudo.includes('FISCAL_ERRO'));
  assert.ok(r.conteudo.includes('COMPROVANTE DE ATENDIMENTO'));
}

function test17Cancelado() {
  const r = renderizar(dtoBase({
    atendimento: { id: 1, codigo: 'ATD-00000001', status: 'CANCELADO', created_at: '2026-08-22 19:30' }
  }), { format: 'TEXT' });
  assert.ok(r.conteudo.includes('*** ATENDIMENTO CANCELADO ***'));
  assert.ok(r.conteudo.includes('2x Suco de Laranja'));
}

function test18ItensContinuos() {
  const r = renderizar(dtoBase({ documentos_fiscais: docsAbc() }), { format: 'TEXT' });
  const itensIdx = r.conteudo.indexOf('ITENS');
  const fiscalIdx = r.conteudo.indexOf('DOCUMENTOS FISCAIS');
  const blocoItens = r.conteudo.slice(itensIdx, fiscalIdx);
  assert.ok(!blocoItens.includes('Empresa A'));
  assert.ok(blocoItens.includes('2x Suco'));
  assert.ok(blocoItens.includes('6x Coca'));
}

function test19EmpresaNaAreaFiscal() {
  const r = renderizar(dtoBase({ documentos_fiscais: docsAbc() }), { format: 'TEXT' });
  const fiscalIdx = r.conteudo.indexOf('DOCUMENTOS FISCAIS');
  assert.ok(r.conteudo.slice(fiscalIdx).includes('Empresa B'));
}

function test20RateioNaoAparece() {
  const r = renderizar(dtoBase(), { format: 'TEXT' });
  const h = renderizar(dtoBase(), { format: 'HTML' });
  assert.ok(!r.conteudo.toLowerCase().includes('rateio'));
  assert.ok(!h.conteudo.toLowerCase().includes('rateio'));
}

function test21HtmlEscapa() {
  const dto = dtoBase({
    itens: [{
      itemId: 1, produtoId: 1,
      descricao: '<script>alert(1)</script>',
      quantidade: 1, valorTotal: 10
    }]
  });
  const r = renderizar(dto, { format: 'HTML' });
  assert.ok(!r.conteudo.includes('<script>alert(1)</script>'));
  assert.ok(r.conteudo.includes('&lt;script&gt;'));
}

function test22Determinismo() {
  const dto = dtoBase({ documentos_fiscais: docsAbc() });
  const a = renderizar(dto, { format: 'TEXT', largura: 40 });
  const b = renderizar(dto, { format: 'TEXT', largura: 40 });
  assert.strictEqual(a.conteudo, b.conteudo);
}

function test23RouterJson() {
  const dto = dtoBase();
  const saida = resolverSaidaHttp(dto, {});
  assert.strictEqual(saida.kind, 'json');
  assert.strictEqual(saida.body.tipo, TIPO_COMPROVANTE);
}

function test24RouterText() {
  const saida = resolverSaidaHttp(dtoBase(), { formato: 'TEXT' });
  assert.strictEqual(saida.kind, 'text');
  assert.ok(saida.contentType.startsWith('text/plain'));
  assert.ok(saida.body.includes('ITENS'));
}

function test25RouterHtml() {
  const saida = resolverSaidaHttp(dtoBase(), { format: 'HTML' });
  assert.strictEqual(saida.kind, 'html');
  assert.ok(saida.contentType.startsWith('text/html'));
}

function test26HttpInvalido() {
  assertRejectsSync(() => resolverSaidaHttp(dtoBase(), { formato: 'ESC' }), 'COMPROVANTE_FORMATO_INVALIDO');
}

function test27SemBanco() {
  const dir = path.join(__dirname, '../../backend/motores/muv/comprovante');
  for (const nome of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, nome), 'utf8');
    assert.ok(!src.includes("require('../../database')"), nome);
    assert.ok(!src.includes('sqlite'), nome);
  }
}

function test28SemSegredos() {
  const r = renderizar(dtoBase({
    certificado_senha: 'SEGREDO',
    token_csc: 'CSC-X'
  }), { format: 'TEXT' });
  assert.ok(!r.conteudo.includes('SEGREDO'));
  assert.ok(!r.conteudo.includes('CSC-X'));
}

function test29RotaUsaRenderer() {
  const src = fs.readFileSync(path.join(__dirname, '../../backend/rotas/atendimentos.js'), 'utf8');
  assert.ok(src.includes('resolverSaidaHttp'));
  assert.ok(src.includes('obterComprovanteUnificado'));
}

function test30HtmlCancelado() {
  const r = renderizar(dtoBase({
    atendimento: { id: 1, codigo: 'ATD-1', status: 'CANCELADO' }
  }), { format: 'HTML' });
  assert.ok(r.conteudo.includes('ATENDIMENTO CANCELADO'));
}

function main() {
  const testes = [
    ['01 TEXT básico', test01TextBasico],
    ['02 HTML básico', test02HtmlBasico],
    ['03 formato inválido', test03FormatoInvalido],
    ['04 DTO inválido', test04DtoInvalido],
    ['05 largura default', test05LarguraDefault],
    ['06 largura 32', test06Largura32],
    ['07 largura 40', test07Largura40],
    ['08 largura 48', test08Largura48],
    ['09 descrição longa', test09DescricaoLonga],
    ['10 múltiplos itens', test10MultiplosItens],
    ['11 pagamento único', test11PagamentoUnico],
    ['12 pagamento misto', test12PagamentoMisto],
    ['13 sem documentos', test13SemDocumentos],
    ['14 documentos completos', test14DocsCompletos],
    ['15 FISCAL_PARCIAL', test15Parcial],
    ['16 FISCAL_ERRO', test16ErroFiscal],
    ['17 CANCELADO', test17Cancelado],
    ['18 itens contínuos', test18ItensContinuos],
    ['19 empresa na área fiscal', test19EmpresaNaAreaFiscal],
    ['20 rateio não aparece', test20RateioNaoAparece],
    ['21 HTML escapa', test21HtmlEscapa],
    ['22 determinismo', test22Determinismo],
    ['23 router JSON legado', test23RouterJson],
    ['24 router TEXT', test24RouterText],
    ['25 router HTML', test25RouterHtml],
    ['26 HTTP formato inválido', test26HttpInvalido],
    ['27 renderer sem banco', test27SemBanco],
    ['28 sem segredos', test28SemSegredos],
    ['29 rota delega renderer', test29RotaUsaRenderer],
    ['30 HTML cancelado', test30HtmlCancelado]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\ncomprovante-renderizacao-04-11: ${ok}/${testes.length} OK`);
}

main();
