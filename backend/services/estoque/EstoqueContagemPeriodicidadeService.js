/**
 * Periodicidade informativa da contagem física — CDS-ESTOQUE-CONTAGEM-PERIODICIDADE-05.
 *
 * Não bloqueia contagens. Não movimenta estoque.
 * Última contagem = histórico real em estoque_contagens_fisicas (somente confirmações).
 *
 * Padrão sem linha: SEMANAL (PADRAO_INICIAL), alinhado à recomendação da Sprint.
 *
 * @module services/estoque/EstoqueContagemPeriodicidadeService
 */
'use strict';

const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');
const {
  garantirSchemaEstoqueContagemPeriodicidadeAsync
} = require('./estoqueContagemPeriodicidadeSchema');
const {
  garantirSchemaEstoqueContagemFisicaAsync
} = require('./estoqueContagemFisicaSchema');

const PERIODICIDADE = Object.freeze({
  SEMANAL: 'SEMANAL',
  QUINZENAL: 'QUINZENAL',
  SOB_DEMANDA: 'SOB_DEMANDA'
});

const INTERVALOS = Object.freeze({
  [PERIODICIDADE.SEMANAL]: 7,
  [PERIODICIDADE.QUINZENAL]: 15,
  [PERIODICIDADE.SOB_DEMANDA]: null
});

const STATUS = Object.freeze({
  EM_DIA: 'EM_DIA',
  PROXIMA_DO_VENCIMENTO: 'PROXIMA_DO_VENCIMENTO',
  ATRASADA: 'ATRASADA',
  PRIMEIRA_CONTAGEM_PENDENTE: 'PRIMEIRA_CONTAGEM_PENDENTE',
  SEM_PERIODICIDADE: 'SEM_PERIODICIDADE',
  DESATIVADA: 'DESATIVADA'
});

const DIAS_PROXIMIDADE = 2;
const HISTORICO_LIMITE_PADRAO = 20;
const HISTORICO_LIMITE_MAX = 50;

function erroPeriod(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
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

function normalizarPeriodicidade(valor) {
  const raw = String(valor == null ? '' : valor).trim().toUpperCase();
  if (raw === 'SEMANAL' || raw === 'SEMANA') return PERIODICIDADE.SEMANAL;
  if (raw === 'QUINZENAL' || raw === 'QUINZENA' || raw === '15_DIAS' || raw === '15DIAS') {
    return PERIODICIDADE.QUINZENAL;
  }
  if (raw === 'SOB_DEMANDA' || raw === 'DEMANDA' || raw === 'SOB DEMANDA') {
    return PERIODICIDADE.SOB_DEMANDA;
  }
  throw erroPeriod(
    'PERIODICIDADE_INVALIDA',
    'Periodicidade inválida. Use SEMANAL, QUINZENAL ou SOB_DEMANDA.'
  );
}

/** Data local YYYY-MM-DD a partir de Date ou string SQLite. */
function paraDataLocalIso(valor, agora = new Date()) {
  if (valor == null || valor === '') {
    return formatarDataLocal(agora);
  }
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    return formatarDataLocal(valor);
  }
  const s = String(valor).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return formatarDataLocal(d);
  throw erroPeriod('DATA_INVALIDA', `Data inválida: ${valor}`);
}

function formatarDataLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDataLocal(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw erroPeriod('DATA_INVALIDA', `Data local inválida: ${iso}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function adicionarDias(iso, dias) {
  const d = parseDataLocal(iso);
  d.setDate(d.getDate() + Number(dias));
  return formatarDataLocal(d);
}

function diffDiasCalendario(isoA, isoB) {
  const a = parseDataLocal(isoA);
  const b = parseDataLocal(isoB);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function formatarBr(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

async function exigirEmpresa(db, empresaId) {
  const row = await dbGet(db, 'SELECT id FROM empresas WHERE id = ?', [empresaId]);
  if (!row) {
    throw erroPeriod('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada.', 404, {
      empresa_id: empresaId
    });
  }
}

/**
 * Configuração efetiva. Sem linha → SEMANAL (PADRAO_INICIAL).
 */
async function obterPeriodicidade(db, empresaIdBruto, opts = {}) {
  const empresaId = resolverEmpresaId(empresaIdBruto);
  if (empresaId == null) {
    throw erroPeriod('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório.');
  }
  if (!db) throw erroPeriod('DB_OBRIGATORIO', 'db é obrigatório.', 500);
  if (opts.garantirSchema !== false) {
    await garantirSchemaEstoqueContagemPeriodicidadeAsync(db);
  }
  await exigirEmpresa(db, empresaId);

  const row = await dbGet(
    db,
    `SELECT empresa_id, periodicidade, intervalo_dias, ativo,
            criado_em, atualizado_em, atualizado_por
       FROM empresas_configuracao_contagem_fisica
      WHERE empresa_id = ?`,
    [empresaId]
  );

  if (!row) {
    return {
      empresa_id: empresaId,
      periodicidade: PERIODICIDADE.SEMANAL,
      intervalo_dias: INTERVALOS[PERIODICIDADE.SEMANAL],
      ativo: true,
      origem: 'PADRAO_INICIAL',
      criado_em: null,
      atualizado_em: null,
      atualizado_por: null
    };
  }

  const periodicidade = normalizarPeriodicidade(row.periodicidade);
  return {
    empresa_id: empresaId,
    periodicidade,
    intervalo_dias: periodicidade === PERIODICIDADE.SOB_DEMANDA
      ? null
      : (row.intervalo_dias != null
        ? Number(row.intervalo_dias)
        : INTERVALOS[periodicidade]),
    ativo: Number(row.ativo) !== 0,
    origem: 'CONFIGURACAO',
    criado_em: row.criado_em || null,
    atualizado_em: row.atualizado_em || null,
    atualizado_por: row.atualizado_por != null ? Number(row.atualizado_por) : null
  };
}

async function salvarPeriodicidade(db, empresaIdBruto, dados = {}, opts = {}) {
  const empresaId = resolverEmpresaId(empresaIdBruto);
  if (empresaId == null) {
    throw erroPeriod('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório.');
  }
  if (!db) throw erroPeriod('DB_OBRIGATORIO', 'db é obrigatório.', 500);
  await garantirSchemaEstoqueContagemPeriodicidadeAsync(db);
  await exigirEmpresa(db, empresaId);

  const periodicidade = normalizarPeriodicidade(
    dados.periodicidade != null ? dados.periodicidade : dados.modo
  );
  const intervalo = INTERVALOS[periodicidade];
  const ativo = dados.ativo === false || dados.ativo === 0 || dados.ativo === '0'
    ? 0
    : 1;
  const usuarioId = opts.usuarioId != null && Number.isInteger(Number(opts.usuarioId))
    ? Number(opts.usuarioId)
    : (dados.atualizado_por != null ? Number(dados.atualizado_por) : null);

  await dbRun(
    db,
    `INSERT INTO empresas_configuracao_contagem_fisica
      (empresa_id, periodicidade, intervalo_dias, ativo, criado_em, atualizado_em, atualizado_por)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(empresa_id) DO UPDATE SET
       periodicidade = excluded.periodicidade,
       intervalo_dias = excluded.intervalo_dias,
       ativo = excluded.ativo,
       atualizado_em = CURRENT_TIMESTAMP,
       atualizado_por = excluded.atualizado_por`,
    [empresaId, periodicidade, intervalo, ativo, usuarioId]
  );

  return obterPeriodicidade(db, empresaId, { garantirSchema: false });
}

/**
 * Última contagem confirmada — somente histórico persistido.
 * Preview / rejeição / rollback / idempotente não criam linha nova.
 */
async function obterUltimaContagemConfirmada(db, empresaId, opts = {}) {
  if (opts.garantirSchema !== false) {
    await garantirSchemaEstoqueContagemFisicaAsync(db);
  }
  try {
    return await dbGet(
      db,
      `SELECT c.id, c.empresa_id, c.usuario_id, c.usuario_nome, c.observacao,
              c.chave_idempotencia, c.criado_em,
              (SELECT COUNT(*) FROM estoque_contagens_fisicas_itens i
                WHERE i.contagem_id = c.id) AS quantidade_produtos
         FROM estoque_contagens_fisicas c
        WHERE c.empresa_id = ?
        ORDER BY datetime(c.criado_em) DESC, c.id DESC
        LIMIT 1`,
      [empresaId]
    );
  } catch (err) {
    if (/no such table/i.test(String(err && err.message || ''))) return null;
    throw err;
  }
}

function calcularStatus(cfg, ultima, agora = new Date()) {
  const hoje = paraDataLocalIso(agora);

  if (!cfg.ativo) {
    return {
      status: STATUS.DESATIVADA,
      ultima_contagem_em: ultima ? ultima.criado_em : null,
      ultima_contagem_data: ultima ? paraDataLocalIso(ultima.criado_em, agora) : null,
      proxima_contagem_data: null,
      dias_para_vencimento: null,
      dias_atraso: null,
      mensagem: 'Periodicidade de contagem desativada para esta empresa.'
    };
  }

  if (cfg.periodicidade === PERIODICIDADE.SOB_DEMANDA) {
    return {
      status: STATUS.SEM_PERIODICIDADE,
      ultima_contagem_em: ultima ? ultima.criado_em : null,
      ultima_contagem_data: ultima ? paraDataLocalIso(ultima.criado_em, agora) : null,
      proxima_contagem_data: null,
      dias_para_vencimento: null,
      dias_atraso: null,
      mensagem: ultima
        ? 'Contagem sob demanda: não há vencimento programado.'
        : 'Contagem sob demanda: não há vencimento programado. Ainda não há contagem registrada.'
    };
  }

  if (!ultima) {
    return {
      status: STATUS.PRIMEIRA_CONTAGEM_PENDENTE,
      ultima_contagem_em: null,
      ultima_contagem_data: null,
      proxima_contagem_data: null,
      dias_para_vencimento: null,
      dias_atraso: null,
      mensagem: 'Esta empresa ainda não possui uma primeira contagem registrada.'
    };
  }

  const ultimaData = paraDataLocalIso(ultima.criado_em, agora);
  const intervalo = Number(cfg.intervalo_dias || INTERVALOS[cfg.periodicidade] || 7);
  const proxima = adicionarDias(ultimaData, intervalo);
  const dias = diffDiasCalendario(hoje, proxima);

  if (dias < 0) {
    const atraso = Math.abs(dias);
    return {
      status: STATUS.ATRASADA,
      ultima_contagem_em: ultima.criado_em,
      ultima_contagem_data: ultimaData,
      proxima_contagem_data: proxima,
      dias_para_vencimento: dias,
      dias_atraso: atraso,
      mensagem: `A contagem física está atrasada há ${atraso} dia${atraso === 1 ? '' : 's'}.`
    };
  }

  if (dias <= DIAS_PROXIMIDADE) {
    return {
      status: STATUS.PROXIMA_DO_VENCIMENTO,
      ultima_contagem_em: ultima.criado_em,
      ultima_contagem_data: ultimaData,
      proxima_contagem_data: proxima,
      dias_para_vencimento: dias,
      dias_atraso: 0,
      mensagem: `Sua próxima contagem está prevista para ${formatarBr(proxima)}.`
    };
  }

  return {
    status: STATUS.EM_DIA,
    ultima_contagem_em: ultima.criado_em,
    ultima_contagem_data: ultimaData,
    proxima_contagem_data: proxima,
    dias_para_vencimento: dias,
    dias_atraso: 0,
    mensagem: `Contagem em dia. Próxima prevista para ${formatarBr(proxima)}.`
  };
}

async function obterStatusPeriodicidade(db, empresaIdBruto, opts = {}) {
  const empresaId = resolverEmpresaId(empresaIdBruto);
  if (empresaId == null) {
    throw erroPeriod('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório.');
  }
  if (!db) throw erroPeriod('DB_OBRIGATORIO', 'db é obrigatório.', 500);

  let cfg;
  let ultima;
  try {
    cfg = await obterPeriodicidade(db, empresaId, opts);
    ultima = await obterUltimaContagemConfirmada(db, empresaId, opts);
  } catch (err) {
    if (err && err.code === 'EMPRESA_NAO_ENCONTRADA') throw err;
    throw erroPeriod(
      'CONSULTA_PERIODICIDADE_FALHOU',
      err && err.message
        ? err.message
        : 'Não foi possível consultar a periodicidade da contagem.',
      503
    );
  }

  const calc = calcularStatus(cfg, ultima, opts.agora || new Date());
  return {
    ok: true,
    consulta_disponivel: true,
    empresa_id: empresaId,
    configuracao: cfg,
    ultima_contagem: ultima
      ? {
        id: Number(ultima.id),
        criado_em: ultima.criado_em,
        usuario_id: ultima.usuario_id != null ? Number(ultima.usuario_id) : null,
        usuario_nome: ultima.usuario_nome || null,
        quantidade_produtos: Number(ultima.quantidade_produtos || 0)
      }
      : null,
    ...calc,
    // Contagem sempre permitida — periodicidade é informativa.
    contagem_permitida: true
  };
}

async function listarHistoricoContagens(db, empresaIdBruto, opts = {}) {
  const empresaId = resolverEmpresaId(empresaIdBruto);
  if (empresaId == null) {
    throw erroPeriod('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório.');
  }
  if (!db) throw erroPeriod('DB_OBRIGATORIO', 'db é obrigatório.', 500);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await exigirEmpresa(db, empresaId);

  let limite = Number(opts.limite != null ? opts.limite : HISTORICO_LIMITE_PADRAO);
  if (!Number.isInteger(limite) || limite <= 0) limite = HISTORICO_LIMITE_PADRAO;
  if (limite > HISTORICO_LIMITE_MAX) limite = HISTORICO_LIMITE_MAX;

  let rows;
  try {
    rows = await dbAll(
      db,
      `SELECT c.id, c.empresa_id, c.usuario_id, c.usuario_nome, c.observacao,
              c.chave_idempotencia, c.criado_em,
              (SELECT COUNT(*) FROM estoque_contagens_fisicas_itens i
                WHERE i.contagem_id = c.id) AS quantidade_produtos
         FROM estoque_contagens_fisicas c
        WHERE c.empresa_id = ?
        ORDER BY datetime(c.criado_em) DESC, c.id DESC
        LIMIT ?`,
      [empresaId, limite]
    );
  } catch (err) {
    if (/no such table/i.test(String(err && err.message || ''))) {
      return { ok: true, empresa_id: empresaId, total: 0, itens: [] };
    }
    throw erroPeriod(
      'CONSULTA_HISTORICO_FALHOU',
      'Não foi possível listar o histórico de contagens.',
      503
    );
  }

  return {
    ok: true,
    empresa_id: empresaId,
    total: rows.length,
    itens: rows.map((row) => ({
      id: Number(row.id),
      empresa_id: Number(row.empresa_id),
      usuario_id: row.usuario_id != null ? Number(row.usuario_id) : null,
      usuario_nome: row.usuario_nome || null,
      observacao: row.observacao || null,
      chave_idempotencia: row.chave_idempotencia || null,
      criado_em: row.criado_em,
      quantidade_produtos: Number(row.quantidade_produtos || 0),
      resultado: 'CONFIRMADA'
    }))
  };
}

module.exports = {
  PERIODICIDADE,
  INTERVALOS,
  STATUS,
  DIAS_PROXIMIDADE,
  obterPeriodicidade,
  salvarPeriodicidade,
  obterUltimaContagemConfirmada,
  obterStatusPeriodicidade,
  listarHistoricoContagens,
  calcularStatus,
  paraDataLocalIso,
  adicionarDias,
  diffDiasCalendario,
  formatarBr,
  normalizarPeriodicidade
};
