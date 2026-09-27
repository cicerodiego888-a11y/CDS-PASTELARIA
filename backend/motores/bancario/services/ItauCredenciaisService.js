/**
 * Credenciais Itaú via SecretStore (MBC-ITAU-01.1).
 * Client Secret, certificado, private key e CA nunca vão ao frontend.
 * @module motores/bancario/services/ItauCredenciaisService
 */
'use strict';

const { ERROS, CODIGO_PROVIDER, AMBIENTE_INTEGRACAO, erroMbc } = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { dbRun, dbGet } = require('./dbPromessas');
const { obterSecretStore } = require('../secrets/EncryptedLocalSecretStore');
const {
  chaveSecretClient,
  chaveCertificado,
  chavePrivateKey,
  chaveCa,
  endpointsParaAmbiente
} = require('../providers/itau/ItauConstants');
const {
  validarMaterialTls,
  metadadosCertificadoPublico
} = require('../providers/itau/ItauCertificadoUtil');
const { ItauBankProvider } = require('../providers/itau/ItauBankProvider');
const { limparCacheToken } = require('../providers/itau/ItauOAuthClient');

function trimExterno(v) {
  if (v == null) return '';
  return String(v).replace(/^\s+|\s+$/g, '');
}

function secretInformado(v) {
  return v != null && String(v) !== '';
}

function depsDe(params) {
  return {
    db: params.db,
    secretStore: params.secretStore || obterSecretStore({ db: params.db }),
    env: params.env || process.env,
    fetchImpl: params.fetchImpl || null,
    oauthClient: params.oauthClient || null
  };
}

async function obterRow(params) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const row = await dbGet(
    params.db,
    `SELECT * FROM config_integracao_bancaria WHERE id = ? AND empresa_id = ?`,
    [params.id, empresaId]
  );
  if (!row) {
    throw erroMbc(ERROS.CONFIG_NAO_ENCONTRADA, 'Configuração de integração não encontrada.', 404);
  }
  return row;
}

function exigirProviderItau(provider) {
  if (String(provider || '').toUpperCase() !== CODIGO_PROVIDER.ITAU) {
    throw erroMbc(
      ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL,
      'Credenciais Itaú só podem ser configuradas no provider ITAU.',
      409
    );
  }
}

async function statusFlags(secretStore, configId, aplicacaoRef) {
  const [secretOk, certOk, keyOk, caOk] = await Promise.all([
    secretStore.has(chaveSecretClient(configId)),
    secretStore.has(chaveCertificado(configId)),
    secretStore.has(chavePrivateKey(configId)),
    secretStore.has(chaveCa(configId))
  ]);
  return {
    client_id_configurado: !!(aplicacaoRef && String(aplicacaoRef).trim()),
    secret_configurado: !!secretOk,
    certificado_configurado: !!certOk,
    private_key_configurado: !!keyOk,
    ca_configurado: !!caOk
  };
}

function derivarStatus(flags, exigeMtls) {
  if (!flags.client_id_configurado && !flags.secret_configurado) return 'NAO_CONFIGURADO';
  if (!flags.client_id_configurado || !flags.secret_configurado) return 'CREDENCIAIS_INCOMPLETAS';
  if (exigeMtls && (!flags.certificado_configurado || !flags.private_key_configurado)) {
    return 'CREDENCIAIS_INCOMPLETAS';
  }
  return 'CREDENCIAIS_CONFIGURADAS';
}

async function obterStatus(params = {}) {
  const { secretStore, env } = depsDe(params);
  const row = await obterRow({ ...params, db: params.db || depsDe(params).db });
  exigirProviderItau(row.provider);
  const flags = await statusFlags(secretStore, row.id, row.aplicacao_ref);
  const endpoints = endpointsParaAmbiente(row.ambiente, env);
  let metaCert = {
    certificado_valido_ate: null,
    certificado_expirado: false,
    certificado_subject_cn: null
  };
  if (flags.certificado_configurado) {
    const pem = await secretStore.get(chaveCertificado(row.id));
    metaCert = metadadosCertificadoPublico(pem);
  }
  return {
    ok: true,
    provider: CODIGO_PROVIDER.ITAU,
    ambiente: row.ambiente,
    client_id: row.aplicacao_ref || null,
    ...flags,
    mtls_requerido: endpoints.exige_mtls === true,
    status_integracao: derivarStatus(flags, endpoints.exige_mtls),
    certificado_valido_ate: metaCert.certificado_valido_ate || null,
    certificado_expirado: metaCert.certificado_expirado === true,
    certificado_subject_cn: metaCert.certificado_subject_cn || null,
    authentication: 'OAUTH2_CLIENT_CREDENTIALS'
  };
}

async function configurar(params = {}) {
  const { db, secretStore } = depsDe(params);
  const row = await obterRow({ ...params, db });
  exigirProviderItau(row.provider);

  if (params.ambiente != null) {
    const ambiente = String(params.ambiente || '').trim().toUpperCase();
    if (!Object.values(AMBIENTE_INTEGRACAO).includes(ambiente)) {
      throw erroMbc(ERROS.AMBIENTE_INVALIDO, 'Ambiente inválido.', 400);
    }
    if (ambiente === AMBIENTE_INTEGRACAO.TESTE) {
      throw erroMbc(ERROS.AMBIENTE_INVALIDO, 'Provider Itaú não opera no ambiente TESTE do MOCK.', 400);
    }
    row.ambiente = ambiente;
  }

  const clientId = trimExterno(params.client_id);
  if (!clientId) {
    throw erroMbc(ERROS.CREDENCIAL_CLIENT_ID_OBRIGATORIO, 'Client ID Itaú é obrigatório.', 400);
  }

  const chaveSec = chaveSecretClient(row.id);
  const jaTemSecret = await secretStore.has(chaveSec);
  if (secretInformado(params.client_secret)) {
    const secret = trimExterno(params.client_secret);
    if (secret) await secretStore.set(chaveSec, secret);
  } else if (!jaTemSecret) {
    throw erroMbc(
      ERROS.CREDENCIAL_SECRET_OBRIGATORIO,
      'Client Secret Itaú é obrigatório na primeira configuração.',
      400
    );
  }

  const novoCert = secretInformado(params.certificate) || secretInformado(params.certificado)
    ? trimExterno(params.certificate || params.certificado)
    : '';
  const novaKey = secretInformado(params.private_key) || secretInformado(params.privateKey)
    ? trimExterno(params.private_key || params.privateKey)
    : '';
  const novaCa = secretInformado(params.ca) || secretInformado(params.certificate_authority)
    ? trimExterno(params.ca || params.certificate_authority)
    : '';

  if (novoCert || novaKey) {
    const certEfetivo = novoCert || (await secretStore.get(chaveCertificado(row.id))) || '';
    const keyEfetiva = novaKey || (await secretStore.get(chavePrivateKey(row.id))) || '';
    const val = validarMaterialTls({
      certificate: certEfetivo,
      private_key: keyEfetiva,
      exigir: true
    });
    if (!val.ok) {
      const e = erroMbc(ERROS.CREDENCIAL_SECRET_OBRIGATORIO, val.message, 400);
      e.errorCode = val.errorCode;
      throw e;
    }
    if (novoCert) await secretStore.set(chaveCertificado(row.id), novoCert);
    if (novaKey) await secretStore.set(chavePrivateKey(row.id), novaKey);
  }
  if (novaCa) await secretStore.set(chaveCa(row.id), novaCa);

  await dbRun(
    db,
    `UPDATE config_integracao_bancaria
     SET aplicacao_ref = ?, ambiente = ?, updated_at = datetime('now','localtime')
     WHERE id = ? AND empresa_id = ?`,
    [clientId, row.ambiente, row.id, row.empresa_id]
  );

  limparCacheToken();
  return obterStatus({ ...params, db, secretStore, id: row.id, empresaId: row.empresa_id });
}

async function remover(params = {}) {
  const { db, secretStore } = depsDe(params);
  const row = await obterRow({ ...params, db });
  exigirProviderItau(row.provider);
  await secretStore.delete(chaveSecretClient(row.id));
  await secretStore.delete(chaveCertificado(row.id));
  await secretStore.delete(chavePrivateKey(row.id));
  await secretStore.delete(chaveCa(row.id));
  await dbRun(
    db,
    `UPDATE config_integracao_bancaria
     SET aplicacao_ref = NULL, updated_at = datetime('now','localtime')
     WHERE id = ? AND empresa_id = ?`,
    [row.id, row.empresa_id]
  );
  limparCacheToken();
  return obterStatus({ ...params, db, secretStore, id: row.id, empresaId: row.empresa_id });
}

async function carregarSegredosServidor(params = {}) {
  const { secretStore } = depsDe(params);
  const row = await obterRow({ ...params, db: params.db });
  exigirProviderItau(row.provider);
  const [clientSecret, certificate, privateKey, ca] = await Promise.all([
    secretStore.get(chaveSecretClient(row.id)),
    secretStore.get(chaveCertificado(row.id)),
    secretStore.get(chavePrivateKey(row.id)),
    secretStore.get(chaveCa(row.id))
  ]);
  return {
    client_id: row.aplicacao_ref ? String(row.aplicacao_ref) : '',
    client_secret: clientSecret ? String(clientSecret) : '',
    certificate: certificate ? String(certificate) : '',
    private_key: privateKey ? String(privateKey) : '',
    ca: ca ? String(ca) : '',
    ambiente: row.ambiente
  };
}

function respostaFalhaPre(params) {
  return {
    success: false,
    provider: CODIGO_PROVIDER.ITAU,
    environment: String(params.environment || 'SANDBOX').toUpperCase(),
    authentication: 'OAUTH2_CLIENT_CREDENTIALS',
    mtls: params.mtls === true,
    mtls_requerido: params.mtls === true,
    authenticated: false,
    errorCode: params.errorCode,
    message: params.message
  };
}

async function testarConexao(params = {}) {
  const deps = depsDe(params);
  const row = await obterRow({ ...params, db: deps.db });
  exigirProviderItau(row.provider);
  const endpoints = endpointsParaAmbiente(row.ambiente, deps.env);
  const seg = await carregarSegredosServidor({ ...params, db: deps.db, secretStore: deps.secretStore });

  if (!seg.client_id && !seg.client_secret) {
    return respostaFalhaPre({
      environment: endpoints.ambiente_chave,
      mtls: endpoints.exige_mtls,
      errorCode: 'CREDENCIAIS_AUSENTES',
      message: 'Configure Client ID e Client Secret antes de testar a conexão.'
    });
  }
  if (!seg.client_id) {
    return respostaFalhaPre({
      environment: endpoints.ambiente_chave,
      mtls: endpoints.exige_mtls,
      errorCode: 'CLIENT_ID_AUSENTE',
      message: 'Client ID Itaú ausente.'
    });
  }
  if (!seg.client_secret) {
    return respostaFalhaPre({
      environment: endpoints.ambiente_chave,
      mtls: endpoints.exige_mtls,
      errorCode: 'CLIENT_SECRET_AUSENTE',
      message: 'Client Secret Itaú ausente.'
    });
  }

  if (endpoints.exige_mtls) {
    if (!seg.certificate) {
      return respostaFalhaPre({
        environment: endpoints.ambiente_chave,
        mtls: true,
        errorCode: 'CERTIFICADO_AUSENTE',
        message: 'Produção Itaú exige certificado cliente.'
      });
    }
    if (!seg.private_key) {
      return respostaFalhaPre({
        environment: endpoints.ambiente_chave,
        mtls: true,
        errorCode: 'PRIVATE_KEY_AUSENTE',
        message: 'Produção Itaú exige private key.'
      });
    }
    const val = validarMaterialTls({
      certificate: seg.certificate,
      private_key: seg.private_key,
      exigir: true
    });
    if (!val.ok) {
      return respostaFalhaPre({
        environment: endpoints.ambiente_chave,
        mtls: true,
        errorCode: val.errorCode,
        message: val.message
      });
    }
  } else if (seg.certificate || seg.private_key) {
    const val = validarMaterialTls({
      certificate: seg.certificate,
      private_key: seg.private_key,
      exigir: !!(seg.certificate && seg.private_key)
    });
    if ((seg.certificate || seg.private_key) && !val.ok && val.errorCode) {
      return respostaFalhaPre({
        environment: endpoints.ambiente_chave,
        mtls: false,
        errorCode: val.errorCode,
        message: val.message
      });
    }
  }

  const provider = new ItauBankProvider({
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    oauthClient: deps.oauthClient
  });
  return provider.testarConexao({
    client_id: seg.client_id,
    client_secret: seg.client_secret,
    certificate: seg.certificate || null,
    private_key: seg.private_key || null,
    ca: seg.ca || null,
    ambiente: row.ambiente,
    fetchImpl: deps.fetchImpl,
    forcarRefresh: params.forcarRefresh === true
  });
}

module.exports = {
  obterStatus,
  configurar,
  remover,
  testarConexao,
  carregarSegredosServidor,
  derivarStatus,
  chaveSecretClient,
  chaveCertificado,
  chavePrivateKey,
  chaveCa
};
