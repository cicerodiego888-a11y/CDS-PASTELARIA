/**
 * Guard MCF-02.1 — identifica projeções de compatibilidade e impede
 * mutação direta no legado como se fossem obrigações independentes.
 *
 * @module motores/mcf/services/ContasPagarFinanceiroCompatGuard
 */
'use strict';

const { ERROS_MCF, erroMcf } = require('../contracts/constantesMcf');

const ORIGEM_PROJECAO = 'mcf_compatibilidade';
const REFERENCIA_TIPO_PROJECAO = 'contas_pagar_mcf';

function ehProjecaoMcfRow(row) {
  if (!row) return false;
  return String(row.origem || '') === ORIGEM_PROJECAO
    || String(row.referencia_tipo || '') === REFERENCIA_TIPO_PROJECAO;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

/**
 * @returns {Promise<{ conta_pagar_id: number, financeiro_id: number }|null>}
 */
async function buscarVinculoPorFinanceiroId(db, empresaId, financeiroId) {
  const emp = Number(empresaId);
  const fin = Number(financeiroId);
  if (!db || !Number.isInteger(emp) || emp <= 0 || !Number.isInteger(fin) || fin <= 0) {
    return null;
  }
  const row = await dbGet(
    db,
    `SELECT empresa_id, conta_pagar_id, financeiro_id
     FROM contas_pagar_financeiro_compat
     WHERE empresa_id = ? AND financeiro_id = ?`,
    [emp, fin]
  );
  if (!row) return null;
  return {
    empresa_id: Number(row.empresa_id),
    conta_pagar_id: Number(row.conta_pagar_id),
    financeiro_id: Number(row.financeiro_id)
  };
}

/**
 * @returns {Promise<{ conta_pagar_id: number, financeiro_id: number }|null>}
 */
async function buscarVinculoPorContaPagarId(db, empresaId, contaPagarId) {
  const emp = Number(empresaId);
  const conta = Number(contaPagarId);
  if (!db || !Number.isInteger(emp) || emp <= 0 || !Number.isInteger(conta) || conta <= 0) {
    return null;
  }
  const row = await dbGet(
    db,
    `SELECT empresa_id, conta_pagar_id, financeiro_id
     FROM contas_pagar_financeiro_compat
     WHERE empresa_id = ? AND conta_pagar_id = ?`,
    [emp, conta]
  );
  if (!row) return null;
  return {
    empresa_id: Number(row.empresa_id),
    conta_pagar_id: Number(row.conta_pagar_id),
    financeiro_id: Number(row.financeiro_id)
  };
}

function erroProjecaoImutavel(operacao = 'alterar') {
  return erroMcf(
    ERROS_MCF.PROJECAO_IMUTAVEL || 'MCF_PROJECAO_IMUTAVEL',
    `Esta movimentação é projeção de Contas a Pagar (MCF). Use /api/contas-pagar para ${operacao}.`,
    409,
    { operacao }
  );
}

function erroUseContasPagar() {
  return erroMcf(
    ERROS_MCF.USE_CONTAS_PAGAR || 'MCF_USE_CONTAS_PAGAR',
    'Obrigações de Contas a Pagar devem ser criadas em /api/contas-pagar (MCF).',
    409
  );
}

/** Fragmento SQL para excluir projeções MCF de listagens/relatórios legados. */
function sqlExcluirProjecaoMcf(alias = 'f') {
  const a = alias ? `${alias}.` : '';
  return ` AND COALESCE(${a}origem, '') <> '${ORIGEM_PROJECAO}'`
    + ` AND COALESCE(${a}referencia_tipo, '') <> '${REFERENCIA_TIPO_PROJECAO}'`;
}

module.exports = {
  ORIGEM_PROJECAO,
  REFERENCIA_TIPO_PROJECAO,
  ehProjecaoMcfRow,
  buscarVinculoPorFinanceiroId,
  buscarVinculoPorContaPagarId,
  erroProjecaoImutavel,
  erroUseContasPagar,
  sqlExcluirProjecaoMcf
};
