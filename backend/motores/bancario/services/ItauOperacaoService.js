/**
 * Operações Itaú (saldo real / extrato provider) — MBC-ITAU-02.
 * Persistência permanece em SincronizacaoBancariaService + TransacaoBancariaService.
 * @module motores/bancario/services/ItauOperacaoService
 */
'use strict';

const { ERROS, CODIGO_PROVIDER, erroMbc } = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { dbGet } = require('./dbPromessas');
const ContaBancariaService = require('./ContaBancariaService');
const ItauCredenciaisService = require('./ItauCredenciaisService');
const { ItauBankProvider } = require('../providers/itau/ItauBankProvider');
const { obterSecretStore } = require('../secrets/EncryptedLocalSecretStore');

function depsDe(params) {
  return {
    db: params.db,
    secretStore: params.secretStore || obterSecretStore({ db: params.db }),
    env: params.env || process.env,
    fetchImpl: params.fetchImpl || null,
    oauthClient: params.oauthClient || null,
    apiClient: params.apiClient || null
  };
}

async function obterConfigItau(db, empresaId, contaId) {
  const row = await dbGet(
    db,
    `SELECT * FROM config_integracao_bancaria
     WHERE empresa_id = ? AND conta_bancaria_id = ? AND ativo = 1
     ORDER BY id DESC`,
    [empresaId, contaId]
  );
  if (!row) {
    throw erroMbc(ERROS.CONFIG_NAO_ENCONTRADA, 'Configuração de integração não encontrada.', 404);
  }
  if (String(row.provider || '').toUpperCase() !== CODIGO_PROVIDER.ITAU) {
    throw erroMbc(
      ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL,
      'Operação de saldo/extrato Itaú exige provider ITAU.',
      409
    );
  }
  return row;
}

async function montarContextoAuth(params, cfg, conta) {
  const deps = depsDe(params);
  const status = await ItauCredenciaisService.obterStatus({
    db: deps.db,
    secretStore: deps.secretStore,
    env: deps.env,
    empresaId: params.empresaId,
    id: cfg.id
  });
  if (status.status_integracao !== 'CREDENCIAIS_CONFIGURADAS') {
    const e = erroMbc(
      ERROS.CREDENCIAL_SECRET_OBRIGATORIO,
      'Credenciais Itaú não configuradas.',
      409
    );
    e.errorCode = 'CREDENCIAIS_AUSENTES';
    throw e;
  }
  const seg = await ItauCredenciaisService.carregarSegredosServidor({
    db: deps.db,
    secretStore: deps.secretStore,
    empresaId: params.empresaId,
    id: cfg.id
  });
  const accountId = String(
    params.account_id
    || cfg.config_ref
    || [conta.agencia, conta.numero, conta.digito].filter(Boolean).join('-')
    || ''
  ).trim() || null;

  return {
    client_id: seg.client_id,
    client_secret: seg.client_secret,
    certificate: seg.certificate || null,
    private_key: seg.private_key || null,
    ca: seg.ca || null,
    ambiente: cfg.ambiente,
    account_id: accountId,
    external_account_id: accountId,
    agencia: conta.agencia || null,
    conta: conta.numero || null,
    numero: conta.numero || null,
    empresaId: params.empresaId,
    empresa_id: params.empresaId,
    contaBancariaId: conta.id,
    conta_bancaria_id: conta.id,
    saldo_url: params.saldo_url || null,
    extrato_url: params.extrato_url || null,
    saldo_path: params.saldo_path || null,
    extrato_path: params.extrato_path || null,
    fetchImpl: deps.fetchImpl,
    data_inicio: params.data_inicio || params.begin_date || null,
    data_fim: params.data_fim || params.end_date || null,
    cursor: params.cursor || null,
    forcarRefresh: params.forcarRefresh === true
  };
}

function criarProvider(deps) {
  return new ItauBankProvider({
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    oauthClient: deps.oauthClient,
    apiClient: deps.apiClient
  });
}

/**
 * Saldo REAL do provider (não conceitual). Não inventa zero.
 */
async function consultarSaldoReal(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const deps = depsDe(params);
  const conta = await ContaBancariaService.obterNoContexto({
    db: deps.db,
    empresaId,
    id: params.conta_bancaria_id || params.id
  });
  const cfg = await obterConfigItau(deps.db, empresaId, conta.id);
  const auth = await montarContextoAuth(params, cfg, conta);
  const provider = criarProvider(deps);
  const saldo = await provider.consultarSaldo(auth);
  return {
    ok: true,
    disponivel: saldo.valor != null,
    rotulo: 'Saldo real do banco',
    natureza: 'informado_banco',
    provider: CODIGO_PROVIDER.ITAU,
    institution: 'Itaú',
    empresa_id: empresaId,
    conta_bancaria_id: conta.id,
    environment: String(cfg.ambiente || '').toUpperCase(),
    saldo,
    available_balance: saldo.available_balance,
    current_balance: saldo.current_balance,
    currency: saldo.currency,
    as_of: saldo.as_of,
    source: saldo.source
  };
}

/**
 * Extrato live do provider (sem persistir).
 */
async function consultarExtratoProvider(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const deps = depsDe(params);
  const conta = await ContaBancariaService.obterNoContexto({
    db: deps.db,
    empresaId,
    id: params.conta_bancaria_id || params.id
  });
  const cfg = await obterConfigItau(deps.db, empresaId, conta.id);
  const auth = await montarContextoAuth(params, cfg, conta);
  const provider = criarProvider(deps);
  const pagina = await provider.listarTransacoes(auth);
  return {
    ok: true,
    provider: CODIGO_PROVIDER.ITAU,
    institution: 'Itaú',
    empresa_id: empresaId,
    conta_bancaria_id: conta.id,
    environment: String(cfg.ambiente || '').toUpperCase(),
    persistido: false,
    origem: 'PROVIDER_LIVE',
    periodo: {
      data_inicio: auth.data_inicio || null,
      data_fim: auth.data_fim || null
    },
    transacoes: pagina.transacoes || [],
    has_more: pagina.has_more === true,
    next_cursor: pagina.next_cursor || null
  };
}

async function montarAuthParaSync(params, cfg, conta) {
  return montarContextoAuth(params, cfg, conta);
}

module.exports = {
  consultarSaldoReal,
  consultarExtratoProvider,
  montarAuthParaSync,
  obterConfigItau
};
