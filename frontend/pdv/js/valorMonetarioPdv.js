/**
 * Valor informado pelo operador, em reais.
 * Vírgula é decimal. Não interpreta a digitação como centavos.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ValorMonetarioPdv = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  function arredondar(valor) {
    return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
  }

  function ler(texto) {
    const limpo = String(texto || '').trim().replace(/[^\d,.-]/g, '');
    if (!limpo) return 0;
    if (limpo.includes(',')) {
      return arredondar(limpo.replace(/\./g, '').replace(',', '.'));
    }
    if (/^\d{1,3}(\.\d{3})+$/.test(limpo)) {
      return arredondar(limpo.replace(/\./g, ''));
    }
    return arredondar(limpo);
  }

  function formatar(valor) {
    return arredondar(valor).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function excedeRestante(valor, restante) {
    return arredondar(valor) - arredondar(restante) > 0.009;
  }

  function limitarAoRestante(valor, restante) {
    const informado = arredondar(valor);
    if (excedeRestante(informado, restante)) return arredondar(restante);
    return informado;
  }

  return { ler, formatar, excedeRestante, limitarAoRestante, arredondar };
}));