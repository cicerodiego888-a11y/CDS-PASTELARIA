/**
 * Eventos operacionais do MBC. Sem token, secret, state ou credencial.
 * @module motores/bancario/contracts/observabilidadeMbc
 */
'use strict';

const { sanitizarObjetoMbc } = require('./sanitizarMbc');

function montarEventoOperacaoMbc(evento = {}) {
  return sanitizarObjetoMbc({
    motor: 'MBC',
    operacao: evento.operacao || null,
    empresa_id: evento.empresa_id != null ? evento.empresa_id : null,
    conta_bancaria_id: evento.conta_bancaria_id != null ? evento.conta_bancaria_id : null,
    provider: evento.provider || null,
    instituicao: evento.instituicao || null,
    ambiente: evento.ambiente || null,
    inicio: evento.inicio || null,
    fim: evento.fim || null,
    resultado: evento.resultado || evento.status || null,
    quantidade: evento.quantidade != null ? evento.quantidade : (evento.transacoes != null ? evento.transacoes : null),
    status: evento.status || null,
    categoria: evento.categoria || null,
    duracao_ms: evento.duracao_ms != null ? evento.duracao_ms : null,
    transacoes: evento.transacoes != null ? evento.transacoes : null,
    token: evento.token,
    secret: evento.secret,
    state: evento.state
  });
}

function registrarOperacaoMbc(evento) {
  const limpo = montarEventoOperacaoMbc(evento);
  if (process.env.MBC_LOG_OPERACOES === '1') {
    console.info('[MBC]', JSON.stringify(limpo));
  }
  return limpo;
}

module.exports = { montarEventoOperacaoMbc, registrarOperacaoMbc };
