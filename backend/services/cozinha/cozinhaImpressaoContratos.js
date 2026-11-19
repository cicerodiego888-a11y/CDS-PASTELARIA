/**
 * Contratos compartilhados — Impressão de Cozinha (Sprint 06 Bloco A).
 * Independente de impressão comercial/fiscal (cupom, DANFE, TEF, MUV).
 */
'use strict';

const LARGURAS_MM = Object.freeze([58, 80]);
const LARGURA_PADRAO_MM = 80;

const MODELOS_IMPRESSAO = Object.freeze({
  INDIVIDUAL: 'INDIVIDUAL',
  AGRUPADO: 'AGRUPADO'
});

/** Convenção D3: codigo_estacao alinhado a tipo_item (roteamento no Bloco C). */
const CODIGOS_ESTACAO_TIPO = Object.freeze({
  PASTEL: 'PASTEL',
  BEBIDA: 'BEBIDA',
  OUTRO: 'OUTRO'
});

const ESTADOS_FILA = Object.freeze({
  PENDENTE: 'PENDENTE',
  PROCESSANDO: 'PROCESSANDO',
  RESULTADO_INCERTO: 'RESULTADO_INCERTO',
  ACEITA_PELO_SPOOLER: 'ACEITA_PELO_SPOOLER',
  FALHA: 'FALHA',
  CANCELADA: 'CANCELADA'
});

function erroImpressao(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

function parsePositiveInteger(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function normalizarCodigoEstacao(raw) {
  const codigo = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!codigo) {
    throw erroImpressao(
      'codigo_estacao obrigatório.',
      400,
      'ESTACAO_CODIGO_OBRIGATORIO'
    );
  }
  if (codigo.length > 64) {
    throw erroImpressao(
      'codigo_estacao excede o tamanho máximo.',
      400,
      'ESTACAO_CODIGO_INVALIDO'
    );
  }
  return codigo;
}

function normalizarLarguraMm(raw) {
  const n = raw == null || raw === '' ? LARGURA_PADRAO_MM : Number(raw);
  if (!LARGURAS_MM.includes(n)) {
    throw erroImpressao(
      'largura_mm deve ser 58 ou 80.',
      400,
      'ESTACAO_LARGURA_INVALIDA'
    );
  }
  return n;
}

function normalizarVias(raw) {
  const n = raw == null || raw === '' ? 1 : Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw erroImpressao(
      'vias deve ser inteiro positivo.',
      400,
      'ESTACAO_VIAS_INVALIDAS'
    );
  }
  return n;
}

function normalizarFlag01(raw, defaultValue = 1) {
  if (raw == null || raw === '') return defaultValue ? 1 : 0;
  const n = Number(raw);
  if (n === 0 || n === 1) return n;
  if (raw === true) return 1;
  if (raw === false) return 0;
  throw erroImpressao('Flag booleana inválida (use 0 ou 1).', 400, 'ESTACAO_FLAG_INVALIDA');
}

/**
 * Monta o snapshot canônico do job (sem preços/fiscais).
 * Bloco A: contrato + validação; enfileiramento real = Bloco B.
 */
function montarPayloadSnapshot(entrada = {}) {
  const empresaId = parsePositiveInteger(entrada.empresa_id != null ? entrada.empresa_id : entrada.empresaId);
  const unidadeId = parsePositiveInteger(entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId);
  const rodadaId = parsePositiveInteger(entrada.rodada_id != null ? entrada.rodada_id : entrada.rodadaId);

  if (!empresaId) {
    throw erroImpressao('empresa_id obrigatório no snapshot.', 400, 'SNAPSHOT_EMPRESA_OBRIGATORIA');
  }
  if (!unidadeId) {
    throw erroImpressao('unidade_id obrigatório no snapshot.', 400, 'SNAPSHOT_UNIDADE_OBRIGATORIA');
  }
  if (!rodadaId) {
    throw erroImpressao('rodada_id obrigatório no snapshot.', 400, 'SNAPSHOT_RODADA_OBRIGATORIA');
  }

  const modeloRaw = String(entrada.modelo || MODELOS_IMPRESSAO.AGRUPADO).trim().toUpperCase();
  if (!MODELOS_IMPRESSAO[modeloRaw]) {
    throw erroImpressao('modelo deve ser INDIVIDUAL ou AGRUPADO.', 400, 'SNAPSHOT_MODELO_INVALIDO');
  }

  const larguraMm = normalizarLarguraMm(entrada.largura_mm != null ? entrada.largura_mm : entrada.larguraMm);
  const itensIn = Array.isArray(entrada.itens) ? entrada.itens : [];

  const itens = itensIn.map((it, idx) => {
    if (!it || typeof it !== 'object') {
      throw erroImpressao(`Item de snapshot inválido no índice ${idx}.`, 400, 'SNAPSHOT_ITEM_INVALIDO');
    }
    const tipo = String(it.tipo_item || it.tipoItem || 'OUTRO').trim().toUpperCase();
    if (!['PASTEL', 'BEBIDA', 'OUTRO'].includes(tipo)) {
      throw erroImpressao(`tipo_item inválido no índice ${idx}.`, 400, 'SNAPSHOT_TIPO_ITEM_INVALIDO');
    }
    const ingredientes = Object.freeze(
      (Array.isArray(it.ingredientes) ? it.ingredientes : []).map((ing) => Object.freeze({
        nome: String(ing.nome || '').trim(),
        qty: ing.qty != null ? String(ing.qty) : null,
        selecionado: ing.selecionado == null ? true : !!ing.selecionado
      }))
    );

    // Campos fiscais/preço são ignorados de propósito (não entram no snapshot).
    return Object.freeze({
      cozinha_item_id: parsePositiveInteger(it.cozinha_item_id != null ? it.cozinha_item_id : it.cozinhaItemId),
      comanda_id: parsePositiveInteger(it.comanda_id != null ? it.comanda_id : it.comandaId),
      tipo_item: tipo,
      descricao: String(it.descricao || it.nome || '').trim(),
      qty: it.qty != null ? String(it.qty) : (it.quantidade != null ? String(it.quantidade) : null),
      observacao: it.observacao != null ? String(it.observacao) : null,
      ingredientes
    });
  });

  return Object.freeze({
    empresa_id: empresaId,
    unidade_id: unidadeId,
    rodada_id: rodadaId,
    sequencia_global: entrada.sequencia_global != null
      ? Number(entrada.sequencia_global)
      : (entrada.sequenciaGlobal != null ? Number(entrada.sequenciaGlobal) : null),
    mesa_numero: entrada.mesa_numero != null
      ? String(entrada.mesa_numero)
      : (entrada.mesaNumero != null ? String(entrada.mesaNumero) : null),
    atendimento_id: parsePositiveInteger(
      entrada.atendimento_id != null ? entrada.atendimento_id : entrada.atendimentoId
    ),
    numero_rodada: entrada.numero_rodada != null
      ? Number(entrada.numero_rodada)
      : (entrada.numeroRodada != null ? Number(entrada.numeroRodada) : null),
    enviada_em: entrada.enviada_em != null
      ? String(entrada.enviada_em)
      : (entrada.enviadaEm != null ? String(entrada.enviadaEm) : null),
    modelo: modeloRaw,
    largura_mm: larguraMm,
    itens: Object.freeze(itens)
  });
}

/**
 * Serializa somente após revalidar/normalizar o contrato canônico.
 * Descarta campos comerciais/fiscais; rejeita se restarem chaves proibidas.
 */
function serializarSnapshot(snapshot) {
  const canonico = montarPayloadSnapshot(
    snapshot && typeof snapshot === 'object' ? snapshot : {}
  );
  const proibidos = snapshotContemCamposProibidos(canonico);
  if (proibidos.length) {
    throw erroImpressao(
      'Snapshot contém campos comerciais/fiscais proibidos.',
      400,
      'SNAPSHOT_CAMPO_PROIBIDO',
      { detalhes: { campos: proibidos } }
    );
  }
  return JSON.stringify(canonico);
}

function parseSnapshotJson(texto) {
  if (texto == null || String(texto).trim() === '') {
    throw erroImpressao('payload_snapshot vazio.', 400, 'SNAPSHOT_VAZIO');
  }
  let obj;
  try {
    obj = JSON.parse(String(texto));
  } catch (_e) {
    throw erroImpressao('payload_snapshot JSON inválido.', 400, 'SNAPSHOT_JSON_INVALIDO');
  }
  return montarPayloadSnapshot(obj);
}

function snapshotContemCamposProibidos(obj) {
  const proibidos = [
    'preco', 'preço', 'preco_unitario', 'preco_total', 'valor', 'valor_total',
    'ncm', 'cfop', 'csosn', 'cpf', 'cnpj', 'danfe', 'nfc-e', 'nfce', 'nfe',
    'tef', 'pagamento', 'forma_pagamento'
  ];
  const json = JSON.stringify(obj || {}).toLowerCase();
  return proibidos.filter((p) => json.includes(`"${p}"`));
}

/**
 * Chave estável da fila (D1=a). Sem timestamp/UUID.
 * Formato: imp:{empresa}:{unidade}:{rodada}:{estacao}:{modelo}:{escopo}
 */
function montarIdempotencyKeyFila({
  empresaId,
  unidadeId,
  rodadaId,
  estacaoId,
  modelo = MODELOS_IMPRESSAO.AGRUPADO,
  escopo = 'all'
} = {}) {
  const emp = parsePositiveInteger(empresaId);
  const uni = parsePositiveInteger(unidadeId);
  const rod = parsePositiveInteger(rodadaId);
  const est = parsePositiveInteger(estacaoId);
  const mod = String(modelo || MODELOS_IMPRESSAO.AGRUPADO).trim().toUpperCase();
  const esc = String(escopo == null ? 'all' : escopo).trim().toLowerCase() || 'all';
  if (!emp || !uni || !rod || !est) {
    throw erroImpressao(
      'Identificadores insuficientes para chave de impressão.',
      400,
      'IMPRESSAO_IDEMPOTENCY_INVALIDA'
    );
  }
  if (!MODELOS_IMPRESSAO[mod]) {
    throw erroImpressao('modelo inválido na chave.', 400, 'IMPRESSAO_MODELO_INVALIDO');
  }
  return `imp:${emp}:${uni}:${rod}:${est}:${mod}:${esc}`;
}

/**
 * Chave estável de reenvio (filho). Formato: imp:reenvio:{job_origem_id}:{n}
 */
function montarIdempotencyKeyReenvio(jobOrigemId, sequencia) {
  const origem = parsePositiveInteger(jobOrigemId);
  const n = parsePositiveInteger(sequencia);
  if (!origem || !n) {
    throw erroImpressao(
      'job_origem_id e sequência obrigatórios para reenvio.',
      400,
      'IMPRESSAO_REENVIO_CHAVE_INVALIDA'
    );
  }
  return `imp:reenvio:${origem}:${n}`;
}

module.exports = {
  LARGURAS_MM,
  LARGURA_PADRAO_MM,
  MODELOS_IMPRESSAO,
  CODIGOS_ESTACAO_TIPO,
  ESTADOS_FILA,
  erroImpressao,
  parsePositiveInteger,
  normalizarCodigoEstacao,
  normalizarLarguraMm,
  normalizarVias,
  normalizarFlag01,
  montarPayloadSnapshot,
  serializarSnapshot,
  parseSnapshotJson,
  snapshotContemCamposProibidos,
  montarIdempotencyKeyFila,
  montarIdempotencyKeyReenvio
};
