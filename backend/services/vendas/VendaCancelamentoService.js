'use strict';

const crypto = require('crypto');
const db = require('../../database');
const { gravarAuditoria } = require('../auditoria');
const { validarMotivoTexto } = require('../validacao/validarMotivoTexto');
const { cancelarFiscal } = require('../tef/ReversaoFiscal');
const VendaDevolucaoService = require('./VendaDevolucaoService');
const VendaFiscalService = require('./VendaFiscalService');
const { cancelarFinanceiroVenda } = require('./VendaFinanceiroService');
const mpfc = require('../mpfc');
const { montarOpcoesRetornoEstoqueDaVenda } = require('./creditoEstoqueVendaViaPorta');
const { estornarConsumoFichaTecnicaDaVendaCb } = require('../produtos/FichaTecnicaConsumoService');
const {
  exigirOperacaoReversaoDaVenda,
  responderErroEmpresaVenda
} = require('./VendaEmpresaContextoService');
const {
  resolverEmpresaDaOrigemFinanceira
} = require('../financeiro/FinanceiroEmpresaContextoService');
const { logFiscalRuntime } = require('../fiscal/core/FiscalRuntimeLog');
const PedidoConsumoEstoqueService = require('../pedido/PedidoConsumoEstoqueService');
const {
  criarAutorizacaoCancelamentoOperador
} = require('../fiscal/autorizacaoTransmissaoSefaz');

const { devolverEstoqueItensVenda } = VendaDevolucaoService;
const {
  buscarNfceAutorizadaVenda,
  cancelarNfceAutorizadaVenda
} = VendaFiscalService;

function autorizacaoCancelamentoDaRequisicao(req) {
  return criarAutorizacaoCancelamentoOperador({
    empresaId: req.empresaId,
    usuarioId: req.user?.id || null
  });
}

/**
 * Único ponto de estoque no cancelamento: item comercial + estorno do snapshot da ficha.
 * Empresa: vendas.empresa_id (montarOpcoesRetornoEstoqueDaVenda).
 */
function devolverEstoqueEEstornarFichaDaVenda(itens, venda, req, dbConn, callback) {
  const opcoes = montarOpcoesRetornoEstoqueDaVenda(venda, req, 'cancelamento_venda', dbConn);
  const obter = (sql, params = []) => new Promise((resolve, reject) => {
    dbConn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
  const obterPedidoId = async () => {
    if (Number(venda.pedido_id) > 0) return Number(venda.pedido_id);
    try {
      const operacao = await obter(
        `SELECT pedido_id
           FROM pedido_faturamento_operacoes
          WHERE venda_id = ? AND empresa_id = ? AND tipo_operacao = 'PDV_COMPOSICAO'`,
        [Number(venda.id), Number(opcoes.empresaId)]
      );
      return operacao ? Number(operacao.pedido_id) : null;
    } catch (err) {
      if (/no such table/i.test(String(err.message || ''))) return null;
      throw err;
    }
  };

  (async () => {
    const pedidoId = await obterPedidoId();
    if (
      pedidoId
      && await PedidoConsumoEstoqueService.jaConsumido(pedidoId, { db: dbConn })
    ) {
      await PedidoConsumoEstoqueService.solicitarEstorno({
        db: dbConn,
        pedidoId,
        empresaId: opcoes.empresaId,
        chaveIdempotencia: `cancelamento-venda-${Number(venda.id)}`,
        usuarioId: opcoes.usuarioId,
        jaEmTransacao: true
      });
      return;
    }

    await new Promise((resolve, reject) => {
      devolverEstoqueItensVenda(itens, (estErr) => {
        if (estErr) return reject(estErr);
        estornarConsumoFichaTecnicaDaVendaCb({
          vendaId: Number(venda.id),
          empresaId: opcoes.empresaId,
          db: dbConn,
          usuarioId: opcoes.usuarioId
        }, (fichaErr) => (fichaErr ? reject(fichaErr) : resolve()));
      }, opcoes);
    });
  })().then(() => callback(null)).catch(callback);
}

/**
 * RC8.2.2 — política operacional da venda via snapshot (nunca configuração atual).
 */
function anexarPoliticaSnapshotAuditoria(venda, contexto) {
  const resolvido = mpfc.resolverPoliticaOperacionalDaVenda(venda, contexto);
  return {
    mpfc_snapshot_presente: resolvido.snapshotPresente,
    mpfc_fonte: resolvido.fonte,
    mpfc_politica: resolvido.payload
  };
}

function cancelarRecebimentosVenda(vendaId, callback) {
  db.run(`
    UPDATE venda_recebimentos
    SET status = 'cancelado'
    WHERE venda_id = ?
      AND tipo_recebimento = 'fiscal'
      AND COALESCE(status, 'aprovado') != 'cancelado'
  `, [vendaId], (errFiscal) => {
    if (errFiscal) return callback(errFiscal);

    db.run(`
      UPDATE venda_recebimentos
      SET status = 'cancelado'
      WHERE venda_id = ?
        AND tipo_recebimento = 'nao_fiscal'
        AND COALESCE(status, 'aprovado') != 'cancelado'
    `, [vendaId], callback);
  });
}

function cancelarVendaPut(id, motivo, req, res) {
db.get('SELECT * FROM vendas WHERE id = ?', [id], (err, venda) => {
  if (err) {
    res.status(500).json({ error: err.message });
    return;
  }
  try {
    exigirOperacaoReversaoDaVenda(venda, req.empresaId);
  } catch (ownErr) {
    return responderErroEmpresaVenda(res, ownErr);
  }
  if (venda.status !== 'concluida') {
    res.status(400).json({ error: 'Apenas vendas concluídas podem ser canceladas.' });
    return;
  }

      gravarAuditoria({
        usuario_id: req.operadorId || req.user?.id || null,
        usuario_nome: req.user?.username || req.user?.nome || null,
        modulo: 'vendas',
        acao: 'cancelar_venda',
        referencia_tipo: 'venda',
        referencia_id: id,
        detalhes: {
          motivo_cancelamento: req.body.motivo || null,
          ip: req.ip,
          sessao_id: req.caixaSessaoId || null,
          ...anexarPoliticaSnapshotAuditoria(venda, 'cancelamento')
        },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao gravar auditoria de cancelamento de venda:', auditErr));

  const executarCancelamentoVenda = () => {
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE');

    db.all('SELECT * FROM vendas_itens WHERE venda_id = ?', [id], (itErr, itens) => {
      if (itErr) {
        db.run('ROLLBACK');
        res.status(500).json({ error: itErr.message });
        return;
      }

      const finalizarCancelamento = () => {
        cancelarRecebimentosVenda(id, (recErr) => {
          if (recErr) {
            db.run('ROLLBACK');
            res.status(500).json({ error: recErr.message });
            return;
          }

        db.run(`
          UPDATE vendas
          SET status = 'cancelada',
              cancelada = 1,
              data_cancelamento = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [id], (upErr) => {
          if (upErr) {
            db.run('ROLLBACK');
            res.status(500).json({ error: upErr.message });
            return;
          }

          cancelarFinanceiroVenda(id, {
            venda,
            empresaId: req.empresaId,
            gerenciarTransacao: false
          })
            .then(() => {
              db.run(`
                INSERT INTO financeiro (
                  tipo, descricao, valor, data_movimento, categoria, forma_pagamento,
                  referencia_id, referencia_tipo, status, origem, documento, vencimento,
                  venda_id, baixado_em, empresa_id
                ) VALUES ('despesa', ?, ?, ?, 'estorno_venda', 'estorno', ?, 'estorno_venda', 'pago', 'cancelamento_venda', ?, ?, ?, ?, ?)
              `, [
                `Estorno cancelamento ${venda.codigo}`,
                venda.total,
                venda.data_venda,
                id,
                venda.codigo,
                venda.data_venda,
                id,
                venda.data_venda,
                resolverEmpresaDaOrigemFinanceira({ venda })
              ], (finErr) => {
                if (finErr) {
                  db.run('ROLLBACK');
                  res.status(500).json({ error: finErr.message });
                  return;
                }

                if (venda.forma_pagamento === 'credito' && venda.cliente_id) {
                  db.run(`
                    UPDATE clientes
                    SET credito_atual = CASE
                      WHEN (credito_atual - ?) < 0 THEN 0
                      ELSE credito_atual - ?
                    END
                    WHERE id = ?
                  `, [venda.total, venda.total, venda.cliente_id], (credErr) => {
                    if (credErr) {
                      db.run('ROLLBACK');
                      res.status(500).json({ error: credErr.message });
                      return;
                    }
                    db.run('COMMIT');
                    res.json({ message: 'Venda cancelada com sucesso' });
                  });
                } else {
                  db.run('COMMIT');
                  res.json({ message: 'Venda cancelada com sucesso' });
                }
              });
            })
            .catch((finCancelErr) => {
              db.run('ROLLBACK');
              res.status(500).json({ error: finCancelErr.message });
            });
        });
        });
      };

      devolverEstoqueEEstornarFichaDaVenda(itens, venda, req, db, (estErr) => {
        if (estErr) {
          db.run('ROLLBACK');
          res.status(500).json({ error: estErr.message });
          return;
        }
        finalizarCancelamento();
      });
    });
  });
  };

  buscarNfceAutorizadaVenda(id, (nfceErr, nfce) => {
    if (nfceErr) {
      return res.status(500).json({ error: nfceErr.message });
    }

    if (!nfce) {
      return executarCancelamentoVenda();
    }

    const validacaoNfce = validarMotivoTexto(motivo);
    if (!validacaoNfce.valido) {
      return res.status(400).json({
        error: `${validacaoNfce.erro} (obrigatório para cancelar NFC-e autorizada)`
      });
    }

    cancelarNfceAutorizadaVenda(id, motivo, {
      empresaIdContexto: req.empresaId,
      autorizacaoTransmissaoSefaz: autorizacaoCancelamentoDaRequisicao(req)
    })
      .then(() => executarCancelamentoVenda())
      .catch((cancelErr) => res.status(cancelErr.statusCode || 400).json({
        success: false,
        error: cancelErr.message,
        code: cancelErr.code,
        resultUnknown: cancelErr.resultUnknown === true
      }));
  });
});
}

function cancelarVendaPost(vendaId, motivo, req, res) {
const correlationId = crypto.randomUUID();
db.get(
  'SELECT * FROM vendas WHERE id = ?',
  [vendaId],
  (err, venda) => {
    if (err) {
      return res.status(500).json({
        sucesso: false,
        mensagem: err.message
      });
    }
    try {
      exigirOperacaoReversaoDaVenda(venda, req.empresaId);
    } catch (ownErr) {
      const status = ownErr.statusCode || ownErr.status || 400;
      return res.status(status).json({
        sucesso: false,
        mensagem: ownErr.message || 'Venda não encontrada.',
        error: ownErr.message,
        code: ownErr.code
      });
    }

    if (venda.cancelada === 1) {
      return res.status(400).json({
        sucesso: false,
        mensagem: 'Venda já cancelada.'
      });
    }

    const estornarTefFiscal = () => {
      if (
        venda.status_pagamento !== 'fiscal_pago'
        && venda.status_pagamento !== 'aguardando_nao_fiscal'
      ) {
        return Promise.resolve();
      }
      if (!venda.tef_transacao_id) return Promise.resolve();

      const started = process.hrtime.bigint();
      return cancelarFiscal(venda.tef_transacao_id, motivo || 'Cancelamento de venda')
        .then((result) => {
          logFiscalRuntime('CANCELAMENTO_COMERCIAL', {
            correlationId,
            etapa: 'estorno_tef',
            duracaoMs: Number(process.hrtime.bigint() - started) / 1e6
          });
          return result;
        });
    };

    const prosseguirCancelamento = () => {
      buscarNfceAutorizadaVenda(vendaId, (errNfce, nfceAutorizada) => {
        if (errNfce) {
          return res.status(500).json({
            sucesso: false,
            mensagem: 'Erro ao verificar NFC-e.'
          });
        }

        const executarCancelamentoLocal = () => {
          const started = process.hrtime.bigint();
          db.serialize(() => {
            db.run('BEGIN IMMEDIATE');

            db.all(
              'SELECT * FROM vendas_itens WHERE venda_id = ?',
              [vendaId],
              (errItens, itens) => {
                if (errItens) {
                  db.run('ROLLBACK');
                  return res.status(500).json({
                    sucesso: false,
                    mensagem: 'Erro ao buscar itens.'
                  });
                }

                devolverEstoqueEEstornarFichaDaVenda(itens, venda, req, db, (estErr) => {
                  logFiscalRuntime('CANCELAMENTO_COMERCIAL', {
                    correlationId,
                    etapa: 'estoque',
                    duracaoMs: Number(process.hrtime.bigint() - started) / 1e6,
                    resultado: estErr ? 'falha' : 'concluido'
                  });
                  if (estErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({
                      sucesso: false,
                      mensagem: estErr.message
                    });
                  }

                  const recebimentosStarted = process.hrtime.bigint();
                  cancelarRecebimentosVenda(vendaId, (recErr) => {
                    logFiscalRuntime('CANCELAMENTO_COMERCIAL', {
                      correlationId,
                      etapa: 'recebimentos',
                      duracaoMs: Number(process.hrtime.bigint() - recebimentosStarted) / 1e6,
                      resultado: recErr ? 'falha' : 'concluido'
                    });
                    if (recErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({
                        sucesso: false,
                        mensagem: recErr.message
                      });
                    }

                    db.run(
                      `
                      UPDATE vendas
                      SET
                        cancelada = 1,
                        status = 'cancelada',
                        data_cancelamento = CURRENT_TIMESTAMP
                      WHERE id = ?
                      `,
                      [vendaId],
                      function (errUpdate) {
                        if (errUpdate) {
                          db.run('ROLLBACK');
                          return res.status(500).json({
                            sucesso: false,
                            mensagem: errUpdate.message
                          });
                        }

                        db.run(
                          `
                          INSERT INTO vendas_canceladas (
                            venda_id,
                            motivo,
                            usuario_id
                          ) VALUES (?, ?, ?)
                          `,
                          [
                            vendaId,
                            motivo || 'Não informado',
                            req.operadorId || req.user?.id || null
                          ]
                        );

                        const financeiroStarted = process.hrtime.bigint();
                        cancelarFinanceiroVenda(vendaId, {
                          venda,
                          empresaId: req.empresaId,
                          gerenciarTransacao: false
                        })
                          .then(() => {
                            logFiscalRuntime('CANCELAMENTO_COMERCIAL', {
                              correlationId,
                              etapa: 'financeiro',
                              duracaoMs: Number(process.hrtime.bigint() - financeiroStarted) / 1e6,
                              resultado: 'concluido'
                            });
                            db.run('COMMIT', (commitErr) => {
                              if (commitErr) {
                                db.run('ROLLBACK');
                                return res.status(500).json({
                                  sucesso: false,
                                  mensagem: commitErr.message
                                });
                              }
                              logFiscalRuntime('CANCELAMENTO_COMERCIAL', {
                                correlationId,
                                etapa: 'pos_cancelamento_fiscal_total',
                                duracaoMs: Number(process.hrtime.bigint() - started) / 1e6
                              });
                              gravarAuditoria({
                                usuario_id: req.operadorId || req.user?.id || null,
                                usuario_nome: req.user?.username || req.user?.nome || null,
                                modulo: 'vendas',
                                acao: 'cancelar_venda',
                                referencia_tipo: 'venda',
                                referencia_id: vendaId,
                                detalhes: {
                                  motivo: motivo || null,
                                  ip: req.ip || null,
                                  sessao_id: req.caixaSessaoId || null,
                                  ...anexarPoliticaSnapshotAuditoria(venda, 'cancelamento')
                                },
                                ip_requisicao: req.ip || null
                              }).catch((auditErr) => console.error('Erro ao gravar auditoria de cancelamento de venda:', auditErr));
                              res.json({
                                sucesso: true,
                                mensagem: 'Venda cancelada com sucesso.'
                              });
                            });
                          })
                          .catch((finCancelErr) => {
                            db.run('ROLLBACK');
                            return res.status(500).json({
                              sucesso: false,
                              mensagem: finCancelErr.message
                            });
                          });
                      }
                    );
                  });
                });
              }
            );
          });
        };

        if (!nfceAutorizada) {
          return estornarTefFiscal()
            .then(() => executarCancelamentoLocal())
            .catch((tefErr) => res.status(500).json({
              sucesso: false,
              mensagem: 'Erro ao estornar pagamento fiscal.',
              code: tefErr.code
            }));
        }

        const justificativa = motivo || '';
        const validacaoNfceLocal = validarMotivoTexto(justificativa);
        if (!validacaoNfceLocal.valido) {
          return res.status(400).json({
            sucesso: false,
            mensagem: `${validacaoNfceLocal.erro} (obrigatório para cancelar NFC-e autorizada)`
          });
        }

        cancelarNfceAutorizadaVenda(vendaId, justificativa, {
          empresaIdContexto: req.empresaId,
          correlationId,
          autorizacaoTransmissaoSefaz: autorizacaoCancelamentoDaRequisicao(req)
        })
          .then(() => estornarTefFiscal())
          .then(() => executarCancelamentoLocal())
          .catch((cancelErr) => res.status(cancelErr.statusCode || 400).json({
            sucesso: false,
            mensagem: cancelErr.message,
            code: cancelErr.code,
            resultUnknown: cancelErr.resultUnknown === true,
            status: cancelErr.resultUnknown
              ? 'cancelamento_desconhecido'
              : (cancelErr.code === 'CANCELAMENTO_EM_ANDAMENTO'
                ? 'cancelamento_em_andamento'
                : undefined),
            correlationId: cancelErr.correlationId || correlationId
          }));
      });
    };

    prosseguirCancelamento();
  }
);
}

module.exports = {
  cancelarRecebimentosVenda,
  cancelarVendaPut,
  cancelarVendaPost,
  anexarPoliticaSnapshotAuditoria,
  devolverEstoqueEEstornarFichaDaVenda
};
