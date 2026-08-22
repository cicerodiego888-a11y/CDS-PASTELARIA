/**
 * Núcleo persistente do atendimento MULTIEMPRESA (Sprint 04.03).
 * Agrupa itens, valida estoque por empresa e persiste atomicamente.
 * Não cria vendas, não paga, não baixa estoque.
 *
 * @module motores/muv/AtendimentoMultiempresaService
 */
'use strict';

const reservasPublico = require('../../services/fiscalNaoFiscal/reservasPublico');
const EmpresaService = require('../../services/empresas/EmpresaService');
const { garantirSchemaAtendimentoAsync } = require('./atendimentoSchema');
const {
  ModoOperacaoVenda,
  STATUS_ATENDIMENTO,
  STATUS_OPERACAO_EMPRESARIAL,
  AtomicidadeMuv,
  arredondarCentavosMuv,
  validarItensEntradaAtendimento,
  agruparItensPorEmpresa,
  TIPO_FISCAL_ITEM_ATENDIMENTO
} = require('./contratos');

function erroAtendimento(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  if (extra.statusCode != null) err.statusCode = extra.statusCode;
  if (extra.detalhes != null) err.detalhes = extra.detalhes;
  return err;
}

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../database');
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

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function gerarCodigoProvisorio() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `ATD-${t}-${r}`;
}

function codigoOperacional(id) {
  return `ATD-${String(id).padStart(8, '0')}`;
}

async function exigirEmpresaCadastrada(db, empresaId) {
  try {
    await EmpresaService.buscarEmpresaPorId(empresaId, { db });
  } catch (e) {
    throw erroAtendimento(
      'EMPRESA_INVALIDA',
      `Empresa inválida: ${empresaId}.`,
      { statusCode: 400, detalhes: { empresaId } }
    );
  }
}

function escolherDisponivel(disp, tipoFiscal) {
  if (tipoFiscal === TIPO_FISCAL_ITEM_ATENDIMENTO.FISCAL) {
    return Number(disp.disponivel_fiscal || 0);
  }
  if (tipoFiscal === TIPO_FISCAL_ITEM_ATENDIMENTO.NAO_FISCAL) {
    return Number(disp.disponivel_nao_fiscal || 0);
  }
  return Number(disp.disponivel_total || 0);
}

async function validarEstoqueOperacoes(operacoes, deps) {
  const consultar = typeof deps.consultarDisponibilidade === 'function'
    ? deps.consultarDisponibilidade
    : (produtoId, opts) => reservasPublico.consultarDisponibilidade(produtoId, opts);

  const insuficientes = [];
  for (const op of operacoes) {
    for (const item of op.itens) {
      const disp = await consultar(item.produtoId, {
        db: deps.db,
        empresaId: item.empresaId
      });
      const disponivel = escolherDisponivel(disp, item.tipoFiscal);
      if (disponivel + 1e-9 < item.quantidade) {
        insuficientes.push({
          produtoId: item.produtoId,
          empresaId: item.empresaId,
          solicitado: item.quantidade,
          disponivel
        });
      }
    }
  }

  if (insuficientes.length) {
    const primeiro = insuficientes[0];
    throw erroAtendimento(
      'SALDO_INSUFICIENTE',
      `Saldo insuficiente do produto ${primeiro.produtoId} na empresa ${primeiro.empresaId}.`,
      { statusCode: 409, detalhes: insuficientes }
    );
  }
}

async function persistirAtendimento(db, origem, operacoes, valorTotal, deps) {
  const codigoTemp = gerarCodigoProvisorio();
  const atendimentoIns = await dbRun(
    db,
    `INSERT INTO atendimentos (
       codigo, modo_operacao, origem, status,
       valor_total, quantidade_operacoes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      codigoTemp,
      ModoOperacaoVenda.MULTIEMPRESA,
      origem,
      STATUS_ATENDIMENTO.ABERTO,
      0,
      0
    ]
  );
  const atendimentoId = atendimentoIns.lastID;
  const codigo = codigoOperacional(atendimentoId);
  await dbRun(
    db,
    `UPDATE atendimentos SET codigo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [codigo, atendimentoId]
  );

  const operacoesPersistidas = [];
  for (const op of operacoes) {
    const opIns = await dbRun(
      db,
      `INSERT INTO atendimento_operacoes (
         atendimento_id, empresa_id, status, subtotal, quantidade_itens,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        atendimentoId,
        op.empresaId,
        STATUS_OPERACAO_EMPRESARIAL.ABERTA,
        op.subtotal,
        op.quantidadeItens
      ]
    );
    const operacaoId = opIns.lastID;
    const itensPersistidos = [];
    for (const item of op.itens) {
      if (item.empresaId !== op.empresaId) {
        throw erroAtendimento(
          'ATENDIMENTO_INVALIDO',
          'empresa_id do item diverge da operação empresarial.',
          { statusCode: 500, detalhes: { operacaoId, empresaId: op.empresaId, item } }
        );
      }
      const itemIns = await dbRun(
        db,
        `INSERT INTO atendimento_operacao_itens (
           operacao_id, produto_id, empresa_id, quantidade,
           valor_unitario, valor_total, tipo_fiscal,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          operacaoId,
          item.produtoId,
          item.empresaId,
          item.quantidade,
          item.valorUnitario,
          item.valorTotal,
          item.tipoFiscal
        ]
      );
      itensPersistidos.push({
        itemId: itemIns.lastID,
        produtoId: item.produtoId,
        empresaId: item.empresaId,
        quantidade: item.quantidade,
        valorUnitario: item.valorUnitario,
        valorTotal: item.valorTotal,
        tipoFiscal: item.tipoFiscal
      });
    }
    operacoesPersistidas.push({
      operacaoId,
      empresaId: op.empresaId,
      subtotal: op.subtotal,
      quantidadeItens: op.quantidadeItens,
      status: STATUS_OPERACAO_EMPRESARIAL.VALIDADA,
      itens: itensPersistidos
    });
  }

  const somaOps = arredondarCentavosMuv(
    operacoesPersistidas.reduce((acc, op) => acc + op.subtotal, 0)
  );
  if (Math.abs(somaOps - valorTotal) > 0.009) {
    throw erroAtendimento(
      'ATENDIMENTO_INVALIDO',
      'Total do atendimento diverge da soma das operações.',
      { statusCode: 500, detalhes: { valorTotal, somaOps } }
    );
  }

  await dbRun(
    db,
    `UPDATE atendimento_operacoes
        SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE atendimento_id = ?`,
    [STATUS_OPERACAO_EMPRESARIAL.VALIDADA, atendimentoId]
  );
  await dbRun(
    db,
    `UPDATE atendimentos
        SET status = ?, valor_total = ?, quantidade_operacoes = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [
      STATUS_ATENDIMENTO.VALIDADO,
      valorTotal,
      operacoesPersistidas.length,
      atendimentoId
    ]
  );

  if (typeof deps.aposPersistirParcial === 'function') {
    await deps.aposPersistirParcial({ atendimentoId, operacoes: operacoesPersistidas });
  }

  return {
    atendimentoId,
    codigo,
    modo_operacao: ModoOperacaoVenda.MULTIEMPRESA,
    status: STATUS_ATENDIMENTO.VALIDADO,
    total: valorTotal,
    operacoes: operacoesPersistidas
  };
}

/**
 * @param {{ origem?: string, itens: Array }} entrada
 * @param {{ db?: object, consultarDisponibilidade?: Function, aposPersistirParcial?: Function }} [deps]
 */
async function criarAtendimento(entrada = {}, deps = {}) {
  const db = getDb(deps.db);
  const origem = String(entrada.origem || 'PDV').trim() || 'PDV';
  const itens = validarItensEntradaAtendimento(entrada.itens);
  const operacoes = agruparItensPorEmpresa(itens);
  if (operacoes.length === 0) {
    throw erroAtendimento(
      'ITENS_ATENDIMENTO_OBRIGATORIOS',
      'Informe ao menos um item para o atendimento multiempresa.',
      { statusCode: 400 }
    );
  }

  await garantirSchemaAtendimentoAsync(db);

  for (const op of operacoes) {
    await exigirEmpresaCadastrada(db, op.empresaId);
  }

  await validarEstoqueOperacoes(operacoes, { ...deps, db });

  const valorTotal = arredondarCentavosMuv(
    operacoes.reduce((acc, op) => acc + op.subtotal, 0)
  );

  let txAberta = false;
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    txAberta = true;
    const preview = await persistirAtendimento(db, origem, operacoes, valorTotal, deps);
    await dbRun(db, 'COMMIT');
    txAberta = false;
    return Object.freeze({
      ...preview,
      atomicidade: AtomicidadeMuv.ROLLBACK_TOTAL,
      venda_concluida: false,
      pagamento_pendente: true
    });
  } catch (e) {
    if (txAberta) {
      try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}

async function obterAtendimento(atendimentoId, deps = {}) {
  const db = getDb(deps.db);
  const id = Number(atendimentoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroAtendimento('ATENDIMENTO_INVALIDO', 'atendimentoId inválido.', { statusCode: 400 });
  }
  const cab = await dbGet(db, `SELECT * FROM atendimentos WHERE id = ?`, [id]);
  if (!cab) {
    throw erroAtendimento('ATENDIMENTO_INVALIDO', `Atendimento não encontrado: ${id}.`, {
      statusCode: 404
    });
  }
  const ops = await dbAll(
    db,
    `SELECT * FROM atendimento_operacoes WHERE atendimento_id = ? ORDER BY id`,
    [id]
  );
  const operacoes = [];
  for (const op of ops) {
    const itens = await dbAll(
      db,
      `SELECT * FROM atendimento_operacao_itens WHERE operacao_id = ? ORDER BY id`,
      [op.id]
    );
    operacoes.push({
      operacaoId: op.id,
      empresaId: op.empresa_id,
      subtotal: arredondarCentavosMuv(op.subtotal),
      quantidadeItens: Number(op.quantidade_itens),
      status: op.status,
      itens: itens.map((it) => ({
        itemId: it.id,
        produtoId: it.produto_id,
        empresaId: it.empresa_id,
        quantidade: Number(it.quantidade),
        valorUnitario: arredondarCentavosMuv(it.valor_unitario),
        valorTotal: arredondarCentavosMuv(it.valor_total),
        tipoFiscal: it.tipo_fiscal
      }))
    });
  }
  return {
    atendimentoId: cab.id,
    codigo: cab.codigo,
    modo_operacao: cab.modo_operacao,
    origem: cab.origem,
    status: cab.status,
    total: arredondarCentavosMuv(cab.valor_total),
    quantidade_operacoes: Number(cab.quantidade_operacoes),
    operacoes
  };
}

module.exports = {
  criarAtendimento,
  obterAtendimento,
  validarEstoqueOperacoes
};
