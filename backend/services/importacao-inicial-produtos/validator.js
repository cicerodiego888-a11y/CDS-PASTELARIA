/**
 * Validação e matching — Importação Inicial de Produtos V1.0.8.
 * Produto EXISTENTE pode ser enriquecido com apresentação comercial nova.
 */
'use strict';

const {
  STATUS,
  MARKUP_PADRAO,
  chaveNomeCadastroSimples,
  calcularFormacaoPrecoOficial,
  arredondarCasas,
  texto,
  resolverFatorConversao,
  calcularEstoqueInicial,
  calcularCustoTotalEstoqueInicial,
  flagOpcional,
  classificarApresentacoesArquivo,
  normalizarUnidadeBaseCadastro,
  validarModoFiscalImportacao,
  itemFiscalDeModoImportacao,
  rotuloModoFiscalImportacao
} = require('./helpers');
const { carregarProdutoConfigMuc } = require('./resolverEstoqueInicialImportacao');

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

function vincularApresentacoes(produto, apresentacoes) {
  const chaveOrigem = chaveNomeCadastroSimples(produto.codigo_origem);
  const chaveNome = chaveNomeCadastroSimples(produto.nome);
  return (apresentacoes || []).filter((a) => {
    const ao = chaveNomeCadastroSimples(a.codigo_origem);
    const an = chaveNomeCadastroSimples(a.nome_produto);
    if (chaveOrigem && ao && chaveOrigem === ao) return true;
    if (chaveNome && an && chaveNome === an) return true;
    return false;
  });
}

function escolherPrincipal(apresentacoesDoProduto) {
  return apresentacoesDoProduto.find((a) => Number(a.principal) === 1)
    || apresentacoesDoProduto.find((a) => a.tipo !== 'UN' && Number(a.quantidade) > 1)
    || apresentacoesDoProduto[0]
    || null;
}

function resolverCustosEPrecos(produto, apresentacoesDoProduto) {
  const markup = Number.isFinite(Number(produto.markup)) ? Number(produto.markup) : MARKUP_PADRAO;
  const principal = escolherPrincipal(apresentacoesDoProduto);

  let custoUnitario = produto.custo_informado;
  let precoUnitario = produto.preco_informado;
  let custoEmbalagem = null;
  let precoEmbalagem = null;
  let quantidadeEmbalagem = null;
  let tipoEmbalagem = null;

  if (principal && Number(principal.quantidade) > 1
    && (Number(principal.custo) > 0 || Number(principal.valor_compra) > 0)) {
    custoEmbalagem = Number(principal.valor_compra ?? principal.custo);
    quantidadeEmbalagem = Number(principal.quantidade);
    tipoEmbalagem = principal.tipo;

    const formacao = calcularFormacaoPrecoOficial({
      valorEmbalagemCompra: custoEmbalagem,
      quantidadePorEmbalagem: quantidadeEmbalagem,
      tipo: tipoEmbalagem,
      markup,
      // custo da planilha pode ser o valor do rolo — formação ignora quando há apresentação
      custoUnitarioInformado: custoUnitario,
      precoVendaInformado: precoUnitario
    });

    // Unidade base: sempre o resultado da conversão (nunca o valor da embalagem)
    custoUnitario = formacao.custo_unitario;
    precoUnitario = formacao.preco_venda;
    // Preço do arquivo só se for escala de embalagem (não flag 0/1 nem preço unitário)
    const precoAprArq = Number(principal.preco ?? principal.preco_venda);
    const tetoApr = Number(custoEmbalagem) * (1 + markup / 100) * 1.2;
    const pisoApr = Number(custoEmbalagem) * 0.5;
    precoEmbalagem = Number.isFinite(precoAprArq) && precoAprArq > 1
      && precoAprArq >= pisoApr && precoAprArq <= tetoApr
      ? precoAprArq
      : formacao.preco_apresentacao;
  } else if (Number.isFinite(Number(produto.custo_apresentacao)) && Number(produto.custo_apresentacao) > 0
    && (!Number.isFinite(Number(custoUnitario)) || Number(custoUnitario) <= 0)) {
    custoEmbalagem = Number(produto.custo_apresentacao);
  } else {
    const formacao = calcularFormacaoPrecoOficial({
      valorEmbalagemCompra: 0,
      quantidadePorEmbalagem: 1,
      markup,
      custoUnitarioInformado: custoUnitario,
      precoVendaInformado: precoUnitario
    });
    if (!Number.isFinite(Number(custoUnitario))) custoUnitario = null;
    else custoUnitario = formacao.custo_unitario;
    if (!Number.isFinite(Number(precoUnitario)) || Number(precoUnitario) <= 0) {
      precoUnitario = formacao.preco_venda;
    }
  }

  return {
    markup,
    custo_unitario: custoUnitario,
    preco_venda: precoUnitario,
    apresentacao_principal: principal ? {
      tipo: tipoEmbalagem || principal.tipo,
      descricao: principal.descricao || null,
      quantidade: quantidadeEmbalagem || Number(principal.quantidade) || 1,
      custo: custoEmbalagem ?? principal.custo ?? principal.valor_compra,
      valor_compra: custoEmbalagem ?? principal.valor_compra ?? principal.custo,
      preco: precoEmbalagem ?? principal.preco,
      preco_venda: precoEmbalagem ?? principal.preco_venda ?? principal.preco,
      unidade: principal.unidade || produto.unidade_base || 'UN',
      codigo_barras: principal.codigo_barras || principal.gtin || null,
      gtin: principal.gtin || principal.codigo_barras || null,
      codigo_fornecedor: principal.codigo_fornecedor || null,
      fornecedor_nome: principal.fornecedor_nome || null,
      principal: flagOpcional(principal.principal) ?? 1,
      compra: flagOpcional(principal.compra),
      venda: flagOpcional(principal.venda),
      estoque: flagOpcional(principal.estoque),
      ativa: flagOpcional(principal.ativa)
    } : null,
    apresentacoes: apresentacoesDoProduto.map((a) => {
      const qtd = Number(a.quantidade) || 1;
      const custo = Number(a.valor_compra ?? a.custo);
      let preco = Number(a.preco_venda ?? a.preco);
      // Ignora flag 0/1 ou valor absurdo vs custo da embalagem
      const precoAprInvalido = !Number.isFinite(preco) || preco <= 1
        || (Number.isFinite(custo) && custo > 0 && preco < custo * 0.5);
      if (precoAprInvalido && Number.isFinite(custo) && custo > 0 && qtd > 1) {
        const f = calcularFormacaoPrecoOficial({
          valorEmbalagemCompra: custo,
          quantidadePorEmbalagem: qtd,
          tipo: a.tipo,
          markup
        });
        preco = f.preco_apresentacao;
      }
      return {
        tipo: a.tipo,
        descricao: a.descricao || null,
        quantidade: qtd,
        unidade: a.unidade || produto.unidade_base || 'UN',
        custo: Number.isFinite(custo) ? custo : null,
        valor_compra: Number.isFinite(custo) ? custo : null,
        preco: Number.isFinite(preco) ? preco : null,
        preco_venda: Number.isFinite(preco) ? preco : null,
        codigo_barras: a.codigo_barras || a.gtin || null,
        gtin: a.gtin || a.codigo_barras || null,
        codigo_fornecedor: a.codigo_fornecedor || null,
        fornecedor_nome: a.fornecedor_nome || null,
        principal: flagOpcional(a.principal),
        compra: flagOpcional(a.compra),
        venda: flagOpcional(a.venda),
        estoque: flagOpcional(a.estoque),
        ativa: flagOpcional(a.ativa)
      };
    })
  };
}

function montarEstoquePreview(produto, pricing, opcoes = {}) {
  const fatorInfo = resolverFatorConversao(pricing.apresentacoes);
  const unidadeBase = String(
    normalizarUnidadeBaseCadastro(produto.unidade_base || 'UN')
  ).toUpperCase();
  const unidadeOrigemArquivo = String(produto.unidade_origem || '').trim();
  const calc = calcularEstoqueInicial({
    quantidadeDocumento: produto.quantidade_documento,
    fatorConversao: fatorInfo.fator,
    unidadeOrigem: unidadeOrigemArquivo,
    unidadeDestino: unidadeBase,
    apresentacoes: pricing.apresentacoes,
    relacoes: opcoes.relacoes,
    produtoConfig: opcoes.produtoConfig,
    db: opcoes.db || null
  });
  const unidadeOrigem = String(
    unidadeOrigemArquivo
    || fatorInfo.tipo
    || unidadeBase
  ).toUpperCase();
  const custoTotal = calcularCustoTotalEstoqueInicial({
    quantidadeOrigem: calc.quantidade_origem,
    custoUnitario: pricing.custo_unitario,
    apresentacao: pricing.apresentacao_principal
  });

  return {
    quantidade_origem: calc.quantidade_origem,
    unidade_origem: unidadeOrigem,
    qtd_origem_label: `${calc.quantidade_origem} ${unidadeOrigem}`,
    fator_conversao: calc.fator_conversao,
    conversao_label: fatorInfo.label,
    estoque_inicial: calc.estoque_inicial,
    estoque_inicial_label: `${calc.estoque_inicial} ${calc.unidadeEstoque || unidadeBase}`,
    unidade_base: unidadeBase,
    custo_total_estoque: custoTotal,
    origem_calculo: calc.origemCalculo || null,
    modo_calculo: calc.modo || null
  };
}

async function carregarIndicesExistentes(db) {
  const produtos = await dbAll(db, `
    SELECT p.id, p.codigo, p.nome, p.codigo_barras, p.marca_id, p.preco_compra, p.preco_venda,
           p.unidade, p.estoque_atual, p.saldo_fiscal, p.item_fiscal,
           m.nome AS marca_nome
    FROM produtos p
    LEFT JOIN marcas m ON m.id = p.marca_id
  `);
  const porCodigo = new Map();
  const porBarras = new Map();
  const porRefMarca = new Map();
  const porNomeMarca = new Map();

  produtos.forEach((p) => {
    const codigo = texto(p.codigo);
    const barras = texto(p.codigo_barras);
    const marca = chaveNomeCadastroSimples(p.marca_nome);
    const nome = chaveNomeCadastroSimples(p.nome);
    if (codigo) porCodigo.set(chaveNomeCadastroSimples(codigo), p);
    if (barras) porBarras.set(barras, p);
    if (nome && marca) porNomeMarca.set(`${nome}|${marca}`, p);
  });

  return { produtos, porCodigo, porBarras, porRefMarca, porNomeMarca };
}

async function carregarEmbalagensProduto(db, produtoId) {
  return dbAll(
    db,
    `SELECT * FROM produto_embalagens WHERE produto_id = ? ORDER BY principal DESC, id ASC`,
    [produtoId]
  );
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

function encontrarCorrespondencia(produto, indices) {
  const codigo = chaveNomeCadastroSimples(produto.codigo_origem);
  if (codigo && indices.porCodigo.has(codigo)) {
    return { seguro: true, motivo: 'codigo_origem', produto: indices.porCodigo.get(codigo) };
  }
  const barras = texto(produto.codigo_barras);
  if (barras && indices.porBarras.has(barras)) {
    return { seguro: true, motivo: 'codigo_barras', produto: indices.porBarras.get(barras) };
  }
  const marca = chaveNomeCadastroSimples(produto.marca);
  const ref = chaveNomeCadastroSimples(produto.referencia_fabricante);
  if (ref && marca) {
    const hit = indices.produtos.find(() => false);
    if (hit) return { seguro: true, motivo: 'referencia_marca', produto: hit };
  }
  const nome = chaveNomeCadastroSimples(produto.nome);
  if (nome && marca && indices.porNomeMarca.has(`${nome}|${marca}`)) {
    return { seguro: true, motivo: 'nome_marca', produto: indices.porNomeMarca.get(`${nome}|${marca}`) };
  }
  if (nome && !marca) {
    const homonimos = indices.produtos.filter((p) => chaveNomeCadastroSimples(p.nome) === nome);
    if (homonimos.length === 1) {
      return { seguro: false, motivo: 'nome_sem_marca', produto: homonimos[0] };
    }
    if (homonimos.length > 1) {
      return { seguro: false, motivo: 'nome_ambiguo', produto: homonimos[0], candidatos: homonimos.length };
    }
  }
  return null;
}

function precisaCorrigirUnidadeBase(produtoDb, unidadeArquivo, apresentacoes) {
  // Compara canônico do arquivo com valor persistido (ex.: "m" legado ≠ "mt" do cadastro)
  const unArq = normalizarUnidadeBaseCadastro(unidadeArquivo);
  const unDbRaw = String(produtoDb?.unidade || '').trim().toLowerCase();
  if (!unArq || unArq === unDbRaw) return false;
  return (apresentacoes || []).some((a) => a.tipo !== 'UN' && Number(a.quantidade) > 1);
}

/**
 * V1.0.14 — indexa codigo_origem duplicado dentro do próprio arquivo.
 * Usa a mesma normalização do matching (chaveNomeCadastroSimples).
 * Não remove/mescla linhas — apenas identifica conflitos.
 */
function mapearDuplicidadesCodigoArquivo(produtos) {
  const porChave = new Map();
  (produtos || []).forEach((p, idx) => {
    const chave = chaveNomeCadastroSimples(p.codigo_origem);
    if (!chave) return;
    if (!porChave.has(chave)) {
      porChave.set(chave, {
        codigo: texto(p.codigo_origem),
        linhas: [],
        nomes: []
      });
    }
    const entry = porChave.get(chave);
    entry.linhas.push(idx + 1);
    entry.nomes.push(texto(p.nome));
  });

  const duplicados = new Map();
  for (const [chave, info] of porChave.entries()) {
    if (info.linhas.length > 1) {
      duplicados.set(chave, {
        codigo: info.codigo,
        ocorrencias: info.linhas.length,
        linhas: info.linhas.slice(),
        nomes: info.nomes.slice()
      });
    }
  }
  return duplicados;
}

function statusBloqueiaImportacao(status) {
  return status === STATUS.ERRO || status === STATUS.CODIGO_DUPLICADO_ARQUIVO;
}

async function validarImportacao(db, dadosExtraidos, { nomeArquivo, modo_fiscal_importacao } = {}) {
  const modoFiscal = validarModoFiscalImportacao(modo_fiscal_importacao);
  const itemFiscalNovos = itemFiscalDeModoImportacao(modoFiscal);
  const indices = await carregarIndicesExistentes(db);
  const duplicidadesArquivo = mapearDuplicidadesCodigoArquivo(dadosExtraidos.produtos);
  const linhas = [];
  let prontos = 0;
  let erros = 0;
  let existentes = 0;
  let enriquecimentos = 0;
  let atencao = 0;
  let estoqueInicialTotal = 0;
  let apresentacoesNovasTotal = 0;
  let novosFiscais = 0;
  let novosNaoFiscais = 0;

  for (let idx = 0; idx < (dadosExtraidos.produtos || []).length; idx += 1) {
    const produtoRaw = dadosExtraidos.produtos[idx];
    const apresentacoes = vincularApresentacoes(produtoRaw, dadosExtraidos.apresentacoes);
    const pricing = resolverCustosEPrecos(produtoRaw, apresentacoes);
    const mensagens = [];
    let status = STATUS.PRONTO;
    let estoque;
    try {
      estoque = montarEstoquePreview(produtoRaw, pricing);
    } catch (e) {
      estoque = {
        quantidade_origem: 0,
        estoque_inicial: 0,
        fator_conversao: 1,
        unidade_origem: '',
        unidade_base: produtoRaw.unidade_base || 'UN'
      };
      status = STATUS.ERRO;
      mensagens.push(e.message || 'Falha na conversão de estoque inicial.');
    }
    let enriquecimento = null;
    const chaveCodigo = chaveNomeCadastroSimples(produtoRaw.codigo_origem);
    const duplicidadeArquivo = chaveCodigo ? duplicidadesArquivo.get(chaveCodigo) || null : null;

    if (!produtoRaw.nome) {
      status = STATUS.ERRO;
      mensagens.push('Nome obrigatório');
    }

    // V1.0.14 — duplicidade no XLSX tem prioridade (bloqueia antes do INSERT/UNIQUE)
    if (duplicidadeArquivo) {
      status = STATUS.CODIGO_DUPLICADO_ARQUIVO;
      mensagens.push('Código duplicado no arquivo.');
    }

    const match = duplicidadeArquivo
      ? null
      : encontrarCorrespondencia(produtoRaw, indices);

    if (match?.produto?.id && status !== STATUS.ERRO) {
      const cfg = await carregarProdutoConfigMuc(db, match.produto.id);
      if (cfg && Number(cfg.utiliza_conversao) === 1) {
        try {
          estoque = montarEstoquePreview(produtoRaw, pricing, { produtoConfig: cfg, db });
        } catch (e) {
          status = STATUS.ERRO;
          mensagens.push(e.message || 'Falha na conversão MUC do estoque inicial.');
        }
      }
    }

    // Produto novo: exige custo/preço válidos
    if (!match && !statusBloqueiaImportacao(status)) {
      if (!Number.isFinite(Number(pricing.custo_unitario)) || Number(pricing.custo_unitario) < 0) {
        status = STATUS.ERRO;
        mensagens.push('Custo unitário inválido');
      }
      if (!Number.isFinite(Number(pricing.preco_venda)) || Number(pricing.preco_venda) <= 0) {
        status = STATUS.ERRO;
        mensagens.push('Preço de venda inválido');
      }
    }

    if (match && !statusBloqueiaImportacao(status)) {
      if (!match.seguro) {
        status = STATUS.ATENCAO;
        mensagens.push(`Requer conferência (${match.motivo})`);
        atencao += 1;
      } else {
        const embDb = await carregarEmbalagensProduto(db, match.produto.id);
        const classif = classificarApresentacoesArquivo(pricing.apresentacoes, embDb);
        const jaEstoque = await jaTemEstoqueInicialImportacao(db, match.produto.id);
        const precisaStock = Number(estoque.estoque_inicial || 0) > 0 && !jaEstoque;
        const corrigeUnidade = precisaCorrigirUnidadeBase(
          match.produto,
          produtoRaw.unidade_base,
          pricing.apresentacoes
        );
        // V1.0.10: preço/custo da unidade base divergente (ex.: 501,47 no lugar de 5,01)
        const temApresentacaoPreco = (pricing.apresentacoes || []).some(
          (a) => a.tipo !== 'UN' && Number(a.quantidade) > 1
            && Number(a.valor_compra ?? a.custo) > 0
        );
        const custoDb = Number(match.produto.preco_compra);
        const precoDb = Number(match.produto.preco_venda);
        const custoEsp = Number(pricing.custo_unitario);
        const precoEsp = Number(pricing.preco_venda);
        const corrigePreco = temApresentacaoPreco
          && Number.isFinite(custoEsp) && custoEsp > 0
          && Number.isFinite(precoEsp) && precoEsp > 0
          && (
            !Number.isFinite(custoDb)
            || !Number.isFinite(precoDb)
            || Math.abs(custoDb - custoEsp) > 0.01
            || Math.abs(precoDb - precoEsp) > 0.02
            || precoDb >= Number(pricing.apresentacao_principal?.valor_compra
              || pricing.apresentacao_principal?.custo || 0) * 0.9
          );

        // V1.0.16 — GTIN/EAN: preencher codigo_barras vazio (nunca sobrescrever)
        const barrasDb = texto(match.produto.codigo_barras);
        const barrasArq = texto(produtoRaw.codigo_barras);
        const corrigeCodigoBarras = !barrasDb && Boolean(barrasArq);

        if (classif.novas.length > 0 || precisaStock || corrigeUnidade || corrigePreco || corrigeCodigoBarras) {
          status = STATUS.EXISTENTE_APRESENTACAO_NOVA;
          mensagens.push(
            corrigeCodigoBarras && classif.novas.length === 0 && !precisaStock && !corrigeUnidade && !corrigePreco
              ? `Produto já existente (#${match.produto.id}) — código de barras a aplicar`
              : `Produto já existente (#${match.produto.id}) — apresentação/complemento a aplicar`
          );
          enriquecimentos += 1;
          apresentacoesNovasTotal += classif.novas.length;
          estoqueInicialTotal = arredondarCasas(
            estoqueInicialTotal + (precisaStock ? Number(estoque.estoque_inicial || 0) : 0),
            3
          );
          enriquecimento = {
            apresentacoes_novas: classif.novas.length,
            apresentacoes_existentes: classif.existentes.length,
            precisa_estoque: precisaStock,
            corrigir_unidade_base: corrigeUnidade,
            corrigir_preco: corrigePreco,
            corrigir_codigo_barras: corrigeCodigoBarras,
            unidade_atual: match.produto.unidade,
            unidade_arquivo: produtoRaw.unidade_base
          };
        } else {
          status = STATUS.EXISTENTE;
          mensagens.push(`Produto já existente (#${match.produto.id} via ${match.motivo})`);
          existentes += 1;
        }
      }
    } else if (!match && status === STATUS.PRONTO) {
      prontos += 1;
      estoqueInicialTotal = arredondarCasas(estoqueInicialTotal + Number(estoque.estoque_inicial || 0), 3);
    }

    if (statusBloqueiaImportacao(status)) erros += 1;

    // V1.0.18 — item_fiscal: novos seguem o modo; existentes preservam o banco
    let itemFiscalLinha;
    let fiscalFonte;
    if (match?.produto) {
      itemFiscalLinha = Number(match.produto.item_fiscal) === 0 ? 0 : 1;
      fiscalFonte = 'EXISTENTE';
    } else {
      itemFiscalLinha = itemFiscalNovos;
      fiscalFonte = 'MODO_IMPORTACAO';
      if (!match && status === STATUS.PRONTO) {
        if (itemFiscalLinha === 1) novosFiscais += 1;
        else novosNaoFiscais += 1;
      }
    }

    const apresentacaoLabel = pricing.apresentacao_principal
      ? `${pricing.apresentacao_principal.tipo} ${pricing.apresentacao_principal.quantidade} ${pricing.apresentacao_principal.unidade}`
      : '—';

    linhas.push({
      linha: idx + 1,
      status,
      mensagens,
      produto: {
        ...produtoRaw,
        item_fiscal: itemFiscalLinha,
        fiscal: itemFiscalLinha === 1,
        fiscal_fonte: fiscalFonte,
        markup: pricing.markup,
        custo_unitario: pricing.custo_unitario,
        preco_venda: pricing.preco_venda,
        unidade_base: normalizarUnidadeBaseCadastro(produtoRaw.unidade_base || 'UN')
      },
      apresentacoes: pricing.apresentacoes,
      apresentacao_label: apresentacaoLabel,
      estoque,
      existente_id: match?.produto?.id || null,
      match_motivo: match?.motivo || null,
      enriquecimento,
      duplicidade_arquivo: duplicidadeArquivo
    });
  }

  const importaveis = prontos + enriquecimentos;

  return {
    arquivo: nomeArquivo || null,
    modo_fiscal_importacao: modoFiscal,
    tratamento_fiscal: rotuloModoFiscalImportacao(modoFiscal),
    resumo: {
      produtos_encontrados: linhas.length,
      produtos_validos: prontos + existentes + enriquecimentos + atencao,
      com_erro: erros,
      possiveis_duplicados: existentes + atencao,
      prontos,
      existentes,
      enriquecimentos,
      apresentacoes_novas: apresentacoesNovasTotal,
      atencao,
      erros,
      estoque_inicial_total: estoqueInicialTotal,
      estoque_inicial_unidade: 'UN',
      modo_fiscal_importacao: modoFiscal,
      tratamento_fiscal: rotuloModoFiscalImportacao(modoFiscal),
      produtos_novos: prontos,
      produtos_existentes: existentes + enriquecimentos + atencao,
      produtos_fiscais_novos: novosFiscais,
      produtos_nao_fiscais_novos: novosNaoFiscais
    },
    linhas,
    pode_importar: erros === 0 && importaveis > 0
  };
}

module.exports = {
  validarImportacao,
  resolverCustosEPrecos,
  vincularApresentacoes,
  encontrarCorrespondencia,
  carregarIndicesExistentes,
  montarEstoquePreview,
  classificarApresentacoesArquivo,
  carregarEmbalagensProduto,
  mapearDuplicidadesCodigoArquivo,
  statusBloqueiaImportacao
};
