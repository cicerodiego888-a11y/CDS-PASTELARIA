/**
 * Renderer TEXT do comprovante unificado. Puro.
 */
'use strict';

const {
  linha,
  centralizar,
  alinharEsquerdaDireita,
  formatarMoeda,
  exigirLargura
} = require('./comprovanteLayout');

function nomeEstabelecimento(dto) {
  const n = dto.estabelecimento && dto.estabelecimento.nome;
  return n && String(n).trim() ? String(n).trim() : 'ESTABELECIMENTO';
}

function dataAtendimento(dto) {
  return (dto.cabecalho && dto.cabecalho.dataHora)
    || (dto.atendimento && dto.atendimento.created_at)
    || '';
}

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

function padNumero(numero) {
  if (numero == null || numero === '') return '';
  return String(numero).padStart(6, '0');
}

function renderizarTexto(dto, opts) {
  const w = exigirLargura(opts.largura || 40);
  const out = [];
  const sep = linha('=', w);
  const dash = linha('-', w);

  out.push(sep);
  out.push(centralizar(nomeEstabelecimento(dto), w));
  out.push(centralizar('COMPROVANTE DE ATENDIMENTO', w));
  out.push(sep);

  if (dto.atendimento && dto.atendimento.status === 'CANCELADO') {
    out.push(centralizar('*** ATENDIMENTO CANCELADO ***', w));
    out.push(dash);
  }

  const codigo = (dto.atendimento && dto.atendimento.codigo) || (dto.cabecalho && dto.cabecalho.codigo) || '';
  out.push(`Atendimento: ${codigo}`);
  const data = dataAtendimento(dto);
  if (data) out.push(`Data: ${data}`);
  if (dto.fiscal && dto.fiscal.status) {
    out.push(`Fiscal: ${dto.fiscal.status}`);
  }

  out.push(dash);
  out.push(centralizar('ITENS', w));
  out.push(dash);

  for (const it of dto.itens) {
    const desc = `${it.quantidade}x ${it.descricao || `Produto ${it.produtoId}`}`;
    out.push(alinharEsquerdaDireita(desc, formatarMoeda(it.valorTotal), w));
    out.push('');
  }

  out.push(dash);
  out.push(alinharEsquerdaDireita('TOTAL DO ATENDIMENTO', formatarMoeda(dto.totais.atendimento), w));
  out.push(dash);

  out.push('PAGAMENTO');
  out.push('');
  const formas = formasPagamento(dto);
  if (formas.length === 0) {
    out.push(alinharEsquerdaDireita('—', formatarMoeda(dto.pagamento.total), w));
  } else {
    for (const pag of formas) {
      out.push(alinharEsquerdaDireita(
        String(pag.formaPagamento || pag.forma || '').toUpperCase(),
        formatarMoeda(pag.valor),
        w
      ));
    }
  }

  if (opts.incluirDocumentosFiscais !== false) {
    const docs = documentosDoDto(dto);
    out.push('');
    out.push(dash);
    out.push(centralizar('DOCUMENTOS FISCAIS', w));
    out.push(dash);
    if (docs.length === 0) {
      out.push('Nenhum documento fiscal disponível.');
    } else {
      for (const doc of docs) {
        const nome = doc.empresa_nome || `Empresa ${doc.empresa_id || doc.empresaId}`;
        const inner = doc.documento || {};
        out.push(nome);
        out.push(`NFC-e: ${padNumero(inner.numero != null ? inner.numero : doc.numero)}`);
        const chave = inner.chave || doc.chaveAcesso;
        if (chave) out.push(`Chave: ${chave}`);
        const qr = inner.qr_code_url || doc.qrCodeUrl;
        if (qr) out.push(`QR: ${qr}`);
        if (doc.status) out.push(`Status: ${doc.status}`);
        out.push('');
      }
    }
  }

  if (opts.incluirMensagemFinal !== false) {
    out.push(sep);
    out.push(centralizar('Obrigado pela preferência!', w));
    out.push(sep);
  }

  return out.join('\n');
}

module.exports = { renderizarTexto };
