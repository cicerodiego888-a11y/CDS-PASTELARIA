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

  function centavos(valor) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return null;
    return Math.round((numero + Number.EPSILON) * 100);
  }

  function separarDinheiro(entregue, restante) {
    const entregueC = centavos(entregue);
    const restanteC = centavos(restante);
    if (entregueC == null || entregueC <= 0) {
      return { ok: false, codigo: 'VALOR_INVALIDO' };
    }
    if (restanteC == null || restanteC < 0) {
      return { ok: false, codigo: 'VALOR_INVALIDO' };
    }
    if (restanteC === 0) {
      return { ok: false, codigo: 'VALOR_ACIMA_DO_RESTANTE' };
    }
    const aplicadoC = Math.min(entregueC, restanteC);
    return {
      ok: true,
      entregue: entregueC / 100,
      restante: restanteC / 100,
      aplicado: aplicadoC / 100,
      troco: (entregueC - aplicadoC) / 100
    };
  }

  function decidirConfirmacaoDinheiro(estado, entregue) {
    if (estado && estado.emRegistro) {
      return { acao: 'ignorada', codigo: 'CONFIRMACAO_DUPLICADA' };
    }
    const conta = separarDinheiro(entregue, estado ? estado.restante : null);
    if (!conta.ok) return { acao: 'recusada', codigo: conta.codigo };
    if (!estado || estado.confirmacaoAberta !== true) {
      return { acao: 'aguardar_confirmacao', conta };
    }
    return { acao: 'registrar', conta };
  }

  return {
    ler,
    formatar,
    excedeRestante,
    limitarAoRestante,
    arredondar,
    separarDinheiro,
    decidirConfirmacaoDinheiro
  };
}));