/**
 * Normalização e validação de CNPJ do cadastro de empresas.
 * Independente do MIIP / configuracoes. Sem fallback.
 *
 * @module services/empresas/empresaCnpj
 */
'use strict';

function apenasDigitos(valor) {
  if (valor == null || valor === '') return '';
  return String(valor).replace(/\D/g, '');
}

/**
 * @param {string|number|null|undefined} valor
 * @returns {string|null} 14 dígitos ou null se vazio
 */
function normalizarCnpjEmpresa(valor) {
  const digitos = apenasDigitos(valor);
  if (!digitos) return null;
  return digitos;
}

function digitoVerificadorCnpj(base) {
  let soma = 0;
  let pos = base.length - 7;
  for (let i = 0; i < base.length; i += 1) {
    soma += Number(base[i]) * pos;
    pos -= 1;
    if (pos < 2) pos = 9;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * Formato: 14 dígitos + dígitos verificadores. Rejeita sequência repetida.
 * @param {string|number|null|undefined} valor
 * @returns {boolean}
 */
function isCnpjEmpresaValido(valor) {
  const digitos = apenasDigitos(valor);
  if (digitos.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digitos)) return false;

  const d1 = digitoVerificadorCnpj(digitos.slice(0, 12));
  const d2 = digitoVerificadorCnpj(digitos.slice(0, 12) + String(d1));
  return digitos === `${digitos.slice(0, 12)}${d1}${d2}`;
}

/**
 * Normaliza e valida. Lança erro com code se inválido/ausente.
 * @returns {string} CNPJ com 14 dígitos
 */
function exigirCnpjEmpresaValido(valor) {
  const normalizado = normalizarCnpjEmpresa(valor);
  if (!normalizado) {
    const err = new Error('CNPJ da empresa é obrigatório.');
    err.code = 'CNPJ_EMPRESA_OBRIGATORIO';
    err.status = 400;
    throw err;
  }
  if (!isCnpjEmpresaValido(normalizado)) {
    const err = new Error('CNPJ da empresa inválido.');
    err.code = 'CNPJ_EMPRESA_INVALIDO';
    err.status = 400;
    throw err;
  }
  return normalizado;
}

module.exports = {
  normalizarCnpjEmpresa,
  isCnpjEmpresaValido,
  exigirCnpjEmpresaValido
};
