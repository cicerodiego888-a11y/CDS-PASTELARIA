/**
 * Contagem física absoluta F×NF — CDS-ESTOQUE-MANUAL-01.
 * CDS-ESTOQUE-CONTAGEM-CONCORRENCIA-03: observação carrega saldo de referência;
 * confirmação em BEGIN IMMEDIATE rejeita snapshot desatualizado (CONTAGEM_DESATUALIZADA).
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
const {
  converterQuantidadeContagem
} = require('./EstoqueContagemConversaoService');

const MOTIVO_CONTAGEM = 'CONTAGEM_FISICA';
const EPS_SALDO = 1e-9;

/**
 * F12 ON = modo fiscal: não contar/ajustar saldo não fiscal.
 * Fonte alinhada a modo_dashboard_fiscal / pdv_modo_fiscal_ativo ('1' = ON).
 */
function resolverOmitirNaoFiscal(params = {}, item = {}) {
  if (item.omitir_nao_fiscal === true || item.omitir_nao_fiscal === 1 || item.omitir_nao_fiscal === '1') {
    return true;
  }
  if (item.contar_nao_fiscal === false || item.contar_nao_fiscal === 0 || item.contar_nao_fiscal === '0') {
    return true;
  }
  const modo = params.modo_fiscal != null
    ? params.modo_fiscal
    : (params.modoFiscal != null
      ? params.modoFiscal
      : (item.modo_fiscal != null ? item.modo_fiscal : item.modoFiscal));
  if (modo == null || modo === '') return false;
  const s = String(modo).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'sim';
}

function quantidadeInformadaOpcional(valor, campo, { obrigatorio }) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) {
      throw erroContagem('QUANTIDADE_CONTAGEM_OBRIGATORIA', `${campo} é obrigatória.`);
    }
    return null;
  }
  return quantidadeNaoNegativa(valor, campo);
}

function erroContagem(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function saldosIguais(a, b) {
  return Math.abs(roundStockQuantity(a) - roundStockQuantity(b)) <= EPS_SALDO;
}

/**
 * Snapshot opcional da observação (preview / abertura).
 * Quando informado, a confirmação exige que o saldo atual ainda coincida.
 */
function extrairSaldoEsperadoItem(item = {}) {
  const temFiscal = item.saldo_fiscal_esperado != null
    || item.saldoFiscalEsperado != null
    || item.saldo_fiscal_anterior != null
    || item.saldoFiscalAnterior != null;
  const temNaoFiscal = item.saldo_nao_fiscal_esperado != null
    || item.saldoNaoFiscalEsperado != null
    || item.saldo_nao_fiscal_anterior != null
    || item.saldoNaoFiscalAnterior != null;
  if (!temFiscal && !temNaoFiscal) return null;
  if (!temFiscal || !temNaoFiscal) {
    throw erroContagem(
      'SALDO_ESPERADO_INCOMPLETO',
      'Informe saldo_fiscal_esperado e saldo_nao_fiscal_esperado juntos (referência da observação).'
    );
  }
  const fiscalRaw = item.saldo_fiscal_esperado != null
    ? item.saldo_fiscal_esperado
    : (item.saldoFiscalEsperado != null
      ? item.saldoFiscalEsperado
      : (item.saldo_fiscal_anterior != null
        ? item.saldo_fiscal_anterior
        : item.saldoFiscalAnterior));
  const naoFiscalRaw = item.saldo_nao_fiscal_esperado != null
    ? item.saldo_nao_fiscal_esperado
    : (item.saldoNaoFiscalEsperado != null
      ? item.saldoNaoFiscalEsperado
      : (item.saldo_nao_fiscal_anterior != null
        ? item.saldo_nao_fiscal_anterior
        : item.saldoNaoFiscalAnterior));
  return {
    saldo_fiscal: quantidadeNaoNegativa(fiscalRaw, 'saldo_fiscal_esperado'),
    saldo_nao_fiscal: quantidadeNaoNegativa(naoFiscalRaw, 'saldo_nao_fiscal_esperado')
  };
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

  // Atalho fora da TX: revalidado dentro de BEGIN IMMEDIATE.
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

  const omitirNaoFiscalGlobal = resolverOmitirNaoFiscal(params);
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

    const omitirNf = omitirNaoFiscalGlobal || resolverOmitirNaoFiscal(params, item);
    const qFInformada = quantidadeInformadaOpcional(
      item.quantidade_fiscal_informada != null
        ? item.quantidade_fiscal_informada
        : (item.quantidade_fiscal_contada != null
          ? item.quantidade_fiscal_contada
          : item.quantidadeFiscalContada),
      'quantidade_fiscal_informada',
      { obrigatorio: true }
    );
    const qNfInformada = omitirNf
      ? null
      : quantidadeInformadaOpcional(
        item.quantidade_nao_fiscal_informada != null
          ? item.quantidade_nao_fiscal_informada
          : (item.quantidade_nao_fiscal_contada != null
            ? item.quantidade_nao_fiscal_contada
            : item.quantidadeNaoFiscalContada),
        'quantidade_nao_fiscal_informada',
        { obrigatorio: true }
      );

    const convOpts = {
      apresentacaoId: item.apresentacao_id != null ? item.apresentacao_id : item.apresentacaoId,
      unidadeOrigem: item.unidade_informada || item.unidade_comercial || item.unidadeComercial
    };
    const convF = await converterQuantidadeContagem(db, produtoId, qFInformada, convOpts);
    const convNf = omitirNf
      ? null
      : await converterQuantidadeContagem(db, produtoId, qNfInformada, convOpts);

    itensNorm.push({
      produto_id: produtoId,
      produto_nome: produto.nome || null,
      omitir_nao_fiscal: omitirNf,
      quantidade_fiscal_informada: convF.quantidade_informada,
      quantidade_nao_fiscal_informada: convNf ? convNf.quantidade_informada : null,
      unidade_informada: convF.unidade_informada,
      unidade_base: convF.unidade_base,
      fator_total: convF.fator_total,
      // Persistidos / comparados na unidade-base.
      quantidade_fiscal_contada: convF.quantidade_convertida,
      quantidade_nao_fiscal_contada: convNf ? convNf.quantidade_convertida : null,
      saldo_esperado: extrairSaldoEsperadoItem(item)
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

  let contagemIdFinal;
  try {
    contagemIdFinal = await estoqueSaldosPublico.executarEmTransacao(async () => {
      // Idempotência sob lock de escrita (evita duplicar ajuste com a mesma chave).
      if (chaveIdempotencia) {
        const existenteTx = await dbGet(
          db,
          `SELECT id FROM estoque_contagens_fisicas
            WHERE empresa_id = ? AND chave_idempotencia = ?`,
          [empresaId, chaveIdempotencia]
        );
        if (existenteTx) {
          return { idempotente: true, id: Number(existenteTx.id) };
        }
      }

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

        // Observação desatualizada: saldo mudou desde o início da contagem.
        if (item.saldo_esperado) {
          if (
            !saldosIguais(item.saldo_esperado.saldo_fiscal, saldoFiscalAnterior)
            || !saldosIguais(item.saldo_esperado.saldo_nao_fiscal, saldoNaoFiscalAnterior)
          ) {
            throw erroContagem(
              'CONTAGEM_DESATUALIZADA',
              'A observação da contagem está desatualizada: o saldo foi alterado desde o início. '
              + 'Atualize a pré-visualização e realize uma nova contagem.',
              409,
              {
                empresa_id: empresaId,
                produto_id: item.produto_id,
                saldo_fiscal_esperado: item.saldo_esperado.saldo_fiscal,
                saldo_nao_fiscal_esperado: item.saldo_esperado.saldo_nao_fiscal,
                saldo_fiscal_atual: saldoFiscalAnterior,
                saldo_nao_fiscal_atual: saldoNaoFiscalAnterior
              }
            );
          }
        }

        const diferencaFiscal = roundStockQuantity(
          item.quantidade_fiscal_contada - saldoFiscalAnterior
        );
        // F12 ON: não interpreta ausência como zero — preserva NF sem ajuste.
        const quantidadeNfPersistida = item.omitir_nao_fiscal
          ? saldoNaoFiscalAnterior
          : item.quantidade_nao_fiscal_contada;
        const diferencaNaoFiscal = item.omitir_nao_fiscal
          ? 0
          : roundStockQuantity(quantidadeNfPersistida - saldoNaoFiscalAnterior);

        let ajusteId = null;
        if (Math.abs(diferencaFiscal) > EPS_SALDO || Math.abs(diferencaNaoFiscal) > EPS_SALDO) {
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
            quantidadeNfPersistida,
            diferencaFiscal,
            diferencaNaoFiscal,
            ajusteId
          ]
        );
      }

      return { idempotente: false, id: contagemId };
    }, { db });
  } catch (err) {
    // Corrida na UNIQUE de idempotência: outra requisição confirmou a mesma chave.
    if (
      chaveIdempotencia
      && err
      && /UNIQUE/i.test(String(err.message || ''))
    ) {
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
    throw err;
  }

  return obterContagemPorId(db, contagemIdFinal.id, empresaId);
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

  const omitirNf = resolverOmitirNaoFiscal(params);
  const qFInformada = quantidadeInformadaOpcional(
    params.quantidade_fiscal_informada != null
      ? params.quantidade_fiscal_informada
      : (params.quantidade_fiscal_contada != null
        ? params.quantidade_fiscal_contada
        : params.quantidadeFiscalContada),
    'quantidade_fiscal_informada',
    { obrigatorio: true }
  );
  const qNfInformada = omitirNf
    ? null
    : quantidadeInformadaOpcional(
      params.quantidade_nao_fiscal_informada != null
        ? params.quantidade_nao_fiscal_informada
        : (params.quantidade_nao_fiscal_contada != null
          ? params.quantidade_nao_fiscal_contada
          : params.quantidadeNaoFiscalContada),
      'quantidade_nao_fiscal_informada',
      { obrigatorio: true }
    );

  const convOpts = {
    apresentacaoId: params.apresentacao_id != null ? params.apresentacao_id : params.apresentacaoId,
    unidadeOrigem: params.unidade_informada || params.unidade_comercial || params.unidadeComercial
  };
  const convF = await converterQuantidadeContagem(db, produtoId, qFInformada, convOpts);
  const convNf = omitirNf
    ? null
    : await converterQuantidadeContagem(db, produtoId, qNfInformada, convOpts);

  const antes = await estoqueSaldosPublico.consultarSaldo(produtoId, {
    db,
    empresaId,
    legado: false
  });
  const saldoFiscalAnterior = roundStockQuantity(Number(antes.saldo_fiscal || 0));
  const saldoNaoFiscalAnterior = roundStockQuantity(Number(antes.saldo_nao_fiscal || 0));
  const qF = convF.quantidade_convertida;
  const qNf = omitirNf ? null : convNf.quantidade_convertida;

  return {
    empresa_id: empresaId,
    produto_id: produtoId,
    modo_fiscal: omitirNf ? '1' : '0',
    omitir_nao_fiscal: omitirNf,
    // Referência da observação — reenviar na confirmação como saldo_*_esperado.
    saldo_fiscal_anterior: saldoFiscalAnterior,
    saldo_nao_fiscal_anterior: saldoNaoFiscalAnterior,
    saldo_fiscal_esperado: saldoFiscalAnterior,
    saldo_nao_fiscal_esperado: saldoNaoFiscalAnterior,
    // Comercial (operador) + convertida (unidade-base — fonte de verdade do ajuste).
    quantidade_fiscal_informada: convF.quantidade_informada,
    quantidade_nao_fiscal_informada: omitirNf ? null : convNf.quantidade_informada,
    unidade_informada: convF.unidade_informada,
    unidade_base: convF.unidade_base,
    fator_total: convF.fator_total,
    mensagem_conversao_fiscal: convF.mensagem_conversao,
    mensagem_conversao_nao_fiscal: omitirNf ? null : convNf.mensagem_conversao,
    quantidade_fiscal_contada: qF,
    quantidade_nao_fiscal_contada: qNf,
    diferenca_fiscal: roundStockQuantity(qF - saldoFiscalAnterior),
    diferenca_nao_fiscal: omitirNf
      ? null
      : roundStockQuantity(qNf - saldoNaoFiscalAnterior)
  };
}

module.exports = {
  MOTIVO_CONTAGEM,
  registrarContagemFisica,
  obterContagemPorId,
  previsualizarContagem,
  resolverOmitirNaoFiscal
};
