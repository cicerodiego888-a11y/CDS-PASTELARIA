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

/** Namespace existente do MBC-05 — credencial da config (Client Secret). */
function chaveSecretMercadoPago(configId) {
  return chaveSecret(configId);
}

function trimExterno(v) {
  if (v == null) return '';
  return String(v).replace(/^\s+|\s+$/g, '');
}

function secretInformado(v) {
  return v != null && String(v) !== '';
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
  if (
    provider === CODIGO_PROVIDER.ITAU
    && ambiente === AMBIENTE_INTEGRACAO.TESTE
  ) {
    throw erroMbc(ERROS.AMBIENTE_INVALIDO, 'Provider Itaú não opera no ambiente TESTE do MOCK.', 400);
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
      : (row.provider === CODIGO_PROVIDER.ITAU ? 'OPERACIONAL_PREPARADO' : 'NAO_APLICAVEL'),
    ativo: Number(row.ativo) === 1,
    secret_configurado,
    client_id_configurado: !!(row.aplicacao_ref && String(row.aplicacao_ref).trim()),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function statusCredenciais(row, secretStore) {
  const publico = await mapPublico(row, secretStore);
  return {
    ok: true,
    provider: publico.provider,
    ambiente: publico.ambiente,
    client_id: publico.aplicacao_ref || null,
    client_id_configurado: publico.client_id_configurado,
    secret_configurado: publico.secret_configurado
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
  const { secretStore } = depsDe(params);
  const row = await obterRowNoContexto(params);
  return mapPublico(row, secretStore);
}

function idsEmpresaValidos(lista) {
  return [...new Set(
    (Array.isArray(lista) ? lista : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0)
  )];
}

async function obterRowNoContexto(params = {}) {
  const { db } = depsDe(params);
  const id = Number(params.id);
  if (Array.isArray(params.empresaIds)) {
    const ids = idsEmpresaValidos(params.empresaIds);
    if (!ids.length || !Number.isInteger(id) || id <= 0) {
      throw erroMbc(ERROS.CONFIG_NAO_ENCONTRADA, 'Configuração de integração não encontrada.', 404);
    }
    const ph = ids.map(() => '?').join(', ');
    const row = await dbGet(
      db,
      `SELECT * FROM config_integracao_bancaria WHERE id = ? AND empresa_id IN (${ph})`,
      [id, ...ids]
    );
    if (!row) {
      throw erroMbc(ERROS.CONFIG_NAO_ENCONTRADA, 'Configuração de integração não encontrada.', 404);
    }
    return row;
  }
  const empresaId = exigirEmpresaId(params.empresaId);
  const row = await dbGet(
    db,
    `SELECT * FROM config_integracao_bancaria WHERE id = ? AND empresa_id = ?`,
    [id, empresaId]
  );
  if (!row) {
    throw erroMbc(ERROS.CONFIG_NAO_ENCONTRADA, 'Configuração de integração não encontrada.', 404);
  }
  return row;
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

function exigirProviderMercadoPago(provider) {
  if (provider !== CODIGO_PROVIDER.OPEN_FINANCE_REAL) {
    throw erroMbc(
      ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL,
      'Credenciais de Mercado Pago só podem ser configuradas no provider OPEN_FINANCE_REAL.',
      409
    );
  }
}

async function obterStatusCredenciais(params = {}) {
  const { secretStore } = depsDe(params);
  const row = await obterRowNoContexto(params);
  if (String(row.provider || '').toUpperCase() === CODIGO_PROVIDER.ITAU) {
    const ItauCredenciaisService = require('./ItauCredenciaisService');
    return ItauCredenciaisService.obterStatus({
      db: params.db || depsDe(params).db,
      secretStore,
      empresaId: params.empresaId,
      id: row.id
    });
  }
  return statusCredenciais(row, secretStore);
}

async function configurarCredenciaisMercadoPago(params = {}) {
  const { db, secretStore } = depsDe(params);
  const row = await obterRowNoContexto(params);
  exigirProviderMercadoPago(row.provider);
  if (params.ambiente != null) {
    const ambiente = parseAmbiente(params.ambiente);
    validarProviderAmbiente(row.provider, ambiente);
    row.ambiente = ambiente;
  }
  const clientId = trimExterno(params.client_id);
  if (!clientId) {
    throw erroMbc(ERROS.CREDENCIAL_CLIENT_ID_OBRIGATORIO, 'Application ID / Client ID é obrigatório.', 400);
  }
  const chave = chaveSecretMercadoPago(row.id);
  const jaTemSecret = await secretStore.has(chave);
  if (secretInformado(params.client_secret)) {
    const secret = trimExterno(params.client_secret);
    if (!secret) {
      if (!jaTemSecret) {
        throw erroMbc(
          ERROS.CREDENCIAL_SECRET_OBRIGATORIO,
          'Client Secret é obrigatório na primeira configuração.',
          400
        );
      }
    } else {
      await secretStore.set(chave, secret);
    }
  } else if (!jaTemSecret) {
    throw erroMbc(
      ERROS.CREDENCIAL_SECRET_OBRIGATORIO,
      'Client Secret é obrigatório na primeira configuração.',
      400
    );
  }
  await dbRun(
    db,
    `UPDATE config_integracao_bancaria
     SET aplicacao_ref = ?, ambiente = ?, updated_at = datetime('now','localtime')
     WHERE id = ? AND empresa_id = ?`,
    [clientId, row.ambiente, row.id, row.empresa_id]
  );
  const atual = await dbGet(db, `SELECT * FROM config_integracao_bancaria WHERE id = ?`, [row.id]);
  return statusCredenciais(atual, secretStore);
}

async function removerCredenciaisMercadoPago(params = {}) {
  const { db, secretStore } = depsDe(params);
  const row = await obterRowNoContexto(params);
  exigirProviderMercadoPago(row.provider);
  await secretStore.delete(chaveSecretMercadoPago(row.id));
  await dbRun(
    db,
    `UPDATE config_integracao_bancaria
     SET aplicacao_ref = NULL, updated_at = datetime('now','localtime')
     WHERE id = ? AND empresa_id = ?`,
    [row.id, row.empresa_id]
  );
  const atual = await dbGet(db, `SELECT * FROM config_integracao_bancaria WHERE id = ?`, [row.id]);
  return statusCredenciais(atual, secretStore);
}

/**
 * Uso interno do provider (OAuth MP). Não expor no Motor.CONTRATO nem em API/logs.
 */
async function obterCredenciaisProvider(params = {}) {
  const { secretStore } = depsDe(params);
  const row = await obterRowNoContexto(params);
  const client_secret = await secretStore.get(chaveSecretMercadoPago(row.id));
  return {
    client_id: row.aplicacao_ref || null,
    client_secret: client_secret || null
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
  obterStatusCredenciais,
  configurarCredenciaisMercadoPago,
  removerCredenciaisMercadoPago,
  obterCredenciaisProvider,
  chaveSecret,
  chaveSecretMercadoPago
};
