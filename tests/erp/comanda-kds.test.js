'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const conferencia = require('../../frontend/erp/js/mesas-conferencia');
const { criarImpressaoComanda, htmlComanda, registrarIpcComanda } = require('../../electron-comanda-kds');

function criarControle(despacho, imprimirComanda) {
  const controle = conferencia.criarConferencia({
    novaChave: () => 'chave',
    fetchJson: async () => ({
      preparacao: { estado: 'EM_PREPARACAO', enviado_em: '2026-01-01 12:00:00' },
      despacho
    }),
    carregarComanda: async () => ({
      snapshot_id: 5,
      html: htmlComanda({ itens: [{ nome: 'Pastel da rodada', qty_solicitada_millis: 2000 }] })
    }),
    imprimirComanda
  });
  controle.finalizar({ id: 40, mesa_id: 1, mesa_atendimento_id: 2, status: 'PEDIDO', itens: [] });
  return controle;
}

const concluido = { success: true, status: 'CONCLUIDO', pedido_id: 40, unidade_id: 3, rodada_id: 9 };

test('comanda ordena os tipos sem alterar os itens e sinaliza composição ausente', () => {
  const itens = [
    { nome: 'Sobremesa', tipo_item: 'OUTRO', qty_solicitada_millis: 1000 },
    { nome: 'Pastel', tipo_item: 'PASTEL', qty_solicitada_millis: 2000, composicao_confiavel: true,
      ingredientes: [
        { nome: 'Massa', quantidade_snapshot_millis: 100, unidade: 'kg', classificacao: 'OBRIGATORIO_OCULTO', selecionado: 1 },
        { nome: 'Queijo', quantidade_snapshot_millis: 50, unidade: 'kg', classificacao: 'OPCIONAL_COM_ADICIONAL', selecionado: 1 },
        { nome: 'Cebola', quantidade_snapshot_millis: 10, unidade: 'kg', classificacao: 'OPCIONAL', selecionado: 0 }
      ] },
    { nome: 'Refrigerante', tipo_item: 'BEBIDA', qty_solicitada_millis: 1000 },
    { nome: 'Pastel sem ficha', tipo_item: 'PASTEL', qty_solicitada_millis: 1000 },
    { nome: 'Histórico', qty_solicitada_millis: 1000 }
  ];
  const original = JSON.stringify(itens);
  for (const ordem of [itens, [...itens].reverse()]) {
    const html = htmlComanda({ itens: ordem });
    assert.ok(html.indexOf('Refrigerante') < html.indexOf('Pastel</strong>'));
    assert.ok(html.indexOf('Pastel</strong>') < html.indexOf('Sobremesa'));
    assert.match(html, /Opcional selecionado: Queijo/);
    assert.match(html, /Não selecionado: Cebola/);
    assert.doesNotMatch(html, /Retirado: Cebola/);
    assert.match(html, /Composição confiável não registrada/);
    assert.match(html, /Classificação e composição não registradas/);
    assert.match(html, /width:76mm/);
  }
  assert.equal(JSON.stringify(itens), original);
});

test('popup não duplica e só imprime após carregar e confirmar', async () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');
  const trecho = fonte.slice(fonte.indexOf('  function abrirPreviaComanda('), fonte.indexOf('\n  async function carregarComandaKds('));
  const janelasComanda = new Map();
  const atual = { etapa: 'pergunta', snapshotId: 5, html: '<p>Comanda</p>' };
  let impressas = 0;
  let aberturas = 0;
  let popup;
  const conferencia = {
    estado: { impressao: atual },
    naoImprimir() { this.estado.impressao = null; },
    async imprimir() { impressas += 1; atual.etapa = 'aceita'; atual.mensagem = 'Simulado'; }
  };
  function elemento() {
    return { eventos: {}, addEventListener(tipo, fn) { this.eventos[tipo] = fn; }, setAttribute() {} };
  }
  const contexto = {
    janelasComanda, conferencia, pintarConferencia() {}, setTimeout: () => 1, clearTimeout() {},
    window: { open() {
      aberturas += 1;
      const sim = elemento();
      const nao = elemento();
      const mensagem = elemento();
      const quadro = elemento();
      popup = {
        closed: false, eventos: {}, focus() {},
        addEventListener(tipo, fn) { this.eventos[tipo] = fn; },
        close() { this.closed = true; if (this.eventos.beforeunload) this.eventos.beforeunload(); },
        document: {
          body: {}, createElement: () => quadro,
          getElementById(id) { return { sim, nao, mensagem, comanda: { appendChild() {} } }[id]; }
        },
        sim, nao, mensagem, quadro
      };
      return popup;
    } }
  };
  const abrir = vm.runInNewContext(`(${trecho.trim()})`, contexto);
  abrir(atual);
  abrir(atual);
  assert.equal(aberturas, 1);
  assert.equal(popup.quadro.srcdoc, atual.html);
  await popup.sim.eventos.click();
  assert.equal(impressas, 0);
  popup.quadro.eventos.load();
  assert.match(popup.mensagem.textContent, /Deseja imprimir/);
  popup.nao.eventos.click();
  assert.equal(impressas, 0);
  assert.equal(conferencia.estado.impressao, null);
  assert.equal(janelasComanda.size, 0);

  atual.etapa = 'pergunta';
  conferencia.estado.impressao = atual;
  abrir(atual);
  popup.quadro.eventos.load();
  await popup.sim.eventos.click();
  assert.equal(impressas, 1);
  assert.equal(atual.etapa, 'aceita');
});

test('pergunta somente quando o despacho correto é efetivamente concluído', async () => {
  for (const despacho of [
    { success: false, status: 'BLOQUEADO' },
    { success: false, status: 'CONCLUIDO', pedido_id: 40, unidade_id: 3, rodada_id: 9 },
    { ...concluido, pedido_id: 41 },
    { ...concluido, rodada_id: null }
  ]) {
    const controle = criarControle(despacho);
    await controle.enviar();
    assert.doesNotMatch(controle.html(), /Deseja imprimir a comanda/);
    if (despacho.success) assert.match(controle.html(), /dados da rodada.*incompletos/);
  }
  const controle = criarControle(concluido);
  await controle.enviar();
  assert.match(controle.html(), /Deseja imprimir a comanda/);
  assert.match(controle.html(), /Prévia da comanda/);
  assert.match(controle.html(), /Pastel da rodada/);
});

test('resposta atrasada da lista não abre a comanda em outro pedido', async () => {
  let liberarLista;
  let liberarComanda;
  let carregamentos = 0;
  const controle = conferencia.criarConferencia({
    novaChave: () => 'chave',
    fetchJson: async () => ({
      preparacao: { estado: 'EM_PREPARACAO', enviado_em: '2026-01-01 12:00:00' },
      despacho: concluido
    }),
    listarPedidos: () => new Promise((resolve) => { liberarLista = resolve; }),
    carregarComanda: () => {
      carregamentos += 1;
      return new Promise((resolve) => { liberarComanda = resolve; });
    }
  });
  controle.finalizar({ id: 40, mesa_id: 1, mesa_atendimento_id: 2, status: 'PEDIDO', itens: [] });
  const envio = controle.enviar();
  await new Promise((resolve) => setImmediate(resolve));
  controle.finalizar({ id: 41, mesa_id: 1, mesa_atendimento_id: 2, status: 'PEDIDO', itens: [] });
  liberarComanda({ snapshot_id: 5, html: '<p>Comanda</p>' });
  liberarLista({ pedidos: [] });
  assert.equal((await envio).obsoleta, true);
  assert.equal(carregamentos, 1);
  assert.equal(controle.estado.pedido.id, 41);
  assert.equal(controle.estado.impressao, null);
});

test('exibe carregamento e prévia sem aguardar lista e evita consulta duplicada', async () => {
  let liberarLista;
  let liberarComanda;
  let consultas = 0;
  const telas = [];
  const controle = conferencia.criarConferencia({
    novaChave: () => 'chave',
    fetchJson: async () => ({
      preparacao: { estado: 'EM_PREPARACAO', enviado_em: '2026-01-01 12:00:00' },
      despacho: concluido
    }),
    listarPedidos: () => new Promise((resolve) => { liberarLista = resolve; }),
    carregarComanda: () => {
      consultas += 1;
      return new Promise((resolve) => { liberarComanda = resolve; });
    },
    aoAtualizar: () => telas.push(controle.html())
  });
  controle.finalizar({ id: 40, mesa_id: 1, mesa_atendimento_id: 2, status: 'PEDIDO', itens: [] });
  const envio = controle.enviar();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(telas.at(-1), /Carregando comanda/);
  assert.match(telas.at(-1), /Pedido enviado ao KDS/);
  assert.doesNotMatch(telas.at(-1), /Deseja imprimir a comanda/);
  await controle.perguntarImpressao();
  assert.equal(consultas, 1);
  liberarComanda({ snapshot_id: 5, html: '<p>Comanda original</p>' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(telas.at(-1), /Comanda original/);
  assert.match(telas.at(-1), /Deseja imprimir a comanda/);
  liberarLista({ pedidos: [] });
  assert.equal((await envio).ok, true);
});

test('consulta a comanda com autenticação e trata timeout', async () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');
  const trecho = fonte.slice(fonte.indexOf('  async function carregarComandaKds('), fonte.indexOf('\n  const conferencia ='));
  let expirar;
  let requisicao;
  let limpar = 0;
  const contexto = {
    API_URL: 'http://localhost:3001/api',
    _pedHeaders: () => ({ Authorization: 'Bearer simulado', 'X-Empresa-Id': '1' }),
    AbortController,
    setTimeout: (callback, ms) => { assert.equal(ms, 15000); expirar = callback; return 1; },
    clearTimeout: () => { limpar += 1; },
    fetch: (url, opts) => {
      requisicao = { url, opts };
      return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('abortado'))));
    }
  };
  const carregar = vm.runInNewContext(`(${trecho.trim()})`, contexto);
  const pendente = carregar(40);
  assert.equal(requisicao.url, 'http://localhost:3001/api/pedidos/40/comanda-kds');
  assert.equal(requisicao.opts.headers.Authorization, 'Bearer simulado');
  expirar();
  await assert.rejects(pendente, /Tempo esgotado/);
  assert.equal(limpar, 1);
  contexto.fetch = async () => ({ ok: true, json: async () => ({ snapshot_id: 5, html: '<p>Original</p>' }) });
  assert.equal((await carregar(40)).snapshot_id, 5);
  assert.equal(limpar, 2);
});

test('confirmação espera o iframe e falha de exibição permite tentar novamente', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');
  const trecho = fonte.slice(fonte.indexOf('  function pintarConferencia()'), fonte.indexOf('\n  async function enviarPreparacao('));
  const atual = { etapa: 'pergunta', snapshotId: 5, html: '<p>Original</p>' };
  const confirmacao = { hidden: false };
  let aoCarregar;
  let expirar;
  let rolagens = 0;
  let limpezas = 0;
  const previa = {
    addEventListener: (_evento, callback) => { aoCarregar = callback; },
    scrollIntoView: () => { rolagens += 1; }
  };
  const host = {
    querySelector: (seletor) => atual.html ? (seletor.startsWith('iframe') ? previa : confirmacao) : null,
    contains: (elemento) => elemento === previa
  };
  const contexto = {
    document: { getElementById: () => host },
    conferencia: { estado: { impressao: atual }, html: () => '<div></div>' },
    setTimeout: (callback, ms) => { assert.equal(ms, 15000); expirar = callback; return 1; },
    clearTimeout: () => { limpezas += 1; }
  };
  const pintar = vm.runInNewContext(`(${trecho.trim()})`, contexto);
  contexto.pintarConferencia = pintar;
  pintar();
  assert.equal(confirmacao.hidden, true);
  aoCarregar();
  assert.equal(confirmacao.hidden, false);
  assert.equal(rolagens, 1);
  assert.equal(limpezas, 1);
  pintar();
  expirar();
  assert.equal(atual.etapa, 'falha_previa');
  assert.equal(atual.html, null);
  assert.equal(atual.snapshotId, 5);
  assert.match(atual.mensagem, /Tente novamente/);
});

test('não imprime ao escolher não; falha e retry nunca repetem despacho', async () => {
  let impressao = 0;
  const controle = criarControle(concluido, async () => {
    impressao += 1;
    return impressao === 1 ? { estado: 'FALHA', detalhe: 'Sem papel' } : { estado: 'ACEITA_PELO_SPOOLER' };
  });
  await controle.enviar();
  controle.naoImprimir();
  assert.equal(impressao, 0);
  await controle.perguntarImpressao();
  assert.equal((await controle.imprimir()).ok, false);
  assert.match(controle.html(), /Sem papel/);
  assert.equal((await controle.imprimir()).ok, true);
  assert.match(controle.html(), /impressão física não foi confirmada/);
  assert.equal((await controle.enviar()).codigo, 'DESPACHO_JA_CONCLUIDO');
  assert.equal(impressao, 2);
});

test('prévia indisponível não imprime nem desfaz o despacho', async () => {
  let impressao = 0;
  let consultas = 0;
  const controle = conferencia.criarConferencia({
    novaChave: () => 'chave',
    fetchJson: async () => ({
      preparacao: { estado: 'EM_PREPARACAO', enviado_em: '2026-01-01 12:00:00' },
      despacho: concluido
    }),
    carregarComanda: async () => {
      consultas += 1;
      if (consultas === 1) throw new Error('Sem acesso ao snapshot');
      return { snapshot_id: 5, html: '<p>Comanda original</p>' };
    },
    imprimirComanda: async () => { impressao += 1; }
  });
  controle.finalizar({ id: 40, mesa_id: 1, mesa_atendimento_id: 2, status: 'PEDIDO', itens: [] });
  assert.equal((await controle.enviar()).ok, true);
  assert.match(controle.html(), /Sem acesso ao snapshot/);
  assert.equal((await controle.imprimir()).ignorada, true);
  assert.equal(impressao, 0);
  assert.equal(controle.estado.pedido.despacho.status, 'CONCLUIDO');
  await controle.perguntarImpressao();
  assert.match(controle.html(), /Comanda original/);
  assert.equal(controle.estado.impressao.snapshotId, 5);
  assert.equal((await controle.enviar()).codigo, 'DESPACHO_JA_CONCLUIDO');
});

test('ignora cliques simultâneos durante a impressão', async () => {
  let resolver;
  let chamadas = 0;
  const controle = criarControle(concluido, () => {
    chamadas += 1;
    return new Promise((resolve) => { resolver = resolve; });
  });
  await controle.enviar();
  const primeira = controle.imprimir();
  assert.equal((await controle.imprimir()).ignorada, true);
  resolver({ estado: 'ACEITA_PELO_SPOOLER' });
  await primeira;
  assert.equal(chamadas, 1);
});

test('adapter imprime apenas snapshot, registra falha e reimprime o mesmo conteúdo', async () => {
  const snapshot = {
    mesa_numero: 7, pedido_id: 22, numero_rodada: 2, garcom: 'Ana',
    enviada_em: '2026-01-01 12:00:00',
    itens: [{ nome: '<Pastel adicional>', qty_solicitada_millis: 2000, numero_comanda: 4, observacao: 'sem sal' }]
  };
  const chamadas = [];
  const impressos = [];
  let falhar = true;
  const imprimir = criarImpressaoComanda({
    requisitarBackend: async (url, sessao, method, body) => {
      chamadas.push({ url, method, body });
      if (url.endsWith('/tentativas')) return { tentativa_id: chamadas.length, snapshot };
      if (url.includes('impressora_cupom')) return { caminho: 'SIMULADA' };
      return { success: true };
    },
    imprimir: async (html) => {
      impressos.push(html);
      if (falhar) { falhar = false; throw new Error('impressora indisponível'); }
    }
  });
  assert.equal((await imprimir(5, {})).estado, 'FALHA');
  assert.equal((await imprimir(5, {})).estado, 'ACEITA_PELO_SPOOLER');
  assert.equal(impressos[0], impressos[1]);
  assert.match(impressos[0], /&lt;Pastel adicional&gt;/);
  assert.match(impressos[0], /sem sal/);
  assert.doesNotMatch(impressos[0], /item anterior/);
  assert.equal(chamadas.filter((c) => c.body && c.body.estado === 'FALHA').length, 1);
  assert.equal(chamadas.filter((c) => c.body && c.body.estado === 'ACEITA_PELO_SPOOLER').length, 1);
  assert.ok(chamadas.every((c) => !c.url.includes('preparacao/enviar')));
  assert.equal(htmlComanda(snapshot), impressos[0]);
});

test('IPC aceita somente janela e origem autorizadas e encaminha apenas referência', async () => {
  const handlers = {};
  const frame = { url: 'http://127.0.0.1:3001/erp' };
  const sender = { id: 5, mainFrame: frame };
  const janela = { webContents: sender, isDestroyed: () => false };
  const chamadas = [];
  registrarIpcComanda({
    ipcMain: { handle: (canal, fn) => { handlers[canal] = fn; } },
    obterJanela: () => janela,
    obterBaseUrl: () => 'http://127.0.0.1:3001',
    imprimirSnapshot: async (...args) => { chamadas.push(args); return { estado: 'ACEITA_PELO_SPOOLER' }; }
  });
  const evento = { sender, senderFrame: frame };
  assert.throws(() => handlers['comanda-kds:sessao'](
    { sender: {}, senderFrame: frame }, { token: 'token', empresaId: 1 }
  ), /não autorizada/);
  frame.url = 'http://outro-host/erp';
  assert.throws(() => handlers['comanda-kds:sessao'](evento, { token: 'token', empresaId: 1 }), /Origem/);
  frame.url = 'http://127.0.0.1:3001/erp';
  assert.equal(handlers['comanda-kds:sessao'](evento, { token: 'token', empresaId: 1 }).success, true);
  assert.equal((await handlers['comanda-kds:imprimir'](evento, 17)).estado, 'ACEITA_PELO_SPOOLER');
  assert.deepEqual(chamadas, [[17, { token: 'token', empresaId: 1 }]]);
  await assert.rejects(handlers['comanda-kds:imprimir'](evento, 17), /Sessão/);
});

test('resultado incerto não é registrado como falha nem repetido automaticamente', async () => {
  const chamadas = [];
  const imprimir = criarImpressaoComanda({
    requisitarBackend: async (url) => {
      chamadas.push(url);
      if (url.endsWith('/tentativas')) return {
        tentativa_id: 1, snapshot: { itens: [{ nome: 'Pastel', qty_solicitada_millis: 1000 }] }
      };
      return { caminho: 'SIMULADA' };
    },
    imprimir: async () => {
      const err = new Error('Sem resposta');
      err.codigo = 'RESULTADO_INCERTO';
      throw err;
    }
  });
  await assert.rejects(imprimir(1, {}), /desconhecido/);
  assert.equal(chamadas.length, 2);
  assert.equal(chamadas.some((url) => url.endsWith('/tentativas/1')), false);
});
