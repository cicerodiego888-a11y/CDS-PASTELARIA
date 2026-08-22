/**
 * Interface Pública de Saldos — Motor Fiscal × Não Fiscal.
 *
 * Única porta autorizada para consultar / debitar / creditar
 * saldo_fiscal e saldo_nao_fiscal de produtos.
 *
 * Fase 1 / Implementação 01: contrato passa a exigir empresaId/contexto
 * (ou modoLegadoSemEmpresa explícito).
 * Fase 2 / 03.19: escrita em `produtos` + dual-write em `estoque_empresa`
 * quando há empresaId.
 * Fase 2 / 03.35: consultarSaldo com empresaId lê `estoque_empresa`
 * (sem registro → zero). Sem empresaId permanece em `produtos`.
 * Writers (_ajustarSaldo / transferir) continuam lendo `produtos`.
 *
 * Outros Motores (ex.: MTS) DEVEM usar apenas estas funções.
 * Não exporta SQL nem acesso cru a tabelas.
 *
 * @module services/fiscalNaoFiscal/estoqueSaldosPublico
 */
'use strict';

const { TipoSaldo, normalizarTipoSaldo } = require('./constants');
const { recalcularEstoqueConsolidado } = require('../estoqueFiscalService');
const { calcularEstoqueProduto } = require('../estoque/EstoqueDisponivelService');
const {
  resolverEmpresaId,
  resolverContextoEmpresa,
  logOperacaoSaldo,
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
} = require('./empresaContexto');

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
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
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

/**
 * Normaliza assinatura:
 *   consultarSaldo(produtoId, opts)
 *   consultarSaldo({ produtoId, empresaId, ... }, opts)
 */
function normalizarArgsProduto(produtoIdOrParams, opts = {}) {
  if (
    produtoIdOrParams
    && typeof produtoIdOrParams === 'object'
    && !Array.isArray(produtoIdOrParams)
  ) {
    const p = produtoIdOrParams;
    const produtoId = p.produtoId != null ? p.produtoId : p.produto_id;
    const merged = {
      ...opts,
      ...p,
      empresaId: p.empresaId != null && p.empresaId !== '' ? p.empresaId : opts.empresaId,
      db: opts.db != null ? opts.db : p.db
    };
    return { produtoId, opts: merged };
  }
  return { produtoId: produtoIdOrParams, opts };
}

/** 03.35 — leitura isolada usa somente opts.empresaId (não body/query/contexto/empresa_id). */
function empresaIdExplicitoConsulta(opts) {
  return resolverEmpresaId(opts && opts.empresaId);
}

function montarRetornoConsultarSaldo(id, ctx, campos) {
  const saldoFiscal = round3(campos.saldoFiscal);
  const saldoNaoFiscal = round3(campos.saldoNaoFiscal);
  const estoqueAtual = round3(
    campos.estoqueAtual != null
      ? campos.estoqueAtual
      : recalcularEstoqueConsolidado({
        saldo_fiscal: saldoFiscal,
        saldo_nao_fiscal: saldoNaoFiscal
      })
  );
  const calc = calcularEstoqueProduto({
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: saldoNaoFiscal,
    reservado_fiscal: campos.reservadoFiscal,
    reservado_nao_fiscal: campos.reservadoNaoFiscal,
    estoque_atual: estoqueAtual
  });
  return Object.freeze({
    produto_id: id,
    empresa_id: ctx.empresaId,
    legado: ctx.legado,
    existe: true,
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: saldoNaoFiscal,
    estoque_atual: estoqueAtual,
    estoque_total: estoqueAtual,
    reservado_fiscal: calc.reservado_fiscal,
    reservado_nao_fiscal: calc.reservado_nao_fiscal,
    disponivel_fiscal: calc.disponivel_fiscal,
    disponivel_nao_fiscal: calc.disponivel_nao_fiscal,
    disponivel_total: calc.disponivel_total
  });
}

function camposDeLinhaProdutos(row) {
  return {
    saldoFiscal: row.saldo_fiscal,
    saldoNaoFiscal: row.saldo_nao_fiscal,
    estoqueAtual: row.estoque_atual,
    reservadoFiscal: row.reservado_fiscal,
    reservadoNaoFiscal: row.reservado_nao_fiscal
  };
}

async function lerLinhaProdutos(db, id) {
  return dbGet(
    db,
    `SELECT id,
            COALESCE(saldo_fiscal, 0) AS saldo_fiscal,
            COALESCE(saldo_nao_fiscal, 0) AS saldo_nao_fiscal,
            COALESCE(reservado_fiscal, 0) AS reservado_fiscal,
            COALESCE(reservado_nao_fiscal, 0) AS reservado_nao_fiscal,
            estoque_atual
     FROM produtos WHERE id = ?`,
    [id]
  );
}

/**
 * Leitura de writers: sempre `produtos` (dual-write 03.19).
 * Não usa estoque_empresa — senão o UPDATE absoluto corromperia o saldo global.
 */
async function consultarSaldoEmProdutos(produtoId, opts = {}) {
  const id = Number(produtoId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Produto inválido.');
    err.code = 'PRODUTO_INVALIDO';
    throw err;
  }
  const ctx = await resolverContextoEmpresa(opts);
  const db = getDb(opts.db);
  const row = await lerLinhaProdutos(db, id);
  if (!row) {
    const err = new Error('Produto não encontrado.');
    err.code = 'PRODUTO_NAO_ENCONTRADO';
    throw err;
  }
  return montarRetornoConsultarSaldo(id, ctx, camposDeLinhaProdutos(row));
}

/**
 * Consulta saldos públicos de um produto.
 * Sem empresaId: `produtos` (COMPAT / legado).
 * Com empresaId: `estoque_empresa`. Sem registro → zero. Sem fallback para produtos.
 *
 * @param {number|object} produtoIdOrParams
 * @param {{ db?: object, empresaId?: number, modoLegadoSemEmpresa?: boolean, validarEmpresa?: Function, usuarioId?: number }} [opts]
 */
async function consultarSaldo(produtoIdOrParams, opts = {}) {
  const normalized = normalizarArgsProduto(produtoIdOrParams, opts);
  const id = Number(normalized.produtoId);
  const callOpts = normalized.opts;

  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Produto inválido.');
    err.code = 'PRODUTO_INVALIDO';
    throw err;
  }

  const empresaId = empresaIdExplicitoConsulta(callOpts);
  const ctx = await resolverContextoEmpresa({
    db: callOpts.db,
    empresaId,
    modoLegadoSemEmpresa: callOpts.modoLegadoSemEmpresa === true,
    motivoCompat: callOpts.motivoCompat,
    validarEmpresa: callOpts.validarEmpresa,
    usuarioId: callOpts.usuarioId
  });
  const db = getDb(callOpts.db);
  const row = await lerLinhaProdutos(db, id);

  if (!row) {
    const err = new Error('Produto não encontrado.');
    err.code = 'PRODUTO_NAO_ENCONTRADO';
    throw err;
  }

  let campos = camposDeLinhaProdutos(row);

  const temEmpresas = ctx.empresaId != null && ctx.legado !== true
    ? await dbGet(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'empresas'`)
    : null;

  if (temEmpresas) {
    const EstoqueEmpresaService = require('../estoque/EstoqueEmpresaService');
    const iso = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId: id,
      empresaId: ctx.empresaId,
      db
    });
    campos = iso
      ? {
        saldoFiscal: iso.saldoFiscal,
        saldoNaoFiscal: iso.saldoNaoFiscal,
        estoqueAtual: iso.estoqueAtual,
        reservadoFiscal: iso.reservadoFiscal,
        reservadoNaoFiscal: iso.reservadoNaoFiscal
      }
      : {
        saldoFiscal: 0,
        saldoNaoFiscal: 0,
        estoqueAtual: 0,
        reservadoFiscal: 0,
        reservadoNaoFiscal: 0
      };
  }

  logOperacaoSaldo({
    operacao: 'consultarSaldo',
    produtoId: id,
    empresaId: ctx.empresaId,
    legado: ctx.legado,
    usuarioId: callOpts.usuarioId
  });

  return montarRetornoConsultarSaldo(id, ctx, campos);
}

/**
 * 03.19 — mesmo delta da porta em estoque_empresa.
 * Registro inexistente nasce zerado + efeito atual. Sem copiar produtos. Sem BEGIN.
 */
async function espelharEfeitoEmEstoqueEmpresa(db, produtoId, empresaId, tipoN, delta) {
  const temEmpresas = await dbGet(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'empresas'`
  );
  if (!temEmpresas) return;

  const EstoqueEmpresaService = require('../estoque/EstoqueEmpresaService');
  await EstoqueEmpresaService.aplicarEfeitoSaldo({
    produtoId,
    empresaId,
    deltaSaldoFiscal: tipoN === TipoSaldo.FISCAL ? delta : 0,
    deltaSaldoNaoFiscal: tipoN === TipoSaldo.NAO_FISCAL ? delta : 0
  }, { db });
}

async function _ajustarSaldo(produtoId, tipo, delta, opts = {}) {
  const tipoN = normalizarTipoSaldo(tipo);
  const q = round3(delta);
  if (!Number.isFinite(q) || q === 0) {
    const err = new Error('Quantidade de ajuste inválida.');
    err.code = 'QUANTIDADE_INVALIDA';
    throw err;
  }

  const ctx = await resolverContextoEmpresa(opts);
  const db = getDb(opts.db);
  const saldos = await consultarSaldoEmProdutos(produtoId, { ...opts, db });

  let saldoFiscal = saldos.saldo_fiscal;
  let saldoNaoFiscal = saldos.saldo_nao_fiscal;

  if (tipoN === TipoSaldo.FISCAL) {
    saldoFiscal = round3(saldoFiscal + q);
  } else {
    saldoNaoFiscal = round3(saldoNaoFiscal + q);
  }

  if (saldoFiscal < -1e-9 || saldoNaoFiscal < -1e-9) {
    const err = new Error(
      tipoN === TipoSaldo.FISCAL
        ? 'Saldo fiscal insuficiente.'
        : 'Saldo não fiscal insuficiente.'
    );
    err.code = 'SALDO_INSUFICIENTE';
    err.saldo_disponivel = tipoN === TipoSaldo.FISCAL
      ? saldos.saldo_fiscal
      : saldos.saldo_nao_fiscal;
    throw err;
  }

  // Invariante: estoque_atual = saldo_fiscal + saldo_nao_fiscal
  const estoqueTotal = round3(saldoFiscal + saldoNaoFiscal);

  await dbRun(
    db,
    `UPDATE produtos
     SET saldo_fiscal = ?,
         saldo_nao_fiscal = ?,
         estoque_atual = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [saldoFiscal, saldoNaoFiscal, estoqueTotal, saldos.produto_id]
  );

  if (ctx.empresaId != null && ctx.legado !== true) {
    await espelharEfeitoEmEstoqueEmpresa(db, saldos.produto_id, ctx.empresaId, tipoN, q);
  }

  logOperacaoSaldo({
    operacao: q < 0 ? 'debitarSaldo' : 'creditarSaldo',
    produtoId: saldos.produto_id,
    empresaId: ctx.empresaId,
    tipo: tipoN,
    quantidade: Math.abs(q),
    legado: ctx.legado,
    usuarioId: opts.usuarioId
  });

  return Object.freeze({
    produto_id: saldos.produto_id,
    empresa_id: ctx.empresaId,
    legado: ctx.legado,
    tipo: tipoN,
    delta: q,
    saldo_fiscal_antes: saldos.saldo_fiscal,
    saldo_nao_fiscal_antes: saldos.saldo_nao_fiscal,
    saldo_fiscal_depois: saldoFiscal,
    saldo_nao_fiscal_depois: saldoNaoFiscal,
    estoque_atual_depois: estoqueTotal,
    estoque_total_depois: estoqueTotal
  });
}

/**
 * Debita quantidade do tipo informado (saldo não pode ficar negativo).
 * @param {number} produtoId
 * @param {string} tipo
 * @param {number} quantidade
 * @param {{ empresaId?: number, empresa_id?: number, db?: object, modoLegadoSemEmpresa?: boolean }} [opts]
 */
async function debitarSaldo(produtoId, tipo, quantidade, opts = {}) {
  const q = round3(quantidade);
  if (!(q > 0)) {
    const err = new Error('Quantidade para débito deve ser maior que zero.');
    err.code = 'QUANTIDADE_INVALIDA';
    throw err;
  }
  return _ajustarSaldo(produtoId, tipo, -q, opts);
}

/**
 * Credita quantidade no tipo informado.
 */
async function creditarSaldo(produtoId, tipo, quantidade, opts = {}) {
  const q = round3(quantidade);
  if (!(q > 0)) {
    const err = new Error('Quantidade para crédito deve ser maior que zero.');
    err.code = 'QUANTIDADE_INVALIDA';
    throw err;
  }
  return _ajustarSaldo(produtoId, tipo, q, opts);
}

/**
 * Transferência Fiscal ↔ Não Fiscal do MESMO produto + mesma empresa.
 * NÃO é transferência entre CNPJs/empresas.
 *
 * @param {{ produtoId?: number, produto_id?: number, empresaId?: number, empresa_id?: number, origem: string, destino: string, quantidade: number }} params
 */
async function transferirSaldoEntreTipos(params = {}, opts = {}) {
  const produtoId = Number(params.produtoId || params.produto_id);
  const origem = normalizarTipoSaldo(params.origem);
  const destino = normalizarTipoSaldo(params.destino);
  const quantidade = round3(params.quantidade);
  const callOpts = {
    ...opts,
    empresaId: resolverEmpresaId(params) ?? resolverEmpresaId(opts),
    modoLegadoSemEmpresa: opts.modoLegadoSemEmpresa === true
      || params.modoLegadoSemEmpresa === true,
    motivoCompat: opts.motivoCompat || params.motivoCompat,
    validarEmpresa: opts.validarEmpresa || params.validarEmpresa,
    usuarioId: opts.usuarioId != null ? opts.usuarioId : params.usuarioId,
    db: opts.db != null ? opts.db : params.db
  };

  if (origem === destino) {
    const err = new Error('Origem e destino devem ser diferentes.');
    err.code = 'ORIGEM_DESTINO_IGUAIS';
    throw err;
  }
  if (!(quantidade > 0)) {
    const err = new Error('Quantidade deve ser maior que zero.');
    err.code = 'QUANTIDADE_INVALIDA';
    throw err;
  }

  const ctx = await resolverContextoEmpresa(callOpts);
  const db = getDb(callOpts.db);
  const antes = await consultarSaldoEmProdutos(produtoId, { ...callOpts, db });
  const disponivel = origem === TipoSaldo.FISCAL
    ? antes.saldo_fiscal
    : antes.saldo_nao_fiscal;

  if (disponivel + 1e-9 < quantidade) {
    const err = new Error(
      origem === TipoSaldo.FISCAL
        ? 'Saldo fiscal insuficiente.'
        : 'Saldo não fiscal insuficiente.'
    );
    err.code = 'SALDO_INSUFICIENTE';
    err.saldo_disponivel = disponivel;
    throw err;
  }

  const debito = await debitarSaldo(produtoId, origem, quantidade, { ...callOpts, db });
  const credito = await creditarSaldo(produtoId, destino, quantidade, { ...callOpts, db });
  const depois = await consultarSaldoEmProdutos(produtoId, { ...callOpts, db });

  logOperacaoSaldo({
    operacao: 'transferirSaldoEntreTipos',
    produtoId,
    empresaId: ctx.empresaId,
    tipo: `${origem}->${destino}`,
    quantidade,
    legado: ctx.legado,
    usuarioId: callOpts.usuarioId
  });

  return Object.freeze({
    produto_id: produtoId,
    empresa_id: ctx.empresaId,
    legado: ctx.legado,
    origem,
    destino,
    quantidade,
    saldo_origem_antes: origem === TipoSaldo.FISCAL
      ? antes.saldo_fiscal
      : antes.saldo_nao_fiscal,
    saldo_origem_depois: origem === TipoSaldo.FISCAL
      ? depois.saldo_fiscal
      : depois.saldo_nao_fiscal,
    saldo_destino_antes: destino === TipoSaldo.FISCAL
      ? antes.saldo_fiscal
      : antes.saldo_nao_fiscal,
    saldo_destino_depois: destino === TipoSaldo.FISCAL
      ? depois.saldo_fiscal
      : depois.saldo_nao_fiscal,
    debito,
    credito,
    saldos: depois
  });
}

/**
 * Executa callback dentro de BEGIN IMMEDIATE / COMMIT (rollback em falha).
 * @param {Function} work async (db) => result
 * @param {{ db?: object }} [opts]
 */
async function executarEmTransacao(work, opts = {}) {
  const db = getDb(opts.db);
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    const result = await work(db);
    await dbRun(db, 'COMMIT');
    return result;
  } catch (err) {
    try {
      await dbRun(db, 'ROLLBACK');
    } catch (_) { /* ignore */ }
    throw err;
  }
}

module.exports = {
  TipoSaldo,
  normalizarTipoSaldo,
  consultarSaldo,
  debitarSaldo,
  creditarSaldo,
  transferirSaldoEntreTipos,
  executarEmTransacao,
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
};
