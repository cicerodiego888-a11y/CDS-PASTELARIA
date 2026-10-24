/**
 * Fixture de empresa para suítes da Central — nunca usa fallback de produção.
 * O chamador deve passar o id retornado explicitamente (contrato 05.74).
 */
'use strict';

const CNPJ_EMPRESA_A = '11111111000191';
const CNPJ_EMPRESA_B = '22222222000182';

async function garantirEmpresaTeste(sql, opcoes = {}) {
  if (!sql || typeof sql.run !== 'function') {
    throw new Error('sql da Central é obrigatório para criar empresa de teste');
  }
  if (typeof sql.whenReady === 'function') {
    await sql.whenReady();
  }
  const cnpj = String(opcoes.cnpj || CNPJ_EMPRESA_A);
  const razao = opcoes.razao || 'Empresa Teste Central A';
  const existente = await sql.get('SELECT id FROM empresas WHERE cnpj = ?', [cnpj]);
  if (existente && existente.id) {
    return Number(existente.id);
  }
  const inserido = await sql.run(
    `INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
     VALUES (?, ?, ?, 1)`,
    [cnpj, razao, opcoes.nomeFantasia || razao]
  );
  return Number(inserido.lastID);
}

module.exports = {
  garantirEmpresaTeste,
  CNPJ_EMPRESA_A,
  CNPJ_EMPRESA_B
};
