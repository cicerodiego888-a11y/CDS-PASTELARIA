/**
 * validarChaveNfe — Validação de chave de acesso NF-e (44 dígitos + DV).
 *
 * validarChaveNfe() permanece 44 dígitos (compatibilidade).
 * validarChaveNfeCompleta() inclui módulo 11 da Plataforma Fiscal.
 *
 * @module motores/central-entradas/utils/validarChaveNfe
 */

const {
  validarDigitoVerificadorChaveNfe
} = require('../../../services/fiscal/utils');

/**
 * @param {string} chave
 * @returns {{ valida: boolean, chave?: string, erro?: string }}
 */
function validarChaveNfe(chave) {
  const limpa = String(chave || '').replace(/\D/g, '');

  if (!limpa) {
    return { valida: false, erro: 'Chave não informada' };
  }

  if (limpa.length !== 44) {
    return { valida: false, erro: 'Chave deve conter 44 dígitos' };
  }

  return { valida: true, chave: limpa };
}

/**
 * Estrutura da chave (não prova destinatário DistDFe).
 * CNPJ nas posições 7–20 é o emitente da NF-e (fornecedor), não a empresa consultante.
 * @param {string} chave44
 * @returns {Object}
 */
function decomporChaveNfe(chave44) {
  const chave = String(chave44 || '').replace(/\D/g, '');
  if (chave.length !== 44) return null;
  return {
    chave,
    uf: chave.slice(0, 2),
    aamm: chave.slice(2, 6),
    cnpjEmitenteNfe: chave.slice(6, 20),
    modelo: chave.slice(20, 22),
    serie: chave.slice(22, 25),
    numero: chave.slice(25, 34),
    tipoEmissao: chave.slice(34, 35),
    codigoNumerico: chave.slice(35, 43),
    dv: chave.slice(43, 44)
  };
}

/**
 * @param {string} chave
 * @returns {{ valida: boolean, chave?: string, estrutura?: Object, erro?: string, motivo?: string }}
 */
function validarChaveNfeCompleta(chave) {
  const base = validarChaveNfe(chave);
  if (!base.valida) {
    return { ...base, motivo: 'FORMATO' };
  }
  if (!validarDigitoVerificadorChaveNfe(base.chave)) {
    return {
      valida: false,
      chave: base.chave,
      erro: 'Dígito verificador da chave de acesso inválido',
      motivo: 'DV'
    };
  }
  return {
    valida: true,
    chave: base.chave,
    estrutura: decomporChaveNfe(base.chave)
  };
}

module.exports = {
  validarChaveNfe,
  validarChaveNfeCompleta,
  decomporChaveNfe
};
