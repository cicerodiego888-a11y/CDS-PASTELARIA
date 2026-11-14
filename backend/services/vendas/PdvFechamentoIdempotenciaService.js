'use strict';

/**
 * CDS-PDV-IDEMPOTENCIA-RECUPERACAO-RESERVA-ORFA-01
 * Reserva de chave de fechamento PDV com recuperação segura de órfãos.
 * Não apaga por TTL isolado; reconcilia venda persistida pela chave inequívoca.
 */

const STATUS = Object.freeze({
  EM_ANDAMENTO: 'em_andamento',
  CONCLUIDO: 'concluido',
  RECUPERACAO_NECESSARIA: 'recuperacao_necessaria',
  FALHA_RECUPERAVEL: 'falha_recuperavel',
  FALHA_INCONSISTENTE: 'falha_inconsistente'
});

const ENV_ORFAO_SEGUNDOS = 'CDS_PDV_IDEMPOTENCIA_ORFAO_SEGUNDOS';
const ORFAO_SEGUNDOS_PADRAO = 20;

function segundosOrfao(env = process.env) {
  const n = Number(env[ENV_ORFAO_SEGUNDOS]);
  if (Number.isFinite(n) && n >= 5 && n <= 3600) return Math.floor(n);
  return ORFAO_SEGUNDOS_PADRAO;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function garantirSchemaIdempotenciaPdv(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS pdv_fechamento_idempotencia (
    chave TEXT PRIMARY KEY,
    venda_id INTEGER NOT NULL,
    status_pagamento TEXT,
    criado_em TEXT
  )`);
  // Necessidade demonstrada: sem coluna na venda, crash pós-INSERT não tem vínculo inequívoco.
  try {
    await run(db, `ALTER TABLE vendas ADD COLUMN chave_fechamento_pdv TEXT`);
  } catch (_err) {
    /* coluna já existe */
  }
  await run(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vendas_chave_fechamento_pdv
    ON vendas(chave_fechamento_pdv)
    WHERE chave_fechamento_pdv IS NOT NULL AND TRIM(chave_fechamento_pdv) != ''
  `);
}

async function buscarVendaPorChaveFechamento(db, chave) {
  return get(db, `
    SELECT id, status_pagamento, cancelada, total, valor_fiscal, valor_nao_fiscal, empresa_id
    FROM vendas
    WHERE chave_fechamento_pdv = ?
    ORDER BY id DESC
    LIMIT 1
  `, [chave]);
}

async function avaliarIntegridadeVendaFechamento(db, vendaId) {
  const id = Number(vendaId);
  if (!(id > 0)) {
    return { ok: false, estado: STATUS.FALHA_INCONSISTENTE, motivo: 'venda_id_invalido' };
  }
  const venda = await get(db, `
    SELECT id, status_pagamento, cancelada, total, valor_fiscal, valor_nao_fiscal
    FROM vendas WHERE id = ?
  `, [id]);
  if (!venda) {
    return { ok: false, estado: STATUS.FALHA_INCONSISTENTE, motivo: 'venda_ausente' };
  }
  if (Number(venda.cancelada) === 1) {
    return { ok: false, estado: STATUS.FALHA_INCONSISTENTE, motivo: 'venda_cancelada', venda };
  }
  const itens = await get(db, `SELECT COUNT(*) AS n FROM vendas_itens WHERE venda_id = ?`, [id]);
  if (!(Number(itens && itens.n) > 0)) {
    return { ok: false, estado: STATUS.FALHA_INCONSISTENTE, motivo: 'itens_ausentes', venda };
  }
  // Fechamento não é íntegro só com cabeçalho: exige itens e evidência de distribuição/recebimento.
  let recebimentosN = 0;
  let pagamentosN = 0;
  try {
    const receb = await get(db, `SELECT COUNT(*) AS n FROM venda_recebimentos WHERE venda_id = ?`, [id]);
    recebimentosN = Number(receb && receb.n) || 0;
  } catch (_err) {
    recebimentosN = 0;
  }
  try {
    const pags = await get(db, `SELECT COUNT(*) AS n FROM venda_pagamentos WHERE venda_id = ?`, [id]);
    pagamentosN = Number(pags && pags.n) || 0;
  } catch (_err) {
    pagamentosN = 0;
  }
  if (recebimentosN + pagamentosN < 1) {
    return {
      ok: false,
      estado: STATUS.FALHA_INCONSISTENTE,
      motivo: 'distribuicao_ou_recebimentos_ausentes',
      venda
    };
  }
  return {
    ok: true,
    estado: STATUS.CONCLUIDO,
    venda,
    itens: Number(itens.n),
    recebimentos: recebimentosN,
    pagamentos: pagamentosN
  };
}

async function vincularReservaAVenda(db, chave, vendaId, statusPagamento) {
  const resultado = await run(db, `
    UPDATE pdv_fechamento_idempotencia
    SET venda_id = ?, status_pagamento = ?
    WHERE chave = ? AND (venda_id = 0 OR venda_id = ?)
  `, [Number(vendaId), statusPagamento || STATUS.CONCLUIDO, chave, Number(vendaId)]);
  return Number(resultado.changes) >= 1;
}

/**
 * Reivindica órfã atomicamente: só se ainda venda_id=0 e idade >= limiar.
 * Não DELETE — apenas renova a posse da reserva.
 */
async function reivindicarReservaOrfa(db, chave, env = process.env) {
  const segundos = segundosOrfao(env);
  const resultado = await run(db, `
    UPDATE pdv_fechamento_idempotencia
    SET criado_em = datetime('now', 'localtime'),
        status_pagamento = ?
    WHERE chave = ?
      AND venda_id = 0
      AND datetime(criado_em) <= datetime('now', 'localtime', ?)
  `, [STATUS.EM_ANDAMENTO, chave, `-${segundos} seconds`]);
  return Number(resultado.changes) === 1;
}

async function reconciliarReservaOrfa(db, chave, env = process.env) {
  const reserva = await get(db, `
    SELECT chave, venda_id, status_pagamento, criado_em
    FROM pdv_fechamento_idempotencia WHERE chave = ?
  `, [chave]);
  if (!reserva) {
    return { estado: STATUS.FALHA_RECUPERAVEL, acao: 'reclamar_nova' };
  }
  const vendaIdReserva = Number(reserva.venda_id) || 0;
  if (vendaIdReserva > 0) {
    const integridade = await avaliarIntegridadeVendaFechamento(db, vendaIdReserva);
    if (integridade.ok) {
      return {
        estado: STATUS.CONCLUIDO,
        acao: 'retornar_venda',
        vendaId: vendaIdReserva,
        status_pagamento: reserva.status_pagamento || integridade.venda.status_pagamento
      };
    }
    return {
      estado: STATUS.FALHA_INCONSISTENTE,
      acao: 'bloquear',
      code: 'FECHAMENTO_INCONSISTENTE',
      motivo: integridade.motivo,
      vendaId: vendaIdReserva
    };
  }

  // venda_id=0: procurar venda pela chave inequívoca (crash após INSERT, antes do UPDATE).
  const vendaPorChave = await buscarVendaPorChaveFechamento(db, chave);
  if (vendaPorChave && Number(vendaPorChave.id) > 0) {
    const integridade = await avaliarIntegridadeVendaFechamento(db, vendaPorChave.id);
    if (!integridade.ok) {
      return {
        estado: STATUS.FALHA_INCONSISTENTE,
        acao: 'bloquear',
        code: 'FECHAMENTO_INCONSISTENTE',
        motivo: integridade.motivo || 'venda_parcial',
        vendaId: Number(vendaPorChave.id)
      };
    }
    const vinculou = await vincularReservaAVenda(
      db,
      chave,
      vendaPorChave.id,
      vendaPorChave.status_pagamento || STATUS.CONCLUIDO
    );
    if (!vinculou) {
      // Outra requisição pode ter vinculado no mesmo instante.
      const deNovo = await get(db, `
        SELECT venda_id, status_pagamento FROM pdv_fechamento_idempotencia WHERE chave = ?
      `, [chave]);
      if (deNovo && Number(deNovo.venda_id) > 0) {
        return {
          estado: STATUS.CONCLUIDO,
          acao: 'retornar_venda',
          vendaId: Number(deNovo.venda_id),
          status_pagamento: deNovo.status_pagamento
        };
      }
      return {
        estado: STATUS.FALHA_INCONSISTENTE,
        acao: 'bloquear',
        code: 'FECHAMENTO_INCONSISTENTE',
        motivo: 'vinculo_idempotencia_falhou'
      };
    }
    return {
      estado: STATUS.CONCLUIDO,
      acao: 'retornar_venda',
      vendaId: Number(vendaPorChave.id),
      status_pagamento: vendaPorChave.status_pagamento || STATUS.CONCLUIDO,
      recuperado: true
    };
  }

  // Sem venda: tentar reivindicar se órfã por idade (processo provavelmente morto).
  const reivindicou = await reivindicarReservaOrfa(db, chave, env);
  if (reivindicou) {
    return {
      estado: STATUS.RECUPERACAO_NECESSARIA,
      acao: 'criar_venda',
      recuperado: true
    };
  }
  return {
    estado: STATUS.EM_ANDAMENTO,
    acao: 'aguardar',
    code: 'FECHAMENTO_EM_ANDAMENTO'
  };
}

async function marcarReservaConcluidaNaTransacao(dbConn, chave, vendaId, statusPagamento) {
  if (!chave || !(Number(vendaId) > 0)) return false;
  const resultado = await run(dbConn, `
    UPDATE pdv_fechamento_idempotencia
    SET venda_id = ?, status_pagamento = ?
    WHERE chave = ? AND venda_id = 0
  `, [Number(vendaId), statusPagamento || STATUS.CONCLUIDO, chave]);
  return Number(resultado.changes) === 1;
}

module.exports = {
  STATUS,
  ENV_ORFAO_SEGUNDOS,
  ORFAO_SEGUNDOS_PADRAO,
  segundosOrfao,
  garantirSchemaIdempotenciaPdv,
  buscarVendaPorChaveFechamento,
  avaliarIntegridadeVendaFechamento,
  vincularReservaAVenda,
  reivindicarReservaOrfa,
  reconciliarReservaOrfa,
  marcarReservaConcluidaNaTransacao
};
