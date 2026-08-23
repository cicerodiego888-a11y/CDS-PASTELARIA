/**
 * Núcleo persistente do atendimento MULTIEMPRESA (Sprint 04.03 + 04.04).
 * 04.03: agrupa, valida estoque e persiste VALIDADO.
 * 04.04: reserva atômica por operação via reservasPublico (dual-write).
 * Não cria vendas, não paga, não consome reserva.
 *
 * @module motores/muv/AtendimentoMultiempresaService
 */
'use strict';

const reservasPublico = require('../../services/fiscalNaoFiscal/reservasPublico');
const EmpresaService = require('../../services/empresas/EmpresaService');
const { TipoSaldo } = require('../../services/fiscalNaoFiscal/constants');
const { validarSomaPagamentosVenda } = require('../../services/vendas/VendaFinanceiroService');
const { garantirSchemaAtendimentoAsync } = require('./atendimentoSchema');
const {
  fingerprintMaterializacao,
  materializarOperacao
} = require('./MaterializarOperacoesAtendimento');
const {
  ModoOperacaoVenda,
  STATUS_ATENDIMENTO,
  STATUS_OPERACAO_EMPRESARIAL,
  STATUS_RESERVA_ATENDIMENTO,
  STATUS_PAGAMENTO_ATENDIMENTO,
  EstrategiaDistribuicaoPagamento,
  AtomicidadeMuv,
  arredondarCentavosMuv,
  arredondarQuantidadeMuv,
  reaisParaCentavosMuv,
  centavosParaReaisMuv,
  validarItensEntradaAtendimento,
  agruparItensPorEmpresa,
  validarDistribuicaoPagamento,
  calcularTotalOficialItens,
  normalizarFormaPagamentoAtendimento,
  normalizarEstrategiaRateio,
  ratearProporcionalCentavos,
  ratearPagamentosPorItem,
  fingerprintPagamentoAtendimento,
  TIPO_FISCAL_ITEM_ATENDIMENTO
} = require('./contratos');

function erroAtendimento(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  if (extra.statusCode != null) err.statusCode = extra.statusCode;
  if (extra.detalhes != null) err.detalhes = extra.detalhes;
  return err;
}

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../database');
}

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

function gerarCodigoProvisorio() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `ATD-${t}-${r}`;
}

function codigoOperacional(id) {
  return `ATD-${String(id).padStart(8, '0')}`;
}

async function exigirEmpresaCadastrada(db, empresaId) {
  try {
    await EmpresaService.buscarEmpresaPorId(empresaId, { db });
  } catch (e) {
    throw erroAtendimento(
      'EMPRESA_INVALIDA',
      `Empresa inválida: ${empresaId}.`,
      { statusCode: 400, detalhes: { empresaId } }
    );
  }
}

function escolherDisponivel(disp, tipoFiscal) {
  if (tipoFiscal === TIPO_FISCAL_ITEM_ATENDIMENTO.FISCAL) {
    return Number(disp.disponivel_fiscal || 0);
  }
  if (tipoFiscal === TIPO_FISCAL_ITEM_ATENDIMENTO.NAO_FISCAL) {
    return Number(disp.disponivel_nao_fiscal || 0);
  }
  return Number(disp.disponivel_total || 0);
}

async function validarEstoqueOperacoes(operacoes, deps) {
  const consultar = typeof deps.consultarDisponibilidade === 'function'
    ? deps.consultarDisponibilidade
    : (produtoId, opts) => reservasPublico.consultarDisponibilidade(produtoId, opts);

  const insuficientes = [];
  for (const op of operacoes) {
    for (const item of op.itens) {
      const disp = await consultar(item.produtoId, {
        db: deps.db,
        empresaId: item.empresaId
      });
      const disponivel = escolherDisponivel(disp, item.tipoFiscal);
      if (disponivel + 1e-9 < item.quantidade) {
        insuficientes.push({
          produtoId: item.produtoId,
          empresaId: item.empresaId,
          solicitado: item.quantidade,
          disponivel
        });
      }
    }
  }

  if (insuficientes.length) {
    const primeiro = insuficientes[0];
    throw erroAtendimento(
      'SALDO_INSUFICIENTE',
      `Saldo insuficiente do produto ${primeiro.produtoId} na empresa ${primeiro.empresaId}.`,
      { statusCode: 409, detalhes: insuficientes }
    );
  }
}

async function persistirAtendimento(db, origem, operacoes, valorTotal, deps) {
  const codigoTemp = gerarCodigoProvisorio();
  const atendimentoIns = await dbRun(
    db,
    `INSERT INTO atendimentos (
       codigo, modo_operacao, origem, status,
       valor_total, quantidade_operacoes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      codigoTemp,
      ModoOperacaoVenda.MULTIEMPRESA,
      origem,
      STATUS_ATENDIMENTO.ABERTO,
      0,
      0
    ]
  );
  const atendimentoId = atendimentoIns.lastID;
  const codigo = codigoOperacional(atendimentoId);
  await dbRun(
    db,
    `UPDATE atendimentos SET codigo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [codigo, atendimentoId]
  );

  const operacoesPersistidas = [];
  for (const op of operacoes) {
    const opIns = await dbRun(
      db,
      `INSERT INTO atendimento_operacoes (
         atendimento_id, empresa_id, status, subtotal, quantidade_itens,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        atendimentoId,
        op.empresaId,
        STATUS_OPERACAO_EMPRESARIAL.ABERTA,
        op.subtotal,
        op.quantidadeItens
      ]
    );
    const operacaoId = opIns.lastID;
    const itensPersistidos = [];
    for (const item of op.itens) {
      if (item.empresaId !== op.empresaId) {
        throw erroAtendimento(
          'ATENDIMENTO_INVALIDO',
          'empresa_id do item diverge da operação empresarial.',
          { statusCode: 500, detalhes: { operacaoId, empresaId: op.empresaId, item } }
        );
      }
      const itemIns = await dbRun(
        db,
        `INSERT INTO atendimento_operacao_itens (
           operacao_id, produto_id, empresa_id, quantidade,
           valor_unitario, valor_total, tipo_fiscal,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          operacaoId,
          item.produtoId,
          item.empresaId,
          item.quantidade,
          item.valorUnitario,
          item.valorTotal,
          item.tipoFiscal
        ]
      );
      itensPersistidos.push({
        itemId: itemIns.lastID,
        produtoId: item.produtoId,
        empresaId: item.empresaId,
        quantidade: item.quantidade,
        valorUnitario: item.valorUnitario,
        valorTotal: item.valorTotal,
        tipoFiscal: item.tipoFiscal
      });
    }
    operacoesPersistidas.push({
      operacaoId,
      empresaId: op.empresaId,
      subtotal: op.subtotal,
      quantidadeItens: op.quantidadeItens,
      status: STATUS_OPERACAO_EMPRESARIAL.VALIDADA,
      itens: itensPersistidos
    });
  }

  const somaOps = arredondarCentavosMuv(
    operacoesPersistidas.reduce((acc, op) => acc + op.subtotal, 0)
  );
  if (Math.abs(somaOps - valorTotal) > 0.009) {
    throw erroAtendimento(
      'ATENDIMENTO_INVALIDO',
      'Total do atendimento diverge da soma das operações.',
      { statusCode: 500, detalhes: { valorTotal, somaOps } }
    );
  }

  await dbRun(
    db,
    `UPDATE atendimento_operacoes
        SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE atendimento_id = ?`,
    [STATUS_OPERACAO_EMPRESARIAL.VALIDADA, atendimentoId]
  );
  await dbRun(
    db,
    `UPDATE atendimentos
        SET status = ?, valor_total = ?, quantidade_operacoes = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [
      STATUS_ATENDIMENTO.VALIDADO,
      valorTotal,
      operacoesPersistidas.length,
      atendimentoId
    ]
  );

  if (typeof deps.aposPersistirParcial === 'function') {
    await deps.aposPersistirParcial({ atendimentoId, operacoes: operacoesPersistidas });
  }

  return {
    atendimentoId,
    codigo,
    modo_operacao: ModoOperacaoVenda.MULTIEMPRESA,
    status: STATUS_ATENDIMENTO.VALIDADO,
    total: valorTotal,
    operacoes: operacoesPersistidas
  };
}

/**
 * @param {{ origem?: string, itens: Array }} entrada
 * @param {{ db?: object, consultarDisponibilidade?: Function, aposPersistirParcial?: Function }} [deps]
 */
async function criarAtendimento(entrada = {}, deps = {}) {
  const db = getDb(deps.db);
  const origem = String(entrada.origem || 'PDV').trim() || 'PDV';
  const itens = validarItensEntradaAtendimento(entrada.itens);
  const operacoes = agruparItensPorEmpresa(itens);
  if (operacoes.length === 0) {
    throw erroAtendimento(
      'ITENS_ATENDIMENTO_OBRIGATORIOS',
      'Informe ao menos um item para o atendimento multiempresa.',
      { statusCode: 400 }
    );
  }

  await garantirSchemaAtendimentoAsync(db);

  for (const op of operacoes) {
    await exigirEmpresaCadastrada(db, op.empresaId);
  }

  await validarEstoqueOperacoes(operacoes, { ...deps, db });

  const valorTotal = arredondarCentavosMuv(
    operacoes.reduce((acc, op) => acc + op.subtotal, 0)
  );

  let txAberta = false;
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    txAberta = true;
    const preview = await persistirAtendimento(db, origem, operacoes, valorTotal, deps);
    await dbRun(db, 'COMMIT');
    txAberta = false;
    return Object.freeze({
      ...preview,
      atomicidade: AtomicidadeMuv.ROLLBACK_TOTAL,
      venda_concluida: false,
      pagamento_pendente: true
    });
  } catch (e) {
    if (txAberta) {
      try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}

function mapearReservaRow(row) {
  return {
    reservaId: row.id,
    atendimentoId: row.atendimento_id,
    operacaoId: row.atendimento_operacao_id,
    empresaId: row.empresa_id,
    produtoId: row.produto_id,
    itemId: row.item_id,
    quantidadeFiscal: Number(row.quantidade_fiscal || 0),
    quantidadeNaoFiscal: Number(row.quantidade_nao_fiscal || 0),
    status: row.status
  };
}

async function carregarReservasAtendimento(db, atendimentoId, apenasAtivas = false) {
  const sql = apenasAtivas
    ? `SELECT * FROM atendimento_operacao_reservas
        WHERE atendimento_id = ? AND status = ?
        ORDER BY id`
    : `SELECT * FROM atendimento_operacao_reservas
        WHERE atendimento_id = ? ORDER BY id`;
  const params = apenasAtivas
    ? [atendimentoId, STATUS_RESERVA_ATENDIMENTO.ATIVA]
    : [atendimentoId];
  const rows = await dbAll(db, sql, params);
  return rows.map(mapearReservaRow);
}

function anexarReservasNasOperacoes(operacoes, reservas) {
  return operacoes.map((op) => ({
    ...op,
    reservas: reservas.filter((r) => r.operacaoId === op.operacaoId && r.empresaId === op.empresaId)
  }));
}

function resolverConsultarDisponibilidade(deps) {
  return typeof deps.consultarDisponibilidade === 'function'
    ? deps.consultarDisponibilidade
    : (produtoId, opts) => reservasPublico.consultarDisponibilidade(produtoId, opts);
}

function resolverReservarQuantidade(deps) {
  return typeof deps.reservarQuantidade === 'function'
    ? deps.reservarQuantidade
    : (produtoId, tipo, quantidade, opts) =>
      reservasPublico.reservarQuantidade(produtoId, tipo, quantidade, opts);
}

function resolverLiberarQuantidade(deps) {
  return typeof deps.liberarQuantidadeReservada === 'function'
    ? deps.liberarQuantidadeReservada
    : (produtoId, tipo, quantidade, opts) =>
      reservasPublico.liberarQuantidadeReservada(produtoId, tipo, quantidade, opts);
}

function calcularQuantidadesReserva(item, disp) {
  const q = arredondarQuantidadeMuv(item.quantidade);
  if (item.tipoFiscal === TIPO_FISCAL_ITEM_ATENDIMENTO.FISCAL) {
    return {
      quantidadeFiscal: q,
      quantidadeNaoFiscal: 0,
      disponivel: Number(disp.disponivel_fiscal || 0)
    };
  }
  if (item.tipoFiscal === TIPO_FISCAL_ITEM_ATENDIMENTO.NAO_FISCAL) {
    return {
      quantidadeFiscal: 0,
      quantidadeNaoFiscal: q,
      disponivel: Number(disp.disponivel_nao_fiscal || 0)
    };
  }
  const df = Math.max(0, Number(disp.disponivel_fiscal || 0));
  const quantidadeFiscal = arredondarQuantidadeMuv(Math.min(q, df));
  const quantidadeNaoFiscal = arredondarQuantidadeMuv(q - quantidadeFiscal);
  return {
    quantidadeFiscal,
    quantidadeNaoFiscal,
    disponivel: Number(disp.disponivel_total || 0)
  };
}

async function aplicarReservaItem(db, item, empresaId, deps) {
  const consultar = resolverConsultarDisponibilidade(deps);
  const reservar = resolverReservarQuantidade(deps);
  const disp = await consultar(item.produtoId, { db, empresaId });
  const split = calcularQuantidadesReserva(item, disp);
  if (split.disponivel + 1e-9 < item.quantidade) {
    throw erroAtendimento(
      'SALDO_INSUFICIENTE',
      `Saldo insuficiente do produto ${item.produtoId} na empresa ${empresaId}.`,
      {
        statusCode: 409,
        detalhes: [{
          produtoId: item.produtoId,
          empresaId,
          solicitado: item.quantidade,
          disponivel: split.disponivel
        }]
      }
    );
  }
  const optsPorta = { db, empresaId };
  if (split.quantidadeFiscal > 0) {
    await reservar(item.produtoId, TipoSaldo.FISCAL, split.quantidadeFiscal, optsPorta);
  }
  if (split.quantidadeNaoFiscal > 0) {
    await reservar(item.produtoId, TipoSaldo.NAO_FISCAL, split.quantidadeNaoFiscal, optsPorta);
  }
  return split;
}

async function persistirLinhaReserva(db, {
  atendimentoId, operacaoId, empresaId, item
}, split) {
  const ins = await dbRun(
    db,
    `INSERT INTO atendimento_operacao_reservas (
       atendimento_id, atendimento_operacao_id, empresa_id, produto_id, item_id,
       quantidade_fiscal, quantidade_nao_fiscal, status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      atendimentoId,
      operacaoId,
      empresaId,
      item.produtoId,
      item.itemId,
      split.quantidadeFiscal,
      split.quantidadeNaoFiscal,
      STATUS_RESERVA_ATENDIMENTO.ATIVA
    ]
  );
  return {
    reservaId: ins.lastID,
    atendimentoId,
    operacaoId,
    empresaId,
    produtoId: item.produtoId,
    itemId: item.itemId,
    quantidadeFiscal: split.quantidadeFiscal,
    quantidadeNaoFiscal: split.quantidadeNaoFiscal,
    status: STATUS_RESERVA_ATENDIMENTO.ATIVA
  };
}

async function montarContratoAtendimento(db, atendimentoId, extras = {}) {
  const preview = await obterAtendimento(atendimentoId, { db });
  const reservas = extras.reservas != null
    ? extras.reservas
    : await carregarReservasAtendimento(db, atendimentoId);
  return Object.freeze({
    ...preview,
    atendimento_id: preview.atendimentoId,
    operacoes: anexarReservasNasOperacoes(preview.operacoes, reservas),
    atomicidade: AtomicidadeMuv.ROLLBACK_TOTAL,
    venda_concluida: false,
    pagamento_pendente: preview.status !== STATUS_ATENDIMENTO.PAGO
      && preview.status !== STATUS_ATENDIMENTO.CONCLUIDO,
    ...extras.flags
  });
}

/**
 * Reserva atômica do atendimento VALIDADO. empresa_id da operação é a autoridade.
 * Idempotente se já RESERVADO com reservas ATIVA.
 */
async function reservarAtendimento(atendimentoId, deps = {}) {
  const db = getDb(deps.db);
  const id = Number(atendimentoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroAtendimento('ATENDIMENTO_INVALIDO', 'atendimentoId inválido.', { statusCode: 400 });
  }

  await garantirSchemaAtendimentoAsync(db);

  let txAberta = false;
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    txAberta = true;

    const cab = await dbGet(db, `SELECT * FROM atendimentos WHERE id = ?`, [id]);
    if (!cab) {
      throw erroAtendimento('ATENDIMENTO_INVALIDO', `Atendimento não encontrado: ${id}.`, {
        statusCode: 404
      });
    }
    if (cab.modo_operacao !== ModoOperacaoVenda.MULTIEMPRESA) {
      throw erroAtendimento(
        'ATENDIMENTO_INVALIDO',
        'Reserva MUV aplica-se somente a atendimento MULTIEMPRESA.',
        { statusCode: 400 }
      );
    }
    if (cab.status === STATUS_ATENDIMENTO.CANCELADO) {
      throw erroAtendimento(
        'ATENDIMENTO_CANCELADO',
        'Atendimento cancelado não pode ser reservado.',
        { statusCode: 409 }
      );
    }

    const reservasAtivas = await carregarReservasAtendimento(db, id, true);
    if (cab.status === STATUS_ATENDIMENTO.RESERVADO || reservasAtivas.length > 0) {
      if (cab.status !== STATUS_ATENDIMENTO.RESERVADO && reservasAtivas.length > 0) {
        throw erroAtendimento(
          'RESERVA_JA_APLICADA',
          'Operação já possui reserva ativa; a reserva não é duplicada.',
          { statusCode: 409 }
        );
      }
      await dbRun(db, 'COMMIT');
      txAberta = false;
      return montarContratoAtendimento(db, id, {
        reservas: reservasAtivas,
        flags: { idempotente: true }
      });
    }

    if (cab.status !== STATUS_ATENDIMENTO.VALIDADO) {
      throw erroAtendimento(
        'ATENDIMENTO_STATUS_INVALIDO',
        `Atendimento em status ${cab.status} não pode ser reservado.`,
        { statusCode: 409 }
      );
    }

    const preview = await obterAtendimento(id, { db });
    const reservasCriadas = [];
    for (const op of preview.operacoes) {
      const empresaId = Number(op.empresaId);
      for (const item of op.itens) {
        if (Number(item.empresaId) !== empresaId) {
          throw erroAtendimento(
            'ATENDIMENTO_INVALIDO',
            'empresa_id do item diverge da operação empresarial.',
            { statusCode: 500, detalhes: { operacaoId: op.operacaoId, empresaId, item } }
          );
        }
        const split = await aplicarReservaItem(db, item, empresaId, { ...deps, db });
        const linha = await persistirLinhaReserva(db, {
          atendimentoId: id,
          operacaoId: op.operacaoId,
          empresaId,
          item
        }, split);
        reservasCriadas.push(linha);
      }
    }

    await dbRun(
      db,
      `UPDATE atendimento_operacoes
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE atendimento_id = ?`,
      [STATUS_OPERACAO_EMPRESARIAL.RESERVADA, id]
    );
    await dbRun(
      db,
      `UPDATE atendimentos
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [STATUS_ATENDIMENTO.RESERVADO, id]
    );

    if (typeof deps.aposReservarParcial === 'function') {
      await deps.aposReservarParcial({ atendimentoId: id, reservas: reservasCriadas });
    }

    await dbRun(db, 'COMMIT');
    txAberta = false;
    return montarContratoAtendimento(db, id, { reservas: reservasCriadas });
  } catch (e) {
    if (txAberta) {
      try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}

async function liberarReservasAtivas(db, reservas, deps) {
  const liberar = resolverLiberarQuantidade(deps);
  for (const reserva of reservas) {
    const optsPorta = { db, empresaId: reserva.empresaId };
    if (reserva.quantidadeFiscal > 0) {
      await liberar(reserva.produtoId, TipoSaldo.FISCAL, reserva.quantidadeFiscal, optsPorta);
    }
    if (reserva.quantidadeNaoFiscal > 0) {
      await liberar(reserva.produtoId, TipoSaldo.NAO_FISCAL, reserva.quantidadeNaoFiscal, optsPorta);
    }
    await dbRun(
      db,
      `UPDATE atendimento_operacao_reservas
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [STATUS_RESERVA_ATENDIMENTO.CANCELADA, reserva.reservaId]
    );
  }
}

/**
 * Cancela atendimento reservado e libera todas as reservas (atômico, idempotente).
 */
async function cancelarAtendimento(atendimentoId, deps = {}) {
  const db = getDb(deps.db);
  const id = Number(atendimentoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroAtendimento('ATENDIMENTO_INVALIDO', 'atendimentoId inválido.', { statusCode: 400 });
  }

  await garantirSchemaAtendimentoAsync(db);

  let txAberta = false;
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    txAberta = true;

    const cab = await dbGet(db, `SELECT * FROM atendimentos WHERE id = ?`, [id]);
    if (!cab) {
      throw erroAtendimento('ATENDIMENTO_INVALIDO', `Atendimento não encontrado: ${id}.`, {
        statusCode: 404
      });
    }

    const reservasAtivas = await carregarReservasAtendimento(db, id, true);

    if (cab.status === STATUS_ATENDIMENTO.CANCELADO && reservasAtivas.length === 0) {
      await dbRun(db, 'COMMIT');
      txAberta = false;
      return montarContratoAtendimento(db, id, {
        flags: { liberacao: 'RESERVA_JA_LIBERADA', idempotente: true }
      });
    }

    if (reservasAtivas.length) {
      await liberarReservasAtivas(db, reservasAtivas, { ...deps, db });
    }

    await dbRun(
      db,
      `UPDATE atendimento_operacoes
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE atendimento_id = ?`,
      [STATUS_OPERACAO_EMPRESARIAL.CANCELADA, id]
    );
    await dbRun(
      db,
      `UPDATE atendimentos
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [STATUS_ATENDIMENTO.CANCELADO, id]
    );

    if (typeof deps.aposCancelarParcial === 'function') {
      await deps.aposCancelarParcial({ atendimentoId: id });
    }

    await dbRun(db, 'COMMIT');
    txAberta = false;
    return montarContratoAtendimento(db, id, {
      flags: { liberacao: reservasAtivas.length ? 'LIBERADA' : 'SEM_RESERVA_ATIVA' }
    });
  } catch (e) {
    if (txAberta) {
      try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}

async function obterAtendimento(atendimentoId, deps = {}) {
  const db = getDb(deps.db);
  const id = Number(atendimentoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroAtendimento('ATENDIMENTO_INVALIDO', 'atendimentoId inválido.', { statusCode: 400 });
  }
  const cab = await dbGet(db, `SELECT * FROM atendimentos WHERE id = ?`, [id]);
  if (!cab) {
    throw erroAtendimento('ATENDIMENTO_INVALIDO', `Atendimento não encontrado: ${id}.`, {
      statusCode: 404
    });
  }
  const ops = await dbAll(
    db,
    `SELECT * FROM atendimento_operacoes WHERE atendimento_id = ? ORDER BY id`,
    [id]
  );
  const operacoes = [];
  for (const op of ops) {
    const itens = await dbAll(
      db,
      `SELECT * FROM atendimento_operacao_itens WHERE operacao_id = ? ORDER BY id`,
      [op.id]
    );
    operacoes.push({
      operacaoId: op.id,
      empresaId: op.empresa_id,
      vendaId: op.venda_id || null,
      subtotal: arredondarCentavosMuv(op.subtotal),
      quantidadeItens: Number(op.quantidade_itens),
      status: op.status,
      itens: itens.map((it) => ({
        itemId: it.id,
        produtoId: it.produto_id,
        empresaId: it.empresa_id,
        quantidade: Number(it.quantidade),
        valorUnitario: arredondarCentavosMuv(it.valor_unitario),
        valorTotal: arredondarCentavosMuv(it.valor_total),
        tipoFiscal: it.tipo_fiscal
      }))
    });
  }
  const reservas = await carregarReservasAtendimento(db, id);
  const financeiro = await carregarFinanceiroAtendimento(db, id);
  return {
    atendimentoId: cab.id,
    codigo: cab.codigo,
    modo_operacao: cab.modo_operacao,
    origem: cab.origem,
    status: cab.status,
    total: arredondarCentavosMuv(cab.valor_total),
    quantidade_operacoes: Number(cab.quantidade_operacoes),
    operacoes: anexarReservasNasOperacoes(operacoes, reservas),
    pagamentos: financeiro.pagamentos,
    rateios: financeiro.rateios
  };
}

function mapearPagamentoRow(row) {
  return {
    pagamentoId: row.id,
    atendimentoId: row.atendimento_id,
    sequencia: Number(row.sequencia),
    formaPagamento: row.forma_pagamento,
    valorCentavos: Number(row.valor_centavos),
    valor: arredondarCentavosMuv(row.valor),
    status: row.status,
    idempotencyKey: row.idempotency_key || null
  };
}

function mapearRateioRow(row) {
  return {
    rateioId: row.id,
    atendimentoId: row.atendimento_id,
    pagamentoId: row.atendimento_pagamento_id,
    operacaoId: row.atendimento_operacao_id,
    empresaId: row.empresa_id,
    valorCentavos: Number(row.valor_centavos),
    valor: arredondarCentavosMuv(row.valor),
    estrategia: row.estrategia_rateio
  };
}

async function carregarFinanceiroAtendimento(db, atendimentoId) {
  const pagamentos = (await dbAll(
    db,
    `SELECT * FROM atendimento_pagamentos WHERE atendimento_id = ? ORDER BY sequencia`,
    [atendimentoId]
  )).map(mapearPagamentoRow);
  const rateios = (await dbAll(
    db,
    `SELECT * FROM atendimento_pagamento_rateios WHERE atendimento_id = ? ORDER BY id`,
    [atendimentoId]
  )).map(mapearRateioRow);
  return { pagamentos, rateios };
}

function normalizarPagamentosEntrada(pagamentos) {
  if (!Array.isArray(pagamentos) || pagamentos.length === 0) {
    throw erroAtendimento(
      'PAGAMENTO_INVALIDO',
      'Informe ao menos um pagamento.',
      { statusCode: 400 }
    );
  }
  return pagamentos.map((p, i) => {
    const formaPagamento = normalizarFormaPagamentoAtendimento(
      p.formaPagamento || p.forma_pagamento
    );
    const valor = arredondarCentavosMuv(p.valor);
    if (!Number.isFinite(Number(p.valor)) || valor < 0) {
      throw erroAtendimento(
        'PAGAMENTO_INVALIDO',
        `Valor de pagamento inválido na posição ${i}.`,
        { statusCode: 400 }
      );
    }
    return { formaPagamento, valor, valorCentavos: reaisParaCentavosMuv(valor) };
  });
}

function ajustarPagamentosAoTotalOficial(pagamentos, totalCentavos) {
  const soma = pagamentos.reduce((acc, p) => acc + p.valorCentavos, 0);
  const delta = totalCentavos - soma;
  if (delta === 0) return pagamentos;
  if (Math.abs(delta) > 1) {
    throw erroAtendimento(
      'PAGAMENTO_INVALIDO',
      'Diferença de pagamento acima da tolerância oficial de 1 centavo.',
      { statusCode: 409 }
    );
  }
  const ultimo = pagamentos[pagamentos.length - 1];
  ultimo.valorCentavos += delta;
  ultimo.valor = centavosParaReaisMuv(ultimo.valorCentavos);
  return pagamentos;
}

function validarSomaComercial(pagamentos, totalOficial) {
  const erro = validarSomaPagamentosVenda(
    pagamentos.map((p) => ({ valor: p.valor })),
    totalOficial
  );
  if (!erro) return;
  const soma = pagamentos.reduce((acc, p) => acc + p.valor, 0);
  if (soma + 0.01 < totalOficial) {
    throw erroAtendimento('PAGAMENTO_INSUFICIENTE', erro, { statusCode: 409 });
  }
  throw erroAtendimento('PAGAMENTO_EXCEDENTE', erro, { statusCode: 409 });
}

function pesosDasOperacoes(operacoes) {
  return operacoes
    .map((op) => ({
      empresaId: Number(op.empresaId),
      operacaoId: op.operacaoId,
      pesoCentavos: reaisParaCentavosMuv(op.subtotal)
    }))
    .sort((a, b) => a.empresaId - b.empresaId);
}

function calcularRateiosPorEstrategia(estrategia, pagamentos, operacoes, entrada) {
  const pesos = pesosDasOperacoes(operacoes);
  const empresasValidas = new Set(pesos.map((p) => p.empresaId));

  if (estrategia === EstrategiaDistribuicaoPagamento.MANUAL) {
    return calcularRateiosManuais(entrada, pagamentos, pesos, empresasValidas);
  }
  if (estrategia === EstrategiaDistribuicaoPagamento.PROPORCIONAL) {
    return pagamentos.map((pag) => ratearProporcionalCentavos(pag.valorCentavos, pesos));
  }
  return ratearPagamentosPorItem(
    pagamentos.map((p) => ({ valorCentavos: p.valorCentavos })),
    pesos
  );
}

function calcularRateiosManuais(entrada, pagamentos, pesos, empresasValidas) {
  const manuais = entrada.rateios || entrada.rateiosManuais;
  if (!Array.isArray(manuais) || manuais.length === 0) {
    throw erroAtendimento(
      'ESTRATEGIA_RATEIO_NAO_IMPLEMENTADA',
      'RATEIO_MANUAL exige rateios explícitos por pagamento e empresa.',
      { statusCode: 400 }
    );
  }
  const porPagamento = pagamentos.map(() => []);
  for (const r of manuais) {
    const seq = Number(r.sequencia != null ? r.sequencia : r.pagamentoIndex);
    const empresaId = Number(r.empresaId);
    if (!empresasValidas.has(empresaId)) {
      throw erroAtendimento(
        'EMPRESA_INVALIDA',
        `Empresa ${empresaId} não pertence ao atendimento.`,
        { statusCode: 400, detalhes: { empresaId } }
      );
    }
    const valorCentavos = r.valorCentavos != null
      ? Math.round(Number(r.valorCentavos))
      : reaisParaCentavosMuv(r.valor);
    if (valorCentavos < 0) {
      throw erroAtendimento('RATEIO_NEGATIVO', 'Rateio não pode ser negativo.', {
        statusCode: 400
      });
    }
    const peso = pesos.find((p) => p.empresaId === empresaId);
    const idx = Number.isInteger(seq) && seq >= 0 ? seq : 0;
    if (!porPagamento[idx]) {
      throw erroAtendimento('DISTRIBUICAO_INVALIDA', 'Índice de pagamento inválido no rateio manual.', {
        statusCode: 400
      });
    }
    porPagamento[idx].push({
      empresaId,
      operacaoId: peso.operacaoId,
      valorCentavos
    });
  }
  return porPagamento;
}

function validarInvariantesFinanceiros({
  totalCentavos, pagamentos, rateiosPorPagamento, operacoes, statusAtendimento
}) {
  const somaPag = pagamentos.reduce((acc, p) => acc + p.valorCentavos, 0);
  if (somaPag !== totalCentavos) {
    throw erroAtendimento(
      'INVARIANTE_PAGAMENTO',
      'Soma dos pagamentos diverge do total oficial do atendimento.',
      { statusCode: 500 }
    );
  }
  const todosRateios = rateiosPorPagamento.flat();
  const somaRateios = todosRateios.reduce((acc, r) => acc + r.valorCentavos, 0);
  if (somaRateios !== totalCentavos) {
    throw erroAtendimento(
      'INVARIANTE_RATEIO',
      'Soma dos rateios diverge do total oficial do atendimento.',
      { statusCode: 500 }
    );
  }
  rateiosPorPagamento.forEach((rateios, i) => {
    const soma = rateios.reduce((acc, r) => acc + r.valorCentavos, 0);
    if (soma !== pagamentos[i].valorCentavos) {
      throw erroAtendimento(
        'INVARIANTE_RATEIO_PAGAMENTO',
        `Rateios do pagamento ${i} divergem do valor pago.`,
        { statusCode: 500 }
      );
    }
  });
  const empresas = new Set(operacoes.map((o) => Number(o.empresaId)));
  for (const r of todosRateios) {
    if (r.valorCentavos < 0) {
      throw erroAtendimento('RATEIO_NEGATIVO', 'Rateio negativo é inválido.', { statusCode: 400 });
    }
    if (!empresas.has(Number(r.empresaId))) {
      throw erroAtendimento(
        'EMPRESA_INVALIDA',
        'Rateio referencia empresa inexistente no atendimento.',
        { statusCode: 400 }
      );
    }
  }
  if (statusAtendimento === STATUS_ATENDIMENTO.CANCELADO) {
    throw erroAtendimento(
      'ATENDIMENTO_CANCELADO',
      'Atendimento cancelado não pode ter pagamento confirmado.',
      { statusCode: 409 }
    );
  }
  if (pagamentos.length === 0 || todosRateios.length === 0) {
    throw erroAtendimento(
      'INVARIANTE_PAGO',
      'Atendimento PAGO exige ao menos um pagamento e rateio completo.',
      { statusCode: 500 }
    );
  }
  validarDistribuicaoPagamento(
    centavosParaReaisMuv(totalCentavos),
    agruparRateiosPorEmpresa(todosRateios),
    0.01
  );
}

function agruparRateiosPorEmpresa(rateios) {
  const mapa = new Map();
  for (const r of rateios) {
    mapa.set(r.empresaId, (mapa.get(r.empresaId) || 0) + r.valorCentavos);
  }
  return [...mapa.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([empresaId, valorCentavos]) => ({
      empresaId,
      valor: centavosParaReaisMuv(valorCentavos)
    }));
}

async function persistirFinanceiro(db, atendimentoId, pagamentos, rateiosPorPagamento, {
  estrategia, idempotencyKey, payloadHash
}) {
  const persistidos = [];
  for (let i = 0; i < pagamentos.length; i += 1) {
    const pag = pagamentos[i];
    const ins = await dbRun(
      db,
      `INSERT INTO atendimento_pagamentos (
         atendimento_id, sequencia, forma_pagamento, valor_centavos, valor,
         status, idempotency_key, payload_hash, metadata_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        atendimentoId,
        i + 1,
        pag.formaPagamento,
        pag.valorCentavos,
        pag.valor,
        STATUS_PAGAMENTO_ATENDIMENTO.CONFIRMADO,
        idempotencyKey || null,
        payloadHash,
        null
      ]
    );
    persistidos.push({ ...pag, pagamentoId: ins.lastID, sequencia: i + 1 });
  }

  const rateiosPersistidos = [];
  for (let i = 0; i < persistidos.length; i += 1) {
    for (const r of rateiosPorPagamento[i]) {
      const valor = centavosParaReaisMuv(r.valorCentavos);
      const ins = await dbRun(
        db,
        `INSERT INTO atendimento_pagamento_rateios (
           atendimento_id, atendimento_pagamento_id, atendimento_operacao_id,
           empresa_id, valor_centavos, valor, estrategia_rateio,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          atendimentoId,
          persistidos[i].pagamentoId,
          r.operacaoId,
          r.empresaId,
          r.valorCentavos,
          valor,
          estrategia
        ]
      );
      rateiosPersistidos.push({
        rateioId: ins.lastID,
        pagamentoId: persistidos[i].pagamentoId,
        ...r,
        valor,
        estrategia
      });
    }
  }
  return { pagamentos: persistidos, rateios: rateiosPersistidos };
}

/**
 * Confirma pagamento unificado do atendimento RESERVADO.
 * Não cria vendas, não chama TEF, não consome reserva.
 */
async function confirmarPagamentoAtendimento(atendimentoId, entrada = {}, deps = {}) {
  const db = getDb(deps.db);
  const id = Number(atendimentoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroAtendimento('ATENDIMENTO_INVALIDO', 'atendimentoId inválido.', { statusCode: 400 });
  }

  await garantirSchemaAtendimentoAsync(db);

  const pagamentosNorm = normalizarPagamentosEntrada(entrada.pagamentos);
  const estrategia = normalizarEstrategiaRateio(entrada.estrategia || entrada.estrategiaRateio);
  const idempotencyKey = entrada.idempotencyKey || entrada.idempotency_key || null;
  const payloadHash = fingerprintPagamentoAtendimento({
    pagamentos: pagamentosNorm,
    estrategia
  });

  let txAberta = false;
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    txAberta = true;

    const cab = await dbGet(db, `SELECT * FROM atendimentos WHERE id = ?`, [id]);
    if (!cab) {
      throw erroAtendimento('ATENDIMENTO_INVALIDO', `Atendimento não encontrado: ${id}.`, {
        statusCode: 404
      });
    }
    if (cab.modo_operacao !== ModoOperacaoVenda.MULTIEMPRESA) {
      throw erroAtendimento(
        'ATENDIMENTO_INVALIDO',
        'Pagamento unificado aplica-se somente a atendimento MULTIEMPRESA.',
        { statusCode: 400 }
      );
    }
    if (cab.status === STATUS_ATENDIMENTO.CANCELADO) {
      throw erroAtendimento(
        'ATENDIMENTO_CANCELADO',
        'Atendimento cancelado não aceita pagamento.',
        { statusCode: 409 }
      );
    }
    if (cab.status === STATUS_ATENDIMENTO.PAGO) {
      const existente = await carregarFinanceiroAtendimento(db, id);
      const hashExistente = existente.pagamentos[0] && existente.pagamentos[0].pagamentoId
        ? (await dbGet(
          db,
          `SELECT payload_hash, idempotency_key FROM atendimento_pagamentos
            WHERE atendimento_id = ? ORDER BY sequencia LIMIT 1`,
          [id]
        ))
        : null;
      if (
        idempotencyKey
        && hashExistente
        && hashExistente.idempotency_key === idempotencyKey
        && hashExistente.payload_hash !== payloadHash
      ) {
        throw erroAtendimento(
          'IDEMPOTENCY_KEY_CONFLICT',
          'A mesma idempotency_key foi usada com payload incompatível.',
          { statusCode: 409 }
        );
      }
      if (
        (idempotencyKey && hashExistente && hashExistente.idempotency_key === idempotencyKey
          && hashExistente.payload_hash === payloadHash)
        || (!idempotencyKey && hashExistente && hashExistente.payload_hash === payloadHash)
      ) {
        await dbRun(db, 'COMMIT');
        txAberta = false;
        return montarContratoAtendimento(db, id, { flags: { idempotente: true } });
      }
      throw erroAtendimento(
        'ATENDIMENTO_JA_PAGO',
        'Atendimento já possui pagamento confirmado.',
        { statusCode: 409 }
      );
    }
    if (cab.status !== STATUS_ATENDIMENTO.RESERVADO) {
      const code = cab.status === STATUS_ATENDIMENTO.VALIDADO
        ? 'ATENDIMENTO_NAO_RESERVADO'
        : 'ATENDIMENTO_STATUS_INVALIDO';
      throw erroAtendimento(
        code,
        `Atendimento em status ${cab.status} não pode iniciar pagamento.`,
        { statusCode: 409 }
      );
    }

    await dbRun(
      db,
      `UPDATE atendimentos SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [STATUS_ATENDIMENTO.PAGAMENTO_PROCESSANDO, id]
    );

    const preview = await obterAtendimento(id, { db });
    const itens = preview.operacoes.flatMap((op) => op.itens);
    const totalOficial = calcularTotalOficialItens(itens);
    if (Math.abs(totalOficial - preview.total) > 0.009) {
      throw erroAtendimento(
        'ATENDIMENTO_INVALIDO',
        'Total persistido diverge do total oficial dos itens.',
        { statusCode: 500 }
      );
    }
    validarSomaComercial(pagamentosNorm, totalOficial);
    ajustarPagamentosAoTotalOficial(pagamentosNorm, reaisParaCentavosMuv(totalOficial));

    const rateiosPorPagamento = calcularRateiosPorEstrategia(
      estrategia,
      pagamentosNorm,
      preview.operacoes,
      entrada
    );
    validarInvariantesFinanceiros({
      totalCentavos: reaisParaCentavosMuv(totalOficial),
      pagamentos: pagamentosNorm,
      rateiosPorPagamento,
      operacoes: preview.operacoes,
      statusAtendimento: cab.status
    });

    if (typeof deps.antesPersistirPagamento === 'function') {
      await deps.antesPersistirPagamento({ atendimentoId: id });
    }

    const gravado = await persistirFinanceiro(db, id, pagamentosNorm, rateiosPorPagamento, {
      estrategia,
      idempotencyKey,
      payloadHash
    });

    if (typeof deps.aposPersistirPagamento === 'function') {
      await deps.aposPersistirPagamento({ atendimentoId: id, pagamentos: gravado.pagamentos });
    }
    if (typeof deps.aposPersistirRateio === 'function') {
      await deps.aposPersistirRateio({ atendimentoId: id, rateios: gravado.rateios });
    }

    await dbRun(
      db,
      `UPDATE atendimento_operacoes
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE atendimento_id = ?`,
      [STATUS_OPERACAO_EMPRESARIAL.AGUARDANDO_CONCLUSAO, id]
    );
    await dbRun(
      db,
      `UPDATE atendimentos SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [STATUS_ATENDIMENTO.PAGO, id]
    );

    if (typeof deps.aposAtualizarPago === 'function') {
      await deps.aposAtualizarPago({ atendimentoId: id });
    }

    const financeiroFinal = await carregarFinanceiroAtendimento(db, id);
    if (financeiroFinal.pagamentos.length === 0 || financeiroFinal.rateios.length === 0) {
      throw erroAtendimento(
        'INVARIANTE_PAGO',
        'Atendimento PAGO exige pagamento e rateio completos.',
        { statusCode: 500 }
      );
    }

    await dbRun(db, 'COMMIT');
    txAberta = false;
    return montarContratoAtendimento(db, id);
  } catch (e) {
    if (txAberta) {
      try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}

/**
 * Materializa vendas reais por operação. Não cobra de novo. Não chama TEF.
 */
async function materializarAtendimento(atendimentoId, entrada = {}, deps = {}) {
  const db = getDb(deps.db);
  const id = Number(atendimentoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroAtendimento('ATENDIMENTO_INVALIDO', 'atendimentoId inválido.', { statusCode: 400 });
  }

  await garantirSchemaAtendimentoAsync(db);
  const idempotencyKey = entrada.idempotencyKey || entrada.idempotency_key || null;

  let txAberta = false;
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    txAberta = true;

    const cab = await dbGet(db, `SELECT * FROM atendimentos WHERE id = ?`, [id]);
    if (!cab) {
      throw erroAtendimento('ATENDIMENTO_INVALIDO', `Atendimento não encontrado: ${id}.`, {
        statusCode: 404
      });
    }
    if (cab.modo_operacao !== ModoOperacaoVenda.MULTIEMPRESA) {
      throw erroAtendimento(
        'ATENDIMENTO_INVALIDO',
        'Materialização aplica-se somente a atendimento MULTIEMPRESA.',
        { statusCode: 400 }
      );
    }
    if (cab.status === STATUS_ATENDIMENTO.CANCELADO) {
      throw erroAtendimento(
        'ATENDIMENTO_CANCELADO',
        'Atendimento cancelado não pode ser materializado.',
        { statusCode: 409 }
      );
    }

    const preview = await obterAtendimento(id, { db });
    const payloadHash = fingerprintMaterializacao(id, preview.operacoes);

    if (cab.status === STATUS_ATENDIMENTO.CONCLUIDO) {
      if (
        idempotencyKey
        && cab.materializacao_idempotency_key === idempotencyKey
        && cab.materializacao_payload_hash
        && cab.materializacao_payload_hash !== payloadHash
      ) {
        throw erroAtendimento(
          'IDEMPOTENCY_KEY_CONFLICT',
          'A mesma idempotency_key foi usada com payload incompatível.',
          { statusCode: 409 }
        );
      }
      await dbRun(db, 'COMMIT');
      txAberta = false;
      return montarContratoAtendimento(db, id, {
        flags: { idempotente: true, venda_concluida: true }
      });
    }

    if (cab.status !== STATUS_ATENDIMENTO.PAGO) {
      throw erroAtendimento(
        'ATENDIMENTO_NAO_PAGO',
        `Atendimento em status ${cab.status} não pode ser materializado.`,
        { statusCode: 409 }
      );
    }

    await dbRun(
      db,
      `UPDATE atendimentos SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [STATUS_ATENDIMENTO.MATERIALIZANDO, id]
    );

    const vendas = [];
    for (const op of preview.operacoes) {
      const resultado = await materializarOperacao(db, preview, op, deps);
      vendas.push(resultado);
      if (typeof deps.aposMaterializarOperacao === 'function') {
        await deps.aposMaterializarOperacao({ atendimentoId: id, operacao: resultado });
      }
    }

    const opsAtual = await dbAll(
      db,
      `SELECT status, venda_id FROM atendimento_operacoes WHERE atendimento_id = ?`,
      [id]
    );
    const todasConcluidas = opsAtual.length > 0
      && opsAtual.every((o) => o.status === STATUS_OPERACAO_EMPRESARIAL.CONCLUIDA && o.venda_id);
    if (!todasConcluidas) {
      throw erroAtendimento(
        'MATERIALIZACAO_INCOMPLETA',
        'CONCLUIDO exige todas as operações materializadas.',
        { statusCode: 500 }
      );
    }

    await dbRun(
      db,
      `UPDATE atendimentos
          SET status = ?, materializacao_idempotency_key = ?, materializacao_payload_hash = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [STATUS_ATENDIMENTO.CONCLUIDO, idempotencyKey, payloadHash, id]
    );

    if (typeof deps.aposConcluirMaterializacao === 'function') {
      await deps.aposConcluirMaterializacao({ atendimentoId: id, vendas });
    }

    await dbRun(db, 'COMMIT');
    txAberta = false;
    return montarContratoAtendimento(db, id, {
      flags: { venda_concluida: true, vendas }
    });
  } catch (e) {
    if (txAberta) {
      try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}

module.exports = {
  criarAtendimento,
  obterAtendimento,
  reservarAtendimento,
  cancelarAtendimento,
  confirmarPagamentoAtendimento,
  materializarAtendimento,
  fiscalizarAtendimento(atendimentoId, deps) {
    return require('./FiscalizarAtendimentoService').fiscalizarAtendimento(atendimentoId, deps);
  },
  obterComprovanteUnificado(atendimentoId, deps) {
    return require('./ComprovanteUnificadoAtendimentoService').obterComprovanteUnificado(atendimentoId, deps);
  },
  validarEstoqueOperacoes
};
