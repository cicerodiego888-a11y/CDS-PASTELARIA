/**
 * Motor Comercial — orquestração RC3.16.1
 *
 * Pedido → Motor Comercial → F×NF / Supervisor / MTS → Reserva → Confirmado
 *
 * NÃO manipula saldo diretamente.
 * NÃO acessa estrutura interna do F×NF nem do MTS.
 *
 * @module motores/comercial/MotorComercialService
 */
'use strict';

const fxnfSaldos = require('../../services/fiscalNaoFiscal/estoqueSaldosPublico');
const fxnfReservas = require('../../services/fiscalNaoFiscal/reservasPublico');
const { resolverEmpresaId } = require('../../services/fiscalNaoFiscal/empresaContexto');
const {
  exigirEmpresaDoPedido,
  exigirEmpresaDaCriacao,
  CODIGO_PEDIDO_EMPRESA_DIVERGENTE,
  CODIGO_RESERVA_EMPRESA_DIVERGENTE,
  CODIGO_PEDIDO_NAO_ENCONTRADO,
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
  CODIGO_EMPRESA_CONTEXT_REQUIRED
} = require('../../services/pedidos/PedidoEmpresaContextoService');
const mts = require('../mts');
const auditoria = require('./PedidoEstoqueAuditoria');
const { TipoSaldo } = require('../../services/fiscalNaoFiscal/constants');

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function carregarPedido(db, pedidoId) {
  const tentativas = [
    `SELECT id, empresa_id, status, venda_id FROM pedidos WHERE id = ?`,
    `SELECT id, empresa_id, status FROM pedidos WHERE id = ?`,
    `SELECT id, status FROM pedidos WHERE id = ?`
  ];
  for (const sql of tentativas) {
    try {
      return await dbGet(db, sql, [pedidoId]);
    } catch (err) {
      const msg = String(err && err.message || '');
      if (msg.includes('no such table')) return null;
      if (msg.includes('no such column')) continue;
      throw err;
    }
  }
  return null;
}

/**
 * Pedido existente → pedidos.empresa_id.
 * Sem pedido (pré-criação) → empresaId explícito do caller.
 * COMPAT não é fonte de ownership.
 */
async function resolverEmpresaMotor(opts = {}) {
  const db = getDb(opts.db);
  const pedidoId = Number(opts.pedidoId || opts.pedido_id);
  const caller = resolverEmpresaId(opts)
    ?? resolverEmpresaId(opts.contexto)
    ?? resolverEmpresaId(opts.pedido);

  if (Number.isInteger(pedidoId) && pedidoId > 0) {
    const pedido = await carregarPedido(db, pedidoId);
    if (!pedido) {
      throw erro(CODIGO_PEDIDO_NAO_ENCONTRADO, 'Pedido não encontrado.', { statusCode: 404 });
    }
    let empresaPedido;
    try {
      empresaPedido = exigirEmpresaDoPedido(pedido);
    } catch (err) {
      throw erro(
        err.code || CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
        err.message || 'Empresa é obrigatória para operar o pedido.',
        { statusCode: err.statusCode || 400, pedido_id: pedidoId }
      );
    }
    if (caller != null && caller !== empresaPedido) {
      throw erro(
        CODIGO_PEDIDO_EMPRESA_DIVERGENTE,
        'empresaId do Motor diverge de pedidos.empresa_id.',
        {
          statusCode: 409,
          pedido_empresa_id: empresaPedido,
          empresa_id: caller
        }
      );
    }
    return { empresaId: empresaPedido, pedido };
  }

  try {
    const empresaId = exigirEmpresaDaCriacao({ empresaId: caller });
    return { empresaId, pedido: null };
  } catch (err) {
    throw erro(
      err.code || CODIGO_EMPRESA_CONTEXT_REQUIRED,
      err.message || 'Empresa do contexto é obrigatória.',
      { statusCode: err.statusCode || 400 }
    );
  }
}

function optsPortaSaldos(opts = {}, empresaId) {
  const id = empresaId != null ? Number(empresaId) : resolverEmpresaId(opts);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro(
      CODIGO_EMPRESA_CONTEXT_REQUIRED,
      'Empresa é obrigatória para a porta F×NF do pedido.',
      { statusCode: 400 }
    );
  }
  return {
    db: opts.db,
    empresaId: id,
    usuarioId: opts.usuarioId,
    validarEmpresa: opts.validarEmpresa
  };
}

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../database');
}

function erro(codigo, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.code = codigo;
  err.codigo = codigo;
  err.statusCode = extra.statusCode || 409;
  Object.assign(err, extra);
  return err;
}

function normalizarItens(itens) {
  if (!Array.isArray(itens) || itens.length === 0) {
    throw erro('ITENS_INVALIDOS', 'Informe ao menos um item.', { statusCode: 400 });
  }
  return itens.map((raw, idx) => {
    const produtoId = Number(raw.produto_id || raw.produtoId);
    const quantidade = round3(raw.quantidade);
    if (!Number.isInteger(produtoId) || produtoId <= 0 || !(quantidade > 0)) {
      throw erro('ITENS_INVALIDOS', `Item ${idx + 1}: produto/quantidade inválidos.`, { statusCode: 400 });
    }
    return {
      produto_id: produtoId,
      quantidade,
      pedido_item_id: raw.id != null ? Number(raw.id) : (raw.pedido_item_id != null ? Number(raw.pedido_item_id) : null)
    };
  });
}

/**
 * Agrega quantidades por produto (pedidos com linhas repetidas).
 */
function agregarPorProduto(itens) {
  const map = new Map();
  for (const item of itens) {
    const prev = map.get(item.produto_id) || { produto_id: item.produto_id, quantidade: 0, linhas: [] };
    prev.quantidade = round3(prev.quantidade + item.quantidade);
    prev.linhas.push(item);
    map.set(item.produto_id, prev);
  }
  return [...map.values()];
}

async function verificarSupervisor(token, deps = {}, escopoOperacao = null) {
  if (!token) return null;
  const verify = deps.verificarSupervisorToken
    || require('../../rotas/auth').verificarSupervisorToken;
  try {
    return await verify(token, escopoOperacao);
  } catch (e) {
    // RC5.1.4 — propaga reutilização sem alterar regras de perfil/autorização
    if (e && (e.code === 'TOKEN_JA_UTILIZADO' || e.codigo === 'TOKEN_JA_UTILIZADO')) {
      throw erro(
        'TOKEN_JA_UTILIZADO',
        e.message || 'Token de autorização já utilizado.',
        { statusCode: 403 }
      );
    }
    // RC5.1.5 — token vinculado a outro pedido/produto/quantidade
    if (e && (e.code === 'TOKEN_FORA_DO_ESCOPO' || e.codigo === 'TOKEN_FORA_DO_ESCOPO')) {
      throw erro(
        'TOKEN_FORA_DO_ESCOPO',
        e.message || 'Token de autorização fora do escopo da operação.',
        { statusCode: 403 }
      );
    }
    throw erro(
      'AUTORIZACAO_REJEITADA',
      e.message || 'Autorização de supervisor inválida.',
      { statusCode: 403 }
    );
  }
}

/**
 * RC5.1.5 — escopo da operação a partir do plano que exige transferência.
 */
function montarEscopoAutorizacao(pedidoId, analise) {
  const passos = (analise?.plano || [])
    .filter((p) => p.acao === 'TRANSFERIR_E_RESERVAR')
    .map((p) => ({
      produto_id: Number(p.produto_id),
      quantidade: round3(p.quantidade)
    }))
    .sort((a, b) => a.produto_id - b.produto_id);

  return {
    pedido_id: Number(pedidoId),
    produtos: passos.map((p) => p.produto_id),
    quantidades: passos.map((p) => p.quantidade)
  };
}

/**
 * Analisa disponibilidade fiscal sem mutar estoque.
 */
async function analisarDisponibilidadeFiscal(itensBrutos, opts = {}) {
  const db = getDb(opts.db);
  const resolved = await resolverEmpresaMotor({ ...opts, db });
  const portaOpts = optsPortaSaldos({ ...opts, db }, resolved.empresaId);
  const itens = agregarPorProduto(normalizarItens(itensBrutos));
  const consultas = [];
  const plano = [];

  let requerAutorizacao = false;
  let bloqueado = false;

  for (const item of itens) {
    const disp = await fxnfReservas.consultarDisponibilidadeParaPedido(
      item.produto_id,
      opts.pedidoId || null,
      portaOpts
    );
    await auditoria.registrar(db, {
      pedido_id: opts.pedidoId || null,
      produto_id: item.produto_id,
      evento: auditoria.Evento.CONSULTA,
      quantidade: item.quantidade,
      saldo_fiscal: disp.saldo_fiscal,
      saldo_nao_fiscal: disp.saldo_nao_fiscal,
      disponivel_fiscal: disp.disponivel_fiscal,
      disponivel_nao_fiscal: disp.disponivel_nao_fiscal,
      usuario_id: opts.usuarioId || null
    });

    consultas.push({ ...disp, quantidade_solicitada: item.quantidade });

    const faltaFiscal = round3(Math.max(0, item.quantidade - disp.disponivel_fiscal));
    if (faltaFiscal <= 0) {
      plano.push({
        produto_id: item.produto_id,
        quantidade: item.quantidade,
        acao: 'RESERVAR',
        transferir: 0,
        linhas: item.linhas
      });
      continue;
    }

    if (disp.disponivel_nao_fiscal + 1e-9 >= faltaFiscal) {
      requerAutorizacao = true;
      plano.push({
        produto_id: item.produto_id,
        quantidade: item.quantidade,
        acao: 'TRANSFERIR_E_RESERVAR',
        transferir: faltaFiscal,
        linhas: item.linhas,
        disponivel_fiscal: disp.disponivel_fiscal,
        disponivel_nao_fiscal: disp.disponivel_nao_fiscal
      });
      await auditoria.registrar(db, {
        pedido_id: opts.pedidoId || null,
        produto_id: item.produto_id,
        evento: auditoria.Evento.REQUER_AUTORIZACAO,
        quantidade: faltaFiscal,
        saldo_fiscal: disp.saldo_fiscal,
        saldo_nao_fiscal: disp.saldo_nao_fiscal,
        disponivel_fiscal: disp.disponivel_fiscal,
        disponivel_nao_fiscal: disp.disponivel_nao_fiscal,
        detalhes: { motivo: 'fiscal_insuficiente_nao_fiscal_ok' },
        usuario_id: opts.usuarioId || null
      });
      continue;
    }

    bloqueado = true;
    plano.push({
      produto_id: item.produto_id,
      quantidade: item.quantidade,
      acao: 'BLOQUEAR',
      transferir: 0,
      linhas: item.linhas,
      disponivel_fiscal: disp.disponivel_fiscal,
      disponivel_nao_fiscal: disp.disponivel_nao_fiscal,
      disponivel_total: disp.disponivel_total
    });
    await auditoria.registrar(db, {
      pedido_id: opts.pedidoId || null,
      produto_id: item.produto_id,
      evento: auditoria.Evento.BLOQUEADO,
      quantidade: item.quantidade,
      saldo_fiscal: disp.saldo_fiscal,
      saldo_nao_fiscal: disp.saldo_nao_fiscal,
      disponivel_fiscal: disp.disponivel_fiscal,
      disponivel_nao_fiscal: disp.disponivel_nao_fiscal,
      detalhes: { mensagem: 'Saldo insuficiente para atender o pedido.' },
      usuario_id: opts.usuarioId || null
    });
  }

  return Object.freeze({
    ok: !bloqueado && !requerAutorizacao,
    bloqueado,
    requerAutorizacao,
    plano,
    consultas
  });
}

/**
 * Executa transferências (MTS) + reservas fiscais (F×NF) em uma transação.
 */
async function executarConfirmacaoFiscal(params = {}, deps = {}) {
  const db = getDb(deps.db);
  const pedidoId = Number(params.pedidoId || params.pedido_id);
  const itens = params.itens;
  const usuarioId = params.usuarioId != null ? Number(params.usuarioId) : null;
  const motivo = params.motivo || `Reserva fiscal pedido #${pedidoId}`;
  const resolved = await resolverEmpresaMotor({ ...params, ...deps, db, pedidoId });
  const empresaIdPedido = resolved.empresaId;

  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    throw erro('PEDIDO_INVALIDO', 'Pedido inválido.', { statusCode: 400 });
  }

  const analise = params.analise
    || await analisarDisponibilidadeFiscal(itens, { db, pedidoId, usuarioId, empresaId: empresaIdPedido });

  if (analise.bloqueado) {
    throw erro(
      'SALDO_INSUFICIENTE',
      'Saldo insuficiente para atender o pedido.',
      { statusCode: 409, plano: analise.plano, consultas: analise.consultas }
    );
  }

  let supervisor = null;
  if (analise.requerAutorizacao) {
    if (!params.supervisorToken) {
      throw erro(
        'REQUER_AUTORIZACAO_SUPERVISOR',
        'Saldo fiscal insuficiente. É necessária autorização do supervisor para transferir do saldo não fiscal.',
        {
          statusCode: 409,
          requer_autorizacao: true,
          plano: analise.plano.filter((p) => p.acao === 'TRANSFERIR_E_RESERVAR'),
          consultas: analise.consultas
        }
      );
    }
    // RC5.1.5 — valida claims do token contra a operação atual
    const escopoOperacao = montarEscopoAutorizacao(pedidoId, analise);
    supervisor = await verificarSupervisor(params.supervisorToken, deps, escopoOperacao);
    await auditoria.registrar(db, {
      pedido_id: pedidoId,
      evento: auditoria.Evento.AUTORIZACAO_CONCEDIDA,
      supervisor_id: supervisor?.id || supervisor?.usuario_id || null,
      usuario_id: usuarioId,
      detalhes: { username: supervisor?.username || null }
    });
  }

  const transferencias = [];
  const reservas = [];

  const executarTx = deps.executarEmTransacao || fxnfSaldos.executarEmTransacao;

  try {
    await executarTx(async (txDb) => {
      // RC5.1.3 — após BEGIN IMMEDIATE, descartar plano pré-TX e recalcular sob lock
      const analiseLock = await analisarDisponibilidadeFiscal(itens, {
        db: txDb,
        pedidoId,
        usuarioId,
        empresaId: empresaIdPedido,
        validarEmpresa: deps.validarEmpresa || params.validarEmpresa
      });

      if (analiseLock.bloqueado) {
        throw erro(
          'SALDO_INSUFICIENTE',
          'Saldo insuficiente para atender o pedido.',
          { statusCode: 409, plano: analiseLock.plano, consultas: analiseLock.consultas }
        );
      }

      // Autorização já resolvida fora da TX; se o plano fresco ainda exige e não há supervisor, bloqueia
      if (analiseLock.requerAutorizacao && !supervisor) {
        throw erro(
          'REQUER_AUTORIZACAO_SUPERVISOR',
          'Saldo fiscal insuficiente. É necessária autorização do supervisor para transferir do saldo não fiscal.',
          {
            statusCode: 409,
            requer_autorizacao: true,
            plano: analiseLock.plano.filter((p) => p.acao === 'TRANSFERIR_E_RESERVAR'),
            consultas: analiseLock.consultas
          }
        );
      }

      const portaOpts = optsPortaSaldos({
        ...params,
        ...deps,
        db: txDb,
        usuarioId,
        empresaId: empresaIdPedido
      }, empresaIdPedido);

      // Libera reservas anteriores do mesmo pedido (reativação / edição)
      await fxnfReservas.liberarReservasPedido(pedidoId, portaOpts);

      for (const passo of analiseLock.plano) {
        if (passo.acao === 'TRANSFERIR_E_RESERVAR' && passo.transferir > 0) {
          const tr = await mts.transferirSaldo({
            produto: passo.produto_id,
            empresaId: portaOpts.empresaId,
            origem: TipoSaldo.NAO_FISCAL,
            destino: TipoSaldo.FISCAL,
            quantidade: passo.transferir,
            motivo,
            usuario: supervisor?.id || usuarioId,
            // RC5.1.2 — contexto já validado (token/perfil no Motor Comercial)
            contextoAutorizacao: {
              autorizado: true,
              supervisor_id: supervisor?.id || supervisor?.usuario_id || null,
              usuario_id: usuarioId
            }
          }, {
            db: txDb,
            jaEmTransacao: true,
            estoque: {
              ...fxnfSaldos,
              executarEmTransacao: async (work) => work(txDb)
            }
          });
          transferencias.push(tr);
          await auditoria.registrar(txDb, {
            pedido_id: pedidoId,
            produto_id: passo.produto_id,
            evento: auditoria.Evento.TRANSFERENCIA,
            quantidade: passo.transferir,
            usuario_id: usuarioId,
            supervisor_id: supervisor?.id || null,
            detalhes: { transferencia_id: tr.transferencia_id }
          });
        }

        // Reserva por linha original (preserva pedido_item_id)
        const linhas = passo.linhas && passo.linhas.length
          ? passo.linhas
          : [{ produto_id: passo.produto_id, quantidade: passo.quantidade, pedido_item_id: null }];

        for (const linha of linhas) {
          const res = await fxnfReservas.criarReservaFiscal({
            pedidoId,
            produtoId: linha.produto_id,
            quantidade: linha.quantidade,
            pedidoItemId: linha.pedido_item_id,
            empresaId: empresaIdPedido
          }, portaOpts);
          if (res && res.empresa_id != null && Number(res.empresa_id) !== empresaIdPedido) {
            throw erro(
              CODIGO_RESERVA_EMPRESA_DIVERGENTE,
              'empresa_id da reserva diverge da empresa persistida do pedido.',
              { statusCode: 409 }
            );
          }
          reservas.push(res);
          await auditoria.registrar(txDb, {
            pedido_id: pedidoId,
            produto_id: linha.produto_id,
            evento: auditoria.Evento.RESERVA,
            quantidade: linha.quantidade,
            usuario_id: usuarioId,
            supervisor_id: supervisor?.id || null,
            detalhes: { reserva_id: res.id }
          });
        }
      }

      await auditoria.registrar(txDb, {
        pedido_id: pedidoId,
        evento: auditoria.Evento.CONFIRMADO,
        usuario_id: usuarioId,
        supervisor_id: supervisor?.id || null,
        detalhes: {
          transferencias: transferencias.length,
          reservas: reservas.length
        }
      });
    }, { db });
  } catch (err) {
    try {
      await auditoria.registrar(db, {
        pedido_id: pedidoId,
        evento: auditoria.Evento.ROLLBACK,
        usuario_id: usuarioId,
        detalhes: { erro: err.message, code: err.code || err.codigo }
      });
    } catch (_) { /* ignore */ }
    throw err;
  }

  return Object.freeze({
    sucesso: true,
    pedido_id: pedidoId,
    transferencias,
    reservas,
    supervisor_id: supervisor?.id || null
  });
}

/**
 * API pública do Motor Comercial para confirmação do Pedido.
 */
async function confirmarPedidoFiscal(params = {}, deps = {}) {
  const itens = params.itens;
  const db = getDb(deps.db);
  const pedidoId = Number(params.pedidoId || params.pedido_id);
  const usuarioId = params.usuarioId != null ? Number(params.usuarioId) : null;

  const analise = await analisarDisponibilidadeFiscal(itens, {
    db,
    pedidoId,
    usuarioId,
    empresaId: resolverEmpresaId(params) ?? resolverEmpresaId(deps),
    validarEmpresa: deps.validarEmpresa || params.validarEmpresa
  });

  const resolved = await resolverEmpresaMotor({
    ...params,
    ...deps,
    db,
    pedidoId
  });

  return executarConfirmacaoFiscal({
    pedidoId,
    itens,
    analise,
    supervisorToken: params.supervisorToken || params.supervisor_token || null,
    usuarioId,
    motivo: params.motivo,
    empresaId: resolved.empresaId,
    validarEmpresa: deps.validarEmpresa || params.validarEmpresa
  }, deps);
}

/**
 * Libera reservas via F×NF (cancelamento de pedido).
 */
async function liberarReservasDoPedido(pedidoId, deps = {}) {
  const db = getDb(deps.db);
  const resolved = await resolverEmpresaMotor({ ...deps, db, pedidoId });
  return fxnfReservas.liberarReservasPedido(
    pedidoId,
    optsPortaSaldos({ ...deps, db }, resolved.empresaId)
  );
}

module.exports = {
  analisarDisponibilidadeFiscal,
  executarConfirmacaoFiscal,
  confirmarPedidoFiscal,
  liberarReservasDoPedido,
  resolverEmpresaMotor,
  EventoAuditoria: auditoria.Evento
};
