/**
 * Cadastro oficial de empresas — Fase 2 / Implementação 03.1.
 *
 * Não altera produtos, saldos, reservas, compras ou vendas.
 * Não cria empresa padrão. Não usa CNPJ de configuracoes.
 *
 * @module services/empresas/EmpresaService
 */
'use strict';

const { exigirCnpjEmpresaValido } = require('./empresaCnpj');

function erroCadastro(code, message, status, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
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

function textoOpcional(valor) {
  if (valor == null) return null;
  const t = String(valor).trim();
  return t === '' ? null : t;
}

function exigirRazaoSocial(valor) {
  const razao = textoOpcional(valor);
  if (!razao) {
    throw erroCadastro(
      'RAZAO_SOCIAL_OBRIGATORIA',
      'Razão social é obrigatória.',
      400
    );
  }
  return razao;
}

function mapearEmpresa(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    cnpj: row.cnpj,
    razao_social: row.razao_social,
    nome_fantasia: row.nome_fantasia != null ? row.nome_fantasia : null,
    inscricao_estadual: row.inscricao_estadual != null ? row.inscricao_estadual : null,
    inscricao_municipal: row.inscricao_municipal != null ? row.inscricao_municipal : null,
    ativo: Number(row.ativo) === 1 ? 1 : 0,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function dtoContextoEmpresa(empresa) {
  if (!empresa) return null;
  return {
    id: Number(empresa.id),
    cnpj: empresa.cnpj,
    razao_social: empresa.razao_social,
    nome_fantasia: empresa.nome_fantasia != null ? empresa.nome_fantasia : null
  };
}

function interpretarUniqueCnpj(err) {
  const msg = String(err && err.message ? err.message : err || '');
  if (/UNIQUE/i.test(msg) && /cnpj/i.test(msg)) {
    return erroCadastro(
      'CNPJ_EMPRESA_DUPLICADO',
      'Já existe uma empresa com este CNPJ.',
      409
    );
  }
  return err;
}

async function criarEmpresa(dados = {}, opts = {}) {
  const db = getDb(opts.db);

  const cnpj = exigirCnpjEmpresaValido(dados.cnpj);
  const razaoSocial = exigirRazaoSocial(dados.razao_social ?? dados.razaoSocial);
  const nomeFantasia = textoOpcional(dados.nome_fantasia ?? dados.nomeFantasia);
  const ie = textoOpcional(dados.inscricao_estadual ?? dados.inscricaoEstadual);
  const im = textoOpcional(dados.inscricao_municipal ?? dados.inscricaoMunicipal);

  const existente = await dbGet(db, `SELECT id FROM empresas WHERE cnpj = ? LIMIT 1`, [cnpj]);
  if (existente) {
    throw erroCadastro(
      'CNPJ_EMPRESA_DUPLICADO',
      'Já existe uma empresa com este CNPJ.',
      409,
      { empresa_id: Number(existente.id) }
    );
  }

  let result;
  try {
    result = await dbRun(
      db,
      `INSERT INTO empresas (
         cnpj, razao_social, nome_fantasia,
         inscricao_estadual, inscricao_municipal, ativo,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [cnpj, razaoSocial, nomeFantasia, ie, im]
    );
  } catch (err) {
    throw interpretarUniqueCnpj(err);
  }

  return buscarEmpresaPorId(result.lastID, { db });
}

async function listarEmpresas(filtros = {}, opts = {}) {
  const db = getDb(opts.db);

  const params = [];
  let sql = `SELECT * FROM empresas`;
  if (filtros.ativo === 1 || filtros.ativo === 0 || filtros.ativo === '1' || filtros.ativo === '0') {
    sql += ` WHERE ativo = ?`;
    params.push(Number(filtros.ativo));
  }
  sql += ` ORDER BY razao_social COLLATE NOCASE, id`;
  const rows = await dbAll(db, sql, params);
  return rows.map(mapearEmpresa);
}

async function buscarEmpresaPorId(id, opts = {}) {
  const db = getDb(opts.db);

  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw erroCadastro('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada.', 404);
  }

  const row = await dbGet(db, `SELECT * FROM empresas WHERE id = ? LIMIT 1`, [n]);
  if (!row) {
    throw erroCadastro(
      'EMPRESA_NAO_ENCONTRADA',
      `Empresa não encontrada: ${n}.`,
      404,
      { empresa_id: n }
    );
  }
  return mapearEmpresa(row);
}

async function buscarEmpresaPorCnpj(cnpj, opts = {}) {
  const db = getDb(opts.db);

  const normalizado = exigirCnpjEmpresaValido(cnpj);
  const row = await dbGet(
    db,
    `SELECT * FROM empresas WHERE cnpj = ? LIMIT 1`,
    [normalizado]
  );
  if (!row) {
    throw erroCadastro(
      'EMPRESA_NAO_ENCONTRADA',
      'Empresa não encontrada para o CNPJ informado.',
      404,
      { cnpj: normalizado }
    );
  }
  return mapearEmpresa(row);
}

async function atualizarEmpresa(id, dados = {}, opts = {}) {
  const atual = await buscarEmpresaPorId(id, opts);
  const db = getDb(opts.db);

  const razaoSocial = dados.razao_social !== undefined || dados.razaoSocial !== undefined
    ? exigirRazaoSocial(dados.razao_social ?? dados.razaoSocial)
    : atual.razao_social;
  const nomeFantasia = dados.nome_fantasia !== undefined || dados.nomeFantasia !== undefined
    ? textoOpcional(dados.nome_fantasia ?? dados.nomeFantasia)
    : atual.nome_fantasia;
  const ie = dados.inscricao_estadual !== undefined || dados.inscricaoEstadual !== undefined
    ? textoOpcional(dados.inscricao_estadual ?? dados.inscricaoEstadual)
    : atual.inscricao_estadual;
  const im = dados.inscricao_municipal !== undefined || dados.inscricaoMunicipal !== undefined
    ? textoOpcional(dados.inscricao_municipal ?? dados.inscricaoMunicipal)
    : atual.inscricao_municipal;

  let cnpj = atual.cnpj;
  if (dados.cnpj !== undefined && dados.cnpj !== null && String(dados.cnpj).trim() !== '') {
    cnpj = exigirCnpjEmpresaValido(dados.cnpj);
    if (cnpj !== atual.cnpj) {
      const outro = await dbGet(db, `SELECT id FROM empresas WHERE cnpj = ? AND id <> ? LIMIT 1`, [cnpj, atual.id]);
      if (outro) {
        throw erroCadastro(
          'CNPJ_EMPRESA_DUPLICADO',
          'Já existe uma empresa com este CNPJ.',
          409,
          { empresa_id: Number(outro.id) }
        );
      }
    }
  }

  const cnpjMudou = cnpj !== atual.cnpj;
  let txAberta = false;
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    txAberta = true;
    await dbRun(
      db,
      `UPDATE empresas
       SET cnpj = ?, razao_social = ?, nome_fantasia = ?,
           inscricao_estadual = ?, inscricao_municipal = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [cnpj, razaoSocial, nomeFantasia, ie, im, atual.id]
    );
    if (cnpjMudou) {
      const { invalidarCscsDaEmpresa } = require('../fiscal/empresasConfiguracaoFiscal');
      await invalidarCscsDaEmpresa(atual.id, db);
    }
    await dbRun(db, 'COMMIT');
    txAberta = false;
  } catch (err) {
    if (txAberta) {
      try { await dbRun(db, 'ROLLBACK'); } catch (_rollback) { /* ignore */ }
    }
    throw interpretarUniqueCnpj(err);
  }

  const empresa = await buscarEmpresaPorId(atual.id, { db });
  if (cnpjMudou) {
    empresa.cscs_invalidados = true;
    empresa.cscs_mensagem = 'O CNPJ foi alterado. Os CSCs anteriores foram invalidados. Cadastre novamente o CSC de homologação e o de produção.';
  }
  return empresa;
}

async function ativarEmpresa(id, opts = {}) {
  const atual = await buscarEmpresaPorId(id, opts);
  if (atual.ativo === 1) {
    throw erroCadastro(
      'EMPRESA_JA_ATIVA',
      `Empresa já está ativa: ${atual.id}.`,
      409,
      { empresa_id: atual.id }
    );
  }
  const db = getDb(opts.db);
  await dbRun(
    db,
    `UPDATE empresas SET ativo = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [atual.id]
  );
  return buscarEmpresaPorId(atual.id, { db });
}

async function inativarEmpresa(id, opts = {}) {
  const atual = await buscarEmpresaPorId(id, opts);
  if (atual.ativo === 0) {
    throw erroCadastro(
      'EMPRESA_JA_INATIVA',
      `Empresa já está inativa: ${atual.id}.`,
      409,
      { empresa_id: atual.id }
    );
  }
  const db = getDb(opts.db);
  await dbRun(
    db,
    `UPDATE empresas SET ativo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [atual.id]
  );
  return buscarEmpresaPorId(atual.id, { db });
}

/**
 * Empresas ativas + vínculo ativo do usuário (03.3).
 * Sem usuarioId não lista nada (não vaza o cadastro completo).
 */
async function listarEmpresasDisponiveis(opts = {}) {
  const UsuarioEmpresaService = require('./UsuarioEmpresaService');
  const uid = UsuarioEmpresaService.exigirUsuarioId(
    opts.usuarioId != null ? opts.usuarioId : (opts.usuario != null ? opts.usuario : opts.user)
  );
  return UsuarioEmpresaService.listarEmpresasPermitidas(uid, opts);
}

/**
 * Seleciona empresa corrente (validação oficial). Não persiste no JWT.
 */
async function selecionarEmpresaContexto(fonte, opts = {}) {
  const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');
  const id = resolverEmpresaId(fonte);
  if (id == null) {
    throw erroCadastro(
      'EMPRESA_ID_OBRIGATORIO',
      'empresaId é obrigatório para selecionar o contexto empresarial.',
      400
    );
  }

  const empresa = await buscarEmpresaPorId(id, opts);
  if (empresa.ativo !== 1) {
    throw erroCadastro(
      'EMPRESA_INATIVA',
      `Empresa inativa não pode ser usada como contexto operacional: ${empresa.id}.`,
      400,
      { empresa_id: empresa.id }
    );
  }

  const UsuarioEmpresaService = require('./UsuarioEmpresaService');
  await UsuarioEmpresaService.exigirEmpresaAutorizada(
    opts.usuarioId != null ? opts.usuarioId : (opts.usuario != null ? opts.usuario : opts.user),
    empresa.id,
    opts
  );
  return dtoContextoEmpresa(empresa);
}

/**
 * Empresa padrão da loja para o fluxo mobile.
 * PDV em modo UNICA usa pdv_empresa_id. Nos demais modos usa a matriz
 * oficial (CNPJ ordem 0001, com desempate por empresa_operacional_id).
 * Não escolhe outra empresa quando a padrão está ausente, inativa ou
 * fora da autorização do operador.
 */
async function resolverEmpresaPadraoDaLoja(opts = {}) {
  const PdvModelo = require('../pdv/PdvModeloEmpresaService');
  const {
    escolherMatrizPadrao,
    classificarTipoEmpresa
  } = require('./ContextoEmpresaOperacionalService');
  const UsuarioEmpresaService = require('./UsuarioEmpresaService');
  const cfg = opts.cfg || PdvModelo.lerConfigPdvModelo(opts);

  async function autorizar(empresa, origem) {
    try {
      await UsuarioEmpresaService.exigirEmpresaAutorizada(
        opts.user || opts.usuario || opts.usuarioId,
        empresa.id,
        opts
      );
    } catch (err) {
      if (err && err.code === 'EMPRESA_NAO_AUTORIZADA') {
        throw erroCadastro(
          'EMPRESA_PADRAO_NAO_AUTORIZADA',
          'A empresa padrão da loja não está autorizada para este operador.',
          403,
          { empresa_id: empresa.id }
        );
      }
      throw err;
    }
    return { empresa: dtoContextoEmpresa(empresa), origem };
  }

  if (cfg.pdv_modelo_empresa === 'UNICA') {
    let empresa;
    try {
      empresa = await buscarEmpresaPorId(cfg.pdv_empresa_id, opts);
    } catch (err) {
      if (err && err.code === 'EMPRESA_NAO_ENCONTRADA') {
        throw erroCadastro(
          'EMPRESA_PADRAO_AUSENTE',
          'A empresa padrão configurada para o PDV não está cadastrada.',
          409
        );
      }
      throw err;
    }
    if (Number(empresa.ativo) !== 1) {
      throw erroCadastro(
        'EMPRESA_PADRAO_INATIVA',
        'A empresa padrão da loja está inativa.',
        400,
        { empresa_id: empresa.id }
      );
    }
    return autorizar(empresa, 'CONFIG_PDV_EMPRESA_UNICA');
  }

  const todas = await listarEmpresas({}, opts);
  const matrizes = todas.filter((empresa) => classificarTipoEmpresa(empresa.cnpj) === 'MATRIZ');
  if (matrizes.length === 1 && Number(matrizes[0].ativo) !== 1) {
    throw erroCadastro(
      'EMPRESA_PADRAO_INATIVA',
      'A matriz padrão da loja está inativa.',
      400,
      { empresa_id: matrizes[0].id }
    );
  }

  let empresaOperacionalId = opts.empresaOperacionalId != null ? opts.empresaOperacionalId : null;
  if (opts.empresaOperacionalId == null) {
    try {
      const { PoliticaEmpresaSimples } = require('../../core/modo-operacional');
      empresaOperacionalId = PoliticaEmpresaSimples.obterEmpresaOperacionalIdConfig(opts);
    } catch (_erro) {
      empresaOperacionalId = null;
    }
  }
  const padrao = escolherMatrizPadrao(todas, { empresaOperacionalId });
  if (!padrao.empresa) {
    const ambiguo = padrao.codigo === 'MATRIZ_AMBIGUA';
    throw erroCadastro(
      ambiguo ? 'MATRIZ_AMBIGUA' : 'EMPRESA_PADRAO_AUSENTE',
      ambiguo
        ? 'Há mais de uma matriz ativa e a configuração não indica qual é a padrão.'
        : 'A loja não tem empresa padrão ativa.',
      409,
      ambiguo ? { candidatas: padrao.candidatas || [] } : {}
    );
  }
  return autorizar(padrao.empresa, padrao.origem);
}

async function obterContextoEmpresa(fonte, opts = {}) {
  const { resolverEmpresaId, resolverEmpresaIdDaRequisicao } = require('../fiscalNaoFiscal/empresaContexto');
  const id = resolverEmpresaId(fonte)
    ?? resolverEmpresaIdDaRequisicao(opts.req);
  if (id == null) {
    return { empresaId: null, empresa: null, selecionada: false };
  }
  const empresa = await selecionarEmpresaContexto(id, opts);
  return {
    empresaId: empresa.id,
    empresa,
    selecionada: true
  };
}

module.exports = {
  criarEmpresa,
  listarEmpresas,
  listarEmpresasDisponiveis,
  buscarEmpresaPorId,
  buscarEmpresaPorCnpj,
  atualizarEmpresa,
  ativarEmpresa,
  inativarEmpresa,
  selecionarEmpresaContexto,
  resolverEmpresaPadraoDaLoja,
  obterContextoEmpresa,
  dtoContextoEmpresa,
  mapearEmpresa
};
