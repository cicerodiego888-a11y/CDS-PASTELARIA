/**
 * OAuth real Mercado Pago (MBC-15).
 * Reutiliza consentimento MBC-06, PKCE, Redirect URI e SecretStore.
 * Tokens somente no ISecretStore — nunca em SQLite plaintext nem frontend.
 * @module motores/bancario/services/MercadoPagoOAuthService
 */
'use strict';

const {
  ERROS,
  CODIGO_PROVIDER,
  STATUS_CONSENTIMENTO,
  erroMbc
} = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { statusRedirectUriOficial } = require('../../../mercado-pago/redirectUri');
const { obterSecretStore } = require('../secrets/EncryptedLocalSecretStore');
const ConfiguracaoIntegracaoBancariaService = require('./ConfiguracaoIntegracaoBancariaService');
const ConsentimentoOpenFinanceService = require('./ConsentimentoOpenFinanceService');
const ContaBancariaService = require('./ContaBancariaService');

const STATUS_OAUTH = Object.freeze({
  NAO_CONFIGURADO: 'NAO_CONFIGURADO',
  CREDENCIAIS_CONFIGURADAS: 'CREDENCIAIS_CONFIGURADAS',
  AGUARDANDO_AUTORIZACAO: 'AGUARDANDO_AUTORIZACAO',
  AUTORIZADO: 'AUTORIZADO',
  NEGADO: 'NEGADO',
  TOKEN_EXPIRADO: 'TOKEN_EXPIRADO',
  ERRO: 'ERRO'
});

function chaveOauthMercadoPago(configId) {
  return 'mbc.oauth.mercadopago.' + Number(configId);
}

function depsDe(params) {
  return {
    db: params.db,
    secretStore: params.secretStore || obterSecretStore({ db: params.db }),
    registry: params.registry,
    env: params.env || process.env,
    fetchImpl: params.fetchImpl || null
  };
}

async function lerPayloadOauth(secretStore, configId) {
  if (!secretStore || configId == null) return null;
  const raw = await secretStore.get(chaveOauthMercadoPago(configId));
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return null;
  }
}

async function gravarPayloadOauth(secretStore, configId, payload) {
  const seguro = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    expires_at: payload.expires_at || null,
    expires_in: payload.expires_in != null ? payload.expires_in : null,
    token_type: payload.token_type || null,
    scope: payload.scope || null,
    user_id: payload.user_id != null ? payload.user_id : null,
    live_mode: typeof payload.live_mode === 'boolean' ? payload.live_mode : null
  };
  await secretStore.set(chaveOauthMercadoPago(configId), JSON.stringify(seguro));
  return true;
}

async function apagarPayloadOauth(secretStore, configId) {
  if (!secretStore || configId == null) return false;
  await secretStore.delete(chaveOauthMercadoPago(configId));
  return true;
}

function tokenExpirado(payload, agoraMs = Date.now()) {
  if (!payload || !payload.expires_at) return false;
  return new Date(payload.expires_at).getTime() <= agoraMs;
}

async function carregarConfig(params) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const deps = depsDe(params);
  const cfg = await ConfiguracaoIntegracaoBancariaService.obterNoContexto({
    db: deps.db,
    secretStore: deps.secretStore,
    empresaId,
    id: params.id
  });
  return { cfg, empresaId, ...deps };
}

async function exigirContaAtiva(db, empresaId, contaId) {
  const conta = await ContaBancariaService.obterNoContexto({ db, empresaId, id: contaId });
  if (!conta.ativa) {
    throw erroMbc(ERROS.CONTA_INATIVA, 'Conta bancária está inativa.', 409);
  }
  return conta;
}

async function exigirCredenciais(params, cfg) {
  const cred = await ConfiguracaoIntegracaoBancariaService.obterCredenciaisProvider({
    db: params.db,
    secretStore: params.secretStore,
    empresaId: params.empresaId,
    id: cfg.id
  });
  const clientId = String((cred && cred.client_id) || cfg.aplicacao_ref || '').trim();
  const clientSecret = cred && cred.client_secret ? String(cred.client_secret) : '';
  if (!clientId) {
    throw erroMbc(ERROS.CREDENCIAL_CLIENT_ID_OBRIGATORIO, 'Application ID / Client ID é obrigatório.', 400);
  }
  if (!clientSecret) {
    throw erroMbc(ERROS.CREDENCIAL_SECRET_OBRIGATORIO, 'Client Secret é obrigatório para autorizar.', 400);
  }
  return { client_id: clientId, client_secret: clientSecret };
}

async function iniciar(params = {}) {
  const { cfg, empresaId, db, secretStore, env, registry } = await carregarConfig(params);
  if (!cfg.ativo) {
    throw erroMbc(ERROS.CONFIG_INATIVA, 'Configuração de integração está inativa.', 409);
  }
  if (cfg.provider !== CODIGO_PROVIDER.OPEN_FINANCE_REAL) {
    throw erroMbc(
      ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL,
      'OAuth Mercado Pago exige provider OPEN_FINANCE_REAL.',
      409
    );
  }
  await exigirContaAtiva(db, empresaId, cfg.conta_bancaria_id);
  await exigirCredenciais({ db, secretStore, empresaId }, cfg);

  const redirect = statusRedirectUriOficial(env);
  if (redirect.status !== 'CONFIGURADO' || !redirect.uri) {
    throw erroMbc(
      ERROS.AUTORIZACAO_INVALIDA,
      'Redirect URI oficial não configurado. Defina MERCADO_PAGO_OAUTH_REDIRECT_URI (HTTPS).',
      409
    );
  }

  const out = await ConsentimentoOpenFinanceService.iniciar({
    db,
    secretStore,
    registry: registry || params.registry,
    empresaId,
    conta_bancaria_id: cfg.conta_bancaria_id,
    provider: CODIGO_PROVIDER.OPEN_FINANCE_REAL,
    usuarioId: params.usuarioId,
    env,
    fetchImpl: params.fetchImpl
  });

  return {
    ok: true,
    authorization_url: out.authorization_url,
    consentimento_id: out.consentimento_id,
    status: out.status
  };
}

async function obterStatus(params = {}) {
  const { cfg, empresaId, db, secretStore } = await carregarConfig(params);
  const credStatus = await ConfiguracaoIntegracaoBancariaService.obterStatusCredenciais({
    db,
    secretStore,
    empresaId,
    id: cfg.id
  });
  const payload = await lerPayloadOauth(secretStore, cfg.id);
  const consentimentos = await ConsentimentoOpenFinanceService.listar({
    db,
    secretStore,
    empresaId,
    conta_bancaria_id: cfg.conta_bancaria_id,
    provider: CODIGO_PROVIDER.OPEN_FINANCE_REAL
  });
  const ultimo = consentimentos[0] || null;

  let status = STATUS_OAUTH.NAO_CONFIGURADO;
  if (!credStatus.client_id_configurado || !credStatus.secret_configurado) {
    status = STATUS_OAUTH.NAO_CONFIGURADO;
  } else if (payload && payload.access_token && !tokenExpirado(payload)) {
    status = STATUS_OAUTH.AUTORIZADO;
  } else if (payload && payload.access_token && tokenExpirado(payload)) {
    status = STATUS_OAUTH.TOKEN_EXPIRADO;
  } else if (ultimo && ultimo.status === STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO) {
    status = STATUS_OAUTH.AGUARDANDO_AUTORIZACAO;
  } else if (ultimo && ultimo.status === STATUS_CONSENTIMENTO.INICIADO) {
    status = STATUS_OAUTH.AGUARDANDO_AUTORIZACAO;
  } else if (ultimo && ultimo.status === STATUS_CONSENTIMENTO.NEGADO) {
    status = STATUS_OAUTH.NEGADO;
  } else if (ultimo && ultimo.status === STATUS_CONSENTIMENTO.ERRO) {
    status = STATUS_OAUTH.ERRO;
  } else if (ultimo && ultimo.status === STATUS_CONSENTIMENTO.AUTORIZADO && (!payload || !payload.access_token)) {
    status = STATUS_OAUTH.ERRO;
  } else {
    status = STATUS_OAUTH.CREDENCIAIS_CONFIGURADAS;
  }

  return {
    status,
    scope: payload && payload.scope ? payload.scope : null,
    expires_at: payload && payload.expires_at ? payload.expires_at : null,
    live_mode: payload && typeof payload.live_mode === 'boolean' ? payload.live_mode : null,
    autorizado: status === STATUS_OAUTH.AUTORIZADO,
    client_id_configurado: !!credStatus.client_id_configurado,
    secret_configurado: !!credStatus.secret_configurado,
    consentimento_status: ultimo ? ultimo.status : null
  };
}

/**
 * Remove tokens locais e invalida consentimento operacional.
 * Não afirma revogação remota no Mercado Pago.
 */
async function desconectar(params = {}) {
  const { cfg, empresaId, db, secretStore, registry } = await carregarConfig(params);
  await apagarPayloadOauth(secretStore, cfg.id);

  const lista = await ConsentimentoOpenFinanceService.listar({
    db,
    secretStore,
    empresaId,
    conta_bancaria_id: cfg.conta_bancaria_id,
    provider: CODIGO_PROVIDER.OPEN_FINANCE_REAL
  });
  for (const c of lista) {
    if ([
      STATUS_CONSENTIMENTO.AUTORIZADO,
      STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO,
      STATUS_CONSENTIMENTO.INICIADO
    ].includes(c.status)) {
      try {
        await ConsentimentoOpenFinanceService.revogar({
          db,
          secretStore,
          registry: registry || params.registry,
          empresaId,
          id: c.id
        });
      } catch (_) {
        /* ignore */
      }
    }
  }

  return obterStatus({ ...params, db, secretStore, empresaId, id: cfg.id });
}

async function persistirTokensAposCallback(params = {}) {
  const { secretStore, configId, tokens } = params;
  if (!secretStore || configId == null || !tokens || !tokens.access_token) {
    throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Não foi possível concluir a autorização.', 400);
  }
  await gravarPayloadOauth(secretStore, configId, tokens);
  return true;
}

module.exports = {
  STATUS_OAUTH,
  chaveOauthMercadoPago,
  iniciar,
  obterStatus,
  desconectar,
  lerPayloadOauth,
  gravarPayloadOauth,
  apagarPayloadOauth,
  persistirTokensAposCallback,
  tokenExpirado
};
