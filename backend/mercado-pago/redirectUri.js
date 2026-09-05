/**
 * Redirect URI oficial do Mercado Pago. Sem valor padrão inventado.
 * @module mercado-pago/redirectUri
 */
'use strict';

function statusRedirectUriOficial(env = process.env) {
  const raw = env.MERCADO_PAGO_OAUTH_REDIRECT_URI;
  if (raw == null || !String(raw).trim()) {
    return { status: 'NAO_CONFIGURADO', uri: null };
  }
  const uri = String(raw).trim();
  if (/^http:\/\//i.test(uri) || /localhost/i.test(uri)) {
    return { status: 'NAO_CONFIGURADO', uri: null };
  }
  if (!/^https:\/\//i.test(uri)) {
    return { status: 'NAO_CONFIGURADO', uri: null };
  }
  return { status: 'CONFIGURADO', uri };
}

module.exports = { statusRedirectUriOficial };
