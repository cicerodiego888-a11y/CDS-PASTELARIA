/**
 * PDV-SEL-01 — Integração do seletor automático de empresa ao POST /api/vendas (PDV oficial).
 * Não cria reserva; reavalia capacidade e fixa req.empresaId antes do núcleo de pagamento.
 *
 * @module services/vendas/SelecaoEmpresaVendaPdvService
 */
'use strict';

const { parseVendaFiscalFlag } = require('../distribuidorEstoqueVenda');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { VendaOrigin, resolverVendaOrigin, origemExigeCaixa } = require('./VendaOrigin');
const {
  avaliarCapacidadeCarrinho,
  hashCarrinho,
  CODIGOS_BLOQUEIO
} = require('../../motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa');
const { exigirSessaoDaEmpresa } = require('../caixa/CaixaEmpresaContextoService');

function erroSelecao(code, message, statusCode = 409, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

/**
 * R08 — tipo de saldo deve ser o mesmo que a finalização consumirá.
 * Se não for inequívoco, bloqueia (não presume padrão inseguro).
 */
function resolverTipoSaldoParaCapacidade(body = {}) {
  const temVendaFiscal = body.venda_fiscal !== undefined && body.venda_fiscal !== null && body.venda_fiscal !== '';
  const temEmitir = body.emitir_fiscal !== undefined && body.emitir_fiscal !== null && body.emitir_fiscal !== '';
  if (!temVendaFiscal && !temEmitir) {
    return { tipoSaldo: null, indeterminado: true };
  }
  const priorizarFiscal = temVendaFiscal
    ? parseVendaFiscalFlag(body.venda_fiscal)
    : parseVendaFiscalFlag(body.emitir_fiscal);
  return {
    tipoSaldo: priorizarFiscal ? TipoSaldo.FISCAL : TipoSaldo.NAO_FISCAL,
    indeterminado: false,
    exigirFiscalValido: temEmitir ? parseVendaFiscalFlag(body.emitir_fiscal) === true : false
  };
}

function extrairItensCarrinho(entrada) {
  const itens = Array.isArray(entrada.itens)
    ? entrada.itens
    : (entrada.body && Array.isArray(entrada.body.itens) ? entrada.body.itens : []);
  return itens.map((i) => ({
    produtoId: Number(i.produto_id != null ? i.produto_id : i.produtoId),
    quantidade: Number(i.quantidade),
    unidade: i.unidade,
    // Campos opcionais já existentes no contrato de venda — não inventam regra nova.
    tipoSaldo: i.tipoSaldo != null ? i.tipoSaldo : i.tipo_saldo,
    tipo_saldo: i.tipo_saldo != null ? i.tipo_saldo : i.tipoSaldo,
    quantidade_fiscal: i.quantidade_fiscal != null ? i.quantidade_fiscal : i.quantidadeFiscal,
    quantidade_nao_fiscal: i.quantidade_nao_fiscal != null ? i.quantidade_nao_fiscal : i.quantidadeNaoFiscal,
    quantidadeFiscal: i.quantidadeFiscal != null ? i.quantidadeFiscal : i.quantidade_fiscal,
    quantidadeNaoFiscal: i.quantidadeNaoFiscal != null ? i.quantidadeNaoFiscal : i.quantidade_nao_fiscal,
    item_fiscal: i.item_fiscal != null ? i.item_fiscal : i.itemFiscal
  }));
}

function montarMensagemBloqueio(capacidade) {
  const base = (capacidade && capacidade.bloqueio && capacidade.bloqueio.mensagem)
    || 'Nenhuma empresa elegível consegue atender ao pedido completo. A venda não será dividida entre CNPJs.';
  const gargalos = [];
  for (const emp of (capacidade && capacidade.porEmpresa) || []) {
    for (const g of emp.gargalos || []) {
      const pedaco = [
        g.produtoId != null ? `produto ${g.produtoId}` : null,
        g.insumoId != null ? `insumo ${g.insumoId}` : null,
        g.necessario != null ? `necessário ${g.necessario}` : null,
        g.disponivel != null ? `disponível ${g.disponivel}` : null,
        g.codigoMotivo || null
      ].filter(Boolean).join(', ');
      if (pedaco) gargalos.push(pedaco);
    }
  }
  if (!gargalos.length) return base;
  return `${base} Gargalos: ${gargalos.slice(0, 8).join('; ')}.`;
}

function aplicarEmpresaNoRequest(req, empresaId) {
  const id = Number(empresaId);
  req.empresaId = id;
  if (req.headers && typeof req.headers === 'object') {
    req.headers['x-empresa-id'] = String(id);
  }
  if (req.body && typeof req.body === 'object') {
    if (Object.prototype.hasOwnProperty.call(req.body, 'empresa_id')) {
      delete req.body.empresa_id;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'empresaId')) {
      delete req.body.empresaId;
    }
  }
  // Garante que o núcleo de pagamento não reuse resolução financeira do header antigo.
  req.__financeiroEmpresaOk = false;
  req.empresaIdVendaSelecionada = id;
}

function validarCaixaDaEmpresaSelecionada(req, empresaId, opcoes = {}) {
  if (opcoes.ignorarCaixa === true) return null;
  const sessao = req && (req.caixaSessao || req.caixa_sessao);
  if (!sessao) {
    if (opcoes.exigirCaixa === true) {
      throw erroSelecao(
        CODIGOS_BLOQUEIO.CAIXA_INCOMPATIVEL,
        'Não há caixa aberto compatível com a empresa selecionada para esta venda.',
        409,
        { empresa_id: Number(empresaId) }
      );
    }
    return null;
  }
  try {
    return exigirSessaoDaEmpresa(sessao, empresaId);
  } catch (err) {
    throw erroSelecao(
      CODIGOS_BLOQUEIO.CAIXA_INCOMPATIVEL,
      'O caixa aberto não pertence à empresa selecionada automaticamente. Abra o caixa na empresa correta; a empresa da venda não será trocada para contornar o problema.',
      409,
      { empresa_id: Number(empresaId), code_caixa: err.code }
    );
  }
}

/**
 * Avalia capacidade + política (consulta). Não persiste venda.
 */
async function avaliarSelecaoEmpresaPdv(entrada = {}, deps = {}) {
  const body = entrada.body || {};
  const itens = extrairItensCarrinho(entrada);
  const saldo = resolverTipoSaldoParaCapacidade(body);

  if (saldo.indeterminado) {
    return {
      aplicada: true,
      selecionada: null,
      bloqueio: {
        codigo: CODIGOS_BLOQUEIO.TIPO_SALDO_INDETERMINADO,
        mensagem: 'Não foi possível determinar o tipo de saldo (fiscal/não fiscal) para avaliar a capacidade. Informe emitir_fiscal ou venda_fiscal.'
      },
      capacidade: null,
      hashCarrinho: hashCarrinho(itens),
      tipoSaldo: null
    };
  }

  const capacidade = await avaliarCapacidadeCarrinho({
    itens,
    usuarioId: entrada.usuarioId,
    modoOperacional: 'MULTIEMPRESA',
    tipoSaldo: saldo.tipoSaldo,
    exigirFiscalValido: saldo.exigirFiscalValido === true,
    empresaOperacionalId: entrada.empresaOperacionalId
  }, deps);

  if (capacidade.bloqueio) {
    return {
      aplicada: true,
      selecionada: null,
      bloqueio: {
        codigo: capacidade.bloqueio.codigo,
        mensagem: montarMensagemBloqueio(capacidade)
      },
      capacidade,
      hashCarrinho: capacidade.meta && capacidade.meta.hashCarrinho,
      tipoSaldo: saldo.tipoSaldo
    };
  }

  return {
    aplicada: true,
    selecionada: capacidade.selecionada,
    bloqueio: null,
    capacidade,
    hashCarrinho: capacidade.meta && capacidade.meta.hashCarrinho,
    tipoSaldo: saldo.tipoSaldo,
    justificativa: capacidade.selecionada && capacidade.selecionada.justificativa
  };
}

/**
 * Aplica seleção no request da finalização PDV (MULTIEMPRESA).
 * Retorna { aplicada:false } quando o seletor não se aplica (origem/modo).
 */
async function aplicarSelecaoEmpresaNaVendaPdv(req, context, contract, deps = {}) {
  const origem = resolverVendaOrigin(context && context.origem);
  if (origem !== VendaOrigin.PDV) {
    return { aplicada: false, motivo: 'ORIGEM_NAO_PDV' };
  }

  const body = (req && req.body) || {};
  const itens = Array.isArray(contract && contract.itens)
    ? contract.itens
    : (Array.isArray(body.itens) ? body.itens : []);

  const usuarioId = req.user && (req.user.id != null ? req.user.id : req.user.usuario_id);
  const resultado = await avaliarSelecaoEmpresaPdv({
    body,
    itens,
    usuarioId,
    empresaOperacionalId: deps.empresaOperacionalId
  }, deps);

  if (resultado.bloqueio) {
    throw erroSelecao(
      resultado.bloqueio.codigo,
      resultado.bloqueio.mensagem,
      409,
      {
        selecao: resultado,
        gargalos: (resultado.capacidade && resultado.capacidade.porEmpresa) || []
      }
    );
  }

  const empresaId = Number(resultado.selecionada.empresaId);
  validarCaixaDaEmpresaSelecionada(req, empresaId, {
    exigirCaixa: origemExigeCaixa(origem)
  });

  // Snapshot cliente: se hash divergir, já recalculamos; se empresa divergir, servidor prevalece (R11).
  const hashCliente = body.selecao_hash || body.selecaoHash || null;
  if (hashCliente && resultado.hashCarrinho && String(hashCliente) !== String(resultado.hashCarrinho)) {
    // Recalculo já feito; apenas registra invalidação.
    resultado.snapshotInvalidado = true;
  }

  aplicarEmpresaNoRequest(req, empresaId);
  req.selecaoEmpresaPdv = {
    empresaId,
    justificativa: resultado.justificativa,
    hashCarrinho: resultado.hashCarrinho,
    tipoSaldo: resultado.tipoSaldo,
    matrizId: resultado.capacidade && resultado.capacidade.matrizId
  };

  return {
    aplicada: true,
    empresaId,
    resultado
  };
}

function responderBloqueioSelecao(res, err) {
  const status = err.statusCode || 409;
  return res.status(status).json({
    success: false,
    error: err.message,
    code: err.code || 'SELECAO_EMPRESA_BLOQUEADA',
    mensagem: err.message,
    selecao: err.selecao || null,
    gargalos: err.gargalos || null,
    empresa_id: err.empresa_id || null,
    venda_concluida: false
  });
}

module.exports = {
  avaliarSelecaoEmpresaPdv,
  aplicarSelecaoEmpresaNaVendaPdv,
  resolverTipoSaldoParaCapacidade,
  extrairItensCarrinho,
  aplicarEmpresaNoRequest,
  validarCaixaDaEmpresaSelecionada,
  montarMensagemBloqueio,
  responderBloqueioSelecao,
  hashCarrinho,
  CODIGOS_BLOQUEIO
};
