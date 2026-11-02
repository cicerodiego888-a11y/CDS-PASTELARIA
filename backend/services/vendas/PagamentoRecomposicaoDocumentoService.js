'use strict';

/**
 * Liga a referência financeira confirmada ao motor pastel → residual → refrigerantes
 * e ao distribuidor oficial F×NF. O XML da NFC-e sai só das linhas fiscais autorizadas.
 *
 * Não cria outro motor, não altera a regra da Sprint 26 e não liga a flag de produção.
 */

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  formaEhDinheiro,
  round2
} = require('./RecomposicaoFiscalContratoService');
const {
  avaliarReferenciaRecomposicao,
  calcularReferenciasConfirmadas,
  parcelaEfetivamenteConfirmada
} = require('./PagamentoSequencialComposicaoService');
const {
  calcularMargemToleranciaDinheiro
} = require('./RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const {
  avaliarCandidatoComBuscarComposicao
} = require('./RecomposicaoFiscalComposicaoMotorSimulacaoService');
const {
  encaminharPropostaValidadaAoDistribuidorOficial
} = require('./RecomposicaoFiscalFechamentoAdaptadorService');
const {
  distribuirItensVendaComValorFiscalEfetivo
} = require('../distribuidorEstoqueVenda');
const { buildNfceXml } = require('../fiscal/xmlBuilder');

const CATEGORIA_PASTEL = 'PASTEIS';

function resposta(campos) {
  return Object.freeze({
    recomposicao_habilitada_em_producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true,
    ...campos
  });
}

function bloqueio(codigo, motivo, extra = {}) {
  return resposta({
    bloqueado: true,
    codigo,
    motivo,
    xml: null,
    itens_fiscais: Object.freeze([]),
    ...extra
  });
}

function categoriaDoItem(item) {
  return String(item && (item.categoria_nome || item.categoria || '')).trim().toUpperCase();
}

function consultarCategorias(db, ids) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT p.id, p.preco_venda, c.nome AS categoria_nome
       FROM produtos p
       LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE p.id IN (${ids.map(() => '?').join(',')})`,
      ids,
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });
}

async function completarCategorias(db, itens) {
  if (!db || !Array.isArray(itens) || itens.length === 0) return itens;
  const ids = [...new Set(itens.map((item) => Number(item.produto_id || item.id)).filter((id) => id > 0))];
  if (!ids.length) return itens;
  const completo = itens.every((item) => categoriaDoItem(item) && Number(item.preco_venda) > 0);
  if (completo) return itens;
  try {
    const rows = await consultarCategorias(db, ids);
    const mapa = new Map(rows.map((row) => [Number(row.id), row]));
    return itens.map((item) => {
      const cadastro = mapa.get(Number(item.produto_id || item.id)) || {};
      return {
        ...item,
        categoria_nome: categoriaDoItem(item)
          ? (item.categoria_nome || item.categoria)
          : (cadastro.categoria_nome || null),
        preco_venda: Number(item.preco_venda) > 0 ? item.preco_venda : cadastro.preco_venda
      };
    });
  } catch (_erro) {
    return itens;
  }
}

function subtotalDoItem(item) {
  if (item && item.subtotal != null && item.subtotal !== '') return round2(Number(item.subtotal));
  return round2(Number(item && item.quantidade || 0) * Number(item && item.preco_unitario || 0));
}

function soma(itens, campo) {
  return round2((itens || []).reduce((total, item) => total + Number(item[campo] || 0), 0));
}

function pagamentosConfirmadosNaReferencia(pagamentos, referencia) {
  const fiscal = Number(referencia && referencia.valor_fiscal_referencia || 0);
  const naoFiscal = Number(referencia && referencia.valor_nao_fiscal_referencia || 0);
  const confirmados = (pagamentos || []).filter((pagamento) => parcelaEfetivamenteConfirmada(pagamento));
  return {
    confirmados,
    soma: round2(confirmados.reduce((total, pagamento) => total + Number(pagamento.valor || 0), 0)),
    referenciaSoma: round2(fiscal + naoFiscal)
  };
}

function propostaDoComposto(composto) {
  const quantidade = Number(composto.quantidade);
  const subtotal = composto.subtotal != null
    ? round2(Number(composto.subtotal))
    : round2(Number(composto.subtotalCentavos || 0) / 100);
  return {
    produto_id: Number(composto.produto_id != null ? composto.produto_id : composto.produtoId),
    quantidade,
    subtotal,
    categoria_fiscal: composto.categoriaFiscal || composto.categoria_fiscal || null,
    volume_total_ml: composto.volumeTotalMl != null ? composto.volumeTotalMl : composto.volume_total_ml
  };
}

function montarXml(itensFiscais, pagamentos, configFiscal, totalFiscal) {
  const somaItens = soma(itensFiscais, 'valor_fiscal');
  if (Math.abs(somaItens - totalFiscal) > 0.02) {
    return bloqueio(
      'XML_ITENS_DIVERGENTES',
      'A soma dos itens fiscais diverge do total autorizado. O vNF não foi reduzido para mascarar o carrinho.',
      { itens_fiscais: Object.freeze(itensFiscais.map((item) => ({ ...item }))) }
    );
  }
  const pagamentosDocumento = (pagamentos || []).map((pagamento) => ({
    forma_pagamento: pagamento.forma_pagamento,
    valor: Number(pagamento.valor),
    tipo_recebimento: formaEhDinheiro(pagamento.forma_pagamento) ? 'nao_fiscal' : 'fiscal'
  }));
  const xml = buildNfceXml({
    config: configFiscal,
    venda: {
      total: totalFiscal,
      desconto: 0,
      acrescimo: 0,
      valor_fiscal: totalFiscal,
      pagamentos: pagamentosDocumento
    },
    itens: itensFiscais,
    numero: 1
  });
  if (Math.abs(Number(xml.valores.vNF) - somaItens) > 0.02) {
    return bloqueio(
      'XML_ITENS_DIVERGENTES',
      'O vNF do documento não reproduz a soma dos itens fiscais autorizados.',
      { itens_fiscais: Object.freeze(itensFiscais.map((item) => ({ ...item }))) }
    );
  }
  return xml;
}

function linhasFiscais(resultadoOficial) {
  const linhas = resultadoOficial && Array.isArray(resultadoOficial.itens) ? resultadoOficial.itens : [];
  return linhas.filter((linha) => Number(linha.valor_fiscal || 0) > 0.009 && Number(linha.quantidade_fiscal || 0) > 0);
}

async function distribuirProposta(entrada, proposta, modelos, capacidade) {
  return encaminharPropostaValidadaAoDistribuidorOficial({
    env: entrada.env || process.env,
    harnessDistribuicaoOficial: entrada.harnessDistribuicaoOficial || null,
    validacao: {
      composicao_validada_em_homologacao: true,
      itens_composicao: proposta
    },
    itensVendidos: entrada.itens,
    pagamentos: entrada.pagamentosConfirmados,
    totalComercial: entrada.total,
    desconto: 0,
    acrescimo: 0,
    empresaId: entrada.empresaId,
    db: entrada.db || null,
    saldosPorProduto: entrada.saldosPorProduto,
    modelos,
    capacidade_por_categoria: capacidade,
    aplicarSaldo: false
  });
}

async function integrarPagamentoRecomposicao(entrada = {}, opcoes = {}) {
  const env = opcoes.env || process.env;
  const total = round2(Number(entrada.total != null ? entrada.total : entrada.total_comercial));
  const pagamentos = Array.isArray(entrada.pagamentos) ? entrada.pagamentos : [];
  const itens = await completarCategorias(
    opcoes.db || entrada.db || null,
    Array.isArray(entrada.itens) ? entrada.itens : []
  );
  const referencia = avaliarReferenciaRecomposicao({
    total,
    pagamentos,
    itens
  }, { env });

  if (referencia.recomposicao_executada !== true) {
    return bloqueio(
      referencia.motivo_recomposicao || 'ambiente_teste_desligado',
      'A recomposição não está ativa neste ambiente. A flag de produção permanece desligada.',
      { bloqueado: false, aplicavel: false, referencia }
    );
  }

  const fiscal = Number(referencia.valor_fiscal_referencia || 0);
  const naoFiscal = Number(referencia.valor_nao_fiscal_referencia || 0);
  const conferencia = pagamentosConfirmadosNaReferencia(pagamentos, referencia);
  if (Math.abs(conferencia.soma - conferencia.referenciaSoma) > 0.02) {
    return bloqueio(
      'REFERENCIA_DIVERGENTE',
      'A soma das parcelas confirmadas não fecha a referência fiscal e não fiscal.',
      { referencia }
    );
  }
  if (Math.abs(conferencia.soma - total) > 0.02) {
    return bloqueio(
      'PAGAMENTO_INCOMPLETO',
      'Parcelas pendentes, rejeitadas ou com falha não entram na referência e o pagamento não fecha a venda.',
      { referencia }
    );
  }

  if (!(fiscal > 0)) {
    return bloqueio(
      'REFERENCIA_FISCAL_ZERO',
      'Não há parcela eletrônica confirmada. Nenhum item comercial entra na NFC-e.',
      {
        referencia,
        itens_nao_fiscais: Object.freeze(itens.map((item) => ({ ...item })))
      }
    );
  }

  const pastéis = itens.filter((item) => categoriaDoItem(item) === CATEGORIA_PASTEL);
  const contexto = {
    env,
    itens,
    total,
    empresaId: entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id,
    db: opcoes.db || entrada.db || null,
    saldosPorProduto: opcoes.saldosPorProduto || entrada.saldosPorProduto || null,
    harnessDistribuicaoOficial: opcoes.harnessDistribuicaoOficial || null,
    pagamentosConfirmados: conferencia.confirmados
  };

  if (!pastéis.length) {
    if (Math.abs(fiscal - total) > 0.02 || naoFiscal > 0.009) {
      return bloqueio(
        'SEM_PASTEL_ELEGIVEL',
        'Não há pastel elegível. A composição residual não foi inventada e o documento fiscal não foi reduzido.',
        { referencia }
      );
    }
    const entradas = itens.map((item) => {
      const saldo = contexto.saldosPorProduto
        ? (contexto.saldosPorProduto[item.produto_id] || contexto.saldosPorProduto[String(item.produto_id)] || {})
        : {};
      return {
        item,
        saldoFiscal: Number(saldo.saldoFiscal != null ? saldo.saldoFiscal : item.quantidade),
        saldoNaoFiscal: Number(saldo.saldoNaoFiscal || 0)
      };
    });
    const oficial = distribuirItensVendaComValorFiscalEfetivo(entradas, true, {
      pagamentos: conferencia.confirmados,
      desconto: 0,
      acrescimo: 0,
      midpAtivo: false
    });
    if (!oficial || oficial.sucesso !== true) {
      return bloqueio('SALDO_INSUFICIENTE', 'O distribuidor oficial não autorizou o carrinho fiscal.', { referencia });
    }
    const fiscais = linhasFiscais(oficial);
    if (Math.abs(soma(fiscais, 'valor_fiscal') - fiscal) > 0.02) {
      return bloqueio(
        'TOTAL_FISCAL_DIVERGENTE_DA_REFERENCIA',
        'O distribuidor oficial não devolveu o valor fiscal da referência.',
        { referencia, itens_fiscais: Object.freeze(fiscais) }
      );
    }
    if (!entrada.configFiscal) {
      return resposta({
        bloqueado: false,
        codigo: 'ITENS_FISCAIS_AUTORIZADOS',
        referencia,
        itens_fiscais: Object.freeze(fiscais),
        xml: null
      });
    }
    const xml = montarXml(fiscais, conferencia.confirmados, entrada.configFiscal, fiscal);
    if (xml && xml.bloqueado) return resposta({ ...xml, referencia });
    return resposta({
      bloqueado: false,
      codigo: 'DOCUMENTO_FISCAL_AUTORIZADO',
      referencia,
      itens_fiscais: Object.freeze(fiscais),
      xml: xml.xmlSemAssinatura,
      valores: xml.valores
    });
  }

  for (const pastel of pastéis) {
    if (!Number.isSafeInteger(Number(pastel.quantidade)) || Number(pastel.quantidade) <= 0) {
      return bloqueio(
        'QUANTIDADE_PASTEL_INVALIDA',
        'O pastel elegível precisa ter quantidade inteira. Nenhuma composição foi gerada.',
        { referencia }
      );
    }
  }

  const valorPastel = soma(pastéis.map((item) => ({ valor: subtotalDoItem(item) })), 'valor');
  const residual = round2(fiscal - valorPastel);
  if (residual < -0.009) {
    return bloqueio(
      'RESIDUAL_PASTEL_NEGATIVO',
      'O valor dos pastéis excede a referência fiscal. Nenhuma composição foi gerada.',
      { referencia }
    );
  }

  let modelos = Array.isArray(opcoes.modelos) ? opcoes.modelos : (Array.isArray(entrada.modelos) ? entrada.modelos : []);
  let capacidade = opcoes.capacidade_por_categoria || entrada.capacidade_por_categoria || {};
  if (residual > 0.009 && modelos.length === 0 && contexto.db && contexto.empresaId) {
    try {
      const pdv = require('./PedidoPdvComposicaoService');
      const contextoModelos = await pdv.obterContextoComposicaoPdvParaDiagnostico({
        empresaId: contexto.empresaId,
        residualCentavos: Math.round(residual * 100),
        db: contexto.db
      });
      if (contextoModelos && Array.isArray(contextoModelos.modelos) && contextoModelos.modelos.length) {
        modelos = contextoModelos.modelos;
        if (!Object.keys(capacidade).length) {
          capacidade = contextoModelos.capacidade_por_categoria || {};
        }
      }
    } catch (_carga) {
      modelos = [];
    }
  }
  let proposta = pastéis.map((item) => ({
    produto_id: Number(item.produto_id != null ? item.produto_id : item.id),
    quantidade: Number(item.quantidade),
    subtotal: subtotalDoItem(item)
  }));

  let motor = null;
  if (residual > 0.009) {
    const margem = calcularMargemToleranciaDinheiro(conferencia.confirmados);
    motor = avaliarCandidatoComBuscarComposicao({
      valorFiscalCandidato: residual,
      margemMaxima: margem && margem.margem_maxima,
      modelos,
      capacidadePorCategoria: capacidade
    });
    if (!motor || motor.distribuicao_possivel !== true) {
      return bloqueio(
        motor && motor.codigo ? motor.codigo : 'COMPOSICAO_AUSENTE_NO_MOTOR',
        motor && motor.motivo
          ? motor.motivo
          : 'O motor não encontrou composição válida para o residual. Nenhum produto foi inventado.',
        { referencia, motor }
      );
    }
    proposta = proposta.concat((motor.itens_compostos || []).map(propostaDoComposto));
  }

  const aplicacao = await distribuirProposta(contexto, proposta, modelos, capacidade);
  if (!aplicacao || aplicacao.distribuicao_aplicada !== true) {
    return bloqueio(
      aplicacao && aplicacao.codigo ? aplicacao.codigo : 'AUTORIZACAO_AUSENTE',
      aplicacao && aplicacao.motivo
        ? aplicacao.motivo
        : 'A distribuição oficial não foi autorizada. O XML não foi montado com o carrinho comercial.',
      { referencia, motor }
    );
  }

  const fiscais = linhasFiscais(aplicacao.resultado_oficial);
  const somaFiscal = soma(fiscais, 'valor_fiscal');
  if (Math.abs(somaFiscal - Number(aplicacao.resultado_oficial.valorFiscalEfetivo || 0)) > 0.02) {
    return bloqueio(
      'XML_ITENS_DIVERGENTES',
      'As linhas fiscais não fecham o total devolvido pelo distribuidor oficial.',
      { referencia }
    );
  }
  if (Math.abs(somaFiscal - fiscal) > 0.02) {
    return bloqueio(
      'TOTAL_FISCAL_DIVERGENTE_DA_REFERENCIA',
      'O total fiscal autorizado diverge da referência das parcelas confirmadas.',
      { referencia, itens_fiscais: Object.freeze(fiscais) }
    );
  }

  const naoFiscais = (aplicacao.resultado_oficial.itens || []).filter(
    (linha) => Number(linha.valor_nao_fiscal || 0) > 0.009
  );
  if (!entrada.configFiscal) {
    return resposta({
      bloqueado: false,
      codigo: 'ITENS_FISCAIS_AUTORIZADOS',
      referencia,
      motor,
      itens_fiscais: Object.freeze(fiscais),
      itens_nao_fiscais: Object.freeze(naoFiscais),
      xml: null
    });
  }
  const xml = montarXml(fiscais, conferencia.confirmados, entrada.configFiscal, fiscal);
  if (xml && xml.bloqueado) return resposta({ ...xml, referencia });
  return resposta({
    bloqueado: false,
    codigo: 'DOCUMENTO_FISCAL_AUTORIZADO',
    referencia,
    motor,
    itens_fiscais: Object.freeze(fiscais),
    itens_nao_fiscais: Object.freeze(naoFiscais),
    xml: xml.xmlSemAssinatura,
    valores: xml.valores
  });
}

function apresentacaoComposicaoFiscal(documento, referencia) {
  const fiscal = documento && Array.isArray(documento.itens_fiscais) ? documento.itens_fiscais : [];
  const motor = documento && documento.motor;
  return Object.freeze({
    titulo: 'Composição fiscal da venda',
    nao_e_nova_venda: true,
    editavel: false,
    itens: Object.freeze(fiscal.map((item) => Object.freeze({
      produto_id: Number(item.produto_id),
      quantidade: Number(item.quantidade_fiscal || item.quantidade || 0),
      preco_unitario: item.preco_unitario != null ? Number(item.preco_unitario) : null,
      valor_fiscal: Number(item.valor_fiscal || 0),
      volume_ml: item.volume_total_ml != null ? Number(item.volume_total_ml) : null
    }))),
    valor_fiscal: Number(referencia && referencia.valor_fiscal_referencia || 0),
    valor_nao_fiscal: Number(referencia && referencia.valor_nao_fiscal_referencia || 0),
    diferenca_monetaria: motor && motor.diferenca_monetaria != null ? motor.diferenca_monetaria : null,
    desconto_ajuste: 0,
    desconto_convertido_da_margem: false,
    motivo_desconto:
      'A tolerância de 20% do dinheiro avalia quantidade inteira. O contrato existente não converte essa margem em desconto.'
  });
}

function paraCentavos(valor) {
  return Math.round(round2(valor) * 100);
}

function deCentavos(centavos) {
  return round2(Number(centavos || 0) / 100);
}

function centavosMoedaReal(centavos) {
  const valor = Math.max(0, Math.floor(Number(centavos) || 0));
  return valor - (valor % 5);
}

function precoEmCentavosExatos(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || !(n > 0)) return 0;
  if (Math.abs(round2(n) - n) > 0.001) return 0;
  return paraCentavos(n);
}

function precoCentavosCatalogo(item) {
  return precoEmCentavosExatos(item && item.preco_unitario)
    || precoEmCentavosExatos(item && item.preco_venda)
    || 0;
}

function unidadeDaNota(item) {
  const fracionado = Number((item && (item.produto_fracionado ?? item.vendido_por_peso)) ?? 0) === 1;
  const unidade = String(item && (item.unidade || item.produto_unidade) || 'UN').trim().toUpperCase();
  if (!fracionado && unidade === 'ML') return 'UN';
  return unidade || 'UN';
}

function linhaInteira(origem, quantidade, precoCentavos) {
  const qtd = Number(quantidade);
  const precoC = Number(precoCentavos);
  if (!Number.isInteger(qtd) || qtd <= 0 || !Number.isInteger(precoC) || precoC <= 0) return null;
  const totalLinha = deCentavos(qtd * precoC);
  const preco = deCentavos(precoC);
  if (Math.abs(round2(qtd * preco) - totalLinha) > 0.001) return null;
  return {
    ...origem,
    produto_id: Number(origem.produto_id || origem.id),
    quantidade: qtd,
    quantidade_fiscal: qtd,
    valor_fiscal: totalLinha,
    preco_unitario: preco,
    quantidade_nao_fiscal: 0,
    valor_nao_fiscal: 0,
    unidade: unidadeDaNota(origem)
  };
}

function menorCoberturaInteira(produtos, alvoCentavos) {
  const alvo = Math.max(0, Math.round(Number(alvoCentavos) || 0));
  if (alvo === 0) return { soma: 0, qtys: produtos.map(() => 0) };
  let melhor = null;
  let visitas = 0;
  const qtys = produtos.map(() => 0);

  function visitar(indice, soma) {
    if (visitas >= 50000) return;
    visitas += 1;
    if (indice === produtos.length) {
      if (soma >= alvo && (!melhor || soma < melhor.soma)) {
        melhor = { soma, qtys: qtys.slice() };
      }
      return;
    }
    const produto = produtos[indice];
    for (let qtd = produto.maxQty; qtd >= 0; qtd -= 1) {
      const proxima = soma + (qtd * produto.precoCentavos);
      if (melhor && proxima >= alvo && proxima >= melhor.soma) continue;
      qtys[indice] = qtd;
      visitar(indice + 1, proxima);
      if (melhor && melhor.soma === alvo) return;
    }
  }

  visitar(0, 0);
  if (melhor) return melhor;

  const gula = produtos.map(() => 0);
  let soma = 0;
  const ordem = produtos
    .map((produto, indice) => ({ indice, precoCentavos: produto.precoCentavos }))
    .sort((a, b) => a.precoCentavos - b.precoCentavos);
  while (soma < alvo) {
    const passo = ordem.find((item) => gula[item.indice] < produtos[item.indice].maxQty);
    if (!passo) break;
    gula[passo.indice] += 1;
    soma += passo.precoCentavos;
  }
  if (soma < alvo) return null;
  return { soma, qtys: gula };
}

/**
 * Fecha a NFC-e com quantidades e preços inteiros de catálogo.
 * Até 20% do dinheiro entra, sempre em moeda de R$ 0,05.
 * O que passar disso vira desconto. A venda não fica bloqueada por falta de combinação exata.
 */
async function itensFiscaisInteirosParaReferencia(entrada = {}) {
  const pagamentos = Array.isArray(entrada.pagamentos) ? entrada.pagamentos : [];
  const referencias = calcularReferenciasConfirmadas(pagamentos);
  const fiscalC = paraCentavos(referencias.valor_fiscal_referencia || 0);
  const dinheiroC = paraCentavos(referencias.valor_nao_fiscal_referencia || 0);
  if (fiscalC <= 0 || dinheiroC <= 0) return null;

  const db = entrada.db || null;
  const itens = await completarCategorias(db, Array.isArray(entrada.itens) ? entrada.itens : []);
  const pastéis = [];
  const demais = [];
  for (const item of itens) {
    const qtd = Number(item.quantidade);
    const precoC = precoCentavosCatalogo(item);
    if (!Number.isInteger(qtd) || qtd <= 0 || precoC <= 0) return null;
    const candidato = { origem: item, maxQty: qtd, precoCentavos: precoC };
    if (categoriaDoItem(item) === CATEGORIA_PASTEL) pastéis.push(candidato);
    else demais.push(candidato);
  }
  if (!pastéis.length && !demais.length) return null;

  const linhas = [];
  let somaC = 0;
  for (const pastel of pastéis) {
    const linha = linhaInteira(pastel.origem, pastel.maxQty, pastel.precoCentavos);
    if (!linha) return null;
    linhas.push(linha);
    somaC += pastel.maxQty * pastel.precoCentavos;
  }

  const alvoDemais = fiscalC - somaC;
  if (alvoDemais > 0) {
    const cobertura = menorCoberturaInteira(demais, alvoDemais);
    if (!cobertura) return null;
    for (let indice = 0; indice < demais.length; indice += 1) {
      const qtd = cobertura.qtys[indice];
      if (!qtd) continue;
      const linha = linhaInteira(demais[indice].origem, qtd, demais[indice].precoCentavos);
      if (!linha) return null;
      linhas.push(linha);
    }
    somaC += cobertura.soma;
  }

  if (!linhas.length || somaC < fiscalC) return null;
  const excessoC = somaC - fiscalC;
  const margem = calcularMargemToleranciaDinheiro(pagamentos);
  const margemMoedaC = centavosMoedaReal(paraCentavos(margem && margem.margem_maxima));
  const dinheiroAplicadoC = centavosMoedaReal(Math.min(excessoC, margemMoedaC));
  const descontoC = excessoC - dinheiroAplicadoC;
  const liquidoC = fiscalC + dinheiroAplicadoC;
  if (somaC - descontoC !== liquidoC) return null;

  return {
    itens: linhas,
    desconto: deCentavos(descontoC),
    dinheiro_aplicado: deCentavos(dinheiroAplicadoC),
    valor_fiscal_liquido: deCentavos(liquidoC),
    valor_produtos: deCentavos(somaC)
  };
}

module.exports = {
  integrarPagamentoRecomposicao,
  apresentacaoComposicaoFiscal,
  itensFiscaisInteirosParaReferencia,
  centavosMoedaReal,
  CATEGORIA_PASTEL
};
