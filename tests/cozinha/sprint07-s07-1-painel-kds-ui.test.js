/**
 * S07-1 painel KDS e controles operacionais de preparação.
 * Banco isolado. Sem impressão física.
 *
 * Executar:
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   node --test --test-concurrency=1 tests/cozinha/sprint07-s07-1-painel-kds-ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_TEST_ISOLATION = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const kds = require('../../frontend/erp/js/cozinha-kds.js');

const AGORA = new Date('2026-11-17T21:10:00-03:00');

function fixtureRodadas() {
  return [
    {
      id: 10,
      empresa_id: 1,
      unidade_id: 3,
      mesa_id: 2,
      mesa_numero: '5',
      atendimento_id: 9,
      numero_rodada: 1,
      sequencia_global: 2,
      estado_preparacao: 'EM_PREPARACAO',
      enviada_em: '2026-11-17 20:58:00',
      created_at: '2026-11-17 20:58:00',
      itens: [
        {
          id: 101,
          numero_comanda: 44,
          tipo_item: 'PASTEL',
          estado_preparacao: 'AGUARDANDO',
          sequencia_global: 2,
          qty_solicitada: '2',
          produto_nome_snapshot: 'Pastel de carne',
          observacoes_snapshot: 'Sem cebola'
        },
        {
          id: 102,
          numero_comanda: 44,
          tipo_item: 'BEBIDA',
          estado_preparacao: 'EM_PREPARACAO',
          sequencia_global: 3,
          qty_solicitada: '1',
          produto_nome_snapshot: 'Refrigerante 200ml',
          observacoes_snapshot: null
        }
      ]
    },
    {
      id: 11,
      empresa_id: 1,
      unidade_id: 3,
      mesa_id: 1,
      mesa_numero: '1',
      atendimento_id: 8,
      numero_rodada: 2,
      sequencia_global: 1,
      estado_preparacao: 'AGUARDANDO',
      enviada_em: '2026-11-17 20:55:00',
      created_at: '2026-11-17 20:55:00',
      itens: [
        {
          id: 201,
          numero_comanda: 12,
          tipo_item: 'PASTEL',
          estado_preparacao: 'AGUARDANDO',
          sequencia_global: 1,
          qty_solicitada: '3',
          produto_nome_snapshot: 'Pastel de queijo',
          observacoes_snapshot: 'Bem passado'
        }
      ]
    },
    {
      id: 12,
      empresa_id: 1,
      unidade_id: 3,
      mesa_id: 7,
      mesa_numero: '07',
      atendimento_id: 15,
      numero_rodada: 3,
      sequencia_global: 3,
      estado_preparacao: 'PRONTA',
      operador_envio_id: 6,
      enviada_em: '2026-11-17 20:50:00',
      rodada_pronta_em: '2026-11-17 21:00:00',
      retirada_estado: 'PENDENTE',
      created_at: '2026-11-17 20:50:00',
      itens: [
        {
          id: 301,
          numero_comanda: 99,
          tipo_item: 'OUTRO',
          estado_preparacao: 'PRONTO',
          sequencia_global: 4,
          qty_solicitada: '1.5',
          produto_nome_snapshot: 'Porção batata',
          observacoes_snapshot: '',
          pronto_em: '2026-11-17 20:49:00',
          operador_pronto_id: 7
        }
      ]
    }
  ];
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
  const control = kds.criarControlador({
    empresaId: 1,
    empresaRotulo: 'Pastelaria Centro',
    agora: () => AGORA,
    intervaloMs: 5000,
    // S07-2: painel só inicia com JWT contextualizado.
    lerUnidadeJwt: () => 3,
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

describe('S07-1 — distribuição e FIFO', () => {
  it('distribui cartões por estado do item e ordena FIFO', () => {
    const dist = kds.distribuirPorEstado(fixtureRodadas());
    assert.equal(dist.AGUARDANDO.length, 2);
    assert.equal(dist.EM_PREPARACAO.length, 1);
    assert.equal(dist.PRONTO.length, 1);
    // FIFO: sequencia_global 1 antes de 2
    assert.equal(dist.AGUARDANDO[0].id, 11);
    assert.equal(dist.AGUARDANDO[1].id, 10);
    assert.equal(dist.AGUARDANDO[0].itens[0].produto_nome_snapshot, 'Pastel de queijo');
    assert.equal(dist.EM_PREPARACAO[0].itens[0].produto_nome_snapshot, 'Refrigerante 200ml');
    assert.deepEqual(kds.contadores(dist), {
      AGUARDANDO: 2,
      EM_PREPARACAO: 1,
      PRONTO: 1
    });
  });

  it('renderiza cabeçalho, colunas, itens e observações', () => {
    const dist = kds.distribuirPorEstado(fixtureRodadas());
    const html = kds.htmlPainel({
      empresaId: 1,
      empresaRotulo: 'Pastelaria Centro',
      unidadeId: 3,
      rodadas: fixtureRodadas(),
      distribuicao: dist,
      carregando: false,
      erro: '',
      ultimaAtualizacao: AGORA
    }, AGORA);
    assert.match(html, /Cozinha/);
    assert.match(html, /\(KDS\)/);
    assert.match(html, /Pastelaria Centro/);
    assert.match(html, /Unidade #3/);
    assert.match(html, /Aguardando/);
    assert.match(html, /Em preparação/);
    assert.match(html, /Prontos/);
    assert.match(html, /Pastel de carne/);
    assert.match(html, /Sem cebola/);
    assert.match(html, /Bem passado/);
    assert.match(html, /Mesa 05|Mesa 5/);
    assert.match(html, /Comanda 44/);
    assert.match(html, /data-acao="atualizar"/);
    assert.match(html, /data-acao="trocar-unidade"/);
    assert.match(html, /Trocar unidade/);
    assert.match(html, /data-acao="iniciar-preparo"/);
    assert.match(html, /INICIAR PREPARO/);
    assert.match(html, /data-acao="marcar-pronto"/);
    assert.match(html, /MARCAR COMO PRONTO/);
    assert.match(html, /Concluído às/);
    assert.match(html, /Operador #7/);
    assert.match(html, /CDS Sistemas/);
    assert.match(html, /Tempo total/);
    assert.match(html, /Espera do garçom/);
    assert.match(html, /data-acao="confirmar-retirada"/);
    assert.match(html, /CONFIRMAR RETIRADA/);
    assert.match(html, /Responsável #6/);
    assert.doesNotMatch(html, /dual-write/i);
  });

  it('calcula durações usando timestamps UTC sem somar tempos paralelos', () => {
    assert.equal(kds.formatarHora('2026-11-17 20:58:00'), '20:58:00');
    assert.equal(kds.formatarHora('2026-11-17T17:58:00-03:00'), '20:58:00');
    assert.equal(kds.segundosEntre(
      '2026-11-17 20:00:00',
      '2026-11-17 20:05:00'
    ), 300);
    assert.equal(kds.formatarDuracao(7322), '02:02:02');

    const tempos = kds.calcularTemposItem({
      enviada_em: '2026-11-17 20:00:00',
      rodada_pronta_em: '2026-11-17 20:20:00',
      retirada_estado: 'RETIRADA',
      retirada_em: '2026-11-17 20:24:00'
    }, {
      estado_preparacao: 'PRONTO',
      iniciado_em: '2026-11-17 20:05:00',
      pronto_em: '2026-11-17 20:15:00'
    }, new Date('2026-11-17T20:25:00Z'));
    assert.equal(tempos.chegada, 1440);
    assert.equal(tempos.espera, 300);
    assert.equal(tempos.preparo, 600);
    assert.equal(tempos.esperaGarcom, 240);
    assert.equal(kds.calcularTemposItem({
      created_at: '2026-11-17 20:00:00'
    }, {
      estado_preparacao: 'AGUARDANDO'
    }, new Date('2026-11-17T20:05:00Z')).chegada, null);
  });

  it('renderiza uma única ação de retirada por rodada com vários estados de item', () => {
    const rodadas = fixtureRodadas();
    rodadas.find((rodada) => rodada.id === 12).itens.push({
      id: 302,
      numero_comanda: 99,
      tipo_item: 'BEBIDA',
      estado_preparacao: 'AGUARDANDO',
      qty_solicitada: '1',
      produto_nome_snapshot: 'Suco',
      observacoes_snapshot: null
    });
    const html = kds.htmlPainel({
      empresaId: 1,
      unidadeId: 3,
      rodadas,
      carregando: false,
      erro: ''
    }, AGORA);
    assert.equal(
      [...html.matchAll(/data-acao="confirmar-retirada" data-rodada-id="12"/g)].length,
      1
    );
  });

  it('estado vazio exibe mensagem por coluna', () => {
    const html = kds.htmlPainel({
      empresaRotulo: 'X',
      unidadeId: 1,
      rodadas: [],
      distribuicao: kds.distribuirPorEstado([]),
      carregando: false,
      erro: '',
      ultimaAtualizacao: AGORA
    }, AGORA);
    assert.match(html, /Nenhum pedido/);
  });
});

describe('S07-1 — consumo API e atualização', () => {
  it('carrega painel via GET /cozinha/preparacao/painel', async () => {
    const chamadas = [];
    const { control, fila } = montar(async (method, path) => {
      chamadas.push({ method, path });
      return {
        success: true,
        empresa_id: 1,
        unidade_id: 3,
        total: 3,
        limite: 100,
        offset: 0,
        ordenacao: 'FIFO_SEQUENCIA_GLOBAL',
        rodadas: fixtureRodadas()
      };
    });
    await control.iniciar();
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].method, 'GET');
    assert.match(chamadas[0].path, /^\/cozinha\/preparacao\/painel\?/);
    assert.match(chamadas[0].path, /limite=100/);
    assert.equal(control.estado.unidadeId, 3);
    assert.equal(control.estado.rodadas.length, 3);
    assert.equal(control.estado.distribuicao.AGUARDANDO.length, 2);
    assert.ok(fila.length >= 1);
    assert.equal(fila[0].ms, 5000);
  });

  it('confirma início e conclusão, move o item e atualiza o painel', async () => {
    let rodadas = fixtureRodadas();
    const chamadas = [];
    const confirmacoes = [];
    const { control } = montar(async (method, path, body) => {
      chamadas.push({ method, path, body });
      if (method === 'GET') {
        return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
      }
      if (path.endsWith('/iniciar')) {
        rodadas = fixtureRodadas();
        const item = rodadas.find((r) => r.id === 11).itens[0];
        item.estado_preparacao = 'EM_PREPARACAO';
        item.iniciado_em = '2026-11-17 21:00:00';
        item.operador_inicio_id = 8;
        return {
          success: true,
          operador_id: 8,
          iniciado_em: item.iniciado_em,
          item: { id: 201, estado_preparacao: 'EM_PREPARACAO' },
          rodada: { id: 11, estado_preparacao: 'EM_PREPARACAO' }
        };
      }
      rodadas = fixtureRodadas();
      const item = rodadas.find((r) => r.id === 11).itens[0];
      item.estado_preparacao = 'PRONTO';
      item.pronto_em = '2026-11-17 21:05:00';
      item.operador_pronto_id = 9;
      return {
        success: true,
        operador_id: 9,
        pronto_em: item.pronto_em,
        item: { id: 201, estado_preparacao: 'PRONTO', pronto_em: item.pronto_em },
        rodada: { id: 11, estado_preparacao: 'PRONTA' }
      };
    }, {
      confirmar: (mensagem) => {
        confirmacoes.push(mensagem);
        return true;
      },
      gerarChaveIdempotencia: (acao, itemId) => `teste:${acao}:${itemId}`
    });

    it('confirma retirada uma vez e reconsulta a rodada persistida', async () => {
      const rodadas = fixtureRodadas();
      const chamadas = [];
      const confirmacoes = [];
      const { control } = montar(async (method, path, body) => {
        chamadas.push({ method, path, body });
        if (method === 'GET') {
          return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
        }
        const rodada = rodadas.find((candidata) => candidata.id === 12);
        rodada.retirada_estado = 'RETIRADA';
        rodada.retirada_em = '2026-11-17 21:10:00';
        rodada.retirada_por = 7;
        return {
          success: true,
          repetida: false,
          rodada: {
            id: 12,
            estado_preparacao: 'PRONTA',
            retirada_estado: 'RETIRADA',
            retirada_em: rodada.retirada_em,
            retirada_por: 7
          }
        };
      }, {
        confirmar: (mensagem) => { confirmacoes.push(mensagem); return true; },
        gerarChaveIdempotencia: (acao, id) => `teste:${acao}:${id}`
      });

      await control.iniciar();
      const resultado = await control.confirmarRetirada(12);
      assert.equal(resultado.ok, true);
      const post = chamadas.find((chamada) => chamada.method === 'POST');
      assert.equal(post.path, '/cozinha/rodadas/12/retirada');
      assert.equal(post.body.idempotency_key, 'teste:retirada:12');
      assert.equal(confirmacoes.length, 1);
      assert.match(control.html(), /Retirada confirmada às 21:10:00 UTC/);
    });

    await control.iniciar();
    const inicio = await control.operarItem(201, 'iniciar');
    assert.equal(inicio.ok, true);
    assert.equal(control.estado.distribuicao.AGUARDANDO.length, 1);
    assert.equal(control.estado.distribuicao.EM_PREPARACAO.length, 2);
    assert.match(control.html(), /MARCAR COMO PRONTO/);
    const chamadaInicio = chamadas.find((c) => c.path.endsWith('/iniciar'));
    assert.equal(chamadaInicio.method, 'POST');
    assert.equal(chamadaInicio.body.idempotency_key, 'teste:iniciar:201');

    const pronto = await control.operarItem(201, 'pronto');
    assert.equal(pronto.ok, true);
    assert.equal(control.estado.distribuicao.EM_PREPARACAO.length, 1);
    assert.equal(control.estado.distribuicao.PRONTO.length, 2);
    assert.match(control.html(), /Concluído às/);
    assert.match(control.html(), /Operador #9/);
    assert.match(control.html(), /Item marcado como pronto/);
    assert.equal(chamadas.filter((c) => c.method === 'GET').length, 3);
    assert.equal(confirmacoes.length, 2);
  });

  it('ignora clique duplo enquanto a operação está em curso', async () => {
    const pendente = adiar();
    let posts = 0;
    const { control } = montar(async (method) => {
      if (method === 'GET') {
        return { success: true, empresa_id: 1, unidade_id: 3, rodadas: fixtureRodadas() };
      }
      posts += 1;
      return pendente.promise;
    }, { confirmar: () => true });
    await control.iniciar();
    const primeira = control.operarItem(201, 'iniciar');
    const segunda = await control.operarItem(201, 'iniciar');
    assert.equal(segunda.sobreposta, true);
    assert.equal(posts, 1);
    assert.match(control.html(), /PROCESSANDO/);
    pendente.resolver({
      success: true,
      operador_id: 8,
      iniciado_em: '2026-11-17 21:00:00',
      item: { id: 201, estado_preparacao: 'EM_PREPARACAO' },
      rodada: { id: 11, estado_preparacao: 'EM_PREPARACAO' }
    });
    const resultado = await primeira;
    assert.equal(resultado.ok, true);
    assert.equal(posts, 1);
  });

  it('atualização manual dispara novo GET', async () => {
    let n = 0;
    const { control } = montar(async () => {
      n += 1;
      return {
        success: true,
        empresa_id: 1,
        unidade_id: 3,
        total: 0,
        rodadas: n === 1 ? fixtureRodadas() : []
      };
    });
    await control.iniciar();
    await control.atualizar({ silencioso: false });
    assert.equal(n, 2);
    assert.equal(control.estado.rodadas.length, 0);
  });

  it('evita sobreposição de requisições', async () => {
    const pendente = adiar();
    let iniciadas = 0;
    const { control } = montar(() => {
      iniciadas += 1;
      return pendente.promise;
    });
    control.estado.ativo = true;
    const p1 = control.atualizar({ silencioso: false });
    const p2 = control.atualizar({ silencioso: true });
    const r2 = await p2;
    assert.equal(r2.ignorada, true);
    assert.equal(r2.sobreposta, true);
    assert.equal(iniciadas, 1);
    pendente.resolver({
      success: true,
      empresa_id: 1,
      unidade_id: 3,
      rodadas: []
    });
    await p1;
  });

  it('em erro preserva últimos dados válidos', async () => {
    let n = 0;
    const { control } = montar(async () => {
      n += 1;
      if (n === 1) {
        return {
          success: true,
          empresa_id: 1,
          unidade_id: 3,
          rodadas: fixtureRodadas()
        };
      }
      const err = new Error('Rede indisponível');
      err.codigo = 'REDE';
      throw err;
    });
    await control.iniciar();
    assert.equal(control.estado.rodadas.length, 3);
    const r = await control.atualizar({ silencioso: true });
    assert.ok(r.erro);
    assert.equal(r.preservouDados, true);
    assert.equal(control.estado.rodadas.length, 3);
    assert.match(control.estado.erro, /Rede indisponível/);
    const html = control.html();
    assert.match(html, /Pastel de carne/);
    assert.match(html, /Falha na atualização|Rede indisponível/);
  });

  it('poll automático usa intervalo de 5s', async () => {
    const { control, fila } = montar(async () => ({
      success: true,
      empresa_id: 1,
      unidade_id: 3,
      rodadas: []
    }));
    await control.iniciar();
    assert.equal(fila[0].ms, kds.INTERVALO_MS);
    assert.equal(kds.INTERVALO_MS, 5000);
    control.parar();
    assert.equal(fila[0].ativo, false);
  });

  it('parar impede redesenho posterior (não invade outra página)', async () => {
    let mudancas = 0;
    const { control } = montar(async () => ({
      success: true,
      empresa_id: 1,
      unidade_id: 3,
      rodadas: []
    }), {
      aoMudar: () => { mudancas += 1; }
    });
    await control.iniciar();
    const antes = mudancas;
    control.parar();
    control.definirUnidadeSelecionada(1);
    assert.equal(mudancas, antes, 'aoMudar não deve disparar com painel parado');
  });

  it('voltarParaSelecao para o poll e exibe tela de unidades', async () => {
    const chamadas = [];
    const { control, fila } = montar(async (method, path) => {
      chamadas.push({ method, path });
      if (String(path).includes('unidades-disponiveis')) {
        return { success: true, unidades: [{ id: 3, codigo: 'UA' }, { id: 7, codigo: 'UB' }] };
      }
      return {
        success: true,
        empresa_id: 1,
        unidade_id: 3,
        rodadas: []
      };
    });
    await control.iniciar();
    assert.equal(control.estado.modo, 'painel');
    assert.ok(fila.some((f) => f.ativo));
    await control.voltarParaSelecao();
    assert.equal(control.estado.modo, 'selecao');
    assert.ok(fila.every((f) => f.ativo === false));
    assert.ok(chamadas.some((c) => String(c.path).includes('/cozinha/unidades-disponiveis')));
    assert.match(control.html(), /data-painel-kds-selecao|Confirmar unidade|kds-selecao/);
  });
});

describe('S07-1 — registro no ERP (sem tocar S06/PDV)', () => {
  it('menu, scripts, ACL e catálogo apontam para cozinha-kds', () => {
    const raiz = path.resolve(__dirname, '../..');
    const indexHtml = fs.readFileSync(path.join(raiz, 'frontend/erp/index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(raiz, 'frontend/erp/js/app.js'), 'utf8');
    const acl = fs.readFileSync(path.join(raiz, 'frontend/shared/js/access-control.js'), 'utf8');
    const core = fs.readFileSync(path.join(raiz, 'frontend/shared/js/core.js'), 'utf8');
    assert.match(indexHtml, /data-page="cozinha-kds"/);
    assert.match(indexHtml, /cozinha-kds\.css/);
    assert.match(appJs, /'cozinha-kds':\s*\['\/erp\/js\/cozinha-kds\.js'\]/);
    assert.match(appJs, /case 'cozinha-kds'/);
    assert.match(appJs, /loadCozinhaKds/);
    assert.match(acl, /'cozinha-kds':\s*'vendas'/);
    assert.match(core, /page:\s*'cozinha-kds'/);
    assert.match(core, /p === 'cozinha-kds'/);
  });

  it('ações usam as rotas KDS existentes e não acessam impressão S06', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/cozinha-kds.js'),
      'utf8'
    );
    assert.match(src, /\/cozinha\/itens\/\$\{itemId\}\/\$\{operacao\.caminho\}/);
    assert.match(src, /data-acao="iniciar-preparo"/);
    assert.match(src, /data-acao="marcar-pronto"/);
    assert.doesNotMatch(src, /\/impressao\/fila/);
    assert.match(src, /\/cozinha\/preparacao\/painel/);
    // S07-2 permite POST apenas para /cozinha/sessao/unidade (contexto JWT).
    assert.match(src, /\/cozinha\/sessao\/unidade/);
  });

  it('ERP para o poll do KDS ao trocar de página (não sobrescreve Pedidos)', () => {
    const appJs = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/app.js'),
      'utf8'
    );
    const kdsSrc = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/cozinha-kds.js'),
      'utf8'
    );
    assert.match(appJs, /CdsCozinhaKds\.parar/);
    assert.match(kdsSrc, /CDS_ERP_ACTIVE_PAGE\s*!==\s*'cozinha-kds'/);
  });
});
