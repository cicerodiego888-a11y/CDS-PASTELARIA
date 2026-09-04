const db = require('../database');
const { resolverEmpresaId } = require('./fiscalNaoFiscal/empresaContexto');
const { garantirSchemaLotesEmpresa } = require('./estoque/lotesEmpresaSchema');

/**
 * Service para controle de lotes e validade (FEFO - First Expire, First Out)
 * Sprint 05.47 — FEFO operacional é empresarial (empresa_id + produto_id).
 */

const CODIGO_EMPRESA_CONTEXT_REQUIRED = 'EMPRESA_CONTEXT_REQUIRED';
const CODIGO_EMPRESA_OWNERSHIP_REQUIRED = 'EMPRESA_OWNERSHIP_REQUIRED';
const CODIGO_LOTE_NAO_ENCONTRADO = 'LOTE_NAO_ENCONTRADO';

function getDb(opcoes) {
  if (opcoes && opcoes.db) return opcoes.db;
  return db;
}

function erroLote(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function empresaIdDe(fonte) {
  return resolverEmpresaId(fonte);
}

function exigirEmpresaContexto(fonte) {
  const id = empresaIdDe(fonte);
  if (id == null) {
    throw erroLote(
      CODIGO_EMPRESA_CONTEXT_REQUIRED,
      'empresaId é obrigatório para operação empresarial de lote.'
    );
  }
  return id;
}

function sqlLotesFefoEmpresa() {
  return `
    SELECT
      pl.*,
      p.nome as produto_nome,
      CAST(julianday(date(pl.data_validade)) - julianday(date('now', 'localtime')) AS INTEGER) AS dias_para_vencer,
      CASE
        WHEN date(pl.data_validade) < date('now', 'localtime') THEN 'vencido'
        WHEN date(pl.data_validade) <= date('now', 'localtime', '+30 days') THEN 'proximo'
        ELSE 'ok'
      END AS status_validade
    FROM produtos_lotes pl
    INNER JOIN produtos p ON p.id = pl.produto_id
    WHERE pl.empresa_id = ?
      AND pl.produto_id = ?
      AND pl.ativo = 1
      AND pl.quantidade_atual > 0
    ORDER BY pl.data_validade ASC, pl.id ASC
  `;
}

function withSchema(conn, callback, work) {
  garantirSchemaLotesEmpresa(conn, (schemaErr) => {
    if (schemaErr) return callback(schemaErr);
    work();
  });
}

// Gerar próximo número de lote automaticamente (sequência nominal global — classe C)
function gerarProximoLote(callback, opcoes = {}) {
  const conn = getDb(opcoes);
  const sql = `
    SELECT lote
    FROM produtos_lotes
    WHERE lote LIKE 'LT%'
    ORDER BY CAST(SUBSTR(lote, 3) AS INTEGER) DESC
    LIMIT 1
  `;

  conn.get(sql, [], (err, row) => {
    if (err) return callback(err);

    let proximoNumero = 1;
    if (row && row.lote) {
      const numeroAtual = parseInt(row.lote.replace('LT', ''), 10);
      proximoNumero = numeroAtual + 1;
    }

    const loteGerado = 'LT' + String(proximoNumero).padStart(6, '0');
    callback(null, loteGerado);
  });
}

// Criar um novo lote para um produto
function criarLote(dados, callback) {
  const { lote } = dados || {};

  if (!lote) {
    return gerarProximoLote((err, loteGerado) => {
      if (err) return callback(err);
      criarLoteComLoteGerado({ ...dados, lote: loteGerado }, callback);
    }, dados);
  }

  criarLoteComLoteGerado(dados, callback);
}

function criarLoteComLoteGerado(dados, callback) {
  const {
    produto_id,
    lote,
    quantidade_inicial,
    data_fabricacao,
    data_validade,
    data_entrada,
    origem = 'COMPRA',
    compra_id = null
  } = dados;

  if (!produto_id || !lote || !quantidade_inicial || !data_validade || !data_entrada) {
    return callback(new Error('Campos obrigatórios: produto_id, lote, quantidade_inicial, data_validade, data_entrada'));
  }

  let empresaId;
  try {
    empresaId = exigirEmpresaContexto(dados);
  } catch (err) {
    return callback(err);
  }

  const conn = getDb(dados);
  withSchema(conn, callback, () => {
    const sql = `
      INSERT INTO produtos_lotes (
        produto_id, lote, quantidade_inicial, quantidade_atual,
        data_fabricacao, data_validade, data_entrada, origem, compra_id, empresa_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    conn.run(sql, [
      produto_id,
      lote,
      quantidade_inicial,
      quantidade_inicial,
      data_fabricacao || null,
      data_validade,
      data_entrada,
      origem,
      compra_id,
      empresaId
    ], function (err) {
      if (err) return callback(err);
      callback(null, { id: this.lastID, ...dados, empresa_id: empresaId });
    });
  });
}

// Buscar lotes ativos de um produto, ordenados por validade (FEFO empresarial)
function buscarLotesProduto(produtoId, callback, opcoes = {}) {
  let empresaId;
  try {
    empresaId = exigirEmpresaContexto(opcoes);
  } catch (err) {
    return callback(err);
  }

  const conn = getDb(opcoes);
  withSchema(conn, callback, () => {
    conn.all(sqlLotesFefoEmpresa(), [empresaId, produtoId], (err, rows) => {
      if (err) return callback(err);
      callback(null, rows || []);
    });
  });
}

/**
 * Contrato operacional principal de FEFO.
 * selecionarLoteFefo({ empresaId, produtoId, quantidade, db })
 * Sem empresa → EMPRESA_CONTEXT_REQUIRED. Sem fallback COMPAT/usuário/global.
 */
function selecionarLoteFefo(params = {}, callback) {
  const executar = (cb) => {
    let empresaId;
    try {
      empresaId = exigirEmpresaContexto(params);
    } catch (err) {
      return cb(err);
    }

    const produtoId = Number(params.produtoId != null ? params.produtoId : params.produto_id);
    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      return cb(erroLote('PRODUTO_INVALIDO', 'produtoId inválido para FEFO.'));
    }

    const conn = getDb(params);
    withSchema(conn, cb, () => {
      conn.all(sqlLotesFefoEmpresa(), [empresaId, produtoId], (err, rows) => {
        if (err) return cb(err);
        cb(null, rows || []);
      });
    });
  };

  if (typeof callback === 'function') {
    return executar(callback);
  }
  return new Promise((resolve, reject) => {
    executar((err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function obterLoteDaEmpresa(loteId, empresaId, callback, opcoes = {}) {
  const executar = (cb) => {
    const id = Number(loteId);
    let emp;
    try {
      emp = exigirEmpresaContexto({ empresaId });
    } catch (err) {
      return cb(err);
    }
    if (!Number.isInteger(id) || id <= 0) {
      return cb(erroLote(CODIGO_LOTE_NAO_ENCONTRADO, 'Lote não encontrado.'));
    }

    const conn = getDb(opcoes);
    withSchema(conn, cb, () => {
      conn.get(
        `SELECT * FROM produtos_lotes WHERE id = ? AND empresa_id = ?`,
        [id, emp],
        (err, row) => {
          if (err) return cb(err);
          if (!row) {
            return cb(erroLote(CODIGO_LOTE_NAO_ENCONTRADO, 'Lote não encontrado.'));
          }
          cb(null, row);
        }
      );
    });
  };

  if (typeof callback === 'function') {
    return executar(callback);
  }
  return new Promise((resolve, reject) => {
    executar((err, row) => (err ? reject(err) : resolve(row)));
  });
}

// Consumir lotes usando FEFO (First Expire, First Out)
function consumirLotesFEFO(produtoId, quantidade, callback, opcoes = {}) {
  let empresaId;
  try {
    empresaId = exigirEmpresaContexto(opcoes);
  } catch (err) {
    return callback(err);
  }

  const conn = getDb(opcoes);

  selecionarLoteFefo({ empresaId, produtoId, quantidade, db: conn }, (err, lotes) => {
    if (err) return callback(err);

    if (!lotes || lotes.length === 0) {
      return callback(new Error('Não há lotes disponíveis para este produto'));
    }

    const totalDisponivel = lotes.reduce((sum, l) => sum + Number(l.quantidade_atual || 0), 0);

    if (totalDisponivel < quantidade) {
      return callback(new Error(`Estoque insuficiente. Disponível: ${totalDisponivel}, Solicitado: ${quantidade}`));
    }

    const consumo = [];
    let quantidadeRestante = quantidade;
    let indice = 0;

    function consumirProximo() {
      if (quantidadeRestante <= 0 || indice >= lotes.length) {
        return callback(null, consumo);
      }

      const lote = lotes[indice];
      const quantidadeConsumir = Math.min(quantidadeRestante, lote.quantidade_atual);

      conn.run(`
        UPDATE produtos_lotes
        SET quantidade_atual = quantidade_atual - ?,
            atualizado_em = CURRENT_TIMESTAMP
        WHERE id = ?
          AND empresa_id = ?
      `, [quantidadeConsumir, lote.id, empresaId], function (updErr) {
        if (updErr) return callback(updErr);
        if (!this.changes) {
          return callback(erroLote(
            CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
            'Lote sem ownership empresarial identificável.'
          ));
        }

        consumo.push({
          produto_lote_id: lote.id,
          lote: lote.lote,
          quantidade: quantidadeConsumir,
          data_validade: lote.data_validade,
          empresa_id: empresaId
        });

        quantidadeRestante -= quantidadeConsumir;
        indice++;
        consumirProximo();
      });
    }

    consumirProximo();
  });
}

// Registrar quais lotes foram consumidos em uma venda
function registrarConsumoVenda(vendaItemId, consumoLotes, callback, opcoes = {}) {
  if (!consumoLotes || consumoLotes.length === 0) {
    return callback(null);
  }

  const conn = getDb(opcoes);
  let indice = 0;

  function inserirProximo() {
    if (indice >= consumoLotes.length) {
      return callback(null);
    }

    const consumo = consumoLotes[indice];
    indice++;

    conn.run(`
      INSERT INTO venda_lotes (venda_item_id, produto_lote_id, quantidade)
      VALUES (?, ?, ?)
    `, [vendaItemId, consumo.produto_lote_id, consumo.quantidade], (err) => {
      if (err) return callback(err);
      inserirProximo();
    });
  }

  inserirProximo();
}

// Restaurar lotes ao cancelar uma venda — somente na empresa proprietária do lote
function restaurarLotesVenda(vendaItemId, callback, opcoes = {}) {
  let empresaId;
  try {
    empresaId = exigirEmpresaContexto(opcoes);
  } catch (err) {
    return callback(err);
  }

  const conn = getDb(opcoes);
  withSchema(conn, callback, () => {
    conn.all(`
      SELECT vl.produto_lote_id, vl.quantidade, pl.empresa_id
      FROM venda_lotes vl
      INNER JOIN produtos_lotes pl ON pl.id = vl.produto_lote_id
      WHERE vl.venda_item_id = ?
    `, [vendaItemId], (err, lotesConsumidos) => {
      if (err) return callback(err);

      if (!lotesConsumidos || lotesConsumidos.length === 0) {
        return callback(null);
      }

      let indice = 0;

      function restaurarProximo() {
        if (indice >= lotesConsumidos.length) {
          conn.run(`
            DELETE FROM venda_lotes WHERE venda_item_id = ?
          `, [vendaItemId], (deleteErr) => {
            if (deleteErr) return callback(deleteErr);
            callback(null);
          });
          return;
        }

        const consumo = lotesConsumidos[indice];
        indice++;

        if (consumo.empresa_id == null) {
          return callback(erroLote(
            CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
            'Lote sem ownership empresarial identificável.'
          ));
        }
        if (Number(consumo.empresa_id) !== Number(empresaId)) {
          return callback(erroLote(
            CODIGO_LOTE_NAO_ENCONTRADO,
            'Lote não encontrado.'
          ));
        }

        conn.run(`
          UPDATE produtos_lotes
          SET quantidade_atual = quantidade_atual + ?,
              atualizado_em = CURRENT_TIMESTAMP
          WHERE id = ?
            AND empresa_id = ?
        `, [consumo.quantidade, consumo.produto_lote_id, empresaId], function (updErr) {
          if (updErr) return callback(updErr);
          if (!this.changes) {
            return callback(erroLote(CODIGO_LOTE_NAO_ENCONTRADO, 'Lote não encontrado.'));
          }
          restaurarProximo();
        });
      }

      restaurarProximo();
    });
  });
}

// Buscar lotes vencidos ou próximos do vencimento
function buscarLotesVencendo(diasAviso = 30, callback, opcoes = {}) {
  const conn = getDb(opcoes);
  const empresaId = empresaIdDe(opcoes);
  const filtroEmpresa = empresaId != null
    ? 'AND pl.empresa_id = ?'
    : '';
  const params = empresaId != null
    ? [diasAviso, diasAviso, empresaId]
    : [diasAviso, diasAviso];

  const sql = `
    SELECT
      pl.*,
      p.nome as produto_nome,
      p.codigo as produto_codigo,
      CAST(julianday(date(pl.data_validade)) - julianday(date('now', 'localtime')) AS INTEGER) AS dias_para_vencer,
      CASE
        WHEN date(pl.data_validade) < date('now', 'localtime') THEN 'vencido'
        WHEN date(pl.data_validade) <= date('now', 'localtime', '+' || ? || ' days') THEN 'proximo'
        ELSE 'ok'
      END AS status_validade
    FROM produtos_lotes pl
    INNER JOIN produtos p ON p.id = pl.produto_id
    WHERE pl.ativo = 1
      AND pl.quantidade_atual > 0
      AND date(pl.data_validade) <= date('now', 'localtime', '+' || ? || ' days')
      ${filtroEmpresa}
    ORDER BY pl.data_validade ASC, pl.id ASC
  `;

  conn.all(sql, params, (err, rows) => {
    if (err) return callback(err);

    const vencidos = (rows || []).filter(r => r.status_validade === 'vencido');
    const proximos = (rows || []).filter(r => r.status_validade === 'proximo');

    callback(null, {
      total: (rows || []).length,
      vencidos: vencidos.length,
      proximos: proximos.length,
      lotes: rows || []
    });
  });
}

// Obter estatísticas de vencimentos para o dashboard
function obterEstatisticasVencimentos(callback, opcoes = {}) {
  buscarLotesVencendo(30, (err, dados30) => {
    if (err) return callback(err);

    buscarLotesVencendo(7, (err2, dados7) => {
      if (err2) return callback(err2);

      buscarLotesVencendo(0, (err3, dadosVencidos) => {
        if (err3) return callback(err3);

        const conn = getDb(opcoes);
        const empresaId = empresaIdDe(opcoes);
        const filtroEmpresa = empresaId != null ? 'AND pl.empresa_id = ?' : '';
        const paramsValor = empresaId != null ? [empresaId] : [];

        const sqlValor = `
          SELECT
            SUM(pl.quantidade_atual * p.preco_venda) as valor_total
          FROM produtos_lotes pl
          INNER JOIN produtos p ON p.id = pl.produto_id
          WHERE pl.ativo = 1
            AND pl.quantidade_atual > 0
            AND date(pl.data_validade) < date('now', 'localtime')
            ${filtroEmpresa}
        `;

        conn.get(sqlValor, paramsValor, (err4, valorRow) => {
          if (err4) return callback(err4);

          callback(null, {
            vencendo_30_dias: dados30.total,
            vencendo_7_dias: dados7.total,
            vencidos: dadosVencidos.vencidos,
            valor_vencidos: valorRow?.valor_total || 0
          });
        });
      }, opcoes);
    }, opcoes);
  }, opcoes);
}

// Verificar se produto controla validade
function produtoControlaValidade(produtoId, callback, opcoes = {}) {
  const conn = getDb(opcoes);
  conn.get(`
    SELECT controlar_validade FROM produtos WHERE id = ?
  `, [produtoId], (err, row) => {
    if (err) return callback(err);
    if (!row) return callback(new Error('Produto não encontrado'));
    callback(null, row.controlar_validade === 1);
  });
}

// Atualizar estoque consolidado do produto baseado nos lotes
function atualizarEstoqueConsolidado(produtoId, callback) {
  db.get(`
    SELECT
      COALESCE((
        SELECT SUM(quantidade_atual)
        FROM produtos_lotes
        WHERE produto_id = ? AND ativo = 1
      ), 0) AS somaLotes,
      COALESCE(saldo_fiscal, 0) AS saldo_fiscal,
      COALESCE(saldo_nao_fiscal, 0) AS saldo_nao_fiscal
    FROM produtos
    WHERE id = ?
  `, [produtoId, produtoId], (err, row) => {
    if (err) return callback(err);
    if (!row) return callback(new Error('Produto não encontrado'));

    const somaLotes = Number(row.somaLotes || 0);
    const totalSaldos =
      Number(row.saldo_fiscal || 0) +
      Number(row.saldo_nao_fiscal || 0);

    if (Math.abs(somaLotes - totalSaldos) > 0.001) {
      console.warn('Divergência estoque fiscal.');
    }

    db.run(`
      UPDATE produtos
      SET estoque_atual = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [somaLotes, produtoId], callback);
  });
}

// Obter configurações de validade
function obterConfiguracoesValidade(callback, opcoes = {}) {
  const conn = getDb(opcoes);
  conn.get(`
    SELECT * FROM configuracoes_validade LIMIT 1
  `, [], (err, row) => {
    if (err) return callback(err);
    callback(null, row || {
      dias_aviso_vencimento: 30,
      bloquear_venda_vencido: 0,
      alertar_venda_proximo_vencimento: 1
    });
  });
}

// Atualizar configurações de validade
function atualizarConfiguracoesValidade(dados, callback, opcoes = {}) {
  const conn = getDb(opcoes);
  const { dias_aviso_vencimento, bloquear_venda_vencido, alertar_venda_proximo_vencimento } = dados;

  conn.run(`
    UPDATE configuracoes_validade
    SET dias_aviso_vencimento = ?,
        bloquear_venda_vencido = ?,
        alertar_venda_proximo_vencimento = ?,
        atualizado_em = CURRENT_TIMESTAMP
    WHERE id = 1
  `, [dias_aviso_vencimento, bloquear_venda_vencido, alertar_venda_proximo_vencimento], callback);
}

module.exports = {
  gerarProximoLote,
  criarLote,
  buscarLotesProduto,
  selecionarLoteFefo,
  obterLoteDaEmpresa,
  consumirLotesFEFO,
  registrarConsumoVenda,
  restaurarLotesVenda,
  buscarLotesVencendo,
  obterEstatisticasVencimentos,
  produtoControlaValidade,
  atualizarEstoqueConsolidado,
  obterConfiguracoesValidade,
  atualizarConfiguracoesValidade,
  garantirSchemaLotesEmpresa,
  CODIGO_EMPRESA_CONTEXT_REQUIRED,
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
  CODIGO_LOTE_NAO_ENCONTRADO
};
