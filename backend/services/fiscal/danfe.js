const QRCodeService = require('../qrcode/QRCodeService');

function montarPagamentosDanfe(pagamentos) {
  if (!Array.isArray(pagamentos) || pagamentos.length === 0) {
    return '';
  }

  return pagamentos.map(p => {
    return `${formatarFormaPagamento(p.forma_pagamento)}: ${formatarMoeda(p.valor)}`;
  }).join('\n');
}

/**
 * Visão comercial do DANFE: o que o cliente pagou,
 * independente da alocação fiscal × não fiscal (MIDP).
 * Agrega por forma_pagamento somando todas as parcelas.
 */
function obterPagamentosComerciaisDanfe(pagamentos = []) {
  const lista = Array.isArray(pagamentos) ? pagamentos : [];
  if (lista.length === 0) return [];

  const mapa = new Map();
  for (const p of lista) {
    const forma = String(p.forma_pagamento || p.forma || '').toLowerCase().trim() || 'outro';
    const valor = Number(p.valor || 0);
    if (!Number.isFinite(valor) || valor <= 0) continue;
    mapa.set(forma, Math.round(((mapa.get(forma) || 0) + valor) * 100) / 100);
  }

  return Array.from(mapa.entries()).map(([forma_pagamento, valor]) => ({
    forma_pagamento,
    valor
  }));
}

function somarPagamentosDanfe(pagamentos = []) {
  return Math.round(
    (Array.isArray(pagamentos) ? pagamentos : []).reduce(
      (s, p) => s + Number(p.valor || 0),
      0
    ) * 100
  ) / 100;
}

/**
 * Cupom do cliente: pagamentos devem fechar com o total da venda.
 * Prioriza recebimentos F+NF; não usa fatia fiscal isolada.
 */
function resolverPagamentosExibicaoDanfe(venda = {}) {
  const total = Math.round(Number(venda.total || 0) * 100) / 100;
  const recebimentos = Array.isArray(venda.pagamentos) ? venda.pagamentos : [];
  const comerciais = Array.isArray(venda.pagamentos_comerciais)
    ? venda.pagamentos_comerciais
    : [];

  const fromRec = obterPagamentosComerciaisDanfe(recebimentos);
  const somaRec = somarPagamentosDanfe(fromRec);
  if (fromRec.length > 0 && (total <= 0 || Math.abs(somaRec - total) <= 0.01)) {
    return fromRec;
  }

  const fromCom = obterPagamentosComerciaisDanfe(comerciais);
  const somaCom = somarPagamentosDanfe(fromCom);
  if (fromCom.length > 0 && (total <= 0 || Math.abs(somaCom - total) <= 0.01)) {
    return fromCom;
  }

  // Junta F+NF quando a soma parcial ainda não fecha o total
  const mesclado = obterPagamentosComerciaisDanfe([...recebimentos, ...comerciais]);
  const somaMesclado = somarPagamentosDanfe(mesclado);
  if (mesclado.length > 0 && (total <= 0 || Math.abs(somaMesclado - total) <= 0.01)) {
    return mesclado;
  }

  if (fromRec.length > 0 && total > 0 && somaRec < total - 0.01) {
    const falta = Math.round((total - somaRec) * 100) / 100;
    const formasRec = new Set(fromRec.map((p) => p.forma_pagamento));
    const extra = fromCom.find((p) => !formasRec.has(p.forma_pagamento));
    const formaFalta = extra?.forma_pagamento
      || String(venda.forma_pagamento || fromRec[0].forma_pagamento || 'outro').toLowerCase();
    return obterPagamentosComerciaisDanfe([
      ...fromRec,
      { forma_pagamento: formaFalta, valor: falta }
    ]);
  }

  if (fromCom.length === 1 && total > 0) {
    return [{ forma_pagamento: fromCom[0].forma_pagamento, valor: total }];
  }

  const formaVenda = String(venda.forma_pagamento || '').toLowerCase().trim();
  if (formaVenda && formaVenda !== 'misto' && total > 0) {
    return [{ forma_pagamento: formaVenda, valor: total }];
  }

  return fromRec.length ? fromRec : fromCom;
}

function formatarFormaPagamento(forma) {
  const nomes = {
    dinheiro: 'Dinheiro',
    pix: 'Pix',
    cartao: 'Cartão',
    cartao_debito: 'Cartão Débito',
    cartao_credito: 'Cartão Crédito',
    misto: 'Misto'
  };

  return nomes[forma] || forma;
}

function formatarMoeda(valor) {
  return 'R$ ' + Number(valor || 0).toFixed(2).replace('.', ',');
}

function obterQuantidadeFiscalDanfe(item = {}) {
  return Number(item.quantidade_fiscal ?? 0);
}

function obterValorFiscalItemDanfe(item = {}) {
  return Number(item.valor_fiscal ?? 0);
}

/** Helpers exclusivos para a tabela de itens do DANFE (impressão). */
function obterQuantidadeImpressao(item = {}) {
  return Number(item.quantidade_fiscal ?? 0) + Number(item.quantidade_nao_fiscal ?? 0);
}

function obterValorImpressao(item = {}) {
  return Number(item.valor_fiscal ?? 0) + Number(item.valor_nao_fiscal ?? 0);
}

// Formata CNPJ: 65957340000150 -> 65.957.340/0001-50
function formatarCNPJ(cnpj) {
  if (!cnpj) return '';
  const numeros = String(cnpj).replace(/\D/g, '');
  if (numeros.length !== 14) return cnpj;
  return numeros.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

function formatarCpfCnpj(valor) {
  const v = String(valor || '').replace(/\D/g, '');

  if (v.length === 11) {
    return v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }

  if (v.length === 14) {
    return v.replace(
      /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
      '$1.$2.$3/$4-$5'
    );
  }

  return valor || '';
}

async function gerarDanfeHtml({
  venda,
  itens: itensDanfe = [],
  itensFiscal = [],
  empresa,
  chave,
  numero,
  serie,
  qrCodeUrl,
  tributos,
  nota
}) {
  const tpAmbDanfe = Number(
    nota?.tpAmb ||
    nota?.ambiente ||
    venda?.tpAmb ||
    venda?.ambiente ||
    1
  );

  const avisoHomologacao = tpAmbDanfe === 2
    ? `
      <div style="text-align:center; font-weight:bold; margin:8px 0;">
        EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL
      </div>
    `
    : '';

  const qrCodeDataUrl = qrCodeUrl
    ? (await QRCodeService.gerarLink(qrCodeUrl, { formato: 'dataurl', largura: 220, uso: 'danfe' })).imagem || ''
    : '';

  const itensImpressao = Array.isArray(itensDanfe) ? itensDanfe : [];

  // Cupom: todos os pagamentos do cliente (F+NF), fechando com o total.
  const pagamentosComerciais = resolverPagamentosExibicaoDanfe(venda);
  const textoPagamentos = montarPagamentosDanfe(pagamentosComerciais);

  const valorTotalVenda = Number(venda.total ?? 0) > 0
    ? Number(venda.total)
    : itensImpressao.reduce((acc, item) => acc + obterValorImpressao(item), 0);

  const itensHtml = itensImpressao.map((item) => {
    const quantidade = obterQuantidadeImpressao(item);
    const subtotal = obterValorImpressao(item);
    const precoUnitario = quantidade > 0
      ? subtotal / quantidade
      : Number(item.preco_unitario || 0);
    return `
    <tr>
      <td>${item.produto_nome || ''}</td>
      <td style="text-align:center;">${quantidade}</td>
      <td style="text-align:right;">${precoUnitario.toFixed(2)}</td>
      <td style="text-align:right;">${subtotal.toFixed(2)}</td>
    </tr>
  `;
  }).join('');

  const tributosHtml = tributos ? `
    <p style="font-size: 10px;">Tributos Totais Incidentes (Lei Federal 12.741/2012):</p>
    <p style="font-size: 10px;">ICMS: R$ ${Number(tributos.vICMS || 0).toFixed(2)}</p>
    <p style="font-size: 10px;">PIS: R$ ${Number(tributos.vPIS || 0).toFixed(2)}</p>
    <p style="font-size: 10px;">COFINS: R$ ${Number(tributos.vCOFINS || 0).toFixed(2)}</p>
  ` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>DANFE NFC-e</title>
  <style>
    body { font-family: monospace; width: 80mm; margin: 0 auto; font-size: 11px; }
    h1,h2,p { margin: 0; padding: 0; }
    .center { text-align: center; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 2px 0; vertical-align: top; }
    .sep { border-top: 1px dashed #000; margin: 6px 0; }
    img { max-width: 100%; }
  </style>
</head>
<body>
  <div class="center">
    <h2>${empresa.nome || ''}</h2>
    <p>CNPJ: ${formatarCNPJ(empresa.cnpj)}</p>
    <p>${empresa.endereco || ''}</p>
    <p>DANFE NFC-e - Documento Auxiliar</p>
    <p>NFC-e nº ${numero} Série ${serie}</p>
    ${(
      venda.cpf_cnpj_nota ||
      venda.cliente_cpf
    ) ? `
<div style="margin-top: 5px;">
  <strong>CPF/CNPJ do Consumidor:</strong>
  ${formatarCpfCnpj(venda.cpf_cnpj_nota || venda.cliente_cpf)}
</div>
` : ''}
  </div>
  <div class="sep"></div>
  <table>
    <thead>
      <tr><th>Item</th><th>Qtd</th><th>Vl.Unit</th><th>Total</th></tr>
    </thead>
    <tbody>${itensHtml}</tbody>
  </table>
  <div class="sep"></div>
  <p>Total: R$ ${valorTotalVenda.toFixed(2)}</p>
  <p>Desconto: R$ ${Number(venda.desconto || 0).toFixed(2)}</p>
  ${textoPagamentos ? `<p>${textoPagamentos.replace(/\n/g, '<br>')}</p>` : ''}
  <div class="sep"></div>
  ${tributosHtml}
  <div class="sep"></div>
  <p>Consulte pela chave de acesso:</p>
  <p>${chave}</p>
  ${qrCodeDataUrl ? `<div class="center"><img src="${qrCodeDataUrl}" alt="QR Code"/><p>Consulte via QR Code</p></div>` : ''}
  <div class="sep"></div>
  ${avisoHomologacao}
</body>
</html>`;
}

module.exports = {
  gerarDanfeHtml,
  obterPagamentosComerciaisDanfe,
  resolverPagamentosExibicaoDanfe,
  obterQuantidadeImpressao,
  obterValorImpressao,
  obterQuantidadeFiscalDanfe,
  obterValorFiscalItemDanfe
};
