/**
 * Seleção pura da empresa responsável pelo carrinho (SPEC-MUV-02 / MUV-CAP-01).
 * Sem I/O. Determinística: matriz capaz → matriz; senão primeira filial capaz (ordem dada).
 *
 * @module motores/muv/capacidade/selecionarEmpresaCapacidade
 */
'use strict';

const CODIGOS_BLOQUEIO = Object.freeze({
  NENHUMA_EMPRESA_ATENDE: 'NENHUMA_EMPRESA_ATENDE',
  NENHUMA_EMPRESA_ELEGIVEL: 'NENHUMA_EMPRESA_ELEGIVEL',
  MATRIZ_AMBIGUA: 'MATRIZ_AMBIGUA',
  MATRIZ_AUSENTE: 'MATRIZ_AUSENTE',
  SELETOR_AUTOMATICO_NAO_APLICA: 'SELETOR_AUTOMATICO_NAO_APLICA',
  CARRINHO_INVALIDO: 'CARRINHO_INVALIDO',
  TIPO_SALDO_INDETERMINADO: 'TIPO_SALDO_INDETERMINADO',
  CAIXA_INCOMPATIVEL: 'CAIXA_INCOMPATIVEL'
});

const JUSTIFICATIVAS = Object.freeze({
  MATRIZ_ATENDE: 'MATRIZ_ATENDE',
  FILIAL_ORDEM_ID: 'FILIAL_ORDEM_ID'
});

/**
 * @param {{
 *   matrizId?: number|null,
 *   ordemAvaliacao?: number[],
 *   porEmpresa?: Array<{
 *     empresaId: number,
 *     tipo?: string,
 *     elegivel?: boolean,
 *     atendeIntegralmente?: boolean
 *   }>,
 *   bloqueioPrevio?: { codigo: string, mensagem: string }|null
 * }} entrada
 * @returns {{
 *   selecionada: { empresaId: number, justificativa: string }|null,
 *   bloqueio: { codigo: string, mensagem: string }|null
 * }}
 */
function selecionarEmpresaCapacidade(entrada = {}) {
  if (entrada.bloqueioPrevio && entrada.bloqueioPrevio.codigo) {
    return {
      selecionada: null,
      bloqueio: {
        codigo: String(entrada.bloqueioPrevio.codigo),
        mensagem: String(entrada.bloqueioPrevio.mensagem || entrada.bloqueioPrevio.codigo)
      }
    };
  }

  const porEmpresa = Array.isArray(entrada.porEmpresa) ? entrada.porEmpresa : [];
  const ordem = Array.isArray(entrada.ordemAvaliacao) && entrada.ordemAvaliacao.length
    ? entrada.ordemAvaliacao.map(Number)
    : porEmpresa.map((e) => Number(e.empresaId));

  const porId = new Map();
  for (const row of porEmpresa) {
    const id = Number(row.empresaId);
    if (Number.isInteger(id) && id > 0) porId.set(id, row);
  }

  const capazes = [];
  for (const id of ordem) {
    const row = porId.get(Number(id));
    if (!row) continue;
    if (row.elegivel === true && row.atendeIntegralmente === true) {
      capazes.push(row);
    }
  }

  if (!capazes.length) {
    const algumaElegivel = porEmpresa.some((e) => e && e.elegivel === true);
    return {
      selecionada: null,
      bloqueio: {
        codigo: algumaElegivel
          ? CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE
          : CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ELEGIVEL,
        mensagem: algumaElegivel
          ? 'Nenhuma empresa consegue atender integralmente ao pedido. A venda não será dividida entre CNPJs.'
          : 'Nenhuma empresa elegível para atender ao pedido.'
      }
    };
  }

  const matrizId = entrada.matrizId != null ? Number(entrada.matrizId) : null;
  if (Number.isInteger(matrizId) && matrizId > 0) {
    const matrizCapaz = capazes.find((e) => Number(e.empresaId) === matrizId);
    if (matrizCapaz) {
      return {
        selecionada: {
          empresaId: matrizId,
          justificativa: JUSTIFICATIVAS.MATRIZ_ATENDE
        },
        bloqueio: null
      };
    }
  }

  const filial = capazes[0];
  return {
    selecionada: {
      empresaId: Number(filial.empresaId),
      justificativa: JUSTIFICATIVAS.FILIAL_ORDEM_ID
    },
    bloqueio: null
  };
}

module.exports = {
  selecionarEmpresaCapacidade,
  CODIGOS_BLOQUEIO,
  JUSTIFICATIVAS
};
