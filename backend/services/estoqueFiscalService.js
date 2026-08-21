'use strict';

const estoqueSaldosPublico = require('./fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('./fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('./fiscalNaoFiscal/empresaContexto');

function resolverQuantidadesCompraItemPersistido(item = {}) {
  const quantidade = Number(item.quantidade || 0);
  let quantidade_fiscal = item.quantidade_fiscal !== undefined && item.quantidade_fiscal !== null
    ? Number(item.quantidade_fiscal || 0)
    : null;
  let quantidade_nao_fiscal = item.quantidade_nao_fiscal !== undefined && item.quantidade_nao_fiscal !== null
    ? Number(item.quantidade_nao_fiscal || 0)
    : null;

  // Registros antigos: colunas criadas com DEFAULT 0 ficaram 0 em vez de NULL
  if (
    quantidade > 0
    && quantidade_fiscal === 0
    && quantidade_nao_fiscal === 0
    && (item.quantidade_fiscal !== undefined || item.quantidade_nao_fiscal !== undefined)
  ) {
    if (Number(item.item_fiscal) === 0) {
      quantidade_nao_fiscal = quantidade;
      quantidade_fiscal = 0;
    } else {
      quantidade_fiscal = quantidade;
      quantidade_nao_fiscal = 0;
    }
  }

  if (quantidade_fiscal === null) {
    quantidade_fiscal = Number(item.item_fiscal) === 0 ? 0 : quantidade;
  }
  if (quantidade_nao_fiscal === null) {
    quantidade_nao_fiscal = Number(item.item_fiscal) === 0 ? quantidade : 0;
  }

  const quantidadeResolvida = quantidade > 0 ? quantidade : (quantidade_fiscal + quantidade_nao_fiscal);

  return {
    quantidade_fiscal,
    quantidade_nao_fiscal,
    quantidade: quantidadeResolvida
  };
}

function resolverQuantidadesVendaItem(item = {}) {
  const quantidade = Number(item.quantidade || 0);
  let quantidade_fiscal = item.quantidade_fiscal !== undefined && item.quantidade_fiscal !== null
    ? Number(item.quantidade_fiscal || 0)
    : null;
  let quantidade_nao_fiscal = item.quantidade_nao_fiscal !== undefined && item.quantidade_nao_fiscal !== null
    ? Number(item.quantidade_nao_fiscal || 0)
    : null;

  if (
    quantidade > 0
    && quantidade_fiscal === 0
    && quantidade_nao_fiscal === 0
    && (item.quantidade_fiscal !== undefined || item.quantidade_nao_fiscal !== undefined)
  ) {
    if (Number(item.item_fiscal) === 0) {
      quantidade_nao_fiscal = quantidade;
      quantidade_fiscal = 0;
    } else {
      quantidade_fiscal = quantidade;
      quantidade_nao_fiscal = 0;
    }
  }

  if (quantidade_fiscal === null) {
    quantidade_fiscal = Number(item.item_fiscal) === 0 ? 0 : quantidade;
  }
  if (quantidade_nao_fiscal === null) {
    quantidade_nao_fiscal = Number(item.item_fiscal) === 0 ? quantidade : 0;
  }

  const quantidadeResolvida = quantidade > 0 ? quantidade : (quantidade_fiscal + quantidade_nao_fiscal);

  return {
    quantidade_fiscal,
    quantidade_nao_fiscal,
    quantidade: quantidadeResolvida
  };
}

function calcularDevolucaoFiscalPrimeiro(qtds, qtdDevolver, jaDevolvido = {}) {
  const fiscalRestante = Math.max(
    0,
    Number(qtds.quantidade_fiscal || 0) - Number(jaDevolvido.fiscal || 0)
  );
  const naoFiscalRestante = Math.max(
    0,
    Number(qtds.quantidade_nao_fiscal || 0) - Number(jaDevolvido.nao_fiscal || 0)
  );
  const qtd = Number(qtdDevolver || 0);

  if (qtd <= 0) {
    return { qtdFiscal: 0, qtdNaoFiscal: 0, qtdTotal: 0 };
  }

  const maxDevolver = fiscalRestante + naoFiscalRestante;
  const qtdEfetiva = Math.min(qtd, maxDevolver);
  const qtdFiscal = Math.min(qtdEfetiva, fiscalRestante);
  const qtdNaoFiscal = Math.min(qtdEfetiva - qtdFiscal, naoFiscalRestante);

  return {
    qtdFiscal: Number(qtdFiscal.toFixed(3)),
    qtdNaoFiscal: Number(qtdNaoFiscal.toFixed(3)),
    qtdTotal: Number(qtdEfetiva.toFixed(3))
  };
}

function calcularDevolucaoVendaFiscalPrimeiro(itemVenda, qtdDevolver, jaDevolvido = {}) {
  return calcularDevolucaoFiscalPrimeiro(
    resolverQuantidadesVendaItem(itemVenda),
    qtdDevolver,
    jaDevolvido
  );
}

function calcularDevolucaoCompraFiscalPrimeiro(itemCompra, qtdDevolver, jaDevolvido = {}) {
  return calcularDevolucaoFiscalPrimeiro(
    resolverQuantidadesCompraItemPersistido(itemCompra),
    qtdDevolver,
    jaDevolvido
  );
}

function resolverJaDevolvidoCompraFiscalPrimeiro(itemCompra, qtdJaDevolvida) {
  const qtd = Number(qtdJaDevolvida || 0);
  if (qtd <= 0) {
    return { fiscal: 0, nao_fiscal: 0 };
  }
  const split = calcularDevolucaoCompraFiscalPrimeiro(itemCompra, qtd, { fiscal: 0, nao_fiscal: 0 });
  return { fiscal: split.qtdFiscal, nao_fiscal: split.qtdNaoFiscal };
}

function recalcularEstoqueConsolidado(produto) {
  return (
    Number(produto.saldo_fiscal || 0) +
    Number(produto.saldo_nao_fiscal || 0)
  );
}

/** Compat explícita: rotas/migração de bootstrap ainda sem empresa no JWT. */
const MOTIVO_COMPAT_RECALCULO = 'COMPAT_RECALCULO_PRE_MULTIEMPRESA';

function montarOptsPortaRecalculo(db, opcoes = {}) {
  const empresaId = resolverEmpresaId(opcoes)
    ?? resolverEmpresaId(opcoes.contexto)
    ?? resolverEmpresaId(opcoes.ctx);

  const base = {
    db,
    usuarioId: opcoes.usuarioId,
    validarEmpresa: opcoes.validarEmpresa
  };

  if (empresaId != null) {
    return { ...base, empresaId, legado: false, motivoCompat: null };
  }

  if (opcoes.exigirEmpresa === true) {
    const err = new Error(
      'empresaId é obrigatório para operações de saldo/reserva. Informe empresa_id/empresaId no contexto.'
    );
    err.code = 'EMPRESA_OBRIGATORIA';
    throw err;
  }

  return {
    ...base,
    modoLegadoSemEmpresa: true,
    motivoCompat: opcoes.motivoCompat || MOTIVO_COMPAT_RECALCULO,
    legado: true
  };
}

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

/**
 * Calcula saldos-alvo a partir do histórico (compras concluídas − vendas não
 * canceladas − devoluções de compra proporcionais). NÃO inclui ajustes, MTS
 * nem devoluções de venda — regra histórica preservada.
 */
function calcularSaldosAlvoRecalculo(comprasItens, vendasItens, devolucoes) {
  let saldoFiscal = 0;
  let saldoNaoFiscal = 0;

  (comprasItens || []).forEach((item) => {
    const qtds = resolverQuantidadesCompraItemPersistido(item);
    saldoFiscal += qtds.quantidade_fiscal;
    saldoNaoFiscal += qtds.quantidade_nao_fiscal;
  });

  (vendasItens || []).forEach((item) => {
    const qtds = resolverQuantidadesVendaItem(item);
    saldoFiscal -= qtds.quantidade_fiscal;
    saldoNaoFiscal -= qtds.quantidade_nao_fiscal;
  });

  (devolucoes || []).forEach((dev) => {
    const qtds = resolverQuantidadesCompraItemPersistido(dev);
    const totalComprado = qtds.quantidade;
    const qtdDevolver = Number(dev.quantidade || 0);
    if (totalComprado <= 0 || qtdDevolver <= 0) return;

    const proporcaoFiscal = qtds.quantidade_fiscal / totalComprado;
    const qtdFiscal = Number((proporcaoFiscal * qtdDevolver).toFixed(3));
    const qtdNaoFiscal = Number((qtdDevolver - qtdFiscal).toFixed(3));
    saldoFiscal -= qtdFiscal;
    saldoNaoFiscal -= qtdNaoFiscal;
  });

  saldoFiscal = Number(Math.max(0, saldoFiscal).toFixed(3));
  saldoNaoFiscal = Number(Math.max(0, saldoNaoFiscal).toFixed(3));

  return {
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: saldoNaoFiscal,
    estoque_atual: Number((saldoFiscal + saldoNaoFiscal).toFixed(3))
  };
}

async function aplicarSaldosAlvoViaPorta(produtoId, alvo, optsPorta) {
  const atual = await estoqueSaldosPublico.consultarSaldo(produtoId, optsPorta);
  const ajusteF = round3(alvo.saldo_fiscal - Number(atual.saldo_fiscal || 0));
  const ajusteNF = round3(alvo.saldo_nao_fiscal - Number(atual.saldo_nao_fiscal || 0));

  if (ajusteF > 0) {
    await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.FISCAL, ajusteF, optsPorta);
  } else if (ajusteF < 0) {
    await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.FISCAL, Math.abs(ajusteF), optsPorta);
  }

  if (ajusteNF > 0) {
    await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, ajusteNF, optsPorta);
  } else if (ajusteNF < 0) {
    await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.NAO_FISCAL, Math.abs(ajusteNF), optsPorta);
  }

  const depois = (ajusteF === 0 && ajusteNF === 0)
    ? atual
    : await estoqueSaldosPublico.consultarSaldo(produtoId, optsPorta);

  return {
    produto_id: Number(produtoId),
    saldo_fiscal: Number(depois.saldo_fiscal),
    saldo_nao_fiscal: Number(depois.saldo_nao_fiscal),
    estoque_atual: Number(
      depois.estoque_atual != null
        ? depois.estoque_atual
        : (depois.saldo_fiscal + depois.saldo_nao_fiscal)
    ),
    empresa_id: depois.empresa_id != null ? depois.empresa_id : null,
    legado: optsPorta.legado === true,
    motivo_compat: optsPorta.legado ? (optsPorta.motivoCompat || MOTIVO_COMPAT_RECALCULO) : null
  };
}

/**
 * Recalcula e grava saldos F×NF via porta pública.
 *
 * Assinaturas suportadas (compat):
 *   recalcularSaldosProduto(db, produtoId, callback)
 *   recalcularSaldosProduto(db, produtoId, opcoes, callback)
 */
function recalcularSaldosProduto(db, produtoId, opcoesOuCallback, maybeCallback) {
  let opcoes = {};
  let callback = opcoesOuCallback;
  if (typeof opcoesOuCallback === 'object' && opcoesOuCallback !== null) {
    opcoes = opcoesOuCallback;
    callback = maybeCallback;
  }
  if (typeof callback !== 'function') {
    throw new Error('recalcularSaldosProduto: callback obrigatório');
  }

  let optsPorta;
  try {
    optsPorta = montarOptsPortaRecalculo(db, opcoes);
  } catch (e) {
    return callback(e);
  }

  db.get('SELECT id FROM produtos WHERE id = ?', [produtoId], (errProduto, produto) => {
    if (errProduto) return callback(errProduto);
    if (!produto) return callback(new Error('Produto não encontrado'));

    db.all(`
      SELECT
        ci.quantidade,
        ci.quantidade_fiscal,
        ci.quantidade_nao_fiscal,
        ci.item_fiscal
      FROM compras_itens ci
      INNER JOIN compras c ON c.id = ci.compra_id
      WHERE ci.produto_id = ?
        AND COALESCE(c.status, 'concluida') = 'concluida'
    `, [produtoId], (errCompras, comprasItens) => {
      if (errCompras) return callback(errCompras);

      db.all(`
        SELECT
          vi.quantidade,
          vi.quantidade_fiscal,
          vi.quantidade_nao_fiscal,
          vi.item_fiscal
        FROM vendas_itens vi
        INNER JOIN vendas v ON v.id = vi.venda_id
        WHERE vi.produto_id = ?
          AND COALESCE(v.status, '') != 'cancelada'
      `, [produtoId], (errVendas, vendasItens) => {
        if (errVendas) return callback(errVendas);

        db.all(`
          SELECT
            cd.quantidade,
            ci.quantidade AS qtd_comprada,
            ci.quantidade_fiscal,
            ci.quantidade_nao_fiscal,
            ci.item_fiscal
          FROM compras_devolucoes cd
          INNER JOIN compras_itens ci ON ci.id = cd.compra_item_id
          WHERE cd.produto_id = ?
        `, [produtoId], (errDev, devolucoes) => {
          if (errDev) return callback(errDev);

          const alvo = calcularSaldosAlvoRecalculo(comprasItens, vendasItens, devolucoes);

          aplicarSaldosAlvoViaPorta(produtoId, alvo, optsPorta).then(
            (result) => callback(null, result),
            (err) => callback(err)
          );
        });
      });
    });
  });
}

function recalcularSaldosTodosProdutos(db, opcoesOuCallback, maybeCallback) {
  let opcoes = {};
  let callback = opcoesOuCallback;
  if (typeof opcoesOuCallback === 'object' && opcoesOuCallback !== null) {
    opcoes = opcoesOuCallback;
    callback = maybeCallback;
  }
  if (typeof callback !== 'function') {
    throw new Error('recalcularSaldosTodosProdutos: callback obrigatório');
  }

  db.all('SELECT id FROM produtos', [], (err, produtos) => {
    if (err) return callback(err);

    let index = 0;
    let atualizados = 0;
    const erros = [];

    function proximo() {
      if (index >= (produtos || []).length) {
        return callback(null, { atualizados, erros });
      }

      const id = produtos[index].id;
      index += 1;

      recalcularSaldosProduto(db, id, opcoes, (recErr) => {
        if (recErr) {
          erros.push({ produto_id: id, erro: recErr.message });
        } else {
          atualizados += 1;
        }
        proximo();
      });
    }

    proximo();
  });
}

module.exports = {
  resolverQuantidadesCompraItemPersistido,
  resolverQuantidadesVendaItem,
  calcularDevolucaoFiscalPrimeiro,
  calcularDevolucaoVendaFiscalPrimeiro,
  calcularDevolucaoCompraFiscalPrimeiro,
  resolverJaDevolvidoCompraFiscalPrimeiro,
  recalcularEstoqueConsolidado,
  recalcularSaldosProduto,
  recalcularSaldosTodosProdutos,
  calcularSaldosAlvoRecalculo,
  MOTIVO_COMPAT_RECALCULO
};
