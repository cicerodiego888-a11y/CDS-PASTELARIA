/**
 * Gateway local exclusivo do callback OAuth Mercado Pago.
 * Escuta só 127.0.0.1. Não serve o ERP.
 * Bootstrap alinhado ao ERP: DB_DIR + banco oficial + MBC_SECRET_STORE_KEY + Redirect URI.
 * @module mercado-pago/oauth-callback-server
 */
'use strict';

const http = require('http');
const express = require('express');
const { obterMotorBancario } = require('../motores/bancario/MotorBancarioService');
const { montarEventoOperacaoMbc } = require('../motores/bancario/contracts/observabilidadeMbc');
const { sanitizarObjetoMbc } = require('../motores/bancario/contracts/sanitizarMbc');
const { ERROS } = require('../motores/bancario/contracts/constantes');
const {
  bootstrapAmbienteOperacionalMbc
} = require('../motores/bancario/secrets/bootstrapAmbienteOperacionalMbc');

const PORTA_PADRAO = 3010;
const HOST_LOCAL = '127.0.0.1';
const ROTA_CALLBACK = '/api/bancario/mercado-pago/oauth/callback';
const MSG_OK = 'Autorização concluída. Você pode retornar ao CDS.';
const MSG_FALHA = 'Não foi possível concluir a autorização.';
const MSG_NEGADO = 'Autorização não concluída.';
const MSG_INVALIDA = 'Autorização inválida.';

function html(texto) {
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Autorização</title></head>'
    + '<body><p>' + texto + '</p></body></html>';
}

function motorPadrao(deps) {
  if (deps.obterMotorBancario) return deps.obterMotorBancario();
  const db = deps.db || require('../database');
  return obterMotorBancario({ db });
}

function statusAmbiente(deps = {}) {
  if (deps.bootstrapStatus) return deps.bootstrapStatus;
  // Harness/testes: motor injetado traz SecretStore; não mutar process.env nem bloquear redirect aqui.
  if (typeof deps.obterMotorBancario === 'function') {
    const redirect = require('./redirectUri').statusRedirectUriOficial(deps.env || process.env);
    const redirectOk = !deps.env || redirect.status === 'CONFIGURADO';
    return {
      ok: true,
      db_dir: (deps.env && deps.env.DB_DIR) || process.env.DB_DIR || null,
      db_path: null,
      db_configurado: true,
      secret_store_disponivel: true,
      secret_store_origem: 'injetado',
      redirect_uri_configurado: deps.env ? redirectOk : true,
      redirect_uri_status: deps.env ? redirect.status : 'HARNESS',
      erros: []
    };
  }
  return bootstrapAmbienteOperacionalMbc({
    env: deps.env || process.env,
    exigirRedirectUri: true
  });
}

function codigoErroSeguro(code) {
  if (code == null || code === '') return null;
  const c = String(code);
  // Evita mascaramento do sanitizer em códigos que contêm "SECRET"
  if (c === ERROS.SECRET_KEY_AUSENTE || /SECRET_KEY/i.test(c)) return 'MBC_COFRE_INDISPONIVEL';
  return c;
}

function registrarCallback(evento, deps) {
  const limpo = sanitizarObjetoMbc({
    ...montarEventoOperacaoMbc({
      operacao: 'mercado-pago-oauth-callback',
      provider: 'MERCADO_PAGO',
      ambiente: evento.ambiente || null,
      empresa_id: evento.empresa_id != null ? evento.empresa_id : null,
      resultado: evento.resultado,
      status: evento.resultado,
      duracao_ms: evento.duracao_ms
    }),
    consentimento_id: evento.consentimento_id != null ? evento.consentimento_id : null,
    config_id: evento.config_id != null ? evento.config_id : null,
    codigo_erro: codigoErroSeguro(evento.codigo_erro),
    status_http: evento.status_http != null ? evento.status_http : null,
    erro_provider: evento.erro_provider || null,
    code: evento.code != null ? '[REDACTED]' : undefined,
    token: evento.token != null ? '[REDACTED]' : undefined,
    state: evento.state != null ? '[REDACTED]' : undefined,
    code_verifier: evento.code_verifier != null ? '[REDACTED]' : undefined,
    client_secret: evento.client_secret != null ? '[REDACTED]' : undefined
  });
  if (typeof deps.logger === 'function') deps.logger(limpo);
  else if (evento.resultado === 'invalido' || evento.resultado === 'falha') {
    try {
      console.warn('[MBC][oauth-callback]', JSON.stringify(limpo));
    } catch (_) { /* ignore */ }
  }
  return limpo;
}

function criarAppCallbackMercadoPago(deps = {}) {
  const app = express();
  app.disable('x-powered-by');
  const boot = statusAmbiente(deps);

  app.get('/health', (_req, res) => {
    const atual = statusAmbiente(deps);
    return res.json({
      status: atual.ok ? 'ok' : 'degraded',
      servico: 'callback-oauth-mercado-pago',
      db_configurado: !!atual.db_configurado,
      cofre_disponivel: !!atual.secret_store_disponivel,
      redirect_uri_configurado: !!atual.redirect_uri_configurado
    });
  });

  app.get(ROTA_CALLBACK, async (req, res) => {
    const inicio = Date.now();
    const q = req.query || {};
    const state = String(q.state || '').trim();
    const queryNucleo = {};
    if (q.code != null) queryNucleo.code = String(q.code);
    if (q.error != null) queryNucleo.error = String(q.error);
    if (q.error_description != null) queryNucleo.error_description = String(q.error_description);

    if (!state) {
      registrarCallback({ resultado: 'invalido', duracao_ms: Date.now() - inicio }, deps);
      return res.status(400).type('html').send(html(MSG_INVALIDA));
    }

    const ambienteAtual = statusAmbiente(deps);
    if (!ambienteAtual.secret_store_disponivel) {
      registrarCallback({
        resultado: 'falha',
        codigo_erro: 'MBC_SECRET_KEY_AUSENTE',
        status_http: 503,
        duracao_ms: Date.now() - inicio,
        state
      }, deps);
      return res.status(503).type('html').send(html(MSG_FALHA));
    }
    if (!ambienteAtual.redirect_uri_configurado) {
      registrarCallback({
        resultado: 'falha',
        codigo_erro: 'MBC_AUTORIZACAO_INVALIDA',
        erro_provider: 'redirect_uri_ausente',
        status_http: 409,
        duracao_ms: Date.now() - inicio,
        state
      }, deps);
      return res.status(409).type('html').send(html(MSG_FALHA));
    }

    try {
      const motor = motorPadrao(deps);
      const item = await motor.processarCallbackConsentimento({
        state,
        query: queryNucleo
      });
      const ok = item && item.status === 'AUTORIZADO';
      const negado = item && item.status === 'NEGADO';
      registrarCallback({
        resultado: ok ? 'sucesso' : (negado ? 'negado' : 'falha'),
        empresa_id: item && item.empresa_id,
        consentimento_id: item && item.id,
        config_id: item && item.config_integracao_id,
        duracao_ms: Date.now() - inicio,
        code: q.code,
        state,
        token: q.access_token
      }, deps);
      if (ok) {
        return res.status(200).type('html').send(html(MSG_OK));
      }
      if (negado) {
        return res.status(400).type('html').send(html(MSG_NEGADO));
      }
      return res.status(400).type('html').send(html(MSG_FALHA));
    } catch (err) {
      registrarCallback({
        resultado: 'falha',
        codigo_erro: err && err.code ? String(err.code) : 'MBC_ERRO',
        status_http: err && err.statusCode != null ? err.statusCode : 400,
        erro_provider: err && err.categoria ? String(err.categoria) : null,
        duracao_ms: Date.now() - inicio,
        code: q.code,
        state
      }, deps);
      // Mensagem segura ao usuário; state inválido permanece "Autorização inválida."
      const msgUsuario = (err && err.code === 'MBC_SECRET_KEY_AUSENTE')
        ? MSG_FALHA
        : MSG_INVALIDA;
      return res.status(400).type('html').send(html(msgUsuario));
    }
  });

  app.use((_req, res) => {
    return res.status(404).type('html').send(html('Não encontrado.'));
  });

  app.locals.mbcBootstrap = boot;
  return app;
}

function portaCallback(env = process.env, override) {
  if (override != null) return Number(override);
  const n = Number(env.MERCADO_PAGO_OAUTH_CALLBACK_PORT || PORTA_PADRAO);
  return Number.isFinite(n) && n > 0 ? n : PORTA_PADRAO;
}

function iniciarServidorCallback(deps = {}) {
  const env = deps.env || process.env;
  const harness = typeof deps.obterMotorBancario === 'function' || deps.bootstrapStatus != null;
  const boot = deps.bootstrapStatus || bootstrapAmbienteOperacionalMbc({
    env,
    dbDir: deps.dbDir,
    exigirRedirectUri: harness ? false : (deps.exigirRedirectUri !== false)
  });
  if (!harness && !boot.secret_store_disponivel) {
    return Promise.reject(new Error(
      'Gateway OAuth indisponível: armazenamento seguro de credenciais bancárias indisponível.'
    ));
  }
  if (!harness && deps.exigirRedirectUri !== false && !boot.redirect_uri_configurado) {
    return Promise.reject(new Error(
      'Gateway OAuth indisponível: defina MERCADO_PAGO_OAUTH_REDIRECT_URI (HTTPS público).'
    ));
  }

  const app = criarAppCallbackMercadoPago({
    ...deps,
    env,
    bootstrapStatus: harness && !deps.bootstrapStatus
      ? {
        ok: true,
        db_configurado: true,
        secret_store_disponivel: true,
        redirect_uri_configurado: true
      }
      : boot
  });
  const port = portaCallback(env, deps.port);
  const server = http.createServer(app);
  server.mbcBootstrap = boot;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST_LOCAL, () => {
      resolve(server);
    });
  });
}

if (require.main === module) {
  iniciarServidorCallback().then((server) => {
    const addr = server.address();
    const boot = server.mbcBootstrap || {};
    console.log('Callback OAuth Mercado Pago em http://' + addr.address + ':' + addr.port + ROTA_CALLBACK);
    console.log('[MBC] Gateway DB_DIR configurado; secret_store='
      + (boot.secret_store_disponivel ? 'ok' : 'ausente')
      + '; redirect_uri='
      + (boot.redirect_uri_configurado ? 'ok' : 'ausente'));
  }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  PORTA_PADRAO,
  HOST_LOCAL,
  ROTA_CALLBACK,
  MSG_OK,
  MSG_FALHA,
  MSG_NEGADO,
  MSG_INVALIDA,
  criarAppCallbackMercadoPago,
  iniciarServidorCallback,
  portaCallback,
  statusAmbiente,
  statusRedirectUriOficial: require('./redirectUri').statusRedirectUriOficial
};
