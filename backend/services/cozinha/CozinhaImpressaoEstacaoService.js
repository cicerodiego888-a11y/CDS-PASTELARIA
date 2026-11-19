/**
 * CRUD de estações de impressão — Sprint 06 Bloco A.
 * Isolamento por empresa + unidade. Sem impressão física.
 */
'use strict';

const {
  erroImpressao,
  parsePositiveInteger,
  normalizarCodigoEstacao,
  normalizarLarguraMm,
  normalizarVias,
  normalizarFlag01
} = require('./cozinhaImpressaoContratos');
const { exigirUnidadeOperacional } = require('./cozinhaUnidadeOperacional');
const { renderizarTesteEstacao } = require('./CozinhaImpressaoRenderer');

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function exigirEmpresa(empresaId) {
  const id = parsePositiveInteger(empresaId);
  if (!id) {
    throw erroImpressao('empresa_id obrigatório.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return id;
}

function mapearEstacao(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    unidade_id: row.unidade_id,
    codigo_estacao: row.codigo_estacao,
    device_name: row.device_name,
    largura_mm: row.largura_mm,
    vias: row.vias,
    modelo_individual: Number(row.modelo_individual) === 1,
    modelo_agrupado: Number(row.modelo_agrupado) === 1,
    ativo: Number(row.ativo) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function exigirUnidadeDaEmpresa(db, empresaId, unidadeId) {
  const unidade = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo
    FROM cozinha_unidades
    WHERE id = ? AND empresa_id = ?
  `, [unidadeId, empresaId]);
  if (!unidade) {
    throw erroImpressao(
      'Unidade não pertence à empresa autenticada.',
      403,
      'UNIDADE_EMPRESA_ISOLAMENTO'
    );
  }
  return unidade;
}

async function listarEstacoes(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);

  const apenasAtivas = entrada.apenas_ativas === true || entrada.apenasAtivas === true;
  const rows = await dbAll(db, `
    SELECT *
    FROM cozinha_estacoes_impressao
    WHERE empresa_id = ? AND unidade_id = ?
      ${apenasAtivas ? 'AND ativo = 1' : ''}
    ORDER BY codigo_estacao COLLATE NOCASE ASC, id ASC
  `, [empresaId, unidadeId]);

  return {
    success: true,
    empresa_id: empresaId,
    unidade_id: unidadeId,
    estacoes: rows.map(mapearEstacao)
  };
}

async function obterEstacao(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const id = parsePositiveInteger(entrada.id != null ? entrada.id : entrada.estacaoId);
  if (!id) throw erroImpressao('Estação inválida.', 400, 'ESTACAO_ID_INVALIDO');

  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);

  const row = await dbGet(db, `
    SELECT *
    FROM cozinha_estacoes_impressao
    WHERE id = ? AND empresa_id = ? AND unidade_id = ?
  `, [id, empresaId, unidadeId]);

  if (!row) {
    throw erroImpressao('Estação não encontrada.', 404, 'ESTACAO_NAO_ENCONTRADA');
  }
  return { success: true, estacao: mapearEstacao(row) };
}

async function criarEstacao(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);

  const codigo = normalizarCodigoEstacao(
    entrada.codigo_estacao != null ? entrada.codigo_estacao : entrada.codigoEstacao
  );
  const deviceName = entrada.device_name != null
    ? String(entrada.device_name).trim() || null
    : (entrada.deviceName != null ? String(entrada.deviceName).trim() || null : null);
  const larguraMm = normalizarLarguraMm(
    entrada.largura_mm != null ? entrada.largura_mm : entrada.larguraMm
  );
  const vias = normalizarVias(entrada.vias);
  const modeloIndividual = normalizarFlag01(
    entrada.modelo_individual != null ? entrada.modelo_individual : entrada.modeloIndividual,
    1
  );
  const modeloAgrupado = normalizarFlag01(
    entrada.modelo_agrupado != null ? entrada.modelo_agrupado : entrada.modeloAgrupado,
    1
  );
  const ativo = normalizarFlag01(entrada.ativo, 1);

  try {
    const result = await dbRun(db, `
      INSERT INTO cozinha_estacoes_impressao (
        empresa_id, unidade_id, codigo_estacao, device_name,
        largura_mm, vias, modelo_individual, modelo_agrupado, ativo, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      empresaId, unidadeId, codigo, deviceName,
      larguraMm, vias, modeloIndividual, modeloAgrupado, ativo
    ]);
    return obterEstacao({ db, empresaId, unidadeId, id: result.lastID }, { db });
  } catch (err) {
    if (/UNIQUE|unique/i.test(String(err && err.message))) {
      throw erroImpressao(
        'Já existe estação com este codigo_estacao nesta unidade.',
        409,
        'ESTACAO_CODIGO_DUPLICADO'
      );
    }
    throw err;
  }
}

async function atualizarEstacao(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const id = parsePositiveInteger(entrada.id != null ? entrada.id : entrada.estacaoId);
  if (!id) throw erroImpressao('Estação inválida.', 400, 'ESTACAO_ID_INVALIDO');

  const atual = await obterEstacao({ db, empresaId, unidadeId, id }, { db });
  const body = entrada.dados && typeof entrada.dados === 'object' ? entrada.dados : entrada;

  const codigo = body.codigo_estacao != null || body.codigoEstacao != null
    ? normalizarCodigoEstacao(body.codigo_estacao != null ? body.codigo_estacao : body.codigoEstacao)
    : atual.estacao.codigo_estacao;

  const deviceName = body.device_name !== undefined
    ? (body.device_name == null ? null : String(body.device_name).trim() || null)
    : (body.deviceName !== undefined
      ? (body.deviceName == null ? null : String(body.deviceName).trim() || null)
      : atual.estacao.device_name);

  const larguraMm = body.largura_mm != null || body.larguraMm != null
    ? normalizarLarguraMm(body.largura_mm != null ? body.largura_mm : body.larguraMm)
    : atual.estacao.largura_mm;

  const vias = body.vias != null
    ? normalizarVias(body.vias)
    : atual.estacao.vias;

  const modeloIndividual = body.modelo_individual != null || body.modeloIndividual != null
    ? normalizarFlag01(body.modelo_individual != null ? body.modelo_individual : body.modeloIndividual)
    : (atual.estacao.modelo_individual ? 1 : 0);

  const modeloAgrupado = body.modelo_agrupado != null || body.modeloAgrupado != null
    ? normalizarFlag01(body.modelo_agrupado != null ? body.modelo_agrupado : body.modeloAgrupado)
    : (atual.estacao.modelo_agrupado ? 1 : 0);

  const ativo = body.ativo != null
    ? normalizarFlag01(body.ativo)
    : (atual.estacao.ativo ? 1 : 0);

  try {
    const result = await dbRun(db, `
      UPDATE cozinha_estacoes_impressao
      SET codigo_estacao = ?,
          device_name = ?,
          largura_mm = ?,
          vias = ?,
          modelo_individual = ?,
          modelo_agrupado = ?,
          ativo = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND empresa_id = ? AND unidade_id = ?
    `, [
      codigo, deviceName, larguraMm, vias,
      modeloIndividual, modeloAgrupado, ativo,
      id, empresaId, unidadeId
    ]);
    if (!result.changes) {
      throw erroImpressao('Estação não encontrada.', 404, 'ESTACAO_NAO_ENCONTRADA');
    }
    return obterEstacao({ db, empresaId, unidadeId, id }, { db });
  } catch (err) {
    if (err.codigo) throw err;
    if (/UNIQUE|unique/i.test(String(err && err.message))) {
      throw erroImpressao(
        'Já existe estação com este codigo_estacao nesta unidade.',
        409,
        'ESTACAO_CODIGO_DUPLICADO'
      );
    }
    throw err;
  }
}

/**
 * Teste de contrato da estação (D6): render preview, sem fila e sem print físico.
 */
async function testarEstacao(entrada = {}, opts = {}) {
  const obtido = await obterEstacao(entrada, opts);
  const estacao = obtido.estacao;
  const render = renderizarTesteEstacao(estacao);
  return {
    success: true,
    estacao,
    teste: render,
    impressao_fisica: false
  };
}

module.exports = {
  listarEstacoes,
  obterEstacao,
  criarEstacao,
  atualizarEstacao,
  testarEstacao,
  mapearEstacao
};
