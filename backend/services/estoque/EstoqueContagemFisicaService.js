/**
 * Contagem física absoluta F×NF — CDS-ESTOQUE-MANUAL-01.
 * Operador informa saldos físicos fiscal e não fiscal separadamente.
 * Deltas são aplicados via porta pública / ajuste existente.
 *
 * @module services/estoque/EstoqueContagemFisicaService
 */
'use strict';

const { roundStockQuantity } = require('./quantityPrecision');
const estoqueSaldosPublico = require('../fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');
const {
  garantirSchemaEstoqueContagemFisicaAsync
} = require('./estoqueContagemFisicaSchema');
const { registrarAjusteEstoque } = require('../ajusteEstoqueService');

const MOTIVO_CONTAGEM = 'CONTAGEM_FISICA';

function erroContagem(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
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

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function quantidadeNaoNegativa(valor, campo) {
  if (valor === undefined || valor === null || valor === '') {
    throw erroContagem('QUANTIDADE_CONTAGEM_OBRIGATORIA', `${campo} é obrigatória.`);
  }
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) {
    throw erroContagem(
      'QUANTIDADE_CONTAGEM_INVALIDA',
      `${campo} deve ser um número maior ou igual a zero.`
    );
  }
  return roundStockQuantity(n);
}

function aplicarAsync(db, produtoId, ajusteF, ajusteNF, opts) {
  return (async () => {
    if (ajusteF > 0) {
      await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.FISCAL, ajusteF, opts);
    } else if (ajusteF < 0) {
      await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.FISCAL, Math.abs(ajusteF), opts);
    }
    if (ajusteNF > 0) {
      await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, ajusteNF, opts);
    } else if (ajusteNF < 0) {
      await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.NAO_FISCAL, Math.abs(ajusteNF), opts);
    }
    return estoqueSaldosPublico.consultarSaldo(produtoId, opts);
  })();
}

function registrarAjusteAsync(db, dados) {
  return new Promise((resolve, reject) => {
    registrarAjusteEstoque(db, dados, function onReg(err) {
      if (err) return reject(err);
      resolve(Number(this.lastID) || null);
    });
  });
}

/**
 * @param {object} params
 * @param {object} params.db
 * @param {number} params.empresaId
 * @param {Array<{produto_id:number, quantidade_fiscal_contada:number, quantidade_nao_fiscal_contada:number}>} params.itens
 * @param {number} [params.usuarioId]
 * @param {string} [params.usuarioNome]
 * @param {string} [params.observacao] — opcional; não obrigatório
 * @param {string} [params.chaveIdempotencia]
 */
async function registrarContagemFisica(params = {}) {
  const db = params.db;
  if (!db) throw erroContagem('DB_OBRIGATORIO', 'db é obrigatório.', 500);

  const empresaId = resolverEmpresaId(params.empresaId != null ? params.empresaId : params.empresa_id);
  if (empresaId == null) {
    throw erroContagem('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório para contagem física.');
  }

  const empresa = await dbGet(db, 'SELECT id FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) {
    throw erroContagem('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada.', 404, { empresa_id: empresaId });
  }

  await garantirSchemaEstoqueContagemFisicaAsync(db);

  const chaveRaw = params.chaveIdempotencia != null
    ? params.chaveIdempotencia
    : params.chave_idempotencia;
  const chaveIdempotencia = chaveRaw != null && String(chaveRaw).trim() !== ''
    ? String(chaveRaw).trim().slice(0, 120)
    : null;

  if (chaveIdempotencia) {
    const existente = await dbGet(
      db,
      `SELECT id FROM estoque_contagens_fisicas
        WHERE empresa_id = ? AND chave_idempotencia = ?`,
      [empresaId, chaveIdempotencia]
    );
    if (existente) {
      return obterContagemPorId(db, existente.id, empresaId);
    }
  }

  const itensBrutos = Array.isArray(params.itens) ? params.itens : [];
  if (itensBrutos.length === 0) {
    throw erroContagem('ITENS_CONTAGEM_OBRIGATORIOS', 'Informe ao menos um produto na contagem.');
  }

  const vistos = new Set();
  const itensNorm = [];
  for (const item of itensBrutos) {
    const produtoId = Number(item.produto_id != null ? item.produto_id : item.produtoId);
    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      throw erroContagem('PRODUTO_INVALIDO', 'produto_id inválido na contagem.');
    }
    if (vistos.has(produtoId)) {
      throw erroContagem(
        'PRODUTO_DUPLICADO_CONTAGEM',
        `O produto ${produtoId} aparece mais de uma vez na mesma contagem.`
      );
    }
    vistos.add(produtoId);
    const produto = await dbGet(db, 'SELECT id, nome FROM produtos WHERE id = ?', [produtoId]);
    if (!produto) {
      throw erroContagem('PRODUTO_NAO_ENCONTRADO', `Produto ${produtoId} não encontrado.`, 404);
    }
    itensNorm.push({
      produto_id: produtoId,
      produto_nome: produto.nome || null,
      quantidade_fiscal_contada: quantidadeNaoNegativa(
        item.quantidade_fiscal_contada != null
          ? item.quantidade_fiscal_contada
          : item.quantidadeFiscalContada,
        'quantidade_fiscal_contada'
      ),
      quantidade_nao_fiscal_contada: quantidadeNaoNegativa(
        item.quantidade_nao_fiscal_contada != null
          ? item.quantidade_nao_fiscal_contada
          : item.quantidadeNaoFiscalContada,
        'quantidade_nao_fiscal_contada'
      )
    });
  }

  const observacao = params.observacao != null && String(params.observacao).trim() !== ''
    ? String(params.observacao).trim().slice(0, 500)
    : null;
  const usuarioId = params.usuarioId != null ? Number(params.usuarioId) : null;
  const usuarioNome = params.usuarioNome != null
    ? String(params.usuarioNome).slice(0, 120)
    : null;

  const optsPorta = {
    db,
    empresaId,
    usuarioId,
    legado: false,
    motivoCompat: null
  };

  await estoqueSaldosPublico.executarEmTransacao(async () => {
    const cab = await dbRun(
      db,
      `INSERT INTO estoque_contagens_fisicas
        (empresa_id, usuario_id, usuario_nome, observacao, chave_idempotencia)
       VALUES (?, ?, ?, ?, ?)`,
      [empresaId, usuarioId, usuarioNome, observacao, chaveIdempotencia]
    );
    const contagemId = Number(cab.lastID);

    for (const item of itensNorm) {
      const antes = await estoqueSaldosPublico.consultarSaldo(item.produto_id, optsPorta);
      const saldoFiscalAnterior = roundStockQuantity(Number(antes.saldo_fiscal || 0));
      const saldoNaoFiscalAnterior = roundStockQuantity(Number(antes.saldo_nao_fiscal || 0));
      const diferencaFiscal = roundStockQuantity(
        item.quantidade_fiscal_contada - saldoFiscalAnterior
      );
      const diferencaNaoFiscal = roundStockQuantity(
        item.quantidade_nao_fiscal_contada - saldoNaoFiscalAnterior
      );

      let ajusteId = null;
      if (Math.abs(diferencaFiscal) > 1e-9 || Math.abs(diferencaNaoFiscal) > 1e-9) {
        const depois = await aplicarAsync(
          db,
          item.produto_id,
          diferencaFiscal,
          diferencaNaoFiscal,
          optsPorta
        );
        const estoqueTotalAntes = roundStockQuantity(saldoFiscalAnterior + saldoNaoFiscalAnterior);
        const estoqueTotalDepois = roundStockQuantity(
          Number(depois.estoque_atual != null
            ? depois.estoque_atual
            : (Number(depois.saldo_fiscal || 0) + Number(depois.saldo_nao_fiscal || 0)))
        );
        ajusteId = await registrarAjusteAsync(db, {
          produto_id: item.produto_id,
          usuario_id: usuarioId,
          usuario_nome: usuarioNome,
          motivo: observacao || MOTIVO_CONTAGEM,
          ajuste_fiscal: diferencaFiscal,
          ajuste_nao_fiscal: diferencaNaoFiscal,
          saldo_fiscal_antes: saldoFiscalAnterior,
          saldo_fiscal_depois: Number(depois.saldo_fiscal),
          saldo_nao_fiscal_antes: saldoNaoFiscalAnterior,
          saldo_nao_fiscal_depois: Number(depois.saldo_nao_fiscal),
          estoque_total_antes: estoqueTotalAntes,
          estoque_total_depois: estoqueTotalDepois
        });
      }

      await dbRun(
        db,
        `INSERT INTO estoque_contagens_fisicas_itens (
          contagem_id, empresa_id, produto_id,
          saldo_fiscal_anterior, saldo_nao_fiscal_anterior,
          quantidade_fiscal_contada, quantidade_nao_fiscal_contada,
          diferenca_fiscal, diferenca_nao_fiscal, ajuste_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contagemId,
          empresaId,
          item.produto_id,
          saldoFiscalAnterior,
          saldoNaoFiscalAnterior,
          item.quantidade_fiscal_contada,
          item.quantidade_nao_fiscal_contada,
          diferencaFiscal,
          diferencaNaoFiscal,
          ajusteId
        ]
      );
    }

    return contagemId;
  }, { db });

  const cabFinal = chaveIdempotencia
    ? await dbGet(
      db,
      `SELECT id FROM estoque_contagens_fisicas
        WHERE empresa_id = ? AND chave_idempotencia = ?`,
      [empresaId, chaveIdempotencia]
    )
    : await dbGet(
      db,
      `SELECT id FROM estoque_contagens_fisicas
        WHERE empresa_id = ?
        ORDER BY id DESC LIMIT 1`,
      [empresaId]
    );

  return obterContagemPorId(db, cabFinal.id, empresaId);
}

async function obterContagemPorId(db, contagemId, empresaId) {
  const cab = await dbGet(
    db,
    `SELECT * FROM estoque_contagens_fisicas WHERE id = ? AND empresa_id = ?`,
    [Number(contagemId), Number(empresaId)]
  );
  if (!cab) {
    throw erroContagem('CONTAGEM_NAO_ENCONTRADA', 'Contagem física não encontrada.', 404);
  }
  const itens = await dbAll(
    db,
    `SELECT * FROM estoque_contagens_fisicas_itens
      WHERE contagem_id = ? AND empresa_id = ?
      ORDER BY id`,
    [cab.id, empresaId]
  );
  return {
    id: Number(cab.id),
    empresa_id: Number(cab.empresa_id),
    usuario_id: cab.usuario_id != null ? Number(cab.usuario_id) : null,
    usuario_nome: cab.usuario_nome || null,
    observacao: cab.observacao || null,
    chave_idempotencia: cab.chave_idempotencia || null,
    criado_em: cab.criado_em,
    itens: itens.map((row) => ({
      id: Number(row.id),
      produto_id: Number(row.produto_id),
      saldo_fiscal_anterior: Number(row.saldo_fiscal_anterior),
      saldo_nao_fiscal_anterior: Number(row.saldo_nao_fiscal_anterior),
      quantidade_fiscal_contada: Number(row.quantidade_fiscal_contada),
      quantidade_nao_fiscal_contada: Number(row.quantidade_nao_fiscal_contada),
      diferenca_fiscal: Number(row.diferenca_fiscal),
      diferenca_nao_fiscal: Number(row.diferenca_nao_fiscal),
      ajuste_id: row.ajuste_id != null ? Number(row.ajuste_id) : null
    }))
  };
}

async function previsualizarContagem(params = {}) {
  const db = params.db;
  if (!db) throw erroContagem('DB_OBRIGATORIO', 'db é obrigatório.', 500);
  const empresaId = resolverEmpresaId(params.empresaId != null ? params.empresaId : params.empresa_id);
  if (empresaId == null) {
    throw erroContagem('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório.');
  }
  const produtoId = Number(params.produtoId != null ? params.produtoId : params.produto_id);
  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    throw erroContagem('PRODUTO_INVALIDO', 'produto_id inválido.');
  }
  const qF = quantidadeNaoNegativa(
    params.quantidade_fiscal_contada != null
      ? params.quantidade_fiscal_contada
      : params.quantidadeFiscalContada,
    'quantidade_fiscal_contada'
  );
  const qNf = quantidadeNaoNegativa(
    params.quantidade_nao_fiscal_contada != null
      ? params.quantidade_nao_fiscal_contada
      : params.quantidadeNaoFiscalContada,
    'quantidade_nao_fiscal_contada'
  );
  const antes = await estoqueSaldosPublico.consultarSaldo(produtoId, {
    db,
    empresaId,
    legado: false
  });
  const saldoFiscalAnterior = roundStockQuantity(Number(antes.saldo_fiscal || 0));
  const saldoNaoFiscalAnterior = roundStockQuantity(Number(antes.saldo_nao_fiscal || 0));
  return {
    empresa_id: empresaId,
    produto_id: produtoId,
    saldo_fiscal_anterior: saldoFiscalAnterior,
    saldo_nao_fiscal_anterior: saldoNaoFiscalAnterior,
    quantidade_fiscal_contada: qF,
    quantidade_nao_fiscal_contada: qNf,
    diferenca_fiscal: roundStockQuantity(qF - saldoFiscalAnterior),
    diferenca_nao_fiscal: roundStockQuantity(qNf - saldoNaoFiscalAnterior)
  };
}

module.exports = {
  MOTIVO_CONTAGEM,
  registrarContagemFisica,
  obterContagemPorId,
  previsualizarContagem
};
