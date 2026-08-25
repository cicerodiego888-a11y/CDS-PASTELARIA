/**
 * Contexto operacional do PDV Universal (Sprint 05.02).
 * Seleção de empresa via mecanismo oficial (X-Empresa-Id / EmpresaService).
 * Não grava em venda, estoque, atendimento, caixa ou fiscal.
 */
'use strict';

const { resolverModoOperacaoVendaAtivo } = require('../../motores/muv/modoOperacaoVenda');
const { ModoOperacaoVenda } = require('../../motores/muv/contratos');
const { resolverModoOperacionalGlobalAtivo } = require('../../core/modo-operacional/modoOperacionalGlobal');
const { ModoOperacionalGlobal, capacidadesParaModoGlobal, validarModoOperacionalGlobal } = require('../../core/modo-operacional/contratos');
const PoliticaEmpresaSimples = require('../../core/modo-operacional/PoliticaEmpresaSimples');
const {
  CAMADA,
  capacidadesParaModo,
  dtoContemSegredo,
  CICLO_MULTIEMPRESA
} = require('../../motores/pdv-universal/contratos');
const {
  resolverOperadorId,
  resolverTerminalId,
  resolverEmpresaIdOpcional,
  listarEmpresasDisponiveisSeguro
} = require('../../motores/pdv-universal/contexto/resolverContextoOperacional');
const EmpresaUnicaAdapter = require('../../motores/pdv-universal/adaptadores/EmpresaUnicaAdapter');
const MultiempresaAdapter = require('../../motores/pdv-universal/adaptadores/MultiempresaAdapter');

function erroContexto(code, message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function nomeEmpresa(empresa) {
  if (!empresa) return null;
  const fantasia = empresa.nome_fantasia || empresa.nomeFantasia || empresa.nome;
  const razao = empresa.razao_social || empresa.razaoSocial;
  return String(fantasia || razao || '').trim() || null;
}

function mapearEmpresaOperacional(empresa) {
  if (!empresa) return null;
  const id = Number(empresa.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const ativa = empresa.ativa != null
    ? empresa.ativa === true || Number(empresa.ativa) === 1
    : Number(empresa.ativo) === 1;
  return {
    id,
    nome: nomeEmpresa(empresa),
    razao_social: empresa.razao_social || empresa.razaoSocial || null,
    nome_fantasia: empresa.nome_fantasia || empresa.nomeFantasia || null,
    cnpj: empresa.cnpj || null,
    ativa
  };
}

function filtrarOperacionais(lista) {
  return (lista || [])
    .map(mapearEmpresaOperacional)
    .filter((e) => e && e.ativa);
}

function resolverOperador(entrada = {}) {
  const user = entrada.user || entrada.usuario || (entrada.req && entrada.req.user) || {};
  const id = resolverOperadorId(entrada);
  const nome = user.nome || user.username || user.usuario || user.login || null;
  if (!id && !nome) return null;
  return { id, nome };
}

function localizarDisponivel(empresas, empresaId) {
  if (empresaId == null) return null;
  return empresas.find((e) => e.id === empresaId) || null;
}

/**
 * EMPRESA_UNICA: exatamente uma disponível → resolve automaticamente.
 * Nunca usa empresa 1, primeira da lista com N>1, ou CNPJ.
 */
function resolverEmpresaSelecionada(modo, empresas, empresaIdInformado) {
  if (empresaIdInformado != null) {
    const encontrada = localizarDisponivel(empresas, empresaIdInformado);
    if (!encontrada) {
      throw erroContexto(
        'EMPRESA_OPERACIONAL_INVALIDA',
        'A empresa do contexto não está operacional ou não está disponível para o operador.',
        400,
        { empresa_id: empresaIdInformado, empresa_selecionada: null }
      );
    }
    return { empresa: encontrada, origem: 'EXPLICITA' };
  }

  if (modo === ModoOperacaoVenda.EMPRESA_UNICA && empresas.length === 1) {
    return { empresa: empresas[0], origem: 'UNICA_DISPONIVEL' };
  }

  return { empresa: null, origem: empresaIdInformado == null ? 'AUSENTE' : 'AUSENTE' };
}

function montarDto({ modo, modoGlobal, operador, empresa, empresas, terminalId, origemSelecao, contratoOperacional }) {
  const capacidades = capacidadesParaModo(modo);
  const capacidadesGlobais = modoGlobal
    ? capacidadesParaModoGlobal(modoGlobal)
    : null;
  const exigeSelecao = modoGlobal === ModoOperacionalGlobal.EMPRESA_SIMPLES
    ? false
    : (modo === ModoOperacaoVenda.EMPRESA_UNICA && !empresa);
  const dto = {
    camada: CAMADA,
    modo_operacional_global: modoGlobal,
    modo_operacao: modo,
    operador,
    empresa_selecionada: empresa,
    empresas_disponiveis: modoGlobal === ModoOperacionalGlobal.EMPRESA_SIMPLES ? [] : empresas,
    contrato_operacional: contratoOperacional || (modoGlobal ? {
      modo_operacional: modoGlobal,
      modo_operacao_venda: modo,
      empresa_operacional: empresa
        ? { empresa_id: empresa.id, cnpj: empresa.cnpj, razao_social: empresa.razao_social || empresa.nome }
        : null,
      capacidades: capacidadesGlobais
    } : null),
    contexto: {
      operador_id: operador && operador.id != null ? operador.id : null,
      terminal_id: terminalId,
      empresa_id: empresa ? empresa.id : null,
      empresas_disponiveis: empresas,
      origem_selecao: origemSelecao,
      empresa_selecionada_nao_substitui_item: true
    },
    capacidades,
    exige_selecao: exigeSelecao,
    pronto_para_checkout: modo === ModoOperacaoVenda.MULTIEMPRESA || !!empresa,
    persistencia: {
      mecanismo: 'X-Empresa-Id',
      jwt: false,
      dominio: false
    },
    integracao: modo === ModoOperacaoVenda.MULTIEMPRESA
      ? { porta: MultiempresaAdapter.PORTA, ciclo: CICLO_MULTIEMPRESA }
      : { porta: EmpresaUnicaAdapter.PORTA, cria_atendimento: false }
  };

  if (dtoContemSegredo(dto)) {
    throw erroContexto(
      'CONTEXTO_OPERACIONAL_INVALIDO',
      'Contexto do PDV Universal não pode expor segredos fiscais.',
      500
    );
  }
  return Object.freeze(dto);
}

function resolverModoGlobalContexto(deps = {}) {
  if (typeof deps.obterModoOperacionalGlobal === 'function') {
    return validarModoOperacionalGlobal(deps.obterModoOperacionalGlobal());
  }
  if (typeof deps.obterModoOperacaoVenda === 'function') {
    const venda = deps.obterModoOperacaoVenda();
    if (venda === ModoOperacaoVenda.MULTIEMPRESA) {
      return ModoOperacionalGlobal.MULTIEMPRESA;
    }
    return null;
  }
  return resolverModoOperacionalGlobalAtivo(deps);
}

async function obterContextoOperacional(entrada = {}, deps = {}) {
  const modoGlobal = resolverModoGlobalContexto(deps);
  const modo = resolverModoOperacaoVendaAtivo(deps);
  const operador = resolverOperador(entrada);
  const brutas = await listarEmpresasDisponiveisSeguro(entrada, deps);
  const empresas = filtrarOperacionais(brutas);

  if (modoGlobal === ModoOperacionalGlobal.EMPRESA_SIMPLES && operador && operador.id) {
    const resolvida = await PoliticaEmpresaSimples.resolverEmpresaOperacional(deps);
    const empresa = mapearEmpresaOperacional({
      id: resolvida.empresa.empresa_id,
      cnpj: resolvida.empresa.cnpj,
      razao_social: resolvida.empresa.razao_social,
      nome_fantasia: resolvida.empresa.nome_fantasia,
      ativo: 1
    });
    const contratoOperacional = {
      modo_operacional: modoGlobal,
      modo_operacao_venda: modo,
      empresa_operacional: resolvida.empresa,
      capacidades: capacidadesParaModoGlobal(modoGlobal)
    };
    return montarDto({
      modo,
      modoGlobal,
      operador,
      empresa,
      empresas: [],
      terminalId: resolverTerminalId(entrada),
      origemSelecao: resolvida.origem,
      contratoOperacional
    });
  }

  if (modo === ModoOperacaoVenda.EMPRESA_UNICA && operador && operador.id && empresas.length === 0) {
    throw erroContexto(
      'NENHUMA_EMPRESA_DISPONIVEL',
      'Nenhuma empresa operacional está disponível para o operador.',
      409
    );
  }

  const informado = resolverEmpresaIdOpcional(entrada);
  const { empresa, origem } = resolverEmpresaSelecionada(modo, empresas, informado);
  return montarDto({
    modo,
    modoGlobal,
    operador,
    empresa,
    empresas,
    terminalId: resolverTerminalId(entrada),
    origemSelecao: origem
  });
}

function exigirEmpresaIdSelecao(fonte) {
  const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');
  const id = resolverEmpresaId(fonte);
  if (id == null) {
    throw erroContexto('EMPRESA_ID_OBRIGATORIO', 'empresa_id é obrigatório para selecionar o contexto.', 400);
  }
  return id;
}

async function selecionarEmpresaOperacional(fonte, entrada = {}, deps = {}) {
  const empresaId = exigirEmpresaIdSelecao(fonte);
  if (fonte && typeof fonte === 'object') {
    const a = fonte.empresa_id != null ? Number(fonte.empresa_id) : null;
    const b = fonte.empresaId != null ? Number(fonte.empresaId) : null;
    if (a != null && b != null && a !== b) {
      throw erroContexto(
        'CONTEXTO_OPERACIONAL_INVALIDO',
        'empresa_id e empresaId divergentes no pedido de seleção.',
        409
      );
    }
  }

  const EmpresaService = deps.EmpresaService || require('../empresas/EmpresaService');
  let cadastrada = null;
  try {
    cadastrada = await EmpresaService.buscarEmpresaPorId(empresaId, { db: deps.db });
  } catch (err) {
    if (err && err.code === 'EMPRESA_NAO_ENCONTRADA') {
      throw erroContexto('EMPRESA_NAO_ENCONTRADA', err.message, 404, { empresa_id: empresaId });
    }
    throw err;
  }

  if (!cadastrada || Number(cadastrada.ativo) !== 1) {
    throw erroContexto(
      'EMPRESA_INATIVA',
      `Empresa inativa não pode ser selecionada: ${empresaId}.`,
      400,
      { empresa_id: empresaId }
    );
  }

  const selecionada = await EmpresaService.selecionarEmpresaContexto(
    { empresaId },
    {
      db: deps.db,
      user: entrada.user || entrada.usuario || (entrada.req && entrada.req.user)
    }
  );

  return obterContextoOperacional({
    ...entrada,
    empresaId: selecionada.id
  }, deps);
}

/**
 * A empresa do contexto nunca preenche empresaId de item MUV.
 */
function empresaContextoNaoSubstituiItem() {
  return true;
}

module.exports = {
  obterContextoOperacional,
  selecionarEmpresaOperacional,
  resolverEmpresaSelecionada,
  resolverModoGlobalContexto,
  mapearEmpresaOperacional,
  filtrarOperacionais,
  empresaContextoNaoSubstituiItem,
  erroContexto
};
