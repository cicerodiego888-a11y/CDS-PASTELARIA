/**
 * Capacidade do carrinho por empresa — somente leitura (MUV-CAP-01 / SPEC-MUV-02).
 * Não cria reserva, venda, financeiro nem documento fiscal.
 *
 * @module motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa
 */
'use strict';

const crypto = require('crypto');
const { roundStockQuantity } = require('../../../services/estoque/quantityPrecision');
const {
  produtoControlaEstoque,
  produtoExigeValidacaoSaldoProprio
} = require('../../../services/estoque/produtoControlaEstoque');
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
    .map((i) => {
      const produtoId = Number(i.produtoId != null ? i.produtoId : i.produto_id);
      const qF = i.quantidadeFiscal != null
        ? Number(i.quantidadeFiscal)
        : (i.quantidade_fiscal != null ? Number(i.quantidade_fiscal) : null);
      const qNf = i.quantidadeNaoFiscal != null
        ? Number(i.quantidadeNaoFiscal)
        : (i.quantidade_nao_fiscal != null ? Number(i.quantidade_nao_fiscal) : null);
      const tipoRaw = i.tipoSaldo != null ? i.tipoSaldo : i.tipo_saldo;
      return {
        produtoId,
        quantidade: roundStockQuantity(i.quantidade),
        unidade: i.unidade != null ? String(i.unidade).trim().toUpperCase() : null,
        tipoSaldo: tipoRaw != null && tipoRaw !== '' ? String(tipoRaw).toUpperCase() : null,
        quantidadeFiscal: qF != null && Number.isFinite(qF) ? roundStockQuantity(qF) : null,
        quantidadeNaoFiscal: qNf != null && Number.isFinite(qNf) ? roundStockQuantity(qNf) : null
      };
    })
    .filter((i) => Number.isInteger(i.produtoId) && i.produtoId > 0 && i.quantidade > 0)
    .sort((a, b) => a.produtoId - b.produtoId || String(a.unidade || '').localeCompare(String(b.unidade || '')));
  return crypto.createHash('sha256').update(JSON.stringify(normalizado)).digest('hex');
}

function lerQuantidadeOpcional(raw, ...chaves) {
  for (const chave of chaves) {
    if (raw[chave] != null && raw[chave] !== '') {
      const n = Number(raw[chave]);
      if (Number.isFinite(n)) return roundStockQuantity(n);
    }
  }
  return null;
}

/**
 * Requisito de estoque por item (PDV-MULTIEMPRESA-04).
 * - SPLIT: quantidade_fiscal + quantidade_nao_fiscal explícitas (pós Motor / contrato rico).
 * - UNICO: tipoSaldo do item, senão o da operação (compatível SEL-01/R08).
 * Não usa item_fiscal sozinho: no contrato atual ele indica natureza do SKU, não o bucket de baixa.
 */
function resolverRequisitoEstoqueItem(item, tipoSaldoOperacao) {
  const qF = lerQuantidadeOpcional(item, 'quantidadeFiscal', 'quantidade_fiscal');
  const qNf = lerQuantidadeOpcional(item, 'quantidadeNaoFiscal', 'quantidade_nao_fiscal');
  const temSplit = qF != null || qNf != null;
  if (temSplit) {
    return {
      modo: 'SPLIT',
      quantidadeFiscal: Math.max(0, qF != null ? qF : 0),
      quantidadeNaoFiscal: Math.max(0, qNf != null ? qNf : 0)
    };
  }

  let tipoItem = null;
  const rawTipo = item.tipoSaldo != null ? item.tipoSaldo : item.tipo_saldo;
  if (rawTipo != null && rawTipo !== '') {
    try {
      tipoItem = normalizarTipoSaldo(rawTipo);
    } catch (_) {
      tipoItem = null;
    }
  }
  return {
    modo: 'UNICO',
    tipoSaldo: tipoItem || tipoSaldoOperacao,
    quantidade: item.quantidade
  };
}

function normalizarItensEntrada(itens) {
  const out = [];
  for (const raw of itens || []) {
    const produtoId = Number(raw.produtoId != null ? raw.produtoId : raw.produto_id);
    const quantidade = Number(raw.quantidade);
    if (!Number.isInteger(produtoId) || produtoId <= 0) continue;
    if (!(quantidade > 0)) continue;
    const qF = lerQuantidadeOpcional(raw, 'quantidadeFiscal', 'quantidade_fiscal');
    const qNf = lerQuantidadeOpcional(raw, 'quantidadeNaoFiscal', 'quantidade_nao_fiscal');
    const tipoRaw = raw.tipoSaldo != null ? raw.tipoSaldo : raw.tipo_saldo;
    out.push({
      produtoId,
      quantidade: roundStockQuantity(quantidade),
      unidade: raw.unidade != null ? String(raw.unidade).trim() : undefined,
      produto_id: produtoId,
      tipoSaldo: tipoRaw != null && tipoRaw !== '' ? tipoRaw : undefined,
      tipo_saldo: tipoRaw != null && tipoRaw !== '' ? tipoRaw : undefined,
      quantidadeFiscal: qF,
      quantidade_fiscal: qF,
      quantidadeNaoFiscal: qNf,
      quantidade_nao_fiscal: qNf,
      item_fiscal: raw.item_fiscal != null ? raw.item_fiscal : raw.itemFiscal
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
 * Ficha técnica (consumo real em FichaTecnicaConsumoService.validarEstoqueAgregado):
 * valida e debita com saldo_fiscal + saldo_nao_fiscal (fiscal primeiro).
 * A capacidade dos insumos deve usar a mesma base — não um único tipoSaldo da emissão.
 */
function lerDisponivelFichaInsumo(disp) {
  if (!disp) return null;
  if (!produtoControlaEstoque(disp)) return Number.POSITIVE_INFINITY;
  return roundStockQuantity(
    Number(disp.disponivel_fiscal || 0) + Number(disp.disponivel_nao_fiscal || 0)
  );
}

async function consultarDisponivelSeguro(consultarDisp, produtoId, empresaId, db) {
  try {
    const disp = await consultarDisp(produtoId, {
      db,
      empresaId,
      modoLegadoSemEmpresa: false
    });
    if (!disp) {
      const err = new Error(`Disponibilidade ausente para produto ${produtoId} na empresa ${empresaId}.`);
      err.code = 'ERRO_CONSULTA_DISPONIBILIDADE';
      throw err;
    }
    return { ok: true, disp };
  } catch (err) {
    return {
      ok: false,
      codigo: err && err.code ? err.code : 'ERRO_CONSULTA_DISPONIBILIDADE',
      detalhe: err && err.message ? err.message : String(err)
    };
  }
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

  const requisitosPorItem = itens.map((item) => ({
    produtoId: item.produtoId,
    requisito: resolverRequisitoEstoqueItem(item, tipoSaldo)
  }));

  const meta = {
    consultadoEm: new Date().toISOString(),
    hashCarrinho: hashCarrinho(itens),
    aviso: 'CONSULTA_NAO_RESERVA',
    tipoSaldo,
    requisitosPorItem: requisitosPorItem.map((r) => ({
      produtoId: r.produtoId,
      modo: r.requisito.modo,
      tipoSaldo: r.requisito.tipoSaldo || null,
      quantidadeFiscal: r.requisito.quantidadeFiscal != null ? r.requisito.quantidadeFiscal : null,
      quantidadeNaoFiscal: r.requisito.quantidadeNaoFiscal != null ? r.requisito.quantidadeNaoFiscal : null
    }))
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

  // R04 / PDV-SEL-01: exige matriz real (CNPJ 0001). Não promove filial única a matriz.
  const origemMatrizOk = matrizRes.origem === 'MATRIZ_CNPJ_0001'
    || matrizRes.origem === 'MATRIZ_EMPRESA_OPERACIONAL_ID';
  if (
    !matrizRes.empresa
    || !origemMatrizOk
    || matrizRes.codigo === 'MATRIZ_AUSENTE'
    || matrizRes.codigo === 'EMPRESA_AUSENTE'
  ) {
    const bloqueio = {
      codigo: CODIGOS_BLOQUEIO.MATRIZ_AUSENTE,
      mensagem: 'Nenhuma matriz ativa (CNPJ 0001) configurada — selecione/corrija a configuração antes de vender.'
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

  const matrizId = Number(matrizRes.empresa.id);

  let permitidas = null;
  // Preferir objeto req.user (perfil/role) — ID numérico sozinho não ativa admin operacional.
  const sujeitoUsuario = entrada.usuario != null
    ? entrada.usuario
    : (entrada.user != null ? entrada.user : entrada.usuarioId);
  if (typeof deps.listarEmpresasPermitidasIds === 'function') {
    permitidas = new Set(
      (await deps.listarEmpresasPermitidasIds({
        usuarioId: entrada.usuarioId,
        usuario: sujeitoUsuario,
        db
      })).map(Number)
    );
  } else if (sujeitoUsuario != null && deps.usarAutorizacaoUsuario !== false) {
    try {
      const UsuarioEmpresaService = deps.UsuarioEmpresaService
        || require('../../../services/empresas/UsuarioEmpresaService');
      const lista = await UsuarioEmpresaService.listarEmpresasPermitidas(sujeitoUsuario, {
        db,
        user: typeof sujeitoUsuario === 'object' ? sujeitoUsuario : undefined
      });
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
                  COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional,
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
          const consulta = await consultarDisponivelSeguro(
            consultarDisp,
            linha.insumo_id,
            empresaId,
            db
          );
          if (!consulta.ok) {
            atendeIntegralmente = false;
            gargalos.push({
              produtoId: item.produtoId,
              insumoId: Number(linha.insumo_id),
              necessario: roundStockQuantity(linha.quantidade),
              disponivel: null,
              unidade: linha.unidade || null,
              codigoMotivo: consulta.codigo || 'ERRO_CONSULTA_DISPONIBILIDADE',
              detalhe: consulta.detalhe
            });
            continue;
          }

          const disponivel = lerDisponivelFichaInsumo(consulta.disp);
          const necessario = roundStockQuantity(linha.quantidade);
          if (disponivel == null) {
            atendeIntegralmente = false;
            gargalos.push({
              produtoId: item.produtoId,
              insumoId: Number(linha.insumo_id),
              necessario,
              disponivel: null,
              unidade: linha.unidade || null,
              codigoMotivo: 'ERRO_CONSULTA_DISPONIBILIDADE',
              detalhe: 'Consulta de disponibilidade retornou vazio.'
            });
            continue;
          }
          if (!(disponivel + 1e-9 >= necessario)) {
            atendeIntegralmente = false;
            gargalos.push({
              produtoId: item.produtoId,
              insumoId: Number(linha.insumo_id),
              necessario,
              disponivel: Number.isFinite(disponivel) ? disponivel : null,
              disponivel_fiscal: Number(consulta.disp.disponivel_fiscal || 0),
              disponivel_nao_fiscal: Number(consulta.disp.disponivel_nao_fiscal || 0),
              baseConsulta: 'TOTAL_FICHA',
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

      // Sem ficha: saldo do próprio produto (D-08) — só INSUMO / quem exige saldo próprio.
      // CDS-PDV-ESTOQUE-PRODUTOS-COMERCIAIS-FISCAIS-01: comercial não valida saldo próprio.
      if (!produtoExigeValidacaoSaldoProprio(produto)) {
        capacidadeMaximaPorItem.push({ produtoId: item.produtoId, maxima: null });
        continue;
      }

      const consultaProd = await consultarDisponivelSeguro(
        consultarDisp,
        item.produtoId,
        empresaId,
        db
      );
      if (!consultaProd.ok) {
        atendeIntegralmente = false;
        gargalos.push({
          produtoId: item.produtoId,
          necessario: item.quantidade,
          disponivel: null,
          unidade: item.unidade || produto.unidade || null,
          codigoMotivo: consultaProd.codigo || 'ERRO_CONSULTA_DISPONIBILIDADE',
          detalhe: consultaProd.detalhe
        });
        capacidadeMaximaPorItem.push({ produtoId: item.produtoId, maxima: 0 });
        continue;
      }
      const requisito = resolverRequisitoEstoqueItem(item, tipoSaldo);
      const unidadeItem = item.unidade || produto.unidade || null;

      if (requisito.modo === 'SPLIT') {
        const dispF = lerDisponivel(consultaProd.disp, TipoSaldo.FISCAL);
        const dispNf = lerDisponivel(consultaProd.disp, TipoSaldo.NAO_FISCAL);
        let ok = true;
        if (requisito.quantidadeFiscal > 0 && !(dispF + 1e-9 >= requisito.quantidadeFiscal)) {
          ok = false;
          atendeIntegralmente = false;
          gargalos.push({
            produtoId: item.produtoId,
            necessario: requisito.quantidadeFiscal,
            disponivel: Number.isFinite(dispF) ? dispF : null,
            tipoSaldo: TipoSaldo.FISCAL,
            unidade: unidadeItem,
            codigoMotivo: 'ESTOQUE_INSUFICIENTE_FISCAL'
          });
        }
        if (requisito.quantidadeNaoFiscal > 0 && !(dispNf + 1e-9 >= requisito.quantidadeNaoFiscal)) {
          ok = false;
          atendeIntegralmente = false;
          gargalos.push({
            produtoId: item.produtoId,
            necessario: requisito.quantidadeNaoFiscal,
            disponivel: Number.isFinite(dispNf) ? dispNf : null,
            tipoSaldo: TipoSaldo.NAO_FISCAL,
            unidade: unidadeItem,
            codigoMotivo: 'ESTOQUE_INSUFICIENTE_NAO_FISCAL'
          });
        }
        let maximaSplit = Number.POSITIVE_INFINITY;
        const qtdLinha = item.quantidade > 0 ? item.quantidade : 1;
        if (requisito.quantidadeFiscal > 0 && Number.isFinite(dispF)) {
          const needPerUnit = requisito.quantidadeFiscal / qtdLinha;
          maximaSplit = Math.min(maximaSplit, Math.floor((dispF + 1e-12) / needPerUnit));
        }
        if (requisito.quantidadeNaoFiscal > 0 && Number.isFinite(dispNf)) {
          const needPerUnit = requisito.quantidadeNaoFiscal / qtdLinha;
          maximaSplit = Math.min(maximaSplit, Math.floor((dispNf + 1e-12) / needPerUnit));
        }
        if (!ok && !Number.isFinite(maximaSplit)) maximaSplit = 0;
        capacidadeMaximaPorItem.push({
          produtoId: item.produtoId,
          maxima: Number.isFinite(maximaSplit) ? Math.max(0, maximaSplit) : (ok ? null : 0)
        });
        continue;
      }

      const tipoItem = requisito.tipoSaldo;
      const disponivel = lerDisponivel(consultaProd.disp, tipoItem);
      const necessario = requisito.quantidade;
      if (!(disponivel + 1e-9 >= necessario)) {
        atendeIntegralmente = false;
        const codigoMotivo = tipoItem === TipoSaldo.NAO_FISCAL
          ? 'ESTOQUE_INSUFICIENTE_NAO_FISCAL'
          : 'ESTOQUE_INSUFICIENTE_FISCAL';
        gargalos.push({
          produtoId: item.produtoId,
          necessario,
          disponivel: Number.isFinite(disponivel) ? disponivel : null,
          tipoSaldo: tipoItem,
          unidade: unidadeItem,
          // Mantém ESTOQUE_INSUFICIENTE como alias semântico nos testes/contratos legados.
          codigoMotivo,
          codigoMotivoLegado: 'ESTOQUE_INSUFICIENTE'
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
  resolverRequisitoEstoqueItem,
  lerDisponivel,
  lerDisponivelFichaInsumo,
  CODIGOS_BLOQUEIO
};
