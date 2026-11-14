'use strict';

const { lerConfigPdvModelo, validarEmpresaPdvAtiva } = require('../pdv/PdvModeloEmpresaService');
const { garantirSchemaCanaisVendaAsync } = require('./canaisVendaSchema');

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

function fecharConexao(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function executarTransacao(db, executar) {
  const conexaoExclusiva = typeof db.openExclusiveConnection === 'function';
  const transacaoDb = conexaoExclusiva ? await db.openExclusiveConnection() : db;
  let iniciouTransacao = false;
  let erroTransacao = null;
  let resultado;

  try {
    await prometer(transacaoDb, 'run', 'BEGIN IMMEDIATE');
    iniciouTransacao = true;
    resultado = await executar(transacaoDb);
    await prometer(transacaoDb, 'run', 'COMMIT');
    iniciouTransacao = false;
  } catch (err) {
    erroTransacao = err instanceof Error ? err : new Error(String(err));
    if (iniciouTransacao) {
      try {
        await prometer(transacaoDb, 'run', 'ROLLBACK');
      } catch (erroRollback) {
        erroTransacao.rollbackError = erroRollback;
      }
    }
  }

  if (conexaoExclusiva) {
    try {
      await fecharConexao(transacaoDb);
    } catch (erroFechamento) {
      if (erroTransacao) erroTransacao.closeError = erroFechamento;
      else erroTransacao = erroFechamento;
    }
  }
  if (erroTransacao) throw erroTransacao;
  return resultado;
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

function normalizarDescricao(valor) {
  if (valor == null) return null;
  const descricao = String(valor).trim();
  return descricao || null;
}

function normalizarAtivo(valor, atual) {
  if (valor == null) return Number(atual) === 1 ? 1 : 0;
  if (valor === true || valor === 1 || valor === '1') return 1;
  if (valor === false || valor === 0 || valor === '0') return 0;
  throw erroCanal('CANAL_STATUS_INVALIDO', 'Informe uma situação ativa ou inativa válida.');
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
  await garantirSchemaCanaisVendaAsync(db);
}

function lerConfigSemFalhar(deps) {
  try {
    return { cfg: lerConfigPdvModelo(deps || {}), aviso: null };
  } catch (err) {
    return {
      cfg: null,
      aviso: err.message || 'A configuração do PDV não pôde ser lida.'
    };
  }
}

async function registrarAuditoria(db, evento) {
  await prometer(db, 'run', `
    INSERT INTO canais_venda_auditoria (
      canal_id, empresa_anterior_id, empresa_nova_id,
      ativo_anterior, ativo_novo,
      nome_anterior, nome_novo, descricao_anterior, descricao_nova,
      tipo_origem_anterior, tipo_origem_novo, usuario_id, criado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    evento.canalId,
    evento.empresaAnteriorId,
    evento.empresaNovaId,
    evento.ativoAnterior,
    evento.ativoNovo,
    evento.nomeAnterior,
    evento.nomeNovo,
    evento.descricaoAnterior,
    evento.descricaoNova,
    evento.tipoOrigemAnterior,
    evento.tipoOrigemNovo,
    evento.usuarioId || null,
    evento.criadoEm || agora()
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

async function lerEmpresasVinculadas(db, ids) {
  if (!ids.length) return { mapa: new Map(), disponivel: true };
  const consultas = [
    `SELECT id, cnpj, nome_fantasia, razao_social, ativo FROM empresas WHERE id IN (${ids.map(() => '?').join(',')})`,
    `SELECT id, cnpj, razao_social, ativo FROM empresas WHERE id IN (${ids.map(() => '?').join(',')})`,
    `SELECT id, cnpj, razao_social FROM empresas WHERE id IN (${ids.map(() => '?').join(',')})`,
    `SELECT id, cnpj FROM empresas WHERE id IN (${ids.map(() => '?').join(',')})`
  ];
  let ultimoErro = null;
  for (const sql of consultas) {
    try {
      const rows = await prometer(db, 'all', sql, ids);
      return {
        mapa: new Map((rows || []).map((row) => [Number(row.id), row])),
        disponivel: true
      };
    } catch (err) {
      ultimoErro = err;
      if (!/no such column/i.test(String(err && err.message || ''))) break;
    }
  }
  if (ultimoErro && /no such table/i.test(String(ultimoErro.message || ''))) {
    return { mapa: new Map(), disponivel: false };
  }
  if (ultimoErro && /no such column/i.test(String(ultimoErro.message || ''))) {
    return { mapa: new Map(), disponivel: false };
  }
  throw ultimoErro;
}

function aplicarEmpresa(canal, empresas, cfg) {
  let empresaId = canal.empresa_id == null ? null : Number(canal.empresa_id);
  if (canal.codigo === CODIGO_PDV && cfg && cfg.pdv_modelo_empresa === 'UNICA') {
    empresaId = cfg.pdv_empresa_id;
  }
  const empresa = empresaId == null ? null : empresas.mapa.get(Number(empresaId));
  const vinculoValido = empresaId == null || !empresa
    ? (empresaId == null ? null : false)
    : (empresa.ativo == null ? null : Number(empresa.ativo) !== 0);
  return Object.assign({}, canal, {
    empresa_id: empresaId,
    empresa_vinculo_valido: vinculoValido,
    cnpj: empresa ? empresa.cnpj : null,
    nome_fantasia: empresa ? (empresa.nome_fantasia || null) : null,
    razao_social: empresa ? (empresa.razao_social || null) : null
  });
}

async function consultarListagemCanais(db, deps) {
  const leitura = lerConfigSemFalhar(deps);
  const canais = await prometer(db, 'all', `
    SELECT id, nome, codigo, descricao, tipo_origem, empresa_id, ativo, criado_em, atualizado_em
    FROM canais_venda
    ORDER BY nome COLLATE NOCASE
  `);
  const ids = [...new Set((canais || [])
    .map((canal) => canal.empresa_id)
    .concat(leitura.cfg && leitura.cfg.pdv_modelo_empresa === 'UNICA' ? [leitura.cfg.pdv_empresa_id] : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];
  const empresas = await lerEmpresasVinculadas(db, ids);
  const avisos = [];
  if (leitura.aviso) avisos.push(leitura.aviso);
  if (!empresas.disponivel) {
    avisos.push('Não foi possível ler o cadastro de empresas. Os canais foram listados sem CNPJ.');
  }
  return {
    canais: (canais || []).map((canal) => aplicarEmpresa(canal, empresas, leitura.cfg)),
    avisos
  };
}

async function listarCanais(db, deps) {
  const lista = await consultarListagemCanais(db, deps);
  return lista.canais;
}

function respostaHttpListagem(err) {
  const negocio = err && Number.isInteger(err.statusCode) && err.statusCode < 500 && err.code;
  return {
    status: negocio ? err.statusCode : 500,
    body: {
      error: negocio ? err.message : 'Não foi possível carregar os canais de venda.',
      code: negocio ? err.code : 'CANAIS_VENDA_LISTAGEM_FALHOU'
    }
  };
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
  const descricao = normalizarDescricao(entrada.descricao);
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
  return executarTransacao(db, async (transacaoDb) => {
    const gravado = await prometer(transacaoDb, 'run', `
      INSERT INTO canais_venda (nome, codigo, descricao, tipo_origem, empresa_id, ativo, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [nome, codigo, descricao, tipo, empresaId, ativo, momento, momento]);
    await registrarAuditoria(transacaoDb, {
      canalId: gravado.lastID,
      empresaAnteriorId: null,
      empresaNovaId: empresaId,
      ativoAnterior: null,
      ativoNovo: ativo,
      nomeAnterior: null,
      nomeNovo: nome,
      descricaoAnterior: null,
      descricaoNova: descricao,
      tipoOrigemAnterior: null,
      tipoOrigemNovo: tipo,
      usuarioId: deps && deps.usuario && deps.usuario.id,
      criadoEm: momento
    });
    return prometer(transacaoDb, 'get', 'SELECT * FROM canais_venda WHERE id = ?', [gravado.lastID]);
  });
}

async function atualizarVinculo(db, canalId, entrada, deps) {
  await garantirSchema(db);
  const id = Number(canalId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroCanal('CANAL_ID_INVALIDO', 'Identificador de canal inválido.');
  }
  const dados = entrada || {};

  return executarTransacao(db, async (transacaoDb) => {
    const atual = await prometer(transacaoDb, 'get', 'SELECT * FROM canais_venda WHERE id = ?', [id]);
    if (!atual) throw erroCanal('CANAL_INEXISTENTE', 'Canal de venda não encontrado.', 404);
    if (atual.codigo === CODIGO_PDV) {
      throw erroCanal(
        'CANAL_PDV_USA_CONFIG',
        'O canal PDV usa pdv_empresa_id e o modo MULTIPLAS ou UNICA. Altere no bloco Canal PDV.',
        409
      );
    }
    if (Object.prototype.hasOwnProperty.call(dados, 'codigo')) {
      const codigoInformado = normalizarCodigo(dados.codigo);
      if (codigoInformado !== atual.codigo) {
        throw erroCanal('CANAL_CODIGO_IMUTAVEL', 'O código do canal é estável e não pode ser alterado.', 409);
      }
    }

    const possuiEmpresa = Object.prototype.hasOwnProperty.call(dados, 'empresa_id')
      || Object.prototype.hasOwnProperty.call(dados, 'empresaId');
    const empresaId = possuiEmpresa
      ? normalizarEmpresaId(dados.empresa_id != null ? dados.empresa_id : dados.empresaId)
      : (atual.empresa_id == null ? null : Number(atual.empresa_id));
    const ativo = normalizarAtivo(dados.ativo, atual.ativo);
    const nome = dados.nome == null ? atual.nome : normalizarNome(dados.nome);
    const descricao = dados.descricao === undefined
      ? atual.descricao
      : normalizarDescricao(dados.descricao);
    const tipo = dados.tipo_origem == null && dados.tipoOrigem == null
      ? atual.tipo_origem
      : normalizarTipo(dados.tipo_origem || dados.tipoOrigem);

    if (ativo === 1 && empresaId == null) {
      throw erroCanal('CANAL_SEM_EMPRESA', 'Canal ativo precisa de uma empresa responsável.', 409);
    }
    const empresaMudou = Number(atual.empresa_id) !== Number(empresaId)
      || (atual.empresa_id == null) !== (empresaId == null);
    if (empresaId != null && (empresaMudou || ativo === 1)) {
      const empresa = await empresaAtiva(transacaoDb, empresaId);
      if (!empresa) throw erroCanal('EMPRESA_INATIVA', 'A empresa responsável não existe ou está inativa.', 409);
    }
    if (ativo === 1) {
      const codigoNormalizado = normalizarCodigo(atual.codigo);
      if (codigoNormalizado !== atual.codigo) {
        throw erroCanal('CANAL_CODIGO_INVALIDO', 'O código salvo do canal é inválido para reativação.', 409);
      }
      const conflito = await prometer(transacaoDb, 'get', `
        SELECT id FROM canais_venda WHERE codigo = ? AND id <> ? LIMIT 1
      `, [atual.codigo, atual.id]);
      if (conflito) {
        throw erroCanal('CANAL_CODIGO_CONFLITANTE', 'Já existe outro canal com este código.', 409);
      }
    }

    const alterado = nome !== atual.nome
      || descricao !== (atual.descricao == null ? null : atual.descricao)
      || tipo !== atual.tipo_origem
      || empresaMudou
      || Number(atual.ativo) !== ativo;
    if (!alterado) return atual;

    const momento = agora();
    await prometer(transacaoDb, 'run', `
      UPDATE canais_venda
      SET nome = ?, descricao = ?, tipo_origem = ?, empresa_id = ?, ativo = ?, atualizado_em = ?
      WHERE id = ?
    `, [nome, descricao, tipo, empresaId, ativo, momento, atual.id]);
    await registrarAuditoria(transacaoDb, {
      canalId: atual.id,
      empresaAnteriorId: atual.empresa_id,
      empresaNovaId: empresaId,
      ativoAnterior: Number(atual.ativo),
      ativoNovo: ativo,
      nomeAnterior: atual.nome,
      nomeNovo: nome,
      descricaoAnterior: atual.descricao,
      descricaoNova: descricao,
      tipoOrigemAnterior: atual.tipo_origem,
      tipoOrigemNovo: tipo,
      usuarioId: deps && deps.usuario && deps.usuario.id,
      criadoEm: momento
    });
    return prometer(transacaoDb, 'get', 'SELECT * FROM canais_venda WHERE id = ?', [atual.id]);
  });
}

async function consultarHistoricoCanal(db, canalId) {
  const id = Number(canalId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroCanal('CANAL_ID_INVALIDO', 'Identificador de canal inválido.');
  }
  const canal = await prometer(db, 'get', 'SELECT id FROM canais_venda WHERE id = ?', [id]);
  if (!canal) throw erroCanal('CANAL_INEXISTENTE', 'Canal de venda não encontrado.', 404);
  return prometer(db, 'all', `
    SELECT id, canal_id, nome_anterior, nome_novo,
           descricao_anterior, descricao_nova,
           tipo_origem_anterior, tipo_origem_novo,
           empresa_anterior_id, empresa_nova_id,
           ativo_anterior, ativo_novo, usuario_id, criado_em
    FROM canais_venda_auditoria
    WHERE canal_id = ?
    ORDER BY id DESC
  `, [id]);
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
  consultarListagemCanais,
  respostaHttpListagem,
  cadastrarCanal,
  atualizarVinculo,
  consultarHistoricoCanal,
  resolverEmpresaDoCanal,
  erroCanal
};
