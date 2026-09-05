/**
 * Ciclo de vida do consentimento Open Finance.
 * Sem tokens na tabela. Sem sincronização de saldo/extrato.
 * @module motores/bancario/services/ConsentimentoOpenFinanceService
 */
'use strict';

const crypto = require('crypto');
const {
  ERROS,
  erroMbc,
  ESCOPOS_OPEN_FINANCE,
  STATUS_CONSENTIMENTO,
  CONSENTIMENTOS_OPERACIONAIS
} = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { dbRun, dbGet, dbAll } = require('./dbPromessas');
const ContaBancariaService = require('./ContaBancariaService');
const { obterRegistryPadrao } = require('../providers/BankProviderRegistry');
const { obterSecretStore } = require('../secrets/EncryptedLocalSecretStore');

const STATE_TTL_MS = 10 * 60 * 1000;
const CONSENT_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;
const txQueue = new WeakMap();

function chaveSecretConsentimento(id) {
  return 'mbc.of.consent.' + id;
}

function agoraIso() {
  return new Date().toISOString();
}

function maisMs(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function gerarState() {
  return crypto.randomBytes(32).toString('hex');
}

function parseEscopos(lista) {
  const raw = Array.isArray(lista) && lista.length ? lista : ESCOPOS_OPEN_FINANCE.slice();
  const out = [];
  for (const item of raw) {
    const e = String(item || '').trim().toUpperCase();
    if (!ESCOPOS_OPEN_FINANCE.includes(e)) {
      throw erroMbc(ERROS.ESCOPO_INVALIDO, 'Escopo de consentimento inválido.', 400);
    }
    if (!out.includes(e)) out.push(e);
  }
  if (!out.length) {
    throw erroMbc(ERROS.ESCOPO_INVALIDO, 'Escopo de consentimento inválido.', 400);
  }
  return out;
}

function autorizacaoInvalida() {
  return erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Autorização inválida.', 400);
}

function depsDe(params) {
  return {
    db: params.db,
    registry: params.registry || obterRegistryPadrao(),
    secretStore: params.secretStore || obterSecretStore({ db: params.db })
  };
}

function mapPublico(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    conta_bancaria_id: row.conta_bancaria_id,
    instituicao_financeira_id: row.instituicao_financeira_id,
    provider: row.provider,
    status: row.status,
    consentimento_externo_id: row.consentimento_externo_id || null,
    estado_integracao: row.estado_integracao || null,
    escopos: String(row.escopos || '').split(',').filter(Boolean),
    iniciado_em: row.iniciado_em,
    autorizado_em: row.autorizado_em,
    expira_em: row.expira_em,
    revogado_em: row.revogado_em,
    ultimo_erro: row.ultimo_erro,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function respostaInicio(row, authorizationUrl, expiraEm) {
  return {
    consentimento_id: row.id,
    status: row.status,
    authorization_url: authorizationUrl || null,
    expira_em: expiraEm || row.expira_em || null
  };
}

async function runTx(db, fn) {
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await dbRun(db, 'COMMIT');
    return out;
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

function withTx(db, fn) {
  const prev = txQueue.get(db) || Promise.resolve();
  const next = prev.then(() => runTx(db, fn), () => runTx(db, fn));
  txQueue.set(db, next.catch(() => {}));
  return next;
}

async function obterContaValida(params) {
  const conta = await ContaBancariaService.obterNoContexto({
    db: params.db,
    empresaId: params.empresaId,
    id: params.conta_bancaria_id
  });
  if (!conta.ativa) {
    throw erroMbc(ERROS.CONTA_INATIVA, 'Conta bancária está inativa.', 409);
  }
  if (Number(conta.empresa_id) !== Number(params.empresaId)) {
    throw erroMbc(ERROS.EMPRESA_CONTA_DIVERGENTE, 'O consentimento deve pertencer à mesma empresa da conta.', 400);
  }
  if (params.instituicao_financeira_id != null && Number(params.instituicao_financeira_id) !== Number(conta.instituicao_financeira_id)) {
    throw erroMbc(ERROS.INSTITUICAO_INCOMPATIVEL, 'Instituição incompatível com a conta bancária.', 400);
  }
  return conta;
}

async function obterConfigAtiva(params, conta, provider) {
  const row = await dbGet(
    params.db,
    `SELECT * FROM config_integracao_bancaria
     WHERE empresa_id = ? AND conta_bancaria_id = ? AND ativo = 1
     ORDER BY id DESC`,
    [params.empresaId, conta.id]
  );
  if (!row) {
    throw erroMbc(ERROS.CONFIG_NAO_ENCONTRADA, 'Configuração de integração não encontrada.', 404);
  }
  if (String(row.provider).toUpperCase() !== provider) {
    throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Provider incompatível com a configuração da conta.', 400);
  }
  return row;
}

async function obterOperacional(db, contaId, provider) {
  return dbGet(
    db,
    `SELECT * FROM consentimento_open_finance
     WHERE conta_bancaria_id = ? AND provider = ?
       AND status IN ('INICIADO','AGUARDANDO_AUTORIZACAO','AUTORIZADO')
     ORDER BY id DESC`,
    [contaId, provider]
  );
}

async function atualizarStatus(db, id, campos) {
  const sets = ['updated_at = datetime(\'now\',\'localtime\')'];
  const bind = [];
  Object.keys(campos).forEach((k) => {
    sets.push(k + ' = ?');
    bind.push(campos[k]);
  });
  bind.push(id);
  await dbRun(db, `UPDATE consentimento_open_finance SET ${sets.join(', ')} WHERE id = ?`, bind);
}

async function persistirState(db, dados) {
  await dbRun(
    db,
    `INSERT INTO consentimento_of_state (
      state, empresa_id, conta_bancaria_id, config_id, consentimento_id, usuario_id, expira_em, consumido, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now','localtime'))`,
    [
      dados.state,
      dados.empresa_id,
      dados.conta_bancaria_id,
      dados.config_id,
      dados.consentimento_id,
      dados.usuario_id != null ? dados.usuario_id : null,
      dados.expira_em
    ]
  );
}

async function criarFluxoAutorizacao(params, row) {
  const { db, registry } = depsDe(params);
  const provider = registry.obter(row.provider);
  if (!provider.suportaAutorizacao) {
    throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Provider incompatível com autorização.', 400);
  }
  const state = gerarState();
  const expiraState = maisMs(STATE_TTL_MS);
  await persistirState(db, {
    state,
    empresa_id: row.empresa_id,
    conta_bancaria_id: row.conta_bancaria_id,
    config_id: params.config_id,
    consentimento_id: row.id,
    usuario_id: params.usuarioId,
    expira_em: expiraState
  });
  const out = await provider.iniciarAutorizacao({
    consentimentoId: row.id,
    state,
    escopos: String(row.escopos || '').split(',').filter(Boolean)
  });
  return { authorization_url: out.authorization_url, expira_em: expiraState, state };
}

async function iniciar(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db, registry } = depsDe(params);
  const conta = await obterContaValida({ ...params, empresaId, db });
  const providerCodigo = String(params.provider || '').trim().toUpperCase();
  if (!registry.existe(providerCodigo)) {
    throw erroMbc(ERROS.PROVIDER_DESCONHECIDO, 'Provider bancário desconhecido.', 400);
  }
  const providerInst = registry.obter(providerCodigo);
  if (!providerInst.suportaAutorizacao) {
    throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Provider incompatível com autorização.', 400);
  }
  const escopos = parseEscopos(params.escopos);
  const cfg = await obterConfigAtiva({ db, empresaId }, conta, providerCodigo);

  return withTx(db, async () => {
    const existente = await obterOperacional(db, conta.id, providerCodigo);
    if (existente) {
      const atualizado = await aplicarExpiracaoSeNecessario(db, existente);
      if (CONSENTIMENTOS_OPERACIONAIS.includes(atualizado.status)) {
        if (atualizado.status === STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO
          || atualizado.status === STATUS_CONSENTIMENTO.INICIADO) {
          const fluxo = await criarFluxoAutorizacao({
            db,
            registry,
            config_id: cfg.id,
            usuarioId: params.usuarioId
          }, atualizado);
          return respostaInicio(atualizado, fluxo.authorization_url, fluxo.expira_em);
        }
        return respostaInicio(atualizado, null, atualizado.expira_em);
      }
    }

    const agora = agoraIso();
    let inserted;
    try {
      inserted = await dbRun(
        db,
        `INSERT INTO consentimento_open_finance (
          empresa_id, conta_bancaria_id, instituicao_financeira_id, provider, status,
          estado_integracao, escopos, iniciado_em, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
        [
          empresaId,
          conta.id,
          conta.instituicao_financeira_id,
          providerCodigo,
          STATUS_CONSENTIMENTO.INICIADO,
          STATUS_CONSENTIMENTO.INICIADO,
          escopos.join(','),
          agora
        ]
      );
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE')) {
        const novamente = await obterOperacional(db, conta.id, providerCodigo);
        if (novamente) return respostaInicio(novamente, null, novamente.expira_em);
      }
      throw err;
    }

    await atualizarStatus(db, inserted.lastID, {
      status: STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO,
      estado_integracao: STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO
    });
    const row = await dbGet(db, `SELECT * FROM consentimento_open_finance WHERE id = ?`, [inserted.lastID]);
    const fluxo = await criarFluxoAutorizacao({
      db,
      registry,
      config_id: cfg.id,
      usuarioId: params.usuarioId
    }, row);
    return respostaInicio(row, fluxo.authorization_url, fluxo.expira_em);
  });
}

async function aplicarExpiracaoSeNecessario(db, row) {
  if (!row) return row;
  if (row.status === STATUS_CONSENTIMENTO.AUTORIZADO && row.expira_em && new Date(row.expira_em).getTime() < Date.now()) {
    await atualizarStatus(db, row.id, {
      status: STATUS_CONSENTIMENTO.EXPIRADO,
      estado_integracao: STATUS_CONSENTIMENTO.EXPIRADO,
      ultimo_erro: null
    });
    return dbGet(db, `SELECT * FROM consentimento_open_finance WHERE id = ?`, [row.id]);
  }
  return row;
}

async function obterNoContexto(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db } = depsDe(params);
  const row = await dbGet(
    db,
    `SELECT * FROM consentimento_open_finance WHERE id = ? AND empresa_id = ?`,
    [Number(params.id), empresaId]
  );
  if (!row) {
    throw erroMbc(ERROS.CONSENTIMENTO_NAO_ENCONTRADO, 'Consentimento não encontrado.', 404);
  }
  return mapPublico(await aplicarExpiracaoSeNecessario(db, row));
}

async function listar(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db } = depsDe(params);
  const where = ['empresa_id = ?'];
  const bind = [empresaId];
  if (params.conta_bancaria_id) {
    await ContaBancariaService.obterNoContexto({
      db,
      empresaId,
      id: params.conta_bancaria_id
    });
    where.push('conta_bancaria_id = ?');
    bind.push(Number(params.conta_bancaria_id));
  }
  if (params.status) {
    where.push('status = ?');
    bind.push(String(params.status).toUpperCase());
  }
  if (params.provider) {
    where.push('provider = ?');
    bind.push(String(params.provider).toUpperCase());
  }
  const rows = await dbAll(
    db,
    `SELECT * FROM consentimento_open_finance WHERE ${where.join(' AND ')} ORDER BY id DESC`,
    bind
  );
  const out = [];
  for (const row of rows) {
    out.push(mapPublico(await aplicarExpiracaoSeNecessario(db, row)));
  }
  return out;
}

async function processarCallback(params = {}) {
  const state = String(params.state || '').trim();
  if (!state) throw autorizacaoInvalida();
  const { db, registry, secretStore } = depsDe(params);

  let rejeitarAposCommit = false;
  const resultadoPublico = await withTx(db, async () => {
    const st = await dbGet(db, `SELECT * FROM consentimento_of_state WHERE state = ?`, [state]);
    if (!st) throw autorizacaoInvalida();
    if (params.empresaIdContexto != null && Number(params.empresaIdContexto) !== Number(st.empresa_id)) {
      throw autorizacaoInvalida();
    }
    if (Number(st.consumido) === 1) throw autorizacaoInvalida();
    if (new Date(st.expira_em).getTime() < Date.now()) {
      await dbRun(db, `UPDATE consentimento_of_state SET consumido = 1 WHERE state = ?`, [state]);
      await atualizarStatus(db, st.consentimento_id, {
        status: STATUS_CONSENTIMENTO.ERRO,
        estado_integracao: STATUS_CONSENTIMENTO.ERRO,
        ultimo_erro: 'state_expirado'
      });
      rejeitarAposCommit = true;
      return null;
    }

    await dbRun(db, `UPDATE consentimento_of_state SET consumido = 1 WHERE state = ?`, [state]);

    const row = await dbGet(db, `SELECT * FROM consentimento_open_finance WHERE id = ?`, [st.consentimento_id]);
    if (!row || Number(row.empresa_id) !== Number(st.empresa_id)) {
      throw autorizacaoInvalida();
    }

    const provider = registry.obter(row.provider);
    const resultado = await provider.processarCallback({
      query: params.query || {},
      consentimentoId: row.id,
      secretStore
    });

    if (resultado.status === STATUS_CONSENTIMENTO.NEGADO) {
      await atualizarStatus(db, row.id, {
        status: STATUS_CONSENTIMENTO.NEGADO,
        estado_integracao: STATUS_CONSENTIMENTO.NEGADO,
        ultimo_erro: null
      });
      const negado = await dbGet(db, `SELECT * FROM consentimento_open_finance WHERE id = ?`, [row.id]);
      return mapPublico(negado);
    }

    const expira = maisMs(CONSENT_VALIDITY_MS);
    await atualizarStatus(db, row.id, {
      status: STATUS_CONSENTIMENTO.AUTORIZADO,
      estado_integracao: STATUS_CONSENTIMENTO.AUTORIZADO,
      consentimento_externo_id: resultado.consentimento_externo_id || null,
      autorizado_em: agoraIso(),
      expira_em: expira,
      ultimo_erro: null
    });
    const providerCodigo = String(row.provider || '').toUpperCase();
    if (providerCodigo === 'MOCK' || providerCodigo === 'MOCK_OPEN_FINANCE') {
      await secretStore.set(chaveSecretConsentimento(row.id), 'OF_MOCK_REF');
    }
    const ok = await dbGet(db, `SELECT * FROM consentimento_open_finance WHERE id = ?`, [row.id]);
    return mapPublico(ok);
  });
  if (rejeitarAposCommit) throw autorizacaoInvalida();
  return resultadoPublico;
}

async function revogar(params = {}) {
  const atual = await obterNoContexto(params);
  const { db, registry, secretStore } = depsDe(params);
  if (atual.status === STATUS_CONSENTIMENTO.REVOGADO) {
    return atual;
  }
  if (![
    STATUS_CONSENTIMENTO.AUTORIZADO,
    STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO,
    STATUS_CONSENTIMENTO.INICIADO
  ].includes(atual.status)) {
    throw erroMbc(ERROS.CONSENTIMENTO_INVALIDO, 'Consentimento não pode ser revogado neste estado.', 409);
  }
  const provider = registry.obter(atual.provider);
  await provider.revogarAutorizacao({ consentimentoId: atual.id, secretStore });
  await atualizarStatus(db, atual.id, {
    status: STATUS_CONSENTIMENTO.REVOGADO,
    estado_integracao: STATUS_CONSENTIMENTO.REVOGADO,
    revogado_em: agoraIso()
  });
  await secretStore.delete(chaveSecretConsentimento(atual.id));
  return obterNoContexto(params);
}

async function renovar(params = {}) {
  const atual = await obterNoContexto(params);
  if (CONSENTIMENTOS_OPERACIONAIS.includes(atual.status) && atual.status !== STATUS_CONSENTIMENTO.AUTORIZADO) {
    throw erroMbc(ERROS.CONSENTIMENTO_JA_OPERACIONAL, 'Já existe autorização em andamento para esta conta.', 409);
  }
  if (atual.status === STATUS_CONSENTIMENTO.AUTORIZADO) {
    await revogar(params);
  }
  return iniciar({
    ...params,
    conta_bancaria_id: atual.conta_bancaria_id,
    provider: atual.provider,
    escopos: atual.escopos,
    instituicao_financeira_id: atual.instituicao_financeira_id
  });
}

async function exigirConsentimentoAutorizado(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db } = depsDe(params);
  const where = ['empresa_id = ?'];
  const bind = [empresaId];
  if (params.id) {
    where.push('id = ?');
    bind.push(Number(params.id));
  }
  if (params.conta_bancaria_id) {
    where.push('conta_bancaria_id = ?');
    bind.push(Number(params.conta_bancaria_id));
  }
  if (params.provider) {
    where.push('provider = ?');
    bind.push(String(params.provider).toUpperCase());
  }
  const row = await dbGet(
    db,
    `SELECT * FROM consentimento_open_finance WHERE ${where.join(' AND ')} ORDER BY id DESC`,
    bind
  );
  if (!row) {
    throw erroMbc(ERROS.CONSENTIMENTO_NAO_ENCONTRADO, 'Consentimento não encontrado.', 404);
  }
  const atual = mapPublico(await aplicarExpiracaoSeNecessario(db, row));
  if (atual.status !== STATUS_CONSENTIMENTO.AUTORIZADO) {
    throw erroMbc(ERROS.CONSENTIMENTO_INVALIDO, 'Consentimento não está autorizado.', 409);
  }
  return atual;
}

module.exports = {
  iniciar,
  listar,
  obterNoContexto,
  processarCallback,
  revogar,
  renovar,
  exigirConsentimentoAutorizado,
  chaveSecretConsentimento,
  gerarState,
  STATE_TTL_MS
};
