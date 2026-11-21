'use strict';

const crypto = require('crypto');
const { decimalParaMilessimos, subtrairMilessimos } = require('./cozinhaQuantidade');

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
  const row = await get(db, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS agora");
  if (!row?.agora) throw erro('Não foi possível obter o horário UTC.', 500, 'HORARIO_UTC_INDISPONIVEL');
  return row.agora;
}

function sqlRetiradaCompletaRodada() {
  const escopo = 'i.rodada_id = r.id AND i.empresa_id = r.empresa_id AND i.unidade_id = r.unidade_id';
  const cancelamentos = `
    COALESCE((
      SELECT SUM(CASE
        WHEN c.tipo_evento = 'CANCELAMENTO_CONFIRMADO' THEN c.qty_millis
        WHEN c.tipo_evento = 'CANCELAMENTO_ESTORNADO' THEN -c.qty_millis
        ELSE 0
      END)
      FROM cozinha_cancelamento_itens c
      WHERE c.empresa_id = i.empresa_id
        AND c.unidade_id = i.unidade_id
        AND c.pedido_id = i.pedido_id
        AND c.pedido_item_id = i.pedido_item_id
        AND c.cozinha_item_id = i.id
        AND c.rodada_id = i.rodada_id
    ), 0)
  `;
  const exigivel = `(i.qty_solicitada_millis - ${cancelamentos})`;
  const retiradas = `
    COALESCE((
      SELECT SUM(CASE
        WHEN e.tipo_evento IN ('RETIRADA_CONFIRMADA', 'AJUSTE_CREDITO') THEN e.qty_millis
        WHEN e.tipo_evento IN ('RETIRADA_ESTORNADA', 'AJUSTE_DEBITO') THEN -e.qty_millis
        ELSE 0
      END)
      FROM cozinha_retirada_itens e
      WHERE e.empresa_id = i.empresa_id
        AND e.unidade_id = i.unidade_id
        AND e.pedido_id = i.pedido_id
        AND e.pedido_item_id = i.pedido_item_id
        AND e.cozinha_item_id = i.id
        AND e.rodada_id = i.rodada_id
    ), 0)
  `;
  const entregas = `
    COALESCE((
      SELECT SUM(b.qty_entregue_millis)
      FROM cozinha_bebida_entregas b
      WHERE b.empresa_id = i.empresa_id
        AND b.cozinha_item_id = i.id
        AND b.rodada_id = i.rodada_id
    ), 0)
  `;
  const itemComercialValido = `
    EXISTS (
      SELECT 1
      FROM pedidos_itens pi
      JOIN pedidos p ON p.id = pi.pedido_id AND p.empresa_id = pi.empresa_id
      WHERE pi.id = i.pedido_item_id
        AND pi.pedido_id = i.pedido_id
        AND pi.empresa_id = i.empresa_id
    )
  `;
  return `CASE
    WHEN r.estado_preparacao = 'PRONTA'
      AND EXISTS (
        SELECT 1 FROM cozinha_itens i
        WHERE ${escopo} AND ${exigivel} > 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM cozinha_itens i
        WHERE ${escopo}
          AND (
            NOT (${itemComercialValido})
            OR ${exigivel} < 0
            OR ${retiradas} <> ${exigivel}
            OR (UPPER(i.tipo_item) = 'BEBIDA' AND ${entregas} <> ${exigivel})
          )
      )
    THEN 1 ELSE 0
  END`;
}

async function sincronizarEstadoRetiradaRodada(db, {
  empresaId,
  unidadeId,
  rodadaId,
  operadorId,
  idempotencyKey
}) {
  const rodada = await get(db, `
    SELECT r.id, r.empresa_id, r.unidade_id, r.estado_preparacao,
           r.retirada_estado, r.retirada_em, r.retirada_por,
           (${sqlRetiradaCompletaRodada()}) AS ledger_completo
    FROM cozinha_rodadas r
    WHERE r.id = ? AND r.empresa_id = ? AND r.unidade_id = ?
  `, [rodadaId, empresaId, unidadeId]);
  if (!rodada) throw erro('Rodada vinculada não encontrada.', 409, 'RODADA_INVALIDA');

  if (Number(rodada.ledger_completo) !== 1) {
    if (rodada.estado_preparacao === 'PRONTA' && rodada.retirada_estado === 'RETIRADA') {
      await run(db, `
        UPDATE cozinha_rodadas
        SET retirada_estado = 'PENDENTE',
            retirada_em = NULL,
            retirada_por = NULL,
            updated_at = datetime('now')
        WHERE id = ? AND empresa_id = ? AND unidade_id = ? AND retirada_estado = 'RETIRADA'
      `, [rodadaId, empresaId, unidadeId]);
    }
    return { completa: false, rodada_id: Number(rodadaId) };
  }

  const eventoLedger = await get(db, `
    SELECT 1 AS existe
    FROM cozinha_eventos_outbox
    WHERE empresa_id = ? AND unidade_id = ? AND tipo = 'RETIRADA_CONFIRMADA'
      AND json_valid(payload_json)
      AND CAST(COALESCE(json_extract(payload_json, '$.rodada_id'),
        json_extract(payload_json, '$.rodada.id')) AS INTEGER) = ?
      AND json_extract(payload_json, '$.origem') = 'LEDGER_ITENS'
    LIMIT 1
  `, [empresaId, unidadeId, rodadaId]);
  if (rodada.retirada_estado !== 'RETIRADA' || !rodada.retirada_em
    || !rodada.retirada_por || !eventoLedger) {
    const retiradaEm = await timestampUtc(db);
    const atualizado = await run(db, `
      UPDATE cozinha_rodadas
      SET retirada_estado = 'RETIRADA',
          retirada_em = ?,
          retirada_por = ?,
          updated_at = ?
      WHERE id = ? AND empresa_id = ? AND unidade_id = ? AND estado_preparacao = 'PRONTA'
    `, [retiradaEm, operadorId, retiradaEm, rodadaId, empresaId, unidadeId]);
    if (atualizado.changes !== 1) {
      throw erro('A rodada mudou durante a conclusão da retirada.', 409, 'RETIRADA_CONCORRENTE');
    }

    const payload = {
      success: true,
      operador_id: operadorId,
      origem: 'LEDGER_ITENS',
      rodada_id: Number(rodadaId),
      rodada: {
        id: Number(rodadaId),
        estado_preparacao: 'PRONTA',
        retirada_estado: 'RETIRADA',
        retirada_em: retiradaEm,
        retirada_por: operadorId
      },
      evento: 'RETIRADA_CONFIRMADA'
    };
    try {
      await run(db, `
        INSERT INTO cozinha_eventos_outbox (
          empresa_id, unidade_id, tipo, payload_json, idempotency_key
        ) VALUES (?, ?, 'RETIRADA_CONFIRMADA', ?, ?)
      `, [
        empresaId,
        unidadeId,
        JSON.stringify(payload),
        `${idempotencyKey}:RETIRADA_CONFIRMADA`
      ]);
    } catch (err) {
      if (!/UNIQUE/i.test(String(err.message))) throw err;
    }
    return {
      completa: true,
      transicionada: true,
      rodada_id: Number(rodadaId),
      rodada: payload.rodada
    };
  }

  return {
    completa: true,
    transicionada: false,
    rodada_id: Number(rodadaId),
    rodada: {
      id: Number(rodadaId),
      estado_preparacao: rodada.estado_preparacao,
      retirada_estado: rodada.retirada_estado,
      retirada_em: rodada.retirada_em,
      retirada_por: Number(rodada.retirada_por)
    }
  };
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
  } catch (_err) {
  }
}

function serializarTransacao(db, trabalho) {
  const anterior = filasTransacao.get(db) || Promise.resolve();
  const atual = anterior.then(trabalho, trabalho);
  filasTransacao.set(db, atual.then(() => undefined, () => undefined));
  return atual;
}

function inteiroPositivo(valor, mensagem, codigo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw erro(mensagem, 400, codigo);
  }
  return numero;
}

function quantidadeMilessimos(valor, jaEmMilessimos = false) {
  if (jaEmMilessimos) {
    const inteiro = Number(valor);
    if (!Number.isInteger(inteiro) || inteiro <= 0) {
      throw erro('Quantidade deve ser maior que zero.', 400, 'QTY_INVALIDA');
    }
    return inteiro;
  }
  if (typeof valor === 'string' && valor.trim() !== '') {
    try {
      return decimalParaMilessimos(valor);
    } catch (err) {
      throw erro(err.message || 'Quantidade inválida.', 400, err.codigo || 'QTY_INVALIDA');
    }
  }
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw erro('Quantidade deve ser maior que zero.', 400, 'QTY_INVALIDA');
  }
  return Math.round(numero * 1000);
}

function exigirChave(valor) {
  const chave = String(valor || '').trim();
  if (!chave) throw erro('Idempotency-Key é obrigatória.', 400, 'IDEMPOTENCY_REQUIRED');
  if (chave.length > 200) throw erro('Idempotency-Key inválida.', 400, 'CHAVE_IDEMPOTENCIA_INVALIDA');
  return chave;
}

function canonicalizar(valor) {
  if (Array.isArray(valor)) return valor.map(canonicalizar);
  if (valor && typeof valor === 'object') {
    return Object.keys(valor).sort().reduce((saida, chave) => {
      saida[chave] = canonicalizar(valor[chave]);
      return saida;
    }, {});
  }
  return valor;
}

function payloadHash(tipoOperacao, dados) {
  const payload = canonicalizar(Object.assign({ tipo_operacao: tipoOperacao }, dados));
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

async function claimIdempotencia(db, { chave, tipoOperacao, hash, contexto }) {
  const existente = await get(
    db,
    'SELECT * FROM cozinha_idempotencia WHERE idempotency_key = ?',
    [chave]
  );
  if (existente) {
    if (String(existente.tipo_operacao) !== tipoOperacao) {
      throw erro('Idempotency-Key já usada em outra operação.', 409, 'IDEMPOTENCY_OPERACAO_DIVERGENTE');
    }
    if (String(existente.payload_hash) !== hash) {
      throw erro('Idempotency-Key reutilizada com payload diferente.', 409, 'IDEMPOTENCY_PAYLOAD_DIVERGENTE');
    }
    if (existente.situacao === 'CONCLUIDA' && existente.resultado_json) {
      return { replay: true, corpo: JSON.parse(existente.resultado_json) };
    }
    throw erro('Operação em andamento ou inconclusiva para esta chave.', 409, 'IDEMPOTENCY_CONFLITO');
  }

  try {
    await run(db, `
      INSERT INTO cozinha_idempotencia (
        idempotency_key, tipo_operacao, contexto, payload_hash, situacao
      ) VALUES (?, ?, ?, ?, 'EM_ANDAMENTO')
    `, [chave, tipoOperacao, JSON.stringify(contexto), hash]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) {
      const novamente = await get(
        db,
        'SELECT * FROM cozinha_idempotencia WHERE idempotency_key = ?',
        [chave]
      );
      if (
        novamente
        && String(novamente.tipo_operacao) === tipoOperacao
        && String(novamente.payload_hash) === hash
        && novamente.situacao === 'CONCLUIDA'
        && novamente.resultado_json
      ) {
        return { replay: true, corpo: JSON.parse(novamente.resultado_json) };
      }
      throw erro('Conflito de idempotência sob concorrência.', 409, 'IDEMPOTENCY_CONCORRENTE');
    }
    throw err;
  }
  return { replay: false };
}

async function concluirIdempotencia(db, { chave, resultado, status = 200, recursoTipo, recursoId }) {
  await run(db, `
    UPDATE cozinha_idempotencia
    SET situacao = 'CONCLUIDA',
        resultado_http_status = ?,
        resultado_json = ?,
        recurso_tipo = ?,
        recurso_id = ?,
        concluded_at = datetime('now')
    WHERE idempotency_key = ?
  `, [status, JSON.stringify(resultado), recursoTipo || null, recursoId || null, chave]);
}

async function obterContextoItem(db, { empresaId, unidadeId, itemId }) {
  const item = await get(
    db,
    'SELECT * FROM cozinha_itens WHERE id = ? AND empresa_id = ?',
    [itemId, empresaId]
  );
  if (!item) throw erro('Item de cozinha não encontrado.', 404, 'ITEM_NAO_ENCONTRADO');
  if (Number(item.unidade_id) !== unidadeId) {
    throw erro('Item não pertence à unidade operacional.', 409, 'UNIDADE_ISOLAMENTO');
  }

  const rodada = await get(
    db,
    'SELECT * FROM cozinha_rodadas WHERE id = ? AND empresa_id = ? AND unidade_id = ?',
    [item.rodada_id, empresaId, unidadeId]
  );
  if (!rodada) throw erro('Rodada vinculada não encontrada.', 409, 'RODADA_INVALIDA');

  const pedidoItemColunas = await all(db, 'PRAGMA table_info(pedidos_itens)');
  if (!pedidoItemColunas.some((coluna) => coluna.name === 'empresa_id')) {
    throw erro('Sprint 1 incompleta: pedidos_itens.empresa_id ausente.', 503, 'LEDGER_SPRINT1_INCOMPLETA');
  }

  const pedidoItem = await get(
    db,
    'SELECT id, pedido_id, quantidade, empresa_id FROM pedidos_itens WHERE id = ? AND pedido_id = ? AND empresa_id = ?',
    [item.pedido_item_id, item.pedido_id, empresaId]
  );
  if (!pedidoItem) throw erro('Pedido item incompatível com o item de cozinha.', 409, 'PEDIDO_ITEM_INVALIDO');
  const pedido = await get(
    db,
    'SELECT id, status FROM pedidos WHERE id = ? AND empresa_id = ?',
    [item.pedido_id, empresaId]
  );
  if (!pedido) throw erro('Pedido do item não pertence à empresa autorizada.', 409, 'PEDIDO_ITEM_INVALIDO');

  let pedidoItemMillis;
  try {
    pedidoItemMillis = decimalParaMilessimos(pedidoItem.quantidade);
  } catch (err) {
    throw erro('Quantidade comercial inválida.', 409, 'PEDIDO_ITEM_QTY_INVALIDA');
  }

  return { item, rodada, pedido, pedidoItem, pedidoItemMillis };
}

async function retiradaLiquidaItem(db, empresaId, itemId) {
  const row = await get(db, `
    SELECT
      COALESCE(SUM(CASE WHEN tipo_evento IN (
        'RETIRADA_CONFIRMADA','AJUSTE_CREDITO'
      ) THEN qty_millis ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN tipo_evento IN (
        'RETIRADA_ESTORNADA','AJUSTE_DEBITO'
      ) THEN qty_millis ELSE 0 END), 0) AS liquida
    FROM cozinha_retirada_itens
    WHERE empresa_id = ? AND cozinha_item_id = ?
  `, [empresaId, itemId]);
  return Number(row?.liquida || 0);
}

async function retiradaLiquidaPedidoItem(db, empresaId, pedidoItemId) {
  const row = await get(db, `
    SELECT
      COALESCE(SUM(CASE WHEN tipo_evento IN (
        'RETIRADA_CONFIRMADA','AJUSTE_CREDITO'
      ) THEN qty_millis ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN tipo_evento IN (
        'RETIRADA_ESTORNADA','AJUSTE_DEBITO'
      ) THEN qty_millis ELSE 0 END), 0) AS liquida
    FROM cozinha_retirada_itens
    WHERE empresa_id = ? AND pedido_item_id = ?
  `, [empresaId, pedidoItemId]);
  return Number(row?.liquida || 0);
}

async function cancelamentoLiquidoItem(db, empresaId, itemId) {
  const row = await get(db, `
    SELECT
      COALESCE(SUM(CASE WHEN tipo_evento='CANCELAMENTO_CONFIRMADO'
        THEN qty_millis ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN tipo_evento='CANCELAMENTO_ESTORNADO'
        THEN qty_millis ELSE 0 END), 0) AS liquida
    FROM cozinha_cancelamento_itens
    WHERE empresa_id = ? AND cozinha_item_id = ?
  `, [empresaId, itemId]);
  return Number(row?.liquida || 0);
}

async function cancelamentoLiquidoPedidoItem(db, empresaId, pedidoItemId) {
  const row = await get(db, `
    SELECT
      COALESCE(SUM(CASE WHEN tipo_evento='CANCELAMENTO_CONFIRMADO'
        THEN qty_millis ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN tipo_evento='CANCELAMENTO_ESTORNADO'
        THEN qty_millis ELSE 0 END), 0) AS liquida
    FROM cozinha_cancelamento_itens
    WHERE empresa_id = ? AND pedido_item_id = ?
  `, [empresaId, pedidoItemId]);
  return Number(row?.liquida || 0);
}

async function retirarItem(entrada = {}, opts = {}) {
  const empresaId = inteiroPositivo(entrada.empresaId, 'Empresa do contexto é obrigatória.', 'EMPRESA_CONTEXT_REQUIRED');
  const unidadeId = inteiroPositivo(
    entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId,
    'Unidade operacional é obrigatória.',
    'UNIDADE_CONTEXT_REQUIRED'
  );
  const operadorId = inteiroPositivo(entrada.operadorId, 'Sessão sem operador.', 'SESSAO_INVALIDA');
  const itemId = inteiroPositivo(entrada.itemId, 'item_id inválido.', 'ITEM_INVALIDO');
  const chave = exigirChave(entrada.idempotencyKey);
  const usarSaldoPendente = entrada.usar_saldo_pendente === true;
  let qtyMillis = usarSaldoPendente ? null : quantidadeMilessimos(
    entrada.qty_millis != null ? entrada.qty_millis : entrada.quantidade,
    entrada.qty_millis != null
  );
  const qtyHash = usarSaldoPendente ? 'SALDO_PENDENTE_BACKEND' : qtyMillis;
  const db = conn(opts);
  const tipoOperacao = 'RETIRADA_CONFIRMADA';
  const hash = payloadHash(tipoOperacao, {
    operacao: 'RETIRADA_ITEM',
    empresa_id: empresaId,
    unidade_id: unidadeId,
    item_id: itemId,
    qty_millis: qtyHash,
    operador_id: operadorId
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const claim = await claimIdempotencia(db, {
        chave,
        tipoOperacao,
        hash,
        contexto: {
          empresa_id: empresaId,
          unidade_id: unidadeId,
          item_id: itemId,
          qty_millis: qtyHash
        }
      });
      if (claim.replay) {
        await commit(db);
        return Object.assign({}, claim.corpo, { repetida: true });
      }

      const contexto = await obterContextoItem(db, { empresaId, unidadeId, itemId });
      const { item, rodada, pedido, pedidoItem, pedidoItemMillis } = contexto;
      if (String(pedido.status || '').trim().toUpperCase() === 'CANCELADO') {
        throw erro(
          'Pedido comercial cancelado não permite confirmar retirada.',
          409,
          'PEDIDO_CANCELADO'
        );
      }
      if (item.estado_preparacao === 'CANCELADO' || rodada.estado_preparacao === 'CANCELADA') {
        throw erro('Item ou rodada cancelada não pode ser retirada.', 409, 'ITEM_CANCELADO');
      }
      if (rodada.estado_preparacao !== 'PRONTA') {
        throw erro('A retirada só pode ocorrer em rodada pronta.', 409, 'RODADA_NAO_PRONTA');
      }
      if (item.estado_preparacao !== 'PRONTO') {
        throw erro('O item precisa estar PRONTO para registrar a retirada.', 409, 'ITEM_NAO_PRONTO');
      }

      const retiradaItem = await retiradaLiquidaItem(db, empresaId, itemId);
      const retiradaPedidoItem = await retiradaLiquidaPedidoItem(db, empresaId, item.pedido_item_id);
      const cancelamentoItem = await cancelamentoLiquidoItem(db, empresaId, itemId);
      const cancelamentoPedidoItem = await cancelamentoLiquidoPedidoItem(db, empresaId, item.pedido_item_id);

      const exigivelItem = subtrairMilessimos(item.qty_solicitada_millis, cancelamentoItem);
      const exigivelPedidoItem = subtrairMilessimos(pedidoItemMillis, cancelamentoPedidoItem);
      const pendenteItem = subtrairMilessimos(exigivelItem, retiradaItem);
      const pendentePedidoItem = subtrairMilessimos(exigivelPedidoItem, retiradaPedidoItem);
      const permitido = Math.min(pendenteItem, pendentePedidoItem);
      let disponivelEntregue = null;

      if (String(item.tipo_item || '').toUpperCase() === 'BEBIDA') {
        const tabelaEntrega = await get(db, `
          SELECT 1 AS existe
          FROM sqlite_master
          WHERE type = 'table' AND name = 'cozinha_bebida_entregas'
        `);
        if (!tabelaEntrega) {
          throw erro(
            'O ledger de entrega de bebidas não está disponível.',
            503,
            'LEDGER_BEBIDA_INDISPONIVEL'
          );
        }
        const entrega = await get(db, `
          SELECT COALESCE(SUM(qty_entregue_millis), 0) AS total
          FROM cozinha_bebida_entregas
          WHERE empresa_id = ? AND cozinha_item_id = ? AND rodada_id = ?
        `, [empresaId, item.id, rodada.id]);
        disponivelEntregue = Math.max(0, Number(entrega?.total || 0) - retiradaItem);
        if (!usarSaldoPendente && qtyMillis > disponivelEntregue) {
          throw erro(
            'A retirada da bebida excede a quantidade efetivamente entregue.',
            409,
            'BEBIDA_AINDA_NAO_ENTREGUE',
            { qty_entregue_disponivel: disponivelEntregue }
          );
        }
      }

      if (usarSaldoPendente) {
        qtyMillis = String(item.tipo_item || '').toUpperCase() === 'BEBIDA'
          ? Math.min(permitido, disponivelEntregue)
          : permitido;
        if (!Number.isSafeInteger(qtyMillis) || qtyMillis <= 0) {
          throw erro('Não há saldo exigível disponível para retirada.', 409, 'RETIRADA_SEM_SALDO');
        }
      }

      if (qtyMillis > permitido) {
        throw erro(
          'Quantidade retirada excede o saldo exigível.',
          409,
          'RETIRADA_ACIMA_DO_PERMITIDO',
          { qty_solicitada_restante: permitido }
        );
      }

      const registradoEm = await timestampUtc(db);
      const inserida = await run(db, `
        INSERT INTO cozinha_retirada_itens (
          empresa_id, unidade_id, pedido_id, pedido_item_id,
          cozinha_item_id, rodada_id, tipo_evento, qty_millis,
          operador_id, autorizado_por_operador_id, operacao_id,
          evento_origem_id, justificativa, registrado_em
        ) VALUES (?, ?, ?, ?, ?, ?, 'RETIRADA_CONFIRMADA', ?, ?, NULL, ?, NULL, NULL, ?)
      `, [
        empresaId,
        unidadeId,
        item.pedido_id,
        item.pedido_item_id,
        itemId,
        item.rodada_id,
        qtyMillis,
        operadorId,
        chave,
        registradoEm
      ]);

      const rodadaRetirada = await sincronizarEstadoRetiradaRodada(db, {
        empresaId,
        unidadeId,
        rodadaId: item.rodada_id,
        operadorId,
        idempotencyKey: chave
      });
      const resultado = {
        success: true,
        repetida: false,
        evento_id: inserida.lastID,
        tipo_evento: 'RETIRADA_CONFIRMADA',
        cozinha_item_id: itemId,
        pedido_item_id: item.pedido_item_id,
        rodada_id: item.rodada_id,
        qty_millis: qtyMillis,
        operador_id: operadorId,
        registrado_em: registradoEm,
        rodada_retirada: rodadaRetirada.completa
      };
      await concluirIdempotencia(db, {
        chave,
        resultado,
        status: 201,
        recursoTipo: 'cozinha_retirada_item',
        recursoId: inserida.lastID
      });
      await commit(db);
      return resultado;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function estornarRetirada(entrada = {}, opts = {}) {
  const empresaId = inteiroPositivo(entrada.empresaId, 'Empresa do contexto é obrigatória.', 'EMPRESA_CONTEXT_REQUIRED');
  const unidadeId = inteiroPositivo(
    entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId,
    'Unidade operacional é obrigatória.',
    'UNIDADE_CONTEXT_REQUIRED'
  );
  const operadorId = inteiroPositivo(entrada.operadorId, 'Sessão sem operador.', 'SESSAO_INVALIDA');
  const autorizadoPorId = entrada.autorizadoPorOperadorId != null
    ? inteiroPositivo(entrada.autorizadoPorOperadorId, 'Autorizador inválido.', 'AUTORIZADOR_INVALIDO')
    : operadorId;
  const eventoId = inteiroPositivo(entrada.eventoId, 'evento_id inválido.', 'EVENTO_INVALIDO');
  const qtd = quantidadeMilessimos(
    entrada.qty_millis != null ? entrada.qty_millis : entrada.quantidade,
    entrada.qty_millis != null
  );
  const justificativa = String(entrada.justificativa || '').trim();
  if (!justificativa) throw erro('Justificativa obrigatória.', 400, 'JUSTIFICATIVA_OBRIGATORIA');
  const chave = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);
  const tipoOperacao = 'RETIRADA_CONFIRMADA';
  const hash = payloadHash(tipoOperacao, {
    operacao: 'ESTORNO_RETIRADA',
    empresa_id: empresaId,
    unidade_id: unidadeId,
    evento_origem_id: eventoId,
    qty_millis: qtd,
    operador_id: operadorId,
    autorizado_por_operador_id: autorizadoPorId,
    justificativa
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const claim = await claimIdempotencia(db, {
        chave,
        tipoOperacao,
        hash,
        contexto: { evento_origem_id: eventoId, qty_millis: qtd }
      });
      if (claim.replay) {
        await commit(db);
        return Object.assign({}, claim.corpo, { repetida: true });
      }

      const origem = await get(
        db,
        `SELECT * FROM cozinha_retirada_itens
         WHERE id = ? AND empresa_id = ? AND unidade_id = ?`,
        [eventoId, empresaId, unidadeId]
      );
      if (!origem) throw erro('Evento original não encontrado.', 404, 'EVENTO_ORIGEM_NAO_ENCONTRADO');
      if (!['RETIRADA_CONFIRMADA', 'AJUSTE_CREDITO', 'AJUSTE_DEBITO'].includes(origem.tipo_evento)) {
        throw erro('Evento não pode ser estornado.', 409, 'EVENTO_ORIGEM_INVALIDO');
      }

      const estornos = await get(db, `
        SELECT COALESCE(SUM(qty_millis), 0) AS total
        FROM cozinha_retirada_itens
        WHERE empresa_id = ? AND evento_origem_id = ? AND tipo_evento = 'RETIRADA_ESTORNADA'
      `, [empresaId, eventoId]);
      const estornado = Number(estornos?.total || 0);
      if (qtd > subtrairMilessimos(origem.qty_millis, estornado)) {
        throw erro('Estorno superior ao saldo ainda estornável.', 409, 'ESTORNO_ACIMA_DO_SALDO');
      }

      const registradoEm = await timestampUtc(db);
      const inserida = await run(db, `
        INSERT INTO cozinha_retirada_itens (
          empresa_id, unidade_id, pedido_id, pedido_item_id,
          cozinha_item_id, rodada_id, tipo_evento, qty_millis,
          operador_id, autorizado_por_operador_id, operacao_id,
          evento_origem_id, justificativa, registrado_em
        ) VALUES (?, ?, ?, ?, ?, ?, 'RETIRADA_ESTORNADA', ?, ?, ?, ?, ?, ?, ?)
      `, [
        empresaId,
        unidadeId,
        origem.pedido_id,
        origem.pedido_item_id,
        origem.cozinha_item_id,
        origem.rodada_id,
        qtd,
        operadorId,
        autorizadoPorId,
        chave,
        eventoId,
        justificativa,
        registradoEm
      ]);
      const rodadaRetirada = await sincronizarEstadoRetiradaRodada(db, {
        empresaId,
        unidadeId,
        rodadaId: origem.rodada_id,
        operadorId,
        idempotencyKey: chave
      });
      const resultado = {
        success: true,
        repetida: false,
        evento_id: inserida.lastID,
        tipo_evento: 'RETIRADA_ESTORNADA',
        evento_origem_id: eventoId,
        qty_millis: qtd,
        operador_id: operadorId,
        registrado_em: registradoEm
      };
      resultado.rodada_retirada = rodadaRetirada.completa;
      await concluirIdempotencia(db, {
        chave,
        resultado,
        status: 201,
        recursoTipo: 'cozinha_retirada_estorno',
        recursoId: inserida.lastID
      });
      await commit(db);
      return resultado;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function cancelarItem(entrada = {}, opts = {}) {
  const empresaId = inteiroPositivo(entrada.empresaId, 'Empresa do contexto é obrigatória.', 'EMPRESA_CONTEXT_REQUIRED');
  const unidadeId = inteiroPositivo(
    entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId,
    'Unidade operacional é obrigatória.',
    'UNIDADE_CONTEXT_REQUIRED'
  );
  const operadorId = inteiroPositivo(entrada.operadorId, 'Sessão sem operador.', 'SESSAO_INVALIDA');
  const itemId = inteiroPositivo(entrada.itemId, 'item_id inválido.', 'ITEM_INVALIDO');
  const qtd = quantidadeMilessimos(
    entrada.qty_millis != null ? entrada.qty_millis : entrada.quantidade,
    entrada.qty_millis != null
  );
  const justificativa = String(entrada.justificativa || '').trim();
  if (!justificativa) throw erro('Justificativa obrigatória.', 400, 'JUSTIFICATIVA_OBRIGATORIA');
  const chave = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);
  const tipoOperacao = 'CANCELAMENTO_ITEM';
  const hash = payloadHash(tipoOperacao, {
    operacao: 'CANCELAMENTO_ITEM',
    empresa_id: empresaId,
    unidade_id: unidadeId,
    item_id: itemId,
    qty_millis: qtd,
    operador_id: operadorId,
    justificativa
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const claim = await claimIdempotencia(db, {
        chave,
        tipoOperacao,
        hash,
        contexto: { item_id: itemId, qty_millis: qtd }
      });
      if (claim.replay) {
        await commit(db);
        return Object.assign({}, claim.corpo, { repetida: true });
      }

      const contexto = await obterContextoItem(db, { empresaId, unidadeId, itemId });
      const { item, rodada, pedidoItem, pedidoItemMillis } = contexto;
      if (rodada.estado_preparacao === 'CANCELADA') {
        throw erro('Rodada já cancelada.', 409, 'RODADA_CANCELADA');
      }
      if (item.estado_preparacao === 'CANCELADO') {
        throw erro('Item já cancelado.', 409, 'ITEM_CANCELADO');
      }

      const retiradaItem = await retiradaLiquidaItem(db, empresaId, itemId);
      const cancelamentoItem = await cancelamentoLiquidoItem(db, empresaId, itemId);
      const retiradaPedidoItem = await retiradaLiquidaPedidoItem(db, empresaId, item.pedido_item_id);
      const cancelamentoPedidoItem = await cancelamentoLiquidoPedidoItem(db, empresaId, item.pedido_item_id);
      const disponivelItem = subtrairMilessimos(
        subtrairMilessimos(item.qty_solicitada_millis, retiradaItem),
        cancelamentoItem
      );
      const disponivelPedidoItem = subtrairMilessimos(
        subtrairMilessimos(pedidoItemMillis, retiradaPedidoItem),
        cancelamentoPedidoItem
      );
      const permitido = Math.min(disponivelItem, disponivelPedidoItem);
      if (qtd > permitido) {
        throw erro(
          'Cancelamento acima da quantidade disponível.',
          409,
          'CANCELAMENTO_ACIMA_DO_PERMITIDO',
          { qty_disponivel: permitido }
        );
      }

      const registradoEm = await timestampUtc(db);
      const inserida = await run(db, `
        INSERT INTO cozinha_cancelamento_itens (
          empresa_id, unidade_id, pedido_id, pedido_item_id,
          cozinha_item_id, rodada_id, tipo_evento, qty_millis,
          operador_id, autorizado_por_operador_id, operacao_id,
          evento_origem_id, justificativa, registrado_em
        ) VALUES (?, ?, ?, ?, ?, ?, 'CANCELAMENTO_CONFIRMADO', ?, ?, NULL, ?, NULL, ?, ?)
      `, [
        empresaId,
        unidadeId,
        item.pedido_id,
        item.pedido_item_id,
        itemId,
        item.rodada_id,
        qtd,
        operadorId,
        chave,
        justificativa,
        registradoEm
      ]);
      await run(db, `
        UPDATE cozinha_itens
        SET qty_cancelada_millis = qty_cancelada_millis + ?,
            estado_preparacao = CASE
              WHEN qty_solicitada_millis <= qty_cancelada_millis + ?
                THEN 'CANCELADO'
              ELSE estado_preparacao
            END
        WHERE id = ? AND empresa_id = ?
      `, [qtd, qtd, itemId, empresaId]);
      const rodadaRetirada = await sincronizarEstadoRetiradaRodada(db, {
            empresaId,
            unidadeId,
            rodadaId: item.rodada_id,
            operadorId,
            idempotencyKey: chave
      });
      const resultado = {
        success: true,
        repetida: false,
        evento_id: inserida.lastID,
        tipo_evento: 'CANCELAMENTO_CONFIRMADO',
        cozinha_item_id: itemId,
        pedido_item_id: item.pedido_item_id,
        rodada_id: item.rodada_id,
        qty_millis: qtd,
        operador_id: operadorId,
        justificativa,
        registrado_em: registradoEm,
        rodada_retirada: rodadaRetirada.completa
      };
      await concluirIdempotencia(db, {
        chave,
        resultado,
        status: 201,
        recursoTipo: 'cozinha_cancelamento_item',
        recursoId: inserida.lastID
      });
      await commit(db);
      return resultado;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function estornarCancelamento(entrada = {}, opts = {}) {
  const empresaId = inteiroPositivo(entrada.empresaId, 'Empresa do contexto é obrigatória.', 'EMPRESA_CONTEXT_REQUIRED');
  const unidadeId = inteiroPositivo(
    entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId,
    'Unidade operacional é obrigatória.',
    'UNIDADE_CONTEXT_REQUIRED'
  );
  const operadorId = inteiroPositivo(entrada.operadorId, 'Sessão sem operador.', 'SESSAO_INVALIDA');
  const autorizadoPorId = entrada.autorizadoPorOperadorId != null
    ? inteiroPositivo(entrada.autorizadoPorOperadorId, 'Autorizador inválido.', 'AUTORIZADOR_INVALIDO')
    : operadorId;
  const eventoId = inteiroPositivo(entrada.eventoId, 'evento_id inválido.', 'EVENTO_INVALIDO');
  const qtd = quantidadeMilessimos(
    entrada.qty_millis != null ? entrada.qty_millis : entrada.quantidade,
    entrada.qty_millis != null
  );
  const justificativa = String(entrada.justificativa || '').trim();
  if (!justificativa) throw erro('Justificativa obrigatória.', 400, 'JUSTIFICATIVA_OBRIGATORIA');
  const chave = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);
  const tipoOperacao = 'CANCELAMENTO_ITEM';
  const hash = payloadHash(tipoOperacao, {
    operacao: 'ESTORNO_CANCELAMENTO',
    empresa_id: empresaId,
    unidade_id: unidadeId,
    evento_origem_id: eventoId,
    qty_millis: qtd,
    operador_id: operadorId,
    autorizado_por_operador_id: autorizadoPorId,
    justificativa
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const claim = await claimIdempotencia(db, {
        chave,
        tipoOperacao,
        hash,
        contexto: { evento_origem_id: eventoId, qty_millis: qtd }
      });
      if (claim.replay) {
        await commit(db);
        return Object.assign({}, claim.corpo, { repetida: true });
      }

      const origem = await get(
        db,
        `SELECT * FROM cozinha_cancelamento_itens
         WHERE id = ? AND empresa_id = ? AND unidade_id = ?`,
        [eventoId, empresaId, unidadeId]
      );
      if (!origem || origem.tipo_evento !== 'CANCELAMENTO_CONFIRMADO') {
        throw erro('Evento original de cancelamento não encontrado.', 404, 'EVENTO_CANCELAMENTO_INVALIDO');
      }
      const estornos = await get(db, `
        SELECT COALESCE(SUM(qty_millis), 0) AS total
        FROM cozinha_cancelamento_itens
        WHERE empresa_id = ? AND evento_origem_id = ? AND tipo_evento = 'CANCELAMENTO_ESTORNADO'
      `, [empresaId, eventoId]);
      const estornado = Number(estornos?.total || 0);
      if (qtd > subtrairMilessimos(origem.qty_millis, estornado)) {
        throw erro('Estorno de cancelamento acima do saldo permitido.', 409, 'ESTORNO_CANCELAMENTO_ACIMA');
      }

      const registradoEm = await timestampUtc(db);
      const inserida = await run(db, `
        INSERT INTO cozinha_cancelamento_itens (
          empresa_id, unidade_id, pedido_id, pedido_item_id,
          cozinha_item_id, rodada_id, tipo_evento, qty_millis,
          operador_id, autorizado_por_operador_id, operacao_id,
          evento_origem_id, justificativa, registrado_em
        ) VALUES (?, ?, ?, ?, ?, ?, 'CANCELAMENTO_ESTORNADO', ?, ?, ?, ?, ?, ?, ?)
      `, [
        empresaId,
        unidadeId,
        origem.pedido_id,
        origem.pedido_item_id,
        origem.cozinha_item_id,
        origem.rodada_id,
        qtd,
        operadorId,
        autorizadoPorId,
        chave,
        eventoId,
        justificativa,
        registradoEm
      ]);
      await run(db, `
        UPDATE cozinha_itens
        SET qty_cancelada_millis = MAX(0, qty_cancelada_millis - ?),
            estado_preparacao = CASE
              WHEN estado_preparacao = 'CANCELADO'
                AND MAX(0, qty_cancelada_millis - ?) = 0
                THEN 'AGUARDANDO'
              ELSE estado_preparacao
            END
        WHERE id = ? AND empresa_id = ?
      `, [qtd, qtd, origem.cozinha_item_id, empresaId]);
      const rodadaRetirada = await sincronizarEstadoRetiradaRodada(db, {
            empresaId,
            unidadeId,
            rodadaId: origem.rodada_id,
            operadorId,
            idempotencyKey: chave
      });
      const resultado = {
        success: true,
        repetida: false,
        evento_id: inserida.lastID,
        tipo_evento: 'CANCELAMENTO_ESTORNADO',
        evento_origem_id: eventoId,
        qty_millis: qtd,
        operador_id: operadorId,
        registrado_em: registradoEm,
        rodada_retirada: rodadaRetirada.completa
      };
      await concluirIdempotencia(db, {
        chave,
        resultado,
        status: 201,
        recursoTipo: 'cozinha_cancelamento_estorno',
        recursoId: inserida.lastID
      });
      await commit(db);
      return resultado;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function ajustarRetirada(entrada = {}, opts = {}) {
  if (entrada.adminAutorizado !== true) {
    throw erro('Ajuste excepcional exige autorização administrativa.', 403, 'AJUSTE_SEM_AUTORIZACAO');
  }
  const empresaId = inteiroPositivo(entrada.empresaId, 'Empresa do contexto é obrigatória.', 'EMPRESA_CONTEXT_REQUIRED');
  const unidadeId = inteiroPositivo(
    entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId,
    'Unidade operacional é obrigatória.',
    'UNIDADE_CONTEXT_REQUIRED'
  );
  const operadorId = inteiroPositivo(entrada.operadorId, 'Sessão sem operador.', 'SESSAO_INVALIDA');
  const autorizadoPorId = inteiroPositivo(
    entrada.autorizadoPorOperadorId,
    'Operador autorizado obrigatório.',
    'AUTORIZADOR_INVALIDO'
  );
  const eventoId = inteiroPositivo(entrada.eventoId, 'evento_id inválido.', 'EVENTO_INVALIDO');
  const tipoEvento = String(entrada.tipo_evento || '').trim().toUpperCase();
  if (!['AJUSTE_CREDITO', 'AJUSTE_DEBITO'].includes(tipoEvento)) {
    throw erro('Tipo de ajuste inválido.', 400, 'AJUSTE_TIPO_INVALIDO');
  }
  const qtd = quantidadeMilessimos(
    entrada.qty_millis != null ? entrada.qty_millis : entrada.quantidade,
    entrada.qty_millis != null
  );
  const justificativa = String(entrada.justificativa || '').trim();
  if (!justificativa) throw erro('Justificativa obrigatória.', 400, 'JUSTIFICATIVA_OBRIGATORIA');
  const chave = exigirChave(entrada.idempotencyKey);
  const db = conn(opts);
  const tipoOperacao = 'RETIRADA_CONFIRMADA';
  const hash = payloadHash(tipoOperacao, {
    operacao: 'AJUSTE_RETIRADA',
    tipo_evento: tipoEvento,
    empresa_id: empresaId,
    unidade_id: unidadeId,
    evento_origem_id: eventoId,
    qty_millis: qtd,
    operador_id: operadorId,
    autorizado_por_operador_id: autorizadoPorId,
    justificativa
  });

  return serializarTransacao(db, async () => {
    await run(db, 'PRAGMA foreign_keys = ON');
    await beginImmediate(db);
    try {
      const claim = await claimIdempotencia(db, {
        chave,
        tipoOperacao,
        hash,
        contexto: { tipo_evento: tipoEvento, evento_origem_id: eventoId, qty_millis: qtd }
      });
      if (claim.replay) {
        await commit(db);
        return Object.assign({}, claim.corpo, { repetida: true });
      }

      let admin = null;
      try {
        admin = await get(db, `
          SELECT id, role, perfil, COALESCE(ativo, 1) AS ativo
          FROM usuarios
          WHERE id = ?
        `, [autorizadoPorId]);
      } catch (_colunasAusentes) {
        admin = await get(db, `
          SELECT id, COALESCE(ativo, 1) AS ativo
          FROM usuarios
          WHERE id = ?
        `, [autorizadoPorId]);
        if (admin) admin.role = '';
      }
      const perfil = String(admin?.perfil || '').trim().toUpperCase();
      const autorizado =
        !!admin
        && Number(admin.ativo) === 1
        && (
          String(admin.role || '').toLowerCase() === 'admin'
          || String(admin.role || '').toLowerCase() === 'supervisor'
          || perfil === 'SUPER_ADMIN'
          || perfil === 'ADMIN'
        );
      if (!autorizado) {
        throw erro('Administrador autorizador inválido ou inativo.', 403, 'AJUSTE_AUTORIZADOR_INVALIDO');
      }

      const origem = await get(
        db,
        `SELECT * FROM cozinha_retirada_itens
         WHERE id = ? AND empresa_id = ? AND unidade_id = ?`,
        [eventoId, empresaId, unidadeId]
      );
      if (!origem || !['RETIRADA_CONFIRMADA', 'AJUSTE_CREDITO', 'AJUSTE_DEBITO'].includes(origem.tipo_evento)) {
        throw erro('Referência de ajuste inválida.', 409, 'AJUSTE_REFERENCIA_INVALIDA');
      }

      const retiradaLiquida = await retiradaLiquidaItem(db, empresaId, origem.cozinha_item_id);
      if (tipoEvento === 'AJUSTE_DEBITO' && qtd > retiradaLiquida) {
        throw erro('Ajuste de débito produziria saldo negativo.', 409, 'AJUSTE_DEBITO_ACIMA');
      }
      if (tipoEvento === 'AJUSTE_CREDITO') {
        const contexto = await obterContextoItem(db, {
          empresaId,
          unidadeId,
          itemId: origem.cozinha_item_id
        });
        const cancelamentoPedido = await cancelamentoLiquidoPedidoItem(
          db,
          empresaId,
          origem.pedido_item_id
        );
        const retiradaPedido = await retiradaLiquidaPedidoItem(
          db,
          empresaId,
          origem.pedido_item_id
        );
        const pendente = subtrairMilessimos(
          subtrairMilessimos(contexto.pedidoItemMillis, cancelamentoPedido),
          retiradaPedido
        );
        if (qtd > pendente) {
          throw erro('Ajuste de crédito excede o saldo exigível.', 409, 'AJUSTE_CREDITO_ACIMA');
        }
      }

      const registradoEm = await timestampUtc(db);
      const inserida = await run(db, `
        INSERT INTO cozinha_retirada_itens (
          empresa_id, unidade_id, pedido_id, pedido_item_id,
          cozinha_item_id, rodada_id, tipo_evento, qty_millis,
          operador_id, autorizado_por_operador_id, operacao_id,
          evento_origem_id, justificativa, registrado_em
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        empresaId,
        unidadeId,
        origem.pedido_id,
        origem.pedido_item_id,
        origem.cozinha_item_id,
        origem.rodada_id,
        tipoEvento,
        qtd,
        operadorId,
        autorizadoPorId,
        chave,
        eventoId,
        justificativa,
        registradoEm
      ]);
      const rodadaRetirada = await sincronizarEstadoRetiradaRodada(db, {
        empresaId,
        unidadeId,
        rodadaId: origem.rodada_id,
        operadorId,
        idempotencyKey: chave
      });
      const resultado = {
        success: true,
        repetida: false,
        evento_id: inserida.lastID,
        tipo_evento: tipoEvento,
        evento_origem_id: eventoId,
        qty_millis: qtd,
        operador_id: operadorId,
        autorizado_por_operador_id: autorizadoPorId,
        justificativa,
        registrado_em: registradoEm,
        rodada_retirada: rodadaRetirada.completa
      };
      await concluirIdempotencia(db, {
        chave,
        resultado,
        status: 201,
        recursoTipo: 'cozinha_retirada_ajuste',
        recursoId: inserida.lastID
      });
      await commit(db);
      return resultado;
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

module.exports = {
  retirarItem,
  estornarRetirada,
  cancelarItem,
  estornarCancelamento,
  ajustarRetirada,
  sincronizarEstadoRetiradaRodada,
  sqlRetiradaCompletaRodada,
  serializarTransacao
};
