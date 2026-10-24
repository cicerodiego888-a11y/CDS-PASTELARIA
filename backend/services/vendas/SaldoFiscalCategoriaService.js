/**
 * Saldo fiscal compartilhado por (empresa, categoria fiscal), em ml inteiros (Sprint 2B).
 *
 * - Controle fiscal lógico; NÃO lê, soma nem altera `produtos`/`estoque_empresa`.
 * - Ledger append-only; correções por novos movimentos (ESTORNO / ajustes).
 * - Sem reservas, consumo por venda, composição ou integração com vendas nesta sprint.
 * - Conversão para ml apenas como adaptador sobre o MUC existente.
 *
 * Transações: o serviço é dono da transação (BEGIN IMMEDIATE), serializada por conexão. Se a conexão
 * já tiver transação aberta, rejeita com TRANSACAO_EXTERNA_ATIVA antes de qualquer escrita e sem
 * emitir COMMIT/ROLLBACK sobre a transação do chamador. SQLITE_BUSY vira SALDO_OCUPADO (503).
 * Autorização do operador NÃO é verificada aqui: usuarioId apenas identifica quem a camada
 * chamadora já autorizou.
 *
 * @module services/vendas/SaldoFiscalCategoriaService
 */
'use strict';

const { garantirSchemaSaldoFiscalCategoriaAsync } = require('./saldoFiscalCategoriaSchema');
const { normalizarCategoriaFiscal } = require('./CategoriaFiscalEmpresaService');
const { obterMuc } = require('../../motores/muc');
const { CODIGOS } = require('../../motores/muc/core/MotorConversaoQuantidade');
const { obterConfiguracao, montarRelacoesMuc } = require('../produtos/ProdutoConversaoConfigService');

const UNIDADE_BASE = 'ML';
const TipoMovimento = Object.freeze({
  ABERTURA: 'ABERTURA',
  AJUSTE_ENTRADA: 'AJUSTE_ENTRADA',
  AJUSTE_SAIDA: 'AJUSTE_SAIDA',
  ESTORNO: 'ESTORNO'
});
const TOLERANCIA_AMBIGUIDADE = 1e-6;

function erro(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = extra.statusCode || 400;
  Object.assign(err, extra);
  return err;
}

function getDb(db) {
  return db || require('../../database');
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

const filas = new WeakMap();

/** Serializa as transações de uma mesma conexão e usa BEGIN IMMEDIATE. */
function executarEmTransacao(db, work) {
  const anterior = filas.get(db) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(async () => {
    try {
      await dbRun(db, 'BEGIN IMMEDIATE');
    } catch (err) {
      // Falha no BEGIN: nenhuma transação nossa foi aberta, então não há ROLLBACK (não toca a do chamador).
      const msg = String(err && err.message);
      if (/within a transaction/i.test(msg)) {
        throw erro(
          'TRANSACAO_EXTERNA_ATIVA',
          'A conexão já possui uma transação aberta. O serviço é dono da própria transação; chame-o fora de BEGIN/COMMIT.',
          { statusCode: 409 }
        );
      }
      if (err && (err.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(msg))) {
        throw erro('SALDO_OCUPADO', 'Banco ocupado por outra operação. Tente novamente.', { statusCode: 503 });
      }
      throw err;
    }
    try {
      const resultado = await work();
      await dbRun(db, 'COMMIT');
      return resultado;
    } catch (err) {
      try {
        await dbRun(db, 'ROLLBACK');
      } catch (_) { /* ignora falha de rollback */ }
      throw err;
    }
  });
  filas.set(db, atual);
  return atual;
}

function idPositivo(valor, code, message) {
  const n = Number(valor);
  if (valor == null || valor === '' || typeof valor === 'boolean' || !Number.isInteger(n) || n <= 0) {
    throw erro(code, message);
  }
  return n;
}

async function exigirEmpresa(db, valor) {
  const empresaId = idPositivo(valor, 'EMPRESA_OBRIGATORIA', 'empresaId é obrigatório e deve ser um inteiro positivo.');
  const row = await dbGet(db, 'SELECT id FROM empresas WHERE id = ? LIMIT 1', [empresaId]);
  if (!row) throw erro('EMPRESA_NAO_ENCONTRADA', `Empresa não encontrada: ${empresaId}.`, { empresa_id: empresaId });
  return empresaId;
}

function exigirQuantidadeMl(valor) {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) {
    throw erro('QUANTIDADE_INVALIDA', 'quantidadeMl deve ser um número inteiro de ml estritamente positivo.');
  }
  return valor;
}

function texto(valor, code, message) {
  const t = String(valor == null ? '' : valor).trim();
  if (!t) throw erro(code, message);
  return t;
}

function resolverOperador(params) {
  const temUsuario = params.usuarioId != null && params.usuarioId !== '';
  const sistemica = String(params.origemSistemica == null ? '' : params.origemSistemica).trim();
  if (temUsuario && sistemica) {
    throw erro('OPERADOR_AMBIGUO', 'Informe usuarioId ou origemSistemica, não ambos.');
  }
  if (temUsuario) {
    const usuarioId = idPositivo(params.usuarioId, 'OPERADOR_INVALIDO', 'usuarioId inválido.');
    return { usuarioId, origemSistemica: null, origem: 'MANUAL' };
  }
  if (sistemica) return { usuarioId: null, origemSistemica: sistemica, origem: 'SISTEMA' };
  throw erro('OPERADOR_OBRIGATORIO', 'Informe usuarioId ou origemSistemica.');
}

function resolverReferencia(ref) {
  if (!ref || typeof ref !== 'object') {
    throw erro('REFERENCIA_OBRIGATORIA', 'referencia ({ tipo, id }) é obrigatória.');
  }
  const tipo = String(ref.tipo == null ? '' : ref.tipo).trim();
  const id = String(ref.id == null ? '' : ref.id).trim();
  if (!tipo || !id) throw erro('REFERENCIA_OBRIGATORIA', 'referencia deve conter tipo e id.');
  return { tipo, id };
}

function mapearSaldo(row) {
  if (!row) return null;
  const atual = Number(row.saldo_atual_ml);
  const reservado = Number(row.saldo_reservado_ml);
  return {
    empresaId: Number(row.empresa_id),
    categoriaFiscal: row.categoria_fiscal,
    unidadeBase: row.unidade_base,
    saldoAtualMl: atual,
    saldoReservadoMl: reservado,
    saldoDisponivelMl: atual - reservado,
    estoqueMinimoMl: Number(row.estoque_minimo_ml),
    ativo: Number(row.ativo) === 1
  };
}

function mapearMovimento(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    empresaId: Number(row.empresa_id),
    categoriaFiscal: row.categoria_fiscal,
    tipo: row.tipo,
    direcao: Number(row.direcao),
    quantidadeMl: Number(row.quantidade_ml),
    saldoAnteriorMl: Number(row.saldo_anterior_ml),
    saldoPosteriorMl: Number(row.saldo_posterior_ml),
    origem: row.origem,
    referencia: { tipo: row.referencia_tipo, id: row.referencia_id },
    movimentoEstornadoId: row.movimento_estornado_id == null ? null : Number(row.movimento_estornado_id),
    idempotencyKey: row.idempotency_key,
    usuarioId: row.usuario_id == null ? null : Number(row.usuario_id),
    origemSistemica: row.origem_sistemica || null,
    produtoId: row.produto_id == null ? null : Number(row.produto_id),
    quantidadeOrigem: row.quantidade_origem == null ? null : Number(row.quantidade_origem),
    unidadeOrigem: row.unidade_origem || null,
    motivo: row.motivo,
    metadados: row.metadados_json ? JSON.parse(row.metadados_json) : null,
    createdAt: row.created_at || null
  };
}

async function prepararBase(params, opts, { exigirCategoria = true } = {}) {
  const db = getDb(opts && opts.db);
  await garantirSchemaSaldoFiscalCategoriaAsync(db);
  const empresaId = await exigirEmpresa(db, params.empresaId);
  const categoria = exigirCategoria ? normalizarCategoriaFiscal(params.categoriaFiscal) : null;
  return { db, empresaId, categoria };
}

async function lerSaldoRow(db, empresaId, categoria) {
  return dbGet(
    db,
    'SELECT * FROM saldo_fiscal_categoria_empresa WHERE empresa_id = ? AND categoria_fiscal = ?',
    [empresaId, categoria]
  );
}

/** Cria o saldo zerado, sem movimento e sem abertura implícita. */
async function garantirSaldo(params = {}, opts = {}) {
  const { db, empresaId, categoria } = await prepararBase(params, opts);
  await dbRun(
    db,
    `INSERT OR IGNORE INTO saldo_fiscal_categoria_empresa (empresa_id, categoria_fiscal) VALUES (?, ?)`,
    [empresaId, categoria]
  );
  return mapearSaldo(await lerSaldoRow(db, empresaId, categoria));
}

/** Retorna null quando o saldo não existe (não cria dados na consulta). */
async function obterSaldo(params = {}, opts = {}) {
  const { db, empresaId, categoria } = await prepararBase(params, opts);
  return mapearSaldo(await lerSaldoRow(db, empresaId, categoria));
}

function conferirIdempotencia(existente, esperado) {
  const iguais =
    existente.tipo === esperado.tipo
    && existente.categoria_fiscal === esperado.categoria
    && Number(existente.quantidade_ml) === esperado.quantidadeMl
    && existente.referencia_tipo === esperado.referencia.tipo
    && existente.referencia_id === esperado.referencia.id
    && existente.motivo === esperado.motivo
    && (existente.usuario_id == null ? null : Number(existente.usuario_id)) === esperado.operador.usuarioId
    && (existente.origem_sistemica || null) === esperado.operador.origemSistemica
    && (existente.movimento_estornado_id == null ? null : Number(existente.movimento_estornado_id))
      === (esperado.movimentoEstornadoId == null ? null : esperado.movimentoEstornadoId)
    && (existente.produto_id == null ? null : Number(existente.produto_id))
      === (esperado.conversao ? Number(esperado.conversao.produtoId) : null)
    && (existente.quantidade_origem == null ? null : Number(existente.quantidade_origem))
      === (esperado.conversao ? Number(esperado.conversao.quantidadeOrigem) : null)
    && (existente.unidade_origem || null)
      === (esperado.conversao ? String(esperado.conversao.unidadeOrigem) : null);
  if (!iguais) {
    throw erro('IDEMPOTENCY_CONFLITO', 'idempotencyKey já utilizada com dados diferentes.', {
      statusCode: 409,
      movimento_id: Number(existente.id)
    });
  }
}

function validarConversao(conversao, quantidadeMl) {
  if (conversao == null) return null;
  if (
    typeof conversao !== 'object'
    || !Number.isInteger(Number(conversao.produtoId))
    || Number(conversao.quantidadeMl) !== quantidadeMl
  ) {
    throw erro('CONVERSAO_INCONSISTENTE', 'conversao deve ser o resultado de converterParaMl com a mesma quantidadeMl.');
  }
  return conversao;
}

/**
 * Núcleo único das operações que alteram saldo. Executa tudo em uma transação:
 * idempotência -> validações -> UPDATE condicional do saldo -> INSERT do movimento.
 */
async function aplicarMovimento(ctx) {
  const {
    db, empresaId, categoria, tipo, quantidadeMl, operador, motivo, referencia,
    idempotencyKey, estornoDe = null, conversao = null
  } = ctx;

  return executarEmTransacao(db, async () => {
    const existente = await dbGet(
      db,
      'SELECT * FROM saldo_fiscal_categoria_movimentos WHERE empresa_id = ? AND idempotency_key = ?',
      [empresaId, idempotencyKey]
    );

    let direcao = tipo === TipoMovimento.AJUSTE_SAIDA ? -1 : 1;
    let qtd = quantidadeMl;
    let originalId = null;

    if (tipo === TipoMovimento.ESTORNO) {
      const original = await dbGet(
        db,
        'SELECT * FROM saldo_fiscal_categoria_movimentos WHERE id = ? AND empresa_id = ?',
        [estornoDe, empresaId]
      );
      if (!original) {
        throw erro('MOVIMENTO_NAO_ENCONTRADO', 'Movimento a estornar não encontrado para esta empresa.', { statusCode: 404 });
      }
      if (original.categoria_fiscal !== categoria) {
        throw erro('MOVIMENTO_OUTRA_CATEGORIA', 'O movimento pertence a outra categoria fiscal.');
      }
      originalId = Number(original.id);
      direcao = -Number(original.direcao);
      qtd = Number(original.quantidade_ml);
    }

    if (existente) {
      conferirIdempotencia(existente, {
        tipo, categoria, quantidadeMl: qtd,         referencia, motivo, operador, movimentoEstornadoId: originalId, conversao
      });
      return {
        idempotente: true,
        movimento: mapearMovimento(existente),
        saldo: mapearSaldo(await lerSaldoRow(db, empresaId, categoria))
      };
    }

    if (tipo === TipoMovimento.ESTORNO) {
      const original = await dbGet(db, 'SELECT tipo FROM saldo_fiscal_categoria_movimentos WHERE id = ?', [originalId]);
      if (original.tipo === TipoMovimento.ESTORNO || original.tipo === TipoMovimento.ABERTURA) {
        throw erro('MOVIMENTO_NAO_ESTORNAVEL', `Movimentos do tipo ${original.tipo} não podem ser estornados; use um ajuste.`);
      }
      const jaEstornado = await dbGet(
        db,
        'SELECT id FROM saldo_fiscal_categoria_movimentos WHERE movimento_estornado_id = ?',
        [originalId]
      );
      if (jaEstornado) {
        throw erro('ESTORNO_DUPLICADO', 'Este movimento já foi estornado.', { statusCode: 409, estorno_id: Number(jaEstornado.id) });
      }
    }

    if (tipo === TipoMovimento.ABERTURA) {
      const qualquer = await dbGet(
        db,
        'SELECT tipo FROM saldo_fiscal_categoria_movimentos WHERE empresa_id = ? AND categoria_fiscal = ? ORDER BY id LIMIT 1',
        [empresaId, categoria]
      );
      if (qualquer) {
        throw erro(
          qualquer.tipo === TipoMovimento.ABERTURA ? 'ABERTURA_JA_REGISTRADA' : 'ABERTURA_APOS_MOVIMENTOS',
          qualquer.tipo === TipoMovimento.ABERTURA
            ? 'Já existe abertura para esta empresa e categoria.'
            : 'A abertura deve ser o primeiro movimento do saldo.',
          { statusCode: 409 }
        );
      }
      await dbRun(
        db,
        'INSERT OR IGNORE INTO saldo_fiscal_categoria_empresa (empresa_id, categoria_fiscal) VALUES (?, ?)',
        [empresaId, categoria]
      );
    }

    const saldo = await lerSaldoRow(db, empresaId, categoria);
    if (!saldo) {
      throw erro('SALDO_NAO_ENCONTRADO', 'Saldo não inicializado para esta empresa e categoria.', { statusCode: 404 });
    }
    if (Number(saldo.ativo) !== 1) {
      throw erro('SALDO_INATIVO', 'Saldo inativo: movimentos não são permitidos.');
    }

    const anterior = Number(saldo.saldo_atual_ml);
    const reservado = Number(saldo.saldo_reservado_ml);
    const posterior = anterior + direcao * qtd;
    if (posterior < reservado || posterior < 0) {
      throw erro('SALDO_INSUFICIENTE', 'Saldo disponível insuficiente para a operação.', {
        statusCode: 409,
        saldo_disponivel_ml: anterior - reservado,
        quantidade_ml: qtd
      });
    }

    const upd = await dbRun(
      db,
      `UPDATE saldo_fiscal_categoria_empresa
          SET saldo_atual_ml = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND saldo_atual_ml = ? AND saldo_reservado_ml = ? AND ativo = 1`,
      [posterior, saldo.id, anterior, reservado]
    );
    if (upd.changes !== 1) {
      throw erro('SALDO_CONFLITO_CONCORRENCIA', 'O saldo foi alterado por outra operação. Tente novamente.', { statusCode: 409 });
    }

    let ins;
    try {
      ins = await dbRun(
        db,
        `INSERT INTO saldo_fiscal_categoria_movimentos
           (empresa_id, categoria_fiscal, tipo, direcao, quantidade_ml, saldo_anterior_ml, saldo_posterior_ml,
            origem, referencia_tipo, referencia_id, movimento_estornado_id, idempotency_key,
            usuario_id, origem_sistemica, produto_id, quantidade_origem, unidade_origem, motivo, metadados_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          empresaId, categoria, tipo, direcao, qtd, anterior, posterior,
          operador.origem, referencia.tipo, referencia.id, originalId, idempotencyKey,
          operador.usuarioId, operador.origemSistemica,
          conversao ? Number(conversao.produtoId) : null,
          conversao ? Number(conversao.quantidadeOrigem) : null,
          conversao ? String(conversao.unidadeOrigem) : null,
          motivo,
          conversao ? JSON.stringify({ conversao }) : null
        ]
      );
    } catch (err) {
      if (/uq_saldo_fiscal_mov_estorno|movimento_estornado_id/.test(String(err.message))) {
        throw erro('ESTORNO_DUPLICADO', 'Este movimento já foi estornado.', { statusCode: 409 });
      }
      throw err;
    }

    const movimento = await dbGet(db, 'SELECT * FROM saldo_fiscal_categoria_movimentos WHERE id = ?', [ins.lastID]);
    return {
      idempotente: false,
      movimento: mapearMovimento(movimento),
      saldo: mapearSaldo(await lerSaldoRow(db, empresaId, categoria))
    };
  });
}

function dadosComuns(params) {
  return {
    operador: resolverOperador(params),
    motivo: texto(params.motivo, 'MOTIVO_OBRIGATORIO', 'motivo é obrigatório.'),
    referencia: resolverReferencia(params.referencia),
    idempotencyKey: texto(params.idempotencyKey, 'IDEMPOTENCY_KEY_OBRIGATORIA', 'idempotencyKey é obrigatória.')
  };
}

async function registrarAbertura(params = {}, opts = {}) {
  if (params.confirmado !== true) {
    throw erro('CONFIRMACAO_OBRIGATORIA', 'A abertura exige confirmado: true (valor conferido e autorizado).');
  }
  const { db, empresaId, categoria } = await prepararBase(params, opts);
  const quantidadeMl = exigirQuantidadeMl(params.quantidadeMl);
  const comuns = dadosComuns(params);
  return aplicarMovimento({
    db, empresaId, categoria, tipo: TipoMovimento.ABERTURA, quantidadeMl,
    conversao: validarConversao(params.conversao, quantidadeMl), ...comuns
  });
}

async function ajustar(params = {}, opts = {}) {
  const tipo = String(params.tipo || '').trim().toUpperCase();
  if (tipo !== TipoMovimento.AJUSTE_ENTRADA && tipo !== TipoMovimento.AJUSTE_SAIDA) {
    throw erro('TIPO_AJUSTE_INVALIDO', 'tipo deve ser AJUSTE_ENTRADA ou AJUSTE_SAIDA.');
  }
  const { db, empresaId, categoria } = await prepararBase(params, opts);
  const quantidadeMl = exigirQuantidadeMl(params.quantidadeMl);
  const comuns = dadosComuns(params);
  return aplicarMovimento({
    db, empresaId, categoria, tipo, quantidadeMl,
    conversao: validarConversao(params.conversao, quantidadeMl), ...comuns
  });
}

async function estornar(params = {}, opts = {}) {
  const { db, empresaId, categoria } = await prepararBase(params, opts);
  const movimentoId = idPositivo(params.movimentoId, 'MOVIMENTO_INVALIDO', 'movimentoId inválido.');
  const comuns = dadosComuns(params);
  return aplicarMovimento({
    db, empresaId, categoria, tipo: TipoMovimento.ESTORNO, quantidadeMl: null, estornoDe: movimentoId, ...comuns
  });
}

async function listarMovimentos(params = {}, opts = {}) {
  const { db, empresaId, categoria } = await prepararBase(params, opts);
  const rows = await new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM saldo_fiscal_categoria_movimentos WHERE empresa_id = ? AND categoria_fiscal = ? ORDER BY id',
      [empresaId, categoria],
      (err, r) => (err ? reject(err) : resolve(r || []))
    );
  });
  return rows.map(mapearMovimento);
}

function mesmaRelacao(rel, etapa) {
  return (rel.de === etapa.de && rel.para === etapa.para) || (rel.de === etapa.para && rel.para === etapa.de);
}

/**
 * Adaptador sobre o MUC: converte a quantidade do produto para ML usando as relações cadastradas
 * (e, opcionalmente, apresentações informadas pelo chamador). Não grava nada.
 * O MUC escolhe o menor caminho sem detectar ambiguidade; aqui cada relação do caminho é removida e a
 * conversão é repetida no próprio MUC: resultado diferente => CONVERSAO_AMBIGUA.
 */
async function converterParaMl(params = {}, opts = {}) {
  const db = getDb(opts.db);
  const produtoId = idPositivo(params.produtoId, 'PRODUTO_INVALIDO', 'produtoId inválido.');
  const quantidade = Number(params.quantidade);
  if (typeof params.quantidade === 'boolean' || !(quantidade > 0) || !Number.isFinite(quantidade)) {
    throw erro('QUANTIDADE_INVALIDA', 'quantidade deve ser positiva.');
  }
  const unidade = String(params.unidade == null ? '' : params.unidade).trim().toUpperCase();
  if (!unidade) throw erro('UNIDADE_INVALIDA', 'unidade de origem é obrigatória.');

  let config;
  try {
    config = await obterConfiguracao(db, produtoId);
  } catch (e) {
    throw erro(e.code || 'PRODUTO_INVALIDO', e.message, { statusCode: e.statusCode || 400 });
  }
  const muc = obterMuc(db);
  const relacoes = montarRelacoesMuc(params.apresentacoes || [], config.relacoes || []);
  const usaConversao = Number(config.utiliza_conversao) === 1;

  const converter = (lista) => muc.converterQuantidade({
    quantidade, unidadeOrigem: unidade, unidadeDestino: UNIDADE_BASE, relacoes: lista
  });

  if (!usaConversao && unidade !== UNIDADE_BASE) {
    throw erro(
      'CONVERSAO_NAO_DISPONIVEL',
      `O produto não utiliza conversão: não há relação cadastrada para converter ${unidade} em ${UNIDADE_BASE}.`
    );
  }

  let resultado;
  try {
    resultado = converter(usaConversao ? relacoes : []);
  } catch (e) {
    throw erro(e.code || CODIGOS.CONVERSAO_INVALIDA, e.message);
  }

  if (usaConversao) {
    for (const etapa of resultado.caminho) {
      if (etapa.origem === 'SI') continue;
      const restantes = relacoes.filter((r) => !mesmaRelacao(r, etapa));
      let alternativa = null;
      try {
        alternativa = converter(restantes);
      } catch (_) {
        alternativa = null;
      }
      if (alternativa) {
        const dif = Math.abs(alternativa.quantidade - resultado.quantidade);
        if (dif > TOLERANCIA_AMBIGUIDADE * Math.max(1, Math.abs(resultado.quantidade))) {
          throw erro(
            'CONVERSAO_AMBIGUA',
            `Existem caminhos de conversão distintos de ${unidade} para ${UNIDADE_BASE} com resultados diferentes.`
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
    produtoId,
    quantidadeOrigem: quantidade,
    unidadeOrigem: unidade,
    unidadeDestino: UNIDADE_BASE,
    quantidadeMl: resultado.quantidade,
    fatorTotal: resultado.fatorTotal,
    caminho: resultado.caminho.map((e) => ({ de: e.de, para: e.para, fator: e.fator, origem: e.origem }))
  };
}

module.exports = {
  UNIDADE_BASE,
  TipoMovimento,
  garantirSaldo,
  obterSaldo,
  registrarAbertura,
  ajustar,
  estornar,
  listarMovimentos,
  converterParaMl,
  // Reuso interno (Sprint 2D): mesma fila/estratégia de lock por conexão e mesmos validadores.
  internos: {
    erro, dbGet, dbRun, executarEmTransacao, idPositivo, texto,
    resolverOperador, resolverReferencia, exigirQuantidadeMl, exigirEmpresa, lerSaldoRow, mapearSaldo
  }
};
