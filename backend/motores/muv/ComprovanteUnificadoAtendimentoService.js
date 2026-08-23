/**
 * Snapshot somente-leitura do Comprovante Unificado (Sprint 04.10).
 * Evolui o contrato 04.07. Não emite NFC-e, não grava atendimento.
 *
 * @module motores/muv/ComprovanteUnificadoAtendimentoService
 */
'use strict';

const {
  STATUS_ATENDIMENTO,
  STATUS_FISCAL_OPERACAO,
  arredondarCentavosMuv
} = require('./contratos');

const TIPO_COMPROVANTE = 'COMPROVANTE_UNIFICADO_ATENDIMENTO';

function erroComprovante(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  if (extra.statusCode != null) err.statusCode = extra.statusCode;
  return err;
}

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../database');
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

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

async function carregarSnapshot(db, atendimentoId) {
  const cab = await dbGet(db, `SELECT * FROM atendimentos WHERE id = ?`, [atendimentoId]);
  if (!cab) {
    throw erroComprovante('ATENDIMENTO_INVALIDO', `Atendimento não encontrado: ${atendimentoId}.`, {
      statusCode: 404
    });
  }

  const operacoes = await dbAll(
    db,
    `SELECT * FROM atendimento_operacoes WHERE atendimento_id = ? ORDER BY id`,
    [atendimentoId]
  );
  const opIds = operacoes.map((o) => o.id);
  const itens = opIds.length
    ? await dbAll(
      db,
      `SELECT * FROM atendimento_operacao_itens
        WHERE operacao_id IN (${placeholders(opIds.length)})
        ORDER BY id`,
      opIds
    )
    : [];

  const pagamentos = await dbAll(
    db,
    `SELECT * FROM atendimento_pagamentos WHERE atendimento_id = ? ORDER BY sequencia, id`,
    [atendimentoId]
  );

  let documentos = [];
  try {
    documentos = await dbAll(
      db,
      `SELECT * FROM atendimento_operacao_documentos WHERE atendimento_id = ? ORDER BY id`,
      [atendimentoId]
    );
  } catch (_) {
    documentos = [];
  }

  const empresaIds = [...new Set(operacoes.map((o) => Number(o.empresa_id)).filter((n) => n > 0))];
  const empresas = empresaIds.length
    ? await dbAll(
      db,
      `SELECT id, cnpj, razao_social, nome_fantasia FROM empresas WHERE id IN (${placeholders(empresaIds.length)})`,
      empresaIds
    )
    : [];

  const produtoIds = [...new Set(itens.map((i) => Number(i.produto_id)).filter((n) => n > 0))];
  let produtos = [];
  if (produtoIds.length) {
    try {
      produtos = await dbAll(
        db,
        `SELECT id, nome, unidade FROM produtos WHERE id IN (${placeholders(produtoIds.length)})`,
        produtoIds
      );
    } catch (_) {
      produtos = [];
    }
  }

  return { cab, operacoes, itens, pagamentos, documentos, empresas, produtos };
}

function montarItens(itens, produtosPorId) {
  return itens
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((it) => {
      const prod = produtosPorId.get(Number(it.produto_id));
      return {
        itemId: it.id,
        produtoId: it.produto_id,
        descricao: (prod && prod.nome) || `Produto ${it.produto_id}`,
        quantidade: Number(it.quantidade),
        unidade: (prod && prod.unidade) || null,
        valorUnitario: arredondarCentavosMuv(it.valor_unitario),
        valorTotal: arredondarCentavosMuv(it.valor_total)
      };
    });
}

function filtrarDocumentosOficiais(documentos, operacoes) {
  return documentos.filter((d) => {
    const op = operacoes.find((o) => Number(o.id) === Number(d.atendimento_operacao_id));
    if (!op) return false;
    if (Number(op.empresa_id) !== Number(d.empresa_id)) return false;
    if (op.venda_id && d.venda_id && Number(op.venda_id) !== Number(d.venda_id)) return false;
    return true;
  });
}

function resumoFiscal(statusAtendimento, docs) {
  const autorizados = docs.filter((d) => d.status === STATUS_FISCAL_OPERACAO.AUTORIZADA);
  const erros = docs.filter((d) => (
    d.status === STATUS_FISCAL_OPERACAO.REJEITADA || d.status === STATUS_FISCAL_OPERACAO.ERRO
  ));
  const naoAplicavel = docs.filter((d) => d.status === STATUS_FISCAL_OPERACAO.NAO_APLICAVEL);
  const pendentes = docs.filter((d) => (
    !d.status
    || d.status === STATUS_FISCAL_OPERACAO.PENDENTE
  ));

  let status = statusAtendimento;
  if (
    docs.length === 0
    && statusAtendimento !== STATUS_ATENDIMENTO.FISCALIZADO
    && statusAtendimento !== STATUS_ATENDIMENTO.FISCAL_PARCIAL
    && statusAtendimento !== STATUS_ATENDIMENTO.FISCAL_ERRO
  ) {
    status = 'PENDENTE';
  }

  return {
    status,
    possui_documentos: docs.length > 0,
    quantidade_documentos: docs.length,
    quantidade_autorizados: autorizados.length,
    quantidade_pendentes: pendentes.length,
    quantidade_com_erro: erros.length,
    quantidade_nao_aplicavel: naoAplicavel.length
  };
}

async function obterComprovanteUnificado(atendimentoId, deps = {}) {
  const id = Number(atendimentoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroComprovante('ATENDIMENTO_INVALIDO', 'atendimentoId inválido.', { statusCode: 400 });
  }

  const db = getDb(deps.db);
  const snap = await carregarSnapshot(db, id);

  if (snap.cab.modo_operacao !== 'MULTIEMPRESA') {
    throw erroComprovante(
      'ATENDIMENTO_INVALIDO',
      'Comprovante unificado aplica-se somente a atendimento MULTIEMPRESA.',
      { statusCode: 400 }
    );
  }

  const produtosPorId = new Map(snap.produtos.map((p) => [Number(p.id), p]));
  const empresasPorId = new Map(snap.empresas.map((e) => [Number(e.id), e]));
  const itens = montarItens(snap.itens, produtosPorId);
  const total = arredondarCentavosMuv(snap.cab.valor_total);
  const formas = snap.pagamentos.map((p) => ({
    formaPagamento: p.forma_pagamento,
    valor: arredondarCentavosMuv(p.valor)
  }));
  const somaItens = arredondarCentavosMuv(itens.reduce((acc, it) => acc + Number(it.valorTotal || 0), 0));
  const somaPagamentos = arredondarCentavosMuv(formas.reduce((acc, p) => acc + Number(p.valor || 0), 0));
  const somaOperacoes = arredondarCentavosMuv(
    snap.operacoes.reduce((acc, o) => acc + Number(o.subtotal || 0), 0)
  );

  const docsOficiais = filtrarDocumentosOficiais(snap.documentos, snap.operacoes);
  const documentosFiscais = docsOficiais.map((d) => {
    const emp = empresasPorId.get(Number(d.empresa_id));
    const chave = d.chave_acesso || null;
    const qr = d.qr_code_url || null;
    return {
      empresaId: d.empresa_id,
      empresa_id: d.empresa_id,
      empresa_nome: (emp && (emp.nome_fantasia || emp.razao_social)) || null,
      operacaoId: d.atendimento_operacao_id,
      vendaId: d.venda_id,
      venda_id: d.venda_id,
      status: d.status,
      documento: {
        tipo: 'NFC-e',
        numero: d.numero != null ? d.numero : null,
        serie: d.serie != null ? d.serie : null,
        chave,
        qr_code_url: qr,
        xml_disponivel: !!(d.nfce_nota_id || chave)
      },
      numero: d.numero,
      chaveAcesso: chave,
      qrCodeUrl: qr,
      nfceNotaId: d.nfce_nota_id
    };
  });

  const fiscal = resumoFiscal(snap.cab.status, docsOficiais);

  return Object.freeze({
    tipo: TIPO_COMPROVANTE,
    atendimento: {
      id: snap.cab.id,
      codigo: snap.cab.codigo,
      status: snap.cab.status,
      created_at: snap.cab.created_at || null,
      origem: snap.cab.origem,
      modo_operacao: snap.cab.modo_operacao
    },
    estabelecimento: {
      nome: null,
      origem: snap.cab.origem
    },
    cabecalho: {
      atendimentoId: snap.cab.id,
      codigo: snap.cab.codigo,
      origem: snap.cab.origem,
      dataHora: snap.cab.created_at || null,
      cliente: null,
      modo_operacao: snap.cab.modo_operacao
    },
    itens,
    itensAgrupadosPorEmpresa: false,
    total,
    totais: {
      atendimento: total,
      itens: somaItens,
      pagamentos: somaPagamentos,
      operacoes: somaOperacoes
    },
    pagamento: {
      unificado: true,
      total,
      formas
    },
    pagamentos: formas,
    documentosFiscais,
    documentos_fiscais: documentosFiscais,
    fiscal,
    invariantes: {
      totalAtendimento: total,
      somaOperacoes,
      somaPagamentos,
      somaItens
    },
    renderizacao: {
      listaItensContinua: true,
      pagamentoUnificado: true,
      secaoFiscalPorEmpresa: true,
      suficienteParaImpressao: true
    }
  });
}

module.exports = {
  obterComprovanteUnificado,
  TIPO_COMPROVANTE
};
