/**
 * Adaptador de Smart POS só para testes.
 * Não fala com adquirente, SDK ou terminal físico.
 * A resposta aprovada tem o formato do TEF, marcada como simulação.
 */
'use strict';

const BaseAdapter = require('./BaseAdapter');
const tefContrato = require('../tefContrato');
const contrato = require('../smartPosContrato');

class SmartPosSimuladorAdapter extends BaseAdapter {
  constructor(config = {}) {
    super(config);
    this.nome = 'smart_pos_simulador';
    this.modo = 'simulacao';
    this.simulado = true;
    this.registros = new Map();
    this.porChave = new Map();
    this.sequencia = 0;
  }

  identificarTerminal() {
    return contrato.identificarTerminal(this.config);
  }

  _recusarVinculo(registro, codigo, mensagem) {
    return tefContrato.criarRespostaAutorizacao({
      sucesso: false,
      status: tefContrato.STATUS.NEGADO,
      codigo,
      mensagem,
      transacaoId: registro.id,
      modo: this.modo,
      payloadRetorno: this._payload(registro, { repetida: true })
    });
  }

  _payload(registro, extra = {}) {
    return {
      simulado: true,
      contrato: 'smart_pos',
      estado: registro.estado,
      modalidade: registro.modalidade,
      valor: registro.valor,
      empresa_id: registro.empresa_id,
      operador_id: registro.operador_id,
      idempotency_key: registro.idempotency_key,
      terminal_id: registro.terminal_id,
      ...extra
    };
  }

  _resposta(registro, extra = {}) {
    if (registro.venda_id != null) {
      return this._recusarVinculo(
        registro,
        'TRANSACAO_JA_VINCULADA',
        'A transação simulada já está vinculada a uma venda.'
      );
    }
    const status = contrato.paraStatusTef(registro.estado);
    const aprovado = status === tefContrato.STATUS.APROVADO;
    return tefContrato.criarRespostaAutorizacao({
      sucesso: aprovado,
      status,
      transacaoId: registro.id,
      codigo: extra.repetida ? 'SOLICITACAO_REPETIDA' : 'SMART_POS_SIMULADO',
      mensagem: aprovado
        ? 'Pagamento simulado. Não é recebimento real.'
        : 'Resultado simulado. Nada foi recebido.',
      modo: this.modo,
      adquirente: 'SIMULADOR',
      payloadRetorno: this._payload(registro, extra)
    });
  }

  _divergente(registro, codigo, mensagem) {
    return tefContrato.criarRespostaAutorizacao({
      sucesso: false,
      status: tefContrato.STATUS.NEGADO,
      codigo,
      mensagem,
      modo: this.modo,
      payloadRetorno: { simulado: true, contrato: 'smart_pos' }
    });
  }

  async autorizarPagamento(dados = {}) {
    const solicitacao = contrato.criarSolicitacao(dados);
    if (!solicitacao.ok) {
      return tefContrato.criarRespostaAutorizacao({
        sucesso: false,
        status: tefContrato.STATUS.ERRO,
        codigo: solicitacao.codigo,
        mensagem: solicitacao.mensagem,
        modo: this.modo,
        payloadRetorno: { simulado: true, contrato: 'smart_pos' }
      });
    }
    const chave = solicitacao.idempotency_key;
    if (chave && this.porChave.has(chave)) {
      const existente = this.porChave.get(chave);
      if (existente.empresa_id !== solicitacao.empresa_id) {
        return this._divergente(existente, 'TEF_EMPRESA_DIVERGENTE', 'A solicitação pertence a outra empresa.');
      }
      if (existente.operador_id !== solicitacao.operador_id) {
        return this._divergente(existente, 'TEF_OPERADOR_DIVERGENTE', 'A solicitação pertence a outro operador.');
      }
      return this._resposta(existente, { repetida: true });
    }
    const estado = contrato.estadoDoPedido(dados.resultado_simulado);
    if (!estado) {
      return tefContrato.criarRespostaAutorizacao({
        sucesso: false,
        status: tefContrato.STATUS.ERRO,
        codigo: 'RESULTADO_SIMULADO_AUSENTE',
        mensagem: 'O simulador exige o resultado de teste. Nada foi aprovado.',
        modo: this.modo,
        payloadRetorno: { simulado: true, contrato: 'smart_pos' }
      });
    }
    if (estado === contrato.ESTADO.FALHA) {
      const erro = new Error('Falha de comunicação com o terminal simulado.');
      erro.codigo = 'FALHA_COMUNICACAO';
      throw erro;
    }
    if (estado === contrato.ESTADO.TIMEOUT) {
      const erro = new Error('Timeout do terminal simulado.');
      erro.codigo = 'TIMEOUT';
      throw erro;
    }
    const registro = {
      ...solicitacao,
      id: 'sim-' + (++this.sequencia),
      estado,
      venda_id: null
    };
    this.registros.set(registro.id, registro);
    if (chave) this.porChave.set(chave, registro);
    return this._resposta(registro);
  }

  _idDoNucleo(transacaoId) {
    const numero = Number(transacaoId);
    return Number.isInteger(numero) && numero > 0 && String(transacaoId) === String(numero);
  }

  _lerPersistida(transacaoId) {
    if (!this._idDoNucleo(transacaoId)) return Promise.resolve(null);
    const db = require('../../../database');
    return new Promise((resolve, reject) => {
      db.get(`
        SELECT id, status, venda_id, empresa_id, operador_id, valor, tipo, provedor, adquirente, idempotency_key
        FROM tef_transacoes
        WHERE id = ?
      `, [Number(transacaoId)], (err, row) => {
        if (err) return reject(err);
        if (!row || row.provedor !== 'smart_pos_simulador') return resolve(null);
        resolve(row);
      });
    });
  }

  _consultaPersistida(row) {
    const status = row.status === 'timeout' ? 'timeout' : row.status;
    const resposta = tefContrato.criarRespostaConsulta({
      sucesso: false,
      status: status === 'timeout' ? tefContrato.STATUS.ERRO : status,
      transacaoId: row.id,
      mensagem: row.venda_id != null
        ? 'A transação simulada já está vinculada a uma venda.'
        : 'Consulta da transação simulada gravada.',
      modo: this.modo,
      dados: {
        simulado: true,
        contrato: 'smart_pos',
        codigo: row.venda_id != null ? 'TRANSACAO_JA_VINCULADA' : 'SMART_POS_SIMULADO',
        estado: status,
        modalidade: row.tipo,
        valor: Number(row.valor),
        empresa_id: row.empresa_id,
        operador_id: row.operador_id,
        idempotency_key: row.idempotency_key,
        recebimento_real: false
      }
    });
    resposta.status = status;
    resposta.sucesso = false;
    return resposta;
  }

  async consultarTransacao(transacaoId) {
    const registro = this.registros.get(String(transacaoId || ''));
    if (!registro) {
      const persistida = await this._lerPersistida(transacaoId);
      if (persistida) return this._consultaPersistida(persistida);
      return tefContrato.criarRespostaConsulta({
        sucesso: false,
        status: tefContrato.STATUS.PENDENTE,
        transacaoId,
        mensagem: 'Transação simulada não encontrada.',
        modo: this.modo,
        dados: { simulado: true, codigo: 'TRANSACAO_INEXISTENTE' }
      });
    }
    const resposta = this._resposta(registro);
    return tefContrato.criarRespostaConsulta({
      sucesso: resposta.sucesso === true && registro.venda_id == null,
      status: resposta.status,
      transacaoId: registro.id,
      mensagem: resposta.mensagem,
      modo: this.modo,
      dados: resposta.payloadRetorno
    });
  }

  async cancelarPagamento(dados) {
    const normalizado = this._normalizarDadosCancelamento(dados);
    const registro = this.registros.get(String(normalizado.transacao_id || ''));
    if (!registro) {
      const persistida = await this._lerPersistida(normalizado.transacao_id);
      if (!persistida) {
        return tefContrato.criarRespostaCancelamento({
          sucesso: false,
          status: tefContrato.STATUS.ERRO,
          codigo: 'TRANSACAO_INEXISTENTE',
          mensagem: 'Não há transação simulada para cancelar.',
          modo: this.modo
        });
      }
      if (persistida.venda_id != null) {
        return tefContrato.criarRespostaCancelamento({
          sucesso: false,
          status: tefContrato.STATUS.NEGADO,
          transacaoId: persistida.id,
          codigo: 'TRANSACAO_JA_VINCULADA',
          mensagem: 'A transação simulada já está vinculada a uma venda.',
          modo: this.modo
        });
      }
      return tefContrato.criarRespostaCancelamento({
        sucesso: true,
        status: tefContrato.STATUS.CANCELADO,
        transacaoId: persistida.id,
        codigo: 'SMART_POS_SIMULADO',
        mensagem: 'Cancelamento simulado. Nada foi recebido.',
        modo: this.modo,
        payloadRetorno: { simulado: true, contrato: 'smart_pos', estado: 'cancelada' }
      });
    }
    if (registro.venda_id != null) {
      return tefContrato.criarRespostaCancelamento({
        sucesso: false,
        status: tefContrato.STATUS.NEGADO,
        transacaoId: registro.id,
        codigo: 'TRANSACAO_JA_VINCULADA',
        mensagem: 'A transação simulada já está vinculada a uma venda.',
        modo: this.modo
      });
    }
    registro.estado = contrato.ESTADO.CANCELADA;
    return tefContrato.criarRespostaCancelamento({
      sucesso: true,
      status: tefContrato.STATUS.CANCELADO,
      transacaoId: registro.id,
      codigo: 'SMART_POS_SIMULADO',
      mensagem: 'Cancelamento simulado. Nada foi recebido.',
      modo: this.modo,
      payloadRetorno: this._payload(registro)
    });
  }

  vincularVenda(transacaoId, vendaId) {
    const registro = this.registros.get(String(transacaoId || ''));
    if (!registro || registro.estado !== contrato.ESTADO.APROVADA || registro.venda_id != null) {
      return { ok: false, codigo: 'VINCULO_RECUSADO' };
    }
    registro.venda_id = Number(vendaId);
    return { ok: true, transacao_id: registro.id, venda_id: registro.venda_id };
  }
}

module.exports = SmartPosSimuladorAdapter;
