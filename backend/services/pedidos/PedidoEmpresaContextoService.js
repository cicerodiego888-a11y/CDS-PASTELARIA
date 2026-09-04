/**
 * Ownership empresarial do pedido (Sprint 05.49).
 * Fonte definitiva: pedidos.empresa_id.
 * Contexto HTTP / COMPAT / usuário / última empresa não substituem o dono persistido.
 *
 * @module services/pedidos/PedidoEmpresaContextoService
 */
'use strict';

const {
  ModoOperacionalGlobal,
  ContratoOperacionalService,
  erroModoGlobal
} = require('../../core/modo-operacional');
const {
  resolverEmpresaId,
  validarEmpresaId
} = require('../fiscalNaoFiscal/empresaContexto');

const CODIGO_EMPRESA_CONTEXT_REQUIRED = 'EMPRESA_CONTEXT_REQUIRED';
const CODIGO_EMPRESA_OWNERSHIP_REQUIRED = 'EMPRESA_OWNERSHIP_REQUIRED';
const CODIGO_PEDIDO_NAO_ENCONTRADO = 'PEDIDO_NAO_ENCONTRADO';
const CODIGO_PEDIDO_EMPRESA_DIVERGENTE = 'PEDIDO_EMPRESA_DIVERGENTE';
const CODIGO_RESERVA_EMPRESA_DIVERGENTE = 'RESERVA_EMPRESA_DIVERGENTE';
const CODIGO_OPERACAO_EMPRESA_DIVERGENTE = 'OPERACAO_EMPRESA_DIVERGENTE';

function erroPedidoEmpresa(code, message, statusCode = 400, extra = {}) {
  const err = erroModoGlobal(code, message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function statusDeErroEmpresaPedido(err) {
  if (!err) return 500;
  if (err.statusCode) return err.statusCode;
  if (err.status) return err.status;
  const code = err.code || '';
  if (code === CODIGO_PEDIDO_NAO_ENCONTRADO || code === 'EMPRESA_NAO_ENCONTRADA') return 404;
  if (code === 'EMPRESA_NAO_AUTORIZADA') return 403;
  if (
    code === CODIGO_PEDIDO_EMPRESA_DIVERGENTE
    || code === CODIGO_RESERVA_EMPRESA_DIVERGENTE
    || code === CODIGO_OPERACAO_EMPRESA_DIVERGENTE
  ) {
    return 409;
  }
  if (
    code === CODIGO_EMPRESA_CONTEXT_REQUIRED
    || code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
    || code === 'EMPRESA_INATIVA'
    || code === 'EMPRESA_OBRIGATORIA'
    || code === 'EMPRESA_ID_OBRIGATORIO'
    || code === 'EMPRESA_OPERACIONAL_AUSENTE'
    || code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    || code === 'EMPRESA_OPERACIONAL_INVALIDA'
  ) {
    return 400;
  }
  return 500;
}

function empresaIdDoHeader(req) {
  const headers = (req && req.headers) || {};
  return resolverEmpresaId(
    headers['x-empresa-id'] != null ? headers['x-empresa-id'] : headers['x-empresaid']
  );
}

function idEmpresaValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve empresa do contexto para CRIAÇÃO de pedido.
 * Não lê query/body como ownership.
 */
async function resolverEmpresaIdParaPedido(req, deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroPedidoEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida para o pedido.',
        409
      );
    }
    return {
      empresaId: id,
      modo,
      origem: 'CONTRATO_EMPRESA_SIMPLES',
      contrato
    };
  }

  const informado = resolverEmpresaId(req && req.empresaId) ?? empresaIdDoHeader(req);

  if (informado == null) {
    throw erroPedidoEmpresa(
      CODIGO_EMPRESA_CONTEXT_REQUIRED,
      'Empresa do contexto é obrigatória para criar pedido.',
      400
    );
  }

  const db = deps.db || (req && req.db) || null;
  const empresaId = await validarEmpresaId(informado, { db, ...deps });

  if (deps.exigirAutorizacaoUsuario !== false && req && req.user) {
    const uid = req.user.id != null ? req.user.id : req.user.usuario_id;
    if (uid) {
      const { exigirEmpresaAutorizada } = deps.UsuarioEmpresaService
        || require('../empresas/UsuarioEmpresaService');
      await exigirEmpresaAutorizada(uid, empresaId, { db });
    }
  }

  return {
    empresaId,
    modo,
    origem: 'CONTEXTO_REQUISICAO',
    contrato
  };
}

/** Pedido novo: contexto explícito. Sem fallback 1 / COMPAT / última empresa. */
function exigirEmpresaDaCriacao(reqOrId) {
  const bruto = reqOrId && typeof reqOrId === 'object'
    ? (reqOrId.empresaId != null ? reqOrId.empresaId : reqOrId.empresa_id)
    : reqOrId;
  const id = idEmpresaValido(bruto);
  if (id == null) {
    throw erroPedidoEmpresa(
      CODIGO_EMPRESA_CONTEXT_REQUIRED,
      'Empresa do contexto é obrigatória para criar pedido.',
      400
    );
  }
  return id;
}

/** Fonte autoritativa: pedidos.empresa_id. */
function resolverEmpresaDoPedido(pedido) {
  if (!pedido) {
    throw erroPedidoEmpresa(CODIGO_PEDIDO_NAO_ENCONTRADO, 'Pedido não encontrado.', 404);
  }
  const sid = idEmpresaValido(pedido.empresa_id != null ? pedido.empresa_id : pedido.empresaId);
  if (sid == null) {
    throw erroPedidoEmpresa(
      CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
      'Empresa é obrigatória para operar o pedido.',
      400,
      { pedido_id: pedido.id != null ? pedido.id : undefined }
    );
  }
  return sid;
}

function exigirEmpresaDoPedido(pedido) {
  return resolverEmpresaDoPedido(pedido);
}

/**
 * Leitura operacional: outra empresa ou legado NULL = NOT_FOUND.
 * Não revela existência cruzada (não usa 403).
 */
function exigirPedidoDaEmpresa(pedido, empresaId) {
  const idEmpresa = Number(empresaId);
  if (!pedido) {
    throw erroPedidoEmpresa(
      CODIGO_PEDIDO_NAO_ENCONTRADO,
      'Pedido não encontrado.',
      404,
      { empresa_id: idEmpresa }
    );
  }
  const sid = idEmpresaValido(pedido.empresa_id != null ? pedido.empresa_id : pedido.empresaId);
  if (sid == null || sid !== idEmpresa) {
    throw erroPedidoEmpresa(
      CODIGO_PEDIDO_NAO_ENCONTRADO,
      'Pedido não encontrado.',
      404,
      { empresa_id: idEmpresa }
    );
  }
  return pedido;
}

function validarEmpresaDoPedidoContraContexto(pedido, empresaIdContexto) {
  const dono = exigirEmpresaDoPedido(pedido);
  const ctx = idEmpresaValido(empresaIdContexto);
  if (ctx == null) {
    throw erroPedidoEmpresa(
      CODIGO_EMPRESA_CONTEXT_REQUIRED,
      'Contexto empresarial obrigatório para autorizar o pedido.',
      400
    );
  }
  if (ctx !== dono) {
    throw erroPedidoEmpresa(
      CODIGO_PEDIDO_NAO_ENCONTRADO,
      'Pedido não encontrado.',
      404,
      { empresa_id: ctx }
    );
  }
  return dono;
}

/**
 * Operação mutável: NULL → EMPRESA_OWNERSHIP_REQUIRED; cruzado → 404.
 */
function exigirOperacaoDoPedido(pedido, empresaIdContexto) {
  if (!pedido) {
    throw erroPedidoEmpresa(
      CODIGO_PEDIDO_NAO_ENCONTRADO,
      'Pedido não encontrado.',
      404,
      { empresa_id: empresaIdContexto != null ? Number(empresaIdContexto) : undefined }
    );
  }
  const empresaDoPedido = resolverEmpresaDoPedido(pedido);
  exigirPedidoDaEmpresa(pedido, empresaIdContexto);
  return empresaDoPedido;
}

function exigirReservaDaMesmaEmpresa(pedido, reserva) {
  const empPedido = exigirEmpresaDoPedido(pedido);
  if (!reserva) {
    throw erroPedidoEmpresa('RESERVA_NAO_ENCONTRADA', 'Reserva não encontrada.', 404);
  }
  const empReserva = idEmpresaValido(reserva.empresa_id != null ? reserva.empresa_id : reserva.empresaId);
  if (empReserva == null) {
    throw erroPedidoEmpresa(
      CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
      'Reserva sem ownership empresarial identificável.',
      400
    );
  }
  if (empReserva !== empPedido) {
    throw erroPedidoEmpresa(
      CODIGO_RESERVA_EMPRESA_DIVERGENTE,
      'empresa_id da reserva diverge da empresa persistida do pedido.',
      409,
      {
        pedido_empresa_id: empPedido,
        reserva_empresa_id: empReserva
      }
    );
  }
  return empPedido;
}

function exigirCadeiaEmpresaPedidoReservaVenda(ids = {}) {
  const pedidoId = idEmpresaValido(ids.pedido);
  const reservaId = ids.reserva != null ? idEmpresaValido(ids.reserva) : pedidoId;
  const vendaId = ids.venda != null ? idEmpresaValido(ids.venda) : pedidoId;
  const estoqueId = ids.estoque != null ? idEmpresaValido(ids.estoque) : pedidoId;
  const escolhido = pedidoId;
  if (escolhido == null) {
    throw erroPedidoEmpresa(
      CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
      'Empresa é obrigatória para a cadeia pedido → reserva → estoque.',
      400
    );
  }
  const conhecidos = [pedidoId, reservaId, vendaId, estoqueId].filter((id) => id != null);
  for (const id of conhecidos) {
    if (id !== escolhido) {
      throw erroPedidoEmpresa(
        CODIGO_OPERACAO_EMPRESA_DIVERGENTE,
        'empresa_id diverge na cadeia pedido/reserva/venda/estoque.',
        409,
        {
          pedido_empresa_id: pedidoId,
          reserva_empresa_id: reservaId,
          venda_empresa_id: vendaId,
          estoque_empresa_id: estoqueId
        }
      );
    }
  }
  return escolhido;
}

function responderErroEmpresaPedido(res, err) {
  const status = statusDeErroEmpresaPedido(err);
  return res.status(status).json({
    success: false,
    error: err.message || 'Erro de ownership do pedido.',
    mensagem: err.message || 'Erro de ownership do pedido.',
    codigo: err.code || CODIGO_EMPRESA_CONTEXT_REQUIRED,
    code: err.code || CODIGO_EMPRESA_CONTEXT_REQUIRED,
    empresa_id: err.empresa_id != null ? err.empresa_id : undefined
  });
}

module.exports = {
  CODIGO_EMPRESA_CONTEXT_REQUIRED,
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
  CODIGO_PEDIDO_NAO_ENCONTRADO,
  CODIGO_PEDIDO_EMPRESA_DIVERGENTE,
  CODIGO_RESERVA_EMPRESA_DIVERGENTE,
  CODIGO_OPERACAO_EMPRESA_DIVERGENTE,
  erroPedidoEmpresa,
  statusDeErroEmpresaPedido,
  responderErroEmpresaPedido,
  resolverEmpresaIdParaPedido,
  exigirEmpresaDaCriacao,
  resolverEmpresaDoPedido,
  exigirEmpresaDoPedido,
  exigirPedidoDaEmpresa,
  validarEmpresaDoPedidoContraContexto,
  exigirOperacaoDoPedido,
  exigirReservaDaMesmaEmpresa,
  exigirCadeiaEmpresaPedidoReservaVenda
};
