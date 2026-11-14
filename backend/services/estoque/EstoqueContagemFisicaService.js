/**
 * Contagem física absoluta F×NF — CDS-ESTOQUE-MANUAL-01.
 * CDS-ESTOQUE-CONTAGEM-CONCORRENCIA-03: observação carrega saldo de referência;
 * confirmação em BEGIN IMMEDIATE rejeita snapshot desatualizado (CONTAGEM_DESATUALIZADA).
 * CDS-ESTOQUE-CONTAGEM-REDESIGN-PREVIEW-05.3 — consulta de saldo atual somente leitura.
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
  converterQuantidadeContagem,
  obterMetadadosConversaoProduto,
  listarApresentacoes
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

/**
 * Ajuste direcionado: a quantidade convertida é a movimentação, não o saldo final.
 * Ausência de tipo preserva a contagem física absoluta.
 */
function normalizarTipoAjuste(valor) {
  if (valor == null || valor === '') return null;
  const s = String(valor).trim().toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (s === 'BAIXA' || s === 'OFF') return 'BAIXA';
  if (s === 'ACRESCIMO' || s === 'ON') return 'ACRESCIMO';
  throw erroContagem(
    'TIPO_AJUSTE_INVALIDO',
    'Tipo de ajuste inválido. Use BAIXA ou ACRESCIMO.'
  );
}

function resolverTipoAjusteItem(params, item) {
  const fonte = item || {};
  const op = String(fonte.operacao != null ? fonte.operacao : (params.operacao || ''))
    .trim()
    .toUpperCase();
  if (op === 'CONTAGEM_FISICA' || op === 'CONTAGEM') return null;
  const bruto = fonte.tipo_ajuste != null ? fonte.tipo_ajuste : fonte.tipoAjuste;
  if ((bruto == null || bruto === '') && op !== 'AJUSTE_DIRECIONADO') return null;
  if (bruto == null || bruto === '') return 'BAIXA';
  return normalizarTipoAjuste(bruto);
}

function mensagemSaldoInsuficiente(bucket, disponivel, solicitado, unidade) {
  const un = unidade ? ` ${unidade}` : '';
  const nome = bucket === 'NAO_FISCAL' ? 'não fiscal' : 'fiscal';
  return `Saldo ${nome} insuficiente para a baixa. Disponível: ${disponivel}${un}. Solicitado: ${solicitado}${un}.`;
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
    const tipoAjuste = resolverTipoAjusteItem(params, item);

    itensNorm.push({
      produto_id: produtoId,
      produto_nome: produto.nome || null,
      omitir_nao_fiscal: omitirNf,
      tipo_ajuste: tipoAjuste,
      quantidade_fiscal_informada: convF.quantidade_informada,
      quantidade_nao_fiscal_informada: convNf ? convNf.quantidade_informada : null,
      unidade_informada: convF.unidade_informada,
      unidade_base: convF.unidade_base,
      fator_total: convF.fator_total,
      quantidade_fiscal_movimento: tipoAjuste ? convF.quantidade_convertida : null,
      quantidade_nao_fiscal_movimento: tipoAjuste && convNf ? convNf.quantidade_convertida : null,
      // Contagem absoluta: a convertida é o saldo-alvo. No ajuste direcionado o alvo
      // é calculado na transação a partir do snapshot, não da quantidade convertida.
      quantidade_fiscal_contada: tipoAjuste ? null : convF.quantidade_convertida,
      quantidade_nao_fiscal_contada: tipoAjuste ? null : (convNf ? convNf.quantidade_convertida : null),
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

        const diferencaFiscalAbsoluta = roundStockQuantity(
          item.quantidade_fiscal_contada - saldoFiscalAnterior
        );
        let diferencaFiscal = diferencaFiscalAbsoluta;
        let quantidadeFiscalPersistida = item.quantidade_fiscal_contada;
        let quantidadeNfPersistida = item.omitir_nao_fiscal
          ? saldoNaoFiscalAnterior
          : item.quantidade_nao_fiscal_contada;
        let diferencaNaoFiscal = item.omitir_nao_fiscal
          ? 0
          : roundStockQuantity(quantidadeNfPersistida - saldoNaoFiscalAnterior);

        if (item.tipo_ajuste === 'BAIXA' || item.tipo_ajuste === 'ACRESCIMO') {
          const sinal = item.tipo_ajuste === 'BAIXA' ? -1 : 1;
          const movF = roundStockQuantity(item.quantidade_fiscal_movimento);
          const unidade = item.unidade_base || '';
          if (item.tipo_ajuste === 'BAIXA' && movF - saldoFiscalAnterior > EPS_SALDO) {
            throw erroContagem(
              'SALDO_INSUFICIENTE',
              mensagemSaldoInsuficiente('FISCAL', saldoFiscalAnterior, movF, unidade),
              409,
              {
                empresa_id: empresaId,
                produto_id: item.produto_id,
                bucket: 'FISCAL',
                tipo_ajuste: 'BAIXA',
                saldo_disponivel: saldoFiscalAnterior,
                quantidade_solicitada: movF
              }
            );
          }
          diferencaFiscal = roundStockQuantity(sinal * movF);
          quantidadeFiscalPersistida = roundStockQuantity(saldoFiscalAnterior + diferencaFiscal);
          if (item.omitir_nao_fiscal) {
            diferencaNaoFiscal = 0;
            quantidadeNfPersistida = saldoNaoFiscalAnterior;
          } else {
            const movNf = roundStockQuantity(item.quantidade_nao_fiscal_movimento);
            if (item.tipo_ajuste === 'BAIXA' && movNf - saldoNaoFiscalAnterior > EPS_SALDO) {
              throw erroContagem(
                'SALDO_INSUFICIENTE',
                mensagemSaldoInsuficiente('NAO_FISCAL', saldoNaoFiscalAnterior, movNf, unidade),
                409,
                {
                  empresa_id: empresaId,
                  produto_id: item.produto_id,
                  bucket: 'NAO_FISCAL',
                  tipo_ajuste: 'BAIXA',
                  saldo_disponivel: saldoNaoFiscalAnterior,
                  quantidade_solicitada: movNf
                }
              );
            }
            diferencaNaoFiscal = roundStockQuantity(sinal * movNf);
            quantidadeNfPersistida = roundStockQuantity(saldoNaoFiscalAnterior + diferencaNaoFiscal);
          }
        }

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
          const motivoAjuste = item.tipo_ajuste
            ? (`AJUSTE_DIRECIONADO_${item.tipo_ajuste}` + (observacao ? ` ${observacao}` : '')).slice(0, 240)
            : (observacao || MOTIVO_CONTAGEM);
          ajusteId = await registrarAjusteAsync(db, {
            produto_id: item.produto_id,
            usuario_id: usuarioId,
            usuario_nome: usuarioNome,
            motivo: motivoAjuste,
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
            diferenca_fiscal, diferenca_nao_fiscal, ajuste_id, tipo_ajuste
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            contagemId,
            empresaId,
            item.produto_id,
            saldoFiscalAnterior,
            saldoNaoFiscalAnterior,
            quantidadeFiscalPersistida,
            quantidadeNfPersistida,
            diferencaFiscal,
            diferencaNaoFiscal,
            ajusteId,
            item.tipo_ajuste || null
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

async function enriquecerHistoricoComTipoAjuste(db, empresaId, hist) {
  if (!hist || !Array.isArray(hist.itens) || hist.itens.length === 0) return hist;
  const ids = hist.itens
    .map((item) => Number(item.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return hist;
  let rows = [];
  try {
    rows = await dbAll(
      db,
      `SELECT contagem_id, tipo_ajuste
         FROM estoque_contagens_fisicas_itens
        WHERE empresa_id = ? AND contagem_id IN (${ids.map(() => '?').join(',')})`,
      [Number(empresaId), ...ids]
    );
  } catch (err) {
    if (/no such column|no such table/i.test(String(err && err.message || ''))) return hist;
    throw err;
  }
  const porContagem = new Map();
  rows.forEach((row) => {
    const id = Number(row.contagem_id);
    if (!porContagem.has(id)) porContagem.set(id, new Set());
    if (row.tipo_ajuste) porContagem.get(id).add(String(row.tipo_ajuste));
  });
  return Object.assign({}, hist, {
    itens: hist.itens.map((item) => {
      const tipos = Array.from(porContagem.get(Number(item.id)) || []);
      let resultado = item.resultado || null;
      if (tipos.length === 1 && tipos[0] === 'BAIXA') resultado = 'BAIXA';
      else if (tipos.length === 1 && tipos[0] === 'ACRESCIMO') resultado = 'ACRÉSCIMO';
      else if (tipos.indexOf('BAIXA') >= 0 && tipos.indexOf('ACRESCIMO') >= 0) {
        resultado = 'BAIXA e ACRÉSCIMO';
      }
      return Object.assign({}, item, {
        tipos_ajuste: tipos,
        resultado: resultado
      });
    })
  });
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
      ajuste_id: row.ajuste_id != null ? Number(row.ajuste_id) : null,
      tipo_ajuste: row.tipo_ajuste || null
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
  const tipoAjuste = resolverTipoAjusteItem(params, params);

  if (tipoAjuste) {
    const sinal = tipoAjuste === 'BAIXA' ? -1 : 1;
    const diferencaFiscal = roundStockQuantity(sinal * qF);
    const diferencaNaoFiscal = omitirNf || qNf == null ? null : roundStockQuantity(sinal * qNf);
    const saldoFiscalPrevisto = roundStockQuantity(saldoFiscalAnterior + diferencaFiscal);
    const saldoNaoFiscalPrevisto = omitirNf
      ? saldoNaoFiscalAnterior
      : roundStockQuantity(saldoNaoFiscalAnterior + diferencaNaoFiscal);
    const insuficienteFiscal = tipoAjuste === 'BAIXA' && qF - saldoFiscalAnterior > EPS_SALDO;
    const insuficienteNaoFiscal = tipoAjuste === 'BAIXA'
      && !omitirNf
      && qNf - saldoNaoFiscalAnterior > EPS_SALDO;
    return {
      empresa_id: empresaId,
      produto_id: produtoId,
      operacao: 'AJUSTE_DIRECIONADO',
      tipo_ajuste: tipoAjuste,
      modo_fiscal: omitirNf ? '1' : '0',
      omitir_nao_fiscal: omitirNf,
      saldo_fiscal_anterior: saldoFiscalAnterior,
      saldo_nao_fiscal_anterior: saldoNaoFiscalAnterior,
      saldo_fiscal_esperado: saldoFiscalAnterior,
      saldo_nao_fiscal_esperado: saldoNaoFiscalAnterior,
      quantidade_fiscal_informada: convF.quantidade_informada,
      quantidade_nao_fiscal_informada: omitirNf ? null : convNf.quantidade_informada,
      unidade_informada: convF.unidade_informada,
      unidade_base: convF.unidade_base,
      fator_total: convF.fator_total,
      mensagem_conversao_fiscal: convF.mensagem_conversao,
      mensagem_conversao_nao_fiscal: omitirNf ? null : convNf.mensagem_conversao,
      quantidade_fiscal_convertida: qF,
      quantidade_nao_fiscal_convertida: qNf,
      quantidade_fiscal_contada: qF,
      quantidade_nao_fiscal_contada: qNf,
      diferenca_fiscal: diferencaFiscal,
      diferenca_nao_fiscal: diferencaNaoFiscal,
      saldo_fiscal_previsto: saldoFiscalPrevisto,
      saldo_nao_fiscal_previsto: saldoNaoFiscalPrevisto,
      saldo_insuficiente_fiscal: insuficienteFiscal,
      saldo_insuficiente_nao_fiscal: insuficienteNaoFiscal,
      saldo_insuficiente: insuficienteFiscal || insuficienteNaoFiscal,
      saldo_disponivel_fiscal: saldoFiscalAnterior,
      saldo_disponivel_nao_fiscal: saldoNaoFiscalAnterior,
      quantidade_solicitada_fiscal: qF,
      quantidade_solicitada_nao_fiscal: qNf,
      movimentou_estoque: false
    };
  }

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

async function carregarProdutoLeituraContagem(db, produtoId) {
  const tentativas = [
    `SELECT id, nome, codigo, codigo_barras,
            COALESCE(unidade_comercial, unidade, 'UN') AS unidade
       FROM produtos WHERE id = ?`,
    `SELECT id, nome, codigo, COALESCE(unidade, 'UN') AS unidade
       FROM produtos WHERE id = ?`,
    `SELECT id, nome FROM produtos WHERE id = ?`
  ];
  let ultimoErroColuna = null;
  for (const sql of tentativas) {
    try {
      const row = await dbGet(db, sql, [produtoId]);
      if (!row) return null;
      return {
        id: Number(row.id),
        nome: row.nome || '',
        codigo: row.codigo != null ? row.codigo : null,
        codigo_barras: row.codigo_barras != null ? row.codigo_barras : null,
        unidade: row.unidade || 'UN'
      };
    } catch (err) {
      if (!/no such column/i.test(String(err && err.message || ''))) throw err;
      ultimoErroColuna = err;
    }
  }
  if (ultimoErroColuna) throw ultimoErroColuna;
  return null;
}

/**
 * Saldo atual da empresa selecionada para a tela de contagem.
 * Somente leitura: não grava estoque, histórico, ajuste, reserva ou receita.
 * O snapshot devolvido é o saldo observado agora, na unidade-base, sem reconversão.
 */
async function consultarSaldoAtualContagem(params = {}) {
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

  const produto = await carregarProdutoLeituraContagem(db, produtoId);
  if (!produto) {
    throw erroContagem('PRODUTO_NAO_ENCONTRADO', `Produto ${produtoId} não encontrado.`, 404);
  }

  const antes = await estoqueSaldosPublico.consultarSaldo(produtoId, {
    db,
    empresaId,
    legado: false
  });
  if (!antes || antes.legado === true || Number(antes.empresa_id) !== empresaId) {
    throw erroContagem(
      'SALDO_EMPRESA_NAO_ISOLADO',
      'O saldo atual precisa ser lido do estoque da empresa selecionada.',
      409,
      { empresa_id: empresaId, produto_id: produtoId }
    );
  }

  let meta = null;
  let metaErro = null;
  try {
    meta = await obterMetadadosConversaoProduto(db, produtoId);
  } catch (err) {
    metaErro = err;
  }

  let apresentacoes = [];
  try {
    const lista = await listarApresentacoes(db, produtoId);
    apresentacoes = (Array.isArray(lista) ? lista : []).map((a) => ({
      id: Number(a.id),
      tipo: a.tipo || null,
      quantidade: a.quantidade != null ? Number(a.quantidade) : null,
      unidade: a.unidade || null,
      principal: Number(a.principal) === 1,
      venda: Number(a.venda) === 1
    }));
  } catch (_) {
    apresentacoes = [];
  }

  const utiliza = !!(meta && meta.utiliza_conversao);
  const fatorBruto = meta && meta.fator_conversao != null ? Number(meta.fator_conversao) : null;
  const conversaoConfiavel = metaErro
    ? false
    : (utiliza
      ? (Number.isFinite(fatorBruto) && fatorBruto > 0 && !!(meta && meta.unidade_base))
      : true);
  const unidadeComercial = (meta && meta.unidade_comercial) || produto.unidade || 'UN';
  const unidadeBase = (meta && meta.unidade_base) || (conversaoConfiavel ? unidadeComercial : null);
  const saldoFiscal = roundStockQuantity(Number(antes.saldo_fiscal || 0));
  const saldoNaoFiscal = roundStockQuantity(Number(antes.saldo_nao_fiscal || 0));

  return {
    ok: true,
    somente_leitura: true,
    movimentou_estoque: false,
    origem_saldo: 'estoque_empresa',
    empresa_id: empresaId,
    produto_id: produtoId,
    nome: produto.nome,
    codigo: produto.codigo,
    codigo_interno: produto.codigo,
    codigo_barras: produto.codigo_barras,
    unidade_comercial: unidadeComercial,
    unidade_base: unidadeBase,
    utiliza_conversao: utiliza,
    fator_conversao: conversaoConfiavel ? (utiliza ? fatorBruto : 1) : null,
    apresentacao_id: meta && meta.apresentacao_id != null ? Number(meta.apresentacao_id) : null,
    apresentacoes,
    conversao_confiavel: conversaoConfiavel,
    conversao_codigo: metaErro && metaErro.code ? metaErro.code : null,
    saldo_fiscal_atual: saldoFiscal,
    saldo_nao_fiscal_atual: saldoNaoFiscal,
    saldo_fiscal_esperado: saldoFiscal,
    saldo_nao_fiscal_esperado: saldoNaoFiscal
  };
}

module.exports = {
  MOTIVO_CONTAGEM,
  registrarContagemFisica,
  obterContagemPorId,
  previsualizarContagem,
  consultarSaldoAtualContagem,
  resolverOmitirNaoFiscal,
  enriquecerHistoricoComTipoAjuste
};
