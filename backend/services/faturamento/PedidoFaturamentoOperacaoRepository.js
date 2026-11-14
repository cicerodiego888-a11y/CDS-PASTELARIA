'use strict';

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
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

function erroConflito(message, extra = {}) {
  const err = new Error(message);
  err.statusCode = 409;
  err.codigo = 'FATURAMENTO_PEDIDO_CONFLITANTE';
  Object.assign(err, extra);
  return err;
}

async function garantirSchema(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedido_faturamento_operacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL UNIQUE,
      empresa_id INTEGER NOT NULL,
      venda_id INTEGER,
      status TEXT NOT NULL DEFAULT 'INICIADA',
      tipo_operacao TEXT NOT NULL DEFAULT 'FATURAMENTO',
      payload_json TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const colunas = await all(db, 'PRAGMA table_info(pedido_faturamento_operacoes)');
  const nomes = new Set(colunas.map((coluna) => String(coluna.name).toLowerCase()));
  if (!nomes.has('tipo_operacao')) {
    await run(
      db,
      "ALTER TABLE pedido_faturamento_operacoes ADD COLUMN tipo_operacao TEXT NOT NULL DEFAULT 'FATURAMENTO'"
    );
  }
  if (!nomes.has('payload_json')) {
    await run(db, 'ALTER TABLE pedido_faturamento_operacoes ADD COLUMN payload_json TEXT');
  }
}

function emCentavos(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.round(numero * 100) : null;
}

async function detectarVendasOrfas(db, pedido, payload) {
  if (!Array.isArray(payload?.itens)) return [];

  const possiveis = await all(db, `
    SELECT v.id, v.empresa_id, v.cliente_id, v.total, v.status, v.status_venda
    FROM vendas v
    WHERE (v.pedido_id IS NULL OR v.pedido_id <> ?)
      AND v.empresa_id = ?
      AND COALESCE(v.cliente_id, 0) = COALESCE(?, 0)
      AND (
        v.created_at IS NULL
        OR ? IS NULL
        OR datetime(v.created_at) >= datetime(?)
      )
      AND v.status = 'concluida'
      AND COALESCE(UPPER(v.status_venda), '') <> 'CANCELADA'
    ORDER BY v.id
  `, [
    pedido.id,
    pedido.empresa_id,
    pedido.cliente_id,
    pedido.created_at || null,
    pedido.created_at || null
  ]);

  const vendasOrfas = [];
  for (const venda of possiveis) {
    if (emCentavos(venda.total) !== emCentavos(payload.total)) continue;
    const itens = await all(db, `
      SELECT produto_id, quantidade, preco_unitario, subtotal
      FROM vendas_itens
      WHERE venda_id = ?
      ORDER BY id
    `, [venda.id]);
    if (itens.length !== payload.itens.length) continue;

    const itensCoincidem = itens.every((item, indice) => {
      const esperado = payload.itens[indice];
      return Number(item.produto_id) === Number(esperado.produto_id)
        && Math.round(Number(item.quantidade) * 1000) === Math.round(Number(esperado.quantidade) * 1000)
        && emCentavos(item.preco_unitario) === emCentavos(esperado.preco_unitario)
        && emCentavos(item.subtotal) === emCentavos(esperado.subtotal);
    });
    if (itensCoincidem) vendasOrfas.push(Number(venda.id));
  }
  return vendasOrfas;
}

async function prepararOperacao(pedidoId, empresaId, payload = {}) {
  const db = require('../../database');
  const transacaoDb = await db.openExclusiveConnection();
  let iniciouTransacao = false;
  let erroOperacao = null;
  let resultado;

  try {
    await garantirSchema(transacaoDb);
    await run(transacaoDb, 'BEGIN IMMEDIATE');
    iniciouTransacao = true;

    const pedido = await get(
      transacaoDb,
      'SELECT id, empresa_id, status, venda_id, cliente_id, created_at FROM pedidos WHERE id = ?',
      [pedidoId]
    );
    if (!pedido) throw erroConflito('Pedido não encontrado durante a preparação do faturamento.');
    if (Number(pedido.empresa_id) !== Number(empresaId)) {
      throw erroConflito('A empresa do Pedido diverge da empresa da operação.', {
        pedido_empresa_id: pedido.empresa_id,
        operacao_empresa_id: empresaId
      });
    }

    let operacao = await get(
      transacaoDb,
      'SELECT * FROM pedido_faturamento_operacoes WHERE pedido_id = ?',
      [pedidoId]
    );
    if (operacao && String(operacao.tipo_operacao || 'FATURAMENTO') !== 'FATURAMENTO') {
      throw erroConflito('O Pedido possui uma operação PDV ativa e não pode ser faturado por outro fluxo.', {
        pedido_id: pedidoId,
        tipo_operacao: operacao.tipo_operacao
      });
    }
    const statusOperacaoAnterior = operacao ? operacao.status : null;

    const candidatos = await all(transacaoDb, `
      SELECT DISTINCT v.id, v.empresa_id, v.pedido_id
      FROM vendas v
      WHERE v.pedido_id = ?
         OR v.id = ?
         OR v.id = ?
      ORDER BY v.id
    `, [pedidoId, pedido.venda_id || 0, operacao?.venda_id || 0]);

    const idsCandidatos = new Set(candidatos.map((venda) => Number(venda.id)));
    if (idsCandidatos.size > 1) {
      throw erroConflito('Há mais de uma venda candidata para este Pedido; nenhuma foi selecionada.', {
        pedido_id: pedidoId,
        venda_ids_candidatas: Array.from(idsCandidatos)
      });
    }
    if (
      pedido.venda_id != null
      && !idsCandidatos.has(Number(pedido.venda_id))
    ) {
      throw erroConflito('O Pedido aponta para uma venda que não existe; faturamento bloqueado.', {
        pedido_id: pedidoId,
        venda_id: pedido.venda_id
      });
    }
    if (!idsCandidatos.size && operacao?.venda_id == null) {
      const vendasOrfas = await detectarVendasOrfas(transacaoDb, pedido, payload);
      if (vendasOrfas.length) {
        throw erroConflito(
          'Há venda(s) sem vínculo compatível com este Pedido; faturamento bloqueado para evitar duplicidade. Verifique os registros antes de retomar.',
          {
            pedido_id: pedidoId,
            venda_ids_candidatas: vendasOrfas,
            codigo: 'FATURAMENTO_VENDA_ORFA'
          }
        );
      }
    }

    if (!operacao) {
      const inserida = await run(transacaoDb, `
        INSERT INTO pedido_faturamento_operacoes (pedido_id, empresa_id, status)
        VALUES (?, ?, 'INICIADA')
      `, [pedidoId, empresaId]);
      operacao = await get(
        transacaoDb,
        'SELECT * FROM pedido_faturamento_operacoes WHERE id = ?',
        [inserida.lastID]
      );
    } else if (Number(operacao.empresa_id) !== Number(empresaId)) {
      throw erroConflito('A operação de faturamento existente pertence a outra empresa.', {
        pedido_id: pedidoId,
        operacao_empresa_id: operacao.empresa_id,
        empresa_id: empresaId
      });
    }

    const vendaCandidata = candidatos[0] || null;
    if (operacao.venda_id != null) {
      if (!vendaCandidata || Number(vendaCandidata.id) !== Number(operacao.venda_id)) {
        throw erroConflito('A venda registrada na operação de faturamento não foi encontrada ou diverge dos vínculos.', {
          pedido_id: pedidoId,
          venda_id: operacao.venda_id
        });
      }
    } else if (vendaCandidata) {
      await run(transacaoDb, `
        UPDATE pedido_faturamento_operacoes
        SET venda_id = ?, status = 'VENDA_CRIADA', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND venda_id IS NULL
      `, [vendaCandidata.id, operacao.id]);
      operacao = await get(
        transacaoDb,
        'SELECT * FROM pedido_faturamento_operacoes WHERE id = ?',
        [operacao.id]
      );
    }

    resultado = {
      pedido,
      operacao,
      vendaCandidata,
      statusOperacaoAnterior
    };
    await run(transacaoDb, 'COMMIT');
    iniciouTransacao = false;
  } catch (err) {
    erroOperacao = err instanceof Error ? err : new Error(String(err));
    if (iniciouTransacao) {
      try {
        await run(transacaoDb, 'ROLLBACK');
      } catch (rollbackError) {
        erroOperacao.rollbackError = rollbackError;
      }
    }
  }

  try {
    await new Promise((resolve, reject) => {
      transacaoDb.close((err) => (err ? reject(err) : resolve()));
    });
  } catch (closeError) {
    if (erroOperacao) erroOperacao.closeError = closeError;
    else erroOperacao = closeError;
  }

  if (erroOperacao) throw erroOperacao;
  return resultado;
}

async function pedidoEmConsolidacao(db, pedidoId) {
  try {
    return await get(db, `
      SELECT c.id, c.status
      FROM venda_consolidacao_pedidos vp
      JOIN venda_consolidacoes c ON c.id = vp.consolidacao_id
      WHERE vp.pedido_id = ?
        AND c.status IN ('RESERVADA', 'EM_CRIACAO', 'VENDA_CRIADA', 'VINCULADA')
    `, [pedidoId]);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return null;
    throw err;
  }
}

async function prepararOperacaoPdv(pedidoId, empresaId, payload) {
  const db = require('../../database');
  const transacaoDb = await db.openExclusiveConnection();
  let iniciouTransacao = false;
  let erroOperacao = null;
  let resultado;

  try {
    await garantirSchema(transacaoDb);
    await run(transacaoDb, 'BEGIN IMMEDIATE');
    iniciouTransacao = true;

    const pedido = await get(transacaoDb, `
      SELECT id, empresa_id, status, venda_id
      FROM pedidos
      WHERE id = ?
    `, [pedidoId]);
    if (!pedido || Number(pedido.empresa_id) !== Number(empresaId)) {
      throw erroConflito('Pedido não encontrado para a empresa informada.');
    }
    if (!['PEDIDO', 'ABERTO', 'EM_SEPARACAO'].includes(String(pedido.status || '').toUpperCase())) {
      throw erroConflito(`Pedido no estado ${pedido.status} não pode iniciar uma venda pelo PDV.`);
    }

    let operacao = await get(
      transacaoDb,
      'SELECT * FROM pedido_faturamento_operacoes WHERE pedido_id = ?',
      [pedidoId]
    );
    if (operacao && Number(operacao.empresa_id) !== Number(empresaId)) {
      throw erroConflito('A operação existente pertence a outra empresa.', { pedido_id: pedidoId });
    }
    if (operacao && String(operacao.tipo_operacao || 'FATURAMENTO') !== 'PDV_COMPOSICAO') {
      throw erroConflito('O Pedido já possui uma operação de faturamento incompatível com o PDV.', {
        pedido_id: pedidoId,
        tipo_operacao: operacao.tipo_operacao
      });
    }

    if (!operacao) {
      if (pedido.venda_id != null) {
        throw erroConflito('O Pedido já aponta para uma venda; a geração foi bloqueada para evitar duplicidade.', {
          pedido_id: pedidoId,
          venda_id: pedido.venda_id
        });
      }
    const reservado = await pedidoEmConsolidacao(transacaoDb, pedidoId);
    if (reservado) {
      throw erroConflito('O pedido participa de uma venda consolidada da mesa.', {
        codigo: 'PEDIDO_EM_CONSOLIDACAO',
        pedido_id: pedidoId,
        consolidacao_id: reservado.id
      });
    }
      const vendaVinculada = await get(
        transacaoDb,
        'SELECT id FROM vendas WHERE pedido_id = ? AND empresa_id = ? LIMIT 1',
        [pedidoId, empresaId]
      );
      if (vendaVinculada) {
        throw erroConflito('Já existe uma venda vinculada ao Pedido sem operação recuperável.', {
          pedido_id: pedidoId,
          venda_id: vendaVinculada.id
        });
      }
      const inserida = await run(transacaoDb, `
        INSERT INTO pedido_faturamento_operacoes
          (pedido_id, empresa_id, status, tipo_operacao, payload_json)
        VALUES (?, ?, 'INICIADA', 'PDV_COMPOSICAO', ?)
      `, [pedidoId, empresaId, JSON.stringify(payload)]);
      operacao = await get(
        transacaoDb,
        'SELECT * FROM pedido_faturamento_operacoes WHERE id = ?',
        [inserida.lastID]
      );
    } else if (operacao.venda_id != null) {
      const venda = await get(transacaoDb, `
        SELECT id, empresa_id, pedido_id
        FROM vendas
        WHERE id = ?
      `, [operacao.venda_id]);
      if (
        !venda
        || Number(venda.empresa_id) !== Number(empresaId)
        || (venda.pedido_id != null && Number(venda.pedido_id) !== Number(pedidoId))
      ) {
        throw erroConflito('A venda persistida na operação não corresponde ao Pedido.', {
          pedido_id: pedidoId,
          venda_id: operacao.venda_id
        });
      }
      let payloadPersistido;
      try {
        payloadPersistido = JSON.parse(operacao.payload_json || 'null');
      } catch (parseError) {
        throw erroConflito('O snapshot da composição persistida não pode ser recuperado.', {
          pedido_id: pedidoId,
          venda_id: operacao.venda_id
        });
      }
      if (!payloadPersistido) {
        throw erroConflito('A operação não contém snapshot recuperável da composição.', {
          pedido_id: pedidoId,
          venda_id: operacao.venda_id
        });
      }
      resultado = { operacao, payload: payloadPersistido, recuperacao: true };
    } else {
      await run(transacaoDb, `
        UPDATE pedido_faturamento_operacoes
        SET payload_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND venda_id IS NULL AND tipo_operacao = 'PDV_COMPOSICAO'
      `, [JSON.stringify(payload), operacao.id]);
      operacao = await get(
        transacaoDb,
        'SELECT * FROM pedido_faturamento_operacoes WHERE id = ?',
        [operacao.id]
      );
      resultado = { operacao, payload, recuperacao: false };
    }

    if (!resultado) resultado = { operacao, payload, recuperacao: false };
    await run(transacaoDb, 'COMMIT');
    iniciouTransacao = false;
  } catch (err) {
    erroOperacao = err instanceof Error ? err : new Error(String(err));
    if (iniciouTransacao) {
      try {
        await run(transacaoDb, 'ROLLBACK');
      } catch (rollbackError) {
        erroOperacao.rollbackError = rollbackError;
      }
    }
  }

  try {
    await new Promise((resolve, reject) => {
      transacaoDb.close((err) => (err ? reject(err) : resolve()));
    });
  } catch (closeError) {
    if (erroOperacao) erroOperacao.closeError = closeError;
    else erroOperacao = closeError;
  }
  if (erroOperacao) throw erroOperacao;
  return resultado;
}

async function consultarOperacaoPdv(pedidoId, empresaId) {
  const db = require('../../database');
  const tabela = await get(
    db,
    "SELECT 1 AS existe FROM sqlite_master WHERE type = 'table' AND name = 'pedido_faturamento_operacoes'"
  );
  if (!tabela) return null;
  const operacao = await get(db, `
    SELECT *
    FROM pedido_faturamento_operacoes
    WHERE pedido_id = ?
  `, [pedidoId]);
  if (!operacao) return null;
  if (
    Number(operacao.empresa_id) !== Number(empresaId)
    || operacao.tipo_operacao !== 'PDV_COMPOSICAO'
  ) {
    return null;
  }
  let payload = null;
  try {
    payload = JSON.parse(operacao.payload_json || 'null');
  } catch (parseError) {
    if (operacao.venda_id != null) {
      throw erroConflito('O snapshot da composição PDV persistida não pode ser recuperado.', {
        pedido_id: pedidoId,
        venda_id: operacao.venda_id
      });
    }
  }
  if (operacao.venda_id != null && !payload) {
    throw erroConflito('A venda persistida não possui um snapshot de composição recuperável.', {
      pedido_id: pedidoId,
      venda_id: operacao.venda_id
    });
  }
  return { operacao, payload };
}

async function registrarVendaCriada(db, operacaoId, pedidoId, empresaId, vendaId) {
  const operacao = await get(db, `
    SELECT id, pedido_id, empresa_id, venda_id
    FROM pedido_faturamento_operacoes
    WHERE id = ?
  `, [operacaoId]);

  if (
    !operacao
    || Number(operacao.pedido_id) !== Number(pedidoId)
    || Number(operacao.empresa_id) !== Number(empresaId)
  ) {
    throw erroConflito('Operação de faturamento inválida ao registrar a venda.', {
      pedido_id: pedidoId,
      venda_id: vendaId
    });
  }

  if (operacao.venda_id != null) {
    throw erroConflito('O Pedido já possui uma venda registrada na operação.', {
      pedido_id: pedidoId,
      venda_id: operacao.venda_id
    });
  }

  const atualizacao = await run(db, `
    UPDATE pedido_faturamento_operacoes
    SET venda_id = ?, status = 'VENDA_CRIADA', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND venda_id IS NULL
  `, [vendaId, operacaoId]);

  if (atualizacao.changes !== 1) {
    throw erroConflito('Não foi possível registrar a venda de forma exclusiva para o Pedido.', {
      pedido_id: pedidoId,
      venda_id: vendaId
    });
  }
}

module.exports = {
  garantirSchema,
  prepararOperacao,
  prepararOperacaoPdv,
  consultarOperacaoPdv,
  registrarVendaCriada,
  erroConflito,
  run,
  get,
  all
};
