/**
 * Gateway local exclusivo do callback OAuth Mercado Pago.
 * Escuta só 127.0.0.1. Não serve o ERP.
 * @module mercado-pago/oauth-callback-server
 */
'use strict';

const http = require('http');
const express = require('express');
const { obterMotorBancario } = require('../motores/bancario/MotorBancarioService');
const { montarEventoOperacaoMbc } = require('../motores/bancario/contracts/observabilidadeMbc');
const { sanitizarObjetoMbc } = require('../motores/bancario/contracts/sanitizarMbc');

const PORTA_PADRAO = 3010;
const HOST_LOCAL = '127.0.0.1';
const ROTA_CALLBACK = '/api/bancario/mercado-pago/oauth/callback';
const MSG_OK = 'Autorização recebida. Você pode retornar ao CDS.';
const MSG_FALHA = 'Não foi possível concluir a autorização.';
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
    code: evento.code != null ? '[REDACTED]' : undefined,
    token: evento.token != null ? '[REDACTED]' : undefined,
    state: evento.state != null ? '[REDACTED]' : undefined,
    code_verifier: evento.code_verifier != null ? '[REDACTED]' : undefined,
    client_secret: evento.client_secret != null ? '[REDACTED]' : undefined
  });
  if (typeof deps.logger === 'function') deps.logger(limpo);
  return limpo;
}

function criarAppCallbackMercadoPago(deps = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    return res.json({ status: 'ok', servico: 'callback-oauth-mercado-pago' });
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

    try {
      const motor = motorPadrao(deps);
      const item = await motor.processarCallbackConsentimento({
        state,
        query: queryNucleo
      });
      const ok = item && item.status === 'AUTORIZADO';
      registrarCallback({
        resultado: ok ? 'sucesso' : 'falha',
        empresa_id: item && item.empresa_id,
        consentimento_id: item && item.id,
        duracao_ms: Date.now() - inicio,
        code: q.code,
        state,
        token: q.access_token
      }, deps);
      if (ok) {
        return res.status(200).type('html').send(html(MSG_OK));
      }
      return res.status(400).type('html').send(html(MSG_FALHA));
    } catch (_err) {
      registrarCallback({
        resultado: 'invalido',
        duracao_ms: Date.now() - inicio,
        code: q.code,
        state
      }, deps);
      return res.status(400).type('html').send(html(MSG_INVALIDA));
    }
  });

  app.use((_req, res) => {
    return res.status(404).type('html').send(html('Não encontrado.'));
  });

  return app;
}

function portaCallback(env = process.env, override) {
  if (override != null) return Number(override);
  const n = Number(env.MERCADO_PAGO_OAUTH_CALLBACK_PORT || PORTA_PADRAO);
  return Number.isFinite(n) && n > 0 ? n : PORTA_PADRAO;
}

function iniciarServidorCallback(deps = {}) {
  const app = criarAppCallbackMercadoPago(deps);
  const port = portaCallback(deps.env || process.env, deps.port);
  const server = http.createServer(app);
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
    console.log('Callback OAuth Mercado Pago em http://' + addr.address + ':' + addr.port + ROTA_CALLBACK);
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
  MSG_INVALIDA,
  criarAppCallbackMercadoPago,
  iniciarServidorCallback,
  portaCallback,
  statusRedirectUriOficial: require('./redirectUri').statusRedirectUriOficial
};
