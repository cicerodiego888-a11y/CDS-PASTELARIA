'use strict';

const crypto = require('crypto');
const { converterQuantidade } = require('../../motores/muc/core/MotorConversaoQuantidade');
const { normalizarUnidade } = require('../../motores/muc/core/unidadesSi');
const { OBJETOS_OBRIGATORIOS: OBJETOS_RESERVA } = require('./reservaSaldoFiscalCategoriaSchema');
const { criarCotadorPreco, CotacaoPrecoErro, TIPO_VENDA } = require('./CotacaoPrecoProdutoService');

const CATEGORIAS = Object.freeze(['REFRIGERANTE', 'AGUA']);
const STATUS_ELEGIVEIS = new Set(['PEDIDO', 'EM_SEPARACAO']);
const ESTADOS_RESERVA_SCHEMA = Object.freeze(OBJETOS_RESERVA);
const LIMITE_ESTADOS_BUSCA = 250000;
// Acima disso o limite superior de poda por modelo não é calculado (usa-se o residual, que é seguro).
const LIMITE_QUANTIDADES_PARA_PODA = 20000;
const CENTAVOS_POR_REAL = 100;
const VERSAO_ALGORITMO_BUSCA = 'fiscal-composition-v3-cotacao';
// Modo de venda explícito da cotação: o modo regular do carrinho (preco_venda; promoção e atacado por quantidade).
const MODO_VENDA_COMPOSICAO = TIPO_VENDA.PESO;
const CRITERIO_DESEMPATE = 'quantidade lexicograficamente maior por produto_id ascendente e categoria ascendente';

function erro(code, message, detalhes) {
  const err = new Error(message);
  err.code = code;
  err.detalhes = detalhes || null;
  return err;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function inteiroPositivo(valor, code, campo) {
  if (typeof valor === 'boolean' || valor == null || valor === '') {
    throw erro(code, `${campo} deve ser um inteiro positivo.`);
  }
  const n = Number(valor);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw erro(code, `${campo} deve ser um inteiro positivo.`);
  }
  return n;
}

function dinheiroEmCentavos(valor, code, campo) {
  if (typeof valor === 'boolean' || valor == null || valor === '') {
    throw erro(code, `${campo} deve ser um valor monetário finito e não negativo.`);
  }
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER / CENTAVOS_POR_REAL) {
    throw erro(code, `${campo} deve ser um valor monetário finito e não negativo.`);
  }
  return Math.round((n + Number.EPSILON) * CENTAVOS_POR_REAL);
}

function dinheiroEmMicros(valor, code, campo) {
  if (typeof valor === 'boolean' || valor == null || valor === '') {
    throw erro(code, `${campo} deve ser um valor monetário finito e não negativo.`);
  }
  const n = Number(valor);
  const micros = Math.round((n + Number.EPSILON) * 1000000);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(micros)) {
    throw erro(code, `${campo} excede a precisão monetária suportada.`);
  }
  return micros;
}

function mapearErroCotacao(err, codigoPreco) {
  if (!(err instanceof CotacaoPrecoErro)) return err;
  if (err.codigo === 'PRECO_BASE_INVALIDO') return erro(codigoPreco, err.message);
  return err;
}

function subtotalCotado(modelo, quantidade) {
  if (quantidade === 0) return 0;
  const centavos = modelo.cotador.cotar(quantidade).subtotalCentavos;
  if (!Number.isSafeInteger(centavos) || centavos < 0) {
    throw erro('PRECO_CATALOGO_INVALIDO', 'O subtotal cotado excede o limite monetário seguro.');
  }
  return centavos;
}

// Limite superior seguro: usa o menor preço unitário que qualquer faixa/promoção poderia aplicar.
function quantidadeMaximaPorValor(modelo, restanteCentavos) {
  if (restanteCentavos <= 0) return 0n;
  const limiteMicros = BigInt(restanteCentavos) * 10000n + 4999n;
  const minimoMicros = BigInt(Math.max(1, Math.round(modelo.cotador.precoUnitarioMinimoInterno * 1000000)));
  return limiteMicros / minimoMicros;
}

async function exigirSchemaLeitura(db) {
  const obrigatorias = [
    'empresas',
    'pedidos',
    'pedidos_itens',
    'produtos',
    'produto_categoria_fiscal_empresa',
    'saldo_fiscal_categoria_empresa',
    'muc_produto_relacoes'
  ];
  const nomes = [...new Set([...obrigatorias, ...ESTADOS_RESERVA_SCHEMA])];
  const encontrados = await dbAll(
    db,
    `SELECT name FROM sqlite_master WHERE name IN (${nomes.map(() => '?').join(',')})`,
    nomes
  );
  const presentes = new Set(encontrados.map((row) => row.name));
  const ausentes = obrigatorias.filter((nome) => !presentes.has(nome));
  if (ausentes.length) {
    throw erro(
      'SCHEMA_COMPOSICAO_AUSENTE',
      'A simulação exige schemas já preparados e não cria tabelas nem executa migrações.',
      { objetos_ausentes: ausentes }
    );
  }

  const existentesReserva = ESTADOS_RESERVA_SCHEMA.filter((nome) => presentes.has(nome));
  if (existentesReserva.length && existentesReserva.length !== ESTADOS_RESERVA_SCHEMA.length) {
    throw erro(
      'SCHEMA_RESERVA_INCOMPLETO',
      'O schema de reservas fiscais está incompleto; a disponibilidade não pode ser validada com segurança.',
      { objetos_presentes: existentesReserva }
    );
  }

  const colunas = await dbAll(db, 'PRAGMA table_info(produtos)');
  const nomesColunas = new Set(colunas.map((coluna) => String(coluna.name).toLowerCase()));
  const colunasObrigatorias = [
    'ativo', 'tipo_operacional', 'preco_venda', 'utiliza_volume',
    'volume_valor', 'volume_unidade', 'unidade', 'utiliza_conversao', 'unidade_estoque'
  ];
  const faltantes = colunasObrigatorias.filter((coluna) => !nomesColunas.has(coluna));
  if (faltantes.length) {
    throw erro(
      'SCHEMA_COMPOSICAO_AUSENTE',
      'O catálogo não possui os campos necessários para validar preço e volume fiscal.',
      { colunas_ausentes: faltantes }
    );
  }
  return { reservasDisponiveis: existentesReserva.length === ESTADOS_RESERVA_SCHEMA.length };
}

function validarCategorias(categorias) {
  const solicitadas = categorias == null ? [...CATEGORIAS] : categorias;
  if (!Array.isArray(solicitadas) || solicitadas.length === 0) {
    throw erro('CATEGORIAS_INVALIDAS', 'Informe ao menos uma categoria fiscal elegível.');
  }
  const normalizadas = [...new Set(solicitadas.map((categoria) => String(categoria || '').trim().toUpperCase()))];
  const invalidas = normalizadas.filter((categoria) => !CATEGORIAS.includes(categoria));
  if (invalidas.length) {
    throw erro('CATEGORIAS_INVALIDAS', 'Categorias aceitas: REFRIGERANTE e AGUA.', { invalidas });
  }
  return normalizadas.sort();
}

function compararLexicografico(a, b) {
  return Number(a) - Number(b);
}

async function carregarPedido(empresaId, pedidoId, db) {
  const pedido = await dbGet(db, 'SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
  if (!pedido) throw erro('PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado.');
  if (pedido.empresa_id == null || Number(pedido.empresa_id) !== empresaId) {
    throw erro('PEDIDO_EMPRESA_DIVERGENTE', 'Pedido inexistente para a empresa informada.');
  }
  if (!STATUS_ELEGIVEIS.has(String(pedido.status || '').toUpperCase())) {
    throw erro('PEDIDO_STATUS_NAO_ELEGIVEL', `Pedido no estado ${pedido.status} não pode ser simulado pelo motor.`);
  }

  const freteCentavos = dinheiroEmCentavos(pedido.frete || 0, 'PEDIDO_INVALIDO', 'frete');
  if (freteCentavos !== 0) {
    throw erro(
      'PEDIDO_COM_FRETE_NAO_SUPORTADO',
      'A simulação da Sprint 2 não inclui frete; nenhum valor de entrega será composto.'
    );
  }

  const totalCentavos = dinheiroEmCentavos(pedido.total, 'PEDIDO_INVALIDO', 'total');
  const descontoCentavos = dinheiroEmCentavos(pedido.desconto || 0, 'PEDIDO_INVALIDO', 'desconto');
  const itens = await dbAll(
    db,
    'SELECT * FROM pedidos_itens WHERE pedido_id = ? ORDER BY id ASC',
    [pedidoId]
  );
  const somaItensCentavos = itens.reduce((soma, item) => {
    const subtotalCentavos = dinheiroEmCentavos(item.subtotal, 'PEDIDO_INVALIDO', 'subtotal do item');
    const somaAtualizada = soma + subtotalCentavos;
    if (!Number.isSafeInteger(somaAtualizada)) {
      throw erro('PEDIDO_INVALIDO', 'A soma dos itens excede o limite monetário seguro.');
    }
    return somaAtualizada;
  }, 0);
  if (somaItensCentavos - descontoCentavos !== totalCentavos || totalCentavos <= 0) {
    throw erro(
      'PEDIDO_TOTAL_INCONSISTENTE',
      'O total persistido do Pedido não corresponde aos itens, desconto e frete suportados.',
      {
        total_centavos: totalCentavos,
        itens_centavos: somaItensCentavos,
        desconto_centavos: descontoCentavos,
        frete_centavos: freteCentavos
      }
    );
  }
  return { pedido, itens, totalCentavos, descontoCentavos };
}

async function converterVolumeParaMl(db, produto) {
  const unidade = normalizarUnidade(produto.volume_unidade);
  const quantidade = Number(produto.volume_valor);
  const utilizaConversao = Number(produto.utiliza_conversao) === 1;
  let relacoes = [];
  if (utilizaConversao) {
    relacoes = await dbAll(
      db,
      `SELECT unidade_origem, unidade_destino, fator
         FROM muc_produto_relacoes
        WHERE produto_id = ?
        ORDER BY id ASC`,
      [Number(produto.id)]
    );
  } else if (unidade !== 'ML') {
    throw erro(
      'CONVERSAO_NAO_DISPONIVEL',
      `O produto não utiliza conversão: não há relação cadastrada para converter ${unidade} em ML.`
    );
  }

  const relacoesMuc = utilizaConversao
    ? relacoes.map((relacao) => ({
      de: relacao.unidade_origem,
      para: relacao.unidade_destino,
      fator: Number(relacao.fator)
    }))
    : [];
  const converter = (regras) => converterQuantidade({
    quantidade,
    unidadeOrigem: unidade,
    unidadeDestino: 'ML',
    relacoes: regras
  });
  const resultado = converter(relacoesMuc);

  if (utilizaConversao) {
    for (const etapa of resultado.caminho) {
      if (etapa.origem === 'SI') continue;
      const restantes = relacoesMuc.filter((relacao) => !(
        (relacao.de === etapa.de && relacao.para === etapa.para)
        || (relacao.de === etapa.para && relacao.para === etapa.de)
      ));
      let alternativa = null;
      try {
        alternativa = converter(restantes);
      } catch (err) {
        if (err.code !== 'CONVERSAO_NAO_DISPONIVEL'
          && err.code !== 'CONVERSAO_INVALIDA'
          && err.code !== 'CONVERSAO_CICLO') {
          throw err;
        }
      }
      if (alternativa) {
        const diferenca = Math.abs(alternativa.quantidade - resultado.quantidade);
        if (diferenca > 1e-6 * Math.max(1, Math.abs(resultado.quantidade))) {
          throw erro(
            'CONVERSAO_AMBIGUA',
            `Existem caminhos de conversão distintos de ${unidade} para ML com resultados diferentes.`
          );
        }
      }
    }
  }

  if (!Number.isInteger(resultado.quantidade)) {
    throw erro(
      'CONVERSAO_FRACIONARIA',
      `A conversão resulta em ${resultado.quantidade} ml, incompatível com saldo em ml inteiro.`,
      { quantidade_convertida: resultado.quantidade }
    );
  }
  return {
    quantidadeMl: resultado.quantidade,
    configuracao: {
      utilizaConversao,
      volumeValor: quantidade,
      volumeUnidade: produto.volume_unidade,
      unidadeComercial: produto.unidade,
      unidadeEstoque: produto.unidade_estoque || null,
      relacoes: relacoesMuc
    }
  };
}

async function cotarItemFixo(db, ctxCotacao, produtoId, quantidade) {
  try {
    const cotador = await criarCotadorPreco({
      db,
      empresaId: ctxCotacao.empresaId,
      produtoId,
      tipoVenda: ctxCotacao.tipoVenda,
      agora: ctxCotacao.agora
    });
    const cotacao = cotador.cotar(quantidade);
    if (!Number.isSafeInteger(cotacao.subtotalCentavos) || cotacao.precoUnitarioInterno <= 0
      || Math.round(cotacao.precoUnitarioInterno * 100) <= 0) {
      throw erro('PRECO_CATALOGO_INVALIDO', 'Preço do item fiscal fixo deve ser maior que zero.', {
        produto_id: produtoId
      });
    }
    return cotacao;
  } catch (err) {
    if (err instanceof CotacaoPrecoErro && err.codigo === 'QUANTIDADE_INVALIDA') {
      throw erro('ITENS_FIXOS_INVALIDOS', err.message);
    }
    throw mapearErroCotacao(err, 'PRECO_CATALOGO_INVALIDO');
  }
}

async function carregarItensFixos(entradas, itensPedido, db, ctxCotacao) {
  if (!Array.isArray(entradas)) {
    throw erro('ITENS_FIXOS_INVALIDOS', 'itensFixos deve ser uma lista de referências e quantidades.');
  }
  const quantidadePorProdutoPedido = new Map();
  for (const item of itensPedido) {
    const produtoId = Number(item.produto_id);
    quantidadePorProdutoPedido.set(
      produtoId,
      (quantidadePorProdutoPedido.get(produtoId) || 0) + Number(item.quantidade || 0)
    );
  }

  const quantidades = new Map();
  for (const entrada of entradas) {
    const produtoId = inteiroPositivo(entrada?.produtoId, 'ITENS_FIXOS_INVALIDOS', 'produtoId');
    const quantidade = Number(entrada?.quantidade);
    if (!Number.isSafeInteger(quantidade) || quantidade <= 0) {
      throw erro('ITENS_FIXOS_INVALIDOS', 'A quantidade dos itens fiscais fixos deve ser um inteiro positivo.');
    }
    quantidades.set(produtoId, (quantidades.get(produtoId) || 0) + quantidade);
  }

  for (const [produtoId, quantidade] of quantidades) {
    if (!quantidadePorProdutoPedido.has(produtoId)
      || quantidade > quantidadePorProdutoPedido.get(produtoId)) {
      throw erro(
        'ITEM_FIXO_FORA_PEDIDO',
        'Itens fiscais fixos devem referenciar produtos e quantidades existentes no Pedido.',
        { produto_id: produtoId, quantidade_solicitada: quantidade }
      );
    }
  }

  const ids = [...quantidades.keys()].sort(compararLexicografico);
  if (!ids.length) return [];
  const produtos = await dbAll(
    db,
    `SELECT id, nome, ativo, COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional,
            updated_at
       FROM produtos
      WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const porId = new Map(produtos.map((produto) => [Number(produto.id), produto]));
  const itensFixos = [];
  for (const produtoId of ids) {
    const produto = porId.get(produtoId);
    if (!produto || Number(produto.ativo) !== 1
      || String(produto.tipo_operacional || '').toUpperCase() === 'INSUMO') {
      throw erro(
        'ITEM_FIXO_INVALIDO',
        'Item fiscal fixo inexistente, inativo ou classificado como insumo.',
        { produto_id: produtoId }
      );
    }
    const quantidade = quantidades.get(produtoId);
    const cotacao = await cotarItemFixo(db, ctxCotacao, produtoId, quantidade);
    itensFixos.push({
      produtoId,
      nome: produto.nome,
      quantidade,
      precoUnitario: cotacao.precoUnitarioInterno,
      precoUnitarioMicros: Math.round(cotacao.precoUnitarioInterno * 1000000),
      precoUnitarioCentavos: Math.round(cotacao.precoUnitarioInterno * 100),
      subtotalCentavos: cotacao.subtotalCentavos,
      regrasAplicadas: cotacao.regrasAplicadas,
      cotacaoFingerprint: cotacao.fingerprint,
      fontePreco: 'CotacaoPrecoProdutoService',
      produtoUpdatedAt: produto.updated_at || null,
      nomeProduto: produto.nome,
      ativoProduto: Number(produto.ativo),
      classificacaoProduto: String(produto.tipo_operacional || '').toUpperCase()
    });
  }
  return itensFixos;
}

async function carregarModelos(empresaId, categorias, db, ctxCotacao) {
  const vinculos = await dbAll(
    db,
    `SELECT v.produto_id, v.categoria_fiscal, p.nome, p.ativo,
            COALESCE(p.tipo_operacional, 'COMERCIAL') AS tipo_operacional,
            p.utiliza_volume, p.volume_valor, p.volume_unidade,
            p.unidade, p.utiliza_conversao, p.unidade_estoque, p.updated_at
       FROM produto_categoria_fiscal_empresa v
       JOIN produtos p ON p.id = v.produto_id
      WHERE v.empresa_id = ?
        AND v.categoria_fiscal IN (${categorias.map(() => '?').join(',')})
        AND v.elegivel_composicao = 1
        AND COALESCE(p.tipo_operacional, 'COMERCIAL') <> 'INSUMO'
      ORDER BY v.produto_id, v.categoria_fiscal`,
    [empresaId, ...categorias]
  );
  const modelos = [];
  const invalidos = [];

  for (const vinculo of vinculos) {
    const produtoId = Number(vinculo.produto_id);
    const categoria = vinculo.categoria_fiscal;
    const invalidar = (motivo) => invalidos.push({
      produto_id: produtoId,
      categoria_fiscal: categoria,
      motivo
    });
    if (Number(vinculo.ativo) !== 1
      || String(vinculo.tipo_operacional || '').toUpperCase() === 'INSUMO') {
      invalidar('PRODUTO_INEXISTENTE_INATIVO_OU_INSUMO');
      continue;
    }
    let cotador;
    let cotacaoUnitaria;
    try {
      cotador = await criarCotadorPreco({
        db,
        empresaId: ctxCotacao.empresaId,
        produtoId,
        tipoVenda: ctxCotacao.tipoVenda,
        agora: ctxCotacao.agora
      });
      cotacaoUnitaria = cotador.cotar(1);
    } catch (err) {
      if (err instanceof CotacaoPrecoErro && err.codigo === 'PRECO_BASE_INVALIDO') {
        invalidar('PRECO_CATALOGO_INVALIDO');
        continue;
      }
      throw err;
    }
    if (Math.round(cotacaoUnitaria.precoUnitarioInterno * 100) <= 0
      || !Number.isSafeInteger(cotacaoUnitaria.subtotalCentavos)) {
      invalidar('PRECO_CATALOGO_INVALIDO');
      continue;
    }
    if (Number(vinculo.utiliza_volume) !== 1
      || !(Number(vinculo.volume_valor) > 0)
      || !String(vinculo.volume_unidade || '').trim()) {
      invalidar('VOLUME_COMERCIAL_NAO_CONFIGURADO');
      continue;
    }

    let conversaoVolume;
    try {
      conversaoVolume = await converterVolumeParaMl(db, {
        id: produtoId,
        utiliza_conversao: vinculo.utiliza_conversao,
        volume_valor: vinculo.volume_valor,
        volume_unidade: vinculo.volume_unidade,
        unidade: vinculo.unidade,
        unidade_estoque: vinculo.unidade_estoque
      });
    } catch (err) {
      invalidar(err.code || 'CONVERSAO_MUC_INVALIDA');
      continue;
    }
    const volumeMl = Number(conversaoVolume.quantidadeMl);
    if (!Number.isSafeInteger(volumeMl) || volumeMl <= 0) {
      invalidar('VOLUME_ML_INVALIDO');
      continue;
    }
    const modelo = {
      produtoId,
      nome: vinculo.nome,
      categoriaFiscal: categoria,
      precoUnitarioReferencia: cotacaoUnitaria.precoUnitarioInterno,
      cotacaoDependenciasFingerprint: cotador.dependenciasFingerprint,
      volumeMlPorUnidade: volumeMl,
      volumeFonte: 'produtos.volume_valor/volume_unidade + MUC',
      volumeConfiguracao: conversaoVolume.configuracao,
      produtoUpdatedAt: vinculo.updated_at || null
    };
    // Não enumerável: o cotador fica fora do fingerprint e das saídas.
    Object.defineProperty(modelo, 'cotador', { value: cotador, enumerable: false });
    modelos.push(modelo);
  }
  return { modelos, invalidos };
}

async function obterReservaDoPedido(empresaId, pedidoId, categoria, db, reservasDisponiveis) {
  if (!reservasDisponiveis) return null;
  return dbGet(
    db,
    `SELECT quantidade_reservada_ml, status
       FROM saldo_fiscal_categoria_reservas
      WHERE empresa_id = ? AND pedido_id = ? AND categoria_fiscal = ?
      ORDER BY (status = 'ATIVA') DESC, id DESC
      LIMIT 1`,
    [empresaId, pedidoId, categoria]
  );
}

async function carregarOrcamentosCategoria(empresaId, pedidoId, categorias, db, reservasDisponiveis) {
  const orcamentos = {};
  for (const categoria of categorias) {
    const saldo = await dbGet(
      db,
      `SELECT saldo_atual_ml, saldo_reservado_ml, ativo
         FROM saldo_fiscal_categoria_empresa
        WHERE empresa_id = ? AND categoria_fiscal = ?`,
      [empresaId, categoria]
    );
    if (!saldo || !saldo.ativo) {
      orcamentos[categoria] = {
        saldoAtualMl: saldo ? Number(saldo.saldo_atual_ml) : 0,
        saldoReservadoMl: saldo ? Number(saldo.saldo_reservado_ml) : 0,
        saldoDisponivelMl: 0,
        reservaDoPedidoMl: 0,
        capacidadeMl: 0
      };
      continue;
    }
    const saldoAtualMl = Number(saldo.saldo_atual_ml);
    const saldoReservadoMl = Number(saldo.saldo_reservado_ml);
    const saldoDisponivelMl = saldoAtualMl - saldoReservadoMl;
    if (!Number.isSafeInteger(saldoAtualMl) || saldoAtualMl < 0
      || !Number.isSafeInteger(saldoReservadoMl) || saldoReservadoMl < 0
      || saldoReservadoMl > saldoAtualMl) {
      throw erro('SALDO_FISCAL_INVALIDO', 'Saldo fiscal persistido inválido.', {
        categoria_fiscal: categoria
      });
    }
    if (reservasDisponiveis) {
      const somaReservas = await dbGet(
        db,
        `SELECT COALESCE(SUM(quantidade_reservada_ml), 0) AS total
           FROM saldo_fiscal_categoria_reservas
          WHERE empresa_id = ? AND categoria_fiscal = ? AND status = 'ATIVA'`,
        [empresaId, categoria]
      );
      if (!somaReservas || Number(somaReservas.total) !== saldoReservadoMl) {
        throw erro(
          'RESERVA_INCONSISTENTE',
          'A soma das reservas ativas não corresponde ao saldo reservado da categoria.',
          {
            categoria_fiscal: categoria,
            reservas_ativas_ml: somaReservas ? Number(somaReservas.total) : null,
            saldo_reservado_ml: saldoReservadoMl
          }
        );
      }
    }
    const reserva = await obterReservaDoPedido(
      empresaId, pedidoId, categoria, db, reservasDisponiveis
    );
    const reservaDoPedidoMl = reserva && reserva.status === 'ATIVA'
      ? Number(reserva.quantidade_reservada_ml)
      : 0;
    if (!Number.isSafeInteger(reservaDoPedidoMl) || reservaDoPedidoMl < 0
      || reservaDoPedidoMl > saldoReservadoMl) {
      throw erro(
        'RESERVA_INCONSISTENTE',
        'A reserva ativa do Pedido não corresponde ao saldo reservado da categoria.',
        { categoria_fiscal: categoria, reserva_do_pedido_ml: reservaDoPedidoMl }
      );
    }
    const capacidadeMl = saldoDisponivelMl + reservaDoPedidoMl;
    if (!Number.isSafeInteger(capacidadeMl) || capacidadeMl < 0
      || capacidadeMl > saldoAtualMl) {
      throw erro('SALDO_FISCAL_INVALIDO', 'Saldo fiscal disponível inválido.', {
        categoria_fiscal: categoria
      });
    }
    orcamentos[categoria] = {
      saldoAtualMl,
      saldoReservadoMl,
      saldoDisponivelMl,
      reservaDoPedidoMl,
      capacidadeMl
    };
  }
  return orcamentos;
}

function buscarComposicao(
  modelos,
  capacidadePorCategoria,
  alvoMaximo,
  alvoMinimo = 0,
  limiteEstados = LIMITE_ESTADOS_BUSCA
) {
  const budgetsIniciais = { ...capacidadePorCategoria };
  const sufixosMaximos = new Array(modelos.length + 1).fill(0);
  for (let i = modelos.length - 1; i >= 0; i -= 1) {
    const modelo = modelos[i];
    const maximoVolume = Math.floor(
      budgetsIniciais[modelo.categoriaFiscal] / modelo.volumeMlPorUnidade
    );
    const quantidadeMaxima = Number(
      quantidadeMaximaPorValor(modelo, alvoMaximo) < BigInt(maximoVolume)
        ? quantidadeMaximaPorValor(modelo, alvoMaximo)
        : BigInt(maximoVolume)
    );
    // Sem monotonicidade (atacado): o limite é o maior subtotal utilizável entre todas as quantidades.
    // Acima do limite de varredura, usa-se o próprio residual, que continua sendo limite seguro.
    let contribuicao = alvoMaximo;
    if (quantidadeMaxima <= LIMITE_QUANTIDADES_PARA_PODA) {
      contribuicao = 0;
      for (let q = 1; q <= quantidadeMaxima; q += 1) {
        const subtotal = subtotalCotado(modelo, q);
        if (subtotal <= alvoMaximo && subtotal > contribuicao) contribuicao = subtotal;
      }
    }
    sufixosMaximos[i] = sufixosMaximos[i + 1]
      + Math.min(contribuicao, alvoMaximo - sufixosMaximos[i + 1]);
  }

  const caminho = new Array(modelos.length).fill(0);
  const estadosConcluidos = new Set();
  let melhorCentavos = -1;
  let melhorCaminho = null;
  let estados = 0;
  let encontrouExato = false;
  let limiteAtingido = false;

  function visitar(indice, restanteCentavos, budgets) {
    if (encontrouExato || limiteAtingido) return;
    if (estados >= limiteEstados) {
      limiteAtingido = true;
      return;
    }
    estados += 1;

    const usadoCentavos = alvoMaximo - restanteCentavos;
    const melhorAlvo = Math.max(alvoMinimo, melhorCentavos);
    if (sufixosMaximos[indice] < melhorAlvo - usadoCentavos) return;
    if (indice === modelos.length) {
      const composicaoNaoVazia = alvoMaximo === 0 || usadoCentavos > 0;
      if (composicaoNaoVazia && usadoCentavos >= alvoMinimo && usadoCentavos > melhorCentavos) {
        melhorCentavos = usadoCentavos;
        melhorCaminho = caminho.slice();
        if (usadoCentavos === alvoMaximo) encontrouExato = true;
      }
      return;
    }

    const modelo = modelos[indice];
    const chave = `${indice}|${restanteCentavos}|${CATEGORIAS.map((c) => budgets[c] || 0).join(',')}`;
    if (estadosConcluidos.has(chave)) return;

    const maximoVolume = Math.floor(
      (budgets[modelo.categoriaFiscal] || 0) / modelo.volumeMlPorUnidade
    );
    const maximoPorValor = quantidadeMaximaPorValor(modelo, restanteCentavos);
    const quantidadeMaxima = Number(
      maximoPorValor < BigInt(maximoVolume) ? maximoPorValor : BigInt(maximoVolume)
    );
    for (let quantidade = quantidadeMaxima; quantidade >= 0; quantidade -= 1) {
      const subtotalCentavos = subtotalCotado(modelo, quantidade);
      if (subtotalCentavos > restanteCentavos) {
        // Sem monotonicidade: quantidade acima do residual é descartada, sem encerrar a varredura.
        if (estados >= limiteEstados) {
          limiteAtingido = true;
          return;
        }
        estados += 1;
        continue;
      }
      caminho[indice] = quantidade;
      const proximoBudget = {
        ...budgets,
        [modelo.categoriaFiscal]:
          (budgets[modelo.categoriaFiscal] || 0) - quantidade * modelo.volumeMlPorUnidade
      };
      visitar(
        indice + 1,
        restanteCentavos - subtotalCentavos,
        proximoBudget
      );
      if (encontrouExato || limiteAtingido) return;
    }
    caminho[indice] = 0;
    estadosConcluidos.add(chave);
  }

  visitar(0, alvoMaximo, budgetsIniciais);
  return {
    totalCentavos: melhorCentavos,
    quantidades: melhorCaminho,
    estadosVisitados: estados,
    encontrouExato,
    completa: !limiteAtingido,
    limiteAtingido,
    otimalidadeComprovada: encontrouExato || !limiteAtingido
  };
}

function criarFingerprint(dados) {
  return crypto.createHash('sha256').update(JSON.stringify(dados)).digest('hex');
}

function comporItens(modelos, quantidades) {
  return modelos.flatMap((modelo, indice) => {
    const quantidade = quantidades[indice];
    if (!quantidade) return [];
    const cotacao = modelo.cotador.cotar(quantidade);
    return [{
      produtoId: modelo.produtoId,
      nome: modelo.nome,
      categoriaFiscal: modelo.categoriaFiscal,
      quantidade,
      precoUnitario: cotacao.precoUnitarioInterno,
      precoUnitarioMicros: Math.round(cotacao.precoUnitarioInterno * 1000000),
      precoUnitarioCentavos: Math.round(cotacao.precoUnitarioInterno * 100),
      subtotalCentavos: cotacao.subtotalCentavos,
      regrasAplicadas: cotacao.regrasAplicadas,
      cotacaoFingerprint: cotacao.fingerprint,
      volumeMlPorUnidade: modelo.volumeMlPorUnidade,
      volumeTotalMl: quantidade * modelo.volumeMlPorUnidade
    }];
  });
}

/**
 * Simula composição fiscal em conexão explicitamente injetada.
 * Não cria schema, reserva/consome saldo, conclui vendas ou realiza efeitos operacionais.
 */
async function simularComposicao(params = {}, opts = {}) {
  const db = opts.db;
  if (!db) throw erro('DB_OBRIGATORIO', 'A simulação exige db explicitamente injetado.');
  const empresaId = inteiroPositivo(params.empresaId, 'EMPRESA_OBRIGATORIA', 'empresaId');
  const pedidoId = inteiroPositivo(params.pedidoId, 'PEDIDO_INVALIDO', 'pedidoId');
  const categorias = validarCategorias(params.categoriasFiscais);
  const { reservasDisponiveis } = await exigirSchemaLeitura(db);

  const modoVenda = String(params.modoVenda || MODO_VENDA_COMPOSICAO).trim().toUpperCase();
  if (modoVenda !== MODO_VENDA_COMPOSICAO) {
    throw erro(
      'MODO_VENDA_NAO_SUPORTADO',
      `Modo de venda ${modoVenda} não definido para a composição; apenas ${MODO_VENDA_COMPOSICAO} (modo regular) é suportado.`
    );
  }
  const agora = params.dataReferencia != null ? new Date(params.dataReferencia) : new Date();
  if (Number.isNaN(agora.getTime())) {
    throw erro('DATA_REFERENCIA_INVALIDA', 'dataReferencia inválida.');
  }
  const ctxCotacao = { empresaId, tipoVenda: modoVenda, agora };

  const { pedido, itens, totalCentavos } = await carregarPedido(empresaId, pedidoId, db);
  const itensFixos = await carregarItensFixos(params.itensFixos || [], itens, db, ctxCotacao);
  const totalFixosCentavos = itensFixos.reduce((soma, item) => {
    const somaAtualizada = soma + item.subtotalCentavos;
    if (!Number.isSafeInteger(somaAtualizada)) {
      throw erro('ITENS_FIXOS_INVALIDOS', 'A soma dos itens fixos excede o limite monetário seguro.');
    }
    return somaAtualizada;
  }, 0);
  const residualCentavos = totalCentavos - totalFixosCentavos;
  if (residualCentavos < 0) {
    throw erro('ITENS_FIXOS_EXCEDEM_PEDIDO', 'Os itens fiscais fixos excedem o total comercial do Pedido.');
  }

  const { modelos, invalidos } = await carregarModelos(empresaId, categorias, db, ctxCotacao);
  const orcamentos = await carregarOrcamentosCategoria(
    empresaId, pedidoId, categorias, db, reservasDisponiveis
  );
  const capacidadePorCategoria = Object.fromEntries(
    categorias.map((categoria) => [categoria, orcamentos[categoria].capacidadeMl])
  );
  const alvoMaximo = residualCentavos;
  const fixosOut = itensFixos.map((item) => ({
    produtoId: item.produtoId,
    nome: item.nome,
    quantidade: item.quantidade,
    precoUnitario: item.precoUnitario,
    precoUnitarioMicros: item.precoUnitarioMicros,
    precoUnitarioCentavos: item.precoUnitarioCentavos,
    subtotalCentavos: item.subtotalCentavos,
    regrasAplicadas: item.regrasAplicadas,
    cotacaoFingerprint: item.cotacaoFingerprint
  }));
  const fingerprintBase = {
    empresaId,
    pedidoId,
    pedidoStatus: pedido.status,
    pedidoTotalCentavos: totalCentavos,
    pedidoDescontoCentavos: dinheiroEmCentavos(pedido.desconto || 0, 'PEDIDO_INVALIDO', 'desconto'),
    pedidoFreteCentavos: dinheiroEmCentavos(pedido.frete || 0, 'PEDIDO_INVALIDO', 'frete'),
    pedidoCodigo: pedido.codigo || null,
    pedidoAtualizadoEm: pedido.updated_at || null,
    itensPedido: itens.map((item) => ({
      itemId: Number(item.id),
      produtoId: Number(item.produto_id),
      quantidade: Number(item.quantidade),
      precoUnitario: Number(item.preco_unitario),
      descontoPercentual: Number(item.desconto_percentual || 0),
      subtotal: Number(item.subtotal),
      classificacao: item.classificacao_operacional_snapshot || null
    })),
    itensFixos: itensFixos.map((item) => ({
      produtoId: item.produtoId,
      quantidade: item.quantidade,
      subtotalCentavos: item.subtotalCentavos,
      cotacaoFingerprint: item.cotacaoFingerprint,
      produtoUpdatedAt: item.produtoUpdatedAt,
      nomeProduto: item.nomeProduto,
      ativoProduto: item.ativoProduto,
      classificacaoProduto: item.classificacaoProduto
    })),
    modelos: modelos.map((modelo) => modelo),
    modelosInvalidos: invalidos,
    saldos: orcamentos,
    categorias,
    fontePreco: 'CotacaoPrecoProdutoService',
    modoVenda,
    busca: {
      versao: VERSAO_ALGORITMO_BUSCA,
      limiteEstados: LIMITE_ESTADOS_BUSCA,
      limiteQuantidadesParaPoda: LIMITE_QUANTIDADES_PARA_PODA,
      criterioDesempate: CRITERIO_DESEMPATE
    }
  };
  const fingerprint = criarFingerprint(fingerprintBase);
  if (params.fingerprintEsperado != null && params.fingerprintEsperado !== fingerprint) {
    throw erro(
      'COMPOSICAO_DESATUALIZADA',
      'Pedido, catálogo, configuração fiscal ou disponibilidade mudaram desde a composição anterior.',
      { fingerprint_atual: fingerprint }
    );
  }

  if (!modelos.length && residualCentavos > 0) {
    throw erro(
      'MODELOS_FISCAIS_INSUFICIENTES',
      'Não há modelos fiscais elegíveis, ativos, precificados e com volume MUC válido.',
      { modelos_invalidos: invalidos }
    );
  }

  const busca = buscarComposicao(modelos, capacidadePorCategoria, residualCentavos);
  if (!busca.otimalidadeComprovada) {
    const encontrouParcial = busca.totalCentavos >= 0;
    return {
      sucesso: false,
      status: 'INCONCLUSIVA',
      codigo: 'COMPOSICAO_BUSCA_INCONCLUSIVA',
      mensagem: 'O limite de estados foi atingido antes de provar a melhor composição; o resultado parcial não é utilizável.',
      pedidoId,
      empresaId,
      valorResidualCentavos: residualCentavos,
      valorComposicaoCentavos: encontrouParcial
        ? totalFixosCentavos + busca.totalCentavos
        : null,
      descontoMonetarioCentavos: encontrouParcial
        ? residualCentavos - busca.totalCentavos
        : null,
      composicaoParcial: encontrouParcial
        ? comporItens(modelos, busca.quantidades)
        : [],
      composicaoParcialUtilizavel: false,
      otimalidadeComprovada: false,
      modoVendaModelos: modoVenda,
      dataReferenciaCotacao: agora.toISOString(),
      estadosBusca: busca.estadosVisitados,
      limiteEstadosBusca: LIMITE_ESTADOS_BUSCA,
      fingerprint,
      efeitosOperacionais: false
    };
  }
  if (busca.totalCentavos < 0) {
    throw erro(
      'COMPOSICAO_FISCAL_INEXISTENTE',
      'Nenhuma composição fiscal válida foi encontrada dentro do saldo e dos volumes disponíveis.',
      { valor_residual_centavos: residualCentavos, estados_visitados: busca.estadosVisitados }
    );
  }

  const itensCompostos = comporItens(modelos, busca.quantidades);
  const valorComposicaoCentavos = totalFixosCentavos + busca.totalCentavos;
  const descontoAplicadoCentavos = totalCentavos - valorComposicaoCentavos;
  if (descontoAplicadoCentavos < 0) {
    throw erro('COMPOSICAO_TOTAL_INVALIDO', 'A composição não pode aumentar o total comercial do Pedido.');
  }
  const capacidadeUsada = {};
  for (const item of itensCompostos) {
    capacidadeUsada[item.categoriaFiscal] =
      (capacidadeUsada[item.categoriaFiscal] || 0) + item.volumeTotalMl;
  }
  return {
    sucesso: true,
    pedidoId,
    empresaId,
    statusPedido: pedido.status,
    valorComercialOriginalCentavos: totalCentavos,
    itensFixos: fixosOut,
    valorItensFixosCentavos: totalFixosCentavos,
    valorResidualCentavos: residualCentavos,
    categoriasFiscais: categorias,
    itensCompostos,
    valorComposicaoCentavos,
    descontoAplicadoCentavos,
    valorFinalCentavos: valorComposicaoCentavos,
    descontoRequerAprovacao: descontoAplicadoCentavos > 0,
    simulacaoAutorizaDesconto: false,
    criterioSelecao: busca.encontrouExato
      ? 'COMPOSICAO_EXATA'
      : 'MENOR_DESCONTO_COMPROVADO',
    criterioDesempate: CRITERIO_DESEMPATE,
    otimalidadeComprovada: busca.otimalidadeComprovada,
    provaOptimalidade: busca.encontrouExato
      ? 'composição exata atinge o limite máximo do residual'
      : 'busca completa sem exceder o limite de estados',
    fontePrecoModelos: 'CotacaoPrecoProdutoService (preço-base, promoção e atacado por quantidade)',
    modoVendaModelos: modoVenda,
    dataReferenciaCotacao: agora.toISOString(),
    fonteVolumeModelos: 'produtos.volume_valor/volume_unidade convertido pelo MUC',
    capacidadeFiscalPorCategoria: orcamentos,
    capacidadeUsadaMlPorCategoria: capacidadeUsada,
    modelosInvalidos: invalidos,
    estadosBusca: busca.estadosVisitados,
    fingerprint,
    revalidarAntesDeQualquerUso: true,
    efeitosOperacionais: false
  };
}

module.exports = {
  simularComposicao,
  internos: {
    dinheiroEmCentavos,
    buscarComposicao,
    criarFingerprint,
    LIMITE_ESTADOS_BUSCA,
    LIMITE_QUANTIDADES_PARA_PODA,
    MODO_VENDA_COMPOSICAO,
    CRITERIO_DESEMPATE
  }
};
