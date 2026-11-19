/**
 * Precisão de quantidades da Cozinha — milésimos inteiros como fonte de verdade.
 * Não usa float binário na aritmética de domínio.
 */
'use strict';

const ESCALA = 3;
const FATOR = 1000;

function erroQty(codigo, mensagem) {
  const err = new Error(mensagem);
  err.codigo = codigo;
  err.code = codigo;
  err.statusCode = 400;
  return err;
}

/**
 * Converte decimal (number|string) em milésimos inteiros.
 * Rejeita mais de 3 casas — sem arredondamento silencioso.
 */
function decimalParaMilessimos(valor) {
  if (valor == null || (typeof valor === 'string' && valor.trim() === '')) {
    throw erroQty('QTY_PRECISAO_INVALIDA', 'Quantidade obrigatória.');
  }
  let bruto;
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) {
      throw erroQty('QTY_PRECISAO_INVALIDA', 'Quantidade em formato inválido.');
    }
    // Evita toString científico; exige representação decimal finita via string limpa
    bruto = Object.is(valor, -0) ? '-0' : String(valor);
    if (/e/i.test(bruto)) {
      throw erroQty('QTY_PRECISAO_INVALIDA', 'Quantidade em notação científica não é aceita.');
    }
  } else {
    bruto = String(valor).trim();
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(bruto)) {
    throw erroQty('QTY_PRECISAO_INVALIDA', 'Quantidade em formato inválido.');
  }
  const negativo = bruto.startsWith('-');
  const limpo = bruto.replace(/^[+-]/, '');
  const partes = limpo.split('.');
  const inteiro = partes[0] || '0';
  const frac = partes[1] || '';
  if (frac.length > ESCALA) {
    throw erroQty(
      'QTY_PRECISAO_INVALIDA',
      `Quantidade não pode ter mais de ${ESCALA} casas decimais.`
    );
  }
  const fracPad = (frac + '000').slice(0, ESCALA);
  const millis = Number(inteiro) * FATOR + Number(fracPad);
  if (!Number.isSafeInteger(millis)) {
    throw erroQty('QTY_PRECISAO_INVALIDA', 'Quantidade fora da faixa suportada.');
  }
  return negativo ? -millis : millis;
}

/** Converte milésimos em string decimal com exatamente 3 casas (exibição / hash). */
function milessimosParaDecimalString(millis) {
  const n = Number(millis);
  if (!Number.isInteger(n)) {
    throw erroQty('QTY_PRECISAO_INVALIDA', 'Milésimos devem ser inteiros.');
  }
  const neg = n < 0;
  const abs = Math.abs(n);
  const inteiro = Math.floor(abs / FATOR);
  const frac = String(abs % FATOR).padStart(ESCALA, '0');
  return `${neg ? '-' : ''}${inteiro}.${frac}`;
}

function milessimosParaNumeroExibicao(millis) {
  return milessimosParaDecimalString(millis);
}

function somarMilessimos(...valores) {
  let acc = 0;
  for (const v of valores) {
    const n = Number(v);
    if (!Number.isInteger(n)) {
      throw erroQty('QTY_PRECISAO_INVALIDA', 'Parcela de soma inválida.');
    }
    acc += n;
  }
  if (!Number.isSafeInteger(acc)) {
    throw erroQty('QTY_PRECISAO_INVALIDA', 'Overflow na soma de quantidades.');
  }
  return acc;
}

function subtrairMilessimos(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isInteger(na) || !Number.isInteger(nb)) {
    throw erroQty('QTY_PRECISAO_INVALIDA', 'Parcela de subtração inválida.');
  }
  const r = na - nb;
  if (!Number.isSafeInteger(r)) {
    throw erroQty('QTY_PRECISAO_INVALIDA', 'Overflow na subtração de quantidades.');
  }
  return r;
}

function compararMilessimos(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isInteger(na) || !Number.isInteger(nb)) {
    throw erroQty('QTY_PRECISAO_INVALIDA', 'Comparação com milésimos inválidos.');
  }
  if (na < nb) return -1;
  if (na > nb) return 1;
  return 0;
}

/** Serializa quantidade de entrada (decimal) para o hash — sempre 3 casas. */
function serializarQtyParaHash(valor) {
  return milessimosParaDecimalString(decimalParaMilessimos(valor));
}

function serializarMilessimosParaHash(millis) {
  return milessimosParaDecimalString(millis);
}

module.exports = {
  ESCALA,
  FATOR,
  decimalParaMilessimos,
  milessimosParaDecimalString,
  milessimosParaNumeroExibicao,
  somarMilessimos,
  subtrairMilessimos,
  compararMilessimos,
  serializarQtyParaHash,
  serializarMilessimosParaHash
};
