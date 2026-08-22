/**
 * Camada isolada de acesso a `estoque_empresa` (Fase 2 / Implementação 03.12).
 *
 * Não é a porta pública. Storage operacional permanece em `produtos`.
 * Sem COMPAT. Sem fallback para produtos. Sem backfill. Sem auto-create na consulta.
 *
 * @module services/estoque/EstoqueEmpresaService
 */
'use strict';

const { garantirSchemaEstoqueEmpresaAsync } = require('./estoqueEmpresaSchema');

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function erroAcesso(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
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

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function resolverIdPositivo(fonte, chaves) {
  if (fonte == null || fonte === '') return null;
  if (typeof fonte === 'number' || typeof fonte === 'string') {
    const n = Number(fonte);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  if (typeof fonte === 'object') {
    for (const chave of chaves) {
      if (fonte[chave] != null && fonte[chave] !== '') {
        const n = Number(fonte[chave]);
        if (Number.isInteger(n) && n > 0) return n;
      }
    }
  }
  return null;
}

function exigirEmpresaId(fonte) {
  const id = resolverIdPositivo(fonte, ['empresaId', 'empresa_id']);
  if (id == null) {
    throw erroAcesso(
      'EMPRESA_OBRIGATORIA',
      'empresaId é obrigatório para acesso a estoque_empresa.'
    );
  }
  return id;
}

function exigirProdutoId(fonte) {
  const id = resolverIdPositivo(fonte, ['produtoId', 'produto_id']);
  if (id == null) {
    throw erroAcesso('PRODUTO_INVALIDO', 'Produto inválido.');
  }
  return id;
}

function numeroOpcional(valor, padrao) {
  if (valor == null || valor === '') return padrao;
  const n = Number(valor);
  return Number.isFinite(n) ? round3(n) : padrao;
}

function mapearRegistro(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    produto_id: Number(row.produto_id),
    empresa_id: Number(row.empresa_id),
    saldo_fiscal: round3(row.saldo_fiscal),
    saldo_nao_fiscal: round3(row.saldo_nao_fiscal),
    estoque_atual: round3(row.estoque_atual),
    reservado_fiscal: round3(row.reservado_fiscal),
    reservado_nao_fiscal: round3(row.reservado_nao_fiscal),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

async function exigirProdutoExistente(db, produtoId) {
  const row = await dbGet(db, `SELECT id FROM produtos WHERE id = ? LIMIT 1`, [produtoId]);
  if (!row) {
    throw erroAcesso(
      'PRODUTO_NAO_ENCONTRADO',
      'Produto não encontrado.',
      { produto_id: produtoId }
    );
  }
}

async function exigirEmpresaExistente(db, empresaId) {
  const row = await dbGet(db, `SELECT id FROM empresas WHERE id = ? LIMIT 1`, [empresaId]);
  if (!row) {
    throw erroAcesso(
      'EMPRESA_NAO_ENCONTRADA',
      `Empresa não encontrada: ${empresaId}.`,
      { empresa_id: empresaId }
    );
  }
}

async function prepararAcesso(params = {}, opts = {}) {
  const db = getDb(opts.db != null ? opts.db : params.db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  const empresaId = exigirEmpresaId({ ...params, ...opts });
  const produtoId = exigirProdutoId({ ...params, ...opts });
  await exigirEmpresaExistente(db, empresaId);
  await exigirProdutoExistente(db, produtoId);
  return { db, produtoId, empresaId };
}

async function buscarLinha(db, produtoId, empresaId) {
  return dbGet(
    db,
    `SELECT id, produto_id, empresa_id,
            COALESCE(saldo_fiscal, 0) AS saldo_fiscal,
            COALESCE(saldo_nao_fiscal, 0) AS saldo_nao_fiscal,
            COALESCE(estoque_atual, 0) AS estoque_atual,
            COALESCE(reservado_fiscal, 0) AS reservado_fiscal,
            COALESCE(reservado_nao_fiscal, 0) AS reservado_nao_fiscal,
            created_at, updated_at
       FROM estoque_empresa
      WHERE produto_id = ? AND empresa_id = ?
      LIMIT 1`,
    [produtoId, empresaId]
  );
}

/**
 * Consulta o registro de estoque_empresa. Não cria linha. Não lê produtos.
 * @returns {Promise<object|null>}
 */
async function consultarSaldo(params = {}, opts = {}) {
  const { db, produtoId, empresaId } = await prepararAcesso(params, opts);
  return mapearRegistro(await buscarLinha(db, produtoId, empresaId));
}

/**
 * 03.15 — leitura técnica isolada para validação de estoque_empresa.
 * Delega exclusivamente a consultarSaldo. Sem fallback, sem criar, sem COMPAT.
 * @returns {Promise<object|null>}
 */
async function consultarSaldoTecnico(params = {}, opts = {}) {
  const registro = await consultarSaldo(params, opts);
  if (!registro) return null;
  return Object.freeze({
    produto_id: registro.produto_id,
    empresa_id: registro.empresa_id,
    saldo_fiscal: registro.saldo_fiscal,
    saldo_nao_fiscal: registro.saldo_nao_fiscal,
    estoque_atual: registro.estoque_atual,
    reservado_fiscal: registro.reservado_fiscal,
    reservado_nao_fiscal: registro.reservado_nao_fiscal
  });
}

/**
 * 03.16 — leitura controlada de estoque_empresa para uma empresa explícita.
 * null = não existe estoque isolado para esta empresa (não é fallback legado).
 * Aceita apenas empresaId no argumento. Sem COMPAT. Sem produtos.
 */
async function consultarSaldoParaEmpresa(params = {}, opts = {}) {
  const bruto = params.empresaId;
  const empresaId = Number(bruto);
  if (bruto == null || bruto === '' || !Number.isInteger(empresaId) || empresaId <= 0) {
    throw erroAcesso(
      'EMPRESA_OBRIGATORIA',
      'empresaId é obrigatório para consultar estoque_empresa.'
    );
  }

  const registro = await consultarSaldo(
    { produtoId: params.produtoId, empresaId, db: params.db },
    { db: opts.db != null ? opts.db : params.db }
  );
  if (!registro) return null;

  return Object.freeze({
    saldoFiscal: registro.saldo_fiscal,
    saldoNaoFiscal: registro.saldo_nao_fiscal,
    estoqueAtual: registro.estoque_atual,
    reservadoFiscal: registro.reservado_fiscal,
    reservadoNaoFiscal: registro.reservado_nao_fiscal
  });
}

async function existeRegistro(params = {}, opts = {}) {
  const registro = await consultarSaldo(params, opts);
  return registro != null;
}

/**
 * Cria registro explícito. Saldos default 0 — nunca copia de produtos.
 */
async function criarRegistro(params = {}, opts = {}) {
  const { db, produtoId, empresaId } = await prepararAcesso(params, opts);
  const existente = await buscarLinha(db, produtoId, empresaId);
  if (existente) {
    throw erroAcesso(
      'ESTOQUE_EMPRESA_DUPLICADO',
      'Já existe estoque_empresa para este produto e empresa.',
      { produto_id: produtoId, empresa_id: empresaId }
    );
  }

  const saldoFiscal = numeroOpcional(params.saldo_fiscal ?? params.saldoFiscal, 0);
  const saldoNaoFiscal = numeroOpcional(params.saldo_nao_fiscal ?? params.saldoNaoFiscal, 0);
  const estoqueAtual = params.estoque_atual != null || params.estoqueAtual != null
    ? numeroOpcional(params.estoque_atual ?? params.estoqueAtual, 0)
    : round3(saldoFiscal + saldoNaoFiscal);
  const reservadoFiscal = numeroOpcional(params.reservado_fiscal ?? params.reservadoFiscal, 0);
  const reservadoNaoFiscal = numeroOpcional(params.reservado_nao_fiscal ?? params.reservadoNaoFiscal, 0);

  try {
    await dbRun(
      db,
      `INSERT INTO estoque_empresa (
         produto_id, empresa_id,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual,
         reservado_fiscal, reservado_nao_fiscal,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        produtoId,
        empresaId,
        saldoFiscal,
        saldoNaoFiscal,
        estoqueAtual,
        reservadoFiscal,
        reservadoNaoFiscal
      ]
    );
  } catch (err) {
    const msg = String(err && err.message ? err.message : '');
    if (/UNIQUE/i.test(msg)) {
      throw erroAcesso(
        'ESTOQUE_EMPRESA_DUPLICADO',
        'Já existe estoque_empresa para este produto e empresa.',
        { produto_id: produtoId, empresa_id: empresaId }
      );
    }
    throw err;
  }

  return consultarSaldo({ produtoId, empresaId }, { db });
}

/**
 * Garante registro zerado (se não existir) e aplica somente o efeito informado.
 * Não lê saldo de `produtos`. Não faz backfill.
 */
async function aplicarEfeitoSaldo(params = {}, opts = {}) {
  const { db, produtoId, empresaId } = await prepararAcesso(params, opts);
  const existia = await buscarLinha(db, produtoId, empresaId);
  if (!existia) {
    await criarRegistro({ produtoId, empresaId }, { db });
  }

  const deltaFiscal = numeroOpcional(params.deltaSaldoFiscal ?? params.delta_saldo_fiscal, 0);
  const deltaNaoFiscal = numeroOpcional(params.deltaSaldoNaoFiscal ?? params.delta_saldo_nao_fiscal, 0);

  if (deltaFiscal === 0 && deltaNaoFiscal === 0) {
    const atual = await consultarSaldo({ produtoId, empresaId }, { db });
    return { ...atual, criado: !existia };
  }

  const atual = await buscarLinha(db, produtoId, empresaId);
  const saldoFiscal = round3(Number(atual.saldo_fiscal || 0) + deltaFiscal);
  const saldoNaoFiscal = round3(Number(atual.saldo_nao_fiscal || 0) + deltaNaoFiscal);
  const estoqueAtual = round3(saldoFiscal + saldoNaoFiscal);

  await dbRun(
    db,
    `UPDATE estoque_empresa
        SET saldo_fiscal = ?,
            saldo_nao_fiscal = ?,
            estoque_atual = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE produto_id = ? AND empresa_id = ?`,
    [saldoFiscal, saldoNaoFiscal, estoqueAtual, produtoId, empresaId]
  );

  const depois = await consultarSaldo({ produtoId, empresaId }, { db });
  return { ...depois, criado: !existia };
}

function pisoReservado(n) {
  return n < 0 ? 0 : n;
}

/**
 * 03.20 — garante registro zerado (se não existir) e aplica somente o delta de reserva.
 * Não altera saldo_fiscal, saldo_nao_fiscal nem estoque_atual. Não lê produtos.
 */
async function aplicarEfeitoReservado(params = {}, opts = {}) {
  const { db, produtoId, empresaId } = await prepararAcesso(params, opts);
  const existia = await buscarLinha(db, produtoId, empresaId);
  if (!existia) {
    await criarRegistro({ produtoId, empresaId }, { db });
  }

  const deltaFiscal = numeroOpcional(params.deltaReservadoFiscal ?? params.delta_reservado_fiscal, 0);
  const deltaNaoFiscal = numeroOpcional(params.deltaReservadoNaoFiscal ?? params.delta_reservado_nao_fiscal, 0);

  if (deltaFiscal === 0 && deltaNaoFiscal === 0) {
    const atual = await consultarSaldo({ produtoId, empresaId }, { db });
    return { ...atual, criado: !existia };
  }

  const atual = await buscarLinha(db, produtoId, empresaId);
  const reservadoFiscal = pisoReservado(round3(Number(atual.reservado_fiscal || 0) + deltaFiscal));
  const reservadoNaoFiscal = pisoReservado(round3(Number(atual.reservado_nao_fiscal || 0) + deltaNaoFiscal));

  await dbRun(
    db,
    `UPDATE estoque_empresa
        SET reservado_fiscal = ?,
            reservado_nao_fiscal = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE produto_id = ? AND empresa_id = ?`,
    [reservadoFiscal, reservadoNaoFiscal, produtoId, empresaId]
  );

  const depois = await consultarSaldo({ produtoId, empresaId }, { db });
  return { ...depois, criado: !existia };
}

module.exports = {
  consultarSaldo,
  consultarSaldoTecnico,
  consultarSaldoParaEmpresa,
  existeRegistro,
  criarRegistro,
  aplicarEfeitoSaldo,
  aplicarEfeitoReservado
};
