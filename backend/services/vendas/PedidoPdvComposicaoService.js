'use strict';

const ComposicaoFiscalPedidoService = require('./ComposicaoFiscalPedidoService');
const { criarCotadorPreco, CotacaoPrecoErro, TIPO_VENDA } = require('./CotacaoPrecoProdutoService');
const { calcularEstoqueProduto } = require('../estoque/EstoqueDisponivelService');
const { produtoControlaEstoque } = require('../estoque/produtoControlaEstoque');
const {
  obterCreditoReservaPedido,
  creditarDisponibilidadeComReservaPedido
} = require('../estoque/pedidoReservaPonteNucleo');

const { internos: ComposicaoInterna } = ComposicaoFiscalPedidoService;
const CATEGORIA_PASTEIS = 'PASTEIS';
const CATEGORIA_REFRIGERANTES = 'REFRIGERANTES';
const VOLUMES_REFRIGERANTE_ELEGIVEIS_ML = new Set([200, 300, 500]);

function erro(code, message, detalhes = null) {
  const err = new Error(message);
  err.code = code;
  err.codigo = code;
  err.statusCode = 409;
  err.detalhes = detalhes;
  return err;
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function inteiroPositivo(valor, campo) {
  const numero = Number(valor);
  if (!Number.isSafeInteger(numero) || numero <= 0) {
    throw erro('PARAMETRO_INVALIDO', `${campo} deve ser um inteiro positivo.`);
  }
  return numero;
}

function somarCentavos(atual, proximo) {
  const soma = atual + proximo;
  if (!Number.isSafeInteger(soma)) {
    throw erro('TOTAL_INVALIDO', 'A soma da composição excede a precisão monetária suportada.');
  }
  return soma;
}

function mapearItemVenda(
  produtoId,
  quantidade,
  precoUnitarioInterno,
  subtotalCentavos,
  metadadosPreco = {}
) {
  const subtotalCalculadoCentavos = Math.round(precoUnitarioInterno * quantidade * 100);
  if (!Number.isSafeInteger(subtotalCentavos)
    || subtotalCentavos !== subtotalCalculadoCentavos) {
    throw erro(
      'PRECO_LINHA_NAO_REPRESENTAVEL',
      `O preço cotado do produto ${produtoId} não reproduz o subtotal comercial em centavos.`,
      {
        produto_id: produtoId,
        quantidade,
        preco_unitario: precoUnitarioInterno,
        subtotal_centavos: subtotalCentavos,
        subtotal_calculado_centavos: subtotalCalculadoCentavos
      }
    );
  }
  return {
    produto_id: produtoId,
    quantidade,
    preco_unitario: precoUnitarioInterno,
    subtotal: subtotalCentavos,
    tipo_venda: TIPO_VENDA.PESO,
    desconto_percentual: 0,
    desconto_valor: 0,
    desconto_manual: 0,
    desconto_atacado: 0,
    tipo_preco: 'varejo',
    promocao_id: null,
    ...metadadosPreco
  };
}

function metadadosDaCotacao(produto, quantidade, cotacao) {
  const regras = cotacao.regrasAplicadas || [];
  const promocao = regras.find((regra) => regra.tipo === 'PROMOCAO');
  const atacado = regras.find((regra) => regra.tipo === 'ATACADO');
  const precoBase = Number(produto.preco_venda || 0);
  const precoOrigem = promocao && Number(promocao.precoPromocional) > 0
    ? Number(promocao.precoPromocional)
    : precoBase;
  const precoBaseSubtotalCentavos = Math.round(precoBase * quantidade * 100);
  const precoOrigemSubtotalCentavos = Math.round(precoOrigem * quantidade * 100);
  const precoFinalCentavos = cotacao.subtotalCentavos;
  const descontoCentavos = Math.max(
    0,
    precoBaseSubtotalCentavos - precoFinalCentavos
  );
  const descontoAtacadoCentavos = atacado
    ? Math.max(0, precoOrigemSubtotalCentavos - precoFinalCentavos)
    : 0;

  return {
    desconto_percentual: precoBaseSubtotalCentavos > 0
      ? Number(((descontoCentavos / precoBaseSubtotalCentavos) * 100).toFixed(2))
      : 0,
    desconto_valor: descontoCentavos / 100,
    desconto_atacado: descontoAtacadoCentavos / 100,
    desconto_manual: 0,
    tipo_preco: atacado ? 'atacado' : 'varejo',
    promocao_id: promocao ? promocao.id : null,
    preco_origem: Number(precoOrigem.toFixed(6))
  };
}

async function carregarCategoriasPedido(itens, db) {
  if (!itens.length) return [];
  const ids = [...new Set(itens.map((item) => Number(item.produto_id)))];
  return dbAll(
    db,
    `SELECT p.id, p.nome, p.ativo, p.updated_at, p.categoria_id, p.preco_venda,
            COALESCE(p.tipo_operacional, 'COMERCIAL') AS tipo_operacional,
            c.nome AS categoria_nome, c.tipo AS categoria_tipo
       FROM produtos p
       LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
}

async function carregarModelosRefrigerante(empresaId, pedidoId, residualCentavos, db, agora) {
  const estoqueEmpresaSchema = await dbAll(
    db,
    "SELECT 1 AS existe FROM sqlite_master WHERE type = 'table' AND name = 'estoque_empresa'"
  );
  if (!estoqueEmpresaSchema.length) {
    throw erro(
      'SCHEMA_ESTOQUE_AUSENTE',
      'A disponibilidade por empresa não pode ser verificada sem o schema existente de estoque_empresa.'
    );
  }
  const produtos = await dbAll(
    db,
    `SELECT p.id, p.nome, p.ativo, p.updated_at, p.categoria_id, p.preco_venda,
            p.utiliza_volume, p.volume_valor, p.volume_unidade,
            p.unidade, p.utiliza_conversao, p.unidade_estoque,
            p.controla_estoque,
            COALESCE(ee.saldo_fiscal, 0) AS saldo_fiscal,
            COALESCE(ee.saldo_nao_fiscal, 0) AS saldo_nao_fiscal,
            COALESCE(ee.estoque_atual, 0) AS estoque_atual,
            COALESCE(ee.reservado_fiscal, 0) AS reservado_fiscal,
            COALESCE(ee.reservado_nao_fiscal, 0) AS reservado_nao_fiscal,
            COALESCE(p.tipo_operacional, 'COMERCIAL') AS tipo_operacional,
            c.nome AS categoria_nome, c.tipo AS categoria_tipo
       FROM produtos p
       JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN estoque_empresa ee
         ON ee.produto_id = p.id AND ee.empresa_id = ?
      WHERE UPPER(TRIM(c.nome)) = ?
        AND LOWER(TRIM(COALESCE(c.tipo, 'produto'))) = 'produto'
      ORDER BY p.id`,
    [empresaId, CATEGORIA_REFRIGERANTES]
  );
  const produtosAtivos = produtos.filter((produto) => (
    Number(produto.ativo) === 1
    && String(produto.tipo_operacional || '').toUpperCase() !== 'INSUMO'
  ));
  const creditoPedido = await obterCreditoReservaPedido(pedidoId, { db });
  const modelos = [];
  const invalidos = [];

  for (const produto of produtosAtivos) {
    const produtoId = Number(produto.id);
    const invalidar = (motivo, mensagem) => invalidos.push({
      produto_id: produtoId,
      motivo,
      ...(mensagem ? { mensagem } : {})
    });
    if (Number(produto.utiliza_volume) !== 1
      || !(Number(produto.volume_valor) > 0)
      || !String(produto.volume_unidade || '').trim()) {
      invalidar('VOLUME_COMERCIAL_NAO_CONFIGURADO');
      continue;
    }

    let cotador;
    let volume;
    try {
      cotador = await criarCotadorPreco({
        db,
        empresaId,
        produtoId,
        tipoVenda: TIPO_VENDA.PESO,
        agora
      });
      const unidade = cotador.cotar(1);
      if (!Number.isSafeInteger(unidade.subtotalCentavos) || unidade.subtotalCentavos <= 0) {
        invalidar('PRECO_CATALOGO_INVALIDO');
        continue;
      }
      volume = await ComposicaoInterna.converterVolumeParaMl(db, produto);
    } catch (err) {
      if (err instanceof CotacaoPrecoErro) {
        invalidar(err.codigo, err.message);
        continue;
      }
      if (err && err.code) {
        invalidar(err.code, err.message);
        continue;
      }
      throw err;
    }

    const volumeMlPorUnidade = Number(volume.quantidadeMl);
    if (!Number.isSafeInteger(volumeMlPorUnidade) || volumeMlPorUnidade <= 0) {
      invalidar('VOLUME_ML_INVALIDO');
      continue;
    }
    if (!VOLUMES_REFRIGERANTE_ELEGIVEIS_ML.has(volumeMlPorUnidade)) {
      invalidar('VOLUME_FORA_DA_REGRA', `Volume convertido ${volumeMlPorUnidade} ml não é elegível.`);
      continue;
    }

    const calc = creditarDisponibilidadeComReservaPedido(
      calcularEstoqueProduto(produto),
      creditoPedido.por_produto[produtoId] || 0
    );
    const quantidadeMaxima = produtoControlaEstoque(produto)
      ? Math.floor(Math.max(0, Number(calc.disponivel_total || 0)) + 1e-9)
      : Number.MAX_SAFE_INTEGER;

    modelos.push({
      produtoId,
      nome: produto.nome,
      categoriaFiscal: 'REFRIGERANTE',
      cotador,
      cotacaoDependenciasFingerprint: cotador.dependenciasFingerprint,
      precoUnitarioMaximoCentavos: Math.ceil(cotador.precoUnitarioMaximoInterno * 100),
      volumeMlPorUnidade,
      volumeConfiguracao: volume.configuracao,
      quantidadeMaxima,
      produtoUpdatedAt: produto.updated_at || null,
      disponibilidade: {
        disponivel: Number(calc.disponivel_total || 0),
        quantidadeMaxima
      }
    });
  }

  const maiorPrecoCentavos = modelos.reduce(
    (maior, modelo) => Math.max(maior, modelo.precoUnitarioMaximoCentavos),
    0
  );
  const limiteBuscaCentavos = residualCentavos + maiorPrecoCentavos;
  if (!Number.isSafeInteger(limiteBuscaCentavos)) {
    throw erro('LIMITE_COMPOSICAO_INVALIDO', 'O limite monetário da busca não é seguro em centavos.');
  }
  const capacidadeMl = modelos.reduce((total, modelo) => {
    const porValor = ComposicaoInterna.quantidadeMaximaPorValor(
      modelo,
      limiteBuscaCentavos
    );
    const maximoPorValor = porValor > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(porValor);
    const quantidadeLimitada = Math.min(modelo.quantidadeMaxima, maximoPorValor);
    const capacidade = quantidadeLimitada * modelo.volumeMlPorUnidade;
    if (!Number.isSafeInteger(capacidade) || !Number.isSafeInteger(total + capacidade)) {
      throw erro('CAPACIDADE_COMPOSICAO_INVALIDA', 'A capacidade de busca excede o limite seguro.');
    }
    return total + capacidade;
  }, 0);

  return {
    modelos,
    invalidos,
    capacidadeMl,
    produtosPorId: new Map(produtosAtivos.map((produto) => [Number(produto.id), produto]))
  };
}

function produtoComercialAtivoNoPedido(produto) {
  return Boolean(produto)
    && Number(produto.ativo) === 1
    && String(produto.tipo_operacional || '').toUpperCase() !== 'INSUMO'
    && String(produto.categoria_tipo || 'produto').trim().toLowerCase() === 'produto';
}

/**
 * Preço comercial já gravado na linha do pedido.
 * A cotação de cadastro continua só como base do residual da busca;
 * ela não substitui o preço principal na composição fiscal.
 */
function precoComercialPersistido(itensPedido, produtoId, quantidade) {
  const linhas = itensPedido.filter((item) => Number(item.produto_id) === produtoId);
  if (!linhas.length) {
    throw erro(
      'PRECO_PASTEL_INVALIDO',
      'O pastel elegível não possui linha comercial no Pedido.',
      { produto_id: produtoId }
    );
  }
  const subtotalCentavos = linhas.reduce((soma, linha) => {
    const centavos = Math.round(Number(linha.subtotal) * 100);
    if (!Number.isSafeInteger(centavos) || centavos <= 0) {
      throw erro(
        'PRECO_PASTEL_INVALIDO',
        'A linha do pastel não possui subtotal comercial válido.',
        { produto_id: produtoId, subtotal: linha.subtotal }
      );
    }
    return somarCentavos(soma, centavos);
  }, 0);
  const precos = linhas.map((linha) => Number(linha.preco_unitario));
  const precoInformado = precos.every((preco) => preco === precos[0]) ? precos[0] : null;
  if (precoInformado != null && Number.isFinite(precoInformado) && precoInformado > 0
    && Math.round(precoInformado * quantidade * 100) === subtotalCentavos) {
    return { precoUnitario: precoInformado, subtotalCentavos };
  }
  const precoUnitario = subtotalCentavos / quantidade / 100;
  if (Math.round(precoUnitario * quantidade * 100) !== subtotalCentavos) {
    throw erro(
      'PRECO_LINHA_NAO_REPRESENTAVEL',
      'O subtotal comercial do pastel não reproduz um preço unitário em centavos.',
      { produto_id: produtoId, quantidade, subtotal_centavos: subtotalCentavos }
    );
  }
  return { precoUnitario, subtotalCentavos };
}

/**
 * Pedidos sem pastéis elegíveis: envia as linhas comerciais originais ao PDV
 * (refrigerantes e demais produtos independentes), sem composição residual nem
 * inclusão artificial de pastel. A composição pastel→refrigerante permanece
 * obrigatória apenas quando há pelo menos um pastel elegível.
 */
async function prepararPassthroughPedidoPdv({
  empresaId,
  pedidoId,
  pedido,
  itens,
  totalCentavos,
  produtoPorId,
  agora
}) {
  const itensVenda = [];
  for (const item of itens) {
    const produtoId = Number(item.produto_id);
    const produto = produtoPorId.get(produtoId);
    if (!produtoComercialAtivoNoPedido(produto)) continue;

    const quantidade = Number(item.quantidade);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw erro(
        'QUANTIDADE_ITEM_INVALIDA',
        `O item ${produto.nome || produtoId} precisa ter quantidade positiva para gerar a venda.`,
        { produto_id: produtoId, quantidade: item.quantidade }
      );
    }
    const precoUnitario = Number(item.preco_unitario);
    const subtotalCentavos = Math.round(Number(item.subtotal) * 100);
    if (!Number.isFinite(precoUnitario) || precoUnitario <= 0
      || !Number.isSafeInteger(subtotalCentavos) || subtotalCentavos <= 0) {
      throw erro(
        'PRECO_ITEM_INVALIDO',
        `O item ${produto.nome || produtoId} não possui preço/subtotal válido no Pedido.`,
        { produto_id: produtoId }
      );
    }
    itensVenda.push(mapearItemVenda(
      produtoId,
      quantidade,
      precoUnitario,
      subtotalCentavos,
      {
        desconto_percentual: 0,
        desconto_valor: 0,
        desconto_atacado: 0,
        desconto_manual: 0,
        tipo_preco: 'varejo',
        promocao_id: null,
        preco_origem: Number(precoUnitario.toFixed(6))
      }
    ));
  }

  if (!itensVenda.length) {
    throw erro(
      'PEDIDO_SEM_ITENS_ELEGIVEIS',
      'O Pedido não contém produtos comerciais ativos elegíveis para gerar a venda no PDV.'
    );
  }

  itensVenda.sort((a, b) => (
    a.produto_id - b.produto_id || a.tipo_venda.localeCompare(b.tipo_venda)
  ));
  const totalCompostoCentavos = itensVenda.reduce(
    (total, item) => somarCentavos(total, item.subtotal),
    0
  );
  const descontoCentavos = Math.round(Number(pedido.desconto || 0) * 100);
  const totalLiquidoCentavos = totalCompostoCentavos - descontoCentavos;
  if (!Number.isSafeInteger(descontoCentavos) || descontoCentavos < 0
    || !Number.isSafeInteger(totalLiquidoCentavos)
    || totalLiquidoCentavos !== totalCentavos) {
    throw erro(
      'TOTAL_COMPOSICAO_DIVERGENTE',
      'O total dos itens elegíveis, após o desconto do Pedido, não corresponde ao total persistido; a geração foi bloqueada.',
      {
        total_pedido_centavos: totalCentavos,
        total_itens_centavos: totalCompostoCentavos,
        desconto_centavos: descontoCentavos,
        total_liquido_centavos: totalLiquidoCentavos
      }
    );
  }

  const fingerprint = ComposicaoInterna.criarFingerprint({
    empresaId,
    pedidoId,
    pedidoStatus: pedido.status,
    pedidoUpdatedAt: pedido.updated_at || null,
    totalCentavos,
    descontoCentavos,
    itensPedido: itens.map((item) => ({
      id: Number(item.id),
      produtoId: Number(item.produto_id),
      quantidade: Number(item.quantidade),
      subtotalCentavos: Math.round(Number(item.subtotal) * 100)
    })),
    itensVenda,
    modelos: []
  });

  return {
    sucesso: true,
    modo: 'PASSTHROUGH',
    pedidoId,
    empresaId,
    pedidoCodigo: pedido.codigo || null,
    clienteId: pedido.cliente_id || null,
    valorOriginalCentavos: totalCentavos,
    valorPastelCentavos: 0,
    valorResidualCentavos: 0,
    valorCompostoBrutoCentavos: totalCompostoCentavos,
    descontoCentavos,
    desconto: descontoCentavos / 100,
    valorFinalCentavos: totalLiquidoCentavos,
    itens: itensVenda.map((item) => ({
      ...item,
      subtotal: item.subtotal / 100
    })),
    fingerprint,
    dataReferenciaCotacao: agora.toISOString(),
    efeitosOperacionais: false
  };
}

async function prepararComposicaoPedidoPdv(params = {}, opts = {}) {
  const db = opts.db;
  if (!db) throw erro('DB_OBRIGATORIO', 'A composição exige uma conexão de banco explícita.');
  const empresaId = inteiroPositivo(params.empresaId, 'empresaId');
  const pedidoId = inteiroPositivo(params.pedidoId, 'pedidoId');
  const agora = params.dataReferencia != null ? new Date(params.dataReferencia) : new Date();
  if (Number.isNaN(agora.getTime())) throw erro('DATA_REFERENCIA_INVALIDA', 'Data de referência inválida.');

  const { pedido, itens, totalCentavos } = await ComposicaoInterna.carregarPedido(
    empresaId,
    pedidoId,
    db
  );
  const produtosPedido = await carregarCategoriasPedido(itens, db);
  const produtoPorId = new Map(produtosPedido.map((produto) => [Number(produto.id), produto]));
  const quantidadePastelPorProduto = new Map();

  for (const item of itens) {
    const produto = produtoPorId.get(Number(item.produto_id));
    if (!produto
      || String(produto.categoria_nome || '').trim().toUpperCase() !== CATEGORIA_PASTEIS
      || !produtoComercialAtivoNoPedido(produto)) {
      continue;
    }
    const quantidade = Number(item.quantidade);
    if (!Number.isSafeInteger(quantidade) || quantidade <= 0) {
      throw erro(
        'QUANTIDADE_PASTEL_INVALIDA',
        `O item de pastel ${produto.nome} precisa ter quantidade inteira para compor a venda.`,
        { produto_id: produto.id, quantidade: item.quantidade }
      );
    }
    quantidadePastelPorProduto.set(
      Number(produto.id),
      (quantidadePastelPorProduto.get(Number(produto.id)) || 0) + quantidade
    );
  }

  if (!quantidadePastelPorProduto.size) {
    return prepararPassthroughPedidoPdv({
      empresaId,
      pedidoId,
      pedido,
      itens,
      totalCentavos,
      produtoPorId,
      agora
    });
  }

  const itensPastel = [];
  let valorPastelCatalogoCentavos = 0;
  for (const [produtoId, quantidade] of [...quantidadePastelPorProduto.entries()]
    .sort(([idA], [idB]) => idA - idB)) {
    const produto = produtoPorId.get(produtoId);
    let cotador;
    try {
      cotador = await criarCotadorPreco({
        db,
        empresaId,
        produtoId,
        tipoVenda: TIPO_VENDA.PESO,
        agora
      });
    } catch (err) {
      if (err instanceof CotacaoPrecoErro) {
        throw erro(
          'PRECO_PASTEL_INVALIDO',
          `Não foi possível cotar o preço vigente do pastel ${produto.nome}: ${err.message}`,
          { produto_id: produtoId, codigo_cotacao: err.codigo }
        );
      }
      throw err;
    }
    const cotacao = cotador.cotar(quantidade);
    if (!Number.isSafeInteger(cotacao.subtotalCentavos)
      || cotacao.subtotalCentavos <= 0
      || !Number.isFinite(cotacao.precoUnitarioInterno)
      || cotacao.precoUnitarioInterno <= 0) {
      throw erro(
        'PRECO_PASTEL_INVALIDO',
        `O preço vigente do pastel ${produto.nome} não produziu valores válidos em centavos.`,
        { produto_id: produtoId, quantidade }
      );
    }
    valorPastelCatalogoCentavos = somarCentavos(
      valorPastelCatalogoCentavos,
      cotacao.subtotalCentavos
    );
    const comercial = precoComercialPersistido(itens, produtoId, quantidade);
    itensPastel.push(mapearItemVenda(
      produtoId,
      quantidade,
      comercial.precoUnitario,
      comercial.subtotalCentavos,
      {
        desconto_percentual: 0,
        desconto_valor: 0,
        desconto_atacado: 0,
        desconto_manual: 0,
        tipo_preco: 'varejo',
        promocao_id: null,
        preco_origem: Number(Number(comercial.precoUnitario).toFixed(6))
      }
    ));
  }
  const valorPastelCentavos = itensPastel.reduce(
    (total, item) => somarCentavos(total, item.subtotal),
    0
  );
  const residualCentavos = totalCentavos - valorPastelCatalogoCentavos;
  if (residualCentavos < 0) {
    throw erro(
      'RESIDUAL_PASTEL_NEGATIVO',
      'O valor-base dos pastéis excede o total do Pedido; nenhuma composição foi gerada.',
      {
        total_pedido_centavos: totalCentavos,
        total_pastel_comercial_centavos: valorPastelCentavos,
        total_pastel_catalogo_centavos: valorPastelCatalogoCentavos
      }
    );
  }

  const {
    modelos,
    invalidos,
    capacidadeMl,
    produtosPorId: produtosRefrigerantesPorId
  } = await carregarModelosRefrigerante(
    empresaId,
    pedidoId,
    residualCentavos,
    db,
    agora
  );
  if (residualCentavos > 0 && modelos.length === 0) {
    throw erro(
      'REFRIGERANTES_INSUFICIENTES',
      'Não há refrigerantes ativos, com preço e volume MUC válidos e disponibilidade suficiente para compor o valor restante.',
      { modelos_invalidos: invalidos }
    );
  }

  let busca = {
    totalCentavos: 0,
    quantidades: modelos.map(() => 0),
    encontrouExato: true,
    otimalidadeComprovada: true,
    estadosVisitados: 0
  };
  if (residualCentavos > 0) {
    busca = ComposicaoInterna.buscarComposicao(
      modelos,
      { REFRIGERANTE: capacidadeMl },
      residualCentavos
    );
    if (!busca.otimalidadeComprovada) {
      throw erro(
        'COMPOSICAO_PDV_INCONCLUSIVA',
        'A busca não conseguiu provar se existe combinação exata; a geração foi bloqueada.',
        { estados_visitados: busca.estadosVisitados, objetivo: 'EXATO' }
      );
    }
    if (!busca.encontrouExato || busca.totalCentavos !== residualCentavos) {
      const limiteBuscaCentavos = residualCentavos
        + modelos.reduce((maior, modelo) => Math.max(maior, modelo.precoUnitarioMaximoCentavos), 0);
      if (!Number.isSafeInteger(limiteBuscaCentavos)) {
        throw erro('LIMITE_COMPOSICAO_INVALIDO', 'O limite monetário da busca não é seguro em centavos.');
      }
      const buscaAcima = ComposicaoInterna.buscarComposicao(
        modelos,
        { REFRIGERANTE: capacidadeMl },
        limiteBuscaCentavos,
        residualCentavos + 1,
        undefined,
        { objetivo: 'MINIMO' }
      );
      if (!buscaAcima.otimalidadeComprovada) {
        throw erro(
          'COMPOSICAO_PDV_INCONCLUSIVA',
          'A busca não conseguiu provar a menor composição acima do valor restante; a geração foi bloqueada.',
          { estados_visitados: buscaAcima.estadosVisitados, objetivo: 'MINIMO_ACIMA' }
        );
      }
      if (buscaAcima.totalCentavos < 0) {
        throw erro(
          'COMPOSICAO_PDV_SEM_COBERTURA',
          `Não existe combinação válida de refrigerantes acima do valor restante de R$ ${(residualCentavos / 100).toFixed(2)} com os preços e a disponibilidade atuais.`,
          {
            residual_centavos: residualCentavos,
            melhor_valor_abaixo_centavos: busca.totalCentavos >= 0 ? busca.totalCentavos : null,
            composicao_abaixo: busca.totalCentavos >= 0
              ? ComposicaoInterna.comporItens(modelos, busca.quantidades)
              : [],
            modelos_invalidos: invalidos
          }
        );
      }
      busca = buscaAcima;
    }
  }

  const bebidas = ComposicaoInterna.comporItens(modelos, busca.quantidades).map((item) => {
    const produto = produtosRefrigerantesPorId.get(Number(item.produtoId));
    if (!produto) {
      throw erro(
        'PRODUTO_COMPOSICAO_AUSENTE',
        `O produto ${item.produtoId} selecionado para a composição não está disponível no catálogo carregado.`
      );
    }
    const metadados = metadadosDaCotacao(produto, item.quantidade, {
      subtotalCentavos: item.subtotalCentavos,
      precoUnitarioInterno: item.precoUnitario,
      regrasAplicadas: item.regrasAplicadas
    });
    return mapearItemVenda(
      item.produtoId,
      item.quantidade,
      item.precoUnitario,
      item.subtotalCentavos,
      metadados
    );
  });
  const itensVenda = [...itensPastel, ...bebidas].sort((a, b) => (
    a.produto_id - b.produto_id || a.tipo_venda.localeCompare(b.tipo_venda)
  ));
  const totalCompostoCentavos = itensVenda.reduce(
    (total, item) => somarCentavos(total, item.subtotal),
    0
  );
  const descontoCentavos = totalCompostoCentavos - totalCentavos;
  const totalLiquidoCentavos = totalCompostoCentavos - descontoCentavos;
  if (!Number.isSafeInteger(descontoCentavos) || descontoCentavos < 0
    || !Number.isSafeInteger(totalLiquidoCentavos)
    || totalLiquidoCentavos !== totalCentavos) {
    throw erro(
      'TOTAL_COMPOSICAO_DIVERGENTE',
      'O total bruto da composição, após o desconto global explícito, não corresponde ao total do Pedido; a geração foi bloqueada.',
      {
        total_pedido_centavos: totalCentavos,
        total_composicao_bruto_centavos: totalCompostoCentavos,
        desconto_centavos: descontoCentavos,
        total_composicao_liquido_centavos: totalLiquidoCentavos
      }
    );
  }

  const fingerprint = ComposicaoInterna.criarFingerprint({
    empresaId,
    pedidoId,
    pedidoStatus: pedido.status,
    pedidoUpdatedAt: pedido.updated_at || null,
    totalCentavos,
    descontoCentavos,
    itensPedido: itens.map((item) => ({
      id: Number(item.id),
      produtoId: Number(item.produto_id),
      quantidade: Number(item.quantidade),
      subtotalCentavos: Math.round(Number(item.subtotal) * 100)
    })),
    itensVenda,
    modelos: modelos.map((modelo) => ({
      produtoId: modelo.produtoId,
      cotacaoFingerprint: modelo.cotacaoDependenciasFingerprint,
      volumeMlPorUnidade: modelo.volumeMlPorUnidade,
      quantidadeMaxima: modelo.quantidadeMaxima,
      produtoUpdatedAt: modelo.produtoUpdatedAt,
      volumeConfiguracao: modelo.volumeConfiguracao
    }))
  });

  const resultado = {
    sucesso: true,
    modo: 'COMPOSICAO_PASTEL_REFRIGERANTE',
    pedidoId,
    empresaId,
    pedidoCodigo: pedido.codigo || null,
    clienteId: pedido.cliente_id || null,
    valorOriginalCentavos: totalCentavos,
    valorPastelCentavos,
    valorResidualCentavos: residualCentavos,
    valorCompostoBrutoCentavos: totalCompostoCentavos,
    descontoCentavos,
    desconto: descontoCentavos / 100,
    valorFinalCentavos: totalLiquidoCentavos,
    itens: itensVenda.map((item) => ({
      ...item,
      subtotal: item.subtotal / 100
    })),
    fingerprint,
    dataReferenciaCotacao: agora.toISOString(),
    efeitosOperacionais: false
  };
  // Só a Venda por Valor troca a massa comercial pelo cadastro fiscal.
  // Pedido sem essa origem mantém o preço comercial da linha.
  if (String(pedido.observacao || '') !== 'VENDA_POR_VALOR_PASTEIS') return resultado;
  const produtoPastelId = itensPastel.length === 1 ? itensPastel[0].produto_id : null;
  const { distribuirValorFiscalVendaPorValor } = require('./VendaPorValorPasteisService');
  return distribuirValorFiscalVendaPorValor(resultado, produtoPastelId);
}

/**
 * Sprint 13/14 — contexto de composição para diagnóstico no fechamento.
 * Reutiliza exclusivamente `carregarModelosRefrigerante` (mesma fonte do PDV).
 * Somente leitura. Não inventa produtos, catálogo ou capacidade.
 *
 * Sprint 14: `pedidoId` é opcional. Em venda de balcão, a reserva de pedido
 * fica vazia (`obterCreditoReservaPedido` já trata id inválido) e os modelos
 * continuam vindo do catálogo/estoque/cotação isolados por `empresaId`.
 *
 * @param {object} opcoes
 * @param {number} opcoes.empresaId
 * @param {number} [opcoes.pedidoId] — opcional (balcão)
 * @param {number} opcoes.residualCentavos — teto monetário da busca (centavos)
 * @param {object} opcoes.db
 * @param {Date} [opcoes.agora]
 * @returns {Promise<object>}
 */
async function obterContextoComposicaoPdvParaDiagnostico(opcoes = {}) {
  const origem = 'PedidoPdvComposicaoService.carregarModelosRefrigerante';
  const empresaId = Number(opcoes.empresaId);
  const pedidoBruto = opcoes.pedidoId != null && opcoes.pedidoId !== ''
    ? Number(opcoes.pedidoId)
    : null;
  const pedidoId = Number.isInteger(pedidoBruto) && pedidoBruto > 0 ? pedidoBruto : null;
  const modo = pedidoId != null ? 'pedido' : 'balcao';
  const residualCentavos = Number(opcoes.residualCentavos);
  const db = opcoes.db;
  const agora = opcoes.agora instanceof Date ? opcoes.agora : new Date();

  const baseInsuficiente = (motivo) => Object.freeze({
    suficiente: false,
    motivo,
    origem,
    modo,
    empresa_id: Number.isInteger(empresaId) && empresaId > 0 ? empresaId : null,
    pedido_id: pedidoId,
    modelos: Object.freeze([]),
    capacidade_por_categoria: Object.freeze({}),
    invalidos: Object.freeze([])
  });

  if (!db) {
    return baseInsuficiente('db_ausente');
  }
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    return baseInsuficiente('empresa_id_ausente');
  }
  if (!Number.isSafeInteger(residualCentavos) || residualCentavos <= 0) {
    return baseInsuficiente('residual_centavos_ausente');
  }

  let carregado;
  try {
    // pedidoId null = balcão: crédito de reserva = 0 (mecanismo existente).
    carregado = await carregarModelosRefrigerante(
      empresaId,
      pedidoId,
      residualCentavos,
      db,
      agora
    );
  } catch (err) {
    return Object.freeze({
      suficiente: false,
      motivo: 'erro_carga_modelos_refrigerante',
      origem,
      modo,
      empresa_id: empresaId,
      pedido_id: pedidoId,
      modelos: Object.freeze([]),
      capacidade_por_categoria: Object.freeze({}),
      invalidos: Object.freeze([]),
      erro_carga: err && (err.code || err.codigo)
        ? (err.code || err.codigo)
        : (err && err.message ? String(err.message).slice(0, 120) : 'ERRO')
    });
  }

  const modelos = Array.isArray(carregado.modelos) ? carregado.modelos : [];
  if (!modelos.length) {
    return Object.freeze({
      suficiente: false,
      motivo: 'modelos_vazios_apos_carga',
      origem,
      modo,
      empresa_id: empresaId,
      pedido_id: pedidoId,
      modelos: Object.freeze([]),
      capacidade_por_categoria: Object.freeze({}),
      invalidos: Object.freeze(
        Array.isArray(carregado.invalidos) ? carregado.invalidos.map((i) => ({ ...i })) : []
      ),
      capacidadeMl: Number(carregado.capacidadeMl) || 0
    });
  }

  return Object.freeze({
    suficiente: true,
    motivo: null,
    origem,
    modo,
    empresa_id: empresaId,
    pedido_id: pedidoId,
    modelos,
    capacidade_por_categoria: Object.freeze({
      REFRIGERANTE: Number(carregado.capacidadeMl) || 0
    }),
    capacidadeMl: Number(carregado.capacidadeMl) || 0,
    invalidos: Object.freeze(
      Array.isArray(carregado.invalidos) ? carregado.invalidos.map((i) => ({ ...i })) : []
    )
  });
}

module.exports = {
  prepararComposicaoPedidoPdv,
  obterContextoComposicaoPdvParaDiagnostico
};
