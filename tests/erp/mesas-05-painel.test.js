/**
 * MESAS-05 — painel desktop de mesas, sem navegador e sem banco oficial.
 *
 * Executar: node --test --test-concurrency=1 tests/erp/mesas-05-painel.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const painel = require('../../frontend/erp/js/mesas-painel.js');

const AGORA = new Date('2026-11-02T12:10:00Z');
const ABERTO = '2026-11-02 12:00:00';

function itensEmpresa() {
  return [
    { id: 1, empresa_id: 1, numero: 1, ativo: true, situacao: 'LIVRE', atendimento: null },
    {
      id: 2, empresa_id: 1, numero: 2, ativo: true, situacao: 'OCUPADA',
      atendimento: { id: 9, estado: 'OCUPADA', cliente_id: 5, operador_abertura_id: 8, aberto_em: ABERTO }
    },
    {
      id: 3, empresa_id: 1, numero: 3, ativo: true, situacao: 'FECHAMENTO',
      atendimento: { id: 10, estado: 'FECHAMENTO', cliente_id: null, operador_abertura_id: 8, aberto_em: '2026-11-02 11:00:00' }
    },
    {
      id: 9, empresa_id: 2, numero: 9, ativo: true, situacao: 'OCUPADA',
      atendimento: { id: 99, estado: 'OCUPADA', cliente_id: 7, operador_abertura_id: 3, aberto_em: ABERTO }
    }
  ];
}

function pedidosMesa() {
  return {
    pedidos: [{
      id: 40,
      codigo: 'PED-40',
      status: 'PEDIDO',
      total: 25,
      preparacao: {
        estado: 'EM_PREPARACAO',
        classificacao: 'ATRASADO',
        enviado_em: ABERTO,
        concluido_em: null,
        tempo_decorrido_segundos: 600
      }
    }]
  };
}

function adiar() {
  let resolver;
  let rejeitar;
  const promise = new Promise((resolve, reject) => {
    resolver = resolve;
    rejeitar = reject;
  });
  return { promise, resolver, rejeitar };
}

function montar(fetchJson, extra = {}) {
  const fila = [];
  const control = painel.criarControlador({
    empresaId: 1,
    empresaRotulo: 'Pastelaria Centro',
    agora: () => AGORA,
    intervaloMs: 5000,
    fetchJson,
    agendar(fn, ms) {
      const item = { fn, ms, ativo: true };
      fila.push(item);
      return item;
    },
    cancelar(item) { if (item) item.ativo = false; },
    ...extra
  });
  return { control, fila };
}

describe('grade e modal', () => {
  it('mostra as mesas da empresa, os três estados e os contadores', () => {
    const estado = {
      empresaRotulo: 'Pastelaria Centro',
      itens: painel.filtrarEmpresa(itensEmpresa(), 1),
      mesaSelecionadaId: null,
      pedidos: [],
      detalhe: null,
      destinoId: '',
      clienteId: '',
      aviso: '',
      sucesso: ''
    };
    const html = painel.htmlPainel(estado, AGORA);
    assert.match(html, /Controle de Mesas/);
    assert.match(html, /Pastelaria Centro/);
    assert.match(html, />01</);
    assert.match(html, />02</);
    assert.match(html, />03</);
    assert.equal(html.includes('>09<'), false);
    assert.match(html, /mesas-card--livre/);
    assert.match(html, /mesas-card--ocupada/);
    assert.match(html, /mesas-card--fechamento/);
    assert.match(html, />LIVRE</);
    assert.match(html, />OCUPADA</);
    assert.match(html, />FECHAMENTO</);
    assert.match(html, /Livres 1/);
    assert.match(html, /Ocupadas 1/);
    assert.match(html, /Fechamento 1/);
    assert.match(html, /Permanência 10 min 0 s/);
    const totais = painel.contadores(estado.itens);
    assert.deepEqual(totais, { livres: 1, ocupadas: 1, fechamento: 1 });
  });

  it('abre o modal da mesa e diferencia livre, ocupada e fechamento', () => {
    const base = {
      empresaRotulo: 'Pastelaria Centro',
      itens: painel.filtrarEmpresa(itensEmpresa(), 1),
      pedidos: [],
      destinoId: '',
      clienteId: '',
      aviso: '',
      sucesso: ''
    };
    const livre = painel.htmlPainel({ ...base, mesaSelecionadaId: 1, detalhe: { situacao: 'LIVRE', numero: 1, atendimento: null } }, AGORA);
    assert.match(livre, /id="mesasModal"/);
    assert.match(livre, /Abrir atendimento/);
    assert.equal(livre.includes('data-acao="transferir"'), false);
    assert.equal(livre.includes('encerrar'), false);

    const ocupada = painel.htmlPainel({
      ...base,
      mesaSelecionadaId: 2,
      detalhe: {
        situacao: 'OCUPADA',
        numero: 2,
        atendimento: { ...base.itens[1].atendimento, cliente_nome: 'Cliente da Mesa' }
      },
      pedidos: pedidosMesa().pedidos
    }, AGORA);
    assert.match(ocupada, /Cliente: Cliente da Mesa/);
    assert.match(ocupada, /Operador da abertura nº 8/);
    assert.match(ocupada, /PED-40/);
    assert.match(ocupada, /Ver todos os pedidos/);
    assert.match(ocupada, /data-acao="pedidos"/);
    assert.match(ocupada, /ATRASADO|Atrasado/);
    assert.match(ocupada, /10 min 0 s/);
    assert.match(ocupada, /Envio 2026-11-02 12:00:00/);
    assert.match(ocupada, /Total do pedido 25/);
    assert.match(ocupada, /<option value="1">01<\/option>/);
    assert.equal(ocupada.includes('<option value="2">'), false);
    assert.equal(ocupada.includes('<option value="3">'), false);
    assert.equal(ocupada.includes('data-acao="liberar"'), false, 'com pedidos não mostra Liberar mesa');

    const ocupadaVazia = painel.htmlPainel({
      ...base,
      mesaSelecionadaId: 2,
      detalhe: {
        situacao: 'OCUPADA',
        numero: 2,
        atendimento: base.itens[1].atendimento
      },
      pedidos: []
    }, AGORA);
    assert.match(ocupadaVazia, /Nenhum pedido vinculado/);
    assert.match(ocupadaVazia, /data-acao="liberar"/);
    assert.match(ocupadaVazia, /Liberar mesa/);

    const fechamento = painel.htmlPainel({
      ...base,
      mesaSelecionadaId: 3,
      detalhe: { situacao: 'FECHAMENTO', numero: 3, atendimento: base.itens[2].atendimento }
    }, AGORA);
    assert.match(fechamento, /processo de fechamento/);
    assert.equal(fechamento.includes('data-acao="transferir"'), false);
    assert.equal(fechamento.includes('data-acao="abrir"'), false);
    assert.equal(fechamento.includes('data-acao="liberar"'), false);
    assert.equal(fechamento.includes('encerrar'), false);
  });
});

describe('ações e concorrência', () => {
  it('libera mesa OCUPADA sem pedido via atendimento/encerrar', async () => {
    const chamadas = [];
    let situacao = itensEmpresa().map((item) => (item.id === 2
      ? { ...item, situacao: 'OCUPADA', atendimento: { ...item.atendimento } }
      : item));
    const { control } = montar(async (method, path) => {
      chamadas.push({ method, path });
      if (path === '/mesas/situacao') return { itens: situacao.filter((i) => i.empresa_id === 1) };
      if (path === '/mesas/2/atendimento' && method === 'GET') {
        const mesa = situacao.find((i) => i.id === 2);
        return { situacao: mesa.situacao, numero: 2, atendimento: mesa.atendimento };
      }
      if (path === '/mesas/2/atendimento/pedidos') return { pedidos: [] };
      if (path === '/mesas/2/atendimento/encerrar' && method === 'POST') {
        situacao = situacao.map((item) => (item.id === 2
          ? { ...item, situacao: 'LIVRE', atendimento: null }
          : item));
        return { success: true, situacao: 'LIVRE' };
      }
      throw new Error('rota inesperada ' + method + ' ' + path);
    }, { confirmar: () => true });
    await control.iniciar();
    await control.selecionar(2);
    assert.equal(control.estado.pedidos.length, 0);
    const out = await control.liberarAtendimento();
    assert.equal(out.ok, true);
    assert.ok(chamadas.some((c) => c.method === 'POST' && c.path === '/mesas/2/atendimento/encerrar'));
    assert.equal(control.estado.itens.find((i) => i.id === 2).situacao, 'LIVRE');
  });

  it('exige selecionar o cliente pesquisado e envia seu identificador ao abrir a mesa', async () => {
    const chamadas = [];
    let situacao = itensEmpresa();
    const { control } = montar(async (method, path, corpo) => {
      chamadas.push({ method, path, corpo });
      if (path === '/mesas/situacao') return { itens: situacao };
      if (path === '/mesas/1/atendimento' && method === 'GET') {
        return { situacao: 'LIVRE', numero: 1, atendimento: null };
      }
      if (path === '/mesas/1/atendimento/pedidos') return { pedidos: [] };
      if (path === '/mesas/1/atendimento' && method === 'POST') {
        situacao = situacao.map((item) => (item.id === 1 ? {
          ...item,
          situacao: 'OCUPADA',
          atendimento: {
            id: 15,
            estado: 'OCUPADA',
            cliente_id: corpo.cliente_id,
            cliente_nome: 'Cliente da Mesa',
            operador_abertura_id: 8,
            aberto_em: ABERTO
          }
        } : item));
        return { atendimento: { id: 15 } };
      }
      throw new Error('rota inesperada ' + method + ' ' + path);
    });
    await control.iniciar();
    await control.selecionar(1);
    control.definirCliente('Cliente da Mesa');
    const semSelecao = await control.abrirAtendimento();
    assert.equal(semSelecao.codigo, 'CLIENTE_NAO_SELECIONADO');
    assert.equal(chamadas.some((item) => item.method === 'POST'), false);

    assert.equal(control.selecionarCliente(5, 'Cliente da Mesa'), true);
    const aberto = await control.abrirAtendimento();
    assert.equal(aberto.ok, true);
    const post = chamadas.find((item) => item.method === 'POST');
    assert.deepEqual(post.corpo, { cliente_id: 5 });
  });

  it('abre atendimento, atualiza a grade e consulta pedidos sem enviar empresa ou operador', async () => {
    const chamadas = [];
    let situacao = itensEmpresa();
    const { control } = montar(async (method, path, corpo, chave) => {
      chamadas.push({ method, path, corpo, chave });
      if (path === '/mesas/situacao') return { itens: situacao };
      if (path === '/mesas/1/atendimento' && method === 'GET') {
        return { situacao: 'LIVRE', numero: 1, atendimento: null };
      }
      if (path === '/mesas/1/atendimento/pedidos') return { pedidos: [] };
      if (path === '/mesas/1/atendimento' && method === 'POST') {
        situacao = situacao.map((item) => (item.id === 1 ? {
          ...item,
          situacao: 'OCUPADA',
          atendimento: { id: 15, estado: 'OCUPADA', cliente_id: null, operador_abertura_id: 8, aberto_em: ABERTO }
        } : item));
        return { atendimento: { id: 15 } };
      }
      if (path === '/mesas/2/atendimento') {
        return { situacao: 'OCUPADA', numero: 2, atendimento: situacao[1].atendimento };
      }
      if (path === '/mesas/2/atendimento/pedidos') return pedidosMesa();
      throw new Error('rota inesperada ' + method + ' ' + path);
    });
    await control.iniciar();
    assert.equal(control.estado.itens.some((item) => item.empresa_id === 2), false);
    await control.selecionar(1);
    assert.match(control.html(), /Abrir atendimento/);
    await control.abrirAtendimento();
    const post = chamadas.find((item) => item.method === 'POST');
    assert.equal(post.path, '/mesas/1/atendimento');
    assert.equal(post.corpo.empresa_id, undefined);
    assert.equal(post.corpo.operador_id, undefined);
    assert.ok(post.chave);
    assert.equal(control.estado.itens.find((item) => item.id === 1).situacao, 'OCUPADA');
    assert.match(control.html(), /Ocupadas 2/);
    await control.selecionar(2);
    assert.match(control.html(), /PED-40/);
    assert.match(control.html(), /Atrasado/);
    assert.match(control.html(), /10 min 0 s/);
  });

  it('transfere só para mesa livre e trata conflito sem sucesso fictício', async () => {
    const chamadas = [];
    let ocuparDestino = false;
    const { control } = montar(async (method, path, corpo) => {
      chamadas.push({ method, path, corpo });
      if (path === '/mesas/situacao') {
        const itens = itensEmpresa().map((item) => {
          if (ocuparDestino && item.id === 1) return { ...item, situacao: 'OCUPADA' };
          return item;
        });
        return { itens };
      }
      if (path === '/mesas/2/atendimento/pedidos') return pedidosMesa();
      if (path === '/mesas/2/atendimento' && method === 'GET') {
        return { situacao: 'OCUPADA', numero: 2, atendimento: itensEmpresa()[1].atendimento };
      }
      if (path === '/mesas/1/atendimento') return { situacao: ocuparDestino ? 'OCUPADA' : 'LIVRE', numero: 1, atendimento: null };
      if (path === '/mesas/1/atendimento/pedidos') return { pedidos: [] };
      if (method === 'POST' && path === '/mesas/2/atendimento/transferir') {
        ocuparDestino = true;
        const err = new Error('ocupada');
        err.codigo = 'MESA_OCUPADA';
        throw err;
      }
      throw new Error('rota inesperada ' + path);
    });
    await control.iniciar();
    await control.selecionar(2);
    control.definirDestino('3');
    let html = control.html();
    assert.equal(html.includes('data-acao="transferir"'), false);
    control.definirDestino('1');
    html = control.html();
    assert.match(html, /Transferir da mesa 02 para a mesa 01/);
    const resultado = await control.transferir();
    assert.equal(resultado.ok, false);
    assert.equal(resultado.codigo, 'MESA_OCUPADA');
    assert.match(control.html(), /ocupada por outro atendimento/);
    assert.equal(control.estado.sucesso, '');
    const post = chamadas.find((item) => item.method === 'POST');
    assert.deepEqual(post.corpo, { mesa_destino_id: 1 });
    assert.equal(post.corpo.empresa_id, undefined);
  });

  it('não sobrepõe consultas, ignora resposta antiga e para o polling ao sair', async () => {
    const situacao = adiar();
    let consultas = 0;
    const detalhes = [];
    const { control, fila } = montar((method, path) => {
      if (path === '/mesas/situacao') {
        consultas += 1;
        return situacao.promise;
      }
      const pendente = adiar();
      detalhes.push({ path, pendente });
      return pendente.promise;
    });
    const inicio = control.iniciar();
    const segunda = control.atualizar();
    assert.deepEqual(await segunda, { ignorada: true });
    assert.equal(consultas, 1);
    situacao.resolver({ itens: painel.filtrarEmpresa(itensEmpresa(), 1) });
    await inicio;
    assert.equal(fila.length, 1);
    assert.equal(fila[0].ms, 5000);

    const primeira = control.selecionar(1);
    const segundaMesa = control.selecionar(2);
    assert.equal(detalhes[0].path, '/mesas/1/atendimento');
    assert.equal(detalhes[1].path, '/mesas/2/atendimento');
    detalhes[0].pendente.resolver({ situacao: 'LIVRE', numero: 1, atendimento: null, atraso: true });
    await primeira;
    detalhes[1].pendente.resolver({
      situacao: 'OCUPADA', numero: 2, atendimento: itensEmpresa()[1].atendimento
    });
    for (let i = 0; i < 10 && detalhes.length < 3; i += 1) await Promise.resolve();
    detalhes[2].pendente.resolver(pedidosMesa());
    await segundaMesa;
    assert.equal(control.estado.mesaSelecionadaId, 2);
    assert.equal(control.estado.detalhe.atraso, undefined);
    assert.equal(control.estado.pedidos[0].codigo, 'PED-40');

    control.fecharModal();
    detalhes.push(null);
    assert.equal(control.estado.mesaSelecionadaId, null);
    assert.equal(fila.filter((item) => item.ativo).length, 1);
    control.parar();
    assert.equal(fila.filter((item) => item.ativo).length, 0);
    fila[0].ativo = false;
    await fila[0].fn();
    assert.equal(consultas, 1);
  });
});

describe('preparação e transferência concluída', () => {
  it('mostra as cinco classificações e o tempo devolvido pelo servidor', () => {
    const pedidos = ['NAO_ENVIADO', 'NORMAL', 'ATRASADO', 'CRITICO', 'CONCLUIDO'].map((classe, indice) => ({
      id: indice + 1,
      codigo: 'PED-' + classe,
      status: 'PEDIDO',
      total: 10,
      preparacao: {
        estado: classe === 'NAO_ENVIADO' ? 'NAO_ENVIADO' : (classe === 'CONCLUIDO' ? 'CONCLUIDO' : 'EM_PREPARACAO'),
        classificacao: classe,
        enviado_em: classe === 'NAO_ENVIADO' ? null : ABERTO,
        tempo_decorrido_segundos: classe === 'NAO_ENVIADO' ? null : 90 + indice
      }
    }));
    const html = painel.htmlPainel({
      empresaRotulo: 'Pastelaria Centro',
      itens: painel.filtrarEmpresa(itensEmpresa(), 1),
      mesaSelecionadaId: 2,
      detalhe: { situacao: 'OCUPADA', numero: 2, atendimento: itensEmpresa()[1].atendimento },
      pedidos,
      destinoId: '',
      clienteId: '',
      aviso: '',
      sucesso: ''
    }, AGORA);
    assert.match(html, /mesas-prep--neutra/);
    assert.match(html, /Não enviado/);
    assert.match(html, /Em preparação/);
    assert.match(html, /Sem contagem/);
    assert.match(html, /mesas-prep--normal/);
    assert.match(html, /mesas-prep--atrasado/);
    assert.match(html, /mesas-prep--critico/);
    assert.match(html, /mesas-prep--concluido/);
    assert.match(html, /Concluído/);
    assert.match(html, /1 min 32 s/);
  });

  it('atualiza origem e destino depois da transferência e informa os conflitos previstos', async () => {
    let situacao = itensEmpresa();
    const { control } = montar(async (method, path) => {
      if (path === '/mesas/situacao') return { itens: situacao };
      if (path === '/mesas/2/atendimento' && method === 'GET') {
        return { situacao: 'OCUPADA', numero: 2, atendimento: itensEmpresa()[1].atendimento };
      }
      if (path === '/mesas/2/atendimento/pedidos') return pedidosMesa();
      if (path === '/mesas/1/atendimento' && method === 'GET') {
        return { situacao: 'OCUPADA', numero: 1, atendimento: itensEmpresa()[1].atendimento };
      }
      if (path === '/mesas/1/atendimento/pedidos') return pedidosMesa();
      if (method === 'POST' && path === '/mesas/2/atendimento/transferir') {
        const atendimento = situacao.find((item) => item.id === 2).atendimento;
        situacao = situacao.map((item) => {
          if (item.id === 2) return { ...item, situacao: 'LIVRE', atendimento: null };
          if (item.id === 1) return { ...item, situacao: 'OCUPADA', atendimento };
          return item;
        });
        return { atendimento };
      }
      throw new Error(method + ' ' + path);
    });
    await control.iniciar();
    await control.selecionar(2);
    control.definirDestino('1');
    const resultado = await control.transferir();
    assert.equal(resultado.ok, true);
    assert.equal(control.estado.mesaSelecionadaId, 1);
    assert.equal(control.estado.itens.find((item) => item.id === 2).situacao, 'LIVRE');
    assert.equal(control.estado.itens.find((item) => item.id === 1).situacao, 'OCUPADA');
    assert.match(control.html(), /PED-40/);
    assert.equal(control.estado.sucesso, 'Operação concluída.');

    const codigos = Object.keys(painel.MENSAGENS);
    assert.deepEqual(codigos.sort(), [
      'ATENDIMENTO_COM_PEDIDO_ABERTO',
      'ATENDIMENTO_EM_FECHAMENTO',
      'ATENDIMENTO_JA_ENCERRADO',
      'CHAVE_IDEMPOTENCIA_DIVERGENTE',
      'MESA_DESTINO_IGUAL',
      'MESA_INATIVA',
      'MESA_LIVRE',
      'MESA_NAO_ENCONTRADA',
      'MESA_OCUPADA'
    ]);
  });
});

describe('navegação e permissões', () => {
  it('preserva a posição do cursor do cliente quando o painel atualiza', () => {
    const painelFonte = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/mesas-painel.js'),
      'utf8'
    );
    assert.match(painelFonte, /selectionStart/);
    assert.match(painelFonte, /setSelectionRange/);
  });

  it('entra no ERP pelo recurso de pedidos e não oferece encerramento técnico', () => {
    const raiz = path.join(__dirname, '../..');
    const index = fs.readFileSync(path.join(raiz, 'frontend/erp/index.html'), 'utf8');
    const app = fs.readFileSync(path.join(raiz, 'frontend/erp/js/app.js'), 'utf8');
    const core = fs.readFileSync(path.join(raiz, 'frontend/shared/js/core.js'), 'utf8');
    const acesso = fs.readFileSync(path.join(raiz, 'frontend/shared/js/access-control.js'), 'utf8');
    const fonte = fs.readFileSync(path.join(raiz, 'frontend/erp/js/mesas-painel.js'), 'utf8');
    const pedidos = fs.readFileSync(path.join(raiz, 'frontend/erp/js/pedidos.js'), 'utf8');
    assert.match(index, /data-page="mesas"/);
    assert.match(index, /data-recurso="pedidos"[\s\S]*data-page="mesas"/);
    assert.match(app, /case 'mesas':/);
    assert.match(app, /CdsPainelMesas\.parar/);
    assert.match(core, /p === 'pedidos' \|\| p === 'mesas'/);
    assert.match(acesso, /mesas: 'vendas'/);
    assert.match(pedidos, /id: 'todos', label: 'Todos', status: null/);
    assert.match(pedidos, /let abaAtual = 'pedidos'/);
    assert.match(pedidos, /filtrarPedidosAbertosDaMesa/);
    assert.match(pedidos, /pedidos abertos vigentes da mesa/);
    assert.match(fonte, /atendimento\/encerrar/);
    assert.match(fonte, /liberarAtendimento/);
    assert.doesNotMatch(fonte, /empresa_id:/);
    assert.doesNotMatch(fonte, /operador_id:/);
    assert.equal(painel.INTERVALO_MS, 5000);
  });

  it('navega da mesa para a lista de pedidos sem abrir o editor', async () => {
    const idas = [];
    const { control } = montar(async (method, path) => {
      if (path === '/mesas/situacao') return { itens: itensEmpresa() };
      if (path === '/mesas/2/atendimento') {
        return { situacao: 'OCUPADA', numero: 2, atendimento: itensEmpresa()[1].atendimento };
      }
      if (path === '/mesas/2/atendimento/pedidos') return pedidosMesa();
      throw new Error('rota inesperada ' + method + ' ' + path);
    }, { aoIrParaPedidos(ctx) { idas.push(ctx); } });
    await control.iniciar();
    await control.selecionar(2);
    const resultado = control.verTodosPedidos();
    assert.equal(resultado.ok, true);
    assert.equal(idas.length, 1);
    assert.equal(idas[0].mesaId, 2);
    assert.equal(idas[0].atendimentoId, 9);
    assert.equal(idas[0].visualizarPedidos, true);
    assert.equal(idas[0].pedidoId, undefined);
  });

  it('oferece gerar venda no PDV e envia o handoff do pedido', async () => {
    const handoffs = [];
    const { control } = montar(async (method, path) => {
      if (path === '/mesas/situacao') return { itens: itensEmpresa() };
      if (path === '/mesas/2/atendimento') {
        return { situacao: 'OCUPADA', numero: 2, atendimento: itensEmpresa()[1].atendimento };
      }
      if (path === '/mesas/2/atendimento/pedidos') return pedidosMesa();
      if (method === 'POST' && path === '/pedidos/40/preparar-venda-pdv') {
        return {
          success: true,
          pedido_id: 40,
          venda_id: null,
          venda_concluida: false,
          itens: [{ produto_id: 1, quantidade: 1 }]
        };
      }
      throw new Error('rota inesperada ' + method + ' ' + path);
    }, {
      confirmar: () => true,
      aoIrParaPdv(preparacao) { handoffs.push(preparacao); }
    });
    await control.iniciar();
    await control.selecionar(2);
    assert.match(control.html(), /data-acao="venda-pdv"/);
    assert.match(control.html(), /Gerar venda no PDV/);
    const resultado = await control.gerarVendaPdv(40);
    assert.equal(resultado.ok, true);
    assert.equal(resultado.redirecionado, true);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].pedido_id, 40);
  });
});
