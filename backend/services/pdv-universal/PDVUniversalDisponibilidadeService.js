/**
 * Disponibilidade operacional do PDV Universal (Sprint 05.04).
 * Reusa reservasPublico.consultarDisponibilidade. Sem reserva, venda ou atendimento.
 */
'use strict';

const reservasPublico = require('../fiscalNaoFiscal/reservasPublico');
const {
  listarEmpresasDisponiveisSeguro
} = require('../../motores/pdv-universal/contexto/resolverContextoOperacional');
const { filtrarOperacionais } = require('./PDVUniversalContextService');

function erroDisp(code, message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function totalDisponivel(disp) {
  if (!disp) return 0;
  const t = Number(disp.disponivel_total);
  if (Number.isFinite(t)) return t;
  return Number(disp.disponivel_fiscal || 0) + Number(disp.disponivel_nao_fiscal || 0);
}

function resolverIdentificacao(empresasComSaldo) {
  if (!empresasComSaldo.length) {
    return { automatica: false, exige_escolha: false, empresa_id: null };
  }
  if (empresasComSaldo.length === 1) {
    return {
      automatica: true,
      exige_escolha: false,
      empresa_id: empresasComSaldo[0].empresa_id,
      origem: 'UNICA_COM_DISPONIBILIDADE'
    };
  }
  return { automatica: false, exige_escolha: true, empresa_id: null };
}

async function consultarDisponibilidadeProduto(produtoId, entrada = {}, deps = {}) {
  const id = Number(produtoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroDisp('PRODUTO_INVALIDO', 'produtoId inválido.', 400);
  }

  const brutas = await listarEmpresasDisponiveisSeguro(entrada, deps);
  const empresas = filtrarOperacionais(brutas);
  const consultar = typeof deps.consultarDisponibilidade === 'function'
    ? deps.consultarDisponibilidade
    : (pid, opts) => reservasPublico.consultarDisponibilidade(pid, opts);

  const linhas = [];
  for (const emp of empresas) {
    const disp = await consultar(id, { db: deps.db, empresaId: emp.id });
    linhas.push({
      empresa_id: emp.id,
      nome: emp.nome,
      disponibilidade: {
        fiscal: Number(disp && disp.disponivel_fiscal) || 0,
        nao_fiscal: Number(disp && disp.disponivel_nao_fiscal) || 0,
        total: totalDisponivel(disp)
      }
    });
  }

  const empresasDisponiveis = linhas.filter((l) => l.disponibilidade.total > 0);
  return Object.freeze({
    produto_id: id,
    empresas_disponiveis: empresasDisponiveis,
    identificacao: resolverIdentificacao(empresasDisponiveis)
  });
}

module.exports = {
  consultarDisponibilidadeProduto,
  resolverIdentificacao,
  totalDisponivel,
  erroDisp
};
