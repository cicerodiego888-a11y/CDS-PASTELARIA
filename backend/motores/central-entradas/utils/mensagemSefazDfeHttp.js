/**
 * Mensagens de transporte DistDFe (HTTP da AN) para a Central.
 * Não troca ambiente, não escolhe outra URL, não usa certificado de outra empresa.
 */

/**
 * @param {string} mensagem
 * @param {{ ambiente?: number|string }} [ctx]
 * @returns {string}
 */
function enriquecerMensagemSefazDfeHttp(mensagem, ctx = {}) {
  const m = String(mensagem || '').trim();
  if (!m) return m;

  const ambienteHom = Number(ctx.ambiente) === 2
    || /hom1\.nfe\.fazenda\.gov\.br/i.test(m);
  const jaOrientada = /tpAmb=2|ambiente Homologação|Notas de entrada reais/i.test(m);

  if (/HTTP 403/i.test(m) && ambienteHom && !jaOrientada) {
    return `${m} A empresa está no ambiente Homologação (tpAmb=2). `
      + 'O web service NFeDistribuicaoDFe da AN em homologação frequentemente responde 403 HTML '
      + '(serviço restrito ou certificado recusado no TLS). '
      + 'Notas de entrada reais exigem ambiente Produção (1) na configuração fiscal desta empresa.';
  }

  if (/HTTP 403/i.test(m) && !jaOrientada) {
    return `${m} HTTP 403 na Distribuição DF-e costuma indicar certificado A1 não enviado no TLS, `
      + 'certificado vencido, ou recusa do Ambiente Nacional.';
  }

  return m;
}

/**
 * @param {string} mensagem
 * @returns {string}
 */
function codigoErroSincronizacaoDfe(mensagem) {
  const t = String(mensagem || '');
  if (/certificado/i.test(t)) return 'CERTIFICADO';
  if (/cnpj/i.test(t) && /não configurado/i.test(t)) return 'CNPJ';
  if (/timeout|ECONN/i.test(t)) return 'SEFAZ';
  return 'SEFAZ';
}

module.exports = {
  enriquecerMensagemSefazDfeHttp,
  codigoErroSincronizacaoDfe
};
