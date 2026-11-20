'use strict';

function escapar(valor) {
  return String(valor == null || valor === '' ? 'Não disponível' : valor)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlComanda(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.itens) || !snapshot.itens.length) {
    throw new Error('Snapshot sem itens.');
  }
  const comandas = [...new Set(snapshot.itens.map((item) => item.numero_comanda))];
  const grupos = [
    { tipo: 'BEBIDA', titulo: 'Bebidas' },
    { tipo: 'PASTEL', titulo: 'Pastéis' },
    { tipo: 'OUTRO', titulo: 'Demais produtos' }
  ];
  const itens = grupos.map(({ tipo, titulo }) => {
    const grupo = snapshot.itens.filter((item) => (
      ['BEBIDA', 'PASTEL'].includes(item.tipo_item) ? item.tipo_item : 'OUTRO'
    ) === tipo);
    if (!grupo.length) return '';
    return `<section><h2>${titulo}</h2>${grupo.map((item) => {
      const quantidade = Number(item.qty_solicitada_millis);
      const quantidadeTexto = Number.isFinite(quantidade) && quantidade > 0
        ? String(quantidade / 1000) : 'Não disponível';
      let composicao = '';
      if (item.tipo_item === 'PASTEL') {
        composicao = item.composicao_confiavel === true && Array.isArray(item.ingredientes) && item.ingredientes.length
          ? `<div class="composicao">Composição por unidade:${item.ingredientes.map((ing) => {
            const estado = Number(ing.selecionado) !== 1 ? 'Não selecionado: '
              : ing.classificacao === 'OBRIGATORIO_OCULTO' ? '' : 'Opcional selecionado: ';
            return `<div>• ${estado}${escapar(ing.nome)} (${escapar(Number(ing.quantidade_snapshot_millis) / 1000)} ${escapar(ing.unidade)})</div>`;
          }).join('')}</div>`
          : '<div class="aviso">Composição confiável não registrada para este pastel.</div>';
      } else if (!['BEBIDA', 'OUTRO'].includes(item.tipo_item)) {
        composicao = '<div class="aviso">Classificação e composição não registradas neste envio.</div>';
      }
      return `<div class="item"><strong>${escapar(quantidadeTexto)} × ${escapar(item.nome)}</strong>
        ${composicao}${item.observacao ? `<div>Obs.: ${escapar(item.observacao)}</div>` : ''}</div>`;
    }).join('')}</section>`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>@page{margin:2mm}body{font:12px Arial,sans-serif;width:76mm;margin:0 auto}
    h1{font-size:16px;text-align:center}h2{font-size:13px;border-top:1px solid #000;padding-top:6px}
    .item{border-top:1px dashed #000;padding:6px 0;overflow-wrap:anywhere}
    .composicao,.aviso{margin-top:4px}.aviso{font-weight:bold}</style></head>
    <body><h1>CDS Sistemas — Comanda cozinha</h1>
    <div>Mesa: ${escapar(snapshot.mesa_numero)}</div>
    <div>Comanda: ${escapar(comandas.join(', '))}</div>
    <div>Pedido: ${escapar(snapshot.pedido_codigo || snapshot.pedido_id)}</div>
    <div>Rodada: ${escapar(snapshot.numero_rodada)}</div>
    <div>Garçom: ${escapar(snapshot.garcom)}</div>
    <div>Envio (UTC): ${escapar(snapshot.enviada_em)}</div>
    ${snapshot.observacao_geral ? `<div>Observação: ${escapar(snapshot.observacao_geral)}</div>` : ''}
    ${itens}</body></html>`;
}

module.exports = { htmlComanda };
