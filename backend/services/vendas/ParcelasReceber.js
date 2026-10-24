'use strict';

function paraCentavos(valor, campo) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) {
    throw new TypeError(`Valor inválido para ${campo}.`);
  }
  return Math.round((numero + Number.EPSILON) * 100);
}

function dividirCentavos(total, quantidade) {
  const base = Math.floor(total / quantidade);
  const sobra = total - base * quantidade;
  return Array.from(
    { length: quantidade },
    (_, indice) => base + (indice < sobra ? 1 : 0)
  );
}

function distribuirComponenteCentavos(totalComponente, parcelasTotais) {
  const totalParcelas = parcelasTotais.reduce((soma, valor) => soma + valor, 0);
  if (totalParcelas === 0) {
    return parcelasTotais.map(() => 0);
  }

  const alocacoes = parcelasTotais.map((valor, indice) => {
    const exato = totalComponente * valor / totalParcelas;
    const base = Math.floor(exato);
    return { indice, valor: base, fracao: exato - base };
  });
  const alocado = alocacoes.reduce((soma, item) => soma + item.valor, 0);
  const centavosRestantes = totalComponente - alocado;

  alocacoes
    .slice()
    .sort((a, b) => b.fracao - a.fracao || a.indice - b.indice)
    .slice(0, centavosRestantes)
    .forEach((item) => {
      alocacoes[item.indice].valor += 1;
    });

  return alocacoes.map((item) => item.valor);
}

function montarParcelasReceber(total, valorOutros = 0, quantidade = 1) {
  const numeroParcelas = Number(quantidade);
  if (!Number.isInteger(numeroParcelas) || numeroParcelas < 1) {
    throw new TypeError('Quantidade de parcelas inválida.');
  }

  const totalCentavos = paraCentavos(total, 'total da venda');
  const outrosCentavos = paraCentavos(valorOutros, 'valor de Outros');
  if (outrosCentavos > totalCentavos) {
    throw new RangeError('Valor de Outros não pode exceder o total da venda.');
  }

  const totaisParcelas = dividirCentavos(totalCentavos, numeroParcelas);
  const parcelasOutros = distribuirComponenteCentavos(outrosCentavos, totaisParcelas);

  return totaisParcelas.map((valorTotal, indice) => {
    const valorOutrosParcela = parcelasOutros[indice];
    const valorProdutosParcela = valorTotal - valorOutrosParcela;
    const componentes = [];

    if (valorProdutosParcela > 0 || (valorTotal === 0 && valorOutrosParcela === 0)) {
      componentes.push({
        componente: 'produtos',
        valor_centavos: valorProdutosParcela
      });
    }
    if (valorOutrosParcela > 0) {
      componentes.push({
        componente: 'outros',
        valor_centavos: valorOutrosParcela
      });
    }

    return {
      numero_parcela: indice + 1,
      total_parcelas: numeroParcelas,
      componentes: componentes.map((componente) => ({
        componente: componente.componente,
        valor_parcela: componente.valor_centavos / 100
      }))
    };
  });
}

module.exports = { montarParcelasReceber };
