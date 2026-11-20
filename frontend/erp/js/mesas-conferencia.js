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
    DESPACHO_JA_CONCLUIDO: 'O pedido já foi confirmado no KDS.',
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
    const despacho = despachoDe(pedido);
    const faturado = String(pedido && pedido.status || '').toUpperCase() === 'FATURADO';
    if ((comercialBloqueado(pedido) && !faturado) || despacho.status === 'CONCLUIDO') {
      return { rotulo: 'Ver pedido', editar: false, enviar: false };
    }
    if (estado === 'EM_PREPARACAO' || estado === 'CONCLUIDO') {
      return { rotulo: 'Reprocessar envio ao KDS', editar: false, enviar: true };
    }
    if (faturado) return { rotulo: 'Conferir pedido', editar: false, enviar: true };
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

  function despachoDe(pedido) {
    const despacho = pedido && pedido.despacho;
    if (despacho && typeof despacho === 'object') return despacho;
    return {
      resolucao_status: pedido && pedido.cozinha_resolucao_status || null,
      status: pedido && pedido.cozinha_despacho_status || null,
      codigo: pedido && pedido.cozinha_despacho_codigo || null,
      unidade_id: pedido && pedido.unidade_cozinha_destino_id != null
        ? Number(pedido.unidade_cozinha_destino_id)
        : null
    };
  }

  function textoDespacho(despacho) {
    if (despacho.status === 'CONCLUIDO') return 'Enviado ao KDS';
    if (despacho.status === 'EM_ANDAMENTO') return 'Despacho em andamento';
    if (despacho.status === 'BLOQUEADO') return 'Bloqueado';
    if (despacho.status === 'FALHA') return 'Falha no despacho';
    if (despacho.resolucao_status && despacho.resolucao_status !== 'RESOLVIDO') {
      return `Destino pendente (${despacho.resolucao_status})`;
    }
    return 'Ainda não confirmado no KDS';
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
      sucesso: '',
      impressao: null,
      previaEmJanela: !!(deps && deps.previaEmJanela)
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
      estado.impressao = null;
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
      if (status === 'CANCELADO' || status === 'ORCAMENTO') {
        return { ok: false, codigo: 'PREPARACAO_ESTADO_INCOMPATIVEL' };
      }
      if (!['NAO_ENVIADO', 'EM_PREPARACAO', 'CONCLUIDO'].includes(prep.estado)) {
        return { ok: false, codigo: 'PREPARACAO_ESTADO_INCOMPATIVEL' };
      }
      if (despachoDe(pedido).status === 'CONCLUIDO') return { ok: false, codigo: 'DESPACHO_JA_CONCLUIDO' };
      if (estado.etapa !== 'conferencia' && estado.etapa !== 'enviado') {
        return { ok: false, codigo: 'CONFERENCIA_AUSENTE' };
      }
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
        if (!prep || !prep.enviado_em || !['EM_PREPARACAO', 'CONCLUIDO'].includes(prep.estado)) {
          estado.sucesso = '';
          estado.aviso = MENSAGENS.RESPOSTA_INVALIDA;
          return { ok: false, codigo: 'RESPOSTA_INVALIDA' };
        }
        estado.preparacao = prep;
        estado.pedido.despacho = data && data.despacho && typeof data.despacho === 'object'
          ? data.despacho
          : null;
        estado.etapa = 'enviado';
        const despacho = despachoDe(estado.pedido);
        const despachoConcluido = despacho.status === 'CONCLUIDO' && despacho.success === true;
        const podeMostrarComanda = despachoConcluido
          && Number(despacho.pedido_id) === pedidoId
          && Number.isInteger(Number(despacho.unidade_id)) && Number(despacho.unidade_id) > 0
          && Number.isInteger(Number(despacho.rodada_id)) && Number(despacho.rodada_id) > 0;
        estado.aviso = despachoConcluido
          ? (podeMostrarComanda ? '' : 'KDS confirmado, mas os dados da rodada para apresentar a comanda estão incompletos.')
          : (despacho.mensagem || despacho.codigo
            ? [despacho.codigo, despacho.mensagem].filter(Boolean).join(': ')
            : 'A preparação ERP foi registrada, mas o envio ao KDS não foi confirmado.');
        estado.sucesso = despachoConcluido ? 'Pedido enviado ao KDS.' : '';
        if (!despachoConcluido) {
          estado.aviso = `Preparação ERP registrada; envio ao KDS não concluído. ${estado.aviso}`;
        }
        const previaPendente = podeMostrarComanda ? perguntarImpressao() : null;
        if (!previaPendente && deps.aoAtualizar) deps.aoAtualizar();
        if (deps.listarPedidos) {
          try {
            const lista = await deps.listarPedidos(estado.pedido.mesa_id);
            if (estado.ativo && geracao === estado.geracao) {
              estado.lista = (lista && lista.pedidos) || [];
              const atualizado = estado.lista.find((item) => Number(item.id) === pedidoId);
              if (atualizado && atualizado.despacho) {
                estado.pedido.despacho = {
                  ...atualizado.despacho,
                  ...despacho,
                  mensagem: despacho.mensagem || atualizado.despacho.mensagem || null
                };
              }
            }
          } catch (_err) {
            if (estado.ativo && geracao === estado.geracao && despachoConcluido) {
              estado.aviso = [estado.aviso, 'O envio foi registrado. A lista da mesa não pôde ser atualizada.'].filter(Boolean).join(' ');
            }
          }
        }
        if (!estado.ativo || geracao !== estado.geracao || ticket !== seq) return { obsoleta: true };
        if (previaPendente) await previaPendente;
        if (!estado.ativo || geracao !== estado.geracao || ticket !== seq) return { obsoleta: true };
        return { ok: despachoConcluido, preparacao: estado.preparacao, despacho: estado.pedido.despacho, pedidoId };
      } catch (err) {
        if (!estado.ativo || geracao !== estado.geracao) return { obsoleta: true };
        estado.sucesso = '';
        const codigo = err && (err.codigo || err.code);
        estado.aviso = (err && err.rede ? MENSAGENS.REDE : (err && err.message))
          || (codigo && MENSAGENS[codigo]) || MENSAGENS.REDE;
        return { ok: false, codigo: codigo || (err && err.rede ? 'REDE' : undefined) };
      } finally {
        if (ticket === seq) estado.emCurso = false;
      }
    }

    function corrigir() {
      const prep = estado.preparacao || {};
      if (!estado.pedido || comercialBloqueado(estado.pedido) || prep.estado !== 'NAO_ENVIADO') return { ok: false };
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
      estado.impressao = null;
    }

    async function perguntarImpressao() {
      const despacho = despachoDe(estado.pedido);
      if (!estado.pedido || despacho.status !== 'CONCLUIDO' || despacho.success === false) return;
      if (estado.impressao && estado.impressao.etapa !== 'falha_previa') return;
      const atual = { etapa: 'carregando', pedidoId: Number(estado.pedido.id), mensagem: '' };
      estado.impressao = atual;
      if (deps.aoAtualizar) deps.aoAtualizar();
      try {
        if (!deps.carregarComanda) throw new Error('Prévia da comanda indisponível.');
        const comanda = await deps.carregarComanda(atual.pedidoId);
        if (estado.impressao !== atual) return;
        if (!comanda || !Number.isInteger(Number(comanda.snapshot_id))
          || Number(comanda.snapshot_id) <= 0 || typeof comanda.html !== 'string' || !comanda.html) {
          throw new Error('Resposta da comanda inválida.');
        }
        atual.snapshotId = Number(comanda.snapshot_id);
        atual.html = comanda.html;
        atual.etapa = 'pergunta';
      } catch (err) {
        if (estado.impressao !== atual) return;
        atual.etapa = 'falha_previa';
        atual.mensagem = err.message || 'Não foi possível carregar a comanda.';
      }
      if (estado.impressao === atual && deps.aoAtualizar) deps.aoAtualizar();
    }

    function naoImprimir() {
      if (estado.impressao && estado.impressao.etapa !== 'imprimindo') estado.impressao = null;
    }

    async function imprimir() {
      const atual = estado.impressao;
      if (!atual || !['pergunta', 'falha'].includes(atual.etapa)) return { ignorada: true };
      atual.etapa = 'imprimindo';
      atual.mensagem = '';
      try {
        if (!deps.imprimirComanda) throw new Error('Impressão de comanda indisponível.');
        const resultado = await deps.imprimirComanda(atual.snapshotId);
        if (estado.impressao !== atual) return { obsoleta: true };
        if (!resultado || resultado.estado !== 'ACEITA_PELO_SPOOLER') {
          throw new Error(resultado && resultado.detalhe || 'Falha ao encaminhar a impressão.');
        }
        atual.etapa = 'aceita';
        atual.mensagem = 'Solicitação aceita pelo spooler. A impressão física não foi confirmada.';
        return { ok: true };
      } catch (err) {
        if (estado.impressao !== atual) return { obsoleta: true };
        atual.etapa = 'falha';
        atual.mensagem = err.message || 'Falha de comunicação com a impressão.';
        return { ok: false };
      }
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
      perguntarImpressao,
      naoImprimir,
      imprimir,
      html: () => htmlConferencia(estado)
    };
  }

  function htmlConferencia(estado) {
    if (!estado || !estado.pedido || (estado.etapa !== 'conferencia' && estado.etapa !== 'enviado')) return '';
    const pedido = estado.pedido;
    const prep = estado.preparacao || {};
    const despacho = despachoDe(pedido);
    const despachoStatus = textoDespacho(despacho);
    const numero = estado.numero != null ? estado.numero : pedido.mesa_numero;
    const itens = Array.isArray(pedido.itens) ? pedido.itens : [];
    const linhas = itens.map((item) => `
      <li>${escapar(item.produto_nome || item.produto_codigo || ('Produto ' + item.produto_id))} · quantidade ${escapar(item.quantidade)}</li>`).join('');
    const total = pedido.total != null ? `<p>Total ${escapar(pedido.total)}</p>` : '';
    const aviso = estado.aviso ? `<div class="alert alert-warning" role="status">${escapar(estado.aviso)}</div>` : '';
    const sucesso = estado.sucesso ? `<div class="alert alert-success" role="status">${escapar(estado.sucesso)}</div>` : '';
    const enviada = prep.estado === 'EM_PREPARACAO' || prep.estado === 'CONCLUIDO';
    const status = String(pedido.status || '').toUpperCase();
    const bloqueado = status === 'CANCELADO' || status === 'ORCAMENTO';
    const despachoConcluido = despacho.status === 'CONCLUIDO' && despacho.success !== false;
    const impressao = estado.impressao;
    const painelImpressao = impressao ? `
      <div class="alert alert-light border mt-3" role="status">
        <strong>Pedido enviado para a cozinha.</strong>
        ${impressao.html && !estado.previaEmJanela ? `<iframe title="Prévia da comanda" sandbox srcdoc="${escapar(impressao.html)}" style="width:100%;max-width:320px;height:320px;border:1px solid #ddd;background:#fff"></iframe>` : ''}
        ${impressao.html && estado.previaEmJanela && impressao.etapa === 'pergunta' ? '<p>Prévia da comanda aberta em outra janela.</p>' : ''}
        ${impressao.etapa === 'carregando' ? '<p>Carregando comanda...</p>' : ''}
        ${impressao.etapa === 'imprimindo' ? '<p>Encaminhando impressão...</p>' : ''}
        ${impressao.mensagem ? `<p>${escapar(impressao.mensagem)}</p>` : ''}
        ${impressao.etapa === 'falha_previa' ? '<button type="button" class="btn btn-outline-secondary" data-acao="reimprimir-comanda">Tentar carregar comanda</button> <button type="button" class="btn btn-outline-secondary" data-acao="nao-imprimir">Não, agora não</button>' : ''}
        ${!estado.previaEmJanela && ['pergunta', 'falha'].includes(impressao.etapa) ? `
          <div data-confirmacao-previa>
          <p>Deseja imprimir a comanda?</p>
          <button type="button" class="btn btn-primary" data-acao="imprimir-comanda">${impressao.etapa === 'falha' ? 'Tentar novamente' : 'Sim, imprimir'}</button>
          <button type="button" class="btn btn-outline-secondary" data-acao="nao-imprimir">Não, agora não</button>
          </div>` : ''}
      </div>` : '';
    const botaoKds = despachoConcluido
      ? '<button type="button" class="btn btn-primary" data-acao="outro">Lançar outro pedido nesta mesa</button>'
      : `<button type="button" class="btn btn-success" data-acao="enviar">${enviada ? 'Reprocessar envio ao KDS' : 'Enviar ao KDS e iniciar preparação'}</button>
        ${!enviada && !comercialBloqueado(pedido) ? '<button type="button" class="btn btn-outline-secondary" data-acao="corrigir">Corrigir lançamento</button>' : ''}`;
    const acoes = bloqueado ? `
      <p>O pedido está ${escapar(String(pedido.status || '').toUpperCase())} e esta tela não altera os itens nem reenvia à preparação.</p>` : `
      ${enviada ? `
      <p><strong>Preparação ERP:</strong> ${escapar(prep.estado === 'EM_PREPARACAO' ? 'Em preparação' : 'Concluída')}</p>
      <p>Estado ${escapar(prep.estado === 'EM_PREPARACAO' ? 'Em preparação' : 'Concluído')}</p>
      <p>Envio ${escapar(prep.enviado_em || '—')}</p>
      ${prep.concluido_em ? `<p>Conclusão ${escapar(prep.concluido_em)}</p>` : ''}
      <p>Classificação ${escapar(prep.classificacao || '—')}</p>
      ${prep.tempo_decorrido_segundos != null ? `<p>Tempo informado pelo servidor ${escapar(prep.tempo_decorrido_segundos)} s</p>` : ''}` : ''}
      <p><strong>KDS:</strong> ${escapar(despachoStatus)}${despacho.unidade_id != null ? ` · unidade ${escapar(despacho.unidade_id)}` : ''}</p>
      ${despacho.codigo ? `<p>Código: ${escapar(despacho.codigo)}</p>` : ''}
      ${despacho.mensagem ? `<p>${escapar(despacho.mensagem)}</p>` : ''}
      ${botaoKds}
      ${despachoConcluido && !impressao ? '<button type="button" class="btn btn-outline-secondary" data-acao="reimprimir-comanda">Imprimir comanda</button>' : ''}
      ${painelImpressao}`;
    const lista = (estado.lista || []).map((item) => {
      const itemPrep = item.preparacao || {};
      return `<li>${escapar(item.codigo || ('Pedido ' + item.id))} · ${escapar(itemPrep.estado || '—')} · KDS ${escapar(textoDespacho(item.despacho || {}))}</li>`;
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
