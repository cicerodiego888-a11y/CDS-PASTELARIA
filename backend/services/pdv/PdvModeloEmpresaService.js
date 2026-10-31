/**
 * CDS-PDV-EMPRESA-UNICA-02 — modelo de empresa exclusivo do PDV.
 * Independente de modo_operacional_global / empresa_operacional_id.
 *
 * @module services/pdv/PdvModeloEmpresaService
 */
'use strict';

const { VendaOrigin, resolverVendaOrigin } = require('../vendas/VendaOrigin');

const PDV_MODELO_MULTIPLAS = 'MULTIPLAS';
const PDV_MODELO_UNICA = 'UNICA';
const PDV_MODELOS = Object.freeze([PDV_MODELO_MULTIPLAS, PDV_MODELO_UNICA]);
const DEFAULT_PDV_MODELO_EMPRESA = PDV_MODELO_MULTIPLAS;

function erroPdvModelo(code, message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function normalizarPdvModeloEmpresa(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') {
    return DEFAULT_PDV_MODELO_EMPRESA;
  }
  const normalizado = String(valor).toUpperCase().trim();
  if (!PDV_MODELOS.includes(normalizado)) {
    throw erroPdvModelo(
      'PDV_MODELO_EMPRESA_INVALIDO',
      'pdv_modelo_empresa inválido. Use MULTIPLAS ou UNICA.'
    );
  }
  return normalizado;
}

function normalizarPdvEmpresaId(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function lerConfigPdvModelo(deps = {}) {
  if (deps.cfg && typeof deps.cfg === 'object') {
    return {
      pdv_modelo_empresa: normalizarPdvModeloEmpresa(deps.cfg.pdv_modelo_empresa),
      pdv_empresa_id: normalizarPdvEmpresaId(deps.cfg.pdv_empresa_id)
    };
  }
  if (typeof deps.obterPdvModeloEmpresa === 'function') {
    return deps.obterPdvModeloEmpresa();
  }
  const configService = deps.configService || require('../configuracaoService');
  const cfg = configService.readConfig();
  return {
    pdv_modelo_empresa: normalizarPdvModeloEmpresa(cfg.pdv_modelo_empresa),
    pdv_empresa_id: normalizarPdvEmpresaId(cfg.pdv_empresa_id)
  };
}

async function validarEmpresaPdvAtiva(empresaId, deps = {}) {
  const id = normalizarPdvEmpresaId(empresaId);
  if (id == null) {
    throw erroPdvModelo(
      'PDV_EMPRESA_ID_AUSENTE',
      'Modo PDV Empresa única exige pdv_empresa_id de uma empresa ativa.',
      409
    );
  }
  if (typeof deps.validarEmpresaPdv === 'function') {
    return deps.validarEmpresaPdv(id);
  }
  const { validarEmpresaId } = deps.empresaContexto
    || require('../fiscalNaoFiscal/empresaContexto');
  const db = deps.db || null;
  try {
    const validado = await validarEmpresaId(id, { db, ...deps });
    return { empresa_id: validado };
  } catch (err) {
    throw erroPdvModelo(
      err.code || 'PDV_EMPRESA_INVALIDA',
      err.message || `Empresa PDV inválida ou inativa: ${id}.`,
      err.statusCode || err.status || 409,
      { empresa_id: id }
    );
  }
}

/**
 * Origens que concluem venda e não podem ser declaradas pelo cliente em POST /api/vendas
 * (CDS-PDV-EMPRESA-UNICA-06). Usam rotas oficiais com override de origem no servidor.
 */
const ORIGENS_PROIBIDAS_CANAL_HTTP_VENDAS = Object.freeze([
  VendaOrigin.FATURAMENTO,
  VendaOrigin.NF_AVULSA
]);

/**
 * Aplica empresa fixa do PDV quando o canal efetivo é PDV e modelo=UNICA.
 * CDS-PDV-EMPRESA-UNICA-06: em canalHttpVendas (POST /api/vendas) a política
 * não confia em body.origem para decidir se UNICA se aplica; FATURAMENTO/NF_AVULSA
 * no body são rejeitados (rotas oficiais preservadas).
 * Idempotente se já aplicado nesta requisição.
 * @returns {Promise<{aplicada:boolean, motivo?:string, empresa_id?:number}>}
 */
async function aplicarModeloEmpresaPdvNaRequisicao(req, deps = {}) {
  if (req && req.pdvModeloEmpresa && req.pdvModeloEmpresa.aplicada === true) {
    return req.pdvModeloEmpresa;
  }

  const canalHttpVendas = deps.canalHttpVendas === true
    || (req && req.canalVendaHttp === 'PDV');

  if (canalHttpVendas && req) {
    req.canalVendaHttp = 'PDV';
  }

  const origemRaw = (req && req.body && req.body.origem != null)
    ? req.body.origem
    : (req && req.vendaContext && req.vendaContext.origem);
  const origemDeclarada = resolverVendaOrigin(origemRaw);

  if (canalHttpVendas && ORIGENS_PROIBIDAS_CANAL_HTTP_VENDAS.includes(origemDeclarada)) {
    throw erroPdvModelo(
      'ORIGEM_NAO_PERMITIDA_NA_ROTA_VENDAS',
      'POST /api/vendas é o canal oficial do PDV. Use as rotas de faturamento ou NF avulsa para essas origens.',
      400,
      { origem_declarada: origemDeclarada }
    );
  }

  // Canal HTTP de vendas = política PDV efetiva (não confiar só no body).
  const origem = canalHttpVendas ? VendaOrigin.PDV : origemDeclarada;
  if (origem !== VendaOrigin.PDV) {
    const out = { aplicada: false, motivo: 'ORIGEM_NAO_PDV' };
    if (req) req.pdvModeloEmpresa = out;
    return out;
  }

  const cfg = lerConfigPdvModelo(deps);
  if (cfg.pdv_modelo_empresa !== PDV_MODELO_UNICA) {
    const out = {
      aplicada: false,
      motivo: 'PDV_MULTIPLAS',
      pdv_modelo_empresa: cfg.pdv_modelo_empresa
    };
    if (req) req.pdvModeloEmpresa = out;
    return out;
  }

  const validada = await validarEmpresaPdvAtiva(cfg.pdv_empresa_id, deps);
  const empresaId = validada.empresa_id;

  const { aplicarEmpresaNoRequest } = require('../vendas/SelecaoEmpresaVendaPdvService');
  aplicarEmpresaNoRequest(req, empresaId);
  // Trava a empresa do PDV: não deixar Financeiro/EMPRESA_SIMPLES sobrescrever.
  req.__financeiroEmpresaOk = true;
  req.empresaId = empresaId;

  const out = {
    aplicada: true,
    motivo: 'PDV_EMPRESA_UNICA',
    pdv_modelo_empresa: PDV_MODELO_UNICA,
    empresa_id: empresaId,
    origem: 'CONFIG_PDV_EMPRESA_UNICA'
  };
  req.pdvModeloEmpresa = out;
  return out;
}

function middlewareAplicarPdvModeloEmpresa(deps = {}) {
  return async function anexarPdvModeloEmpresa(req, res, next) {
    try {
      const db = deps.db != null
        ? deps.db
        : (req && req.db != null ? req.db : undefined);
      await aplicarModeloEmpresaPdvNaRequisicao(req, {
        ...deps,
        canalHttpVendas: deps.canalHttpVendas === true,
        db: db !== undefined ? db : require('../../database')
      });
      return next();
    } catch (err) {
      const status = err.statusCode || err.status || 400;
      return res.status(status).json({
        success: false,
        error: err.message || 'Falha ao aplicar modelo de empresa do PDV.',
        code: err.code || 'PDV_MODELO_EMPRESA_ERRO',
        empresa_id: err.empresa_id != null ? err.empresa_id : undefined,
        origem_declarada: err.origem_declarada != null ? err.origem_declarada : undefined,
        venda_concluida: false
      });
    }
  };
}

function obterPdvModeloEmpresaPublico(deps = {}) {
  const cfg = lerConfigPdvModelo(deps);
  return {
    pdv_modelo_empresa: cfg.pdv_modelo_empresa,
    pdv_empresa_id: cfg.pdv_modelo_empresa === PDV_MODELO_UNICA
      ? cfg.pdv_empresa_id
      : null
  };
}

/**
 * CDS-PDV-EMPRESA-UNICA-04 — validação antes de persistir configuração.
 * MULTIPLAS: não exige empresa. UNICA: exige id + empresa ativa.
 * Não grava nada; o chamador só persiste após sucesso.
 */
async function validarPdvModeloEmpresaAntesDeSalvar(obj = {}, deps = {}) {
  const configService = deps.configService || require('../configuracaoService');
  const current = typeof deps.current === 'object' && deps.current
    ? deps.current
    : configService.readConfig();

  const temModelo = Object.prototype.hasOwnProperty.call(obj || {}, 'pdv_modelo_empresa');
  const temEmpresa = Object.prototype.hasOwnProperty.call(obj || {}, 'pdv_empresa_id');

  const modelo = temModelo
    ? normalizarPdvModeloEmpresa(obj.pdv_modelo_empresa)
    : normalizarPdvModeloEmpresa(current.pdv_modelo_empresa);

  if (modelo !== PDV_MODELO_UNICA) {
    return {
      ok: true,
      pdv_modelo_empresa: modelo,
      pdv_empresa_id: null
    };
  }

  const empresaId = temEmpresa
    ? normalizarPdvEmpresaId(obj.pdv_empresa_id)
    : normalizarPdvEmpresaId(current.pdv_empresa_id);

  if (empresaId == null) {
    throw erroPdvModelo(
      'PDV_EMPRESA_ID_AUSENTE',
      'pdv_empresa_id é obrigatório e deve referenciar uma empresa ativa quando pdv_modelo_empresa = UNICA.',
      400
    );
  }

  const validada = await validarEmpresaPdvAtiva(empresaId, deps);
  return {
    ok: true,
    pdv_modelo_empresa: PDV_MODELO_UNICA,
    pdv_empresa_id: validada.empresa_id
  };
}

module.exports = {
  PDV_MODELO_MULTIPLAS,
  PDV_MODELO_UNICA,
  PDV_MODELOS,
  DEFAULT_PDV_MODELO_EMPRESA,
  ORIGENS_PROIBIDAS_CANAL_HTTP_VENDAS,
  normalizarPdvModeloEmpresa,
  normalizarPdvEmpresaId,
  lerConfigPdvModelo,
  validarEmpresaPdvAtiva,
  validarPdvModeloEmpresaAntesDeSalvar,
  aplicarModeloEmpresaPdvNaRequisicao,
  middlewareAplicarPdvModeloEmpresa,
  obterPdvModeloEmpresaPublico,
  erroPdvModelo
};
