/**
 * Contexto de empresa para a Porta Pública de Saldos / Reservas (F×NF).
 *
 * Fase 1 / Implementação 01 — contrato multiempresa SEM estoque_empresa.
 * Fase 2 / Implementação 03.1 — reconhece a tabela oficial `empresas`
 * (existência + ativo). 03.2 — resolução a partir da requisição (header
 * X-Empresa-Id) sem alterar JWT. 03.4 — o mesmo middleware aceita
 * `{ obrigatorio: true }` em operações novas da Fase Empresas.
 * COMPAT legado permanece.
 * Reutiliza o vocabulário já presente no CDS: empresa_id / empresaId (VendaContext,
 * FeatureFlags, DfeAuditoria). Não inventa companyId/tenant paralelo.
 *
 * @module services/fiscalNaoFiscal/empresaContexto
 */
'use strict';

/**
 * Opt-in EXPLÍCITO para fluxos certificados pré-multiempresa (MTS / Motor Comercial).
 * Proibido usar em operações que já conheçam empresa ativa.
 * Não é fallback silencioso: o chamador deve setar o flag.
 */
const COMPAT_CERTIFICADA_PRE_MULTIEMPRESA = Object.freeze({
  modoLegadoSemEmpresa: true,
  motivoCompat: 'COMPAT_CERTIFICADA_PRE_MULTIEMPRESA'
});

function erroEmpresa(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Extrai empresaId de fontes comuns do CDS (sem default inventado).
 * @param {number|string|object|null|undefined} fonte
 * @returns {number|null}
 */
function resolverEmpresaId(fonte) {
  if (fonte == null || fonte === '') return null;

  if (typeof fonte === 'number' || typeof fonte === 'string') {
    const n = Number(fonte);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  if (typeof fonte === 'object') {
    const raw = fonte.empresaId != null
      ? fonte.empresaId
      : (fonte.empresa_id != null
        ? fonte.empresa_id
        : (fonte.empresa != null ? fonte.empresa : null));
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  return null;
}

function exigirEmpresaId(fonte) {
  const id = resolverEmpresaId(fonte);
  if (id == null) {
    throw erroEmpresa(
      'EMPRESA_OBRIGATORIA',
      'empresaId é obrigatório para operações de saldo/reserva. Informe empresa_id/empresaId no contexto.'
    );
  }
  return id;
}

/**
 * Extrai empresaId de uma requisição HTTP sem inventar fallback.
 * Ordem: req.empresaId (já anexado) → header X-Empresa-Id → body → query.
 * Não lê configuracoes.cnpj. Não assume empresa 1. Não lê JWT (token sem claim).
 */
function resolverEmpresaIdDaRequisicao(req) {
  if (!req || typeof req !== 'object') return null;

  const doAnexo = resolverEmpresaId(req.empresaId);
  if (doAnexo != null) return doAnexo;

  const headers = req.headers || {};
  const doHeader = resolverEmpresaId(
    headers['x-empresa-id'] != null ? headers['x-empresa-id'] : headers['x-empresaid']
  );
  if (doHeader != null) return doHeader;

  const doBody = resolverEmpresaId(req.body);
  if (doBody != null) return doBody;

  return resolverEmpresaId(req.query);
}

/**
 * Anexa req.empresaId quando o cliente enviou contexto.
 * Sem header/body: deixa null (COMPAT dos módulos ainda não migrados),
 * salvo opts.obrigatorio === true → EMPRESA_OBRIGATORIA (03.4).
 * Com valor: valida existência, ativo e vínculo do usuário.
 * Não é um middleware paralelo: o mesmo factory cobre os dois modos.
 *
 * @param {object} [db]
 * @param {{ obrigatorio?: boolean }} [opts]
 */
function criarMiddlewareContextoEmpresa(db, opts = {}) {
  const obrigatorio = opts && opts.obrigatorio === true;
  return async function anexarContextoEmpresa(req, res, next) {
    const bruto = resolverEmpresaIdDaRequisicao(req);
    if (bruto == null) {
      if (obrigatorio) {
        return res.status(400).json({
          error: 'empresaId é obrigatório para esta operação. Informe o contexto via X-Empresa-Id.',
          code: 'EMPRESA_OBRIGATORIA'
        });
      }
      req.empresaId = null;
      req.empresa = null;
      return next();
    }
    try {
      const dbConn = db || req.db;
      const empresaId = await validarEmpresaId(bruto, { db: dbConn });
      const uid = req.user && (req.user.id != null ? req.user.id : req.user.usuario_id);
      if (!uid) {
        throw erroEmpresa(
          'EMPRESA_NAO_AUTORIZADA',
          'Usuário não está autorizado a usar esta empresa.',
          { empresa_id: empresaId }
        );
      }
      const { exigirEmpresaAutorizada } = require('../empresas/UsuarioEmpresaService');
      await exigirEmpresaAutorizada(uid, empresaId, { db: dbConn });
      req.empresaId = empresaId;
      req.empresa = { id: empresaId };
      return next();
    } catch (err) {
      const code = err && err.code ? err.code : 'ERRO_EMPRESA';
      const status = code === 'EMPRESA_NAO_ENCONTRADA' ? 404
        : (code === 'EMPRESA_NAO_AUTORIZADA' ? 403
        : (code === 'EMPRESA_INATIVA' || code === 'EMPRESA_ID_OBRIGATORIO' || code === 'EMPRESA_OBRIGATORIA' ? 400 : 500));
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro de contexto empresarial.',
        code,
        empresa_id: err && err.empresa_id != null ? err.empresa_id : undefined
      });
    }
  };
}

/**
 * Garante que o recurso alvo é a empresa já autorizada no contexto.
 * Não é um resolver novo: reutiliza resolverEmpresaId.
 */
function exigirEmpresaAlvoDoContexto(contextoId, alvoFonte) {
  const ctx = resolverEmpresaId(contextoId);
  if (ctx == null) {
    const err = erroEmpresa(
      'EMPRESA_OBRIGATORIA',
      'empresaId é obrigatório para esta operação. Informe o contexto via X-Empresa-Id.'
    );
    err.status = 400;
    throw err;
  }
  const alvo = resolverEmpresaId(alvoFonte);
  if (alvo == null || alvo !== ctx) {
    const err = erroEmpresa(
      'EMPRESA_NAO_AUTORIZADA',
      'A operação só pode ser feita sobre a empresa do contexto selecionado.',
      { empresa_id: alvo != null ? alvo : ctx }
    );
    err.status = 403;
    throw err;
  }
  return ctx;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function tabelaEmpresasExiste(db) {
  if (!db) return false;
  const row = await dbGet(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'empresas'`
  );
  return !!(row && row.name);
}

/**
 * Valida existência da empresa e, quando a coluna `ativo` existe, recusa inativa
 * em contexto operacional (`EMPRESA_INATIVA`).
 * - Se opts.validarEmpresa(fn) → usa o callback (testes / integração).
 * - Se tabela empresas existir → SELECT da linha.
 * - Sem tabela ainda (pré-cadastro / testes 02.x) → aceita apenas ID inteiro positivo
 *   já exigido; "inexistente" exige tabela ou validarEmpresa.
 * COMPAT modoLegadoSemEmpresa permanece: empresa NÃO é obrigatória globalmente.
 *
 * @param {number|string|object} fonte
 * @param {{ db?: object, validarEmpresa?: Function, modoLegadoSemEmpresa?: boolean }} [opts]
 */
async function validarEmpresaId(fonte, opts = {}) {
  if (opts.modoLegadoSemEmpresa === true && resolverEmpresaId(fonte) == null) {
    return null;
  }

  const empresaId = exigirEmpresaId(fonte);

  if (typeof opts.validarEmpresa === 'function') {
    const ok = await opts.validarEmpresa(empresaId, opts);
    if (!ok) {
      throw erroEmpresa(
        'EMPRESA_NAO_ENCONTRADA',
        `Empresa não encontrada: ${empresaId}.`,
        { empresa_id: empresaId }
      );
    }
    return empresaId;
  }

  if (opts.db) {
    const temTabela = await tabelaEmpresasExiste(opts.db);
    if (temTabela) {
      const row = await dbGet(
        opts.db,
        `SELECT * FROM empresas WHERE id = ? LIMIT 1`,
        [empresaId]
      );
      if (!row) {
        throw erroEmpresa(
          'EMPRESA_NAO_ENCONTRADA',
          `Empresa não encontrada: ${empresaId}.`,
          { empresa_id: empresaId }
        );
      }
      if (Object.prototype.hasOwnProperty.call(row, 'ativo') && row.ativo != null
        && Number(row.ativo) === 0) {
        throw erroEmpresa(
          'EMPRESA_INATIVA',
          `Empresa inativa não pode ser usada como contexto operacional: ${empresaId}.`,
          { empresa_id: empresaId }
        );
      }
    }
  }

  return empresaId;
}

/**
 * Resolve contexto de empresa para a porta pública.
 * @returns {Promise<{ empresaId: number|null, legado: boolean, motivoCompat: string|null }>}
 */
async function resolverContextoEmpresa(opts = {}) {
  const declarado = resolverEmpresaId(opts)
    ?? resolverEmpresaId(opts.contexto)
    ?? resolverEmpresaId(opts.ctx)
    ?? resolverEmpresaIdDaRequisicao(opts.req);

  if (declarado != null) {
    const empresaId = await validarEmpresaId(declarado, opts);
    return {
      empresaId,
      legado: false,
      motivoCompat: null
    };
  }

  if (opts.modoLegadoSemEmpresa === true) {
    return {
      empresaId: null,
      legado: true,
      motivoCompat: opts.motivoCompat || COMPAT_CERTIFICADA_PRE_MULTIEMPRESA.motivoCompat
    };
  }

  throw erroEmpresa(
    'EMPRESA_OBRIGATORIA',
    'empresaId é obrigatório para operações de saldo/reserva. Informe empresa_id/empresaId no contexto.'
  );
}

/**
 * Log estruturado mínimo (sem dados sensíveis).
 */
function logOperacaoSaldo(evento) {
  try {
    if (process.env.CDS_LOG_SALDOS !== '1') return;
    const payload = {
      escopo: 'fiscalNaoFiscal.saldos',
      operacao: evento.operacao || null,
      produto_id: evento.produtoId != null ? Number(evento.produtoId) : null,
      empresa_id: evento.empresaId != null ? Number(evento.empresaId) : null,
      tipo: evento.tipo || null,
      quantidade: evento.quantidade != null ? Number(evento.quantidade) : null,
      legado: evento.legado === true,
      usuario_id: evento.usuarioId != null ? Number(evento.usuarioId) : null
    };
    if (typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info('[FXNF-SALDOS]', JSON.stringify(payload));
    }
  } catch (_) { /* ignore */ }
}

module.exports = {
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA,
  resolverEmpresaId,
  resolverEmpresaIdDaRequisicao,
  exigirEmpresaId,
  validarEmpresaId,
  resolverContextoEmpresa,
  criarMiddlewareContextoEmpresa,
  exigirEmpresaAlvoDoContexto,
  logOperacaoSaldo,
  tabelaEmpresasExiste
};
