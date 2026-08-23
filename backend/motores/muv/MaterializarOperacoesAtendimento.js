/**
 * Orquestrador 04.06 — materializa operações empresariais em vendas reais.
 * Não cobra novamente nem inicia TEF.
 * O núcleo HTTP de venda não é invocado (TX aninhada / novo recebimento).
 *
 * Reutiliza:
 * - debitarEstoqueItemVenda → porta pública de saldos (03.19)
 * - reservasPublico.liberarQuantidadeReservada (03.20) após a baixa
 *
 * @module motores/muv/MaterializarOperacoesAtendimento
 */
'use strict';

const { debitarEstoqueItemVenda } = require('../../services/vendas/debitoEstoqueVendaViaPorta');
const reservasPublico = require('../../services/fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../../services/fiscalNaoFiscal/constants');
const {
  STATUS_OPERACAO_EMPRESARIAL,
  STATUS_RESERVA_ATENDIMENTO,
  TIPO_FISCAL_ITEM_ATENDIMENTO,
  reaisParaCentavosMuv,
  centavosParaReaisMuv,
  arredondarCentavosMuv
} = require('./contratos');

function erroMat(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  if (extra.statusCode != null) err.statusCode = extra.statusCode;
  if (extra.detalhes != null) err.detalhes = extra.detalhes;
  return err;
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function debitarEstoqueAsync(db, dados) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemVenda(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function fingerprintMaterializacao(atendimentoId, operacoes) {
  return JSON.stringify({
    atendimentoId,
    operacoes: operacoes
      .map((o) => ({ operacaoId: o.operacaoId, empresaId: o.empresaId }))
      .sort((a, b) => a.operacaoId - b.operacaoId)
  });
}

async function carregarRateiosOperacao(db, operacaoId) {
  return dbAll(
    db,
    `SELECT r.*, p.forma_pagamento
       FROM atendimento_pagamento_rateios r
       JOIN atendimento_pagamentos p ON p.id = r.atendimento_pagamento_id
      WHERE r.atendimento_operacao_id = ?
      ORDER BY p.sequencia, r.id`,
    [operacaoId]
  );
}

function validarRateioOperacao(operacao, rateios) {
  const soma = rateios.reduce((acc, r) => acc + Number(r.valor_centavos || 0), 0);
  const alvo = reaisParaCentavosMuv(operacao.subtotal);
  if (soma !== alvo) {
    throw erroMat(
      'RATEIO_OPERACAO_INCONSISTENTE',
      `Rateio da operação ${operacao.operacaoId} diverge do subtotal oficial.`,
      {
        statusCode: 409,
        detalhes: {
          operacaoId: operacao.operacaoId,
          empresaId: operacao.empresaId,
          rateioCentavos: soma,
          subtotalCentavos: alvo
        }
      }
    );
  }
}

async function garantirColunasFiscaisVenda(db) {
  const garantir = async (table, column, ddl) => {
    const cols = await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(${table})`, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    if (!cols.some((c) => c.name === column)) {
      await dbRun(db, `ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  await garantir('vendas_itens', 'quantidade_fiscal', 'quantidade_fiscal REAL DEFAULT 0');
  await garantir('vendas_itens', 'quantidade_nao_fiscal', 'quantidade_nao_fiscal REAL DEFAULT 0');
  await garantir('vendas_itens', 'valor_fiscal', 'valor_fiscal REAL DEFAULT 0');
  await garantir('vendas_itens', 'valor_nao_fiscal', 'valor_nao_fiscal REAL DEFAULT 0');
  await garantir('vendas_itens', 'item_fiscal', 'item_fiscal INTEGER DEFAULT 0');
  await garantir('vendas', 'valor_fiscal', 'valor_fiscal REAL DEFAULT 0');
  await garantir('vendas', 'valor_nao_fiscal', 'valor_nao_fiscal REAL DEFAULT 0');
}

function fatiasFiscaisItem(item, reservas) {
  const reserva = (reservas || []).find((r) => (
    (r.itemId && r.itemId === item.itemId) || r.produtoId === item.produtoId
  ));
  if (reserva) {
    const qF = Number(reserva.quantidadeFiscal || 0);
    const qNf = Number(reserva.quantidadeNaoFiscal || 0);
    const unit = Number(item.valorUnitario || 0);
    return {
      quantidade_fiscal: qF,
      quantidade_nao_fiscal: qNf,
      valor_fiscal: arredondarCentavosMuv(qF * unit),
      valor_nao_fiscal: arredondarCentavosMuv(qNf * unit),
      item_fiscal: qF > 0 ? 1 : 0
    };
  }
  if (item.tipoFiscal === TIPO_FISCAL_ITEM_ATENDIMENTO.NAO_FISCAL) {
    return {
      quantidade_fiscal: 0,
      quantidade_nao_fiscal: Number(item.quantidade || 0),
      valor_fiscal: 0,
      valor_nao_fiscal: arredondarCentavosMuv(item.valorTotal),
      item_fiscal: 0
    };
  }
  return {
    quantidade_fiscal: Number(item.quantidade || 0),
    quantidade_nao_fiscal: 0,
    valor_fiscal: arredondarCentavosMuv(item.valorTotal),
    valor_nao_fiscal: 0,
    item_fiscal: 1
  };
}

function pagamentosEmpresariais(rateios) {
  const porForma = new Map();
  for (const r of rateios) {
    const valor = Number(r.valor_centavos || 0);
    if (valor <= 0) continue;
    const forma = r.forma_pagamento;
    porForma.set(forma, (porForma.get(forma) || 0) + valor);
  }
  return [...porForma.entries()].map(([forma_pagamento, valorCentavos]) => ({
    forma_pagamento,
    valor: centavosParaReaisMuv(valorCentavos),
    valorCentavos
  }));
}

async function persistirVendaOperacao(db, atendimento, operacao, pagamentos) {
  const empresaId = Number(operacao.empresaId);
  await garantirColunasFiscaisVenda(db);
  const forma = pagamentos.length === 1 ? pagamentos[0].forma_pagamento : 'misto';
  const codigo = `MUV-${atendimento.atendimentoId}-${operacao.operacaoId}`;
  const itensFiscais = operacao.itens.map((item) => fatiasFiscaisItem(item, operacao.reservas));
  const valorFiscal = arredondarCentavosMuv(
    itensFiscais.reduce((acc, f) => acc + Number(f.valor_fiscal || 0), 0)
  );
  const valorNaoFiscal = arredondarCentavosMuv(
    itensFiscais.reduce((acc, f) => acc + Number(f.valor_nao_fiscal || 0), 0)
  );
  const ins = await dbRun(
    db,
    `INSERT INTO vendas (
       codigo, data_venda, total, desconto, forma_pagamento, status, status_pagamento, origem,
       valor_fiscal, valor_nao_fiscal
     ) VALUES (?, CURRENT_TIMESTAMP, ?, 0, ?, 'concluida', 'quitada', 'ATENDIMENTO', ?, ?)`,
    [codigo, operacao.subtotal, forma, valorFiscal, valorNaoFiscal]
  );
  const vendaId = ins.lastID;

  const itensPersistidos = [];
  for (let i = 0; i < operacao.itens.length; i += 1) {
    const item = operacao.itens[i];
    if (Number(item.empresaId) !== empresaId) {
      throw erroMat(
        'ATENDIMENTO_INVALIDO',
        'empresa_id do item diverge da operação empresarial.',
        { statusCode: 500 }
      );
    }
    const fatia = itensFiscais[i];
    const itemIns = await dbRun(
      db,
      `INSERT INTO vendas_itens (
         venda_id, produto_id, quantidade, preco_unitario, subtotal,
         quantidade_fiscal, quantidade_nao_fiscal, valor_fiscal, valor_nao_fiscal, item_fiscal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vendaId, item.produtoId, item.quantidade, item.valorUnitario, item.valorTotal,
        fatia.quantidade_fiscal, fatia.quantidade_nao_fiscal,
        fatia.valor_fiscal, fatia.valor_nao_fiscal, fatia.item_fiscal
      ]
    );
    itensPersistidos.push({ ...item, ...fatia, vendaItemId: itemIns.lastID });
  }

  for (const pag of pagamentos) {
    await dbRun(
      db,
      `INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor) VALUES (?, ?, ?)`,
      [vendaId, pag.forma_pagamento, pag.valor]
    );
  }

  const temFinanceiro = await new Promise((resolve) => {
    db.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'financeiro'`,
      (err, row) => resolve(!err && !!row)
    );
  });
  if (temFinanceiro) {
    await dbRun(
      db,
      `INSERT INTO financeiro (venda_id, tipo, origem, valor, status)
       VALUES (?, 'receita', 'venda', ?, 'recebido')`,
      [vendaId, operacao.subtotal]
    );
  }

  return { vendaId, codigo, empresaId, itens: itensPersistidos, pagamentos };
}

async function consumirReservasOperacao(db, operacao, venda, deps) {
  const empresaId = Number(operacao.empresaId);
  const reservas = (operacao.reservas || []).filter((r) => r.status === STATUS_RESERVA_ATENDIMENTO.ATIVA);
  const baixar = typeof deps.debitarEstoqueItemVenda === 'function'
    ? (dados) => deps.debitarEstoqueItemVenda(db, dados)
    : (dados) => debitarEstoqueAsync(db, dados);
  const liberar = typeof deps.liberarQuantidadeReservada === 'function'
    ? deps.liberarQuantidadeReservada
    : (produtoId, tipo, qtd, opts) =>
      reservasPublico.liberarQuantidadeReservada(produtoId, tipo, qtd, opts);

  for (const reserva of reservas) {
    if (Number(reserva.empresaId) !== empresaId) {
      throw erroMat(
        'ATENDIMENTO_INVALIDO',
        'Reserva com empresa divergente da operação.',
        { statusCode: 500 }
      );
    }
    const qF = Number(reserva.quantidadeFiscal || 0);
    const qNf = Number(reserva.quantidadeNaoFiscal || 0);
    const item = venda.itens.find((it) => it.produtoId === reserva.produtoId);

    if (qF > 0 || qNf > 0) {
      await baixar({
        produtoId: reserva.produtoId,
        quantidadeFiscal: qF,
        quantidadeNaoFiscal: qNf,
        empresaId,
        exigirEmpresa: true,
        origem: 'materializacao_atendimento',
        vendaItemId: item && item.vendaItemId
      });
    }
    if (qF > 0) {
      await liberar(reserva.produtoId, TipoSaldo.FISCAL, qF, { db, empresaId });
    }
    if (qNf > 0) {
      await liberar(reserva.produtoId, TipoSaldo.NAO_FISCAL, qNf, { db, empresaId });
    }
    await dbRun(
      db,
      `UPDATE atendimento_operacao_reservas
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [STATUS_RESERVA_ATENDIMENTO.CONSUMIDA, reserva.reservaId]
    );
  }
}

async function materializarOperacao(db, atendimento, operacao, deps) {
  const empresaId = Number(operacao.empresaId);
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw erroMat('EMPRESA_OBRIGATORIA', 'Operação sem empresa_id persistida.', { statusCode: 500 });
  }
  if (operacao.vendaId) {
    throw erroMat(
      'OPERACAO_JA_MATERIALIZADA',
      `Operação ${operacao.operacaoId} já possui venda.`,
      { statusCode: 409 }
    );
  }

  const rateios = await carregarRateiosOperacao(db, operacao.operacaoId);
  validarRateioOperacao(operacao, rateios);
  const pagamentos = pagamentosEmpresariais(rateios);
  const venda = await persistirVendaOperacao(db, atendimento, operacao, pagamentos);
  await consumirReservasOperacao(db, operacao, venda, deps);

  await dbRun(
    db,
    `UPDATE atendimento_operacoes
        SET venda_id = ?, status = ?, materializado_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [venda.vendaId, STATUS_OPERACAO_EMPRESARIAL.CONCLUIDA, operacao.operacaoId]
  );

  return {
    operacaoId: operacao.operacaoId,
    empresaId,
    vendaId: venda.vendaId,
    codigo: venda.codigo,
    total: arredondarCentavosMuv(operacao.subtotal),
    pagamentos,
    status: STATUS_OPERACAO_EMPRESARIAL.CONCLUIDA
  };
}

module.exports = {
  fingerprintMaterializacao,
  materializarOperacao,
  validarRateioOperacao,
  pagamentosEmpresariais,
  fatiasFiscaisItem
};
