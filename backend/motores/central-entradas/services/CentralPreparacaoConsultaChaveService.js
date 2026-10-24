/**
 * Preparação offline de reconciliação por chave de acesso (consChNFe futuro).
 *
 * Não envia DistDFe, não envia consChNFe, não abre PFX, não altera NSU/cooldown,
 * não envia 210210 e não credita estoque/compra/financeiro.
 *
 * CONTRATO FUTURO (não executado aqui):
 * - Empresa, CNPJ, ambiente e certificado explícitos da empresa (sem fallback global).
 * - Reutilizar consultarNotaPorChave + persistirDocumentosRetorno existentes.
 * - Gate, mutex, cooldown, rate limiter e circuit breaker compartilhados com distNSU.
 * - Diferenciar: solicitada / enviada / resposta / persistido / erro de persistência.
 * - Idempotente: repetir a chave não duplica documento nem credita estoque.
 * - Sucesso só com persistência durável, não com aceitação interna da solicitação.
 * - consChNFe não altera ult_nsu / max_nsu / cooldown_ate.
 *
 * @module motores/central-entradas/services/CentralPreparacaoConsultaChaveService
 */

'use strict';

const crypto = require('crypto');
const { validarChaveNfeCompleta } = require('../utils/validarChaveNfe');
const { mascararCnpj, mascararChave } = require('./resolverContextoDocumentoCentral');
const { DocumentoFiscalStatus, normalizarStatus } = require('../core/DocumentoFiscalStatus');
const {
  CLASSIFICACOES_PREPARACAO_CHAVE: C,
  ACOES_FUTURAS: A
} = require('../config/preparacaoConsultaChaveClassificacoes');

const STATUS_DOCUMENTO_PERSISTIDO_COMPLETO = Object.freeze([
  DocumentoFiscalStatus.XML_COMPLETO,
  DocumentoFiscalStatus.PRONTA_IMPORTACAO,
  DocumentoFiscalStatus.EM_IMPORTACAO,
  DocumentoFiscalStatus.IMPORTADA,
  DocumentoFiscalStatus.FINALIZADA,
  DocumentoFiscalStatus.CANCELADA,
  DocumentoFiscalStatus.DENEGADA,
  DocumentoFiscalStatus.INUTILIZADA
]);

function empresaIdValido(empresaId) {
  const n = Number(empresaId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizarCnpj(valor) {
  const d = String(valor || '').replace(/\D/g, '');
  return d.length === 14 ? d : '';
}

function normalizarAmbiente(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  return n === 1 || n === 2 ? n : null;
}

function criarCorrelationId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `prep-chave-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function itemBase(parcial) {
  return {
    chave: parcial.chave || null,
    chaveMascarada: parcial.chave ? mascararChave(parcial.chave) : null,
    empresaId: parcial.empresaId != null ? Number(parcial.empresaId) : null,
    cnpjEmpresa: parcial.cnpjEmpresa || null,
    cnpjEmpresaMascarado: parcial.cnpjEmpresa ? mascararCnpj(parcial.cnpjEmpresa) : null,
    cnpjEmitenteNfe: parcial.cnpjEmitenteNfe || null,
    ambiente: parcial.ambiente != null ? Number(parcial.ambiente) : null,
    classificacao: parcial.classificacao,
    motivo: parcial.motivo || null,
    evidencias: parcial.evidencias || [],
    situacaoLocal: parcial.situacaoLocal || null,
    acaoFutura: parcial.acaoFutura,
    executaSefaz: false,
    alteraNsu: false,
    envia210210: false,
    creditaEstoque: false,
    correlationId: parcial.correlationId,
    estruturaChave: parcial.estruturaChave || null
  };
}

class CentralPreparacaoConsultaChaveService {
  /**
   * @param {Object} [deps]
   * @param {Object} deps.documentosRepository  buscarPorChave / buscarPorChaveExcetoEmpresa
   * @param {Object} [deps.nsuRepository]       buscarPorCnpjAmbiente (somente leitura)
   * @param {Function} deps.resolverIdentidadeFiscal
   * @param {Object} [deps.comprasBridge]       existeCompraComChave (somente leitura)
   */
  constructor(deps = {}) {
    this._documentos = deps.documentosRepository || null;
    this._nsu = deps.nsuRepository || null;
    this._resolverIdentidade = deps.resolverIdentidadeFiscal || null;
    this._compras = deps.comprasBridge || null;
    this._criarCorrelationId = deps.criarCorrelationId || criarCorrelationId;
  }

  /**
   * Plano de reconciliação por lista de chaves. 100% offline.
   * @param {Object} params
   * @param {string[]} params.chaves
   * @param {number|string} [params.empresaId]
   * @param {number|string} [params.ambienteEsperado]
   * @param {string} [params.cnpjEmpresaEsperado]
   * @param {string} [params.correlationId]
   * @returns {Promise<Object>}
   */
  async preparar(params = {}) {
    const correlationId = params.correlationId || this._criarCorrelationId();
    const chaves = Array.isArray(params.chaves) ? params.chaves : [];
    const empresaId = empresaIdValido(params.empresaId);
    const cnpjEsperado = normalizarCnpj(params.cnpjEmpresaEsperado);
    const ambienteEsperado = normalizarAmbiente(params.ambienteEsperado);

    let identidade = null;
    if (empresaId && this._resolverIdentidade) {
      identidade = await this._resolverIdentidade({
        empresaId,
        permitirFallbackGlobal: false
      });
    }

    const cnpjCursor = identidade ? normalizarCnpj(identidade.cnpj) : null;
    const ambienteCursor = identidade ? normalizarAmbiente(identidade.ambiente) : null;
    const cursorAntes = await this._snapshotCursor(cnpjCursor, ambienteCursor);

    const itens = [];
    for (const bruta of chaves) {
      itens.push(await this._classificarUma(bruta, {
        empresaId,
        identidade,
        cnpjEsperado,
        ambienteEsperado,
        correlationId
      }));
    }

    const cursorDepois = await this._snapshotCursor(cnpjCursor, ambienteCursor);

    return {
      correlationId,
      sefazExecutada: false,
      distNsuChamado: false,
      consChNFeChamado: false,
      certificadoAberto: false,
      manifestacao210210: false,
      nsuAlterado: this._cursorMudou(cursorAntes, cursorDepois, ['ultNsu', 'maxNsu']),
      cooldownAlterado: this._cursorMudou(cursorAntes, cursorDepois, ['cooldownAte']),
      creditaEstoque: false,
      cursorAntes,
      cursorDepois,
      itens,
      resumo: this._resumo(itens),
      contratoFuturoConsChNFe: {
        habilitado: false,
        exigeAutorizacao: true,
        reutiliza: [
          'consultarNotaPorChave',
          'CentralDfePersistenciaService',
          'CentralSefazOperationalGate',
          'mutex DistDFe'
        ],
        naoAltera: ['ult_nsu', 'max_nsu', 'cooldown_ate'],
        naoEnvia: ['210210'],
        identidadeObrigatoria: ['empresaId', 'cnpj', 'ambiente', 'certificado da mesma empresa']
      }
    };
  }

  async _classificarUma(bruta, ctx) {
    const correlationId = ctx.correlationId;
    const validacao = validarChaveNfeCompleta(bruta);

    if (!validacao.valida) {
      return itemBase({
        chave: validacao.chave || String(bruta || '').replace(/\D/g, '') || null,
        empresaId: ctx.empresaId,
        classificacao: C.CHAVE_INVALIDA,
        motivo: validacao.motivo === 'DV'
          ? 'Dígito verificador inválido'
          : (validacao.erro || 'Chave malformada'),
        evidencias: [validacao.motivo || 'FORMATO'],
        acaoFutura: A.CORRIGIR_CHAVE,
        correlationId
      });
    }

    const chave = validacao.chave;
    const estrutura = validacao.estrutura;

    if (!ctx.empresaId) {
      return itemBase({
        chave,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.EMPRESA_OBRIGATORIA,
        motivo: 'empresaId explícito é obrigatório; não há fallback global',
        evidencias: ['empresa_ausente'],
        acaoFutura: A.INFORMAR_EMPRESA,
        correlationId
      });
    }

    const identidade = ctx.identidade;
    if (!identidade || identidade.ok !== true) {
      const codigo = identidade && identidade.codigoErro
        ? String(identidade.codigoErro)
        : 'IDENTIDADE_AUSENTE';
      const cnpjParcial = identidade ? normalizarCnpj(identidade.cnpj) : '';
      const ambienteParcial = identidade ? normalizarAmbiente(identidade.ambiente) : null;
      if (!cnpjParcial) {
        return itemBase({
          chave,
          empresaId: ctx.empresaId,
          estruturaChave: estrutura,
          cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
          classificacao: C.CNPJ_NAO_CONFIGURADO,
          motivo: (identidade && identidade.mensagem) || 'CNPJ da empresa não configurado',
          evidencias: ['cadastro_empresa_sem_cnpj', codigo],
          acaoFutura: A.CONFIGURAR_CNPJ,
          correlationId
        });
      }
      if (ambienteParcial == null) {
        return itemBase({
          chave,
          empresaId: ctx.empresaId,
          cnpjEmpresa: cnpjParcial,
          estruturaChave: estrutura,
          cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
          classificacao: C.AMBIENTE_NAO_CONFIGURADO,
          motivo: (identidade && identidade.mensagem) || 'Ambiente fiscal da empresa não configurado',
          evidencias: ['ambiente_ausente', codigo],
          acaoFutura: A.CONFIGURAR_AMBIENTE,
          correlationId
        });
      }
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        cnpjEmpresa: cnpjParcial,
        ambiente: ambienteParcial,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.PENDENTE_DE_REVISAO,
        motivo: (identidade && identidade.mensagem) || 'Identidade fiscal incompleta ou ambígua',
        evidencias: ['identidade_incompleta', codigo],
        acaoFutura: A.COMPLETAR_EVIDENCIAS,
        correlationId
      });
    }

    const cnpjEmpresa = normalizarCnpj(identidade.cnpj);
    const ambiente = normalizarAmbiente(identidade.ambiente);

    if (!cnpjEmpresa) {
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.CNPJ_NAO_CONFIGURADO,
        motivo: 'CNPJ da empresa não configurado',
        evidencias: ['cadastro_empresa_sem_cnpj'],
        acaoFutura: A.CONFIGURAR_CNPJ,
        correlationId
      });
    }

    if (ambiente == null) {
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        cnpjEmpresa,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.AMBIENTE_NAO_CONFIGURADO,
        motivo: 'Ambiente fiscal da empresa não configurado',
        evidencias: ['ambiente_ausente'],
        acaoFutura: A.CONFIGURAR_AMBIENTE,
        correlationId
      });
    }

    if (ctx.cnpjEsperado && ctx.cnpjEsperado !== cnpjEmpresa) {
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        cnpjEmpresa,
        ambiente,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.CHAVE_INCOMPATIVEL_COM_EMPRESA,
        motivo: 'CNPJ informado não confere com o cadastro da empresa',
        evidencias: ['cnpj_empresa_divergente'],
        acaoFutura: A.CONFERIR_EMPRESA,
        correlationId
      });
    }

    if (ctx.ambienteEsperado != null && ctx.ambienteEsperado !== ambiente) {
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        cnpjEmpresa,
        ambiente,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.CHAVE_INCOMPATIVEL_COM_EMPRESA,
        motivo: 'Ambiente informado não confere com a configuração da empresa',
        evidencias: ['ambiente_divergente'],
        acaoFutura: A.CONFERIR_EMPRESA,
        correlationId
      });
    }

    const local = this._documentos
      ? await this._documentos.buscarPorChave(chave, ctx.empresaId)
      : null;

    if (local) {
      const status = normalizarStatus(local.status);
      const completo = STATUS_DOCUMENTO_PERSISTIDO_COMPLETO.includes(status);
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        cnpjEmpresa,
        ambiente,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.DOCUMENTO_JA_EXISTE,
        motivo: completo
          ? `Documento já persistido (${status}) — não tratar como NF-e nova`
          : `Documento já persistido em ${status} — não é documento novo`,
        evidencias: [
          'central_entradas_documentos',
          `status:${status}`,
          `documentoId:${local.id || local.documentoId || '?'}`
        ],
        situacaoLocal: {
          documentoId: local.id || null,
          status,
          origem: local.origem || null,
          nsu: local.nsu || null
        },
        acaoFutura: A.NAO_TRATAR_COMO_NOVO,
        correlationId
      });
    }

    const outra = this._documentos && typeof this._documentos.buscarPorChaveExcetoEmpresa === 'function'
      ? await this._documentos.buscarPorChaveExcetoEmpresa(chave, ctx.empresaId)
      : null;

    if (outra) {
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        cnpjEmpresa,
        ambiente,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.CHAVE_INCOMPATIVEL_COM_EMPRESA,
        motivo: 'Chave já persistida em outra empresa — não reutilizar contexto alheio',
        evidencias: [
          'chave_em_outra_empresa',
          `empresaIdLocal:${outra.empresaId || outra.empresa_id}`
        ],
        situacaoLocal: {
          documentoId: outra.id || null,
          empresaId: outra.empresaId || outra.empresa_id || null,
          status: outra.status || null
        },
        acaoFutura: A.CONFERIR_EMPRESA,
        correlationId
      });
    }

    let compraLocal = false;
    if (this._compras && typeof this._compras.existeCompraComChave === 'function') {
      compraLocal = await this._compras.existeCompraComChave(chave, ctx.empresaId) === true;
    }

    if (compraLocal) {
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        cnpjEmpresa,
        ambiente,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.PENDENTE_DE_REVISAO,
        motivo: 'Há compra local com a chave, mas o documento não está na Central',
        evidencias: ['compra_local_sem_documento_central'],
        situacaoLocal: { compra: true },
        acaoFutura: A.COMPLETAR_EVIDENCIAS,
        correlationId
      });
    }

    if (identidade.certificadoConfigurado === false) {
      return itemBase({
        chave,
        empresaId: ctx.empresaId,
        cnpjEmpresa,
        ambiente,
        estruturaChave: estrutura,
        cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
        classificacao: C.PENDENTE_DE_REVISAO,
        motivo: 'Identidade ok, mas certificado da empresa não está configurado',
        evidencias: ['certificado_ausente_sem_abrir_pfx'],
        acaoFutura: A.CONFIGURAR_CERTIFICADO,
        correlationId
      });
    }

    return itemBase({
      chave,
      empresaId: ctx.empresaId,
      cnpjEmpresa,
      ambiente,
      estruturaChave: estrutura,
      cnpjEmitenteNfe: estrutura.cnpjEmitenteNfe,
      classificacao: C.ELEGIVEL_PARA_CONSULTA,
      motivo: 'Chave válida, empresa/CNPJ/ambiente explícitos, ausente na Central — consulta futura exige autorização',
      evidencias: [
        'chave_44_dv_ok',
        'empresa_explicita',
        'cnpj_cadastro',
        'ambiente_configurado',
        'ausente_no_repositorio',
        'ausencia_local_nao_prova_sefaz'
      ],
      situacaoLocal: { presente: false },
      acaoFutura: A.CONSCHNFE_AUTORIZADO,
      correlationId
    });
  }

  async _snapshotCursor(cnpj, ambiente) {
    if (!this._nsu || !cnpj || ambiente == null) return null;
    if (typeof this._nsu.buscarPorCnpjAmbiente !== 'function') return null;
    const row = await this._nsu.buscarPorCnpjAmbiente(cnpj, ambiente);
    if (!row) return { presente: false, cnpj, ambiente };
    return {
      presente: true,
      cnpj: row.cnpj,
      ambiente: row.ambiente,
      ultNsu: row.ultNsu,
      maxNsu: row.maxNsu,
      cooldownAte: row.cooldownAte || null,
      ultimoCstat: row.ultimoCstat || null
    };
  }

  _cursorMudou(antes, depois, campos) {
    if (!antes || !depois || antes.presente === false && depois.presente === false) {
      return false;
    }
    return campos.some((campo) => String(antes[campo] ?? '') !== String(depois[campo] ?? ''));
  }

  _resumo(itens) {
    const por = {};
    for (const nome of Object.values(C)) por[nome] = 0;
    for (const item of itens) {
      por[item.classificacao] = (por[item.classificacao] || 0) + 1;
    }
    return {
      total: itens.length,
      porClassificacao: por
    };
  }
}

CentralPreparacaoConsultaChaveService.CLASSIFICACOES = C;
CentralPreparacaoConsultaChaveService.ACOES_FUTURAS = A;

module.exports = CentralPreparacaoConsultaChaveService;
