/**
 * Porta oficial do PDV Universal (Sprint 05.01).
 * Orquestra modo + contexto. Não duplica estoque, pagamento, fiscal ou TEF.
 */
'use strict';

const { resolverModoOperacaoVendaAtivo, executarNoModoOperacaoVenda } = require('../muv/modoOperacaoVenda');
const EmpresaUnicaAdapter = require('./adaptadores/EmpresaUnicaAdapter');
const MultiempresaAdapter = require('./adaptadores/MultiempresaAdapter');
const { ModoOperacaoVenda } = require('../muv/contratos');
const contextoService = require('../../services/pdv-universal/PDVUniversalContextService');
const disponibilidadeService = require('../../services/pdv-universal/PDVUniversalDisponibilidadeService');
const vendaAdapter = require('../../services/pdv-universal/PDVUniversalVendaAdapter');
const atendimentoAdapter = require('../../services/pdv-universal/PDVUniversalAtendimentoAdapter');

const idempotenciaCheckout = new Map();

function capturarRespostaCriarVenda(criarVendaFn, req, deps) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = Number(code) || 200;
        return this;
      },
      json(body) {
        if (settled) return body;
        settled = true;
        if (this.statusCode >= 400) {
          const err = new Error((body && (body.error || body.mensagem)) || 'Erro no checkout.');
          err.code = (body && (body.code || body.codigo)) || 'ERRO_CHECKOUT';
          err.statusCode = this.statusCode;
          err.body = body;
          reject(err);
        } else {
          resolve(body);
        }
        return body;
      }
    };
    Promise.resolve(criarVendaFn(req, res, deps)).catch((err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function resolverModoOficial(deps = {}) {
  return resolverModoOperacaoVendaAtivo(deps);
}

function despacharPorModo(deps, executores) {
  const modo = resolverModoOficial(deps);
  return executarNoModoOperacaoVenda(modo, executores);
}

async function obterContexto(entrada = {}, deps = {}) {
  return contextoService.obterContextoOperacional(entrada, deps);
}

async function selecionarEmpresa(fonte, entrada = {}, deps = {}) {
  return contextoService.selecionarEmpresaOperacional(fonte, entrada, deps);
}

async function consultarDisponibilidadeProduto(produtoId, entrada = {}, deps = {}) {
  return disponibilidadeService.consultarDisponibilidadeProduto(produtoId, entrada, deps);
}

async function finalizarCheckoutMultiempresa(entrada = {}, deps = {}) {
  const chave = entrada.idempotency_key || entrada.idempotencyKey;
  if (chave && idempotenciaCheckout.has(String(chave))) {
    return idempotenciaCheckout.get(String(chave));
  }
  const itens = atendimentoAdapter.montarItensAtendimento(entrada.itens || []);
  const criar = deps.criarAtendimento
    || ((dados, d) => {
      const svc = deps.AtendimentoMultiempresaService
        || require('../muv/AtendimentoMultiempresaService');
      return svc.criarAtendimento(dados, d);
    });
  const preview = await criar({ origem: 'PDV', itens }, deps);
  const normalizado = atendimentoAdapter.normalizarRespostaAtendimento(preview);
  if (chave) idempotenciaCheckout.set(String(chave), normalizado);
  return normalizado;
}

async function finalizarCheckout(entrada = {}, deps = {}) {
  const modo = resolverModoOficial(deps);
  if (modo === ModoOperacaoVenda.MULTIEMPRESA) {
    return finalizarCheckoutMultiempresa(entrada, deps);
  }
  if (modo !== ModoOperacaoVenda.EMPRESA_UNICA) {
    const err = new Error('Checkout exige modo EMPRESA_UNICA.');
    err.code = 'MODO_OPERACAO_VENDA_INVALIDO';
    err.statusCode = 400;
    throw err;
  }

  const contexto = await obterContexto(entrada, deps);
  const empresaId = contexto.empresa_selecionada && contexto.empresa_selecionada.id;
  vendaAdapter.validarCarrinhoEmpresaUnica(entrada.itens || [], empresaId);

  const chave = entrada.idempotency_key || entrada.idempotencyKey;
  if (chave && idempotenciaCheckout.has(String(chave))) {
    return idempotenciaCheckout.get(String(chave));
  }

  const payload = vendaAdapter.montarPayloadVendaOficial({
    itens: entrada.itens,
    pagamentos: entrada.pagamentos,
    emitir_fiscal: entrada.emitir_fiscal,
    origem: 'PDV'
  });

  const req = {
    body: payload,
    user: entrada.user || (entrada.req && entrada.req.user),
    headers: (entrada.req && entrada.req.headers) || {},
    empresaId,
    query: {}
  };

  const criar = deps.criarVenda
    || ((r, s, d) => EmpresaUnicaAdapter.criarVenda(r, s, d));
  const nucleo = await capturarRespostaCriarVenda(criar, req, deps);
  const normalizado = vendaAdapter.normalizarRespostaNucleo(nucleo);
  if (chave) {
    idempotenciaCheckout.set(String(chave), normalizado);
  }
  return normalizado;
}

function erroPdv(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function exigirModoMultiempresa(deps = {}) {
  const modo = resolverModoOficial(deps);
  if (modo !== ModoOperacaoVenda.MULTIEMPRESA) {
    throw erroPdv(
      'OPERACAO_EXCLUSIVA_MULTIEMPRESA',
      'Reserva e pagamento unificado existem somente no modo MULTIEMPRESA.',
      409
    );
  }
  return modo;
}

function resolverMuv(deps = {}) {
  return deps.AtendimentoMultiempresaService
    || require('../muv/AtendimentoMultiempresaService');
}

function exigirAtendimentoId(valor) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroPdv('ATENDIMENTO_INVALIDO', 'atendimento_id inválido.', 400);
  }
  return id;
}

function normalizarRespostaMuv(preview, extra = {}) {
  const id = preview.atendimentoId || preview.atendimento_id;
  return {
    sucesso: true,
    modo_operacao_venda: 'MULTIEMPRESA',
    modo: 'MULTIEMPRESA',
    atendimento_id: id,
    atendimento: {
      id,
      codigo: preview.codigo,
      status: preview.status
    },
    operacoes: preview.operacoes || [],
    pagamento_pendente: preview.pagamento_pendente !== false
      && preview.status !== 'PAGO',
    venda_concluida: false,
    materializado: false,
    fiscalizado: false,
    idempotente: !!preview.idempotente,
    ...extra
  };
}

async function reservarAtendimentoPdv(atendimentoId, deps = {}) {
  exigirModoMultiempresa(deps);
  const id = exigirAtendimentoId(atendimentoId);
  const preview = await (deps.reservarAtendimento
    || ((aid, d) => resolverMuv(d).reservarAtendimento(aid, d)))(id, deps);
  return normalizarRespostaMuv(preview);
}

async function confirmarPagamentoPdv(atendimentoId, entrada = {}, deps = {}) {
  exigirModoMultiempresa(deps);
  const id = exigirAtendimentoId(atendimentoId);
  const preview = await (deps.confirmarPagamentoAtendimento
    || ((aid, e, d) => resolverMuv(d).confirmarPagamentoAtendimento(aid, e, d)))(
    id,
    {
      pagamentos: entrada.pagamentos,
      estrategia: entrada.estrategia_rateio || entrada.estrategia || 'POR_ITEM',
      idempotency_key: entrada.idempotency_key || entrada.idempotencyKey
    },
    deps
  );
  return normalizarRespostaMuv(preview, {
    pagamento_pendente: false,
    proxima_etapa: 'MATERIALIZACAO'
  });
}

async function cancelarAtendimentoPdv(atendimentoId, deps = {}) {
  exigirModoMultiempresa(deps);
  const id = exigirAtendimentoId(atendimentoId);
  const preview = await (deps.cancelarAtendimento
    || ((aid, d) => resolverMuv(d).cancelarAtendimento(aid, d)))(id, deps);
  return normalizarRespostaMuv(preview);
}

async function materializarAtendimentoPdv(atendimentoId, entrada = {}, deps = {}) {
  exigirModoMultiempresa(deps);
  const id = exigirAtendimentoId(atendimentoId);
  const preview = await (deps.materializarAtendimento
    || ((aid, e, d) => resolverMuv(d).materializarAtendimento(aid, e, d)))(
    id,
    { idempotency_key: entrada.idempotency_key || entrada.idempotencyKey },
    deps
  );
  return normalizarRespostaMuv(preview, {
    pagamento_pendente: false,
    venda_concluida: preview.venda_concluida !== false,
    materializado: true,
    fiscalizado: false,
    vendas: preview.vendas || [],
    proxima_etapa: 'FISCALIZACAO'
  });
}

async function fiscalizarAtendimentoPdv(atendimentoId, deps = {}) {
  exigirModoMultiempresa(deps);
  const id = exigirAtendimentoId(atendimentoId);
  const fiscalizar = deps.fiscalizarAtendimento
    || ((aid, d) => {
      const svc = d.FiscalizarAtendimentoService
        || require('../muv/FiscalizarAtendimentoService');
      return svc.fiscalizarAtendimento(aid, d);
    });
  const preview = await fiscalizar(id, deps);
  const status = preview.status || (preview.atendimento && preview.atendimento.status);
  return {
    sucesso: true,
    modo_operacao_venda: 'MULTIEMPRESA',
    modo: 'MULTIEMPRESA',
    atendimento_id: preview.atendimento_id || id,
    atendimento: {
      id: preview.atendimento_id || id,
      codigo: preview.codigo || (preview.atendimento && preview.atendimento.codigo),
      status
    },
    documentos: preview.documentos || [],
    comprovante: preview.comprovante || null,
    pagamento_pendente: false,
    venda_concluida: true,
    materializado: true,
    fiscalizado: status === 'FISCALIZADO',
    fiscal_parcial: status === 'FISCAL_PARCIAL',
    proxima_etapa: 'COMPROVANTE'
  };
}

async function obterComprovantePdv(atendimentoId, deps = {}) {
  exigirModoMultiempresa(deps);
  const id = exigirAtendimentoId(atendimentoId);
  const obter = deps.obterComprovanteUnificado
    || ((aid, d) => {
      const svc = d.ComprovanteUnificadoAtendimentoService
        || require('../muv/ComprovanteUnificadoAtendimentoService');
      return svc.obterComprovanteUnificado(aid, d);
    });
  return obter(id, deps);
}

function despacharVenda(req, res, deps = {}) {
  return despacharPorModo(deps, {
    EMPRESA_UNICA() {
      return EmpresaUnicaAdapter.criarVenda(req, res, deps);
    },
    MULTIEMPRESA() {
      return MultiempresaAdapter.reconhecer(deps);
    }
  });
}

module.exports = {
  resolverModoOficial,
  despacharPorModo,
  obterContexto,
  selecionarEmpresa,
  consultarDisponibilidadeProduto,
  finalizarCheckout,
  reservarAtendimentoPdv,
  confirmarPagamentoPdv,
  cancelarAtendimentoPdv,
  materializarAtendimentoPdv,
  fiscalizarAtendimentoPdv,
  obterComprovantePdv,
  despacharVenda,
  EmpresaUnicaAdapter,
  MultiempresaAdapter
};
