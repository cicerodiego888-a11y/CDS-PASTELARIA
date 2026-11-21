/**
 * FaturamentoService — Pedido → Núcleo (Sprint 3.2 / RC4.0.0).
 *
 * Fluxo oficial RC4.0.0:
 *   Pedido → Expedição → Venda (Núcleo) → Central de Faturamento → NF-e
 *
 * A Expedição NÃO emite NF-e. Emissão ocorre apenas na Central de Faturamento.
 * emitir_fiscal permanece false no núcleo (não dispara NFC-e).
 */

'use strict';

const configService = require('../configuracaoService');
const PedidoRepository = require('../pedido/PedidoRepository');
const { PedidoStatus } = require('../pedido/enums');
const { exigirOperacaoDoPedido } = require('../pedidos/PedidoEmpresaContextoService');
const { VendaOrigin } = require('../vendas/VendaOrigin');
const { criarVendaContract } = require('../vendas/VendaContract');
const { criarVendaContext } = require('../vendas/VendaContext');
const VendaApplicationService = require('../vendas/VendaApplicationService');
const { consumirReservasDaVenda } = require('../estoque/EstoqueConsumoReserva');
const { consumirReservasPedidoNaVenda } = require('../estoque/pedidoReservaPonteNucleo');
const { montarOptsPortaReservaPdv } = require('../estoque/EstoqueReservaService');
const { calcularFinanceiroPedido } = require('./CalculoFinanceiroPedido');
const PedidoFaturamentoOperacaoRepository = require('./PedidoFaturamentoOperacaoRepository');
const { validarLiberacaoPdv } = require('../cozinha/CozinhaLiberacaoPdvService');

function assertModuloHabilitado() {
  if (!configService.recursoHabilitado('expedicao')) {
    const err = new Error('Módulo Expedição desabilitado.');
    err.statusCode = 404;
    err.codigo = 'MODULO_FATURAMENTO_DESABILITADO';
    throw err;
  }
}

/**
 * Mesma regra do PDV: F12 ON ↔ modo_dashboard_fiscal = '1'.
 * Fail-closed: se não conseguir ler, trata como não fiscal (não emite).
 */
function parseModoOperacionalFiscalFlag(valor) {
  return valor === true
    || valor === 'true'
    || valor === 1
    || valor === '1';
}

async function modoOperacionalFiscalAtivo() {
  const db = require('../../database');
  try {
    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT valor FROM configuracoes WHERE chave = ?`,
        ['modo_dashboard_fiscal'],
        (err, r) => (err ? reject(err) : resolve(r || null))
      );
    });
    return parseModoOperacionalFiscalFlag(row && row.valor);
  } catch (err) {
    console.warn('[Faturamento] modo operacional (F12):', err.message);
    return false;
  }
}

function extrairDadosNfe(body = {}, pedido = {}) {
  return {
    natureza_operacao: body.natureza_operacao || pedido.natureza_operacao || 'VENDA DE MERCADORIA',
    cfop: body.cfop || pedido.cfop || '5102',
    frete: Number(body.frete != null ? body.frete : (pedido.frete || 0)),
    acrescimo: Number(body.acrescimo != null ? body.acrescimo : (pedido.acrescimo || 0)),
    desconto: Number(body.desconto != null ? body.desconto : (pedido.desconto || 0)),
    transportadora: body.transportadora || pedido.transportadora || null,
    volumes: Number(body.volumes != null ? body.volumes : (pedido.volumes || 0)),
    peso: Number(body.peso != null ? body.peso : (pedido.peso || 0)),
    observacoes: body.observacoes || pedido.observacao || null,
    dados_adicionais: body.dados_adicionais || pedido.dados_adicionais || null,
    mod_frete: body.mod_frete != null ? body.mod_frete : pedido.mod_frete,
    dest_logradouro: body.dest_logradouro,
    dest_numero: body.dest_numero,
    dest_bairro: body.dest_bairro,
    dest_municipio: body.dest_municipio,
    dest_uf: body.dest_uf,
    dest_cep: body.dest_cep,
    dest_codigo_municipio: body.dest_codigo_municipio
  };
}

function montarPayloadVendaDoPedido(pedido, pagamentosBody = {}, opcoes = {}) {
  const itens = (pedido.itens || []).map((item) => ({
    produto_id: Number(item.produto_id),
    quantidade: Number(item.quantidade),
    preco_unitario: Number(item.preco_unitario),
    desconto_percentual: Number(item.desconto_percentual || 0),
    subtotal: Number(item.subtotal),
    tipo_venda: item.tipo_venda || 'PESO',
    promocao_id: null,
    desconto_atacado: 0,
    tipo_preco: 'varejo'
  }));

  const forma = pagamentosBody.forma_pagamento
    || (Array.isArray(pagamentosBody.pagamentos) && (
      pagamentosBody.pagamentos[0]?.forma_pagamento
      || pagamentosBody.pagamentos[0]?.forma
    ))
    || 'dinheiro';

  const dadosNfe = extrairDadosNfe(pagamentosBody, pedido);
  const financeiroPedido = calcularFinanceiroPedido(pedido.itens || [], dadosNfe);

  // Núcleo / venda_pagamentos exigem forma_pagamento (NOT NULL).
  // UI do Faturamento pode enviar { forma, valor } — normalizar aqui.
  let pagamentos;
  if (Array.isArray(pagamentosBody.pagamentos) && pagamentosBody.pagamentos.length > 0) {
    pagamentos = pagamentosBody.pagamentos.map((p) => ({
      ...p,
      forma_pagamento: String(
        p.forma_pagamento || p.forma || forma || 'dinheiro'
      ).toLowerCase().trim(),
      valor: Number(p.valor != null ? p.valor : 0)
    }));
  }

  return {
    origem: VendaOrigin.FATURAMENTO,
    tipo_venda: 'BALCAO',
    pedido_id: Number(pedido.id),
    cliente_id: pedido.cliente_id || null,
    itens,
    total: financeiroPedido.total,
    desconto: financeiroPedido.desconto,
    valor_outros: financeiroPedido.valor_outros,
    forma_pagamento: forma,
    pagamentos,
    parcelas: Math.max(1, parseInt(pagamentosBody.parcelas || 1, 10) || 1),
    primeiro_vencimento: pagamentosBody.primeiro_vencimento || null,
    intervalo_parcelas: pagamentosBody.intervalo_parcelas || pagamentosBody.intervalo || 'mensal',
    valor_recebido: pagamentosBody.valor_recebido != null
      ? Number(pagamentosBody.valor_recebido)
      : financeiroPedido.total,
    // RC3.15.11 — NFC-e nunca pela Expedição; distribuição fiscal segue F12 (venda_fiscal).
    emitir_fiscal: false,
    venda_fiscal: opcoes.vendaFiscal === true,
    observacao: dadosNfe.observacoes || pedido.observacao || pagamentosBody.observacao_pagamento || null
  };
}

function invocarNucleo(contract, context, reqBase) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = {
      ...reqBase,
      body: contract.payload,
      vendaContract: contract,
      vendaContext: context
    };

    const finish = (statusCode, body) => {
      if (settled) return;
      settled = true;
      if (statusCode >= 400) {
        const err = new Error(body?.error || body?.mensagem || body?.message || 'Falha ao faturar.');
        err.statusCode = statusCode;
        err.body = body;
        reject(err);
        return;
      }
      resolve(body);
    };

    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        finish(this.statusCode || 200, body);
        return this;
      }
    };

    try {
      const ret = VendaApplicationService.criarVendaComContexto(contract, context, req, res);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      }
    } catch (err) {
      reject(err);
    }
  });
}

function valorEmCentavos(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.round(numero * 100) : null;
}

function erroVendaPedidoConflitante(message, pedidoId, vendaId, extra = {}) {
  const err = new Error(message);
  err.statusCode = 409;
  err.codigo = 'FATURAMENTO_PEDIDO_CONFLITANTE';
  err.pedido_id = pedidoId;
  if (vendaId != null) err.venda_id = Number(vendaId);
  Object.assign(err, extra);
  return err;
}

async function validarVendaCandidata(pedido, vendaId, payload, dbConn) {
  try {
    const venda = await PedidoFaturamentoOperacaoRepository.get(dbConn, `
    SELECT id, codigo, empresa_id, cliente_id, total, desconto, status, status_venda, pedido_id, origem
    FROM vendas
    WHERE id = ?
  `, [vendaId]);
    const itensVenda = await PedidoFaturamentoOperacaoRepository.all(dbConn, `
    SELECT produto_id, quantidade, preco_unitario, subtotal
    FROM vendas_itens
    WHERE venda_id = ?
    ORDER BY id
  `, [vendaId]);

  const conflito = () => erroVendaPedidoConflitante(
    'A venda candidata não corresponde ao Pedido; nenhuma venda será criada ou substituída.',
    pedido.id,
    vendaId
  );
  const descontoSnapshotCentavos = payload.desconto == null
    ? null
    : valorEmCentavos(payload.desconto);
  const brutoSnapshotCentavos = payload.valor_composicao_bruto == null
    ? null
    : valorEmCentavos(payload.valor_composicao_bruto);
  const subtotaisItensCentavos = payload.itens.map((item) => valorEmCentavos(item.subtotal));
  const brutoItensCentavos = subtotaisItensCentavos.every(Number.isSafeInteger)
    ? subtotaisItensCentavos.reduce((total, subtotal) => total + subtotal, 0)
    : null;
  const composicaoFinanceiraInconsistente = payload.valor_composicao_bruto != null
    && (
      brutoSnapshotCentavos == null
      || descontoSnapshotCentavos == null
      || !Number.isSafeInteger(brutoItensCentavos)
      || brutoSnapshotCentavos !== brutoItensCentavos
      || brutoSnapshotCentavos - descontoSnapshotCentavos !== valorEmCentavos(payload.total)
    );

  if (
    !venda
    || Number(venda.empresa_id) !== Number(pedido.empresa_id)
    || Number(venda.cliente_id || 0) !== Number(pedido.cliente_id || 0)
    || String(venda.status || '').toLowerCase() !== 'concluida'
    || String(venda.status_venda || '').toUpperCase() === 'CANCELADA'
    || (venda.pedido_id != null && Number(venda.pedido_id) !== Number(pedido.id))
    || valorEmCentavos(venda.total) !== valorEmCentavos(payload.total)
    || (payload.desconto != null
      && valorEmCentavos(venda.desconto || 0) !== descontoSnapshotCentavos)
    || composicaoFinanceiraInconsistente
    || itensVenda.length !== payload.itens.length
  ) {
    throw conflito();
  }

  for (let indice = 0; indice < payload.itens.length; indice += 1) {
    const esperado = payload.itens[indice];
    const persistido = itensVenda[indice];
    if (
      Number(persistido.produto_id) !== Number(esperado.produto_id)
      || Math.round(Number(persistido.quantidade) * 1000) !== Math.round(Number(esperado.quantidade) * 1000)
      || valorEmCentavos(persistido.preco_unitario) !== valorEmCentavos(esperado.preco_unitario)
      || valorEmCentavos(persistido.subtotal) !== valorEmCentavos(esperado.subtotal)
    ) {
      throw conflito();
    }
  }

  if (pedido.venda_id != null && Number(pedido.venda_id) !== Number(vendaId)) {
    throw erroVendaPedidoConflitante(
      'O Pedido já está associado a outra venda.',
      pedido.id,
      vendaId,
      { pedido_venda_id: pedido.venda_id }
    );
  }

  return venda;
  } catch (err) {
    err.pedido_id = Number(pedido.id);
    err.venda_id = Number(vendaId);
    err.venda_persistida = true;
    throw err;
  }
}

async function finalizarPedidoComVenda(
  pedidoId,
  vendaId,
  empresaId,
  operadorId,
  reqHttp,
  payload,
  opcoes = {}
) {
  const db = require('../../database');
  const origemVenda = opcoes.origemVenda || VendaOrigin.FATURAMENTO;
  const statusPermitidos = opcoes.permitirStatusPedido
    ? [PedidoStatus.PEDIDO, PedidoStatus.ABERTO, PedidoStatus.AGUARDANDO_FATURAMENTO, PedidoStatus.FATURADO]
    : [PedidoStatus.ABERTO, PedidoStatus.AGUARDANDO_FATURAMENTO, PedidoStatus.FATURADO];
  let transacaoDb;
  let iniciouTransacao = false;
  let erroOperacao = null;
  let pedidoAtualizado;

  try {
    transacaoDb = await db.openExclusiveConnection();
    await PedidoFaturamentoOperacaoRepository.run(transacaoDb, 'BEGIN IMMEDIATE');
    iniciouTransacao = true;

    const pedido = await PedidoRepository.obterPorId(pedidoId, { db: transacaoDb });
    if (!pedido || Number(pedido.empresa_id) !== Number(empresaId)) {
      throw erroVendaPedidoConflitante(
        'Pedido ausente ou pertencente a outra empresa durante a finalização.',
        pedidoId,
        vendaId
      );
    }
    if (!statusPermitidos.includes(pedido.status)) {
      throw erroVendaPedidoConflitante(
        `Pedido não pode ser finalizado no status ${pedido.status}.`,
        pedidoId,
        vendaId
      );
    }

    const operacao = await PedidoFaturamentoOperacaoRepository.get(transacaoDb, `
      SELECT id, pedido_id, empresa_id, venda_id, status, tipo_operacao, payload_json
      FROM pedido_faturamento_operacoes
      WHERE pedido_id = ?
    `, [pedidoId]);
    if (
      !operacao
      || Number(operacao.empresa_id) !== Number(empresaId)
      || Number(operacao.venda_id) !== Number(vendaId)
    ) {
      throw erroVendaPedidoConflitante(
        'A identidade persistida da operação diverge da venda a finalizar.',
        pedidoId,
        vendaId
      );
    }
    if (opcoes.tipoOperacao && operacao.tipo_operacao !== opcoes.tipoOperacao) {
      throw erroVendaPedidoConflitante(
        'O tipo da operação persistida diverge do fluxo de venda.',
        pedidoId,
        vendaId
      );
    }

    const { validarLiberacaoPdv } = require('../cozinha/CozinhaLiberacaoPdvService');
    await validarLiberacaoPdv(
      { pedidoId, empresaId },
      { db: transacaoDb }
    );

    const venda = await validarVendaCandidata(pedido, vendaId, payload, transacaoDb);
    if (venda.pedido_id == null || Number(venda.pedido_id) !== Number(pedidoId)) {
      const vinculada = await PedidoFaturamentoOperacaoRepository.run(transacaoDb, `
        UPDATE vendas
        SET origem = ?, pedido_id = ?
        WHERE id = ? AND empresa_id = ?
          AND (pedido_id IS NULL OR pedido_id = ?)
      `, [origemVenda, pedidoId, vendaId, empresaId, pedidoId]);
      if (vinculada.changes !== 1) {
        throw erroVendaPedidoConflitante(
          'Não foi possível vincular a venda ao Pedido sem sobrescrever outro vínculo.',
          pedidoId,
          vendaId
        );
      }
    } else if (venda.origem !== VendaOrigin.FATURAMENTO) {
      await PedidoFaturamentoOperacaoRepository.run(transacaoDb, `
        UPDATE vendas SET origem = ?
        WHERE id = ? AND empresa_id = ? AND pedido_id = ?
      `, [origemVenda, vendaId, empresaId, pedidoId]);
    }

    await consumirReservasDaVenda(
      vendaId,
      montarOptsPortaReservaPdv(reqHttp, transacaoDb)
    );
    await consumirReservasPedidoNaVenda(pedidoId, vendaId, {
      db: transacaoDb,
      empresaId,
      contexto: reqHttp,
      usuarioId: operadorId
    });

    const marcado = await PedidoRepository.marcarFaturado(pedidoId, vendaId, operadorId, {
      db: transacaoDb,
      empresaId,
      permitirPedido: opcoes.permitirStatusPedido === true
    });
    if (!marcado) {
      throw erroVendaPedidoConflitante(
        'Venda persistida, mas o status do Pedido não pôde ser atualizado.',
        pedidoId,
        vendaId
      );
    }

    const atualizacaoOperacao = await PedidoFaturamentoOperacaoRepository.run(transacaoDb, `
      UPDATE pedido_faturamento_operacoes
      SET status = 'FINALIZADA', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND venda_id = ? AND empresa_id = ?
    `, [operacao.id, vendaId, empresaId]);
    if (atualizacaoOperacao.changes !== 1) {
      throw erroVendaPedidoConflitante(
        'Não foi possível registrar a finalização da operação do Pedido.',
        pedidoId,
        vendaId
      );
    }

    pedidoAtualizado = await PedidoRepository.obterPorId(pedidoId, { db: transacaoDb });
    await PedidoFaturamentoOperacaoRepository.run(transacaoDb, 'COMMIT');
    iniciouTransacao = false;
  } catch (err) {
    erroOperacao = err instanceof Error ? err : new Error(String(err));
    if (iniciouTransacao) {
      try {
        await PedidoFaturamentoOperacaoRepository.run(transacaoDb, 'ROLLBACK');
      } catch (rollbackError) {
        erroOperacao.rollbackError = rollbackError;
      }
    }
  }

  if (transacaoDb) {
    try {
      await new Promise((resolve, reject) => {
        transacaoDb.close((err) => (err ? reject(err) : resolve()));
      });
    } catch (closeError) {
      if (erroOperacao) erroOperacao.closeError = closeError;
      else erroOperacao = closeError;
    }
  }

  if (erroOperacao) {
    erroOperacao.venda_id = Number(vendaId);
    erroOperacao.venda_persistida = true;
    erroOperacao.message = `A venda ${vendaId} já foi persistida, mas a finalização do Pedido falhou: ${erroOperacao.message}`;
    throw erroOperacao;
  }
  return pedidoAtualizado;
}

async function finalizarVendaPdvPedido(pedidoId, reqHttp = {}) {
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Pedido inválido.');
    err.statusCode = 400;
    throw err;
  }

  const pedido = await PedidoRepository.obterPorId(id);
  const empresaId = exigirOperacaoDoPedido(
    pedido,
    reqHttp.empresaId != null ? reqHttp.empresaId : reqHttp.empresa_id
  );
  const db = require('../../database');
  const operacao = await PedidoFaturamentoOperacaoRepository.get(db, `
    SELECT id, pedido_id, empresa_id, venda_id, status, tipo_operacao, payload_json
    FROM pedido_faturamento_operacoes
    WHERE pedido_id = ?
  `, [id]);
  if (
    !operacao
    || Number(operacao.empresa_id) !== Number(empresaId)
    || operacao.tipo_operacao !== 'PDV_COMPOSICAO'
  ) {
    throw erroVendaPedidoConflitante(
      'Não existe uma operação de composição PDV válida para este Pedido.',
      id,
      operacao?.venda_id
    );
  }
  if (
    operacao.status === 'FINALIZADA'
    && pedido.status === PedidoStatus.FATURADO
    && Number(pedido.venda_id) === Number(operacao.venda_id)
  ) {
    const mesa = await registrarMesaAposVendaConfirmada(pedido, empresaId, reqHttp);
    return { pedido, venda_id: Number(operacao.venda_id), idempotente: true, mesa };
  }
  if (!Number.isInteger(Number(operacao.venda_id)) || Number(operacao.venda_id) <= 0) {
    throw erroVendaPedidoConflitante(
      'A venda ainda não foi persistida pelo PDV; a finalização do Pedido não pode ser antecipada.',
      id
    );
  }
  const vendaPagamento = await PedidoFaturamentoOperacaoRepository.get(db, `
    SELECT status_pagamento
    FROM vendas
    WHERE id = ? AND empresa_id = ?
  `, [operacao.venda_id, empresaId]);
  if (!vendaPagamento) {
    throw erroVendaPedidoConflitante(
      'A venda persistida não foi encontrada para validar o estado do pagamento.',
      id,
      operacao.venda_id
    );
  }
  if (String(vendaPagamento.status_pagamento || '').toLowerCase() === 'aguardando_nao_fiscal') {
    const err = erroVendaPedidoConflitante(
      'A venda aguarda a conclusão do pagamento não fiscal; o Pedido permanecerá aberto até essa etapa terminar.',
      id,
      operacao.venda_id
    );
    err.codigo = 'PAGAMENTO_PDV_PENDENTE';
    throw err;
  }

  let payload;
  try {
    payload = JSON.parse(operacao.payload_json || 'null');
  } catch (parseError) {
    throw erroVendaPedidoConflitante(
      'O snapshot da composição da venda não pode ser recuperado.',
      id,
      operacao.venda_id
    );
  }
  if (
    !payload
    || Number(payload.pedidoId) !== id
    || Number(payload.empresaId) !== Number(empresaId)
    || !Array.isArray(payload.itens)
    || !Number.isFinite(Number(payload.total))
  ) {
    throw erroVendaPedidoConflitante(
      'O snapshot persistido da composição é inválido ou pertence a outra operação.',
      id,
      operacao.venda_id
    );
  }

  const pedidoAtualizado = await finalizarPedidoComVenda(
    id,
    Number(operacao.venda_id),
    empresaId,
    reqHttp.operadorId || reqHttp.user?.id || null,
    reqHttp,
    payload,
    {
      origemVenda: VendaOrigin.PDV,
      permitirStatusPedido: true,
      tipoOperacao: 'PDV_COMPOSICAO'
    }
  );
  const mesa = await registrarMesaAposVendaConfirmada(pedidoAtualizado, empresaId, reqHttp);
  return { pedido: pedidoAtualizado, venda_id: Number(operacao.venda_id), idempotente: false, mesa };
}

async function registrarMesaAposVendaConfirmada(pedido, empresaId, reqHttp) {
  const Atendimento = require('../pedido/MesaAtendimentoService');
  const operadorId = reqHttp.operadorId || reqHttp.user?.id || reqHttp.user?.usuario_id || null;
  try {
    return await Atendimento.encerrarAtendimentoQuitado(empresaId, pedido && pedido.id, { operadorId });
  } catch (err) {
    return {
      encerrado: false,
      codigo: (err && (err.codigo || err.code)) || 'ATENDIMENTO_MESA_NAO_ATUALIZADO'
    };
  }
}

async function faturarPedido(pedidoId, body = {}, reqHttp = {}) {
  assertModuloHabilitado();

  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Pedido inválido.');
    err.statusCode = 400;
    throw err;
  }

  const pedido = await PedidoRepository.obterPorId(id);
  const empresaIdPedido = exigirOperacaoDoPedido(
    pedido,
    reqHttp.empresaId != null ? reqHttp.empresaId : reqHttp.empresa_id
  );
  await validarLiberacaoPdv(
    { pedidoId: id, empresaId: empresaIdPedido },
    { db: require('../../database') }
  );

  const statusPedidoPodeRetomar = [
    PedidoStatus.ABERTO,
    PedidoStatus.AGUARDANDO_FATURAMENTO,
    PedidoStatus.FATURADO
  ].includes(pedido.status);
  if (!statusPedidoPodeRetomar) {
    const err = new Error(`Pedido não está aguardando faturamento (status=${pedido.status}).`);
    err.statusCode = 409;
    throw err;
  }

  if (!Array.isArray(pedido.itens) || pedido.itens.length === 0) {
    const err = new Error('Pedido sem itens.');
    err.statusCode = 400;
    throw err;
  }

  // RC4.0.0 — Expedição é exclusivamente logística: nunca emite NF-e.
  const modoOperacionalFiscal = await modoOperacionalFiscalAtivo();
  const dadosNfe = extrairDadosNfe(body, pedido);

  const payload = montarPayloadVendaDoPedido(pedido, body, {
    vendaFiscal: modoOperacionalFiscal
  });
  const preparacao = await PedidoFaturamentoOperacaoRepository.prepararOperacao(
    id,
    empresaIdPedido,
    payload
  );
  const vendaCandidataId = Number(
    preparacao.operacao.venda_id || preparacao.vendaCandidata?.id || 0
  ) || null;
  const vendaCandidata = vendaCandidataId
    ? await validarVendaCandidata(
      pedido,
      vendaCandidataId,
      payload,
      require('../../database')
    )
    : null;

  if (pedido.status === PedidoStatus.FATURADO) {
    if (!vendaCandidataId) {
      throw erroVendaPedidoConflitante(
        'Pedido consta como faturado, mas não há uma venda vinculada que possa ser recuperada.',
        id,
        pedido.venda_id
      );
    }

    const linksConsistentes = Number(pedido.venda_id) === vendaCandidataId
      && Number(vendaCandidata.pedido_id) === id;
    const db = require('../../database');
    let reservaAtiva;
    try {
      reservaAtiva = await PedidoFaturamentoOperacaoRepository.get(db, `
        SELECT 1 AS existe
        FROM pedido_estoque_reservas
        WHERE pedido_id = ? AND status = 'ATIVA'
        LIMIT 1
      `, [id]);
    } catch (err) {
      err.pedido_id = id;
      err.venda_id = vendaCandidataId;
      err.venda_persistida = true;
      throw err;
    }
    if (
      preparacao.statusOperacaoAnterior === 'FINALIZADA'
      || (linksConsistentes && !reservaAtiva)
    ) {
      const err = new Error('Pedido já faturado.');
      err.statusCode = 409;
      err.venda_id = vendaCandidataId;
      throw err;
    }
  } else if (!vendaCandidataId && ![
    PedidoStatus.ABERTO,
    PedidoStatus.AGUARDANDO_FATURAMENTO
  ].includes(pedido.status)) {
    const err = new Error(`Pedido não está aguardando faturamento (status=${pedido.status}).`);
    err.statusCode = 409;
    throw err;
  }

  // Persistir metadados fiscais do pedido antes do núcleo (úteis na Central).
  // A rejeição idempotente de um Pedido já finalizado não altera seus dados.
  try {
    await PedidoRepository.atualizarDadosFiscais(id, dadosNfe);
  } catch (metaErr) {
    console.warn('[Faturamento] metadados fiscais:', metaErr.message);
  }

  const contract = criarVendaContract({ body: payload });
  const context = criarVendaContext(reqHttp, { origem: VendaOrigin.FATURAMENTO });

  let vendaResposta;
  if (vendaCandidataId) {
    vendaResposta = {
      id: vendaCandidataId,
      venda_id: vendaCandidataId,
      codigo: vendaCandidata.codigo,
      recuperada: true
    };
  } else {
    vendaResposta = await invocarNucleo(contract, context, {
      user: reqHttp.user,
      operadorId: reqHttp.operadorId || reqHttp.user?.id || null,
      terminalId: reqHttp.terminalId || null,
      caixaId: reqHttp.caixaId || null,
      caixaSessaoId: reqHttp.caixaSessaoId || null,
      pedidoFaturamentoOperacaoId: preparacao.operacao.id
    });
  }

  const vendaId = Number(vendaResposta?.id || vendaResposta?.venda_id || 0);
  if (!Number.isInteger(vendaId) || vendaId <= 0) {
    const err = new Error('Núcleo não retornou venda válida.');
    err.statusCode = 500;
    err.body = vendaResposta;
    throw err;
  }

  const operadorId = reqHttp.operadorId || reqHttp.user?.id || null;
  const pedidoAtualizado = await finalizarPedidoComVenda(
    id,
    vendaId,
    empresaIdPedido,
    operadorId,
    reqHttp,
    payload
  );

  return {
    success: true,
    origem: VendaOrigin.FATURAMENTO,
    venda_concluida: true,
    emitir_fiscal_nfc: false,
    modo_operacional_fiscal: Boolean(modoOperacionalFiscal),
    emitir_nfe: false,
    proxima_etapa: 'central_faturamento',
    venda_id: vendaId,
    pedido_id: id,
    pedido: pedidoAtualizado,
    venda: vendaResposta,
    nfe: null,
    message: 'Pedido expedido. Venda criada — prossiga na Central de Faturamento para emitir a NF-e.'
  };
}

/**
 * Sprint 3.13 / RC2 — Central de Vendas Faturadas.
 * Origem: vendas (origem=FATURAMENTO | NF_AVULSA) + LEFT JOIN nfe_notas.
 * Não altera /api/vendas nem emissores.
 *
 * @param {object} query
 * @param {string} [query.aba] todas|com_nfe|sem_nfe|pendentes|canceladas
 * @param {string|number|boolean} [query.modo_fiscal] F12 (1/0); se omitido, lê configuracoes
 * @param {number} [query.page]
 * @param {number} [query.pageSize]
 * @param {string} [query.cliente]
 * @param {string|number} [query.venda_id]
 * @param {string|number} [query.pedido_id]
 * @param {string} [query.documento] número/chave NF-e
 * @param {string} [query.origem]
 * @param {string} [query.data_inicio]
 * @param {string} [query.data_fim]
 * @param {string} [query.status] status da venda
 */
function normalizarAbaCentral(valor) {
  const s = String(valor || 'todas').toLowerCase().trim().replace(/-/g, '_');
  const mapa = {
    todas: 'todas',
    com_nfe: 'com_nfe',
    sem_nfe: 'sem_nfe',
    pendentes: 'pendentes',
    canceladas: 'canceladas'
  };
  return mapa[s] || 'todas';
}

function abasDisponiveisCentral(modoFiscal) {
  if (modoFiscal) {
    return ['todas', 'com_nfe', 'pendentes', 'canceladas'];
  }
  return ['todas', 'com_nfe', 'sem_nfe', 'pendentes', 'canceladas'];
}

/** RC2 — rótulo comercial do campo origem existente (sem novo campo). */
function rotuloOrigemCentral(origem) {
  const o = String(origem || '').toUpperCase().trim();
  const mapa = {
    FATURAMENTO: 'Pedido',
    PEDIDO: 'Pedido',
    PDV: 'PDV',
    ENTREGA: 'Entrega',
    COMPRA_FACIL: 'Entrega',
    MARKETPLACE: 'Marketplace',
    ORCAMENTO: 'Orçamento',
    API: 'API',
    NF_AVULSA: 'NF-e Avulsa'
  };
  return mapa[o] || (o || '—');
}

/**
 * RC2 — classificação visual do documento (nunca vazia).
 * Reutiliza status existentes de venda / nfe_notas.
 */
function classificarDocumentoCentral(row = {}) {
  const statusVenda = String(row.status || '').toLowerCase();
  const nfeStatus = String(row.nfe_status || '').toLowerCase();
  const nfeNumero = row.nfe_numero != null && String(row.nfe_numero).trim() !== ''
    ? String(row.nfe_numero).trim()
    : null;

  if (statusVenda === 'cancelada') {
    return {
      documento: 'Cancelada',
      documento_tipo: 'cancelada',
      status_visual: 'cancelada',
      status_visual_label: 'Cancelada'
    };
  }
  if (row.nfe_id && nfeStatus === 'autorizada') {
    return {
      documento: nfeNumero ? `NF-e ${nfeNumero}` : 'NF-e',
      documento_tipo: 'autorizada',
      status_visual: 'com_nfe',
      status_visual_label: 'Com NF-e'
    };
  }
  if (row.nfe_id && nfeStatus === 'cancelada') {
    return {
      documento: 'Cancelada',
      documento_tipo: 'nfe_cancelada',
      status_visual: 'cancelada',
      status_visual_label: 'Cancelada'
    };
  }
  if (row.nfe_id) {
    return {
      documento: 'Pendente',
      documento_tipo: 'pendente',
      status_visual: 'pendente',
      status_visual_label: 'Pendente'
    };
  }
  return {
    documento: 'Sem Documento Fiscal',
    documento_tipo: 'sem_documento',
    status_visual: 'sem_documento',
    status_visual_label: 'Sem Documento Fiscal'
  };
}

function enriquecerItemCentral(row) {
  const doc = classificarDocumentoCentral(row);
  return {
    ...row,
    origem_label: rotuloOrigemCentral(row.origem),
    ...doc
  };
}

async function listarVendasFaturadas(query = {}) {
  assertModuloHabilitado();

  const modoFiscal = query.modo_fiscal != null && String(query.modo_fiscal).trim() !== ''
    ? parseModoOperacionalFiscalFlag(query.modo_fiscal)
    : await modoOperacionalFiscalAtivo();

  let aba = normalizarAbaCentral(query.aba || query.filtro);
  const disponiveis = abasDisponiveisCentral(modoFiscal);
  if (modoFiscal && aba === 'sem_nfe') {
    aba = 'todas';
  }
  if (!disponiveis.includes(aba)) {
    aba = 'todas';
  }

  const page = Math.max(1, parseInt(query.page || 1, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || query.limit || 20, 10) || 20));
  const offset = (page - 1) * pageSize;

  const where = [`v.origem IN (?, ?)`];
  const params = [VendaOrigin.FATURAMENTO, VendaOrigin.NF_AVULSA];

  // F12 ON: somente vendas fiscais (= já possuem registro em nfe_notas).
  if (modoFiscal) {
    where.push(`EXISTS (SELECT 1 FROM nfe_notas nx WHERE nx.venda_id = v.id)`);
  }

  if (aba === 'com_nfe') {
    where.push(`EXISTS (
      SELECT 1 FROM nfe_notas nx
      WHERE nx.venda_id = v.id
        AND LOWER(COALESCE(nx.status, '')) = 'autorizada'
    )`);
  } else if (aba === 'sem_nfe') {
    where.push(`NOT EXISTS (SELECT 1 FROM nfe_notas nx WHERE nx.venda_id = v.id)`);
  } else if (aba === 'pendentes') {
    // NF-e gerada, ainda não autorizada (reutiliza status atuais).
    where.push(`EXISTS (SELECT 1 FROM nfe_notas nx WHERE nx.venda_id = v.id)`);
    where.push(`NOT EXISTS (
      SELECT 1 FROM nfe_notas nx
      WHERE nx.venda_id = v.id
        AND LOWER(COALESCE(nx.status, '')) = 'autorizada'
    )`);
    where.push(`EXISTS (
      SELECT 1 FROM nfe_notas nx
      WHERE nx.venda_id = v.id
        AND LOWER(COALESCE(nx.status, '')) NOT IN ('autorizada', 'cancelada')
    )`);
  } else if (aba === 'canceladas') {
    where.push(`LOWER(COALESCE(v.status, '')) = 'cancelada'`);
  }

  // RC2 — filtros operacionais (mesma consulta; sem novas tabelas).
  const cliente = String(query.cliente || '').trim();
  if (cliente) {
    where.push(`(c.nome LIKE ? OR CAST(v.cliente_id AS TEXT) = ?)`);
    params.push(`%${cliente}%`, cliente);
  }

  const vendaId = String(query.venda_id || query.numero_venda || '').trim();
  if (vendaId) {
    where.push(`(CAST(v.id AS TEXT) = ? OR IFNULL(v.codigo, '') LIKE ?)`);
    params.push(vendaId, `%${vendaId}%`);
  }

  const pedidoId = String(query.pedido_id || query.numero_pedido || '').trim();
  if (pedidoId) {
    where.push(`CAST(v.pedido_id AS TEXT) = ?`);
    params.push(pedidoId);
  }

  const documento = String(query.documento || query.documento_fiscal || '').trim();
  if (documento) {
    where.push(`(
      CAST(IFNULL(nfe.numero, '') AS TEXT) LIKE ?
      OR IFNULL(nfe.chave_acesso, '') LIKE ?
      OR LOWER(IFNULL(nfe.status, '')) LIKE ?
    )`);
    const termoDoc = `%${documento}%`;
    params.push(termoDoc, termoDoc, `%${documento.toLowerCase()}%`);
  }

  const origemFiltro = String(query.origem || '').trim().toUpperCase();
  if (origemFiltro && origemFiltro !== 'TODAS' && origemFiltro !== 'ALL') {
    // Alias comercial Pedido → FATURAMENTO / PEDIDO
    if (origemFiltro === 'PEDIDO') {
      where.push(`UPPER(IFNULL(v.origem, '')) IN ('FATURAMENTO', 'PEDIDO')`);
    } else if (origemFiltro === 'NF_AVULSA' || origemFiltro === 'NFE_AVULSA') {
      where.push(`UPPER(IFNULL(v.origem, '')) = 'NF_AVULSA'`);
    } else {
      where.push(`UPPER(IFNULL(v.origem, '')) = ?`);
      params.push(origemFiltro);
    }
  }

  const dataInicio = String(query.data_inicio || query.dataInicio || '').trim().slice(0, 10);
  if (dataInicio) {
    where.push(`DATE(v.data_venda) >= DATE(?)`);
    params.push(dataInicio);
  }
  const dataFim = String(query.data_fim || query.dataFim || '').trim().slice(0, 10);
  if (dataFim) {
    where.push(`DATE(v.data_venda) <= DATE(?)`);
    params.push(dataFim);
  }

  const statusFiltro = String(query.status || '').trim().toLowerCase();
  if (statusFiltro && statusFiltro !== 'todos' && statusFiltro !== 'all') {
    where.push(`LOWER(IFNULL(v.status, '')) = ?`);
    params.push(statusFiltro);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = require('../../database');
  const sqlBase = `
    FROM vendas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN nfe_notas nfe ON nfe.id = (
      SELECT nfe2.id
      FROM nfe_notas nfe2
      WHERE nfe2.venda_id = v.id
      ORDER BY
        CASE WHEN LOWER(COALESCE(nfe2.status, '')) = 'autorizada' THEN 0 ELSE 1 END,
        nfe2.id DESC
      LIMIT 1
    )
    LEFT JOIN nfce_notas nfce ON nfce.id = (
      SELECT nfce2.id
      FROM nfce_notas nfce2
      WHERE nfce2.venda_id = v.id
      ORDER BY
        CASE WHEN LOWER(COALESCE(nfce2.status, '')) = 'autorizada' THEN 0 ELSE 1 END,
        nfce2.id DESC
      LIMIT 1
    )
    ${whereSql}
  `;

  const total = await new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS total ${sqlBase}`,
      params,
      (err, row) => (err ? reject(err) : resolve(Number(row && row.total) || 0))
    );
  });

  const rows = await new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        v.id,
        v.codigo,
        v.data_venda,
        v.created_at,
        v.cliente_id,
        v.total,
        v.valor_fiscal,
        v.valor_nao_fiscal,
        v.forma_pagamento,
        v.status,
        v.pedido_id,
        v.origem,
        c.nome AS cliente_nome,
        nfe.id AS nfe_id,
        nfe.numero AS nfe_numero,
        nfe.serie AS nfe_serie,
        nfe.status AS nfe_status,
        nfe.chave_acesso AS nfe_chave,
        nfe.protocolo AS nfe_protocolo,
        nfce.id AS nfce_id,
        nfce.numero AS nfce_numero,
        nfce.status AS nfce_status
      ${sqlBase}
      ORDER BY v.data_venda DESC, v.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset],
      (err, r) => (err ? reject(err) : resolve(r || []))
    );
  });

  const itens = rows.map(enriquecerItemCentral);

  return {
    success: true,
    aba,
    modo_operacional_fiscal: Boolean(modoFiscal),
    abas_disponiveis: disponiveis,
    page,
    pageSize,
    total,
    itens
  };
}

module.exports = {
  faturarPedido,
  finalizarVendaPdvPedido,
  listarVendasFaturadas,
  normalizarAbaCentral,
  abasDisponiveisCentral,
  rotuloOrigemCentral,
  classificarDocumentoCentral,
  enriquecerItemCentral,
  montarPayloadVendaDoPedido,
  extrairDadosNfe,
  assertModuloHabilitado,
  parseModoOperacionalFiscalFlag,
  modoOperacionalFiscalAtivo
};
