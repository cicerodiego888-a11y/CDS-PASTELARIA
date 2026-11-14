/**
 * CDS-VENDA-VALOR-PASTEIS-01 — adaptador de entrada.
 * Recebe valor total + quantidade de pastéis, cria Pedido via EntradaPedido
 * e reutiliza prepararComposicaoPedidoPdv + handoff PDV existentes.
 * O pedido guarda o valor comercial informado. O payload fiscal reparte
 * esse total pelo cadastro do pastel e pelos componentes, e o desconto
 * técnico fica só no excedente da busca. O motor compartilhado não muda.
 *
 * @module services/vendas/VendaPorValorPasteisService
 */
'use strict';

const EntradaPedido = require('../pedido/EntradaPedidoService');
const { prepararComposicaoPedidoPdv } = require('./PedidoPdvComposicaoService');
const PedidoFaturamentoOperacaoRepository = require('../faturamento/PedidoFaturamentoOperacaoRepository');
const { criarCotadorPreco, CotacaoPrecoErro, TIPO_VENDA } = require('./CotacaoPrecoProdutoService');
const { obterModoEstoqueEmpresa } = require('../empresas/EmpresaModoEstoqueService');

const CATEGORIA_PASTEIS = 'PASTEIS';
const OBS_ORIGEM = 'VENDA_POR_VALOR_PASTEIS';

function erro(code, message, statusCode = 400, detalhes = null) {
  const err = new Error(message);
  err.code = code;
  err.codigo = code;
  err.statusCode = statusCode;
  if (detalhes) err.detalhes = detalhes;
  return err;
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function dinheiroParaCentavos(valor, campo) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) {
    throw erro('VALOR_TOTAL_INVALIDO', `${campo} deve ser um valor monetário positivo.`);
  }
  const centavos = Math.round(n * 100);
  if (!Number.isSafeInteger(centavos) || centavos <= 0) {
    throw erro('VALOR_TOTAL_INVALIDO', `${campo} não é representável em centavos.`);
  }
  if (Math.abs(n * 100 - centavos) > 1e-6) {
    throw erro('VALOR_TOTAL_INVALIDO', `${campo} deve ter no máximo duas casas decimais.`);
  }
  return centavos;
}

function quantidadePasteis(valor) {
  const n = Number(valor);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw erro(
      'QUANTIDADE_PASTEIS_INVALIDA',
      'A quantidade de pastéis deve ser um inteiro positivo.'
    );
  }
  return n;
}

function produtoComercialAtivo(produto) {
  return Number(produto.ativo) === 1
    && String(produto.tipo_operacional || 'COMERCIAL').toUpperCase() === 'COMERCIAL'
    && String(produto.categoria_tipo || 'produto').trim().toLowerCase() === 'produto';
}

/**
 * Resolve o pastel cadastrado elegível (categoria PASTEIS).
 * Se produto_pastel_id for informado, valida. Senão exige unicidade.
 */
async function resolverProdutoPastel(db, produtoPastelIdInformado) {
  const candidatos = await dbAll(
    db,
    `SELECT p.id, p.nome, p.ativo, p.preco_venda,
            COALESCE(p.tipo_operacional, 'COMERCIAL') AS tipo_operacional,
            c.nome AS categoria_nome, c.tipo AS categoria_tipo
       FROM produtos p
       JOIN categorias c ON c.id = p.categoria_id
      WHERE UPPER(TRIM(c.nome)) = ?
      ORDER BY p.id`,
    [CATEGORIA_PASTEIS]
  );
  const elegiveis = candidatos.filter(produtoComercialAtivo);

  if (produtoPastelIdInformado != null && produtoPastelIdInformado !== '') {
    const id = Number(produtoPastelIdInformado);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw erro('PRODUTO_PASTEL_INVALIDO', 'produto_pastel_id inválido.');
    }
    const encontrado = elegiveis.find((p) => Number(p.id) === id);
    if (!encontrado) {
      throw erro(
        'PRODUTO_PASTEL_NAO_ELEGIVEL',
        'O produto informado não é um pastel comercial ativo da categoria PASTEIS.',
        409,
        { produto_pastel_id: id }
      );
    }
    return encontrado;
  }

  if (elegiveis.length === 0) {
    throw erro(
      'PASTEL_CADASTRO_AUSENTE',
      'Não há pastel comercial ativo cadastrado na categoria PASTEIS para esta operação.',
      409
    );
  }
  if (elegiveis.length > 1) {
    throw erro(
      'PASTEL_CADASTRO_AMBIGUO',
      'Há mais de um pastel elegível cadastrado. Informe produto_pastel_id para identificar o produto.',
      409,
      {
        candidatos: elegiveis.map((p) => ({ id: Number(p.id), nome: p.nome }))
      }
    );
  }
  return elegiveis[0];
}

/**
 * Linha comercial do pedido: o valor informado inteiro fica no pastel
 * para a soma dos itens fechar o total. Não é o preço fiscal emitido.
 */
function montarItemPedidoPastel(produtoId, quantidade, totalCentavos) {
  const subtotal = totalCentavos / 100;
  const precoUnitario = Number((subtotal / quantidade).toFixed(6));
  const subtotalRecalc = Number((precoUnitario * quantidade).toFixed(2));
  if (Math.abs(subtotalRecalc - subtotal) > 0.01) {
    throw erro(
      'TOTAL_NAO_DISTRIBUIVEL',
      'Não foi possível distribuir o valor total na quantidade de pastéis informada.'
    );
  }
  return {
    produto_id: Number(produtoId),
    quantidade,
    preco_unitario: precoUnitario,
    subtotal,
    desconto_percentual: 0
  };
}

/**
 * Item no preço de cadastro — usado só na EntradaPedido (passa personalização).
 * Em seguida `persistirMassaMonetariaPedidoAlvo` alinha total+itens para a
 * validação de integridade do motor de composição (soma itens === total).
 */
function montarItemPedidoPastelDaCotacao(produtoId, quantidade, cotacao) {
  const subtotalCentavos = Number(cotacao && cotacao.subtotalCentavos);
  if (!Number.isSafeInteger(subtotalCentavos) || subtotalCentavos <= 0) {
    throw erro('PRECO_PASTEL_INVALIDO', 'Cotação sem subtotal válido para montar o item do pedido.', 409);
  }
  const subtotal = Number((subtotalCentavos / 100).toFixed(2));
  let precoUnitario = Number(cotacao.precoUnitarioInterno);
  if (!Number.isFinite(precoUnitario) || precoUnitario <= 0) {
    precoUnitario = Number((subtotal / quantidade).toFixed(6));
  }
  return {
    produto_id: Number(produtoId),
    quantidade,
    preco_unitario: precoUnitario,
    subtotal,
    desconto_percentual: 0
  };
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

/**
 * Persistência no formato aceito por ComposicaoInterna.carregarPedido:
 *   total === soma(itens.subtotal) − desconto  (frete = 0)
 * A massa monetária fica na linha do pastel para essa invariante.
 * A distribuição fiscal, feita depois, usa o cadastro e o residual.
 */
async function persistirMassaMonetariaPedidoAlvo(db, params = {}) {
  const pedidoId = Number(params.pedidoId);
  const empresaId = Number(params.empresaId);
  const produtoPastelId = Number(params.produtoPastelId);
  const quantidade = Number(params.quantidade);
  const totalCentavos = Number(params.totalCentavos);

  if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) {
    throw erro('PEDIDO_INVALIDO', 'pedidoId inválido ao persistir massa monetária.', 500);
  }
  if (!Number.isSafeInteger(empresaId) || empresaId <= 0) {
    throw erro('EMPRESA_OBRIGATORIA', 'empresaId inválido ao persistir massa monetária.');
  }

  const item = montarItemPedidoPastel(produtoPastelId, quantidade, totalCentavos);
  const totalReais = totalCentavos / 100;

  const pedido = await dbGet(
    db,
    `SELECT id, empresa_id, desconto, frete FROM pedidos WHERE id = ?`,
    [pedidoId]
  );
  if (!pedido || Number(pedido.empresa_id) !== empresaId) {
    throw erro(
      'PEDIDO_EMPRESA_DIVERGENTE',
      'Pedido inexistente para a empresa ao gravar o total-alvo.',
      404,
      { pedido_id: pedidoId, empresa_id: empresaId }
    );
  }

  const itens = await dbAll(
    db,
    `SELECT id, produto_id FROM pedidos_itens WHERE pedido_id = ? ORDER BY id ASC`,
    [pedidoId]
  );
  const linhasPastel = itens.filter((row) => Number(row.produto_id) === produtoPastelId);
  if (linhasPastel.length !== 1) {
    throw erro(
      'PEDIDO_ITENS_INESPERADOS',
      'Esperava exatamente uma linha do pastel no Pedido para gravar a massa monetária.',
      500,
      { pedido_id: pedidoId, linhas_pastel: linhasPastel.length, total_itens: itens.length }
    );
  }
  if (itens.length !== 1) {
    throw erro(
      'PEDIDO_ITENS_INESPERADOS',
      'O Pedido de venda por valor deve conter somente a linha do pastel antes da composição.',
      500,
      { pedido_id: pedidoId, total_itens: itens.length }
    );
  }

  const upPed = await dbRun(
    db,
    `UPDATE pedidos SET total = ?, desconto = 0, frete = 0 WHERE id = ? AND empresa_id = ?`,
    [totalReais, pedidoId, empresaId]
  );
  if (!upPed.changes) {
    throw erro('PEDIDO_TOTAL_NAO_ATUALIZADO', 'Falha ao gravar total do Pedido.', 500);
  }

  const upItem = await dbRun(
    db,
    `UPDATE pedidos_itens
        SET quantidade = ?, preco_unitario = ?, subtotal = ?
      WHERE id = ? AND pedido_id = ?`,
    [
      item.quantidade,
      item.preco_unitario,
      item.subtotal,
      Number(linhasPastel[0].id),
      pedidoId
    ]
  );
  if (!upItem.changes) {
    throw erro('PEDIDO_ITEM_NAO_ATUALIZADO', 'Falha ao gravar a massa monetária no item do pastel.', 500);
  }

  // Confirma a mesma invariante de ComposicaoInterna.carregarPedido (centavos).
  const somaItensCentavos = Math.round(Number(item.subtotal) * 100);
  if (somaItensCentavos !== totalCentavos) {
    throw erro(
      'PEDIDO_TOTAL_INCONSISTENTE',
      'Massa monetária inconsistente após persistência (itens ≠ total).',
      500,
      { total_centavos: totalCentavos, itens_centavos: somaItensCentavos }
    );
  }

  return { total: totalReais, item };
}

/** @deprecated Preferir persistirMassaMonetariaPedidoAlvo (total+itens alinhados). */
async function atualizarTotalPedidoAlvo(db, pedidoId, empresaId, totalReais) {
  const r = await dbRun(
    db,
    `UPDATE pedidos SET total = ? WHERE id = ? AND empresa_id = ?`,
    [Number(totalReais), Number(pedidoId), Number(empresaId)]
  );
  if (!r.changes) {
    throw erro(
      'PEDIDO_TOTAL_NAO_ATUALIZADO',
      'Não foi possível gravar o valor total do pedido para a composição.',
      500,
      { pedido_id: Number(pedidoId), empresa_id: Number(empresaId) }
    );
  }
}

/**
 * Separa o valor comercial, já gravado no pedido, da composição fiscal.
 * O pastel fiscal sai pelo cadastro (total − residual). O desconto técnico
 * é só o quanto os componentes passaram do residual. O líquido continua
 * o valor informado: cadastro + componentes − excedente.
 * Não altera a busca nem a composição de um pedido cuja linha do pastel
 * não seja a massa inteira.
 */
function distribuirValorFiscalVendaPorValor(composicao, produtoPastelId) {
  const totalCentavos = Number(composicao && composicao.valorFinalCentavos);
  const residualCentavos = Number(composicao && composicao.valorResidualCentavos);
  const pastelComercialCentavos = Number(composicao && composicao.valorPastelCentavos);
  const brutoComercialCentavos = Number(composicao && composicao.valorCompostoBrutoCentavos);
  const produtoId = Number(produtoPastelId);

  if (!Number.isSafeInteger(totalCentavos) || totalCentavos <= 0
    || !Number.isSafeInteger(residualCentavos) || residualCentavos < 0
    || !Number.isSafeInteger(pastelComercialCentavos)
    || pastelComercialCentavos !== totalCentavos
    || !Number.isSafeInteger(brutoComercialCentavos)
    || brutoComercialCentavos < pastelComercialCentavos
    || !Number.isSafeInteger(produtoId) || produtoId <= 0) {
    throw erro(
      'DISTRIBUICAO_FISCAL_INVALIDA',
      'A venda por valor não recebeu uma composição cuja linha do pastel seja o valor comercial informado.',
      500,
      {
        total_centavos: totalCentavos,
        residual_centavos: residualCentavos,
        pastel_comercial_centavos: pastelComercialCentavos,
        bruto_comercial_centavos: brutoComercialCentavos,
        produto_pastel_id: produtoId
      }
    );
  }

  const catalogoCentavos = totalCentavos - residualCentavos;
  const componentesCentavos = brutoComercialCentavos - pastelComercialCentavos;
  const excedenteCentavos = componentesCentavos - residualCentavos;
  const brutoFiscalCentavos = catalogoCentavos + componentesCentavos;
  if (!Number.isSafeInteger(catalogoCentavos) || catalogoCentavos <= 0
    || !Number.isSafeInteger(componentesCentavos) || componentesCentavos < 0
    || !Number.isSafeInteger(excedenteCentavos) || excedenteCentavos < 0
    || brutoFiscalCentavos - excedenteCentavos !== totalCentavos) {
    throw erro(
      'DISTRIBUICAO_FISCAL_INVALIDA',
      'Cadastro, componentes e excedente não fecham o valor comercial informado.',
      500,
      {
        catalogo_centavos: catalogoCentavos,
        componentes_centavos: componentesCentavos,
        excedente_centavos: excedenteCentavos,
        total_centavos: totalCentavos
      }
    );
  }

  const itens = (Array.isArray(composicao.itens) ? composicao.itens : []).map((item) => ({ ...item }));
  const linhasPastel = itens.filter((item) => Number(item.produto_id) === produtoId);
  if (linhasPastel.length !== 1) {
    throw erro(
      'DISTRIBUICAO_FISCAL_INVALIDA',
      'A distribuição fiscal espera uma linha do pastel na composição.',
      500,
      { produto_pastel_id: produtoId, linhas: linhasPastel.length }
    );
  }

  const linha = linhasPastel[0];
  const quantidade = Number(linha.quantidade);
  const precoUnitario = catalogoCentavos / quantidade / 100;
  if (!Number.isSafeInteger(quantidade) || quantidade <= 0
    || Math.round(precoUnitario * quantidade * 100) !== catalogoCentavos) {
    throw erro(
      'PRECO_LINHA_NAO_REPRESENTAVEL',
      'O valor fiscal do pastel não reproduz o cadastro na quantidade informada.',
      500,
      {
        produto_pastel_id: produtoId,
        quantidade,
        catalogo_centavos: catalogoCentavos
      }
    );
  }

  linha.preco_unitario = precoUnitario;
  linha.subtotal = catalogoCentavos / 100;
  linha.desconto_percentual = 0;
  linha.desconto_valor = 0;
  linha.desconto_atacado = 0;
  linha.desconto_manual = 0;
  linha.preco_origem = Number(precoUnitario.toFixed(6));

  const somaItensCentavos = itens.reduce(
    (soma, item) => soma + Math.round(Number(item.subtotal) * 100),
    0
  );
  if (somaItensCentavos !== brutoFiscalCentavos) {
    throw erro(
      'DISTRIBUICAO_FISCAL_INVALIDA',
      'A soma fiscal dos itens não fecha cadastro mais componentes.',
      500,
      { soma_itens_centavos: somaItensCentavos, bruto_fiscal_centavos: brutoFiscalCentavos }
    );
  }

  return {
    ...composicao,
    valorPastelCentavos: catalogoCentavos,
    valorCompostoBrutoCentavos: brutoFiscalCentavos,
    descontoCentavos: excedenteCentavos,
    desconto: excedenteCentavos / 100,
    valorFinalCentavos: totalCentavos,
    itens
  };
}

/**
 * @param {object} params
 * @param {object} params.db
 * @param {number} params.empresaId
 * @param {number|string} params.valorTotal
 * @param {number|string} params.quantidadePasteis
 * @param {number} [params.produtoPastelId]
 * @param {number|null} [params.operadorId]
 * @param {string|null} [params.chaveIdempotencia]
 * @param {number|null} [params.clienteId]
 */
async function iniciarVendaPorValorPasteis(params = {}, deps = {}) {
  const db = params.db;
  if (!db) throw erro('DB_OBRIGATORIO', 'db é obrigatório.', 500);

  const empresaId = Number(params.empresaId);
  if (!Number.isSafeInteger(empresaId) || empresaId <= 0) {
    throw erro('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório.');
  }

  const totalCentavos = dinheiroParaCentavos(
    params.valorTotal != null ? params.valorTotal : params.valor_total,
    'valor_total'
  );
  const quantidade = quantidadePasteis(
    params.quantidadePasteis != null
      ? params.quantidadePasteis
      : params.quantidade_pasteis
  );
  const produtoPastel = await resolverProdutoPastel(
    db,
    params.produtoPastelId != null ? params.produtoPastelId : params.produto_pastel_id
  );

  const cotar = deps.criarCotadorPreco || criarCotadorPreco;
  let cotacao;
  try {
    const cotador = await cotar({
      db,
      empresaId,
      produtoId: Number(produtoPastel.id),
      tipoVenda: TIPO_VENDA.PESO,
      agora: new Date()
    });
    cotacao = cotador.cotar(quantidade);
  } catch (err) {
    if (err instanceof CotacaoPrecoErro) {
      throw erro(
        'PRECO_PASTEL_INVALIDO',
        `Não foi possível cotar o pastel ${produtoPastel.nome}: ${err.message}`,
        409,
        { produto_id: Number(produtoPastel.id), codigo_cotacao: err.codigo }
      );
    }
    throw err;
  }
  if (!Number.isSafeInteger(cotacao.subtotalCentavos) || cotacao.subtotalCentavos <= 0) {
    throw erro('PRECO_PASTEL_INVALIDO', 'A cotação do pastel não produziu subtotal válido.', 409);
  }
  if (cotacao.subtotalCentavos > totalCentavos) {
    throw erro(
      'RESIDUAL_PASTEL_NEGATIVO',
      'O valor-base dos pastéis excede o valor total informado; nenhuma composição será gerada.',
      409,
      {
        total_centavos: totalCentavos,
        total_pastel_centavos: cotacao.subtotalCentavos
      }
    );
  }

  // 1) EntradaPedido com preço de cadastro (compatível com personalização).
  // 2) Em seguida alinha total+item na massa monetária do valor informado —
  //    mesma invariante do fluxo original / fixtures: soma(itens) === total.
  // 3) Motor de composição recota o pastel e monta o residual (inalterado).
  // 4) A distribuição fiscal devolve o pastel ao cadastro e limita o desconto ao excedente.
  const itemEntrada = montarItemPedidoPastelDaCotacao(produtoPastel.id, quantidade, cotacao);
  const valorTotalReais = totalCentavos / 100;
  const chaveIdempotencia = params.chaveIdempotencia || params.chave_idempotencia || null;

  const receber = deps.receberEntrada || ((entrada) => EntradaPedido.receber(entrada));
  const criado = await receber({
    canal: EntradaPedido.CanalOrigem.EQUIPE,
    empresaId,
    operadorId: params.operadorId != null ? params.operadorId : null,
    chaveIdempotencia,
    body: {
      tipo: 'pedido',
      status: 'PEDIDO',
      // Sem `total`: EntradaPedido/Personalização fecham pela soma dos itens (cadastro).
      desconto: 0,
      frete: 0,
      cliente_id: params.clienteId != null
        ? params.clienteId
        : (params.cliente_id != null ? params.cliente_id : null),
      observacao: OBS_ORIGEM,
      itens: [itemEntrada]
    }
  });

  const pedido = criado && criado.pedido ? criado.pedido : criado;
  const pedidoId = Number(pedido && (pedido.id != null ? pedido.id : pedido.pedido_id));
  if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) {
    throw erro('PEDIDO_NAO_CRIADO', 'A entrada não retornou um Pedido válido.', 500);
  }

  const persistirMassa = deps.persistirMassaMonetariaPedidoAlvo || persistirMassaMonetariaPedidoAlvo;
  await persistirMassa(db, {
    pedidoId,
    empresaId,
    produtoPastelId: Number(produtoPastel.id),
    quantidade,
    totalCentavos
  });

  const consultarOperacao = deps.consultarOperacaoPdv
    || ((id, emp) => PedidoFaturamentoOperacaoRepository.consultarOperacaoPdv(id, emp));
  const prepararOperacao = deps.prepararOperacaoPdv
    || ((id, emp, payload) => PedidoFaturamentoOperacaoRepository.prepararOperacaoPdv(id, emp, payload));
  const prepararComposicao = deps.prepararComposicaoPedidoPdv || prepararComposicaoPedidoPdv;
  const lerModoEstoque = deps.obterModoEstoqueEmpresa || obterModoEstoqueEmpresa;

  const operacaoExistente = await consultarOperacao(pedidoId, empresaId);
  if (operacaoExistente?.operacao?.venda_id != null) {
    const payloadPersistido = operacaoExistente.payload;
    const modoEstoque = await lerModoEstoque(db, empresaId);
    return {
      success: true,
      origem: OBS_ORIGEM,
      pedido_id: pedidoId,
      empresa_id: empresaId,
      produto_pastel_id: Number(produtoPastel.id),
      produto_pastel_nome: produtoPastel.nome,
      quantidade_pasteis: quantidade,
      valor_total_informado: valorTotalReais,
      operacao_id: operacaoExistente.operacao.id,
      venda_id: operacaoExistente.operacao.venda_id,
      recuperacao: true,
      venda_concluida: operacaoExistente.operacao.status === 'FINALIZADA',
      total: payloadPersistido.total,
      desconto: payloadPersistido.desconto || 0,
      valor_composicao_bruto: payloadPersistido.valor_composicao_bruto || payloadPersistido.total,
      cliente_id: payloadPersistido.cliente_id || null,
      itens: payloadPersistido.itens,
      fingerprint: payloadPersistido.fingerprint,
      modo_estoque: modoEstoque.modo,
      pedido_repetido: criado.repetido === true || criado.idempotente === true
    };
  }

  const composicao = await prepararComposicao({
    pedidoId,
    empresaId
  }, { db });

  const payload = {
    pedidoId: composicao.pedidoId,
    empresaId: composicao.empresaId,
    fingerprint: composicao.fingerprint,
    total: composicao.valorFinalCentavos / 100,
    desconto: composicao.desconto,
    valor_composicao_bruto: composicao.valorCompostoBrutoCentavos / 100,
    cliente_id: composicao.clienteId,
    itens: composicao.itens
  };

  const preparacao = await prepararOperacao(
    composicao.pedidoId,
    empresaId,
    payload
  );

  const modoEstoque = await lerModoEstoque(db, empresaId);

  return {
    success: true,
    origem: OBS_ORIGEM,
    pedido_id: composicao.pedidoId,
    empresa_id: empresaId,
    produto_pastel_id: Number(produtoPastel.id),
    produto_pastel_nome: produtoPastel.nome,
    quantidade_pasteis: quantidade,
    valor_total_informado: valorTotalReais,
    valor_pastel_centavos: composicao.valorPastelCentavos,
    valor_residual_centavos: composicao.valorResidualCentavos,
    desconto_centavos: composicao.descontoCentavos,
    modo_composicao: composicao.modo,
    operacao_id: preparacao.operacao.id,
    venda_id: preparacao.operacao.venda_id || null,
    recuperacao: preparacao.recuperacao,
    venda_concluida: preparacao.operacao.status === 'FINALIZADA',
    total: payload.total,
    desconto: payload.desconto,
    valor_composicao_bruto: payload.valor_composicao_bruto,
    cliente_id: preparacao.payload.cliente_id || null,
    itens: preparacao.payload.itens,
    fingerprint: preparacao.payload.fingerprint,
    modo_estoque: modoEstoque.modo,
    pedido_repetido: criado.repetido === true || criado.idempotente === true
  };
}

module.exports = {
  iniciarVendaPorValorPasteis,
  resolverProdutoPastel,
  montarItemPedidoPastel,
  montarItemPedidoPastelDaCotacao,
  persistirMassaMonetariaPedidoAlvo,
  distribuirValorFiscalVendaPorValor,
  atualizarTotalPedidoAlvo,
  OBS_ORIGEM,
  CATEGORIA_PASTEIS
};
