/**
 * S07-3D — Resolução automática do destino de cozinha a partir do canal de origem.
 * Responsabilidades 1–2 (origem + roteamento). SEM despacho ao KDS.
 * Usa cozinha_canais / cozinha_canal_destinos / cozinha_unidades (S07-3C).
 * Empresa só do contexto autenticado. Destino arbitrário do cliente é ignorado.
 */
'use strict';

const {
  verificarSchemaCozinhaCanais,
  exigirSchemaCozinhaCanais
} = require('./cozinhaCanaisSchema');
const {
  verificarSchemaCozinhaRoteamento
} = require('./cozinhaRoteamentoSchema');
const { CODIGO_LOJA } = require('./CozinhaCanaisService');

/** Adaptador de entrada (EntradaPedido) → código do canal de cozinha (S07-3C). */
const MAPA_ADAPTADOR_PARA_CANAL_COZINHA = Object.freeze({
  EQUIPE: CODIGO_LOJA
});

const STATUS_RESOLUCAO = Object.freeze({
  RESOLVIDO: 'RESOLVIDO',
  DESTINO_NAO_CONFIGURADO: 'DESTINO_NAO_CONFIGURADO',
  CANAL_INEXISTENTE: 'CANAL_INEXISTENTE',
  CANAL_INATIVO: 'CANAL_INATIVO',
  UNIDADE_DESTINO_INVALIDA: 'UNIDADE_DESTINO_INVALIDA',
  SCHEMA_CANAIS_INDISPONIVEL: 'SCHEMA_CANAIS_INDISPONIVEL',
  SCHEMA_ROTEAMENTO_INDISPONIVEL: 'SCHEMA_ROTEAMENTO_INDISPONIVEL',
  MODO_ROTEAMENTO_INVALIDO: 'MODO_ROTEAMENTO_INVALIDO',
  CANAL_ORIGEM_OBRIGATORIO: 'CANAL_ORIGEM_OBRIGATORIO'
});

function erro(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

function conn(opts) {
  return (opts && opts.db) || require('../../database');
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return n;
}

/**
 * Normaliza o código do canal de cozinha a partir do adaptador / origem persistida.
 * EQUIPE (garçom / operação loja) → LOJA. Demais códigos passam em maiúsculas.
 */
function normalizarCanalCozinha(canalCodigo) {
  const raw = String(canalCodigo == null ? '' : canalCodigo).trim().toUpperCase();
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(MAPA_ADAPTADOR_PARA_CANAL_COZINHA, raw)) {
    return MAPA_ADAPTADOR_PARA_CANAL_COZINHA[raw];
  }
  return raw;
}

function montarResultado({
  status,
  empresaId,
  canalCodigoInformado = null,
  canalCodigoCozinha = null,
  canal = null,
  destino = null,
  pendente = false,
  mensagem = null
}) {
  const resolvido = status === STATUS_RESOLUCAO.RESOLVIDO;
  return {
    success: resolvido,
    status,
    codigo: status,
    empresa_id: empresaId,
    canal_codigo_informado: canalCodigoInformado,
    canal_codigo: canalCodigoCozinha,
    canal,
    destino: resolvido ? destino : null,
    pendente: !!pendente || status === STATUS_RESOLUCAO.DESTINO_NAO_CONFIGURADO,
    mensagem,
    despacho: false
  };
}

/**
 * Resolve primeiro um destino específico de canal; sem ele, respeita o modo
 * COZINHA_PADRAO configurado pela empresa.
 * Não despacha para o KDS.
 *
 * @param {object} entrada
 * @param {number|string} entrada.empresaId contexto autenticado
 * @param {string} entrada.canalCodigo origem (adaptador ou código de canal de cozinha)
 * @param {*} [entrada.bodyEmpresaIdIgnored] ignorado (nunca confiar no cliente)
 * @param {*} [entrada.unidadeDestinoArbitrariaIgnored] ignorado
 * @param {*} [entrada.destinoArbitrarioIgnored] ignorado
 */
async function resolverDestinoPedido({
  empresaId,
  canalCodigo,
  bodyEmpresaIdIgnored,
  unidadeDestinoArbitrariaIgnored,
  destinoArbitrarioIgnored
} = {}, opts = {}) {
  void bodyEmpresaIdIgnored;
  void unidadeDestinoArbitrariaIgnored;
  void destinoArbitrarioIgnored;

  const empId = exigirEmpresa(empresaId);
  const informado = canalCodigo == null ? null : String(canalCodigo).trim();
  const codigoCozinha = normalizarCanalCozinha(canalCodigo);

  if (!codigoCozinha) {
    return montarResultado({
      status: STATUS_RESOLUCAO.CANAL_ORIGEM_OBRIGATORIO,
      empresaId: empId,
      canalCodigoInformado: informado,
      mensagem: 'Canal de origem obrigatório para resolução de destino.'
    });
  }

  const db = conn(opts);
  const schema = await verificarSchemaCozinhaCanais(db);
  if (!schema.disponivel) {
    return montarResultado({
      status: STATUS_RESOLUCAO.SCHEMA_CANAIS_INDISPONIVEL,
      empresaId: empId,
      canalCodigoInformado: informado,
      canalCodigoCozinha: codigoCozinha,
      pendente: true,
      mensagem: 'Schema de canais de cozinha indisponível.'
    });
  }

  const row = await dbGet(db, `
    SELECT
      c.id AS canal_id,
      c.empresa_id AS canal_empresa_id,
      c.codigo AS canal_codigo,
      c.nome AS canal_nome,
      c.origem_tipo AS canal_origem_tipo,
      c.ativo AS canal_ativo,
      d.unidade_cozinha_id,
      u.id AS unidade_id,
      u.empresa_id AS unidade_empresa_id,
      u.codigo AS unidade_codigo,
      u.ativo AS unidade_ativo
    FROM cozinha_canais c
    LEFT JOIN cozinha_canal_destinos d
      ON d.canal_id = c.id AND d.empresa_id = c.empresa_id
    LEFT JOIN cozinha_unidades u
      ON u.id = d.unidade_cozinha_id AND u.empresa_id = d.empresa_id
    WHERE c.empresa_id = ? AND c.codigo = ?
  `, [empId, codigoCozinha]);

  if (!row) {
    return montarResultado({
      status: STATUS_RESOLUCAO.CANAL_INEXISTENTE,
      empresaId: empId,
      canalCodigoInformado: informado,
      canalCodigoCozinha: codigoCozinha,
      mensagem: `Canal de cozinha "${codigoCozinha}" inexistente para a empresa.`
    });
  }

  const canal = {
    id: Number(row.canal_id),
    codigo: String(row.canal_codigo),
    nome: row.canal_nome != null ? String(row.canal_nome) : null,
    origem_tipo: row.canal_origem_tipo != null ? String(row.canal_origem_tipo) : null,
    ativo: Number(row.canal_ativo) === 1
  };

  if (!canal.ativo) {
    return montarResultado({
      status: STATUS_RESOLUCAO.CANAL_INATIVO,
      empresaId: empId,
      canalCodigoInformado: informado,
      canalCodigoCozinha: codigoCozinha,
      canal,
      mensagem: `Canal de cozinha "${codigoCozinha}" está inativo.`
    });
  }

  let destinoId = row.unidade_cozinha_id;
  let unidade = row.unidade_cozinha_id == null
    ? null
    : {
      id: row.unidade_id,
      empresa_id: row.unidade_empresa_id,
      codigo: row.unidade_codigo,
      ativo: row.unidade_ativo
    };

  if (destinoId == null) {
    const schemaRoteamento = await verificarSchemaCozinhaRoteamento(db);
    if (!schemaRoteamento.disponivel) {
      return montarResultado({
        status: STATUS_RESOLUCAO.SCHEMA_ROTEAMENTO_INDISPONIVEL,
        empresaId: empId,
        canalCodigoInformado: informado,
        canalCodigoCozinha: codigoCozinha,
        canal,
        pendente: true,
        mensagem: 'Schema de roteamento de cozinhas indisponível.'
      });
    }

    const roteamento = await dbGet(db, `
      SELECT modo, unidade_padrao_id
      FROM cozinha_roteamento_config
      WHERE empresa_id = ?
    `, [empId]);

    if (!roteamento || roteamento.unidade_padrao_id == null) {
      return montarResultado({
        status: STATUS_RESOLUCAO.DESTINO_NAO_CONFIGURADO,
        empresaId: empId,
        canalCodigoInformado: informado,
        canalCodigoCozinha: codigoCozinha,
        canal,
        pendente: true,
        mensagem: `Canal "${codigoCozinha}" sem destino ou cozinha padrão configurada.`
      });
    }

    const modo = String(roteamento.modo || '').trim().toUpperCase();
    if (modo !== 'COZINHA_PADRAO') {
      if (modo !== 'COZINHA_POR_SEGMENTO') {
        return montarResultado({
          status: STATUS_RESOLUCAO.MODO_ROTEAMENTO_INVALIDO,
          empresaId: empId,
          canalCodigoInformado: informado,
          canalCodigoCozinha: codigoCozinha,
          canal,
          mensagem: 'Modo de roteamento de cozinhas inválido.'
        });
      }
      return montarResultado({
        status: STATUS_RESOLUCAO.DESTINO_NAO_CONFIGURADO,
        empresaId: empId,
        canalCodigoInformado: informado,
        canalCodigoCozinha: codigoCozinha,
        canal,
        pendente: true,
        mensagem: `Canal "${codigoCozinha}" sem destino de cozinha configurado.`
      });
    }

    destinoId = roteamento.unidade_padrao_id;
    unidade = await dbGet(db, `
      SELECT id, empresa_id, codigo, ativo
      FROM cozinha_unidades
      WHERE id = ?
    `, [destinoId]);
  }

  const unidadeId = Number(destinoId);
  const unidadeEmpresaOk = unidade && Number(unidade.empresa_id) === empId;
  const unidadeAtiva = unidade && Number(unidade.ativo) === 1;

  if (!Number.isInteger(unidadeId) || unidadeId <= 0 || !unidadeEmpresaOk || !unidadeAtiva) {
    return montarResultado({
      status: STATUS_RESOLUCAO.UNIDADE_DESTINO_INVALIDA,
      empresaId: empId,
      canalCodigoInformado: informado,
      canalCodigoCozinha: codigoCozinha,
      canal,
      mensagem: 'Unidade de destino inválida, inativa ou de outra empresa.'
    });
  }

  return montarResultado({
    status: STATUS_RESOLUCAO.RESOLVIDO,
    empresaId: empId,
    canalCodigoInformado: informado,
    canalCodigoCozinha: codigoCozinha,
    canal,
    destino: {
      unidade_id: unidadeId,
      unidade_codigo: unidade.codigo != null ? String(unidade.codigo) : null
    },
    mensagem: null
  });
}

module.exports = {
  MAPA_ADAPTADOR_PARA_CANAL_COZINHA,
  STATUS_RESOLUCAO,
  normalizarCanalCozinha,
  resolverDestinoPedido,
  verificarSchemaCozinhaCanais,
  exigirSchemaCozinhaCanais
};
