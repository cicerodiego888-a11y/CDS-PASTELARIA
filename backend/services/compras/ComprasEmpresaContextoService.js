/**
 * Resolução de empresa operacional para Compras (Sprint 05.38.F.B).
 * Adaptador fino — não é motor de compras.
 * Fonte: ContratoOperacionalService + documento Central + contexto HTTP.
 *
 * @module services/compras/ComprasEmpresaContextoService
 */
'use strict';

const {
  ModoOperacionalGlobal,
  ContratoOperacionalService,
  erroModoGlobal
} = require('../../core/modo-operacional');
const {
  resolverEmpresaId,
  resolverEmpresaIdDaRequisicao,
  validarEmpresaId
} = require('../fiscalNaoFiscal/empresaContexto');

function erroCompraEmpresa(code, message, statusCode = 400, extra = {}) {
  const err = erroModoGlobal(code, message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function statusDeErroCompraEmpresa(err) {
  if (!err) return 500;
  if (err.statusCode) return err.statusCode;
  if (err.status) return err.status;
  const code = err.code || '';
  if (code === 'EMPRESA_NAO_ENCONTRADA') return 404;
  if (
    code === 'COMPRA_EMPRESA_INCOMPATIVEL'
    || code === 'EMPRESA_COMPRA_INCOMPATIVEL'
    || code === 'DOCUMENTO_EMPRESA_INCOMPATIVEL'
    || code === 'OPERACAO_EMPRESA_DIVERGENTE'
    || code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
    || code === 'FINANCEIRO_EMPRESA_DIVERGENTE'
  ) {
    return code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA' || code === 'OPERACAO_EMPRESA_DIVERGENTE'
      ? 409
      : 403;
  }
  if (code === 'DOCUMENTO_NAO_ENCONTRADO' || code === 'DOCUMENTO_CENTRAL_AUSENTE') return 404;
  if (code === 'COMPRA_NAO_ENCONTRADA' || code === 'COMPRA_AUSENTE') return 404;
  if (code === 'EMPRESA_OWNERSHIP_REQUIRED') return 409;
  if (
    code === 'EMPRESA_INATIVA'
    || code === 'EMPRESA_COMPRA_AUSENTE'
    || code === 'EMPRESA_COMPRA_NAO_RESOLVIDA'
    || code === 'EMPRESA_OPERACIONAL_AUSENTE'
    || code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    || code === 'EMPRESA_OPERACIONAL_INVALIDA'
    || code === 'EMPRESA_OBRIGATORIA'
    || code === 'EMPRESA_CENTRAL_INATIVA'
  ) {
    return 400;
  }
  return 500;
}

async function carregarDocumentoCentral(centralDocumentoId, deps = {}) {
  const id = Number(centralDocumentoId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (typeof deps.buscarDocumentoCentral === 'function') {
    return deps.buscarDocumentoCentral(id);
  }
  const CentralDocumentosRepository = deps.CentralDocumentosRepository
    || require('../../motores/central-entradas/repositories/CentralDocumentosRepository');
  const repo = new CentralDocumentosRepository({ db: deps.db || null });
  return repo.buscarPorId(id);
}

/**
 * Resolve empresa_id único para criação de compra (antes do BEGIN).
 *
 * Com central_documento_id: só documento.empresa_id (contexto autoriza).
 * Sem documento Central: contexto HTTP / body / contrato EMPRESA_SIMPLES.
 *
 * @param {object} req
 * @param {object} [opts]
 * @param {number|string|null} [opts.centralDocumentoId]
 * @param {number|string|null} [opts.empresaIdBody]
 * @param {object} [deps]
 */
/**
 * Compra originada da Central: DOCUMENTO determina. Contexto só autoriza.
 * Body / HTTP / empresa operacional NÃO são fonte de ownership.
 */
async function resolverEmpresaDaCompraDesdeDocumentoCentral(req, opts, deps) {
  const {
    exigirDocumentoDaEmpresa,
    exigirEmpresaIdDoDocumento,
    exigirDocumentoCompraMesmaEmpresa,
    resolverEmpresaParaCentral
  } = require('../central-entradas/CentralEntradasEmpresaContextoService');

  const db = deps.db || opts.db || (req && req.db) || null;
  const documento = await carregarDocumentoCentral(opts.centralDocumentoId, { db, ...deps });
  if (!documento) {
    const err = erroCompraEmpresa(
      'DOCUMENTO_NAO_ENCONTRADO',
      'Documento não encontrado',
      404
    );
    throw err;
  }

  const ctx = await resolverEmpresaParaCentral({
    req,
    empresaId: req && req.empresaId
  }, deps);

  await exigirDocumentoDaEmpresa(
    { documento, documentoId: documento.id, empresaId: ctx.empresaId },
    { db, ...deps }
  );

  const empresaDocumentoId = exigirEmpresaIdDoDocumento(documento);

  const compraIdExistente = documento.compraId != null
    ? Number(documento.compraId)
    : (documento.compra_id != null ? Number(documento.compra_id) : null);
  if (Number.isInteger(compraIdExistente) && compraIdExistente > 0) {
    let compraEmpresaId = null;
    if (typeof deps.buscarEmpresaIdCompra === 'function') {
      compraEmpresaId = await deps.buscarEmpresaIdCompra(compraIdExistente);
    } else {
      try {
        const CentralDocumentosRepository = deps.CentralDocumentosRepository
          || require('../../motores/central-entradas/repositories/CentralDocumentosRepository');
        const repo = new CentralDocumentosRepository({ db });
        const sql = repo._obterSql();
        await sql.whenReady();
        const row = await sql.get('SELECT empresa_id FROM compras WHERE id = ?', [compraIdExistente]);
        compraEmpresaId = row && row.empresa_id != null ? Number(row.empresa_id) : null;
      } catch { /* ignore */ }
    }
    exigirDocumentoCompraMesmaEmpresa(empresaDocumentoId, compraEmpresaId);
  }

  return {
    empresaId: empresaDocumentoId,
    modo: opts.modo || ctx.modo,
    origem: 'DOCUMENTO_CENTRAL',
    contrato: opts.contrato || ctx.contrato,
    documento,
    exigirEmpresaEstoque: (opts.modo || ctx.modo) === ModoOperacionalGlobal.MULTIEMPRESA
  };
}

/**
 * Resolve empresa_id único para criação de compra (antes do BEGIN).
 *
 * Com central_documento_id: somente documento.empresa_id (após autorização).
 * Sem documento Central: contexto HTTP / body / contrato EMPRESA_SIMPLES.
 */
async function resolverEmpresaDaCompra(req, opts = {}, deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;
  const db = deps.db || (req && req.db) || null;

  const centralDocumentoId = opts.centralDocumentoId != null
    ? opts.centralDocumentoId
    : (opts.central_documento_id != null ? opts.central_documento_id : null);

  if (centralDocumentoId != null && String(centralDocumentoId).trim() !== '') {
    return resolverEmpresaDaCompraDesdeDocumentoCentral(req, {
      centralDocumentoId,
      modo,
      contrato,
      db
    }, deps);
  }

  const httpId = resolverEmpresaId(req && req.empresaId)
    ?? resolverEmpresaIdDaRequisicao(req);
  const bodyId = resolverEmpresaId(opts.empresaIdBody)
    ?? resolverEmpresaId(opts.empresa_id)
    ?? resolverEmpresaId(opts);

  let empresaCompraId = httpId != null ? Number(httpId) : (bodyId != null ? Number(bodyId) : null);

  if (bodyId != null && httpId != null && Number(bodyId) !== Number(httpId)) {
    throw erroCompraEmpresa(
      'EMPRESA_COMPRA_INCOMPATIVEL',
      `empresa_id do body (${bodyId}) diverge do contexto HTTP (${httpId}).`,
      403,
      { body_empresa_id: bodyId, contexto_empresa_id: httpId }
    );
  }

  if (empresaCompraId != null) {
    empresaCompraId = await validarEmpresaId(empresaCompraId, { db, ...deps });
    return {
      empresaId: empresaCompraId,
      modo,
      origem: httpId != null ? 'CONTEXTO_HTTP' : 'BODY_EXPLICITO',
      contrato,
      documento: null,
      exigirEmpresaEstoque: modo === ModoOperacionalGlobal.MULTIEMPRESA
    };
  }

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroCompraEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida para criar compra.',
        409
      );
    }
    return {
      empresaId: id,
      modo,
      origem: 'CONTRATO_EMPRESA_SIMPLES',
      contrato,
      documento: null,
      exigirEmpresaEstoque: false
    };
  }

  throw erroCompraEmpresa(
    'EMPRESA_COMPRA_AUSENTE',
    'Modo MULTIEMPRESA exige empresa resolvida para criar compra (Central, X-Empresa-Id ou contexto válido).',
    400
  );
}

/**
 * Resolve empresa do contexto para listagem / ownership de compra existente.
 */
async function resolverEmpresaContextoCompra(req, deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;
  const db = deps.db || (req && req.db) || null;

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroCompraEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida.',
        409
      );
    }
    return { empresaId: id, modo, origem: 'CONTRATO_EMPRESA_SIMPLES', contrato };
  }

  const informado = resolverEmpresaId(req && req.empresaId)
    ?? resolverEmpresaIdDaRequisicao(req);
  if (informado == null) {
    throw erroCompraEmpresa(
      'EMPRESA_COMPRA_AUSENTE',
      'Modo MULTIEMPRESA exige X-Empresa-Id / contexto empresarial para operações de compra.',
      400
    );
  }
  const empresaId = await validarEmpresaId(informado, { db, ...deps });
  return { empresaId, modo, origem: 'CONTEXTO_HTTP', contrato };
}

/**
 * Ownership: compra.empresa_id deve bater com o contexto.
 * Registros legados NULL: EMPRESA_COMPRA_NAO_RESOLVIDA em MULTIEMPRESA;
 * EMPRESA_SIMPLES só se empresa operacional == contexto (determinístico).
 */
function exigirCompraDaEmpresa(compra, empresaId, opts = {}) {
  const rotulo = opts.rotulo || 'Compra';
  if (!compra) {
    throw erroCompraEmpresa(
      'COMPRA_AUSENTE',
      `${rotulo} não encontrada.`,
      404,
      { empresa_id: empresaId }
    );
  }

  const cid = compra.empresa_id != null ? Number(compra.empresa_id) : null;
  const esperado = Number(empresaId);

  if (cid == null || !Number.isInteger(cid) || cid <= 0) {
    if (opts.modo === ModoOperacionalGlobal.EMPRESA_SIMPLES
      && Number.isInteger(esperado) && esperado > 0
      && opts.permitirLegadoSimples === true) {
      return compra;
    }
    throw erroCompraEmpresa(
      'EMPRESA_COMPRA_NAO_RESOLVIDA',
      `${rotulo} legada sem empresa_id. Não é possível operar com isolamento multiempresa.`,
      409,
      { id: compra.id }
    );
  }

  if (cid !== esperado) {
    throw erroCompraEmpresa(
      'COMPRA_EMPRESA_INCOMPATIVEL',
      `${rotulo} não pertence à empresa do contexto atual.`,
      403,
      {
        id: compra.id,
        empresa_id: esperado,
        compra_empresa_id: cid
      }
    );
  }
  return compra;
}

/**
 * Mutação/leitura opaca: mesma fonte (compra.empresa_id) que exigirCompraDaEmpresa.
 * Cruzado → 404 COMPRA_NAO_ENCONTRADA sem dados da outra empresa.
 * NULL → EMPRESA_OWNERSHIP_REQUIRED (sem fallback).
 * PUT chave (05.58): inexistente permanece COMPRA_AUSENTE salvo opts.
 */
function exigirCompraParaMutacaoOpaca(compra, empresaIdContexto, opts = {}) {
  try {
    return exigirCompraDaEmpresa(compra, empresaIdContexto, { permitirLegadoSimples: false });
  } catch (err) {
    if (err && err.code === 'COMPRA_AUSENTE') {
      const code = opts.tratarInexistenteComoNaoEncontrada
        ? 'COMPRA_NAO_ENCONTRADA'
        : 'COMPRA_AUSENTE';
      throw erroCompraEmpresa(code, 'Compra não encontrada.', 404);
    }
    if (err && err.code === 'EMPRESA_COMPRA_NAO_RESOLVIDA') {
      throw erroCompraEmpresa(
        'EMPRESA_OWNERSHIP_REQUIRED',
        opts.mensagemNull
          || 'Compra sem empresa_id. Não é possível operar este recurso.',
        409
      );
    }
    if (err && err.code === 'COMPRA_EMPRESA_INCOMPATIVEL') {
      throw erroCompraEmpresa('COMPRA_NAO_ENCONTRADA', 'Compra não encontrada.', 404);
    }
    throw err;
  }
}

function jsonErroCompraOpaca(err) {
  return {
    error: (err && err.message) || 'Compra não encontrada.',
    code: (err && err.code) || 'COMPRA_NAO_ENCONTRADA'
  };
}

function carregarCompraAutorizada(db, opts, callback) {
  const id = opts && opts.compraId;
  const empresaId = opts && opts.empresaId;
  db.get('SELECT * FROM compras WHERE id = ?', [id], (err, compra) => {
    if (err) return callback(err);
    try {
      exigirCompraParaMutacaoOpaca(compra, empresaId, {
        tratarInexistenteComoNaoEncontrada: true
      });
    } catch (ownErr) {
      return callback(ownErr);
    }
    return callback(null, compra);
  });
}

function carregarCompraAutorizadaP(db, opts) {
  return new Promise((resolve, reject) => {
    carregarCompraAutorizada(db, opts, (err, compra) => {
      if (err) reject(err);
      else resolve(compra);
    });
  });
}

function atualizarChaveNfeFornecedorCompra(db, opts, callback) {
  const id = Number(opts && opts.compraId);
  const empresaId = Number(opts && opts.empresaId);
  const chave = String((opts && opts.chave) || '').replace(/\D/g, '');

  db.get('SELECT * FROM compras WHERE id = ?', [id], (err, compra) => {
    if (err) return callback(err);
    try {
      exigirCompraParaMutacaoOpaca(compra, empresaId);
    } catch (ownErr) {
      return callback(ownErr);
    }

    if (chave.length !== 44) {
      const invalida = new Error('A chave da NF-e deve ter 44 dígitos.');
      invalida.statusCode = 400;
      return callback(invalida);
    }

    db.run(
      'UPDATE compras SET chave_acesso = ? WHERE id = ? AND empresa_id = ?',
      [chave, id, empresaId],
      function onUpdate(updErr) {
        if (updErr) return callback(updErr);
        if (!this.changes) {
          return callback(erroCompraEmpresa(
            'COMPRA_NAO_ENCONTRADA',
            'Compra não encontrada.',
            404
          ));
        }
        return callback(null, { success: true, changes: this.changes });
      }
    );
  });
}

module.exports = {
  resolverEmpresaDaCompra,
  resolverEmpresaContextoCompra,
  exigirCompraDaEmpresa,
  exigirCompraParaMutacaoOpaca,
  atualizarChaveNfeFornecedorCompra,
  carregarCompraAutorizada,
  carregarCompraAutorizadaP,
  jsonErroCompraOpaca,
  erroCompraEmpresa,
  statusDeErroCompraEmpresa,
  carregarDocumentoCentral
};
