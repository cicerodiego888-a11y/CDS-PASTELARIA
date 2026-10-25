/**
 * PedidoOperacionalService — Sprint 3.5 + 3.14 (Orçamento) + RC3.16.1
 * Operações da UI comercial (listar/editar/cancelar/duplicar/enviar/converter).
 * NÃO altera FaturamentoService / Núcleo.
 *
 * RC3.16.1: validação/reserva fiscal via Motor Comercial (nunca F×NF/MTS direto).
 * Orçamento e Pedido compartilham a mesma entidade (tabela pedidos).
 * Conversão ORCAMENTO → PEDIDO altera status após confirmação fiscal.
 */

'use strict';

const configService = require('../configuracaoService');
const dbPadrao = require('../../database');
const {
  PedidoStatus,
  STATUS_ENVIAVEIS_FATURAMENTO,
  normalizarPedidoStatus
} = require('./enums');
const repo = require('./PedidoRepository');
const PedidoConsumoEstoqueService = require('./PedidoConsumoEstoqueService');
const PedidoPersonalizacaoService = require('./PedidoPersonalizacaoService');
const MesaService = require('./MesaService');
const VendaFinanceiroService = require('../vendas/VendaFinanceiroService');
const MotorComercial = require('../../motores/comercial');
const { empresaIdDoReqPedido } = require('./empresaIdDoReqPedido');
const {
  exigirEmpresaDaCriacao,
  exigirPedidoDaEmpresa,
  exigirOperacaoDoPedido,
  statusDeErroEmpresaPedido
} = require('../pedidos/PedidoEmpresaContextoService');

const { agoraLocalBrasil } = VendaFinanceiroService;
const TOLERANCIA_MONETARIA = 0.01;
const CAMPOS_SNAPSHOT_PRECO = [
  'preco_venda_snapshot',
  'preco_pedido_snapshot',
  'preco_sugerido_snapshot'
];
const ORIGENS_PRECO_SUGERIDO = new Set(['PRECO_PEDIDO', 'PROMOCAO', 'PRECO_VENDA']);

function assertModuloHabilitado() {
  if (!configService.recursoHabilitado('pedidos')) {
    const err = new Error('O módulo Pedidos não está habilitado para esta empresa.');
    err.statusCode = 403;
    err.codigo = 'MODULO_NAO_LICENCIADO';
    throw err;
  }
}

function assertExpedicaoHabilitada() {
  if (!configService.recursoHabilitado('expedicao')) {
    const err = new Error('Módulo Expedição desabilitado.');
    err.statusCode = 404;
    err.codigo = 'MODULO_FATURAMENTO_DESABILITADO';
    throw err;
  }
}

function normalizarItens(itensBrutos) {
  if (!Array.isArray(itensBrutos) || itensBrutos.length === 0) {
    const err = new Error('Informe ao menos um item no pedido.');
    err.statusCode = 400;
    throw err;
  }
  return itensBrutos.map((raw, idx) => {
    const produtoId = Number(raw.produto_id);
    const quantidade = Number(raw.quantidade);
    const preco = Number(raw.preco_unitario);
    const desconto = Number(raw.desconto_percentual || 0);
    const subtotal = raw.subtotal != null
      ? Number(raw.subtotal)
      : Number((quantidade * preco * (1 - desconto / 100)).toFixed(2));
    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      const err = new Error(`Item ${idx + 1}: produto inválido.`);
      err.statusCode = 400;
      throw err;
    }
    if (!(quantidade > 0) || !(preco >= 0) || !(subtotal >= 0)) {
      const err = new Error(`Item ${idx + 1}: quantidade/preço/subtotal inválidos.`);
      err.statusCode = 400;
      throw err;
    }
    const item = {
      produto_id: produtoId,
      quantidade,
      preco_unitario: preco,
      desconto_percentual: desconto,
      subtotal,
      tipo_venda: raw.tipo_venda || 'PESO',
      id: raw.id != null ? Number(raw.id) : undefined
    };
    if (Object.prototype.hasOwnProperty.call(raw, 'preco_base_unitario')) {
      item.preco_base_unitario = raw.preco_base_unitario;
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'ingredientes_selecionados')) {
      item.ingredientes_selecionados = raw.ingredientes_selecionados;
    }
    for (const campo of CAMPOS_SNAPSHOT_PRECO) {
      if (!Object.prototype.hasOwnProperty.call(raw, campo)) continue;
      const valorBruto = raw[campo];
      if (valorBruto == null || valorBruto === '') {
        item[campo] = null;
        continue;
      }
      const valor = Number(valorBruto);
      if (!Number.isFinite(valor) || valor < 0) {
        const err = new Error(`Item ${idx + 1}: ${campo} inválido.`);
        err.statusCode = 400;
        throw err;
      }
      item[campo] = valor;
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'origem_preco_sugerido')) {
      const origemBruta = raw.origem_preco_sugerido;
      const origem = origemBruta == null || origemBruta === ''
        ? null
        : String(origemBruta).trim().toUpperCase();
      if (origem != null && !ORIGENS_PRECO_SUGERIDO.has(origem)) {
        const err = new Error(`Item ${idx + 1}: origem_preco_sugerido inválida.`);
        err.statusCode = 400;
        throw err;
      }
      item.origem_preco_sugerido = origem;
    }
    return item;
  });
}

async function montarCabecalho(body = {}, opcoes = {}) {
  const itens = normalizarItens(body.itens);
  await PedidoPersonalizacaoService.prepararItens(itens, body.itens, opcoes);
  const somaItens = Number(itens.reduce((s, i) => s + Number(i.subtotal || 0), 0).toFixed(2));
  const desconto = Number(body.desconto || 0);
  const frete = Number(body.frete || 0);
  const totalEsperado = Number((somaItens - desconto + frete).toFixed(2));
  const totalInformado = body.total != null ? Number(body.total) : null;
  const total = totalInformado != null ? totalInformado : totalEsperado;
  if (
    totalInformado != null
    && Math.abs(Number((totalInformado - totalEsperado).toFixed(2))) > TOLERANCIA_MONETARIA
  ) {
    const err = new Error(
      `Total do pedido inconsistente com os itens (esperado ${totalEsperado.toFixed(2)}).`
    );
    err.statusCode = 400;
    err.codigo = 'PEDIDO_TOTAL_INCONSISTENTE';
    throw err;
  }
  if (!(total >= 0) || !(somaItens > 0)) {
    const err = new Error('Total do pedido inválido.');
    err.statusCode = 400;
    throw err;
  }
  return {
    itens,
    desconto,
    frete,
    total,
    clienteId: body.cliente_id != null && body.cliente_id !== '' ? Number(body.cliente_id) : null,
    representanteId: body.representante_id != null ? Number(body.representante_id) : null,
    representanteNome: body.representante_nome != null ? String(body.representante_nome).trim() : null,
    observacao: body.observacao || null,
    mesaId: body.mesa_id === undefined
      ? undefined
      : (body.mesa_id === null || body.mesa_id === '' ? null : body.mesa_id),
    supervisorToken: body.supervisor_token || body.supervisorToken || null
  };
}

/** Resolve status inicial: UI pode enviar status ou tipo (orcamento|pedido). */
function resolverStatusInicial(body = {}) {
  const tipo = String(body.tipo || body.tipo_documento || '').toLowerCase().trim();
  if (tipo === 'orcamento' || tipo === 'orçamento') {
    return PedidoStatus.ORCAMENTO;
  }
  if (tipo === 'pedido') {
    return PedidoStatus.PEDIDO;
  }
  const status = normalizarPedidoStatus(body.status);
  if (status) return status;
  return PedidoStatus.PEDIDO;
}

function empresaDoContexto(opcoes = {}) {
  return exigirEmpresaDaCriacao({
    empresaId: empresaIdDoReqPedido({ empresaId: opcoes.empresaId })
  });
}

function anexarStatusOwnership(err) {
  if (err && !err.statusCode) {
    err.statusCode = statusDeErroEmpresaPedido(err);
  }
  if (err && !err.codigo && err.code) err.codigo = err.code;
  return err;
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

async function tabelaExiste(db, nome) {
  const row = await dbGet(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [nome]
  );
  return Boolean(row);
}

async function bloquearCancelamentoComVenda(db, pedido, empresaId) {
  const vendaId = Number(pedido.venda_id);
  if (!Number.isInteger(vendaId) || vendaId <= 0) return;

  if (!(await tabelaExiste(db, 'vendas'))) {
    const err = new Error(
      'O pedido possui venda vinculada, mas o estado da venda não pôde ser verificado. O cancelamento foi bloqueado.'
    );
    err.statusCode = 409;
    err.codigo = 'PEDIDO_VENDA_VINCULADA_ESTADO_INDISPONIVEL';
    throw err;
  }
  const venda = await dbGet(
    db,
    'SELECT id, empresa_id, status, cancelada FROM vendas WHERE id = ?',
    [vendaId]
  );
  if (!venda) {
    const err = new Error(
      'O pedido possui uma referência de venda não localizada. O cancelamento foi bloqueado para preservar o estoque.'
    );
    err.statusCode = 409;
    err.codigo = 'PEDIDO_VENDA_VINCULADA_NAO_ENCONTRADA';
    throw err;
  }
  if (venda.empresa_id != null && Number(venda.empresa_id) !== Number(empresaId)) {
    const err = new Error('A venda vinculada não pertence à empresa do pedido.');
    err.statusCode = 409;
    err.codigo = 'PEDIDO_VENDA_EMPRESA_DIVERGENTE';
    throw err;
  }

  const documentos = [];
  for (const tabela of ['nfe_notas', 'nfce_notas']) {
    if (!(await tabelaExiste(db, tabela))) {
      documentos.push({ tabela, estado: 'indisponivel' });
      continue;
    }
    const notas = await dbAll(
      db,
      `SELECT id, status FROM ${tabela} WHERE venda_id = ? ORDER BY id`,
      [vendaId]
    );
    documentos.push(...notas.map((nota) => ({
      tabela,
      id: Number(nota.id),
      status: String(nota.status || '').toLowerCase()
    })));
  }

  const fiscalAutorizado = documentos.some((documento) =>
    ['autorizada', 'cancelamento_em_andamento', 'cancelamento_rejeitado'].includes(documento.status)
  );
  const estadoFiscal = fiscalAutorizado
    ? 'há documento fiscal autorizado ou com cancelamento pendente'
    : documentos.some((documento) => documento.estado === 'indisponivel')
      ? 'o estado dos documentos fiscais não pôde ser verificado'
      : 'o fluxo de cancelamento da venda não está integrado ao cancelamento do pedido';
  const err = new Error(
    `Pedido vinculado à venda ${vendaId} (${venda.status || 'status indisponível'}); ${estadoFiscal}. Cancele ou regularize a venda pelo fluxo próprio antes de cancelar o pedido.`
  );
  err.statusCode = 409;
  err.codigo = fiscalAutorizado
    ? 'PEDIDO_VENDA_DOCUMENTO_FISCAL_VINCULADO'
    : 'PEDIDO_VENDA_VINCULADA';
  err.detalhes = { venda_id: vendaId, venda_status: venda.status || null, documentos };
  throw err;
}

async function executarTransacaoPedido(db, operacao) {
  await new Promise((resolve, reject) => {
    db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve()));
  });
  try {
    const resultado = await operacao();
    await new Promise((resolve, reject) => {
      db.run('COMMIT', (err) => (err ? reject(err) : resolve()));
    });
    return resultado;
  } catch (err) {
    try {
      await new Promise((resolve, reject) => {
        db.run('ROLLBACK', (rollbackErr) => (rollbackErr ? reject(rollbackErr) : resolve()));
      });
    } catch (_) { /* preserve the operation error */ }
    throw err;
  }
}

function statusExigeConfirmacaoFiscal(status) {
  return [
    PedidoStatus.PEDIDO,
    PedidoStatus.ABERTO,
    PedidoStatus.EM_SEPARACAO,
    PedidoStatus.AGUARDANDO_FATURAMENTO
  ].includes(status);
}

async function exigirPedidoEditavel(pedido, db) {
  const estadoEdicao = await repo.obterEstadoEdicao(pedido, { db });
  if (estadoEdicao.edicao_bloqueada) {
    throw repo.criarErroPedidoImutavel(pedido, estadoEdicao);
  }
  return estadoEdicao;
}

/**
 * Confirma estoque fiscal via Motor Comercial (única ponte).
 * Pedido NÃO conhece F×NF nem MTS.
 */
async function confirmarEstoqueViaMotorComercial({
  pedidoId,
  itens,
  supervisorToken,
  usuarioId,
  motivo,
  empresaId
}, deps = {}) {
  try {
    return await MotorComercial.confirmarPedidoFiscal({
      pedidoId,
      itens,
      supervisorToken,
      usuarioId,
      motivo,
      empresaId
    }, deps);
  } catch (err) {
    throw anexarStatusOwnership(err);
  }
}

async function listar(filtros = {}) {
  assertModuloHabilitado();
  const empresaId = empresaDoContexto(filtros);
  const itens = await repo.listarPedidos({ ...filtros, empresaId });
  return { success: true, itens };
}

async function obter(pedidoId, opcoes = {}) {
  assertModuloHabilitado();
  const empresaId = empresaDoContexto(opcoes);
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Pedido inválido.');
    err.statusCode = 400;
    throw err;
  }
  const db = opcoes.db || dbPadrao;
  const pedido = await repo.obterPorId(id, { db });
  if (!pedido) {
    const err = new Error('Pedido não encontrado.');
    err.statusCode = 404;
    err.codigo = 'PEDIDO_NAO_ENCONTRADO';
    throw err;
  }
  exigirPedidoDaEmpresa(pedido, empresaId);
  Object.assign(pedido, await repo.obterEstadoEdicao(pedido, { db }));
  return { success: true, pedido };
}

async function criar(body = {}, operadorId = null, opcoes = {}) {
  assertModuloHabilitado();
  const empresaId = empresaDoContexto(opcoes);
  const db = opcoes.db || dbPadrao;
  const cab = await montarCabecalho(body, { db });
  // Canal definido apenas por código servidor (EntradaPedidoService); nunca lido de body.
  const origemCanal = opcoes.origemCanal || null;
  const status = resolverStatusInicial(body);
  if ([PedidoStatus.FATURADO, PedidoStatus.CANCELADO].includes(status)) {
    const err = new Error('Status inicial inválido.');
    err.statusCode = 400;
    throw err;
  }
  const agora = agoraLocalBrasil();
  const dataPedido = String(body.data_pedido || agora).slice(0, 10);
  const prefixo = status === PedidoStatus.ORCAMENTO ? 'ORC' : 'PED';
  const codigo = String(body.codigo || `${prefixo}-${Date.now()}`).trim();
  const chaveIdempotencia = opcoes.chaveIdempotencia
    ? PedidoConsumoEstoqueService.normalizarChaveIdempotencia(opcoes.chaveIdempotencia)
    : null;
  if (opcoes.exigirChaveIdempotencia && !chaveIdempotencia) {
    PedidoConsumoEstoqueService.normalizarChaveIdempotencia(null);
  }
  const bodyParaHash = { ...body };
  delete bodyParaHash.supervisor_token;
  delete bodyParaHash.supervisorToken;
  const requisicaoHash = PedidoConsumoEstoqueService.hashRequisicao({
    empresaId,
    origemCanal,
    body: bodyParaHash
  });

  await PedidoConsumoEstoqueService.garantirSchema(db);
  await new Promise((resolve, reject) => {
    db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve()));
  });
  let pedidoId;
  let repetido = false;
  let mesaId;
  try {
    const existenteId = await PedidoConsumoEstoqueService.obterPedidoIdempotente(
      db,
      empresaId,
      chaveIdempotencia,
      requisicaoHash
    );
    if (existenteId) {
      pedidoId = existenteId;
      repetido = true;
    } else {
      mesaId = await MesaService.validarMesaDoPedido(empresaId, cab.mesaId);
      pedidoId = await repo.criarPedido({
        codigo,
        dataPedido,
        clienteId: cab.clienteId,
        total: cab.total,
        desconto: cab.desconto,
        frete: cab.frete,
        status,
        representanteId: cab.representanteId,
        representanteNome: cab.representanteNome,
        observacao: cab.observacao,
        operadorId,
        empresaId,
        mesaId,
        origemCanal,
        itens: cab.itens,
        db,
        jaEmTransacao: true
      });

      if (statusExigeConfirmacaoFiscal(status)) {
        const pedido = await repo.obterPorId(pedidoId, { db });
        await PedidoConsumoEstoqueService.reservarConsumo({
          db,
          pedidoId,
          empresaId,
          usuarioId: operadorId,
          itens: pedido.itens || [],
          supervisorToken: cab.supervisorToken,
          jaEmTransacao: true
        });
      }

      await PedidoConsumoEstoqueService.registrarPedidoIdempotente(
        db,
        empresaId,
        chaveIdempotencia,
        requisicaoHash,
        pedidoId
      );
    }
    await new Promise((resolve, reject) => {
      db.run('COMMIT', (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    try {
      await new Promise((resolve, reject) => {
        db.run('ROLLBACK', (rollbackErr) => (rollbackErr ? reject(rollbackErr) : resolve()));
      });
    } catch (_) { /* preserve the operation error */ }
    throw anexarStatusOwnership(err);
  }

  const pedido = await repo.obterPorId(pedidoId, { db });
  exigirPedidoDaEmpresa(pedido, empresaId);
  return { success: true, pedido, ...(repetido ? { idempotente: true } : {}) };
}

async function atualizar(pedidoId, body = {}, opcoes = {}) {
  assertModuloHabilitado();
  const empresaIdContexto = empresaDoContexto(opcoes);
  const db = opcoes.db || dbPadrao;
  const id = Number(pedidoId);
  const existente = await repo.obterPorId(id, { db });
  const empresaId = exigirOperacaoDoPedido(existente, empresaIdContexto);
  await exigirPedidoEditavel(existente, db);
  const cab = await montarCabecalho(body, { db, itensExistentes: existente.itens || [] });

  // Mesa só é revalidada (ativa e da empresa) quando muda; pedido existente pode manter mesa desativada depois.
  let mesaAtualizada;
  if (cab.mesaId !== undefined) {
    const mesaAtual = existente.mesa_id != null ? Number(existente.mesa_id) : null;
    const mesaNova = cab.mesaId == null ? null : Number(cab.mesaId);
    mesaAtualizada = await MesaService.validarMesaDoPedido(empresaId, cab.mesaId, {
      permitirInativa: mesaNova != null && mesaNova === mesaAtual
    });
  }

  await PedidoConsumoEstoqueService.garantirSchema(db);
  await executarTransacaoPedido(db, async () => {
    const atual = await repo.obterPorId(id, { db });
    const empresaAtual = exigirOperacaoDoPedido(atual, empresaIdContexto);
    await exigirPedidoEditavel(atual, db);
    await repo.substituirPedido({
      pedidoId: id,
      clienteId: cab.clienteId,
      total: cab.total,
      desconto: cab.desconto,
      frete: cab.frete,
      representanteId: cab.representanteId,
      representanteNome: cab.representanteNome,
      observacao: cab.observacao,
      itens: cab.itens,
      mesaId: mesaAtualizada,
      empresaId: empresaAtual,
      db,
      jaEmTransacao: true
    });
    if (statusExigeConfirmacaoFiscal(atual.status)) {
      const pedido = await repo.obterPorId(id, { db });
      await PedidoConsumoEstoqueService.reservarConsumo({
        db,
        pedidoId: id,
        empresaId: empresaAtual,
        usuarioId: opcoes.usuarioId || null,
        itens: pedido.itens || cab.itens,
        supervisorToken: cab.supervisorToken,
        jaEmTransacao: true
      });
    }
  });

  return obter(id, { empresaId, db });
}

async function cancelar(pedidoId, opcoes = {}) {
  assertModuloHabilitado();
  const empresaIdContexto = empresaDoContexto(opcoes);
  const db = opcoes.db || dbPadrao;
  const id = Number(pedidoId);
  const existente = await repo.obterPorId(id, { db });
  let empresaId = exigirOperacaoDoPedido(existente, empresaIdContexto);
  if (await PedidoConsumoEstoqueService.jaConsumido(id, { db })) {
    await PedidoConsumoEstoqueService.garantirSchema(db);
    let resultadoEstorno;
    await executarTransacaoPedido(db, async () => {
      const atual = await repo.obterPorId(id, { db });
      empresaId = exigirOperacaoDoPedido(atual, empresaIdContexto);
      if (!(await PedidoConsumoEstoqueService.jaConsumido(id, { db }))) {
        const err = new Error('O consumo do pedido não está mais disponível para estorno.');
        err.statusCode = 409;
        err.codigo = 'PEDIDO_CONSUMO_NAO_ENCONTRADO';
        throw err;
      }

      if (atual.status === PedidoStatus.CANCELADO) {
        const estornoExistente = await PedidoConsumoEstoqueService.obterEstornoPorPedido(id, { db });
        if (!estornoExistente) {
          const err = new Error(
            'O pedido já está cancelado, mas não há estorno registrado. O saldo não foi alterado.'
          );
          err.statusCode = 409;
          err.codigo = 'PEDIDO_CANCELADO_COM_CONSUMO_SEM_ESTORNO';
          throw err;
        }
        resultadoEstorno = await PedidoConsumoEstoqueService.solicitarEstorno({
          db,
          pedidoId: id,
          empresaId,
          usuarioId: opcoes.usuarioId,
          chaveIdempotencia: opcoes.chaveIdempotencia,
          jaEmTransacao: true
        });
        return;
      }

      if (atual.status === PedidoStatus.FATURADO) {
        const err = new Error('Pedido faturado não pode ser cancelado por esta tela.');
        err.statusCode = 400;
        throw err;
      }
      await bloquearCancelamentoComVenda(db, atual, empresaId);

      resultadoEstorno = await PedidoConsumoEstoqueService.solicitarEstorno({
        db,
        pedidoId: id,
        empresaId,
        usuarioId: opcoes.usuarioId,
        chaveIdempotencia: opcoes.chaveIdempotencia,
        jaEmTransacao: true
      });
      await MotorComercial.liberarReservasDoPedido(id, {
        db,
        executarEmTransacao: async (work, opcoesMotor = {}) => work(opcoesMotor.db || db)
      });
      const ok = await repo.atualizarStatus(id, PedidoStatus.CANCELADO, [
        PedidoStatus.ORCAMENTO,
        PedidoStatus.PEDIDO,
        PedidoStatus.ABERTO,
        PedidoStatus.EM_SEPARACAO,
        PedidoStatus.AGUARDANDO_FATURAMENTO
      ], { empresaId, db });
      if (!ok) {
        const err = new Error('Não foi possível cancelar o pedido.');
        err.statusCode = 409;
        err.codigo = 'PEDIDO_CANCELAMENTO_CONCORRENTE';
        throw err;
      }
    });
    const pedidoAtualizado = await obter(id, { empresaId, db });
    return {
      success: true,
      pedido: pedidoAtualizado.pedido || pedidoAtualizado,
      estorno: resultadoEstorno,
      ja_cancelado: resultadoEstorno?.ja_estornado === true
    };
  }
  if (existente.status === PedidoStatus.FATURADO) {
    const err = new Error('Pedido faturado não pode ser cancelado por esta tela.');
    err.statusCode = 400;
    throw err;
  }
  if (existente.status === PedidoStatus.CANCELADO) {
    return { success: true, pedido: existente };
  }

  await MotorComercial.liberarReservasDoPedido(id, { empresaId, db });

  const ok = await repo.atualizarStatus(id, PedidoStatus.CANCELADO, [
    PedidoStatus.ORCAMENTO,
    PedidoStatus.PEDIDO,
    PedidoStatus.ABERTO,
    PedidoStatus.EM_SEPARACAO,
    PedidoStatus.AGUARDANDO_FATURAMENTO
  ], { empresaId, db });
  if (!ok) {
    const err = new Error('Não foi possível cancelar o pedido.');
    err.statusCode = 400;
    throw err;
  }
  return obter(id, { empresaId, db });
}

/** Exclusão física — somente Orçamento. */
async function excluir(pedidoId, opcoes = {}) {
  assertModuloHabilitado();
  const empresaId = empresaDoContexto(opcoes);
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Pedido inválido.');
    err.statusCode = 400;
    throw err;
  }
  const db = opcoes.db || dbPadrao;
  const existente = await repo.obterPorId(id, { db });
  exigirOperacaoDoPedido(existente, empresaId);
  await exigirPedidoEditavel(existente, db);
  await repo.excluirOrcamento(id, { empresaId, db });
  return { success: true, excluido: true, id };
}

async function duplicar(pedidoId, operadorId = null, opcoes = {}) {
  assertModuloHabilitado();
  const { pedido } = await obter(pedidoId, opcoes);
  const statusCopia = pedido.status === PedidoStatus.ORCAMENTO
    ? PedidoStatus.ORCAMENTO
    : PedidoStatus.PEDIDO;
  return criar({
    cliente_id: pedido.cliente_id,
    representante_id: pedido.representante_id,
    representante_nome: pedido.representante_nome,
    observacao: pedido.observacao ? `Cópia de ${pedido.codigo}: ${pedido.observacao}` : `Cópia de ${pedido.codigo}`,
    desconto: pedido.desconto,
    frete: pedido.frete,
    status: statusCopia,
    itens: (pedido.itens || []).map((i) => ({
      produto_id: i.produto_id,
      quantidade: i.quantidade,
      preco_unitario: i.preco_unitario,
      desconto_percentual: i.desconto_percentual,
      subtotal: i.subtotal,
      tipo_venda: i.tipo_venda,
      preco_venda_snapshot: i.preco_venda_snapshot ?? null,
      preco_pedido_snapshot: i.preco_pedido_snapshot ?? null,
      preco_sugerido_snapshot: i.preco_sugerido_snapshot ?? null,
      origem_preco_sugerido: i.origem_preco_sugerido ?? null,
      ...(Number(i.personalizacao_ingredientes_snapshot) === 1 ? {
        preco_base_unitario: i.preco_base_unitario_snapshot,
        ingredientes_selecionados: (i.ingredientes_personalizados || [])
          .filter((ingrediente) => Number(ingrediente.selecionado) === 1
            && ingrediente.classificacao_comercial_snapshot !== 'OBRIGATORIO_OCULTO')
          .map((ingrediente) => Number(ingrediente.insumo_id))
      } : {})
    }))
  }, operadorId, opcoes);
}

/**
 * Converte Orçamento em Pedido — confirma estoque fiscal via Motor Comercial.
 */
async function converterParaPedido(pedidoId, body = {}, operadorId = null, opcoes = {}) {
  assertModuloHabilitado();
  const empresaIdContexto = empresaDoContexto(opcoes);
  const id = Number(pedidoId);
  const db = opcoes.db || dbPadrao;
  await PedidoConsumoEstoqueService.garantirSchema(db);
  let jaConvertido = false;
  let empresaId;
  await executarTransacaoPedido(db, async () => {
    const existente = await repo.obterPorId(id, { db });
    empresaId = exigirOperacaoDoPedido(existente, empresaIdContexto);
    if (existente.status === PedidoStatus.PEDIDO) {
      jaConvertido = true;
      return;
    }
    if (existente.status !== PedidoStatus.ORCAMENTO) {
      const err = new Error('Somente orçamentos podem ser convertidos em pedido.');
      err.statusCode = 400;
      throw err;
    }

    const supervisorToken = body.supervisor_token || body.supervisorToken || null;
    await PedidoConsumoEstoqueService.reservarConsumo({
      db,
      pedidoId: id,
      empresaId,
      usuarioId: operadorId,
      itens: existente.itens || [],
      supervisorToken,
      jaEmTransacao: true
    });

    const ok = await repo.atualizarStatus(
      id,
      PedidoStatus.PEDIDO,
      [PedidoStatus.ORCAMENTO],
      { empresaId, db }
    );
    if (!ok) {
      const err = new Error('Falha ao converter orçamento em pedido.');
      err.statusCode = 400;
      throw err;
    }
  });
  const resultado = await obter(id, { empresaId, db });
  return jaConvertido ? { ...resultado, ja_convertido: true } : resultado;
}

/** Envia para a fila do Faturamento (não fatura). Orçamento nunca entra na fila. */
async function enviarParaFaturamento(pedidoId, body = {}, operadorId = null, opcoes = {}) {
  assertModuloHabilitado();
  assertExpedicaoHabilitada();
  const empresaIdContexto = empresaDoContexto(opcoes);
  const id = Number(pedidoId);
  const db = opcoes.db || dbPadrao;
  const existente = await repo.obterPorId(id, { db });
  const empresaId = exigirOperacaoDoPedido(existente, empresaIdContexto);
  if (existente.status === PedidoStatus.ORCAMENTO) {
    const err = new Error('Orçamento não pode ser faturado. Converta em Pedido primeiro.');
    err.statusCode = 400;
    err.codigo = 'ORCAMENTO_NAO_FATURAVEL';
    throw err;
  }
  if (existente.status === PedidoStatus.AGUARDANDO_FATURAMENTO) {
    return { success: true, pedido: existente, ja_enviado: true };
  }
  if (!STATUS_ENVIAVEIS_FATURAMENTO.includes(existente.status)) {
    const err = new Error('Somente pedidos comerciais podem ser enviados ao faturamento.');
    err.statusCode = 400;
    throw err;
  }
  if (!(existente.itens || []).length) {
    const err = new Error('Pedido sem itens.');
    err.statusCode = 400;
    throw err;
  }

  await PedidoConsumoEstoqueService.garantirSchema(db);
  await executarTransacaoPedido(db, async () => {
    const pedidoAtual = await repo.obterPorId(id, { db });
    exigirOperacaoDoPedido(pedidoAtual, empresaId);
    if (!STATUS_ENVIAVEIS_FATURAMENTO.includes(pedidoAtual.status)) {
      const err = new Error('Somente pedidos comerciais podem ser enviados ao faturamento.');
      err.statusCode = 400;
      throw err;
    }
    const supervisorToken = body.supervisor_token || body.supervisorToken || null;
    await PedidoConsumoEstoqueService.reservarConsumo({
      db,
      pedidoId: id,
      empresaId,
      usuarioId: operadorId,
      itens: pedidoAtual.itens || [],
      supervisorToken,
      jaEmTransacao: true
    });
    const ok = await repo.atualizarStatus(
      id,
      PedidoStatus.AGUARDANDO_FATURAMENTO,
      [...STATUS_ENVIAVEIS_FATURAMENTO],
      { empresaId, db }
    );
    if (!ok) {
      const err = new Error('Falha ao enviar para faturamento.');
      err.statusCode = 400;
      throw err;
    }
  });
  return obter(id, { empresaId, db });
}

module.exports = {
  listar,
  obter,
  criar,
  atualizar,
  cancelar,
  excluir,
  duplicar,
  converterParaPedido,
  enviarParaFaturamento,
  empresaIdDoReqPedido,
  confirmarEstoqueViaMotorComercial
};
