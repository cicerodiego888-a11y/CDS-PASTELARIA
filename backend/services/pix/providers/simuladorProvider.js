/**
 * Provedor PIX simulado — apenas testes / homologação local.
 * Não comunica com adquirente real.
 */

const memoria = new Map();

function criarCobranca({ valor, descricao, config }) {
  const txid = `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const statusInicial = String((config && config.statusInicial) || 'PENDENTE').toUpperCase();
  const registro = {
    provedor: 'simulador',
    txid,
    status: statusInicial,
    statusOriginal: statusInicial,
    qrCodeBase64: null,
    copiaCola: `00020126PIX-SIMULADO-${txid}`,
    raw: { simulado: true, descricao: descricao || 'Venda PDV', valor: Number(valor) }
  };
  memoria.set(txid, { ...registro, valor: Number(valor) });
  return Promise.resolve(registro);
}

function consultarStatus({ txid, config }) {
  const forcar = config && config.statusForcado;
  const atual = memoria.get(String(txid)) || { txid: String(txid), status: 'PENDENTE' };
  const status = String(forcar || atual.status || 'PENDENTE').toUpperCase();
  const saida = {
    txid: String(txid),
    status,
    statusOriginal: status,
    raw: { simulado: true, ...(atual.raw || {}) }
  };
  memoria.set(String(txid), { ...atual, status });
  return Promise.resolve(saida);
}

function definirStatus(txid, status) {
  const atual = memoria.get(String(txid)) || { txid: String(txid) };
  memoria.set(String(txid), { ...atual, status: String(status || 'PENDENTE').toUpperCase() });
}

function limpar() {
  memoria.clear();
}

module.exports = {
  criarCobranca,
  consultarStatus,
  definirStatus,
  limpar
};
