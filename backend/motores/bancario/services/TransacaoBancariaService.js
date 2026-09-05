/**
 * Transações bancárias por conta/empresa. Idempotência. Sem financeiro. Sem conciliação.
 * @module motores/bancario/services/TransacaoBancariaService
 */
'use strict';

const { ERROS, DIRECAO, STATUS_REGISTRO, erroMbc } = require('../contracts/constantes');
const {
  exigirEmpresaId,
  normalizarTransacao,
  chaveIdempotencia,
  parseDirecao,
  parseTipoTransacao,
  textoOuNull
} = require('../contracts/TransacaoBancariaNormalizada');
const { dbRun, dbGet, dbAll } = require('./dbPromessas');
const ContaBancariaService = require('./ContaBancariaService');

const LIMITE_PADRAO = 100;
const LIMITE_MAX = 200;

function valorPositivo(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw erroMbc(ERROS.VALOR_INVALIDO, 'O valor da transação deve ser positivo.', 400);
  }
  return Math.round(n * 100) / 100;
}

function validarDataTransacao(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) {
    throw erroMbc(ERROS.DATA_INVALIDA, 'Data da transação inválida.', 400);
  }
  const t = Date.parse(raw.replace(' ', 'T'));
  if (!Number.isFinite(t)) {
    throw erroMbc(ERROS.DATA_INVALIDA, 'Data da transação inválida.', 400);
  }
  return raw;
}

function dataIsoValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validarPeriodo(inicio, fim) {
  const i = inicio ? String(inicio).trim() : '';
  const f = fim ? String(fim).trim() : '';
  if (i && !dataIsoValida(i)) {
    throw erroMbc(ERROS.DATA_INVALIDA, 'Data inicial inválida.', 400);
  }
  if (f && !dataIsoValida(f)) {
    throw erroMbc(ERROS.DATA_INVALIDA, 'Data final inválida.', 400);
  }
  if (i && f && i > f) {
    throw erroMbc(ERROS.PERIODO_INVALIDO, 'Período inválido.', 400);
  }
  return { inicio: i || null, fim: f || null };
}

function sanitizarRaw(v) {
  if (v == null || String(v).trim() === '') return null;
  const t = String(v);
  if (/secret|password|senha|refresh.?token|access.?token|bearer |private.?key|certificado|client_secret/i.test(t)) {
    return null;
  }
  return t.slice(0, 500);
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    conta_bancaria_id: row.conta_bancaria_id,
    external_source: row.external_source,
    external_id: row.external_id,
    data_transacao: row.data_transacao,
    data_processamento: row.data_processamento,
    valor: Number(row.valor),
    direcao: row.direcao,
    descricao: row.descricao,
    tipo: row.tipo,
    saldo_apos_transacao: row.saldo_apos_transacao == null ? null : Number(row.saldo_apos_transacao),
    referencia_externa: row.referencia_externa,
    observacao: row.observacao,
    raw_reference: row.raw_reference,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function buscarPorChave(db, empresaId, contaId, source, extId) {
  return dbGet(
    db,
    `SELECT * FROM transacao_bancaria
     WHERE empresa_id = ? AND conta_bancaria_id = ?
       AND external_source = ? AND external_id = ?`,
    [empresaId, contaId, source, extId]
  );
}

async function registrar(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const conta = await ContaBancariaService.obterNoContexto({
    db,
    empresaId,
    id: params.conta_bancaria_id || params.accountId
  });
  if (conta.empresa_id !== empresaId) {
    throw erroMbc(ERROS.EMPRESA_CONTA_DIVERGENTE, 'A transação deve pertencer à mesma empresa da conta.', 400);
  }
  if (!conta.ativa) {
    throw erroMbc(ERROS.CONTA_INATIVA, 'Conta bancária está inativa.', 409);
  }

  const dto = normalizarTransacao({
    ...params,
    empresaId,
    empresa_id: empresaId,
    conta_bancaria_id: conta.id,
    accountId: conta.id
  });
  if (dto.empresa_id !== conta.empresa_id) {
    throw erroMbc(ERROS.EMPRESA_CONTA_DIVERGENTE, 'A transação deve pertencer à mesma empresa da conta.', 400);
  }

  const valor = valorPositivo(dto.valor);
  const dataTransacao = validarDataTransacao(dto.data_transacao);
  const tipo = parseTipoTransacao(params.tipo || params.type || 'OUTROS');

  const extId = dto.external_id;
  let source = dto.external_source ? String(dto.external_source).trim().toUpperCase() : null;
  if (extId && !source) {
    throw erroMbc(ERROS.SOURCE_OBRIGATORIO, 'external_source é obrigatório quando external_id é informado.', 400);
  }
  if (!extId) source = source || null;

  const temIdempotencia = !!(extId && source);
  if (temIdempotencia) {
    const existente = await buscarPorChave(db, empresaId, conta.id, source, extId);
    if (existente) {
      return {
        status: STATUS_REGISTRO.JA_EXISTENTE,
        transacao: mapRow(existente),
        idempotencia: true
      };
    }
  }

  const saldoOrigem = dto.saldo_apos_transacao;
  const saldoApos = saldoOrigem == null || saldoOrigem === ''
    ? null
    : Number(saldoOrigem);

  try {
    const r = await dbRun(
      db,
      `INSERT INTO transacao_bancaria (
        empresa_id, conta_bancaria_id, external_source, external_id,
        data_transacao, data_processamento, valor, direcao, descricao, tipo,
        saldo_apos_transacao, referencia_externa, observacao, raw_reference,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
      [
        empresaId,
        conta.id,
        source,
        extId,
        dataTransacao,
        textoOuNull(dto.data_processamento),
        valor,
        dto.direcao,
        dto.descricao || null,
        tipo,
        Number.isFinite(saldoApos) ? saldoApos : null,
        dto.referencia_externa,
        dto.observacao,
        sanitizarRaw(dto.raw_reference)
      ]
    );
    const row = await dbGet(db, `SELECT * FROM transacao_bancaria WHERE id = ?`, [r.lastID]);
    return {
      status: STATUS_REGISTRO.CRIADA,
      transacao: mapRow(row),
      idempotencia: temIdempotencia
    };
  } catch (err) {
    if (temIdempotencia && /UNIQUE/i.test(String(err.message || ''))) {
      const existente = await buscarPorChave(db, empresaId, conta.id, source, extId);
      if (existente) {
        return {
          status: STATUS_REGISTRO.JA_EXISTENTE,
          transacao: mapRow(existente),
          idempotencia: true
        };
      }
    }
    throw err;
  }
}

async function obterNoContexto(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMbc(ERROS.TRANSACAO_NAO_ENCONTRADA, 'Transação bancária não encontrada.', 404);
  }
  const row = await dbGet(
    params.db,
    `SELECT * FROM transacao_bancaria WHERE id = ? AND empresa_id = ?`,
    [id, empresaId]
  );
  if (!row) {
    throw erroMbc(ERROS.TRANSACAO_NAO_ENCONTRADA, 'Transação bancária não encontrada.', 404);
  }
  return mapRow(row);
}

async function listar(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { inicio, fim } = validarPeriodo(params.data_inicio, params.data_fim);
  const limite = Math.min(Math.max(Number(params.limite) || LIMITE_PADRAO, 1), LIMITE_MAX);
  const offset = Math.max(Number(params.offset) || 0, 0);

  const where = ['t.empresa_id = ?'];
  const bind = [empresaId];

  if (params.conta_bancaria_id) {
    const conta = await ContaBancariaService.obterNoContexto({
      db: params.db,
      empresaId,
      id: params.conta_bancaria_id
    });
    where.push('t.conta_bancaria_id = ?');
    bind.push(conta.id);
  }
  if (params.direcao) {
    where.push('t.direcao = ?');
    bind.push(parseDirecao(params.direcao));
  }
  if (params.tipo) {
    where.push('t.tipo = ?');
    bind.push(parseTipoTransacao(params.tipo));
  }
  if (inicio) {
    where.push('date(t.data_transacao) >= date(?)');
    bind.push(inicio);
  }
  if (fim) {
    where.push('date(t.data_transacao) <= date(?)');
    bind.push(fim);
  }

  bind.push(limite, offset);
  const rows = await dbAll(
    params.db,
    `SELECT t.* FROM transacao_bancaria t
     WHERE ${where.join(' AND ')}
     ORDER BY t.data_transacao DESC, t.id DESC
     LIMIT ? OFFSET ?`,
    bind
  );
  return rows.map(mapRow);
}

async function calcularSaldoConceitual(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const conta = await ContaBancariaService.obterNoContexto({
    db: params.db,
    empresaId,
    id: params.conta_bancaria_id || params.id
  });
  const { inicio, fim } = validarPeriodo(params.data_inicio, params.data_fim);
  const where = ['empresa_id = ?', 'conta_bancaria_id = ?'];
  const bind = [empresaId, conta.id];
  if (inicio) {
    where.push('date(data_transacao) >= date(?)');
    bind.push(inicio);
  }
  if (fim) {
    where.push('date(data_transacao) <= date(?)');
    bind.push(fim);
  }
  const row = await dbGet(
    params.db,
    `SELECT
        COALESCE(SUM(CASE WHEN direcao = '${DIRECAO.ENTRADA}' THEN valor ELSE 0 END), 0) AS entradas,
        COALESCE(SUM(CASE WHEN direcao = '${DIRECAO.SAIDA}' THEN valor ELSE 0 END), 0) AS saidas
     FROM transacao_bancaria
     WHERE ${where.join(' AND ')}`,
    bind
  );
  const entradas = Number(row.entradas) || 0;
  const saidas = Number(row.saidas) || 0;
  return {
    empresa_id: empresaId,
    conta_bancaria_id: conta.id,
    natureza: 'conceitual',
    rotulo: 'Saldo conceitual',
    entradas,
    saidas,
    saldo_conceitual: Math.round((entradas - saidas) * 100) / 100
  };
}

module.exports = {
  registrar,
  obterNoContexto,
  listar,
  calcularSaldoConceitual,
  validarPeriodo,
  STATUS_REGISTRO,
  chaveIdempotencia
};
