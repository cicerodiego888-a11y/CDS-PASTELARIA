/**
 * Ajuste de Estoque — gravação de saldo via Porta Pública F×NF.
 *
 * Fase 1 / Implementação 02.1:
 *   ajuste → estoqueSaldosPublico → produtos
 * Storage ainda em `produtos` (sem estoque_empresa).
 *
 * @module services/ajusteEstoqueService
 */
'use strict';

const estoqueSaldosPublico = require('./fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('./fiscalNaoFiscal/constants');
const {
  resolverEmpresaId
} = require('./fiscalNaoFiscal/empresaContexto');

/** Compat explícita: endpoints ERP / importação ainda sem empresa no JWT. */
const MOTIVO_COMPAT_AJUSTE = 'COMPAT_AJUSTE_ESTOQUE_PRE_MULTIEMPRESA';

function produtoTemMovimentacoes(db, produtoId, callback) {
  db.get(`
    SELECT
      (SELECT COUNT(*) FROM compras_itens WHERE produto_id = ?) AS compras,
      (SELECT COUNT(*) FROM vendas_itens WHERE produto_id = ?) AS vendas,
      (SELECT COUNT(*) FROM compras_devolucoes WHERE produto_id = ?) AS devolucoes,
      (SELECT COUNT(*) FROM produtos_ajustes_estoque WHERE produto_id = ?) AS ajustes,
      (SELECT COUNT(*) FROM produtos_lotes
        WHERE produto_id = ? AND COALESCE(origem, '') != 'ESTOQUE_INICIAL') AS lotes_mov
  `, [produtoId, produtoId, produtoId, produtoId, produtoId], (err, row) => {
    if (err) return callback(err);

    const tem = (
      Number(row?.compras || 0) > 0
      || Number(row?.vendas || 0) > 0
      || Number(row?.devolucoes || 0) > 0
      || Number(row?.ajustes || 0) > 0
      || Number(row?.lotes_mov || 0) > 0
    );

    callback(null, tem);
  });
}

/** Estoque Inicial só bloqueia após a primeira venda do produto. */
function produtoTemVendas(db, produtoId, callback) {
  db.get(
    `SELECT COUNT(*) AS vendas FROM vendas_itens WHERE produto_id = ?`,
    [produtoId],
    (err, row) => {
      if (err) return callback(err);
      callback(null, Number(row?.vendas || 0) > 0);
    }
  );
}

function registrarAjusteEstoque(db, dados, callback) {
  db.run(`
    INSERT INTO produtos_ajustes_estoque (
      produto_id, usuario_id, usuario_nome, motivo,
      ajuste_fiscal, ajuste_nao_fiscal,
      saldo_fiscal_antes, saldo_fiscal_depois,
      saldo_nao_fiscal_antes, saldo_nao_fiscal_depois,
      estoque_total_antes, estoque_total_depois
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    dados.produto_id,
    dados.usuario_id || null,
    dados.usuario_nome || null,
    dados.motivo,
    dados.ajuste_fiscal,
    dados.ajuste_nao_fiscal,
    dados.saldo_fiscal_antes,
    dados.saldo_fiscal_depois,
    dados.saldo_nao_fiscal_antes,
    dados.saldo_nao_fiscal_depois,
    dados.estoque_total_antes,
    dados.estoque_total_depois
  ], callback);
}

/**
 * Monta opts da porta: empresaId explícito ou COMPAT de ajuste (legado ERP).
 * Nunca inventa empresa 1 / CNPJ de configurações.
 *
 * Se opcoes.exigirEmpresa === true, ausência de empresaId → EMPRESA_OBRIGATORIA
 * (sem COMPAT). Usado em testes/contrato multiempresa.
 */
function montarOptsPortaAjuste(db, opcoes = {}) {
  const empresaId = resolverEmpresaId(opcoes)
    ?? resolverEmpresaId(opcoes.contexto)
    ?? resolverEmpresaId(opcoes.ctx);

  const base = {
    db,
    usuarioId: opcoes.usuarioId,
    validarEmpresa: opcoes.validarEmpresa
  };

  if (empresaId != null) {
    return { ...base, empresaId, legado: false, motivoCompat: null };
  }

  if (opcoes.exigirEmpresa === true) {
    const err = new Error(
      'empresaId é obrigatório para operações de saldo/reserva. Informe empresa_id/empresaId no contexto.'
    );
    err.code = 'EMPRESA_OBRIGATORIA';
    throw err;
  }

  // Fluxos ERP/importação pré-multiempresa (JWT sem empresa): COMPAT explícito do ajuste.
  return {
    ...base,
    modoLegadoSemEmpresa: true,
    motivoCompat: opcoes.motivoCompat || MOTIVO_COMPAT_AJUSTE,
    legado: true
  };
}

function mapearErroPorta(err) {
  if (!err) return err;
  if (err.code === 'SALDO_INSUFICIENTE') {
    const msg = /não fiscal/i.test(String(err.message || ''))
      ? 'Ajuste não fiscal resultaria em saldo não fiscal negativo.'
      : 'Ajuste fiscal resultaria em saldo fiscal negativo.';
    const e = new Error(msg);
    e.code = err.code;
    e.cause = err;
    return e;
  }
  if (err.code === 'PRODUTO_NAO_ENCONTRADO') {
    const e = new Error('Produto não encontrado.');
    e.code = err.code;
    return e;
  }
  if (err.code === 'EMPRESA_OBRIGATORIA' || err.code === 'EMPRESA_NAO_ENCONTRADA') {
    return err;
  }
  return err;
}

async function aplicarDeltasSaldoViaPorta(produtoId, ajusteF, ajusteNF, optsPorta) {
  if (ajusteF > 0) {
    await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.FISCAL, ajusteF, optsPorta);
  } else if (ajusteF < 0) {
    await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.FISCAL, Math.abs(ajusteF), optsPorta);
  }

  if (ajusteNF > 0) {
    await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, ajusteNF, optsPorta);
  } else if (ajusteNF < 0) {
    await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.NAO_FISCAL, Math.abs(ajusteNF), optsPorta);
  }

  return estoqueSaldosPublico.consultarSaldo(produtoId, optsPorta);
}

function aplicarAjusteEstoqueProduto(db, opcoes, callback) {
  const {
    produtoId,
    ajusteFiscal,
    ajusteNaoFiscal,
    motivo,
    usuarioId,
    usuarioNome,
    lote,
    dataFabricacao,
    dataValidade,
    lotesService
  } = opcoes;

  const ajusteF = Number(ajusteFiscal || 0);
  const ajusteNF = Number(ajusteNaoFiscal || 0);

  let optsPorta;
  try {
    optsPorta = montarOptsPortaAjuste(db, opcoes);
  } catch (e) {
    return callback(e);
  }

  if (ajusteF === 0 && ajusteNF === 0) {
    return callback(new Error('Informe ao menos um ajuste fiscal ou não fiscal diferente de zero.'));
  }

  if (!motivo || !String(motivo).trim()) {
    return callback(new Error('Motivo do ajuste é obrigatório.'));
  }

  db.get(
    'SELECT controlar_validade FROM produtos WHERE id = ?',
    [produtoId],
    (getErr, produtoMeta) => {
      if (getErr) return callback(getErr);
      if (!produtoMeta) return callback(new Error('Produto não encontrado.'));

      (async () => {
        const antes = await estoqueSaldosPublico.consultarSaldo(produtoId, optsPorta);
        const saldoFiscalAntes = Number(antes.saldo_fiscal || 0);
        const saldoNaoFiscalAntes = Number(antes.saldo_nao_fiscal || 0);
        const estoqueTotalAntes = Number(
          (antes.estoque_atual != null
            ? antes.estoque_atual
            : (saldoFiscalAntes + saldoNaoFiscalAntes)).toFixed(3)
        );

        const saldoFiscalDepois = Number((saldoFiscalAntes + ajusteF).toFixed(3));
        const saldoNaoFiscalDepois = Number((saldoNaoFiscalAntes + ajusteNF).toFixed(3));
        const estoqueTotalDepois = Number((saldoFiscalDepois + saldoNaoFiscalDepois).toFixed(3));

        if (saldoFiscalDepois < 0) {
          throw new Error('Ajuste fiscal resultaria em saldo fiscal negativo.');
        }
        if (saldoNaoFiscalDepois < 0) {
          throw new Error('Ajuste não fiscal resultaria em saldo não fiscal negativo.');
        }

        const controlaValidade = produtoMeta.controlar_validade === 1;
        const ajusteTotalPositivo = Math.max(0, ajusteF) + Math.max(0, ajusteNF);
        const ajusteTotalNegativo = Math.abs(Math.min(0, ajusteF)) + Math.abs(Math.min(0, ajusteNF));

        const finalizarComSaldos = async () => {
          // Mutação de saldo exclusivamente via porta pública (mesmo `db` / TX externa).
          const depois = await aplicarDeltasSaldoViaPorta(produtoId, ajusteF, ajusteNF, optsPorta);

          await new Promise((resolve, reject) => {
            registrarAjusteEstoque(db, {
              produto_id: produtoId,
              usuario_id: usuarioId,
              usuario_nome: usuarioNome,
              motivo: String(motivo).trim(),
              ajuste_fiscal: ajusteF,
              ajuste_nao_fiscal: ajusteNF,
              saldo_fiscal_antes: saldoFiscalAntes,
              saldo_fiscal_depois: Number(depois.saldo_fiscal),
              saldo_nao_fiscal_antes: saldoNaoFiscalAntes,
              saldo_nao_fiscal_depois: Number(depois.saldo_nao_fiscal),
              estoque_total_antes: estoqueTotalAntes,
              estoque_total_depois: Number(
                depois.estoque_atual != null
                  ? depois.estoque_atual
                  : (depois.saldo_fiscal + depois.saldo_nao_fiscal)
              )
            }, (histErr) => (histErr ? reject(histErr) : resolve()));
          });

          return {
            saldo_fiscal: Number(depois.saldo_fiscal),
            saldo_nao_fiscal: Number(depois.saldo_nao_fiscal),
            estoque_atual: Number(
              depois.estoque_atual != null
                ? depois.estoque_atual
                : (depois.saldo_fiscal + depois.saldo_nao_fiscal)
            ),
            empresa_id: depois.empresa_id != null ? depois.empresa_id : null,
            legado: optsPorta.legado === true,
            motivo_compat: optsPorta.legado ? (optsPorta.motivoCompat || MOTIVO_COMPAT_AJUSTE) : null
          };
        };

        if (controlaValidade) {
          if (ajusteTotalPositivo > 0) {
            if (!dataValidade) {
              throw new Error('Para produtos com controle de validade, informe a data de validade no ajuste positivo.');
            }
            const hoje = new Date().toISOString().split('T')[0];
            await new Promise((resolve, reject) => {
              lotesService.criarLote({
                produto_id: produtoId,
                lote: lote || undefined,
                quantidade_inicial: ajusteTotalPositivo,
                data_fabricacao: dataFabricacao || null,
                data_validade: dataValidade,
                data_entrada: hoje,
                origem: 'AJUSTE_ESTOQUE',
                compra_id: null
              }, (loteErr) => (loteErr ? reject(loteErr) : resolve()));
            });
          } else if (ajusteTotalNegativo > 0) {
            await new Promise((resolve, reject) => {
              lotesService.consumirLotesFEFO(produtoId, ajusteTotalNegativo, (consumoErr) => (
                consumoErr ? reject(consumoErr) : resolve()
              ));
            });
          }
        }

        return finalizarComSaldos();
      })().then(
        (result) => callback(null, result),
        (err) => callback(mapearErroPorta(err))
      );
    }
  );
}

function definirSaldosIniciaisProduto(saldoFiscal, saldoNaoFiscal) {
  const fiscal = Number(saldoFiscal || 0);
  const naoFiscal = Number(saldoNaoFiscal || 0);
  if (fiscal < 0 || naoFiscal < 0) {
    throw new Error('Saldos iniciais não podem ser negativos.');
  }
  const estoqueAtual = Number((fiscal + naoFiscal).toFixed(3));
  return {
    saldo_fiscal: fiscal,
    saldo_nao_fiscal: naoFiscal,
    estoque_atual: estoqueAtual
  };
}

/**
 * Aplica saldos iniciais (absolutos) via porta pública — deltas a partir do saldo atual.
 * Não grava histórico de ajuste (comportamento do PUT legado preservado).
 */
function aplicarSaldosIniciaisViaPorta(db, opcoes, callback) {
  const produtoId = Number(opcoes.produtoId || opcoes.produto_id);
  let alvo;
  try {
    alvo = definirSaldosIniciaisProduto(opcoes.saldoFiscal, opcoes.saldoNaoFiscal);
  } catch (e) {
    return callback(e);
  }

  let optsPorta;
  try {
    optsPorta = montarOptsPortaAjuste(db, opcoes);
  } catch (e) {
    return callback(e);
  }

  (async () => {
    const atual = await estoqueSaldosPublico.consultarSaldo(produtoId, optsPorta);
    const ajusteF = Number((alvo.saldo_fiscal - Number(atual.saldo_fiscal || 0)).toFixed(3));
    const ajusteNF = Number((alvo.saldo_nao_fiscal - Number(atual.saldo_nao_fiscal || 0)).toFixed(3));

    if (ajusteF === 0 && ajusteNF === 0) {
      return {
        saldo_fiscal: Number(atual.saldo_fiscal),
        saldo_nao_fiscal: Number(atual.saldo_nao_fiscal),
        estoque_atual: Number(atual.estoque_atual),
        empresa_id: atual.empresa_id != null ? atual.empresa_id : null,
        legado: optsPorta.legado === true,
        motivo_compat: optsPorta.legado ? (optsPorta.motivoCompat || MOTIVO_COMPAT_AJUSTE) : null
      };
    }

    const depois = await aplicarDeltasSaldoViaPorta(produtoId, ajusteF, ajusteNF, optsPorta);
    return {
      saldo_fiscal: Number(depois.saldo_fiscal),
      saldo_nao_fiscal: Number(depois.saldo_nao_fiscal),
      estoque_atual: Number(depois.estoque_atual),
      empresa_id: depois.empresa_id != null ? depois.empresa_id : null,
      legado: optsPorta.legado === true,
      motivo_compat: optsPorta.legado ? (optsPorta.motivoCompat || MOTIVO_COMPAT_AJUSTE) : null
    };
  })().then(
    (result) => callback(null, result),
    (err) => callback(mapearErroPorta(err))
  );
}

module.exports = {
  produtoTemMovimentacoes,
  produtoTemVendas,
  registrarAjusteEstoque,
  aplicarAjusteEstoqueProduto,
  definirSaldosIniciaisProduto,
  aplicarSaldosIniciaisViaPorta,
  montarOptsPortaAjuste,
  MOTIVO_COMPAT_AJUSTE
};
