/**
 * MESAS-05.3 — uma venda oficial para vários pedidos da mesma mesa.
 * A criação da venda ocorre uma vez, no núcleo já usado pelo PDV.
 * O vínculo dos pedidos é outra etapa e não abre uma segunda venda.
 */
'use strict';

const { VendaOrigin } = require('./VendaOrigin');

const STATUS_ELEGIVEL = Object.freeze(['PEDIDO', 'ABERTO', 'EM_SEPARACAO']);
const emCurso = new Map();

function erro(mensagem, statusCode, codigo) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  return err;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
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

function conn(opts) {
  return (opts && opts.db) || require('../../database');
}

function centavos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  return Math.round(numero * 100);
}

function idsPedidos(lista) {
  const ids = [...new Set((Array.isArray(lista) ? lista : []).map((id) => Number(id)))];
  if (ids.length < 2 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw erro('Informe ao menos dois pedidos da mesma mesa.', 400, 'PEDIDOS_INSUFICIENTES');
  }
  return ids;
}

async function garantirSchema(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS venda_consolidacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      mesa_id INTEGER NOT NULL,
      mesa_atendimento_id INTEGER NOT NULL,
      venda_id INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      operador_id INTEGER,
      total REAL NOT NULL,
      desconto REAL NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS venda_consolidacao_pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consolidacao_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL UNIQUE,
      empresa_id INTEGER NOT NULL,
      venda_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS venda_consolidacao_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consolidacao_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL,
      subtotal REAL NOT NULL,
      observacao TEXT,
      UNIQUE (consolidacao_id, pedido_item_id)
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS venda_consolidacao_chaves (
      idempotency_key TEXT PRIMARY KEY,
      consolidacao_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      selecao_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function agruparPedidos(linhas) {
  const pedidos = new Map();
  for (const linha of linhas) {
    if (!pedidos.has(linha.id)) {
      pedidos.set(linha.id, {
        id: linha.id,
        codigo: linha.codigo,
        empresa_id: linha.empresa_id,
        mesa_id: linha.mesa_id,
        mesa_atendimento_id: linha.mesa_atendimento_id,
        status: String(linha.status || '').toUpperCase(),
        venda_id: linha.venda_id,
        total: Number(linha.total || 0),
        desconto: Number(linha.desconto || 0),
        observacao: linha.observacao || '',
        cliente_id: linha.cliente_id,
        itens: []
      });
    }
    if (linha.item_id != null) {
      pedidos.get(linha.id).itens.push({
        id: linha.item_id,
        produto_id: linha.produto_id,
        quantidade: Number(linha.quantidade),
        preco_unitario: Number(linha.preco_unitario),
        subtotal: Number(linha.subtotal),
        tipo_venda: linha.tipo_venda || 'PESO',
        nome: linha.produto_nome_snapshot || ''
      });
    }
  }
  return [...pedidos.values()];
}

function validarGrupo(pedidos, mesaId) {
  const atendimentoIds = new Set(pedidos.map((pedido) => Number(pedido.mesa_atendimento_id)));
  const mesas = new Set(pedidos.map((pedido) => Number(pedido.mesa_id)));
  if (pedidos.some((pedido) => pedido.mesa_id == null)) {
    throw erro('Pedido sem mesa não entra na venda consolidada.', 409, 'PEDIDO_SEM_MESA');
  }
  if (mesas.size !== 1 || !mesas.has(Number(mesaId))) {
    throw erro('A venda consolidada só reúne pedidos da mesma mesa.', 409, 'MESAS_DIFERENTES');
  }
  if (atendimentoIds.size !== 1 || atendimentoIds.has(0)) {
    throw erro('A venda consolidada só reúne pedidos do mesmo atendimento.', 409, 'ATENDIMENTOS_DIFERENTES');
  }
  for (const pedido of pedidos) {
    if (!STATUS_ELEGIVEL.includes(pedido.status)) {
      const codigo = pedido.status === 'CANCELADO'
        ? 'PEDIDO_CANCELADO'
        : (pedido.status === 'FATURADO' ? 'PEDIDO_FATURADO' : 'PEDIDO_ESTADO_INCOMPATIVEL');
      throw erro(`O pedido ${pedido.codigo || pedido.id} não pode entrar na venda consolidada.`, 409, codigo);
    }
    if (pedido.venda_id != null) {
      throw erro(`O pedido ${pedido.codigo || pedido.id} já está vinculado a uma venda.`, 409, 'PEDIDO_JA_VINCULADO');
    }
    if (!pedido.itens.length) {
      throw erro(`O pedido ${pedido.codigo || pedido.id} não tem itens.`, 409, 'PEDIDO_SEM_ITENS');
    }
    let bruto = 0;
    for (const item of pedido.itens) {
      const subtotal = centavos(item.subtotal);
      const preco = centavos(item.preco_unitario);
      if (!Number.isSafeInteger(subtotal) || subtotal <= 0 || !Number.isSafeInteger(preco) || preco <= 0 || !(item.quantidade > 0)) {
        throw erro(`O pedido ${pedido.codigo || pedido.id} tem item sem valor comercial.`, 409, 'PEDIDO_SEM_ITENS');
      }
      bruto += subtotal;
    }
    const liquido = bruto - centavos(pedido.desconto || 0);
    if (liquido !== centavos(pedido.total)) {
      throw erro(`O total do pedido ${pedido.codigo || pedido.id} não confere com os itens gravados.`, 409, 'TOTAL_DIVERGENTE');
    }
  }
  return Number([...atendimentoIds][0]);
}

function montarContrato(pedidos, consolidacaoId) {
  const itens = [];
  let bruto = 0;
  let desconto = 0;
  const clientes = new Set(pedidos.map((pedido) => pedido.cliente_id).filter((id) => id != null));
  for (const pedido of pedidos) {
    desconto += centavos(pedido.desconto || 0);
    for (const item of pedido.itens) {
      bruto += centavos(item.subtotal);
      itens.push({
        produto_id: Number(item.produto_id),
        quantidade: Number(item.quantidade),
        preco_unitario: Number(item.preco_unitario),
        subtotal: Number(item.subtotal),
        desconto_percentual: 0,
        desconto_valor: 0,
        desconto_atacado: 0,
        desconto_manual: 0,
        tipo_preco: 'varejo',
        promocao_id: null,
        preco_origem: Number(item.preco_unitario),
        tipo_venda: item.tipo_venda || 'PESO',
        pedido_id: pedido.id,
        pedido_item_id: item.id,
        observacao: pedido.observacao || '',
        produto_nome: item.nome || ''
      });
    }
  }
  const total = (bruto - desconto) / 100;
  return {
    origem: VendaOrigin.PDV,
    emitir_fiscal: false,
    pedido_id: null,
    consolidacao_id: consolidacaoId || null,
    cliente_id: clientes.size === 1 ? [...clientes][0] : null,
    total,
    desconto: desconto / 100,
    itens
  };
}

function assinaturaItem(item) {
  const produtoId = Number(item && item.produto_id);
  const quantidade = Math.round(Number(item && item.quantidade) * 1000);
  const preco = centavos(item && item.preco_unitario);
  const subtotal = centavos(item && item.subtotal);
  if (
    !Number.isInteger(produtoId)
    || produtoId <= 0
    || !Number.isSafeInteger(quantidade)
    || quantidade <= 0
    || !Number.isSafeInteger(preco)
    || !Number.isSafeInteger(subtotal)
  ) return null;
  return `${produtoId}:${quantidade}:${preco}:${subtotal}`;
}

function itensCoincidem(esperados, recebidos) {
  if (!Array.isArray(esperados) || !Array.isArray(recebidos) || esperados.length !== recebidos.length) {
    return false;
  }
  const contagem = new Map();
  for (const item of esperados) {
    const assinatura = assinaturaItem(item);
    if (!assinatura) return false;
    contagem.set(assinatura, (contagem.get(assinatura) || 0) + 1);
  }
  for (const item of recebidos) {
    const assinatura = assinaturaItem(item);
    const quantidade = assinatura ? contagem.get(assinatura) : 0;
    if (!quantidade) return false;
    if (quantidade === 1) contagem.delete(assinatura);
    else contagem.set(assinatura, quantidade - 1);
  }
  return contagem.size === 0;
}

async function carregarPedidos(db, empresaId, ids) {
  const marcas = ids.map(() => '?').join(', ');
  const linhas = await all(db, `
    SELECT p.id, p.codigo, p.empresa_id, p.mesa_id, p.mesa_atendimento_id, p.status,
           p.venda_id, p.total, p.desconto, p.observacao, p.cliente_id,
           i.id AS item_id, i.produto_id, i.quantidade, i.preco_unitario, i.subtotal,
           i.tipo_venda, i.produto_nome_snapshot
    FROM pedidos p
    LEFT JOIN pedidos_itens i ON i.pedido_id = p.id
    WHERE p.empresa_id = ? AND p.id IN (${marcas})
  `, [empresaId, ...ids]);
  const pedidos = agruparPedidos(linhas);
  if (pedidos.length !== ids.length) {
    const encontrados = await all(db, `
      SELECT id, empresa_id FROM pedidos WHERE id IN (${marcas})
    `, ids);
    const outraEmpresa = encontrados.some((pedido) => Number(pedido.empresa_id) !== Number(empresaId));
    throw erro(
      outraEmpresa ? 'Um dos pedidos pertence a outra empresa.' : 'Um dos pedidos não foi encontrado.',
      outraEmpresa ? 409 : 404,
      outraEmpresa ? 'PEDIDO_OUTRA_EMPRESA' : 'PEDIDO_NAO_ENCONTRADO'
    );
  }
  return pedidos;
}

async function lerConsolidacao(db, id, empresaId) {
  const row = await get(db, `
    SELECT * FROM venda_consolidacoes WHERE id = ? AND empresa_id = ?
  `, [id, empresaId]);
  if (!row) throw erro('A consolidação não foi encontrada nesta empresa.', 404, 'CONSOLIDACAO_NAO_ENCONTRADA');
  row.payload = JSON.parse(row.payload_json);
  row.pedidos = await all(db, `
    SELECT pedido_id, venda_id FROM venda_consolidacao_pedidos WHERE consolidacao_id = ?
  `, [id]);
  return row;
}

function assinaturaSelecao(empresaId, mesaId, ids) {
  return JSON.stringify({
    empresa_id: Number(empresaId),
    mesa_id: Number(mesaId),
    pedido_ids: ids.slice().sort((a, b) => a - b)
  });
}

function idsConsolidacao(consolidacao) {
  return (consolidacao.pedidos || [])
    .map((pedido) => Number(pedido.pedido_id))
    .sort((a, b) => a - b);
}

function selecaoConsolidacaoCoincide(consolidacao, mesaId, ids) {
  const participantes = idsConsolidacao(consolidacao);
  const solicitados = ids.slice().sort((a, b) => a - b);
  return Number(consolidacao.mesa_id) === Number(mesaId)
    && participantes.length === solicitados.length
    && participantes.every((id, indice) => id === solicitados[indice]);
}

async function registrarChave(db, chave, consolidacao, assinatura) {
  const existente = await get(db, `
    SELECT consolidacao_id, empresa_id, selecao_json
    FROM venda_consolidacao_chaves WHERE idempotency_key = ?
  `, [chave]);
  if (
    existente
    && (
      Number(existente.consolidacao_id) !== Number(consolidacao.id)
      || Number(existente.empresa_id) !== Number(consolidacao.empresa_id)
      || existente.selecao_json !== assinatura
    )
  ) {
    throw erro(
      'A chave de idempotência já foi usada com outra mesa ou seleção de pedidos.',
      409,
      'IDEMPOTENCIA_CONTEUDO_DIVERGENTE'
    );
  }
  if (!existente) {
    await run(db, `
      INSERT INTO venda_consolidacao_chaves
        (idempotency_key, consolidacao_id, empresa_id, selecao_json)
      VALUES (?, ?, ?, ?)
    `, [chave, consolidacao.id, consolidacao.empresa_id, assinatura]);
  }
}

function validarReservaRecuperavel(consolidacao) {
  if (consolidacao.status === 'FALHA_CRIACAO') {
    throw erro(
      'A consolidação anterior falhou durante a criação da venda e precisa ser verificada antes de uma nova tentativa.',
      409,
      'CONSOLIDACAO_FALHA_CRIACAO'
    );
  }
  if (consolidacao.status === 'EM_CRIACAO' && consolidacao.venda_id == null) {
    throw erro(
      'A criação da venda desta consolidação ainda está em andamento.',
      409,
      'CONSOLIDACAO_EM_ANDAMENTO'
    );
  }
  if (
    !['RESERVADA', 'EM_CRIACAO', 'VENDA_CRIADA', 'VINCULADA'].includes(consolidacao.status)
    || (consolidacao.status === 'RESERVADA' && consolidacao.venda_id != null)
    || (['VENDA_CRIADA', 'VINCULADA'].includes(consolidacao.status) && consolidacao.venda_id == null)
  ) {
    throw erro(
      'O estado da consolidação anterior não permite recuperação automática.',
      409,
      'CONSOLIDACAO_NAO_RECUPERAVEL'
    );
  }
}

async function buscarReservaPorSelecao(db, empresaId, mesaId, ids) {
  const marcas = ids.map(() => '?').join(', ');
  const candidatos = await all(db, `
    SELECT DISTINCT c.id
    FROM venda_consolidacoes c
    JOIN venda_consolidacao_pedidos cp ON cp.consolidacao_id = c.id
    WHERE c.empresa_id = ? AND cp.pedido_id IN (${marcas})
  `, [empresaId, ...ids]);
  const solicitados = ids.slice().sort((a, b) => a - b);
  const encontrados = [];
  let sobreposicao = false;

  for (const candidato of candidatos) {
    const consolidacao = await lerConsolidacao(db, candidato.id, empresaId);
    const participantes = consolidacao.pedidos.map((pedido) => Number(pedido.pedido_id)).sort((a, b) => a - b);
    if (
      participantes.length !== solicitados.length
      || participantes.some((id, indice) => id !== solicitados[indice])
    ) {
      sobreposicao = true;
      continue;
    }
    if (Number(consolidacao.mesa_id) !== Number(mesaId)) {
      throw erro(
        'Os pedidos já pertencem a uma consolidação de outra mesa.',
        409,
        'PEDIDO_EM_OUTRA_CONSOLIDACAO'
      );
    }
    validarReservaRecuperavel(consolidacao);
    encontrados.push(consolidacao);
  }

  if (sobreposicao) {
    throw erro('Um dos pedidos já participa de outra consolidação.', 409, 'PEDIDO_EM_OUTRA_CONSOLIDACAO');
  }
  if (encontrados.length > 1) {
    throw erro('A seleção está associada a mais de uma consolidação e exige verificação.', 409, 'CONSOLIDACAO_AMBIGUA');
  }
  if (encontrados.length === 1) return encontrados[0];

  const falhas = await all(db, `
    SELECT id, mesa_id, mesa_atendimento_id, venda_id, status, payload_json
    FROM venda_consolidacoes
    WHERE empresa_id = ? AND status = 'FALHA_CRIACAO'
  `, [empresaId]);
  for (const falha of falhas) {
    let pedidoIdsFalha = [];
    try {
      const payload = JSON.parse(falha.payload_json || '{}');
      pedidoIdsFalha = [...new Set((payload.itens || [])
        .map((item) => Number(item.pedido_id))
        .filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
    } catch (parseError) {
      throw erro(
        'Uma consolidação anterior com falha não pôde ser verificada com segurança.',
        409,
        'CONSOLIDACAO_FALHA_NAO_VERIFICAVEL'
      );
    }
    if (pedidoIdsFalha.some((id) => solicitados.includes(id))) {
      throw erro(
        'A consolidação anterior falhou durante a criação da venda e precisa ser verificada antes de uma nova tentativa.',
        409,
        'CONSOLIDACAO_FALHA_CRIACAO'
      );
    }
  }

  return null;
}

async function reservar(db, entrada) {
  const empresaId = Number(entrada.empresaId);
  const mesaId = Number(entrada.mesaId);
  const operadorId = Number(entrada.operadorId);
  const chave = String(entrada.idempotencyKey || '').trim();
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw erro('Empresa inválida.', 400, 'EMPRESA_INVALIDA');
  if (!Number.isInteger(mesaId) || mesaId <= 0) throw erro('Mesa inválida.', 400, 'MESA_INVALIDA');
  if (!chave) throw erro('A venda consolidada exige uma chave de idempotência.', 400, 'IDEMPOTENCIA_AUSENTE');
  const ids = idsPedidos(entrada.pedidoIds);
  const assinatura = assinaturaSelecao(empresaId, mesaId, ids);

  await garantirSchema(db);
  await run(db, 'BEGIN IMMEDIATE');
  try {
    let reservaExistente = null;
    const chaveAlias = await get(db, `
      SELECT consolidacao_id, empresa_id, selecao_json
      FROM venda_consolidacao_chaves WHERE idempotency_key = ?
    `, [chave]);
    if (chaveAlias) {
      if (Number(chaveAlias.empresa_id) !== empresaId || chaveAlias.selecao_json !== assinatura) {
        throw erro(
          'A chave de idempotência já foi usada com outra empresa, mesa ou seleção de pedidos.',
          409,
          'IDEMPOTENCIA_CONTEUDO_DIVERGENTE'
        );
      }
      reservaExistente = await lerConsolidacao(db, chaveAlias.consolidacao_id, empresaId);
      if (!selecaoConsolidacaoCoincide(reservaExistente, mesaId, ids)) {
        throw erro(
          'A chave de idempotência já foi usada com outra mesa ou seleção de pedidos.',
          409,
          'IDEMPOTENCIA_CONTEUDO_DIVERGENTE'
        );
      }
      validarReservaRecuperavel(reservaExistente);
    } else {
      const existente = await get(db, `
        SELECT * FROM venda_consolidacoes WHERE idempotency_key = ?
      `, [chave]);
      if (existente) {
        if (Number(existente.empresa_id) !== empresaId) {
          throw erro('A chave de idempotência pertence a outra empresa.', 409, 'IDEMPOTENCIA_OUTRA_EMPRESA');
        }
        reservaExistente = await lerConsolidacao(db, existente.id, empresaId);
        if (!selecaoConsolidacaoCoincide(reservaExistente, mesaId, ids)) {
          throw erro(
            'A chave de idempotência já foi usada com outra mesa ou seleção de pedidos.',
            409,
            'IDEMPOTENCIA_CONTEUDO_DIVERGENTE'
          );
        }
        validarReservaRecuperavel(reservaExistente);
      }
    }

    if (!reservaExistente) {
      reservaExistente = await buscarReservaPorSelecao(db, empresaId, mesaId, ids);
    }
    if (
      reservaExistente
      && reservaExistente.status !== 'RESERVADA'
    ) {
      await registrarChave(db, chave, reservaExistente, assinatura);
      await run(db, 'COMMIT');
      return reservaExistente;
    }

    const pedidos = await carregarPedidos(db, empresaId, ids);
    const atendimentoId = validarGrupo(pedidos, mesaId);
    if (
      reservaExistente
      && Number(reservaExistente.mesa_atendimento_id) !== Number(atendimentoId)
    ) {
      throw erro(
        'Os pedidos já pertencem a uma consolidação de outro atendimento.',
        409,
        'PEDIDO_EM_OUTRA_CONSOLIDACAO'
      );
    }
    const atendimento = await get(db, `
      SELECT id, estado FROM mesa_atendimentos
      WHERE id = ? AND empresa_id = ? AND mesa_id = ?
    `, [atendimentoId, empresaId, mesaId]);
    if (!atendimento || atendimento.estado !== 'OCUPADA') {
      throw erro('O atendimento da mesa não está aberto.', 409, 'ATENDIMENTO_NAO_ABERTO');
    }

    for (const pedido of pedidos) {
      const operacao = await get(db, `
        SELECT id, venda_id, status FROM pedido_faturamento_operacoes
        WHERE pedido_id = ? AND empresa_id = ?
      `, [pedido.id, empresaId]);
      if (operacao) {
        throw erro('O pedido já está em um fechamento individual.', 409, 'PEDIDO_FECHAMENTO_INDIVIDUAL');
      }
    }
    if (reservaExistente) {
      await registrarChave(db, chave, reservaExistente, assinatura);
      await run(db, 'COMMIT');
      return reservaExistente;
    }

    const contrato = montarContrato(pedidos, null);
    const inserida = await run(db, `
      INSERT INTO venda_consolidacoes (
        empresa_id, mesa_id, mesa_atendimento_id, idempotency_key, status,
        operador_id, total, desconto, payload_json
      ) VALUES (?, ?, ?, ?, 'RESERVADA', ?, ?, ?, ?)
    `, [
      empresaId, mesaId, atendimentoId, chave, operadorId || null,
      contrato.total, contrato.desconto, JSON.stringify(contrato)
    ]);
    for (const pedido of pedidos) {
      await run(db, `
        INSERT INTO venda_consolidacao_pedidos (consolidacao_id, pedido_id, empresa_id)
        VALUES (?, ?, ?)
      `, [inserida.lastID, pedido.id, empresaId]);
      for (const item of contrato.itens.filter((linha) => linha.pedido_id === pedido.id)) {
        await run(db, `
          INSERT INTO venda_consolidacao_itens (
            consolidacao_id, pedido_id, pedido_item_id, produto_id,
            quantidade, preco_unitario, subtotal, observacao
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          inserida.lastID, pedido.id, item.pedido_item_id, item.produto_id,
          item.quantidade, item.preco_unitario, item.subtotal, item.observacao
        ]);
      }
    }
    await registrarChave(db, chave, {
      id: inserida.lastID,
      empresa_id: empresaId
    }, assinatura);
    await run(db, 'COMMIT');
    return lerConsolidacao(db, inserida.lastID, empresaId);
  } catch (err) {
    try { await run(db, 'ROLLBACK'); } catch (_rollback) { /* a transação pode já ter sido encerrada */ }
    if (/venda_consolidacao_pedidos/i.test(String(err.message || '')) && /UNIQUE/i.test(String(err.message || ''))) {
      throw erro('Um dos pedidos já participa de outra consolidação.', 409, 'PEDIDO_EM_OUTRA_CONSOLIDACAO');
    }
    throw err;
  }
}

async function liberarFalha(db, consolidacao) {
  await run(db, 'BEGIN IMMEDIATE');
  try {
    await run(db, `
      UPDATE venda_consolidacoes
      SET status = 'FALHA_CRIACAO', updated_at = datetime('now')
      WHERE id = ? AND venda_id IS NULL
    `, [consolidacao.id]);
    await run(db, 'COMMIT');
  } catch (err) {
    try { await run(db, 'ROLLBACK'); } catch (_rollback) { /* ignore */ }
    throw err;
  }
}

function nucleoOficial(contrato, entrada) {
  const VendaApplicationService = require('./VendaApplicationService');
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = {
      body: contrato,
      empresaId: entrada.empresaId,
      user: { id: entrada.operadorId },
      headers: {},
      get() { return null; }
    };
    const finish = (statusCode, body) => {
      if (settled) return;
      settled = true;
      if (statusCode >= 400 || !body || (!body.venda_id && !body.id)) {
        const falha = erro(
          (body && (body.error || body.mensagem)) || 'A venda consolidada não foi criada.',
          statusCode || 500,
          'VENDA_NAO_CRIADA'
        );
        falha.pedidos_faturados = false;
        reject(falha);
        return;
      }
      resolve({
        venda_id: Number(body.venda_id || body.id),
        status_pagamento: body.status_pagamento || null
      });
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { finish(this.statusCode || 200, body); return this; }
    };
    try {
      const ret = VendaApplicationService.concluirVendaNoNucleoOficial(
        req,
        res,
        { origem: VendaOrigin.PDV },
        { payload: contrato, origem: VendaOrigin.PDV }
      );
      if (ret && typeof ret.then === 'function') ret.catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function vincular(entrada, opts = {}) {
  const db = conn(opts);
  const Operacao = require('../faturamento/PedidoFaturamentoOperacaoRepository');
  await Operacao.garantirSchema(db);
  const empresaId = Number(entrada.empresaId);
  const consolidacao = await lerConsolidacao(db, Number(entrada.consolidacaoId), empresaId);
  if (consolidacao.status === 'VINCULADA' && Number(consolidacao.venda_id) === Number(entrada.vendaId)) {
    const Atendimento = require('../pedido/MesaAtendimentoService');
    const mesa = await Atendimento.encerrarAtendimentoQuitado(
      empresaId,
      consolidacao.pedidos[0] && consolidacao.pedidos[0].pedido_id,
      { operadorId: entrada.operadorId },
      { db }
    );
    return {
      consolidacao,
      idempotente: true,
      venda_id: Number(consolidacao.venda_id),
      mesa
    };
  }
  if (consolidacao.venda_id != null && Number(consolidacao.venda_id) !== Number(entrada.vendaId)) {
    throw erro('A consolidação já possui outra venda e não será substituída.', 409, 'VENDA_DIVERGENTE');
  }
  const vendaId = Number(entrada.vendaId);
  const venda = await get(db, `
    SELECT id, empresa_id, total, desconto, status, status_pagamento, pedido_id
    FROM vendas WHERE id = ? AND empresa_id = ?
  `, [vendaId, empresaId]);
  if (!venda) throw erro('A venda não pertence a esta empresa.', 404, 'VENDA_NAO_ENCONTRADA');
  if (String(venda.status || '').toLowerCase() !== 'concluida') {
    throw erro('A venda ainda não está concluída.', 409, 'VENDA_NAO_CONCLUIDA');
  }
  if (centavos(venda.total) !== centavos(consolidacao.payload.total)) {
    throw erro('O total da venda não confere com os pedidos reservados.', 409, 'TOTAL_DIVERGENTE');
  }
  if (venda.pedido_id != null) {
    throw erro('A venda já pertence a outro pedido e não será reaproveitada.', 409, 'VENDA_DE_OUTRO_PEDIDO');
  }
  const itensVenda = await all(db, `
    SELECT produto_id, quantidade, preco_unitario, subtotal
    FROM vendas_itens WHERE venda_id = ? ORDER BY id
  `, [vendaId]);
  if (!itensCoincidem(consolidacao.payload.itens, itensVenda)) {
    throw erro('Os itens da venda não conferem com a consolidação.', 409, 'ITENS_DIVERGENTES');
  }

  if (typeof opts.antesDeVincular === 'function') await opts.antesDeVincular(consolidacao, venda);

  await run(db, 'BEGIN IMMEDIATE');
  try {
    const estadoAtual = await get(db, `
      SELECT venda_id, status FROM venda_consolidacoes
      WHERE id = ? AND empresa_id = ?
    `, [consolidacao.id, empresaId]);
    if (estadoAtual && estadoAtual.status === 'VINCULADA' && Number(estadoAtual.venda_id) === vendaId) {
      consolidacao.status = 'VINCULADA';
      consolidacao.venda_id = vendaId;
    } else {
      const consolidacaoAtualizada = await run(db, `
        UPDATE venda_consolidacoes
        SET venda_id = ?, status = 'VINCULADA', updated_at = datetime('now')
        WHERE id = ? AND empresa_id = ? AND (venda_id IS NULL OR venda_id = ?)
      `, [vendaId, consolidacao.id, empresaId, vendaId]);
      if (consolidacaoAtualizada.changes !== 1) {
        throw erro('A consolidação já está vinculada a outra venda.', 409, 'VENDA_DIVERGENTE');
      }
      for (const participante of consolidacao.pedidos) {
        const marcado = await run(db, `
          UPDATE pedidos
          SET status = 'FATURADO', venda_id = ?, faturado_em = datetime('now'),
              faturado_por = ?, updated_at = datetime('now')
          WHERE id = ? AND empresa_id = ? AND venda_id IS NULL
            AND status IN ('PEDIDO', 'ABERTO', 'EM_SEPARACAO')
        `, [vendaId, entrada.operadorId || null, participante.pedido_id, empresaId]);
        if (marcado.changes !== 1) {
          throw erro('O vínculo de um pedido não pôde ser gravado sem criar outra venda.', 409, 'VINCULO_NAO_GRAVADO');
        }
        await run(db, `
          INSERT INTO pedido_faturamento_operacoes
            (pedido_id, empresa_id, venda_id, status, tipo_operacao, payload_json)
          VALUES (?, ?, ?, 'FINALIZADA', 'PDV_COMPOSICAO', ?)
        `, [participante.pedido_id, empresaId, vendaId, consolidacao.payload_json]);
        await run(db, `
          UPDATE venda_consolidacao_pedidos SET venda_id = ? WHERE consolidacao_id = ? AND pedido_id = ?
        `, [vendaId, consolidacao.id, participante.pedido_id]);
      }
    }
    await run(db, 'COMMIT');
  } catch (err) {
    try { await run(db, 'ROLLBACK'); } catch (_rollback) { /* ignore */ }
    throw err;
  }

  const Atendimento = require('../pedido/MesaAtendimentoService');
  const mesa = await Atendimento.encerrarAtendimentoQuitado(
    empresaId,
    consolidacao.pedidos[0].pedido_id,
    { operadorId: entrada.operadorId },
    { db }
  );
  return {
    consolidacao: await lerConsolidacao(db, consolidacao.id, empresaId),
    venda_id: vendaId,
    idempotente: false,
    mesa
  };
}

async function executar(entrada, opts) {
  const db = conn(opts);
  let consolidacao = await reservar(db, entrada);
  if (consolidacao.status === 'VINCULADA') {
    return { consolidacao, venda_id: Number(consolidacao.venda_id), idempotente: true, criada: false };
  }
  if (!consolidacao.venda_id) {
    const reivindicada = await run(db, `
      UPDATE venda_consolidacoes SET status = 'EM_CRIACAO', updated_at = datetime('now')
      WHERE id = ? AND status = 'RESERVADA' AND venda_id IS NULL
    `, [consolidacao.id]);
    if (reivindicada.changes !== 1) {
      const atual = await lerConsolidacao(db, consolidacao.id, Number(entrada.empresaId));
      if (atual.venda_id == null) {
        throw erro(
          'A criação da venda desta consolidação já está em andamento.',
          409,
          'CONSOLIDACAO_EM_ANDAMENTO'
        );
      }
      consolidacao = atual;
    }
  }
  if (!consolidacao.venda_id) {
    const contrato = { ...consolidacao.payload, consolidacao_id: consolidacao.id };
    try {
      const nucleo = opts.nucleo || nucleoOficial;
      const criada = await nucleo(contrato, entrada);
      if (!criada || !Number.isInteger(Number(criada.venda_id)) || Number(criada.venda_id) <= 0) {
        throw erro('O núcleo não devolveu a venda.', 500, 'VENDA_NAO_CRIADA');
      }
      await run(db, `
        UPDATE venda_consolidacoes
        SET venda_id = ?, status = 'VENDA_CRIADA', updated_at = datetime('now')
        WHERE id = ? AND venda_id IS NULL
      `, [Number(criada.venda_id), consolidacao.id]);
    } catch (err) {
      await liberarFalha(db, consolidacao);
      err.pedidos_faturados = false;
      throw err;
    }
  }
  return vincular({
    empresaId: entrada.empresaId,
    consolidacaoId: consolidacao.id,
    vendaId: (await lerConsolidacao(db, consolidacao.id, Number(entrada.empresaId))).venda_id,
    operadorId: entrada.operadorId
  }, opts);
}

function concluir(entrada, opts = {}) {
  const chave = String(entrada && entrada.idempotencyKey || '');
  if (emCurso.has(chave)) return emCurso.get(chave);
  const promessa = executar(entrada, opts).finally(() => emCurso.delete(chave));
  emCurso.set(chave, promessa);
  return promessa;
}

async function preparar(entrada, opts = {}) {
  const consolidacao = await reservar(conn(opts), entrada);
  const contrato = { ...consolidacao.payload, consolidacao_id: consolidacao.id };
  return {
    consolidacao_id: consolidacao.id,
    status: consolidacao.status,
    venda_id: consolidacao.venda_id,
    total: contrato.total,
    desconto: contrato.desconto,
    itens: contrato.itens,
    pedido_ids: consolidacao.pedidos.map((pedido) => pedido.pedido_id),
    mesa_id: consolidacao.mesa_id,
    mesa_atendimento_id: consolidacao.mesa_atendimento_id
  };
}

module.exports = {
  preparar,
  concluir,
  vincular,
  montarContrato,
  nucleoOficial
};
