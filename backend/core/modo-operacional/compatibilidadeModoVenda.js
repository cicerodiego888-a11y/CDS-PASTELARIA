/**
 * Camada de compatibilidade entre modo operacional global e modo_operacao_venda legado.
 * EMPRESA_SIMPLES → EMPRESA_UNICA | MULTIEMPRESA → MULTIEMPRESA
 *
 * @module core/modo-operacional/compatibilidadeModoVenda
 */
'use strict';

const { ModoOperacaoVenda } = require('../../motores/muv/contratos');
const {
  ModoOperacionalGlobal,
  validarModoOperacionalGlobal
} = require('./contratos');

function modoGlobalParaModoVenda(modoGlobal) {
  const m = validarModoOperacionalGlobal(modoGlobal);
  if (m === ModoOperacionalGlobal.MULTIEMPRESA) {
    return ModoOperacaoVenda.MULTIEMPRESA;
  }
  return ModoOperacaoVenda.EMPRESA_UNICA;
}

function modoVendaParaModoGlobal(modoVenda) {
  const normalizado = String(modoVenda || '').toUpperCase().trim();
  if (normalizado === ModoOperacaoVenda.MULTIEMPRESA) {
    return ModoOperacionalGlobal.MULTIEMPRESA;
  }
  return ModoOperacionalGlobal.EMPRESA_SIMPLES;
}

function sincronizarModoOperacaoVendaLegado(modoGlobal) {
  return modoGlobalParaModoVenda(modoGlobal);
}

module.exports = {
  modoGlobalParaModoVenda,
  modoVendaParaModoGlobal,
  sincronizarModoOperacaoVendaLegado
};
