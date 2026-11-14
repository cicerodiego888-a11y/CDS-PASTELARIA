/**
 * Casca mobile de MESAS.
 * Só apresenta e dispara o que o servidor já decide: o controlador de mesas
 * (CdsPainelMesasApi) e a conferência (CdsMesasConferencia) são os mesmos do desktop.
 * Não grava pedido, não fecha venda e não confia em empresa, operador ou atendimento do cliente.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MobileMesas = api;
  if (root && root.document && root.document.getElementById && root.document.getElementById('mm-app')) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => { api.iniciar(root).catch(api.falhaFatal(root)); });
    } else {
      api.iniciar(root).catch(api.falhaFatal(root));
    }
  }
}(typeof window !== 'undefined' ? window : globalThis, function factory(root) {
  'use strict';

  const MSG_REDE = 'Sem conexão com o servidor. A operação não foi confirmada: confira a situação da mesa antes de repetir.';
  const CAMINHO = '/mobile-mesas/';

  function escapar(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function dinheiro(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return escapar(valor == null ? '—' : valor);
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function painel() { return root.CdsPainelMesasApi; }
  function conferenciaApi() { return root.CdsMesasConferencia; }

  function rotuloSituacao(situacao) {
    if (situacao === 'OCUPADA') return 'Ocupada';
    if (situacao === 'FECHAMENTO') return 'Em fechamento';
    return 'Livre';
  }

  function classeSituacao(situacao) {
    if (situacao === 'OCUPADA') return 'ocupada';
    if (situacao === 'FECHAMENTO') return 'fechamento';
    return 'livre';
  }

  function rotuloEstadoPreparacao(estado) {
    if (estado === 'EM_PREPARACAO') return 'Em preparação';
    if (estado === 'CONCLUIDO') return 'Concluído';
    return 'Não enviado';
  }

  function rotuloClassificacao(classificacao) {
    return {
      NORMAL: 'Normal', ATRASADO: 'Atrasado', CRITICO: 'Crítico', CONCLUIDO: 'Concluído'
    }[classificacao] || '';
  }

  function filtrar(itens, filtro) {
    if (!filtro || filtro === 'TODAS') return itens;
    return itens.filter((item) => item.situacao === filtro);
  }

  function htmlAvisos(estado, rede) {
    const aviso = estado.aviso && !(rede && estado.aviso === MSG_REDE) ? estado.aviso : '';
    return `${aviso ? `<div class="mm-aviso" role="status">${escapar(aviso)}</div>` : ''}${
      estado.sucesso ? `<div class="mm-sucesso" role="status">${escapar(estado.sucesso)}</div>` : ''}`;
  }

  function htmlLista(estado, opcoes) {
    const p = painel();
    const filtro = (opcoes && opcoes.filtro) || 'TODAS';
    const instante = (opcoes && opcoes.agora) || new Date();
    const totais = p.contadores(estado.itens);
    const visiveis = filtrar(estado.itens, filtro);
    const cards = visiveis.map((item) => {
      const ocupada = item.situacao === 'OCUPADA' && item.atendimento;
      const classe = classeSituacao(item.situacao);
      return `
        <button type="button" class="mm-card mm-card--${classe}${item.ativo === false ? ' mm-card--inativa' : ''}" data-acao="abrir-mesa" data-mesa-id="${escapar(item.id)}" aria-label="Mesa ${escapar(p.numeroMesa(item.numero))}, ${escapar(rotuloSituacao(item.situacao))}">
          <span class="mm-card__numero">${escapar(p.numeroMesa(item.numero))}</span>
          <span class="mm-card__texto">
            <span class="mm-selo mm-selo--${classe}">${escapar(rotuloSituacao(item.situacao))}</span>
            ${ocupada ? `<small>Permanência ${escapar(p.permanencia(item.atendimento.aberto_em, instante))}</small>` : ''}
            ${item.ativo === false ? '<small>Mesa desativada</small>' : ''}
          </span>
        </button>`;
    }).join('');
    const chip = (valor, rotulo, quantidade) => `
      <button type="button" class="mm-filtro${filtro === valor ? ' is-ativo' : ''}" data-acao="filtro" data-filtro="${valor}" aria-pressed="${filtro === valor}">
        <strong>${quantidade}</strong><span>${rotulo}</span>
      </button>`;
    return `
      <h1>Mesas</h1>
      ${htmlAvisos(estado, opcoes && opcoes.rede)}
      <div class="mm-contadores">
        ${chip('LIVRE', 'Livres', totais.livres)}
        ${chip('OCUPADA', 'Ocupadas', totais.ocupadas)}
        ${chip('FECHAMENTO', 'Fechamento', totais.fechamento)}
      </div>
      ${filtro !== 'TODAS' ? '<button type="button" class="mp-btn" data-acao="filtro" data-filtro="TODAS">Mostrar todas as mesas</button>' : ''}
      <div class="mm-grade" data-grade="1">${cards || `<p class="mm-vazio">${estado.itens.length ? 'Nenhuma mesa nesta situação.' : (opcoes && opcoes.rede ? 'Aguardando a conexão para carregar as mesas.' : 'Nenhuma mesa cadastrada nesta empresa.')}</p>`}</div>`;
  }

  function blocoAtendimento(atendimento, instante) {
    if (!atendimento) return '';
    const p = painel();
    const cliente = atendimento.cliente_nome
      ? `Cliente: ${escapar(atendimento.cliente_nome)}`
      : (atendimento.cliente_id != null ? `Cliente nº ${escapar(atendimento.cliente_id)}` : 'Cliente não identificado');
    return `
      <div class="mm-bloco">
        <p>${cliente}</p>
        <p>Operador da abertura nº ${escapar(atendimento.operador_abertura_id)}</p>
        <p>Abertura ${escapar(atendimento.aberto_em || '—')}</p>
        <p>Permanência ${escapar(p.permanencia(atendimento.aberto_em, instante))}</p>
      </div>`;
  }

  function blocoPedidos(pedidos, permitirAbrir) {
    const p = painel();
    const conf = conferenciaApi();
    if (!pedidos || !pedidos.length) return '<p class="mm-vazio">Nenhum pedido vinculado a este atendimento.</p>';
    return pedidos.map((pedido) => {
      const prep = pedido.preparacao || {};
      const estado = prep.estado || (prep.classificacao === 'CONCLUIDO' ? 'CONCLUIDO' : 'NAO_ENVIADO');
      const emPreparacao = estado === 'EM_PREPARACAO';
      const tempo = prep.tempo_decorrido_segundos == null || (!emPreparacao && estado !== 'CONCLUIDO')
        ? 'Sem contagem'
        : p.formatarDuracao(prep.tempo_decorrido_segundos);
      const classificacao = emPreparacao && rotuloClassificacao(prep.classificacao)
        ? ` <span class="mm-prep mm-prep--${escapar(String(prep.classificacao || '').toLowerCase())}">${escapar(rotuloClassificacao(prep.classificacao))}</span>`
        : '';
      const acao = conf.acaoDoPedido(pedido);
      return `
        <article class="mm-pedido" data-pedido-card="${escapar(pedido.id)}">
          <strong>${escapar(pedido.codigo || ('Pedido ' + pedido.id))}</strong>
          <div>Estado comercial ${escapar(pedido.status || '—')}</div>
          <div>Preparação <span class="mm-prep">${escapar(rotuloEstadoPreparacao(estado))}</span>${classificacao}</div>
          <div>Envio ${escapar(prep.enviado_em || '—')}</div>
          <div>Tempo ${escapar(tempo)}</div>
          ${pedido.total != null ? `<div>Total ${dinheiro(pedido.total)}</div>` : ''}
          ${permitirAbrir ? `<button type="button" class="mp-btn" data-acao="pedido" data-pedido-id="${escapar(pedido.id)}">${escapar(acao.rotulo)}</button>` : ''}
        </article>`;
    }).join('');
  }

  function htmlDetalhe(estado, opcoes) {
    const p = painel();
    const instante = (opcoes && opcoes.agora) || new Date();
    const mesa = (estado.itens || []).find((item) => Number(item.id) === Number(estado.mesaSelecionadaId));
    const detalhe = estado.detalhe || {};
    const atendimento = detalhe.atendimento || (mesa && mesa.atendimento) || null;
    const situacao = detalhe.situacao || (mesa && mesa.situacao) || 'LIVRE';
    const numero = p.numeroMesa(detalhe.numero != null ? detalhe.numero : (mesa && mesa.numero));
    const ativa = !(mesa && mesa.ativo === false);
    let corpo = '';
    if (situacao === 'LIVRE') {
      const sugestoes = (estado.clientesSugestoes || []).map((cliente) => `
        <button type="button" data-acao="selecionar-cliente" data-cliente-id="${escapar(cliente.id)}" data-cliente-nome="${escapar(cliente.nome)}">${escapar(cliente.nome || `Cliente nº ${cliente.id}`)}</button>`).join('');
      corpo = ativa ? `
        <p>Mesa livre. Ao abrir o atendimento você segue para o lançamento do pedido.</p>
        <label class="mp-label" for="mm-cliente">Cliente, se houver</label>
        <input id="mm-cliente" class="mp-campo" type="search" value="${escapar(estado.clienteNome)}" placeholder="Nome, CPF ou telefone" autocomplete="off" enterkeyhint="search">
        <div class="mm-sugestoes" id="mm-sugestoes">${sugestoes}</div>
        <p class="mp-ajuda" id="mm-cliente-ajuda" role="status">${escapar(estado.clienteBuscaStatus || (estado.clienteId ? `Cliente selecionado: ${estado.clienteNome}` : 'Opcional. Selecione um cliente cadastrado para vinculá-lo à mesa.'))}</p>
        <div class="mm-acoes"><button type="button" class="mp-btn mp-btn-primario" data-acao="abrir">Abrir atendimento</button></div>`
        : '<p>Mesa desativada. O atendimento não pode ser aberto.</p>';
    } else if (situacao === 'FECHAMENTO') {
      corpo = `
        <p>Esta mesa está em fechamento e não recebe pedido novo. A consulta abaixo é somente leitura.</p>
        ${blocoAtendimento(atendimento, instante)}
        <h2>Pedidos do atendimento</h2>
        ${blocoPedidos(estado.pedidos, false)}`;
    } else {
      const livres = p.mesasLivres(estado.itens, estado.mesaSelecionadaId);
      const destino = livres.find((item) => String(item.id) === String(estado.destinoId));
      const opcoesDestino = livres.map((item) => `<option value="${escapar(item.id)}"${String(item.id) === String(estado.destinoId) ? ' selected' : ''}>Mesa ${escapar(p.numeroMesa(item.numero))}</option>`).join('');
      corpo = `
        ${blocoAtendimento(atendimento, instante)}
        <div class="mm-acoes">
          ${ativa ? '<button type="button" class="mp-btn mp-btn-primario" data-acao="lancar">Lançar pedido</button>' : ''}
        </div>
        <h2>Pedidos do atendimento</h2>
        ${blocoPedidos(estado.pedidos, true)}
        <h2>Transferir atendimento</h2>
        <label class="mp-label" for="mm-destino">Para a mesa livre</label>
        <select id="mm-destino" class="mp-campo">
          <option value="">Selecione</option>
          ${opcoesDestino}
        </select>
        ${destino ? `<p>Transferir da mesa ${escapar(numero)} para a mesa ${escapar(p.numeroMesa(destino.numero))}.</p>
          <button type="button" class="mp-btn mp-btn-primario" data-acao="transferir">Confirmar transferência</button>` : (livres.length ? '' : '<p class="mm-vazio">Não há outra mesa livre nesta empresa.</p>')}`;
    }
    return `
      <div class="mm-titulo">
        <h1>Mesa ${escapar(numero)} <span class="mm-selo mm-selo--${classeSituacao(situacao)}">${escapar(rotuloSituacao(situacao))}</span></h1>
        <button type="button" class="mp-btn mm-voltar" data-acao="fechar">Mesas</button>
      </div>
      ${htmlAvisos(estado, opcoes && opcoes.rede)}
      ${corpo}`;
  }

  function htmlConferencia(vista) {
    const cab = `
      <div class="mm-titulo">
        <h1>Pedido da mesa</h1>
        <button type="button" class="mp-btn mm-voltar" data-acao="voltar-mesa">Voltar</button>
      </div>`;
    if (vista.carregando) return `${cab}<p class="mp-ajuda">Consultando o pedido…</p>`;
    if (vista.erro) {
      return `${cab}<div class="mm-aviso" role="status">${escapar(vista.erro)}</div>
        <div class="mm-acoes"><button type="button" class="mp-btn" data-acao="voltar-mesa">Voltar à mesa</button></div>`;
    }
    const estado = vista.ctrl.estado;
    const pedido = estado.pedido;
    const prep = estado.preparacao || {};
    const enviada = prep.estado === 'EM_PREPARACAO' || prep.estado === 'CONCLUIDO';
    const itens = (Array.isArray(pedido.itens) ? pedido.itens : []).map((item) => `
      <li>${escapar(item.quantidade)} × ${escapar(item.produto_nome || item.produto_codigo || ('Produto ' + item.produto_id))}${item.subtotal != null ? ` — ${dinheiro(item.subtotal)}` : ''}</li>`).join('');
    const status = String(pedido.status || '').toUpperCase();
    const bloqueado = status === 'FATURADO' || status === 'CANCELADO' || status === 'ORCAMENTO';
    let acoes;
    if (bloqueado) {
      acoes = `<p>O pedido está ${escapar(status)}. Esta tela não altera itens nem reenvia à preparação.</p>`;
    } else if (enviada) {
      const pdv = vista.pdv || { fase: 'idle' };
      const ocupado = pdv.fase === 'enviando';
      const jaVinculado = Number(pedido.venda_id) > 0;
      acoes = `
        <div class="mm-bloco">
          <p><strong>Enviado para preparação.</strong> Registro operacional do ERP; não confirma recebimento por cozinha, impressora ou KDS.</p>
          <p>Estado ${escapar(rotuloEstadoPreparacao(prep.estado))}</p>
          <p>Envio ${escapar(prep.enviado_em || '—')}</p>
          ${prep.concluido_em ? `<p>Conclusão ${escapar(prep.concluido_em)}</p>` : ''}
          ${rotuloClassificacao(prep.classificacao) ? `<p>Classificação ${escapar(rotuloClassificacao(prep.classificacao))}</p>` : ''}
        </div>
        ${pdv.mensagem ? `<div class="mm-aviso" role="alert">${escapar(pdv.mensagem)}</div>` : ''}
        <div class="mm-acoes">
          <button type="button" class="mp-btn mp-btn-primario" data-acao="finalizar-pdv"${ocupado || pdv.fase === 'confirmando' ? ' disabled' : ''}>${jaVinculado ? 'Recuperar operação no PDV' : 'Finalizar pedido e ir para o PDV'}</button>
          <button type="button" class="mp-btn" data-acao="outro">Lançar outro pedido nesta mesa</button>
        </div>
        <p class="mp-ajuda">Venda consolidada de vários pedidos da mesa: disponível apenas no computador. Aqui cada pedido segue para o PDV individualmente.</p>
        ${pdv.fase === 'confirmando' || ocupado ? `
        <div class="mm-modal" role="dialog" aria-modal="true" aria-labelledby="mm-modal-titulo">
          <div class="mm-modal__caixa">
            <h2 id="mm-modal-titulo">Finalizar pedido e ir para o PDV?</h2>
            <p>Pedido <strong>${escapar(pedido.codigo || ('#' + pedido.id))}</strong> da mesa ${escapar(estado.numero == null ? '—' : estado.numero)}${pedido.total != null ? ` — ${dinheiro(pedido.total)}` : ''}.</p>
            <p>O PDV será aberto para receber o pagamento. A mesa continua ocupada até a venda ser concluída.</p>
            <div class="mm-acoes">
              <button type="button" class="mp-btn mp-btn-primario" data-acao="pdv-confirmar"${ocupado ? ' disabled' : ''}>${ocupado ? 'Preparando o PDV…' : 'Confirmar e ir para o PDV'}</button>
              <button type="button" class="mp-btn" data-acao="pdv-cancelar"${ocupado ? ' disabled' : ''}>Cancelar</button>
            </div>
          </div>
        </div>` : ''}`;
    } else {
      acoes = `<div class="mm-acoes">
        <button type="button" class="mp-btn mp-btn-primario" data-acao="enviar"${estado.emCurso ? ' disabled' : ''}>${estado.emCurso ? 'Enviando…' : 'Enviar para preparação'}</button>
      </div>`;
    }
    return `${cab}
      ${estado.aviso ? `<div class="mm-aviso" role="status">${escapar(estado.aviso)}</div>` : ''}
      ${estado.sucesso ? `<div class="mm-sucesso" role="status">${escapar(estado.sucesso)}</div>` : ''}
      <div class="mm-bloco">
        <p>Mesa <strong>${escapar(estado.numero == null ? '—' : estado.numero)}</strong></p>
        <p>Pedido <strong>${escapar(pedido.codigo || ('#' + pedido.id))}</strong> · ${escapar(status || '—')}</p>
        <p>Observação ${escapar(pedido.observacao || '—')}</p>
        <ul>${itens || '<li>Nenhum item retornado pelo servidor.</li>'}</ul>
        ${pedido.total != null ? `<p>Total <strong>${dinheiro(pedido.total)}</strong></p>` : ''}
      </div>
      ${acoes}`;
  }

  // O backend responde 403 + SESSAO_INVALIDA para token inválido/expirado; o contexto de empresa expõe status/code.
  function sessaoInvalida(err) {
    if (!err) return false;
    const codigo = err.codigo || err.code;
    return err.status === 401 || codigo === 'SESSAO_INVALIDA';
  }

  const CHAVE_RETORNO = 'cdsMesaRetorno';
  const MSG_SEM_REDE_PDV = 'Sem conexão com o servidor. O pedido foi preservado e o PDV não foi aberto. Tente novamente.';

  // Consulta o pedido e o atendimento no servidor e decide, com a mesma regra do desktop, se ainda pode ser aberto.
  async function consultarPedidoDaMesa(rede, Conf, mesaId, pedidoId, geracao) {
    const consulta = await rede.requisitar('GET', `/mesas/${mesaId}/atendimento`);
    const dados = await rede.requisitar('GET', `/pedidos/${pedidoId}`);
    if (!dados || !dados.pedido) {
      const err = new Error('O pedido não foi encontrado.');
      err.codigo = 'PEDIDO_NAO_ENCONTRADO';
      throw err;
    }
    const lista = await rede.requisitar('GET', `/mesas/${mesaId}/atendimento/pedidos`);
    const item = (lista.pedidos || []).find((row) => Number(row.id) === Number(dados.pedido.id));
    const pedido = { ...dados.pedido, preparacao: item && item.preparacao };
    pedido.mesa_atendimento_id = item ? item.mesa_atendimento_id : null;
    const decisao = Conf.decidirConsultaPedido(consulta, pedido, geracao ? { geracao: geracao.seq, geracaoAtual: geracao.atual() } : {});
    return { consulta, pedido, decisao };
  }

  // Encaminha ao PDV oficial pelo contrato preparar-venda-pdv. Nunca cria venda nem pagamento e só libera a navegação com handoff válido.
  async function finalizarNoPdv(entrada) {
    const { rede, Conf, mesaId, pedidoId, global } = entrada;
    const MobilePedido = entrada.MobilePedido;
    let leitura;
    try {
      leitura = await consultarPedidoDaMesa(rede, Conf, mesaId, pedidoId);
    } catch (err) {
      return {
        ok: false,
        autenticacao: !!err.autenticacao,
        mensagem: err.rede ? MSG_SEM_REDE_PDV : (err.message || 'Não foi possível consultar o pedido.')
      };
    }
    const { decisao, pedido } = leitura;
    if (!decisao.abrir) {
      return { ok: false, atualizar: true, codigo: decisao.codigo, mensagem: decisao.mensagem || 'O pedido não pôde ser aberto.' };
    }
    const status = String(pedido.status || '').toUpperCase();
    if (status === 'FATURADO' || status === 'CANCELADO' || status === 'ORCAMENTO') {
      return { ok: false, atualizar: true, somenteConsulta: true, mensagem: `O pedido está ${status}. Somente consulta.` };
    }
    const estadoPrep = pedido.preparacao && pedido.preparacao.estado;
    if (estadoPrep !== 'EM_PREPARACAO' && estadoPrep !== 'CONCLUIDO') {
      return { ok: false, atualizar: true, mensagem: 'Envie o pedido para preparação antes de finalizar.' };
    }
    if (!MobilePedido || typeof MobilePedido.encaminharPedidoAoPdv !== 'function') {
      return { ok: false, mensagem: 'O módulo de encaminhamento ao PDV não foi carregado. Atualize a página.' };
    }
    let usuario = null;
    try { usuario = JSON.parse(global.localStorage.getItem('user') || 'null'); } catch (_e) { usuario = null; }
    const resultado = await MobilePedido.encaminharPedidoAoPdv(pedidoId, {
      fetch: global.fetch.bind(global),
      storage: global.sessionStorage,
      contexto: global.CdsEmpresaContexto,
      usuario
    });
    if (resultado.ok) {
      const handoff = resultado.handoff || {};
      if (Number(handoff.pedido_id) !== Number(pedidoId)) {
        return { ok: false, mensagem: 'A preparação veio de outro pedido. O PDV não foi aberto.' };
      }
      global.sessionStorage.setItem(CHAVE_RETORNO, JSON.stringify({
        mesa_id: Number(mesaId),
        pedido_id: Number(pedidoId),
        empresa: handoff.empresa_id
      }));
      return { ok: true, destino: resultado.destino || '/mobile-pdv', handoff };
    }
    if (resultado.codigo === 'VENDA_JA_VINCULADA' && Number(resultado.vendaId) > 0) {
      // Mesma recuperação do desktop: a venda já existe; só o vínculo do pedido está pendente.
      try {
        const vinculo = await rede.requisitar('POST', `/pedidos/${pedidoId}/finalizar-venda-pdv`, {});
        if (Number(vinculo && vinculo.venda_id) !== Number(resultado.vendaId)) {
          return { ok: false, atualizar: true, mensagem: 'O servidor não confirmou o vínculo da venda existente.' };
        }
        return {
          ok: false,
          atualizar: true,
          recuperado: true,
          vendaId: Number(resultado.vendaId),
          mensagem: `A venda ${resultado.vendaId} já estava registrada e foi vinculada ao pedido. Nenhuma venda nova foi criada.`
        };
      } catch (err) {
        return {
          ok: false,
          autenticacao: !!err.autenticacao,
          atualizar: !err.rede,
          mensagem: err.rede ? MSG_SEM_REDE_PDV : (err.message || 'Não foi possível concluir o vínculo da venda.')
        };
      }
    }
    if (resultado.codigo === 'VENDA_JA_CONCLUIDA') {
      return { ok: false, atualizar: true, somenteConsulta: true, mensagem: resultado.mensagem };
    }
    return {
      ok: false,
      autenticacao: !!resultado.autenticacao,
      codigo: resultado.codigo,
      mensagem: resultado.mensagem || 'O PDV não pôde ser preparado.'
    };
  }

  function criarRede(global, aoMudarRede) {
    const estadoRede = { offline: false };

    function marcar(offline) {
      if (estadoRede.offline === offline) return;
      estadoRede.offline = offline;
      if (aoMudarRede) aoMudarRede(offline);
    }

    function base() {
      if (typeof global.API_URL === 'string' && global.API_URL) return global.API_URL;
      return (global.location && global.location.origin ? global.location.origin : '') + '/api';
    }

    async function requisitar(method, path, corpo, chave) {
      const contexto = global.CdsEmpresaContexto;
      const headers = contexto && contexto.headersJson ? contexto.headersJson() : { 'Content-Type': 'application/json' };
      if (chave) headers['Idempotency-Key'] = chave;
      let resp;
      try {
        resp = await global.fetch(base() + path, {
          method,
          headers,
          body: corpo && method !== 'GET' ? JSON.stringify(corpo) : undefined
        });
      } catch (_erro) {
        marcar(true);
        const err = new Error(MSG_REDE);
        err.codigo = 'REDE';
        err.rede = true;
        throw err;
      }
      marcar(false);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const err = new Error((data && (data.mensagem || data.error)) || ('Falha na operação (HTTP ' + resp.status + ').'));
        err.codigo = data && (data.codigo || data.code);
        err.status = resp.status;
        err.autenticacao = sessaoInvalida(err);
        throw err;
      }
      return data;
    }

    return { estado: estadoRede, requisitar };
  }

  function novaChave(global) {
    const c = global.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'mesas-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function parametrosDaUrl(global) {
    try {
      const q = new global.URLSearchParams(global.location.search);
      const inteiro = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
      return { mesa: inteiro(q.get('mesa')), pedido: inteiro(q.get('pedido')) };
    } catch (_erro) {
      return { mesa: null, pedido: null };
    }
  }

  function falhaFatal(global) {
    return (erro) => {
      const el = global.document.getElementById('mm-alerta');
      if (el) { el.hidden = false; el.textContent = (erro && erro.message) || 'Não foi possível carregar as mesas.'; }
    };
  }

  async function iniciar(global) {
    const doc = global.document;
    const $ = (id) => doc.getElementById(id);
    let token = '';
    try { token = global.localStorage.getItem('token') || ''; } catch (_e) { token = ''; }
    if (!token) {
      global.location.replace('/login?next=' + CAMINHO.replace(/\/$/, ''));
      return null;
    }
    const contexto = global.CdsEmpresaContexto;
    const P = painel();
    const Conf = conferenciaApi();
    if (!contexto || !P || !Conf) throw new Error('Os módulos de mesas não foram carregados. Atualize a página.');

    const host = $('mm-conteudo');
    const alerta = (texto) => { const el = $('mm-alerta'); el.hidden = !texto; el.textContent = texto || ''; };
    let filtro = 'TODAS';
    let vista = null; // conferência de pedido aberta
    let ultimoHtml = '';
    let seqConferencia = 0;
    let timerCliente = null;
    let seqCliente = 0;
    let control = null;

    function irLogin() {
      try { global.localStorage.removeItem('token'); } catch (_e) { /* sem storage */ }
      global.location.replace('/login?next=' + CAMINHO.replace(/\/$/, ''));
    }
    function tratar(err) {
      if (!sessaoInvalida(err)) return false;
      alerta('Sua sessão expirou. Redirecionando para o login…');
      irLogin();
      return true;
    }

    const rede = criarRede(global, () => render());

    function pintarIdentidade() {
      const empresa = contexto.lerEmpresa ? contexto.lerEmpresa() : null;
      $('mm-empresa').textContent = empresa
        ? (empresa.nome_fantasia || empresa.razao_social || ('Empresa #' + empresa.id))
        : 'Empresa não selecionada';
      let usuario = null;
      try { usuario = JSON.parse(global.localStorage.getItem('user') || 'null'); } catch (_e) { usuario = null; }
      const nome = usuario && (usuario.nome || usuario.username);
      $('mm-operador').textContent = nome ? ('Operador: ' + nome) : '';
    }

    function sincronizarUrl() {
      if (!global.history || typeof global.history.replaceState !== 'function') return;
      let alvo = CAMINHO;
      if (vista && vista.mesaId) alvo += '?mesa=' + vista.mesaId + (vista.pedidoId ? '&pedido=' + vista.pedidoId : '');
      else if (control && control.estado.mesaSelecionadaId != null) alvo += '?mesa=' + control.estado.mesaSelecionadaId;
      if (global.location.pathname + global.location.search !== alvo) global.history.replaceState(null, '', alvo);
    }

    function render() {
      if (!control) return;
      const estado = control.estado;
      if (!rede.estado.offline && estado.aviso === MSG_REDE) estado.aviso = '';
      $('mm-rede').hidden = !rede.estado.offline;
      let html;
      if (vista) html = htmlConferencia(vista);
      else if (estado.mesaSelecionadaId != null) html = htmlDetalhe(estado, { rede: rede.estado.offline });
      else html = htmlLista(estado, { filtro, rede: rede.estado.offline });
      sincronizarUrl();
      const foco = doc.activeElement;
      const campo = foco && foco.id === 'mm-cliente' ? foco : null;
      if (html === ultimoHtml && !campo) return;
      const rolagem = global.scrollY || 0;
      const selecao = campo && Number.isInteger(campo.selectionStart)
        ? { ini: campo.selectionStart, fim: campo.selectionEnd } : null;
      if (campo && campo.value !== estado.clienteNome) control.definirCliente(campo.value);
      if (foco && foco.id === 'mm-destino') control.definirDestino(foco.value);
      host.innerHTML = html;
      ultimoHtml = html;
      if (campo) {
        const novo = $('mm-cliente');
        if (novo) {
          novo.focus();
          if (selecao && novo.setSelectionRange) novo.setSelectionRange(selecao.ini, selecao.fim);
        }
      }
      if (global.scrollTo) global.scrollTo(0, rolagem);
    }

    async function abrirConferencia(mesaId, pedidoId) {
      const seq = ++seqConferencia;
      vista = { carregando: true, mesaId, pedidoId };
      render();
      try {
        const { consulta, pedido, decisao } = await consultarPedidoDaMesa(rede, Conf, mesaId, pedidoId, { seq, atual: () => seqConferencia });
        if (seq !== seqConferencia) return;
        if (!decisao.abrir) {
          vista = { erro: decisao.mensagem || 'O pedido não pôde ser aberto.', mesaId, pedidoId };
          render();
          return;
        }
        const ctrl = Conf.criarConferencia({
          fetchJson: (method, path, chave) => rede.requisitar(method, path, undefined, chave),
          novaChave: () => novaChave(global),
          listarPedidos: (id) => rede.requisitar('GET', `/mesas/${id}/atendimento/pedidos`)
        });
        ctrl.finalizar(pedido, { numero: consulta.numero });
        vista = { ctrl, mesaId, pedidoId: Number(pedido.id) };
        render();
      } catch (err) {
        if (seq !== seqConferencia) return;
        tratar(err);
        vista = { erro: err.rede ? 'Não foi possível consultar o pedido sem conexão. Tente novamente.' : (err.message || 'Não foi possível consultar o pedido.'), mesaId, pedidoId };
        render();
      }
    }

    function fecharConferencia() {
      seqConferencia += 1;
      const mesaId = vista && vista.mesaId;
      if (vista && vista.ctrl) vista.ctrl.parar();
      vista = null;
      ultimoHtml = '';
      if (mesaId && control.estado.mesaSelecionadaId !== mesaId) control.selecionar(mesaId);
      else render();
    }

    function irParaPedidos(ctx) {
      if (ctx && ctx.pedidoId) { abrirConferencia(ctx.mesaId, ctx.pedidoId); return; }
      if (ctx && ctx.visualizarPedidos) return;
      global.location.assign('/mobile-pedido/?mesa=' + encodeURIComponent(ctx.mesaId));
    }

    function buscarClientes(termo) {
      const pesquisa = String(termo || '').trim();
      const seq = ++seqCliente;
      global.clearTimeout(timerCliente);
      if (pesquisa.length < 2) return;
      timerCliente = global.setTimeout(async () => {
        try {
          const clientes = await rede.requisitar('GET', `/clientes/buscar?termo=${encodeURIComponent(pesquisa)}`);
          const campo = $('mm-cliente');
          if (seq !== seqCliente || !campo || campo.value.trim() !== pesquisa) return;
          control.definirSugestoesClientes(clientes);
        } catch (err) {
          const campo = $('mm-cliente');
          if (seq !== seqCliente || !campo || campo.value.trim() !== pesquisa) return;
          tratar(err);
          control.definirErroBuscaCliente(`Falha ao buscar clientes: ${err.message}`);
        }
      }, 250);
    }

    // O desvio de erro de autenticação precisa acontecer antes de o controlador engolir a falha.
    const fetchJson = async (method, path, corpo, chave) => {
      try {
        return await rede.requisitar(method, path, corpo, chave);
      } catch (err) {
        tratar(err);
        throw err;
      }
    };

    try {
      await contexto.listarDisponiveis();
      await contexto.adotarEmpresaPadrao();
    } catch (err) {
      if (tratar(err)) return null;
      alerta((err && err.message) || 'Não foi possível identificar a empresa da sessão.');
      host.innerHTML = '<button type="button" class="mp-btn mp-btn-primario" data-acao="recarregar">Tentar novamente</button>';
      host.addEventListener('click', (evento) => {
        if (evento.target.closest('[data-acao="recarregar"]')) global.location.reload();
      });
      return null;
    }
    alerta('');
    pintarIdentidade();

    const empresa = contexto.lerEmpresa ? contexto.lerEmpresa() : null;
    control = P.criarControlador({
      empresaId: contexto.lerEmpresaId ? contexto.lerEmpresaId() : null,
      empresaRotulo: empresa ? (empresa.nome_fantasia || empresa.razao_social || '') : '',
      fetchJson,
      agendar: (fn, ms) => global.setTimeout(async () => { await fn(); render(); }, ms),
      cancelar: (id) => global.clearTimeout(id),
      aoMudar: render,
      aoIrParaPedidos: irParaPedidos
    });

    host.addEventListener('click', (evento) => {
      const alvo = evento.target.closest('[data-acao]');
      if (!alvo || !host.contains(alvo)) return;
      const acao = alvo.getAttribute('data-acao');
      if (acao === 'abrir-mesa') { ultimoHtml = ''; control.selecionar(alvo.getAttribute('data-mesa-id')); return; }
      if (acao === 'filtro') { filtro = alvo.getAttribute('data-filtro'); render(); return; }
      if (acao === 'fechar') { control.fecharModal(); return; }
      if (acao === 'abrir') { control.abrirAtendimento(); return; }
      if (acao === 'lancar') { control.lancarPedido(); return; }
      if (acao === 'transferir') { control.transferir(); return; }
      if (acao === 'selecionar-cliente') {
        global.clearTimeout(timerCliente);
        seqCliente += 1;
        control.selecionarCliente(alvo.getAttribute('data-cliente-id'), alvo.getAttribute('data-cliente-nome'));
        return;
      }
      if (acao === 'pedido') {
        const mesa = control.mesaAtual();
        if (mesa && mesa.situacao === 'OCUPADA') abrirConferencia(mesa.id, Number(alvo.getAttribute('data-pedido-id')));
        return;
      }
      if (acao === 'voltar-mesa') { fecharConferencia(); return; }
      if (acao === 'enviar' && vista && vista.ctrl) {
        const ctrl = vista.ctrl;
        const corrente = vista;
        const mesaId = corrente.mesaId;
        ctrl.enviar().then(() => {
          if (vista === corrente) render();
          if (control.estado.mesaSelecionadaId === mesaId) control.atualizar();
        });
        render();
        return;
      }
      if (acao === 'finalizar-pdv' && vista && vista.ctrl) {
        if (vista.pdv && vista.pdv.fase !== 'idle') return;
        vista.pdv = { fase: 'confirmando' };
        render();
        return;
      }
      if (acao === 'pdv-cancelar' && vista && vista.pdv && vista.pdv.fase === 'confirmando') {
        vista.pdv = { fase: 'idle' };
        render();
        return;
      }
      if (acao === 'pdv-confirmar' && vista && vista.pdv && vista.pdv.fase === 'confirmando') {
        const corrente = vista;
        corrente.pdv = { fase: 'enviando' };
        render();
        finalizarNoPdv({
          rede, Conf, mesaId: corrente.mesaId, pedidoId: corrente.pedidoId, global, MobilePedido: global.MobilePedido
        }).then(async (resultado) => {
          if (resultado.ok) {
            global.location.assign(resultado.destino);
            return;
          }
          if (resultado.autenticacao) { tratar({ status: 401 }); return; }
          if (vista !== corrente) return;
          corrente.pdv = { fase: 'idle', mensagem: resultado.mensagem };
          if (resultado.atualizar) {
            await abrirConferencia(corrente.mesaId, corrente.pedidoId);
            if (vista && vista.ctrl) vista.pdv = { fase: 'idle', mensagem: resultado.mensagem };
            control.atualizar().then(render);
          }
          render();
        });
        return;
      }
      if (acao === 'outro' && vista) { global.location.assign('/mobile-pedido/?mesa=' + encodeURIComponent(vista.mesaId)); }
    });
    host.addEventListener('input', (evento) => {
      if (evento.target.id !== 'mm-cliente') return;
      control.definirCliente(evento.target.value);
      buscarClientes(evento.target.value);
    });
    host.addEventListener('change', (evento) => {
      if (evento.target.id !== 'mm-destino') return;
      control.definirDestino(evento.target.value);
      ultimoHtml = '';
      render();
    });
    global.addEventListener('online', () => { control.atualizar().then(render); });
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) control.atualizar().then(render); });

    const url = parametrosDaUrl(global);
    try { global.sessionStorage.removeItem(CHAVE_RETORNO); } catch (_e) { /* sem storage */ }
    await control.iniciar();
    if (url.mesa && url.pedido) {
      await abrirConferencia(url.mesa, url.pedido);
      control.selecionar(url.mesa);
    } else if (url.mesa) {
      await control.selecionar(url.mesa);
    }
    render();
    return { control, render };
  }

  return {
    MSG_REDE,
    sessaoInvalida,
    htmlLista,
    htmlDetalhe,
    htmlConferencia,
    consultarPedidoDaMesa,
    finalizarNoPdv,
    CHAVE_RETORNO,
    criarRede,
    parametrosDaUrl,
    iniciar,
    falhaFatal,
    rotuloSituacao
  };
}));
