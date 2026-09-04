/**
 * MUC-02 — Conversão de quantidade (SI + grafo de relações + encadeamento).
 * Puro: não acessa banco, empresa, estoque, venda ou compra.
 * @module motores/muc/core/MotorConversaoQuantidade
 */
'use strict';

const {
  FATOR_SI,
  isUnidadeConhecida,
  normalizarUnidade,
  siIncompativel
} = require('./unidadesSi');

const CODIGOS = Object.freeze({
  CONVERSAO_INVALIDA: 'CONVERSAO_INVALIDA',
  CONVERSAO_NAO_DISPONIVEL: 'CONVERSAO_NAO_DISPONIVEL',
  CONVERSAO_CICLO: 'CONVERSAO_CICLO'
});

function erroConv(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Arredonda só no contrato de saída (não nas etapas). */
function arredondarContrato(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 1e9) / 1e9;
}

function normalizarRelacoes(raw) {
  const lista = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const r of lista) {
    if (!r) continue;
    const de = normalizarUnidade(r.de || r.origem || r.from);
    const para = normalizarUnidade(r.para || r.destino || r.to);
    const fator = Number(r.fator ?? r.quantidade ?? r.factor);
    if (!de || !para) {
      throw erroConv(
        CODIGOS.CONVERSAO_INVALIDA,
        `Relação de conversão com unidade inválida: ${r.de} → ${r.para}.`
      );
    }
    if (!(fator > 0) || !Number.isFinite(fator)) {
      throw erroConv(
        CODIGOS.CONVERSAO_INVALIDA,
        `Fator de conversão inválido: ${de} → ${para}.`
      );
    }
    if (de === para) continue;
    out.push({ de, para, fator });
  }
  return out;
}

function detectarCiclo(relacoes) {
  const adj = new Map();
  for (const r of relacoes) {
    if (!adj.has(r.de)) adj.set(r.de, []);
    adj.get(r.de).push(r.para);
  }
  const estado = new Map();

  function dfs(no) {
    estado.set(no, 1);
    for (const prox of adj.get(no) || []) {
      const st = estado.get(prox) || 0;
      if (st === 1) {
        throw erroConv(
          CODIGOS.CONVERSAO_CICLO,
          `Ciclo de conversão detectado envolvendo ${no} → ${prox}.`
        );
      }
      if (st === 0) dfs(prox);
    }
    estado.set(no, 2);
  }

  for (const no of adj.keys()) {
    if (!estado.has(no)) dfs(no);
  }
}

function adicionarAresta(adj, de, para, fator, origem) {
  if (!adj.has(de)) adj.set(de, []);
  const lista = adj.get(de);
  const existente = lista.find((e) => e.para === para);
  if (existente) return;
  lista.push({ para, fator, origem });
}

function montarGrafo(relacoes) {
  const adj = new Map();

  const siKeys = Object.keys(FATOR_SI);
  for (const a of siKeys) {
    for (const b of siKeys) {
      if (a === b) continue;
      if (FATOR_SI[a].familia !== FATOR_SI[b].familia) continue;
      const fator = FATOR_SI[a].fatorParaBase / FATOR_SI[b].fatorParaBase;
      adicionarAresta(adj, a, b, fator, 'SI');
    }
  }

  for (const r of relacoes) {
    adicionarAresta(adj, r.de, r.para, r.fator, 'RELACAO');
    adicionarAresta(adj, r.para, r.de, 1 / r.fator, 'INVERSO');
  }

  return adj;
}

function bfs(adj, origem, destino) {
  const fila = [{ no: origem, fatorAcum: 1, caminho: [] }];
  const visitado = new Set([origem]);

  while (fila.length) {
    const atual = fila.shift();
    if (atual.no === destino) {
      return { fatorTotal: atual.fatorAcum, caminho: atual.caminho };
    }
    for (const aresta of adj.get(atual.no) || []) {
      if (visitado.has(aresta.para)) continue;
      visitado.add(aresta.para);
      fila.push({
        no: aresta.para,
        fatorAcum: atual.fatorAcum * aresta.fator,
        caminho: atual.caminho.concat({
          de: atual.no,
          para: aresta.para,
          fator: aresta.fator,
          origem: aresta.origem
        })
      });
    }
  }
  return null;
}

/**
 * @param {{ quantidade: number, unidadeOrigem: string, unidadeDestino: string, relacoes?: Array }} input
 * @returns {{ quantidade: number, unidade: string, unidadeOrigem: string, unidadeDestino: string, caminho: Array, fatorTotal: number }}
 */
function converterQuantidade(input = {}) {
  const quantidade = Number(input.quantidade);
  if (!(quantidade > 0) || !Number.isFinite(quantidade)) {
    throw erroConv(CODIGOS.CONVERSAO_INVALIDA, 'Quantidade para conversão deve ser positiva.');
  }
  if (!isUnidadeConhecida(input.unidadeOrigem) || !isUnidadeConhecida(input.unidadeDestino)) {
    throw erroConv(
      CODIGOS.CONVERSAO_INVALIDA,
      `Conversão inválida: ${input.unidadeOrigem || '(vazia)'} → ${input.unidadeDestino || '(vazia)'}.`
    );
  }

  const origem = normalizarUnidade(input.unidadeOrigem);
  const destino = normalizarUnidade(input.unidadeDestino);
  const relacoes = normalizarRelacoes(input.relacoes);
  detectarCiclo(relacoes);

  if (origem === destino) {
    return Object.freeze({
      quantidade: arredondarContrato(quantidade),
      unidade: destino,
      unidadeOrigem: origem,
      unidadeDestino: destino,
      caminho: Object.freeze([]),
      fatorTotal: 1
    });
  }

  const achado = bfs(montarGrafo(relacoes), origem, destino);
  if (!achado) {
    if (siIncompativel(origem, destino) && relacoes.length === 0) {
      throw erroConv(CODIGOS.CONVERSAO_INVALIDA, `Conversão inválida: ${origem} → ${destino}.`);
    }
    throw erroConv(
      CODIGOS.CONVERSAO_NAO_DISPONIVEL,
      `Conversão não disponível: ${origem} → ${destino}.`
    );
  }

  const qtdFinal = quantidade * achado.fatorTotal;
  return Object.freeze({
    quantidade: arredondarContrato(qtdFinal),
    unidade: destino,
    unidadeOrigem: origem,
    unidadeDestino: destino,
    caminho: Object.freeze(achado.caminho.map((e) => Object.freeze({ ...e }))),
    fatorTotal: arredondarContrato(achado.fatorTotal)
  });
}

module.exports = {
  converterQuantidade,
  CODIGOS,
  arredondarContrato,
  normalizarRelacoes
};
