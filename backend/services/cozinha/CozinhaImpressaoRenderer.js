/**
 * Renderer de snapshot — Impressão de Cozinha (Sprint 06 Bloco A).
 * Gera TEXT para 58/80 mm. Não executa impressão física.
 */
'use strict';

const {
  montarPayloadSnapshot,
  parseSnapshotJson,
  normalizarLarguraMm,
  LARGURA_PADRAO_MM,
  erroImpressao
} = require('./cozinhaImpressaoContratos');

function larguraColunas(larguraMm) {
  // Heurística de colunas ESC/POS / cupom térmico.
  return larguraMm === 58 ? 32 : 48;
}

function linha(char, cols) {
  return String(char || '-').repeat(cols);
}

function cortar(texto, cols) {
  const s = String(texto == null ? '' : texto);
  if (s.length <= cols) return s;
  return s.slice(0, Math.max(0, cols - 1)) + '…';
}

function wrap(texto, cols) {
  const s = String(texto == null ? '' : texto).trim();
  if (!s) return [];
  const out = [];
  let rest = s;
  while (rest.length > cols) {
    out.push(rest.slice(0, cols));
    rest = rest.slice(cols);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * @param {object|string} snapshotOuJson
 * @param {{ largura_mm?: number }} [opts]
 * @returns {{ largura_mm: number, colunas: number, texto: string, impressao_fisica: false }}
 */
function renderizarTexto(snapshotOuJson, opts = {}) {
  const snapshot = typeof snapshotOuJson === 'string'
    ? parseSnapshotJson(snapshotOuJson)
    : montarPayloadSnapshot(snapshotOuJson);

  const larguraMm = normalizarLarguraMm(
    opts.largura_mm != null ? opts.largura_mm : (snapshot.largura_mm || LARGURA_PADRAO_MM)
  );
  const cols = larguraColunas(larguraMm);
  const linhas = [];

  linhas.push(cortar('COZINHA', cols));
  linhas.push(linha('=', cols));
  if (snapshot.mesa_numero != null) {
    linhas.push(cortar(`Mesa: ${snapshot.mesa_numero}`, cols));
  }
  if (snapshot.sequencia_global != null && Number.isFinite(snapshot.sequencia_global)) {
    linhas.push(cortar(`Seq: ${snapshot.sequencia_global}`, cols));
  }
  if (snapshot.numero_rodada != null && Number.isFinite(snapshot.numero_rodada)) {
    linhas.push(cortar(`Rodada: ${snapshot.numero_rodada}`, cols));
  }
  if (snapshot.enviada_em) {
    linhas.push(cortar(`Envio: ${snapshot.enviada_em}`, cols));
  }
  linhas.push(cortar(`Modelo: ${snapshot.modelo}`, cols));
  linhas.push(linha('-', cols));

  if (!snapshot.itens.length) {
    linhas.push(cortar('(sem itens)', cols));
  }

  for (const item of snapshot.itens) {
    const qty = item.qty != null ? item.qty : '';
    const cab = [qty, item.tipo_item, item.descricao].filter(Boolean).join(' ');
    for (const w of wrap(cab, cols)) linhas.push(w);
    if (item.comanda_id) {
      linhas.push(cortar(`  Comanda #${item.comanda_id}`, cols));
    }
    if (item.observacao) {
      for (const w of wrap(`  Obs: ${item.observacao}`, cols)) linhas.push(w);
    }
    for (const ing of item.ingredientes || []) {
      if (!ing.selecionado) continue;
      const ingTxt = ['  +', ing.nome, ing.qty].filter(Boolean).join(' ');
      for (const w of wrap(ingTxt, cols)) linhas.push(w);
    }
    linhas.push(linha('-', cols));
  }

  linhas.push(cortar('*** FIM ***', cols));

  return Object.freeze({
    largura_mm: larguraMm,
    colunas: cols,
    texto: linhas.join('\n'),
    impressao_fisica: false
  });
}

/**
 * Preview de teste de estação (D6) — sem fila, sem print físico.
 */
function renderizarTesteEstacao(estacao = {}) {
  const larguraMm = normalizarLarguraMm(estacao.largura_mm);
  const codigo = String(estacao.codigo_estacao || 'TESTE').trim().toUpperCase() || 'TESTE';
  const snapshot = montarPayloadSnapshot({
    empresa_id: estacao.empresa_id || 1,
    unidade_id: estacao.unidade_id || 1,
    rodada_id: estacao.rodada_id || 1,
    sequencia_global: 0,
    mesa_numero: 'TESTE',
    numero_rodada: 0,
    enviada_em: new Date().toISOString(),
    modelo: 'AGRUPADO',
    largura_mm: larguraMm,
    itens: [{
      cozinha_item_id: 1,
      comanda_id: 1,
      tipo_item: 'OUTRO',
      descricao: `Teste estacao ${codigo}`,
      qty: '1.000',
      observacao: 'Sem impressao fisica (Bloco A)',
      ingredientes: []
    }]
  });
  const render = renderizarTexto(snapshot, { largura_mm: larguraMm });
  return Object.freeze({
    ...render,
    codigo_estacao: codigo,
    device_name: estacao.device_name != null ? String(estacao.device_name) : null,
    modo: 'TESTE_ESTACAO',
    impressao_fisica: false
  });
}

function assertSemImpressaoFisica(resultado) {
  if (!resultado || resultado.impressao_fisica !== false) {
    throw erroImpressao(
      'Renderer Bloco A não pode marcar impressao_fisica=true.',
      500,
      'IMPRESSAO_BLOCO_A_VIOLACAO'
    );
  }
  return resultado;
}

module.exports = {
  renderizarTexto,
  renderizarTesteEstacao,
  assertSemImpressaoFisica,
  larguraColunas
};
