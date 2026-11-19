/**
 * E-03 C10 — serializa confirmação do COMMIT do claim com invalidação de logout.
 *
 * Ordem inequívoca:
 * - quem segura o gate executa atomicamente (sem ceder a outro await externo);
 * - logout não invalida geração no meio do COMMIT;
 * - claim não confirma COMMIT se a geração já foi invalidada sob o gate.
 */
'use strict';

let _cadeia = Promise.resolve();
let _profundidade = 0;
let _ultimoDono = null;

/**
 * Executa fn com exclusividade claim↔logout.
 * @param {string} dono — 'claim-commit' | 'logout-invalidacao' | teste
 * @param {function(): (any|Promise<any>)} fn
 */
function comGateClaimLogout(dono, fn) {
  const donoNorm = String(dono || 'desconhecido');
  const executar = async () => {
    _profundidade += 1;
    _ultimoDono = donoNorm;
    try {
      return await fn();
    } finally {
      _profundidade -= 1;
      if (_profundidade <= 0) {
        _profundidade = 0;
        _ultimoDono = null;
      }
    }
  };

  const run = _cadeia.then(executar, executar);
  // Impede que rejeição quebre a cadeia para o próximo.
  _cadeia = run.then(() => undefined, () => undefined);
  return run;
}

function descreverGateClaimLogout() {
  return {
    ocupado: _profundidade > 0,
    profundidade: _profundidade,
    ultimo_dono: _ultimoDono
  };
}

function _resetGateClaimLogoutParaTeste() {
  _cadeia = Promise.resolve();
  _profundidade = 0;
  _ultimoDono = null;
}

module.exports = {
  comGateClaimLogout,
  descreverGateClaimLogout,
  _resetGateClaimLogoutParaTeste
};
