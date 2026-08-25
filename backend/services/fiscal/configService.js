const dbDefault = require('../../database');
const {
  normalizarEmpresaId,
  carregarConfiguracaoFiscalEmpresa,
  montarConfigEmpresa,
  incrementaNumeroFiscalEmpresa
} = require('./empresasConfiguracaoFiscal');
const { logFiscalRuntime } = require('./core/FiscalRuntimeLog');
const {
  ehPlaceholderCsc,
  preencherUrlsVaziasComOficiais,
  resolverUrlsOficiaisNfce
} = require('./FiscalConfigUrlsResolver');

function useDb(db) {
  return db || dbDefault;
}

function getConfiguracoes(chaves, dbInjected) {
  return new Promise((resolve, reject) => {
    const placeholders = chaves.map(() => '?').join(',');

    useDb(dbInjected).all(
      `SELECT chave, valor FROM configuracoes WHERE chave IN (${placeholders})`,
      chaves,
      (err, rows) => {
        if (err) return reject(err);

        const map = {};
        rows.forEach((row) => {
          map[row.chave] = row.valor;
        });

        resolve(map);
      }
    );
  });
}

function resolverUrlsEmissao(config) {
  if (!config || !config.urls) {
    const err = new Error('Configuração fiscal sem urls.');
    err.code = 'CONFIGURACAO_FISCAL_EMPRESA_INCOMPLETA';
    throw err;
  }
  const ambiente = Number(config.ambiente);
  const bloco = ambiente === 1 ? config.urlsProducao : config.urlsHomologacao;
  if (bloco) {
    ['autorizacao', 'consultaQr', 'consultaChave'].forEach((chave) => {
      const ativa = String(config.urls[chave] || '');
      const doBloco = String(bloco[chave] || '');
      if (ativa && doBloco && ativa !== doBloco) {
        const err = new Error('URL ativa diverge do bloco do ambiente fiscal.');
        err.code = 'CONFIGURACAO_FISCAL_AMBIENTE_DIVERGENTE';
        throw err;
      }
    });
  }
  return {
    autorizacao: String(config.urls.autorizacao || ''),
    consultaQr: String(config.urls.consultaQr || ''),
    consultaChave: String(config.urls.consultaChave || ''),
    retorno: String(config.urls.retorno || ''),
    status: String(config.urls.status || ''),
    ambiente,
    empresaId: config.empresaId != null ? Number(config.empresaId) : null,
    origem: config.fonte === 'EMPRESA' ? 'CONFIGURACAO_EMPRESA' : 'CONFIGURACAO_GLOBAL'
  };
}

function logFiscalConfigSeguro(config, operacao) {
  const urls = config && config.urls ? config.urls : {};
  logFiscalRuntime(operacao || 'CONFIG', {
    empresa_id: config && config.empresaId != null ? config.empresaId : null,
    ambiente: Number(config && config.ambiente) === 1 ? 'PRODUCAO' : 'HOMOLOGACAO',
    origem: config && config.fonte === 'EMPRESA' ? 'CONFIGURACAO_EMPRESA' : 'CONFIGURACAO_GLOBAL',
    operacao: operacao || 'CARGA',
    url_autorizacao: urls.autorizacao || '',
    url_qrcode: urls.consultaQr || '',
    url_consulta_chave: urls.consultaChave || ''
  });
}

async function getFiscalConfig({ validarUrls = true, empresaId, db } = {}) {
  if (empresaId != null && empresaId !== '') {
    const idEmpresa = normalizarEmpresaId(empresaId);
    if (!idEmpresa) {
      const err = new Error('empresaId inválido para configuração fiscal empresarial.');
      err.code = 'EMPRESA_OBRIGATORIA';
      throw err;
    }
    const loaded = await carregarConfiguracaoFiscalEmpresa(idEmpresa, useDb(db));
    const config = montarConfigEmpresa({ ...loaded, validarUrls });
    logFiscalConfigSeguro(config, 'CARGA');
    return config;
  }

  const cfg = await getConfiguracoes([
    'nome_empresa',
    'nome_fantasia',
    'razao_social',
    'cnpj',
    'telefone',
    'email',
    'endereco',
    'fiscal_danfe_largura_mm',
    'fiscal_ambiente',
    'fiscal_uf',
    'fiscal_codigo_uf',
    'fiscal_serie',
    'fiscal_numero_atual',
    'fiscal_token_csc',
    'fiscal_id_csc',
    'fiscal_certificado_path',
    'fiscal_certificado_senha',
    'fiscal_regime_tributario',
    'fiscal_ie',
    'fiscal_im',
    'fiscal_cnae',

    'fiscal_csc_qrcode_url_homologacao',
    'fiscal_consulta_chave_url_homologacao',
    'fiscal_ws_autorizacao_homologacao',
    'fiscal_ws_retorno_homologacao',
    'fiscal_ws_status_homologacao',

    'fiscal_csc_qrcode_url_producao',
    'fiscal_consulta_chave_url_producao',
    'fiscal_ws_autorizacao_producao',
    'fiscal_ws_retorno_producao',
    'fiscal_ws_status_producao',

    'fiscal_tp_imp',
    'fiscal_municipio_codigo',
    'fiscal_municipio_nome',
    'fiscal_uf_sigla',
    'fiscal_emitente_cep',
    'fiscal_emitente_logradouro',
    'fiscal_emitente_numero',
    'fiscal_emitente_bairro'
  ], db);

  const cfgLog = { ...cfg };
  ['fiscal_token_csc', 'fiscal_certificado_senha'].forEach((k) => {
    if (cfgLog[k]) cfgLog[k] = '***';
  });
  console.log('[FISCAL CONFIG] Configurações carregadas:', JSON.stringify(cfgLog, null, 2));

  if (!cfg.fiscal_ambiente) {
    throw new Error('Ambiente fiscal não configurado. Selecione Produção ou Homologação.');
  }

  const ambienteFiscal = Number(cfg.fiscal_ambiente);

  console.log('[FISCAL CONFIG] Ambiente fiscal:', ambienteFiscal);

  if (![1, 2].includes(ambienteFiscal)) {
    throw new Error('Ambiente fiscal inválido. Escolha 1 Produção ou 2 Homologação.');
  }

  const urlsHomologacao = {
    autorizacao: cfg.fiscal_ws_autorizacao_homologacao || '',
    retorno: cfg.fiscal_ws_retorno_homologacao || '',
    status: cfg.fiscal_ws_status_homologacao || '',
    consultaQr: cfg.fiscal_csc_qrcode_url_homologacao || '',
    consultaChave: cfg.fiscal_consulta_chave_url_homologacao || ''
  };

  const urlsProducao = {
    autorizacao: cfg.fiscal_ws_autorizacao_producao || '',
    retorno: cfg.fiscal_ws_retorno_producao || '',
    status: cfg.fiscal_ws_status_producao || '',
    consultaQr: cfg.fiscal_csc_qrcode_url_producao || '',
    consultaChave: cfg.fiscal_consulta_chave_url_producao || ''
  };

  const urlsSelecionadas = ambienteFiscal === 1 ? urlsProducao : urlsHomologacao;

  if (validarUrls && !urlsSelecionadas.autorizacao) {
    throw new Error(
      ambienteFiscal === 1
        ? 'URL de autorização em PRODUÇÃO não configurada.'
        : 'URL de autorização em HOMOLOGAÇÃO não configurada.'
    );
  }

  const configGlobal = {
    fonte: 'GLOBAL',
    empresaId: null,
    ambiente: ambienteFiscal,
    uf: cfg.fiscal_uf_sigla || cfg.fiscal_uf || 'CE',
    codigoUf: String(cfg.fiscal_codigo_uf || '23'),
    serie: Number(cfg.fiscal_serie || 1),
    numeroAtual: Number(cfg.fiscal_numero_atual || 1),
    tokenCSC: cfg.fiscal_token_csc || '',
    idCSC: cfg.fiscal_id_csc || '',
    certificadoPath: cfg.fiscal_certificado_path || '',
    certificadoSenha: cfg.fiscal_certificado_senha || '',
    crt: String(cfg.fiscal_regime_tributario || '1'),
    ie: cfg.fiscal_ie || '',
    im: cfg.fiscal_im || '',
    cnae: cfg.fiscal_cnae || '',
    nomeEmpresa: cfg.nome_empresa || '',
    nomeFantasia: cfg.nome_fantasia || cfg.nome_empresa || '',
    razaoSocial: cfg.razao_social || cfg.nome_empresa || '',
    cnpj: cfg.cnpj || '',
    telefone: cfg.telefone || '',
    email: cfg.email || '',
    endereco: cfg.endereco || '',
    municipioCodigo: String(cfg.fiscal_municipio_codigo || '2307304'),
    municipioNome: cfg.fiscal_municipio_nome || 'Juazeiro do Norte',
    cep: cfg.fiscal_emitente_cep || '',
    logradouro: cfg.fiscal_emitente_logradouro || '',
    numeroEndereco: cfg.fiscal_emitente_numero || 'S/N',
    bairro: cfg.fiscal_emitente_bairro || '',
    danfeLarguraMm: Number(cfg.fiscal_danfe_largura_mm || 80) === 58 ? 58 : 80,
    tpImp: Number(cfg.fiscal_tp_imp || 4),

    urls: urlsSelecionadas,
    urlsHomologacao,
    urlsProducao
  };
  logFiscalConfigSeguro(configGlobal, 'CARGA');
  return configGlobal;
}

function setConfiguracao(chave, valor, tipo = 'string', descricao = '', dbInjected) {
  return new Promise((resolve, reject) => {
    useDb(dbInjected).run(`
      INSERT INTO configuracoes (chave, valor, tipo, descricao, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chave) DO UPDATE SET
        valor = excluded.valor,
        tipo = excluded.tipo,
        descricao = excluded.descricao,
        updated_at = CURRENT_TIMESTAMP
    `, [chave, valor, tipo, descricao], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

const CHAVES_SEGREDAS_PRESERVAR = Object.freeze([
  'fiscal_token_csc',
  'fiscal_certificado_senha'
]);

/**
 * DTO seguro para UI — não devolve TOKEN CSC puro.
 * idCSC permanece (não é segredo).
 */
function dtoPublicoFiscalParaUi(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const cscOk = !!(cfg.tokenCSC && String(cfg.tokenCSC).trim());
  const idOk = !!(cfg.idCSC && String(cfg.idCSC).trim());
  const out = { ...cfg };
  delete out.tokenCSC;
  delete out.certificadoSenha;
  out.idCSC = idOk ? String(cfg.idCSC).trim() : '';
  out.id_csc = out.idCSC;
  out.cscConfigurado = cscOk;
  out.csc_configurado = cscOk;
  out.idCscConfigurado = idOk;
  out.id_csc_configurado = idOk;
  out.certificado_configurado = !!(cfg.certificadoPath && String(cfg.certificadoPath).trim());
  // Preencher URLs vazias na exibição a partir do catálogo oficial.
  const uf = cfg.uf || 'CE';
  const enriquecer = (bloco, ambiente) => {
    const oficial = resolverUrlsOficiaisNfce({ uf, ambiente });
    const b = bloco && typeof bloco === 'object' ? { ...bloco } : {};
    ['autorizacao', 'retorno', 'status', 'consultaQr', 'consultaChave'].forEach((k) => {
      if (!b[k] || !String(b[k]).trim()) b[k] = oficial[k];
    });
    return b;
  };
  out.urlsHomologacao = enriquecer(cfg.urlsHomologacao, 2);
  out.urlsProducao = enriquecer(cfg.urlsProducao, 1);
  if (out.urls) {
    out.urls = Number(cfg.ambiente) === 1 ? out.urlsProducao : out.urlsHomologacao;
  }
  return out;
}

/**
 * Filtra payload do PUT /fiscal/config:
 * - não persiste placeholder CSC
 * - não zera segredos com string vazia
 */
function filtrarPayloadConfigFiscalUi(payload) {
  const bruto = payload && typeof payload === 'object' ? payload : {};
  const out = {};
  for (const [chave, valor] of Object.entries(bruto)) {
    if (chave === 'fiscal_token_csc' || chave === 'fiscal_id_csc') {
      if (ehPlaceholderCsc(valor)) continue;
    }
    if (CHAVES_SEGREDAS_PRESERVAR.includes(chave)) {
      if (valor == null || String(valor).trim() === '') continue;
    }
    if (chave === 'fiscal_certificado_senha' && (valor == null || String(valor).trim() === '')) continue;
    out[chave] = valor;
  }
  return out;
}

/**
 * Completa chaves de URL vazias no mapa global configuracoes com oficiais.
 */
async function completarUrlsGlobaisVazias(dbInjected) {
  const db = useDb(dbInjected);
  const ufRow = await getConfiguracoes(['fiscal_uf_sigla', 'fiscal_uf'], db);
  const uf = ufRow.fiscal_uf_sigla || ufRow.fiscal_uf || 'CE';
  const merged = {};
  const chavesUrl = [
    'fiscal_ws_autorizacao_homologacao', 'fiscal_ws_retorno_homologacao', 'fiscal_ws_status_homologacao',
    'fiscal_csc_qrcode_url_homologacao', 'fiscal_consulta_chave_url_homologacao',
    'fiscal_ws_autorizacao_producao', 'fiscal_ws_retorno_producao', 'fiscal_ws_status_producao',
    'fiscal_csc_qrcode_url_producao', 'fiscal_consulta_chave_url_producao'
  ];
  const atuais = await getConfiguracoes(chavesUrl, db);
  const comoEmpresa = {
    uf,
    ws_autorizacao_homologacao: atuais.fiscal_ws_autorizacao_homologacao,
    ws_retorno_homologacao: atuais.fiscal_ws_retorno_homologacao,
    ws_status_homologacao: atuais.fiscal_ws_status_homologacao,
    csc_qrcode_url_homologacao: atuais.fiscal_csc_qrcode_url_homologacao,
    consulta_chave_url_homologacao: atuais.fiscal_consulta_chave_url_homologacao,
    ws_autorizacao_producao: atuais.fiscal_ws_autorizacao_producao,
    ws_retorno_producao: atuais.fiscal_ws_retorno_producao,
    ws_status_producao: atuais.fiscal_ws_status_producao,
    csc_qrcode_url_producao: atuais.fiscal_csc_qrcode_url_producao,
    consulta_chave_url_producao: atuais.fiscal_consulta_chave_url_producao
  };
  preencherUrlsVaziasComOficiais(comoEmpresa, { uf });
  const mapa = {
    fiscal_ws_autorizacao_homologacao: comoEmpresa.ws_autorizacao_homologacao,
    fiscal_ws_retorno_homologacao: comoEmpresa.ws_retorno_homologacao,
    fiscal_ws_status_homologacao: comoEmpresa.ws_status_homologacao,
    fiscal_csc_qrcode_url_homologacao: comoEmpresa.csc_qrcode_url_homologacao,
    fiscal_consulta_chave_url_homologacao: comoEmpresa.consulta_chave_url_homologacao,
    fiscal_ws_autorizacao_producao: comoEmpresa.ws_autorizacao_producao,
    fiscal_ws_retorno_producao: comoEmpresa.ws_retorno_producao,
    fiscal_ws_status_producao: comoEmpresa.ws_status_producao,
    fiscal_csc_qrcode_url_producao: comoEmpresa.csc_qrcode_url_producao,
    fiscal_consulta_chave_url_producao: comoEmpresa.consulta_chave_url_producao
  };
  for (const [chave, valor] of Object.entries(mapa)) {
    const atual = atuais[chave] != null ? String(atuais[chave]).trim() : '';
    if (!atual && valor) {
      await setConfiguracao(chave, valor, 'string', `URL fiscal auto: ${chave}`, db);
      merged[chave] = valor;
    }
  }
  return merged;
}

async function incrementaNumeroFiscal(opcoes = {}) {
  const db = useDb(opcoes.db);
  const idEmpresa = normalizarEmpresaId(opcoes.empresaId);
  if (idEmpresa) {
    return incrementaNumeroFiscalEmpresa(idEmpresa, db);
  }

  const cfg = await getConfiguracoes([
    'fiscal_numero_atual',
    'fiscal_serie',
    'fiscal_ambiente'
  ], db);

  const numeroConfig = Number(cfg.fiscal_numero_atual || 1);
  const serie = Number(cfg.fiscal_serie || 1);
  const ambiente = Number(cfg.fiscal_ambiente || 2);

  return new Promise((resolve, reject) => {
    db.get(`
      SELECT MAX(CAST(numero AS INTEGER)) AS maior
      FROM nfce_notas
      WHERE CAST(serie AS INTEGER) = ?
        AND CAST(ambiente AS INTEGER) = ?
    `, [serie, ambiente], async (err, row) => {
      if (err) return reject(err);

      const maiorBanco = Number(row?.maior || 0);

      const numeroSeguro = Math.max(
        numeroConfig,
        maiorBanco + 1
      );

      try {
        await setConfiguracao(
          'fiscal_numero_atual',
          String(numeroSeguro + 1),
          'number',
          'Próximo número NFC-e',
          db
        );

        console.log(`[FISCAL] Número usado: ${numeroSeguro}`);
        console.log(`[FISCAL] Próximo número salvo: ${numeroSeguro + 1}`);

        resolve(numeroSeguro);
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = {
  getFiscalConfig,
  setConfiguracao,
  incrementaNumeroFiscal,
  resolverUrlsEmissao,
  logFiscalConfigSeguro,
  dtoPublicoFiscalParaUi,
  filtrarPayloadConfigFiscalUi,
  completarUrlsGlobaisVazias
};