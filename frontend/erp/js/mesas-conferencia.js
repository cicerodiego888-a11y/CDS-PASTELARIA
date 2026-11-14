/**
 * Conferência e envio à preparação do pedido de salão.
 * Salvar e finalizar não chamam o envio. O relógio é o horário devolvido pelo servidor.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CdsMesasConferencia = api;
}(typeof window !== 'undefined' ? window : globalThis, function factory() {
  'use strict';

  const MENSAGENS = Object.freeze({
    ATENDIMENTO_NAO_ABERTO: 'Não há atendimento ativo nesta mesa.',
    ATENDIMENTO_JA_ENCERRADO: 'O atendimento já está encerrado.',
    ATENDIMENTO_EM_FECHAMENTO: 'A mesa está em fechamento e não recebe envio à preparação.',
    PEDIDO_FORA_DO_SALAO: 'O pedido não está vinculado ao atendimento da mesa.',
    PEDIDO_FORA_DO_ATENDIMENTO: 'O pedido não pertence ao atendimento ativo desta mesa.',
    PEDIDO_OUTRA_EMPRESA: 'O pedido não pertence à empresa da sessão.',
    PEDIDO_NAO_ENCONTRADO: 'O pedido não foi encontrado.',
    PREPARACAO_JA_CONCLUIDA: 'A preparação já foi concluída.',
    PREPARACAO_ESTADO_INCOMPATIVEL: 'Este pedido não pode ser enviado à preparação.',
    PREPARACAO_CONCORRENTE: 'O envio mudou. Consulte o pedido novamente.',
    PREPARACAO_JA_ENVIADA: 'O pedido já foi enviado para preparação.',
    CHAVE_IDEMPOTENCIA_DIVERGENTE: 'Esta operação já foi usada em outro contexto.',
    RESPOSTA_INVALIDA: 'Resposta inválida do servidor. O envio não foi confirmado.',
    REDE: 'Não foi possível falar com o servidor. O pedido foi preservado.'
  });

  function escapar(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fluxoDoPedido(pedido) {
    if (!pedido) return 'legado';
    if (pedido.mesa_id != null || pedido.mesa_atendimento_id != null) return 'salao';
    return 'legado';
  }

  function metodoPersistencia(pedidoId) {
    return pedidoId ? 'PUT' : 'POST';
  }

  function comercialBloqueado(pedido) {
    const status = String(pedido && pedido.status || '').toUpperCase();
    return status === 'FATURADO' || status === 'CANCELADO' || status === 'ORCAMENTO';
  }

  function acaoDoPedido(pedido) {
    const estado = (pedido && pedido.preparacao && pedido.preparacao.estado) || 'NAO_ENVIADO';
    if (comercialBloqueado(pedido) || estado === 'EM_PREPARACAO' || estado === 'CONCLUIDO') {
      return { rotulo: 'Ver pedido', editar: false, enviar: false };
    }
    return { rotulo: 'Conferir pedido', editar: true, enviar: true };
  }

  function decidirConsultaPedido(consulta, pedido, opcoes) {
    const opts = opcoes || {};
    if (opts.rede) {
      return {
        ok: false,
        abrir: false,
        sucesso: false,
        criarPedido: false,
        mensagem: MENSAGENS.REDE
      };
    }
    if (opts.geracao != null && opts.geracaoAtual != null && opts.geracao !== opts.geracaoAtual) {
      return { ok: false, abrir: false, obsoleta: true, criarPedido: false };
    }
    if (!pedido || !pedido.id) {
      return { ok: false, abrir: false, sucesso: false, criarPedido: false, codigo: 'PEDIDO_NAO_ENCONTRADO', mensagem: MENSAGENS.PEDIDO_NAO_ENCONTRADO };
    }
    const dados = consulta || {};
    if (dados.empresa_id != null && pedido.empresa_id != null && Number(dados.empresa_id) !== Number(pedido.empresa_id)) {
      return { ok: false, abrir: false, sucesso: false, criarPedido: false, codigo: 'PEDIDO_OUTRA_EMPRESA', mensagem: MENSAGENS.PEDIDO_OUTRA_EMPRESA };
    }
    const atendimento = dados.atendimento || null;
    if (dados.situacao === 'FECHAMENTO') {
      return { ok: false, abrir: false, sucesso: false, criarPedido: false, codigo: 'ATENDIMENTO_EM_FECHAMENTO', mensagem: MENSAGENS.ATENDIMENTO_EM_FECHAMENTO };
    }
    if (!atendimento || dados.situacao !== 'OCUPADA') {
      return { ok: false, abrir: false, sucesso: false, criarPedido: false, codigo: 'ATENDIMENTO_JA_ENCERRADO', mensagem: MENSAGENS.ATENDIMENTO_JA_ENCERRADO };
    }
    if (Number(pedido.mesa_atendimento_id) !== Number(atendimento.id)) {
      return { ok: false, abrir: false, sucesso: false, criarPedido: false, codigo: 'PEDIDO_FORA_DO_ATENDIMENTO', mensagem: MENSAGENS.PEDIDO_FORA_DO_ATENDIMENTO };
    }
    const acao = acaoDoPedido(pedido);
    return {
      ok: true,
      abrir: true,
      sucesso: false,
      criarPedido: false,
      pedidoId: Number(pedido.id),
      editar: acao.editar,
      enviar: acao.enviar,
      rotulo: acao.rotulo,
      numero: dados.numero
    };
  }

  function preparacaoDe(pedido) {
    const prep = pedido && pedido.preparacao;
    if (prep && prep.estado) return prep;
    return {
      estado: 'NAO_ENVIADO',
      classificacao: 'NAO_ENVIADO',
      enviado_em: null,
      tempo_decorrido_segundos: null
    };
  }

  function criarConferencia(deps) {
    const fetchJson = deps && deps.fetchJson;
    const novaChave = deps && deps.novaChave;
    const chaves = new Map();
    let seq = 0;
    const estado = {
      ativo: true,
      emCurso: false,
      geracao: 0,
      etapa: 'edicao',
      pedido: null,
      numero: null,
      preparacao: null,
      lista: [],
      aviso: '',
      sucesso: ''
    };

    function chaveDo(pedidoId) {
      const id = Number(pedidoId);
      if (!chaves.has(id)) chaves.set(id, novaChave());
      return chaves.get(id);
    }

    function finalizar(pedido, extra) {
      if (!pedido || !pedido.id) return { ok: false, codigo: 'PEDIDO_NAO_CONFIRMADO' };
      estado.geracao += 1;
      estado.ativo = true;
      estado.pedido = pedido;
      estado.numero = extra && extra.numero != null ? extra.numero : pedido.mesa_numero;
      estado.preparacao = preparacaoDe(pedido);
      estado.lista = [];
      estado.aviso = '';
      estado.sucesso = '';
      const somenteLeitura = estado.preparacao.estado !== 'NAO_ENVIADO' || comercialBloqueado(pedido);
      estado.etapa = somenteLeitura ? 'enviado' : 'conferencia';
      return { ok: true, enviado: false, pedidoId: Number(pedido.id) };
    }

    function podeEnviar() {
      const pedido = estado.pedido;
      const prep = estado.preparacao || {};
      if (!pedido || !pedido.id) return { ok: false, codigo: 'PEDIDO_NAO_CONFIRMADO' };
      if (pedido.mesa_atendimento_id == null) return { ok: false, codigo: 'PEDIDO_FORA_DO_SALAO' };
      const status = String(pedido.status || '').toUpperCase();
      if (status === 'CANCELADO' || status === 'FATURADO' || status === 'ORCAMENTO') {
        return { ok: false, codigo: 'PREPARACAO_ESTADO_INCOMPATIVEL' };
      }
      if (prep.estado === 'CONCLUIDO') return { ok: false, codigo: 'PREPARACAO_JA_CONCLUIDA' };
      if (prep.estado === 'EM_PREPARACAO') return { ok: false, codigo: 'PREPARACAO_JA_ENVIADA' };
      if (estado.etapa !== 'conferencia') return { ok: false, codigo: 'CONFERENCIA_AUSENTE' };
      return { ok: true };
    }

    async function enviar() {
      if (!estado.ativo) return { obsoleta: true };
      if (estado.emCurso) return { ok: false, ignorada: true };
      const permitido = podeEnviar();
      if (!permitido.ok) {
        if (permitido.codigo !== 'PREPARACAO_JA_ENVIADA') {
          estado.sucesso = '';
          estado.aviso = MENSAGENS[permitido.codigo] || 'O pedido não pode ser enviado.';
        }
        return permitido;
      }
      estado.emCurso = true;
      const ticket = ++seq;
      const geracao = estado.geracao;
      const pedidoId = Number(estado.pedido.id);
      try {
        const data = await fetchJson('POST', `/pedidos/${pedidoId}/preparacao/enviar`, chaveDo(pedidoId));
        if (!estado.ativo || geracao !== estado.geracao || ticket !== seq) return { obsoleta: true };
        const prep = data && data.preparacao;
        if (!prep || !prep.enviado_em || prep.estado !== 'EM_PREPARACAO') {
          estado.sucesso = '';
          estado.aviso = MENSAGENS.RESPOSTA_INVALIDA;
          return { ok: false, codigo: 'RESPOSTA_INVALIDA' };
        }
        estado.preparacao = prep;
        estado.etapa = 'enviado';
        estado.aviso = '';
        estado.sucesso = 'Enviado para preparação.';
        if (deps.listarPedidos) {
          try {
            const lista = await deps.listarPedidos(estado.pedido.mesa_id);
            if (estado.ativo && geracao === estado.geracao) estado.lista = (lista && lista.pedidos) || [];
          } catch (_err) {
            if (estado.ativo && geracao === estado.geracao) {
              estado.aviso = 'O envio foi registrado. A lista da mesa não pôde ser atualizada.';
            }
          }
        }
        return { ok: true, preparacao: estado.preparacao, pedidoId };
      } catch (err) {
        if (!estado.ativo || geracao !== estado.geracao) return { obsoleta: true };
        estado.sucesso = '';
        const codigo = err && (err.codigo || err.code);
        estado.aviso = (codigo && MENSAGENS[codigo]) || (err && err.rede ? MENSAGENS.REDE : (err && err.message)) || MENSAGENS.REDE;
        return { ok: false, codigo: codigo || (err && err.rede ? 'REDE' : undefined) };
      } finally {
        if (ticket === seq) estado.emCurso = false;
      }
    }

    function corrigir() {
      const prep = estado.preparacao || {};
      if (!estado.pedido || prep.estado !== 'NAO_ENVIADO') return { ok: false };
      estado.geracao += 1;
      estado.etapa = 'edicao';
      estado.sucesso = '';
      estado.aviso = '';
      return { ok: true, pedidoId: Number(estado.pedido.id) };
    }

    function dispensar() {
      estado.geracao += 1;
      estado.etapa = 'edicao';
      estado.sucesso = '';
      estado.aviso = '';
      estado.emCurso = false;
    }

    function parar() {
      estado.ativo = false;
      dispensar();
    }

    return {
      estado,
      finalizar,
      enviar,
      corrigir,
      dispensar,
      parar,
      podeEnviar,
      html: () => htmlConferencia(estado)
    };
  }

  function htmlConferencia(estado) {
    if (!estado || !estado.pedido || (estado.etapa !== 'conferencia' && estado.etapa !== 'enviado')) return '';
    const pedido = estado.pedido;
    const prep = estado.preparacao || {};
    const numero = estado.numero != null ? estado.numero : pedido.mesa_numero;
    const itens = Array.isArray(pedido.itens) ? pedido.itens : [];
    const linhas = itens.map((item) => `
      <li>${escapar(item.produto_nome || item.produto_codigo || ('Produto ' + item.produto_id))} · quantidade ${escapar(item.quantidade)}</li>`).join('');
    const total = pedido.total != null ? `<p>Total ${escapar(pedido.total)}</p>` : '';
    const aviso = estado.aviso ? `<div class="alert alert-warning" role="status">${escapar(estado.aviso)}</div>` : '';
    const sucesso = estado.sucesso ? `<div class="alert alert-success" role="status">${escapar(estado.sucesso)}</div>` : '';
    const enviada = prep.estado === 'EM_PREPARACAO' || prep.estado === 'CONCLUIDO';
    const bloqueado = comercialBloqueado(pedido);
    const acoes = bloqueado ? `
      <p>O pedido está ${escapar(String(pedido.status || '').toUpperCase())} e esta tela não altera os itens nem reenvia à preparação.</p>` : (enviada ? `
      <p><strong>Enviado para preparação.</strong> Este é o registro operacional do ERP. Não confirma recebimento por cozinha, impressora ou KDS.</p>
      <p>Estado ${escapar(prep.estado === 'EM_PREPARACAO' ? 'Em preparação' : 'Concluído')}</p>
      <p>Envio ${escapar(prep.enviado_em || '—')}</p>
      ${prep.concluido_em ? `<p>Conclusão ${escapar(prep.concluido_em)}</p>` : ''}
      <p>Classificação ${escapar(prep.classificacao || '—')}</p>
      ${prep.tempo_decorrido_segundos != null ? `<p>Tempo informado pelo servidor ${escapar(prep.tempo_decorrido_segundos)} s</p>` : ''}
      <button type="button" class="btn btn-primary" data-acao="outro">Lançar outro pedido nesta mesa</button>` : `
      <button type="button" class="btn btn-success" data-acao="enviar">Enviar pedido para cozinha</button>
      <button type="button" class="btn btn-outline-secondary" data-acao="corrigir">Corrigir lançamento</button>`);
    const lista = (estado.lista || []).map((item) => {
      const itemPrep = item.preparacao || {};
      return `<li>${escapar(item.codigo || ('Pedido ' + item.id))} · ${escapar(itemPrep.estado || '—')} · ${escapar(itemPrep.classificacao || '—')}</li>`;
    }).join('');
    return `
      <section class="card shadow-sm mb-3" id="pedConferencia" data-conferencia="1">
        <div class="card-body">
          ${aviso}
          ${sucesso}
          <h2 class="h5">Conferência do pedido</h2>
          <p>Mesa ${escapar(numero == null ? '—' : numero)}</p>
          <p>Pedido ${escapar(pedido.codigo || ('#' + pedido.id))}</p>
          <p>Observação ${escapar(pedido.observacao || '—')}</p>
          ${total}
          <ul class="mb-3">${linhas || '<li>Nenhum item retornado pelo servidor.</li>'}</ul>
          ${acoes}
          ${lista ? `<h3 class="h6 mt-3">Pedidos desta mesa</h3><ul>${lista}</ul>` : ''}
        </div>
      </section>`;
  }

  return {
    MENSAGENS,
    fluxoDoPedido,
    metodoPersistencia,
    acaoDoPedido,
    decidirConsultaPedido,
    criarConferencia,
    htmlConferencia
  };
}));
