'use strict';
const { roundStockQuantity } = require('../estoque/quantityPrecision');

const crypto = require('crypto');
const { obterMuc } = require('../../motores/muc/public');
const { normalizarUnidade } = require('../../motores/muc/core/unidadesSi');
const { tipoParaUnidadeComercial } = require('../../motores/muc/constants/tiposApresentacao');
const MotorComercial = require('../../motores/comercial');
const ProdutoConversaoConfigService = require('../produtos/ProdutoConversaoConfigService');
const FichaTecnicaService = require('../produtos/FichaTecnicaService');
const FichaTecnicaConsumoService = require('../produtos/FichaTecnicaConsumoService');
const { produtoControlaEstoque } = require('../estoque/produtoControlaEstoque');
const { debitarEstoqueItemVenda } = require('../vendas/debitoEstoqueVendaViaPorta');
const { consumirReservasPedidoNaVenda } = require('../estoque/pedidoReservaPonteNucleo');
const estoqueSaldosPublico = require('../fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');

const SQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pedido_operacao_idempotencia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    chave TEXT NOT NULL,
    requisicao_hash TEXT NOT NULL,
    pedido_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (empresa_id, chave),
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS pedido_estoque_consumos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id INTEGER NOT NULL UNIQUE,
    empresa_id INTEGER NOT NULL,
    operacao_id TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS pedido_estoque_consumo_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consumo_id INTEGER NOT NULL,
    pedido_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    pedido_item_id INTEGER,
    produto_id INTEGER NOT NULL,
    insumo_id INTEGER,
    origem_requisito TEXT NOT NULL,
    quantidade REAL NOT NULL,
    unidade TEXT NOT NULL,
    quantidade_fiscal REAL NOT NULL DEFAULT 0,
    quantidade_nao_fiscal REAL NOT NULL DEFAULT 0,
    quantidade_ficha REAL,
    unidade_ficha TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (consumo_id) REFERENCES pedido_estoque_consumos(id) ON DELETE CASCADE,
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pedido_consumo_itens_pedido
    ON pedido_estoque_consumo_itens(pedido_id, pedido_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pedido_consumo_itens_empresa_produto
    ON pedido_estoque_consumo_itens(empresa_id, produto_id)`,
  `CREATE TABLE IF NOT EXISTS pedido_estoque_estornos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id INTEGER NOT NULL UNIQUE,
    consumo_id INTEGER NOT NULL UNIQUE,
    empresa_id INTEGER NOT NULL,
    operacao_id TEXT NOT NULL UNIQUE,
    chave_idempotencia TEXT NOT NULL,
    usuario_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id),
    FOREIGN KEY (consumo_id) REFERENCES pedido_estoque_consumos(id)
  )`,
  `CREATE TABLE IF NOT EXISTS pedido_estoque_estorno_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estorno_id INTEGER NOT NULL,
    consumo_item_id INTEGER NOT NULL UNIQUE,
    pedido_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    pedido_item_id INTEGER,
    produto_id INTEGER NOT NULL,
    insumo_id INTEGER,
    origem_requisito TEXT NOT NULL,
    quantidade REAL NOT NULL,
    unidade TEXT NOT NULL,
    quantidade_fiscal REAL NOT NULL,
    quantidade_nao_fiscal REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (estorno_id, consumo_item_id),
    FOREIGN KEY (estorno_id) REFERENCES pedido_estoque_estornos(id),
    FOREIGN KEY (consumo_item_id) REFERENCES pedido_estoque_consumo_itens(id),
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
  )`,
  `CREATE TABLE IF NOT EXISTS pedido_estoque_estorno_solicitacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    chave TEXT NOT NULL,
    requisicao_hash TEXT NOT NULL,
    pedido_id INTEGER NOT NULL,
    estorno_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (empresa_id, chave),
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id),
    FOREIGN KEY (estorno_id) REFERENCES pedido_estoque_estornos(id)
  )`
];

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
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

function erro(codigo, mensagem, statusCode = 409) {
  const err = new Error(mensagem);
  err.code = codigo;
  err.codigo = codigo;
  err.statusCode = statusCode;
  return err;
}



async function garantirSchema(db) {
  if (!db) throw erro('DB_OBRIGATORIO', 'Conexão SQLite obrigatória.', 500);
  for (const sql of SQL_SCHEMA) await dbRun(db, sql);
}

function normalizarChaveIdempotencia(chave) {
  const valor = String(chave || '').trim();
  if (!valor || valor.length > 200) {
    throw erro(
      'CHAVE_IDEMPOTENCIA_OBRIGATORIA',
      'Informe uma chave de idempotência válida para criar o Pedido.',
      400
    );
  }
  return valor;
}

function hashRequisicao(dados) {
  return crypto.createHash('sha256').update(JSON.stringify(dados)).digest('hex');
}

async function obterPedidoIdempotente(db, empresaId, chave, requisicaoHash) {
  if (!chave) return null;
  const row = await dbGet(
    db,
    `SELECT pedido_id, requisicao_hash
       FROM pedido_operacao_idempotencia
      WHERE empresa_id = ? AND chave = ?`,
    [Number(empresaId), normalizarChaveIdempotencia(chave)]
  );
  if (!row) return null;
  if (row.requisicao_hash !== requisicaoHash) {
    throw erro(
      'CHAVE_IDEMPOTENCIA_REUTILIZADA',
      'A chave de idempotência já foi usada com outro conteúdo.',
      409
    );
  }
  return Number(row.pedido_id);
}

async function registrarPedidoIdempotente(db, empresaId, chave, requisicaoHash, pedidoId) {
  if (!chave) return;
  await dbRun(
    db,
    `INSERT INTO pedido_operacao_idempotencia
      (empresa_id, chave, requisicao_hash, pedido_id)
     VALUES (?, ?, ?, ?)`,
    [Number(empresaId), normalizarChaveIdempotencia(chave), requisicaoHash, Number(pedidoId)]
  );
}

async function jaConsumido(pedidoId, opts = {}) {
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0 || !opts.db) return false;
  try {
    return Boolean(await dbGet(
      opts.db,
      'SELECT id FROM pedido_estoque_consumos WHERE pedido_id = ?',
      [id]
    ));
  } catch (err) {
    if (/no such table/i.test(String(err.message || ''))) return false;
    throw err;
  }
}

async function obterEstornoPorPedido(pedidoId, opts = {}) {
    if (!opts.db) throw erro('DB_OBRIGATORIO', 'Conexão SQLite obrigatória.', 500);
    return dbGet(
      opts.db,
      `SELECT id, pedido_id, consumo_id, empresa_id, operacao_id, chave_idempotencia,
              usuario_id, created_at
         FROM pedido_estoque_estornos
        WHERE pedido_id = ?`,
      [Number(pedidoId)]
    );
  }

async function solicitarEstorno({
    db,
    pedidoId,
    empresaId,
    chaveIdempotencia,
    usuarioId,
    jaEmTransacao
  }) {
    if (!db) throw erro('DB_OBRIGATORIO', 'Conexão SQLite obrigatória.', 500);
    if (jaEmTransacao !== true) {
      throw erro(
        'TRANSACAO_PEDIDO_OBRIGATORIA',
        'O estorno do Pedido deve participar da transação iniciada pelo caller.',
        500
      );
    }
    const id = Number(pedidoId);
    const empresa = Number(empresaId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(empresa) || empresa <= 0) {
      throw erro('CONTEXTO_PEDIDO_INVALIDO', 'Pedido e empresa são obrigatórios para o estorno.');
    }
    const chave = normalizarChaveIdempotencia(chaveIdempotencia);
    const requisicaoHash = hashRequisicao({ operacao: 'ESTORNO_PEDIDO', pedidoId: id, empresaId: empresa });
    const pedido = await dbGet(db, 'SELECT empresa_id FROM pedidos WHERE id = ?', [id]);
    if (!pedido) throw erro('PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado.', 404);
    if (Number(pedido.empresa_id) !== empresa) {
      throw erro('PEDIDO_EMPRESA_DIVERGENTE', 'O Pedido não pertence à empresa informada.', 409);
    }

    const solicitacaoExistente = await dbGet(
      db,
      `SELECT requisicao_hash, pedido_id, estorno_id
         FROM pedido_estoque_estorno_solicitacoes
        WHERE empresa_id = ? AND chave = ?`,
      [empresa, chave]
    );
    if (solicitacaoExistente) {
      if (
        solicitacaoExistente.requisicao_hash !== requisicaoHash
        || Number(solicitacaoExistente.pedido_id) !== id
      ) {
        throw erro(
          'CHAVE_IDEMPOTENCIA_REUTILIZADA',
          'A chave de idempotência já foi usada com outro cancelamento.',
          409
        );
      }
      return {
        ...(await obterEstornoPorPedido(id, { db })),
        ja_estornado: true,
        idempotente: true
      };
    }

    const consumo = await dbGet(
      db,
      `SELECT id, pedido_id, empresa_id, operacao_id
         FROM pedido_estoque_consumos
        WHERE pedido_id = ?`,
      [id]
    );
    if (!consumo) {
      throw erro('PEDIDO_CONSUMO_NAO_ENCONTRADO', 'Não há consumo confirmado para estornar.');
    }
    if (Number(consumo.empresa_id) !== empresa) {
      throw erro('PEDIDO_EMPRESA_DIVERGENTE', 'O consumo não pertence à empresa informada.', 409);
    }

    const estornoExistente = await obterEstornoPorPedido(id, { db });
    let estornoId;
    let operacaoId;
    if (estornoExistente) {
      if (
        Number(estornoExistente.consumo_id) !== Number(consumo.id)
        || Number(estornoExistente.empresa_id) !== empresa
      ) {
        throw erro('PEDIDO_ESTORNO_INCONSISTENTE', 'O estorno existente não corresponde ao consumo.', 409);
      }
      estornoId = Number(estornoExistente.id);
      operacaoId = estornoExistente.operacao_id;
    } else {
      const linhas = await dbAll(
        db,
        `SELECT id, pedido_id, empresa_id, pedido_item_id, produto_id, insumo_id,
                origem_requisito, quantidade, unidade, quantidade_fiscal, quantidade_nao_fiscal
           FROM pedido_estoque_consumo_itens
          WHERE consumo_id = ?
          ORDER BY id`,
        [Number(consumo.id)]
      );
      operacaoId = crypto.randomUUID();
      const cabecalho = await dbRun(
        db,
        `INSERT INTO pedido_estoque_estornos
          (pedido_id, consumo_id, empresa_id, operacao_id, chave_idempotencia, usuario_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, Number(consumo.id), empresa, operacaoId, chave, usuarioId || null]
      );
      estornoId = cabecalho.lastID;

      for (const linha of linhas) {
        const quantidade = roundStockQuantity(linha.quantidade);
        const quantidadeFiscal = roundStockQuantity(linha.quantidade_fiscal);
        const quantidadeNaoFiscal = roundStockQuantity(linha.quantidade_nao_fiscal);
        const produtoEstoqueId = Number(linha.insumo_id || linha.produto_id);
        if (
          Number(linha.empresa_id) !== empresa
          || !Number.isInteger(produtoEstoqueId)
          || produtoEstoqueId <= 0
          || !String(linha.unidade || '').trim()
          || !Number.isFinite(quantidade)
          || quantidade < 0
          || quantidadeFiscal < 0
          || quantidadeNaoFiscal < 0
          || Math.abs(roundStockQuantity(quantidadeFiscal + quantidadeNaoFiscal) - quantidade) > 0.001
        ) {
          throw erro(
            'PEDIDO_LEDGER_ESTORNO_INVALIDO',
            'O ledger de consumo contém dados inválidos; o cancelamento foi bloqueado.',
            409
          );
        }

        const opcoesSaldo = { db, empresaId: empresa, usuarioId };
        if (quantidadeFiscal > 0) {
          await estoqueSaldosPublico.creditarSaldo(
            produtoEstoqueId,
            TipoSaldo.FISCAL,
            quantidadeFiscal,
            opcoesSaldo
          );
        }
        if (quantidadeNaoFiscal > 0) {
          await estoqueSaldosPublico.creditarSaldo(
            produtoEstoqueId,
            TipoSaldo.NAO_FISCAL,
            quantidadeNaoFiscal,
            opcoesSaldo
          );
        }

        await dbRun(
          db,
          `INSERT INTO pedido_estoque_estorno_itens (
            estorno_id, consumo_item_id, pedido_id, empresa_id, pedido_item_id, produto_id,
            insumo_id, origem_requisito, quantidade, unidade, quantidade_fiscal,
            quantidade_nao_fiscal
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            estornoId,
            Number(linha.id),
            id,
            empresa,
            linha.pedido_item_id,
            Number(linha.produto_id),
            linha.insumo_id == null ? null : Number(linha.insumo_id),
            linha.origem_requisito,
            quantidade,
            linha.unidade,
            quantidadeFiscal,
            quantidadeNaoFiscal
          ]
        );
      }
    }

    await dbRun(
      db,
      `INSERT INTO pedido_estoque_estorno_solicitacoes
        (empresa_id, chave, requisicao_hash, pedido_id, estorno_id)
       VALUES (?, ?, ?, ?, ?)`,
      [empresa, chave, requisicaoHash, id, estornoId]
    );
    return {
      ...(await obterEstornoPorPedido(id, { db })),
      operacao_id: operacaoId,
      ja_estornado: Boolean(estornoExistente),
      idempotente: Boolean(estornoExistente)
    };
}

async function carregarProduto(db, produtoId) {
  const colunas = new Set(
    (await dbAll(db, 'PRAGMA table_info(produtos)')).map((coluna) => String(coluna.name).toLowerCase())
  );
  const opcional = (nome, fallback) => (colunas.has(nome) ? nome : fallback);
  return dbGet(
    db,
    `SELECT id, nome,
            ${opcional('unidade', 'NULL')} AS unidade,
            ${opcional('controla_estoque', '1')} AS controla_estoque,
            ${opcional('utiliza_volume', '0')} AS utiliza_volume,
            ${opcional('volume_valor', 'NULL')} AS volume_valor,
            ${opcional('volume_unidade', 'NULL')} AS volume_unidade
       FROM produtos WHERE id = ?`,
    [Number(produtoId)]
  );
}

async function listarApresentacoes(db, produtoId) {
  try {
    return await dbAll(
      db,
      `SELECT tipo, quantidade, unidade, ativa, compra, venda, principal
         FROM produto_embalagens
        WHERE produto_id = ? AND COALESCE(ativa, 1) = 1`,
      [Number(produtoId)]
    );
  } catch (err) {
    if (/no such table/i.test(String(err.message || ''))) return [];
    throw err;
  }
}

async function converterProdutoSimples(db, item, produto) {
  const config = await ProdutoConversaoConfigService.obterConfiguracao(db, produto.id);
  const unidadeDestino = normalizarUnidade(config.unidade_estoque || config.unidade);
  const usaVolume = Number(produto.utiliza_volume) === 1;
  const quantidade = Number(item.quantidade);
  let unidadeOrigem = normalizarUnidade(item.produto_unidade_snapshot || produto.unidade);
  let quantidadeOrigem = quantidade;
  const relacoesConfiguradas = Number(config.utiliza_conversao) === 1;
  const apresentacoes = relacoesConfiguradas ? await listarApresentacoes(db, produto.id) : [];

  if (usaVolume) {
    const volume = Number(produto.volume_valor);
    unidadeOrigem = normalizarUnidade(produto.volume_unidade);
    if (!(volume > 0) || !unidadeOrigem) {
      throw erro(
        'VOLUME_COMERCIAL_INVALIDO',
        `O volume comercial do produto ${produto.nome || produto.id} está incompleto.`
      );
    }
    quantidadeOrigem = roundStockQuantity(quantidade * volume);
  } else if (relacoesConfiguradas) {
    const apresentacoesVendaPrincipal = apresentacoes.filter(
      (apresentacao) => Number(apresentacao.venda) === 1
        && Number(apresentacao.principal) === 1
    );
    if (apresentacoesVendaPrincipal.length > 1) {
      throw erro(
        'UNIDADE_COMERCIAL_AMBIGUA',
        `O produto ${produto.nome || produto.id} possui mais de uma apresentação principal de venda.`
      );
    }
    if (apresentacoesVendaPrincipal.length === 1) {
      unidadeOrigem = normalizarUnidade(
        tipoParaUnidadeComercial(apresentacoesVendaPrincipal[0].tipo)
      );
    }
  }

  if (!unidadeOrigem || !unidadeDestino) {
    throw erro(
      'UNIDADE_ESTOQUE_INVALIDA',
      `Não foi possível determinar as unidades comercial e de estoque do produto ${produto.nome || produto.id}.`
    );
  }

  if (unidadeOrigem === unidadeDestino) {
    return { quantidade: roundStockQuantity(quantidadeOrigem), unidade: unidadeDestino };
  }

  const relacoes = ProdutoConversaoConfigService.montarRelacoesMuc(
    apresentacoes,
    relacoesConfiguradas ? (config.relacoes || []) : []
  );
  try {
    const convertido = obterMuc(db).converterQuantidade({
      quantidade: quantidadeOrigem,
      unidadeOrigem,
      unidadeDestino,
      relacoes
    });
    return {
      quantidade: roundStockQuantity(convertido.quantidade),
      unidade: convertido.unidade || unidadeDestino
    };
  } catch (err) {
    const codigoConversao = err.code === 'CONVERSAO_INVALIDA'
      ? 'CONVERSAO_NAO_DISPONIVEL'
      : (err.code || 'CONVERSAO_NAO_DISPONIVEL');
    throw erro(
      codigoConversao,
      `Não foi possível converter ${unidadeOrigem} para ${unidadeDestino} no produto ${produto.nome || produto.id}: ${err.message}`
    );
  }
}

async function montarRequisitos(itens, db) {
  const itensComFicha = new Set();
  const componentesPorItem = new Map();
  for (const item of itens || []) {
    if (Number(item.personalizacao_ingredientes_snapshot) === 1) {
      const pedidoItemId = Number(item.id);
      const componentes = item.ingredientes_personalizados;
      if (!Number.isInteger(pedidoItemId) || pedidoItemId <= 0
        || !Array.isArray(componentes) || componentes.length === 0) {
        throw erro(
          'PERSONALIZACAO_PEDIDO_INVALIDA',
          'O snapshot de ingredientes personalizados do item está incompleto.',
          409
        );
      }
      const vistos = new Set();
      const selecionados = [];
      for (const componente of componentes) {
        const insumoId = Number(componente.insumo_id);
        const quantidade = Number(componente.quantidade_snapshot);
        const unidade = String(componente.unidade_snapshot || '').trim();
        const classificacao = String(componente.classificacao_comercial_snapshot || '');
        const selecionado = Number(componente.selecionado);
        const adicional = Number(componente.preco_adicional_snapshot);
        if (!Number.isInteger(insumoId) || insumoId <= 0 || vistos.has(insumoId)
          || !(quantidade > 0) || !Number.isFinite(quantidade) || !unidade
          || !['OBRIGATORIO_OCULTO', 'OPCIONAL', 'OPCIONAL_COM_ADICIONAL'].includes(classificacao)
          || ![0, 1].includes(selecionado) || !Number.isFinite(adicional) || adicional < 0
          || (classificacao === 'OBRIGATORIO_OCULTO' && selecionado !== 1)
          || (classificacao === 'OPCIONAL_COM_ADICIONAL' ? adicional <= 0 : adicional !== 0)) {
          throw erro(
            'PERSONALIZACAO_PEDIDO_INVALIDA',
            `O snapshot do ingrediente ${componente.insumo_id || '(inválido)'} está inconsistente.`,
            409
          );
        }
        vistos.add(insumoId);
        if (selecionado === 1) {
          selecionados.push({
            insumo_id: insumoId,
            quantidade,
            unidade,
            quantidade_snapshot: quantidade,
            unidade_snapshot: unidade
          });
        }
      }
      componentesPorItem.set(pedidoItemId, selecionados);
      itensComFicha.add(pedidoItemId);
      continue;
    }

    const usoFicha = await FichaTecnicaService.consultarUsoFichaTecnica(item.produto_id, { db });
    if (!usoFicha.utiliza_ficha_tecnica) continue;

    let ficha;
    try {
      ficha = await FichaTecnicaService.obterPorProdutoId(item.produto_id, { db });
    } catch (err) {
      throw FichaTecnicaConsumoService.normalizarErroFichaTecnica(err);
    }
    if (!ficha || ficha.existe === false) {
      if (!usoFicha.configuracao_legada) {
        throw erro(
          'FICHA_TECNICA_NAO_ENCONTRADA',
          `O produto ${item.produto_nome || item.produto_id} está configurado para utilizar ficha técnica, mas não possui ficha.`,
          400
        );
      }
      continue;
    }
    if (Number(ficha.ativo) !== 1) {
      if (!usoFicha.configuracao_legada) {
        throw erro(
          'FICHA_TECNICA_INATIVA',
          `A ficha técnica do produto ${item.produto_nome || item.produto_id} está inativa.`,
          400
        );
      }
      continue;
    }
    if (!Array.isArray(ficha.itens) || ficha.itens.length === 0) {
      throw erro(
        'FICHA_TECNICA_VAZIA',
        `A ficha técnica ativa do produto ${item.produto_nome || item.produto_id} não possui ingredientes.`,
        400
      );
    }
    itensComFicha.add(Number(item.id));
  }

  const linhasFicha = await FichaTecnicaConsumoService.montarLinhasConsumo(itens, db, {
    componentesPorItem
  });
  for (const linha of linhasFicha) {
    const insumo = await carregarProduto(db, linha.insumo_id);
    if (!insumo) {
      throw erro('PRODUTO_INEXISTENTE', `Insumo ${linha.insumo_id} não encontrado.`, 404);
    }
    if (!produtoControlaEstoque(insumo)) {
      throw erro(
        'INSUMO_SEM_CONTROLE_ESTOQUE',
        `O insumo ${insumo.nome || insumo.id} da ficha técnica não controla estoque.`,
        409
      );
    }
  }
  const requisitos = linhasFicha.map((linha) => ({
    pedido_item_id: linha.pedido_item_id,
    produto_id: Number(linha.produto_id),
    insumo_id: Number(linha.insumo_id),
    origem_requisito: 'FICHA_TECNICA',
    quantidade: roundStockQuantity(linha.quantidade),
    unidade: linha.unidade,
    quantidade_ficha: roundStockQuantity(linha.quantidade_ficha),
    unidade_ficha: linha.unidade_ficha
  }));

  for (const item of itens || []) {
    if (itensComFicha.has(Number(item.id))) continue;
    const produto = await carregarProduto(db, item.produto_id);
    if (!produto) {
      throw erro('PRODUTO_INEXISTENTE', `Produto ${item.produto_id} não encontrado.`, 404);
    }
    if (!produtoControlaEstoque(produto)) continue;
    const convertido = await converterProdutoSimples(db, item, produto);
    if (!(convertido.quantidade > 0)) {
      throw erro('QUANTIDADE_ESTOQUE_INVALIDA', `Quantidade inválida para o produto ${produto.nome || produto.id}.`);
    }
    requisitos.push({
      pedido_item_id: Number(item.id),
      produto_id: Number(item.produto_id),
      insumo_id: null,
      origem_requisito: 'PRODUTO_SIMPLES',
      quantidade: convertido.quantidade,
      unidade: convertido.unidade,
      quantidade_ficha: null,
      unidade_ficha: null
    });
  }
  return requisitos;
}

function agregarRequisitos(requisitos) {
  const agregados = new Map();
  for (const requisito of requisitos) {
    const produtoEstoqueId = requisito.insumo_id || requisito.produto_id;
    const anterior = agregados.get(produtoEstoqueId) || {
      produto_id: produtoEstoqueId,
      quantidade: 0
    };
    anterior.quantidade = roundStockQuantity(anterior.quantidade + Number(requisito.quantidade));
    agregados.set(produtoEstoqueId, anterior);
  }
  return [...agregados.values()];
}

function debitarEstoque(db, produtoId, quantidade, empresaId, usuarioId) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemVenda(db, {
      produtoId,
      quantidadeFiscal: quantidade,
      quantidadeNaoFiscal: 0,
      empresaId,
      usuarioId,
      exigirEmpresa: true,
      origem: 'consumo_pedido'
    }, (err, resultado) => (err ? reject(err) : resolve(resultado)));
  });
}

async function registrarConsumo({
  db,
  pedidoId,
  empresaId,
  usuarioId,
  itens,
  supervisorToken,
  jaEmTransacao
}) {
  if (!db) throw erro('DB_OBRIGATORIO', 'Conexão SQLite obrigatória.', 500);
  if (jaEmTransacao !== true) {
    throw erro(
      'TRANSACAO_PEDIDO_OBRIGATORIA',
      'O consumo do Pedido deve participar da transação iniciada pelo caller.',
      500
    );
  }
  const id = Number(pedidoId);
  const empresa = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(empresa) || empresa <= 0) {
    throw erro('CONTEXTO_PEDIDO_INVALIDO', 'Pedido e empresa são obrigatórios para o consumo.');
  }
  const pedido = await dbGet(db, 'SELECT empresa_id FROM pedidos WHERE id = ?', [id]);
  if (!pedido) throw erro('PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado.', 404);
  if (Number(pedido.empresa_id) !== empresa) {
    throw erro('PEDIDO_EMPRESA_DIVERGENTE', 'O Pedido não pertence à empresa informada.', 409);
  }
  if (await jaConsumido(id, { db })) {
    return { pedido_id: id, empresa_id: empresa, ja_consumido: true, itens: [] };
  }

  const requisitos = await montarRequisitos(itens, db);
  const agregados = agregarRequisitos(requisitos);
  if (agregados.length > 0) {
    await MotorComercial.confirmarPedidoFiscal({
      pedidoId: id,
      itens: agregados,
      supervisorToken,
      usuarioId,
      motivo: `Consumo operacional pedido ${id}`,
      empresaId: empresa
    }, {
      db,
      executarEmTransacao: async (work, opcoes = {}) => work(opcoes.db || db)
    });

    for (const agregado of agregados) {
      await debitarEstoque(db, agregado.produto_id, agregado.quantidade, empresa, usuarioId);
    }

    await consumirReservasPedidoNaVenda(id, null, { db, empresaId: empresa, usuarioId });
  }

  const operacaoId = crypto.randomUUID();
  const cab = await dbRun(
    db,
    `INSERT INTO pedido_estoque_consumos (pedido_id, empresa_id, operacao_id)
     VALUES (?, ?, ?)`,
    [id, empresa, operacaoId]
  );

  for (const requisito of requisitos) {
    await dbRun(
      db,
      `INSERT INTO pedido_estoque_consumo_itens (
        consumo_id, pedido_id, empresa_id, pedido_item_id, produto_id, insumo_id,
        origem_requisito, quantidade, unidade, quantidade_fiscal,
        quantidade_nao_fiscal, quantidade_ficha, unidade_ficha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        cab.lastID,
        id,
        empresa,
        requisito.pedido_item_id,
        requisito.produto_id,
        requisito.insumo_id,
        requisito.origem_requisito,
        requisito.quantidade,
        requisito.unidade,
        requisito.quantidade,
        requisito.quantidade_ficha,
        requisito.unidade_ficha
      ]
    );
  }

  return {
    pedido_id: id,
    empresa_id: empresa,
    operacao_id: operacaoId,
    ja_consumido: false,
    itens: requisitos
  };
}

module.exports = {
  garantirSchema,
  normalizarChaveIdempotencia,
  hashRequisicao,
  obterPedidoIdempotente,
  registrarPedidoIdempotente,
  jaConsumido,
  obterEstornoPorPedido,
  solicitarEstorno,
  montarRequisitos,
  registrarConsumo
};
