/**
 * CozinhaDespachoService — Sprint 02
 * Despacho em lote → uma rodada + FIFO da unidade + idempotência central.
 */
'use strict';

const {
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../utils/cozinhaSchema');
const {
  decimalParaMilessimos,
  milessimosParaDecimalString,
  somarMilessimos,
  subtrairMilessimos
} = require('./cozinhaQuantidade');
const {
  TIPOS_OPERACAO,
  calcularHashOperacao
} = require('./cozinhaIdempotenciaHash');
const {
  classificarTipoItem,
  classificarItemCozinha
} = require('./cozinhaClassificacaoItem');
const CozinhaImpressaoFila = require('./CozinhaImpressaoFilaService');
const CozinhaComandaSnapshot = require('./CozinhaComandaSnapshotService');

const STATUS_DESPACHAVEIS = new Set(['PEDIDO', 'ABERTO', 'EM_SEPARACAO']);

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

function exigirIdempotencyKey(chave) {
  if (chave == null || String(chave).trim() === '') {
    throw erro('Idempotency-Key é obrigatória.', 400, 'IDEMPOTENCY_REQUIRED');
  }
  const texto = String(chave).trim();
  if (texto.length > 200) {
    throw erro('Idempotency-Key inválida.', 400, 'CHAVE_IDEMPOTENCIA_INVALIDA');
  }
  return texto;
}

function qtySnapshotParaMillis(valor) {
  if (valor == null || valor === '') return null;
  try {
    return decimalParaMilessimos(valor);
  } catch (_e) {
    // snapshots legados com mais casas: quantiza truncando à 3ª (só leitura histórica)
    const n = Number(valor);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n * 1000);
  }
}

function montarRespostaRodada(rodada, itensCriados, comandasIds) {
  return {
    success: true,
    repetida: false,
    rodada: {
      id: rodada.id,
      empresa_id: rodada.empresa_id,
      unidade_id: rodada.unidade_id,
      mesa_id: rodada.mesa_id,
      atendimento_id: rodada.atendimento_id,
      numero_rodada: rodada.numero_rodada,
      sequencia_global: rodada.sequencia_global,
      estado_preparacao: rodada.estado_preparacao,
      retirada_estado: rodada.retirada_estado,
      entrega_estado: rodada.entrega_estado,
      enviada_em: rodada.enviada_em
    },
    comandas_ids: comandasIds,
    quantidade_itens: itensCriados.length,
    itens: itensCriados
  };
}

async function despacharLote(entrada = {}, opts = {}) {
  if (!isCozinhaOperacional() && !(opts && opts.db)) {
    const st = getCozinhaSchemaStatus();
    throw erro(
      (st.erro && st.erro.mensagem) || 'Módulo Cozinha não operacional.',
      503,
      'COZINHA_NAO_OPERACIONAL',
      { detalhes: st }
    );
  }

  const empresaId = exigirEmpresa(entrada.empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const idempotencyKey = exigirIdempotencyKey(entrada.idempotencyKey);
  const unidadeId = Number(entrada.unidade_id);
  const mesaId = Number(entrada.mesa_id);
  const atendimentoId = Number(entrada.atendimento_id);
  const itensRaw = Array.isArray(entrada.itens) ? entrada.itens : null;

  if (!Number.isInteger(unidadeId) || unidadeId <= 0) {
    throw erro('unidade_id inválida.', 400, 'UNIDADE_INVALIDA');
  }
  if (!Number.isInteger(mesaId) || mesaId <= 0) {
    throw erro('mesa_id inválida.', 400, 'MESA_INVALIDA');
  }
  if (!Number.isInteger(atendimentoId) || atendimentoId <= 0) {
    throw erro('atendimento_id inválido.', 400, 'ATENDIMENTO_INVALIDO');
  }
  if (!itensRaw || !itensRaw.length) {
    throw erro('Informe ao menos um item para despacho.', 400, 'ITENS_OBRIGATORIOS');
  }

  const itensNorm = [];
  const vistos = new Set();
  for (const raw of itensRaw) {
    const pedidoId = Number(raw.pedido_id);
    const pedidoItemId = Number(raw.pedido_item_id);
    const comandaId = Number(raw.comanda_id);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      throw erro('pedido_id inválido no item.', 400, 'PEDIDO_INVALIDO');
    }
    if (!Number.isInteger(pedidoItemId) || pedidoItemId <= 0) {
      throw erro('pedido_item_id inválido.', 400, 'PEDIDO_ITEM_INVALIDO');
    }
    if (!Number.isInteger(comandaId) || comandaId <= 0) {
      throw erro('comanda_id obrigatório e inválido.', 400, 'COMANDA_ITEM_OBRIGATORIA');
    }
    if (vistos.has(pedidoItemId)) {
      throw erro('Item duplicado no lote.', 400, 'ITEM_DUPLICADO_NO_LOTE');
    }
    vistos.add(pedidoItemId);
    let qtyMillis;
    try {
      qtyMillis = decimalParaMilessimos(
        raw.qty_solicitada != null ? raw.qty_solicitada : raw.quantidade
      );
    } catch (e) {
      if (e && e.codigo === 'QTY_PRECISAO_INVALIDA') throw e;
      throw erro('Quantidade inválida.', 400, 'QTY_INVALIDA');
    }
    if (qtyMillis <= 0) {
      throw erro('Quantidade deve ser maior que zero.', 400, 'QTY_INVALIDA');
    }
    itensNorm.push({
      pedido_id: pedidoId,
      pedido_item_id: pedidoItemId,
      comanda_id: comandaId,
      qty_solicitada: milessimosParaDecimalString(qtyMillis),
      qty_solicitada_millis: qtyMillis
    });
  }

  const hash = calcularHashOperacao(TIPOS_OPERACAO.DESPACHO_LOTE, {
    empresa_id: empresaId,
    unidade_id: unidadeId,
    atendimento_id: atendimentoId,
    mesa_id: mesaId,
    responsavel_operador_id: operadorId,
    itens: itensNorm.map((it) => ({
      pedido_id: it.pedido_id,
      pedido_item_id: it.pedido_item_id,
      comanda_id: it.comanda_id,
      qty_solicitada: it.qty_solicitada
    }))
  });

  const db = conn(opts);
  // FK deve estar ON antes de qualquer TX (SQLite ignora mudança no meio da transação).
  await run(db, 'PRAGMA foreign_keys = ON');
  await beginImmediate(db);
  try {
    // 1) Idempotência ANTES das validações de negócio
    const existente = await get(db, `
      SELECT * FROM cozinha_idempotencia WHERE idempotency_key = ?
    `, [idempotencyKey]);

    if (existente) {
      if (existente.tipo_operacao !== TIPOS_OPERACAO.DESPACHO_LOTE) {
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
        await commit(db);
        const corpo = JSON.parse(existente.resultado_json);
        return { ...corpo, repetida: true };
      }
      if (existente.situacao === 'EM_ANDAMENTO') {
        throw erro(
          'Operação de despacho em andamento para esta chave.',
          409,
          'IDEMPOTENCY_EM_ANDAMENTO'
        );
      }
    }

    const contexto = JSON.stringify({
      empresa_id: empresaId,
      unidade_id: unidadeId,
      atendimento_id: atendimentoId,
      mesa_id: mesaId
    });

    try {
      await run(db, `
        INSERT INTO cozinha_idempotencia (
          idempotency_key, tipo_operacao, contexto, payload_hash, situacao
        ) VALUES (?, ?, ?, ?, 'EM_ANDAMENTO')
      `, [idempotencyKey, TIPOS_OPERACAO.DESPACHO_LOTE, contexto, hash]);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) {
        const novamente = await get(db, `
          SELECT * FROM cozinha_idempotencia WHERE idempotency_key = ?
        `, [idempotencyKey]);
        if (
          novamente
          && novamente.situacao === 'CONCLUIDA'
          && String(novamente.payload_hash) === String(hash)
          && novamente.resultado_json
        ) {
          await commit(db);
          return { ...JSON.parse(novamente.resultado_json), repetida: true };
        }
        throw erro(
          'Conflito de idempotência sob concorrência.',
          409,
          'IDEMPOTENCY_CONCORRENTE'
        );
      }
      throw e;
    }

    // 2) Validações de negócio
    const unidade = await get(db, `
      SELECT id, empresa_id, codigo, ativo, sequencia_atual
      FROM cozinha_unidades
      WHERE id = ? AND empresa_id = ?
    `, [unidadeId, empresaId]);
    if (!unidade) {
      throw erro('Unidade operacional não encontrada.', 404, 'UNIDADE_NAO_ENCONTRADA');
    }
    if (Number(unidade.ativo) !== 1) {
      throw erro('Unidade operacional inativa.', 409, 'UNIDADE_INATIVA');
    }

    const mesa = await get(db, `
      SELECT id, empresa_id, numero, ativo FROM mesas
      WHERE id = ? AND empresa_id = ?
    `, [mesaId, empresaId]);
    if (!mesa) {
      throw erro('Mesa não encontrada.', 404, 'MESA_NAO_ENCONTRADA');
    }
    if (Number(mesa.ativo) !== 1) {
      throw erro('Mesa inativa.', 409, 'MESA_INATIVA');
    }

    const atendimento = await get(db, `
      SELECT id, empresa_id, mesa_id, estado
      FROM mesa_atendimentos
      WHERE id = ? AND empresa_id = ?
    `, [atendimentoId, empresaId]);
    if (!atendimento) {
      throw erro('Atendimento não encontrado.', 404, 'ATENDIMENTO_NAO_ENCONTRADO');
    }
    if (Number(atendimento.mesa_id) !== mesaId) {
      throw erro('Atendimento não pertence à mesa informada.', 409, 'ATENDIMENTO_MESA_INCOMPATIVEL');
    }
    if (atendimento.estado === 'FECHAMENTO') {
      throw erro('Atendimento em fechamento.', 409, 'ATENDIMENTO_EM_FECHAMENTO');
    }
    if (atendimento.estado === 'ENCERRADO') {
      throw erro('Atendimento encerrado.', 409, 'ATENDIMENTO_JA_ENCERRADO');
    }
    if (atendimento.estado !== 'OCUPADA') {
      throw erro('Atendimento não está aberto.', 409, 'ATENDIMENTO_NAO_ABERTO');
    }

    const comandaIds = [...new Set(itensNorm.map((i) => i.comanda_id))];
    const comandas = await all(db, `
      SELECT id, empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id
      FROM cozinha_comandas
      WHERE empresa_id = ? AND id IN (${comandaIds.map(() => '?').join(',')})
    `, [empresaId, ...comandaIds]);
    if (comandas.length !== comandaIds.length) {
      throw erro('Comanda não encontrada para a empresa.', 404, 'COMANDA_NAO_ENCONTRADA');
    }
    const comandasPorId = new Map(comandas.map((c) => [Number(c.id), c]));
    for (const c of comandas) {
      if (Number(c.atendimento_id) !== atendimentoId) {
        throw erro(
          'Comanda não pertence ao atendimento informado.',
          400,
          'COMANDA_ATENDIMENTO_INCOMPATIVEL'
        );
      }
    }

    const itensCriados = [];
    const detalhesPorItem = [];

    for (const linha of itensNorm) {
      const comandaLinha = comandasPorId.get(linha.comanda_id);
      if (
        comandaLinha
        && comandaLinha.pedido_id != null
        && Number(comandaLinha.pedido_id) !== linha.pedido_id
      ) {
        throw erro(
          'Comanda não corresponde ao pedido do item.',
          400,
          'COMANDA_PEDIDO_INCOMPATIVEL'
        );
      }
      const pedido = await get(db, `
        SELECT id, empresa_id, status, mesa_id, mesa_atendimento_id
        FROM pedidos WHERE id = ?
      `, [linha.pedido_id]);
      if (!pedido || Number(pedido.empresa_id) !== empresaId) {
        throw erro('Pedido não encontrado.', 404, 'PEDIDO_NAO_ENCONTRADO');
      }
      if (Number(pedido.mesa_atendimento_id) !== atendimentoId) {
        throw erro(
          'Pedido não pertence ao atendimento informado.',
          400,
          'PEDIDO_ATENDIMENTO_INCOMPATIVEL'
        );
      }
      const status = String(pedido.status || '').toUpperCase();
      if (status === 'CANCELADO' || status === 'ORCAMENTO') {
        throw erro(
          'Pedido em estado incompatível com despacho.',
          409,
          'PEDIDO_ESTADO_INCOMPATIVEL'
        );
      }
      if (!STATUS_DESPACHAVEIS.has(status) && !(status === 'FATURADO' && opts.permitirPedidoFaturado === true)) {
        throw erro(
          'Pedido em estado incompatível com despacho.',
          409,
          'PEDIDO_ESTADO_INCOMPATIVEL'
        );
      }

      const temCategorias = await get(db, `
        SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='categorias'
      `);
      const temFicha = await get(db, `
        SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='ficha_tecnica'
      `);
      const colsProd = await all(db, `PRAGMA table_info(produtos)`);
      const nomesProd = new Set((colsProd || []).map((c) => String(c.name)));
      const colTipoOp = nomesProd.has('tipo_operacional')
        ? "COALESCE(pr.tipo_operacional, 'COMERCIAL')"
        : "'COMERCIAL'";
      const colComerc = nomesProd.has('comercializavel')
        ? 'COALESCE(pr.comercializavel, 0)'
        : '0';
      const colFichaFlag = nomesProd.has('utiliza_ficha_tecnica')
        ? 'pr.utiliza_ficha_tecnica'
        : 'NULL';
      const colPermPers = nomesProd.has('permite_personalizacao_ingredientes')
        ? 'COALESCE(pr.permite_personalizacao_ingredientes, 0)'
        : '0';
      const item = await get(db, `
        SELECT
          i.*,
          COALESCE(NULLIF(i.produto_nome_snapshot, ''), pr.nome) AS produto_nome,
          COALESCE(i.classificacao_operacional_snapshot, UPPER(${colTipoOp}))
            AS classificacao_operacional,
          ${colTipoOp} AS tipo_operacional,
          ${colComerc} AS comercializavel,
          ${colFichaFlag} AS utiliza_ficha_tecnica,
          ${colPermPers} AS permite_personalizacao_ingredientes
          ${temCategorias ? ', c.nome AS categoria_nome' : ', NULL AS categoria_nome'}
        FROM pedidos_itens i
        LEFT JOIN produtos pr ON pr.id = i.produto_id
        ${temCategorias ? 'LEFT JOIN categorias c ON c.id = pr.categoria_id' : ''}
        WHERE i.id = ? AND i.pedido_id = ?
      `, [linha.pedido_item_id, linha.pedido_id]);
      if (!item) {
        throw erro(
          'Item não pertence ao pedido informado.',
          400,
          'ITEM_PEDIDO_INCOMPATIVEL'
        );
      }

      let temFichaAtiva = 0;
      if (temFicha && item.produto_id) {
        const fichaRow = await get(db, `
          SELECT id FROM ficha_tecnica
          WHERE produto_id = ? AND COALESCE(ativo, 1) = 1
          LIMIT 1
        `, [item.produto_id]);
        temFichaAtiva = fichaRow ? 1 : 0;
      }
      item.tem_ficha_tecnica = temFichaAtiva;

      let controle = await get(db, `
        SELECT * FROM cozinha_pedido_item_controle WHERE pedido_item_id = ?
      `, [linha.pedido_item_id]);
      if (!controle) {
        const refMillis = decimalParaMilessimos(item.quantidade);
        await run(db, `
          INSERT INTO cozinha_pedido_item_controle (
            empresa_id, pedido_id, pedido_item_id,
            qty_referencia_despacho_millis, qty_referencia_inicial_millis
          ) VALUES (?, ?, ?, ?, ?)
        `, [empresaId, linha.pedido_id, linha.pedido_item_id, refMillis, refMillis]);
        controle = await get(db, `
          SELECT * FROM cozinha_pedido_item_controle WHERE pedido_item_id = ?
        `, [linha.pedido_item_id]);
      } else if (Number(controle.empresa_id) !== empresaId) {
        throw erro('Controle de quantidade de outra empresa.', 403, 'EMPRESA_ISOLAMENTO');
      }

      const aut = await get(db, `
        SELECT COALESCE(SUM(qty_autorizada_millis), 0) AS total
        FROM cozinha_autorizacoes_qty
        WHERE pedido_item_id = ? AND empresa_id = ? AND situacao = 'ATIVA'
      `, [linha.pedido_item_id, empresaId]);
      const teto = somarMilessimos(
        Number(controle.qty_referencia_despacho_millis),
        Number(aut.total || 0)
      );

      const liquidaRow = await get(db, `
        SELECT COALESCE(SUM(qty_solicitada_millis - qty_cancelada_millis), 0) AS liquida
        FROM cozinha_itens
        WHERE pedido_item_id = ? AND empresa_id = ?
      `, [linha.pedido_item_id, empresaId]);
      const liquida = Number(liquidaRow.liquida || 0);
      const restante = subtrairMilessimos(teto, liquida);
      if (linha.qty_solicitada_millis > restante) {
        throw erro(
          'Quantidade excede o saldo despachável.',
          409,
          'QTY_EXCEDE_RESTANTE',
          {
            detalhes: {
              pedido_item_id: linha.pedido_item_id,
              solicitado: milessimosParaDecimalString(linha.qty_solicitada_millis),
              restante: milessimosParaDecimalString(restante)
            }
          }
        );
      }

      const ingredientes = await all(db, `
        SELECT *
        FROM pedido_item_ingredientes
        WHERE pedido_item_id = ?
        ORDER BY id
      `, [linha.pedido_item_id]);
      item.qtd_ingredientes_pedido = ingredientes.length;

      const classif = classificarItemCozinha(item);
      detalhesPorItem.push({
        linha,
        item,
        tipo_item: classif.tipo,
        classificacao_motivo: classif.motivo,
        ingredientes
      });
    }

    // 3) FIFO + rodada
    const seqUp = await run(db, `
      UPDATE cozinha_unidades
      SET sequencia_atual = sequencia_atual + 1,
          updated_at = datetime('now')
      WHERE id = ? AND empresa_id = ?
    `, [unidadeId, empresaId]);
    if (seqUp.changes !== 1) {
      throw erro('Falha ao atribuir sequência FIFO.', 500, 'FIFO_CONCORRENTE');
    }
    const unidadeAtual = await get(db, `
      SELECT sequencia_atual FROM cozinha_unidades WHERE id = ? AND empresa_id = ?
    `, [unidadeId, empresaId]);
    const sequenciaGlobal = Number(unidadeAtual.sequencia_atual);

    const maxRodada = await get(db, `
      SELECT COALESCE(MAX(numero_rodada), 0) AS m
      FROM cozinha_rodadas
      WHERE atendimento_id = ? AND empresa_id = ?
    `, [atendimentoId, empresaId]);
    const numeroRodada = Number(maxRodada.m) + 1;

    const insRodada = await run(db, `
      INSERT INTO cozinha_rodadas (
        empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global,
        enviada_em, operador_envio_id, estado_preparacao, retirada_estado, entrega_estado,
        idempotency_key_despacho, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        datetime('now'), ?, 'AGUARDANDO', 'PENDENTE', 'PENDENTE',
        ?, datetime('now')
      )
    `, [
      empresaId, unidadeId, mesaId, atendimentoId, numeroRodada, sequenciaGlobal,
      operadorId, idempotencyKey
    ]);
    const rodadaId = insRodada.lastID;

    for (const det of detalhesPorItem) {
      const { linha, item, tipo_item, ingredientes } = det;
      const insItem = await run(db, `
        INSERT INTO cozinha_itens (
          empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global, tipo_item, tipo_lancamento,
          qty_solicitada_millis, qty_preparada_millis, qty_cancelada_millis,
          estado_preparacao, produto_id, produto_nome_snapshot, observacoes_snapshot,
          updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, 'ORIGINAL',
          ?, 0, 0,
          'AGUARDANDO', ?, ?, ?,
          datetime('now')
        )
      `, [
        empresaId, unidadeId, rodadaId, linha.comanda_id, linha.pedido_id, linha.pedido_item_id,
        sequenciaGlobal, tipo_item,
        linha.qty_solicitada_millis,
        item.produto_id || null,
        item.produto_nome_snapshot || item.produto_nome || null,
        item.observacao || item.observacoes || null
      ]);

      for (const ing of ingredientes) {
        await run(db, `
          INSERT INTO cozinha_item_ingredientes (
            cozinha_item_id, insumo_id, insumo_nome_snapshot,
            quantidade_snapshot_millis, unidade_snapshot,
            classificacao_comercial_snapshot, selecionado, preco_adicional_snapshot_millis
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          insItem.lastID,
          ing.insumo_id || null,
          ing.insumo_nome_snapshot,
          qtySnapshotParaMillis(ing.quantidade_snapshot),
          ing.unidade_snapshot || null,
          ing.classificacao_comercial_snapshot || null,
          Number(ing.selecionado) === 1 ? 1 : 0,
          qtySnapshotParaMillis(ing.preco_adicional_snapshot) || 0
        ]);
      }

      itensCriados.push({
        id: insItem.lastID,
        pedido_id: linha.pedido_id,
        pedido_item_id: linha.pedido_item_id,
        comanda_id: linha.comanda_id,
        tipo_item,
        qty_solicitada: milessimosParaDecimalString(linha.qty_solicitada_millis),
        estado_preparacao: 'AGUARDANDO',
        produto_nome_snapshot: item.produto_nome_snapshot || item.produto_nome || null
      });
    }

    const rodada = await get(db, `SELECT * FROM cozinha_rodadas WHERE id = ?`, [rodadaId]);

    if (opts && opts.pedidoSnapshotComandaId) {
      await CozinhaComandaSnapshot.registrar(db, {
        empresaId,
        unidadeId,
        pedidoId: opts.pedidoSnapshotComandaId,
        rodadaId,
        chave: idempotencyKey
      });
      if (opts.simularFalhaAposSnapshot === true) {
        throw erro('Falha simulada após snapshot.', 500, 'SIMULAR_FALHA_SNAPSHOT');
      }
    }

    // Sprint 06 B2: enfileira jobs na MESMA TX (D2=a). Sem print físico.
    // Ausência de estação → aviso IMPRESSAO_SEM_ESTACAO; despacho segue (D5).
    // mesa.numero = número visível; mesa.id nunca substitui mesa_numero no snapshot.
    // S07-3E: omitirEnfileiramentoImpressao=true separa despacho operacional KDS da fila S06
    // sem alterar o fluxo legado (POST /api/cozinha/despacho continua enfileirando).
    if (!(opts && opts.omitirEnfileiramentoImpressao === true)) {
      await CozinhaImpressaoFila.enfileirarDaRodada({
        db,
        empresaId,
        unidadeId,
        rodadaId,
        mesa_numero: String(mesa.numero)
      }, { db });

      if (opts && opts.simularFalhaAposEnfileirarImpressao) {
        throw erro(
          'Falha simulada após enfileirar impressão.',
          500,
          'SIMULAR_FALHA_IMPRESSAO'
        );
      }
    }

    const resposta = montarRespostaRodada(rodada, itensCriados, comandaIds);

    await run(db, `
      UPDATE cozinha_idempotencia
      SET situacao = 'CONCLUIDA',
          resultado_http_status = 201,
          resultado_json = ?,
          recurso_tipo = 'rodada',
          recurso_id = ?,
          concluded_at = datetime('now')
      WHERE idempotency_key = ?
    `, [JSON.stringify(resposta), rodadaId, idempotencyKey]);

    await commit(db);
    return resposta;
  } catch (err) {
    await rollback(db);
    throw err;
  }
}

module.exports = {
  despacharLote,
  STATUS_DESPACHAVEIS,
  classificarTipoItem,
  classificarItemCozinha
};
