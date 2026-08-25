/**
 * Origem da configuração fiscal por empresa (Sprint 04.08).
 * Não é um motor fiscal: apenas isola emitente, CSC, certificado e numeração.
 *
 * @module services/fiscal/empresasConfiguracaoFiscal
 */
'use strict';

const {
  preencherUrlsVaziasComOficiais,
  enriquecerBlocoUrlsExibicao,
  sanitizarPatchCsc
} = require('./FiscalConfigUrlsResolver');

const DDL_EMPRESAS_CONFIGURACAO_FISCAL = `
  CREATE TABLE IF NOT EXISTS empresas_configuracao_fiscal (
    empresa_id INTEGER NOT NULL UNIQUE,
    ambiente INTEGER,
    uf TEXT,
    codigo_uf TEXT,
    serie INTEGER NOT NULL DEFAULT 1,
    numero_atual INTEGER NOT NULL DEFAULT 1,
    token_csc TEXT,
    id_csc TEXT,
    certificado_path TEXT,
    certificado_senha TEXT,
    crt TEXT,
    ie TEXT,
    im TEXT,
    cnae TEXT,
    telefone TEXT,
    email TEXT,
    municipio_codigo TEXT,
    municipio_nome TEXT,
    cep TEXT,
    logradouro TEXT,
    numero_endereco TEXT,
    bairro TEXT,
    ws_autorizacao TEXT,
    ws_retorno TEXT,
    ws_status TEXT,
    csc_qrcode_url TEXT,
    consulta_chave_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )
`;

const URL_CAMPOS_AMBIENTE = Object.freeze([
  'ws_autorizacao_homologacao',
  'ws_retorno_homologacao',
  'ws_status_homologacao',
  'csc_qrcode_url_homologacao',
  'consulta_chave_url_homologacao',
  'ws_autorizacao_producao',
  'ws_retorno_producao',
  'ws_status_producao',
  'csc_qrcode_url_producao',
  'consulta_chave_url_producao'
]);

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function garantirColuna(db, table, column, ddl) {
  const cols = await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  if (cols.some((c) => c.name === column)) return;
  await runSql(db, `ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

async function garantirSchemaFiscalEmpresaAsync(db) {
  if (!db) throw new Error('db obrigatório para configuração fiscal por empresa');
  await runSql(db, DDL_EMPRESAS_CONFIGURACAO_FISCAL);
  for (const col of URL_CAMPOS_AMBIENTE) {
    await garantirColuna(db, 'empresas_configuracao_fiscal', col, `${col} TEXT`);
  }
  const nfce = await dbGet(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nfce_notas'`);
  if (nfce) {
    await garantirColuna(db, 'nfce_notas', 'empresa_id', 'empresa_id INTEGER');
    await runSql(db, `CREATE INDEX IF NOT EXISTS idx_nfce_notas_empresa ON nfce_notas(empresa_id)`);
  }
}

function erroConfig(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  if (extra.statusCode != null) err.statusCode = extra.statusCode;
  return err;
}

function normalizarEmpresaId(valor) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function carregarConfiguracaoFiscalEmpresa(empresaId, db) {
  const id = normalizarEmpresaId(empresaId);
  if (!id) {
    throw erroConfig('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório para configuração fiscal empresarial.', {
      statusCode: 400
    });
  }
  await garantirSchemaFiscalEmpresaAsync(db);
  const empresa = await dbGet(db, `SELECT * FROM empresas WHERE id = ?`, [id]);
  if (!empresa) {
    throw erroConfig('EMPRESA_INVALIDA', `Empresa ${id} não cadastrada.`, { statusCode: 400 });
  }
  const row = await dbGet(db, `SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id = ?`, [id]);
  if (!row) {
    throw erroConfig(
      'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE',
      `Empresa ${id} não possui configuração fiscal própria.`,
      { statusCode: 409 }
    );
  }
  return { empresa, row };
}

function valorUrlCampo(row, campoNovo, campoLegado, usarLegado) {
  const novo = row && row[campoNovo] != null ? String(row[campoNovo]).trim() : '';
  if (novo) return novo;
  if (usarLegado && row && row[campoLegado] != null) {
    return String(row[campoLegado]).trim();
  }
  return '';
}

function montarBlocoUrls(row, sufixo, usarLegado) {
  return {
    autorizacao: valorUrlCampo(row, `ws_autorizacao_${sufixo}`, 'ws_autorizacao', usarLegado),
    retorno: valorUrlCampo(row, `ws_retorno_${sufixo}`, 'ws_retorno', usarLegado),
    status: valorUrlCampo(row, `ws_status_${sufixo}`, 'ws_status', usarLegado),
    consultaQr: valorUrlCampo(row, `csc_qrcode_url_${sufixo}`, 'csc_qrcode_url', usarLegado),
    consultaChave: valorUrlCampo(row, `consulta_chave_url_${sufixo}`, 'consulta_chave_url', usarLegado)
  };
}

function resolverUrlsEmpresa(row) {
  const ambiente = Number(row && row.ambiente);
  const urlsHomologacao = montarBlocoUrls(row, 'homologacao', ambiente === 2);
  const urlsProducao = montarBlocoUrls(row, 'producao', ambiente === 1);
  return {
    urls: ambiente === 1 ? urlsProducao : urlsHomologacao,
    urlsHomologacao,
    urlsProducao
  };
}

function complementarUrlsPorAmbiente(merged) {
  preencherUrlsVaziasComOficiais(merged, { uf: merged.uf || 'CE' });
  const amb = Number(merged.ambiente);
  const sufixo = amb === 1 ? 'producao' : (amb === 2 ? 'homologacao' : null);
  if (!sufixo) return merged;
  const pares = [
    ['ws_autorizacao', `ws_autorizacao_${sufixo}`],
    ['ws_retorno', `ws_retorno_${sufixo}`],
    ['ws_status', `ws_status_${sufixo}`],
    ['csc_qrcode_url', `csc_qrcode_url_${sufixo}`],
    ['consulta_chave_url', `consulta_chave_url_${sufixo}`]
  ];
  pares.forEach(([legado, novo]) => {
    const temNovo = merged[novo] != null && String(merged[novo]).trim() !== '';
    const temLegado = merged[legado] != null && String(merged[legado]).trim() !== '';
    if (temNovo && !temLegado) merged[legado] = merged[novo];
    if (temLegado && !temNovo) merged[novo] = merged[legado];
  });
  return merged;
}

function montarConfigEmpresa({ empresa, row, validarUrls }) {
  const ambiente = Number(row.ambiente);
  if (![1, 2].includes(ambiente)) {
    throw erroConfig('CONFIGURACAO_FISCAL_EMPRESA_INVALIDA', 'Ambiente fiscal da empresa inválido.', {
      statusCode: 409
    });
  }
  const { urls, urlsHomologacao, urlsProducao } = resolverUrlsEmpresa(row);
  if (validarUrls && !urls.autorizacao) {
    throw erroConfig(
      'CONFIGURACAO_FISCAL_EMPRESA_INCOMPLETA',
      `URL de autorização não configurada para a empresa ${empresa.id}.`,
      { statusCode: 409 }
    );
  }
  const ie = row.ie || empresa.inscricao_estadual || '';
  return {
    fonte: 'EMPRESA',
    empresaId: Number(empresa.id),
    ambiente,
    uf: row.uf || 'CE',
    codigoUf: String(row.codigo_uf || '23'),
    serie: Number(row.serie || 1),
    numeroAtual: Number(row.numero_atual || 1),
    tokenCSC: row.token_csc || '',
    idCSC: row.id_csc || '',
    certificadoPath: row.certificado_path || '',
    certificadoSenha: row.certificado_senha || '',
    crt: String(row.crt || '1'),
    ie,
    im: row.im || empresa.inscricao_municipal || '',
    cnae: row.cnae || '',
    nomeEmpresa: empresa.razao_social || empresa.nome_fantasia || '',
    nomeFantasia: empresa.nome_fantasia || empresa.razao_social || '',
    razaoSocial: empresa.razao_social || '',
    cnpj: empresa.cnpj || '',
    telefone: row.telefone || '',
    email: row.email || '',
    endereco: [row.logradouro, row.numero_endereco, row.bairro].filter(Boolean).join(', '),
    municipioCodigo: String(row.municipio_codigo || '2307304'),
    municipioNome: row.municipio_nome || 'Juazeiro do Norte',
    cep: row.cep || '',
    logradouro: row.logradouro || '',
    numeroEndereco: row.numero_endereco || 'S/N',
    bairro: row.bairro || '',
    danfeLarguraMm: 80,
    tpImp: 4,
    urls,
    urlsHomologacao,
    urlsProducao
  };
}

async function upsertConfiguracaoFiscalEmpresa(empresaId, dados, db) {
  const id = normalizarEmpresaId(empresaId);
  if (!id) throw erroConfig('EMPRESA_OBRIGATORIA', 'empresaId obrigatório.', { statusCode: 400 });
  await garantirSchemaFiscalEmpresaAsync(db);
  const existente = await dbGet(db, `SELECT empresa_id FROM empresas_configuracao_fiscal WHERE empresa_id = ?`, [id]);
  const campos = CAMPOS_ESCRITA.slice();
  const valores = campos.map((c) => (dados[c] != null ? dados[c] : null));
  if (existente) {
    const setSql = campos.map((c) => `${c}=?`).join(', ');
    await runSql(
      db,
      `UPDATE empresas_configuracao_fiscal SET ${setSql}, updated_at=CURRENT_TIMESTAMP WHERE empresa_id=?`,
      [...valores, id]
    );
    return id;
  }
  const placeholders = campos.map(() => '?').join(', ');
  await runSql(
    db,
    `INSERT INTO empresas_configuracao_fiscal (empresa_id, ${campos.join(', ')}) VALUES (?, ${placeholders})`,
    [id, ...valores]
  );
  return id;
}

async function atualizarNumeroAtualEmpresa(empresaId, proximo, db) {
  const id = normalizarEmpresaId(empresaId);
  await garantirSchemaFiscalEmpresaAsync(db);
  await runSql(
    db,
    `UPDATE empresas_configuracao_fiscal
        SET numero_atual = ?, updated_at = CURRENT_TIMESTAMP
      WHERE empresa_id = ?`,
    [Number(proximo), id]
  );
}

async function incrementaNumeroFiscalEmpresa(empresaId, db) {
  const { row } = await carregarConfiguracaoFiscalEmpresa(empresaId, db);
  const serie = Number(row.serie || 1);
  const ambiente = Number(row.ambiente || 2);
  const numeroConfig = Number(row.numero_atual || 1);
  const maxRow = await dbGet(
    db,
    `SELECT MAX(CAST(numero AS INTEGER)) AS maior
       FROM nfce_notas
      WHERE CAST(serie AS INTEGER) = ?
        AND CAST(ambiente AS INTEGER) = ?
        AND empresa_id = ?`,
    [serie, ambiente, Number(empresaId)]
  );
  const maiorBanco = Number(maxRow && maxRow.maior || 0);
  const numeroSeguro = Math.max(numeroConfig, maiorBanco + 1);
  await atualizarNumeroAtualEmpresa(empresaId, numeroSeguro + 1, db);
  return numeroSeguro;
}

const STATUS_FISCAL_ADMIN = Object.freeze({
  PRONTA: 'PRONTA',
  INCOMPLETA: 'INCOMPLETA',
  INVALIDA: 'INVALIDA',
  DESATIVADA: 'DESATIVADA'
});

const CAMPOS_ESCRITA = Object.freeze([
  'ambiente', 'uf', 'codigo_uf', 'serie', 'numero_atual', 'token_csc', 'id_csc',
  'certificado_path', 'certificado_senha', 'crt', 'ie', 'im', 'cnae', 'telefone', 'email',
  'municipio_codigo', 'municipio_nome', 'cep', 'logradouro', 'numero_endereco', 'bairro',
  'ws_autorizacao', 'ws_retorno', 'ws_status', 'csc_qrcode_url', 'consulta_chave_url',
  ...URL_CAMPOS_AMBIENTE
]);

const ALIASES_ESCRITA = Object.freeze({
  tokenCsc: 'token_csc',
  idCsc: 'id_csc',
  certificadoPath: 'certificado_path',
  certificadoSenha: 'certificado_senha',
  codigoUf: 'codigo_uf',
  numeroAtual: 'numero_atual',
  wsAutorizacao: 'ws_autorizacao',
  wsRetorno: 'ws_retorno',
  wsStatus: 'ws_status',
  cscQrcodeUrl: 'csc_qrcode_url',
  consultaChaveUrl: 'consulta_chave_url',
  wsAutorizacaoHomologacao: 'ws_autorizacao_homologacao',
  wsRetornoHomologacao: 'ws_retorno_homologacao',
  wsStatusHomologacao: 'ws_status_homologacao',
  cscQrcodeUrlHomologacao: 'csc_qrcode_url_homologacao',
  consultaChaveUrlHomologacao: 'consulta_chave_url_homologacao',
  wsAutorizacaoProducao: 'ws_autorizacao_producao',
  wsRetornoProducao: 'ws_retorno_producao',
  wsStatusProducao: 'ws_status_producao',
  cscQrcodeUrlProducao: 'csc_qrcode_url_producao',
  consultaChaveUrlProducao: 'consulta_chave_url_producao',
  municipioCodigo: 'municipio_codigo',
  municipioNome: 'municipio_nome',
  numeroEndereco: 'numero_endereco'
});

function preencherTexto(valor) {
  if (valor == null) return false;
  return String(valor).trim() !== '';
}

function normalizarPayloadEscrita(entrada) {
  const bruto = entrada && typeof entrada === 'object' ? entrada : {};
  const out = {};
  for (const [k, v] of Object.entries(bruto)) {
    if (k === 'empresa_id' || k === 'empresaId') continue;
    const dest = ALIASES_ESCRITA[k] || k;
    if (CAMPOS_ESCRITA.includes(dest)) out[dest] = v;
  }
  return out;
}

function validarConfiguracaoFiscalEmpresa(empresaId, configuracao) {
  const id = normalizarEmpresaId(empresaId);
  if (!id) {
    throw erroConfig('EMPRESA_OBRIGATORIA', 'empresaId obrigatório.', { statusCode: 400 });
  }
  const dados = normalizarPayloadEscrita(configuracao);
  if (dados.ambiente != null && dados.ambiente !== '') {
    const amb = Number(dados.ambiente);
    if (![1, 2].includes(amb)) {
      throw erroConfig(
        'CONFIGURACAO_FISCAL_EMPRESA_INVALIDA',
        'Ambiente fiscal deve ser 1 (produção) ou 2 (homologação).',
        { statusCode: 400 }
      );
    }
  }
  if (dados.serie != null && dados.serie !== '') {
    const serie = Number(dados.serie);
    if (!Number.isInteger(serie) || serie < 1) {
      throw erroConfig(
        'CONFIGURACAO_FISCAL_EMPRESA_INVALIDA',
        'Série fiscal deve ser um inteiro >= 1.',
        { statusCode: 400 }
      );
    }
  }
  return { empresaId: id, dados, valida: true };
}

function avaliarCamposProntidao(row) {
  const ambienteOk = row && [1, 2].includes(Number(row.ambiente));
  const serieOk = row && Number(row.serie) >= 1;
  const cscOk = row && preencherTexto(row.token_csc) && preencherTexto(row.id_csc);
  const certificadoOk = row && preencherTexto(row.certificado_path) && preencherTexto(row.certificado_senha);
  const sefazOk = row && (
    preencherTexto(row.ws_autorizacao)
    || preencherTexto(row.ws_autorizacao_homologacao)
    || preencherTexto(row.ws_autorizacao_producao)
  );
  return {
    ambiente: !!ambienteOk,
    serie: !!serieOk,
    csc: !!cscOk,
    certificado: !!certificadoOk,
    sefaz: !!sefazOk
  };
}

function avaliarStatusAdmin(empresa, row) {
  if (empresa && Number(empresa.ativo) === 0) {
    return STATUS_FISCAL_ADMIN.DESATIVADA;
  }
  if (!row) return STATUS_FISCAL_ADMIN.INCOMPLETA;
  if (row.ambiente != null && row.ambiente !== '' && ![1, 2].includes(Number(row.ambiente))) {
    return STATUS_FISCAL_ADMIN.INVALIDA;
  }
  if (row.serie != null && row.serie !== '' && !(Number(row.serie) >= 1)) {
    return STATUS_FISCAL_ADMIN.INVALIDA;
  }
  const campos = avaliarCamposProntidao(row);
  const pronta = campos.ambiente && campos.serie && campos.csc && campos.certificado && campos.sefaz;
  return pronta ? STATUS_FISCAL_ADMIN.PRONTA : STATUS_FISCAL_ADMIN.INCOMPLETA;
}

function dtoPublicoConfiguracao(empresa, row) {
  const path = require('path');
  const campos = avaliarCamposProntidao(row);
  const status = avaliarStatusAdmin(empresa, row);
  const nomeCert = row && preencherTexto(row.certificado_path)
    ? path.basename(String(row.certificado_path))
    : null;
  return {
    empresa_id: Number(empresa.id),
    cnpj: empresa.cnpj,
    razao_social: empresa.razao_social,
    ativo: Number(empresa.ativo) === 1 ? 1 : 0,
    ambiente: row && row.ambiente != null ? Number(row.ambiente) : null,
    ambiente_label: row && Number(row.ambiente) === 1
      ? 'PRODUCAO'
      : (row && Number(row.ambiente) === 2 ? 'HOMOLOGACAO' : null),
    serie: row && row.serie != null ? Number(row.serie) : null,
    numero_atual: row && row.numero_atual != null ? Number(row.numero_atual) : null,
    uf: (row && row.uf) || null,
    // ID CSC não é segredo — devolver valor real para a tela.
    // TOKEN CSC é segredo — apenas flag (nunca token_csc puro no DTO público).
    id_csc: row && preencherTexto(row.id_csc) ? String(row.id_csc).trim() : null,
    id_csc_configurado: !!(row && preencherTexto(row.id_csc)),
    csc_configurado: !!(row && preencherTexto(row.token_csc)),
    certificado_configurado: !!(row && preencherTexto(row.certificado_path) && preencherTexto(row.certificado_senha)),
    certificado_nome: nomeCert,
    sefaz_configurado: !!(row && (
      preencherTexto(row.ws_autorizacao)
      || preencherTexto(row.ws_autorizacao_homologacao)
      || preencherTexto(row.ws_autorizacao_producao)
    )),
    urls_homologacao: enriquecerBlocoUrlsExibicao(
      resolverUrlsEmpresa(row || {}).urlsHomologacao,
      { uf: (row && row.uf) || 'CE', ambiente: 2 }
    ),
    urls_producao: enriquecerBlocoUrlsExibicao(
      resolverUrlsEmpresa(row || {}).urlsProducao,
      { uf: (row && row.uf) || 'CE', ambiente: 1 }
    ),
    ie_configurada: !!(row && preencherTexto(row.ie)) || preencherTexto(empresa.inscricao_estadual),
    status,
    campos,
    configurada: !!row
  };
}

function exigirEmpresaAlvoAdministrativo(empresaIdParam, body) {
  const id = normalizarEmpresaId(empresaIdParam);
  if (!id) {
    throw erroConfig('EMPRESA_OBRIGATORIA', 'empresaId da rota é obrigatório.', { statusCode: 400 });
  }
  if (!body || typeof body !== 'object') return id;
  const bodyId = body.empresa_id != null ? body.empresa_id : body.empresaId;
  if (bodyId != null && bodyId !== '') {
    const n = Number(bodyId);
    if (n !== id) {
      throw erroConfig(
        'EMPRESA_CONFIGURACAO_DIVERGENTE',
        'empresa_id do body diverge da empresa da rota.',
        { statusCode: 409 }
      );
    }
  }
  return id;
}

async function obterEmpresaOuErro(empresaId, db) {
  const id = normalizarEmpresaId(empresaId);
  if (!id) throw erroConfig('EMPRESA_OBRIGATORIA', 'empresaId obrigatório.', { statusCode: 400 });
  await garantirSchemaFiscalEmpresaAsync(db);
  const empresa = await dbGet(db, `SELECT * FROM empresas WHERE id = ?`, [id]);
  if (!empresa) {
    throw erroConfig('EMPRESA_NAO_ENCONTRADA', `Empresa ${id} não cadastrada.`, { statusCode: 404 });
  }
  return empresa;
}

async function obterConfiguracaoFiscalEmpresa(empresaId, deps = {}) {
  const empresa = await obterEmpresaOuErro(empresaId, deps.db);
  const row = await dbGet(
    deps.db,
    `SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id = ?`,
    [empresa.id]
  );
  return dtoPublicoConfiguracao(empresa, row);
}

async function obterStatusFiscalEmpresa(empresaId, deps = {}) {
  const dto = await obterConfiguracaoFiscalEmpresa(empresaId, deps);
  return {
    empresa_id: dto.empresa_id,
    status: dto.status,
    campos: dto.campos
  };
}

async function listarStatusFiscalEmpresas(deps = {}) {
  const db = deps.db;
  await garantirSchemaFiscalEmpresaAsync(db);
  const empresas = await dbAll(db, `SELECT * FROM empresas ORDER BY id`);
  const out = [];
  for (const empresa of empresas) {
    const row = await dbGet(
      db,
      `SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id = ?`,
      [empresa.id]
    );
    const dto = dtoPublicoConfiguracao(empresa, row);
    out.push({
      empresa_id: dto.empresa_id,
      status: dto.status,
      campos: dto.campos
    });
  }
  return out;
}

async function salvarConfiguracaoFiscalEmpresa(empresaId, configuracao, deps = {}) {
  const db = deps.db;
  const id = exigirEmpresaAlvoAdministrativo(empresaId, configuracao);
  validarConfiguracaoFiscalEmpresa(id, configuracao);
  const empresa = await obterEmpresaOuErro(id, db);
  const patch = sanitizarPatchCsc(normalizarPayloadEscrita(configuracao));
  const existente = await dbGet(db, `SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id = ?`, [id]);

  let txAberta = false;
  try {
    await runSql(db, 'BEGIN IMMEDIATE');
    txAberta = true;
    const base = existente || {};
    const merged = {};
    for (const campo of CAMPOS_ESCRITA) {
      if (Object.prototype.hasOwnProperty.call(patch, campo)) {
        const valor = patch[campo];
        // Nunca apagar CSC/certificado com string vazia acidental.
        if (
          (campo === 'token_csc' || campo === 'id_csc' || campo === 'certificado_senha' || campo === 'certificado_path')
          && (valor == null || String(valor).trim() === '')
        ) {
          merged[campo] = base[campo] != null ? base[campo] : null;
        } else {
          merged[campo] = valor;
        }
      } else {
        merged[campo] = base[campo] != null ? base[campo] : null;
      }
    }
    if (merged.serie == null) merged.serie = 1;
    if (merged.numero_atual == null) merged.numero_atual = 1;
    if (!merged.uf) merged.uf = 'CE';
    complementarUrlsPorAmbiente(merged);
    await upsertConfiguracaoFiscalEmpresa(id, merged, db);
    if (typeof deps.aposPersistir === 'function') {
      await deps.aposPersistir({ empresaId: id, merged });
    }
    await runSql(db, 'COMMIT');
    txAberta = false;
  } catch (e) {
    if (txAberta) {
      try { await runSql(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw e;
  }
  return obterConfiguracaoFiscalEmpresa(empresa.id, { db });
}

async function removerConfiguracaoFiscalEmpresa(empresaId, deps = {}) {
  const empresa = await obterEmpresaOuErro(empresaId, deps.db);
  await runSql(deps.db, `DELETE FROM empresas_configuracao_fiscal WHERE empresa_id = ?`, [empresa.id]);
  return { empresa_id: Number(empresa.id), removida: true };
}

module.exports = {
  DDL_EMPRESAS_CONFIGURACAO_FISCAL,
  URL_CAMPOS_AMBIENTE,
  resolverUrlsEmpresa,
  STATUS_FISCAL_ADMIN,
  garantirSchemaFiscalEmpresaAsync,
  carregarConfiguracaoFiscalEmpresa,
  montarConfigEmpresa,
  upsertConfiguracaoFiscalEmpresa,
  atualizarNumeroAtualEmpresa,
  incrementaNumeroFiscalEmpresa,
  normalizarEmpresaId,
  validarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa,
  salvarConfiguracaoFiscalEmpresa,
  removerConfiguracaoFiscalEmpresa,
  obterStatusFiscalEmpresa,
  listarStatusFiscalEmpresas,
  exigirEmpresaAlvoAdministrativo,
  dtoPublicoConfiguracao
};
