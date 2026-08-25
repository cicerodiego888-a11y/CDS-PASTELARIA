/**
 * Orquestrador fiscal do atendimento MULTIEMPRESA (Sprint 04.07).
 * Chama o emissor oficial por venda_id. Não emite NFC-e, não cobra, não baixa estoque.
 *
 * @module motores/muv/FiscalizarAtendimentoService
 */
'use strict';

const { garantirSchemaAtendimentoAsync } = require('./atendimentoSchema');
const {
  STATUS_ATENDIMENTO,
  STATUS_FISCAL_OPERACAO,
  TIPO_FISCAL_ITEM_ATENDIMENTO
} = require('./contratos');

function erroFiscal(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  if (extra.statusCode != null) err.statusCode = extra.statusCode;
  if (extra.detalhes != null) err.detalhes = extra.detalhes;
  return err;
}

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../database');
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
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

function resolverEmissor(deps) {
  if (typeof deps.emitirPorVendaId === 'function') return deps.emitirPorVendaId;
  const emissor = require('../../services/fiscal/emissor');
  return (vendaId, opts) => emissor.emitirPorVendaId(vendaId, opts || {});
}

function operacaoExigeDocumentoFiscal(operacao) {
  const itens = operacao.itens || [];
  if (itens.length === 0) return false;
  return itens.some((it) => it.tipoFiscal !== TIPO_FISCAL_ITEM_ATENDIMENTO.NAO_FISCAL);
}

function mapearStatusEmissor(resultado) {
  const status = String((resultado && resultado.status) || '').toLowerCase();
  if (status === 'autorizada' || resultado.success === true && resultado.reused) {
    return STATUS_FISCAL_OPERACAO.AUTORIZADA;
  }
  if (status === 'sem_itens_fiscais') return STATUS_FISCAL_OPERACAO.NAO_APLICAVEL;
  if (status === 'rejeitada' || status === 'rejeitada_duplicidade') {
    return STATUS_FISCAL_OPERACAO.REJEITADA;
  }
  if (resultado && resultado.success === true && status === 'autorizada') {
    return STATUS_FISCAL_OPERACAO.AUTORIZADA;
  }
  return STATUS_FISCAL_OPERACAO.ERRO;
}

function consolidarStatusAtendimento(resultados) {
  const aplicaveis = resultados.filter((r) => r.status !== STATUS_FISCAL_OPERACAO.NAO_APLICAVEL);
  if (aplicaveis.length === 0) return STATUS_ATENDIMENTO.FISCALIZADO;
  const ok = aplicaveis.filter((r) => r.status === STATUS_FISCAL_OPERACAO.AUTORIZADA);
  const falhas = aplicaveis.filter((r) => (
    r.status === STATUS_FISCAL_OPERACAO.REJEITADA || r.status === STATUS_FISCAL_OPERACAO.ERRO
  ));
  if (ok.length === aplicaveis.length) return STATUS_ATENDIMENTO.FISCALIZADO;
  if (ok.length === 0 && falhas.length === aplicaveis.length) return STATUS_ATENDIMENTO.FISCAL_ERRO;
  return STATUS_ATENDIMENTO.FISCAL_PARCIAL;
}

async function carregarDocumentoOperacao(db, operacaoId) {
  return dbGet(
    db,
    `SELECT * FROM atendimento_operacao_documentos WHERE atendimento_operacao_id = ?`,
    [operacaoId]
  );
}

async function upsertDocumento(db, payload) {
  const existente = await carregarDocumentoOperacao(db, payload.atendimentoOperacaoId);
  if (existente) {
    await dbRun(
      db,
      `UPDATE atendimento_operacao_documentos
          SET nfce_nota_id = ?, chave_acesso = ?, numero = ?, serie = ?,
              status = ?, qr_code_url = ?, erro_codigo = ?, erro_mensagem = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [
        payload.nfceNotaId,
        payload.chaveAcesso,
        payload.numero,
        payload.serie,
        payload.status,
        payload.qrCodeUrl,
        payload.erroCodigo,
        payload.erroMensagem,
        existente.id
      ]
    );
    return existente.id;
  }
  const ins = await dbRun(
    db,
    `INSERT INTO atendimento_operacao_documentos (
       atendimento_id, atendimento_operacao_id, empresa_id, venda_id,
       nfce_nota_id, chave_acesso, numero, serie, status, qr_code_url,
       erro_codigo, erro_mensagem, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      payload.atendimentoId,
      payload.atendimentoOperacaoId,
      payload.empresaId,
      payload.vendaId,
      payload.nfceNotaId,
      payload.chaveAcesso,
      payload.numero,
      payload.serie,
      payload.status,
      payload.qrCodeUrl,
      payload.erroCodigo,
      payload.erroMensagem
    ]
  );
  return ins.lastID;
}

function mapearDocumento(row) {
  if (!row) return null;
  return {
    documentoId: row.id,
    atendimentoId: row.atendimento_id,
    operacaoId: row.atendimento_operacao_id,
    empresaId: row.empresa_id,
    vendaId: row.venda_id,
    nfceNotaId: row.nfce_nota_id,
    chaveAcesso: row.chave_acesso,
    numero: row.numero,
    serie: row.serie,
    status: row.status,
    qrCodeUrl: row.qr_code_url,
    erroCodigo: row.erro_codigo,
    erroMensagem: row.erro_mensagem
  };
}

async function exigirDadosFiscaisMaterializados(db, vendaId) {
  const cols = await dbAll(db, `PRAGMA table_info(vendas_itens)`);
  const nomes = cols.map((c) => c.name);
  if (!nomes.includes('quantidade_fiscal') || !nomes.includes('valor_fiscal')) {
    throw erroFiscal(
      'DADOS_FISCAIS_INCOMPLETOS',
      'Venda materializada sem colunas fiscais exigidas pelo emissor.',
      { statusCode: 409 }
    );
  }
  const itens = await dbAll(
    db,
    `SELECT quantidade_fiscal, valor_fiscal FROM vendas_itens WHERE venda_id = ?`,
    [vendaId]
  );
  const pronto = itens.some((it) => Number(it.quantidade_fiscal || 0) > 0 && Number(it.valor_fiscal || 0) > 0);
  if (!pronto) {
    throw erroFiscal(
      'DADOS_FISCAIS_INCOMPLETOS',
      'Venda sem quantidade_fiscal/valor_fiscal materializados. Emissão externa bloqueada.',
      { statusCode: 409 }
    );
  }
}

async function fiscalizarOperacao(atendimento, operacao, deps) {
  const db = getDb(deps.db);
  const empresaId = Number(operacao.empresaId);
  const vendaId = Number(operacao.vendaId);

  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw erroFiscal('VINCULO_FISCAL_INVALIDO', 'empresa_id persistido da operação é obrigatório.', {
      statusCode: 500
    });
  }
  if (!Number.isInteger(vendaId) || vendaId <= 0) {
    throw erroFiscal('VINCULO_FISCAL_INVALIDO', 'venda_id persistido da operação é obrigatório.', {
      statusCode: 409
    });
  }

  if (deps.empresaId != null && Number(deps.empresaId) !== empresaId) {
    throw erroFiscal(
      'VINCULO_FISCAL_INVALIDO',
      'empresaId externo diverge da operação persistida.',
      { statusCode: 409 }
    );
  }

  const venda = await dbGet(db, `SELECT id, codigo FROM vendas WHERE id = ?`, [vendaId]);
  if (!venda) {
    throw erroFiscal(
      'VINCULO_FISCAL_INVALIDO',
      `Venda ${vendaId} vinculada à operação ${operacao.operacaoId} não existe.`,
      { statusCode: 409 }
    );
  }
  const donos = await dbAll(
    db,
    `SELECT id, empresa_id FROM atendimento_operacoes WHERE venda_id = ?`,
    [vendaId]
  );
  if (
    donos.length !== 1
    || Number(donos[0].id) !== Number(operacao.operacaoId)
    || Number(donos[0].empresa_id) !== empresaId
  ) {
    throw erroFiscal(
      'VINCULO_FISCAL_INVALIDO',
      'Venda não pertence exclusivamente à operação empresarial persistida.',
      { statusCode: 409 }
    );
  }
  const codigoEsperado = `MUV-${atendimento.atendimentoId}-${operacao.operacaoId}`;
  if (venda.codigo && String(venda.codigo) !== codigoEsperado) {
    throw erroFiscal(
      'VINCULO_FISCAL_INVALIDO',
      'Código da venda materializada não corresponde à operação persistida.',
      { statusCode: 409 }
    );
  }

  const atual = await carregarDocumentoOperacao(db, operacao.operacaoId);
  if (atual && atual.status === STATUS_FISCAL_OPERACAO.AUTORIZADA) {
    return { ...mapearDocumento(atual), reused: true };
  }
  if (atual && atual.empresa_id !== empresaId) {
    throw erroFiscal(
      'VINCULO_FISCAL_INVALIDO',
      'empresa_id do documento diverge da operação persistida.',
      { statusCode: 409 }
    );
  }

  if (!operacaoExigeDocumentoFiscal(operacao)) {
    const payload = {
      atendimentoId: atendimento.atendimentoId,
      atendimentoOperacaoId: operacao.operacaoId,
      empresaId,
      vendaId,
      nfceNotaId: null,
      chaveAcesso: null,
      numero: null,
      serie: null,
      status: STATUS_FISCAL_OPERACAO.NAO_APLICAVEL,
      qrCodeUrl: null,
      erroCodigo: null,
      erroMensagem: null
    };
    await upsertDocumento(db, payload);
    return { ...payload, operacaoId: operacao.operacaoId, reused: false };
  }

  await exigirDadosFiscaisMaterializados(db, vendaId);
  const obterConfig = typeof deps.getFiscalConfig === 'function'
    ? deps.getFiscalConfig
    : (opts) => require('../../services/fiscal/configService').getFiscalConfig(opts);
  const config = await obterConfig({ empresaId, db, validarUrls: false });
  if (!config || config.fonte !== 'EMPRESA' || Number(config.empresaId) !== empresaId) {
    throw erroFiscal(
      'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE',
      'MULTIEMPRESA exige configuração fiscal própria da operação. Sem fallback global.',
      { statusCode: 409 }
    );
  }

  const emitir = resolverEmissor(deps);
  const resultado = await emitir(vendaId, { empresaId, db });
  const status = mapearStatusEmissor(resultado || {});
  const payload = {
    atendimentoId: atendimento.atendimentoId,
    atendimentoOperacaoId: operacao.operacaoId,
    empresaId,
    vendaId,
    nfceNotaId: (resultado && (resultado.notaId || resultado.nfce_id)) || null,
    chaveAcesso: (resultado && (resultado.chaveAcesso || resultado.chave_acesso)) || null,
    numero: (resultado && resultado.numero) || null,
    serie: (resultado && resultado.serie) || null,
    status,
    qrCodeUrl: (resultado && (resultado.qrCodeUrl || resultado.qr_code_url)) || null,
    erroCodigo: status === STATUS_FISCAL_OPERACAO.AUTORIZADA
      ? null
      : ((resultado && (resultado.status || resultado.code)) || 'ERRO_FISCAL'),
    erroMensagem: status === STATUS_FISCAL_OPERACAO.AUTORIZADA
      ? null
      : ((resultado && resultado.message) || null)
  };
  await upsertDocumento(db, payload);
  return { ...payload, operacaoId: operacao.operacaoId, reused: !!(resultado && resultado.reused) };
}

async function fiscalizarAtendimento(atendimentoId, deps = {}) {
  const db = getDb(deps.db);
  const id = Number(atendimentoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroFiscal('ATENDIMENTO_INVALIDO', 'atendimentoId inválido.', { statusCode: 400 });
  }

  await garantirSchemaAtendimentoAsync(db);
  const atendimentoService = deps.AtendimentoMultiempresaService
    || require('./AtendimentoMultiempresaService');

  const atendimento = await atendimentoService.obterAtendimento(id, { db });
  if (atendimento.modo_operacao !== 'MULTIEMPRESA') {
    throw erroFiscal(
      'ATENDIMENTO_INVALIDO',
      'Fiscalização MUV aplica-se somente a atendimento MULTIEMPRESA.',
      { statusCode: 400 }
    );
  }
  if (atendimento.status === STATUS_ATENDIMENTO.CANCELADO) {
    throw erroFiscal('ATENDIMENTO_CANCELADO', 'Atendimento cancelado não pode ser fiscalizado.', {
      statusCode: 409
    });
  }
  const elegivel = [
    STATUS_ATENDIMENTO.CONCLUIDO,
    STATUS_ATENDIMENTO.FISCALIZANDO,
    STATUS_ATENDIMENTO.FISCAL_PARCIAL,
    STATUS_ATENDIMENTO.FISCAL_ERRO,
    STATUS_ATENDIMENTO.FISCALIZADO
  ];
  if (!elegivel.includes(atendimento.status)) {
    throw erroFiscal(
      'ATENDIMENTO_NAO_MATERIALIZADO',
      `Atendimento em status ${atendimento.status} não pode ser fiscalizado.`,
      { statusCode: 409 }
    );
  }

  await dbRun(
    db,
    `UPDATE atendimentos SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [STATUS_ATENDIMENTO.FISCALIZANDO, id]
  );

  const documentos = [];
  for (const op of atendimento.operacoes) {
    const doc = await fiscalizarOperacao(atendimento, op, { ...deps, db });
    documentos.push(doc);
    if (typeof deps.aposFiscalizarOperacao === 'function') {
      await deps.aposFiscalizarOperacao({ atendimentoId: id, operacao: op, documento: doc });
    }
  }

  const consolidado = consolidarStatusAtendimento(documentos);
  await dbRun(
    db,
    `UPDATE atendimentos SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [consolidado, id]
  );

  const comprovante = await require('./ComprovanteUnificadoAtendimentoService')
    .obterComprovanteUnificado(id, { ...deps, db });
  return Object.freeze({
    atendimento_id: id,
    status: consolidado,
    documentos,
    comprovante,
    venda_concluida: true,
    pagamento_pendente: false
  });
}

function obterComprovanteUnificado(atendimentoId, deps = {}) {
  return require('./ComprovanteUnificadoAtendimentoService').obterComprovanteUnificado(
    atendimentoId,
    deps
  );
}

module.exports = {
  fiscalizarAtendimento,
  obterComprovanteUnificado,
  operacaoExigeDocumentoFiscal,
  consolidarStatusAtendimento
};
