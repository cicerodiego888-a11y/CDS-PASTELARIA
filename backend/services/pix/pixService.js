const db = require('../../database');
const providerCatalog = require('./providerCatalog');

const providers = {
  mercadopago: require('./providers/mercadoPagoProvider'),
  stone: require('./providers/stoneProvider'),
  simulador: require('./providers/simuladorProvider')
};

function obterDb(dbConn) {
  return dbConn || db;
}

function dbGet(sql, params = [], dbConn) {
  const conn = obterDb(dbConn);
  return new Promise((resolve, reject) => {
    conn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(sql, params = [], dbConn) {
  const conn = obterDb(dbConn);
  return new Promise((resolve, reject) => {
    conn.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function tentarAlter(sql, dbConn) {
  try {
    await dbRun(sql, [], dbConn);
  } catch (_e) {
    // coluna já existe
  }
}

async function garantirTabela(dbConn) {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS pix_cobrancas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      provedor TEXT NOT NULL,
      txid TEXT NOT NULL,
      valor REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDENTE',
      copia_cola TEXT,
      qr_code_base64 TEXT,
      raw_json TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      pago_em DATETIME
    )
  `, [], dbConn);

  await tentarAlter(`ALTER TABLE pix_cobrancas ADD COLUMN empresa_id INTEGER`, dbConn);
  await tentarAlter(`ALTER TABLE pix_cobrancas ADD COLUMN parcela_local_id INTEGER`, dbConn);
  await tentarAlter(`ALTER TABLE pix_cobrancas ADD COLUMN sessao_pagamento TEXT`, dbConn);
  await tentarAlter(`ALTER TABLE pix_cobrancas ADD COLUMN chave_parcela TEXT`, dbConn);
  await tentarAlter(`ALTER TABLE pix_cobrancas ADD COLUMN consumo_venda_id INTEGER`, dbConn);
  await tentarAlter(`ALTER TABLE pix_cobrancas ADD COLUMN confirmado_em DATETIME`, dbConn);
}

async function buscarConfigPix(dbConn) {
  const ativo = await dbGet("SELECT valor FROM configuracoes WHERE chave = 'pix_automatico_ativo'", [], dbConn);
  const provedor = await dbGet("SELECT valor FROM configuracoes WHERE chave = 'pix_provedor_ativo'", [], dbConn);
  const configs = await dbGet("SELECT valor FROM configuracoes WHERE chave = 'pix_configs_json'", [], dbConn);

  let json = {};
  try {
    json = configs && configs.valor ? JSON.parse(configs.valor) : {};
  } catch (e) {
    json = {};
  }

  return {
    ativo: ativo && ativo.valor === '1',
    provedor: (provedor && provedor.valor) || 'mercadopago',
    configs: json
  };
}

async function salvarConfigPix({ ativo, provedor, configs }, dbConn) {
  await dbRun(`
    INSERT INTO configuracoes (chave, valor, tipo, descricao)
    VALUES ('pix_automatico_ativo', ?, 'boolean', 'Ativar Pix automático')
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now', 'localtime')
  `, [ativo ? '1' : '0'], dbConn);

  await dbRun(`
    INSERT INTO configuracoes (chave, valor, tipo, descricao)
    VALUES ('pix_provedor_ativo', ?, 'text', 'Provedor Pix ativo')
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now', 'localtime')
  `, [provedor], dbConn);

  await dbRun(`
    INSERT INTO configuracoes (chave, valor, tipo, descricao)
    VALUES ('pix_configs_json', ?, 'json', 'Configurações dos provedores Pix')
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now', 'localtime')
  `, [JSON.stringify(configs || {})], dbConn);
}

async function criarCobranca({
  valor,
  descricao,
  vendaId,
  empresaId,
  parcelaLocalId,
  sessaoPagamento,
  chaveParcela
}, dbConn) {
  await garantirTabela(dbConn);

  const cfg = await buscarConfigPix(dbConn);

  if (!cfg.ativo) {
    throw new Error('Pix automático está desativado.');
  }

  const provedor = cfg.provedor;
  const provider = providers[provedor];

  if (!provider) {
    throw new Error(`Provedor Pix ainda não implementado: ${provedor}`);
  }

  const configProvedor = cfg.configs[provedor] || {};

  const cobranca = await provider.criarCobranca({
    valor,
    descricao,
    config: configProvedor
  });

  await dbRun(`
    INSERT INTO pix_cobrancas
    (venda_id, empresa_id, parcela_local_id, sessao_pagamento, chave_parcela,
     provedor, txid, valor, status, copia_cola, qr_code_base64, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    vendaId || null,
    empresaId != null ? Number(empresaId) : null,
    parcelaLocalId != null ? Number(parcelaLocalId) : null,
    sessaoPagamento || null,
    chaveParcela || null,
    provedor,
    cobranca.txid,
    valor,
    cobranca.status || 'PENDENTE',
    cobranca.copiaCola || null,
    cobranca.qrCodeBase64 || null,
    JSON.stringify(cobranca.raw || {})
  ], dbConn);

  return {
    ...cobranca,
    empresa_id: empresaId != null ? Number(empresaId) : null,
    parcela_local_id: parcelaLocalId != null ? Number(parcelaLocalId) : null,
    sessao_pagamento: sessaoPagamento || null,
    chave_parcela: chaveParcela || null,
    valor: Number(valor)
  };
}

async function obterCobrancaPorTxid(txid, dbConn) {
  await garantirTabela(dbConn);
  return dbGet(
    `SELECT * FROM pix_cobrancas WHERE txid = ? ORDER BY id DESC LIMIT 1`,
    [String(txid)],
    dbConn
  );
}

async function consultarStatus(txid, opcoes = {}) {
  const dbConn = opcoes.db || null;
  await garantirTabela(dbConn);

  const row = await obterCobrancaPorTxid(txid, dbConn);

  if (!row) {
    throw new Error('Cobrança Pix não encontrada.');
  }

  const cfg = await buscarConfigPix(dbConn);
  const provider = providers[row.provedor];

  if (!provider) {
    throw new Error(`Provedor Pix ainda não implementado: ${row.provedor}`);
  }

  const status = await provider.consultarStatus({
    txid,
    config: (cfg.configs && cfg.configs[row.provedor]) || {}
  });

  const statusNorm = String(status.status || '').toUpperCase();
  await dbRun(`
    UPDATE pix_cobrancas
    SET status = ?,
        pago_em = CASE
          WHEN ? = 'PAGO' AND (pago_em IS NULL OR pago_em = '') THEN datetime('now', 'localtime')
          ELSE pago_em
        END,
        confirmado_em = CASE
          WHEN ? = 'PAGO' AND (confirmado_em IS NULL OR confirmado_em = '') THEN datetime('now', 'localtime')
          ELSE confirmado_em
        END
    WHERE txid = ?
  `, [statusNorm, statusNorm, statusNorm, txid], dbConn);

  const atualizada = await obterCobrancaPorTxid(txid, dbConn);

  return {
    ...status,
    status: statusNorm,
    cobranca: atualizada,
    empresa_id: atualizada && atualizada.empresa_id,
    parcela_local_id: atualizada && atualizada.parcela_local_id,
    sessao_pagamento: atualizada && atualizada.sessao_pagamento,
    chave_parcela: atualizada && atualizada.chave_parcela,
    valor: atualizada && atualizada.valor
  };
}

async function marcarConsumoVenda(txid, vendaId, dbConn) {
  await garantirTabela(dbConn);
  await dbRun(`
    UPDATE pix_cobrancas
    SET consumo_venda_id = COALESCE(consumo_venda_id, ?),
        venda_id = COALESCE(venda_id, ?)
    WHERE txid = ?
      AND (consumo_venda_id IS NULL OR consumo_venda_id = ?)
  `, [Number(vendaId), Number(vendaId), String(txid), Number(vendaId)], dbConn);
}

async function vincularVenda(txid, vendaId, dbConn) {
  await garantirTabela(dbConn);
  await dbRun(`
    UPDATE pix_cobrancas
    SET venda_id = ?
    WHERE txid = ?
      AND (venda_id IS NULL OR venda_id = ?)
  `, [Number(vendaId), String(txid), Number(vendaId)], dbConn);
}

/**
 * Utilitário de teste: grava cobrança PAGO sem chamar provedor real.
 */
async function registrarCobrancaSimulada(dados = {}, dbConn) {
  await garantirTabela(dbConn);
  const txid = String(dados.txid || `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await dbRun(`
    INSERT INTO pix_cobrancas
    (venda_id, empresa_id, parcela_local_id, sessao_pagamento, chave_parcela,
     provedor, txid, valor, status, copia_cola, qr_code_base64, raw_json, pago_em, confirmado_em, consumo_venda_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    dados.vendaId || null,
    dados.empresaId != null ? Number(dados.empresaId) : null,
    dados.parcelaLocalId != null ? Number(dados.parcelaLocalId) : null,
    dados.sessaoPagamento || null,
    dados.chaveParcela || null,
    dados.provedor || 'simulador',
    txid,
    Number(dados.valor || 0),
    String(dados.status || 'PAGO').toUpperCase(),
    dados.copiaCola || 'PIX-SIM',
    null,
    JSON.stringify(dados.raw || { simulado: true }),
    dados.status === 'PAGO' || !dados.status ? new Date().toISOString() : null,
    dados.status === 'PAGO' || !dados.status ? new Date().toISOString() : null,
    dados.consumoVendaId || null
  ], dbConn);
  return obterCobrancaPorTxid(txid, dbConn);
}

module.exports = {
  providerCatalog,
  buscarConfigPix,
  salvarConfigPix,
  criarCobranca,
  consultarStatus,
  obterCobrancaPorTxid,
  marcarConsumoVenda,
  vincularVenda,
  registrarCobrancaSimulada,
  garantirTabela
};
