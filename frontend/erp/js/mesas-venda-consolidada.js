/**
 * MESAS-05.3 — seleção da venda consolidada na listagem de pedidos.
 * O navegador só escolhe os pedidos. Preço, total e bloqueio ficam no servidor.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CdsVendaConsolidada = api;
}(typeof window !== 'undefined' ? window : globalThis, function factory() {
  'use strict';

  function elegivel(pedido) {
    const status = String(pedido && pedido.status || '').toUpperCase();
    const venda = Number(pedido && (pedido.venda_id || pedido.venda_pdv_id) || 0);
    return ['PEDIDO', 'ABERTO', 'EM_SEPARACAO'].includes(status)
      && !(venda > 0)
      && pedido.mesa_id != null
      && pedido.mesa_atendimento_id != null;
  }

  function grupos(pedidos) {
    const mapa = new Map();
    (Array.isArray(pedidos) ? pedidos : []).forEach((pedido) => {
      if (!elegivel(pedido)) return;
      const chave = [pedido.empresa_id || '', pedido.mesa_id, pedido.mesa_atendimento_id].join(':');
      if (!mapa.has(chave)) mapa.set(chave, []);
      mapa.get(chave).push(pedido);
    });
    return [...mapa.values()].filter((grupo) => grupo.length >= 2).map((grupo) => ({
      mesa_id: Number(grupo[0].mesa_id),
      mesa_numero: grupo[0].mesa_numero,
      atendimento_id: Number(grupo[0].mesa_atendimento_id),
      pedidos: grupo.slice(),
      total: Math.round(grupo.reduce((soma, pedido) => soma + Number(pedido.total || 0), 0) * 100) / 100
    }));
  }

  function confirmarSelecao(pedidos, removidos) {
    const fora = new Set((removidos || []).map((id) => Number(id)));
    const escolhidos = (pedidos || []).filter((pedido) => !fora.has(Number(pedido.id)));
    return {
      ok: escolhidos.length >= 2,
      pedidoIds: escolhidos.map((pedido) => Number(pedido.id)),
      criarVenda: false
    };
  }

  function chaveIdempotencia(opcoes) {
    const empresaId = Number(opcoes && opcoes.empresaId);
    const mesaId = Number(opcoes && opcoes.mesaId);
    const atendimentoId = Number(opcoes && opcoes.atendimentoId) || 0;
    const pedidoIds = [...new Set((opcoes && opcoes.pedidoIds || []).map(Number))]
      .sort((a, b) => a - b);
    const storage = opcoes && opcoes.storage;
    if (
      !Number.isInteger(empresaId) || empresaId <= 0
      || !Number.isInteger(mesaId) || mesaId <= 0
      || pedidoIds.length < 2
      || pedidoIds.some((id) => !Number.isInteger(id) || id <= 0)
      || !storage
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function'
    ) {
      throw new Error('Não foi possível identificar com segurança a seleção da consolidação.');
    }

    const storageKey = [
      'cds:pedido:venda-consolidada',
      empresaId,
      mesaId,
      atendimentoId,
      pedidoIds.join(',')
    ].join(':');
    let chave = storage.getItem(storageKey);
    if (!chave) {
      const gerar = opcoes.criarChave;
      chave = typeof gerar === 'function' ? gerar() : null;
      if (!chave) throw new Error('Não foi possível gerar a chave de idempotência da consolidação.');
      storage.setItem(storageKey, String(chave));
    }
    return String(chave);
  }

  return { elegivel, grupos, confirmarSelecao, chaveIdempotencia };
}));
