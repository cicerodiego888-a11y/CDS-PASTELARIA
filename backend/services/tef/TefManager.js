const { obterAdapter } = require('./tefFactory');
const repository = require('./tefRepository');
const tefEvents = require('./tefEvents');
const tefContrato = require('./tefContrato');
const TefFiscalValidator = require('./tefFiscalValidator');
const DataMaskingService = require('../crypto/dataMaskingService');
const tefLockService = require('./tefLockService');
const tefFraudDetectionService = require('./tefFraudDetectionService');
const tefRetryService = require('./tefRetryService');
const tefCircuitBreakerService = require('./tefCircuitBreakerService');
const tefFailureNotificationService = require('./tefFailureNotificationService');
const tefFluxoPagamento = require('./tefFluxoPagamento');

class TefManager {

  constructor() {
    // Timeout padrão para operações TEF (configurável via variável de ambiente)
    this.timeout = Number(process.env.TEF_TIMEOUT_MS) || 30000; // 30 segundos padrão
  }

  async autorizar(dados, timeoutMs) {
    const operacaoTimeout = timeoutMs || this.timeout;
    const dadosNormalizados = {
      ...dados,
      tipo: tefFluxoPagamento.normalizarTipoTef(dados.tipo)
    };
    
    // Determinar chave do lock (usar idempotency_key ou venda_id)
    const lockKey = dadosNormalizados.idempotency_key || dadosNormalizados.venda_id || `tef_${Date.now()}`;
    
    try {
      // Validar regras fiscais antes de autorizar
      const validacaoFiscal = TefFiscalValidator.validarTransacao(dadosNormalizados);
      if (!validacaoFiscal.valido) {
        return {
          sucesso: false,
          codigo: 'VALIDACAO_FISCAL_FALHOU',
          mensagem: 'Validação fiscal falhou',
          erros: validacaoFiscal.erros
        };
      }

      // Detectar transações suspeitas (fraude)
      const contexto = {
        ip_address: dados.ip_address || null,
        user_agent: dados.user_agent || null
      };
      const analiseFraude = await tefFraudDetectionService.analisarTransacao(dadosNormalizados, contexto);
      
      if (analiseFraude.suspeita) {
        // Registrar alerta de fraude nos logs
        repository.registrarLog(null, 'ALERTA_FRAUDE', `Transação suspeita detectada: ${analiseFraude.alertas.join(', ')}`, {
          nivel_risco: analiseFraude.nivel_risco,
          alertas: analiseFraude.alertas
        });
        
        // Se risco alto, bloquear transação
        if (analiseFraude.nivel_risco === 'alto') {
          return {
            sucesso: false,
            codigo: 'TRANSACAO_SUSPEITA',
            mensagem: 'Transação bloqueada por suspeita de fraude',
            alertas: analiseFraude.alertas,
            nivel_risco: analiseFraude.nivel_risco
          };
        }
      }

      // Verificar idempotência para evitar duplicação
      if (dadosNormalizados.idempotency_key) {
        const transacaoExistente = await this._verificarIdempotencia(dadosNormalizados.idempotency_key);
        if (transacaoExistente) {
          const completa = await this._buscarTransacaoCompleta(transacaoExistente.id);
          const empresaPedido = Number(dadosNormalizados.empresa_id);
          if (
            completa
            && completa.empresa_id != null
            && empresaPedido
            && Number(completa.empresa_id) !== empresaPedido
          ) {
            return {
              sucesso: false,
              aprovado: false,
              codigo: 'TEF_EMPRESA_DIVERGENTE',
              mensagem: 'Transação TEF pertence a outra empresa.',
              transacao_id: transacaoExistente.id,
              status: transacaoExistente.status
            };
          }
          const operadorPedido = Number(dadosNormalizados.operador_id);
          if (
            completa
            && completa.operador_id != null
            && operadorPedido
            && Number(completa.operador_id) !== operadorPedido
          ) {
            return {
              sucesso: false,
              aprovado: false,
              codigo: 'TEF_OPERADOR_DIVERGENTE',
              mensagem: 'Transação TEF pertence a outro operador.',
              status: 'negado'
            };
          }
          if (completa && completa.venda_id != null) {
            return {
              sucesso: false,
              aprovado: false,
              codigo: 'TEF_JA_VINCULADO',
              mensagem: 'Esta autorização TEF já entrou em outra venda. Informe o pagamento novamente.',
              transacao_id: transacaoExistente.id,
              status: 'negado'
            };
          }
          const resposta = tefContrato.paraRespostaApi({
            sucesso: tefContrato.estaAprovado({ status: transacaoExistente.status }),
            status: transacaoExistente.status,
            nsu: completa?.nsu,
            autorizacao: completa?.autorizacao,
            adquirente: completa?.adquirente,
            bandeira: completa?.bandeira,
            comprovanteCliente: completa?.comprovante_cliente,
            comprovanteLoja: completa?.comprovante_estabelecimento,
            codigo: 'TRANSACAO_DUPLICADA',
            mensagem: 'Transação duplicada detectada — retornando existente',
            modo: completa?.provedor === 'smart_pos_simulador' ? 'simulacao' : null,
            simulado: completa?.provedor === 'smart_pos_simulador'
          }, transacaoExistente.id);
          return {
            ...resposta,
            transacao_existente: true
          };
        }
      }

      if (!Number(dadosNormalizados.empresa_id)) {
        return {
          sucesso: false,
          aprovado: false,
          codigo: 'TEF_EMPRESA_AUSENTE',
          mensagem: 'Transação TEF sem empresa autorizada.'
        };
      }

      let adapter;
      try {
        adapter = await obterAdapter();
      } catch (adapterErr) {
        if (adapterErr && adapterErr.code === 'TEF_DESABILITADO') {
          return {
            sucesso: false,
            aprovado: false,
            codigo: 'TEF_DESABILITADO',
            mensagem: adapterErr.message || 'TEF está desabilitado na configuração.',
            status: 'negado'
          };
        }
        throw adapterErr;
      }

      // Executar operação com circuit breaker e retry
      return await tefCircuitBreakerService.executarComCircuitBreaker(
        'tef_autorizacao',
        async () => {
          return await tefRetryService.autorizarComRetry(async () => {
            return await tefLockService.comLock(lockKey, async () => {
              // Criar Promise com timeout
              const operacaoComTimeout = new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                  reject(new Error(`Timeout de ${operacaoTimeout}ms excedido na operação TEF`));
                }, operacaoTimeout);

                repository.criarTransacao({
                  venda_id: dadosNormalizados.venda_id || null,
                  empresa_id: Number(dadosNormalizados.empresa_id),
                  operador_id: Number(dadosNormalizados.operador_id) || null,
                  tipo: dadosNormalizados.tipo,
                  valor: dadosNormalizados.valor,
                  parcelas: dadosNormalizados.parcelas || 1,
                  status: 'pendente',
                  provedor: adapter.nome,
                  idempotency_key: dadosNormalizados.idempotency_key || null
                }, async (err, transacaoId) => {
                  clearTimeout(timeoutId);
                  
                  if (err) {
                    // Se erro for de chave duplicada (idempotency_key), buscar transação existente
                    if (err.message && err.message.includes('UNIQUE constraint')) {
                      const transacaoExistente = await this._buscarPorIdempotencyKey(dadosNormalizados.idempotency_key);
                      if (transacaoExistente) {
                        const completa = await this._buscarTransacaoCompleta(transacaoExistente.id);
                        const operadorPedido = Number(dadosNormalizados.operador_id);
                        if (
                          completa
                          && completa.operador_id != null
                          && operadorPedido
                          && Number(completa.operador_id) !== operadorPedido
                        ) {
                          return resolve({
                            sucesso: false,
                            aprovado: false,
                            codigo: 'TEF_OPERADOR_DIVERGENTE',
                            mensagem: 'Transação TEF pertence a outro operador.',
                            status: 'negado'
                          });
                        }
                        if (completa && completa.venda_id != null) {
                          return resolve({
                            sucesso: false,
                            aprovado: false,
                            codigo: 'TEF_JA_VINCULADO',
                            mensagem: 'Esta autorização TEF já entrou em outra venda. Informe o pagamento novamente.',
                            transacao_id: transacaoExistente.id,
                            status: 'negado'
                          });
                        }
                        return resolve({
                          sucesso: false,
                          codigo: 'TRANSACAO_DUPLICADA',
                          mensagem: 'Transação duplicada detectada',
                          transacao_id: transacaoExistente.id,
                          status: transacaoExistente.status,
                          transacao_existente: true
                        });
                      }
                    }
                    return reject(err);
                  }

                  // Mascarar dados sensíveis nos logs
                  const dadosMascarados = DataMaskingService.mascararObjeto(dadosNormalizados);
                  repository.registrarLog(transacaoId, 'INICIO', 'Transação TEF iniciada', dadosMascarados);

                  tefEvents.emitirEstado(tefEvents.estados.INSIRA_CARTAO);

                  try {
                    const retornoBruto = await adapter.autorizarPagamento(dadosNormalizados);
                    const retorno = tefContrato.criarRespostaAutorizacao({
                      sucesso: retornoBruto.sucesso,
                      status: retornoBruto.status,
                      nsu: retornoBruto.nsu,
                      autorizacao: retornoBruto.autorizacao,
                      adquirente: retornoBruto.adquirente,
                      bandeira: retornoBruto.bandeira,
                      comprovanteCliente: retornoBruto.comprovanteCliente || retornoBruto.comprovante_cliente,
                      comprovanteLoja: retornoBruto.comprovanteLoja || retornoBruto.comprovante_estabelecimento,
                      transacaoId: String(transacaoId),
                      codigo: retornoBruto.codigo,
                      mensagem: retornoBruto.mensagem,
                      payloadRetorno: retornoBruto.payloadRetorno || retornoBruto.payload_retorno,
                      modo: retornoBruto.modo
                    });

                    tefEvents.emitirEstado(tefEvents.estados.PROCESSANDO);

                    const persistencia = tefContrato.paraPersistencia(retorno);

                    repository.atualizarTransacao(transacaoId, {
                      venda_id: dados.venda_id || null,
                      ...persistencia
                    }, (updateErr) => {
                      if (updateErr) {
                        return reject(updateErr);
                      }

                      if (tefContrato.estaAprovado(retorno)) {
                        tefEvents.emitirEstadoPinpad(tefEvents.estadosPinpad.TRANSACAO_APROVADA, { transacaoId });
                        tefEvents.emitirEstado(tefEvents.estados.APROVADO);
                      } else if (retorno.status === tefContrato.STATUS.NEGADO) {
                        tefEvents.emitirEstadoPinpad(tefEvents.estadosPinpad.TRANSACAO_NEGADA, { transacaoId });
                      }

                      const retornoMascarado = DataMaskingService.mascararObjeto(retorno);
                      repository.registrarLog(transacaoId, 'RETORNO', retorno.mensagem, retornoMascarado);

                      resolve(tefContrato.paraRespostaApi(retorno, transacaoId));
                    });
                  } catch (error) {
                    const falhaSimulada = adapter.nome === 'smart_pos_simulador'
                      && (error.codigo === 'TIMEOUT' || error.codigo === 'FALHA_COMUNICACAO');
                    if (falhaSimulada) {
                      const status = error.codigo === 'TIMEOUT' ? 'timeout' : 'erro';
                      repository.atualizarTransacao(transacaoId, {
                        status,
                        adquirente: 'SIMULADOR',
                        codigo_transacao: error.codigo,
                        payload_retorno: {
                          simulado: true,
                          contrato: 'smart_pos',
                          estado: error.codigo === 'TIMEOUT' ? 'timeout' : 'falha'
                        }
                      }, (updateErr) => {
                        if (updateErr) return reject(updateErr);
                        repository.registrarLog(transacaoId, 'ERRO', error.message, {
                          error: error.message,
                          simulado: true
                        });
                        resolve({
                          sucesso: false,
                          aprovado: false,
                          status,
                          codigo: error.codigo,
                          mensagem: error.message,
                          transacao_id: transacaoId,
                          transacaoId: String(transacaoId),
                          modo: 'simulacao',
                          simulado: true,
                          tipo_erro: error.codigo === 'TIMEOUT' ? 'timeout' : 'erro',
                          nsu: null,
                          autorizacao: null
                        });
                      });
                      return;
                    }
                    repository.registrarLog(transacaoId, 'ERRO', error.message, { error: error.message });
                    reject(error);
                  }
                });
              });

              return await operacaoComTimeout;
            }, operacaoTimeout + 10000); // Lock com 10 segundos a mais que o timeout da operação
          }, dados);
        },
        {
          limiteFalhas: 5,
          timeoutAberto: 60000
        }
      );
    } catch (error) {
      // Tratamento específico para diferentes tipos de erro
      if (error.message && error.message.includes('Timeout')) {
        repository.registrarLog(null, 'ERRO_TIMEOUT', error.message, { error: error.message });
        await tefFailureNotificationService.notificarFalhaTimeout({
          mensagem: error.message,
          dados
        });
        return {
          sucesso: false,
          codigo: 'TIMEOUT',
          mensagem: error.message,
          tipo_erro: 'timeout'
        };
      }
      if (error.message && error.message.includes('lock')) {
        repository.registrarLog(null, 'ERRO_LOCK', error.message, { error: error.message });
        return {
          sucesso: false,
          codigo: 'LOCK_NAO_ADQUIRIDO',
          mensagem: 'Operação em andamento, tente novamente',
          tipo_erro: 'conflito'
        };
      }
      if (error.message && error.message.includes('Circuit breaker')) {
        repository.registrarLog(null, 'ERRO_CIRCUIT_BREAKER', error.message, { error: error.message });
        await tefFailureNotificationService.notificarFalhaCircuitBreaker('tef_autorizacao', tefCircuitBreakerService.obterEstado('tef_autorizacao'), error);
        return {
          sucesso: false,
          codigo: 'CIRCUIT_BREAKER_ABERTO',
          mensagem: 'Serviço TEF temporariamente indisponível devido a falhas consecutivas',
          tipo_erro: 'servico_indisponivel'
        };
      }
      if (error.message && error.message.includes('TRANSACAO_SUSPEITA')) {
        repository.registrarLog(null, 'ALERTA_FRAUDE', 'Transação bloqueada por suspeita de fraude', error);
        await tefFailureNotificationService.notificarFalhaFraude(error);
        return {
          sucesso: false,
          codigo: 'TRANSACAO_SUSPEITA',
          mensagem: error.mensagem,
          alertas: error.alertas,
          nivel_risco: error.nivel_risco,
          tipo_erro: 'seguranca'
        };
      }
      
      // Erro genérico
      repository.registrarLog(null, 'ERRO_GENERICO', error.message, { error: error.message, stack: error.stack });
      await tefFailureNotificationService.notificarFalhaGenerica(error, { dados });
      return Promise.reject(error);
    }
  }

  async _verificarIdempotencia(idempotencyKey) {
    return new Promise((resolve, reject) => {
      const db = require('../../database');

      db.get(`
        SELECT id, status, criado_em
        FROM tef_transacoes
        WHERE idempotency_key = ?
        ORDER BY criado_em DESC
        LIMIT 1
      `, [idempotencyKey], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  }

  async _buscarPorIdempotencyKey(idempotencyKey) {
    return new Promise((resolve, reject) => {
      const db = require('../../database');

      db.get(`
        SELECT id, status, criado_em
        FROM tef_transacoes
        WHERE idempotency_key = ?
      `, [idempotencyKey], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  }

  async _buscarTransacaoCompleta(transacaoId) {
    return new Promise((resolve, reject) => {
      const db = require('../../database');
      db.get('SELECT * FROM tef_transacoes WHERE id = ?', [transacaoId], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  }

  async cancelar(transacaoId, motivo = 'Cancelamento da venda') {
    return new Promise((resolve, reject) => {
      const db = require('../../database');

      db.get(`
        SELECT *
        FROM tef_transacoes
        WHERE id = ?
      `, [transacaoId], async (err, transacao) => {
        if (err) return reject(err);

        if (!transacao) {
          return reject(new Error('Transação TEF não encontrada.'));
        }

        if (transacao.status === 'cancelado') {
          return resolve({
            cancelado: true,
            status: 'cancelado',
            mensagem: 'Transação TEF já estava cancelada.',
            transacao_id: transacaoId
          });
        }

        repository.registrarLog(transacaoId, 'CANCELAMENTO_INICIO', 'Cancelamento TEF iniciado', {
          transacaoId,
          motivo
        });

        try {
          const adapter = await obterAdapter();
          const retornoBruto = await adapter.cancelarPagamento({
            transacao_id: transacaoId,
            nsu: transacao.nsu,
            autorizacao: transacao.autorizacao,
            motivo
          });

          const retorno = tefContrato.criarRespostaCancelamento({
            sucesso: retornoBruto.sucesso,
            status: retornoBruto.status,
            nsu: retornoBruto.nsu,
            autorizacao: retornoBruto.autorizacao,
            transacaoId: String(transacaoId),
            codigo: retornoBruto.codigo,
            mensagem: retornoBruto.mensagem,
            payloadRetorno: retornoBruto.payloadRetorno || retornoBruto.payload_retorno,
            modo: retornoBruto.modo
          });

          if (retorno.codigo === 'TRANSACAO_JA_VINCULADA') {
            repository.registrarLog(transacaoId, 'CANCELAMENTO_RECUSADO', retorno.mensagem, {
              simulado: transacao.provedor === 'smart_pos_simulador'
            });
            return resolve({
              sucesso: false,
              aprovado: false,
              status: transacao.status,
              codigo: 'TRANSACAO_JA_VINCULADA',
              mensagem: retorno.mensagem,
              transacao_id: Number(transacaoId),
              transacaoId: String(transacaoId),
              modo: transacao.provedor === 'smart_pos_simulador' ? 'simulacao' : retorno.modo,
              simulado: transacao.provedor === 'smart_pos_simulador'
            });
          }

          db.run(`
            UPDATE tef_transacoes
            SET
              status = ?,
              payload_retorno = ?,
              atualizado_em = datetime('now')
            WHERE id = ?
          `, [
            retorno.status,
            JSON.stringify(retorno),
            transacaoId
          ], (updateErr) => {
            if (updateErr) return reject(updateErr);

            repository.registrarLog(transacaoId, 'CANCELAMENTO_RETORNO', retorno.mensagem, retorno);

            resolve(tefContrato.paraRespostaApi({
              ...retorno,
              status: retorno.status,
              sucesso: retorno.sucesso
            }, transacaoId));
          });

        } catch (error) {
          repository.registrarLog(transacaoId, 'CANCELAMENTO_ERRO', error.message, {
            error: error.message
          });

          reject(error);
        }
      });
    });
  }

  async consultar(transacaoId) {
    try {
      const adapter = await obterAdapter();
      return await adapter.consultarTransacao(transacaoId);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async reimprimir(transacaoId, tipo = 'cliente') {
    try {
      const adapter = await obterAdapter();
      return await adapter.reimprimirComprovante(transacaoId, tipo);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async status() {
    try {
      const adapter = await obterAdapter();
      return await adapter.status();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async vincularNfce(transacaoId, nfceNumero, nfceChave) {
    return new Promise((resolve, reject) => {
      const db = require('../../database');

      db.run(`
        UPDATE tef_transacoes
        SET
          nfce_numero = ?,
          nfce_chave = ?,
          atualizado_em = datetime('now')
        WHERE id = ?
      `, [nfceNumero, nfceChave, transacaoId], (err) => {
        if (err) return reject(err);

        repository.registrarLog(transacaoId, 'NFC_E_VINCULADA', `NFC-e ${nfceNumero} vinculada à transação TEF`, {
          nfce_numero: nfceNumero,
          nfce_chave: nfceChave
        });

        resolve({
          sucesso: true,
          mensagem: 'NFC-e vinculada com sucesso',
          transacao_id: transacaoId,
          nfce_numero: nfceNumero,
          nfce_chave: nfceChave
        });
      });
    });
  }

  /**
   * Consulta uma cobrança já registrada pela estação.
   * Somente leitura: não chama o adaptador e não cria transação.
   */
  async acompanharPorCorrelacao(chave, empresaId, operadorId) {
    if (!Number(operadorId)) {
      return tefContrato.classificarAcompanhamento(null);
    }
    const row = await new Promise((resolve, reject) => {
      const db = require('../../database');
      db.get(`
        SELECT id, status, valor, tipo, venda_id, empresa_id
        FROM tef_transacoes
        WHERE idempotency_key = ? AND empresa_id = ? AND operador_id = ?
        ORDER BY id DESC
        LIMIT 1
      `, [String(chave || ''), Number(empresaId), Number(operadorId)], (err, found) => {
        if (err) return reject(err);
        resolve(found || null);
      });
    });
    return tefContrato.classificarAcompanhamento(row);
  }
}

module.exports = new TefManager();
