const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '../..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

require('../../frontend/erp/js/mesas-painel.js');
require('../../frontend/erp/js/mesas-conferencia.js');
const MobileMesas = require('../../frontend/mobile-mesas/mobile-mesas.js');

const itens = [
  { id: 1, numero: 1, ativo: true, situacao: 'LIVRE', atendimento: null },
  { id: 2, numero: 2, ativo: true, situacao: 'OCUPADA', atendimento: { id: 9, aberto_em: '2026-01-01 10:00:00', operador_abertura_id: 3 } },
  { id: 3, numero: 3, ativo: true, situacao: 'FECHAMENTO', atendimento: { id: 10, aberto_em: '2026-01-01 10:00:00', operador_abertura_id: 3 } }
];

test('MESAS-06 acesso pelo menu e rota mobile', () => {
  assert.match(ler('frontend/mobile/index.html'), /href="\/mobile-mesas\/"/);
  assert.match(ler('backend/server.js'), /'\/mobile-mesas'/);
  assert.ok(fs.existsSync(path.join(RAIZ, 'frontend/mobile-mesas/index.html')));
  assert.match(ler('frontend/shared/js/pdv-acesso-oficial.js'), /'\/mobile-mesas'/);
});

test('MESAS-06 lista: cartões com número, estado e área de toque', () => {
  const html = MobileMesas.htmlLista({ itens, aviso: '', sucesso: '' }, {});
  assert.equal((html.match(/data-acao="abrir-mesa"/g) || []).length, 3);
  assert.match(html, /Livre/);
  assert.match(html, /Ocupada/);
  assert.match(html, /echamento/);
  assert.match(html, /Permanência/);
});

test('MESAS-06 lista vazia aguarda conexão em vez de afirmar ausência de mesas', () => {
  const html = MobileMesas.htmlLista({ itens: [] }, { rede: true });
  assert.match(html, /Aguardando a conexão/);
});

test('MESAS-06 detalhe: livre abre atendimento; ocupada lança e consulta; fechamento é leitura', () => {
  const livre = MobileMesas.htmlDetalhe({ itens, mesaSelecionadaId: 1, detalhe: null, pedidos: [] }, {});
  assert.match(livre, /data-acao="abrir"/);
  assert.doesNotMatch(livre, /data-acao="lancar"/);

  const ocupada = MobileMesas.htmlDetalhe({
    itens, mesaSelecionadaId: 2, detalhe: { situacao: 'OCUPADA', numero: 2, atendimento: itens[1].atendimento },
    pedidos: [{ id: 5, codigo: 'PED-5', status: 'PEDIDO', preparacao: { estado: 'NAO_ENVIADO' } }]
  }, {});
  assert.match(ocupada, /data-acao="lancar"/);
  assert.match(ocupada, /data-acao="pedido"/);
  assert.match(ocupada, /PED-5/);

  const fech = MobileMesas.htmlDetalhe({
    itens, mesaSelecionadaId: 3, detalhe: { situacao: 'FECHAMENTO', numero: 3, atendimento: itens[2].atendimento },
    pedidos: [{ id: 6, codigo: 'PED-6', status: 'PEDIDO', preparacao: { estado: 'NAO_ENVIADO' } }]
  }, {});
  assert.doesNotMatch(fech, /data-acao="lancar"/);
  assert.doesNotMatch(fech, /data-acao="pedido"/);
  assert.match(fech, /somente leitura/);
});

test('MESAS-06 rede: falha não confirma a operação e se recupera sozinha', async () => {
  const mudancas = [];
  let falha = true;
  const global = {
    location: { origin: 'http://x' },
    fetch: async () => {
      if (falha) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
  const rede = MobileMesas.criarRede(global, (offline) => mudancas.push(offline));
  await assert.rejects(rede.requisitar('POST', '/mesas/1/atendimento', {}, 'k1'), (e) => e.rede === true && e.message === MobileMesas.MSG_REDE);
  assert.equal(rede.estado.offline, true);
  assert.match(MobileMesas.MSG_REDE, /não foi confirmada/);
  falha = false;
  await rede.requisitar('GET', '/mesas/situacao');
  assert.equal(rede.estado.offline, false);
  assert.deepEqual(mudancas, [true, false]);
});

test('MESAS-06 rede: 401 é sinalizado e a chave de idempotência segue no cabeçalho', async () => {
  let cabecalhos;
  const global = {
    location: { origin: 'http://x' },
    CdsEmpresaContexto: { headersJson: () => ({ Authorization: 'Bearer t', 'X-Empresa-Id': '1' }) },
    fetch: async (_u, opcoes) => { cabecalhos = opcoes.headers; return { ok: false, status: 401, json: async () => ({ mensagem: 'Sessão expirada.' }) }; }
  };
  const rede = MobileMesas.criarRede(global);
  await assert.rejects(rede.requisitar('POST', '/x', {}, 'chave-1'), (e) => e.autenticacao === true);
  assert.equal(cabecalhos['Idempotency-Key'], 'chave-1');
  assert.equal(cabecalhos['X-Empresa-Id'], '1');
});

test('MESAS-06 sessão inválida: 401 e 403 SESSAO_INVALIDA levam ao login; outros 403 não', async () => {
  assert.equal(MobileMesas.sessaoInvalida({ status: 401 }), true);
  assert.equal(MobileMesas.sessaoInvalida({ status: 403, code: 'SESSAO_INVALIDA' }), true);
  assert.equal(MobileMesas.sessaoInvalida({ status: 403, codigo: 'SESSAO_INVALIDA' }), true);
  assert.equal(MobileMesas.sessaoInvalida({ status: 403, code: 'RECURSO_NAO_LICENCIADO' }), false);
  assert.equal(MobileMesas.sessaoInvalida(null), false);
  const global = {
    location: { origin: 'http://x' },
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'Token inválido ou expirado', code: 'SESSAO_INVALIDA' }) })
  };
  const rede = MobileMesas.criarRede(global);
  await assert.rejects(rede.requisitar('GET', '/mesas/situacao'), (e) => e.autenticacao === true);
});

test('MESAS-06 atualização da tela: o estado vem da URL, sem criar atendimento ou pedido', () => {
  const global = { URLSearchParams, location: { search: '?mesa=4&pedido=12' } };
  assert.deepEqual(MobileMesas.parametrosDaUrl(global), { mesa: 4, pedido: 12 });
  assert.deepEqual(MobileMesas.parametrosDaUrl({ URLSearchParams, location: { search: '?mesa=abc' } }), { mesa: null, pedido: null });
  assert.match(ler('frontend/mobile-mesas/mobile-mesas.js'), /replaceState/);
});

test('MESAS-06 o cliente nunca envia empresa, operador ou atendimento como autoridade', () => {
  for (const rel of ['frontend/mobile-mesas/mobile-mesas.js', 'frontend/mobile-pedido/mobile-pedido.js']) {
    const fonte = ler(rel);
    assert.doesNotMatch(fonte, /(^|[{,]\s*)mesa_atendimento_id\s*:/m, rel);
    assert.doesNotMatch(fonte, /\boperador_id\s*:/, rel);
    assert.doesNotMatch(fonte, /\bempresa_id\s*:/, rel);
  }
  assert.match(ler('frontend/mobile-pedido/mobile-pedido.js'), /mesa_id: estado\.mesaId \? Number\(estado\.mesaId\) : null/);
});

test('MESAS-06 mobile-pedido em modo mesa: valida atendimento, bloqueia e guarda rascunho separado', () => {
  const mp = ler('frontend/mobile-pedido/mobile-pedido.js');
  assert.match(mp, /mesaBloqueada/);
  assert.match(mp, /ATENDIMENTO_EM_FECHAMENTO/);
  assert.match(mp, /ATENDIMENTO_NAO_ABERTO/);
  assert.match(mp, /consultarMesa/);
  assert.match(ler('frontend/shared/js/cds-mobile-operacao.js'), /':mesa:'/);
});

test('MESAS-06 o shell reutiliza o controlador e a conferência do desktop sem duplicar APIs', () => {
  const fonte = ler('frontend/mobile-mesas/mobile-mesas.js');
  assert.match(fonte, /criarControlador/);
  assert.match(fonte, /criarConferencia/);
  assert.doesNotMatch(fonte, /venda-consolidada/);
  const html = ler('frontend/mobile-mesas/index.html');
  assert.match(html, /mesas-painel\.js/);
  assert.match(html, /mesas-conferencia\.js/);
  assert.match(html, /viewport-fit=cover/);
  const css = ler('frontend/mobile-mesas/mobile-mesas.css');
  assert.match(css, /safe-area-inset/);
  assert.match(css, /overflow-x:\s*hidden/);
});
