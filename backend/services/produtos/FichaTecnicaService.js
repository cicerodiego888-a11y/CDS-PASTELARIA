/**
 * Ficha técnica do produto comercial — catálogo compartilhado (03.03).
 * Sem empresa_id: a ficha é do produto, não do CNPJ.
 * Sem baixa de estoque. Sem fallback de empresa.
 *
 * @module services/produtos/FichaTecnicaService
 */
'use strict';

const MotorUM = require('../unidades/MotorUnidadesMedida');
const { obterMuc } = require('../../motores/muc/public');
const {
  TipoOperacionalProduto,
  normalizarTipoOperacional
} = require('./tipoOperacionalProduto');
const { garantirSchemaFichaTecnicaAsync } = require('./fichaTecnicaSchema');

function erroFicha(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../database');
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

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function validarUnidadeFicha(unidade) {
  const raw = String(unidade || '').trim();
  if (!raw) {
    throw erroFicha('UNIDADE_INVALIDA', 'Unidade da ficha é obrigatória.');
  }
  const { isUnidadeConhecida, normalizarUnidade } = require('../../motores/muc/core/unidadesSi');
  const dest = normalizarUnidade(raw);
  if (!dest || !isUnidadeConhecida(dest)) {
    if (!MotorUM.isUnidadeComercialConhecida(raw)) {
      throw erroFicha('UNIDADE_INVALIDA', `Unidade inválida: ${unidade || '(vazia)'}.`);
    }
    return MotorUM.normalizarUnidadeComercial(raw);
  }
  return dest;
}

function converterQuantidadeFicha(entrada = {}) {
  const db = entrada.db || getDb();
  const muc = obterMuc(db);
  if (entrada.quantidade != null && (entrada.unidadeOrigem || entrada.unidade) && entrada.unidadeDestino) {
    return muc.converterQuantidade({
      quantidade: entrada.quantidade,
      unidadeOrigem: entrada.unidadeOrigem || entrada.unidade,
      unidadeDestino: entrada.unidadeDestino,
      relacoes: entrada.relacoes
    });
  }
  return muc.converter(entrada);
}

async function obterProduto(db, id) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw erroFicha('PRODUTO_INEXISTENTE', 'Produto inexistente.', 404);
  }
  const row = await dbGet(
    db,
    `SELECT id, nome, ativo, unidade, COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional
     FROM produtos WHERE id = ?`,
    [pid]
  );
  if (!row) throw erroFicha('PRODUTO_INEXISTENTE', 'Produto inexistente.', 404);
  return row;
}

async function listarInsumos(opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  return dbAll(
    db,
    `SELECT id, codigo, nome, unidade, COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional
     FROM produtos
     WHERE COALESCE(tipo_operacional, 'COMERCIAL') = ?
       AND COALESCE(ativo, 1) = 1
     ORDER BY nome`,
    [TipoOperacionalProduto.INSUMO]
  );
}

async function obterPorProdutoId(produtoId, opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  const produto = await obterProduto(db, produtoId);
  const cab = await dbGet(db, 'SELECT * FROM ficha_tecnica WHERE produto_id = ?', [produto.id]);
  if (!cab) {
    return { produto_id: produto.id, ativo: 0, itens: [] };
  }
  const itens = await dbAll(
    db,
    `SELECT i.id, i.insumo_id, i.quantidade, i.unidade, p.nome AS insumo_nome, p.unidade AS insumo_unidade
     FROM ficha_tecnica_itens i
     JOIN produtos p ON p.id = i.insumo_id
     WHERE i.ficha_tecnica_id = ?
     ORDER BY i.id`,
    [cab.id]
  );
  return { ...cab, itens };
}

async function excluirPorProdutoId(produtoId, opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  const cab = await dbGet(db, 'SELECT id FROM ficha_tecnica WHERE produto_id = ?', [Number(produtoId)]);
  if (!cab) return { excluida: false };
  await dbRun(db, 'DELETE FROM ficha_tecnica_itens WHERE ficha_tecnica_id = ?', [cab.id]);
  await dbRun(db, 'DELETE FROM ficha_tecnica WHERE id = ?', [cab.id]);
  return { excluida: true };
}

async function salvar(produtoId, payload = {}, opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  const produto = await obterProduto(db, produtoId);
  if (Number(produto.ativo) === 0) {
    throw erroFicha('PRODUTO_INATIVO', 'Produto inativo não recebe ficha técnica.');
  }
  if (normalizarTipoOperacional(produto.tipo_operacional) !== TipoOperacionalProduto.COMERCIAL) {
    throw erroFicha(
      'FICHA_SOMENTE_COMERCIAL',
      'Ficha técnica aplica-se somente a produto comercial.'
    );
  }

  const itens = Array.isArray(payload.itens) ? payload.itens : [];
  const visto = new Set();

  for (const raw of itens) {
    const insumoId = Number(raw.insumo_id != null ? raw.insumo_id : raw.insumoId);
    const qtd = Number(raw.quantidade);
    if (!Number.isInteger(insumoId) || insumoId <= 0) {
      throw erroFicha('INSUMO_INVALIDO', 'Insumo inválido.');
    }
    if (!(qtd > 0)) {
      throw erroFicha('QUANTIDADE_INVALIDA', 'Quantidade da ficha técnica deve ser positiva.');
    }
    const unidade = validarUnidadeFicha(raw.unidade);
    if (visto.has(insumoId)) {
      throw erroFicha('INSUMO_DUPLICADO', 'Componente duplicado na ficha técnica.');
    }
    visto.add(insumoId);

    let insumo;
    try {
      insumo = await obterProduto(db, insumoId);
    } catch (e) {
      if (e.code === 'PRODUTO_INEXISTENTE') {
        throw erroFicha('INSUMO_INEXISTENTE', 'Insumo inexistente.', 404);
      }
      throw e;
    }
    if (Number(insumo.ativo) === 0) {
      throw erroFicha('INSUMO_INATIVO', 'Insumo inativo.');
    }
    if (normalizarTipoOperacional(insumo.tipo_operacional) !== TipoOperacionalProduto.INSUMO) {
      throw erroFicha(
        'COMPONENTE_NAO_INSUMO',
        'Produto comercial não pode ser utilizado como insumo.'
      );
    }
    const fichaDoInsumo = await dbGet(
      db,
      'SELECT id FROM ficha_tecnica WHERE produto_id = ? AND COALESCE(ativo, 1) = 1',
      [insumo.id]
    );
    if (fichaDoInsumo) {
      throw erroFicha(
        'INSUMO_NAO_PODE_TER_FICHA',
        'Insumo não pode ter ficha técnica de outro insumo.'
      );
    }
    raw._ok = { insumo_id: insumo.id, quantidade: qtd, unidade };
  }

  const existente = await dbGet(db, 'SELECT id FROM ficha_tecnica WHERE produto_id = ?', [produto.id]);
  const ativo = payload.ativo === 0 || payload.ativo === false ? 0 : 1;
  let fichaId;
  if (existente) {
    await dbRun(
      db,
      `UPDATE ficha_tecnica SET ativo = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [ativo, existente.id]
    );
    fichaId = existente.id;
    await dbRun(db, 'DELETE FROM ficha_tecnica_itens WHERE ficha_tecnica_id = ?', [fichaId]);
  } else {
    const ins = await dbRun(
      db,
      `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, ?)`,
      [produto.id, ativo]
    );
    fichaId = ins.lastID;
  }

  for (const raw of itens) {
    const it = raw._ok;
    await dbRun(
      db,
      `INSERT INTO ficha_tecnica_itens (ficha_tecnica_id, insumo_id, quantidade, unidade)
       VALUES (?, ?, ?, ?)`,
      [fichaId, it.insumo_id, it.quantidade, it.unidade]
    );
  }

  return obterPorProdutoId(produto.id, { db });
}

module.exports = {
  listarInsumos,
  obterPorProdutoId,
  salvar,
  excluirPorProdutoId,
  converterQuantidadeFicha,
  validarUnidadeFicha
};
