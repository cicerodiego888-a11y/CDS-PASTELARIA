'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const kds = require('../../frontend/erp/js/cozinha-kds');

function ambiente(tipo) {
  const timers = new Map();
  const eventos = {};
  const requisicoes = [];
  const host = {
    textContent: '',
    atributos: {},
    getAttribute: () => tipo,
    setAttribute: function (chave, valor) { this.atributos[chave] = valor; }
  };
  let proximo = 0;
  const window = {
    document: { getElementById: (id) => id === 'cds-rede-status' ? host : null },
    location: { origin: 'http://cds-loja.local:3002' },
    console,
    addEventListener: (evento, fn) => { eventos[evento] = fn; },
    setTimeout: (fn) => { const id = ++proximo; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    XMLHttpRequest: class {
      constructor() { requisicoes.push(this); }
      open(method, url) { this.method = method; this.url = url; }
      send() {}
      abort() { this.abortado = true; }
      responder(status, texto, responseURL = 'http://cds-loja.local:3002/cozinha') {
        this.status = status;
        this.responseText = texto;
        this.responseURL = responseURL;
        this.onload();
      }
    }
  };
  const script = fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/cds-empresa-contexto.js'), 'utf8');
  vm.runInNewContext(script, { window, URL, Promise, Date, console });
  return {
    window, host, requisicoes, eventos,
    proximaConsulta() {
      const entrada = timers.entries().next().value;
      assert.ok(entrada);
      timers.delete(entrada[0]);
      entrada[1]();
    }
  };
}

test('TV mostra busca, queda, indisponibilidade e recuperação sem reenviar operações', async () => {
  const a = ambiente('kds');
  let consultas = 0;
  a.window.CdsCozinhaKds = {
    estado: { modo: 'painel' },
    atualizar: async () => { consultas += 1; }
  };
  assert.equal(a.host.atributos['data-estado'], 'procurando');
  assert.equal(a.requisicoes[0].method, 'GET');
  assert.match(a.requisicoes[0].url, /^\/cozinha\?cds_rede=/);
  a.requisicoes[0].responder(200, '<section id="tv-acesso"></section>');
  assert.equal(a.host.atributos['data-estado'], 'conectado');
  a.proximaConsulta();
  a.requisicoes[1].onerror();
  assert.equal(a.host.atributos['data-estado'], 'reconectando');
  a.proximaConsulta();
  a.requisicoes[2].ontimeout();
  a.proximaConsulta();
  a.requisicoes[3].responder(503, '');
  assert.equal(a.host.atributos['data-estado'], 'indisponivel');
  a.eventos.online();
  assert.equal(a.host.atributos['data-estado'], 'reconectando');
  a.requisicoes[4].responder(200, '<section id="tv-acesso"></section>');
  await Promise.resolve();
  assert.equal(a.host.atributos['data-estado'], 'conectado');
  assert.equal(consultas, 1);
  assert.ok(a.requisicoes.every((r) => r.method === 'GET'));
  a.proximaConsulta();
  a.eventos.pagehide();
  assert.equal(a.requisicoes[5].abortado, true);
  a.eventos.pageshow();
  assert.equal(a.host.atributos['data-estado'], 'procurando');
  a.eventos.pagehide();
});

test('mobile verifica apenas a origem atual e não considera respostas estranhas como CDS', () => {
  const a = ambiente('mobile');
  assert.match(a.requisicoes[0].url, /^\/api\/ping\?cds_rede=/);
  a.requisicoes[0].responder(200, '{"status":"ok"}', 'http://outro.local:3002/api/ping');
  assert.equal(a.host.atributos['data-estado'], 'reconectando');
  a.proximaConsulta();
  a.requisicoes[1].responder(200, '<html>portal</html>', 'http://cds-loja.local:3002/api/ping');
  assert.equal(a.host.atributos['data-estado'], 'reconectando');
  a.proximaConsulta();
  a.requisicoes[2].responder(200, '{"status":"ok"}', 'http://cds-loja.local:3002/api/ping');
  assert.equal(a.host.atributos['data-estado'], 'conectado');
  assert.ok(a.requisicoes.every((r) => r.method === 'GET'));
  a.eventos.pagehide();
});

test('recuperação do KDS consulta o painel sem repetir uma ação que falhou', async () => {
  const chamadas = [];
  const controle = kds.criarControlador({
    fetchJson: async (method, url) => {
      chamadas.push({ method, url });
      if (method === 'POST') throw new Error('Rede interrompida');
      return { rodadas: [{ id: 1, itens: [{ id: 12, estado_preparacao: 'AGUARDANDO' }] }] };
    }
  });
  await controle.iniciar({ unidadeJwt: 3 });
  const a = ambiente('kds');
  a.window.CdsCozinhaKds = controle;
  a.requisicoes[0].responder(200, '<section id="tv-acesso"></section>');
  await controle.operarItem(12, 'iniciar');
  a.proximaConsulta();
  a.requisicoes[1].onerror();
  a.proximaConsulta();
  a.requisicoes[2].responder(200, '<section id="tv-acesso"></section>');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chamadas.filter((chamada) => chamada.method === 'POST').length, 1);
  assert.equal(chamadas.filter((chamada) => chamada.method === 'GET').length, 2);
  controle.parar();
  a.eventos.pagehide();
});

test('TV recupera seleção de unidade mesmo quando a conexão inicial falhou', async () => {
  const a = ambiente('kds');
  let consultas = 0;
  let acoes = 0;
  a.window.CdsCozinhaKds = {
    estado: { modo: 'selecao', selecaoFalhaLista: true },
    carregarUnidadesDisponiveis: async () => { consultas += 1; },
    atualizar: async () => { acoes += 1; }
  };
  a.requisicoes[0].onerror();
  a.proximaConsulta();
  a.requisicoes[1].responder(200, '<section id="tv-acesso"></section>');
  await Promise.resolve();
  assert.equal(consultas, 1);
  assert.equal(acoes, 0);
  a.eventos.pagehide();
});

test('TV limita somente consultas GET pendentes e não repete ações', async () => {
  const timers = [];
  const chamadas = [];
  const host = { innerHTML: '', querySelector: () => null };
  const global = {
    document: { getElementById: (id) => id === 'cds-rede-status' ? {} : host },
    localStorage: { getItem: () => null },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    fetch: (_url, opcoes) => {
      chamadas.push(opcoes.method);
      if (opcoes.method === 'GET') return new Promise(() => {});
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
  };
  const controle = kds.montarNoNavegador(global);
  const inicio = controle.iniciar(host, { unidadeJwt: 3 });
  const limite = timers.find((timer) => timer.ms === 10000);
  assert.ok(limite);
  limite.fn();
  await inicio;
  assert.match(controle.estado.erro, /Tempo esgotado/);
  assert.deepEqual(chamadas, ['GET']);
  controle.parar();
});

test('hostname mantido recupera consultas quando DNS simulado muda de IPv4', async () => {
  const acessos = [];
  function servidor(nome) {
    return http.createServer((req, res) => {
      acessos.push({ nome, metodo: req.method, host: req.headers.host });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"status":"ok"}');
    });
  }
  const primeiro = servidor('primeiro');
  const segundo = servidor('segundo');
  await new Promise((resolve, reject) => primeiro.once('error', reject).listen(0, '127.0.0.1', resolve));
  const porta = primeiro.address().port;
  try {
    await new Promise((resolve, reject) => segundo.once('error', reject).listen(porta, '127.0.0.2', resolve));
    let endereco = '127.0.0.1';
    let timer;
    let estado;
    let mudou;
    const window = {
      document: { getElementById: () => null },
      location: { origin: `http://cds-loja.local:${porta}` },
      setTimeout: (fn) => { timer = fn; return 1; },
      clearTimeout: () => { timer = null; },
      XMLHttpRequest: class {
        open(method, url) { this.method = method; this.url = url; }
        send() {
          this.req = http.request({
            hostname: 'cds-loja.local', port: porta, path: this.url, method: this.method,
            agent: false, family: 4, lookup: (_hostname, _options, cb) => cb(null, endereco, 4)
          }, (res) => {
            let texto = '';
            res.setEncoding('utf8');
            res.on('data', (parte) => { texto += parte; });
            res.on('end', () => {
              this.status = res.statusCode;
              this.responseText = texto;
              this.responseURL = window.location.origin + this.url;
              this.onload();
            });
          });
          this.req.on('error', () => this.onerror());
          this.req.end();
        }
        abort() { this.req.destroy(); }
      }
    };
    const script = fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/cds-empresa-contexto.js'), 'utf8');
    vm.runInNewContext(script, { window, URL, Promise, Date, console });
    const esperar = () => new Promise((resolve) => { mudou = resolve; });
    const monitor = window.CdsEstadoRede.criarMonitor({
      tipo: 'mobile', caminho: '/api/ping',
      aoMudar(novo) { estado = novo; if (mudou) { const fim = mudou; mudou = null; fim(); } }
    });
    let transicao = esperar();
    monitor.iniciar();
    await transicao;
    if (estado === 'procurando') { transicao = esperar(); await transicao; }
    assert.equal(estado, 'conectado');
    await new Promise((resolve) => primeiro.close(resolve));
    transicao = esperar();
    timer();
    await transicao;
    assert.equal(estado, 'reconectando');
    endereco = '127.0.0.2';
    transicao = esperar();
    timer();
    await transicao;
    assert.equal(estado, 'conectado');
    assert.deepEqual(acessos.map((item) => item.nome), ['primeiro', 'segundo']);
    assert.ok(acessos.every((item) => item.metodo === 'GET' && item.host === `cds-loja.local:${porta}`));
    monitor.parar();
  } finally {
    if (primeiro.listening) await new Promise((resolve) => primeiro.close(resolve));
    if (segundo.listening) await new Promise((resolve) => segundo.close(resolve));
  }
});
