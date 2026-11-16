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
  parcelaEfetivamenteConfirmada,
  parcelaAlocaReferenciaPlanejamento
} = require('./PagamentoSequencialComposicaoService');
const {
  calcularMargemToleranciaDinheiro,
  complementoMaximoPermitidoCentavos
} = require('./RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const {
  avaliarCandidatoComComplementoDinheiro
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
  // Mesmo critério do planejamento F×NF (TEF-off informado conta como fiscal candidato).
  const confirmados = (pagamentos || []).filter((pagamento) => (
    parcelaAlocaReferenciaPlanejamento(pagamento)
    || parcelaEfetivamenteConfirmada(pagamento)
  ));
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

/**
 * Modelos de preço fixo a partir dos itens vendidos (centavos inteiros).
 * A composição fiscal do PDV só pode usar produto_id do carrinho — o catálogo
 * global de refrigerantes inventaria itens e estoura PRODUTO_INCOMPATIVEL.
 */
function modelosPrecoFixoDosItens(itens, opcoes = {}) {
  const excluirPastel = opcoes.excluirPastel === true;
  const modelos = [];
  const capacidade = {};
  for (const item of itens || []) {
    if (excluirPastel && categoriaDoItem(item) === CATEGORIA_PASTEL) continue;
    const produtoId = Number(item.produto_id != null ? item.produto_id : item.id);
    const quantidade = Number(item.quantidade);
    if (!Number.isInteger(produtoId) || produtoId <= 0) continue;
    if (!Number.isSafeInteger(quantidade) || quantidade <= 0) continue;
    const subtotalC = Math.round(subtotalDoItem(item) * 100);
    if (!(subtotalC > 0) || subtotalC % quantidade !== 0) continue;
    const precoC = subtotalC / quantidade;
    const categoria = categoriaDoItem(item) || 'ITEM';
    capacidade[categoria] = (capacidade[categoria] || 0) + quantidade;
    modelos.push({
      produtoId,
      nome: item.produto_nome || item.nome || `Produto ${produtoId}`,
      categoriaFiscal: categoria,
      volumeMlPorUnidade: 1,
      quantidadeMaxima: quantidade,
      cotador: {
        precoUnitarioMinimoInterno: precoC / 100,
        cotar(qtd) {
          return {
            subtotalCentavos: precoC * qtd,
            precoUnitarioInterno: precoC / 100,
            regrasAplicadas: [],
            fingerprint: `carrinho-${produtoId}-${qtd}`
          };
        }
      }
    });
  }
  return { modelos, capacidade_por_categoria: capacidade };
}

function idsProdutosVendidos(itens) {
  const ids = new Set();
  for (const item of itens || []) {
    const id = Number(item.produto_id != null ? item.produto_id : item.id);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

/** Motor só é utilizável se todos os compostos existirem no carrinho vendido. */
function motorCompativelComItensVendidos(motor, itens) {
  if (!motor || motor.distribuicao_possivel !== true) return false;
  const vendidos = idsProdutosVendidos(itens);
  const compostos = Array.isArray(motor.itens_compostos) ? motor.itens_compostos : [];
  if (!compostos.length && motor.complemento_dinheiro > 0.009) return false;
  for (const composto of compostos) {
    const id = Number(composto.produto_id != null ? composto.produto_id : composto.produtoId);
    if (!vendidos.has(id)) return false;
  }
  return true;
}

/**
 * Filtra modelos do catálogo PDV aos produto_id já vendidos (preço/capacidade
 * do catálogo só entram se o item estiver no carrinho).
 */
function filtrarModelosAosVendidos(modelos, itens) {
  const vendidos = idsProdutosVendidos(itens);
  return (modelos || []).filter((modelo) => vendidos.has(Number(modelo.produtoId)));
}

/**
 * Snapshot só para o rateio F×NF: reduz o dinheiro gerencial e representa o
 * complemento como capacidade não-dinheiro (não inventa TEF persistido).
 */
function pagamentosParaDistribuicaoComComplemento(confirmados, complementoReais) {
  const complemento = round2(Number(complementoReais || 0));
  if (!(complemento > 0.009)) {
    return (confirmados || []).map((pagamento) => ({ ...pagamento }));
  }
  const saida = [];
  let restante = complemento;
  for (const pagamento of confirmados || []) {
    if (!formaEhDinheiro(pagamento.forma_pagamento)) {
      saida.push({ ...pagamento });
      continue;
    }
    const valor = round2(Number(pagamento.valor || 0));
    const usar = round2(Math.min(valor, restante));
    const gerencial = round2(valor - usar);
    restante = round2(restante - usar);
    if (gerencial > 0.009) {
      saida.push({ ...pagamento, valor: gerencial, tipo_recebimento: 'nao_fiscal' });
    }
  }
  if (complemento > 0.009) {
    saida.push({
      forma_pagamento: 'outros',
      valor: complemento,
      status_autorizacao: 'informada',
      confirmacao_manual: 1,
      tipo_recebimento: 'fiscal',
      complemento_dinheiro_recomposicao: true
    });
  }
  return saida;
}

/**
 * Desconto de ajuste só no fiscal; os centavos saem do F e entram no NF para
 * preservar total_original = fiscal_final + gerencial_final.
 */
function aplicarDescontoAjustePreservandoTotal(resultadoOficial, descontoAjuste) {
  const desconto = round2(Number(descontoAjuste || 0));
  if (!(desconto > 0.009) || !resultadoOficial || !Array.isArray(resultadoOficial.itens)) {
    return resultadoOficial;
  }
  const itens = resultadoOficial.itens.map((linha) => ({ ...linha }));
  let restante = desconto;
  const ordemFiscal = itens
    .map((linha, indice) => ({ indice, valor: Number(linha.valor_fiscal || 0) }))
    .filter((entrada) => entrada.valor > 0.009)
    .sort((a, b) => b.valor - a.valor);
  for (const entrada of ordemFiscal) {
    if (restante <= 0.009) break;
    const linha = itens[entrada.indice];
    const tirar = round2(Math.min(Number(linha.valor_fiscal || 0), restante));
    linha.valor_fiscal = round2(Number(linha.valor_fiscal || 0) - tirar);
    restante = round2(restante - tirar);
  }
  if (restante > 0.009) return null;
  let devolver = desconto;
  const ordemNf = itens
    .map((linha, indice) => ({ indice, valor: Number(linha.valor_nao_fiscal || 0) }))
    .filter((entrada) => entrada.valor > 0.009)
    .sort((a, b) => b.valor - a.valor);
  if (!ordemNf.length) {
    // Sem linha NF prévia: cria a parcela gerencial na maior linha fiscal ajustada.
    const alvo = ordemFiscal[0] && itens[ordemFiscal[0].indice];
    if (!alvo) return null;
    alvo.valor_nao_fiscal = round2(Number(alvo.valor_nao_fiscal || 0) + desconto);
    devolver = 0;
  } else {
    for (const entrada of ordemNf) {
      if (devolver <= 0.009) break;
      itens[entrada.indice].valor_nao_fiscal = round2(
        Number(itens[entrada.indice].valor_nao_fiscal || 0) + devolver
      );
      devolver = 0;
    }
  }
  const totalFiscal = soma(itens, 'valor_fiscal');
  const totalNao = soma(itens, 'valor_nao_fiscal');
  return {
    ...resultadoOficial,
    itens,
    valorFiscalEfetivo: totalFiscal,
    valorFiscalLiquido: totalFiscal,
    valorNaoFiscal: totalNao,
    valorNaoFiscalLiquido: totalNao
  };
}

function inferirFormaEletronicaDocumento(pagamentos) {
  const { formaPagamentoUsaTEF } = require('../tef/tefFluxoPagamento');
  for (const pagamento of pagamentos || []) {
    if (!pagamento || formaEhDinheiro(pagamento.forma_pagamento)) continue;
    if (formaPagamentoUsaTEF(pagamento.forma_pagamento)) {
      return String(pagamento.forma_pagamento);
    }
  }
  return 'pix';
}

/**
 * Pagamentos do XML fiscal: eletrônicos + complemento de dinheiro fiscal.
 * Não altera os recebimentos persistidos da venda.
 *
 * Se o TEF não reconstitui o carimbo na emissão, usa o snapshot
 * valor_fiscal_referencia_inicial — nunca substitui o vNF por dinheiro.
 */
function pagamentosParaDocumentoFiscal(confirmados, complementoReais, opcoes = {}) {
  const docs = [];
  for (const pagamento of confirmados || []) {
    if (formaEhDinheiro(pagamento.forma_pagamento)) continue;
    if (!parcelaEfetivamenteConfirmada(pagamento)) continue;
    docs.push({
      forma_pagamento: pagamento.forma_pagamento,
      valor: Number(pagamento.valor),
      tipo_recebimento: 'fiscal'
    });
  }

  const eletronicoSnapshot = round2(Number(
    opcoes.valor_fiscal_referencia_inicial != null
      ? opcoes.valor_fiscal_referencia_inicial
      : (opcoes.valor_fiscal_eletronico || 0)
  ));
  if (docs.length === 0 && eletronicoSnapshot > 0.009) {
    docs.push({
      forma_pagamento: opcoes.forma_pagamento_eletronica
        || inferirFormaEletronicaDocumento(confirmados),
      valor: eletronicoSnapshot,
      tipo_recebimento: 'fiscal',
      eletronico_snapshot_referencia: true,
      status: 'aprovado',
      status_autorizacao: 'aprovado'
    });
  }

  const complemento = round2(Number(complementoReais || 0));
  if (complemento > 0.009) {
    docs.push({
      forma_pagamento: 'dinheiro',
      valor: complemento,
      tipo_recebimento: 'fiscal',
      // xmlBuilder: em misto, dinheiro só entra no <pag> com esta marca.
      dinheiro_moeda_fechamento: true,
      complemento_dinheiro_recomposicao: true
    });
  }
  return docs;
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
    tipo_recebimento: pagamento.tipo_recebimento
      || (formaEhDinheiro(pagamento.forma_pagamento) ? 'nao_fiscal' : 'fiscal'),
    dinheiro_moeda_fechamento: pagamento.dinheiro_moeda_fechamento === true,
    complemento_dinheiro_recomposicao: pagamento.complemento_dinheiro_recomposicao === true
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
    contextoFechamentoPdv: entrada.contexto || null,
    validacao: {
      composicao_validada_em_homologacao: true,
      itens_composicao: proposta
    },
    itensVendidos: entrada.itens,
    pagamentos: entrada.pagamentosConfirmados,
    totalComercial: entrada.total,
    desconto: round2(Number(entrada.desconto || 0)),
    acrescimo: round2(Number(entrada.acrescimo || 0)),
    // Desconto comercial do PDV não pode reduzir o fiscal da referência
    // (eletrônico + complemento ≤20%); absorve no gerencial.
    preferirNaoFiscal: true,
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
  const contextoFechamento = opcoes.contexto || entrada.contexto || null;
  const total = round2(Number(entrada.total != null ? entrada.total : entrada.total_comercial));
  let pagamentos = Array.isArray(entrada.pagamentos) ? entrada.pagamentos : [];
  const dbConn = opcoes.db || entrada.db || null;
  // CONFIRMACAO-AUTORITATIVA-01: se ainda não carimbados, comprova contra tef_transacoes.
  if (opcoes.pagamentosJaComprovados !== true) {
    const empresaId = entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id;
    const operadorId = opcoes.operadorId != null
      ? opcoes.operadorId
      : (entrada.operadorId != null ? entrada.operadorId : null);
    const { comprovarPagamentosParaReferenciaFiscal } = require('../OrquestradorPagamento');
    const comprovacao = await comprovarPagamentosParaReferenciaFiscal(pagamentos, {
      empresaId,
      operadorId,
      vendaIdPermitida: opcoes.vendaIdPermitida || entrada.venda_id || null,
      db: dbConn
    });
    pagamentos = comprovacao.pagamentos;
  }
  const itens = await completarCategorias(
    dbConn,
    Array.isArray(entrada.itens) ? entrada.itens : []
  );
  const referencia = avaliarReferenciaRecomposicao({
    total,
    pagamentos,
    itens
  }, {
    env,
    contexto: contextoFechamento,
    forcarReferencia: opcoes.forcarReferencia === true
  });

  if (referencia.recomposicao_executada !== true) {
    return bloqueio(
      referencia.motivo_recomposicao || 'ambiente_teste_desligado',
      'A recomposição não está ativa neste ambiente. Ative o fechamento operacional ou o ambiente de teste.',
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
    pagamentosConfirmados: conferencia.confirmados,
    contexto: contextoFechamento
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
  // Residual negativo (pastel > eletrônico): não bloqueia ainda — tenta recomposição
  // pelo eletrônico cheio com os itens do carrinho (passo 2 abaixo).
  const residual = round2(fiscal - valorPastel);
  const residualUtilizavel = residual > 0.009;

  // Fonte preferencial: itens vendidos do carrinho (preço/qtd da venda).
  // Catálogo PDV (carregarModelosRefrigerante) só entra filtrado aos ids vendidos.
  const doCarrinhoResidual = modelosPrecoFixoDosItens(itens, { excluirPastel: true });
  const doCarrinhoCheio = modelosPrecoFixoDosItens(itens);
  let modelos = Array.isArray(opcoes.modelos) ? opcoes.modelos : (Array.isArray(entrada.modelos) ? entrada.modelos : []);
  let capacidade = opcoes.capacidade_por_categoria || entrada.capacidade_por_categoria || {};
  if (modelos.length) {
    modelos = filtrarModelosAosVendidos(modelos, itens);
  }
  if (residualUtilizavel && doCarrinhoResidual.modelos.length) {
    modelos = doCarrinhoResidual.modelos;
    capacidade = doCarrinhoResidual.capacidade_por_categoria;
  } else if (residualUtilizavel && modelos.length === 0 && contexto.db && contexto.empresaId) {
    try {
      const pdv = require('./PedidoPdvComposicaoService');
      const contextoModelos = await pdv.obterContextoComposicaoPdvParaDiagnostico({
        empresaId: contexto.empresaId,
        residualCentavos: Math.round(residual * 100),
        db: contexto.db
      });
      if (contextoModelos && Array.isArray(contextoModelos.modelos) && contextoModelos.modelos.length) {
        modelos = filtrarModelosAosVendidos(contextoModelos.modelos, itens);
        if (!Object.keys(capacidade).length) {
          capacidade = contextoModelos.capacidade_por_categoria || {};
        }
      }
    } catch (_carga) {
      modelos = [];
    }
  }
  // residual === 0: pastel fecha o eletrônico sozinho; residual < 0: proposta vem do retry.
  let proposta = residual >= -0.009
    ? pastéis.map((item) => ({
      produto_id: Number(item.produto_id != null ? item.produto_id : item.id),
      quantidade: Number(item.quantidade),
      subtotal: subtotalDoItem(item)
    }))
    : [];

  let motor = null;
  let complementoDinheiro = 0;
  let descontoAjuste = 0;
  let propostaSomenteMotor = false;
  const margemInfo = complementoMaximoPermitidoCentavos(conferencia.confirmados);
  if (residualUtilizavel && modelos.length) {
    // 1) Tentativa preferencial: residual após pastel fiscal integral (só itens do carrinho).
    motor = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: residual,
      margemMaxima: margemInfo.margem_maxima,
      dinheiroConfirmado: margemInfo.dinheiro_recebido,
      modelos,
      capacidadePorCategoria: capacidade
    });
    if (!motorCompativelComItensVendidos(motor, itens)) {
      motor = null;
    }
  }

  // 2) Residual inviável, pastel > eletrônico, ou residual no teto 20% com
  //    desconto alto: tenta o eletrônico cheio e prefere menor complemento.
  const residualNoTeto20 = !!(motor
    && motor.distribuicao_possivel === true
    && motor.modo === 'acima_teto_20_com_desconto');
  if (
    ((!motor || motor.distribuicao_possivel !== true) || residualNoTeto20)
    && fiscal > 0.009
  ) {
    const modelosCheios = doCarrinhoCheio.modelos.length
      ? doCarrinhoCheio.modelos
      : filtrarModelosAosVendidos(modelos, itens);
    const capacidadeCheia = Object.keys(doCarrinhoCheio.capacidade_por_categoria || {}).length
      ? doCarrinhoCheio.capacidade_por_categoria
      : capacidade;
    if (modelosCheios.length) {
      const motorCheio = avaliarCandidatoComComplementoDinheiro({
        valorFiscalCandidato: fiscal,
        margemMaxima: margemInfo.margem_maxima,
        dinheiroConfirmado: margemInfo.dinheiro_recebido,
        modelos: modelosCheios,
        capacidadePorCategoria: capacidadeCheia
      });
      if (motorCompativelComItensVendidos(motorCheio, itens)) {
        const semMotor = !motor || motor.distribuicao_possivel !== true;
        const complementoCheio = round2(Number(motorCheio.complemento_dinheiro || 0));
        const complementoAtual = round2(Number(motor && motor.complemento_dinheiro || 0));
        const descontoCheio = round2(Number(motorCheio.desconto_ajuste || 0));
        const descontoAtual = round2(Number(motor && motor.desconto_ajuste || 0));
        const melhorComplemento = complementoCheio + 0.009 < complementoAtual;
        const mesmoComplementoMenorDesconto = Math.abs(complementoCheio - complementoAtual) <= 0.02
          && descontoCheio + 0.009 < descontoAtual;
        if (semMotor || melhorComplemento || mesmoComplementoMenorDesconto) {
          motor = motorCheio;
          modelos = modelosCheios;
          capacidade = capacidadeCheia;
          propostaSomenteMotor = true;
          proposta = (motor.itens_compostos || []).map(propostaDoComposto);
        }
      }
    }
  }

  if (residualUtilizavel || propostaSomenteMotor || residual < -0.009) {
    if (!motor || motor.distribuicao_possivel !== true) {
      return bloqueio(
        motor && motor.codigo
          ? motor.codigo
          : (residual < -0.009 ? 'RESIDUAL_PASTEL_NEGATIVO' : 'COMPOSICAO_AUSENTE_NO_MOTOR'),
        motor && motor.motivo
          ? motor.motivo
          : (residual < -0.009
            ? 'O valor dos pastéis excede a referência fiscal e nenhuma composição alternativa coube no eletrônico + margem.'
            : 'O motor não encontrou composição válida para o residual. Nenhum produto foi inventado.'),
        { referencia, motor, margem_complemento: margemInfo }
      );
    }
    complementoDinheiro = round2(Number(motor.complemento_dinheiro || 0));
    descontoAjuste = round2(Number(motor.desconto_ajuste || 0));
    if (!propostaSomenteMotor) {
      proposta = proposta.concat((motor.itens_compostos || []).map(propostaDoComposto));
    }
  }

  const fiscalFinal = round2(fiscal + complementoDinheiro);
  const naoFiscalFinal = round2(naoFiscal - complementoDinheiro);
  if (naoFiscalFinal < -0.009) {
    return bloqueio(
      'COMPLEMENTO_DINHEIRO_EXCEDE_DISPONIVEL',
      'O complemento fiscal calculado ultrapassa o dinheiro confirmado.',
      { referencia, motor, complemento_dinheiro: complementoDinheiro }
    );
  }
  const referenciaAjustada = Object.freeze({
    ...referencia,
    valor_fiscal_referencia: fiscalFinal,
    valor_nao_fiscal_referencia: naoFiscalFinal,
    valor_fiscal_referencia_inicial: fiscal,
    valor_nao_fiscal_referencia_inicial: naoFiscal,
    complemento_dinheiro_utilizado: complementoDinheiro,
    desconto_ajuste: descontoAjuste,
    margem_complemento_maxima: margemInfo.complemento_maximo
  });

  const descontoComercialEntrada = round2(Number(
    entrada.desconto != null ? entrada.desconto : (contexto.desconto || 0)
  ));
  const contextoDistribuicao = {
    ...contexto,
    total,
    desconto: descontoComercialEntrada,
    pagamentosConfirmados: pagamentosParaDistribuicaoComComplemento(
      conferencia.confirmados,
      complementoDinheiro
    )
  };
  // Desconto de ajuste NÃO entra no rateio comercial global (preserva total).
  const aplicacao = await distribuirProposta(
    contextoDistribuicao,
    proposta,
    modelos,
    capacidade
  );
  if (!aplicacao || aplicacao.distribuicao_aplicada !== true) {
    return bloqueio(
      aplicacao && aplicacao.codigo ? aplicacao.codigo : 'AUTORIZACAO_AUSENTE',
      aplicacao && aplicacao.motivo
        ? aplicacao.motivo
        : 'A distribuição oficial não foi autorizada. O XML não foi montado com o carrinho comercial.',
      { referencia: referenciaAjustada, motor }
    );
  }

  let resultadoOficial = aplicacao.resultado_oficial;
  if (descontoAjuste > 0.009) {
    resultadoOficial = aplicarDescontoAjustePreservandoTotal(resultadoOficial, descontoAjuste);
    if (!resultadoOficial) {
      return bloqueio(
        'DESCONTO_AJUSTE_INCOMPATIVEL',
        'Não foi possível aplicar o desconto de ajuste preservando o total original.',
        { referencia: referenciaAjustada, motor }
      );
    }
  }

  const fiscais = linhasFiscais(resultadoOficial);
  const somaFiscal = soma(fiscais, 'valor_fiscal');
  if (Math.abs(somaFiscal - Number(resultadoOficial.valorFiscalEfetivo || 0)) > 0.02) {
    return bloqueio(
      'XML_ITENS_DIVERGENTES',
      'As linhas fiscais não fecham o total devolvido pelo distribuidor oficial.',
      { referencia: referenciaAjustada }
    );
  }
  if (Math.abs(somaFiscal - fiscalFinal) > 0.02) {
    return bloqueio(
      'TOTAL_FISCAL_DIVERGENTE_DA_REFERENCIA',
      'O total fiscal autorizado diverge da referência eletrônica acrescida do complemento de dinheiro.',
      { referencia: referenciaAjustada, itens_fiscais: Object.freeze(fiscais) }
    );
  }

  const naoFiscais = (resultadoOficial.itens || []).filter(
    (linha) => Number(linha.valor_nao_fiscal || 0) > 0.009
  );
  const somaNao = soma(naoFiscais, 'valor_nao_fiscal');
  if (Math.abs(somaNao - naoFiscalFinal) > 0.05) {
    return bloqueio(
      'TOTAL_NAO_FISCAL_DIVERGENTE_DA_REFERENCIA',
      'O total gerencial autorizado diverge do dinheiro remanescente após o complemento.',
      { referencia: referenciaAjustada, itens_nao_fiscais: Object.freeze(naoFiscais) }
    );
  }
  if (Math.abs(round2(somaFiscal + somaNao) - round2(fiscal + naoFiscal)) > 0.02) {
    return bloqueio(
      'TOTAL_ORIGINAL_NAO_PRESERVADO',
      'A soma fiscal + gerencial não preserva o total original da venda.',
      { referencia: referenciaAjustada }
    );
  }
  if (!entrada.configFiscal) {
    return resposta({
      bloqueado: false,
      codigo: 'ITENS_FISCAIS_AUTORIZADOS',
      referencia: referenciaAjustada,
      motor,
      complemento_dinheiro_utilizado: complementoDinheiro,
      desconto_ajuste: descontoAjuste,
      itens_fiscais: Object.freeze(fiscais),
      itens_nao_fiscais: Object.freeze(naoFiscais),
      xml: null
    });
  }
  const xml = montarXml(
    fiscais,
    pagamentosParaDocumentoFiscal(conferencia.confirmados, complementoDinheiro),
    entrada.configFiscal,
    fiscalFinal
  );
  if (xml && xml.bloqueado) return resposta({ ...xml, referencia: referenciaAjustada });
  return resposta({
    bloqueado: false,
    codigo: 'DOCUMENTO_FISCAL_AUTORIZADO',
    referencia: referenciaAjustada,
    motor,
    complemento_dinheiro_utilizado: complementoDinheiro,
    desconto_ajuste: descontoAjuste,
    itens_fiscais: Object.freeze(fiscais),
    itens_nao_fiscais: Object.freeze(naoFiscais),
    xml: xml.xmlSemAssinatura,
    valores: xml.valores
  });
}

function apresentacaoComposicaoFiscal(documento, referencia) {
  const fiscal = documento && Array.isArray(documento.itens_fiscais) ? documento.itens_fiscais : [];
  const motor = documento && documento.motor;
  // Preferir referência ajustada do documento (eletrônico + complemento), não a inicial.
  const refAjustada = (documento && documento.referencia) || referencia || null;
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
    valor_fiscal: Number(refAjustada && refAjustada.valor_fiscal_referencia || 0),
    valor_nao_fiscal: Number(refAjustada && refAjustada.valor_nao_fiscal_referencia || 0),
    diferenca_monetaria: motor && motor.diferenca_monetaria != null ? motor.diferenca_monetaria : null,
    desconto_ajuste: Number(
      documento && documento.desconto_ajuste != null
        ? documento.desconto_ajuste
        : (refAjustada && refAjustada.desconto_ajuste) || 0
    ),
    complemento_dinheiro_utilizado: Number(
      documento && documento.complemento_dinheiro_utilizado != null
        ? documento.complemento_dinheiro_utilizado
        : (refAjustada && refAjustada.complemento_dinheiro_utilizado) || 0
    ),
    desconto_convertido_da_margem: false,
    motivo_desconto:
      'Complemento = parcela do dinheiro (múltiplo de R$ 0,05) classificada como fiscal. '
      + 'Desconto de ajuste apenas alinha o bruto da composição ao valor fiscal final.'
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
  pagamentosParaDocumentoFiscal,
  pagamentosParaDistribuicaoComComplemento,
  centavosMoedaReal,
  CATEGORIA_PASTEL
};
