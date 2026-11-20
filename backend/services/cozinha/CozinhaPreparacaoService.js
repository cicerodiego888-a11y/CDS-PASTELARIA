/**
 * CozinhaPreparacaoService — Sprint 03 (+ auditoria) / Sprint 05 (operações homologadas)
 * Motor de preparação: iniciar, pronto, entrega de bebida, estado derivado da rodada.
 * Idempotência via tabela central cozinha_idempotencia (não só outbox).
 * Sprint 05: reforço de integridade item↔rodada↔comanda↔unidade sem duplicar o motor.
 */
'use strict';

const {
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../utils/cozinhaSchema');
const {
  decimalParaMilessimos,
  milessimosParaDecimalString,
  subtrairMilessimos
} = require('./cozinhaQuantidade');
const {
  TIPOS_OPERACAO,
  calcularHashOperacao
} = require('./cozinhaIdempotenciaHash');
const { exigirUnidadeOperacional } = require('./cozinhaUnidadeOperacional');

const EVENTOS = Object.freeze({
  PREPARACAO_INICIADA: 'PREPARACAO_INICIADA',
  PREPARACAO_REVERTIDA: 'PREPARACAO_REVERTIDA',
  ITEM_PRONTO: 'ITEM_PRONTO',
  BEBIDA_ENTREGUE: 'BEBIDA_ENTREGUE',
  RODADA_PRONTA: 'RODADA_PRONTA',
  RETIRADA_CONFIRMADA: 'RETIRADA_CONFIRMADA'
});
const filasTransacao = new WeakMap();

function erro(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

function conn(opts) {
  return (opts && opts.db) || require('../../database');
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function timestampUtc(db) {
  const row = await get(db, `
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS agora
  `);
  if (!row || typeof row.agora !== 'string' || !row.agora) {
    throw erro('Não foi possível obter o horário UTC do banco.', 500, 'HORARIO_UTC_INDISPONIVEL');
  }
  return row.agora;
}

async function beginImmediate(db) {
  await run(db, 'BEGIN IMMEDIATE');
}

async function commit(db) {
  await run(db, 'COMMIT');
}

async function rollback(db) {
  try {
    await run(db, 'ROLLBACK');
  } catch (_e) { /* já desfeita */ }
}

function serializarTransacao(db, trabalho) {
  const anterior = filasTransacao.get(db) || Promise.resolve();
  const atual = anterior.then(trabalho, trabalho);
  filasTransacao.set(db, atual.then(() => undefined, () => undefined));
  return atual;
}

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return n;
}

function exigirOperador(operadorId) {
  const n = Number(operadorId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Sessão sem operador.', 401, 'SESSAO_INVALIDA');
  }
  return n;
}

function exigirId(valor, codigo, mensagem) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro(mensagem, 400, codigo);
  }
  return n;
}

function exigirChave(chave) {
  if (chave == null || String(chave).trim() === '') {
    throw erro('Idempotency-Key é obrigatória.', 400, 'IDEMPOTENCY_REQUIRED');
  }
  const texto = String(chave).trim();
  if (texto.length > 200) {
    throw erro('Idempotency-Key inválida.', 400, 'CHAVE_IDEMPOTENCIA_INVALIDA');
  }
  return texto;
}

function garantirOperacional(opts) {
  if (!isCozinhaOperacional() && !(opts && opts.db)) {
    const st = getCozinhaSchemaStatus();
    throw erro(
      (st.erro && st.erro.mensagem) || 'Módulo Cozinha não operacional.',
      503,
      'COZINHA_NAO_OPERACIONAL',
      { detalhes: st }
    );
  }
}

/**
 * Claim na tabela central cozinha_idempotencia.
 * @returns {{ replay: true, corpo: object } | { replay: false }}
 */
async function claimIdempotenciaCentral(db, {
  idempotencyKey,
  tipoOperacao,
  hash,
  contexto
}) {
  const existente = await get(db, `
    SELECT * FROM cozinha_idempotencia WHERE idempotency_key = ?
  `, [idempotencyKey]);

  if (existente) {
    if (String(existente.tipo_operacao) !== String(tipoOperacao)) {
      throw erro(
        'Idempotency-Key já utilizada em outra operação.',
        409,
        'IDEMPOTENCY_OPERACAO_DIVERGENTE'
      );
    }
    if (String(existente.payload_hash) !== String(hash)) {
      throw erro(
        'Idempotency-Key reutilizada com payload diferente.',
        409,
        'IDEMPOTENCY_PAYLOAD_DIVERGENTE'
      );
    }
    if (existente.situacao === 'CONCLUIDA' && existente.resultado_json) {
      return { replay: true, corpo: JSON.parse(existente.resultado_json) };
    }
    if (existente.situacao === 'EM_ANDAMENTO') {
      throw erro(
        'Operação em andamento para esta chave.',
        409,
        'IDEMPOTENCY_EM_ANDAMENTO'
      );
    }
  }

  try {
    await run(db, `
      INSERT INTO cozinha_idempotencia (
        idempotency_key, tipo_operacao, contexto, payload_hash, situacao
      ) VALUES (?, ?, ?, ?, 'EM_ANDAMENTO')
    `, [idempotencyKey, tipoOperacao, contexto || null, hash]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) {
      const novamente = await get(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key = ?
      `, [idempotencyKey]);
      if (
        novamente
        && novamente.situacao === 'CONCLUIDA'
        && String(novamente.payload_hash) === String(hash)
        && String(novamente.tipo_operacao) === String(tipoOperacao)
        && novamente.resultado_json
      ) {
        return { replay: true, corpo: JSON.parse(novamente.resultado_json) };
      }
      throw erro(
        'Conflito de idempotência sob concorrência.',
        409,
        'IDEMPOTENCY_CONCORRENTE'
      );
    }
    throw e;
  }

  return { replay: false };
}

async function concluirIdempotencia(db, {
  idempotencyKey,
  resultado,
  httpStatus,
  recursoTipo,
  recursoId
}) {
  await run(db, `
    UPDATE cozinha_idempotencia
    SET situacao = 'CONCLUIDA',
        resultado_http_status = ?,
        resultado_json = ?,
        recurso_tipo = ?,
        recurso_id = ?,
        concluded_at = datetime('now')
    WHERE idempotency_key = ?
  `, [
    httpStatus,
    JSON.stringify(resultado),
    recursoTipo || null,
    recursoId != null ? Number(recursoId) : null,
    idempotencyKey
  ]);
}

async function registrarEventoOutbox(db, {
  empresaId,
  unidadeId,
  tipo,
  payload,
  idempotencyKey
}) {
  try {
    await run(db, `
      INSERT INTO cozinha_eventos_outbox (
        empresa_id, unidade_id, tipo, payload_json, idempotency_key
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      empresaId,
      unidadeId || null,
      tipo,
      JSON.stringify(payload),
      idempotencyKey
    ]);
    return { novo: true };
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) {
      return { novo: false };
    }
    throw e;
  }
}

async function carregarItemEmpresa(db, itemId, empresaId) {
  const item = await get(db, `
    SELECT * FROM cozinha_itens WHERE id = ? AND empresa_id = ?
  `, [itemId, empresaId]);
  if (!item) {
    throw erro('Item de cozinha não encontrado.', 404, 'ITEM_NAO_ENCONTRADO');
  }
  return item;
}

async function carregarRodadaEmpresa(db, rodadaId, empresaId) {
  const rodada = await get(db, `
    SELECT * FROM cozinha_rodadas WHERE id = ? AND empresa_id = ?
  `, [rodadaId, empresaId]);
  if (!rodada) {
    throw erro('Rodada não encontrada.', 404, 'RODADA_NAO_ENCONTRADA');
  }
  return rodada;
}

async function validarUnidadeAtivaDaEmpresa(db, empresaId, unidadeId) {
  const unidade = await get(db, `
    SELECT id, ativo FROM cozinha_unidades
    WHERE id = ? AND empresa_id = ?
  `, [unidadeId, empresaId]);
  if (!unidade) {
    throw erro('Unidade de cozinha não pertence à empresa autorizada.', 403, 'UNIDADE_NAO_AUTORIZADA');
  }
  if (Number(unidade.ativo) !== 1) {
    throw erro('Unidade de cozinha inativa.', 403, 'UNIDADE_INATIVA');
  }
  return unidade;
}

function exigirRodadaNaoCancelada(rodada) {
  if (rodada.estado_preparacao === 'CANCELADA') {
    throw erro(
      'Rodada cancelada — operação de preparação não permitida.',
      409,
      'RODADA_CANCELADA'
    );
  }
  return rodada;
}

/**
 * Garante vínculo item ↔ rodada ↔ unidade ↔ comanda na mesma empresa.
 * unidadeIdAutorizada é obrigatória (origem: sessão autenticada via rota).
 */
async function validarIntegridadeOperacional(db, item, rodada, {
  empresaId,
  unidadeIdAutorizada
}) {
  if (Number(item.rodada_id) !== Number(rodada.id)) {
    throw erro('Item não pertence à rodada informada.', 409, 'ITEM_RODADA_INCOMPATIVEL');
  }
  if (Number(item.empresa_id) !== Number(empresaId)
    || Number(rodada.empresa_id) !== Number(empresaId)) {
    throw erro('Isolamento empresarial violado.', 403, 'EMPRESA_ISOLAMENTO');
  }
  if (Number(item.unidade_id) !== Number(rodada.unidade_id)) {
    throw erro(
      'Item e rodada com unidades divergentes.',
      409,
      'ITEM_UNIDADE_INCOMPATIVEL'
    );
  }

  const unidadeId = exigirUnidadeOperacional(unidadeIdAutorizada);
  if (unidadeId !== Number(item.unidade_id)) {
    throw erro(
      'Item não pertence à unidade operacional autorizada.',
      409,
      'UNIDADE_ISOLAMENTO'
    );
  }
  await validarUnidadeAtivaDaEmpresa(db, empresaId, unidadeId);

  const comanda = await get(db, `
    SELECT id, empresa_id, atendimento_id, pedido_id
    FROM cozinha_comandas
    WHERE id = ? AND empresa_id = ?
  `, [item.comanda_id, empresaId]);
  if (!comanda) {
    throw erro('Comanda do item não encontrada.', 409, 'COMANDA_ITEM_INEXISTENTE');
  }
  if (Number(rodada.atendimento_id) !== Number(comanda.atendimento_id)) {
    throw erro(
      'Comanda e rodada com atendimentos divergentes.',
      409,
      'COMANDA_RODADA_INCOMPATIVEL'
    );
  }
  if (Number(item.pedido_id) !== Number(comanda.pedido_id)) {
    throw erro(
      'Item e comanda pertencem a pedidos diferentes.',
      409,
      'ITEM_PEDIDO_INCOMPATIVEL'
    );
  }
  const pedido = await get(db, `
    SELECT id FROM pedidos WHERE id = ? AND empresa_id = ?
  `, [item.pedido_id, empresaId]);
  if (!pedido) {
    throw erro('Pedido do item não pertence à empresa autorizada.', 403, 'PEDIDO_ITEM_ISOLAMENTO');
  }

  return { comanda, unidadeId };
}

async function carregarItensRodada(db, rodadaId, empresaId) {
  return all(db, `
    SELECT * FROM cozinha_itens
    WHERE rodada_id = ? AND empresa_id = ?
    ORDER BY id
  `, [rodadaId, empresaId]);
}

async function carregarRodadaProntaEm(db, rodada) {
  const evento = await get(db, `
    SELECT
      CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.em')
        ELSE NULL
      END AS em,
      created_at
    FROM cozinha_eventos_outbox
    WHERE empresa_id = ?
      AND unidade_id = ?
      AND tipo = 'RODADA_PRONTA'
      AND CAST(CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.rodada_id')
        ELSE NULL
      END AS INTEGER) = ?
    ORDER BY id DESC
    LIMIT 1
  `, [rodada.empresa_id, rodada.unidade_id, rodada.id]);
  return evento ? (evento.em || evento.created_at || null) : null;
}

async function carregarIngredientesItem(db, cozinhaItemId) {
  return all(db, `
    SELECT id, cozinha_item_id, insumo_id, insumo_nome_snapshot,
           quantidade_snapshot_millis, unidade_snapshot,
           classificacao_comercial_snapshot, selecionado,
           preco_adicional_snapshot_millis
    FROM cozinha_item_ingredientes
    WHERE cozinha_item_id = ?
    ORDER BY id
  `, [cozinhaItemId]);
}

async function qtyBebidaEntregue(db, cozinhaItemId, empresaId) {
  const row = await get(db, `
    SELECT COALESCE(SUM(qty_entregue_millis), 0) AS total
    FROM cozinha_bebida_entregas
    WHERE cozinha_item_id = ? AND empresa_id = ?
  `, [cozinhaItemId, empresaId]);
  return Number(row && row.total) || 0;
}

/**
 * Bloqueadores da rodada:
 * - Com PASTEL: só pastéis precisam estar PRONTO.
 * - Sem PASTEL: OUTROs precisam estar PRONTO.
 * - BEBIDA nunca bloqueia.
 */
function avaliarConclusaoRodada(itens) {
  const lista = itens || [];
  const pastels = lista.filter((i) => i.tipo_item === 'PASTEL' && i.estado_preparacao !== 'CANCELADO');
  const outros = lista.filter((i) => i.tipo_item === 'OUTRO' && i.estado_preparacao !== 'CANCELADO');

  if (pastels.length > 0) {
    const pendentes = pastels.filter((i) => i.estado_preparacao !== 'PRONTO');
    return {
      pronta: pendentes.length === 0,
      regra: 'PASTEIS_OBRIGATORIOS',
      pendentes: pendentes.map((i) => i.id)
    };
  }

  const pendentesOutro = outros.filter((i) => i.estado_preparacao !== 'PRONTO');
  return {
    pronta: pendentesOutro.length === 0,
    regra: 'OUTROS_SEM_PASTEL',
    pendentes: pendentesOutro.map((i) => i.id)
  };
}

async function sincronizarEstadoRodada(db, rodada, itens, {
  empresaId,
  operadorId,
  idempotencyKeyBase,
  transicaoEm
}) {
  // Rodada cancelada: nunca reabrir / não alterar estado.
  if (rodada.estado_preparacao === 'CANCELADA') {
    return {
      estado_preparacao: 'CANCELADA',
      avaliacao: avaliarConclusaoRodada(itens),
      eventoRodada: null,
      bloqueada: true
    };
  }

  const avaliacao = avaliarConclusaoRodada(itens);
  let estado = rodada.estado_preparacao;
  let eventoRodada = null;

  if (avaliacao.pronta) {
    if (estado !== 'PRONTA') {
      const prontaEm = transicaoEm || await timestampUtc(db);
      await run(db, `
        UPDATE cozinha_rodadas
        SET estado_preparacao = 'PRONTA', updated_at = ?
        WHERE id = ? AND empresa_id = ? AND estado_preparacao <> 'CANCELADA'
      `, [prontaEm, rodada.id, empresaId]);
      const conf = await get(db, `
        SELECT estado_preparacao FROM cozinha_rodadas WHERE id = ? AND empresa_id = ?
      `, [rodada.id, empresaId]);
      if (conf && conf.estado_preparacao === 'CANCELADA') {
        return {
          estado_preparacao: 'CANCELADA',
          avaliacao,
          eventoRodada: null,
          bloqueada: true
        };
      }
      estado = 'PRONTA';
      const ev = await registrarEventoOutbox(db, {
        empresaId,
        unidadeId: rodada.unidade_id,
        tipo: EVENTOS.RODADA_PRONTA,
        idempotencyKey: `${idempotencyKeyBase}:RODADA_PRONTA:${rodada.id}`,
        payload: {
          rodada_id: rodada.id,
          empresa_id: empresaId,
          operador_id: operadorId,
          regra: avaliacao.regra,
          em: prontaEm,
          nota: 'PRONTA refere-se à preparação; não confirma entrega de bebidas ao cliente.'
        }
      });
      eventoRodada = { tipo: EVENTOS.RODADA_PRONTA, novo: ev.novo };
    }
  } else if (estado === 'AGUARDANDO') {
    const algumAndamento = itens.some((i) => (
      i.estado_preparacao === 'EM_PREPARACAO' || i.estado_preparacao === 'PRONTO'
    ));
    if (algumAndamento) {
      const em = transicaoEm || await timestampUtc(db);
      await run(db, `
        UPDATE cozinha_rodadas
        SET estado_preparacao = 'EM_PREPARACAO', updated_at = ?
        WHERE id = ? AND empresa_id = ? AND estado_preparacao = 'AGUARDANDO'
      `, [em, rodada.id, empresaId]);
      const conf = await get(db, `
        SELECT estado_preparacao FROM cozinha_rodadas WHERE id = ? AND empresa_id = ?
      `, [rodada.id, empresaId]);
      estado = conf ? conf.estado_preparacao : estado;
    }
  }

  return { estado_preparacao: estado, avaliacao, eventoRodada, bloqueada: false };
}

function dtoItem(item, extras = {}) {
  return {
    id: item.id,
    empresa_id: item.empresa_id,
    rodada_id: item.rodada_id,
    comanda_id: item.comanda_id,
    pedido_id: item.pedido_id,
    pedido_item_id: item.pedido_item_id,
    tipo_item: item.tipo_item,
    estado_preparacao: item.estado_preparacao,
    qty_solicitada: milessimosParaDecimalString(item.qty_solicitada_millis),
    qty_preparada: milessimosParaDecimalString(item.qty_preparada_millis || 0),
    qty_cancelada: milessimosParaDecimalString(item.qty_cancelada_millis || 0),
    produto_id: item.produto_id,
    produto_nome_snapshot: item.produto_nome_snapshot,
    ...extras
  };
}

async function iniciarPreparacao(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const itemId = exigirId(entrada.itemId, 'ITEM_INVALIDO', 'item_id inválido.');
  const idempotencyKey = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);

  const hash = calcularHashOperacao(TIPOS_OPERACAO.PREPARACAO_INICIADA, {
    empresa_id: empresaId,
    item_id: itemId,
    responsavel_operador_id: operadorId
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const item = await carregarItemEmpresa(db, itemId, empresaId);
      const rodada = exigirRodadaNaoCancelada(
        await carregarRodadaEmpresa(db, item.rodada_id, empresaId)
      );
      await validarIntegridadeOperacional(db, item, rodada, {
        empresaId,
        unidadeIdAutorizada: entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId
      });
      const claim = await claimIdempotenciaCentral(db, {
        idempotencyKey,
        tipoOperacao: TIPOS_OPERACAO.PREPARACAO_INICIADA,
        hash,
        contexto: JSON.stringify({ empresa_id: empresaId, item_id: itemId })
      });
      if (claim.replay) {
        await commit(db);
        return { ...claim.corpo, repetida: true };
      }

      if (item.estado_preparacao === 'CANCELADO') {
        throw erro('Item cancelado.', 409, 'ITEM_CANCELADO');
      }
      if (item.estado_preparacao === 'EM_PREPARACAO') {
        const resposta = {
          success: true,
          repetida: true,
          ja_em_preparacao: true,
          operador_id: null,
          iniciado_em: null,
          item: dtoItem(item),
          rodada: { id: rodada.id, estado_preparacao: rodada.estado_preparacao },
          evento: EVENTOS.PREPARACAO_INICIADA
        };
        await concluirIdempotencia(db, {
          idempotencyKey,
          resultado: resposta,
          httpStatus: 200,
          recursoTipo: 'cozinha_item',
          recursoId: itemId
        });
        await commit(db);
        return resposta;
      }
      if (item.estado_preparacao !== 'AGUARDANDO') {
        throw erro('Transição de preparação inválida.', 409, 'TRANSICAO_INVALIDA');
      }

      const iniciadoEm = await timestampUtc(db);
      const atualizado = await run(db, `
        UPDATE cozinha_itens
        SET estado_preparacao = 'EM_PREPARACAO', updated_at = ?
        WHERE id = ? AND empresa_id = ? AND estado_preparacao = 'AGUARDANDO'
      `, [iniciadoEm, itemId, empresaId]);
      if (atualizado.changes !== 1) {
        throw erro('O estado do item mudou durante o início do preparo.', 409, 'TRANSICAO_CONCORRENTE');
      }
      const itemAtual = await carregarItemEmpresa(db, itemId, empresaId);
      const itens = await carregarItensRodada(db, rodada.id, empresaId);
      const sync = await sincronizarEstadoRodada(db, rodada, itens, {
        empresaId,
        operadorId,
        idempotencyKeyBase: idempotencyKey,
        transicaoEm: iniciadoEm
      });

      const resposta = {
        success: true,
        repetida: false,
        ja_em_preparacao: false,
        operador_id: operadorId,
        iniciado_em: iniciadoEm,
        item: dtoItem(itemAtual),
        rodada: {
          id: rodada.id,
          estado_preparacao: sync.estado_preparacao
        },
        evento: EVENTOS.PREPARACAO_INICIADA
      };

      await registrarEventoOutbox(db, {
        empresaId,
        unidadeId: item.unidade_id,
        tipo: EVENTOS.PREPARACAO_INICIADA,
        idempotencyKey: `${idempotencyKey}:EVENTO`,
        payload: resposta
      });

      await concluirIdempotencia(db, {
        idempotencyKey,
        resultado: resposta,
        httpStatus: 200,
        recursoTipo: 'cozinha_item',
        recursoId: itemId
      });

      if (opts.simularFalha === 'antes_commit') {
        throw erro('Falha simulada antes do commit.', 500, 'FALHA_SIMULADA');
      }

      await commit(db);
      return resposta;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function voltarParaAguardando(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const itemId = exigirId(entrada.itemId, 'ITEM_INVALIDO', 'item_id inválido.');
  const idempotencyKey = exigirChave(entrada.idempotencyKey);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId
  );
  const db = conn(opts);
  const hash = calcularHashOperacao(TIPOS_OPERACAO.PREPARACAO_REVERTIDA, {
    empresa_id: empresaId,
    unidade_id: unidadeId,
    item_id: itemId,
    responsavel_operador_id: operadorId
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const item = await carregarItemEmpresa(db, itemId, empresaId);
      const rodada = exigirRodadaNaoCancelada(
        await carregarRodadaEmpresa(db, item.rodada_id, empresaId)
      );
      await validarIntegridadeOperacional(db, item, rodada, {
        empresaId,
        unidadeIdAutorizada: unidadeId
      });
      const claim = await claimIdempotenciaCentral(db, {
        idempotencyKey,
        tipoOperacao: TIPOS_OPERACAO.PREPARACAO_REVERTIDA,
        hash,
        contexto: JSON.stringify({ empresa_id: empresaId, unidade_id: unidadeId, item_id: itemId })
      });
      if (claim.replay) {
        await commit(db);
        return { ...claim.corpo, repetida: true };
      }
      if (rodada.retirada_estado !== 'PENDENTE'
        || rodada.retirada_em != null || rodada.retirada_por != null) {
        throw erro('Não é permitido alterar uma rodada retirada ou em retirada.', 409, 'RETIRADA_ESTADO_INVALIDO');
      }
      if (item.estado_preparacao !== 'EM_PREPARACAO') {
        throw erro('Só é possível retornar itens em preparação.', 409, 'TRANSICAO_INVALIDA');
      }
      const revertidoEm = await timestampUtc(db);
      const atualizado = await run(db, `
        UPDATE cozinha_itens SET estado_preparacao = 'AGUARDANDO', updated_at = ?
        WHERE id = ? AND empresa_id = ? AND estado_preparacao = 'EM_PREPARACAO'
      `, [revertidoEm, itemId, empresaId]);
      if (atualizado.changes !== 1) {
        throw erro('O estado do item mudou durante o retorno.', 409, 'TRANSICAO_CONCORRENTE');
      }

      const itens = await carregarItensRodada(db, rodada.id, empresaId);
      let estadoRodada = rodada.estado_preparacao;
      if (estadoRodada === 'EM_PREPARACAO'
        && !itens.some((i) => i.estado_preparacao === 'EM_PREPARACAO' || i.estado_preparacao === 'PRONTO')) {
        await run(db, `
          UPDATE cozinha_rodadas SET estado_preparacao = 'AGUARDANDO', updated_at = ?
          WHERE id = ? AND empresa_id = ? AND estado_preparacao = 'EM_PREPARACAO'
        `, [revertidoEm, rodada.id, empresaId]);
        estadoRodada = 'AGUARDANDO';
      }
      const resposta = {
        success: true,
        repetida: false,
        operador_id: operadorId,
        revertido_em: revertidoEm,
        item: dtoItem(await carregarItemEmpresa(db, itemId, empresaId)),
        rodada: { id: rodada.id, estado_preparacao: estadoRodada },
        evento: EVENTOS.PREPARACAO_REVERTIDA
      };
      await run(db, `
        INSERT INTO cozinha_eventos_outbox
          (empresa_id, unidade_id, tipo, payload_json, idempotency_key)
        VALUES (?, ?, ?, ?, ?)
      `, [empresaId, unidadeId, EVENTOS.PREPARACAO_REVERTIDA, JSON.stringify(resposta), `${idempotencyKey}:EVENTO`]);
      await concluirIdempotencia(db, {
        idempotencyKey,
        resultado: resposta,
        httpStatus: 200,
        recursoTipo: 'cozinha_item',
        recursoId: itemId
      });
      if (opts.simularFalha === 'antes_commit') {
        throw erro('Falha simulada antes do commit.', 500, 'FALHA_SIMULADA');
      }
      await commit(db);
      return resposta;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function marcarItemPronto(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const itemId = exigirId(entrada.itemId, 'ITEM_INVALIDO', 'item_id inválido.');
  const idempotencyKey = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);

  const hash = calcularHashOperacao(TIPOS_OPERACAO.ITEM_PRONTO, {
    empresa_id: empresaId,
    item_id: itemId,
    responsavel_operador_id: operadorId
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const item = await carregarItemEmpresa(db, itemId, empresaId);
      const rodada = exigirRodadaNaoCancelada(
        await carregarRodadaEmpresa(db, item.rodada_id, empresaId)
      );
      await validarIntegridadeOperacional(db, item, rodada, {
        empresaId,
        unidadeIdAutorizada: entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId
      });
      const claim = await claimIdempotenciaCentral(db, {
        idempotencyKey,
        tipoOperacao: TIPOS_OPERACAO.ITEM_PRONTO,
        hash,
        contexto: JSON.stringify({ empresa_id: empresaId, item_id: itemId })
      });
      if (claim.replay) {
        await commit(db);
        return { ...claim.corpo, repetida: true };
      }

      if (item.estado_preparacao === 'CANCELADO') {
        throw erro('Item cancelado.', 409, 'ITEM_CANCELADO');
      }
      if (item.estado_preparacao === 'PRONTO') {
        const resposta = {
          success: true,
          repetida: true,
          ja_pronto: true,
          operador_id: null,
          pronto_em: null,
          item: dtoItem(item),
          rodada: {
            id: rodada.id,
            estado_preparacao: rodada.estado_preparacao,
            conclusao: avaliarConclusaoRodada(await carregarItensRodada(db, rodada.id, empresaId))
          },
          evento: EVENTOS.ITEM_PRONTO,
          evento_rodada: null
        };
        await concluirIdempotencia(db, {
          idempotencyKey,
          resultado: resposta,
          httpStatus: 200,
          recursoTipo: 'cozinha_item',
          recursoId: itemId
        });
        await commit(db);
        return resposta;
      }
      if (item.estado_preparacao === 'AGUARDANDO') {
        throw erro(
          'Inicie a preparação antes de marcar como pronto.',
          409,
          'TRANSICAO_INVALIDA'
        );
      }
      if (item.estado_preparacao !== 'EM_PREPARACAO') {
        throw erro('Transição para PRONTO inválida.', 409, 'TRANSICAO_INVALIDA');
      }

      const prontoEm = await timestampUtc(db);
      const atualizado = await run(db, `
        UPDATE cozinha_itens
        SET estado_preparacao = 'PRONTO',
            qty_preparada_millis = qty_solicitada_millis - qty_cancelada_millis,
            updated_at = ?
        WHERE id = ? AND empresa_id = ? AND estado_preparacao = 'EM_PREPARACAO'
      `, [prontoEm, itemId, empresaId]);
      if (atualizado.changes !== 1) {
        throw erro('O estado do item mudou durante a conclusão.', 409, 'TRANSICAO_CONCORRENTE');
      }
      const itemAtual = await carregarItemEmpresa(db, itemId, empresaId);
      const itens = await carregarItensRodada(db, rodada.id, empresaId);
      const sync = await sincronizarEstadoRodada(db, rodada, itens, {
        empresaId,
        operadorId,
        idempotencyKeyBase: idempotencyKey,
        transicaoEm: prontoEm
      });

      const resposta = {
        success: true,
        repetida: false,
        ja_pronto: false,
        operador_id: operadorId,
        pronto_em: prontoEm,
        item: dtoItem(itemAtual, { pronto_em: prontoEm }),
        rodada: {
          id: rodada.id,
          estado_preparacao: sync.estado_preparacao,
          conclusao: sync.avaliacao
        },
        evento: EVENTOS.ITEM_PRONTO,
        evento_rodada: sync.eventoRodada
      };

      await registrarEventoOutbox(db, {
        empresaId,
        unidadeId: item.unidade_id,
        tipo: EVENTOS.ITEM_PRONTO,
        idempotencyKey: `${idempotencyKey}:EVENTO`,
        payload: resposta
      });

      await concluirIdempotencia(db, {
        idempotencyKey,
        resultado: resposta,
        httpStatus: 200,
        recursoTipo: 'cozinha_item',
        recursoId: itemId
      });

      if (opts.simularFalha === 'antes_commit') {
        throw erro('Falha simulada antes do commit.', 500, 'FALHA_SIMULADA');
      }

      await commit(db);
      return resposta;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function confirmarRetirada(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const rodadaId = exigirId(entrada.rodadaId, 'RODADA_INVALIDA', 'rodada_id inválido.');
  const unidadeIdAutorizada = exigirUnidadeOperacional(
    entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId
  );
  const idempotencyKey = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);
  const hash = calcularHashOperacao(TIPOS_OPERACAO.RETIRADA_CONFIRMADA, {
    empresa_id: empresaId,
    rodada_alvo_id: rodadaId,
    responsavel_operador_id: operadorId
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const rodada = await carregarRodadaEmpresa(db, rodadaId, empresaId);
      if (Number(rodada.unidade_id) !== unidadeIdAutorizada) {
        throw erro(
          'Rodada não pertence à unidade operacional autorizada.',
          409,
          'UNIDADE_ISOLAMENTO'
        );
      }
      await validarUnidadeAtivaDaEmpresa(db, empresaId, unidadeIdAutorizada);

      const claim = await claimIdempotenciaCentral(db, {
        idempotencyKey,
        tipoOperacao: TIPOS_OPERACAO.RETIRADA_CONFIRMADA,
        hash,
        contexto: JSON.stringify({
          empresa_id: empresaId,
          unidade_id: unidadeIdAutorizada,
          rodada_id: rodadaId
        })
      });
      if (claim.replay) {
        await commit(db);
        return { ...claim.corpo, repetida: true };
      }

      if (rodada.estado_preparacao === 'CANCELADA') {
        throw erro('Rodada cancelada não pode ser retirada.', 409, 'RODADA_CANCELADA');
      }
      if (rodada.estado_preparacao !== 'PRONTA') {
        throw erro(
          'A retirada só pode ser confirmada após a rodada ficar pronta.',
          409,
          'RODADA_NAO_PRONTA'
        );
      }

      const itens = await carregarItensRodada(db, rodadaId, empresaId);
      const avaliacao = avaliarConclusaoRodada(itens);
      if (!avaliacao.pronta) {
        throw erro(
          'A rodada ainda possui itens necessários em preparação.',
          409,
          'RODADA_NAO_PRONTA',
          { detalhes: avaliacao }
        );
      }
      const rodadaProntaEm = await carregarRodadaProntaEm(db, rodada);

      if (rodada.retirada_estado === 'RETIRADA') {
        const resposta = {
          success: true,
          repetida: true,
          rodada: {
            id: rodadaId,
            estado_preparacao: rodada.estado_preparacao,
            retirada_estado: rodada.retirada_estado,
            retirada_em: rodada.retirada_em || null,
            retirada_por: rodada.retirada_por != null ? Number(rodada.retirada_por) : null,
            rodada_pronta_em: rodadaProntaEm
          },
          evento: EVENTOS.RETIRADA_CONFIRMADA
        };
        await concluirIdempotencia(db, {
          idempotencyKey,
          resultado: resposta,
          httpStatus: 200,
          recursoTipo: 'cozinha_rodada',
          recursoId: rodadaId
        });
        await commit(db);
        return resposta;
      }
      if (rodada.retirada_estado === 'ASSUMIDA_RETIRADA') {
        throw erro(
          'A rodada está em ASSUMIDA_RETIRADA; o significado dessa etapa precisa ser definido antes da confirmação.',
          409,
          'RETIRADA_ESTADO_NAO_SUPORTADO'
        );
      }
      if (rodada.retirada_estado !== 'PENDENTE'
        || rodada.retirada_em != null
        || rodada.retirada_por != null) {
        throw erro(
          'Estado de retirada inconsistente; nenhuma alteração foi aplicada.',
          409,
          'RETIRADA_ESTADO_INCONSISTENTE'
        );
      }

      const retiradaEm = await timestampUtc(db);
      const atualizado = await run(db, `
        UPDATE cozinha_rodadas
        SET retirada_estado = 'RETIRADA',
            retirada_em = ?,
            retirada_por = ?,
            updated_at = ?
        WHERE id = ?
          AND empresa_id = ?
          AND unidade_id = ?
          AND estado_preparacao = 'PRONTA'
          AND retirada_estado = 'PENDENTE'
          AND retirada_em IS NULL
          AND retirada_por IS NULL
      `, [
        retiradaEm,
        operadorId,
        retiradaEm,
        rodadaId,
        empresaId,
        unidadeIdAutorizada
      ]);
      if (atualizado.changes !== 1) {
        throw erro(
          'A rodada mudou durante a confirmação da retirada.',
          409,
          'RETIRADA_CONCORRENTE'
        );
      }

      const resposta = {
        success: true,
        repetida: false,
        operador_id: operadorId,
        rodada: {
          id: rodadaId,
          estado_preparacao: 'PRONTA',
          retirada_estado: 'RETIRADA',
          retirada_em: retiradaEm,
          retirada_por: operadorId,
          rodada_pronta_em: rodadaProntaEm
        },
        evento: EVENTOS.RETIRADA_CONFIRMADA
      };
      await registrarEventoOutbox(db, {
        empresaId,
        unidadeId: unidadeIdAutorizada,
        tipo: EVENTOS.RETIRADA_CONFIRMADA,
        idempotencyKey: `${idempotencyKey}:EVENTO`,
        payload: resposta
      });
      await concluirIdempotencia(db, {
        idempotencyKey,
        resultado: resposta,
        httpStatus: 200,
        recursoTipo: 'cozinha_rodada',
        recursoId: rodadaId
      });

      await commit(db);
      return resposta;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function entregarBebida(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const itemId = exigirId(entrada.itemId, 'ITEM_INVALIDO', 'item_id inválido.');
  const idempotencyKey = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);

  let qtyMillis;
  let qtyDecimal;
  try {
    qtyMillis = decimalParaMilessimos(
      entrada.qty_entregue != null ? entrada.qty_entregue : entrada.quantidade
    );
    qtyDecimal = milessimosParaDecimalString(qtyMillis);
  } catch (e) {
    if (e && e.codigo === 'QTY_PRECISAO_INVALIDA') throw e;
    throw erro('Quantidade inválida.', 400, 'QTY_INVALIDA');
  }
  if (qtyMillis <= 0) {
    throw erro('Quantidade deve ser maior que zero.', 400, 'QTY_INVALIDA');
  }

  const hash = calcularHashOperacao(TIPOS_OPERACAO.BEBIDA_ENTREGUE, {
    empresa_id: empresaId,
    item_id: itemId,
    qty_entregue: qtyDecimal,
    responsavel_operador_id: operadorId
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const claim = await claimIdempotenciaCentral(db, {
        idempotencyKey,
        tipoOperacao: TIPOS_OPERACAO.BEBIDA_ENTREGUE,
        hash,
        contexto: JSON.stringify({
          empresa_id: empresaId,
          item_id: itemId,
          qty_entregue: qtyDecimal
        })
      });
      if (claim.replay) {
        await commit(db);
        return { ...claim.corpo, repetida: true };
      }

      const item = await carregarItemEmpresa(db, itemId, empresaId);
      const rodada = exigirRodadaNaoCancelada(
        await carregarRodadaEmpresa(db, item.rodada_id, empresaId)
      );
      await validarIntegridadeOperacional(db, item, rodada, {
        empresaId,
        unidadeIdAutorizada: entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId
      });

      if (item.tipo_item !== 'BEBIDA') {
        throw erro('Entrega de bebida só se aplica a itens BEBIDA.', 409, 'ITEM_NAO_BEBIDA');
      }
      if (item.estado_preparacao === 'CANCELADO') {
        throw erro('Item cancelado.', 409, 'ITEM_CANCELADO');
      }

      const jaEntregue = await qtyBebidaEntregue(db, item.id, empresaId);
      const capacidade = subtrairMilessimos(
        subtrairMilessimos(item.qty_solicitada_millis, item.qty_cancelada_millis || 0),
        jaEntregue
      );
      if (qtyMillis > capacidade) {
        throw erro(
          'Quantidade entregue excede o saldo da bebida.',
          409,
          'QTY_ENTREGA_EXCEDE',
          {
            detalhes: {
              solicitado_restante: milessimosParaDecimalString(capacidade),
              informado: milessimosParaDecimalString(qtyMillis)
            }
          }
        );
      }

      const restanteApos = subtrairMilessimos(capacidade, qtyMillis);
      const entregueEm = await timestampUtc(db);
      const ins = await run(db, `
        INSERT INTO cozinha_bebida_entregas (
          empresa_id, cozinha_item_id, rodada_id,
          qty_entregue_millis, qty_restante_millis,
          operador_id, entregue_em, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        empresaId, item.id, item.rodada_id,
        qtyMillis, restanteApos,
        operadorId, entregueEm, idempotencyKey
      ]);

      if (restanteApos === 0 && item.estado_preparacao !== 'PRONTO') {
        await run(db, `
          UPDATE cozinha_itens
          SET estado_preparacao = 'PRONTO',
              qty_preparada_millis = qty_solicitada_millis - qty_cancelada_millis,
              updated_at = ?
          WHERE id = ? AND empresa_id = ?
        `, [entregueEm, item.id, empresaId]);
      }

      const itens = await carregarItensRodada(db, rodada.id, empresaId);
      const sync = await sincronizarEstadoRodada(db, rodada, itens, {
        empresaId,
        operadorId,
        idempotencyKeyBase: idempotencyKey,
        transicaoEm: entregueEm
      });

      const itemAtual = await carregarItemEmpresa(db, item.id, empresaId);
      const entregueTotal = await qtyBebidaEntregue(db, item.id, empresaId);

      const resposta = {
        success: true,
        repetida: false,
        entrega: {
          id: ins.lastID,
          qty_entregue: milessimosParaDecimalString(qtyMillis),
          qty_restante: milessimosParaDecimalString(restanteApos)
        },
        item: dtoItem(itemAtual, {
          qty_entregue_acumulada: milessimosParaDecimalString(entregueTotal),
          qty_pendente_entrega: milessimosParaDecimalString(restanteApos)
        }),
        rodada: {
          id: rodada.id,
          estado_preparacao: sync.estado_preparacao,
          conclusao: sync.avaliacao
        },
        evento: EVENTOS.BEBIDA_ENTREGUE
      };

      await registrarEventoOutbox(db, {
        empresaId,
        unidadeId: item.unidade_id,
        tipo: EVENTOS.BEBIDA_ENTREGUE,
        idempotencyKey: `${idempotencyKey}:EVENTO`,
        payload: resposta
      });

      await concluirIdempotencia(db, {
        idempotencyKey,
        resultado: resposta,
        httpStatus: 201,
        recursoTipo: 'cozinha_item',
        recursoId: itemId
      });

      if (opts.simularFalha === 'antes_commit') {
        throw erro('Falha simulada antes do commit.', 500, 'FALHA_SIMULADA');
      }

      await commit(db);
      return resposta;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function consultarPreparacaoRodada(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const rodadaId = exigirId(entrada.rodadaId, 'RODADA_INVALIDA', 'rodada_id inválido.');
  const db = conn(opts);

  const rodada = await carregarRodadaEmpresa(db, rodadaId, empresaId);
  const itens = await carregarItensRodada(db, rodadaId, empresaId);
  const avaliacao = avaliarConclusaoRodada(itens);
  const rodadaProntaEm = rodada.estado_preparacao === 'PRONTA'
    || (rodada.estado_preparacao === 'CANCELADA' && rodada.cancelamento_etapa === 'PRONTA')
    ? await carregarRodadaProntaEm(db, rodada) : null;

  const detalhe = [];
  let qtySolicBebida = 0;
  let qtyEntregueBebida = 0;
  let qtyPendenteBebida = 0;

  for (const item of itens) {
    const ings = await carregarIngredientesItem(db, item.id);
    let entrega = null;
    if (item.tipo_item === 'BEBIDA') {
      const entregue = await qtyBebidaEntregue(db, item.id, empresaId);
      const pendente = subtrairMilessimos(
        subtrairMilessimos(item.qty_solicitada_millis, item.qty_cancelada_millis || 0),
        entregue
      );
      qtySolicBebida += subtrairMilessimos(
        item.qty_solicitada_millis,
        item.qty_cancelada_millis || 0
      );
      qtyEntregueBebida += entregue;
      qtyPendenteBebida += pendente;
      entrega = {
        qty_solicitada: milessimosParaDecimalString(
          subtrairMilessimos(item.qty_solicitada_millis, item.qty_cancelada_millis || 0)
        ),
        qty_entregue: milessimosParaDecimalString(entregue),
        qty_pendente: milessimosParaDecimalString(pendente)
      };
    }
    detalhe.push({
      ...dtoItem(item),
      ingredientes: ings,
      entrega_bebida: entrega
    });
  }

  return {
    success: true,
    rodada: {
      id: rodada.id,
      empresa_id: rodada.empresa_id,
      unidade_id: rodada.unidade_id,
      mesa_id: rodada.mesa_id,
      atendimento_id: rodada.atendimento_id,
      numero_rodada: rodada.numero_rodada,
      sequencia_global: rodada.sequencia_global,
      estado_preparacao: rodada.estado_preparacao,
      operador_envio_id: rodada.operador_envio_id != null ? Number(rodada.operador_envio_id) : null,
      enviada_em: rodada.enviada_em || null,
      rodada_pronta_em: rodadaProntaEm,
      retirada_estado: rodada.retirada_estado,
      retirada_em: rodada.retirada_em || null,
      retirada_por: rodada.retirada_por != null ? Number(rodada.retirada_por) : null,
      entrega_estado: rodada.entrega_estado
    },
    conclusao: avaliacao,
    bebidas: {
      qty_solicitada: milessimosParaDecimalString(qtySolicBebida),
      qty_entregue: milessimosParaDecimalString(qtyEntregueBebida),
      qty_pendente: milessimosParaDecimalString(qtyPendenteBebida),
      nota: 'estado_preparacao=PRONTA não confirma que as bebidas foram entregues.'
    },
    itens: detalhe
  };
}

const MOTIVOS_CANCELAMENTO = Object.freeze([
  'PRAZO_EXCEDIDO',
  'CLIENTE_DESISTIU',
  'CANCELAMENTO_IFOOD',
  'PEDIDO_DUPLICADO',
  'ERRO_LANCAMENTO',
  'FALTA_PRODUTO',
  'OUTRO'
]);

function validarMotivoCancelamento(entrada) {
  const motivo = String(entrada.motivo || '').toUpperCase().trim();
  const justificativa = String(entrada.justificativa || '').trim();
  if (!MOTIVOS_CANCELAMENTO.includes(motivo)) {
    throw erro('Motivo de cancelamento inválido.', 400, 'MOTIVO_CANCELAMENTO_INVALIDO');
  }
  if (motivo === 'OUTRO' && !justificativa) {
    throw erro('Justificativa é obrigatória quando o motivo é OUTRO.', 400, 'JUSTIFICATIVA_OBRIGATORIA');
  }
  return { motivo, justificativa: justificativa || null };
}

function exigirRetiradaPendente(rodada) {
  if (rodada.retirada_estado !== 'PENDENTE' || rodada.retirada_em != null || rodada.retirada_por != null) {
    throw erro('Não é permitido cancelar uma rodada retirada ou em retirada.', 409, 'RODADA_JA_RETIRADA');
  }
}

async function registrarCancelamentoRodada(db, rodada, itens, dados) {
  const { empresaId, unidadeId, operadorId, motivo, justificativa, canceladoEm, idempotencyKey } = dados;
  await run(db, `
    UPDATE cozinha_rodadas SET estado_preparacao='CANCELADA', cancelamento_motivo=?,
      cancelamento_justificativa=?, cancelamento_por=?, cancelamento_em=?,
      cancelamento_etapa=?, updated_at=?
    WHERE id=? AND empresa_id=?
  `, [motivo, justificativa, operadorId, canceladoEm, rodada.estado_preparacao, canceladoEm, rodada.id, empresaId]);
  await run(db, `
    UPDATE cozinha_itens SET estado_preparacao='CANCELADO', motivo_cancelamento=?,
      operador_cancelamento_id=?, cancelado_em=?, updated_at=?
    WHERE rodada_id=? AND empresa_id=? AND estado_preparacao <> 'CANCELADO'
  `, [motivo, operadorId, canceladoEm, canceladoEm, rodada.id, empresaId]);
  const payload = {
    empresa_id: empresaId, unidade_id: unidadeId, rodada_id: rodada.id,
    cancelamento_motivo: motivo, cancelamento_justificativa: justificativa,
    cancelamento_por: operadorId, cancelamento_em: canceladoEm,
    cancelamento_etapa: rodada.estado_preparacao,
    rodada_pronta_em: rodada.estado_preparacao === 'PRONTA' ? await carregarRodadaProntaEm(db, rodada) : null,
    itens: itens.filter((item) => item.estado_preparacao !== 'CANCELADO').map((item) => ({
      item_id: item.id, pedido_id: item.pedido_id, estado_anterior: item.estado_preparacao
    }))
  };
  await run(db, `
    INSERT INTO cozinha_eventos_outbox
      (empresa_id, unidade_id, tipo, payload_json, idempotency_key, created_at)
    VALUES (?, ?, 'RODADA_CANCELADA', ?, ?, ?)
  `, [empresaId, unidadeId, JSON.stringify(payload), `${idempotencyKey}:RODADA_CANCELADA`, canceladoEm]);
  return {
    id: rodada.id, estado_preparacao: 'CANCELADA',
    cancelamento_motivo: motivo, cancelamento_justificativa: justificativa,
    cancelamento_por: operadorId, cancelamento_em: canceladoEm,
    cancelamento_etapa: rodada.estado_preparacao
  };
}

async function cancelarItem(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const itemId = exigirId(entrada.itemId, 'ITEM_INVALIDO', 'item_id inválido.');
  const unidadeId = exigirUnidadeOperacional(entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId);
  const idempotencyKey = exigirChave(entrada.idempotencyKey);
  const { motivo, justificativa } = validarMotivoCancelamento(entrada);
  const hash = calcularHashOperacao(TIPOS_OPERACAO.CANCELAMENTO_ITEM, {
    empresa_id: empresaId, unidade_id: unidadeId, item_id: itemId,
    motivo, justificativa, responsavel_operador_id: operadorId
  });
  const db = conn(opts);
  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const item = await carregarItemEmpresa(db, itemId, empresaId);
      const rodada = await carregarRodadaEmpresa(db, item.rodada_id, empresaId);
      await validarIntegridadeOperacional(db, item, rodada, { empresaId, unidadeIdAutorizada: unidadeId });
      const claim = await claimIdempotenciaCentral(db, {
        idempotencyKey, tipoOperacao: TIPOS_OPERACAO.CANCELAMENTO_ITEM, hash,
        contexto: JSON.stringify({ empresa_id: empresaId, unidade_id: unidadeId, item_id: itemId })
      });
      if (claim.replay) {
        await commit(db);
        return { ...claim.corpo, repetida: true };
      }
      exigirRetiradaPendente(rodada);
      exigirRodadaNaoCancelada(rodada);
      if (!['AGUARDANDO', 'EM_PREPARACAO', 'PRONTO'].includes(item.estado_preparacao)) {
        throw erro('Item já cancelado ou em estado incompatível.', 409, 'ITEM_CANCELADO');
      }
      const canceladoEm = await timestampUtc(db);
      await run(db, `
        UPDATE cozinha_itens SET estado_preparacao='CANCELADO', motivo_cancelamento=?,
          operador_cancelamento_id=?, cancelado_em=?, updated_at=?
        WHERE id=? AND empresa_id=?
      `, [motivo, operadorId, canceladoEm, canceladoEm, itemId, empresaId]);
      const evento = {
        empresa_id: empresaId, unidade_id: unidadeId, rodada_id: rodada.id,
        item_id: itemId, pedido_id: item.pedido_id, estado_anterior: item.estado_preparacao,
        cancelamento_etapa: rodada.estado_preparacao, cancelamento_motivo: motivo,
        cancelamento_justificativa: justificativa, cancelamento_por: operadorId, cancelamento_em: canceladoEm,
        rodada_pronta_em: rodada.estado_preparacao === 'PRONTA' ? await carregarRodadaProntaEm(db, rodada) : null
      };
      await run(db, `
        INSERT INTO cozinha_eventos_outbox
          (empresa_id, unidade_id, tipo, payload_json, idempotency_key, created_at)
        VALUES (?, ?, 'ITEM_CANCELADO', ?, ?, ?)
      `, [empresaId, unidadeId, JSON.stringify(evento), `${idempotencyKey}:ITEM_CANCELADO`, canceladoEm]);
      const itens = await carregarItensRodada(db, rodada.id, empresaId);
      let resultadoRodada;
      if (itens.every((i) => i.estado_preparacao === 'CANCELADO')) {
        resultadoRodada = await registrarCancelamentoRodada(db, rodada, itens, {
          empresaId, unidadeId, operadorId, motivo, justificativa, canceladoEm, idempotencyKey
        });
      } else {
        const avaliacao = avaliarConclusaoRodada(itens);
        if (avaliacao.pronta) {
          const sync = await sincronizarEstadoRodada(db, rodada, itens, {
            empresaId, operadorId, idempotencyKeyBase: idempotencyKey, transicaoEm: canceladoEm
          });
          resultadoRodada = { id: rodada.id, estado_preparacao: sync.estado_preparacao };
        } else {
          const estado = itens.some((i) => ['EM_PREPARACAO', 'PRONTO'].includes(i.estado_preparacao))
            ? 'EM_PREPARACAO' : 'AGUARDANDO';
          await run(db, 'UPDATE cozinha_rodadas SET estado_preparacao=?, updated_at=? WHERE id=? AND empresa_id=?',
            [estado, canceladoEm, rodada.id, empresaId]);
          resultadoRodada = { id: rodada.id, estado_preparacao: estado };
        }
      }
      const resposta = {
        success: true, repetida: false,
        item: dtoItem(await carregarItemEmpresa(db, itemId, empresaId), evento),
        rodada: resultadoRodada
      };
      await concluirIdempotencia(db, {
        idempotencyKey, resultado: resposta, httpStatus: 200, recursoTipo: 'cozinha_item', recursoId: itemId
      });
      if (opts.simularFalha === 'antes_commit') throw erro('Falha simulada antes do commit.', 500, 'FALHA_SIMULADA');
      await commit(db);
      return resposta;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function cancelarRodada(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const rodadaId = exigirId(entrada.rodadaId, 'RODADA_INVALIDA', 'rodada_id inválido.');
  const unidadeIdAutorizada = exigirUnidadeOperacional(
    entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId
  );
  const { motivo, justificativa } = validarMotivoCancelamento(entrada);
  const idempotencyKey = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);
  const hash = calcularHashOperacao('CANCELAMENTO_RODADA', {
    empresa_id: empresaId,
    unidade_id: unidadeIdAutorizada,
    rodada_alvo_id: rodadaId,
    motivo,
    justificativa,
    responsavel_operador_id: operadorId
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const rodada = await carregarRodadaEmpresa(db, rodadaId, empresaId);
      if (Number(rodada.unidade_id) !== unidadeIdAutorizada) {
        throw erro(
          'Rodada não pertence à unidade operacional autorizada.',
          409,
          'UNIDADE_ISOLAMENTO'
        );
      }
      await validarUnidadeAtivaDaEmpresa(db, empresaId, unidadeIdAutorizada);

      const claim = await claimIdempotenciaCentral(db, {
        idempotencyKey,
        tipoOperacao: 'CANCELAMENTO_RODADA',
        hash,
        contexto: JSON.stringify({
          empresa_id: empresaId,
          unidade_id: unidadeIdAutorizada,
          rodada_id: rodadaId,
          motivo
        })
      });
      if (claim.replay) {
        await commit(db);
        return { ...claim.corpo, repetida: true };
      }

      exigirRetiradaPendente(rodada);

      if (rodada.estado_preparacao === 'CANCELADA' || rodada.cancelamento_motivo != null) {
        throw erro(
          'Esta rodada já foi cancelada.',
          409,
          'RODADA_JA_CANCELADA'
        );
      }

      const canceladoEm = await timestampUtc(db);
      const rodadaCancelada = await registrarCancelamentoRodada(
        db, rodada, await carregarItensRodada(db, rodadaId, empresaId),
        { empresaId, unidadeId: unidadeIdAutorizada, operadorId, motivo, justificativa, canceladoEm, idempotencyKey }
      );
      const resposta = {
        success: true,
        rodada: rodadaCancelada
      };

      await concluirIdempotencia(db, {
        idempotencyKey,
        resultado: resposta,
        httpStatus: 200,
        recursoTipo: 'cozinha_rodada',
        recursoId: rodadaId
      });

      if (opts.simularFalha === 'antes_commit') {
        throw erro('Falha simulada antes do commit.', 500, 'FALHA_SIMULADA');
      }

      await commit(db);
      return resposta;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

module.exports = {
  EVENTOS,
  MOTIVOS_CANCELAMENTO,
  iniciarPreparacao,
  voltarParaAguardando,
  marcarItemPronto,
  confirmarRetirada,
  entregarBebida,
  cancelarRodada,
  cancelarItem,
  consultarPreparacaoRodada,
  avaliarConclusaoRodada,
  sincronizarEstadoRodada
};
