/**
 * Contrato abstrato de driver de impressão — Sprint 06 Bloco D.
 * Sem integração desktop, sem chamada de impressão nativa, sem impressora real.
 */
'use strict';

const { erroImpressao } = require('./cozinhaImpressaoContratos');

const RESULTADOS_DRIVER = Object.freeze({
  ACEITA: 'ACEITA',
  FALHA: 'FALHA',
  INCERTO: 'INCERTO',
  /** Simulação/dry-run — NÃO é aceitação do spooler. */
  SIMULADO: 'SIMULADO'
});

/**
 * @typedef {object} DriverImpressaoResultado
 * @property {'ACEITA'|'FALHA'|'INCERTO'|'SIMULADO'} resultado
 * @property {string|null} [spooler_job_token]
 * @property {string|null} [erro]
 * @property {boolean} impressao_fisica
 * @property {string} driver
 * @property {boolean} [dry_run]
 */

function assertResultadoDriver(out) {
  if (!out || typeof out !== 'object') {
    throw erroImpressao('Driver retornou resultado inválido.', 500, 'IMPRESSAO_DRIVER_INVALIDO');
  }
  if (out.impressao_fisica === true) {
    throw erroImpressao(
      'Contrato de driver: impressao_fisica=true é proibido (ACEITA ≠ papel impresso).',
      500,
      'IMPRESSAO_FISICA_PROIBIDA'
    );
  }
  const r = String(out.resultado || '').toUpperCase();
  if (!RESULTADOS_DRIVER[r]) {
    throw erroImpressao(
      'resultado do driver inválido.',
      500,
      'IMPRESSAO_DRIVER_RESULTADO_INVALIDO',
      { detalhes: { resultado: out.resultado } }
    );
  }
  return {
    resultado: r,
    spooler_job_token: out.spooler_job_token != null ? String(out.spooler_job_token) : null,
    erro: out.erro != null ? String(out.erro) : null,
    impressao_fisica: false,
    dry_run: out.dry_run === true || r === RESULTADOS_DRIVER.SIMULADO,
    driver: String(out.driver || 'DESCONHECIDO')
  };
}

/**
 * Interface documental — qualquer driver deve expor imprimir(contexto).
 * @interface
 */
class ImpressaoDriver {
  /**
   * @param {object} _contexto
   * @returns {Promise<DriverImpressaoResultado>}
   */
  async imprimir(_contexto) {
    throw erroImpressao(
      'Driver abstrato: implementar imprimir().',
      501,
      'IMPRESSAO_DRIVER_NAO_IMPLEMENTADO'
    );
  }

  get nome() {
    return 'ABSTRACT';
  }

  get impressaoFisica() {
    return false;
  }
}

/**
 * Driver FAKE — simula sucesso, falha conhecida ou resultado incerto.
 * Nunca acessa impressora real nem runtime desktop de impressão.
 */
class FakeImpressaoDriver extends ImpressaoDriver {
  /**
   * @param {object} [opts]
   * @param {'sucesso'|'falha'|'incerto'|'timeout'} [opts.modo]
   * @param {string} [opts.erro]
   * @param {string} [opts.tokenPrefix]
   * @param {number} [opts.delayMs] — apenas simulação (não imprime)
   * @param {function} [opts.resolver] — override por job: (ctx) => modo|resultado
   */
  constructor(opts = {}) {
    super();
    this.modo = String(opts.modo || 'sucesso').toLowerCase();
    this.erroPadrao = opts.erro != null ? String(opts.erro) : null;
    this.tokenPrefix = opts.tokenPrefix != null ? String(opts.tokenPrefix) : 'fake-spool';
    this.delayMs = Number(opts.delayMs) > 0 ? Number(opts.delayMs) : 0;
    this.resolver = typeof opts.resolver === 'function' ? opts.resolver : null;
    this.chamadas = [];
    this._seq = 0;
  }

  get nome() {
    return 'FAKE';
  }

  get impressaoFisica() {
    return false;
  }

  /**
   * Altera o modo em runtime (testes / simulação operacional).
   * @param {'sucesso'|'falha'|'incerto'|'timeout'} modo
   */
  setModo(modo) {
    this.modo = String(modo || 'sucesso').toLowerCase();
  }

  async imprimir(contexto = {}) {
    this._seq += 1;
    const registro = {
      seq: this._seq,
      job_id: contexto.job && contexto.job.id,
      vias: contexto.job && contexto.job.vias,
      em: new Date().toISOString()
    };
    this.chamadas.push(registro);

    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    let modo = this.modo;
    if (this.resolver) {
      const decidido = await Promise.resolve(this.resolver(contexto, registro));
      if (decidido && typeof decidido === 'object' && decidido.resultado) {
        return assertResultadoDriver({
          ...decidido,
          impressao_fisica: false,
          driver: 'FAKE'
        });
      }
      if (typeof decidido === 'string') modo = decidido.toLowerCase();
    }

    if (modo === 'falha' || modo === 'fail' || modo === 'erro') {
      return assertResultadoDriver({
        resultado: RESULTADOS_DRIVER.FALHA,
        spooler_job_token: null,
        erro: this.erroPadrao || 'FAKE: falha conhecida antes da aceitação do spooler',
        impressao_fisica: false,
        driver: 'FAKE'
      });
    }

    if (modo === 'incerto' || modo === 'timeout' || modo === 'uncertain') {
      return assertResultadoDriver({
        resultado: RESULTADOS_DRIVER.INCERTO,
        spooler_job_token: null,
        erro: this.erroPadrao
          || (modo === 'timeout'
            ? 'FAKE: timeout — resultado indeterminável'
            : 'FAKE: resultado incerto'),
        impressao_fisica: false,
        driver: 'FAKE'
      });
    }

    // sucesso
    return assertResultadoDriver({
      resultado: RESULTADOS_DRIVER.ACEITA,
      spooler_job_token: `${this.tokenPrefix}:${contexto.job && contexto.job.id}:${this._seq}`,
      erro: null,
      impressao_fisica: false,
      driver: 'FAKE'
    });
  }
}

function criarFakeDriver(opts = {}) {
  return new FakeImpressaoDriver(opts);
}

module.exports = {
  RESULTADOS_DRIVER,
  ImpressaoDriver,
  FakeImpressaoDriver,
  criarFakeDriver,
  assertResultadoDriver
};
