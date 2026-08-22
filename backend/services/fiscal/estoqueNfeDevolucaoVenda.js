/**
 * RC5 — Retorno/reversão de estoque na autorização/cancelamento da NF-e de Devolução de Venda.
 *
 * Fase 2 / Implementação 03.5:
 *   cancelar NF-e de devolução de venda → debitarSaldo → produtos
 * O retorno (autorização) já credita via 02.5 (`devolverSaldosDistribuidos`).
 * Este arquivo só migra o revert: desfaz o crédito com a mesma distribuição F/NF.
 * Storage ainda em `produtos` (sem estoque_empresa).
 */

'use strict';

const { resolverQuantidadesVendaItem } = require('../estoqueFiscalService');
const estoqueSaldosPublico = require('../fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');

/** Compat explícita: cancelamento NF-e devolução venda ainda sem empresa no JWT. */
const MOTIVO_COMPAT_REVERT_DEVOLUCAO_VENDA = 'COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA';

function getDb() {
  return require('../../database');
}

function montarOptsPortaRevertDevolucaoVenda(db, opcoes = {}) {
  const empresaId = resolverEmpresaId(opcoes.empresaId);

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
    motivoCompat: opcoes.motivoCompat || MOTIVO_COMPAT_REVERT_DEVOLUCAO_VENDA,
    legado: true
  };
}

/**
 * Mesma distribuição F/NF já usada em `retornarEstoqueNfeDevolucaoVenda`.
 * Não recalcula regra fiscal — só aplica o fator da quantidade da NF-e
 * sobre as quantidades persistidas no item da venda.
 */
function resolverQuantidadesItemDevolucaoNfe(item) {
  const produtoId = item.produto_id || item.vi_produto_id;
  const qtd = Number(item.quantidade || 0);
  const baseItem = {
    id: item.venda_item_id,
    produto_id: produtoId,
    quantidade: item.quantidade_vendida || item.vi_quantidade || item.quantidade,
    quantidade_fiscal: item.quantidade_fiscal,
    quantidade_nao_fiscal: item.quantidade_nao_fiscal
  };
  const qtdsOrig = resolverQuantidadesVendaItem(baseItem);
  const totalOrig = Number(qtdsOrig.quantidade_fiscal || 0) + Number(qtdsOrig.quantidade_nao_fiscal || 0)
    || Number(baseItem.quantidade || 0) || 1;
  const fator = Math.min(1, qtd / totalOrig);
  const qtdFiscal = Math.round(Number(qtdsOrig.quantidade_fiscal || 0) * fator * 1000) / 1000;
  const qtdNaoFiscal = Math.round(Math.max(0, qtd - qtdFiscal) * 1000) / 1000;
  return { produtoId, qtd, qtdFiscal, qtdNaoFiscal };
}

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

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

/**
 * Ao autorizar: devolve quantidade ao estoque físico/fiscal.
 */
async function retornarEstoqueNfeDevolucaoVenda(nfeDevolucaoId, opcoes = {}) {
  const db = opcoes.db || getDb();
  const empresaId = resolverEmpresaId(opcoes.empresaId);
  const optsCredito = {
    db,
    empresaId,
    usuarioId: opcoes.usuarioId,
    origem: opcoes.origem || 'nfe_devolucao_venda'
  };
  const nota = await dbGet(db, `SELECT * FROM nfe_devolucoes_venda WHERE id = ?`, [Number(nfeDevolucaoId)]);
  if (!nota || Number(nota.estoque_retornado) === 1) return { ok: true, reused: true };

  const itens = await dbAll(db, `
    SELECT i.*, vi.quantidade, vi.quantidade_fiscal, vi.quantidade_nao_fiscal, vi.produto_id AS vi_produto_id
    FROM nfe_devolucao_venda_itens i
    LEFT JOIN vendas_itens vi ON vi.id = i.venda_item_id
    WHERE i.nfe_devolucao_id = ?
  `, [Number(nfeDevolucaoId)]);

  for (const item of itens) {
    if (Number(item.estoque_retornado) === 1) continue;
    const { produtoId, qtd, qtdFiscal, qtdNaoFiscal } = resolverQuantidadesItemDevolucaoNfe(item);
    if (!produtoId || !(qtd > 0)) continue;

    const { devolverSaldosDistribuidos } = require('../vendas/VendaDevolucaoService');
    const lotesService = require('../lotesService');

    await new Promise((resolve, reject) => {
      lotesService.produtoControlaValidade(produtoId, (err, controla) => {
        if (err) return reject(err);
        const aplicar = () => {
          devolverSaldosDistribuidos(produtoId, qtdFiscal, qtdNaoFiscal, (saldoErr) => {
            if (saldoErr) return reject(saldoErr);
            resolve();
          }, optsCredito);
        };
        if (controla) {
          // restauração parcial de lotes quando possível
          const { devolverLotesParcialItem } = require('../vendas/VendaDevolucaoService');
          if (typeof devolverLotesParcialItem === 'function') {
            devolverLotesParcialItem(item.venda_item_id, qtd, (loteErr) => {
              if (loteErr) return reject(loteErr);
              aplicar();
            });
            return;
          }
        }
        aplicar();
      });
    });

    await dbRun(
      db,
      `UPDATE nfe_devolucao_venda_itens SET estoque_retornado = 1 WHERE id = ?`,
      [item.id]
    );
  }

  await dbRun(
    db,
    `UPDATE nfe_devolucoes_venda SET estoque_retornado = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [Number(nfeDevolucaoId)]
  );
  return { ok: true, itens: itens.length };
}

/**
 * Ao cancelar NF-e autorizada: remove do estoque o que havia sido devolvido.
 * Débito F/NF pela porta pública (desfaz o crédito da autorização).
 * Não abre transação própria — usa o mesmo `db` do caller.
 */
async function reverterEstoqueNfeDevolucaoVenda(nfeDevolucaoId, opcoes = {}) {
  const db = opcoes.db || getDb();
  const optsPorta = montarOptsPortaRevertDevolucaoVenda(db, opcoes);

  const itens = await dbAll(db, `
    SELECT i.*, vi.quantidade AS vi_quantidade, vi.quantidade_fiscal, vi.quantidade_nao_fiscal,
           vi.produto_id AS vi_produto_id
    FROM nfe_devolucao_venda_itens i
    LEFT JOIN vendas_itens vi ON vi.id = i.venda_item_id
    WHERE i.nfe_devolucao_id = ? AND COALESCE(i.estoque_retornado, 0) = 1
  `, [Number(nfeDevolucaoId)]);

  const aplicados = [];
  for (const item of itens) {
    const { produtoId, qtd, qtdFiscal, qtdNaoFiscal } = resolverQuantidadesItemDevolucaoNfe(item);
    if (!produtoId || !(qtd > 0)) continue;

    if (qtdFiscal > 0) {
      await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.FISCAL, qtdFiscal, optsPorta);
    }
    if (qtdNaoFiscal > 0) {
      await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.NAO_FISCAL, qtdNaoFiscal, optsPorta);
    }

    const depois = await estoqueSaldosPublico.consultarSaldo(produtoId, optsPorta);
    aplicados.push({
      produto_id: produtoId,
      quantidade_fiscal: qtdFiscal,
      quantidade_nao_fiscal: qtdNaoFiscal,
      saldo_fiscal: Number(depois.saldo_fiscal),
      saldo_nao_fiscal: Number(depois.saldo_nao_fiscal),
      estoque_atual: Number(
        depois.estoque_atual != null
          ? depois.estoque_atual
          : (depois.saldo_fiscal + depois.saldo_nao_fiscal)
      ),
      empresa_id: depois.empresa_id != null ? depois.empresa_id : null
    });

    await dbRun(
      db,
      `UPDATE nfe_devolucao_venda_itens SET estoque_retornado = 0 WHERE id = ?`,
      [item.id]
    );
  }

  await dbRun(
    db,
    `UPDATE nfe_devolucoes_venda SET estoque_retornado = 0 WHERE id = ?`,
    [Number(nfeDevolucaoId)]
  );

  return {
    ok: true,
    itens: aplicados.length,
    empresa_id: optsPorta.empresaId != null ? optsPorta.empresaId : null,
    legado: optsPorta.legado === true,
    motivo_compat: optsPorta.legado
      ? (optsPorta.motivoCompat || MOTIVO_COMPAT_REVERT_DEVOLUCAO_VENDA)
      : null,
    saldos: aplicados
  };
}

module.exports = {
  MOTIVO_COMPAT_REVERT_DEVOLUCAO_VENDA,
  montarOptsPortaRevertDevolucaoVenda,
  resolverQuantidadesItemDevolucaoNfe,
  retornarEstoqueNfeDevolucaoVenda,
  reverterEstoqueNfeDevolucaoVenda
};
