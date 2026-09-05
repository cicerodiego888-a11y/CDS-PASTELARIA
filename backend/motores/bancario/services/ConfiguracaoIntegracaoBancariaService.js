/**
 * Configuração de provider por conta. Sem secrets na tabela.
 * @module motores/bancario/services/ConfiguracaoIntegracaoBancariaService
 */
'use strict';

const { ERROS, AMBIENTE_INTEGRACAO, CODIGO_PROVIDER, erroMbc } = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { dbRun, dbGet, dbAll } = require('./dbPromessas');
const ContaBancariaService = require('./ContaBancariaService');
const { obterRegistryPadrao } = require('../providers/BankProviderRegistry');
const { obterSecretStore } = require('../secrets/EncryptedLocalSecretStore');

function chaveSecret(configId) {
  return 'mbc.config.' + configId;
}

function parseAmbiente(v) {
  const a = String(v || '').trim().toUpperCase();
  if (!Object.values(AMBIENTE_INTEGRACAO).includes(a)) {
    throw erroMbc(ERROS.AMBIENTE_INVALIDO, 'Ambiente deve ser TESTE, SANDBOX, HOMOLOGACAO ou PRODUCAO.', 400);
  }
  return a;
}

function parseProvider(codigo, registry) {
  const p = String(codigo || '').trim().toUpperCase();
  if (!registry.existe(p)) {
    throw erroMbc(ERROS.PROVIDER_DESCONHECIDO, 'Provider bancário desconhecido.', 400);
  }
  return p;
}

function validarProviderAmbiente(provider, ambiente) {
  if (
    (provider === CODIGO_PROVIDER.MOCK || provider === CODIGO_PROVIDER.MOCK_OPEN_FINANCE)
    && ambiente !== AMBIENTE_INTEGRACAO.TESTE
  ) {
    throw erroMbc(ERROS.AMBIENTE_INVALIDO, 'Provider de teste só pode operar em TESTE.', 400);
  }
  if (
    provider === CODIGO_PROVIDER.OPEN_FINANCE_REAL
    && ambiente === AMBIENTE_INTEGRACAO.TESTE
  ) {
    throw erroMbc(ERROS.AMBIENTE_INVALIDO, 'Provider real não opera no ambiente TESTE do MOCK.', 400);
  }
}

async function mapPublico(row, secretStore) {
  if (!row) return null;
  const secret_configurado = secretStore
    ? await secretStore.has(chaveSecret(row.id))
    : false;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    conta_bancaria_id: row.conta_bancaria_id,
    provider: row.provider,
    ambiente: row.ambiente,
    aplicacao_ref: row.aplicacao_ref || null,
    config_ref: row.config_ref || null,
    homologacao_status: row.provider === CODIGO_PROVIDER.OPEN_FINANCE_REAL
      ? 'NAO_HOMOLOGAVEL'
      : 'NAO_APLICAVEL',
    ativo: Number(row.ativo) === 1,
    secret_configurado,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function depsDe(params) {
  return {
    db: params.db,
    registry: params.registry || obterRegistryPadrao(),
    secretStore: params.secretStore || obterSecretStore({ db: params.db })
  };
}

async function obterContaAtiva(params) {
  const conta = await ContaBancariaService.obterNoContexto({
    db: params.db,
    empresaId: params.empresaId,
    id: params.conta_bancaria_id
  });
  if (!conta.ativa) {
    throw erroMbc(ERROS.CONTA_INATIVA, 'Conta bancária está inativa.', 409);
  }
  if (conta.empresa_id !== params.empresaId) {
    throw erroMbc(ERROS.EMPRESA_CONTA_DIVERGENTE, 'A configuração deve pertencer à mesma empresa da conta.', 400);
  }
  return conta;
}

async function criar(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db, registry, secretStore } = depsDe(params);
  const conta = await obterContaAtiva({ db, empresaId, conta_bancaria_id: params.conta_bancaria_id });
  const provider = parseProvider(params.provider, registry);
  const ambiente = parseAmbiente(params.ambiente || AMBIENTE_INTEGRACAO.TESTE);
  validarProviderAmbiente(provider, ambiente);
  const ativo = params.ativo === false || params.ativo === 0 ? 0 : 1;
  const aplicacaoRef = params.aplicacao_ref != null ? String(params.aplicacao_ref).trim() || null : null;
  const configRef = params.config_ref != null ? String(params.config_ref).trim() || null : null;
  if (params.client_secret || params.access_token || params.refresh_token) {
    throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Credenciais não podem ser enviadas na configuração.', 400);
  }
  if (ativo) {
    await dbRun(db, `UPDATE config_integracao_bancaria SET ativo = 0, updated_at = datetime('now','localtime')
      WHERE conta_bancaria_id = ? AND ativo = 1`, [conta.id]);
  }
  const r = await dbRun(
    db,
    `INSERT INTO config_integracao_bancaria (
      empresa_id, conta_bancaria_id, provider, ativo, ambiente, aplicacao_ref, config_ref, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
    [empresaId, conta.id, provider, ativo, ambiente, aplicacaoRef, configRef]
  );
  const row = await dbGet(db, `SELECT * FROM config_integracao_bancaria WHERE id = ?`, [r.lastID]);
  return mapPublico(row, secretStore);
}

async function obterNoContexto(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db, secretStore } = depsDe(params);
  const row = await dbGet(
    db,
    `SELECT * FROM config_integracao_bancaria WHERE id = ? AND empresa_id = ?`,
    [Number(params.id), empresaId]
  );
  if (!row) {
    throw erroMbc(ERROS.CONFIG_NAO_ENCONTRADA, 'Configuração de integração não encontrada.', 404);
  }
  return mapPublico(row, secretStore);
}

async function listar(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db, secretStore } = depsDe(params);
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
  const rows = await dbAll(
    db,
    `SELECT * FROM config_integracao_bancaria WHERE ${where.join(' AND ')} ORDER BY id DESC`,
    bind
  );
  const out = [];
  for (const row of rows) out.push(await mapPublico(row, secretStore));
  return out;
}

async function atualizar(params = {}) {
  const atual = await obterNoContexto(params);
  const { db, registry, secretStore } = depsDe(params);
  const provider = params.provider != null ? parseProvider(params.provider, registry) : atual.provider;
  const ambiente = params.ambiente != null ? parseAmbiente(params.ambiente) : atual.ambiente;
  validarProviderAmbiente(provider, ambiente);
  if (params.client_secret || params.access_token || params.refresh_token) {
    throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Credenciais não podem ser enviadas na configuração.', 400);
  }
  const aplicacaoRef = params.aplicacao_ref != null
    ? (String(params.aplicacao_ref).trim() || null)
    : atual.aplicacao_ref;
  const configRef = params.config_ref != null
    ? (String(params.config_ref).trim() || null)
    : atual.config_ref;
  await dbRun(
    db,
    `UPDATE config_integracao_bancaria
     SET provider = ?, ambiente = ?, aplicacao_ref = ?, config_ref = ?, updated_at = datetime('now','localtime')
     WHERE id = ? AND empresa_id = ?`,
    [provider, ambiente, aplicacaoRef, configRef, atual.id, atual.empresa_id]
  );
  const row = await dbGet(db, `SELECT * FROM config_integracao_bancaria WHERE id = ?`, [atual.id]);
  return mapPublico(row, secretStore);
}

async function definirAtivo(params, ativo) {
  const atual = await obterNoContexto(params);
  const { db, secretStore } = depsDe(params);
  if (ativo) {
    await obterContaAtiva({
      db,
      empresaId: atual.empresa_id,
      conta_bancaria_id: atual.conta_bancaria_id
    });
    validarProviderAmbiente(atual.provider, atual.ambiente);
    await dbRun(db, `UPDATE config_integracao_bancaria SET ativo = 0, updated_at = datetime('now','localtime')
      WHERE conta_bancaria_id = ? AND ativo = 1 AND id != ?`, [atual.conta_bancaria_id, atual.id]);
  }
  await dbRun(
    db,
    `UPDATE config_integracao_bancaria SET ativo = ?, updated_at = datetime('now','localtime')
     WHERE id = ? AND empresa_id = ?`,
    [ativo ? 1 : 0, atual.id, atual.empresa_id]
  );
  const row = await dbGet(db, `SELECT * FROM config_integracao_bancaria WHERE id = ?`, [atual.id]);
  return mapPublico(row, secretStore);
}

async function executar(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const persistir = params.persistir === true;
  const { db, registry } = depsDe(params);
  const cfg = await obterNoContexto({ ...params, empresaId, db, secretStore: params.secretStore, registry });
  if (!cfg.ativo) {
    throw erroMbc(ERROS.CONFIG_INATIVA, 'Configuração de integração está inativa.', 409);
  }
  const conta = await obterContaAtiva({
    db,
    empresaId,
    conta_bancaria_id: cfg.conta_bancaria_id
  });
  const provider = registry.obter(cfg.provider);
  if (!provider.disponivel) {
    throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Provider não está disponível.', 400);
  }
  validarProviderAmbiente(cfg.provider, cfg.ambiente);
  await provider.conectar();
  const bruto = await provider.listarTransacoes({
    empresaId,
    contaBancariaId: conta.id,
    conta_bancaria_id: conta.id
  });
  const dtos = Array.isArray(bruto) ? bruto : ((bruto && bruto.transacoes) || []);
  await provider.desconectar();
  let persistidas = [];
  if (persistir) {
    const TransacaoBancariaService = require('./TransacaoBancariaService');
    for (const dto of dtos) {
      persistidas.push(await TransacaoBancariaService.registrar({
        db,
        empresaId,
        ...dto,
        conta_bancaria_id: conta.id
      }));
    }
  }
  return {
    configuracao_id: cfg.id,
    conta_bancaria_id: conta.id,
    provider: cfg.provider,
    persistiu: persistir,
    transacoes: dtos,
    persistidas
  };
}

module.exports = {
  criar,
  obterNoContexto,
  listar,
  atualizar,
  ativar: (p) => definirAtivo(p, true),
  desativar: (p) => definirAtivo(p, false),
  executar,
  chaveSecret
};
