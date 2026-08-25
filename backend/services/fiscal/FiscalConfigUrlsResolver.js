/**
 * Helper fino — resolve URLs de configuração NFC-e para tela/admin.
 * NÃO é motor fiscal. Reutiliza ENDPOINTS oficiais (RegistryBuilder)
 * e bases de consulta QR/chave já adotadas no bootstrap (CE/SVRS).
 *
 * @module services/fiscal/FiscalConfigUrlsResolver
 */
'use strict';

const { ENDPOINTS } = require('./core/RegistryBuilder');
const { EnvironmentType } = require('./core/EnvironmentType');

/** Bases oficiais de consulta pública NFC-e (mesmo seed de configuracoes). */
const CONSULTA_PUBLICA = Object.freeze({
  CE: Object.freeze({
    [EnvironmentType.PRODUCAO]: 'https://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html',
    [EnvironmentType.HOMOLOGACAO]: 'https://nfceh.sefaz.ce.gov.br/pages/ShowNFCe.html'
  })
});

const PLACEHOLDER_CSC_UI = 'CONFIGURADO — informe para substituir';

function normalizarUf(uf) {
  const u = String(uf || 'CE').trim().toUpperCase();
  return u.length === 2 ? u : 'CE';
}

function ambienteKey(ambiente) {
  return Number(ambiente) === 1 ? EnvironmentType.PRODUCAO : EnvironmentType.HOMOLOGACAO;
}

/**
 * Resolve bloco de URLs oficiais NFC-e por UF + ambiente.
 * UF CE (e demais no modelo SVRS do catálogo) usam ENDPOINTS.NFCE_*.
 */
function resolverUrlsOficiaisNfce({ uf = 'CE', ambiente = 2 } = {}) {
  const amb = ambienteKey(ambiente);
  const ufN = normalizarUf(uf);
  const consulta = (CONSULTA_PUBLICA[ufN] && CONSULTA_PUBLICA[ufN][amb])
    || CONSULTA_PUBLICA.CE[amb];
  return Object.freeze({
    uf: ufN,
    ambiente: amb === EnvironmentType.PRODUCAO ? 1 : 2,
    autorizacao: ENDPOINTS.NFCE_AUTORIZACAO[amb],
    retorno: ENDPOINTS.NFCE_RETORNO[amb],
    status: ENDPOINTS.NFCE_STATUS[amb],
    consultaQr: consulta,
    consultaChave: consulta
  });
}

function blocoParaCampos(bloco, sufixo) {
  return {
    [`ws_autorizacao_${sufixo}`]: bloco.autorizacao,
    [`ws_retorno_${sufixo}`]: bloco.retorno,
    [`ws_status_${sufixo}`]: bloco.status,
    [`csc_qrcode_url_${sufixo}`]: bloco.consultaQr,
    [`consulta_chave_url_${sufixo}`]: bloco.consultaChave
  };
}

/**
 * Preenche somente campos de URL vazios no objeto merged (não sobrescreve manual).
 */
function preencherUrlsVaziasComOficiais(merged, { uf } = {}) {
  const out = merged && typeof merged === 'object' ? merged : {};
  const ufN = normalizarUf(uf || out.uf || 'CE');
  const homo = blocoParaCampos(resolverUrlsOficiaisNfce({ uf: ufN, ambiente: 2 }), 'homologacao');
  const prod = blocoParaCampos(resolverUrlsOficiaisNfce({ uf: ufN, ambiente: 1 }), 'producao');
  const catalogo = { ...homo, ...prod };
  for (const [campo, urlOficial] of Object.entries(catalogo)) {
    const atual = out[campo] != null ? String(out[campo]).trim() : '';
    if (!atual) out[campo] = urlOficial;
  }
  return out;
}

/**
 * Enriquece blocos de exibição (urls_homologacao / urls_producao) sem persistir.
 */
function enriquecerBlocoUrlsExibicao(bloco, { uf, ambiente } = {}) {
  const oficial = resolverUrlsOficiaisNfce({ uf, ambiente });
  const base = bloco && typeof bloco === 'object' ? bloco : {};
  const pick = (chave) => {
    const v = base[chave] != null ? String(base[chave]).trim() : '';
    return v || oficial[chave] || '';
  };
  return {
    autorizacao: pick('autorizacao'),
    retorno: pick('retorno'),
    status: pick('status'),
    consultaQr: pick('consultaQr'),
    consultaChave: pick('consultaChave')
  };
}

function ehPlaceholderCsc(valor) {
  const t = String(valor == null ? '' : valor).trim();
  if (!t) return true;
  if (t === PLACEHOLDER_CSC_UI) return true;
  if (/^CONFIGURADO/i.test(t) && /substituir/i.test(t)) return true;
  return false;
}

/**
 * Remove do patch campos CSC que significam "não alterar".
 */
function sanitizarPatchCsc(patch) {
  const out = patch && typeof patch === 'object' ? { ...patch } : {};
  ['token_csc', 'id_csc'].forEach((campo) => {
    if (!Object.prototype.hasOwnProperty.call(out, campo)) return;
    if (ehPlaceholderCsc(out[campo])) delete out[campo];
  });
  return out;
}

module.exports = {
  PLACEHOLDER_CSC_UI,
  CONSULTA_PUBLICA,
  resolverUrlsOficiaisNfce,
  preencherUrlsVaziasComOficiais,
  enriquecerBlocoUrlsExibicao,
  ehPlaceholderCsc,
  sanitizarPatchCsc
};
