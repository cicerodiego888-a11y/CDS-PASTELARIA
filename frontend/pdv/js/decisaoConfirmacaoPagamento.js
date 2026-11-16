/**
 * CDS-PDV — decisão de registro/confirmação de parcelas.
 * TEF on: eletrônico via autorizador TEF.
 * TEF off: eletrônico informado + confirmação operacional no fechamento (sem chamar TEF).
 * PIX próprio: confirmação pela integração quando disponível.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DecisaoConfirmacaoPagamento = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  function normalizarForma(forma) {
    return String(forma || '')
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  const FORMAS_DINHEIRO = new Set(['dinheiro', 'especie', 'cash']);
  const FORMAS_PIX = new Set(['pix', 'pix_tef']);
  const FORMAS_CARTAO = new Set([
    'cartao', 'cartao_credito', 'cartao_debito', 'credito', 'debito', 'tef'
  ]);
  const FORMAS_VOUCHER = new Set([
    'voucher', 'vale_alimentacao', 'vale_refeicao', 'vale_presente', 'vale_combustivel'
  ]);

  function formaEhDinheiro(forma) {
    return FORMAS_DINHEIRO.has(normalizarForma(forma));
  }

  function formaEhPix(forma) {
    return FORMAS_PIX.has(normalizarForma(forma));
  }

  function formaEhCartao(forma) {
    return FORMAS_CARTAO.has(normalizarForma(forma));
  }

  function formaEhVoucher(forma) {
    return FORMAS_VOUCHER.has(normalizarForma(forma));
  }

  function formaExigeAutorizadorExterno(forma) {
    const f = normalizarForma(forma);
    return FORMAS_PIX.has(f) || FORMAS_CARTAO.has(f);
  }

  function decisaoEletronicoTefOff(forma, mecanismo, mensagem) {
    return {
      ok: true,
      forma,
      usaTef: false,
      modo: 'informado',
      statusInicial: 'informada',
      alocaSaldo: true,
      confirmaNoRegistro: false,
      tipoRecebimento: 'fiscal',
      confirmacaoModalidade: null,
      requerConfirmacaoPosterior: true,
      mecanismoConfirmacao: mecanismo,
      mensagem
    };
  }

  /**
   * Decide como a parcela pode ser registrada agora.
   * Eletrônico informado NÃO conta como recebido até confirmação (TEF, PIX próprio ou operacional TEF-off).
   */
  function resolverRegistroParcela(entrada = {}) {
    const forma = normalizarForma(entrada.forma);
    const tefOn = entrada.tefHabilitado === true;
    const pixProprio = entrada.pixIntegracaoHabilitada === true;

    if (!forma) {
      return {
        ok: false,
        codigo: 'FORMA_AUSENTE',
        mensagem: 'Informe a forma de pagamento.'
      };
    }

    if (formaEhDinheiro(forma)) {
      return {
        ok: true,
        forma,
        usaTef: false,
        modo: 'manual',
        statusInicial: 'informada',
        alocaSaldo: true,
        confirmaNoRegistro: true,
        tipoRecebimento: 'nao_fiscal',
        confirmacaoModalidade: 'manual',
        requerConfirmacaoPosterior: false
      };
    }

    if (formaEhPix(forma)) {
      if (tefOn) {
        return {
          ok: true,
          forma,
          usaTef: true,
          modo: 'tef',
          statusInicial: 'pendente',
          alocaSaldo: false,
          confirmaNoRegistro: false,
          tipoRecebimento: 'fiscal',
          confirmacaoModalidade: 'tef',
          requerConfirmacaoPosterior: false
        };
      }
      if (pixProprio) {
        return {
          ok: true,
          forma,
          usaTef: false,
          modo: 'pix_proprio',
          statusInicial: 'informada',
          alocaSaldo: true,
          confirmaNoRegistro: false,
          tipoRecebimento: 'fiscal',
          confirmacaoModalidade: null,
          requerConfirmacaoPosterior: true,
          mecanismoConfirmacao: 'pix_proprio',
          mensagem: 'PIX informado. Aguardando confirmação da integração PIX.'
        };
      }
      return decisaoEletronicoTefOff(
        forma,
        'confirmacao_operacional_externa',
        'PIX informado. Confirme o recebimento no fechamento (TEF desligado — sem pinpad do CDS).'
      );
    }

    if (formaEhCartao(forma)) {
      if (tefOn) {
        return {
          ok: true,
          forma,
          usaTef: true,
          modo: 'tef',
          statusInicial: 'pendente',
          alocaSaldo: false,
          confirmaNoRegistro: false,
          tipoRecebimento: 'fiscal',
          confirmacaoModalidade: 'tef',
          requerConfirmacaoPosterior: false
        };
      }
      return decisaoEletronicoTefOff(
        forma,
        'confirmacao_operacional_externa',
        'Cartão informado. Confirme o recebimento na maquininha no fechamento (TEF do CDS desligado).'
      );
    }

    if (formaEhVoucher(forma)) {
      return decisaoEletronicoTefOff(
        forma,
        'confirmacao_operacional_externa',
        'Voucher informado. Confirmação exigida no fechamento.'
      );
    }

    return {
      ok: true,
      forma,
      usaTef: false,
      modo: 'manual',
      statusInicial: 'informada',
      alocaSaldo: true,
      confirmaNoRegistro: true,
      tipoRecebimento: 'nao_fiscal',
      confirmacaoModalidade: 'manual',
      requerConfirmacaoPosterior: false
    };
  }

  function modoConfirmacaoDireta(forma, contexto = {}) {
    const decisao = resolverRegistroParcela({
      forma,
      tefHabilitado: contexto.tefHabilitado,
      pixIntegracaoHabilitada: contexto.pixIntegracaoHabilitada
    });
    if (!decisao.ok && decisao.modo === 'bloqueado') return 'indisponivel';
    if (decisao.usaTef) return 'tef';
    if (decisao.modo === 'pix_proprio') return 'pix_proprio';
    if (decisao.modo === 'informado') return 'informado';
    return 'manual';
  }

  function parcelaAlocaSaldo(parcela) {
    if (!parcela || !(Number(parcela.valor) > 0)) return false;
    const status = String(parcela.status_autorizacao || '').toLowerCase();
    if (['pendente', 'rejeitada', 'rejeitado', 'falha', 'negado', 'negada', 'timeout', 'erro'].includes(status)) {
      return false;
    }
    return true;
  }

  function parcelaRecebimentoConfirmado(parcela) {
    if (!parcela || !(Number(parcela.valor) > 0)) return false;
    const status = String(parcela.status_autorizacao || '').toLowerCase();
    if (['pendente', 'rejeitada', 'rejeitado', 'falha', 'negado', 'negada', 'timeout', 'erro'].includes(status)) {
      return false;
    }
    if (formaEhDinheiro(parcela.forma_pagamento)) {
      return status === 'informada' || status === 'aprovada' || status === 'aprovado' || status === '';
    }
    if (
      (parcela.confirmacao_efetiva === true || parcela.pix_confirmado === true)
      && String(parcela.pix_txid || parcela.tef_transacao_id || '').trim() !== ''
    ) {
      return status === 'aprovada' || status === 'aprovado' || status === 'confirmada' || status === 'informada';
    }
    const id = parcela.tef_transacao_id || (parcela.tef && parcela.tef.transacao_id);
    if (id && (status === 'aprovada' || status === 'aprovado' || parcela.aprovado === true)) {
      return parcela.aprovado !== false;
    }
    // Confirmação operacional explícita (TEF off) carimbada no fechamento.
    if (
      parcela.confirmacao_manual === 1
      || parcela.confirmacao_manual === true
      || parcela.confirmacao_modalidade === 'manual'
      || parcela.confirmacao_operacional_externa === true
    ) {
      return status === 'informada' || status === 'aprovada' || status === 'aprovado' || status === 'confirmada' || status === '';
    }
    return false;
  }

  return {
    normalizarForma,
    formaEhDinheiro,
    formaEhPix,
    formaEhCartao,
    formaEhVoucher,
    formaExigeAutorizadorExterno,
    resolverRegistroParcela,
    modoConfirmacaoDireta,
    parcelaAlocaSaldo,
    parcelaRecebimentoConfirmado
  };
}));
