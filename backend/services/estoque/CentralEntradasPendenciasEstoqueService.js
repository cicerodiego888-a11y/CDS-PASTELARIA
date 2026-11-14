/**
 * Consulta informativa — documentos da Central ainda sem compra persistida.
 * CDS-ESTOQUE-CONTAGEM-PENDENCIAS-04.
 *
 * Somente leitura. Não cria compra, não credita estoque, não altera status.
 *
 * Evidência de conversão/crédito no modelo atual:
 *   documento.compra_id preenchido + status IMPORTADA (GRAVADA) + compra existente.
 * Crédito físico ocorre no fluxo de Compras; a Central não guarda flag própria de crédito.
 * Por isso a classificação é “pendente de conversão”, não “estoque faltante confirmado”.
 *
 * @module services/estoque/CentralEntradasPendenciasEstoqueService
 */
'use strict';

const {
  DocumentoFiscalStatus,
  normalizarStatus,
  obterLabel,
  isTerminal
} = require('../../motores/central-entradas/core/DocumentoFiscalStatus');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');

const TABELA = 'central_entradas_documentos';
const LIMITE_PADRAO = 50;
const LIMITE_MAX = 100;

/** Status em pipeline sem compra → pendência clara de conversão. */
const STATUS_PENDENTE_CONVERSAO = Object.freeze([
  DocumentoFiscalStatus.NOVA,
  DocumentoFiscalStatus.RESUMO_RECEBIDO,
  DocumentoFiscalStatus.XML_COMPLETO,
  DocumentoFiscalStatus.EM_REVISAO,
  DocumentoFiscalStatus.PRONTA_IMPORTACAO
]);

/** Em andamento / inconsistente — não afirmar ausência definitiva de crédito. */
const STATUS_NAO_CONFIRMADA = Object.freeze([
  DocumentoFiscalStatus.EM_IMPORTACAO,
  DocumentoFiscalStatus.ERRO
]);

const CLASSIFICACAO = Object.freeze({
  PENDENTE_CONVERSAO: 'PENDENTE_CONVERSAO',
  NAO_CONFIRMADA: 'NAO_CONFIRMADA',
  CONVERTIDA: 'CONVERTIDA',
  EXCLUIDA: 'EXCLUIDA'
});

function erroPendencia(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

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

function compraIdValido(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function chaveCurta(chave) {
  const raw = String(chave || '').trim();
  if (raw.length <= 16) return raw || null;
  return `${raw.slice(0, 8)}…${raw.slice(-6)}`;
}

function extrairQtdItensMiip(miipResumoJson) {
  if (miipResumoJson == null || miipResumoJson === '') return null;
  try {
    const parsed = typeof miipResumoJson === 'string'
      ? JSON.parse(miipResumoJson)
      : miipResumoJson;
    const resumo = parsed && (parsed.resumo || parsed);
    if (!resumo || typeof resumo !== 'object') return null;
    const candidatos = [
      resumo.total_itens,
      resumo.totalItens,
      resumo.quantidade_itens,
      resumo.qtd_itens,
      Array.isArray(resumo.itens) ? resumo.itens.length : null,
      Array.isArray(parsed.itens) ? parsed.itens.length : null
    ];
    for (const c of candidatos) {
      const n = Number(c);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch (_) {
    return null;
  }
  return null;
}

/**
 * Classifica um documento já filtrado por empresa.
 * @returns {{ classificacao: string, motivo: string }}
 */
function classificarDocumento(row, compraExiste) {
  const status = normalizarStatus(row.status);
  const compraId = compraIdValido(row.compra_id);

  if (isTerminal(status)) {
    return {
      classificacao: CLASSIFICACAO.EXCLUIDA,
      motivo: `Status terminal (${status}) — não é pendência de conversão.`
    };
  }

  if (status === DocumentoFiscalStatus.IMPORTADA && compraId != null && compraExiste) {
    return {
      classificacao: CLASSIFICACAO.CONVERTIDA,
      motivo: 'Documento vinculado a compra persistida (IMPORTADA/GRAVADA).'
    };
  }

  if (status === DocumentoFiscalStatus.IMPORTADA && (compraId == null || !compraExiste)) {
    return {
      classificacao: CLASSIFICACAO.NAO_CONFIRMADA,
      motivo: 'Status IMPORTADA sem compra comprovada — situação inconsistente.'
    };
  }

  if (STATUS_PENDENTE_CONVERSAO.includes(status) && compraId == null) {
    return {
      classificacao: CLASSIFICACAO.PENDENTE_CONVERSAO,
      motivo: 'Documento na Central sem compra vinculada — ainda não representa crédito de estoque.'
    };
  }

  if (STATUS_PENDENTE_CONVERSAO.includes(status) && compraId != null) {
    return {
      classificacao: CLASSIFICACAO.NAO_CONFIRMADA,
      motivo: 'Documento em pipeline com compra_id preenchido antes do status IMPORTADA.'
    };
  }

  if (STATUS_NAO_CONFIRMADA.includes(status)) {
    return {
      classificacao: CLASSIFICACAO.NAO_CONFIRMADA,
      motivo: status === DocumentoFiscalStatus.EM_IMPORTACAO
        ? 'Documento em importação/compra — não afirmar ausência definitiva de crédito.'
        : 'Documento em erro — verificar na Central antes de concluir sobre estoque.'
    };
  }

  return {
    classificacao: CLASSIFICACAO.NAO_CONFIRMADA,
    motivo: `Status ${status} sem classificação definitiva de pendência de crédito.`
  };
}

function mapearResumo(row, meta) {
  return {
    documento_id: Number(row.id),
    chave: row.chave || null,
    chave_curta: chaveCurta(row.chave),
    numero: row.numero != null ? String(row.numero) : null,
    serie: row.serie != null ? String(row.serie) : null,
    fornecedor: row.fornecedor || null,
    cnpj_fornecedor: row.cnpj_fornecedor || null,
    data_emissao: row.data_emissao || null,
    data_recebimento: row.created_at || null,
    data_entrada: row.data_entrada || null,
    empresa_id: row.empresa_id != null ? Number(row.empresa_id) : null,
    status: normalizarStatus(row.status),
    status_label: obterLabel(row.status),
    status_detalhe: row.status_detalhe || null,
    valor_total: row.valor_total != null ? Number(row.valor_total) : null,
    quantidade_itens: extrairQtdItensMiip(row.miip_resumo_json),
    compra_id: compraIdValido(row.compra_id),
    classificacao: meta.classificacao,
    motivo: meta.motivo
  };
}

/**
 * @param {{ db: object, empresaId: number|string, limite?: number }} params
 */
async function listarPendenciasEntradaEstoque(params = {}) {
  const db = params.db;
  if (!db) throw erroPendencia('DB_OBRIGATORIO', 'db é obrigatório.', 500);

  const empresaId = resolverEmpresaId(
    params.empresaId != null ? params.empresaId : params.empresa_id
  );
  if (empresaId == null) {
    throw erroPendencia(
      'EMPRESA_OBRIGATORIA',
      'empresaId é obrigatório para consultar pendências de entrada.',
      400
    );
  }

  const empresa = await dbGet(db, 'SELECT id FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) {
    throw erroPendencia('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada.', 404, {
      empresa_id: empresaId
    });
  }

  let limite = Number(params.limite != null ? params.limite : LIMITE_PADRAO);
  if (!Number.isInteger(limite) || limite <= 0) limite = LIMITE_PADRAO;
  if (limite > LIMITE_MAX) limite = LIMITE_MAX;

  // Sem XML/parse — COLUNAS leves. empresa_id IS NOT NULL e = empresa (sem fallback).
  const statusRelevantes = [
    ...STATUS_PENDENTE_CONVERSAO,
    ...STATUS_NAO_CONFIRMADA,
    DocumentoFiscalStatus.IMPORTADA
  ];
  const placeholders = statusRelevantes.map(() => '?').join(', ');

  let rows;
  try {
    rows = await dbAll(
      db,
      `SELECT id, chave, numero, serie, modelo, fornecedor, cnpj_fornecedor,
              data_emissao, data_entrada, valor_total, status, status_detalhe,
              miip_resumo_json, compra_id, empresa_id, created_at, updated_at, processado_em
         FROM ${TABELA}
        WHERE empresa_id = ?
          AND status IN (${placeholders})
        ORDER BY created_at DESC
        LIMIT ?`,
      [empresaId, ...statusRelevantes, limite]
    );
  } catch (err) {
    if (/no such table/i.test(String(err && err.message || ''))) {
      return {
        ok: true,
        empresa_id: empresaId,
        consulta_disponivel: true,
        total_pendentes_conversao: 0,
        total_nao_confirmadas: 0,
        pendentes_conversao: [],
        nao_confirmadas: [],
        fornecedores: [],
        aviso: 'Central de Entradas sem tabela de documentos neste banco.'
      };
    }
    throw erroPendencia(
      'CONSULTA_PENDENCIAS_FALHOU',
      err && err.message
        ? err.message
        : 'Não foi possível verificar as entradas pendentes.',
      503,
      { causa: err && err.code ? err.code : undefined }
    );
  }

  const compraIds = [...new Set(
    rows.map((r) => compraIdValido(r.compra_id)).filter((id) => id != null)
  )];
  const comprasExistentes = new Set();
  if (compraIds.length > 0) {
    try {
      const ph = compraIds.map(() => '?').join(', ');
      const compras = await dbAll(
        db,
        `SELECT id FROM compras WHERE id IN (${ph}) AND empresa_id = ?`,
        [...compraIds, empresaId]
      );
      for (const c of compras) comprasExistentes.add(Number(c.id));
    } catch (err) {
      if (!/no such table/i.test(String(err && err.message || ''))) {
        throw erroPendencia(
          'CONSULTA_PENDENCIAS_FALHOU',
          'Não foi possível validar compras vinculadas às entradas.',
          503
        );
      }
    }
  }

  const pendentes = [];
  const naoConfirmadas = [];
  const vistosChave = new Set();

  for (const row of rows) {
    // Isolamento: nunca atribuir documento sem empresa ou de outra empresa.
    if (row.empresa_id == null || Number(row.empresa_id) !== empresaId) continue;

    const chaveNorm = String(row.chave || '').trim();
    if (chaveNorm && vistosChave.has(chaveNorm)) continue;
    if (chaveNorm) vistosChave.add(chaveNorm);

    const compraId = compraIdValido(row.compra_id);
    const compraExiste = compraId != null && comprasExistentes.has(compraId);
    const meta = classificarDocumento(row, compraExiste);
    if (meta.classificacao === CLASSIFICACAO.EXCLUIDA
      || meta.classificacao === CLASSIFICACAO.CONVERTIDA) {
      continue;
    }

    const resumo = mapearResumo(row, meta);
    if (meta.classificacao === CLASSIFICACAO.PENDENTE_CONVERSAO) {
      pendentes.push(resumo);
    } else if (meta.classificacao === CLASSIFICACAO.NAO_CONFIRMADA) {
      naoConfirmadas.push(resumo);
    }
  }

  const fornecedores = [...new Set(
    pendentes.map((p) => p.fornecedor).filter((f) => f && String(f).trim() !== '')
  )];

  return {
    ok: true,
    empresa_id: empresaId,
    consulta_disponivel: true,
    total_pendentes_conversao: pendentes.length,
    total_nao_confirmadas: naoConfirmadas.length,
    pendentes_conversao: pendentes,
    nao_confirmadas: naoConfirmadas,
    fornecedores,
    mensagem: pendentes.length > 0
      ? 'Existem documentos fiscais na Central sem compra efetivamente registrada. '
        + 'Eles ainda não representam crédito de estoque.'
      : null,
    limitacao: 'A Central não armazena flag própria de crédito F×NF; conversão comprovada '
      + 'por compra_id + status IMPORTADA + existência da compra. Documentos em EM_IMPORTACAO/ERRO '
      + 'ficam como NAO_CONFIRMADA.'
  };
}

module.exports = {
  CLASSIFICACAO,
  STATUS_PENDENTE_CONVERSAO,
  STATUS_NAO_CONFIRMADA,
  listarPendenciasEntradaEstoque,
  classificarDocumento,
  extrairQtdItensMiip,
  chaveCurta
};
