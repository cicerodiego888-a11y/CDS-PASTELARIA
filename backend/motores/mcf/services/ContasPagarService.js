/**
 * ContasPagarService — Fundação MCF-01.
 * Títulos dedicados com valor_original / valor_restante.
 * Mantém projeção vinculada em financeiro para compatibilidade MBC; o MCF é canônico.
 * @module motores/mcf/services/ContasPagarService
 */
'use strict';

const {
  STATUS_CONTA_PAGAR,
  ERROS_MCF,
  erroMcf,
  round2
} = require('../contracts/constantesMcf');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function withTx(db, fn) {
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await dbRun(db, 'COMMIT');
    return out;
  } catch (err) {
    try {
      await dbRun(db, 'ROLLBACK');
    } catch (rollbackErr) {
      console.error('Falha ao reverter transação MCF:', rollbackErr.message);
    }
    throw err;
  }
}

function exigirChaveIdempotencia(valor) {
  const chave = valor == null ? '' : String(valor).trim();
  if (!chave || chave.length > 200) {
    throw erroMcf(
      ERROS_MCF.IDEMPOTENCIA_INVALIDA,
      'Informe uma chave de idempotência válida (até 200 caracteres).',
      400
    );
  }
  return chave;
}

function exigirEmpresaId(empresaId) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMcf(ERROS_MCF.EMPRESA_OBRIGATORIA, 'empresa_id é obrigatório.', 400);
  }
  return id;
}

function parseData(valor, rotulo) {
  if (valor == null || String(valor).trim() === '') return null;
  const s = String(valor).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw erroMcf(ERROS_MCF.DATA_INVALIDA, rotulo + ' inválida. Use YYYY-MM-DD.', 400);
  }
  return s;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    empresa_id: Number(row.empresa_id),
    fornecedor_id: row.fornecedor_id != null ? Number(row.fornecedor_id) : null,
    descricao: row.descricao != null ? String(row.descricao) : '',
    valor_original: round2(row.valor_original),
    valor_restante: round2(row.valor_restante),
    data_emissao: row.data_emissao || null,
    data_vencimento: row.data_vencimento,
    status: String(row.status || STATUS_CONTA_PAGAR.ABERTA),
    forma_pagamento: row.forma_pagamento || null,
    documento: row.documento != null ? String(row.documento) : null,
    origem: row.origem != null ? String(row.origem) : 'manual',
    categoria: row.categoria != null ? String(row.categoria) : null,
    pessoa_nome: row.pessoa_nome || null,
    referencia_tipo: row.referencia_tipo || null,
    referencia_id: row.referencia_id != null ? Number(row.referencia_id) : null,
    numero_parcela: row.numero_parcela != null ? Number(row.numero_parcela) : null,
    total_parcelas: row.total_parcelas != null ? Number(row.total_parcelas) : null,
    observacao: row.observacao != null ? String(row.observacao) : null,
    idempotency_key: row.idempotency_key || null,
    fornecedor_nome: row.fornecedor_nome || null,
    criado_por: row.criado_por != null ? Number(row.criado_por) : null,
    saldo_cancelado: round2(row.saldo_cancelado || 0),
    cancelamento_motivo: row.cancelamento_motivo || null,
    cancelado_em: row.cancelado_em || null,
    cancelado_por: row.cancelado_por != null ? Number(row.cancelado_por) : null,
    cancelamento_idempotency_key: row.cancelamento_idempotency_key || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function statusFinanceiroProjecao(status) {
  if (status === STATUS_CONTA_PAGAR.QUITADA) return 'pago';
  if (status === STATUS_CONTA_PAGAR.PARCIAL) return 'parcial';
  if (status === STATUS_CONTA_PAGAR.CANCELADA) return 'cancelado';
  return 'pendente';
}

/** Marcador inequívoco de projeção criada pelo MCF (não é lançamento histórico de cliente). */
const MARCADOR_PROJECAO_SINTETICA = '[MCF_PROJECAO_SINTETICA]';

async function assegurarProjecaoFinanceira(db, empresaId, contaId) {
  const vinculo = await dbGet(
    db,
    `SELECT financeiro_id FROM contas_pagar_financeiro_compat
     WHERE empresa_id = ? AND conta_pagar_id = ?`,
    [empresaId, contaId]
  );
  if (vinculo) {
    const financeiro = await dbGet(
      db,
      'SELECT id FROM financeiro WHERE id = ? AND empresa_id = ?',
      [vinculo.financeiro_id, empresaId]
    );
    if (!financeiro) {
      throw erroMcf(
        ERROS_MCF.INCONSISTENCIA,
        'Projeção financeira MCF vinculada não foi encontrada para a empresa.',
        409,
        { conta_pagar_id: contaId, financeiro_id: vinculo.financeiro_id }
      );
    }
    return Number(vinculo.financeiro_id);
  }

  const conta = await dbGet(
    db,
    `SELECT cp.*, f.nome AS fornecedor_nome
     FROM contas_pagar cp
     LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
     WHERE cp.id = ? AND cp.empresa_id = ?`,
    [contaId, empresaId]
  );
  if (!conta) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }
  const observacaoBase = conta.observacao != null ? String(conta.observacao) : '';
  const observacaoProj = observacaoBase.includes(MARCADOR_PROJECAO_SINTETICA)
    ? observacaoBase
    : `${observacaoBase ? `${observacaoBase} ` : ''}${MARCADOR_PROJECAO_SINTETICA}`.trim();
  const financeiro = await dbRun(
    db,
    `INSERT INTO financeiro (
      tipo, descricao, valor, data_movimento, categoria, forma_pagamento,
      referencia_id, referencia_tipo, status, origem, documento, vencimento,
      numero_parcela, total_parcelas, compra_id, pessoa_nome, observacao,
      baixado_em, empresa_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      'despesa',
      conta.descricao || '',
      round2(conta.valor_original),
      conta.data_emissao || conta.data_vencimento,
      conta.categoria,
      conta.forma_pagamento,
      conta.id,
      'contas_pagar_mcf',
      statusFinanceiroProjecao(conta.status),
      'mcf_compatibilidade',
      conta.documento,
      conta.data_vencimento,
      conta.numero_parcela,
      conta.total_parcelas,
      conta.referencia_tipo === 'compra' ? conta.referencia_id : null,
      conta.pessoa_nome || conta.fornecedor_nome,
      observacaoProj,
      empresaId
    ]
  );
  await dbRun(
    db,
    `INSERT INTO contas_pagar_financeiro_compat (
      empresa_id, conta_pagar_id, financeiro_id
    ) VALUES (?, ?, ?)`,
    [empresaId, contaId, financeiro.lastID]
  );
  return financeiro.lastID;
}

async function sincronizarProjecaoFinanceira(db, empresaId, contaId, status, dataPagamento, formaPagamento) {
  const vinculo = await dbGet(
    db,
    `SELECT financeiro_id FROM contas_pagar_financeiro_compat
     WHERE empresa_id = ? AND conta_pagar_id = ?`,
    [empresaId, contaId]
  );
  if (!vinculo) return;
  const atualizado = await dbRun(
    db,
    `UPDATE financeiro
     SET status = ?,
         baixado_em = CASE WHEN ? = 'pendente' THEN baixado_em ELSE ? END,
         forma_pagamento = COALESCE(?, forma_pagamento)
     WHERE id = ? AND empresa_id = ?`,
    [
      statusFinanceiroProjecao(status),
      statusFinanceiroProjecao(status),
      dataPagamento || null,
      formaPagamento || null,
      vinculo.financeiro_id,
      empresaId
    ]
  );
  if (atualizado.changes !== 1) {
    throw erroMcf(
      ERROS_MCF.INCONSISTENCIA,
      'Não foi possível atualizar a projeção financeira MCF vinculada.',
      409,
      { conta_pagar_id: contaId, financeiro_id: Number(vinculo.financeiro_id) }
    );
  }
}

function derivarStatus(valorOriginal, valorRestante, statusAtual) {
  if (statusAtual === STATUS_CONTA_PAGAR.CANCELADA) return STATUS_CONTA_PAGAR.CANCELADA;
  const orig = round2(valorOriginal);
  const rest = round2(valorRestante);
  if (rest <= 0) return STATUS_CONTA_PAGAR.QUITADA;
  if (rest < orig) return STATUS_CONTA_PAGAR.PARCIAL;
  return STATUS_CONTA_PAGAR.ABERTA;
}

function validarConsistencia(valorOriginal, valorRestante) {
  const orig = round2(valorOriginal);
  const rest = round2(valorRestante);
  if (!(orig > 0)) {
    throw erroMcf(ERROS_MCF.VALOR_INVALIDO, 'valor_original deve ser maior que zero.', 400);
  }
  if (rest < 0) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'valor_restante não pode ser negativo.', 400);
  }
  if (rest > orig) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'valor_restante não pode exceder valor_original.', 400);
  }
}

async function validarFornecedor(db, fornecedorId) {
  if (fornecedorId == null || fornecedorId === '') return null;
  const id = Number(fornecedorId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMcf(ERROS_MCF.FORNECEDOR_NAO_ENCONTRADO, 'fornecedor_id inválido.', 400);
  }
  const row = await dbGet(db, 'SELECT id FROM fornecedores WHERE id = ?', [id]);
  if (!row) {
    throw erroMcf(ERROS_MCF.FORNECEDOR_NAO_ENCONTRADO, 'Fornecedor não encontrado.', 404);
  }
  return id;
}

function validarIdentidadeParcela(params) {
  const referenciaTipo = params.referencia_tipo != null
    ? String(params.referencia_tipo).trim().toLowerCase()
    : null;
  const referenciaId = params.referencia_id != null && params.referencia_id !== ''
    ? Number(params.referencia_id)
    : null;
  const numeroParcela = params.numero_parcela != null && params.numero_parcela !== ''
    ? Number(params.numero_parcela)
    : null;
  const totalParcelas = params.total_parcelas != null && params.total_parcelas !== ''
    ? Number(params.total_parcelas)
    : null;

  if (referenciaId != null && (!Number.isInteger(referenciaId) || referenciaId <= 0)) {
    throw erroMcf(
      ERROS_MCF.ORIGEM_NAO_ENCONTRADA,
      'referencia_id deve ser um identificador positivo.',
      400
    );
  }

  const temNumeroParcela = numeroParcela != null;
  const temTotalParcelas = totalParcelas != null;
  if (
    temNumeroParcela !== temTotalParcelas
    || (temNumeroParcela && (
      !Number.isInteger(numeroParcela)
      || !Number.isInteger(totalParcelas)
      || numeroParcela <= 0
      || totalParcelas <= 0
      || numeroParcela > totalParcelas
    ))
  ) {
    throw erroMcf(
      ERROS_MCF.PARCELA_INVALIDA,
      'Informe numero_parcela e total_parcelas válidos; numero_parcela deve estar dentro do total.',
      400
    );
  }

  if (referenciaTipo === 'compra' && (
    referenciaId == null
    || numeroParcela == null
    || totalParcelas == null
  )) {
    throw erroMcf(
      ERROS_MCF.PARCELA_INVALIDA,
      'Título de compra exige referencia_id, numero_parcela e total_parcelas.',
      400
    );
  }

  return {
    referenciaTipo,
    referenciaId,
    numeroParcela,
    totalParcelas,
    origem: referenciaTipo === 'compra'
      ? 'compra'
      : (params.origem != null ? String(params.origem) : 'manual')
  };
}

async function obterTituloCompraPorParcela(db, empresaId, referenciaId, numeroParcela) {
  return dbGet(
    db,
    `SELECT * FROM contas_pagar
     WHERE empresa_id = ? AND referencia_tipo = 'compra'
       AND referencia_id = ? AND numero_parcela = ?`,
    [empresaId, referenciaId, numeroParcela]
  );
}

function mesmoValorTexto(a, b) {
  const valorA = a == null ? null : String(a);
  const valorB = b == null ? null : String(b);
  return valorA === valorB;
}

function payloadCompraEquivalente(row, esperado) {
  const mesmoNumeroOpcional = (a, b) => (
    a == null && b == null
      ? true
      : a != null && b != null && Number(a) === Number(b)
  );
  return (
    round2(row.valor_original) === esperado.valor_original
    && Number(row.empresa_id) === esperado.empresa_id
    && (row.fornecedor_id == null ? null : Number(row.fornecedor_id)) === esperado.fornecedor_id
    && mesmoValorTexto(row.descricao, esperado.descricao)
    && mesmoValorTexto(row.data_emissao, esperado.data_emissao)
    && mesmoValorTexto(row.data_vencimento, esperado.data_vencimento)
    && mesmoValorTexto(row.forma_pagamento, esperado.forma_pagamento)
    && mesmoValorTexto(row.documento, esperado.documento)
    && mesmoValorTexto(row.categoria, esperado.categoria)
    && mesmoValorTexto(row.pessoa_nome, esperado.pessoa_nome)
    && mesmoValorTexto(row.origem, esperado.origem)
    && mesmoValorTexto(row.referencia_tipo, esperado.referencia_tipo)
    && mesmoNumeroOpcional(row.referencia_id, esperado.referencia_id)
    && mesmoNumeroOpcional(row.numero_parcela, esperado.numero_parcela)
    && mesmoNumeroOpcional(row.total_parcelas, esperado.total_parcelas)
    && mesmoValorTexto(row.observacao, esperado.observacao)
  );
}

function resultadoIdempotente(row, esperado) {
  if (!payloadCompraEquivalente(row, esperado)) {
    throw erroMcf(
      ERROS_MCF.ORIGEM_CONFLITANTE,
      'A chave ou identidade do título já possui dados diferentes.',
      409,
      { conta_pagar_id: Number(row.id) }
    );
  }
  return { ...mapRow(row), idempotente: true };
}

async function resolverTituloCompraExistente(db, esperado) {
  const row = await obterTituloCompraPorParcela(
    db,
    esperado.empresa_id,
    esperado.referencia_id,
    esperado.numero_parcela
  );
  return row ? resultadoIdempotente(row, esperado) : null;
}

async function criarNaTransacaoAtual(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const valorOriginal = round2(params.valor_original);
  if (!(valorOriginal > 0) || !Number.isFinite(valorOriginal)) {
    throw erroMcf(ERROS_MCF.VALOR_INVALIDO, 'valor_original deve ser maior que zero.', 400);
  }
  const dataVencimento = parseData(params.data_vencimento, 'data_vencimento');
  if (!dataVencimento) {
    throw erroMcf(ERROS_MCF.DATA_INVALIDA, 'data_vencimento é obrigatória.', 400);
  }
  const dataEmissao = parseData(params.data_emissao, 'data_emissao')
    || dataVencimento;
  const fornecedorId = await validarFornecedor(db, params.fornecedor_id);
  const identidadeParcela = validarIdentidadeParcela(params);
  const descricao = params.descricao != null ? String(params.descricao) : '';
  const documento = params.documento != null ? String(params.documento) : null;
  const observacao = params.observacao != null ? String(params.observacao) : null;
  const categoria = params.categoria != null ? String(params.categoria) : null;
  const pessoaNome = params.pessoa_nome != null ? String(params.pessoa_nome) : null;
  const formaPagamento = params.forma_pagamento != null
    ? String(params.forma_pagamento)
    : null;
  const criadoPor = params.criado_por != null ? Number(params.criado_por) : null;
  const chaveIdempotencia = params.idempotency_key != null
    ? exigirChaveIdempotencia(params.idempotency_key)
    : null;
  const esperado = {
    empresa_id: empresaId,
    fornecedor_id: fornecedorId,
    descricao,
    valor_original: valorOriginal,
    data_emissao: dataEmissao,
    data_vencimento: dataVencimento,
    forma_pagamento: formaPagamento,
    documento,
    categoria,
    pessoa_nome: pessoaNome,
    origem: identidadeParcela.origem,
    referencia_tipo: identidadeParcela.referenciaTipo,
    referencia_id: identidadeParcela.referenciaId,
    numero_parcela: identidadeParcela.numeroParcela,
    total_parcelas: identidadeParcela.totalParcelas,
    observacao
  };

  if (chaveIdempotencia) {
    const tituloPorChave = await dbGet(
      db,
      'SELECT * FROM contas_pagar WHERE empresa_id = ? AND idempotency_key = ?',
      [empresaId, chaveIdempotencia]
    );
    if (tituloPorChave) return resultadoIdempotente(tituloPorChave, esperado);
  }

  if (identidadeParcela.referenciaTipo === 'compra') {
    const compra = await dbGet(
      db,
      'SELECT id, empresa_id FROM compras WHERE id = ?',
      [identidadeParcela.referenciaId]
    );
    if (!compra || Number(compra.empresa_id) !== empresaId) {
      throw erroMcf(
        ERROS_MCF.ORIGEM_NAO_ENCONTRADA,
        'Compra de origem não encontrada para a empresa informada.',
        404
      );
    }

    const tituloLegado = await dbGet(
      db,
      `SELECT id FROM contas_pagar
       WHERE empresa_id = ? AND referencia_tipo = 'compra'
         AND referencia_id = ? AND numero_parcela IS NULL
       LIMIT 1`,
      [empresaId, identidadeParcela.referenciaId]
    );
    if (tituloLegado) {
      throw erroMcf(
        ERROS_MCF.ORIGEM_CONFLITANTE,
        'Existe título MCF legado sem número de parcela para esta compra; reconcilie-o antes de gerar títulos individualizados.',
        409,
        { conta_pagar_id: Number(tituloLegado.id) }
      );
    }

    const existente = await resolverTituloCompraExistente(db, esperado);
    if (existente) return existente;

    // The unique partial index is the final race guard; a matching replay is idempotent.
    const valorRestante = valorOriginal;
    validarConsistencia(valorOriginal, valorRestante);
    try {
      const r = await dbRun(
        db,
        `INSERT INTO contas_pagar (
          empresa_id, fornecedor_id, descricao, valor_original, valor_restante,
          data_emissao, data_vencimento, status, forma_pagamento, documento, origem, categoria, pessoa_nome,
          referencia_tipo, referencia_id, numero_parcela, total_parcelas,
          observacao, criado_por, idempotency_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          empresaId,
          fornecedorId,
          descricao,
          valorOriginal,
          valorRestante,
          dataEmissao,
          dataVencimento,
          STATUS_CONTA_PAGAR.ABERTA,
          formaPagamento,
          documento,
          identidadeParcela.origem,
          categoria,
          pessoaNome,
          identidadeParcela.referenciaTipo,
          identidadeParcela.referenciaId,
          identidadeParcela.numeroParcela,
          identidadeParcela.totalParcelas,
          observacao,
          criadoPor,
          chaveIdempotencia
        ]
      );
      const conta = await obter({ db, empresaId, id: r.lastID });
      if (params.omitirProjecao !== true) {
        await assegurarProjecaoFinanceira(db, empresaId, r.lastID);
      }
      return conta;
    } catch (err) {
      if (!err || err.code !== 'SQLITE_CONSTRAINT') throw err;
      if (chaveIdempotencia) {
        const tituloPorChave = await dbGet(
          db,
          'SELECT * FROM contas_pagar WHERE empresa_id = ? AND idempotency_key = ?',
          [empresaId, chaveIdempotencia]
        );
        if (tituloPorChave) return resultadoIdempotente(tituloPorChave, esperado);
      }
      const repetida = await resolverTituloCompraExistente(db, esperado);
      if (repetida) return repetida;
      throw err;
    }
  }

  // valor_restante sempre derivado — nunca confiar no frontend.
  const valorRestante = valorOriginal;
  validarConsistencia(valorOriginal, valorRestante);
  const status = STATUS_CONTA_PAGAR.ABERTA;

  try {
    const r = await dbRun(
      db,
      `INSERT INTO contas_pagar (
        empresa_id, fornecedor_id, descricao, valor_original, valor_restante,
        data_emissao, data_vencimento, status, forma_pagamento, documento, origem, categoria, pessoa_nome,
        referencia_tipo, referencia_id, numero_parcela, total_parcelas,
        observacao, criado_por, idempotency_key, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        empresaId,
        fornecedorId,
        descricao,
        valorOriginal,
        valorRestante,
        dataEmissao,
        dataVencimento,
        status,
        formaPagamento,
        documento,
        identidadeParcela.origem,
        categoria,
        pessoaNome,
        identidadeParcela.referenciaTipo,
        identidadeParcela.referenciaId,
        identidadeParcela.numeroParcela,
        identidadeParcela.totalParcelas,
        observacao,
        criadoPor,
        chaveIdempotencia
      ]
    );
    const conta = await obter({ db, empresaId, id: r.lastID });
    if (params.omitirProjecao !== true) {
      await assegurarProjecaoFinanceira(db, empresaId, r.lastID);
    }
    return conta;
  } catch (err) {
    if (!chaveIdempotencia || !err || err.code !== 'SQLITE_CONSTRAINT') throw err;
    const tituloPorChave = await dbGet(
      db,
      'SELECT * FROM contas_pagar WHERE empresa_id = ? AND idempotency_key = ?',
      [empresaId, chaveIdempotencia]
    );
    if (tituloPorChave) return resultadoIdempotente(tituloPorChave, esperado);
    throw err;
  }
}

async function criar(params = {}) {
  return withTx(params.db, () => criarNaTransacaoAtual(params));
}

async function criarLoteNaTransacaoAtual(params = {}) {
  const chaveBase = exigirChaveIdempotencia(params.idempotency_key);
  const parcelas = params.parcelas;
  if (!Array.isArray(parcelas) || parcelas.length === 0 || parcelas.length > 60) {
    throw erroMcf(
      ERROS_MCF.PARCELA_INVALIDA,
      'Informe de 1 a 60 parcelas para criar o título.',
      400
    );
  }
  const contas = [];
  for (let index = 0; index < parcelas.length; index++) {
    const parcela = parcelas[index] || {};
    contas.push(await criarNaTransacaoAtual({
      ...params,
      ...parcela,
      db: params.db,
      empresaId: params.empresaId,
      criado_por: params.criado_por,
      referencia_tipo: params.referencia_tipo || 'despesa_manual',
      referencia_id: null,
      numero_parcela: index + 1,
      total_parcelas: parcelas.length,
      idempotency_key: `${chaveBase}:${index + 1}`
    }));
  }
  return contas;
}

async function criarLote(params = {}) {
  return withTx(params.db, () => criarLoteNaTransacaoAtual(params));
}

async function obter(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }
  const row = await dbGet(
    db,
    `SELECT * FROM contas_pagar WHERE id = ? AND empresa_id = ?`,
    [id, empresaId]
  );
  if (!row) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }
  return mapRow(row);
}

async function listar(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const where = ['cp.empresa_id = ?'];
  const bind = [empresaId];
  const status = params.status != null ? String(params.status).toLowerCase() : '';
  if (status && !['todos', 'todas'].includes(status)) {
    if (status === 'pendente') {
      where.push("cp.status = 'aberto' AND date(cp.data_vencimento) >= date('now')");
    } else if (status === 'pago') {
      where.push("cp.status = 'quitada'");
    } else if (status === 'vencido') {
      where.push("cp.status IN ('aberto', 'parcial') AND date(cp.data_vencimento) < date('now')");
    } else {
      where.push('cp.status = ?');
      bind.push(status === 'cancelado' ? STATUS_CONTA_PAGAR.CANCELADA : status);
    }
  }
  if (params.fornecedor_id != null) {
    where.push('cp.fornecedor_id = ?');
    bind.push(Number(params.fornecedor_id));
  }
  if (params.referencia_tipo != null) {
    where.push('cp.referencia_tipo = ?');
    bind.push(String(params.referencia_tipo));
  }
  if (params.referencia_id != null) {
    const referenciaId = Number(params.referencia_id);
    if (!Number.isInteger(referenciaId) || referenciaId <= 0) {
      throw erroMcf(ERROS_MCF.ORIGEM_NAO_ENCONTRADA, 'referencia_id inválido.', 400);
    }
    where.push('cp.referencia_id = ?');
    bind.push(referenciaId);
  }
  if (params.dataInicio) {
    const dataInicio = parseData(params.dataInicio, 'dataInicio');
    if (!dataInicio) {
      throw erroMcf(ERROS_MCF.DATA_INVALIDA, 'dataInicio inválida.', 400);
    }
    where.push('date(cp.data_vencimento) >= date(?)');
    bind.push(dataInicio);
  }
  if (params.dataFim) {
    const dataFim = parseData(params.dataFim, 'dataFim');
    if (!dataFim) {
      throw erroMcf(ERROS_MCF.DATA_INVALIDA, 'dataFim inválida.', 400);
    }
    where.push('date(cp.data_vencimento) <= date(?)');
    bind.push(dataFim);
  }
  if (params.fornecedor) {
    where.push(`(
      COALESCE(f.nome, '') LIKE ?
      OR COALESCE(cp.pessoa_nome, '') LIKE ?
      OR COALESCE(cp.descricao, '') LIKE ?
      OR COALESCE(cp.documento, '') LIKE ?
    )`);
    const fornecedor = `%${String(params.fornecedor)}%`;
    bind.push(fornecedor, fornecedor, fornecedor, fornecedor);
  }
  const limite = Math.min(Math.max(Number(params.limite) || 100, 1), 500);
  const rows = await dbAll(
    db,
    `SELECT cp.*, f.nome AS fornecedor_nome
     FROM contas_pagar cp
     LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
     WHERE ${where.join(' AND ')}
     ORDER BY cp.data_vencimento ASC, cp.id ASC
     LIMIT ?`,
    bind.concat([limite])
  );
  return rows.map(mapRow);
}

async function listarPagamentos(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const titulo = await obter({ db, empresaId, id: params.id });
  const rows = await dbAll(
    db,
    `SELECT * FROM contas_pagar_pagamentos
     WHERE conta_pagar_id = ? AND empresa_id = ?
     ORDER BY data_pagamento ASC, id ASC`,
    [titulo.id, empresaId]
  );
  return {
    conta_pagar: titulo,
    pagamentos: rows.map(mapPagamento)
  };
}

function mapPagamento(row) {
  return {
    id: Number(row.id),
    conta_pagar_id: Number(row.conta_pagar_id),
    empresa_id: Number(row.empresa_id),
    fornecedor_id: row.fornecedor_id != null ? Number(row.fornecedor_id) : null,
    valor_pago: round2(row.valor_pago),
    data_pagamento: row.data_pagamento,
    forma_pagamento: row.forma_pagamento || null,
    observacao: row.observacao || null,
    idempotency_key: row.idempotency_key || null,
    usuario_id: row.usuario_id != null ? Number(row.usuario_id) : null,
    origem_operacao: row.origem_operacao || null,
    created_at: row.created_at || null
  };
}

function pagamentoEquivalente(row, esperado) {
  return (
    Number(row.conta_pagar_id) === esperado.conta_pagar_id
    && round2(row.valor_pago) === esperado.valor_pago
    && mesmoValorTexto(row.data_pagamento, esperado.data_pagamento)
    && mesmoValorTexto(row.forma_pagamento, esperado.forma_pagamento)
    && mesmoValorTexto(row.observacao, esperado.observacao)
  );
}

/**
 * Registra pagamento dentro da transação já controlada pelo chamador.
 * A função não inicia nem confirma transação.
 */
async function baixarNaTransacaoAtual(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const id = Number(params.id);
  const chaveIdempotencia = exigirChaveIdempotencia(params.idempotency_key);
  const valorPago = round2(params.valor_pago != null ? params.valor_pago : params.valor);
  if (!(valorPago > 0) || !Number.isFinite(valorPago)) {
    throw erroMcf(ERROS_MCF.VALOR_INVALIDO, 'valor_pago deve ser maior que zero.', 400);
  }
  const dataPagamento = parseData(params.data_pagamento, 'data_pagamento')
    || new Date().toISOString().slice(0, 10);
  const formaPagamento = params.forma_pagamento != null
    ? String(params.forma_pagamento)
    : null;
  const observacao = params.observacao != null ? String(params.observacao) : null;
  const esperado = {
    conta_pagar_id: id,
    valor_pago: valorPago,
    data_pagamento: dataPagamento,
    forma_pagamento: formaPagamento,
    observacao
  };

  const pagamentoExistente = await dbGet(
    db,
    `SELECT * FROM contas_pagar_pagamentos
     WHERE empresa_id = ? AND idempotency_key = ?`,
    [empresaId, chaveIdempotencia]
  );
  if (pagamentoExistente) {
    if (!pagamentoEquivalente(pagamentoExistente, esperado)) {
      throw erroMcf(
        ERROS_MCF.OPERACAO_CONFLITANTE,
        'A chave de idempotência já foi usada com dados de pagamento diferentes.',
        409,
        { pagamento_id: Number(pagamentoExistente.id) }
      );
    }
    return {
      ...(await obter({ db, empresaId, id })),
      pagamento_id: Number(pagamentoExistente.id),
      idempotente: true
    };
  }

  const row = await dbGet(
    db,
    `SELECT cp.*, f.nome AS fornecedor_nome
     FROM contas_pagar cp
     LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
     WHERE cp.id = ? AND cp.empresa_id = ?`,
    [id, empresaId]
  );
  if (!row) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }
  const statusAtual = String(row.status || '');
  if (statusAtual === STATUS_CONTA_PAGAR.CANCELADA) {
    throw erroMcf(ERROS_MCF.TITULO_CANCELADO, 'Título cancelado não aceita baixa.', 409);
  }
  if (statusAtual === STATUS_CONTA_PAGAR.QUITADA || round2(row.valor_restante) <= 0) {
    throw erroMcf(ERROS_MCF.TITULO_QUITADO, 'Título já está quitado.', 409);
  }
  const restante = round2(row.valor_restante);
  if (valorPago > restante) {
    throw erroMcf(
      ERROS_MCF.BAIXA_EXCEDE_RESTANTE,
      'Valor da baixa excede o valor restante.',
      400,
      { valor_restante: restante, valor_pago: valorPago }
    );
  }
  const novoRestante = round2(restante - valorPago);
  validarConsistencia(row.valor_original, novoRestante);
  const novoStatus = derivarStatus(row.valor_original, novoRestante, statusAtual);

  const pagamento = await dbRun(
    db,
    `INSERT INTO contas_pagar_pagamentos (
      conta_pagar_id, empresa_id, fornecedor_id, valor_pago,
      data_pagamento, forma_pagamento, observacao,
      idempotency_key, usuario_id, origem_operacao
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      empresaId,
      row.fornecedor_id,
      valorPago,
      dataPagamento,
      formaPagamento,
      observacao,
      chaveIdempotencia,
      params.usuario_id != null ? Number(params.usuario_id) : null,
      params.origem_operacao != null ? String(params.origem_operacao) : 'mcf'
    ]
  );
  const atualizacao = await dbRun(
    db,
    `UPDATE contas_pagar
     SET valor_restante = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND empresa_id = ? AND valor_restante = ? AND status = ?`,
    [novoRestante, novoStatus, id, empresaId, restante, statusAtual]
  );
  if (atualizacao.changes !== 1) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE,
      'O saldo do título foi alterado durante a baixa. Recarregue e tente novamente.',
      409
    );
  }
  await sincronizarProjecaoFinanceira(
    db,
    empresaId,
    id,
    novoStatus,
    dataPagamento,
    formaPagamento
  );
  return {
    ...(await obter({ db, empresaId, id })),
    pagamento_id: pagamento.lastID,
    idempotente: false
  };
}

async function baixar(params = {}) {
  return withTx(params.db, () => baixarNaTransacaoAtual(params));
}

async function cancelarNaTransacaoAtual(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const id = Number(params.id);
  const chaveIdempotencia = exigirChaveIdempotencia(params.idempotency_key);
  const motivo = params.motivo != null ? String(params.motivo).trim() : '';
  if (!motivo || motivo.length > 1000) {
    throw erroMcf(
      ERROS_MCF.STATUS_INVALIDO,
      'Informe o motivo do cancelamento (até 1000 caracteres).',
      400
    );
  }

  const canceladoExistente = await dbGet(
    db,
    `SELECT * FROM contas_pagar
     WHERE empresa_id = ? AND cancelamento_idempotency_key = ?`,
    [empresaId, chaveIdempotencia]
  );
  if (canceladoExistente) {
    if (
      Number(canceladoExistente.id) !== id
      || String(canceladoExistente.cancelamento_motivo || '') !== motivo
    ) {
      throw erroMcf(
        ERROS_MCF.OPERACAO_CONFLITANTE,
        'A chave de idempotência já foi usada para outro cancelamento.',
        409,
        { conta_pagar_id: Number(canceladoExistente.id) }
      );
    }
    return { ...mapRow(canceladoExistente), idempotente: true };
  }

  const row = await dbGet(
    db,
    'SELECT * FROM contas_pagar WHERE id = ? AND empresa_id = ?',
    [id, empresaId]
  );
  if (!row) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }
  if (row.status === STATUS_CONTA_PAGAR.CANCELADA) {
    throw erroMcf(
      ERROS_MCF.TITULO_JA_CANCELADO,
      'Título já cancelado; não é possível substituir seu motivo ou chave.',
      409
    );
  }
  if (row.status === STATUS_CONTA_PAGAR.QUITADA || round2(row.valor_restante) <= 0) {
    throw erroMcf(
      ERROS_MCF.TITULO_QUITADO,
      'Título quitado exige operação de estorno separada e não pode ser cancelado.',
      409
    );
  }
  const saldoCancelado = round2(row.valor_restante);
  const atualizado = await dbRun(
    db,
    `UPDATE contas_pagar
     SET valor_restante = 0, status = ?, saldo_cancelado = ?,
         cancelamento_motivo = ?, cancelado_em = CURRENT_TIMESTAMP,
         cancelado_por = ?, cancelamento_idempotency_key = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND empresa_id = ? AND valor_restante = ? AND status = ?`,
    [
      STATUS_CONTA_PAGAR.CANCELADA,
      saldoCancelado,
      motivo,
      params.usuario_id != null ? Number(params.usuario_id) : null,
      chaveIdempotencia,
      id,
      empresaId,
      round2(row.valor_restante),
      row.status
    ]
  );
  if (atualizado.changes !== 1) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE,
      'O saldo do título foi alterado durante o cancelamento. Recarregue e tente novamente.',
      409
    );
  }
  await sincronizarProjecaoFinanceira(
    db,
    empresaId,
    id,
    STATUS_CONTA_PAGAR.CANCELADA,
    null,
    null
  );
  return {
    ...(await obter({ db, empresaId, id })),
    saldo_cancelado: saldoCancelado,
    idempotente: false
  };
}

async function cancelar(params = {}) {
  return withTx(params.db, () => cancelarNaTransacaoAtual(params));
}

/**
 * Estorna baixas automáticas da liquidação inicial da compra (pagamento-inicial).
 * Se houver qualquer pagamento manual/adicional, mantém bloqueio (409).
 * Deixa o título em aberto para o cancelamento da compra seguir.
 */
async function estornarBaixasIniciaisCompraNaTransacaoAtual(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const compraId = Number(params.compra_id ?? params.compraId ?? params.referencia_id);
  const id = Number(params.id);
  if (!Number.isInteger(compraId) || compraId <= 0) {
    throw erroMcf(ERROS_MCF.STATUS_INVALIDO, 'compra_id inválido para estorno da liquidação inicial.', 400);
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }

  const row = await dbGet(
    db,
    'SELECT * FROM contas_pagar WHERE id = ? AND empresa_id = ?',
    [id, empresaId]
  );
  if (!row) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }
  if (row.status === STATUS_CONTA_PAGAR.CANCELADA) {
    return { ...mapRow(row), estornado: false, ja_cancelado: true };
  }
  if (
    String(row.referencia_tipo || '') !== 'compra'
    || Number(row.referencia_id) !== compraId
  ) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE,
      'Título não pertence à compra informada.',
      409,
      { conta_pagar_id: id, compra_id: compraId }
    );
  }

  const pagamentos = await dbAll(
    db,
    `SELECT * FROM contas_pagar_pagamentos
     WHERE conta_pagar_id = ? AND empresa_id = ?
     ORDER BY id ASC`,
    [id, empresaId]
  );

  if (!pagamentos.length) {
    if (row.status === STATUS_CONTA_PAGAR.QUITADA || round2(row.valor_restante) <= 0) {
      // Quitada sem trilha de pagamento: reabre para permitir cancelar a compra.
      const reaberto = await dbRun(
        db,
        `UPDATE contas_pagar
         SET valor_restante = ?, status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND empresa_id = ?`,
        [round2(row.valor_original), STATUS_CONTA_PAGAR.ABERTA, id, empresaId]
      );
      if (reaberto.changes !== 1) {
        throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'Não foi possível reabrir o título quitado.', 409);
      }
      await sincronizarProjecaoFinanceira(
        db,
        empresaId,
        id,
        STATUS_CONTA_PAGAR.ABERTA,
        null,
        null
      );
      return { ...(await obter({ db, empresaId, id })), estornado: true };
    }
    return { ...mapRow(row), estornado: false };
  }

  const prefixo = `compra:${compraId}:parcela:`;
  const soLiquidacaoInicial = pagamentos.every((p) => {
    const key = String(p.idempotency_key || '');
    const origem = String(p.origem_operacao || '');
    return key.startsWith(prefixo)
      && key.endsWith(':pagamento-inicial')
      && (origem === 'compra' || origem === '');
  });
  if (!soLiquidacaoInicial) {
    throw erroMcf(
      ERROS_MCF.TITULO_QUITADO,
      'Compra possui título com baixa manual. Devolução ou estorno deve ser tratado separadamente.',
      409,
      { conta_pagar_id: id, compra_id: compraId }
    );
  }

  await dbRun(
    db,
    `DELETE FROM contas_pagar_pagamentos
     WHERE conta_pagar_id = ? AND empresa_id = ?`,
    [id, empresaId]
  );
  const atualizado = await dbRun(
    db,
    `UPDATE contas_pagar
     SET valor_restante = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND empresa_id = ?`,
    [round2(row.valor_original), STATUS_CONTA_PAGAR.ABERTA, id, empresaId]
  );
  if (atualizado.changes !== 1) {
    throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'Não foi possível estornar a liquidação inicial.', 409);
  }
  await sincronizarProjecaoFinanceira(
    db,
    empresaId,
    id,
    STATUS_CONTA_PAGAR.ABERTA,
    null,
    null
  );
  return { ...(await obter({ db, empresaId, id })), estornado: true };
}

module.exports = {
  criar,
  criarNaTransacaoAtual,
  criarLote,
  criarLoteNaTransacaoAtual,
  obter,
  listar,
  listarPagamentos,
  baixar,
  baixarNaTransacaoAtual,
  cancelar,
  cancelarNaTransacaoAtual,
  estornarBaixasIniciaisCompraNaTransacaoAtual,
  assegurarProjecaoFinanceira,
  sincronizarProjecaoFinanceira,
  MARCADOR_PROJECAO_SINTETICA,
  STATUS_CONTA_PAGAR,
  ERROS_MCF,
  round2,
  mapRow,
  derivarStatus,
  validarConsistencia
};
