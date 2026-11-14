/**
 * Atendimento de salão. Não é o atendimento multiempresa do MUV.
 * A mesa livre é a ausência de atendimento OCUPADA ou FECHAMENTO.
 * A empresa recebida já foi resolvida pelo contexto; o corpo da requisição não a substitui.
 */
'use strict';

const MesaService = require('./MesaService');

const ESTADOS_ATIVOS = Object.freeze(['OCUPADA', 'FECHAMENTO']);

const filas = new WeakMap();

function erro(mensagem, statusCode, codigo) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
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

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória para operar mesas.', 400, 'EMPRESA_CONTEXT_REQUIRED');
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

function normalizarCliente(clienteId) {
  if (clienteId == null || clienteId === '') return null;
  const n = Number(clienteId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Cliente inválido.', 400, 'CLIENTE_INVALIDO');
  }
  return n;
}

function normalizarChave(chave) {
  if (chave == null || String(chave).trim() === '') return null;
  const texto = String(chave).trim();
  if (texto.length > 200) {
    throw erro('Chave de idempotência inválida.', 400, 'CHAVE_IDEMPOTENCIA_INVALIDA');
  }
  return texto;
}

function mapear(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    mesa_id: row.mesa_id,
    estado: row.estado,
    cliente_id: row.cliente_id == null ? null : row.cliente_id,
    cliente_nome: row.cliente_nome || null,
    operador_abertura_id: row.operador_abertura_id,
    aberto_em: row.aberto_em,
    operador_encerramento_id: row.operador_encerramento_id == null ? null : row.operador_encerramento_id,
    encerrado_em: row.encerrado_em || null,
    idempotency_key: row.idempotency_key || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function situacaoDe(estado) {
  return ESTADOS_ATIVOS.includes(estado) ? estado : 'LIVRE';
}

function emTransacao(db, trabalho) {
  const anterior = filas.get(db) || Promise.resolve();
  const execucao = anterior.then(() => trabalhoEmTransacao(db, trabalho), () => trabalhoEmTransacao(db, trabalho));
  filas.set(db, execucao.then(() => undefined, () => undefined));
  return execucao;
}

async function trabalhoEmTransacao(db, trabalho) {
  await run(db, 'BEGIN IMMEDIATE');
  try {
    const resultado = await trabalho();
    await run(db, 'COMMIT');
    return resultado;
  } catch (err) {
    try { await run(db, 'ROLLBACK'); } catch (_rollback) { /* a transação já pode ter sido desfeita */ }
    throw err;
  }
}

function conflitoUnico(err) {
  return err && /UNIQUE|constraint/i.test(String(err.message || ''));
}

function conflitoDaChave(err) {
  return conflitoUnico(err) && /idempotency_key/i.test(String(err.message || ''));
}

async function lerPorChave(db, chave) {
  if (!chave) return null;
  return get(db, `
    SELECT ma.*, c.nome AS cliente_nome
    FROM mesa_atendimentos ma
    LEFT JOIN clientes c ON c.id = ma.cliente_id
    WHERE ma.idempotency_key = ?
  `, [chave]);
}

async function lerTransferenciaPorChave(db, chave) {
  if (!chave) return null;
  return get(db, 'SELECT * FROM mesa_atendimento_transferencias WHERE idempotency_key = ?', [chave]);
}

function mapearTransferencia(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    atendimento_id: row.atendimento_id,
    mesa_origem_id: row.mesa_origem_id,
    mesa_destino_id: row.mesa_destino_id,
    operador_id: row.operador_id,
    transferido_em: row.transferido_em,
    idempotency_key: row.idempotency_key || null,
    created_at: row.created_at
  };
}

function mesmoContextoTransferencia(row, esperado) {
  return Number(row.empresa_id) === esperado.empresaId
    && Number(row.mesa_origem_id) === esperado.origemId
    && Number(row.mesa_destino_id) === esperado.destinoId
    && Number(row.operador_id) === esperado.operadorId;
}

function rejeitarChaveDivergente() {
  throw erro(
    'A chave de idempotência já foi usada em outro contexto.',
    409,
    'CHAVE_IDEMPOTENCIA_DIVERGENTE'
  );
}

function responderChaveExistente(row, esperado) {
  const mesmoContexto = Number(row.empresa_id) === esperado.empresaId
    && Number(row.mesa_id) === esperado.mesaId
    && Number(row.operador_abertura_id) === esperado.operadorId;
  if (!mesmoContexto) {
    throw erro(
      'A chave de idempotência já foi usada em outro contexto.',
      409,
      'CHAVE_IDEMPOTENCIA_DIVERGENTE'
    );
  }
  return { success: true, repetida: true, atendimento: mapear(row) };
}

async function atendimentoAtivo(db, empresaId, mesaId) {
  return get(db, `
    SELECT ma.*, c.nome AS cliente_nome
    FROM mesa_atendimentos ma
    LEFT JOIN clientes c ON c.id = ma.cliente_id
    WHERE ma.empresa_id = ? AND ma.mesa_id = ? AND ma.estado IN ('OCUPADA', 'FECHAMENTO')
    ORDER BY ma.id DESC
    LIMIT 1
  `, [empresaId, mesaId]);
}

async function colunaAtendimentoNoPedido(db) {
  const cols = await all(db, 'PRAGMA table_info(pedidos)');
  return cols.some((coluna) => String(coluna.name).toLowerCase() === 'mesa_atendimento_id');
}

async function pedidoAbertoNoAtendimento(db, atendimentoId) {
  if (!(await colunaAtendimentoNoPedido(db))) return null;
  return get(db, `
    SELECT id, status FROM pedidos
    WHERE mesa_atendimento_id = ?
      AND UPPER(COALESCE(status, '')) NOT IN ('FATURADO', 'CANCELADO')
    LIMIT 1
  `, [atendimentoId]);
}

async function abrir(empresaId, mesaId, entrada = {}, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const clienteId = normalizarCliente(entrada.clienteId);
  const chave = normalizarChave(entrada.idempotencyKey);
  const db = conn(opts);
  const mesa = await MesaService.obterDaEmpresa(emp, mesaId, opts);
  if (!mesa.ativo) {
    throw erro(`A Mesa ${mesa.numero} está desativada e não pode receber atendimento.`, 409, 'MESA_INATIVA');
  }

  try {
    return await emTransacao(db, async () => {
      if (chave) {
        const existente = await lerPorChave(db, chave);
        if (existente) return responderChaveExistente(existente, { empresaId: emp, mesaId: mesa.id, operadorId });
      }
      const ocupada = await atendimentoAtivo(db, emp, mesa.id);
      if (ocupada) {
        throw erro(`A Mesa ${mesa.numero} já possui atendimento ativo.`, 409, 'MESA_OCUPADA');
      }
      const ins = await run(db, `
        INSERT INTO mesa_atendimentos (
          empresa_id, mesa_id, estado, cliente_id, operador_abertura_id,
          aberto_em, idempotency_key, updated_at
        ) VALUES (?, ?, 'OCUPADA', ?, ?, datetime('now'), ?, datetime('now'))
      `, [emp, mesa.id, clienteId, operadorId, chave]);
      const row = await get(db, 'SELECT * FROM mesa_atendimentos WHERE id = ?', [ins.lastID]);
      return { success: true, repetida: false, atendimento: mapear(row) };
    });
  } catch (err) {
    if (err && err.codigo) throw err;
    if (conflitoDaChave(err)) {
      const existente = await lerPorChave(db, chave);
      if (existente) return responderChaveExistente(existente, { empresaId: emp, mesaId: mesa.id, operadorId });
    }
    if (conflitoUnico(err)) {
      throw erro(`A Mesa ${mesa.numero} já possui atendimento ativo.`, 409, 'MESA_OCUPADA');
    }
    throw err;
  }
}

async function consultarAtivo(empresaId, mesaId, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const mesa = await MesaService.obterDaEmpresa(emp, mesaId, opts);
  const row = await atendimentoAtivo(conn(opts), emp, mesa.id);
  return {
    success: true,
    mesa_id: mesa.id,
    numero: mesa.numero,
    situacao: situacaoDe(row && row.estado),
    atendimento: mapear(row)
  };
}

async function reconciliarAtendimentosQuitados(empresaId, entrada = {}, opts = {}) {
  const operadorId = Number(entrada.operadorId);
  if (!Number.isInteger(operadorId) || operadorId <= 0) return [];
  const emp = exigirEmpresa(empresaId);
  const db = conn(opts);
  const tabela = await get(db, `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'pedido_faturamento_operacoes'
  `);
  if (!tabela) return [];
  const ativos = await all(db, `
    SELECT id FROM mesa_atendimentos
    WHERE empresa_id = ? AND estado = 'OCUPADA'
  `, [emp]);
  const resultados = [];
  for (const row of ativos) {
    const pedido = await get(db, `
      SELECT id FROM pedidos
      WHERE mesa_atendimento_id = ? AND empresa_id = ?
      ORDER BY id
      LIMIT 1
    `, [row.id, emp]);
    if (!pedido) continue;
    try {
      resultados.push(await encerrarAtendimentoQuitado(emp, pedido.id, { operadorId }, opts));
    } catch (_err) {
      resultados.push({ encerrado: false, codigo: 'ATENDIMENTO_MESA_NAO_ATUALIZADO' });
    }
  }
  return resultados;
}

async function listarSituacao(empresaId, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  if (opts.operadorId) {
    try {
      await reconciliarAtendimentosQuitados(emp, { operadorId: opts.operadorId }, opts);
    } catch (_err) { /* a grade continua mesmo se o encerramento falhar */ }
  }
  const cadastro = await MesaService.listar(emp, opts);
  const ativos = await all(conn(opts), `
    SELECT ma.*, c.nome AS cliente_nome
    FROM mesa_atendimentos ma
    LEFT JOIN clientes c ON c.id = ma.cliente_id
    WHERE ma.empresa_id = ? AND ma.estado IN ('OCUPADA', 'FECHAMENTO')
  `, [emp]);
  const porMesa = new Map(ativos.map((row) => [Number(row.mesa_id), row]));
  return {
    success: true,
    itens: cadastro.itens.map((mesa) => {
      const atendimento = porMesa.get(Number(mesa.id)) || null;
      return {
        id: mesa.id,
        empresa_id: mesa.empresa_id,
        numero: mesa.numero,
        nome: mesa.nome,
        ativo: mesa.ativo,
        situacao: situacaoDe(atendimento && atendimento.estado),
        atendimento: mapear(atendimento)
      };
    })
  };
}

async function encerrar(empresaId, mesaId, entrada = {}, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const db = conn(opts);
  const mesa = await MesaService.obterDaEmpresa(emp, mesaId, opts);
  return emTransacao(db, async () => {
    const row = await get(db, `
      SELECT * FROM mesa_atendimentos
      WHERE empresa_id = ? AND mesa_id = ?
      ORDER BY id DESC
      LIMIT 1
    `, [emp, mesa.id]);
    if (!row) {
      throw erro('Não há atendimento nesta mesa.', 404, 'ATENDIMENTO_NAO_ENCONTRADO');
    }
    if (row.estado === 'ENCERRADO') {
      throw erro('O atendimento já está encerrado.', 409, 'ATENDIMENTO_JA_ENCERRADO');
    }
    if (row.estado === 'FECHAMENTO') {
      throw erro(
        'O atendimento está em fechamento e esta operação não conclui venda nem pagamento.',
        409,
        'ATENDIMENTO_EM_FECHAMENTO'
      );
    }
    const pedidoAberto = await pedidoAbertoNoAtendimento(db, row.id);
    if (pedidoAberto) {
      throw erro(
        'Há pedido em aberto neste atendimento. O encerramento técnico não cria venda.',
        409,
        'ATENDIMENTO_COM_PEDIDO_ABERTO'
      );
    }
    const atualizado = await run(db, `
      UPDATE mesa_atendimentos
      SET estado = 'ENCERRADO',
          operador_encerramento_id = ?,
          encerrado_em = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ? AND empresa_id = ? AND estado = 'OCUPADA'
    `, [operadorId, row.id, emp]);
    if (atualizado.changes !== 1) {
      throw erro('O atendimento mudou durante o encerramento.', 409, 'ATENDIMENTO_CONCORRENTE');
    }
    const gravado = await get(db, 'SELECT * FROM mesa_atendimentos WHERE id = ? AND empresa_id = ?', [row.id, emp]);
    return { success: true, atendimento: mapear(gravado), situacao: 'LIVRE' };
  });
}

function exigirMesaDestino(mesaDestinoId) {
  const n = Number(mesaDestinoId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Mesa de destino inválida.', 400, 'MESA_DESTINO_INVALIDA');
  }
  return n;
}

async function responderTransferencia(db, emp, atendimentoRow, transferenciaRow, origem, destino, repetida) {
  const origemAtiva = await atendimentoAtivo(db, emp, origem.id);
  const destinoAtivo = await atendimentoAtivo(db, emp, destino.id);
  return {
    success: true,
    repetida: !!repetida,
    atendimento: mapear(atendimentoRow),
    transferencia: mapearTransferencia(transferenciaRow),
    origem: { id: origem.id, numero: origem.numero, situacao: situacaoDe(origemAtiva && origemAtiva.estado) },
    destino: { id: destino.id, numero: destino.numero, situacao: situacaoDe(destinoAtivo && destinoAtivo.estado) }
  };
}

async function repetirTransferencia(db, emp, existente, origem, destino) {
  const atendimento = await get(
    db,
    'SELECT * FROM mesa_atendimentos WHERE id = ? AND empresa_id = ?',
    [existente.atendimento_id, emp]
  );
  if (!atendimento) rejeitarChaveDivergente();
  const atualNaOrigem = await atendimentoAtivo(db, emp, origem.id);
  if (atualNaOrigem && Number(atualNaOrigem.id) !== Number(existente.atendimento_id)) {
    rejeitarChaveDivergente();
  }
  return responderTransferencia(db, emp, atendimento, existente, origem, destino, true);
}

async function transferir(empresaId, mesaOrigemId, entrada = {}, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const destinoId = exigirMesaDestino(entrada.mesaDestinoId);
  const chave = normalizarChave(entrada.idempotencyKey);
  const db = conn(opts);
  const origem = await MesaService.obterDaEmpresa(emp, mesaOrigemId, opts);
  const destino = await MesaService.obterDaEmpresa(emp, destinoId, opts);
  if (!origem.ativo) {
    throw erro(`A Mesa ${origem.numero} está desativada e não pode transferir atendimento.`, 409, 'MESA_INATIVA');
  }
  if (!destino.ativo) {
    throw erro(`A Mesa ${destino.numero} está desativada e não pode receber atendimento.`, 409, 'MESA_INATIVA');
  }
  if (origem.id === destino.id) {
    throw erro('A mesa de destino é a mesma da origem.', 409, 'MESA_DESTINO_IGUAL');
  }

  const esperado = { empresaId: emp, origemId: origem.id, destinoId: destino.id, operadorId };
  try {
    return await emTransacao(db, async () => {
      if (chave) {
        const existente = await lerTransferenciaPorChave(db, chave);
        if (existente) {
          if (!mesmoContextoTransferencia(existente, esperado)) rejeitarChaveDivergente();
          return repetirTransferencia(db, emp, existente, origem, destino);
        }
      }

      const row = await atendimentoAtivo(db, emp, origem.id);
      if (!row) {
        const ultimo = await get(db, `
          SELECT estado FROM mesa_atendimentos
          WHERE empresa_id = ? AND mesa_id = ?
          ORDER BY id DESC
          LIMIT 1
        `, [emp, origem.id]);
        if (ultimo && ultimo.estado === 'ENCERRADO') {
          throw erro('O atendimento já está encerrado.', 409, 'ATENDIMENTO_JA_ENCERRADO');
        }
        throw erro('A mesa de origem está livre.', 409, 'MESA_LIVRE');
      }
      if (row.estado === 'FECHAMENTO') {
        throw erro('O atendimento está em fechamento e não pode ser transferido.', 409, 'ATENDIMENTO_EM_FECHAMENTO');
      }

      const destinoOcupado = await atendimentoAtivo(db, emp, destino.id);
      if (destinoOcupado) {
        throw erro(`A Mesa ${destino.numero} já possui atendimento ativo.`, 409, 'MESA_OCUPADA');
      }

      const abertoEm = row.aberto_em;
      const atualizado = await run(db, `
        UPDATE mesa_atendimentos
        SET mesa_id = ?, updated_at = datetime('now')
        WHERE id = ? AND empresa_id = ? AND estado = 'OCUPADA' AND mesa_id = ?
      `, [destino.id, row.id, emp, origem.id]);
      if (atualizado.changes !== 1) {
        throw erro('O atendimento mudou durante a transferência.', 409, 'ATENDIMENTO_CONCORRENTE');
      }

      const ins = await run(db, `
        INSERT INTO mesa_atendimento_transferencias (
          empresa_id, atendimento_id, mesa_origem_id, mesa_destino_id,
          operador_id, transferido_em, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      `, [emp, row.id, origem.id, destino.id, operadorId, chave]);

      const gravado = await get(
        db,
        'SELECT * FROM mesa_atendimentos WHERE id = ? AND empresa_id = ?',
        [row.id, emp]
      );
      if (!gravado || gravado.aberto_em !== abertoEm || Number(gravado.id) !== Number(row.id)) {
        throw erro('O atendimento mudou durante a transferência.', 409, 'ATENDIMENTO_CONCORRENTE');
      }
      const historico = await get(
        db,
        'SELECT * FROM mesa_atendimento_transferencias WHERE id = ? AND empresa_id = ?',
        [ins.lastID, emp]
      );
      return responderTransferencia(db, emp, gravado, historico, origem, destino, false);
    });
  } catch (err) {
    if (err && err.codigo) throw err;
    if (chave && conflitoDaChave(err)) {
      const existente = await lerTransferenciaPorChave(db, chave);
      if (existente) {
        if (!mesmoContextoTransferencia(existente, esperado)) rejeitarChaveDivergente();
        return repetirTransferencia(db, emp, existente, origem, destino);
      }
    }
    if (conflitoOcupacao(err)) {
      throw erro(`A Mesa ${destino.numero} já possui atendimento ativo.`, 409, 'MESA_OCUPADA');
    }
    throw err;
  }
}

function conflitoOcupacao(err) {
  const msg = String(err && err.message || '');
  return conflitoUnico(err) && /mesa_atendimentos/i.test(msg) && /mesa_id/i.test(msg);
}

async function resolverParaNovoPedido(empresaId, mesaId, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const db = conn(opts);
  const mesa = Number(mesaId);
  const row = await atendimentoAtivo(db, emp, mesa);
  if (row && row.estado === 'FECHAMENTO') {
    throw erro(
      'O atendimento está em fechamento e não recebe pedido novo.',
      409,
      'ATENDIMENTO_EM_FECHAMENTO'
    );
  }
  if (row && row.estado === 'OCUPADA') {
    if (Number(row.empresa_id) !== emp) {
      throw erro('Mesa não encontrada.', 404, 'MESA_NAO_ENCONTRADA');
    }
    return row.id;
  }
  const ultimo = await get(db, `
    SELECT estado FROM mesa_atendimentos
    WHERE empresa_id = ? AND mesa_id = ?
    ORDER BY id DESC
    LIMIT 1
  `, [emp, mesa]);
  if (ultimo && ultimo.estado === 'ENCERRADO') {
    throw erro('O atendimento já está encerrado e não recebe pedido novo.', 409, 'ATENDIMENTO_JA_ENCERRADO');
  }
  throw erro('Abra o atendimento da mesa antes de lançar o pedido.', 409, 'ATENDIMENTO_NAO_ABERTO');
}

function pagamentoConfirmado(status) {
  return String(status || '').toLowerCase() === 'quitada';
}

function motivoQueImpedeQuitacao(pedidos) {
  if (!pedidos.length) return 'ATENDIMENTO_SEM_PEDIDO';
  for (const pedido of pedidos) {
    const status = String(pedido.status || '').toUpperCase();
    const confirmado = pagamentoConfirmado(pedido.status_pagamento);
    if (status === 'CANCELADO') {
      if (pedido.venda_id != null && !confirmado) return 'CANCELAMENTO_INCOMPLETO';
      continue;
    }
    if (status !== 'FATURADO') return 'PEDIDO_PENDENTE';
    if (String(pedido.venda_status || '').toLowerCase() !== 'concluida') return 'VENDA_NAO_CONCLUIDA';
    if (!confirmado) return 'PAGAMENTO_NAO_CONFIRMADO';
    if (pedido.venda_id == null) return 'VENDA_NAO_CONCLUIDA';
    if (String(pedido.operacao_status || '') !== 'FINALIZADA') return 'VENDA_NAO_CONCLUIDA';
    if (String(pedido.tipo_operacao || '') !== 'PDV_COMPOSICAO') return 'VENDA_NAO_CONCLUIDA';
  }
  return null;
}

/**
 * Encerra o atendimento só depois da venda oficial confirmada de todos os pedidos.
 * Roda em transação própria: a conclusão da venda já foi commitada em outra conexão.
 * Repetir devolve o mesmo encerramento, sem novo horário e sem outra linha.
 */
async function encerrarAtendimentoQuitado(empresaId, pedidoId, entrada = {}, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    return { encerrado: false, codigo: 'PEDIDO_INVALIDO' };
  }
  const db = conn(opts);
  if (!(await colunaAtendimentoNoPedido(db))) {
    return { encerrado: false, codigo: 'PEDIDO_SEM_ATENDIMENTO' };
  }
  return emTransacao(db, async () => {
    const pedido = await get(db, `
      SELECT id, empresa_id, mesa_atendimento_id
      FROM pedidos
      WHERE id = ? AND empresa_id = ?
    `, [id, emp]);
    if (!pedido) return { encerrado: false, codigo: 'PEDIDO_FORA_DA_EMPRESA' };
    if (pedido.mesa_atendimento_id == null) return { encerrado: false, codigo: 'PEDIDO_SEM_ATENDIMENTO' };

    const atendimento = await get(db, `
      SELECT * FROM mesa_atendimentos
      WHERE id = ? AND empresa_id = ?
    `, [pedido.mesa_atendimento_id, emp]);
    if (!atendimento) return { encerrado: false, codigo: 'ATENDIMENTO_NAO_ENCONTRADO' };
    if (atendimento.estado === 'ENCERRADO') {
      return {
        encerrado: true,
        repetida: true,
        situacao: 'LIVRE',
        atendimento: mapear(atendimento)
      };
    }
    if (atendimento.estado === 'FECHAMENTO') {
      return { encerrado: false, codigo: 'ATENDIMENTO_EM_FECHAMENTO', situacao: 'FECHAMENTO' };
    }
    if (atendimento.estado !== 'OCUPADA') {
      return { encerrado: false, codigo: 'ATENDIMENTO_INATIVO', situacao: situacaoDe(atendimento.estado) };
    }

    const pedidos = await all(db, `
      SELECT p.id, p.status, p.venda_id, v.status AS venda_status, v.status_pagamento,
             op.status AS operacao_status, op.tipo_operacao
      FROM pedidos p
      LEFT JOIN vendas v ON v.id = p.venda_id AND v.empresa_id = p.empresa_id
      LEFT JOIN pedido_faturamento_operacoes op
        ON op.pedido_id = p.id AND op.empresa_id = p.empresa_id
      WHERE p.mesa_atendimento_id = ? AND p.empresa_id = ?
    `, [atendimento.id, emp]);
    const impedimento = motivoQueImpedeQuitacao(pedidos);
    if (impedimento) {
      return { encerrado: false, codigo: impedimento, situacao: 'OCUPADA' };
    }

    const atualizado = await run(db, `
      UPDATE mesa_atendimentos
      SET estado = 'ENCERRADO',
          operador_encerramento_id = ?,
          encerrado_em = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ? AND empresa_id = ? AND estado = 'OCUPADA'
    `, [operadorId, atendimento.id, emp]);
    const gravado = await get(db, `
      SELECT * FROM mesa_atendimentos WHERE id = ? AND empresa_id = ?
    `, [atendimento.id, emp]);
    if (atualizado.changes !== 1) {
      if (gravado && gravado.estado === 'ENCERRADO') {
        return { encerrado: true, repetida: true, situacao: 'LIVRE', atendimento: mapear(gravado) };
      }
      return {
        encerrado: false,
        codigo: 'ATENDIMENTO_CONCORRENTE',
        situacao: situacaoDe(gravado && gravado.estado)
      };
    }
    return { encerrado: true, repetida: false, situacao: 'LIVRE', atendimento: mapear(gravado) };
  });
}

module.exports = {
  abrir,
  consultarAtivo,
  listarSituacao,
  encerrar,
  transferir,
  resolverParaNovoPedido,
  encerrarAtendimentoQuitado,
  reconciliarAtendimentosQuitados
};
