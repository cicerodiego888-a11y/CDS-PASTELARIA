/**
 * S07-3E — Despacho controlado do pedido comercial → KDS.
 * Pré-condição: S07-3D com cozinha_resolucao_status = RESOLVIDO e unidade persistida.
 * Reutiliza CozinhaDespachoService.despacharLote (estrutura existente).
 * Não altera S06. Falha de despacho não cancela o pedido comercial.
 * Empresa/destino do frontend são ignorados.
 */
'use strict';

const crypto = require('crypto');
const CozinhaDespacho = require('./CozinhaDespachoService');
const {
  verificarSchemaDespachoPedidoCozinha,
  garantirSchemaDespachoPedidoCozinha,
  exigirSchemaDespachoPedidoCozinha
} = require('../../utils/pedidosDespachoCozinhaSchema');

const STATUS = Object.freeze({
  EM_ANDAMENTO: 'EM_ANDAMENTO',
  CONCLUIDO: 'CONCLUIDO',
  FALHA: 'FALHA',
  BLOQUEADO: 'BLOQUEADO'
});

/** Tempo padrão (ms) para considerar EM_ANDAMENTO abandonado após queda do backend. */
const STALE_EM_ANDAMENTO_MS_PADRAO = 120000;

const CODIGOS = Object.freeze({
  RESOLUCAO_OBRIGATORIA: 'DESPACHO_REQUER_RESOLVIDO',
  DESTINO_AUSENTE: 'DESPACHO_DESTINO_AUSENTE',
  DESTINO_INVALIDO: 'DESPACHO_DESTINO_INVALIDO',
  UNIDADE_INATIVA: 'DESPACHO_UNIDADE_INATIVA',
  UNIDADE_EMPRESA: 'DESPACHO_UNIDADE_EMPRESA_ISOLAMENTO',
  MESA_OBRIGATORIA: 'DESPACHO_MESA_OBRIGATORIA',
  ATENDIMENTO_OBRIGATORIO: 'DESPACHO_ATENDIMENTO_OBRIGATORIO',
  ITENS_AUSENTES: 'DESPACHO_ITENS_AUSENTES',
  OPERADOR_OBRIGATORIO: 'DESPACHO_OPERADOR_OBRIGATORIO',
  SCHEMA_INDISPONIVEL: 'SCHEMA_DESPACHO_PEDIDO_INDISPONIVEL',
  JA_CONCLUIDO: 'DESPACHO_JA_CONCLUIDO',
  EM_ANDAMENTO: 'DESPACHO_EM_ANDAMENTO',
  RECUPERADO_POS_INTERRUPCAO: 'DESPACHO_RECUPERADO_POS_INTERRUPCAO'
});

function novoClaimToken() {
  return crypto.randomBytes(16).toString('hex');
}

function parseUpdatedAtMs(valor) {
  if (valor == null || valor === '') return 0;
  const t = Date.parse(String(valor).includes('T') ? String(valor) : String(valor).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : 0;
}

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

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
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

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return n;
}

function chaveIdempotenciaPedido(empresaId, pedidoId) {
  return `s07-3e:despacho:empresa:${empresaId}:pedido:${pedidoId}`;
}

function montarResultado(parcial) {
  return {
    success: parcial.success === true,
    status: parcial.status,
    codigo: parcial.codigo || null,
    empresa_id: parcial.empresa_id,
    pedido_id: parcial.pedido_id,
    unidade_id: parcial.unidade_id != null ? Number(parcial.unidade_id) : null,
    rodada_id: parcial.rodada_id != null ? Number(parcial.rodada_id) : null,
    repetida: !!parcial.repetida,
    bloqueado: !!parcial.bloqueado,
    mensagem: parcial.mensagem || null,
    despacho: parcial.despacho || null
  };
}

async function atualizarSnapshotPedido(db, empresaId, pedidoId, {
  status,
  rodadaId = null,
  codigo = null,
  reivindicacao = null
}) {
  const cols = await dbAll(db, 'PRAGMA table_info(pedidos)');
  const nomes = new Set((cols || []).map((c) => String(c.name).toLowerCase()));
  if (!nomes.has('cozinha_despacho_status')) return;
  const sets = ['cozinha_despacho_status = ?'];
  const params = [status];
  if (nomes.has('cozinha_despacho_rodada_id')) {
    sets.push('cozinha_despacho_rodada_id = ?');
    params.push(rodadaId);
  }
  if (nomes.has('cozinha_despacho_codigo')) {
    sets.push('cozinha_despacho_codigo = ?');
    params.push(codigo);
  }
  params.push(pedidoId, empresaId);
  let where = 'WHERE id = ? AND empresa_id = ?';
  if (reivindicacao) {
    where += `
      AND EXISTS (
        SELECT 1 FROM cozinha_pedido_despachos
        WHERE id = ?
          AND status = 'EM_ANDAMENTO'
          AND claim_token = ?
      )
    `;
    params.push(reivindicacao.registroId, String(reivindicacao.claimToken));
  }
  await dbRun(db, `
    UPDATE pedidos SET ${sets.join(', ')} ${where}
  `, params);
}

async function marcarDespacho(db, registroId, patch, claimToken) {
  if (claimToken == null || String(claimToken) === '') return false;
  const r = await dbRun(db, `
    UPDATE cozinha_pedido_despachos
    SET status = ?,
        unidade_id = COALESCE(?, unidade_id),
        rodada_id = COALESCE(?, rodada_id),
        claim_token = NULL,
        codigo_falha = ?,
        mensagem_falha = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'EM_ANDAMENTO'
      AND claim_token = ?
  `, [
    patch.status,
    patch.unidade_id != null ? patch.unidade_id : null,
    patch.rodada_id != null ? patch.rodada_id : null,
    patch.codigo_falha != null ? String(patch.codigo_falha).slice(0, 80) : null,
    patch.mensagem_falha != null ? String(patch.mensagem_falha).slice(0, 240) : null,
    registroId,
    String(claimToken)
  ]);
  return Number(r.changes) === 1;
}

async function resultadoClaimPerdido(db, {
  registroId,
  empresaId,
  pedidoId,
  unidadeId,
  rodadaId = null
}) {
  const atual = await dbGet(db, `SELECT * FROM cozinha_pedido_despachos WHERE id = ?`, [registroId]);
  if (atual && String(atual.status) === STATUS.CONCLUIDO) {
    return montarResultado({
      success: true,
      status: STATUS.CONCLUIDO,
      codigo: CODIGOS.JA_CONCLUIDO,
      empresa_id: empresaId,
      pedido_id: pedidoId,
      unidade_id: atual.unidade_id != null ? Number(atual.unidade_id) : unidadeId,
      rodada_id: atual.rodada_id != null ? Number(atual.rodada_id) : rodadaId,
      repetida: true,
      mensagem: 'Despacho consolidado por uma execução proprietária.'
    });
  }
  return montarResultado({
    success: false,
    status: atual && atual.status ? atual.status : STATUS.EM_ANDAMENTO,
    codigo: 'DESPACHO_CLAIM_PERDIDO',
    empresa_id: empresaId,
    pedido_id: pedidoId,
    unidade_id: unidadeId,
    mensagem: 'A execução perdeu a posse do despacho antes da confirmação.'
  });
}

async function consultarConclusaoExistente(db, chave) {
  const idem = await dbGet(db, `
    SELECT situacao, recurso_id FROM cozinha_idempotencia WHERE idempotency_key = ?
  `, [chave]);
  if (idem && String(idem.situacao) === 'CONCLUIDA' && idem.recurso_id != null) {
    return { rodada_id: Number(idem.recurso_id), origem: 'IDEMPOTENCIA' };
  }
  const rodada = await dbGet(db, `
    SELECT id FROM cozinha_rodadas WHERE idempotency_key_despacho = ? LIMIT 1
  `, [chave]);
  if (rodada && rodada.id != null) {
    return { rodada_id: Number(rodada.id), origem: 'RODADA' };
  }
  return null;
}

/**
 * Garante comanda do pedido no atendimento (estrutura existente).
 */
async function garantirComandaDoPedido(db, {
  empresaId,
  atendimentoId,
  pedidoId,
  operadorId
}) {
  const existente = await dbGet(db, `
    SELECT id FROM cozinha_comandas
    WHERE empresa_id = ? AND atendimento_id = ? AND pedido_id = ?
    ORDER BY id ASC LIMIT 1
  `, [empresaId, atendimentoId, pedidoId]);
  if (existente) return Number(existente.id);

  const maxNum = await dbGet(db, `
    SELECT COALESCE(MAX(numero_comanda), 0) AS m
    FROM cozinha_comandas
    WHERE empresa_id = ? AND atendimento_id = ?
  `, [empresaId, atendimentoId]);
  const numero = Number(maxNum && maxNum.m != null ? maxNum.m : 0) + 1;

  try {
    const ins = await dbRun(db, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id,
        operador_lancamento_id, registrado_em, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      empresaId,
      atendimentoId,
      numero,
      `PED-${pedidoId}`,
      pedidoId,
      operadorId || null
    ]);
    return Number(ins.lastID);
  } catch (e) {
    if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    const again = await dbGet(db, `
      SELECT id FROM cozinha_comandas
      WHERE empresa_id = ? AND atendimento_id = ? AND pedido_id = ?
      ORDER BY id ASC LIMIT 1
    `, [empresaId, atendimentoId, pedidoId]);
    if (again) return Number(again.id);
    throw e;
  }
}

async function validarUnidadeDestino(db, empresaId, unidadeId) {
  const id = Number(unidadeId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro('Destino de cozinha ausente ou inválido.', 409, CODIGOS.DESTINO_INVALIDO);
  }
  const row = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo FROM cozinha_unidades WHERE id = ?
  `, [id]);
  if (!row) {
    throw erro('Unidade de destino inexistente.', 404, CODIGOS.DESTINO_INVALIDO);
  }
  if (Number(row.empresa_id) !== Number(empresaId)) {
    throw erro('Unidade de destino de outra empresa.', 403, CODIGOS.UNIDADE_EMPRESA);
  }
  if (Number(row.ativo) !== 1) {
    throw erro('Unidade de destino inativa.', 409, CODIGOS.UNIDADE_INATIVA);
  }
  return { id: Number(row.id), codigo: row.codigo != null ? String(row.codigo) : null };
}

/**
 * Reivindica exclusividade de despacho por (empresa_id, pedido_id) na persistência.
 * Retomada FALHA/BLOQUEADO e recuperação de EM_ANDAMENTO abandonado são atômicas (changes=1 + claim_token).
 */
async function reivindicarDespacho(db, {
  empresaId,
  pedidoId,
  unidadeId,
  chave,
  staleEmAndamentoMs = STALE_EM_ANDAMENTO_MS_PADRAO,
  agoraMs = Date.now()
}) {
  const claimToken = novoClaimToken();

  const sincronizarSeJaConcluido = async (registroBase) => {
    const existente = await consultarConclusaoExistente(db, chave);
    if (!existente) return null;
    const claimAnterior = registroBase.claim_token != null
      ? String(registroBase.claim_token)
      : null;
    const atualizacao = await dbRun(db, `
      UPDATE cozinha_pedido_despachos
      SET status = ?,
          rodada_id = ?,
          unidade_id = COALESCE(unidade_id, ?),
          claim_token = NULL,
          codigo_falha = NULL,
          mensagem_falha = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'EM_ANDAMENTO'
        AND claim_token IS ?
    `, [
      STATUS.CONCLUIDO,
      existente.rodada_id,
      unidadeId,
      registroBase.id,
      claimAnterior
    ]);
    const reg = await dbGet(db, `SELECT * FROM cozinha_pedido_despachos WHERE id = ?`, [registroBase.id]);
    if (Number(atualizacao.changes) !== 1 && (!reg || String(reg.status) !== STATUS.CONCLUIDO)) {
      return null;
    }
    if (!reg || String(reg.status) !== STATUS.CONCLUIDO) return null;
    return {
      acao: 'JA_CONCLUIDO',
      registro: reg,
      claimToken: null,
      recuperado: true
    };
  };

  const lerAtual = () => dbGet(db, `
    SELECT * FROM cozinha_pedido_despachos
    WHERE empresa_id = ? AND pedido_id = ?
  `, [empresaId, pedidoId]);

  let atual = await lerAtual();

  if (atual) {
    if (String(atual.status) === STATUS.CONCLUIDO) {
      return { acao: 'JA_CONCLUIDO', registro: atual, claimToken: null };
    }

    if (String(atual.status) === STATUS.EM_ANDAMENTO) {
      const ja = await sincronizarSeJaConcluido(atual);
      if (ja) return ja;

      const idade = agoraMs - parseUpdatedAtMs(atual.updated_at || atual.created_at);
      const abandonado = !Number.isFinite(idade) || idade >= Number(staleEmAndamentoMs);
      if (!abandonado) {
        return { acao: 'EM_ANDAMENTO', registro: atual, claimToken: null };
      }

      // Recuperação atômica: só uma execução assume o claim abandonado.
      const claimAnterior = atual.claim_token != null ? String(atual.claim_token) : null;
      const upRec = await dbRun(db, `
        UPDATE cozinha_pedido_despachos
        SET claim_token = ?,
            unidade_id = ?,
            rodada_id = NULL,
            codigo_falha = NULL,
            mensagem_falha = NULL,
            idempotency_key = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'EM_ANDAMENTO'
          AND (
            (? IS NULL AND claim_token IS NULL)
            OR claim_token = ?
          )
          AND updated_at IS ?
      `, [
        claimToken,
        unidadeId,
        chave,
        atual.id,
        claimAnterior,
        claimAnterior,
        atual.updated_at != null ? atual.updated_at : null
      ]);

      if (Number(upRec.changes) === 1) {
        const renovado = await dbGet(db, `SELECT * FROM cozinha_pedido_despachos WHERE id = ?`, [atual.id]);
        if (
          !renovado
          || String(renovado.status) !== STATUS.EM_ANDAMENTO
          || String(renovado.claim_token || '') !== claimToken
        ) {
          const again = await lerAtual();
          if (again && String(again.status) === STATUS.CONCLUIDO) {
            return { acao: 'JA_CONCLUIDO', registro: again, claimToken: null };
          }
          return { acao: 'EM_ANDAMENTO', registro: again || atual, claimToken: null };
        }
        // Revalida idempotência/rodada antes de liberar nova execução.
        const jaPos = await sincronizarSeJaConcluido(renovado);
        if (jaPos) return jaPos;
        return {
          acao: 'REIVINDICADO',
          registro: renovado,
          claimToken,
          recuperado: true
        };
      }
      const again = await lerAtual();
      if (again && String(again.status) === STATUS.CONCLUIDO) {
        return { acao: 'JA_CONCLUIDO', registro: again, claimToken: null };
      }
      return { acao: 'EM_ANDAMENTO', registro: again || atual, claimToken: null };
    }

    // FALHA / BLOQUEADO → retomada atômica (somente uma execução vence)
    const upFalha = await dbRun(db, `
      UPDATE cozinha_pedido_despachos
      SET status = 'EM_ANDAMENTO',
          unidade_id = ?,
          rodada_id = NULL,
          codigo_falha = NULL,
          mensagem_falha = NULL,
          idempotency_key = ?,
          claim_token = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status IN ('FALHA', 'BLOQUEADO')
    `, [unidadeId, chave, claimToken, atual.id]);

    if (Number(upFalha.changes) === 1) {
      const renovado = await dbGet(db, `SELECT * FROM cozinha_pedido_despachos WHERE id = ?`, [atual.id]);
      if (
        renovado
        && String(renovado.status) === STATUS.EM_ANDAMENTO
        && String(renovado.claim_token || '') === claimToken
      ) {
        return { acao: 'REIVINDICADO', registro: renovado, claimToken };
      }
      const again = await lerAtual();
      if (again && String(again.status) === STATUS.CONCLUIDO) {
        return { acao: 'JA_CONCLUIDO', registro: again, claimToken: null };
      }
      if (again && String(again.status) === STATUS.EM_ANDAMENTO) {
        return { acao: 'EM_ANDAMENTO', registro: again, claimToken: null };
      }
      throw erro('Conflito ao confirmar posse do despacho.', 409, 'DESPACHO_CONCORRENTE');
    }

    const again = await lerAtual();
    if (again && String(again.status) === STATUS.CONCLUIDO) {
      return { acao: 'JA_CONCLUIDO', registro: again, claimToken: null };
    }
    if (again && String(again.status) === STATUS.EM_ANDAMENTO) {
      return { acao: 'EM_ANDAMENTO', registro: again, claimToken: null };
    }
    throw erro('Conflito ao reivindicar despacho.', 409, 'DESPACHO_CONCORRENTE');
  }

  try {
    const ins = await dbRun(db, `
      INSERT INTO cozinha_pedido_despachos (
        empresa_id, pedido_id, unidade_id, status, idempotency_key, claim_token,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [empresaId, pedidoId, unidadeId, STATUS.EM_ANDAMENTO, chave, claimToken]);
    const registro = await dbGet(db, `SELECT * FROM cozinha_pedido_despachos WHERE id = ?`, [ins.lastID]);
    return { acao: 'NOVO', registro, claimToken };
  } catch (e) {
    if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    const again = await lerAtual();
    if (again && String(again.status) === STATUS.CONCLUIDO) {
      return { acao: 'JA_CONCLUIDO', registro: again, claimToken: null };
    }
    if (again && String(again.status) === STATUS.EM_ANDAMENTO) {
      return { acao: 'EM_ANDAMENTO', registro: again, claimToken: null };
    }
    // Outro processo pode ter inserido e já falhado — tentar uma retomada
    if (again && (String(again.status) === STATUS.FALHA || String(again.status) === STATUS.BLOQUEADO)) {
      return reivindicarDespacho(db, {
        empresaId, pedidoId, unidadeId, chave, staleEmAndamentoMs, agoraMs
      });
    }
    throw erro('Conflito de idempotência no despacho do pedido.', 409, 'DESPACHO_CONCORRENTE');
  }
}

/**
 * Despacha pedido já resolvido (S07-3D) para a unidade persistida.
 * @param {object} entrada
 * @param {number} entrada.empresaId contexto autenticado
 * @param {number} entrada.pedidoId
 * @param {number} [entrada.operadorId]
 * @param {*} [entrada.bodyEmpresaIdIgnored]
 * @param {*} [entrada.unidadeDestinoArbitrariaIgnored]
 */
async function despacharPedidoResolvido({
  empresaId,
  pedidoId,
  operadorId = null,
  bodyEmpresaIdIgnored,
  unidadeDestinoArbitrariaIgnored,
  destinoArbitrarioIgnored
} = {}, opts = {}) {
  void bodyEmpresaIdIgnored;
  void unidadeDestinoArbitrariaIgnored;
  void destinoArbitrarioIgnored;

  const staleEmAndamentoMs = opts.staleEmAndamentoMs != null
    ? Number(opts.staleEmAndamentoMs)
    : STALE_EM_ANDAMENTO_MS_PADRAO;
  const agoraMs = opts.agoraMs != null ? Number(opts.agoraMs) : Date.now();

  const empId = exigirEmpresa(empresaId);
  const pedId = Number(pedidoId);
  if (!Number.isInteger(pedId) || pedId <= 0) {
    throw erro('pedido_id inválido.', 400, 'PEDIDO_INVALIDO');
  }

  const db = conn(opts);
  const schema = await verificarSchemaDespachoPedidoCozinha(db);
  if (!schema.disponivel) {
    return montarResultado({
      success: false,
      status: STATUS.BLOQUEADO,
      codigo: CODIGOS.SCHEMA_INDISPONIVEL,
      empresa_id: empId,
      pedido_id: pedId,
      bloqueado: true,
      mensagem: 'Schema de despacho indisponível.'
    });
  }

  const pedido = await dbGet(db, `
    SELECT id, empresa_id, status, mesa_id, mesa_atendimento_id,
           cozinha_resolucao_status, unidade_cozinha_destino_id,
           cozinha_despacho_status, operador_id
    FROM pedidos WHERE id = ?
  `, [pedId]);

  if (!pedido || Number(pedido.empresa_id) !== empId) {
    throw erro('Pedido não encontrado na empresa do contexto.', 404, 'PEDIDO_NAO_ENCONTRADO');
  }

  if (String(pedido.cozinha_resolucao_status || '') !== 'RESOLVIDO') {
    const codigo = CODIGOS.RESOLUCAO_OBRIGATORIA;
    await atualizarSnapshotPedido(db, empId, pedId, { status: STATUS.BLOQUEADO, codigo });
    return montarResultado({
      success: false,
      status: STATUS.BLOQUEADO,
      codigo,
      empresa_id: empId,
      pedido_id: pedId,
      bloqueado: true,
      mensagem: 'Pedido sem resolução de destino RESOLVIDO.'
    });
  }

  if (pedido.unidade_cozinha_destino_id == null) {
    const codigo = CODIGOS.DESTINO_AUSENTE;
    await atualizarSnapshotPedido(db, empId, pedId, { status: STATUS.BLOQUEADO, codigo });
    return montarResultado({
      success: false,
      status: STATUS.BLOQUEADO,
      codigo,
      empresa_id: empId,
      pedido_id: pedId,
      bloqueado: true,
      mensagem: 'Pedido sem unidade de destino persistida.'
    });
  }

  let unidade;
  try {
    unidade = await validarUnidadeDestino(db, empId, pedido.unidade_cozinha_destino_id);
  } catch (errValid) {
    const codigo = errValid.codigo || CODIGOS.DESTINO_INVALIDO;
    await atualizarSnapshotPedido(db, empId, pedId, { status: STATUS.BLOQUEADO, codigo });
    return montarResultado({
      success: false,
      status: STATUS.BLOQUEADO,
      codigo,
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: Number(pedido.unidade_cozinha_destino_id),
      bloqueado: true,
      mensagem: errValid.message
    });
  }

  const mesaId = pedido.mesa_id != null ? Number(pedido.mesa_id) : null;
  const atendimentoId = pedido.mesa_atendimento_id != null
    ? Number(pedido.mesa_atendimento_id)
    : null;

  if (!Number.isInteger(mesaId) || mesaId <= 0) {
    const codigo = CODIGOS.MESA_OBRIGATORIA;
    await atualizarSnapshotPedido(db, empId, pedId, { status: STATUS.BLOQUEADO, codigo });
    return montarResultado({
      success: false,
      status: STATUS.BLOQUEADO,
      codigo,
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      bloqueado: true,
      mensagem: 'Despacho KDS requer mesa vinculada ao pedido (estrutura atual de rodadas).'
    });
  }
  if (!Number.isInteger(atendimentoId) || atendimentoId <= 0) {
    const codigo = CODIGOS.ATENDIMENTO_OBRIGATORIO;
    await atualizarSnapshotPedido(db, empId, pedId, { status: STATUS.BLOQUEADO, codigo });
    return montarResultado({
      success: false,
      status: STATUS.BLOQUEADO,
      codigo,
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      bloqueado: true,
      mensagem: 'Despacho KDS requer atendimento de mesa vinculado.'
    });
  }

  const opId = Number(operadorId != null ? operadorId : pedido.operador_id);
  if (!Number.isInteger(opId) || opId <= 0) {
    const codigo = CODIGOS.OPERADOR_OBRIGATORIO;
    await atualizarSnapshotPedido(db, empId, pedId, { status: STATUS.FALHA, codigo });
    return montarResultado({
      success: false,
      status: STATUS.FALHA,
      codigo,
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      mensagem: 'Operador obrigatório para despacho.'
    });
  }

  const itens = await dbAll(db, `
    SELECT id, pedido_id, quantidade FROM pedidos_itens WHERE pedido_id = ? ORDER BY id
  `, [pedId]);
  if (!itens.length) {
    const codigo = CODIGOS.ITENS_AUSENTES;
    await atualizarSnapshotPedido(db, empId, pedId, { status: STATUS.BLOQUEADO, codigo });
    return montarResultado({
      success: false,
      status: STATUS.BLOQUEADO,
      codigo,
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      bloqueado: true,
      mensagem: 'Pedido sem itens para despacho.'
    });
  }

  const chave = chaveIdempotenciaPedido(empId, pedId);
  const claim = await reivindicarDespacho(db, {
    empresaId: empId,
    pedidoId: pedId,
    unidadeId: unidade.id,
    chave,
    staleEmAndamentoMs,
    agoraMs
  });

  if (claim.acao === 'JA_CONCLUIDO') {
    await atualizarSnapshotPedido(db, empId, pedId, {
      status: STATUS.CONCLUIDO,
      rodadaId: claim.registro.rodada_id,
      codigo: CODIGOS.JA_CONCLUIDO
    });
    return montarResultado({
      success: true,
      status: STATUS.CONCLUIDO,
      codigo: claim.recuperado ? CODIGOS.RECUPERADO_POS_INTERRUPCAO : CODIGOS.JA_CONCLUIDO,
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: claim.registro.unidade_id || unidade.id,
      rodada_id: claim.registro.rodada_id,
      repetida: true,
      mensagem: claim.recuperado
        ? 'Despacho já persistido; estado recuperado após interrupção.'
        : 'Despacho já concluído anteriormente.'
    });
  }

  if (claim.acao === 'EM_ANDAMENTO' && claim.registro && Number(claim.registro.id)) {
    return montarResultado({
      success: false,
      status: STATUS.EM_ANDAMENTO,
      codigo: CODIGOS.EM_ANDAMENTO,
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      mensagem: 'Despacho já em andamento para este pedido.'
    });
  }

  const registroId = Number(claim.registro.id);
  const claimToken = claim.claimToken;
  const reivindicacao = { registroId, claimToken };
  await atualizarSnapshotPedido(db, empId, pedId, {
    status: STATUS.EM_ANDAMENTO,
    codigo: null,
    reivindicacao
  });

  if (opts.simularFalhaAposReivindicacao === true) {
    await atualizarSnapshotPedido(db, empId, pedId, {
      status: STATUS.FALHA,
      codigo: 'SIMULAR_FALHA_APOS_CLAIM',
      reivindicacao
    });
    const marcado = await marcarDespacho(db, registroId, {
      status: STATUS.FALHA,
      unidade_id: unidade.id,
      codigo_falha: 'SIMULAR_FALHA_APOS_CLAIM',
      mensagem_falha: 'Falha simulada após reivindicação EM_ANDAMENTO.'
    }, claimToken);
    if (!marcado) {
      return resultadoClaimPerdido(db, {
        registroId,
        empresaId: empId,
        pedidoId: pedId,
        unidadeId: unidade.id
      });
    }
    return montarResultado({
      success: false,
      status: STATUS.FALHA,
      codigo: 'SIMULAR_FALHA_APOS_CLAIM',
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      mensagem: 'Falha simulada após reivindicação EM_ANDAMENTO.'
    });
  }

  let comandaId;
  try {
    comandaId = await garantirComandaDoPedido(db, {
      empresaId: empId,
      atendimentoId,
      pedidoId: pedId,
      operadorId: opId
    });
  } catch (errComanda) {
    await atualizarSnapshotPedido(db, empId, pedId, {
      status: STATUS.FALHA,
      codigo: errComanda.codigo || 'COMANDA_FALHA',
      reivindicacao
    });
    const marcado = await marcarDespacho(db, registroId, {
      status: STATUS.FALHA,
      unidade_id: unidade.id,
      codigo_falha: errComanda.codigo || 'COMANDA_FALHA',
      mensagem_falha: errComanda.message
    }, claimToken);
    if (!marcado) {
      return resultadoClaimPerdido(db, {
        registroId,
        empresaId: empId,
        pedidoId: pedId,
        unidadeId: unidade.id
      });
    }
    return montarResultado({
      success: false,
      status: STATUS.FALHA,
      codigo: errComanda.codigo || 'COMANDA_FALHA',
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      mensagem: errComanda.message
    });
  }

  try {
    const out = await CozinhaDespacho.despacharLote({
      empresaId: empId,
      operadorId: opId,
      idempotencyKey: chave,
      unidade_id: unidade.id,
      mesa_id: mesaId,
      atendimento_id: atendimentoId,
      itens: itens.map((it) => ({
        pedido_id: pedId,
        pedido_item_id: Number(it.id),
        comanda_id: comandaId,
        quantidade: it.quantidade
      }))
    }, {
      db,
      // S07-3E: despacho operacional KDS sem autorizar impressão física automática (S06 intacta).
      omitirEnfileiramentoImpressao: true
    });

    const rodadaId = out && out.rodada && out.rodada.id != null ? Number(out.rodada.id) : null;
    await atualizarSnapshotPedido(db, empId, pedId, {
      status: STATUS.CONCLUIDO,
      rodadaId,
      codigo: null,
      reivindicacao
    });
    const marcado = await marcarDespacho(db, registroId, {
      status: STATUS.CONCLUIDO,
      unidade_id: unidade.id,
      rodada_id: rodadaId,
      codigo_falha: null,
      mensagem_falha: null
    }, claimToken);
    if (!marcado) {
      return resultadoClaimPerdido(db, {
        registroId,
        empresaId: empId,
        pedidoId: pedId,
        unidadeId: unidade.id,
        rodadaId
      });
    }

    return montarResultado({
      success: true,
      status: STATUS.CONCLUIDO,
      codigo: out && out.repetida
        ? CODIGOS.JA_CONCLUIDO
        : (claim.recuperado ? CODIGOS.RECUPERADO_POS_INTERRUPCAO : null),
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      rodada_id: rodadaId,
      repetida: !!(out && out.repetida),
      despacho: out,
      mensagem: null
    });
  } catch (errDespacho) {
    const codigo = errDespacho && (errDespacho.codigo || errDespacho.code)
      ? String(errDespacho.codigo || errDespacho.code)
      : 'DESPACHO_LOTE_FALHA';

    if (
      codigo === 'IDEMPOTENCY_EM_ANDAMENTO'
      || codigo === 'IDEMPOTENCY_CONCORRENTE'
      || codigo === 'IDEMPOTENCY_PAYLOAD_DIVERGENTE'
    ) {
      const existente = await consultarConclusaoExistente(db, chave);
      if (existente) {
        await atualizarSnapshotPedido(db, empId, pedId, {
          status: STATUS.CONCLUIDO,
          rodadaId: existente.rodada_id,
          codigo: CODIGOS.JA_CONCLUIDO,
          reivindicacao
        });
        const marcado = await marcarDespacho(db, registroId, {
          status: STATUS.CONCLUIDO,
          unidade_id: unidade.id,
          rodada_id: existente.rodada_id,
          codigo_falha: null,
          mensagem_falha: null
        }, claimToken);
        if (!marcado) {
          return resultadoClaimPerdido(db, {
            registroId,
            empresaId: empId,
            pedidoId: pedId,
            unidadeId: unidade.id,
            rodadaId: existente.rodada_id
          });
        }
        return montarResultado({
          success: true,
          status: STATUS.CONCLUIDO,
          codigo: CODIGOS.JA_CONCLUIDO,
          empresa_id: empId,
          pedido_id: pedId,
          unidade_id: unidade.id,
          rodada_id: existente.rodada_id,
          repetida: true,
          mensagem: 'Despacho concluído por operação concorrente idempotente.'
        });
      }
      return montarResultado({
        success: false,
        status: STATUS.EM_ANDAMENTO,
        codigo,
        empresa_id: empId,
        pedido_id: pedId,
        unidade_id: unidade.id,
        mensagem: errDespacho.message
      });
    }

    await atualizarSnapshotPedido(db, empId, pedId, {
      status: STATUS.FALHA,
      codigo,
      reivindicacao
    });
    const marcado = await marcarDespacho(db, registroId, {
      status: STATUS.FALHA,
      unidade_id: unidade.id,
      codigo_falha: codigo,
      mensagem_falha: errDespacho && errDespacho.message
    }, claimToken);
    if (!marcado) {
      return resultadoClaimPerdido(db, {
        registroId,
        empresaId: empId,
        pedidoId: pedId,
        unidadeId: unidade.id
      });
    }

    return montarResultado({
      success: false,
      status: STATUS.FALHA,
      codigo,
      empresa_id: empId,
      pedido_id: pedId,
      unidade_id: unidade.id,
      mensagem: errDespacho && errDespacho.message ? String(errDespacho.message) : null
    });
  }
}

module.exports = {
  STATUS,
  CODIGOS,
  STALE_EM_ANDAMENTO_MS_PADRAO,
  chaveIdempotenciaPedido,
  despacharPedidoResolvido,
  reivindicarDespacho,
  garantirComandaDoPedido,
  validarUnidadeDestino,
  verificarSchemaDespachoPedidoCozinha,
  garantirSchemaDespachoPedidoCozinha,
  exigirSchemaDespachoPedidoCozinha
};
