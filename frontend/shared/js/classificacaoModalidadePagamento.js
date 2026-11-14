/**
 * Classificação da modalidade de pagamento da venda.
 * Misto é duas ou mais modalidades distintas já recebidas.
 * Várias operações da mesma modalidade continuam sendo essa modalidade.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClassificacaoModalidadePagamento = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const NAO_RECEBIDO = new Set([
    'pendente', 'rejeitada', 'rejeitado', 'falha', 'negado', 'negada',
    'timeout', 'erro', 'recusada', 'recusado'
  ]);

  const ROTULOS = {
    cartao_debito: 'Débito',
    cartao_credito: 'Crédito',
    pix: 'PIX',
    dinheiro: 'Dinheiro',
    misto: 'Misto',
    pendente: 'Pendente',
    prazo: 'A prazo',
    boleto: 'Boleto',
    transferencia: 'Transferência',
    cheque: 'Cheque'
  };

  function canon(forma) {
    const nome = String(forma || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .replace(/\s+/g, '_');
    if (nome === 'debito' || nome === 'cartao_debito') return 'cartao_debito';
    if (nome === 'credito' || nome === 'cartao_credito') return 'cartao_credito';
    if (nome === 'pix' || nome === 'pix_tef') return 'pix';
    if (nome === 'dinheiro' || nome === 'especie' || nome === 'cash') return 'dinheiro';
    return nome;
  }

  function statusDe(pagamento) {
    return String(
      (pagamento && (pagamento.status || pagamento.status_autorizacao)) || ''
    ).toLowerCase();
  }

  function recebido(pagamento) {
    if (!pagamento) return false;
    const status = statusDe(pagamento);
    if (NAO_RECEBIDO.has(status)) return false;
    return Number(pagamento.valor) > 0;
  }

  function classificarFormaPagamento(pagamentos) {
    const lista = Array.isArray(pagamentos) ? pagamentos : [];
    const recebidos = lista.filter(recebido);
    if (recebidos.length === 0) {
      const pendente = lista.some((pagamento) => statusDe(pagamento) === 'pendente');
      return pendente ? 'pendente' : null;
    }
    const distintas = [...new Set(recebidos.map((pagamento) => (
      canon(pagamento.forma_pagamento || pagamento.forma)
    )))].filter((forma) => forma && forma !== 'misto');
    if (distintas.length === 0) return null;
    if (distintas.length > 1) return 'misto';
    return distintas[0];
  }

  function rotuloFormaClassificada(codigo) {
    const forma = canon(codigo);
    if (ROTULOS[forma]) return ROTULOS[forma];
    return codigo ? String(codigo) : '-';
  }

  function pagamentosDoResumo(texto) {
    return String(texto || '').split(';').map((parte) => {
      const [forma, valor] = String(parte || '').split('|');
      if (!String(forma || '').trim()) return null;
      return {
        forma_pagamento: forma,
        valor: Number(valor)
      };
    }).filter(Boolean);
  }

  function formaExibidaDaVenda(venda) {
    const linhas = Array.isArray(venda && venda.venda_pagamentos) && venda.venda_pagamentos.length
      ? venda.venda_pagamentos
      : (Array.isArray(venda && venda.pagamentos) && venda.pagamentos.length
        ? venda.pagamentos
        : pagamentosDoResumo(venda && venda.pagamentos_resumo));
    const classificada = classificarFormaPagamento(linhas);
    if (classificada) return rotuloFormaClassificada(classificada);
    return rotuloFormaClassificada(venda && venda.forma_pagamento);
  }

  return {
    canon,
    classificarFormaPagamento,
    rotuloFormaClassificada,
    pagamentosDoResumo,
    formaExibidaDaVenda
  };
}));
