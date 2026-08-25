/**
 * Contratos oficiais do Modo Operacional Global (Sprint 05.38.B).
 * Valores: EMPRESA_SIMPLES | MULTIEMPRESA
 *
 * @module core/modo-operacional/contratos
 */
'use strict';

const ModoOperacionalGlobal = Object.freeze({
  EMPRESA_SIMPLES: 'EMPRESA_SIMPLES',
  MULTIEMPRESA: 'MULTIEMPRESA'
});

const MODOS_OPERACIONAL_GLOBAL = Object.freeze([
  ModoOperacionalGlobal.EMPRESA_SIMPLES,
  ModoOperacionalGlobal.MULTIEMPRESA
]);

const DEFAULT_MODO_OPERACIONAL_GLOBAL = ModoOperacionalGlobal.EMPRESA_SIMPLES;

const CODIGO_MODO_OPERACIONAL_GLOBAL_INVALIDO = 'MODO_OPERACIONAL_GLOBAL_INVALIDO';

function erroModoGlobal(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validarModoOperacionalGlobal(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') {
    throw erroModoGlobal(
      CODIGO_MODO_OPERACIONAL_GLOBAL_INVALIDO,
      'modo_operacional_global nulo não é valor explícito válido. Use EMPRESA_SIMPLES ou MULTIEMPRESA.'
    );
  }
  const normalizado = String(valor).toUpperCase().trim();
  if (normalizado === 'EMPRESA_UNICA') {
    return ModoOperacionalGlobal.EMPRESA_SIMPLES;
  }
  if (!MODOS_OPERACIONAL_GLOBAL.includes(normalizado)) {
    throw erroModoGlobal(
      CODIGO_MODO_OPERACIONAL_GLOBAL_INVALIDO,
      `modo_operacional_global inválido: ${String(valor)}. Use EMPRESA_SIMPLES ou MULTIEMPRESA.`
    );
  }
  return normalizado;
}

const CAPACIDADES_EMPRESA_SIMPLES = Object.freeze({
  multiempresa: false,
  selecao_empresa: false,
  muv: false,
  consolidacao: false
});

const CAPACIDADES_MULTIEMPRESA = Object.freeze({
  multiempresa: true,
  selecao_empresa: true,
  muv: true,
  consolidacao: true
});

function capacidadesParaModoGlobal(modo) {
  const m = validarModoOperacionalGlobal(modo);
  if (m === ModoOperacionalGlobal.MULTIEMPRESA) {
    return { ...CAPACIDADES_MULTIEMPRESA };
  }
  return { ...CAPACIDADES_EMPRESA_SIMPLES };
}

module.exports = {
  ModoOperacionalGlobal,
  MODOS_OPERACIONAL_GLOBAL,
  DEFAULT_MODO_OPERACIONAL_GLOBAL,
  CODIGO_MODO_OPERACIONAL_GLOBAL_INVALIDO,
  CAPACIDADES_EMPRESA_SIMPLES,
  CAPACIDADES_MULTIEMPRESA,
  validarModoOperacionalGlobal,
  capacidadesParaModoGlobal,
  erroModoGlobal
};
