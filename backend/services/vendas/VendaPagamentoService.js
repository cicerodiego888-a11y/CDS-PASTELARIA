'use strict';

const db = require('../../database');
const moment = require('moment');
const configService = require('../configuracaoService');
const tefManager = require('../tef/TefManager');
const tefContrato = require('../tef/tefContrato');
const tefFluxoPagamento = require('../tef/tefFluxoPagamento');
const tefConfigService = require('../tef/tefConfigService');
const lotesService = require('../lotesService');
const { normalizarTipoVendaItem } = require('../vendaUnidadeHelpers');
const { separarItensDistribuidos } = require('../fiscalNaoFiscalService');
const OrquestradorPagamento = require('../OrquestradorPagamento');
const { montarParcelasReceber } = require('./ParcelasReceber');
const { parseVendaFiscalFlag, distribuirItensVendaComValorFiscalEfetivo } = require('../distribuidorEstoqueVenda');
const mpfc = require('../mpfc');
const {
  obterCreditoReservaPedidoCb,
  creditarDisponibilidadeComReservaPedido
} = require('../estoque/pedidoReservaPonteNucleo');
const {
  debitarEstoqueItemVenda,
  montarOpcoesBaixaEstoqueVenda
} = require('./debitoEstoqueVendaViaPorta');
const { aplicarSaldosDisponibilidadeVenda } = require('../estoque/leituraEstoqueEmpresaProduto');
const { exigirProdutosVendaveisNaVenda } = require('../produtos/tipoOperacionalProduto');
const {
  exigirEmpresaDaOperacao,
  exigirCaixaCompativelComVenda,
  resolverEmpresaIdParaVenda,
  exigirVendaDaEmpresa,
  responderErroEmpresaVenda
} = require('./VendaEmpresaContextoService');
const {
  validarReferenciasPersistenciaVenda
} = require('./VendaReferenciaIntegridade');
const {
  classificarFormaPagamento
} = require('./ClassificacaoModalidadePagamento');
const {
  avaliarReferenciaRecomposicao,
  ambienteTesteRecomposicaoReferencia,
  gravarReferenciaRecomposicao
} = require('./PagamentoSequencialComposicaoService');
const {
  devePreservarItensComposicaoPedido,
  decisaoEmissaoComposicaoPreservada
} = require('./FechamentoComposicaoPedidoContrato');
const { registroFinanceiroParcela } = require('./registroTrocoDinheiro');

/**
 * RC8.2 — carrega MPFC e entrega política aos consumidores.
 * midpAtivo / preservarDinheiro vêm exclusivamente da política (não de leitura direta no F×NF).
 */
function carregarPoliticaFiscalComercialPassiva(opcoes = {}) {
  const politica = mpfc.obterPolitica(opcoes);
  const comercial = mpfc.receberPoliticaMotorComercial(politica);
  const fiscalNaoFiscal = mpfc.receberPoliticaMotorFiscalNaoFiscal(politica);
  const snapshot = mpfc.prepararSnapshot(politica);
  return { politica, comercial, fiscalNaoFiscal, snapshot };
}

/**
 * RC8.2 — validação comercial de margem (domínio comercial exclusivo).
 */
function validarMargemPoliticaComercial(itens, produtoMap, politica) {
  return mpfc.validarMargemMinimaComercial(itens, produtoMap, politica);
}

/**
 * RC3.15.11 — prioridade fiscal do estoque ≠ emissão de NFC-e.
 * - venda_fiscal: informa o Motor F×NF (priorizar saldo fiscal)
 * - emitir_fiscal: informa se o núcleo deve emitir NFC-e
 * Retrocompatível: se venda_fiscal ausente, usa emitir_fiscal (PDV).
 */
function resolverVendaFiscalParaMotor(body = {}) {
  if (body.venda_fiscal !== undefined && body.venda_fiscal !== null && body.venda_fiscal !== '') {
    return parseVendaFiscalFlag(body.venda_fiscal);
  }
  return parseVendaFiscalFlag(body.emitir_fiscal);
}

/**
 * HOTFIX FISCAL-4.0.2 — totais oficiais para validação de pagamento.
 * Prefere valorFiscalLiquido / valorNaoFiscalLiquido do Motor; espelha itens se ausente.
 */
function resolverTotaisFiscaisLiquidosMotor(resultadoMotor, distribuicaoItens) {
  const espelho = separarItensDistribuidos(distribuicaoItens || []);
  const totalFiscal = Number(
    resultadoMotor && resultadoMotor.valorFiscalLiquido != null
      ? resultadoMotor.valorFiscalLiquido
      : (resultadoMotor && resultadoMotor.valorFiscalEfetivo != null
        ? resultadoMotor.valorFiscalEfetivo
        : espelho.totalFiscal)
  );
  const totalNaoFiscal = Number(
    resultadoMotor && resultadoMotor.valorNaoFiscalLiquido != null
      ? resultadoMotor.valorNaoFiscalLiquido
      : (resultadoMotor && resultadoMotor.valorNaoFiscal != null
        ? resultadoMotor.valorNaoFiscal
        : espelho.totalNaoFiscal)
  );
  return {
    totalFiscal: Math.round((totalFiscal || 0) * 100) / 100,
    totalNaoFiscal: Math.round((totalNaoFiscal || 0) * 100) / 100
  };
}

const VendaFinanceiroService = require('./VendaFinanceiroService');
const VendaFiscalService = require('./VendaFiscalService');

const { agoraLocalBrasil, validarSomaPagamentosVenda } = VendaFinanceiroService;
const { emitirFiscalSeSolicitado, responderVendaComFiscal } = VendaFiscalService;

/**
 * Enriquece SQLITE FOREIGN KEY com a etapa e IDs relevantes (diagnóstico PDV).
 */
function erroPersistenciaVenda(err, etapa, ctx = {}) {
  const msg = String((err && err.message) || err || 'Erro ao gravar venda');
  if (err && err.codigo && !/FOREIGN KEY/i.test(msg)) {
    return {
      error: msg,
      codigo: err.codigo,
      etapa,
      referencia: err.referencia || null
    };
  }
  if (/FOREIGN KEY/i.test(msg)) {
    const detalhe = Object.entries(ctx || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return {
      error:
        `Integridade do banco na etapa "${etapa}" (FOREIGN KEY).` +
        (detalhe ? ` Refs: ${detalhe}.` : '') +
        ' Confira caixa/turno, terminal, operador, cliente e produto.',
      codigo: 'FK_CONSTRAINT',
      etapa
    };
  }
  return { error: msg, etapa };
}

function atualizarSaldoProdutoAposBaixa(produtoId, quantidade, itemFiscal, callback, opcoes = {}) {
  const qtd = Number(quantidade || 0);
  const fiscal = Number(itemFiscal) === 1;
  debitarEstoqueItemVenda(opcoes.db || db, {
    produtoId,
    quantidadeFiscal: fiscal ? qtd : 0,
    quantidadeNaoFiscal: fiscal ? 0 : qtd,
    empresaId: opcoes.empresaId ?? opcoes.empresa_id,
    usuarioId: opcoes.usuarioId,
    exigirEmpresa: opcoes.exigirEmpresa,
    origem: opcoes.origem || 'baixa_venda',
    validarEmpresa: opcoes.validarEmpresa
  }, callback);
}

function reduzirEstoqueComFEFO(vendaItemId, produtoId, quantidade, itemFiscal, callback, opcoes = {}) {
    lotesService.produtoControlaValidade(produtoId, (err, controlaValidade) => {
    if (err) return callback(err);

    if (!controlaValidade) {
      return atualizarSaldoProdutoAposBaixa(produtoId, quantidade, itemFiscal, callback, opcoes);
    }

    const opcoesLote = {
      db: opcoes.db || db,
      empresaId: opcoes.empresaId ?? opcoes.empresa_id
    };

    // Produto controla validade - usar FEFO empresarial
    lotesService.consumirLotesFEFO(produtoId, quantidade, (consumoErr, consumoLotes) => {
      if (consumoErr) return callback(consumoErr);

      const aposRegistro = (registroErr) => {
        if (registroErr) return callback(registroErr);
        atualizarSaldoProdutoAposBaixa(produtoId, quantidade, itemFiscal, callback, opcoes);
      };

      // Sem item válido não grava venda_lotes (evita FK órfã); baixa de lote já ocorreu
      if (vendaItemId == null || Number(vendaItemId) <= 0) {
        return aposRegistro(null);
      }

      const dbConn = opcoes.db || db;
      dbConn.get('SELECT id FROM vendas_itens WHERE id = ?', [vendaItemId], (itemLookupErr, itemRow) => {
        if (itemLookupErr) return callback(itemLookupErr);
        if (!itemRow) return aposRegistro(null);
        lotesService.registrarConsumoVenda(vendaItemId, consumoLotes, aposRegistro, opcoesLote);
      });
    }, opcoesLote);
  }, { db: opcoes.db || db });
}

function reduzirEstoqueDistribuido(
  vendaItemId,
  produtoId,
  quantidadeFiscal,
  quantidadeNaoFiscal,
  callback,
  opcoes = {}
) {
  const { produtoControlaEstoque } = require('../estoque/produtoControlaEstoque');
  const dbConn = opcoes.db || db;
  if (opcoes.pedidoJaConsumido) {
    return callback(null);
  }
  if (opcoes.baixaAutomatica === false || opcoes.modoEstoque === 'MANUAL') {
    return callback(null);
  }

  const executarBaixaProduto = () => {
    dbConn.get(
      `SELECT COALESCE(controla_estoque, 1) AS controla_estoque FROM produtos WHERE id = ?`,
      [produtoId],
      (errFlag, rowFlag) => {
        if (errFlag) return callback(errFlag);
        if (!produtoControlaEstoque(rowFlag || {})) {
          return callback(null);
        }

        const executarNaoFiscal = () => {
          if (Number(quantidadeNaoFiscal || 0) <= 0) {
            return callback(null);
          }
          reduzirEstoqueComFEFO(
            vendaItemId,
            produtoId,
            quantidadeNaoFiscal,
            0,
            callback,
            opcoes
          );
        };

        if (Number(quantidadeFiscal || 0) <= 0) {
          return executarNaoFiscal();
        }

        reduzirEstoqueComFEFO(
          vendaItemId,
          produtoId,
          quantidadeFiscal,
          1,
          (err) => {
            if (err) {
              return callback(err);
            }
            executarNaoFiscal();
          },
          opcoes
        );
      }
    );
  };

  if (opcoes.baixaAutomatica === true) {
    return executarBaixaProduto();
  }

  const empresaIdModo = opcoes.empresaId != null ? opcoes.empresaId : opcoes.empresa_id;
  const { empresaPermiteBaixaAutomaticaEstoque } = require('../empresas/EmpresaModoEstoqueService');
  Promise.resolve()
    .then(() => empresaPermiteBaixaAutomaticaEstoque(dbConn, empresaIdModo))
    .then((permite) => {
      if (!permite) return callback(null);
      executarBaixaProduto();
    })
    .catch(callback);
}

function atualizarStatusPagamentoVenda(vendaId, status, tefTransacaoId) {
  if (tefTransacaoId) {
    db.run(
      `UPDATE vendas SET status_pagamento = ?, tef_transacao_id = ? WHERE id = ?`,
      [status, tefTransacaoId, vendaId]
    );
  } else {
    db.run(
      `UPDATE vendas SET status_pagamento = ? WHERE id = ?`,
      [status, vendaId]
    );
  }
}

// Função para gravar recebimentos
function flattenRecebimentos(recebimentos) {
  if (!Array.isArray(recebimentos)) {
    return [];
  }

  return recebimentos.flatMap((item) => (Array.isArray(item) ? item : [item]));
}

function runSqlite(dbConnection, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbConnection.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getSqlite(dbConnection, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbConnection.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allSqlite(dbConnection, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbConnection.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function valorEmCentavos(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.round(numero * 100) : null;
}

function obterOperacaoPedidoId(req) {
  return Number(
    req.pedidoFaturamentoOperacaoId
    || req.body?.pedido_faturamento_operacao_id
    || 0
  );
}

function vendaVinculadaAoPedidoOperacional(req, pedidoId) {
  if (!Number.isInteger(Number(pedidoId)) || Number(pedidoId) <= 0) return false;
  const origem = String(req.vendaContext?.origem || req.body?.origem || '').trim().toUpperCase();
  return origem === 'FATURAMENTO' || obterOperacaoPedidoId(req) > 0;
}

async function obterVendaExistenteDaOperacaoPedido(
  transacaoDb,
  distribuicaoItens,
  total,
  empresaId,
  req,
  pedidoIdVenda
) {
  const operacaoId = obterOperacaoPedidoId(req);
  if (!Number.isInteger(operacaoId) || operacaoId <= 0) {
    if (Number.isInteger(Number(pedidoIdVenda)) && Number(pedidoIdVenda) > 0) {
      const operacaoPedido = await getSqlite(transacaoDb, `
        SELECT tipo_operacao
        FROM pedido_faturamento_operacoes
        WHERE pedido_id = ?
      `, [pedidoIdVenda]);
      if (operacaoPedido?.tipo_operacao === 'PDV_COMPOSICAO') {
        const err = new Error('A venda deste Pedido deve usar a operação de composição PDV preparada.');
        err.statusCode = 409;
        err.codigo = 'FATURAMENTO_PEDIDO_CONFLITANTE';
        throw err;
      }
    }
    return null;
  }

  const operacao = await getSqlite(transacaoDb, `
    SELECT id, pedido_id, empresa_id, venda_id, tipo_operacao, payload_json
    FROM pedido_faturamento_operacoes
    WHERE id = ?
  `, [operacaoId]);
  if (
    !operacao
    || Number(operacao.pedido_id) !== Number(pedidoIdVenda)
    || Number(operacao.empresa_id) !== Number(empresaId)
  ) {
    const err = new Error('Operação idempotente do Pedido ausente ou incompatível.');
    err.statusCode = 409;
    err.codigo = 'FATURAMENTO_PEDIDO_CONFLITANTE';
    throw err;
  }
  if (operacao.tipo_operacao === 'PDV_COMPOSICAO') {
    let snapshot;
    try {
      snapshot = JSON.parse(operacao.payload_json || 'null');
    } catch (parseError) {
      snapshot = null;
    }
    const itensEsperados = snapshot?.itens;
    const itensConferem = Array.isArray(itensEsperados)
      && itensEsperados.length === distribuicaoItens.length
      && itensEsperados.every((esperado, indice) => {
        const recebido = distribuicaoItens[indice];
        return Number(recebido.produto_id) === Number(esperado.produto_id)
          && Math.round(Number(recebido.quantidade) * 1000) === Math.round(Number(esperado.quantidade) * 1000)
          && valorEmCentavos(recebido.preco_unitario) === valorEmCentavos(esperado.preco_unitario)
          && valorEmCentavos(recebido.subtotal) === valorEmCentavos(esperado.subtotal);
      });
    if (
      !snapshot
      || Number(snapshot.pedidoId) !== Number(pedidoIdVenda)
      || Number(snapshot.empresaId) !== Number(empresaId)
      || valorEmCentavos(snapshot.total) !== valorEmCentavos(total)
      || !itensConferem
    ) {
      const err = new Error('Os itens ou o total enviados ao PDV divergem do snapshot aprovado para este Pedido.');
      err.statusCode = 409;
      err.codigo = 'COMPOSICAO_PDV_DIVERGENTE';
      throw err;
    }
  }
  if (operacao.venda_id == null) return null;

  const venda = await getSqlite(transacaoDb, `
    SELECT id, codigo, empresa_id, status, status_venda, total, pedido_id
    FROM vendas
    WHERE id = ?
  `, [operacao.venda_id]);
  const itensVenda = await allSqlite(transacaoDb, `
    SELECT produto_id, quantidade, preco_unitario, subtotal
    FROM vendas_itens
    WHERE venda_id = ?
    ORDER BY id
  `, [operacao.venda_id]);

  const erro = new Error('A venda existente da operação não corresponde ao Pedido; faturamento bloqueado.');
  erro.statusCode = 409;
  erro.codigo = 'FATURAMENTO_PEDIDO_CONFLITANTE';
  erro.pedido_id = pedidoIdVenda;
  erro.venda_id = operacao.venda_id;

  if (
    !venda
    || Number(venda.empresa_id) !== Number(empresaId)
    || String(venda.status || '').toLowerCase() !== 'concluida'
    || String(venda.status_venda || '').toUpperCase() === 'CANCELADA'
    || (venda.pedido_id != null && Number(venda.pedido_id) !== Number(pedidoIdVenda))
    || valorEmCentavos(venda.total) !== valorEmCentavos(total)
    || itensVenda.length !== distribuicaoItens.length
  ) {
    throw erro;
  }

  for (let indice = 0; indice < distribuicaoItens.length; indice += 1) {
    const esperado = distribuicaoItens[indice];
    const persistido = itensVenda[indice];
    if (
      Number(persistido.produto_id) !== Number(esperado.produto_id)
      || Math.round(Number(persistido.quantidade) * 1000) !== Math.round(Number(esperado.quantidade) * 1000)
      || valorEmCentavos(persistido.preco_unitario) !== valorEmCentavos(esperado.preco_unitario)
      || valorEmCentavos(persistido.subtotal) !== valorEmCentavos(esperado.subtotal)
    ) {
      throw erro;
    }
  }

  return { id: Number(venda.id), codigo: venda.codigo };
}

async function registrarVendaDaOperacaoPedido(transacaoDb, vendaId, empresaId, req, pedidoIdVenda) {
  const operacaoId = obterOperacaoPedidoId(req);
  if (!Number.isInteger(operacaoId) || operacaoId <= 0) return;

  const PedidoFaturamentoOperacaoRepository = require('../faturamento/PedidoFaturamentoOperacaoRepository');
  await PedidoFaturamentoOperacaoRepository.registrarVendaCriada(
    transacaoDb,
    operacaoId,
    pedidoIdVenda,
    empresaId,
    vendaId
  );
}

async function gerarCodigoVendaUnico(dbConnection, codigoBase) {
  let codigo = codigoBase;
  let sufixo = 1;

  while (await getSqlite(dbConnection, 'SELECT 1 FROM vendas WHERE codigo = ?', [codigo])) {
    codigo = `${codigoBase}-${String(sufixo).padStart(2, '0')}`;
    sufixo += 1;
  }

  return codigo;
}

async function executarTransacaoVendaExclusiva(operacao) {
  const transacaoDb = await db.openExclusiveConnection();
  let transacaoIniciada = false;
  let resultado;
  let erroOperacao = null;

  try {
    await runSqlite(transacaoDb, 'BEGIN IMMEDIATE');
    transacaoIniciada = true;
    resultado = await operacao(transacaoDb);
    await runSqlite(transacaoDb, 'COMMIT');
    transacaoIniciada = false;
  } catch (err) {
    erroOperacao = err instanceof Error ? err : new Error(String(err));
    if (transacaoIniciada) {
      try {
        await runSqlite(transacaoDb, 'ROLLBACK');
        transacaoIniciada = false;
      } catch (rollbackErr) {
        erroOperacao.rollbackError = rollbackErr;
        console.error('Falha no rollback da transação exclusiva da venda:', rollbackErr);
      }
    }
  }

  try {
    await new Promise((resolve, reject) => {
      transacaoDb.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve();
      });
    });
  } catch (closeErr) {
    if (erroOperacao) {
      erroOperacao.closeError = closeErr;
    } else {
      console.error('Falha ao fechar conexão exclusiva após commit da venda:', closeErr);
    }
  }

  if (erroOperacao) throw erroOperacao;
  return resultado;
}

function gravarRecebimentos(vendaId, recebimentos, callback, dbConnection = db) {
  const lista = flattenRecebimentos(recebimentos);
  let index = 0;

  function next() {
    if (index >= lista.length) {
      callback(null);
      return;
    }

    const r = lista[index++];

    dbConnection.run(`
      INSERT INTO venda_recebimentos
      (
        venda_id,
        tipo_recebimento,
        forma_pagamento,
        valor,
        tef_transacao_id,
        nsu,
        autorizacao,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      vendaId,
      r.tipo_recebimento,
      r.forma_pagamento,
      Number(r.valor || 0),
      r.tef_transacao_id || null,
      r.nsu || null,
      r.autorizacao || null,
      'aprovado'
    ], next);
  }

  next();
}

function gravarRecebimentosAsync(vendaId, recebimentos, dbConnection) {
  return new Promise((resolve, reject) => {
    gravarRecebimentos(vendaId, recebimentos, (err) => {
      if (err) reject(err);
      else resolve();
    }, dbConnection);
  });
}

// TEF exclusivo para recebimentos fiscais (conta empresa)
async function processarPagamentosTef(recebimentos) {
  let tefHabilitado = false;

  try {
    const tefConfig = await tefConfigService.obterConfiguracao();
    tefHabilitado = tefFluxoPagamento.parseTefHabilitado(tefConfig.tefHabilitado);
  } catch (error) {
    console.error('Erro ao verificar configuração TEF:', error);
    tefHabilitado = false;
  }

  if (!tefHabilitado) {
    console.log('TEF desabilitado, pulando autorização de pagamentos TEF');
    return { sucesso: true, transacoes: [] };
  }

  const pagamentosTef = recebimentos.filter((p) => {
    const forma = String(p.forma_pagamento || '').toLowerCase();
    return forma === 'cartao_debito'
      || forma === 'cartao_credito'
      || forma === 'cartao'
      || forma === 'pix'
      || forma === 'pix_tef';
  });

  if (pagamentosTef.length === 0) {
    return { sucesso: true, transacoes: [] };
  }

  const transacoesAutorizadas = [];

  for (const pagamento of pagamentosTef) {
    if (pagamento.tef_transacao_id) {
      transacoesAutorizadas.push(pagamento.tef_transacao_id);
      continue;
    }

    try {
      const tipoTef = tefFluxoPagamento.normalizarTipoTef(pagamento.forma_pagamento);
      const retornoTEF = await tefManager.autorizar({
        venda_id: null,
        tipo: tipoTef,
        valor: pagamento.valor,
        parcelas: 1
      });

      if (!tefContrato.estaAprovado(retornoTEF)) {
        // Cancelar transações anteriores
        for (const transacaoId of transacoesAutorizadas) {
          try {
            await tefManager.cancelar(transacaoId, 'Pagamento fiscal não aprovado');
          } catch (cancelError) {
            console.error(`Erro ao cancelar transação TEF ${transacaoId}:`, cancelError);
          }
        }
        return { sucesso: false, erro: retornoTEF };
      }

      if (retornoTEF.transacao_id) {
        transacoesAutorizadas.push(retornoTEF.transacao_id);
        pagamento.tef_transacao_id = retornoTEF.transacao_id;
        pagamento.nsu = retornoTEF.nsu;
        pagamento.autorizacao = retornoTEF.autorizacao;
      }
    } catch (error) {
      console.error('Erro ao autorizar pagamento TEF fiscal:', error);
      // Cancelar transações anteriores
      for (const transacaoId of transacoesAutorizadas) {
        try {
          await tefManager.cancelar(transacaoId, 'Erro no pagamento fiscal');
        } catch (cancelError) {
          console.error(`Erro ao cancelar transação TEF ${transacaoId}:`, cancelError);
        }
      }
      return { sucesso: false, erro: error.message };
    }
  }

  return { sucesso: true, transacoes: transacoesAutorizadas };
}


const FORMAS_NAO_FISCAL_PERMITIDAS = new Set([
  'pix',
  'dinheiro',
  'cartao',
  'cartao_pf',
  'outro'
]);

const FORMAS_TEF_FISCAL = new Set([
  'cartao_debito',
  'cartao_credito'
]);

function calcularSaldoNaoFiscal(venda, recebimentosNaoFiscal) {
  const valorNaoFiscal = Number(venda.valor_nao_fiscal || 0);
  const recebimentos = Array.isArray(recebimentosNaoFiscal) ? recebimentosNaoFiscal : [];
  const valorRecebido = recebimentos.reduce(
    (acc, r) => acc + Number(r.valor || 0),
    0
  );
  const saldoPendente = Math.round((valorNaoFiscal - valorRecebido) * 100) / 100;

  return {
    valorNaoFiscal,
    valorRecebido,
    saldoPendente: Math.max(0, saldoPendente)
  };
}

function verificarSaldoOutrosVenda(vendaId, valorOutros, callback) {
  const valorEsperado = Number(valorOutros || 0);
  if (valorEsperado <= 0) {
    callback(null, 0);
    return;
  }

  db.get(`
    SELECT
      COALESCE((
        SELECT SUM(valor)
        FROM venda_recebimentos
        WHERE venda_id = ? AND tipo_recebimento = 'outros' AND status = 'aprovado'
      ), 0) AS valor_recebido,
      COALESCE((
        SELECT SUM(valor_parcela)
        FROM contas_receber
        WHERE venda_id = ? AND componente = 'outros'
      ), 0) AS valor_parcelado,
      COALESCE((
        SELECT SUM(valor_restante)
        FROM contas_receber
        WHERE venda_id = ? AND componente = 'outros'
      ), 0) AS saldo_parcelado
  `, [vendaId, vendaId, vendaId], (err, row) => {
    if (err) {
      callback(err);
      return;
    }

    const valorConfirmado = Number(row?.valor_recebido || 0)
      + Number(row?.valor_parcelado || 0)
      - Number(row?.saldo_parcelado || 0);
    callback(null, Math.max(0, Math.round(
      (valorEsperado - valorConfirmado + Number.EPSILON) * 100
    ) / 100));
  });
}

function filtrarRecebimentosNaoFiscal(recebimentos) {
  return (Array.isArray(recebimentos) ? recebimentos : []).filter(
    (recebimento) => String(recebimento.tipo_recebimento || '').toLowerCase() === 'nao_fiscal'
  );
}

function resolverStatusPagamentoVenda(
  valorNaoFiscal,
  recebimentosNaoFiscal,
  statusAtual = 'quitada',
  opcoes = {}
) {
  const valor = Number(valorNaoFiscal || 0);
  const valorFiscal = Number(opcoes.valorFiscal || 0);
  const recebimentos = Array.isArray(recebimentosNaoFiscal) ? recebimentosNaoFiscal : [];

  if (valor <= 0 && valorFiscal <= 0) {
    return statusAtual;
  }

  const totalConfirmado = recebimentos.reduce(
    (acc, recebimento) => acc + Number(recebimento.valor || 0),
    0
  );
  const naoFiscalConfirmado =
    recebimentos.length > 0
    && Math.abs(totalConfirmado - valor) <= 0.01;

  // Venda mista (fiscal + não fiscal): 2ª etapa obrigatória
  if (valorFiscal > 0 && valor > 0) {
    return naoFiscalConfirmado ? statusAtual : 'aguardando_nao_fiscal';
  }

  // Venda somente não fiscal: pagamento único na criação — nunca aguarda 2ª etapa
  if (valorFiscal <= 0 && valor > 0) {
    if (naoFiscalConfirmado || statusAtual === 'quitada' || statusAtual === 'pendente') {
      return 'quitada';
    }
    return statusAtual;
  }

  // Venda somente fiscal
  return statusAtual;
}

function aplicarRegraStatusPagamentoVenda({
  valorFiscal,
  valorNaoFiscal,
  valorOutros = 0,
  statusPagamento,
  recebimentos
}) {
  const recebimentosNaoFiscal = filtrarRecebimentosNaoFiscal(recebimentos);
  let statusFinal = resolverStatusPagamentoVenda(
    valorNaoFiscal,
    recebimentosNaoFiscal,
    statusPagamento,
    { valorFiscal }
  );
  const outrosRecebidos = (Array.isArray(recebimentos) ? recebimentos : [])
    .filter((recebimento) => String(recebimento.tipo_recebimento || '').toLowerCase() === 'outros')
    .reduce((soma, recebimento) => soma + Number(recebimento.valor || 0), 0);
  if (statusFinal === 'quitada' && Number(valorOutros || 0) - outrosRecebidos > 0.01) {
    statusFinal = 'pendente';
  }

  let recebimentosFinal = Array.isArray(recebimentos) ? [...recebimentos] : [];

  if (statusFinal === 'aguardando_nao_fiscal') {
    recebimentosFinal = recebimentosFinal.filter(
      (recebimento) => String(recebimento.tipo_recebimento || '').toLowerCase() !== 'nao_fiscal'
    );
  }

  return {
    statusPagamento: statusFinal,
    recebimentos: recebimentosFinal
  };
}

function normalizarPagamentosNaoFiscal(body) {
  if (Array.isArray(body.pagamentos) && body.pagamentos.length > 0) {
    return body.pagamentos;
  }

  if (body.forma_pagamento && body.valor != null) {
    return [{
      forma_pagamento: body.forma_pagamento,
      valor: body.valor
    }];
  }

  return [];
}

function validarPagamentosNaoFiscal(pagamentos) {
  for (const pagamento of pagamentos) {
    const forma = String(pagamento.forma_pagamento || '').toLowerCase().trim();

    if (!forma) {
      return 'Informe a forma de pagamento não fiscal.';
    }

    if (FORMAS_TEF_FISCAL.has(forma) || pagamento.tef_transacao_id) {
      return 'Pagamento não fiscal não utiliza TEF.';
    }

    if (!FORMAS_NAO_FISCAL_PERMITIDAS.has(forma)) {
      return `Forma de pagamento não fiscal inválida: ${forma}.`;
    }

    if (Number(pagamento.valor || 0) <= 0) {
      return 'Valor do pagamento não fiscal deve ser maior que zero.';
    }
  }

  return null;
}

function obterTerminalId(req) {
  const rawId = req.body?.terminal_id || req.query?.terminal_id || req.headers['x-terminal-id'];
  const id = Number(rawId || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function preCalcularDistribuicao(req, res) {
const { itens, emitir_fiscal, desconto, acrescimo } = req.body;
const vendaFiscal = resolverVendaFiscalParaMotor(req.body);

if (!itens || !Array.isArray(itens) || itens.length === 0) {
  return res.status(400).json({
    sucesso: false,
    error: 'Itens da venda são obrigatórios.'
  });
}

if (itens.some((item) => item.produto_id === undefined || item.produto_id === null)) {
  return res.status(400).json({
    sucesso: false,
    error: 'Um ou mais itens da venda não possuem produto vinculado.'
  });
}

const produtoIds = Array.from(
  new Set(itens.map((item) => item.produto_id).filter((id) => id !== undefined && id !== null))
);

db.all(`
  SELECT
    id,
    nome,
    saldo_fiscal,
    saldo_nao_fiscal,
    COALESCE(controla_estoque, 1) AS controla_estoque,
    COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional
  FROM produtos
  WHERE id IN (${produtoIds.map(() => '?').join(',')})
`, produtoIds, async (err, produtos) => {
  if (err) {
    return res.status(500).json({ sucesso: false, error: err.message });
  }

  let produtosEstoque = produtos || [];
  try {
    produtosEstoque = await aplicarSaldosDisponibilidadeVenda({
      produtos: produtosEstoque,
      empresaId: req.empresaId,
      db
    });
  } catch (isoErr) {
    return res.status(500).json({
      sucesso: false,
      error: isoErr && isoErr.message ? isoErr.message : 'Erro ao consultar estoque da empresa.',
      code: isoErr && isoErr.code ? isoErr.code : undefined
    });
  }

  try {
    exigirProdutosVendaveisNaVenda(produtosEstoque);
  } catch (insumoErr) {
    return res.status(insumoErr.statusCode || 400).json({
      sucesso: false,
      error: insumoErr.message,
      code: insumoErr.code
    });
  }

  const { saldosParaDistribuicaoVenda } = require('../estoque/produtoControlaEstoque');

  const produtoMap = produtosEstoque.reduce((map, produto) => {
    map[produto.id] = produto;
    return map;
  }, {});

  const itensDistribuidos = [];
  const entradasMotor = [];

  for (const item of itens) {
    const produto = produtoMap[item.produto_id];

    if (!produto) {
      return res.status(400).json({
        sucesso: false,
        error: `Produto ID ${item.produto_id} não encontrado`
      });
    }

    const qtdEstoque = item.quantidade_estoque != null && item.quantidade_estoque !== ''
      ? Number(item.quantidade_estoque)
      : Number(item.quantidade || 0);
    const saldos = saldosParaDistribuicaoVenda(
      produto,
      qtdEstoque,
      produto.saldo_fiscal,
      produto.saldo_nao_fiscal
    );

    entradasMotor.push({
      item,
      saldoFiscal: saldos.saldoFiscal,
      saldoNaoFiscal: saldos.saldoNaoFiscal
    });
  }

  const { politica: politicaMpfc } = carregarPoliticaFiscalComercialPassiva();
  const midpAtivo = Boolean(politicaMpfc.preservarDinheiro);
  const pagamentosPre = Array.isArray(req.body?.pagamentos) ? req.body.pagamentos : [];
  const preservarPre = devePreservarItensComposicaoPedido({
    pedidoId: req.body && (req.body.pedido_id || req.body.pedidoId),
    itens,
    desconto,
    acrescimo,
    total: req.body && req.body.total
  });
  const resultadoMotor = distribuirItensVendaComValorFiscalEfetivo(
    entradasMotor,
    vendaFiscal,
    {
      pagamentos: pagamentosPre,
      midpAtivo,
      desconto: Number(desconto || 0),
      acrescimo: Number(acrescimo || 0),
      politicaFiscalComercial: politicaMpfc,
      preservarItensComposicaoPedido: preservarPre
    }
  );

  if (!resultadoMotor.sucesso) {
    const nome = resultadoMotor.item?.produto_id
      ? (produtoMap[resultadoMotor.item.produto_id]?.nome || resultadoMotor.item.produto_id)
      : 'produto';
    return res.status(400).json({
      sucesso: false,
      error:
        `Saldo insuficiente para ${nome}. ` +
        `Disponível: ${resultadoMotor.erro?.estoqueTotal}`
    });
  }

  for (const row of resultadoMotor.itens) {
    itensDistribuidos.push({
      produto_id: row.produto_id,
      quantidade_fiscal: row.quantidade_fiscal,
      quantidade_nao_fiscal: row.quantidade_nao_fiscal,
      valor_fiscal: row.valor_fiscal,
      valor_nao_fiscal: row.valor_nao_fiscal
    });
  }

  res.json({
    sucesso: true,
    liquido_aplicado_backend: true,
    valor_fiscal: resultadoMotor.valorFiscalEfetivo,
    valor_nao_fiscal: resultadoMotor.valorNaoFiscal,
    valor_fiscal_maximo: resultadoMotor.valorFiscalMaximo,
    valor_fiscal_efetivo: resultadoMotor.valorFiscalEfetivo,
    valor_fiscal_liquido: resultadoMotor.valorFiscalLiquido,
    valor_nao_fiscal_liquido: resultadoMotor.valorNaoFiscalLiquido,
    valor_fiscal_bruto: resultadoMotor.valorFiscalBruto,
    midp_preservacao: resultadoMotor.preservacaoAplicada,
    liquido_comercial: resultadoMotor.liquidoComercial || null,
    itens: itensDistribuidos
  });
});
}

function arredondarCentavosAcrescimo(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

function subtotalComercialDoItem(item) {
  if (item && item.subtotal != null && item.subtotal !== '') {
    return Number(item.subtotal);
  }
  return Number(item && item.preco_unitario || 0) * Number(item && item.quantidade || 0);
}

/**
 * O acréscimo gravado é o que fecha a identidade comercial já aceita:
 * total = subtotal dos itens - desconto + acréscimo + valor_outros.
 * Valor enviado fora dessa identidade é recusado. O total comercial não é recalculado.
 */
function resolverAcrescimoPersistido({ itens, desconto, acrescimo, total, valorOutros }) {
  const informadoBruto = acrescimo == null || acrescimo === '' ? 0 : Number(acrescimo);
  if (!Number.isFinite(informadoBruto) || informadoBruto < 0) {
    const err = new Error('Acréscimo inválido.');
    err.statusCode = 400;
    err.code = 'ACRESCIMO_INVALIDO';
    throw err;
  }
  const informado = arredondarCentavosAcrescimo(informadoBruto);
  const subtotal = arredondarCentavosAcrescimo(
    (Array.isArray(itens) ? itens : []).reduce((soma, item) => soma + subtotalComercialDoItem(item), 0)
  );
  const desc = arredondarCentavosAcrescimo(Math.max(0, Number(desconto || 0)));
  const outros = arredondarCentavosAcrescimo(Math.max(0, Number(valorOutros || 0)));
  const totalArred = arredondarCentavosAcrescimo(total);
  if (!(subtotal > 0)) {
    if (informado > 0.009) {
      const err = new Error('O acréscimo não confere com o total comercial da venda.');
      err.statusCode = 400;
      err.code = 'ACRESCIMO_DIVERGENTE';
      throw err;
    }
    return 0;
  }
  const derivado = arredondarCentavosAcrescimo(totalArred - subtotal + desc - outros);
  if (derivado < -0.009) {
    if (informado > 0.009) {
      const err = new Error('O acréscimo não confere com o total comercial da venda.');
      err.statusCode = 400;
      err.code = 'ACRESCIMO_DIVERGENTE';
      throw err;
    }
    return 0;
  }
  const persistido = Math.max(0, derivado);
  if (Math.abs(persistido - informado) > 0.009) {
    const err = new Error('O acréscimo não confere com o total comercial da venda.');
    err.statusCode = 400;
    err.code = 'ACRESCIMO_DIVERGENTE';
    throw err;
  }
  return persistido;
}

function vendaExigeAutorizacaoDescontoManual(body = {}) {
  if (Number(body.desconto || 0) > 0) return true;
  const itens = Array.isArray(body.itens) ? body.itens : [];
  return itens.some((item) => (
    Number(item.desconto_manual || 0) === 1
    && (Number(item.desconto_valor || 0) > 0 || Number(item.desconto_percentual || 0) > 0)
  ));
}

function criarVenda(req, res) {
if (!req.__financeiroEmpresaOk) {
  const { resolverEmpresaIdParaFinanceiro } = require('../financeiro/FinanceiroEmpresaContextoService');
  return resolverEmpresaIdParaFinanceiro(req, { db, exigirAutorizacaoUsuario: false })
    .then((resolved) => {
      req.empresaId = resolved.empresaId;
      req.__financeiroEmpresaOk = true;
      return criarVenda(req, res);
    })
    .catch((err) => res.status(err.statusCode || 400).json({
      error: err.message || 'Empresa obrigatória para persistência financeira da venda.',
      code: err.code || 'FINANCEIRO_EMPRESA_OBRIGATORIA'
    }));
}
let empresaIdVenda;
try {
  empresaIdVenda = exigirEmpresaDaOperacao(req);
  exigirCaixaCompativelComVenda(req, empresaIdVenda);
} catch (errEmp) {
  return res.status(errEmp.statusCode || 400).json({
    error: errEmp.message || 'Empresa do contexto é obrigatória para criar venda.',
    code: errEmp.code || 'EMPRESA_CONTEXT_REQUIRED',
    empresa_id: errEmp.empresa_id
  });
}
req.empresaIdVenda = empresaIdVenda;
const opcoesBaixaEstoque = {
  ...montarOpcoesBaixaEstoqueVenda(req, 'baixa_venda', db),
  exigirEmpresa: true
};
{
  const { empresaPermiteBaixaAutomaticaEstoque } = require('../empresas/EmpresaModoEstoqueService');
  // Resolve o modo uma vez por venda; legado sem config = AUTOMATICO.
  // Falha de leitura não bloqueia a venda — trata como AUTOMATICO só se empresa inválida?
  // Exigimos resolução síncrona via Promise no fluxo async abaixo após validações iniciais.
  opcoesBaixaEstoque.__resolverModoEstoque = () => empresaPermiteBaixaAutomaticaEstoque(db, empresaIdVenda)
    .then((permite) => {
      opcoesBaixaEstoque.baixaAutomatica = permite === true;
      opcoesBaixaEstoque.modoEstoque = permite ? 'AUTOMATICO' : 'MANUAL';
      return opcoesBaixaEstoque.baixaAutomatica;
    });
}
const tipoVendaCanal = String(req.body?.tipo_venda || 'BALCAO').toUpperCase();
if (tipoVendaCanal === 'ENTREGA') {
  const { criarVendaEntrega } = require('../entrega/CriarVendaEntregaService');
  return criarVendaEntrega(req, res);
}

if (!req.__descontoAuthOk && vendaExigeAutorizacaoDescontoManual(req.body)) {
  const { verificarSupervisorToken, isSupervisorPerfil } = require('../../rotas/auth');
  if (!isSupervisorPerfil(req.user || {})) {
    return verificarSupervisorToken(req.body.supervisor_token || null)
      .then((supervisorUser) => {
        req.__descontoAuthOk = true;
        req.supervisorAutorizacao = supervisorUser;
        return criarVenda(req, res);
      })
      .catch((err) => res.status(403).json({
        error: err.message || 'Desconto exige autorização de administrador ou supervisor.',
        codigo: err.code || 'DESCONTO_NAO_AUTORIZADO'
      }));
  }
  req.__descontoAuthOk = true;
}

const {
  cliente_id,
  total,
  desconto,
  acrescimo,
  forma_pagamento,
  itens,
  parcelas,
  primeiro_vencimento,
  forcar,
  emitir_fiscal,
  valor_recebido,
  cpf_cnpj_nota,
  pagamentos,
  tef,
  pedido_id: pedidoIdBody,
  valor_fiscal: _valorFiscalBody,
  valor_nao_fiscal: _valorNaoFiscalBody,
  valor_outros: valorOutrosBody
} = req.body;

/** RC4.1.2 — ponte reserva do pedido (Expedição → Núcleo). Já vem em FaturamentoService. */
const pedidoIdVenda = Number(pedidoIdBody || req.body?.pedidoId || 0) || null;
const vendaPedidoOperacional = vendaVinculadaAoPedidoOperacional(req, pedidoIdVenda);

const vendaFiscal = resolverVendaFiscalParaMotor(req.body);

const cpfCnpjNotaLimpo = String(cpf_cnpj_nota || '').replace(/\D/g, '');

if (cpfCnpjNotaLimpo && ![11, 14].includes(cpfCnpjNotaLimpo.length)) {
  return res.status(400).json({
    error: 'CPF/CNPJ informado na nota é inválido.'
  });
}

const pagamentosVenda = Array.isArray(pagamentos) ? pagamentos : [];

const formaClassificada = classificarFormaPagamento(pagamentosVenda);
let formaPagamentoFinal = formaClassificada || forma_pagamento;

// Hotfix: body.valor_fiscal / valor_nao_fiscal são ignorados — fonte de verdade = Motor.
void _valorFiscalBody;
void _valorNaoFiscalBody;

const totalNum = Number(total);
const valorOutrosInformado = valorOutrosBody != null;
const valorOutros = valorOutrosInformado ? Number(valorOutrosBody) : 0;
if (valorOutrosInformado && (!Number.isFinite(valorOutros) || valorOutros < 0)) {
  return res.status(400).json({ error: 'Valor de Outros inválido.' });
}
const formasPendentes = ['prazo', 'parcelado', 'crediario', 'boleto', 'boleto_bancario'];
const formaPagamentoNormalizada = String(forma_pagamento || '').toLowerCase().trim();
const vendaFicaPendente = formasPendentes.includes(formaPagamentoNormalizada);

/** RC3.17 — mesmas formas que geram Contas a Receber pelo caminho a prazo existente */
function formaGeraParcelasFinanceiras(forma) {
  return formasPendentes.includes(String(forma || '').toLowerCase().trim());
}

function avancarVencimentoParcela(baseMoment, intervalo) {
  const m = baseMoment.clone ? baseMoment.clone() : moment(baseMoment);
  const i = String(intervalo || 'mensal').toLowerCase().trim();
  if (i === 'semanal') return m.add(1, 'weeks');
  if (i === 'quinzenal') return m.add(15, 'days');
  return m.add(1, 'months');
}

const intervaloParcelasBody = req.body?.intervalo_parcelas || req.body?.intervalo || 'mensal';


const buscarNomeCliente = (callback, dbConnection = db) => {
  if (!cliente_id) {
    callback(null, null, null);
    return;
  }

  dbConnection.get(
    'SELECT nome, cpf_cnpj FROM clientes WHERE id = ?',
    [cliente_id],
    (err, cliente) => {
      if (err) {
        callback(err);
        return;
      }

      callback(null, cliente ? cliente.nome : null, cliente ? cliente.cpf_cnpj : null);
    }
  );
};

if (!itens || !Array.isArray(itens) || itens.length === 0) {
  res.status(400).json({ error: 'Informe ao menos um item na venda.' });
  return;
}
if (Number.isNaN(totalNum) || totalNum <= 0) {
  res.status(400).json({ error: 'Total inválido.' });
  return;
}

let acrescimoPersistido;
try {
  acrescimoPersistido = resolverAcrescimoPersistido({
    itens,
    desconto,
    acrescimo,
    total: totalNum,
    valorOutros
  });
} catch (errAcrescimo) {
  return res.status(errAcrescimo.statusCode || 400).json({
    error: errAcrescimo.message,
    codigo: errAcrescimo.code || 'ACRESCIMO_INVALIDO'
  });
}

let referenciaRecomposicao = null;
if ((req.body && req.body.pagamento_sequencial === true) || ambienteTesteRecomposicaoReferencia()) {
  try {
    const pagamentosReferencia = pagamentosVenda.length
      ? pagamentosVenda
      : (forma_pagamento ? [{ forma_pagamento, valor: totalNum }] : []);
    referenciaRecomposicao = avaliarReferenciaRecomposicao({
      total: totalNum,
      pagamentos: pagamentosReferencia,
      itens
    });
  } catch (errComposicao) {
    return res.status(errComposicao.statusCode || 400).json({
      error: errComposicao.message,
      codigo: errComposicao.code || 'COMPOSICAO_INVALIDA'
    });
  }
}

if (formaGeraParcelasFinanceiras(forma_pagamento) && !cliente_id) {
  return res.status(400).json({
    error: 'Cliente é obrigatório para venda a prazo / parcelada / boleto.'
  });
}

const produtoIds = Array.from(new Set(itens.map(item => item.produto_id).filter(id => id !== undefined && id !== null)));

if (itens.some(item => item.produto_id === undefined || item.produto_id === null)) {
  res.status(400).json({ error: 'Um ou mais itens da venda não possuem produto vinculado.' });
  return;
}

db.all(`
  SELECT
    id,
    nome,
    preco_compra,
    saldo_fiscal,
    saldo_nao_fiscal,
    estoque_atual,
    COALESCE(reservado_fiscal, 0) AS reservado_fiscal,
    COALESCE(reservado_nao_fiscal, 0) AS reservado_nao_fiscal,
    COALESCE(controla_estoque, 1) AS controla_estoque,
    COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional
  FROM produtos
  WHERE id IN (${produtoIds.map(() => '?').join(',')})
`, produtoIds, async (err, produtos) => {
  if (err) {
    res.status(500).json({ error: err.message });
    return;
  }

  let produtosEstoque = produtos || [];
  try {
    produtosEstoque = await aplicarSaldosDisponibilidadeVenda({
      produtos: produtosEstoque,
      empresaId: req.empresaId,
      db
    });
  } catch (isoErr) {
    return res.status(500).json({
      error: isoErr && isoErr.message ? isoErr.message : 'Erro ao consultar estoque da empresa.',
      code: isoErr && isoErr.code ? isoErr.code : undefined
    });
  }

  try {
    exigirProdutosVendaveisNaVenda(produtosEstoque);
  } catch (insumoErr) {
    return res.status(insumoErr.statusCode || 400).json({
      error: insumoErr.message,
      code: insumoErr.code
    });
  }

  const { calcularEstoqueProduto } = require('../estoque/EstoqueDisponivelService');
  const { saldosParaDistribuicaoVenda } = require('../estoque/produtoControlaEstoque');

  const produtoMap = produtosEstoque.reduce((map, produto) => {
    map[produto.id] = produto;
    return map;
  }, {});

  const faltantes = itens.reduce((acumulador, item) => {
    const produto = produtoMap[item.produto_id];
    if (!produto) {
      acumulador.push(`Produto ID ${item.produto_id} não encontrado`);
    }
    return acumulador;
  }, []);

  if (faltantes.length > 0) {
    res.status(400).json({ error: 'Erro na venda: ' + faltantes.join('; ') });
    return;
  }

  // RC4.1.2 — carrega crédito da reserva do pedido antes da distribuição
  obterCreditoReservaPedidoCb(pedidoIdVenda, db, (_credErr, creditoReserva) => {
    if (_credErr) {
      db.run('ROLLBACK');
      res.status(_credErr.statusCode || 500).json({
        error: _credErr.message || 'Falha ao consultar consumo de estoque do pedido.',
        code: _credErr.code || 'CONSULTA_CONSUMO_PEDIDO_FALHOU'
      });
      return;
    }

    const seguirComCredito = async () => {
    const creditoPorProduto = (creditoReserva && creditoReserva.por_produto) || {};
    const pedidoJaConsumido = Boolean(
      (creditoReserva && creditoReserva.consumo_confirmado) || vendaPedidoOperacional
    );
    opcoesBaixaEstoque.pedidoJaConsumido = pedidoJaConsumido;

  const distribuicaoItens = [];
  const entradasMotor = [];

  for (const item of itens) {
    const produto = produtoMap[item.produto_id];
    const calcBase = calcularEstoqueProduto(produto);
    const creditoAplicado = creditoPorProduto[item.produto_id] || 0;
    const calc = creditarDisponibilidadeComReservaPedido(
      calcBase,
      creditoAplicado
    );

    const qtdEstoque = item.quantidade_estoque != null && item.quantidade_estoque !== ''
      ? Number(item.quantidade_estoque)
      : Number(item.quantidade || 0);
    const saldos = saldosParaDistribuicaoVenda(
      produto,
      qtdEstoque,
      calc.disponivel_fiscal,
      calc.disponivel_nao_fiscal
    );

    entradasMotor.push({
      item,
      saldoFiscal: saldos.saldoFiscal,
      saldoNaoFiscal: saldos.saldoNaoFiscal
    });
  }
  const { politica: politicaMpfc, snapshot: snapshotMpfc } = carregarPoliticaFiscalComercialPassiva();
  const midpAtivo = Boolean(politicaMpfc.preservarDinheiro);
  const snapshotJson = mpfc.snapshotParaJson(politicaMpfc);
  mpfc.registrarSnapshotGravado(politicaMpfc, { fonte: 'criar_venda' });

  const validacaoMargem = validarMargemPoliticaComercial(itens, produtoMap, politicaMpfc);
  if (!validacaoMargem.sucesso) {
    return res.status(400).json({
      error: validacaoMargem.error,
      codigo: 'MARGEM_MINIMA_COMERCIAL',
      itens: validacaoMargem.itensViolados
    });
  }

  const pagamentosParaMotor = Array.isArray(pagamentosVenda) && pagamentosVenda.length
    ? pagamentosVenda
    : (forma_pagamento
      ? [{ forma_pagamento, valor: Number(total || 0) }]
      : []);

  // Sprint 10–16 — diagnóstico isolado de recomposição (antes do Motor F×NF).
  // Flags internas: CDS_RECOMPOSICAO_DIAGNOSTICO*, HOMOLOGACAO, APLICAR_DISTRIBUICAO.
  // Sprint 17: CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR encaminha a proposta validada
  // ao distribuidor oficial. Não lê body. A flag APLICAR_DISTRIBUICAO continua bloqueio.
  // O objeto resultadoMotor legado não é mutado.
  let __cdsRecomposicaoPipeline = null;
  try {
    const {
      executarDiagnosticoRecomposicaoNoFechamento,
      resolverDiagnosticoInternoParaFechamento,
      obterAtivacaoHomologacaoInterna,
      resolverModoOperacionalRecomposicao
    } = require('./RecomposicaoFiscalFechamentoAdaptadorService');
    const diagnosticoInterno = resolverDiagnosticoInternoParaFechamento({
      harnessReq: req.__cdsRecomposicaoDiagnostico || null
    });
    const ativacaoHomolog = obterAtivacaoHomologacaoInterna(
      process.env,
      req.__cdsRecomposicaoHomologacao || null
    );
    const modoInfo = resolverModoOperacionalRecomposicao({
      env: process.env,
      diagnosticoInterno,
      harnessHomologacao: req.__cdsRecomposicaoHomologacao || null,
      harnessAplicar: req.__cdsRecomposicaoAplicar || null
    });
    const diagRecomposicao = await executarDiagnosticoRecomposicaoNoFechamento({
      totalComercial: totalNum,
      pagamentos: pagamentosVenda,
      itens,
      diagnosticoInterno,
      pedidoId: pedidoIdVenda,
      empresaId: empresaIdVenda,
      db
    });
    if (diagRecomposicao && diagRecomposicao.evento) {
      console.info(
        '[cds-recomposicao-diagnostico]',
        diagRecomposicao.evento,
        diagRecomposicao.resumoSeguro || {}
      );
    }
    if (ativacaoHomolog.ativa || diagnosticoInterno
      || modoInfo.modo_efetivo !== 'DESLIGADO') {
      __cdsRecomposicaoPipeline = {
        ativacao: ativacaoHomolog,
        modoInfo,
        diagnostico: diagRecomposicao
      };
    }
  } catch (diagRecomposicaoErr) {
    console.warn(
      '[cds-recomposicao-diagnostico]',
      'erro_isolado',
      diagRecomposicaoErr && (diagRecomposicaoErr.code || diagRecomposicaoErr.codigo)
        ? (diagRecomposicaoErr.code || diagRecomposicaoErr.codigo)
        : 'ERRO',
      diagRecomposicaoErr && diagRecomposicaoErr.message
        ? String(diagRecomposicaoErr.message).slice(0, 200)
        : ''
    );
  }

  const preservarComposicaoPedido = devePreservarItensComposicaoPedido({
    pedidoId: pedidoIdVenda,
    itens,
    desconto,
    acrescimo,
    total: totalNum
  });
  const resultadoMotor = distribuirItensVendaComValorFiscalEfetivo(
    entradasMotor,
    vendaFiscal,
    {
      pagamentos: pagamentosParaMotor,
      midpAtivo,
      desconto: Number(desconto || 0),
      acrescimo: Number(acrescimo || 0),
      politicaFiscalComercial: politicaMpfc,
      preservarItensComposicaoPedido: preservarComposicaoPedido
    }
  );

  // Sprint 15/17 — validação após o Motor. A distribuição da recomposição,
  // quando autorizada, é outra chamada ao distribuidor oficial; resultadoMotor não é mutado.
  let resultadoParaFechamento = resultadoMotor;
  if (__cdsRecomposicaoPipeline) {
    try {
      const {
        validarPropostaContraContratoMotorFxnf,
        montarRelatorioOperacionalRecomposicao,
        obterAutorizacaoDistribuicaoOficialInterna,
        encaminharPropostaValidadaAoDistribuidorOficial
      } = require('./RecomposicaoFiscalFechamentoAdaptadorService');
      const validacao = validarPropostaContraContratoMotorFxnf({
        diagnostico: __cdsRecomposicaoPipeline.diagnostico,
        resultadoMotorOficial: resultadoMotor,
        totalComercial: totalNum,
        pagamentos: pagamentosVenda,
        itens
      });
      const authDist = obterAutorizacaoDistribuicaoOficialInterna(
        process.env,
        req.__cdsRecomposicaoDistribuicaoOficial || null
      );
      const modoBloqueia = __cdsRecomposicaoPipeline.modoInfo
        && __cdsRecomposicaoPipeline.modoInfo.modo_efetivo === 'APLICACAO_BLOQUEADA';
      let aplicacaoOficial = null;
      if (authDist.ativa && !modoBloqueia && validacao.composicao_validada_em_homologacao === true) {
        const saldosPorProduto = {};
        for (const entrada of entradasMotor) {
          const pid = Number(entrada.item && entrada.item.produto_id);
          saldosPorProduto[pid] = {
            saldoFiscal: entrada.saldoFiscal,
            saldoNaoFiscal: entrada.saldoNaoFiscal
          };
        }
        aplicacaoOficial = await encaminharPropostaValidadaAoDistribuidorOficial({
          env: process.env,
          autorizacao: authDist,
          diagnostico: __cdsRecomposicaoPipeline.diagnostico,
          validacao,
          itensVendidos: itens,
          pagamentos: pagamentosVenda,
          totalComercial: totalNum,
          desconto: Number(desconto || 0),
          acrescimo: Number(acrescimo || 0),
          empresaId: empresaIdVenda,
          db,
          saldosPorProduto,
          aplicarSaldo: false,
          harnessAplicar: req.__cdsRecomposicaoAplicar || null,
          modelos: req.__cdsRecomposicaoDiagnostico
            && req.__cdsRecomposicaoDiagnostico.modelos,
          capacidade_por_categoria: req.__cdsRecomposicaoDiagnostico
            && req.__cdsRecomposicaoDiagnostico.capacidade_por_categoria
        });
        if (
          aplicacaoOficial
          && aplicacaoOficial.distribuicao_aplicada === true
          && aplicacaoOficial.resultado_oficial
          && aplicacaoOficial.resultado_oficial.sucesso === true
        ) {
          resultadoParaFechamento = aplicacaoOficial.resultado_oficial;
        }
      }
      const relatorio = montarRelatorioOperacionalRecomposicao({
        modoInfo: __cdsRecomposicaoPipeline.modoInfo,
        diagnostico: __cdsRecomposicaoPipeline.diagnostico,
        validacao,
        totalComercial: totalNum,
        itensVenda: itens,
        resultado_motor_inalterado: true,
        distribuicaoAplicada: aplicacaoOficial
          && aplicacaoOficial.distribuicao_aplicada === true,
        resultadoOficial: aplicacaoOficial && aplicacaoOficial.resultado_oficial
      });
      req.__cdsRecomposicaoHomologacaoResultado = Object.freeze({
        ativacao: __cdsRecomposicaoPipeline.ativacao,
        diagnostico: __cdsRecomposicaoPipeline.diagnostico,
        validacao,
        relatorio_operacional: relatorio,
        resultado_motor_inalterado: true,
        distribuicao_aplicada: relatorio.distribuicao_aplicada === true,
        aplicacao_oficial: aplicacaoOficial
      });
      req.__cdsRecomposicaoOperacional = relatorio;
      console.info(
        '[cds-recomposicao-operacional]',
        relatorio.modo_efetivo,
        {
          proposta_calculada: relatorio.proposta_calculada,
          proposta_validada: relatorio.proposta_validada,
          distribuicao_aplicada: relatorio.distribuicao_aplicada,
          valor_composicao: relatorio.valor_composicao,
          compativel_itens: relatorio.compatibilidade_itens_vendidos
            ? relatorio.compatibilidade_itens_vendidos.compativel
            : null
        }
      );
    } catch (homologErr) {
      console.warn(
        '[cds-recomposicao-operacional]',
        'erro_isolado',
        homologErr && homologErr.message
          ? String(homologErr.message).slice(0, 200)
          : 'ERRO'
      );
      // Fechamento segue com resultadoMotor oficial — sem estado parcial.
      resultadoParaFechamento = resultadoMotor;
    }
  }

  const fiscalReferencia = Number(referenciaRecomposicao && referenciaRecomposicao.valor_fiscal_referencia || 0);
  const naoFiscalReferencia = Number(referenciaRecomposicao && referenciaRecomposicao.valor_nao_fiscal_referencia || 0);
  const somenteDinheiroConfirmado = vendaFiscal === true
    && referenciaRecomposicao
    && referenciaRecomposicao.recomposicao_executada === true
    && fiscalReferencia <= 0.009
    && naoFiscalReferencia > 0.009
    && Math.abs(naoFiscalReferencia - totalNum) <= 0.02;
  if (somenteDinheiroConfirmado) {
    resultadoParaFechamento = {
      sucesso: true,
      valorFiscalLiquido: 0,
      valorFiscalEfetivo: 0,
      valorNaoFiscalLiquido: totalNum,
      valorNaoFiscal: totalNum,
      itens: (itens || []).map((item) => ({
        ...item,
        quantidade_fiscal: 0,
        valor_fiscal: 0,
        quantidade_nao_fiscal: Number(item.quantidade || 0),
        valor_nao_fiscal: Number(item.subtotal || 0)
      }))
    };
  }

  if (
    vendaFiscal === true
    && referenciaRecomposicao
    && referenciaRecomposicao.recomposicao_executada === true
    && fiscalReferencia > 0.009
    && naoFiscalReferencia > 0.009
  ) {
    const { integrarPagamentoRecomposicao } = require('./PagamentoRecomposicaoDocumentoService');
    const documento = await integrarPagamentoRecomposicao({
      total: totalNum,
      pagamentos: pagamentosVenda,
      itens,
      empresaId: empresaIdVenda
    }, { db });
    const somaCampo = (linhas, campo) => Math.round((linhas || []).reduce((total, linha) => (
      total + Number(linha && linha[campo] || 0)
    ), 0) * 100) / 100;
    const autorizado = documento
      && documento.bloqueado !== true
      && Array.isArray(documento.itens_fiscais)
      && documento.itens_fiscais.length > 0;
    if (autorizado) {
      const porId = new Map();
      for (const item of itens || []) {
        const id = Number(item.produto_id);
        porId.set(id, {
          ...item,
          produto_id: id,
          quantidade_fiscal: 0,
          valor_fiscal: 0,
          quantidade_nao_fiscal: 0,
          valor_nao_fiscal: 0
        });
      }
      for (const linha of documento.itens_fiscais) {
        const id = Number(linha.produto_id);
        const base = porId.get(id) || { produto_id: id, preco_unitario: linha.preco_unitario };
        base.quantidade_fiscal = Number(linha.quantidade_fiscal || 0);
        base.valor_fiscal = Number(linha.valor_fiscal || 0);
        base.preco_unitario = base.preco_unitario || linha.preco_unitario;
        base.produto_nome = base.produto_nome || linha.produto_nome;
        base.produto_ncm = base.produto_ncm || linha.produto_ncm || linha.ncm;
        porId.set(id, base);
      }
      for (const linha of documento.itens_nao_fiscais || []) {
        const id = Number(linha.produto_id);
        const base = porId.get(id) || { produto_id: id, preco_unitario: linha.preco_unitario };
        base.quantidade_nao_fiscal = Number(linha.quantidade_nao_fiscal || 0);
        base.valor_nao_fiscal = Number(linha.valor_nao_fiscal || 0);
        porId.set(id, base);
      }
      const mesclados = [...porId.values()].map((item) => ({
        ...item,
        quantidade: Number(item.quantidade || 0) || (Number(item.quantidade_fiscal || 0) + Number(item.quantidade_nao_fiscal || 0)),
        subtotal: item.subtotal != null
          ? item.subtotal
          : Math.round((Number(item.valor_fiscal || 0) + Number(item.valor_nao_fiscal || 0)) * 100) / 100
      }));
      const somaFiscal = somaCampo(mesclados, 'valor_fiscal');
      const somaNao = somaCampo(mesclados, 'valor_nao_fiscal');
      if (Math.abs(somaFiscal - Number(referenciaRecomposicao.valor_fiscal_referencia)) <= 0.02) {
        resultadoParaFechamento = {
          ...resultadoParaFechamento,
          sucesso: true,
          valorFiscalLiquido: somaFiscal,
          valorFiscalEfetivo: somaFiscal,
          valorNaoFiscalLiquido: somaNao,
          valorNaoFiscal: somaNao,
          itens: mesclados
        };
        req.__distribuicaoReferenciaAplicada = true;
      } else {
        req.__bloqueioDocumentoFiscal = {
          codigo: 'TOTAL_FISCAL_DIVERGENTE_DA_REFERENCIA',
          motivo: 'A distribuição autorizada não fecha a referência fiscal.'
        };
      }
    }
    if (!req.__distribuicaoReferenciaAplicada) {
      req.__bloqueioDocumentoFiscal = req.__bloqueioDocumentoFiscal || {
        codigo: documento && documento.codigo ? documento.codigo : 'DISTRIBUICAO_NAO_AUTORIZADA',
        motivo: documento && documento.motivo
          ? documento.motivo
          : 'A distribuição fiscal não foi autorizada.'
      };
      resultadoParaFechamento = {
        sucesso: true,
        valorFiscalLiquido: 0,
        valorFiscalEfetivo: 0,
        valorNaoFiscalLiquido: totalNum,
        valorNaoFiscal: totalNum,
        itens: (itens || []).map((item) => ({
          ...item,
          quantidade_fiscal: 0,
          valor_fiscal: 0,
          quantidade_nao_fiscal: 0,
          valor_nao_fiscal: 0
        }))
      };
    }
  }

  if (vendaFiscal === true && !req.__distribuicaoReferenciaAplicada && !req.__bloqueioDocumentoFiscal) {
    const { calcularReferenciasConfirmadas } = require('./PagamentoSequencialComposicaoService');
    const classificado = calcularReferenciasConfirmadas(pagamentosVenda);
    const fiscalClassificado = Number(classificado.valor_fiscal_referencia || 0);
    const naoClassificado = Number(classificado.valor_nao_fiscal_referencia || 0);
    if (fiscalClassificado > 0.009 && naoClassificado > 0.009) {
      if (preservarComposicaoPedido && resultadoParaFechamento && resultadoParaFechamento.sucesso) {
        const decisao = decisaoEmissaoComposicaoPreservada(pagamentosVenda);
        resultadoParaFechamento = {
          ...resultadoParaFechamento,
          valorFiscalLiquido: decisao.valorFiscal,
          valorFiscalEfetivo: decisao.valorFiscal,
          valorNaoFiscalLiquido: decisao.valorNaoFiscal,
          valorNaoFiscal: decisao.valorNaoFiscal
        };
        req.__bloqueioDocumentoFiscal = {
          codigo: decisao.codigo,
          motivo: decisao.motivo
        };
      } else {
      req.__bloqueioDocumentoFiscal = {
        codigo: 'RECOMPOSICAO_NAO_AUTORIZADA',
        motivo: 'A venda tem recebimento fiscal e não fiscal, mas não há distribuição autorizada. A NFC-e não foi montada.'
      };
      resultadoParaFechamento = {
        sucesso: true,
        valorFiscalLiquido: 0,
        valorFiscalEfetivo: 0,
        valorNaoFiscalLiquido: totalNum,
        valorNaoFiscal: totalNum,
        itens: (itens || []).map((item) => ({
          ...item,
          quantidade_fiscal: 0,
          valor_fiscal: 0,
          quantidade_nao_fiscal: 0,
          valor_nao_fiscal: 0
        }))
      };
      }
    } else if (fiscalClassificado <= 0.009 && naoClassificado > 0.009 && Math.abs(naoClassificado - totalNum) <= 0.02) {
      resultadoParaFechamento = {
        sucesso: true,
        valorFiscalLiquido: 0,
        valorFiscalEfetivo: 0,
        valorNaoFiscalLiquido: totalNum,
        valorNaoFiscal: totalNum,
        itens: (itens || []).map((item) => ({
          ...item,
          quantidade_fiscal: 0,
          valor_fiscal: 0,
          quantidade_nao_fiscal: Number(item.quantidade || 0),
          valor_nao_fiscal: Number(item.subtotal || 0)
        }))
      };
    }
  }

  if (!resultadoParaFechamento.sucesso) {
    const produtoErro = resultadoParaFechamento.item
      ? produtoMap[resultadoParaFechamento.item.produto_id]
      : null;
    return res.status(400).json({
      error:
        `Saldo insuficiente para ${produtoErro?.nome || 'produto'}. ` +
        `Disponível: ${resultadoParaFechamento.erro?.estoqueTotal}`
    });
  }
  for (const row of resultadoParaFechamento.itens) {
    distribuicaoItens.push({
      ...row,
      quantidade_fiscal: row.quantidade_fiscal,
      quantidade_nao_fiscal: row.quantidade_nao_fiscal,
      valor_fiscal: row.valor_fiscal,
      valor_nao_fiscal: row.valor_nao_fiscal
    });
  }
  async function aposBaixaItensDaVenda(vendaId, transacaoDb) {
    if (pedidoJaConsumido) {
      return;
    }
    if (opcoesBaixaEstoque.baixaAutomatica === false || opcoesBaixaEstoque.modoEstoque === 'MANUAL') {
      return;
    }
    const { consumirFichaTecnicaDaVendaCb } = require('../produtos/FichaTecnicaConsumoService');
    await new Promise((resolve, reject) => {
      consumirFichaTecnicaDaVendaCb({
        vendaId,
        empresaId: empresaIdVenda,
        itens: distribuicaoItens,
        db: transacaoDb,
        usuarioId: opcoesBaixaEstoque.usuarioId
      }, (fichaErr) => {
        if (fichaErr) reject(fichaErr);
        else resolve();
      });
    });
  }

  async function inserirItensDaVenda(transacaoDb, vendaId) {
    for (const item of distribuicaoItens) {
      const quantidadeFiscal = Number(item.quantidade_fiscal || 0);
      const quantidadeNaoFiscal = Number(item.quantidade_nao_fiscal || 0);
      const itemFiscal = quantidadeFiscal > 0 ? 1 : 0;
      const valorFiscal = Number((item.valor_fiscal || 0).toFixed(2));
      const valorNaoFiscal = Number((item.valor_nao_fiscal || 0).toFixed(2));
      const tipoVenda = normalizarTipoVendaItem(item);
      const insercao = await runSqlite(transacaoDb, `
        INSERT INTO vendas_itens (
          venda_id, produto_id, quantidade, preco_unitario, preco_unitario_interno,
          desconto_percentual, desconto_valor, desconto_manual, promocao_id,
          desconto_atacado, tipo_preco, subtotal, item_fiscal, quantidade_fiscal,
          quantidade_nao_fiscal, valor_fiscal, valor_nao_fiscal, tipo_venda
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        vendaId,
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.preco_unitario_interno ?? item.preco_unitario,
        item.desconto_percentual || 0,
        item.desconto_valor || 0,
        Number(item.desconto_manual || 0) === 1 ? 1 : 0,
        item.promocao_id || null,
        item.desconto_atacado || 0,
        item.tipo_preco || 'varejo',
        item.subtotal,
        itemFiscal,
        quantidadeFiscal,
        quantidadeNaoFiscal,
        valorFiscal,
        valorNaoFiscal,
        tipoVenda
      ]);

      await new Promise((resolve, reject) => {
        reduzirEstoqueDistribuido(
          insercao.lastID,
          item.produto_id,
          item.quantidade_fiscal,
          item.quantidade_nao_fiscal,
          (err) => {
            if (err) reject(err);
            else resolve();
          },
          { ...opcoesBaixaEstoque, db: transacaoDb }
        );
      });
    }

    await aposBaixaItensDaVenda(vendaId, transacaoDb);
  }

  async function consumirPedidoNaVenda(transacaoDb, vendaId) {
    if (!vendaPedidoOperacional) return;
    const PedidoRepository = require('../pedido/PedidoRepository');
    const PedidoConsumoEstoqueService = require('../pedido/PedidoConsumoEstoqueService');
    const pedido = await PedidoRepository.obterPorId(pedidoIdVenda, { db: transacaoDb });
    if (!pedido || Number(pedido.empresa_id) !== Number(empresaIdVenda)) {
      const err = new Error('Pedido ausente ou pertencente a outra empresa durante a baixa física.');
      err.statusCode = 409;
      err.codigo = 'PEDIDO_EMPRESA_DIVERGENTE';
      throw err;
    }
    await PedidoConsumoEstoqueService.registrarConsumo({
      db: transacaoDb,
      pedidoId: pedidoIdVenda,
      empresaId: empresaIdVenda,
      usuarioId: req.operadorId || req.user?.id || null,
      itens: pedido.itens || [],
      supervisorToken: req.body?.supervisor_token || null,
      vendaId,
      jaEmTransacao: true
    });
  }

  async function vincularTransacoesTef(transacaoDb, vendaId, resultadoFiscal) {
    if (process.env.CDS_TEF_VINCULO_FALHA === '1') {
      const err = new Error('Falha controlada na vinculação TEF.');
      err.code = 'TEF_VINCULO_FALHA';
      err.statusCode = 409;
      throw err;
    }
    const transacoesTefParaVincular = resultadoFiscal?.transacoes || [];
    if (tef && tef.transacao_id) {
      transacoesTefParaVincular.push(tef.transacao_id);
    }
    pagamentosVenda.forEach((pagamento) => {
      const idTef = pagamento.tef_transacao_id || pagamento.tef?.transacao_id;
      if (idTef) transacoesTefParaVincular.push(idTef);
    });

    for (const transacaoId of new Set(transacoesTefParaVincular)) {
      const resultado = await runSqlite(transacaoDb, `
        UPDATE tef_transacoes
        SET venda_id = ?, atualizado_em = datetime('now')
        WHERE id = ? AND venda_id IS NULL AND empresa_id = ?
          AND (operador_id IS NULL OR operador_id = ?)
      `, [
        vendaId,
        transacaoId,
        empresaIdVenda,
        Number(req.user && (req.user.id || req.user.usuario_id)) || null
      ]);
      if (!resultado || Number(resultado.changes) !== 1) {
        const err = new Error('Transação TEF não pôde ser vinculada à venda.');
        err.code = 'TEF_VINCULO_RECUSADO';
        err.statusCode = 409;
        throw err;
      }
    }
  }

  function confirmacaoManualExplicitaNoPedido(pagamento) {
    const flag = req.body && req.body.confirmacao_fiscal_manual;
    if (flag === true || flag === 'true' || flag === 1 || flag === '1') return true;
    if (!pagamento) return false;
    return pagamento.confirmacao_manual === 1
      || pagamento.confirmacao_manual === true
      || pagamento.confirmacao_manual === '1'
      || pagamento.confirmacao_modalidade === 'manual';
  }

  function camposConfirmacaoPagamento(pagamento, tefId) {
    const operadorId = req.user && (req.user.id != null ? req.user.id : req.user.usuario_id);
    if (tefId) {
      return {
        modalidade: 'tef',
        manual: 0,
        operadorId: operadorId || null,
        confirmadoEm: null
      };
    }
    if (!confirmacaoManualExplicitaNoPedido(pagamento)) {
      return { modalidade: null, manual: 0, operadorId: null, confirmadoEm: null };
    }
    return {
      modalidade: 'manual',
      manual: 1,
      operadorId: operadorId || null,
      confirmadoEm: agoraLocalBrasil()
    };
  }

  async function inserirPagamentosDaVenda(transacaoDb, vendaId) {
    const sql = `
      INSERT INTO venda_pagamentos (
        venda_id, forma_pagamento, valor, tef_transacao_id, tef_nsu,
        tef_autorizacao, tef_bandeira, tef_adquirente,
        tef_comprovante_cliente, tef_comprovante_estabelecimento,
        confirmacao_modalidade, confirmacao_manual, operador_id, confirmado_em,
        valor_entregue, troco
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    if (pagamentosVenda.length > 0) {
      for (const pagamento of pagamentosVenda) {
        const tefId = pagamento.tef_transacao_id || pagamento.tef?.transacao_id || null;
        const confirmacao = camposConfirmacaoPagamento(pagamento, tefId);
        let nsu = pagamento.nsu || pagamento.tef?.nsu || null;
        let autorizacao = pagamento.autorizacao || pagamento.tef?.autorizacao || null;
        let bandeira = pagamento.bandeira || pagamento.tef?.bandeira || null;
        let adquirente = pagamento.adquirente || pagamento.tef?.adquirente || null;
        if (tefId) {
          const row = await getSqlite(
            transacaoDb,
            `SELECT nsu, autorizacao FROM tef_transacoes WHERE id = ?`,
            [tefId]
          );
          if (!row) {
            const err = new Error('Transação TEF não encontrada na gravação do pagamento.');
            err.code = 'TEF_VINCULO_RECUSADO';
            err.statusCode = 409;
            throw err;
          }
          nsu = row.nsu || null;
          autorizacao = row.autorizacao || null;
        } else if (confirmacao.manual === 1) {
          nsu = null;
          autorizacao = null;
          bandeira = null;
          adquirente = null;
        }
        const registro = registroFinanceiroParcela(pagamento);
        await runSqlite(transacaoDb, sql, [
          vendaId,
          pagamento.forma_pagamento,
          registro.valor,
          confirmacao.manual === 1 ? null : tefId,
          nsu,
          autorizacao,
          bandeira,
          adquirente,
          confirmacao.manual === 1 ? null : (pagamento.tef?.comprovante_cliente || null),
          confirmacao.manual === 1 ? null : (pagamento.tef?.comprovante_estabelecimento || null),
          confirmacao.modalidade,
          confirmacao.manual,
          confirmacao.operadorId,
          confirmacao.confirmadoEm,
          registro.valor_entregue,
          registro.troco
        ]);
      }
      return;
    }

    const confirmacaoUnica = camposConfirmacaoPagamento(
      { confirmacao_manual: req.body && req.body.confirmacao_fiscal_manual },
      tef?.transacao_id || null
    );
    const registroUnico = registroFinanceiroParcela({ valor: Number(total || 0) });
    await runSqlite(transacaoDb, sql, [
      vendaId,
      formaPagamentoFinal,
      registroUnico.valor,
      confirmacaoUnica.manual === 1 ? null : (tef?.transacao_id || null),
      confirmacaoUnica.manual === 1 ? null : (tef?.nsu || null),
      confirmacaoUnica.manual === 1 ? null : (tef?.autorizacao || null),
      confirmacaoUnica.manual === 1 ? null : (tef?.bandeira || null),
      confirmacaoUnica.manual === 1 ? null : (tef?.adquirente || null),
      confirmacaoUnica.manual === 1 ? null : (tef?.comprovante_cliente || null),
      confirmacaoUnica.manual === 1 ? null : (tef?.comprovante_estabelecimento || null),
      confirmacaoUnica.modalidade,
      confirmacaoUnica.manual,
      confirmacaoUnica.operadorId,
      confirmacaoUnica.confirmadoEm,
      registroUnico.valor_entregue,
      registroUnico.troco
    ]);
  }

  async function obterNomeCliente(transacaoDb) {
    return new Promise((resolve, reject) => {
      buscarNomeCliente((err, nome, cpf) => {
        if (err) reject(err);
        else resolve({ nome, cpf });
      }, transacaoDb);
    });
  }

  // Venda a prazo / parcelado / boleto / crediário exige cliente
  if (formaGeraParcelasFinanceiras(forma_pagamento)) {
  if (!cliente_id) {
    res.status(400).json({ error: 'Cliente obrigatório para venda a prazo / parcelada / boleto.' });
    return;
  }
  // Validar débitos e parcelas vencidas, a menos que forçar esteja ativo
  if (!forcar) {
    const hoje = agoraLocalBrasil().slice(0, 10);
    db.get(`
      SELECT 
        SUM(CASE WHEN status = 'aberto' THEN valor_restante ELSE 0 END) as total_em_aberto,
        COUNT(CASE WHEN status = 'aberto' AND data_vencimento < ? THEN 1 END) as parcelas_vencidas
      FROM contas_receber
      WHERE cliente_id = ?
    `, [hoje, cliente_id], (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      const totalEmAberto = Number(row?.total_em_aberto || 0);
      const parcelasVencidas = Number(row?.parcelas_vencidas || 0);
      if (totalEmAberto > 0 || parcelasVencidas > 0) {
        // Avisar operador e pedir confirmação
        res.status(409).json({
          aviso: 'Cliente possui débitos em aberto.',
          total_em_aberto: totalEmAberto,
          parcelas_vencidas: parcelasVencidas,
          pode_continuar: true
        });
        return;
      }
      executarVendaPrazo();
    });
    return;
  }
  // Função para executar venda a prazo
  executarVendaPrazo();
  async function executarVendaPrazo() {
    const codigoBase = `VND-${agoraLocalBrasil().replace(/[- :]/g, '').slice(0, 14)}`;
    let codigo;
    const data_venda = agoraLocalBrasil().slice(0, 10);

    // HOTFIX FISCAL-4.0.2 — validação sempre sobre Valor Fiscal Líquido do Motor
    const totaisLiquidosPrazo = resolverTotaisFiscaisLiquidosMotor(
      resultadoParaFechamento,
      distribuicaoItens
    );
    const totalFiscal = totaisLiquidosPrazo.totalFiscal;
    const totalNaoFiscal = totaisLiquidosPrazo.totalNaoFiscal;

    const erroSomaPagamentosMotor = validarSomaPagamentosVenda(pagamentosVenda, total, {
      valor_fiscal: totalFiscal,
      valor_nao_fiscal: totalNaoFiscal,
      valor_outros: valorOutrosInformado ? valorOutros : undefined
    });
    if (erroSomaPagamentosMotor) {
      return res.status(400).json({ error: erroSomaPagamentosMotor });
    }

    // Obter configurações TEF e confirmação fiscal
    let tefHabilitado = false;
    let modoConfirmacaoFiscal = 'TEF';
    
    try {
      const tefConfig = await tefConfigService.obterConfiguracao();
      tefHabilitado = tefFluxoPagamento.parseTefHabilitado(tefConfig.tefHabilitado);
    } catch (error) {
      console.error('Erro ao verificar configuração TEF:', error);
    }
    
    modoConfirmacaoFiscal = configService.getModoConfirmacaoFiscal() || 'TEF';

    // Processar fluxo de pagamento usando o Orquestrador → MIDP (única via)
    const resultadoPagamento = await OrquestradorPagamento.processarFluxoPagamentoVenda({
      totalFiscal,
      totalNaoFiscal,
      formaPagamento: formaPagamentoFinal,
      pagamentos: req.body.pagamentos || [],
      tefHabilitado,
      modoConfirmacaoFiscal,
      valorFiscalMaximo: resultadoParaFechamento.valorFiscalMaximo,
      preservacaoAplicada: resultadoParaFechamento.preservacaoAplicada,
      midpAtivo,
      desconto: Number(desconto || 0),
      acrescimo: Number(acrescimo || 0),
      totalOutros: valorOutros,
      subtotalBruto: Number(resultadoParaFechamento.totalVendaBruto || 0),
      debugDescontoFiscal: process.env.CDS_DEBUG_DESCONTO_FISCAL === '1',
      confirmacaoFiscalManual: req.body ? req.body.confirmacao_fiscal_manual : undefined,
      empresaId: empresaIdVenda,
      operadorId: Number(req.user && (req.user.id || req.user.usuario_id)) || null
    });

    if (!resultadoPagamento.sucesso) {
      return res.status(400).json({
        error: resultadoPagamento.erro,
        tef: resultadoPagamento.tef
      });
    }

    const { resultadoFiscal } = resultadoPagamento;
    const resultadoStatus = aplicarRegraStatusPagamentoVenda({
      valorFiscal: totalFiscal,
      valorNaoFiscal: totalNaoFiscal,
      valorOutros,
      statusPagamento: resultadoPagamento.statusPagamento,
      recebimentos: resultadoPagamento.recebimentos
    });
    const { statusPagamento, recebimentos } = resultadoStatus;

    let vendaId;
    try {
      vendaId = await executarTransacaoVendaExclusiva(async (transacaoDb) => {
        const vendaExistente = await obterVendaExistenteDaOperacaoPedido(
          transacaoDb,
          distribuicaoItens,
          totalNum,
          empresaIdVenda,
          req,
          pedidoIdVenda
        );
        if (vendaExistente) {
          codigo = vendaExistente.codigo;
          return vendaExistente.id;
        }

        codigo = await gerarCodigoVendaUnico(transacaoDb, codigoBase);
        const refsVenda = await validarReferenciasPersistenciaVenda(transacaoDb, {
          caixaId: req.caixaId,
          caixaSessaoId: req.caixaSessaoId,
          terminalId: req.terminalId,
          operadorId: req.operadorId,
          usuario: req.user,
          empresaId: empresaIdVenda,
          clienteId: cliente_id
        });
        const venda = await runSqlite(transacaoDb, `
          INSERT INTO vendas (
            codigo, data_venda, cliente_id, total, valor_outros, desconto, acrescimo,
            forma_pagamento, status, caixa_sessao_id, caixa_id, terminal_id,
            operador_id, valor_fiscal, valor_nao_fiscal, status_pagamento,
            tef_transacao_id, mpfc_politica_snapshot, empresa_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'concluida', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          codigo,
          data_venda,
          cliente_id || null,
          totalNum,
          valorOutros,
          desconto || 0,
          acrescimoPersistido,
          formaPagamentoFinal,
          refsVenda.caixaSessaoId,
          refsVenda.caixaId,
          refsVenda.terminalId,
          refsVenda.operadorId,
          totalFiscal,
          totalNaoFiscal,
          statusPagamento,
          resultadoFiscal?.transacoes?.[0] || null,
          snapshotJson,
          empresaIdVenda
        ]);
        const id = venda.lastID;

        await consumirPedidoNaVenda(transacaoDb, id);
        await gravarRecebimentosAsync(id, recebimentos, transacaoDb);
        await vincularTransacoesTef(transacaoDb, id, resultadoFiscal);
        await inserirItensDaVenda(transacaoDb, id);
        await inserirPagamentosDaVenda(transacaoDb, id);
        await gravarReferenciaRecomposicao(transacaoDb, id, referenciaRecomposicao);

        const qtdParcelas = Math.max(1, parseInt(parcelas || 1, 10) || 1);
        const parcelasReceber = montarParcelasReceber(totalNum, valorOutros, qtdParcelas);
        let vencimento = moment(primeiro_vencimento || undefined, 'YYYY-MM-DD');
        if (!vencimento.isValid()) vencimento = moment().add(30, 'days');
        for (const parcela of parcelasReceber) {
          for (const componente of parcela.componentes) {
            await runSqlite(transacaoDb, `
              INSERT INTO contas_receber (
                venda_id, cliente_id, numero_parcela, total_parcelas,
                valor_parcela, valor_restante, data_vencimento, status,
                empresa_id, componente
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'aberto', ?, ?)
            `, [
              id,
              cliente_id,
              parcela.numero_parcela,
              parcela.total_parcelas,
              componente.valor_parcela,
              componente.valor_parcela,
              vencimento.format('YYYY-MM-DD'),
              empresaIdVenda,
              componente.componente
            ]);
          }
          vencimento = avancarVencimentoParcela(vencimento, intervaloParcelasBody);
        }

        const cliente = await obterNomeCliente(transacaoDb);
        let vencimentoFinanceiro = moment(primeiro_vencimento || undefined, 'YYYY-MM-DD');
        if (!vencimentoFinanceiro.isValid()) {
          vencimentoFinanceiro = moment().add(30, 'days');
        }
        for (let indice = 1; indice <= qtdParcelas; indice += 1) {
          const valorParcela = parcelasReceber[indice - 1].componentes
            .reduce((soma, componente) => soma + componente.valor_parcela, 0);
          await runSqlite(transacaoDb, `
            INSERT INTO financeiro (
              tipo, descricao, valor, data_movimento, categoria, forma_pagamento,
              referencia_id, referencia_tipo, status, origem, documento, vencimento,
              numero_parcela, total_parcelas, venda_id, pessoa_nome, baixado_em, empresa_id
            ) VALUES ('receita', ?, ?, ?, 'vendas', ?, ?, 'venda', 'pendente', 'venda', ?, ?, ?, ?, ?, ?, NULL, ?)
          `, [
            `Venda ${codigo} - Parcela ${indice}/${qtdParcelas}`,
            valorParcela,
            data_venda,
            forma_pagamento,
            id,
            cliente.cpf,
            vencimentoFinanceiro.format('YYYY-MM-DD'),
            indice,
            qtdParcelas,
            id,
            cliente.nome,
            empresaIdVenda
          ]);
          vencimentoFinanceiro = avancarVencimentoParcela(
            vencimentoFinanceiro,
            intervaloParcelasBody
          );
        }

        await registrarVendaDaOperacaoPedido(
          transacaoDb,
          id,
          empresaIdVenda,
          req,
          pedidoIdVenda
        );
        return id;
      });
    } catch (err) {
      const respostaErro = erroPersistenciaVenda(err, 'persistencia_venda_prazo', {
        caixa_sessao_id: req.caixaSessaoId,
        caixa_id: req.caixaId,
        terminal_id: req.terminalId,
        operador_id: req.operadorId,
        cliente_id
      });
      if (err.rollbackError) respostaErro.rollback_error = err.rollbackError.message;
      if (err.closeError) respostaErro.close_error = err.closeError.message;
      return res.status(err.statusCode || 500).json(respostaErro);
    }

    responderVendaComFiscal(res, {
      vendaId,
      codigo,
      message: 'Venda a prazo registrada com sucesso',
      emitirFiscal: !!emitir_fiscal,
      valorFiscal: totalFiscal,
      valorNaoFiscal: totalNaoFiscal,
      statusPagamento,
      pagamentosTef: pagamentosVenda
    });
  }
  return;
}

// Venda à vista ou crédito antigo
const executarVenda = async () => {
  const codigoBase = `VND-${agoraLocalBrasil().replace(/[- :]/g, '').slice(0, 14)}`;
  let codigo;
  const data_venda = agoraLocalBrasil().slice(0, 10);

  // HOTFIX FISCAL-4.0.2 — validação sempre sobre Valor Fiscal Líquido do Motor
  const totaisLiquidos = resolverTotaisFiscaisLiquidosMotor(
    resultadoParaFechamento,
    distribuicaoItens
  );
  const totalFiscal = totaisLiquidos.totalFiscal;
  const totalNaoFiscal = totaisLiquidos.totalNaoFiscal;

  const erroSomaPagamentosMotor = validarSomaPagamentosVenda(pagamentosVenda, total, {
    valor_fiscal: totalFiscal,
    valor_nao_fiscal: totalNaoFiscal,
    valor_outros: valorOutrosInformado ? valorOutros : undefined
  });
  if (erroSomaPagamentosMotor) {
    return res.status(400).json({ error: erroSomaPagamentosMotor });
  }

  // Obter configurações TEF e confirmação fiscal
  let tefHabilitado = false;
  let modoConfirmacaoFiscal = 'TEF';
  
  try {
    const tefConfig = await tefConfigService.obterConfiguracao();
    tefHabilitado = tefFluxoPagamento.parseTefHabilitado(tefConfig.tefHabilitado);
  } catch (error) {
    console.error('Erro ao verificar configuração TEF:', error);
  }
  
  modoConfirmacaoFiscal = configService.getModoConfirmacaoFiscal() || 'TEF';

  // Processar fluxo de pagamento usando o Orquestrador → MIDP (única via)
  const resultadoPagamento = await OrquestradorPagamento.processarFluxoPagamentoVenda({
    totalFiscal,
    totalNaoFiscal,
    formaPagamento: formaPagamentoFinal,
    pagamentos: req.body.pagamentos || [],
    tefHabilitado,
    modoConfirmacaoFiscal,
    valorFiscalMaximo: resultadoParaFechamento.valorFiscalMaximo,
    preservacaoAplicada: resultadoParaFechamento.preservacaoAplicada,
    midpAtivo,
    desconto: Number(desconto || 0),
    acrescimo: Number(acrescimo || 0),
    totalOutros: valorOutros,
    subtotalBruto: Number(resultadoParaFechamento.totalVendaBruto || 0),
    debugDescontoFiscal: process.env.CDS_DEBUG_DESCONTO_FISCAL === '1',
    confirmacaoFiscalManual: req.body ? req.body.confirmacao_fiscal_manual : undefined,
    empresaId: empresaIdVenda,
    operadorId: Number(req.user && (req.user.id || req.user.usuario_id)) || null
  });

  if (!resultadoPagamento.sucesso) {
    return res.status(400).json({
      error: resultadoPagamento.erro,
      tef: resultadoPagamento.tef
    });
  }

  const { distribuicao, resultadoFiscal } = resultadoPagamento;
  const resultadoStatus = aplicarRegraStatusPagamentoVenda({
    valorFiscal: totalFiscal,
    valorNaoFiscal: totalNaoFiscal,
    valorOutros,
    statusPagamento: resultadoPagamento.statusPagamento,
    recebimentos: resultadoPagamento.recebimentos
  });
  let { statusPagamento, recebimentos } = resultadoStatus;
  const { classificarTipoRecebimento } = require('./PagamentoSequencialComposicaoService');
  recebimentos = (recebimentos || []).map((recebimento) => {
    const tipo = classificarTipoRecebimento(recebimento);
    if (!tipo) return recebimento;
    if (tipo === 'nao_fiscal') {
      return {
        ...recebimento,
        tipo_recebimento: 'nao_fiscal',
        tef_transacao_id: null,
        nsu: null,
        autorizacao: null
      };
    }
    return { ...recebimento, tipo_recebimento: 'fiscal' };
  });

  let vendaId;
  try {
    vendaId = await executarTransacaoVendaExclusiva(async (transacaoDb) => {
      const vendaExistente = await obterVendaExistenteDaOperacaoPedido(
        transacaoDb,
        distribuicaoItens,
        totalNum,
        empresaIdVenda,
        req,
        pedidoIdVenda
      );
      if (vendaExistente) {
        codigo = vendaExistente.codigo;
        return vendaExistente.id;
      }

      codigo = await gerarCodigoVendaUnico(transacaoDb, codigoBase);
      const refsVenda = await validarReferenciasPersistenciaVenda(transacaoDb, {
        caixaId: req.caixaId,
        caixaSessaoId: req.caixaSessaoId,
        terminalId: req.terminalId,
        operadorId: req.operadorId,
        usuario: req.user,
        empresaId: empresaIdVenda,
        clienteId: cliente_id
      });
      const venda = await runSqlite(transacaoDb, `
        INSERT INTO vendas (
          codigo, data_venda, cliente_id, total, valor_outros, desconto, acrescimo,
          forma_pagamento, status, valor_recebido, caixa_sessao_id, caixa_id,
          terminal_id, cpf_cnpj_nota, operador_id, valor_fiscal, valor_nao_fiscal,
          status_pagamento, tef_transacao_id, mpfc_politica_snapshot, empresa_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'concluida', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        codigo,
        data_venda,
        cliente_id || null,
        totalNum,
        valorOutros,
        desconto || 0,
        acrescimoPersistido,
        formaPagamentoFinal,
        valor_recebido || null,
        refsVenda.caixaSessaoId,
        refsVenda.caixaId,
        refsVenda.terminalId,
        emitir_fiscal ? cpfCnpjNotaLimpo || null : null,
        refsVenda.operadorId,
        totalFiscal,
        totalNaoFiscal,
        statusPagamento,
        resultadoFiscal?.transacoes?.[0] || null,
        snapshotJson,
        empresaIdVenda
      ]);
      const id = venda.lastID;

      await consumirPedidoNaVenda(transacaoDb, id);
      await gravarRecebimentosAsync(id, recebimentos, transacaoDb);
      await vincularTransacoesTef(transacaoDb, id, resultadoFiscal);
      await inserirItensDaVenda(transacaoDb, id);
      await inserirPagamentosDaVenda(transacaoDb, id);
      await gravarReferenciaRecomposicao(transacaoDb, id, referenciaRecomposicao);

      const statusFinanceiro = vendaFicaPendente ? 'pendente' : 'recebido';
      const baixadoEm = statusFinanceiro === 'recebido' ? data_venda : null;
      const cliente = await obterNomeCliente(transacaoDb);
      await runSqlite(transacaoDb, `
        INSERT INTO financeiro (
          tipo, descricao, valor, data_movimento, categoria, forma_pagamento,
          referencia_id, referencia_tipo, status, origem, documento, vencimento,
          numero_parcela, total_parcelas, venda_id, pessoa_nome, baixado_em, empresa_id
        ) VALUES ('receita', ?, ?, ?, 'vendas', ?, ?, 'venda', ?, 'venda', ?, ?, 1, 1, ?, ?, ?, ?)
      `, [
        `Venda ${codigo}`,
        totalNum,
        data_venda,
        forma_pagamento,
        id,
        statusFinanceiro,
        cliente.cpf,
        data_venda,
        id,
        cliente.nome,
        baixadoEm,
        empresaIdVenda
      ]);

      if (formaGeraParcelasFinanceiras(forma_pagamento) && cliente_id) {
        await runSqlite(transacaoDb, `
          INSERT INTO contas_receber (
            venda_id, cliente_id, numero_parcela, total_parcelas, valor_parcela,
            valor_restante, data_vencimento, status, empresa_id
          ) VALUES (?, ?, ?, ?, ?, ?, date('now', '+30 day'), 'aberto', ?)
        `, [id, cliente_id, 1, 1, totalNum, totalNum, empresaIdVenda]);
        await runSqlite(transacaoDb, `
          UPDATE clientes
          SET credito_atual = COALESCE(credito_atual, 0) + ?
          WHERE id = ?
        `, [totalNum, cliente_id]);
      }

      await registrarVendaDaOperacaoPedido(
        transacaoDb,
        id,
        empresaIdVenda,
        req,
        pedidoIdVenda
      );
      return id;
    });
  } catch (err) {
    const respostaErro = erroPersistenciaVenda(err, 'persistencia_venda', {
      caixa_sessao_id: req.caixaSessaoId,
      caixa_id: req.caixaId,
      terminal_id: req.terminalId,
      operador_id: req.operadorId,
      cliente_id
    });
    if (err.rollbackError) respostaErro.rollback_error = err.rollbackError.message;
    if (err.closeError) respostaErro.close_error = err.closeError.message;
    return res.status(err.statusCode || 500).json(respostaErro);
  }

  responderVendaComFiscal(res, {
    vendaId,
    codigo,
    message: 'Venda registrada com sucesso',
    emitirFiscal: !!emitir_fiscal && !req.__bloqueioDocumentoFiscal,
    valorFiscal: totalFiscal,
    valorNaoFiscal: totalNaoFiscal,
    statusPagamento,
    pagamentosTef: pagamentosVenda,
    documentoFiscalBloqueado: req.__bloqueioDocumentoFiscal || null
  });
};

// Venda à vista pode ser sem cliente
if (forma_pagamento === 'credito') {
  if (!cliente_id) {
    res.status(400).json({ error: 'Cliente obrigatório para venda a crédito.' });
    return;
  }
  db.get(
    'SELECT credito_atual, limite_credito FROM clientes WHERE id = ?',
    [cliente_id],
    (err, cliente) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      if (!cliente) {
        res.status(400).json({ error: 'Cliente não encontrado.' });
        return;
      }
      if (Number(cliente.limite_credito) <= 0) {
        res.status(400).json({ error: 'Configure um limite de crédito maior que zero para este cliente.' });
        return;
      }
      if (Number(cliente.credito_atual) + totalNum > Number(cliente.limite_credito)) {
        res.status(400).json({ error: 'Limite de crédito excedido.' });
        return;
      }
      executarVenda();
    }
  );
} else {
  executarVenda();
}
    }; // seguirComCredito

    const resolverModo = typeof opcoesBaixaEstoque.__resolverModoEstoque === 'function'
      ? opcoesBaixaEstoque.__resolverModoEstoque()
      : Promise.resolve(true);
    resolverModo.then(() => seguirComCredito()).catch((modoErr) => {
      res.status(modoErr.status || modoErr.statusCode || 500).json({
        error: modoErr.message || 'Falha ao resolver modo de estoque da empresa.',
        code: modoErr.code || 'MODO_ESTOQUE_FALHOU'
      });
    });
  });
  });
}

function consultarPagamentoNaoFiscal(req, res) {
const { id } = req.params;

return resolverEmpresaIdParaVenda(req, { db, exigirAutorizacaoUsuario: false })
  .then((resolved) => {
    req.empresaId = resolved.empresaId;
    db.get('SELECT * FROM vendas WHERE id = ? AND empresa_id = ?', [id, resolved.empresaId], (err, venda) => {
  if (err) {
    res.status(500).json({ error: err.message });
    return;
  }

  try {
    exigirVendaDaEmpresa(venda, resolved.empresaId);
  } catch (ownErr) {
    return responderErroEmpresaVenda(res, ownErr);
  }

  db.all(`
    SELECT *
    FROM venda_recebimentos
    WHERE venda_id = ? AND tipo_recebimento = 'nao_fiscal'
    ORDER BY id ASC
  `, [id], (recErr, recebimentos) => {
    if (recErr) {
      res.status(500).json({ error: recErr.message });
      return;
    }

    const saldo = calcularSaldoNaoFiscal(venda, recebimentos);

    res.json({
      venda_id: Number(id),
      codigo: venda.codigo,
      status_pagamento: venda.status_pagamento,
      valor_fiscal: Number(venda.valor_fiscal || 0),
      valor_nao_fiscal: saldo.valorNaoFiscal,
      valor_recebido_nao_fiscal: saldo.valorRecebido,
      saldo_pendente: saldo.saldoPendente,
      recebimentos_nao_fiscal: recebimentos || [],
      aguardando_pagamento: venda.status_pagamento === 'aguardando_nao_fiscal'
    });
  });
    });
  })
  .catch((err) => responderErroEmpresaVenda(res, err));
}

function registrarPagamentoNaoFiscal(req, res) {
const { id } = req.params;
const pagamentosInformados = normalizarPagamentosNaoFiscal(req.body || {});

if (pagamentosInformados.length === 0) {
  res.status(400).json({ error: 'Informe ao menos um pagamento não fiscal.' });
  return;
}

const erroValidacao = validarPagamentosNaoFiscal(pagamentosInformados);
if (erroValidacao) {
  res.status(400).json({ error: erroValidacao });
  return;
}

return resolverEmpresaIdParaVenda(req, { db, exigirAutorizacaoUsuario: false })
  .then((resolved) => {
    req.empresaId = resolved.empresaId;
    db.get('SELECT * FROM vendas WHERE id = ? AND empresa_id = ?', [id, resolved.empresaId], (err, venda) => {
  if (err) {
    res.status(500).json({ error: err.message });
    return;
  }

  try {
    exigirVendaDaEmpresa(venda, resolved.empresaId);
  } catch (ownErr) {
    return responderErroEmpresaVenda(res, ownErr);
  }

  if (venda.status !== 'concluida') {
    res.status(400).json({ error: 'Venda não está ativa para recebimento.' });
    return;
  }

  const valorFiscalVenda = Number(venda.valor_fiscal || 0);
  const valorNaoFiscalVenda = Number(venda.valor_nao_fiscal || 0);
  const vendaSomenteNaoFiscal = valorFiscalVenda <= 0 && valorNaoFiscalVenda > 0;

  if (vendaSomenteNaoFiscal) {
    if (venda.status_pagamento === 'quitada') {
      res.json({
        id: Number(id),
        codigo: venda.codigo,
        status_pagamento: 'quitada',
        message: 'Venda não fiscal já finalizada.',
        saldo_pendente: 0,
        fiscal: null,
        idempotente: true
      });
      return;
    }

    db.all(`
      SELECT *
      FROM venda_recebimentos
      WHERE venda_id = ? AND tipo_recebimento = 'nao_fiscal'
    `, [id], (recExistErr, recebimentosExistentes) => {
      if (recExistErr) {
        res.status(500).json({ error: recExistErr.message });
        return;
      }

      const saldoExistente = calcularSaldoNaoFiscal(venda, recebimentosExistentes);
      if (saldoExistente.saldoPendente <= 0 && saldoExistente.valorRecebido > 0) {
        verificarSaldoOutrosVenda(id, venda.valor_outros, (outrosErr, saldoOutros) => {
          if (outrosErr) {
            res.status(500).json({ error: outrosErr.message });
            return;
          }
          const statusFinal = saldoOutros > 0.01 ? 'pendente' : 'quitada';
          db.run(
            `UPDATE vendas SET status_pagamento = ? WHERE id = ?`,
            [statusFinal, id],
            (updErr) => {
              if (updErr) {
                res.status(500).json({ error: updErr.message });
                return;
              }
              res.json({
                id: Number(id),
                codigo: venda.codigo,
                status_pagamento: statusFinal,
                message: statusFinal === 'quitada'
                  ? 'Venda não fiscal já finalizada.'
                  : 'Pagamento não fiscal registrado; há saldo de Outros pendente.',
                saldo_pendente: saldoOutros,
                fiscal: null,
                idempotente: true
              });
            }
          );
        });
        return;
      }

      const totalInformado = pagamentosInformados.reduce(
        (acc, p) => acc + Number(p.valor || 0),
        0
      );
      const totalEsperado = Number(venda.valor_outros || 0) > 0
        ? valorNaoFiscalVenda
        : Number(venda.total || valorNaoFiscalVenda || 0);

      if (Math.abs(totalInformado - totalEsperado) > 0.01) {
        res.status(400).json({
          error: 'Valor informado não confere com o total da venda não fiscal.',
          saldo_pendente: totalEsperado
        });
        return;
      }

      if (totalInformado - totalEsperado > 0.01) {
        res.status(400).json({
          error: 'Valor recebido maior que o total da venda não fiscal.',
          saldo_pendente: totalEsperado
        });
        return;
      }

      const recebimentos = pagamentosInformados.map((pagamento) => ({
        tipo_recebimento: 'nao_fiscal',
        forma_pagamento: String(pagamento.forma_pagamento).toLowerCase().trim(),
        valor: Number(pagamento.valor || 0),
        tef_transacao_id: pagamento.tef_transacao_id || null,
        nsu: pagamento.nsu || null,
        autorizacao: pagamento.autorizacao || null
      }));

      db.serialize(() => {
        db.run('BEGIN IMMEDIATE');

        gravarRecebimentos(id, recebimentos, (gravarErr) => {
          if (gravarErr) {
            db.run('ROLLBACK');
            res.status(500).json({ error: gravarErr.message });
            return;
          }

          verificarSaldoOutrosVenda(id, venda.valor_outros, (outrosErr, saldoOutros) => {
            if (outrosErr) {
              db.run('ROLLBACK');
              res.status(500).json({ error: outrosErr.message });
              return;
            }
            const statusFinal = saldoOutros > 0.01 ? 'pendente' : 'quitada';
            db.run(
              `UPDATE vendas SET status_pagamento = ? WHERE id = ?`,
              [statusFinal, id],
              (updateErr) => {
                if (updateErr) {
                  db.run('ROLLBACK');
                  res.status(500).json({ error: updateErr.message });
                  return;
                }

                db.run('COMMIT', async (commitErr) => {
                  if (commitErr) {
                    res.status(500).json({ error: commitErr.message });
                    return;
                  }

                  res.json({
                    id: Number(id),
                    codigo: venda.codigo,
                    status_pagamento: statusFinal,
                    message: statusFinal === 'quitada'
                      ? 'Venda não fiscal finalizada com sucesso.'
                      : 'Pagamento não fiscal registrado; há saldo de Outros pendente.',
                    saldo_pendente: saldoOutros,
                    fiscal: null
                  });
                });
              }
            );
          });
        });
      });
    });
    return;
  }

  if (valorFiscalVenda <= 0) {
    if (venda.status_pagamento === 'quitada') {
      res.json({
        id: Number(id),
        codigo: venda.codigo,
        status_pagamento: 'quitada',
        message: 'Venda sem itens fiscais já finalizada. NFC-e não necessária.',
        saldo_pendente: 0,
        fiscal: {
          success: true,
          status: 'sem_itens_fiscais',
          message: 'Venda sem itens fiscais. NFC-e não necessária.'
        }
      });
      return;
    }

    res.status(400).json({
      error: 'Venda sem itens fiscais deve ser finalizada em POST /vendas.',
      status_pagamento: venda.status_pagamento
    });
    return;
  }

  if (venda.status_pagamento === 'quitada') {
    res.json({
      id: Number(id),
      codigo: venda.codigo,
      status_pagamento: 'quitada',
      message: 'Pagamento não fiscal já registrado.',
      saldo_pendente: 0,
      fiscal: null,
      idempotente: true
    });
    return;
  }

  if (venda.status_pagamento !== 'aguardando_nao_fiscal') {
    res.status(400).json({
      error: 'Venda não está aguardando pagamento não fiscal.',
      status_pagamento: venda.status_pagamento
    });
    return;
  }

  db.all(`
    SELECT *
    FROM venda_recebimentos
    WHERE venda_id = ? AND tipo_recebimento = 'nao_fiscal'
  `, [id], (recErr, recebimentosAtuais) => {
    if (recErr) {
      res.status(500).json({ error: recErr.message });
      return;
    }

    const saldo = calcularSaldoNaoFiscal(venda, recebimentosAtuais);

    if (saldo.saldoPendente <= 0) {
      verificarSaldoOutrosVenda(id, venda.valor_outros, (outrosErr, saldoOutros) => {
        if (outrosErr) {
          res.status(500).json({ error: outrosErr.message });
          return;
        }
        const statusFinal = saldoOutros > 0.01 ? 'pendente' : 'quitada';
        db.run(
          `UPDATE vendas SET status_pagamento = ? WHERE id = ? AND status_pagamento = 'aguardando_nao_fiscal'`,
          [statusFinal, id],
          (updErr) => {
            if (updErr) {
              res.status(500).json({ error: updErr.message });
              return;
            }
            res.json({
              id: Number(id),
              codigo: venda.codigo,
              status_pagamento: statusFinal,
              message: statusFinal === 'quitada'
                ? 'Pagamento não fiscal já registrado.'
                : 'Pagamento não fiscal registrado; há saldo de Outros pendente.',
              saldo_pendente: saldoOutros,
              fiscal: null,
              idempotente: true
            });
          }
        );
      });
      return;
    }

    const totalInformado = pagamentosInformados.reduce(
      (acc, p) => acc + Number(p.valor || 0),
      0
    );

    if (totalInformado - saldo.saldoPendente > 0.01) {
      res.status(400).json({
        error: 'Valor recebido maior que o saldo não fiscal pendente.',
        saldo_pendente: saldo.saldoPendente
      });
      return;
    }

    if (Math.abs(totalInformado - saldo.saldoPendente) > 0.01) {
      res.status(400).json({
        error: 'Valor informado não confere com o saldo não fiscal pendente.',
        saldo_pendente: saldo.saldoPendente
      });
      return;
    }

    const recebimentos = pagamentosInformados.map((pagamento) => ({
      tipo_recebimento: 'nao_fiscal',
      forma_pagamento: String(pagamento.forma_pagamento).toLowerCase().trim(),
      valor: Number(pagamento.valor || 0),
      tef_transacao_id: null,
      nsu: pagamento.nsu || null,
      autorizacao: pagamento.autorizacao || null
    }));

    db.serialize(() => {
      db.run('BEGIN IMMEDIATE');

      gravarRecebimentos(id, recebimentos, (gravarErr) => {
        if (gravarErr) {
          db.run('ROLLBACK');
          res.status(500).json({ error: gravarErr.message });
          return;
        }

        const recebimentosNaoFiscalRegistrados = [
          ...(Array.isArray(recebimentosAtuais) ? recebimentosAtuais : []),
          ...recebimentos
        ];
        const statusFinanceiro = resolverStatusPagamentoVenda(
          venda.valor_nao_fiscal,
          recebimentosNaoFiscalRegistrados,
          'quitada',
          { valorFiscal: valorFiscalVenda }
        );

        if (statusFinanceiro !== 'quitada') {
          db.run('ROLLBACK');
          res.status(400).json({
            error: 'Recebimento insuficiente para quitar a venda.',
            status_pagamento: statusFinanceiro,
            saldo_pendente: calcularSaldoNaoFiscal(venda, recebimentosNaoFiscalRegistrados).saldoPendente
          });
          return;
        }

        verificarSaldoOutrosVenda(id, venda.valor_outros, (outrosErr, saldoOutros) => {
          if (outrosErr) {
            db.run('ROLLBACK');
            res.status(500).json({ error: outrosErr.message });
            return;
          }
          const statusFinal = saldoOutros > 0.01 ? 'pendente' : statusFinanceiro;
          db.run(
            `UPDATE vendas SET status_pagamento = ? WHERE id = ?`,
            [statusFinal, id],
            (updateErr) => {
              if (updateErr) {
                db.run('ROLLBACK');
                res.status(500).json({ error: updateErr.message });
                return;
              }

              db.run('COMMIT', async (commitErr) => {
                if (commitErr) {
                  res.status(500).json({ error: commitErr.message });
                  return;
                }

                const fiscal = await emitirFiscalSeSolicitado(id, req.body.emitir_fiscal, venda);

                res.json({
                  id: Number(id),
                  codigo: venda.codigo,
                  status_pagamento: statusFinal,
                  message: saldoOutros > 0.01
                    ? 'Pagamento não fiscal registrado; há saldo de Outros pendente.'
                    : 'Pagamento não fiscal registrado com sucesso.',
                  saldo_pendente: saldoOutros,
                  fiscal
                });
              });
            }
          );
        });
      });
    });
  });
    });
  })
  .catch((err) => responderErroEmpresaVenda(res, err));
}

module.exports = {
  reduzirEstoqueComFEFO,
  reduzirEstoqueDistribuido,
  atualizarStatusPagamentoVenda,
  flattenRecebimentos,
  gravarRecebimentos,
  processarPagamentosTef,
  calcularSaldoNaoFiscal,
  filtrarRecebimentosNaoFiscal,
  resolverStatusPagamentoVenda,
  aplicarRegraStatusPagamentoVenda,
  normalizarPagamentosNaoFiscal,
  carregarPoliticaFiscalComercialPassiva,
  validarPagamentosNaoFiscal,
  obterTerminalId,
  preCalcularDistribuicao,
  criarVenda,
  consultarPagamentoNaoFiscal,
  registrarPagamentoNaoFiscal,
  // RC3.15.11
  resolverVendaFiscalParaMotor
};
