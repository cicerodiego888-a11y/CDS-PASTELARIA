/**
 * Ficha técnica do produto comercial — catálogo compartilhado (03.03).
 * Sem empresa_id: a ficha é do produto, não do CNPJ.
 * Sem baixa de estoque. Sem fallback de empresa.
 *
 * @module services/produtos/FichaTecnicaService
 */
'use strict';

const MotorUM = require('../unidades/MotorUnidadesMedida');
const { obterMuc } = require('../../motores/muc/public');
const {
  TipoOperacionalProduto,
  normalizarTipoOperacional
} = require('./tipoOperacionalProduto');
const { garantirSchemaFichaTecnicaAsync } = require('./fichaTecnicaSchema');
const { garantirSchemaFichaPersonalizacaoAsync } = require('./personalizacaoIngredientesSchema');

const CLASSIFICACOES_COMERCIAIS = new Set([
  'OBRIGATORIO_OCULTO',
  'OPCIONAL',
  'OPCIONAL_COM_ADICIONAL'
]);

function erroFicha(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
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

function validarUnidadeFicha(unidade) {
  const raw = String(unidade || '').trim();
  if (!raw) {
    throw erroFicha('UNIDADE_INVALIDA', 'Unidade da ficha é obrigatória.');
  }
  const { isUnidadeConhecida, normalizarUnidade } = require('../../motores/muc/core/unidadesSi');
  const dest = normalizarUnidade(raw);
  if (!dest || !isUnidadeConhecida(dest)) {
    if (!MotorUM.isUnidadeComercialConhecida(raw)) {
      throw erroFicha('UNIDADE_INVALIDA', `Unidade inválida: ${unidade || '(vazia)'}.`);
    }
    return MotorUM.normalizarUnidadeComercial(raw);
  }
  return dest;
}

function converterQuantidadeFicha(entrada = {}) {
  const db = entrada.db || getDb();
  const muc = obterMuc(db);
  if (entrada.quantidade != null && (entrada.unidadeOrigem || entrada.unidade) && entrada.unidadeDestino) {
    return muc.converterQuantidade({
      quantidade: entrada.quantidade,
      unidadeOrigem: entrada.unidadeOrigem || entrada.unidade,
      unidadeDestino: entrada.unidadeDestino,
      relacoes: entrada.relacoes
    });
  }
  return muc.converter(entrada);
}

async function obterProduto(db, id) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw erroFicha('PRODUTO_INEXISTENTE', 'Produto inexistente.', 404);
  }
  const row = await dbGet(
    db,
    `SELECT id, nome, ativo, unidade,
            COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional,
            COALESCE(permite_personalizacao_ingredientes, 0) AS permite_personalizacao_ingredientes,
            utiliza_ficha_tecnica
     FROM produtos WHERE id = ?`,
    [pid]
  );
  if (!row) throw erroFicha('PRODUTO_INEXISTENTE', 'Produto inexistente.', 404);
  return row;
}

async function consultarUsoFichaTecnica(produtoId, opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaFichaPersonalizacaoAsync(db);
  const produto = await obterProduto(db, produtoId);
  const ficha = await dbGet(
    db,
    'SELECT id, ativo FROM ficha_tecnica WHERE produto_id = ?',
    [produto.id]
  );
  const configuracaoLegada = produto.utiliza_ficha_tecnica == null;
  const utilizaFichaTecnica = configuracaoLegada
    ? Boolean(ficha) || Number(produto.permite_personalizacao_ingredientes) === 1
    : Number(produto.utiliza_ficha_tecnica) === 1;
  return {
    produto_id: produto.id,
    utiliza_ficha_tecnica: utilizaFichaTecnica,
    configuracao_legada: configuracaoLegada,
    ficha_existe: Boolean(ficha),
    ficha_ativa: Boolean(ficha) && Number(ficha.ativo) === 1
  };
}

async function listarInsumos(opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaFichaPersonalizacaoAsync(db);
  return dbAll(
    db,
    `SELECT id, codigo, nome, unidade, COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional
     FROM produtos
     WHERE COALESCE(tipo_operacional, 'COMERCIAL') = ?
       AND COALESCE(ativo, 1) = 1
     ORDER BY nome`,
    [TipoOperacionalProduto.INSUMO]
  );
}

async function obterPorProdutoId(produtoId, opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaFichaPersonalizacaoAsync(db);
  const produto = await obterProduto(db, produtoId);
  const cab = await dbGet(db, 'SELECT * FROM ficha_tecnica WHERE produto_id = ?', [produto.id]);
  if (!cab) {
    return {
      produto_id: produto.id,
      permite_personalizacao_ingredientes: Number(produto.permite_personalizacao_ingredientes) === 1,
      utiliza_ficha_tecnica: produto.utiliza_ficha_tecnica == null
        ? Boolean(Number(produto.permite_personalizacao_ingredientes) === 1)
        : Number(produto.utiliza_ficha_tecnica) === 1,
      configuracao_legada: produto.utiliza_ficha_tecnica == null,
      existe: false,
      ativo: 0,
      itens: []
    };
  }
  const itensBrutos = await dbAll(
    db,
    `SELECT id, insumo_id, quantidade, unidade, classificacao_comercial, preco_adicional
     FROM ficha_tecnica_itens
     WHERE ficha_tecnica_id = ?
     ORDER BY id`,
    [cab.id]
  );
  const idsInsumos = Array.from(new Set(itensBrutos.map((item) => Number(item.insumo_id))));
  const produtosInsumos = idsInsumos.length
    ? await dbAll(
      db,
      `SELECT id, nome, unidade, ativo,
              COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional
       FROM produtos
       WHERE id IN (${idsInsumos.map(() => '?').join(',')})`,
      idsInsumos
    )
    : [];
  const insumosPorId = new Map(produtosInsumos.map((item) => [Number(item.id), item]));
  const referenciasInvalidas = itensBrutos
    .filter((item) => !insumosPorId.has(Number(item.insumo_id)))
    .map((item) => `item ${item.id} → insumo ${item.insumo_id}`);
  if (referenciasInvalidas.length) {
    throw erroFicha(
      'FICHA_TECNICA_INTEGRIDADE',
      `Ficha técnica ${cab.id} do produto ${produto.id} contém referência(s) de insumo inexistente(s): ${referenciasInvalidas.join(', ')}.`
    );
  }

  const vistos = new Set();
  const itens = itensBrutos.map((item) => {
    const insumoId = Number(item.insumo_id);
    const insumo = insumosPorId.get(insumoId);
    if (Number(insumo.ativo) === 0) {
      throw erroFicha(
        'INSUMO_INATIVO',
        `O insumo ${insumoId} da ficha técnica ${cab.id} está inativo.`
      );
    }
    if (normalizarTipoOperacional(insumo.tipo_operacional) !== TipoOperacionalProduto.INSUMO) {
      throw erroFicha(
        'COMPONENTE_NAO_INSUMO',
        `O produto ${insumoId} da ficha técnica ${cab.id} não está cadastrado como insumo.`
      );
    }
    if (vistos.has(insumoId)) {
      throw erroFicha(
        'INSUMO_DUPLICADO',
        `O insumo ${insumoId} está duplicado na ficha técnica ${cab.id}.`
      );
    }
    vistos.add(insumoId);
    if (!(Number(item.quantidade) > 0) || !Number.isFinite(Number(item.quantidade))) {
      throw erroFicha(
        'QUANTIDADE_INVALIDA',
        `A quantidade do item ${item.id} da ficha técnica ${cab.id} deve ser positiva.`
      );
    }
    if (!CLASSIFICACOES_COMERCIAIS.has(String(item.classificacao_comercial || 'OBRIGATORIO_OCULTO'))) {
      throw erroFicha(
        'CLASSIFICACAO_INGREDIENTE_INVALIDA',
        `A classificação comercial do item ${item.id} da ficha técnica ${cab.id} é inválida.`
      );
    }
    if (!Number.isFinite(Number(item.preco_adicional)) || Number(item.preco_adicional) < 0) {
      throw erroFicha(
        'PRECO_ADICIONAL_INVALIDO',
        `O preço adicional do item ${item.id} da ficha técnica ${cab.id} é inválido.`
      );
    }
    if (
      item.classificacao_comercial === 'OPCIONAL_COM_ADICIONAL'
        ? Number(item.preco_adicional) <= 0
        : Number(item.preco_adicional) !== 0
    ) {
      throw erroFicha(
        'PRECO_ADICIONAL_INVALIDO',
        `O preço adicional do item ${item.id} da ficha técnica ${cab.id} não corresponde à classificação comercial.`
      );
    }
    validarUnidadeFicha(item.unidade);
    return {
      ...item,
      insumo_nome: insumo.nome,
      insumo_unidade: insumo.unidade
    };
  });
  return {
    ...cab,
    permite_personalizacao_ingredientes: Number(produto.permite_personalizacao_ingredientes) === 1,
    utiliza_ficha_tecnica: produto.utiliza_ficha_tecnica == null
      ? true
      : Number(produto.utiliza_ficha_tecnica) === 1,
    configuracao_legada: produto.utiliza_ficha_tecnica == null,
    existe: true,
    itens
  };
}

async function excluirPorProdutoId(produtoId, opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  const cab = await dbGet(db, 'SELECT id FROM ficha_tecnica WHERE produto_id = ?', [Number(produtoId)]);
  if (!cab) return { excluida: false };
  await dbRun(db, 'DELETE FROM ficha_tecnica_itens WHERE ficha_tecnica_id = ?', [cab.id]);
  await dbRun(db, 'DELETE FROM ficha_tecnica WHERE id = ?', [cab.id]);
  return { excluida: true };
}

async function salvar(produtoId, payload = {}, opcoes = {}) {
  const db = getDb(opcoes.db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaFichaPersonalizacaoAsync(db);
  const produto = await obterProduto(db, produtoId);
  if (Number(produto.ativo) === 0) {
    throw erroFicha('PRODUTO_INATIVO', 'Produto inativo não recebe ficha técnica.');
  }
  if (normalizarTipoOperacional(produto.tipo_operacional) !== TipoOperacionalProduto.COMERCIAL) {
    throw erroFicha(
      'FICHA_SOMENTE_COMERCIAL',
      'Ficha técnica aplica-se somente a produto comercial.'
    );
  }

  const itens = Array.isArray(payload.itens) ? payload.itens : [];
  const ativo = payload.ativo === 0 || payload.ativo === false ? 0 : 1;
  if (ativo === 1 && itens.length === 0) {
    throw erroFicha(
      'FICHA_TECNICA_VAZIA',
      'Ficha técnica ativa deve possuir ao menos um ingrediente.'
    );
  }
  const visto = new Set();
  let quantidadeOpcionais = 0;

  for (const raw of itens) {
    const insumoId = Number(raw.insumo_id != null ? raw.insumo_id : raw.insumoId);
    const qtd = Number(raw.quantidade);
    if (!Number.isInteger(insumoId) || insumoId <= 0) {
      throw erroFicha('INSUMO_INVALIDO', 'Insumo inválido.');
    }
    if (!(qtd > 0) || !Number.isFinite(qtd)) {
      throw erroFicha('QUANTIDADE_INVALIDA', 'Quantidade da ficha técnica deve ser positiva.');
    }
    const unidade = validarUnidadeFicha(raw.unidade);
    const classificacaoComercial = String(raw.classificacao_comercial || 'OBRIGATORIO_OCULTO')
      .trim()
      .toUpperCase();
    if (!CLASSIFICACOES_COMERCIAIS.has(classificacaoComercial)) {
      throw erroFicha('CLASSIFICACAO_INGREDIENTE_INVALIDA', 'Classificação comercial do ingrediente inválida.');
    }
    const precoAdicionalBruto = raw.preco_adicional == null || raw.preco_adicional === ''
      ? 0
      : Number(raw.preco_adicional);
    if (!Number.isFinite(precoAdicionalBruto) || precoAdicionalBruto < 0) {
      throw erroFicha('PRECO_ADICIONAL_INVALIDO', 'Preço adicional do ingrediente inválido.');
    }
    const precoAdicional = Number(precoAdicionalBruto.toFixed(2));
    if (
      classificacaoComercial === 'OPCIONAL_COM_ADICIONAL'
        ? precoAdicional <= 0
        : precoAdicional !== 0
    ) {
      throw erroFicha(
        'PRECO_ADICIONAL_INVALIDO',
        'Informe um preço positivo apenas para ingredientes opcionais com adicional.'
      );
    }
    if (classificacaoComercial !== 'OBRIGATORIO_OCULTO') quantidadeOpcionais += 1;
    if (visto.has(insumoId)) {
      throw erroFicha('INSUMO_DUPLICADO', 'Componente duplicado na ficha técnica.');
    }
    visto.add(insumoId);

    let insumo;
    try {
      insumo = await obterProduto(db, insumoId);
    } catch (e) {
      if (e.code === 'PRODUTO_INEXISTENTE') {
        throw erroFicha('INSUMO_INEXISTENTE', 'Insumo inexistente.', 404);
      }
      throw e;
    }
    if (Number(insumo.ativo) === 0) {
      throw erroFicha('INSUMO_INATIVO', 'Insumo inativo.');
    }
    if (normalizarTipoOperacional(insumo.tipo_operacional) !== TipoOperacionalProduto.INSUMO) {
      throw erroFicha(
        'COMPONENTE_NAO_INSUMO',
        'Produto comercial não pode ser utilizado como insumo.'
      );
    }
    const fichaDoInsumo = await dbGet(
      db,
      'SELECT id FROM ficha_tecnica WHERE produto_id = ? AND COALESCE(ativo, 1) = 1',
      [insumo.id]
    );
    if (fichaDoInsumo) {
      throw erroFicha(
        'INSUMO_NAO_PODE_TER_FICHA',
        'Insumo não pode ter ficha técnica de outro insumo.'
      );
    }
    raw._ok = {
      insumo_id: insumo.id,
      quantidade: qtd,
      unidade,
      classificacao_comercial: classificacaoComercial,
      preco_adicional: precoAdicional
    };
  }

  if (Number(produto.permite_personalizacao_ingredientes) === 1) {
    if (ativo !== 1) {
      throw erroFicha(
        'PERSONALIZACAO_SEM_FICHA_ATIVA',
        'A personalização de ingredientes exige uma ficha técnica ativa.'
      );
    }
    if (quantidadeOpcionais === 0) {
      throw erroFicha(
        'PERSONALIZACAO_SEM_OPCOES',
        'Cadastre ao menos um ingrediente opcional para habilitar a personalização.'
      );
    }
  }

  const existente = await dbGet(db, 'SELECT id FROM ficha_tecnica WHERE produto_id = ?', [produto.id]);
  let fichaId;
  if (existente) {
    await dbRun(
      db,
      `UPDATE ficha_tecnica SET ativo = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [ativo, existente.id]
    );
    fichaId = existente.id;
    await dbRun(db, 'DELETE FROM ficha_tecnica_itens WHERE ficha_tecnica_id = ?', [fichaId]);
  } else {
    const ins = await dbRun(
      db,
      `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, ?)`,
      [produto.id, ativo]
    );
    fichaId = ins.lastID;
  }

  for (const raw of itens) {
    const it = raw._ok;
    await dbRun(
      db,
      `INSERT INTO ficha_tecnica_itens (
         ficha_tecnica_id, insumo_id, quantidade, unidade, classificacao_comercial, preco_adicional
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        fichaId,
        it.insumo_id,
        it.quantidade,
        it.unidade,
        it.classificacao_comercial,
        it.preco_adicional
      ]
    );
  }

  return obterPorProdutoId(produto.id, { db });
}

module.exports = {
  listarInsumos,
  consultarUsoFichaTecnica,
  obterPorProdutoId,
  salvar,
  excluirPorProdutoId,
  converterQuantidadeFicha,
  validarUnidadeFicha
};
