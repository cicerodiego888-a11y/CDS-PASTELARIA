'use strict';

const { lerConfigPdvModelo, validarEmpresaPdvAtiva } = require('../pdv/PdvModeloEmpresaService');

const CODIGO_PDV = 'PDV';

function erroCanal(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function prometer(db, metodo, sql, params) {
  return new Promise((resolve, reject) => {
    db[metodo](sql, params || [], function (err, rows) {
      if (err) reject(err);
      else if (metodo === 'run') resolve({ lastID: this.lastID, changes: this.changes });
      else resolve(rows);
    });
  });
}

function agora() {
  return new Date().toISOString();
}

function normalizarCodigo(valor) {
  const codigo = String(valor || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
  if (!codigo) throw erroCanal('CANAL_CODIGO_INVALIDO', 'Informe o código interno do canal.');
  return codigo;
}

function normalizarNome(valor) {
  const nome = String(valor || '').trim();
  if (!nome) throw erroCanal('CANAL_NOME_INVALIDO', 'Informe o nome do canal.');
  return nome;
}

function normalizarTipo(valor) {
  const tipo = String(valor || '').trim();
  if (!tipo) throw erroCanal('CANAL_TIPO_INVALIDO', 'Informe o tipo ou a origem do canal.');
  return tipo.slice(0, 60);
}

function normalizarEmpresaId(valor) {
  if (valor == null || valor === '') return null;
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroCanal('CANAL_EMPRESA_INVALIDA', 'A empresa responsável é inválida.');
  }
  return id;
}

function usuarioEhAdmin(usuario) {
  if (!usuario) return false;
  const role = String(usuario.role || usuario.perfil || '').toUpperCase();
  return usuario.admin === true || role === 'ADMIN' || role === 'SUPER_ADMIN';
}

function autorizarUsuario(usuario, empresaId) {
  if (!usuario || usuario.id == null) {
    throw erroCanal('CANAL_USUARIO_SEM_AUTORIZACAO', 'Usuário sem autorização para esta empresa.', 403);
  }
  if (usuarioEhAdmin(usuario)) return;
  if (!Array.isArray(usuario.empresas)) return;
  const permitidas = usuario.empresas.map((id) => Number(id));
  if (!permitidas.includes(Number(empresaId))) {
    throw erroCanal('CANAL_USUARIO_SEM_AUTORIZACAO', 'Usuário sem autorização para esta empresa.', 403);
  }
}

async function garantirSchema(db) {
  await prometer(db, 'run', `
    CREATE TABLE IF NOT EXISTS canais_venda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      codigo TEXT NOT NULL UNIQUE,
      descricao TEXT,
      tipo_origem TEXT NOT NULL,
      empresa_id INTEGER,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    )
  `);
  await prometer(db, 'run', `
    CREATE TABLE IF NOT EXISTS canais_venda_auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canal_id INTEGER NOT NULL,
      empresa_anterior_id INTEGER,
      empresa_nova_id INTEGER,
      ativo_anterior INTEGER,
      ativo_novo INTEGER,
      usuario_id INTEGER,
      criado_em TEXT NOT NULL
    )
  `);
}

async function registrarAuditoria(db, evento) {
  await prometer(db, 'run', `
    INSERT INTO canais_venda_auditoria (
      canal_id, empresa_anterior_id, empresa_nova_id,
      ativo_anterior, ativo_novo, usuario_id, criado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    evento.canalId,
    evento.empresaAnteriorId,
    evento.empresaNovaId,
    evento.ativoAnterior,
    evento.ativoNovo,
    evento.usuarioId || null,
    agora()
  ]);
}

async function empresaAtiva(db, empresaId) {
  const row = await prometer(
    db,
    'get',
    'SELECT id, cnpj, nome_fantasia, razao_social, ativo FROM empresas WHERE id = ?',
    [empresaId]
  );
  if (!row || Number(row.ativo) === 0) return null;
  return row;
}

async function espelharCanalPdv(db, deps) {
  const cfg = lerConfigPdvModelo(deps || {});
  const existente = await prometer(db, 'get', 'SELECT id FROM canais_venda WHERE codigo = ?', [CODIGO_PDV]);
  const momento = agora();
  if (!existente) {
    await prometer(db, 'run', `
      INSERT INTO canais_venda (nome, codigo, descricao, tipo_origem, empresa_id, ativo, criado_em, atualizado_em)
      VALUES ('PDV', 'PDV', 'Loja física', 'PDV', ?, 1, ?, ?)
    `, [cfg.pdv_empresa_id, momento, momento]);
    return;
  }
  if (cfg.pdv_modelo_empresa === 'UNICA') {
    await prometer(db, 'run', `
      UPDATE canais_venda SET empresa_id = ?, atualizado_em = ? WHERE codigo = 'PDV'
    `, [cfg.pdv_empresa_id, momento]);
  }
}

async function listarCanais(db, deps) {
  await garantirSchema(db);
  await espelharCanalPdv(db, deps);
  return prometer(db, 'all', `
    SELECT c.id, c.nome, c.codigo, c.descricao, c.tipo_origem, c.empresa_id, c.ativo,
           c.criado_em, c.atualizado_em, e.cnpj, e.nome_fantasia, e.razao_social
    FROM canais_venda c
    LEFT JOIN empresas e ON e.id = c.empresa_id
    ORDER BY c.nome COLLATE NOCASE
  `);
}

async function cadastrarCanal(db, entrada, deps) {
  await garantirSchema(db);
  const codigo = normalizarCodigo(entrada.codigo);
  if (codigo === CODIGO_PDV) {
    throw erroCanal(
      'CANAL_PDV_USA_CONFIG',
      'O canal PDV usa pdv_empresa_id e o modo MULTIPLAS ou UNICA. Altere no bloco Canal PDV.',
      409
    );
  }
  const nome = normalizarNome(entrada.nome);
  const tipo = normalizarTipo(entrada.tipo_origem || entrada.tipoOrigem);
  const descricao = entrada.descricao != null ? String(entrada.descricao).trim() : '';
  const ativo = entrada.ativo === false || Number(entrada.ativo) === 0 ? 0 : 1;
  const empresaId = normalizarEmpresaId(entrada.empresa_id != null ? entrada.empresa_id : entrada.empresaId);
  if (ativo === 1 && empresaId == null) {
    throw erroCanal('CANAL_SEM_EMPRESA', 'Canal ativo precisa de uma empresa responsável.', 409);
  }
  if (empresaId != null) {
    const empresa = await empresaAtiva(db, empresaId);
    if (!empresa) throw erroCanal('EMPRESA_INATIVA', 'A empresa responsável não existe ou está inativa.', 409);
  }
  const momento = agora();
  const gravado = await prometer(db, 'run', `
    INSERT INTO canais_venda (nome, codigo, descricao, tipo_origem, empresa_id, ativo, criado_em, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [nome, codigo, descricao || null, tipo, empresaId, ativo, momento, momento]);
  await registrarAuditoria(db, {
    canalId: gravado.lastID,
    empresaAnteriorId: null,
    empresaNovaId: empresaId,
    ativoAnterior: null,
    ativoNovo: ativo,
    usuarioId: deps && deps.usuario && deps.usuario.id
  });
  return prometer(db, 'get', 'SELECT * FROM canais_venda WHERE id = ?', [gravado.lastID]);
}

async function atualizarVinculo(db, canalId, entrada, deps) {
  await garantirSchema(db);
  const atual = await prometer(db, 'get', 'SELECT * FROM canais_venda WHERE id = ?', [canalId]);
  if (!atual) throw erroCanal('CANAL_INEXISTENTE', 'Canal de venda não encontrado.', 404);
  if (atual.codigo === CODIGO_PDV) {
    throw erroCanal(
      'CANAL_PDV_USA_CONFIG',
      'O canal PDV usa pdv_empresa_id e o modo MULTIPLAS ou UNICA. Altere no bloco Canal PDV.',
      409
    );
  }
  const empresaId = Object.prototype.hasOwnProperty.call(entrada, 'empresa_id')
    || Object.prototype.hasOwnProperty.call(entrada, 'empresaId')
    ? normalizarEmpresaId(entrada.empresa_id != null ? entrada.empresa_id : entrada.empresaId)
    : atual.empresa_id;
  const ativo = entrada.ativo == null ? Number(atual.ativo) : (entrada.ativo === false || Number(entrada.ativo) === 0 ? 0 : 1);
  if (ativo === 1 && empresaId == null) {
    throw erroCanal('CANAL_SEM_EMPRESA', 'Canal ativo precisa de uma empresa responsável.', 409);
  }
  if (empresaId != null) {
    const empresa = await empresaAtiva(db, empresaId);
    if (!empresa) throw erroCanal('EMPRESA_INATIVA', 'A empresa responsável não existe ou está inativa.', 409);
  }
  const momento = agora();
  await prometer(db, 'run', `
    UPDATE canais_venda
    SET nome = ?, descricao = ?, tipo_origem = ?, empresa_id = ?, ativo = ?, atualizado_em = ?
    WHERE id = ?
  `, [
    entrada.nome != null ? normalizarNome(entrada.nome) : atual.nome,
    entrada.descricao != null ? String(entrada.descricao).trim() : atual.descricao,
    entrada.tipo_origem != null || entrada.tipoOrigem != null
      ? normalizarTipo(entrada.tipo_origem || entrada.tipoOrigem)
      : atual.tipo_origem,
    empresaId,
    ativo,
    momento,
    atual.id
  ]);
  if (Number(atual.empresa_id) !== Number(empresaId) || Number(atual.ativo) !== ativo) {
    await registrarAuditoria(db, {
      canalId: atual.id,
      empresaAnteriorId: atual.empresa_id,
      empresaNovaId: empresaId,
      ativoAnterior: atual.ativo,
      ativoNovo: ativo,
      usuarioId: deps && deps.usuario && deps.usuario.id
    });
  }
  return prometer(db, 'get', 'SELECT * FROM canais_venda WHERE id = ?', [atual.id]);
}

async function resolverPdvPelaConfiguracao(db, entrada, deps, canal) {
  const cfg = lerConfigPdvModelo(deps || {});
  if (cfg.pdv_modelo_empresa !== 'UNICA') {
    return {
      canal_id: canal ? canal.id : null,
      codigo: CODIGO_PDV,
      aplicada: false,
      motivo: 'PDV_MULTIPLAS',
      pdv_modelo_empresa: cfg.pdv_modelo_empresa,
      pdv_empresa_id: cfg.pdv_empresa_id
    };
  }
  const validada = await validarEmpresaPdvAtiva(cfg.pdv_empresa_id, deps || {});
  const empresa = await empresaAtiva(db, validada.empresa_id);
  if (!empresa) throw erroCanal('EMPRESA_INATIVA', 'A empresa do PDV não existe ou está inativa.', 409);
  autorizarUsuario(entrada && entrada.usuario, empresa.id);
  return {
    canal_id: canal ? canal.id : null,
    codigo: CODIGO_PDV,
    aplicada: true,
    motivo: 'PDV_EMPRESA_UNICA',
    empresa_id: empresa.id,
    cnpj: empresa.cnpj,
    pdv_modelo_empresa: 'UNICA',
    pdv_empresa_id: cfg.pdv_empresa_id
  };
}

async function resolverEmpresaDoCanal(db, entrada, deps) {
  await garantirSchema(db);
  const porId = entrada && entrada.canalId != null;
  const codigoBusca = porId ? null : normalizarCodigo(entrada && entrada.codigo);
  const canal = porId
    ? await prometer(db, 'get', 'SELECT * FROM canais_venda WHERE id = ?', [Number(entrada.canalId)])
    : await prometer(db, 'get', 'SELECT * FROM canais_venda WHERE codigo = ?', [codigoBusca]);
  if ((canal && canal.codigo === CODIGO_PDV) || codigoBusca === CODIGO_PDV) {
    return resolverPdvPelaConfiguracao(db, entrada, deps, canal);
  }
  if (!canal) throw erroCanal('CANAL_INEXISTENTE', 'Canal de venda não encontrado.', 404);
  if (Number(canal.ativo) !== 1) {
    throw erroCanal('CANAL_INATIVO', 'O canal de venda está inativo.', 409);
  }

  if (canal.empresa_id == null) {
    throw erroCanal('CANAL_SEM_EMPRESA', 'O canal não tem empresa responsável.', 409);
  }
  const empresa = await empresaAtiva(db, canal.empresa_id);
  if (!empresa) throw erroCanal('EMPRESA_INATIVA', 'A empresa responsável não existe ou está inativa.', 409);
  autorizarUsuario(entrada && entrada.usuario, empresa.id);
  return {
    canal_id: canal.id,
    codigo: canal.codigo,
    aplicada: true,
    empresa_id: empresa.id,
    cnpj: empresa.cnpj,
    nome_fantasia: empresa.nome_fantasia || empresa.razao_social || null
  };
}

module.exports = {
  garantirSchema,
  listarCanais,
  cadastrarCanal,
  atualizarVinculo,
  resolverEmpresaDoCanal,
  erroCanal
};
