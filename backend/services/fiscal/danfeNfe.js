/**
 * DANFE NF-e (modelo 55) — visualização/impressão (Sprint 3.2).
 * Separado do DANFE NFC-e (danfe.js).
 */

'use strict';

function fmtMoney(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDoc(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc || '';
}

async function gerarDanfeNfeHtml({
  venda,
  itens = [],
  empresa = {},
  chave,
  numero,
  serie,
  protocolo,
  status,
  natureza,
  dadosNfe = {}
}) {
  const linhas = (itens || []).map((it, i) => {
    const qtd = Number(it.quantidade_fiscal || 0);
    const total = Number(it.valor_fiscal != null ? it.valor_fiscal : 0);
    const preco = qtd > 0 && total > 0 ? total / qtd : Number(it.preco_unitario || 0);
    return `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(it.produto_nome || '')}</td>
      <td class="num">${qtd}</td>
      <td class="num">${fmtMoney(preco)}</td>
      <td class="num">${fmtMoney(total)}</td>
    </tr>`;
  }).join('');

  const totalFiscalItens = (itens || []).reduce(
    (s, it) => s + Number(it.valor_fiscal || 0),
    0
  );
  const total = Number(venda.valor_fiscal != null ? venda.valor_fiscal : totalFiscalItens);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <title>DANFE NF-e ${numero || ''}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 12px; color: #111; margin: 16px; }
    h1 { font-size: 16px; margin: 0 0 8px; }
    .box { border: 1px solid #333; padding: 8px; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #999; padding: 4px 6px; }
    th { background: #eee; text-align: left; }
    .num { text-align: right; }
    .muted { color: #555; font-size: 11px; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:12px">
    <button onclick="window.print()">Imprimir DANFE</button>
  </div>
  <div class="box">
    <h1>DANFE — Documento Auxiliar da NF-e (Modelo 55)</h1>
    <div><strong>${escapeHtml(empresa.nome || '')}</strong></div>
    <div>CNPJ: ${fmtDoc(empresa.cnpj)} · IE: ${escapeHtml(empresa.ie || '')}</div>
    <div class="muted">${escapeHtml(empresa.endereco || '')}</div>
  </div>
  <div class="box">
    <div>NF-e nº <strong>${numero || '—'}</strong> · Série <strong>${serie || '—'}</strong> · Status: <strong>${escapeHtml(status || '')}</strong></div>
    <div>Natureza: ${escapeHtml(natureza || dadosNfe.natureza_operacao || 'VENDA')}</div>
    <div>Chave: <span class="muted">${escapeHtml(chave || '')}</span></div>
    <div>Protocolo: ${escapeHtml(protocolo || '—')}</div>
  </div>
  <div class="box">
    <div><strong>Destinatário:</strong> ${escapeHtml(venda.cliente_nome || '—')}</div>
    <div>Documento: ${fmtDoc(venda.cliente_cpf)}</div>
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>Produto</th><th>Qtd</th><th>Preço</th><th>Total</th></tr>
    </thead>
    <tbody>${linhas}</tbody>
  </table>
  <div class="box" style="margin-top:10px; text-align:right">
    <strong>Total: ${fmtMoney(total)}</strong>
    ${dadosNfe.frete ? `<div>Frete: ${fmtMoney(dadosNfe.frete)}</div>` : ''}
    ${dadosNfe.transportadora ? `<div>Transportadora: ${escapeHtml(dadosNfe.transportadora)}</div>` : ''}
  </div>
  ${dadosNfe.dados_adicionais || dadosNfe.observacoes ? `<div class="box"><strong>Dados adicionais</strong><div>${escapeHtml(dadosNfe.dados_adicionais || dadosNfe.observacoes)}</div></div>` : ''}
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  gerarDanfeNfeHtml
};
