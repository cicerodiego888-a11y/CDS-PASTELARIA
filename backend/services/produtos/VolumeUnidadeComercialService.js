'use strict';

const { familiaDe, normalizarUnidade } = require('../../motores/muc/core/unidadesSi');

const DDL_UNIDADES_VOLUME = `
  CREATE TABLE IF NOT EXISTS unidades_volume_comercial (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    sigla TEXT NOT NULL,
    sigla_normalizada TEXT NOT NULL UNIQUE,
    ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
    padrao INTEGER NOT NULL DEFAULT 0 CHECK (padrao IN (0, 1)),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

function erroUnidade(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function dbRun(db, sql, params = []) {
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

function normalizarNome(valor) {
  const nome = String(valor == null ? '' : valor).trim().replace(/\s+/g, ' ');
  if (!nome) throw erroUnidade('NOME_UNIDADE_OBRIGATORIO', 'Informe o nome da unidade.');
  if (nome.length > 80) throw erroUnidade('NOME_UNIDADE_INVALIDO', 'O nome da unidade deve ter no máximo 80 caracteres.');
  if (/[\u0000-\u001f\u007f]/.test(nome)) throw erroUnidade('NOME_UNIDADE_INVALIDO', 'O nome da unidade contém caracteres inválidos.');
  return nome;
}

function normalizarSigla(valor) {
  const sigla = String(valor == null ? '' : valor).trim().replace(/\s+/g, '').toUpperCase();
  if (!sigla) throw erroUnidade('SIGLA_UNIDADE_OBRIGATORIA', 'Informe a sigla da unidade.');
  if (sigla.length > 10 || !/^[A-Z0-9]+$/.test(sigla)) {
    throw erroUnidade('SIGLA_UNIDADE_INVALIDA', 'A sigla deve ter até 10 caracteres e conter apenas letras e números.');
  }
  return sigla;
}

function validarId(valor) {
  const id = Number(valor);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw erroUnidade('UNIDADE_VOLUME_INVALIDA', 'Selecione uma unidade de volume válida.');
  }
  return id;
}

async function garantirSchema(db, callback) {
  try {
    await dbRun(db, DDL_UNIDADES_VOLUME);
    const colunas = await new Promise((resolve, reject) => {
      db.all('PRAGMA table_info(produtos)', [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    if (!colunas.some((coluna) => coluna.name === 'volume_unidade_id')) {
      await dbRun(
        db,
        'ALTER TABLE produtos ADD COLUMN volume_unidade_id INTEGER REFERENCES unidades_volume_comercial(id)'
      );
    }

    for (const padrao of [
      { nome: 'Mililitro', sigla: 'ML' },
      { nome: 'Litro', sigla: 'L' }
    ]) {
      await dbRun(
        db,
        `INSERT OR IGNORE INTO unidades_volume_comercial
          (nome, sigla, sigla_normalizada, ativo, padrao)
         VALUES (?, ?, ?, 1, 1)`,
        [padrao.nome, padrao.sigla, padrao.sigla]
      );
    }

    await dbRun(
      db,
      `UPDATE produtos
       SET volume_unidade_id = (
         SELECT u.id
         FROM unidades_volume_comercial u
         WHERE u.sigla_normalizada = UPPER(TRIM(produtos.volume_unidade))
       )
       WHERE COALESCE(utiliza_volume, 0) = 1
         AND volume_unidade_id IS NULL
         AND UPPER(TRIM(COALESCE(volume_unidade, ''))) IN ('ML', 'L')`
    );
    if (typeof callback === 'function') callback(null);
  } catch (err) {
    if (typeof callback === 'function') callback(err);
    else throw err;
  }
}

async function listarAtivas(db) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, nome, sigla, ativo, padrao, created_at, updated_at
       FROM unidades_volume_comercial
       WHERE ativo = 1
       ORDER BY padrao DESC, nome COLLATE NOCASE, id`,
      [],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });
}

async function criar(db, payload) {
  const nome = normalizarNome(payload?.nome);
  const sigla = normalizarSigla(payload?.sigla);
  try {
    const result = await dbRun(
      db,
      `INSERT INTO unidades_volume_comercial (nome, sigla, sigla_normalizada, ativo, padrao)
       VALUES (?, ?, ?, 1, 0)`,
      [nome, sigla, sigla]
    );
    return await dbGet(
      db,
      `SELECT id, nome, sigla, ativo, padrao, created_at, updated_at
       FROM unidades_volume_comercial WHERE id = ?`,
      [result.lastID]
    );
  } catch (err) {
    if (/UNIQUE constraint failed: unidades_volume_comercial\.sigla_normalizada/i.test(String(err.message || ''))) {
      throw erroUnidade('UNIDADE_VOLUME_DUPLICADA', 'Já existe uma unidade com essa sigla.', 409);
    }
    throw err;
  }
}

async function obterPorId(db, unidadeId) {
  return dbGet(
    db,
    `SELECT id, nome, sigla, sigla_normalizada, ativo, padrao
     FROM unidades_volume_comercial WHERE id = ?`,
    [validarId(unidadeId)]
  );
}

async function resolverAssociacaoProduto(db, { unidadeId, sigla, produtoId = null } = {}) {
  const siglaNormalizada = normalizarSigla(sigla);
  let unidade = null;

  if (unidadeId !== undefined && unidadeId !== null && String(unidadeId).trim() !== '') {
    unidade = await obterPorId(db, unidadeId);
    if (!unidade) {
      throw erroUnidade('UNIDADE_VOLUME_NAO_ENCONTRADA', 'A unidade selecionada não existe.', 404);
    }
    if (unidade.sigla_normalizada !== siglaNormalizada) {
      throw erroUnidade('UNIDADE_VOLUME_DIVERGENTE', 'A sigla não corresponde à unidade selecionada.');
    }
  } else {
    const si = normalizarUnidade(siglaNormalizada);
    if (!si || familiaDe(si) !== 'VOLUME' || !['ML', 'L'].includes(si)) {
      throw erroUnidade('UNIDADE_VOLUME_ID_OBRIGATORIO', 'Selecione uma unidade cadastrada para usar esta sigla.');
    }
    unidade = await dbGet(
      db,
      `SELECT id, nome, sigla, sigla_normalizada, ativo, padrao
       FROM unidades_volume_comercial WHERE sigla_normalizada = ?`,
      [si]
    );
    if (!unidade) {
      throw erroUnidade('UNIDADE_VOLUME_NAO_ENCONTRADA', 'A unidade padrão não está cadastrada.', 500);
    }
  }

  if (Number(unidade.ativo) !== 1) {
    let podePreservar = false;
    if (produtoId != null) {
      const produto = await dbGet(
        db,
        'SELECT volume_unidade_id FROM produtos WHERE id = ?',
        [produtoId]
      );
      podePreservar = Number(produto?.volume_unidade_id) === Number(unidade.id);
    }
    if (!podePreservar) {
      throw erroUnidade('UNIDADE_VOLUME_INATIVA', 'A unidade selecionada está inativa.', 400);
    }
  }

  return unidade;
}

module.exports = {
  DDL_UNIDADES_VOLUME,
  erroUnidade,
  normalizarNome,
  normalizarSigla,
  garantirSchema,
  listarAtivas,
  criar,
  obterPorId,
  resolverAssociacaoProduto
};
