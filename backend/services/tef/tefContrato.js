/**
 * Contrato oficial de resposta dos adapters TEF.
 * Todos os adapters devem normalizar retornos via estas funções.
 */

const STATUS = {
  APROVADO: 'aprovado',
  NEGADO: 'negado',
  PENDENTE: 'pendente',
  CANCELADO: 'cancelado',
  ERRO: 'erro'
};

function normalizarStatus(valor) {
  const s = String(valor || '').toLowerCase();
  if (['aprovado', 'approved', 'ok', 'success'].includes(s)) return STATUS.APROVADO;
  if (['negado', 'negada', 'denied', 'reprovado'].includes(s)) return STATUS.NEGADO;
  if (['cancelado', 'cancelada', 'cancelled'].includes(s)) return STATUS.CANCELADO;
  if (['pendente', 'pending', 'processando'].includes(s)) return STATUS.PENDENTE;
  return STATUS.ERRO;
}

function estaAprovado(retorno) {
  if (!retorno) return false;
  if (retorno.sucesso === true && normalizarStatus(retorno.status) === STATUS.APROVADO) return true;
  return normalizarStatus(retorno.status) === STATUS.APROVADO;
}

/**
 * @param {object} params
 * @returns {object} Contrato padronizado de autorização
 */
function criarRespostaAutorizacao({
  sucesso = false,
  status = STATUS.ERRO,
  nsu = null,
  autorizacao = null,
  adquirente = null,
  bandeira = null,
  comprovanteCliente = null,
  comprovanteLoja = null,
  transacaoId = null,
  codigo = null,
  mensagem = '',
  payloadRetorno = null,
  modo = 'simulacao'
} = {}) {
  const statusNorm = normalizarStatus(status);
  return {
    sucesso: sucesso === true || statusNorm === STATUS.APROVADO,
    status: statusNorm,
    nsu: nsu || null,
    autorizacao: autorizacao || null,
    adquirente: adquirente || null,
    bandeira: bandeira || null,
    comprovanteCliente: comprovanteCliente || null,
    comprovanteLoja: comprovanteLoja || null,
    transacaoId: transacaoId != null ? String(transacaoId) : null,
    codigo: codigo || null,
    mensagem: mensagem || '',
    payloadRetorno: payloadRetorno || null,
    modo
  };
}

function criarRespostaCancelamento({
  sucesso = false,
  status = STATUS.CANCELADO,
  nsu = null,
  autorizacao = null,
  transacaoId = null,
  codigo = null,
  mensagem = '',
  payloadRetorno = null,
  modo = 'simulacao'
} = {}) {
  const statusNorm = normalizarStatus(status);
  return {
    sucesso: sucesso === true || statusNorm === STATUS.CANCELADO,
    status: statusNorm,
    nsu: nsu || null,
    autorizacao: autorizacao || null,
    transacaoId: transacaoId != null ? String(transacaoId) : null,
    codigo: codigo || null,
    mensagem: mensagem || '',
    payloadRetorno: payloadRetorno || null,
    modo
  };
}

function criarRespostaConsulta({
  sucesso = false,
  status = STATUS.PENDENTE,
  nsu = null,
  autorizacao = null,
  transacaoId = null,
  suportado = true,
  mensagem = '',
  dados = null,
  modo = 'simulacao'
} = {}) {
  return {
    sucesso,
    status: normalizarStatus(status),
    nsu: nsu || null,
    autorizacao: autorizacao || null,
    transacaoId: transacaoId != null ? String(transacaoId) : null,
    suportado,
    mensagem,
    dados: dados || null,
    modo
  };
}

function criarRespostaReimpressao({
  sucesso = false,
  tipo = 'cliente',
  comprovante = null,
  suportado = true,
  mensagem = '',
  modo = 'simulacao'
} = {}) {
  return {
    sucesso,
    tipo,
    comprovante: comprovante || null,
    suportado,
    mensagem,
    modo
  };
}

function criarRespostaDiagnostico({
  sucesso = false,
  mensagem = '',
  detalhes = {}
} = {}) {
  return {
    sucesso,
    mensagem,
    detalhes: detalhes || {},
    timestamp: new Date().toISOString()
  };
}

/** Mapeia contrato padronizado → campos do banco / legado API */
function paraPersistencia(retorno) {
  return {
    status: retorno.status,
    adquirente: retorno.adquirente,
    bandeira: retorno.bandeira,
    nsu: retorno.nsu,
    autorizacao: retorno.autorizacao,
    codigo_transacao: retorno.transacaoId || retorno.codigo_transacao || null,
    comprovante_cliente: retorno.comprovanteCliente || retorno.comprovante_cliente || null,
    comprovante_estabelecimento: retorno.comprovanteLoja || retorno.comprovante_estabelecimento || null,
    payload_retorno: retorno.payloadRetorno || retorno.payload_retorno || retorno
  };
}

/** Mapeia contrato → resposta HTTP (compatível PDV e vendas) */
function paraRespostaApi(retorno, transacaoId = null) {
  const id = transacaoId || retorno.transacaoId || retorno.transacao_id;
  const simulado = retorno.simulado === true
    || retorno.payloadRetorno?.simulado === true
    || retorno.payload_retorno?.simulado === true;
  const corpo = {
    sucesso: retorno.sucesso === true,
    status: retorno.status,
    aprovado: estaAprovado(retorno),
    nsu: retorno.nsu,
    autorizacao: retorno.autorizacao,
    adquirente: retorno.adquirente,
    bandeira: retorno.bandeira,
    comprovanteCliente: retorno.comprovanteCliente,
    comprovanteLoja: retorno.comprovanteLoja,
    comprovante_cliente: retorno.comprovanteCliente || retorno.comprovante_cliente || null,
    comprovante_estabelecimento: retorno.comprovanteLoja || retorno.comprovante_estabelecimento || null,
    transacaoId: id != null ? String(id) : null,
    transacao_id: id != null ? Number(id) : null,
    codigo: retorno.codigo,
    mensagem: retorno.mensagem || '',
    modo: retorno.modo || null,
    payloadRetorno: retorno.payloadRetorno || retorno.payload_retorno || null,
    pix_copia_cola: retorno.pixCopiaCola
      || retorno.pix_copia_cola
      || retorno.payloadRetorno?.pix_copia_cola
      || retorno.payload_retorno?.pix_copia_cola
      || null,
    exibir_qr_tela: retorno.exibirQrTela
      || retorno.exibir_qr_tela
      || retorno.payloadRetorno?.exibir_qr_tela
      || retorno.payload_retorno?.exibir_qr_tela
      || false
  };
  if (simulado) corpo.simulado = true;
  if (retorno.tipo_erro) corpo.tipo_erro = retorno.tipo_erro;
  return corpo;
}

/**
 * Leitura de uma cobrança já gravada. Não inicia pagamento e não chama adaptador.
 * Sem registro, o estado permanece pendente e não pode ser tratado como recebido.
 */
function classificarAcompanhamento(row) {
  if (!row || row.id == null) {
    return {
      encontrado: false,
      aprovado: false,
      status: STATUS.PENDENTE,
      transacao_id: null,
      nsu: null,
      autorizacao: null,
      executou_cobranca: false
    };
  }
  const bruto = String(row.status || '').toLowerCase();
  let status;
  if (bruto === 'timeout') status = 'timeout';
  else if (bruto === 'falha' || bruto === 'falha_comunicacao') status = STATUS.ERRO;
  else status = normalizarStatus(bruto);
  if (row.venda_id != null) {
    return {
      encontrado: true,
      aprovado: false,
      status: 'vinculada',
      transacao_id: null,
      codigo: 'TRANSACAO_JA_VINCULADA',
      executou_cobranca: false
    };
  }
  const aprovado = status === STATUS.APROVADO;
  return {
    encontrado: true,
    aprovado,
    status,
    transacao_id: aprovado ? row.id : null,
    valor: aprovado ? Number(row.valor) : null,
    tipo: aprovado ? (row.tipo || null) : null,
    executou_cobranca: false
  };
}

function respostaAcompanhamentoPublica(resultado) {
  const aprovado = !!(resultado && resultado.aprovado === true && resultado.transacao_id != null);
  const corpo = {
    encontrado: !!(resultado && resultado.encontrado),
    aprovado,
    status: resultado && resultado.status ? resultado.status : STATUS.PENDENTE,
    executou_cobranca: false
  };
  if (resultado && resultado.codigo) corpo.code = resultado.codigo;
  if (aprovado) {
    corpo.transacao_id = resultado.transacao_id;
    corpo.valor = Number(resultado.valor);
    corpo.tipo = resultado.tipo || null;
  }
  return corpo;
}

module.exports = {
  STATUS,
  normalizarStatus,
  estaAprovado,
  classificarAcompanhamento,
  respostaAcompanhamentoPublica,
  criarRespostaAutorizacao,
  criarRespostaCancelamento,
  criarRespostaConsulta,
  criarRespostaReimpressao,
  criarRespostaDiagnostico,
  paraPersistencia,
  paraRespostaApi
};
