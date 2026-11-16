/**
 * CDS-PDV-CORRECAO-CONFIRMACAO-EVIDENCIA-PIX-01
 * Evidência persistida de PIX: cobrança → empresa/parcela/valor → confirmação.
 */
const pixService = require('./pixService');

function arredondar(valor) {
  return Math.round((Number(valor || 0) + Number.EPSILON) * 100) / 100;
}

function valoresCompativeis(a, b) {
  return Math.abs(arredondar(a) - arredondar(b)) <= 0.009;
}

function formaEhPix(forma) {
  const f = String(forma || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return f === 'pix' || f === 'pix_tef';
}

/**
 * Comprova cobrança PAGO na base (fonte persistida). Não confia em flags do cliente.
 * @param {object} entrada
 * @param {string} entrada.txid
 * @param {number} [entrada.empresaId]
 * @param {number} entrada.valor
 * @param {number|null} [entrada.vendaId]
 * @param {number|null} [entrada.parcelaLocalId]
 * @param {string|null} [entrada.sessaoPagamento]
 * @param {string|null} [entrada.chaveParcela]
 * @param {object} [entrada.db] — conexão opcional (transação)
 * @param {boolean} [entrada.consultarProvedor=false]
 */
async function comprovarCobrancaPixPago(entrada = {}) {
  const txid = String(entrada.txid || '').trim();
  if (!txid) {
    return { sucesso: false, codigo: 'PIX_TXID_AUSENTE', erro: 'PIX sem TXID de cobrança persistida.' };
  }

  let row;
  try {
    row = await pixService.obterCobrancaPorTxid(txid, entrada.db);
  } catch (error) {
    return { sucesso: false, codigo: 'PIX_CONSULTA_FALHA', erro: 'Não foi possível consultar a cobrança PIX.' };
  }

  if (!row) {
    return { sucesso: false, codigo: 'PIX_COBRANCA_AUSENTE', erro: 'TXID não corresponde a cobrança PIX persistida.' };
  }

  if (entrada.consultarProvedor === true) {
    try {
      const status = await pixService.consultarStatus(txid, { db: entrada.db });
      if (String(status && status.status) === 'PAGO') {
        row = await pixService.obterCobrancaPorTxid(txid, entrada.db) || row;
        row.status = 'PAGO';
      } else {
        return {
          sucesso: false,
          codigo: 'PIX_NAO_PAGO',
          erro: `PIX não confirmado (status ${status && status.status}).`
        };
      }
    } catch (error) {
      return {
        sucesso: false,
        codigo: 'PIX_PROVEDOR_FALHA',
        erro: error && error.message ? error.message : 'Falha ao consultar provedor PIX.'
      };
    }
  }

  const status = String(row.status || '').toUpperCase();
  if (status !== 'PAGO') {
    return {
      sucesso: false,
      codigo: 'PIX_NAO_PAGO',
      erro: `PIX ainda não pago (status ${status || 'DESCONHECIDO'}).`
    };
  }

  const empresaId = Number(entrada.empresaId || 0);
  if (empresaId > 0 && row.empresa_id != null && Number(row.empresa_id) !== empresaId) {
    return { sucesso: false, codigo: 'PIX_EMPRESA_DIVERGENTE', erro: 'Cobrança PIX pertence a outra empresa.' };
  }

  if (!valoresCompativeis(row.valor, entrada.valor)) {
    return { sucesso: false, codigo: 'PIX_VALOR_DIVERGENTE', erro: 'Valor da cobrança PIX diverge do pagamento.' };
  }

  const vendaId = entrada.vendaId != null ? Number(entrada.vendaId) : null;
  if (row.venda_id != null && vendaId > 0 && Number(row.venda_id) !== vendaId) {
    return { sucesso: false, codigo: 'PIX_VENDA_DIVERGENTE', erro: 'Cobrança PIX vinculada a outra venda.' };
  }
  if (row.consumo_venda_id != null && vendaId > 0 && Number(row.consumo_venda_id) !== vendaId) {
    return { sucesso: false, codigo: 'PIX_JA_CONSUMIDO', erro: 'Cobrança PIX já utilizada em outra venda.' };
  }

  if (
    entrada.parcelaLocalId != null
    && row.parcela_local_id != null
    && Number(row.parcela_local_id) !== Number(entrada.parcelaLocalId)
  ) {
    return { sucesso: false, codigo: 'PIX_PARCELA_DIVERGENTE', erro: 'Cobrança PIX vinculada a outra parcela.' };
  }

  if (
    entrada.sessaoPagamento
    && row.sessao_pagamento
    && String(row.sessao_pagamento) !== String(entrada.sessaoPagamento)
  ) {
    return { sucesso: false, codigo: 'PIX_SESSAO_DIVERGENTE', erro: 'Cobrança PIX vinculada a outra sessão de pagamento.' };
  }

  if (
    entrada.chaveParcela
    && row.chave_parcela
    && String(row.chave_parcela) !== String(entrada.chaveParcela)
  ) {
    return { sucesso: false, codigo: 'PIX_CHAVE_DIVERGENTE', erro: 'Cobrança PIX não confere com a chave da parcela.' };
  }

  return {
    sucesso: true,
    cobranca: row,
    txid: String(row.txid),
    valor: arredondar(row.valor),
    empresa_id: row.empresa_id != null ? Number(row.empresa_id) : null,
    parcela_local_id: row.parcela_local_id != null ? Number(row.parcela_local_id) : null,
    sessao_pagamento: row.sessao_pagamento || null,
    chave_parcela: row.chave_parcela || null
  };
}

/**
 * Comprova lista de pagamentos PIX no fechamento.
 * Aceita somente TXID persistido e PAGO; rejeita TXID inventado pelo cliente.
 */
async function comprovarPagamentosPix(pagamentos, opcoes = {}) {
  const lista = Array.isArray(pagamentos) ? pagamentos : [];
  const empresaId = Number(opcoes.empresaId || 0);
  const vendaId = opcoes.vendaId != null ? Number(opcoes.vendaId) : null;
  const db = opcoes.db || null;
  const consultarProvedor = opcoes.consultarProvedor === true;
  const saida = [];
  const txidsUsados = new Set();

  for (const pagamento of lista) {
    if (!formaEhPix(pagamento && pagamento.forma_pagamento)) {
      saida.push({ ...pagamento });
      continue;
    }

    const tefId = pagamento.tef_transacao_id || (pagamento.tef && pagamento.tef.transacao_id);
    if (tefId) {
      saida.push({ ...pagamento });
      continue;
    }

    const txid = String(
      pagamento.pix_txid
      || pagamento.txid
      || (pagamento.pix && pagamento.pix.txid)
      || ''
    ).trim();

    if (!txid) {
      return {
        sucesso: false,
        codigo: 'PIX_SEM_EVIDENCIA',
        erro: 'PIX sem evidência persistida de pagamento. A venda não foi registrada.'
      };
    }

    if (txidsUsados.has(txid)) {
      return {
        sucesso: false,
        codigo: 'PIX_TXID_DUPLICADO',
        erro: 'A mesma cobrança PIX não pode quitar mais de um pagamento.'
      };
    }

    const prova = await comprovarCobrancaPixPago({
      txid,
      empresaId,
      valor: pagamento.valor,
      vendaId,
      parcelaLocalId: pagamento.parcela_local_id != null
        ? pagamento.parcela_local_id
        : pagamento.local_id,
      sessaoPagamento: pagamento.sessao_pagamento || null,
      chaveParcela: pagamento.chave_parcela || null,
      db,
      consultarProvedor
    });

    if (!prova.sucesso) {
      return prova;
    }

    txidsUsados.add(txid);
    saida.push({
      ...pagamento,
      pix_txid: prova.txid,
      pix_confirmado: true,
      confirmacao_efetiva: true,
      confirmacao_eletronica_comprovada: true,
      confirmacao_modalidade: 'pix',
      confirmacao_manual: 0,
      status: 'aprovado',
      status_autorizacao: 'aprovado',
      aprovado: true,
      _pix_comprovacao: {
        txid: prova.txid,
        valor: prova.valor,
        empresa_id: prova.empresa_id,
        cobranca_id: prova.cobranca && prova.cobranca.id
      }
    });
  }

  return { sucesso: true, pagamentos: saida };
}

async function marcarConsumoCobrancasPix(pagamentos, vendaId, db) {
  const idVenda = Number(vendaId);
  if (!(idVenda > 0)) return;
  for (const pagamento of pagamentos || []) {
    const txid = pagamento && (pagamento.pix_txid || (pagamento._pix_comprovacao && pagamento._pix_comprovacao.txid));
    if (!txid) continue;
    await pixService.marcarConsumoVenda(txid, idVenda, db);
  }
}

module.exports = {
  formaEhPix,
  comprovarCobrancaPixPago,
  comprovarPagamentosPix,
  marcarConsumoCobrancasPix,
  valoresCompativeis
};
