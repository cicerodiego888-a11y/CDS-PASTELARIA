const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '../..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

require('../../frontend/erp/js/mesas-painel.js');
require('../../frontend/erp/js/mesas-conferencia.js');
require('../../frontend/mobile-pedido/mobile-pedido.js');
const MobileMesas = require('../../frontend/mobile-mesas/mobile-mesas.js');
require('../../frontend/mobile-pdv/mobile-pdv.js');

const Conf = globalThis.CdsMesasConferencia;

function armazenamento() {
  const dados = new Map();
  return {
    getItem: (k) => (dados.has(k) ? dados.get(k) : null),
    setItem: (k, v) => dados.set(k, String(v)),
    removeItem: (k) => dados.delete(k),
    dados
  };
}

function resposta(status, corpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo };
}

// Servidor simulado: só responde aos contratos oficiais e registra cada chamada.
function montar(opcoes = {}) {
  const o = {
    situacao: 'OCUPADA',
    empresa: 1,
    atendimentoId: 9,
    pedido: { id: 5, codigo: 'PED-5', status: 'PEDIDO', empresa_id: 1, total: 20, itens: [{ produto_id: 1, quantidade: 2, produto_nome: 'Pastel', subtotal: 20 }] },
    preparacao: { estado: 'EM_PREPARACAO' },
    preparar: null,
    finalizar: null,
    offlineEm: null,
    ...opcoes
  };
  const chamadas = [];
  const sessao = armazenamento();
  const local = armazenamento();
  local.setItem('user', JSON.stringify({ id: 3, nome: 'Op' }));
  const preparoPadrao = () => resposta(200, {
    pedido_id: o.pedido.id,
    empresa_id: o.empresa,
    operacao_id: 77,
    venda_id: null,
    recuperacao: false,
    venda_concluida: false,
    total: 20,
    desconto: 0,
    itens: [{ produto_id: 1, quantidade: 2, subtotal: 20 }]
  });
  const global = {
    location: { origin: 'http://x' },
    localStorage: local,
    sessionStorage: sessao,
    CdsEmpresaContexto: {
      headersJson: () => ({ 'Content-Type': 'application/json', 'X-Empresa-Id': String(o.empresa) }),
      temEmpresaSelecionada: () => true
    },
    fetch: async (url, init = {}) => {
      const metodo = init.method || 'GET';
      const rota = url.replace('http://x/api', '');
      chamadas.push({ metodo, rota, corpo: init.body });
      if (o.offlineEm && o.offlineEm.test(`${metodo} ${rota}`)) throw new TypeError('Failed to fetch');
      if (metodo === 'GET' && /\/mesas\/\d+\/atendimento$/.test(rota)) {
        return resposta(200, {
          situacao: o.situacao,
          numero: 2,
          empresa_id: o.empresa,
          atendimento: o.situacao === 'LIVRE' ? null : { id: o.atendimentoId }
        });
      }
      if (metodo === 'GET' && /\/mesas\/\d+\/atendimento\/pedidos$/.test(rota)) {
        return resposta(200, { pedidos: [{ id: o.pedido.id, mesa_atendimento_id: o.atendimentoId, preparacao: o.preparacao }] });
      }
      if (metodo === 'GET' && /\/pedidos\/\d+$/.test(rota)) {
        return resposta(200, { pedido: { ...o.pedido, mesa_atendimento_id: o.atendimentoId } });
      }
      if (metodo === 'POST' && /preparar-venda-pdv$/.test(rota)) return (o.preparar || preparoPadrao)(rota);
      if (metodo === 'POST' && /finalizar-venda-pdv$/.test(rota)) {
        return (o.finalizar || (() => resposta(200, { success: true, venda_id: 900 })))(rota);
      }
      return resposta(404, { error: 'rota inesperada ' + rota });
    }
  };
  const rede = MobileMesas.criarRede(global, () => {});
  const executar = (extra = {}) => MobileMesas.finalizarNoPdv({
    rede, Conf, mesaId: 2, pedidoId: o.pedido.id, global, MobilePedido: globalThis.MobilePedido, ...extra
  });
  return { o, chamadas, sessao, global, rede, executar };
}

const postsDe = (chamadas, re) => chamadas.filter((c) => c.metodo === 'POST' && re.test(c.rota));

test('MESAS-07 pedido enviado à preparação é encaminhado ao PDV oficial', async () => {
  const s = montar();
  const r = await s.executar();
  assert.equal(r.ok, true);
  assert.equal(r.destino, '/mobile-pdv');
  const handoff = JSON.parse(s.sessao.getItem('pdvPedidoHandoff'));
  assert.equal(handoff.pedido_id, 5);
  assert.equal(handoff.operacao_id, 77);
  assert.equal(handoff.empresa_id, 1);
  assert.equal(handoff.sessao_operador_id, 3);
  assert.equal(postsDe(s.chamadas, /preparar-venda-pdv$/).length, 1);
  assert.equal(postsDe(s.chamadas, /preparar-venda-pdv$/)[0].corpo, '{}');
});

test('MESAS-07 nenhuma venda, pagamento ou fechamento é criado pela tela de mesas', async () => {
  const s = montar();
  await s.executar();
  assert.equal(s.chamadas.filter((c) => c.metodo === 'POST' && !/preparar-venda-pdv$/.test(c.rota)).length, 0);
  const fonte = ler('frontend/mobile-mesas/mobile-mesas.js');
  assert.doesNotMatch(fonte, /['`]\/vendas/);
  assert.doesNotMatch(fonte, /operador_id|pagamento_id/);
  assert.ok(s.chamadas.filter((c) => c.metodo === 'POST').every((c) => c.corpo === '{}'));
});

test('MESAS-07 falha na preparação não navega nem grava handoff', async () => {
  const s = montar({ preparar: () => resposta(409, { codigo: 'COMPOSICAO_INVALIDA', mensagem: 'Composição inválida.' }) });
  const r = await s.executar();
  assert.equal(r.ok, false);
  assert.equal(r.destino, undefined);
  assert.match(r.mensagem, /Composição inválida/);
  assert.equal(s.sessao.getItem('pdvPedidoHandoff'), null);
  assert.equal(s.sessao.getItem(MobileMesas.CHAVE_RETORNO), null);
});

test('MESAS-07 resposta sem identificador de operação não navega', async () => {
  const s = montar({ preparar: () => resposta(200, { pedido_id: 5, empresa_id: 1, itens: [{ produto_id: 1 }] }) });
  const r = await s.executar();
  assert.equal(r.ok, false);
  assert.equal(s.sessao.getItem('pdvPedidoHandoff'), null);
});

test('MESAS-07 duplo toque: botão bloqueado durante confirmação e envio, e o manipulador ignora fase ocupada', () => {
  const base = {
    ctrl: { estado: { pedido: { id: 5, codigo: 'PED-5', status: 'PEDIDO', total: 20, itens: [] }, preparacao: { estado: 'EM_PREPARACAO' }, numero: 2 } }
  };
  const conf = MobileMesas.htmlConferencia({ ...base, pdv: { fase: 'confirmando' } });
  assert.match(conf, /role="dialog"/);
  assert.match(conf, /data-acao="pdv-confirmar"/);
  assert.match(conf, /data-acao="finalizar-pdv" disabled/);
  const env = MobileMesas.htmlConferencia({ ...base, pdv: { fase: 'enviando' } });
  assert.match(env, /data-acao="pdv-confirmar" disabled/);
  assert.match(env, /data-acao="pdv-cancelar" disabled/);
  const fonte = ler('frontend/mobile-mesas/mobile-mesas.js');
  assert.match(fonte, /vista\.pdv && vista\.pdv\.fase !== 'idle'\) return/);
  assert.match(fonte, /acao === 'pdv-confirmar' && vista && vista\.pdv && vista\.pdv\.fase === 'confirmando'/);
});

test('MESAS-07 perda de conexão durante o handoff preserva o pedido e não navega', async () => {
  const s = montar({ offlineEm: /preparar-venda-pdv/ });
  const r = await s.executar();
  assert.equal(r.ok, false);
  assert.match(r.mensagem, /Sem conexão/);
  assert.equal(s.sessao.getItem('pdvPedidoHandoff'), null);

  const s2 = montar({ offlineEm: /GET \/pedidos\/5/ });
  const r2 = await s2.executar();
  assert.equal(r2.ok, false);
  assert.match(r2.mensagem, /Sem conexão/);
  assert.equal(postsDe(s2.chamadas, /preparar-venda-pdv/).length, 0);
});

test('MESAS-07 atualização da página e recuperação reutilizam a mesma operação', async () => {
  const s = montar({
    preparar: () => resposta(200, {
      pedido_id: 5, empresa_id: 1, operacao_id: 77, venda_id: null, recuperacao: true, venda_concluida: false,
      total: 20, desconto: 0, itens: [{ produto_id: 1, quantidade: 2, subtotal: 20 }]
    })
  });
  const a = await s.executar();
  const b = await s.executar();
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.handoff.operacao_id, b.handoff.operacao_id);
  assert.equal(JSON.parse(s.sessao.getItem('pdvPedidoHandoff')).operacao_id, 77);
});

test('MESAS-07 venda já registrada: vincula pelo contrato oficial, sem nova venda e sem abrir o PDV', async () => {
  const s = montar({
    preparar: () => resposta(200, {
      pedido_id: 5, empresa_id: 1, operacao_id: 77, venda_id: 900, recuperacao: true, venda_concluida: false, itens: [{ produto_id: 1 }]
    })
  });
  const r = await s.executar();
  assert.equal(r.ok, false);
  assert.equal(r.recuperado, true);
  assert.equal(r.vendaId, 900);
  assert.match(r.mensagem, /Nenhuma venda nova/);
  assert.equal(postsDe(s.chamadas, /finalizar-venda-pdv$/).length, 1);
  assert.equal(s.sessao.getItem('pdvPedidoHandoff'), null);
});

test('MESAS-07 pagamento pendente no vínculo mantém o pedido aberto e mostra o motivo', async () => {
  const s = montar({
    preparar: () => resposta(200, { pedido_id: 5, empresa_id: 1, operacao_id: 77, venda_id: 900, itens: [{ produto_id: 1 }] }),
    finalizar: () => resposta(409, { codigo: 'PAGAMENTO_PDV_PENDENTE', mensagem: 'A venda aguarda a conclusão do pagamento não fiscal.' })
  });
  const r = await s.executar();
  assert.equal(r.ok, false);
  assert.match(r.mensagem, /aguarda a conclusão do pagamento/);
  assert.equal(s.sessao.getItem('pdvPedidoHandoff'), null);
});

test('MESAS-07 venda já concluída do pedido é somente consulta', async () => {
  const s = montar({
    preparar: () => resposta(200, { pedido_id: 5, empresa_id: 1, operacao_id: 77, venda_id: 900, venda_concluida: true, itens: [{ produto_id: 1 }] })
  });
  const r = await s.executar();
  assert.equal(r.ok, false);
  assert.equal(r.somenteConsulta, true);
  assert.equal(postsDe(s.chamadas, /finalizar-venda-pdv$/).length, 0);
});

test('MESAS-07 pedido ou composição de outra empresa não segue para o PDV', async () => {
  const outra = montar({ preparar: () => resposta(200, { pedido_id: 5, empresa_id: 2, operacao_id: 77, itens: [{ produto_id: 1 }] }) });
  const r1 = await outra.executar();
  assert.equal(r1.ok, false);
  assert.equal(r1.codigo, 'EMPRESA_DIVERGENTE');
  assert.equal(outra.sessao.getItem('pdvPedidoHandoff'), null);

  const s = montar({ pedido: { id: 5, codigo: 'PED-5', status: 'PEDIDO', empresa_id: 2, itens: [] } });
  const r2 = await s.executar();
  assert.equal(r2.ok, false);
  assert.equal(r2.codigo, 'PEDIDO_OUTRA_EMPRESA');
  assert.equal(postsDe(s.chamadas, /preparar-venda-pdv/).length, 0);
});

test('MESAS-07 atendimento encerrado ou em fechamento bloqueia antes de preparar', async () => {
  for (const situacao of ['LIVRE', 'FECHAMENTO']) {
    const s = montar({ situacao });
    const r = await s.executar();
    assert.equal(r.ok, false, situacao);
    assert.equal(postsDe(s.chamadas, /preparar-venda-pdv/).length, 0, situacao);
    assert.equal(s.sessao.getItem('pdvPedidoHandoff'), null, situacao);
  }
});

test('MESAS-07 pedido faturado ou cancelado é somente consulta e sem botão de finalização', async () => {
  for (const status of ['FATURADO', 'CANCELADO']) {
    const s = montar({ pedido: { id: 5, codigo: 'PED-5', status, empresa_id: 1, itens: [] } });
    const r = await s.executar();
    assert.equal(r.ok, false, status);
    assert.equal(r.somenteConsulta, true, status);
    assert.equal(postsDe(s.chamadas, /preparar-venda-pdv/).length, 0, status);
    const html = MobileMesas.htmlConferencia({
      ctrl: { estado: { pedido: { id: 5, status, itens: [] }, preparacao: { estado: 'EM_PREPARACAO' }, numero: 2 } }
    });
    assert.doesNotMatch(html, /finalizar-pdv/, status);
  }
});

test('MESAS-07 pedido ainda não enviado à preparação não oferece nem executa a finalização', async () => {
  const html = MobileMesas.htmlConferencia({
    ctrl: { estado: { pedido: { id: 5, status: 'PEDIDO', itens: [] }, preparacao: { estado: 'NAO_ENVIADO' }, numero: 2 } }
  });
  assert.match(html, /data-acao="enviar"/);
  assert.doesNotMatch(html, /finalizar-pdv/);
  const s = montar({ preparacao: { estado: 'NAO_ENVIADO' } });
  const r = await s.executar();
  assert.equal(r.ok, false);
  assert.match(r.mensagem, /preparação/);
  assert.equal(postsDe(s.chamadas, /preparar-venda-pdv/).length, 0);
});

test('MESAS-07 dois pedidos na mesma mesa seguem individualmente, cada um com a sua operação', async () => {
  const a = montar();
  const b = montar({ pedido: { id: 6, codigo: 'PED-6', status: 'PEDIDO', empresa_id: 1, total: 20, itens: [] } });
  const ra = await a.executar();
  const rb = await b.executar();
  assert.equal(ra.handoff.pedido_id, 5);
  assert.equal(rb.handoff.pedido_id, 6);
  assert.equal(ra.handoff.consolidacao_id, undefined);
  assert.match(postsDe(b.chamadas, /preparar-venda-pdv/)[0].rota, /\/pedidos\/6\/preparar-venda-pdv$/);
});

test('MESAS-07 venda individual não altera o atendimento; consolidada fica documentada como só no computador', async () => {
  const s = montar();
  await s.executar();
  assert.equal(s.chamadas.filter((c) => /encerrar|transferir|fechamento|venda-consolidada/.test(c.rota)).length, 0);
  assert.equal(s.chamadas.filter((c) => c.metodo !== 'GET' && !/preparar-venda-pdv$/.test(c.rota)).length, 0);
  const html = MobileMesas.htmlConferencia({
    ctrl: { estado: { pedido: { id: 5, status: 'PEDIDO', itens: [] }, preparacao: { estado: 'EM_PREPARACAO' }, numero: 2 } }
  });
  assert.match(html, /consolidada[^<]*apenas no computador/);
  assert.match(html, /Finalizar pedido e ir para o PDV/);
  assert.doesNotMatch(ler('frontend/mobile-mesas/mobile-mesas.js'), /venda-consolidada-mesa/);
});

test('MESAS-07 retorno do PDV para a mesa só vale para a mesma empresa e pedido', () => {
  const armaz = armazenamento();
  armaz.setItem('cdsMesaRetorno', JSON.stringify({ mesa_id: 2, pedido_id: 5, empresa: 1 }));
  assert.equal(globalThis.MobilePdv.destinoRetornoMesa(armaz, 1, 5), '/mobile-mesas/?mesa=2');
  assert.equal(globalThis.MobilePdv.destinoRetornoMesa(armaz, 1, null), '/mobile-mesas/?mesa=2');
  assert.equal(globalThis.MobilePdv.destinoRetornoMesa(armaz, 2, 5), null);
  assert.equal(globalThis.MobilePdv.destinoRetornoMesa(armaz, 1, 6), null);
  armaz.setItem('cdsMesaRetorno', '{"mesa_id":"x"}');
  assert.equal(globalThis.MobilePdv.destinoRetornoMesa(armaz, 1, 5), null);
  armaz.setItem('cdsMesaRetorno', 'lixo');
  assert.equal(globalThis.MobilePdv.destinoRetornoMesa(armaz, 1, 5), null);
  assert.match(ler('frontend/mobile-pdv/index.html'), /id="mv-voltar-mesa"/);
  assert.match(ler('frontend/mobile-pdv/index.html'), /id="mv-voltar-mesa-fim"/);
});

test('MESAS-07 sessão expirada no handoff pede novo login em vez de navegar', async () => {
  const s = montar({ preparar: () => resposta(403, { code: 'SESSAO_INVALIDA', error: 'Token inválido ou expirado' }) });
  const r = await s.executar();
  assert.equal(r.ok, false);
  assert.equal(r.autenticacao, true);
  assert.equal(s.sessao.getItem('pdvPedidoHandoff'), null);
});

test('MESAS-07 página de mesas carrega o encaminhamento oficial e limpa a dica de retorno', () => {
  assert.match(ler('frontend/mobile-mesas/index.html'), /\/mobile-pedido\/mobile-pedido\.js/);
  assert.match(ler('frontend/mobile-mesas/mobile-mesas.js'), /removeItem\(CHAVE_RETORNO\)/);
});
