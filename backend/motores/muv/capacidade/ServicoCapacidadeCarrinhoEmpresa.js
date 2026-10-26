/**
 * Capacidade do carrinho por empresa — somente leitura (MUV-CAP-01 / SPEC-MUV-02).
 * Não cria reserva, venda, financeiro nem documento fiscal.
 *
 * @module motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa
 */
'use strict';

const crypto = require('crypto');
const { roundStockQuantity } = require('../../../services/estoque/quantityPrecision');
const { produtoControlaEstoque } = require('../../../services/estoque/produtoControlaEstoque');
const { TipoSaldo, normalizarTipoSaldo } = require('../../../services/fiscalNaoFiscal/constants');
const {
  classificarTipoEmpresa,
  escolherMatrizPadrao
} = require('../../../services/empresas/ContextoEmpresaOperacionalService');
const {
  selecionarEmpresaCapacidade,
  CODIGOS_BLOQUEIO
} = require('./selecionarEmpresaCapacidade');

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../../database');
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function hashCarrinho(itens) {
  const normalizado = (itens || [])
    .map((i) => ({
      produtoId: Number(i.produtoId != null ? i.produtoId : i.produto_id),
      quantidade: roundStockQuantity(i.quantidade),
      unidade: i.unidade != null ? String(i.unidade).trim().toUpperCase() : null
    }))
    .filter((i) => Number.isInteger(i.produtoId) && i.produtoId > 0 && i.quantidade > 0)
    .sort((a, b) => a.produtoId - b.produtoId || String(a.unidade || '').localeCompare(String(b.unidade || '')));
  return crypto.createHash('sha256').update(JSON.stringify(normalizado)).digest('hex');
}

function normalizarItensEntrada(itens) {
  const out = [];
  for (const raw of itens || []) {
    const produtoId = Number(raw.produtoId != null ? raw.produtoId : raw.produto_id);
    const quantidade = Number(raw.quantidade);
    if (!Number.isInteger(produtoId) || produtoId <= 0) continue;
    if (!(quantidade > 0)) continue;
    out.push({
      produtoId,
      quantidade: roundStockQuantity(quantidade),
      unidade: raw.unidade != null ? String(raw.unidade).trim() : undefined,
      produto_id: produtoId
    });
  }
  return out;
}

function lerDisponivel(disp, tipoSaldo) {
  if (!disp) return 0;
  if (!produtoControlaEstoque(disp)) return Number.POSITIVE_INFINITY;
  if (tipoSaldo === TipoSaldo.NAO_FISCAL) {
    return roundStockQuantity(disp.disponivel_nao_fiscal);
  }
  return roundStockQuantity(disp.disponivel_fiscal);
}

/**
 * @param {object} entrada
 * @param {object} [deps]
 */
async function avaliarCapacidadeCarrinho(entrada = {}, deps = {}) {
  const db = getDb(deps.db || entrada.db);
  const itens = normalizarItensEntrada(entrada.itens);
  const tipoSaldo = normalizarTipoSaldo(entrada.tipoSaldo || TipoSaldo.FISCAL) || TipoSaldo.FISCAL;
  const exigirFiscalValido = entrada.exigirFiscalValido === true;
  const modo = String(entrada.modoOperacional || deps.modoOperacional || 'MULTIEMPRESA').toUpperCase();

  const meta = {
    consultadoEm: new Date().toISOString(),
    hashCarrinho: hashCarrinho(itens),
    aviso: 'CONSULTA_NAO_RESERVA',
    tipoSaldo
  };

  if (modo === 'EMPRESA_SIMPLES' || modo === 'EMPRESA_UNICA') {
    const bloqueio = {
      codigo: CODIGOS_BLOQUEIO.SELETOR_AUTOMATICO_NAO_APLICA,
      mensagem: 'Seleção automática matriz→filiais não se aplica em EMPRESA_SIMPLES.'
    };
    return {
      matrizId: null,
      ordemAvaliacao: [],
      porEmpresa: [],
      selecionada: null,
      bloqueio,
      meta
    };
  }

  if (!itens.length) {
    const bloqueio = {
      codigo: CODIGOS_BLOQUEIO.CARRINHO_INVALIDO,
      mensagem: 'Carrinho vazio ou sem itens válidos.'
    };
    return {
      matrizId: null,
      ordemAvaliacao: [],
      porEmpresa: [],
      selecionada: null,
      bloqueio,
      meta
    };
  }

  const listarEmpresas = deps.listarEmpresasAtivas
    || (async () => dbAll(
      db,
      `SELECT id, cnpj, razao_social, nome_fantasia, ativo
       FROM empresas
       WHERE COALESCE(ativo, 1) = 1
       ORDER BY id ASC`
    ));

  const empresasAtivas = await listarEmpresas({ db });
  const matrizRes = escolherMatrizPadrao(empresasAtivas, {
    empresaOperacionalId: entrada.empresaOperacionalId != null
      ? entrada.empresaOperacionalId
      : deps.empresaOperacionalId
  });

  if (matrizRes.codigo === 'MATRIZ_AMBIGUA') {
    const bloqueio = {
      codigo: CODIGOS_BLOQUEIO.MATRIZ_AMBIGUA,
      mensagem: 'Mais de uma matriz ativa (CNPJ 0001) sem desempate configurado — seleção automática bloqueada.'
    };
    return {
      matrizId: null,
      ordemAvaliacao: [],
      porEmpresa: [],
      selecionada: null,
      bloqueio,
      meta: { ...meta, candidatasMatriz: matrizRes.candidatas || [] }
    };
  }

  const matrizId = matrizRes.empresa ? Number(matrizRes.empresa.id) : null;

  let permitidas = null;
  if (typeof deps.listarEmpresasPermitidasIds === 'function') {
    permitidas = new Set(
      (await deps.listarEmpresasPermitidasIds({
        usuarioId: entrada.usuarioId,
        db
      })).map(Number)
    );
  } else if (entrada.usuarioId != null && deps.usarAutorizacaoUsuario !== false) {
    try {
      const UsuarioEmpresaService = deps.UsuarioEmpresaService
        || require('../../../services/empresas/UsuarioEmpresaService');
      const lista = await UsuarioEmpresaService.listarEmpresasPermitidas(entrada.usuarioId, { db });
      permitidas = new Set((lista || []).map((e) => Number(e.id != null ? e.id : e.empresa_id)));
    } catch (_) {
      permitidas = null;
    }
  }

  const verificarFiscal = typeof deps.verificarFiscalValido === 'function'
    ? deps.verificarFiscalValido
    : async () => true;

  const consultarDisp = deps.consultarDisponibilidade
    || require('../../../services/fiscalNaoFiscal/reservasPublico').consultarDisponibilidade;

  const FichaTecnicaService = deps.FichaTecnicaService
    || require('../../../services/produtos/FichaTecnicaService');
  const {
    montarLinhasConsumo,
    agregarPorInsumo
  } = deps.FichaTecnicaConsumoService
    || require('../../../services/produtos/FichaTecnicaConsumoService');

  const candidatas = [];
  for (const emp of empresasAtivas || []) {
    const empresaId = Number(emp.id);
    if (!Number.isInteger(empresaId) || empresaId <= 0) continue;
    const tipo = classificarTipoEmpresa(emp.cnpj) || 'FILIAL';
    candidatas.push({ empresaId, tipo, emp });
  }

  candidatas.sort((a, b) => {
    if (matrizId != null) {
      if (a.empresaId === matrizId && b.empresaId !== matrizId) return -1;
      if (b.empresaId === matrizId && a.empresaId !== matrizId) return 1;
    }
    return a.empresaId - b.empresaId;
  });

  const ordemAvaliacao = candidatas.map((c) => c.empresaId);
  const porEmpresa = [];

  for (const cand of candidatas) {
    const { empresaId, tipo } = cand;
    const motivosInelegibilidade = [];
    let elegivel = true;

    if (permitidas && !permitidas.has(empresaId)) {
      elegivel = false;
      motivosInelegibilidade.push('SEM_ACESSO');
    }

    if (exigirFiscalValido) {
      const okFiscal = await verificarFiscal({ empresaId, db });
      if (!okFiscal) {
        elegivel = false;
        motivosInelegibilidade.push('FISCAL_INVALIDO');
      }
    }

    const gargalos = [];
    const capacidadeMaximaPorItem = [];
    let atendeIntegralmente = elegivel;

    if (!elegivel) {
      porEmpresa.push({
        empresaId,
        tipo,
        elegivel: false,
        atendeIntegralmente: false,
        capacidadeMaximaPorItem: [],
        gargalos: [],
        motivosInelegibilidade
      });
      continue;
    }

    for (const item of itens) {
      let produto;
      try {
        produto = await dbGet(
          db,
          `SELECT id, nome, ativo, unidade,
                  COALESCE(controla_estoque, 1) AS controla_estoque,
                  utiliza_ficha_tecnica
           FROM produtos WHERE id = ?`,
          [item.produtoId]
        );
      } catch (err) {
        atendeIntegralmente = false;
        gargalos.push({
          produtoId: item.produtoId,
          necessario: item.quantidade,
          disponivel: 0,
          unidade: item.unidade || null,
          codigoMotivo: 'ERRO_CONSULTA_PRODUTO',
          detalhe: err.message
        });
        continue;
      }

      if (!produto || Number(produto.ativo) === 0) {
        atendeIntegralmente = false;
        gargalos.push({
          produtoId: item.produtoId,
          necessario: item.quantidade,
          disponivel: 0,
          unidade: item.unidade || null,
          codigoMotivo: 'PRODUTO_INDISPONIVEL'
        });
        capacidadeMaximaPorItem.push({ produtoId: item.produtoId, maxima: 0 });
        continue;
      }

      let usaFicha = false;
      try {
        const uso = await FichaTecnicaService.consultarUsoFichaTecnica(item.produtoId, { db });
        usaFicha = Boolean(uso && uso.utiliza_ficha_tecnica);
      } catch (_) {
        usaFicha = Number(produto.utiliza_ficha_tecnica) === 1;
      }

      if (usaFicha) {
        let linhas;
        try {
          linhas = await montarLinhasConsumo(
            [{ produto_id: item.produtoId, quantidade: item.quantidade }],
            db
          );
        } catch (err) {
          atendeIntegralmente = false;
          gargalos.push({
            produtoId: item.produtoId,
            necessario: item.quantidade,
            disponivel: 0,
            unidade: item.unidade || produto.unidade || null,
            codigoMotivo: err.code || 'FICHA_INVALIDA',
            detalhe: err.message
          });
          capacidadeMaximaPorItem.push({ produtoId: item.produtoId, maxima: 0 });
          continue;
        }

        if (!linhas.length) {
          // Ficha marcada mas sem linhas (legado vazio): não restringe por insumo.
          capacidadeMaximaPorItem.push({
            produtoId: item.produtoId,
            maxima: null
          });
          continue;
        }

        const agregadas = agregarPorInsumo(linhas);
        let maximaItem = Number.POSITIVE_INFINITY;

        for (const linha of agregadas) {
          const disp = await consultarDisp(linha.insumo_id, {
            db,
            empresaId,
            modoLegadoSemEmpresa: false
          });
          const disponivel = lerDisponivel(disp, tipoSaldo);
          const necessario = roundStockQuantity(linha.quantidade);
          if (!(disponivel + 1e-9 >= necessario)) {
            atendeIntegralmente = false;
            gargalos.push({
              produtoId: item.produtoId,
              insumoId: Number(linha.insumo_id),
              necessario,
              disponivel: Number.isFinite(disponivel) ? disponivel : null,
              unidade: linha.unidade || null,
              codigoMotivo: 'INSUMO_INSUFICIENTE'
            });
          }

          let linhasUnit;
          try {
            linhasUnit = await montarLinhasConsumo(
              [{ produto_id: item.produtoId, quantidade: 1 }],
              db
            );
          } catch (_) {
            linhasUnit = [];
          }
          const unitAg = agregarPorInsumo(linhasUnit).find(
            (l) => Number(l.insumo_id) === Number(linha.insumo_id)
          );
          const needUnit = unitAg ? roundStockQuantity(unitAg.quantidade) : necessario;
          if (needUnit > 0 && Number.isFinite(disponivel)) {
            const maxPorInsumo = Math.floor((disponivel + 1e-12) / needUnit);
            if (maxPorInsumo < maximaItem) maximaItem = maxPorInsumo;
          }
        }

        capacidadeMaximaPorItem.push({
          produtoId: item.produtoId,
          maxima: Number.isFinite(maximaItem) ? maximaItem : null
        });
        continue;
      }

      // Sem ficha: saldo do próprio produto (D-08).
      if (!produtoControlaEstoque(produto)) {
        capacidadeMaximaPorItem.push({ produtoId: item.produtoId, maxima: null });
        continue;
      }

      const dispProd = await consultarDisp(item.produtoId, {
        db,
        empresaId,
        modoLegadoSemEmpresa: false
      });
      const disponivel = lerDisponivel(dispProd, tipoSaldo);
      const necessario = item.quantidade;
      if (!(disponivel + 1e-9 >= necessario)) {
        atendeIntegralmente = false;
        gargalos.push({
          produtoId: item.produtoId,
          necessario,
          disponivel: Number.isFinite(disponivel) ? disponivel : null,
          unidade: item.unidade || produto.unidade || null,
          codigoMotivo: 'ESTOQUE_INSUFICIENTE'
        });
      }
      capacidadeMaximaPorItem.push({
        produtoId: item.produtoId,
        maxima: Number.isFinite(disponivel) ? Math.floor(disponivel + 1e-12) : null
      });
    }

    porEmpresa.push({
      empresaId,
      tipo,
      elegivel: true,
      atendeIntegralmente,
      capacidadeMaximaPorItem,
      gargalos,
      motivosInelegibilidade: []
    });
  }

  const decisao = selecionarEmpresaCapacidade({
    matrizId,
    ordemAvaliacao,
    porEmpresa
  });

  return {
    matrizId,
    ordemAvaliacao,
    porEmpresa,
    selecionada: decisao.selecionada,
    bloqueio: decisao.bloqueio,
    meta
  };
}

module.exports = {
  avaliarCapacidadeCarrinho,
  hashCarrinho,
  selecionarEmpresaCapacidade,
  CODIGOS_BLOQUEIO
};
