/**
 * API MBC — instituições, contas, transações, conciliação, config e autorização.
 * Sem SQL de negócio na rota. Sem secrets no JSON.
 */
'use strict';

const express = require('express');
const {
  resolverContextoBancario,
  resolverEmpresaFiltroLeitura,
  resolverEmpresaEscritaConta,
  statusDeErroEmpresaBancario
} = require('../motores/bancario/BancarioEmpresaContextoService');
const { obterMotorBancario } = require('../motores/bancario/MotorBancarioService');

function motorDe(req, deps) {
  const db = deps.db || require('../database');
  return deps.obterMotorBancario ? deps.obterMotorBancario({ db }) : obterMotorBancario({ db });
}

async function resolverContexto(req, deps) {
  const db = deps.db || require('../database');
  if (typeof deps.resolverContextoBancario === 'function') {
    return deps.resolverContextoBancario(req, { db, ...deps });
  }
  return resolverContextoBancario(req, { db, ...deps });
}

function responderErro(res, err) {
  const { classificarErroProvider } = require('../motores/bancario/contracts/constantes');
  const { sanitizarValorMbc } = require('../motores/bancario/contracts/sanitizarMbc');
  const status = err.statusCode || statusDeErroEmpresaBancario(err) || 500;
  const body = {
    error: sanitizarValorMbc(err.message || 'Erro no Motor Bancário.'),
    code: err.code || 'MBC_ERRO',
    categoria: err.categoria || classificarErroProvider(err)
  };
  return res.status(status).json(body);
}

async function comContexto(req, res, deps, fn) {
  try {
    let ctx;
    try {
      ctx = await resolverContexto(req, deps);
    } catch (empErr) {
      return res.status(statusDeErroEmpresaBancario(empErr)).json({
        error: empErr.message,
        code: empErr.code,
        empresa_id: empErr.empresa_id != null ? empErr.empresa_id : undefined
      });
    }
    const motor = motorDe(req, deps);
    return await fn(motor, ctx);
  } catch (err) {
    return responderErro(res, err);
  }
}

async function empresaIdDaConta(motor, ctx, contaId) {
  if (ctx.visao === 'todas') {
    const conta = await motor.obterConta({ id: contaId, empresaIds: ctx.empresaIds });
    return conta.empresa_id;
  }
  return ctx.empresaId;
}

async function comEmpresa(req, res, deps, fn) {
  return comContexto(req, res, deps, async (motor, ctx) => {
    const contaId = req.params && req.params.id;
    const empresaId = contaId != null
      ? await empresaIdDaConta(motor, ctx, contaId)
      : ctx.empresaId;
    return fn(motor, empresaId, ctx);
  });
}

async function empresaIdDaConfig(motor, ctx, configId) {
  if (ctx.visao === 'todas') {
    const cfg = await motor.obterConfiguracaoIntegracao({ id: configId, empresaIds: ctx.empresaIds });
    return cfg.empresa_id;
  }
  return ctx.empresaId;
}

async function comConfiguracao(req, res, deps, fn) {
  return comContexto(req, res, deps, async (motor, ctx) => {
    const empresaId = await empresaIdDaConfig(motor, ctx, req.params.id);
    return fn(motor, empresaId, ctx);
  });
}

function criarRouter(deps = {}) {
  const router = express.Router();
  const perm = typeof deps.auth === 'function'
    ? deps.auth
    : require('../middleware/auth').verificarPermissaoEspecifica('financeiro');

  router.get('/instituicoes', perm, async (req, res) => {
    try {
      const lista = await motorDe(req, deps).listarInstituicoes();
      return res.json({ instituicoes: lista });
    } catch (err) {
      return responderErro(res, err);
    }
  });

  router.get('/instituicoes/:id', perm, async (req, res) => {
    try {
      const inst = await motorDe(req, deps).obterInstituicao({ id: req.params.id });
      return res.json(inst);
    } catch (err) {
      return responderErro(res, err);
    }
  });

  router.post('/instituicoes', perm, async (req, res) => {
    try {
      const inst = await motorDe(req, deps).criarInstituicao(req.body || {});
      return res.status(201).json(inst);
    } catch (err) {
      return responderErro(res, err);
    }
  });

  router.put('/instituicoes/:id', perm, async (req, res) => {
    try {
      const inst = await motorDe(req, deps).atualizarInstituicao({ id: req.params.id, ...(req.body || {}) });
      return res.json(inst);
    } catch (err) {
      return responderErro(res, err);
    }
  });

  router.delete('/instituicoes/:id', perm, async (req, res) => {
    try {
      const out = await motorDe(req, deps).excluirInstituicao({ id: req.params.id });
      return res.json(out);
    } catch (err) {
      return responderErro(res, err);
    }
  });

  router.get('/contas', perm, (req, res) => comContexto(req, res, deps, async (motor, ctx) => {
    const filtro = resolverEmpresaFiltroLeitura(ctx, req);
    const contas = filtro.empresaId != null
      ? await motor.listarContas({ empresaId: filtro.empresaId })
      : await motor.listarContas({ empresaIds: filtro.empresaIds });
    const payload = { visao: ctx.visao, contas };
    if (ctx.visao === 'empresa') payload.empresa_id = ctx.empresaId;
    return res.json(payload);
  }));

  router.get('/contas/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const conta = await motor.obterConta({ empresaId, id: req.params.id });
    return res.json(conta);
  }));

  router.post('/contas', perm, (req, res) => comContexto(req, res, deps, async (motor, ctx) => {
    const empresaId = resolverEmpresaEscritaConta(ctx, req);
    const body = req.body || {};
    const conta = await motor.criarConta({
      ...body,
      empresaId,
      empresa_id: empresaId
    });
    return res.status(201).json(conta);
  }));

  router.put('/contas/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = Object.assign({}, req.body || {});
    delete body.empresa_id;
    delete body.empresaId;
    const conta = await motor.atualizarConta({
      ...body,
      id: req.params.id,
      empresaId,
      empresa_id: empresaId
    });
    return res.json(conta);
  }));

  router.patch('/contas/:id/ativar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const conta = await motor.ativarConta({ empresaId, id: req.params.id });
    return res.json(conta);
  }));

  router.patch('/contas/:id/desativar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const conta = await motor.desativarConta({ empresaId, id: req.params.id });
    return res.json(conta);
  }));

  router.patch('/contas/:id/principal', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const conta = await motor.definirContaPrincipal({ empresaId, id: req.params.id });
    return res.json(conta);
  }));

  router.delete('/contas/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.excluirConta({ empresaId, id: req.params.id });
    return res.json(out);
  }));

  router.get('/contas/:id/transacoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const transacoes = await motor.listarTransacoes({
      empresaId,
      conta_bancaria_id: req.params.id,
      data_inicio: q.data_inicio,
      data_fim: q.data_fim,
      direcao: q.direcao,
      tipo: q.tipo,
      limite: q.limite,
      offset: q.offset
    });
    return res.json({ empresa_id: empresaId, conta_bancaria_id: Number(req.params.id), transacoes });
  }));

  router.get('/contas/:id/saldo', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const saldo = await motor.calcularSaldoConceitual({
      empresaId,
      conta_bancaria_id: req.params.id,
      data_inicio: q.data_inicio,
      data_fim: q.data_fim
    });
    return res.json(saldo);
  }));

  router.post('/contas/:id/sincronizar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    // empresa_id no body/query NÃO altera propriedade — empresaId vem do contexto
    const out = await motor.sincronizarConta({
      empresaId,
      id: req.params.id,
      conta_bancaria_id: req.params.id,
      begin_date: body.begin_date,
      end_date: body.end_date,
      reprocessarCatalogo: body.reprocessarCatalogo === true
    });
    return res.json(out);
  }));

  router.get('/contas/:id/sincronizacao', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.obterSincronizacao({ empresaId, id: req.params.id });
    return res.json(out);
  }));

  router.get('/contas/:id/saldo-bancario', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.obterSaldoBancario({ empresaId, id: req.params.id });
    return res.json(out);
  }));

  router.get('/contas/:id/saldo-real', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    try {
      const out = await motor.consultarSaldoReal({
        empresaId,
        id: req.params.id,
        conta_bancaria_id: req.params.id
      });
      return res.json(out);
    } catch (err) {
      if (err && err.payload) {
        return res.status(err.statusCode || 409).json(err.payload);
      }
      throw err;
    }
  }));

  router.get('/contas/:id/extrato', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const out = await motor.consultarExtratoConta({
      empresaId,
      id: req.params.id,
      conta_bancaria_id: req.params.id,
      fonte: q.fonte || q.origem,
      data_inicio: q.data_inicio,
      data_fim: q.data_fim,
      direcao: q.direcao,
      tipo: q.tipo,
      limite: q.limite,
      offset: q.offset,
      cursor: q.cursor
    });
    return res.json(out);
  }));

  router.get('/transacoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const transacoes = await motor.listarTransacoes({
      empresaId,
      conta_bancaria_id: q.conta_bancaria_id,
      data_inicio: q.data_inicio,
      data_fim: q.data_fim,
      direcao: q.direcao,
      tipo: q.tipo,
      limite: q.limite,
      offset: q.offset
    });
    return res.json({ empresa_id: empresaId, transacoes });
  }));

  router.get('/transacoes/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const transacao = await motor.obterTransacao({ empresaId, id: req.params.id });
    return res.json(transacao);
  }));

  router.post('/transacoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const out = await motor.registrarTransacaoBancaria({
      ...body,
      empresaId,
      empresa_id: empresaId
    });
    const status = out.status === 'CRIADA' ? 201 : 200;
    return res.status(status).json(out);
  }));

  router.get('/conciliacoes/registros-elegiveis', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const registros = await motor.listarRegistrosElegiveisConciliacao({
      empresaId,
      direcao: q.direcao
    });
    return res.json({ empresa_id: empresaId, registros });
  }));

  router.get('/conciliacoes/pendentes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const pendentes = await motor.listarPendentesConciliacao({
      empresaId,
      conta_bancaria_id: q.conta_bancaria_id,
      data_inicio: q.data_inicio,
      data_fim: q.data_fim,
      direcao: q.direcao,
      provider: q.provider || q.origem || q.external_source,
      status_conciliacao: q.status_conciliacao || q.status
    });
    return res.json({ empresa_id: empresaId, pendentes });
  }));

  router.get('/conciliacoes/sugestoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const sugestoes = await motor.listarSugestoesConciliacao({
      empresaId,
      conta_bancaria_id: q.conta_bancaria_id,
      status: q.status,
      nivel_confianca: q.nivel_confianca,
      data_inicio: q.data_inicio,
      data_fim: q.data_fim,
      limite: q.limite,
      offset: q.offset
    });
    return res.json({ empresa_id: empresaId, sugestoes });
  }));

  router.get('/conciliacoes/sugestoes/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const item = await motor.obterSugestaoConciliacao({ empresaId, id: req.params.id });
    return res.json(item);
  }));

  router.post('/conciliacoes/sugestoes/:id/aceitar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.aceitarSugestaoConciliacao({ empresaId, id: req.params.id });
    return res.json(out);
  }));

  router.post('/conciliacoes/sugestoes/:id/recusar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.recusarSugestaoConciliacao({ empresaId, id: req.params.id });
    return res.json(out);
  }));

  router.post('/contas/:id/analisar-conciliacoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.analisarConciliacoesConta({ empresaId, id: req.params.id });
    return res.json(out);
  }));

  router.post('/transacoes/:id/analisar-conciliacao', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.analisarConciliacaoTransacao({ empresaId, id: req.params.id });
    return res.json(out);
  }));

  router.get('/transacoes/:id/matching', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.obterMatchingTransacao({ empresaId, id: req.params.id });
    return res.json(out);
  }));

  router.get('/conciliacoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const conciliacoes = await motor.listarConciliacoes({
      empresaId,
      conta_bancaria_id: q.conta_bancaria_id,
      transacao_bancaria_id: q.transacao_bancaria_id,
      status: q.status,
      origem_financeira: q.origem_financeira,
      data_inicio: q.data_inicio,
      data_fim: q.data_fim
    });
    return res.json({ empresa_id: empresaId, conciliacoes });
  }));

  router.get('/conciliacoes/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const conc = await motor.obterConciliacao({ empresaId, id: req.params.id });
    return res.json(conc);
  }));

  router.get('/transacoes/:id/conciliacoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.obterConciliacoesPorTransacao({
      empresaId,
      id: req.params.id,
      transacao_bancaria_id: req.params.id
    });
    return res.json(out);
  }));

  router.post('/conciliacoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const conc = await motor.conciliarTransacao({
      ...body,
      empresaId,
      empresa_id: empresaId,
      origem_conciliacao: body.origem_conciliacao || 'MANUAL'
    });
    return res.status(201).json(conc);
  }));

  router.post('/transacoes/:id/conciliacoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const conc = await motor.conciliarTransacao({
      ...body,
      empresaId,
      empresa_id: empresaId,
      transacao_bancaria_id: req.params.id,
      origem_conciliacao: body.origem_conciliacao || 'MANUAL'
    });
    return res.status(201).json(conc);
  }));

  router.post('/conciliacoes/:id/desconciliar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const conc = await motor.desconciliarTransacao({
      empresaId,
      id: req.params.id,
      motivo: body.motivo,
      observacao: body.observacao
    });
    return res.json(conc);
  }));

  router.post('/conciliacoes/:id/cancelar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const conc = await motor.desconciliarTransacao({
      empresaId,
      id: req.params.id,
      motivo: body.motivo,
      observacao: body.observacao
    });
    return res.json(conc);
  }));

  router.post('/transacoes/:id/ignorar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const conc = await motor.marcarTransacaoIgnorada({
      empresaId,
      transacao_bancaria_id: req.params.id,
      observacao: body.observacao
    });
    return res.json(conc);
  }));

  router.post('/transacoes/:id/divergente', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const conc = await motor.marcarTransacaoDivergente({
      empresaId,
      transacao_bancaria_id: req.params.id,
      observacao: body.observacao
    });
    return res.json(conc);
  }));

  router.get('/providers', perm, async (req, res) => {
    try {
      const providers = motorDe(req, deps).listarProviders();
      return res.json({ providers });
    } catch (err) {
      return responderErro(res, err);
    }
  });

  router.get('/configuracoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const configuracoes = await motor.listarConfiguracoesIntegracao({
      empresaId,
      conta_bancaria_id: q.conta_bancaria_id
    });
    return res.json({ empresa_id: empresaId, configuracoes });
  }));

  router.get('/configuracoes/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const cfg = await motor.obterConfiguracaoIntegracao({ empresaId, id: req.params.id });
    return res.json(cfg);
  }));

  router.post('/configuracoes', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const cfg = await motor.criarConfiguracaoIntegracao({
      ...body,
      empresaId,
      empresa_id: empresaId
    });
    return res.status(201).json(cfg);
  }));

  router.put('/configuracoes/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const cfg = await motor.atualizarConfiguracaoIntegracao({
      ...body,
      id: req.params.id,
      empresaId,
      empresa_id: empresaId
    });
    return res.json(cfg);
  }));

  router.get('/configuracoes/:id/credenciais', perm, (req, res) => comConfiguracao(req, res, deps, async (motor, empresaId) => {
    const status = await motor.obterStatusCredenciaisIntegracao({ empresaId, id: req.params.id });
    return res.json(status);
  }));

  router.post('/configuracoes/:id/credenciais', perm, (req, res) => comConfiguracao(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const status = await motor.configurarCredenciaisProvider({
      empresaId,
      id: req.params.id,
      client_id: body.client_id,
      client_secret: body.client_secret,
      certificate: body.certificate || body.certificado,
      private_key: body.private_key || body.privateKey,
      ca: body.ca || body.certificate_authority,
      ambiente: body.ambiente
    });
    return res.json({
      ok: true,
      provider: status.provider,
      ambiente: status.ambiente,
      client_id: status.client_id,
      client_id_configurado: status.client_id_configurado,
      secret_configurado: status.secret_configurado,
      certificado_configurado: status.certificado_configurado === true,
      private_key_configurado: status.private_key_configurado === true,
      ca_configurado: status.ca_configurado === true,
      status_integracao: status.status_integracao || null,
      certificado_valido_ate: status.certificado_valido_ate || null,
      certificado_expirado: status.certificado_expirado === true,
      certificado_subject_cn: status.certificado_subject_cn || null,
      mtls_requerido: status.mtls_requerido === true,
      authentication: status.authentication || null
    });
  }));

  router.delete('/configuracoes/:id/credenciais', perm, (req, res) => comConfiguracao(req, res, deps, async (motor, empresaId) => {
    const status = await motor.removerCredenciaisProvider({ empresaId, id: req.params.id });
    return res.json({
      ok: true,
      provider: status.provider,
      ambiente: status.ambiente,
      client_id: status.client_id,
      client_id_configurado: status.client_id_configurado,
      secret_configurado: status.secret_configurado,
      certificado_configurado: status.certificado_configurado === true,
      private_key_configurado: status.private_key_configurado === true,
      ca_configurado: status.ca_configurado === true
    });
  }));

  router.post('/configuracoes/:id/conexao/testar', perm, (req, res) => comConfiguracao(req, res, deps, async (motor, empresaId) => {
    const cfg = await motor.obterConfiguracaoIntegracao({ empresaId, id: req.params.id });
    if (String(cfg.provider || '').toUpperCase() !== 'ITAU') {
      return res.status(409).json({
        success: false,
        provider: cfg.provider,
        authentication: null,
        mtls: false,
        authenticated: false,
        errorCode: 'PROVIDER_INCOMPATIVEL',
        message: 'Teste de conexão Itaú exige provider ITAU.'
      });
    }
    const out = await motor.testarConexaoItau({ empresaId, id: req.params.id });
    const bodyOut = {
      success: out.success === true,
      provider: out.provider || 'ITAU',
      environment: out.environment || null,
      authentication: out.authentication || 'OAUTH2_CLIENT_CREDENTIALS',
      mtls: out.mtls === true,
      authenticated: out.authenticated === true,
      message: out.message || null,
      errorCode: out.errorCode || null,
      token_from_cache: out.token_from_cache === true,
      mtls_requerido: out.mtls_requerido === true
    };
    const statusHttp = out.success ? 200 : (
      /AUSENTE|INVALIDOS|EXPIRADO|CREDENCIAIS/i.test(String(out.errorCode || '')) ? 409 : 401
    );
    return res.status(statusHttp).json(bodyOut);
  }));

  router.post('/configuracoes/:id/oauth/autorizar', perm, (req, res) => comConfiguracao(req, res, deps, async (motor, empresaId) => {
    const out = await motor.iniciarOAuthMercadoPago({
      empresaId,
      id: req.params.id,
      usuarioId: req.user && (req.user.id || req.user.usuario_id)
    });
    return res.json({
      ok: true,
      authorization_url: out.authorization_url
    });
  }));

  router.get('/configuracoes/:id/oauth/status', perm, (req, res) => comConfiguracao(req, res, deps, async (motor, empresaId) => {
    const status = await motor.obterStatusOAuthMercadoPago({ empresaId, id: req.params.id });
    return res.json({
      status: status.status,
      scope: status.scope,
      expires_at: status.expires_at,
      live_mode: status.live_mode,
      autorizado: status.autorizado,
      client_id_configurado: status.client_id_configurado,
      secret_configurado: status.secret_configurado
    });
  }));

  router.post('/configuracoes/:id/oauth/desconectar', perm, (req, res) => comConfiguracao(req, res, deps, async (motor, empresaId) => {
    const status = await motor.desconectarOAuthMercadoPago({ empresaId, id: req.params.id });
    return res.json({
      ok: true,
      status: status.status,
      autorizado: status.autorizado
    });
  }));

  router.post('/configuracoes/:id/provider/testar-leitura', perm, (req, res) => comConfiguracao(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    // empresa_id no body NÃO altera propriedade — empresaId vem do contexto
    const out = await motor.testarLeituraProviderMercadoPago({
      empresaId,
      id: req.params.id,
      begin_date: body.begin_date,
      end_date: body.end_date,
      persistir: body.persistir === true
    });
    return res.json({
      ok: out.ok === true,
      provider: out.provider,
      origem: out.origem,
      persistiu: out.persistiu === true,
      status_leitura: out.status_leitura,
      mensagem: out.mensagem || null,
      periodo: out.periodo || null,
      saldo: out.saldo,
      movimentacoes: out.movimentacoes || [],
      rejeitadas: out.rejeitadas || [],
      relatorio: out.relatorio || null,
      persistencia: out.persistencia || null
    });
  }));

  router.patch('/configuracoes/:id/ativar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const cfg = await motor.ativarConfiguracaoIntegracao({ empresaId, id: req.params.id });
    return res.json(cfg);
  }));

  router.patch('/configuracoes/:id/desativar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const cfg = await motor.desativarConfiguracaoIntegracao({ empresaId, id: req.params.id });
    return res.json(cfg);
  }));

  router.post('/configuracoes/:id/testar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.testarProvider({ empresaId, id: req.params.id });
    return res.json({
      ok: true,
      persistiu: false,
      provider: out.provider,
      transacoes: out.transacoes
    });
  }));

  router.get('/open-finance/consentimentos', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const q = req.query || {};
    const consentimentos = await motor.listarConsentimentos({
      empresaId,
      conta_bancaria_id: q.conta_bancaria_id,
      status: q.status,
      provider: q.provider
    });
    return res.json({ empresa_id: empresaId, consentimentos });
  }));

  router.get('/open-finance/consentimentos/:id', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const item = await motor.obterConsentimento({ empresaId, id: req.params.id });
    return res.json(item);
  }));

  router.post('/open-finance/consentimentos', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const body = req.body || {};
    const out = await motor.iniciarConsentimento({
      empresaId,
      conta_bancaria_id: body.conta_bancaria_id,
      provider: body.provider,
      escopos: body.escopos,
      instituicao_financeira_id: body.instituicao_financeira_id,
      usuarioId: req.user && (req.user.id != null ? req.user.id : req.user.usuario_id)
    });
    return res.status(201).json(out);
  }));

  router.post('/open-finance/consentimentos/:id/revogar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const item = await motor.revogarConsentimento({ empresaId, id: req.params.id });
    return res.json(item);
  }));

  router.post('/open-finance/consentimentos/:id/renovar', perm, (req, res) => comEmpresa(req, res, deps, async (motor, empresaId) => {
    const out = await motor.renovarConsentimento({ empresaId, id: req.params.id });
    return res.status(201).json(out);
  }));

  router.get('/open-finance/mock-autorizar', perm, (req, res) => {
    const state = String((req.query && req.query.state) || '');
    if (!state) {
      return res.status(400).type('html').send('<p>Autorização inválida.</p>');
    }
    const qs = encodeURIComponent(state);
    return res.type('html').send(
      '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Autorização de teste</title></head>'
      + '<body><p>Ambiente de teste. Autorize o compartilhamento de dados sem senha bancária.</p>'
      + '<p><a href="/api/bancario/open-finance/callback?state=' + qs + '&amp;resultado=aprovado&amp;ui=1">Aprovar</a></p>'
      + '<p><a href="/api/bancario/open-finance/callback?state=' + qs + '&amp;resultado=negado&amp;ui=1">Recusar</a></p>'
      + '</body></html>'
    );
  });

  router.get('/open-finance/callback', perm, async (req, res) => {
    const q = req.query || {};
    if (!q.state) {
      return res.status(400).json({ error: 'Autorização inválida.' });
    }
    let empresaIdContexto = null;
    try {
      const ctx = await resolverEmpresa(req, deps);
      empresaIdContexto = ctx.empresaId;
    } catch (_) {
      if (req.empresaId != null) empresaIdContexto = req.empresaId;
    }
    try {
      const motor = motorDe(req, deps);
      const item = await motor.processarCallbackConsentimento({
        state: q.state,
        query: q,
        empresaIdContexto
      });
      if (String(q.ui) === '1') {
        return res.redirect(302, '/erp/#/contas-bancarias');
      }
      return res.json({
        consentimento_id: item.id,
        status: item.status,
        expira_em: item.expira_em
      });
    } catch (err) {
      if (String(q.ui) === '1') {
        return res.status(400).type('html').send('<p>Autorização inválida.</p>');
      }
      return res.status(err.statusCode || 400).json({ error: 'Autorização inválida.' });
    }
  });

  return router;
}

const router = criarRouter;
module.exports = router;
module.exports.criarRouter = criarRouter;
