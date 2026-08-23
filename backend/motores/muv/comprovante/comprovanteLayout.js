/**
 * Helpers de layout do comprovante (Sprint 04.11).
 * Sem I/O. Sem banco. Determinístico.
 */
'use strict';

function exigirLargura(largura) {
  const n = Number(largura);
  if (!Number.isInteger(n) || n < 16) {
    const err = new Error('Largura de comprovante inválida.');
    err.code = 'COMPROVANTE_FORMATO_INVALIDO';
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function formatarMoeda(valor) {
  const n = Math.round(Number(valor || 0) * 100) / 100;
  const neg = n < 0;
  const abs = Math.abs(n).toFixed(2).replace('.', ',');
  return `${neg ? '-' : ''}R$ ${abs}`;
}

function linha(char, largura) {
  const w = exigirLargura(largura);
  const c = String(char || '-').charAt(0);
  return c.repeat(w);
}

function centralizar(texto, largura) {
  const w = exigirLargura(largura);
  const t = String(texto == null ? '' : texto);
  if (t.length >= w) return t.slice(0, w);
  const pad = w - t.length;
  const left = Math.floor(pad / 2);
  return `${' '.repeat(left)}${t}${' '.repeat(pad - left)}`;
}

function quebrarTexto(texto, largura) {
  const w = exigirLargura(largura);
  const raw = String(texto == null ? '' : texto).trim();
  if (!raw) return [''];
  const palavras = raw.split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const palavra of palavras) {
    if (palavra.length > w) {
      if (atual) {
        linhas.push(atual);
        atual = '';
      }
      for (let i = 0; i < palavra.length; i += w) {
        linhas.push(palavra.slice(i, i + w));
      }
      continue;
    }
    const next = atual ? `${atual} ${palavra}` : palavra;
    if (next.length > w) {
      linhas.push(atual);
      atual = palavra;
    } else {
      atual = next;
    }
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [''];
}

function alinharEsquerdaDireita(esquerda, direita, largura) {
  const w = exigirLargura(largura);
  const dir = String(direita == null ? '' : direita);
  const maxEsq = Math.max(1, w - dir.length - 1);
  const esqLinhas = quebrarTexto(esquerda, maxEsq);
  return esqLinhas.map((linhaEsq, i) => {
    if (i === esqLinhas.length - 1) {
      const gap = w - linhaEsq.length - dir.length;
      if (gap < 1) return `${linhaEsq.slice(0, maxEsq)} ${dir}`.slice(0, w);
      return `${linhaEsq}${' '.repeat(gap)}${dir}`;
    }
    return linhaEsq;
  }).join('\n');
}

function escaparHtml(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  exigirLargura,
  formatarMoeda,
  linha,
  centralizar,
  quebrarTexto,
  alinharEsquerdaDireita,
  escaparHtml
};
