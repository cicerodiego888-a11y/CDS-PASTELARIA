/**
 * Contexto de empresa operacional — cadeia única de resolução (empresa → CNPJ → ambiente → certificado).
 *
 * Fontes oficiais (somente leitura, nenhuma configuração nova):
 *   empresa/CNPJ  → tabela empresas
 *   ambiente/UF/certificado → empresas_configuracao_fiscal (getFiscalConfig({ empresaId }))
 *   modo → core/modo-operacional
 *
 * MULTIEMPRESA sem seleção explícita: matriz = empresa ativa cujo CNPJ tem ordem 0001.
 * Mais de uma matriz ativa: desempate por empresa_operacional_id (configuração existente); senão estado explícito.
 * EMPRESA_SIMPLES: empresa do contrato operacional; configuração fiscal global só quando a empresa
 * não tem configuração própria, sempre declarada em origemAmbiente.
 *
 * Nunca expõe senha nem caminho completo do certificado; nunca abre o PFX.
 *
 * @module services/empresas/ContextoEmpresaOperacionalService
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ESTADOS = Object.freeze({
  OK: 'OK',
  EMPRESA_NAO_SELECIONADA: 'EMPRESA_NAO_SELECIONADA',
  CONTEXTO_EMPRESA_INVALIDO: 'CONTEXTO_EMPRESA_INVALIDO',
  FISCAL_NAO_CONFIGURADO: 'FISCAL_NAO_CONFIGURADO'
});

const ORIGENS_EMPRESA = Object.freeze({
  SELECAO_EXPLICITA: 'SELECAO_EXPLICITA',
  MATRIZ_CNPJ_0001: 'MATRIZ_CNPJ_0001',
  MATRIZ_EMPRESA_OPERACIONAL_ID: 'MATRIZ_EMPRESA_OPERACIONAL_ID',
  EMPRESA_UNICA_ATIVA: 'EMPRESA_UNICA_ATIVA',
  CONTRATO_EMPRESA_SIMPLES: 'CONTRATO_EMPRESA_SIMPLES'
});

const ORIGEM_FISCAL_EMPRESA = 'empresas_configuracao_fiscal';
const ORIGEM_FISCAL_GLOBAL_LEGADO = 'configuracoes (legado EMPRESA_SIMPLES)';

function normalizarCnpj(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function idValido(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** MATRIZ quando a ordem do CNPJ (posições 9–12) é 0001; FILIAL caso contrário. */
function classificarTipoEmpresa(cnpj) {
  const d = normalizarCnpj(cnpj);
  if (d.length !== 14) return null;
  return d.slice(8, 12) === '0001' ? 'MATRIZ' : 'FILIAL';
}

function labelAmbiente(ambiente) {
  const n = Number(ambiente);
  if (n === 1) return 'Produção';
  if (n === 2) return 'Homologação';
  return 'Não configurado';
}

/**
 * Escolhe a empresa padrão da visão global/multiempresa.
 * @param {Array<Object>} empresas
 * @param {{ empresaOperacionalId?: number|null }} [opcoes]
 * @returns {{ empresa: Object|null, origem: string|null, codigo?: string, candidatas?: number[] }}
 */
function escolherMatrizPadrao(empresas, opcoes = {}) {
  const ativas = (Array.isArray(empresas) ? empresas : [])
    .filter((e) => e && idValido(e.id) && (e.ativo == null || Number(e.ativo) === 1));
  const matrizes = ativas.filter((e) => classificarTipoEmpresa(e.cnpj) === 'MATRIZ');

  if (matrizes.length === 1) {
    return { empresa: matrizes[0], origem: ORIGENS_EMPRESA.MATRIZ_CNPJ_0001 };
  }
  if (matrizes.length > 1) {
    const cfgId = idValido(opcoes.empresaOperacionalId);
    const configurada = cfgId != null ? matrizes.find((e) => Number(e.id) === cfgId) : null;
    if (configurada) {
      return { empresa: configurada, origem: ORIGENS_EMPRESA.MATRIZ_EMPRESA_OPERACIONAL_ID };
    }
    return {
      empresa: null,
      origem: null,
      codigo: 'MATRIZ_AMBIGUA',
      candidatas: matrizes.map((e) => Number(e.id))
    };
  }
  if (ativas.length === 1) {
    return { empresa: ativas[0], origem: ORIGENS_EMPRESA.EMPRESA_UNICA_ATIVA };
  }
  return {
    empresa: null,
    origem: null,
    codigo: ativas.length ? 'MATRIZ_AUSENTE' : 'EMPRESA_AUSENTE'
  };
}

function lerEmpresaOperacionalIdConfig(deps) {
  try {
    const { PoliticaEmpresaSimples } = require('../../core/modo-operacional');
    return PoliticaEmpresaSimples.obterEmpresaOperacionalIdConfig(deps);
  } catch {
    return null;
  }
}

function resolverModo(deps) {
  const { resolverModoOperacionalGlobalAtivo } = require('../../core/modo-operacional');
  return resolverModoOperacionalGlobalAtivo(deps);
}

function empresaIdInformado(params) {
  const {
    resolverEmpresaId,
    resolverEmpresaIdDaRequisicao
  } = require('../fiscalNaoFiscal/empresaContexto');
  const req = params.req || null;
  return resolverEmpresaId(params.empresaId)
    ?? resolverEmpresaId(req && req.empresaId)
    ?? (req ? resolverEmpresaIdDaRequisicao(req) : null);
}

async function carregarFiscalEmpresaPadrao({ empresaId, db }) {
  const { getFiscalConfig } = require('../fiscal/configService');
  return getFiscalConfig({ empresaId, db, validarUrls: false });
}

async function carregarFiscalGlobalPadrao({ db }) {
  const { getFiscalConfig } = require('../fiscal/configService');
  return getFiscalConfig({ db, validarUrls: false });
}

function montarCertificado(fiscal, empresa, origem, existeArquivo) {
  const caminho = fiscal && fiscal.certificadoPath ? String(fiscal.certificadoPath) : '';
  const configurado = Boolean(caminho);
  const arquivoExiste = configurado ? Boolean(existeArquivo(caminho)) : false;
  let status = 'NAO_CONFIGURADO';
  if (configurado) status = arquivoExiste ? 'CONFIGURADO' : 'ARQUIVO_AUSENTE';
  return {
    empresaId: empresa ? Number(empresa.id) : null,
    cnpjEmpresa: empresa ? normalizarCnpj(empresa.cnpj) || null : null,
    configurado,
    arquivo: configurado ? path.basename(caminho) : null,
    arquivoExiste,
    senhaConfigurada: Boolean(fiscal && fiscal.certificadoSenha),
    status,
    origem: configurado ? origem : null
  };
}

function contextoVazio(estado, codigo, mensagem, extra = {}) {
  return {
    estado,
    codigo,
    mensagem,
    contextoResolvido: false,
    empresaId: null,
    razaoSocial: null,
    nomeFantasia: null,
    cnpj: null,
    tipoEmpresa: null,
    ambienteFiscal: null,
    ambienteLabel: labelAmbiente(null),
    uf: null,
    codigoUf: null,
    certificado: null,
    modo: extra.modo || null,
    origens: {
      origemEmpresa: null,
      origemCnpj: null,
      origemAmbiente: null,
      origemCertificado: null
    },
    ...extra
  };
}

/**
 * Resolução única do contexto de empresa operacional.
 *
 * @param {{ empresaId?: number|string|null, req?: Object }} [params]
 * @param {Object} [deps]
 * @param {Object} [deps.db]
 * @param {Function} [deps.obterModoOperacionalGlobal]
 * @param {Object} [deps.EmpresaService]
 * @param {Function} [deps.carregarFiscalEmpresa]  ({ empresaId, db }) => config fiscal da empresa
 * @param {Function} [deps.carregarFiscalGlobal]   ({ db }) => config global (só EMPRESA_SIMPLES)
 * @param {Function} [deps.existeArquivo]
 * @returns {Promise<Object>}
 */
async function resolverContextoEmpresaOperacional(params = {}, deps = {}) {
  const { ModoOperacionalGlobal, PoliticaEmpresaSimples } = require('../../core/modo-operacional');
  const EmpresaService = deps.EmpresaService || require('./EmpresaService');
  const db = deps.db || (params.req && params.req.db) || undefined;
  const carregarFiscalEmpresa = deps.carregarFiscalEmpresa || carregarFiscalEmpresaPadrao;
  const carregarFiscalGlobal = deps.carregarFiscalGlobal || carregarFiscalGlobalPadrao;
  const existeArquivo = deps.existeArquivo || ((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });

  const modo = resolverModo(deps);
  const multiempresa = modo === ModoOperacionalGlobal.MULTIEMPRESA;

  let empresa = null;
  let origemEmpresa = null;

  if (multiempresa) {
    const informado = empresaIdInformado(params);
    if (informado != null) {
      try {
        empresa = await EmpresaService.buscarEmpresaPorId(informado, { db });
      } catch (err) {
        return contextoVazio(
          ESTADOS.CONTEXTO_EMPRESA_INVALIDO,
          (err && err.code) || 'EMPRESA_NAO_ENCONTRADA',
          `Empresa ${informado} não encontrada.`,
          { modo, empresaIdSolicitado: informado }
        );
      }
      if (!empresa || Number(empresa.ativo) !== 1) {
        return contextoVazio(
          ESTADOS.CONTEXTO_EMPRESA_INVALIDO,
          'EMPRESA_INATIVA',
          `Empresa ${informado} inativa.`,
          { modo, empresaIdSolicitado: informado }
        );
      }
      origemEmpresa = ORIGENS_EMPRESA.SELECAO_EXPLICITA;
    } else {
      const ativas = await EmpresaService.listarEmpresas({ ativo: 1 }, { db });
      const escolha = escolherMatrizPadrao(ativas, {
        empresaOperacionalId: lerEmpresaOperacionalIdConfig(deps)
      });
      if (!escolha.empresa) {
        const mensagens = {
          MATRIZ_AMBIGUA: 'Mais de uma matriz ativa (CNPJ 0001) — selecione a empresa.',
          MATRIZ_AUSENTE: 'Nenhuma matriz ativa (CNPJ 0001) — selecione a empresa.',
          EMPRESA_AUSENTE: 'Nenhuma empresa ativa cadastrada.'
        };
        return contextoVazio(
          ESTADOS.EMPRESA_NAO_SELECIONADA,
          escolha.codigo,
          mensagens[escolha.codigo] || 'Empresa não selecionada.',
          { modo, candidatas: escolha.candidatas || undefined }
        );
      }
      empresa = escolha.empresa;
      origemEmpresa = escolha.origem;
    }
  } else {
    try {
      const resolvida = await PoliticaEmpresaSimples.resolverEmpresaOperacional(deps);
      const id = idValido(resolvida && resolvida.empresa && resolvida.empresa.empresa_id);
      empresa = id != null ? await EmpresaService.buscarEmpresaPorId(id, { db }) : null;
      origemEmpresa = `${ORIGENS_EMPRESA.CONTRATO_EMPRESA_SIMPLES}:${resolvida.origem}`;
    } catch (err) {
      return contextoVazio(
        ESTADOS.EMPRESA_NAO_SELECIONADA,
        (err && err.code) || 'EMPRESA_OPERACIONAL_AUSENTE',
        (err && err.message) || 'Empresa operacional não resolvida.',
        { modo }
      );
    }
    if (!empresa) {
      return contextoVazio(
        ESTADOS.EMPRESA_NAO_SELECIONADA,
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Empresa operacional não resolvida.',
        { modo }
      );
    }
  }

  const empresaId = Number(empresa.id);
  let fiscal = null;
  let origemAmbiente = null;
  let codigoFiscal = null;
  let mensagemFiscal = null;

  try {
    fiscal = await carregarFiscalEmpresa({ empresaId, db });
    origemAmbiente = ORIGEM_FISCAL_EMPRESA;
  } catch (err) {
    codigoFiscal = (err && err.code) || 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE';
    mensagemFiscal = (err && err.message) || `Empresa ${empresaId} sem configuração fiscal própria.`;
    if (!multiempresa && codigoFiscal === 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE') {
      try {
        fiscal = await carregarFiscalGlobal({ db });
        origemAmbiente = ORIGEM_FISCAL_GLOBAL_LEGADO;
        codigoFiscal = null;
        mensagemFiscal = null;
      } catch (errGlobal) {
        mensagemFiscal = (errGlobal && errGlobal.message) || mensagemFiscal;
      }
    }
  }

  const ambiente = fiscal && [1, 2].includes(Number(fiscal.ambiente)) ? Number(fiscal.ambiente) : null;
  const certificado = montarCertificado(fiscal, empresa, origemAmbiente, existeArquivo);
  const contextoResolvido = ambiente != null;

  return {
    estado: contextoResolvido ? ESTADOS.OK : ESTADOS.FISCAL_NAO_CONFIGURADO,
    codigo: contextoResolvido ? null : (codigoFiscal || 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE'),
    mensagem: contextoResolvido ? null : mensagemFiscal,
    contextoResolvido,
    empresaId,
    razaoSocial: empresa.razao_social || null,
    nomeFantasia: empresa.nome_fantasia || null,
    cnpj: normalizarCnpj(empresa.cnpj) || null,
    tipoEmpresa: classificarTipoEmpresa(empresa.cnpj),
    ambienteFiscal: ambiente,
    ambienteLabel: labelAmbiente(ambiente),
    uf: fiscal ? (fiscal.uf || null) : null,
    codigoUf: fiscal && fiscal.codigoUf ? String(fiscal.codigoUf) : null,
    certificado,
    modo,
    origens: {
      origemEmpresa,
      origemCnpj: 'empresas.cnpj',
      origemAmbiente,
      origemCertificado: certificado.origem
    }
  };
}

function lerConfiguracoesLegadas(db, chaves) {
  return new Promise((resolve) => {
    if (!db || typeof db.all !== 'function') return resolve({});
    const placeholders = chaves.map(() => '?').join(',');
    db.all(
      `SELECT chave, valor FROM configuracoes WHERE chave IN (${placeholders})`,
      chaves,
      (err, rows) => {
        if (err) return resolve({});
        const mapa = {};
        (rows || []).forEach((r) => { mapa[r.chave] = r.valor; });
        return resolve(mapa);
      }
    );
  });
}

/**
 * Diagnóstico de origens + divergências com fontes legadas globais (somente leitura).
 *
 * @param {{ empresaId?: number|string|null, req?: Object, competencia?: Object }} [params]
 * @param {Object} [deps]  mesmas deps de resolverContextoEmpresaOperacional
 * @returns {Promise<Object>}
 */
async function diagnosticarContextoEmpresa(params = {}, deps = {}) {
  const contexto = await resolverContextoEmpresaOperacional(params, deps);
  const db = deps.db || (params.req && params.req.db) || require('../../database');
  const legado = await lerConfiguracoesLegadas(db, [
    'fiscal_ambiente',
    'cnpj',
    'razao_social',
    'nome_empresa',
    'fiscal_certificado_path'
  ]);

  const ambienteGlobal = [1, 2].includes(Number(legado.fiscal_ambiente)) ? Number(legado.fiscal_ambiente) : null;
  const cnpjGlobal = normalizarCnpj(legado.cnpj) || null;
  const certGlobal = legado.fiscal_certificado_path ? path.basename(String(legado.fiscal_certificado_path)) : null;

  const divergencias = [];
  if (contexto.empresaId != null && ambienteGlobal != null && contexto.ambienteFiscal != null
    && ambienteGlobal !== contexto.ambienteFiscal) {
    divergencias.push({
      campo: 'ambiente',
      contextoEmpresa: labelAmbiente(contexto.ambienteFiscal),
      legadoGlobal: labelAmbiente(ambienteGlobal),
      fonteLegada: 'configuracoes.fiscal_ambiente',
      descricao: `Empresa ${contexto.empresaId} → ${labelAmbiente(contexto.ambienteFiscal)}; configuração global → ${labelAmbiente(ambienteGlobal)}. Telas usam o contexto da empresa.`
    });
  }
  if (contexto.cnpj && cnpjGlobal && cnpjGlobal !== contexto.cnpj) {
    divergencias.push({
      campo: 'cnpj',
      contextoEmpresa: contexto.cnpj,
      legadoGlobal: cnpjGlobal,
      fonteLegada: 'configuracoes.cnpj',
      descricao: 'CNPJ global difere do CNPJ da empresa resolvida. Telas usam empresas.cnpj.'
    });
  }
  const certEmpresa = contexto.certificado && contexto.certificado.arquivo;
  if (certEmpresa && certGlobal && certEmpresa !== certGlobal) {
    divergencias.push({
      campo: 'certificado',
      contextoEmpresa: certEmpresa,
      legadoGlobal: certGlobal,
      fonteLegada: 'configuracoes.fiscal_certificado_path',
      descricao: 'Certificado global difere do certificado da empresa. Telas usam o certificado da empresa.'
    });
  }
  if (contexto.estado === ESTADOS.EMPRESA_NAO_SELECIONADA && ambienteGlobal != null) {
    divergencias.push({
      campo: 'empresa',
      contextoEmpresa: null,
      legadoGlobal: labelAmbiente(ambienteGlobal),
      fonteLegada: 'configuracoes.fiscal_ambiente',
      descricao: 'Sem empresa resolvida; a configuração global existe mas não é usada como fallback.'
    });
  }

  const competencia = params.competencia || null;
  return {
    contexto,
    origens: {
      ...contexto.origens,
      origemCompetencia: competencia
        ? (competencia.origem || 'parametro ano/mes da requisição (padrão: mês corrente)')
        : 'parametro ano/mes da requisição (padrão: mês corrente)'
    },
    competencia: competencia
      ? { competencia: competencia.competencia || null, label: competencia.label || null }
      : null,
    fontesLegadas: {
      configuracoesFiscalAmbiente: ambienteGlobal,
      configuracoesCnpj: cnpjGlobal,
      configuracoesCertificadoArquivo: certGlobal,
      usadasComoFallback: contexto.origens.origemAmbiente === ORIGEM_FISCAL_GLOBAL_LEGADO
    },
    fontesCentral: {
      nsu: 'central_entradas_nsu (por CNPJ + ambiente da empresa)',
      gate: 'CentralSefazOperationalGate (estado 593 por empresa + fingerprint fiscal por empresa)',
      configuracaoCentral: 'central_entradas_config (timeouts, sync, política — sem identidade fiscal)',
      endpoints: 'UrlResolver / RegistryBuilder (ambiente da empresa)'
    },
    divergencias
  };
}

/** Versão pública (UI) do contexto — sem campos internos. */
function contextoPublico(contexto) {
  if (!contexto) return null;
  return {
    estado: contexto.estado,
    codigo: contexto.codigo,
    mensagem: contexto.mensagem,
    contextoResolvido: contexto.contextoResolvido,
    empresaId: contexto.empresaId,
    razaoSocial: contexto.razaoSocial,
    nomeFantasia: contexto.nomeFantasia,
    cnpj: contexto.cnpj,
    tipoEmpresa: contexto.tipoEmpresa,
    ambienteFiscal: contexto.ambienteFiscal,
    ambienteLabel: contexto.ambienteLabel,
    uf: contexto.uf,
    codigoUf: contexto.codigoUf,
    certificado: contexto.certificado,
    modo: contexto.modo,
    origens: contexto.origens
  };
}

module.exports = {
  resolverContextoEmpresaOperacional,
  diagnosticarContextoEmpresa,
  escolherMatrizPadrao,
  classificarTipoEmpresa,
  contextoPublico,
  labelAmbiente,
  ESTADOS,
  ORIGENS_EMPRESA,
  ORIGEM_FISCAL_EMPRESA,
  ORIGEM_FISCAL_GLOBAL_LEGADO
};
