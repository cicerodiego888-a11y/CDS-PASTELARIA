'use strict';

/**
 * Probe de Heartbeat — RC3.1
 * Consome Transportes oficiais. Não altera EquipamentosService.
 */

const EthernetTransport = require('../transport/EthernetTransport');
const { TIPO_TESTE } = require('./HeartbeatProfile');

/**
 * @param {Object} equipamento
 * @param {Object} perfil
 * @returns {Promise<{ sucesso: boolean, timeout: boolean, latencia_ms: number|null, erro: string|null, tipo_teste: string, comunicacao_real: boolean }>}
 */
async function executarProbe(equipamento, perfil) {
  const tipo = perfil.tipo_teste || TIPO_TESTE.TCP_CONNECT;
  const timeoutMs = Number(perfil.timeout_ms || 3000);
  const transporte = String(equipamento.transporte || '').toLowerCase();

  if (transporte === 'ethernet' || (!transporte && equipamento.ip)) {
    return probeEthernet(equipamento, timeoutMs, tipo);
  }

  // Serial/USB: sem socket — marca como sem comunicação real nesta RC
  // (evita falso positivo do testarConexao simulado).
  return {
    sucesso: false,
    timeout: false,
    latencia_ms: null,
    erro: `Heartbeat ${transporte || 'desconhecido'}: probe físico não habilitado nesta RC`,
    tipo_teste: tipo,
    comunicacao_real: false,
    skip: false
  };
}

async function probeEthernet(equipamento, timeoutMs, tipo) {
  if (!equipamento.ip) {
    return {
      sucesso: false,
      timeout: false,
      latencia_ms: null,
      erro: 'Equipamento sem IP',
      tipo_teste: tipo,
      comunicacao_real: false
    };
  }

  const transport = new EthernetTransport({
    equipamento_id: Number(equipamento.id),
    host: equipamento.ip,
    porta: equipamento.porta_tcp || 9100,
    timeout: timeoutMs,
    tentativas: 1,
    intervaloReconexao: 0,
    heartbeatInterval: 0
  });

  const inicio = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, timeoutMs + 50);

  try {
    await transport.connect();
    if (tipo === TIPO_TESTE.PING_LOGICO || tipo === TIPO_TESTE.HANDSHAKE || tipo === TIPO_TESTE.LEITURA_SIMPLES) {
      await transport.ping();
    } else {
      // TCP_CONNECT — connect já valida
      await transport.ping().catch(() => {});
    }
    await transport.disconnect().catch(() => {});
    clearTimeout(timer);
    return {
      sucesso: true,
      timeout: false,
      latencia_ms: Date.now() - inicio,
      erro: null,
      tipo_teste: tipo,
      comunicacao_real: true
    };
  } catch (err) {
    clearTimeout(timer);
    await transport.disconnect().catch(() => {});
    const msg = err && err.message ? err.message : String(err);
    const isTimeout = timedOut
      || /timeout|ETIMEDOUT|timed out/i.test(msg);
    return {
      sucesso: false,
      timeout: isTimeout,
      latencia_ms: Date.now() - inicio,
      erro: msg,
      tipo_teste: tipo,
      comunicacao_real: true
    };
  }
}

module.exports = {
  executarProbe,
  probeEthernet
};
