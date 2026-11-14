/**
 * Contexto de navegação entre Controle de Mesas e Pedidos.
 * O sessionStorage só indica qual mesa consultar. Quem autoriza é o servidor.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CdsMesasLancamento = api;
}(typeof window !== 'undefined' ? window : globalThis, function factory() {
  'use strict';

  const CHAVE = 'cds.mesas.lancamento';

  function escapar(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function numeroMesa(numero) {
    const n = Number(numero);
    if (!Number.isInteger(n) || n < 0) return String(numero == null ? '' : numero);
    return String(n).padStart(2, '0');
  }

  function tituloMesa(numero) {
    return `PEDIDO DA MESA ${numeroMesa(numero)}`;
  }

  function inteiro(valor) {
    const n = Number(valor);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function gravarLancamento(storage, contexto) {
    const ctx = contexto || {};
    const mesaId = inteiro(ctx.mesaId != null ? ctx.mesaId : ctx.mesa_id);
    if (!mesaId) throw new Error('Mesa do lançamento inválida.');
    const atendimentoId = inteiro(ctx.atendimentoId != null ? ctx.atendimentoId : ctx.atendimento_id);
    const empresaId = inteiro(ctx.empresaId != null ? ctx.empresaId : ctx.empresa_id);
    const pedidoId = inteiro(ctx.pedidoId != null ? ctx.pedidoId : ctx.pedido_id);
    const visualizarPedidos = ctx.visualizarPedidos === true || ctx.visualizar_pedidos === true;
    const payload = {
      origem: 'controle-mesas',
      mesa_id: mesaId,
      numero: ctx.numero == null ? null : String(ctx.numero),
      atendimento_id: atendimentoId,
      empresa_id: empresaId,
      pedido_id: pedidoId,
      abrir_modal: !visualizarPedidos && pedidoId == null,
      visualizar_pedidos: visualizarPedidos
    };
    storage.setItem(CHAVE, JSON.stringify(payload));
    return payload;
  }

  function lerLancamento(storage, empresaIdAtual) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    const bruto = storage.getItem(CHAVE);
    if (!bruto) return null;
    let dados;
    try {
      dados = JSON.parse(bruto);
    } catch (_err) {
      return null;
    }
    if (!dados || dados.origem !== 'controle-mesas') return null;
    const mesaId = inteiro(dados.mesa_id);
    if (!mesaId) return null;
    const empresaId = inteiro(dados.empresa_id);
    const atual = inteiro(empresaIdAtual);
    if (atual && empresaId && atual !== empresaId) return null;
    return {
      origem: 'controle-mesas',
      mesa_id: mesaId,
      numero: dados.numero == null ? null : String(dados.numero),
      atendimento_id: inteiro(dados.atendimento_id),
      empresa_id: empresaId,
      pedido_id: inteiro(dados.pedido_id),
      abrir_modal: dados.abrir_modal === true,
      visualizar_pedidos: dados.visualizar_pedidos === true
    };
  }

  function filtrarPedidosAbertosDaMesa(pedidos, contexto) {
    const ctx = contexto || {};
    const mesaId = inteiro(ctx.mesa_id);
    const atendimentoId = inteiro(ctx.atendimento_id);
    const empresaId = inteiro(ctx.empresa_id);
    if (!mesaId || !atendimentoId || !empresaId) return [];
    const statusAbertos = new Set(['PEDIDO', 'ABERTO', 'EM_SEPARACAO']);
    return (Array.isArray(pedidos) ? pedidos : []).filter((pedido) => {
      if (!pedido) return false;
      const status = String(pedido && pedido.status || '').toUpperCase();
      const vendaId = Number(pedido && (pedido.venda_id || pedido.venda_pdv_id) || 0);
      const finalizada = pedido && (
        pedido.finalizacao_confirmada === true
        || Number(pedido.finalizacao_confirmada) === 1
        || pedido.somente_consulta === true
        || Number(pedido.somente_consulta) === 1
        || String(pedido.venda_pdv_status || '').toUpperCase() === 'FINALIZADA'
      );
      return statusAbertos.has(status)
        && Number(pedido.mesa_id) === mesaId
        && Number(pedido.mesa_atendimento_id) === atendimentoId
        && Number(pedido.empresa_id) === empresaId
        && !(vendaId > 0)
        && !finalizada;
    });
  }

  function consumirConsultaPedido(storage) {
    if (!storage || typeof storage.getItem !== 'function') return;
    const bruto = storage.getItem(CHAVE);
    if (!bruto) return;
    let dados;
    try {
      dados = JSON.parse(bruto);
    } catch (_err) {
      return;
    }
    if (!dados || dados.origem !== 'controle-mesas') return;
    dados.pedido_id = null;
    dados.abrir_modal = false;
    storage.setItem(CHAVE, JSON.stringify(dados));
  }

  function temIntencaoModal(storage, empresaIdAtual) {
    const ctx = lerLancamento(storage, empresaIdAtual);
    return !!(ctx && ctx.abrir_modal);
  }

  function consumirIntencaoModal(storage) {
    if (!storage || typeof storage.getItem !== 'function') return;
    const bruto = storage.getItem(CHAVE);
    if (!bruto) return;
    let dados;
    try {
      dados = JSON.parse(bruto);
    } catch (_err) {
      return;
    }
    if (!dados || dados.origem !== 'controle-mesas') return;
    dados.abrir_modal = false;
    storage.setItem(CHAVE, JSON.stringify(dados));
  }

  function consumirVisualizacaoPedidos(storage) {
    if (!storage || typeof storage.getItem !== 'function') return;
    const bruto = storage.getItem(CHAVE);
    if (!bruto) return;
    let dados;
    try {
      dados = JSON.parse(bruto);
    } catch (_err) {
      return;
    }
    if (!dados || dados.origem !== 'controle-mesas') return;
    dados.visualizar_pedidos = false;
    storage.setItem(CHAVE, JSON.stringify(dados));
  }

  function decidirAberturaModal(consulta, opcoes) {
    const opts = opcoes || {};
    if (opts.rede) {
      return {
        abrirModal: false,
        sucesso: false,
        bloqueado: true,
        mensagem: 'Não foi possível confirmar o atendimento da mesa.'
      };
    }
    const decisao = decidirLancamento(consulta);
    if (!decisao.abrirEditor || decisao.bloqueado) {
      return { ...decisao, abrirModal: false, sucesso: false };
    }
    if (opts.modalAberto) {
      return { ...decisao, abrirModal: false, duplicada: true, sucesso: false };
    }
    if (opts.intencao === false) {
      return { ...decisao, abrirModal: false, sucesso: false };
    }
    return { ...decisao, abrirModal: true, sucesso: false };
  }

  function efeitoDaAcaoModal(acao) {
    if (acao === 'salvar') return { criarPedido: true, criarAtendimento: false };
    return { criarPedido: false, criarAtendimento: false };
  }

  function decidirLancamento(consulta) {
    const dados = consulta || {};
    const atendimento = dados.atendimento || null;
    const situacao = dados.situacao || 'LIVRE';
    const base = {
      mesa_id: inteiro(dados.mesa_id),
      numero: dados.numero,
      situacao,
      atendimento_id: atendimento ? inteiro(atendimento.id) : null,
      cliente_id: atendimento && atendimento.cliente_id != null ? atendimento.cliente_id : null,
      cliente_nome: atendimento && atendimento.cliente_nome ? String(atendimento.cliente_nome) : null,
      titulo: tituloMesa(dados.numero),
      abrirEditor: false,
      bloqueado: true,
      mensagem: ''
    };
    if (situacao === 'OCUPADA' && base.atendimento_id) {
      return { ...base, abrirEditor: true, bloqueado: false, mensagem: '' };
    }
    if (situacao === 'FECHAMENTO') {
      return {
        ...base,
        mensagem: 'O atendimento está em fechamento e não recebe pedido novo.'
      };
    }
    return {
      ...base,
      mensagem: 'Abra o atendimento da mesa antes de lançar o pedido.'
    };
  }

  function htmlFaixa(decisao) {
    if (!decisao || decisao.numero == null) return '';
    const cliente = decisao.cliente_nome
      ? `Cliente: ${decisao.cliente_nome}`
      : (decisao.cliente_id != null ? `Cliente nº ${decisao.cliente_id}` : 'Cliente não identificado');
    const aviso = decisao.mensagem ? `<div>${escapar(decisao.mensagem)}</div>` : '';
    const classe = decisao.bloqueado ? 'alert-warning' : 'alert-primary';
    return `
      <div class="alert ${classe}" id="pedMesaLancamento" role="status">
        <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
          <div>
            <strong>${escapar(decisao.titulo || tituloMesa(decisao.numero))}</strong>
            <div>Mesa ${escapar(numeroMesa(decisao.numero))}</div>
            <div>Estado ${escapar(decisao.situacao || '')}</div>
            ${decisao.situacao === 'LIVRE' ? '' : `<div>${escapar(cliente)}</div>`}
            ${aviso}
          </div>
          <button type="button" class="btn btn-outline-secondary btn-sm" id="btnPedVoltarMesas">Voltar ao Controle de Mesas</button>
        </div>
      </div>`;
  }

  return {
    CHAVE,
    gravarLancamento,
    lerLancamento,
    filtrarPedidosAbertosDaMesa,
    consumirConsultaPedido,
    temIntencaoModal,
    consumirIntencaoModal,
    consumirVisualizacaoPedidos,
    decidirLancamento,
    decidirAberturaModal,
    efeitoDaAcaoModal,
    htmlFaixa,
    tituloMesa,
    numeroMesa
  };
}));
