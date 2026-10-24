/**
 * Pendências de persistência DistDFe — rastreáveis após reinício.
 * Não avança NSU e não consulta SEFAZ.
 *
 * @module services/fiscal/pendenciasPersistenciaDfe
 */

'use strict';

const { extrairChave } = require('./dfeXmlMetadados');
const { DfeAuditoriaResultado, DfeAuditoriaEtapa } = require('./dfeAuditoriaConstantes');

function montarErroPersistenciaDfe({ nsu, xml, err, empresaId } = {}) {
  return {
    nsu: nsu || null,
    chave: extrairChave(xml) || null,
    empresaId: empresaId != null ? Number(empresaId) : null,
    codigo: (err && err.code) || null,
    mensagem: (err && err.message) || 'Erro ao persistir documento DistDFe'
  };
}

function pendenciaAindaAberta(registro, documentos = []) {
  const chave = String(registro.chave || '').replace(/\D/g, '');
  if (!chave) return true;
  const empresaId = registro.empresaId != null
    ? Number(registro.empresaId)
    : (registro.empresa_id != null ? Number(registro.empresa_id) : null);
  return !documentos.some((doc) => {
    const mesmaChave = String(doc.chave || '').replace(/\D/g, '') === chave;
    if (!mesmaChave) return false;
    if (empresaId == null) return true;
    return Number(doc.empresaId ?? doc.empresa_id) === empresaId;
  });
}

function filtrarPendenciasPersistenciaAbertas(registrosAuditoria = [], documentos = []) {
  return (registrosAuditoria || [])
    .filter((row) => String(row.resultado || '') === DfeAuditoriaResultado.ERRO_BANCO
      && String(row.tipo || row.etapa || '') === DfeAuditoriaEtapa.PERSISTENCIA)
    .filter((row) => pendenciaAindaAberta(row, documentos));
}

function listarPendenciasPersistenciaAbertas(db, filtros = {}) {
  const where = [
    'a.resultado = ?',
    'a.tipo = ?'
  ];
  const params = [DfeAuditoriaResultado.ERRO_BANCO, DfeAuditoriaEtapa.PERSISTENCIA];
  if (filtros.cnpj) {
    where.push('a.cnpj = ?');
    params.push(String(filtros.cnpj).replace(/\D/g, ''));
  }
  if (filtros.ambiente != null) {
    where.push('a.ambiente = ?');
    params.push(Number(filtros.ambiente));
  }
  if (filtros.empresaId != null) {
    where.push('a.empresa_id = ?');
    params.push(Number(filtros.empresaId));
  }

  const sql = `
    SELECT a.id, a.correlation_id, a.empresa_id, a.cnpj, a.ambiente, a.nsu, a.chave,
           a.resultado, a.motivo, a.detalhe_json, a.created_at
      FROM dfe_auditoria a
      LEFT JOIN central_entradas_documentos d
        ON d.chave = a.chave
       AND (a.empresa_id IS NULL OR d.empresa_id = a.empresa_id)
     WHERE ${where.join(' AND ')}
       AND d.id IS NULL
     ORDER BY a.id ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

module.exports = {
  montarErroPersistenciaDfe,
  filtrarPendenciasPersistenciaAbertas,
  listarPendenciasPersistenciaAbertas,
  pendenciaAindaAberta
};
