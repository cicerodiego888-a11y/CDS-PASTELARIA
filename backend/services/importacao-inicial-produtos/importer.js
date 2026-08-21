/**
 * Persistência transacional — Importação Inicial de Produtos V1.0.8.
 * Apresentações via ProdutoEmbalagemService (mesmo do cadastro manual).
 * Produto EXISTENTE pode ser enriquecido com apresentação comercial nova.
 * Estoque via ajusteEstoqueService.
 */
'use strict';

const path = require('path');
const dbModule = require('../../database');
const { fazerBackupManual } = require('../backupManual');
const { findOrCreateMarca } = require('../MarcaService');
const { aplicarAjusteEstoqueProduto } = require('../ajusteEstoqueService');
const { obterProdutoEmbalagemService } = require('../produto-embalagem/ProdutoEmbalagemService');
const {
  chaveNomeCadastroSimples,
  normalizarNomeCadastroSimples,
  STATUS,
  montarMotivoEstoqueInicial,
  calcularCustoTotalEstoqueInicial,
  montarEmbalagensParaServico,
  mesclarApresentacoesParaSync,
  normalizarUnidadeBaseCadastro,
  texto
} = require('./helpers');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
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

function aplicarAjusteAsync(db, opcoes) {
  return new Promise((resolve, reject) => {
    aplicarAjusteEstoqueProduto(db, opcoes, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function findOrCreateCategoria(db, nomeBruto, cache) {
  const nome = normalizarNomeCadastroSimples(nomeBruto);
  if (!nome) return null;
  const chave = chaveNomeCadastroSimples(nome);
  if (cache.categorias.has(chave)) return cache.categorias.get(chave);

  const todas = await dbAll(db, `SELECT id, nome FROM categorias WHERE COALESCE(ativo, 1) = 1`);
  const existente = todas.find((c) => chaveNomeCadastroSimples(c.nome) === chave);
  if (existente) {
    cache.categorias.set(chave, existente.id);
    return existente.id;
  }
  const ins = await dbRun(
    db,
    `INSERT INTO categorias (nome, tipo, ativo, created_at, updated_at)
     VALUES (?, 'produto', 1, datetime('now','localtime'), datetime('now','localtime'))`,
    [nome]
  );
  cache.categorias.set(chave, ins.lastID);
  return ins.lastID;
}

async function findOrCreateSubcategoria(db, nomeBruto, categoriaId, cache) {
  const nome = normalizarNomeCadastroSimples(nomeBruto);
  if (!nome || !categoriaId) return null;
  const chave = `${categoriaId}|${chaveNomeCadastroSimples(nome)}`;
  if (cache.subcategorias.has(chave)) return cache.subcategorias.get(chave);

  const todas = await dbAll(
    db,
    `SELECT id, nome, categoria_id FROM subcategorias WHERE categoria_id = ? AND COALESCE(ativo, 1) = 1`,
    [categoriaId]
  );
  const existente = todas.find((s) => chaveNomeCadastroSimples(s.nome) === chaveNomeCadastroSimples(nome));
  if (existente) {
    cache.subcategorias.set(chave, existente.id);
    return existente.id;
  }
  const ins = await dbRun(
    db,
    `INSERT INTO subcategorias (nome, categoria_id, ativo, created_at, updated_at)
     VALUES (?, ?, 1, datetime('now','localtime'), datetime('now','localtime'))`,
    [nome, categoriaId]
  );
  cache.subcategorias.set(chave, ins.lastID);
  return ins.lastID;
}

/**
 * Persiste apresentações pelo serviço oficial do cadastro manual.
 * usarTransacao:false — a TX externa da importação já está aberta.
 */
function sincronizarEmbalagensOficial(db, produtoId, apresentacoes, unidadeBase, usuario, { forcarFalha } = {}) {
  return new Promise((resolve, reject) => {
    if (forcarFalha) {
      return reject(new Error('Falha forçada na criação da apresentação (teste de rollback).'));
    }
    const lista = montarEmbalagensParaServico(apresentacoes, unidadeBase, {
      origem: 'IMPORTACAO_INICIAL'
    });
    if (!lista.length) return resolve([]);

    const svc = obterProdutoEmbalagemService(db);
    svc.sincronizarEmbalagensProduto(
      produtoId,
      lista,
      unidadeBase,
      usuario || null,
      (err, inseridas) => (err ? reject(err) : resolve(inseridas || [])),
      { usarTransacao: false }
    );
  });
}

async function jaTemEstoqueInicialImportacao(db, produtoId) {
  const row = await dbGet(
    db,
    `SELECT id FROM produtos_ajustes_estoque
     WHERE produto_id = ?
       AND motivo LIKE 'ESTOQUE INICIAL — IMPORTAÇÃO DE PRODUTOS%'
     LIMIT 1`,
    [produtoId]
  );
  return Boolean(row);
}

async function registrarEstoqueInicial(db, {
  produtoId,
  linha,
  importId,
  usuarioId,
  usuarioNome,
  forcarFalhaEstoque
}) {
  const estoque = linha.estoque || {};
  const qtd = Number(estoque.estoque_inicial || 0);
  if (!Number.isFinite(qtd) || qtd <= 0) {
    return { lancado: 0, movimentado: false };
  }

  if (await jaTemEstoqueInicialImportacao(db, produtoId)) {
    return { lancado: 0, movimentado: false, ja_existia: true };
  }

  if (forcarFalhaEstoque) {
    throw new Error('Falha forçada no registro de estoque inicial (teste de rollback).');
  }

  const p = linha.produto || {};
  const custoTotal = Number.isFinite(Number(estoque.custo_total_estoque))
    ? Number(estoque.custo_total_estoque)
    : calcularCustoTotalEstoqueInicial({
      quantidadeOrigem: estoque.quantidade_origem,
      custoUnitario: p.custo_unitario,
      apresentacao: linha.apresentacoes?.find((a) => a.tipo !== 'UN' && Number(a.quantidade) > 1)
        || linha.apresentacoes?.[0]
        || null
    });

  const motivo = montarMotivoEstoqueInicial({
    importId,
    codigoOrigem: p.codigo_origem,
    custoUnitario: p.custo_unitario,
    custoTotal
  });

  // Estoque inicial segue o item_fiscal da linha (novo=modo; existente=banco)
  const itemFiscal = Number(p.item_fiscal) === 0 ? 0 : 1;
  await aplicarAjusteAsync(db, {
    produtoId,
    ajusteFiscal: itemFiscal === 1 ? qtd : 0,
    ajusteNaoFiscal: itemFiscal === 0 ? qtd : 0,
    motivo,
    usuarioId: usuarioId || null,
    usuarioNome: usuarioNome || 'Importação Inicial'
  });

  return { lancado: qtd, movimentado: true };
}

async function inserirProduto(db, linha, cache, usuarioId) {
  const p = linha.produto;
  let marcaId = null;
  if (p.marca) {
    const r = await findOrCreateMarca(db, p.marca);
    marcaId = r.marca?.id || null;
  }
  const categoriaId = await findOrCreateCategoria(db, p.categoria, cache);
  const subcategoriaId = await findOrCreateSubcategoria(db, p.subcategoria, categoriaId, cache);
  const unidade = normalizarUnidadeBaseCadastro(p.unidade_base || 'UN');
  const codigo = p.codigo_origem || null;

  const ins = await dbRun(
    db,
    `INSERT INTO produtos (
      codigo, nome, categoria_id, subcategoria_id, unidade,
      preco_compra, lucro_percentual, preco_venda,
      estoque_atual, estoque_minimo, fornecedor,
      ncm, cfop, csosn, origem, cest, codigo_barras,
      aliquota_icms, aliquota_pis, aliquota_cofins,
      controlar_validade, controla_estoque,
      vendido_por_peso, produto_fracionado, peso_total_compra, valor_total_compra, custo_por_kg,
      venda_atacado,
      saldo_fiscal, saldo_nao_fiscal, item_fiscal,
      permite_venda_unidade, peso_medio_unidade, preco_unidade,
      marca_id, observacoes, imagem_principal
    ) VALUES (${Array(37).fill('?').join(', ')})`,
    [
      codigo,
      p.nome,
      categoriaId,
      subcategoriaId,
      unidade,
      Number(p.custo_unitario) || 0,
      Number(p.markup) || 100,
      Number(p.preco_venda) || 0,
      0,
      0,
      null,
      p.ncm || null,
      null,
      null,
      0,
      p.cest || null,
      p.codigo_barras || null,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      Number(p.item_fiscal) === 0 ? 0 : 1,
      0,
      0,
      0,
      marcaId,
      p.observacoes || (p.referencia_fabricante ? `Ref: ${p.referencia_fabricante}` : null),
      null
    ]
  );

  const produtoId = ins.lastID;
  const temApresentacaoComercial = (linha.apresentacoes || []).some(
    (a) => a.tipo !== 'UN' && Number(a.quantidade) > 1
  );
  if (temApresentacaoComercial) {
    await dbRun(db, `UPDATE produtos SET compra_por_embalagem = 1 WHERE id = ?`, [produtoId]);
  }

  await sincronizarEmbalagensOficial(
    db,
    produtoId,
    linha.apresentacoes,
    unidade,
    { id: usuarioId },
    { forcarFalha: linha._forcarFalhaApresentacao === true }
  );
  return produtoId;
}

/**
 * Enriquece produto EXISTENTE: apresentação nova/sincronizada, unidade base se
 * a apresentação exigir, custo/preço via motor (já na linha), estoque inicial,
 * e codigo_barras quando vazio no banco (V1.0.16).
 * Não sobrescreve nome, marca, categoria, fiscal, NCM, codigo_barras já preenchido, etc.
 */
async function enriquecerProdutoExistente(db, linha, {
  usuarioId,
  usuarioNome,
  importId,
  forcarFalhaEstoque,
  forcarFalhaApresentacao
} = {}) {
  const produtoId = linha.existente_id;
  if (!produtoId) {
    throw new Error('Linha de enriquecimento sem produto existente.');
  }

  const enr = linha.enriquecimento || {};
  let codigoBarrasAtualizado = false;

  // V1.0.16 — preencher codigo_barras somente se estiver vazio no banco
  if (enr.corrigir_codigo_barras) {
    const barrasArq = texto(linha.produto?.codigo_barras);
    if (barrasArq) {
      const upd = await dbRun(
        db,
        `UPDATE produtos
         SET codigo_barras = ?
         WHERE id = ?
           AND (codigo_barras IS NULL OR TRIM(COALESCE(codigo_barras, '')) = '')`,
        [barrasArq, produtoId]
      );
      codigoBarrasAtualizado = Number(upd.changes || 0) > 0;
    }
  }

  const soCodigoBarras = Boolean(enr.corrigir_codigo_barras)
    && !enr.corrigir_unidade_base
    && !enr.corrigir_preco
    && !enr.precisa_estoque
    && !(Number(enr.apresentacoes_novas || 0) > 0);

  if (soCodigoBarras) {
    return {
      produtoId,
      apresentacoes_novas: 0,
      apresentacoes_sincronizadas: 0,
      codigo_barras_atualizado: codigoBarrasAtualizado,
      mov: { lancado: 0, movimentado: false }
    };
  }

  const embDb = await dbAll(
    db,
    `SELECT * FROM produto_embalagens WHERE produto_id = ? ORDER BY principal DESC, id ASC`,
    [produtoId]
  );
  const { merged, classif } = mesclarApresentacoesParaSync(linha.apresentacoes || [], embDb);
  const unidadeAlvo = normalizarUnidadeBaseCadastro(linha.produto?.unidade_base || 'UN');

  if (enr.corrigir_unidade_base) {
    // Mesmo código do select do cadastro (Metro = "mt")
    await dbRun(db, `UPDATE produtos SET unidade = ? WHERE id = ?`, [unidadeAlvo, produtoId]);
  }

  const temComercial = merged.some((a) => a.tipo !== 'UN' && Number(a.quantidade) > 1);
  if (temComercial) {
    await dbRun(db, `UPDATE produtos SET compra_por_embalagem = 1 WHERE id = ?`, [produtoId]);
  }

  // Custo/preço somente quando a importação trouxe formação válida (motor oficial na validação)
  const p = linha.produto || {};
  const custo = Number(p.custo_unitario);
  const preco = Number(p.preco_venda);
  const markup = Number(p.markup);
  if ((classif.novas.length > 0 || classif.existentes.length > 0)
    && Number.isFinite(custo) && custo > 0
    && Number.isFinite(preco) && preco > 0) {
    await dbRun(
      db,
      `UPDATE produtos
       SET preco_compra = ?, preco_venda = ?, lucro_percentual = COALESCE(?, lucro_percentual)
       WHERE id = ?`,
      [custo, preco, Number.isFinite(markup) ? markup : null, produtoId]
    );
  }

  if (merged.length > 0) {
    await sincronizarEmbalagensOficial(
      db,
      produtoId,
      merged,
      unidadeAlvo,
      { id: usuarioId },
      { forcarFalha: forcarFalhaApresentacao === true || linha._forcarFalhaApresentacao === true }
    );
  }

  const mov = await registrarEstoqueInicial(db, {
    produtoId,
    linha,
    importId,
    usuarioId,
    usuarioNome,
    forcarFalhaEstoque
  });

  return {
    produtoId,
    apresentacoes_novas: classif.novas.length,
    apresentacoes_sincronizadas: classif.existentes.length,
    codigo_barras_atualizado: codigoBarrasAtualizado,
    mov
  };
}

async function obterPastaBackupConfigurada(db) {
  const row = await dbGet(db, `SELECT valor FROM configuracoes WHERE chave = 'backup_path' LIMIT 1`);
  return row?.valor || null;
}

/**
 * Executa backup + importação transacional (produto novo e/ou enriquecimento).
 */
async function executarImportacao(db, validacao, {
  usuarioId,
  usuarioNome,
  dbPath,
  pastaBackup,
  importId,
  forcarFalhaEstoque,
  forcarFalhaApresentacao
} = {}) {
  const linhasNovas = (validacao.linhas || []).filter((l) => l.status === STATUS.PRONTO);
  const linhasEnriquecer = (validacao.linhas || []).filter(
    (l) => l.status === STATUS.EXISTENTE_APRESENTACAO_NOVA
  );
  const existentes = (validacao.linhas || []).filter((l) => l.status === STATUS.EXISTENTE);
  const atencao = (validacao.linhas || []).filter((l) => l.status === STATUS.ATENCAO);
  const refImportacao = importId || validacao.arquivo || `imp-${Date.now()}`;

  if ((validacao.linhas || []).some(
    (l) => l.status === STATUS.ERRO || l.status === STATUS.CODIGO_DUPLICADO_ARQUIVO
  )) {
    const err = new Error('Existem produtos com erro. Corrija antes de importar.');
    err.status = 400;
    throw err;
  }
  if (!linhasNovas.length && !linhasEnriquecer.length) {
    return {
      sucesso: true,
      backup: null,
      relatorio: {
        produtos_processados: (validacao.linhas || []).length,
        criados: 0,
        existentes: existentes.length,
        enriquecidos: 0,
        apresentacoes_novas: 0,
        atualizados: 0,
        com_atencao: atencao.length,
        erros: 0,
        estoque_lancado: 0,
        movimentacoes_estoque: 0
      }
    };
  }

  let backup;
  try {
    const pasta = pastaBackup || await obterPastaBackupConfigurada(db);
    const caminhoDb = dbPath || dbModule.dbPath || path.join(process.cwd(), 'database.db');
    backup = fazerBackupManual(caminhoDb, pasta || undefined);
  } catch (e) {
    const err = new Error('Não foi possível criar o backup. A importação foi cancelada.');
    err.status = 500;
    err.cause = e;
    throw err;
  }

  const cache = {
    categorias: new Map(),
    subcategorias: new Map()
  };

  await dbRun(db, 'BEGIN IMMEDIATE');
  const criados = [];
  const enriquecidos = [];
  let apresentacoesNovas = 0;
  let estoqueLancado = 0;
  let movimentacoes = 0;
  try {
    for (const linha of linhasNovas) {
      if (forcarFalhaApresentacao) {
        linha._forcarFalhaApresentacao = true;
      }
      const id = await inserirProduto(db, linha, cache, usuarioId);
      criados.push(id);
      const mov = await registrarEstoqueInicial(db, {
        produtoId: id,
        linha,
        importId: refImportacao,
        usuarioId,
        usuarioNome,
        forcarFalhaEstoque
      });
      estoqueLancado += Number(mov.lancado || 0);
      if (mov.movimentado) movimentacoes += 1;
    }

    for (const linha of linhasEnriquecer) {
      const r = await enriquecerProdutoExistente(db, linha, {
        usuarioId,
        usuarioNome,
        importId: refImportacao,
        forcarFalhaEstoque,
        forcarFalhaApresentacao
      });
      enriquecidos.push(r.produtoId);
      apresentacoesNovas += Number(r.apresentacoes_novas || 0);
      estoqueLancado += Number(r.mov?.lancado || 0);
      if (r.mov?.movimentado) movimentacoes += 1;
    }

    await dbRun(db, 'COMMIT');
  } catch (e) {
    try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }

  return {
    sucesso: true,
    backup: {
      arquivo: backup.arquivo,
      caminho: backup.caminho
    },
    relatorio: {
      produtos_processados: (validacao.linhas || []).length,
      criados: criados.length,
      existentes: existentes.length,
      enriquecidos: enriquecidos.length,
      apresentacoes_novas: apresentacoesNovas,
      atualizados: enriquecidos.length,
      com_atencao: atencao.length,
      erros: 0,
      estoque_lancado: estoqueLancado,
      movimentacoes_estoque: movimentacoes,
      ids_criados: criados,
      ids_enriquecidos: enriquecidos,
      import_id: refImportacao
    }
  };
}

module.exports = {
  executarImportacao,
  findOrCreateCategoria,
  findOrCreateSubcategoria,
  inserirProduto,
  enriquecerProdutoExistente,
  sincronizarEmbalagensOficial,
  registrarEstoqueInicial,
  jaTemEstoqueInicialImportacao
};
