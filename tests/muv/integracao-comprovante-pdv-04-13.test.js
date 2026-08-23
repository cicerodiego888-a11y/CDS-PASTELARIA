/**
 * Sprint 04.13 — integração do comprovante unificado ao PDV (consumo da API oficial).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = require('../../frontend/shared/js/muv-comprovante-client.js');
const modal = require('../../frontend/shared/js/muv-comprovante-modal.js');

const FRONT_CLIENT = path.join(__dirname, '../../frontend/shared/js/muv-comprovante-client.js');
const FRONT_MODAL = path.join(__dirname, '../../frontend/shared/js/muv-comprovante-modal.js');
const PDV_JS = path.join(__dirname, '../../frontend/pdv/js/pdv.js');
const PDV_HTML = path.join(__dirname, '../../frontend/pdv/index.html');
const ROTAS_ATD = path.join(__dirname, '../../backend/rotas/atendimentos.js');

function src(p) {
  return fs.readFileSync(p, 'utf8');
}

function dtoAbc(extra = {}) {
  return {
    tipo: 'COMPROVANTE_UNIFICADO_ATENDIMENTO',
    atendimento: { id: 1548, codigo: 'ATD-00001548', status: extra.status || 'CONCLUIDO' },
    itens: [
      { itemId: 1, descricao: 'Suco de Laranja', quantidade: 2, valorTotal: 12 },
      { itemId: 2, descricao: 'Coca-Cola 200ml', quantidade: 6, valorTotal: 18 },
      { itemId: 3, descricao: 'Pastel de Carne', quantidade: 3, valorTotal: 21 }
    ],
    totais: { atendimento: 51, itens: 51, pagamentos: 51 },
    pagamento: { unificado: true, total: 51, formas: [{ formaPagamento: 'pix', valor: 51 }] },
    documentos_fiscais: extra.documentos_fiscais || [
      { empresaId: 1, empresaNome: 'Empresa A', modelo: '65', numero: '000123', status: 'AUTORIZADA' },
      { empresaId: 2, empresaNome: 'Empresa B', modelo: '65', numero: '000456', status: extra.docB || 'AUTORIZADA' },
      { empresaId: 3, empresaNome: 'Empresa C', modelo: '65', numero: '000789', status: 'AUTORIZADA' }
    ],
    fiscal: extra.fiscal || { status: 'FISCALIZADO' }
  };
}

function mockFetchSequencia(respostas) {
  const chamadas = [];
  const fetchFn = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    const r = respostas.shift();
    if (!r) throw new Error('FETCH_INESPERADO');
    return {
      ok: r.ok !== false,
      status: r.status || (r.ok === false ? 500 : 200),
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? (r.contentType || 'application/json') : null) },
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    };
  };
  return { fetchFn, chamadas };
}

async function test01CarregarPorAtendimentoId() {
  const dto = dtoAbc();
  const { fetchFn, chamadas } = mockFetchSequencia([{ body: dto }]);
  const out = await client.obterComprovanteJson(1548, fetchFn);
  assert.strictEqual(out.atendimento.id, 1548);
  assert.ok(chamadas[0].url.includes('/api/atendimentos/1548/comprovante'));
  assert.ok(!chamadas[0].url.includes('formato='));
  assert.strictEqual(client.extrairAtendimentoId({ venda_id: 99, vendaId: 99 }), null);
  assert.strictEqual(client.extrairAtendimentoId({ atendimento_id: 1548 }), 1548);
}

async function test02PreviewHtml() {
  const html = '<!DOCTYPE html><html><body>COMPROVANTE OFICIAL</body></html>';
  const { fetchFn, chamadas } = mockFetchSequencia([{ body: html, contentType: 'text/html' }]);
  const out = await client.obterComprovanteHtml(1548, fetchFn);
  assert.ok(String(out).includes('COMPROVANTE OFICIAL'));
  assert.ok(chamadas[0].url.includes('formato=HTML'));
  const iframe = modal.iframePreview(html);
  assert.strictEqual(iframe.tipo, 'html_oficial');
  assert.ok(iframe.conteudo.includes('COMPROVANTE OFICIAL'));
}

async function test03MultiempresaAbc() {
  const dto = dtoAbc();
  assert.strictEqual(dto.documentos_fiscais.length, 3);
  assert.strictEqual(dto.documentos_fiscais[0].empresaNome, 'Empresa A');
  assert.strictEqual(dto.documentos_fiscais[1].numero, '000456');
  assert.strictEqual(dto.documentos_fiscais[2].empresaNome, 'Empresa C');
}

async function test04ListaContinua() {
  const dto = dtoAbc();
  const nomes = dto.itens.map((i) => i.descricao);
  assert.deepStrictEqual(nomes, ['Suco de Laranja', 'Coca-Cola 200ml', 'Pastel de Carne']);
  assert.ok(dto.itens.every((i) => i.empresaId == null && i.empresa_id == null));
}

async function test05TotalOficial() {
  const dto = dtoAbc();
  assert.strictEqual(dto.totais.atendimento, 51);
  const srcAll = src(FRONT_CLIENT) + src(FRONT_MODAL);
  assert.ok(!/reduce\s*\(/.test(srcAll));
  assert.ok(!/valorTotal\s*\+/.test(srcAll));
}

async function test06PagamentoUnificado() {
  const dto = dtoAbc();
  assert.strictEqual(dto.pagamento.unificado, true);
  assert.strictEqual(dto.pagamento.formas.length, 1);
  assert.strictEqual(dto.pagamento.formas[0].formaPagamento, 'pix');
}

async function test07DocumentosPorEmpresa() {
  const dto = dtoAbc();
  const porEmpresa = dto.documentos_fiscais.map((d) => `${d.empresaNome}:${d.numero}`);
  assert.deepStrictEqual(porEmpresa, ['Empresa A:000123', 'Empresa B:000456', 'Empresa C:000789']);
}

async function test08FiscalParcial() {
  const dto = dtoAbc({
    fiscal: { status: 'FISCAL_PARCIAL' },
    docB: 'ERRO'
  });
  const estado = client.classificarEstadoVisual(dto, false);
  assert.strictEqual(estado, 'FISCAL_PARCIAL');
  assert.ok(dto.documentos_fiscais.some((d) => d.status === 'AUTORIZADA'));
  assert.ok(dto.documentos_fiscais.some((d) => d.status === 'ERRO'));
}

async function test09FiscalErro() {
  const dto = dtoAbc({ fiscal: { status: 'FISCAL_ERRO' } });
  assert.strictEqual(client.classificarEstadoVisual(dto, false), 'FISCAL_ERRO');
}

async function test10Cancelado() {
  const dto = dtoAbc({ status: 'CANCELADO' });
  assert.strictEqual(client.classificarEstadoVisual(dto, false), 'ATENDIMENTO_CANCELADO');
  assert.ok(client.mensagensEstado('ATENDIMENTO_CANCELADO').toLowerCase().includes('cancelado'));
}

async function test11SemDocumentos() {
  const dto = dtoAbc({ documentos_fiscais: [], fiscal: { status: 'PENDENTE' } });
  assert.strictEqual(client.classificarEstadoVisual(dto, false), 'SEM_DOCUMENTO_FISCAL');
}

async function test12ErroApi() {
  const { fetchFn } = mockFetchSequencia([{
    ok: false,
    status: 404,
    body: { codigo: 'ATENDIMENTO_NAO_ENCONTRADO', mensagem: 'não encontrado' }
  }]);
  await assert.rejects(() => client.obterComprovanteJson(999, fetchFn), (err) => {
    assert.strictEqual(err.code, 'ATENDIMENTO_NAO_ENCONTRADO');
    return true;
  });
  assert.strictEqual(client.classificarEstadoVisual(null, true), 'ERRO_CARREGAMENTO');
}

async function test13PrepararBrowser() {
  const { fetchFn, chamadas } = mockFetchSequencia([{
    body: { destino: 'BROWSER', formato: 'HTML', conteudo: '<html>prep</html>', impressao_fisica: false }
  }]);
  const out = await client.prepararImpressaoBrowser(1548, fetchFn);
  assert.strictEqual(out.destino, 'BROWSER');
  assert.strictEqual(out.impressao_fisica, false);
  assert.ok(chamadas[0].url.includes('/api/atendimentos/1548/imprimir'));
  assert.strictEqual(chamadas[0].opcoes.method, 'POST');
  const body = JSON.parse(chamadas[0].opcoes.body);
  assert.deepStrictEqual(body, { destino: 'BROWSER', formato: 'HTML', largura: 40 });
}

async function test14SemAlterarEstadoBackend() {
  const srcAll = src(FRONT_CLIENT) + src(FRONT_MODAL);
  assert.ok(!/fiscalizarAtendimento/.test(srcAll));
  assert.ok(!/confirmarPagamento/.test(srcAll));
  assert.ok(!/materializar/.test(srcAll));
  assert.ok(!/PUT/.test(srcAll));
  assert.ok(!/DELETE/.test(srcAll));
}

async function test15NaoDuplicarCalculo() {
  const srcAll = src(FRONT_CLIENT) + src(FRONT_MODAL);
  assert.ok(!/pre-calcular/.test(srcAll));
  assert.ok(!/agrupar.*empresa/i.test(srcAll));
  assert.ok(!/QRCode|qrcode|qr_code/.test(srcAll));
}

async function test16SemChamadasDiretas() {
  const srcAll = src(FRONT_CLIENT) + src(FRONT_MODAL);
  assert.ok(!/nfce_notas/.test(srcAll));
  assert.ok(!/sqlite/.test(srcAll));
  assert.ok(!/\/api\/nfce/.test(srcAll));
  assert.ok(!/\/api\/empresas/.test(srcAll));
  assert.ok(!/emitirPorVendaId/.test(srcAll));
}

async function test17NaoExporSegredos() {
  const srcAll = src(FRONT_CLIENT) + src(FRONT_MODAL);
  assert.ok(!/localStorage\.setItem\(\s*['"]csc/.test(srcAll));
  assert.ok(client.CAMPOS_SECRETOS.includes('token_csc'));
  assert.ok(client.CAMPOS_SECRETOS.includes('senha_certificado'));
  const dtoSujo = dtoAbc();
  dtoSujo.token_csc = 'SEGREDO';
  assert.strictEqual(client.dtoContemSegredo(dtoSujo, 0), true);
  await assert.rejects(() => {
    const { fetchFn } = mockFetchSequencia([{ body: dtoSujo }]);
    return client.obterComprovanteJson(1, fetchFn);
  }, (err) => err.code === 'COMPROVANTE_COM_DADOS_SECRETOS');
}

async function test18CompatRotasExistentes() {
  const pdv = src(PDV_JS);
  const html = src(PDV_HTML);
  const rotas = src(ROTAS_ATD);
  assert.ok(pdv.includes("url: `${API_URL}/vendas`"));
  assert.ok(pdv.includes('mostrarModalImpressaoFiscal'));
  assert.ok(pdv.includes('notificarAtendimentoMuvSePresente'));
  assert.ok(html.includes('muv-comprovante-client.js'));
  assert.ok(html.includes('muv-comprovante-modal.js'));
  assert.ok(rotas.includes('/:id/comprovante'));
  assert.ok(rotas.includes('/:id/imprimir'));
  assert.ok(!html.includes('preview-comprovante'));
  assert.ok(!src(FRONT_CLIENT).includes('window.print'));
  assert.ok(!src(FRONT_MODAL).includes('window.print'));
}

async function run() {
  const testes = [
    test01CarregarPorAtendimentoId,
    test02PreviewHtml,
    test03MultiempresaAbc,
    test04ListaContinua,
    test05TotalOficial,
    test06PagamentoUnificado,
    test07DocumentosPorEmpresa,
    test08FiscalParcial,
    test09FiscalErro,
    test10Cancelado,
    test11SemDocumentos,
    test12ErroApi,
    test13PrepararBrowser,
    test14SemAlterarEstadoBackend,
    test15NaoDuplicarCalculo,
    test16SemChamadasDiretas,
    test17NaoExporSegredos,
    test18CompatRotasExistentes
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
