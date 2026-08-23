/**
 * Renderer HTML do comprovante unificado. Puro. Escapa texto.
 */
'use strict';

const { formatarMoeda, escaparHtml } = require('./comprovanteLayout');

function documentosDoDto(dto) {
  if (Array.isArray(dto.documentos_fiscais) && dto.documentos_fiscais.length) {
    return dto.documentos_fiscais;
  }
  return Array.isArray(dto.documentosFiscais) ? dto.documentosFiscais : [];
}

function formasPagamento(dto) {
  if (Array.isArray(dto.pagamentos) && dto.pagamentos.length) return dto.pagamentos;
  if (dto.pagamento && Array.isArray(dto.pagamento.formas)) return dto.pagamento.formas;
  return [];
}

function renderizarHtml(dto, opts) {
  const nome = (dto.estabelecimento && dto.estabelecimento.nome) || 'ESTABELECIMENTO';
  const codigo = (dto.atendimento && dto.atendimento.codigo) || '';
  const data = (dto.cabecalho && dto.cabecalho.dataHora) || (dto.atendimento && dto.atendimento.created_at) || '';
  const cancelado = dto.atendimento && dto.atendimento.status === 'CANCELADO';

  const linhasItens = dto.itens.map((it) => (
    `<tr><td>${escaparHtml(`${it.quantidade}x`)}</td>`
    + `<td>${escaparHtml(it.descricao || `Produto ${it.produtoId}`)}</td>`
    + `<td class="valor">${escaparHtml(formatarMoeda(it.valorTotal))}</td></tr>`
  )).join('');

  const linhasPag = formasPagamento(dto).map((pag) => (
    `<tr><td>${escaparHtml(String(pag.formaPagamento || '').toUpperCase())}</td>`
    + `<td class="valor">${escaparHtml(formatarMoeda(pag.valor))}</td></tr>`
  )).join('');

  let secaoFiscal = '';
  if (opts.incluirDocumentosFiscais !== false) {
    const docs = documentosDoDto(dto);
    const blocos = docs.length === 0
      ? '<p>Nenhum documento fiscal disponível.</p>'
      : docs.map((doc) => {
        const inner = doc.documento || {};
        const chave = inner.chave || doc.chaveAcesso || '';
        const qr = inner.qr_code_url || doc.qrCodeUrl || '';
        return `<article class="doc-fiscal">`
          + `<h3>${escaparHtml(doc.empresa_nome || `Empresa ${doc.empresa_id || doc.empresaId}`)}</h3>`
          + `<p>NFC-e: ${escaparHtml(inner.numero != null ? inner.numero : doc.numero)}</p>`
          + (chave ? `<p>Chave: ${escaparHtml(chave)}</p>` : '')
          + (qr ? `<p>QR: ${escaparHtml(qr)}</p>` : '')
          + (doc.status ? `<p>Status: ${escaparHtml(doc.status)}</p>` : '')
          + `</article>`;
      }).join('');
    secaoFiscal = `<section><h2>Documentos fiscais</h2>${blocos}</section>`;
  }

  const fiscalStatus = dto.fiscal && dto.fiscal.status
    ? `<p>Fiscal: ${escaparHtml(dto.fiscal.status)}</p>`
    : '';

  const banner = cancelado ? '<p class="cancelado">*** ATENDIMENTO CANCELADO ***</p>' : '';
  const rodape = opts.incluirMensagemFinal !== false
    ? '<p class="msg">Obrigado pela preferência!</p>'
    : '';

  return [
    '<!DOCTYPE html>',
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    `<title>${escaparHtml(`Comprovante ${codigo}`)}</title>`,
    '<style>body{font-family:sans-serif;max-width:32rem;margin:1rem auto}',
    'td.valor,th.valor{text-align:right}.cancelado{font-weight:bold;color:#a00}</style>',
    '</head><body>',
    `<header><h1>${escaparHtml(nome)}</h1><h2>Comprovante de atendimento</h2></header>`,
    banner,
    `<p>Atendimento: ${escaparHtml(codigo)}</p>`,
    data ? `<p>Data: ${escaparHtml(data)}</p>` : '',
    fiscalStatus,
    '<section><h2>Itens</h2><table><tbody>',
    linhasItens,
    '</tbody></table></section>',
    `<p><strong>Total do atendimento ${escaparHtml(formatarMoeda(dto.totais.atendimento))}</strong></p>`,
    '<section><h2>Pagamento</h2><table><tbody>',
    linhasPag,
    '</tbody></table></section>',
    secaoFiscal,
    rodape,
    '</body></html>'
  ].filter(Boolean).join('');
}

module.exports = { renderizarHtml };
