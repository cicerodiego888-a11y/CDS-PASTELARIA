/**
 * Resolução de empresa operacional para o módulo Financeiro (Sprint 05.38.D).
 * Fonte oficial: ContratoOperacionalService + empresaContexto (sem resolver paralelo).
 * Não duplica regras financeiras — apenas resolve/valida empresa e delega.
 *
 * @module services/financeiro/FinanceiroEmpresaContextoService
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

function erroFinanceiroEmpresa(code, message, statusCode = 400, extra = {}) {
  const err = erroModoGlobal(code, message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

const CODIGO_EMPRESA_OWNERSHIP_REQUIRED = 'EMPRESA_OWNERSHIP_REQUIRED';
const CODIGO_FINANCEIRO_EMPRESA_DIVERGENTE = 'FINANCEIRO_EMPRESA_DIVERGENTE';
const CODIGO_FINANCEIRO_NAO_ENCONTRADO = 'FINANCEIRO_NAO_ENCONTRADO';

function statusDeErroEmpresa(err) {
  if (!err) return 500;
  if (err.statusCode) return err.statusCode;
  if (err.status) return err.status;
  const code = err.code || '';
  if (
    code === 'EMPRESA_NAO_ENCONTRADA'
    || code === CODIGO_FINANCEIRO_NAO_ENCONTRADO
  ) {
    return 404;
  }
  if (code === 'EMPRESA_NAO_AUTORIZADA' || code === CODIGO_FINANCEIRO_EMPRESA_DIVERGENTE) return 403;
  if (
    code === 'EMPRESA_INATIVA'
    || code === 'EMPRESA_OBRIGATORIA'
    || code === 'EMPRESA_ID_OBRIGATORIO'
    || code === 'EMPRESA_OPERACIONAL_AUSENTE'
    || code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    || code === 'EMPRESA_OPERACIONAL_INVALIDA'
    || code === 'FINANCEIRO_EMPRESA_OBRIGATORIA'
    || code === 'FINANCEIRO_REGISTRO_SEM_EMPRESA'
    || code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  ) {
    return 400;
  }
  return 500;
}

function idEmpresaValido(valor) {
  const id = Number(valor);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Invariante 05.41: lançamento financeiro empresarial novo exige empresa_id.
 * Reutiliza exigirEmpresaDaOperacao (05.40) e traduz o erro para o domínio financeiro.
 */
function exigirEmpresaIdFinanceiro(reqOrId) {
  const { exigirEmpresaDaOperacao } = require('../vendas/VendaEmpresaContextoService');
  try {
    return exigirEmpresaDaOperacao(reqOrId);
  } catch (_err) {
    throw erroFinanceiroEmpresa(
      CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
      'Empresa é obrigatória para materializar lançamento financeiro empresarial.',
      400
    );
  }
}

/**
 * Resolve empresa_id somente a partir de fontes persistidas/confiáveis.
 * Ordem real de ownership: origem explícita → venda → operação/MUV → caixa → compra.
 * Não usa empresa 1, última empresa, config global ou query.
 * Fontes conhecidas divergentes bloqueiam (FINANCEIRO_EMPRESA_DIVERGENTE).
 */
function resolverEmpresaDaOrigemFinanceira(fontes = {}) {
  const origemExplicita = idEmpresaValido(
    fontes.origemExplicita != null ? fontes.origemExplicita : fontes.empresaId
  );
  const vendaId = fontes.venda
    ? idEmpresaValido(fontes.venda.empresa_id != null ? fontes.venda.empresa_id : fontes.venda.empresaId)
    : null;
  const operacaoId = fontes.operacao
    ? idEmpresaValido(
      fontes.operacao.empresaId != null ? fontes.operacao.empresaId : fontes.operacao.empresa_id
    )
    : null;
  const caixaId = fontes.caixa
    ? idEmpresaValido(fontes.caixa.empresa_id != null ? fontes.caixa.empresa_id : fontes.caixa.empresaId)
    : null;
  const compraId = fontes.compra
    ? idEmpresaValido(fontes.compra.empresa_id != null ? fontes.compra.empresa_id : fontes.compra.empresaId)
    : null;

  const escolhido = origemExplicita || vendaId || operacaoId || caixaId || compraId;
  if (escolhido == null) {
    throw erroFinanceiroEmpresa(
      CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
      'Empresa é obrigatória para materializar lançamento financeiro empresarial.',
      400
    );
  }

  const conhecidos = [origemExplicita, vendaId, operacaoId, caixaId, compraId]
    .filter((id) => id != null);
  for (const id of conhecidos) {
    if (id !== escolhido) {
      throw erroFinanceiroEmpresa(
        CODIGO_FINANCEIRO_EMPRESA_DIVERGENTE,
        'empresa_id do lançamento financeiro diverge da origem (venda/caixa/operação).',
        409,
        {
          empresa_id: escolhido,
          venda_empresa_id: vendaId,
          caixa_empresa_id: caixaId,
          operacao_empresa_id: operacaoId
        }
      );
    }
  }

  return escolhido;
}

/**
 * Consulta operacional: lançamento de outra empresa ou legado NULL = NOT_FOUND.
 * Não revela existência, saldo, descrição ou valores cruzados.
 */
function exigirLancamentoDaEmpresa(registro, empresaId) {
  const idEmpresa = Number(empresaId);
  if (!registro) {
    throw erroFinanceiroEmpresa(
      CODIGO_FINANCEIRO_NAO_ENCONTRADO,
      'Movimentação não encontrada.',
      404,
      { empresa_id: idEmpresa }
    );
  }
  const sid = idEmpresaValido(registro.empresa_id);
  if (sid == null || sid !== idEmpresa) {
    throw erroFinanceiroEmpresa(
      CODIGO_FINANCEIRO_NAO_ENCONTRADO,
      'Movimentação não encontrada.',
      404,
      { empresa_id: idEmpresa }
    );
  }
  return registro;
}

/**
 * Resolve empresa_id para operações financeiras.
 *
 * Prioridade:
 * 1. empresa_id explícito da origem de domínio (venda/compra/caixa)
 * 2. EMPRESA_SIMPLES → ContratoOperacional
 * 3. MULTIEMPRESA → X-Empresa-Id / req.empresaId
 */
async function resolverEmpresaIdParaFinanceiro(req, deps = {}) {
  const origemExplicita = resolverEmpresaId(deps.empresaIdOrigem)
    ?? resolverEmpresaId(deps.origem);

  if (origemExplicita != null) {
    const db = deps.db || (req && req.db) || null;
    const empresaId = await validarEmpresaId(origemExplicita, { db, ...deps });
    return {
      empresaId,
      modo: deps.modo || null,
      origem: 'ORIGEM_DOMINIO',
      contrato: null
    };
  }

  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroFinanceiroEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida para o Financeiro.',
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

  const informado = resolverEmpresaId(req && req.empresaId)
    ?? resolverEmpresaIdDaRequisicao(req);

  if (informado == null) {
    throw erroFinanceiroEmpresa(
      'FINANCEIRO_EMPRESA_OBRIGATORIA',
      'Modo MULTIEMPRESA exige contexto empresarial válido para o Financeiro. Informe X-Empresa-Id.',
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

function exigirRegistroDaEmpresa(registro, empresaId, opts = {}) {
  const rotulo = opts.rotulo || 'Registro financeiro';
  if (!registro) {
    throw erroFinanceiroEmpresa(
      'FINANCEIRO_REGISTRO_AUSENTE',
      `${rotulo} não encontrado para a empresa atual.`,
      404,
      { empresa_id: empresaId }
    );
  }
  const sid = registro.empresa_id != null ? Number(registro.empresa_id) : null;
  if (sid == null || !Number.isInteger(sid) || sid <= 0) {
    throw erroFinanceiroEmpresa(
      'FINANCEIRO_REGISTRO_SEM_EMPRESA',
      `${rotulo} sem empresa_id. Execute a migration 05.38.D.`,
      409,
      { id: registro.id }
    );
  }
  if (sid !== Number(empresaId)) {
    throw erroFinanceiroEmpresa(
      'FINANCEIRO_EMPRESA_DIVERGENTE',
      `${rotulo} não pertence à empresa do contexto atual.`,
      403,
      {
        id: registro.id,
        empresa_id: empresaId,
        registro_empresa_id: sid
      }
    );
  }
  return registro;
}

async function obterMetaEmpresaPorId(empresaId, deps = {}) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) {
    return { empresa_nome: 'CDS Sistemas', empresa_cnpj: '', empresa_id: null };
  }
  if (typeof deps.buscarEmpresaPorId === 'function') {
    const emp = await deps.buscarEmpresaPorId(id);
    return {
      empresa_id: id,
      empresa_nome: (emp && (emp.nome_fantasia || emp.razao_social)) || 'CDS Sistemas',
      empresa_cnpj: (emp && emp.cnpj) || ''
    };
  }
  const EmpresaService = deps.EmpresaService || require('../empresas/EmpresaService');
  try {
    const emp = await EmpresaService.buscarEmpresaPorId(id, { db: deps.db });
    return {
      empresa_id: id,
      empresa_nome: emp.nome_fantasia || emp.razao_social || 'CDS Sistemas',
      empresa_cnpj: emp.cnpj || ''
    };
  } catch (err) {
    if (err && err.code === 'EMPRESA_NAO_ENCONTRADA') {
      return { empresa_id: id, empresa_nome: 'CDS Sistemas', empresa_cnpj: '' };
    }
    throw err;
  }
}

function middlewareResolverEmpresaFinanceiro(deps = {}) {
  return async function anexarEmpresaFinanceiro(req, res, next) {
    try {
      const resolved = await resolverEmpresaIdParaFinanceiro(req, {
        ...deps,
        db: deps.db || req.db || require('../../database')
      });
      req.empresaId = resolved.empresaId;
      req.financeiroEmpresaContexto = resolved;
      return next();
    } catch (err) {
      const status = statusDeErroEmpresa(err);
      return res.status(status).json({
        error: err.message || 'Erro ao resolver empresa do Financeiro.',
        code: err.code || 'FINANCEIRO_EMPRESA_ERRO',
        empresa_id: err.empresa_id != null ? err.empresa_id : undefined
      });
    }
  };
}

module.exports = {
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
  CODIGO_FINANCEIRO_EMPRESA_DIVERGENTE,
  CODIGO_FINANCEIRO_NAO_ENCONTRADO,
  resolverEmpresaIdParaFinanceiro,
  resolverEmpresaDaOrigemFinanceira,
  exigirEmpresaIdFinanceiro,
  exigirLancamentoDaEmpresa,
  exigirRegistroDaEmpresa,
  obterMetaEmpresaPorId,
  middlewareResolverEmpresaFinanceiro,
  statusDeErroEmpresa,
  erroFinanceiroEmpresa
};
