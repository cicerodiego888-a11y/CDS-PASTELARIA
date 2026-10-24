/**
 * Conciliação local de NF-e ausentes na Central — classificação A–E.
 *
 * Não consulta a SEFAZ, não altera NSU, não envia 210210 e não credita estoque.
 * DistDFe/`consChNFe` só aparecem como plano; a execução real exige autorização.
 *
 * @module motores/central-entradas/services/CentralConciliacaoNfeService
 */

'use strict';

const {
  pendenciaAindaAberta,
  filtrarPendenciasPersistenciaAbertas
} = require('../../../services/fiscal/pendenciasPersistenciaDfe');
const {
  calcularIntervaloPeriodoPadrao,
  PERIODOS_PADRAO
} = require('./CentralPeriodoPadraoService');

const CLASSES = Object.freeze({
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E'
});

const DESCRICAO_CLASSE = Object.freeze({
  A: 'Persistido, mas não exibido',
  B: 'Pendência de persistência conhecida (ERRO_BANCO)',
  C: 'Chave conhecida, documento não persistido',
  D: 'NSU avançado, sem chave conhecida',
  E: 'Inconclusivo'
});

function normalizarChave(chave) {
  return String(chave || '').replace(/\D/g, '');
}

function chaveValida44(chave) {
  return normalizarChave(chave).length === 44;
}

function empresaIdValido(empresaId) {
  const n = Number(empresaId);
  return Number.isInteger(n) && n > 0;
}

function dataDia(valor) {
  if (valor == null || valor === '') return null;
  return String(valor).slice(0, 10);
}

function dataNoIntervalo(data, inicio, fim) {
  const d = dataDia(data);
  if (!d) return false;
  const i = dataDia(inicio);
  const f = dataDia(fim);
  if (i && d < i) return false;
  if (f && d > f) return false;
  return true;
}

function mesmoDocumento(a, b) {
  const chaveA = normalizarChave(a.chave);
  const chaveB = normalizarChave(b.chave);
  if (!chaveA || chaveA !== chaveB) return false;
  const empA = a.empresaId != null ? Number(a.empresaId) : (a.empresa_id != null ? Number(a.empresa_id) : null);
  const empB = b.empresaId != null ? Number(b.empresaId) : (b.empresa_id != null ? Number(b.empresa_id) : null);
  if (empA == null || empB == null) return true;
  return empA === empB;
}

/**
 * Motivos pelos quais um documento persistido some da listagem.
 * @param {Object} doc
 * @param {Object} [filtro]
 * @returns {string[]}
 */
function avaliarFiltroUi(doc, filtro = {}) {
  const motivos = [];
  if (filtro.empresaId != null && Number(doc.empresaId ?? doc.empresa_id) !== Number(filtro.empresaId)) {
    motivos.push('empresa');
  }
  const inicio = filtro.dataEmissaoInicio || filtro.data_emissao_inicio || null;
  const fim = filtro.dataEmissaoFim || filtro.data_emissao_fim || null;
  if (inicio || fim) {
    const data = doc.dataEmissao || doc.data_emissao;
    if (!data || !dataNoIntervalo(data, inicio, fim)) motivos.push('periodo');
  }
  if (filtro.status && String(doc.status || '') !== String(filtro.status)) {
    motivos.push('status');
  }
  return motivos;
}

/**
 * Plano de `consChNFe` — nunca dispara SOAP.
 * @param {Object} params
 * @returns {Object}
 */
function planejarConsChNFe(params = {}) {
  const chave = normalizarChave(params.chave);
  if (!chaveValida44(chave)) {
    return {
      viavel: false,
      mecanismo: 'consChNFe',
      executaSefaz: false,
      alteraNsu: false,
      envia210210: false,
      motivo: 'chave_invalida'
    };
  }
  if (!empresaIdValido(params.empresaId)) {
    return {
      viavel: false,
      mecanismo: 'consChNFe',
      executaSefaz: false,
      alteraNsu: false,
      envia210210: false,
      motivo: 'EMPRESA_CENTRAL_AUSENTE'
    };
  }
  if (params.empresaIdEsperada != null
    && Number(params.empresaId) !== Number(params.empresaIdEsperada)) {
    return {
      viavel: false,
      mecanismo: 'consChNFe',
      executaSefaz: false,
      alteraNsu: false,
      envia210210: false,
      motivo: 'EMPRESA_DIVERGENTE'
    };
  }
  if (params.gateBloqueado) {
    return {
      viavel: false,
      mecanismo: 'consChNFe',
      executaSefaz: false,
      alteraNsu: false,
      envia210210: false,
      motivo: 'GATE_BLOQUEADO'
    };
  }
  if (params.cooldownAtivo) {
    return {
      viavel: false,
      mecanismo: 'consChNFe',
      executaSefaz: false,
      alteraNsu: false,
      envia210210: false,
      motivo: 'COOLDOWN'
    };
  }
  return {
    viavel: true,
    mecanismo: 'consChNFe',
    executaSefaz: false,
    alteraNsu: false,
    envia210210: false,
    motivo: 'aguardando_autorizacao',
    preRequisitos: [
      'autorizacao_escrita',
      'gate_liberado',
      'certificado_da_empresa',
      'chave_44_digitos',
      'empresa_id_oficial'
    ],
    riscos: [
      'consulta SEFAZ real (não executada nesta sprint)',
      'não recupera NSU já consumido por distNSU',
      'não creditar estoque automaticamente'
    ]
  };
}

function planoPorClasse(classe, extra = {}) {
  const base = {
    classe,
    descricao: DESCRICAO_CLASSE[classe],
    executaSefaz: false,
    envia210210: false,
    alteraNsu: false,
    creditaEstoque: false
  };
  if (classe === CLASSES.A) {
    return {
      ...base,
      mecanismo: 'filtro_local',
      procedimento: 'Ajustar período (TODO_PERIODO) ou empresa na UI; o documento já está no repositório.',
      criterioConfirmacao: 'listar() sem o filtro devolve o documento; COUNT(chave, empresa_id)=1',
      ...extra
    };
  }
  if (classe === CLASSES.B) {
    return {
      ...base,
      mecanismo: extra.nsuAindaAnteriorAoLote ? 'distNSU_retomada' : 'consChNFe_se_chave',
      procedimento: extra.nsuAindaAnteriorAoLote
        ? 'Após autorização, DistDFe no cursor atual (idempotente). Não rebobinar NSU.'
        : 'Se o cursor já passou do NSU do lote, DistDFe não devolve o documento; usar consChNFe autorizado ou XML do fornecedor.',
      criterioConfirmacao: 'pendenciaAindaAberta=false e UNIQUE(chave, empresa_id)=1',
      ...extra
    };
  }
  if (classe === CLASSES.C) {
    return {
      ...base,
      mecanismo: 'consChNFe',
      procedimento: 'Não executar nesta sprint. Com autorização: consChNFe pela chave, Gate, sem 210210, sem crédito de estoque.',
      criterioConfirmacao: 'documento persistido para a empresa correta; dataEmissaoEstimada se não houver dhEmi',
      ...extra
    };
  }
  if (classe === CLASSES.D) {
    return {
      ...base,
      mecanismo: 'nenhum_no_produto',
      limitacao: 'consNSU não existe. distNSU não consulta NSU já consumido.',
      procedimento: 'Obter a chave (DANFE/XML/fornecedor) e reclassificar como C. Não inventar NSU nem rewind.',
      fontesAutorizadas: ['xml_fornecedor', 'danfe', 'dfe_auditoria_com_chave', 'portal_nacional'],
      ...extra
    };
  }
  return {
    ...base,
    mecanismo: 'nenhum',
    dadosFaltantes: extra.dadosFaltantes || ['chave', 'empresa_id', 'evidencia_local'],
    procedimento: 'Completar evidências locais antes de qualquer consulta.',
    ...extra
  };
}

function itemInventario(parcial) {
  return {
    classe: parcial.classe,
    descricaoClasse: DESCRICAO_CLASSE[parcial.classe],
    empresaId: parcial.empresaId != null ? Number(parcial.empresaId) : null,
    chave: parcial.chave ? normalizarChave(parcial.chave) : null,
    nsu: parcial.nsu != null ? String(parcial.nsu) : null,
    evidencia: parcial.evidencia || null,
    ultimoEstadoLocal: parcial.ultimoEstadoLocal || null,
    causaComprovada: parcial.causaComprovada || null,
    hipotese: parcial.hipotese || null,
    dataEmissao: parcial.dataEmissao || null,
    dataEmissaoOrigem: parcial.dataEmissaoOrigem || null,
    dataEmissaoEstimada: parcial.dataEmissaoEstimada === true,
    filtrosQueOcultam: parcial.filtrosQueOcultam || [],
    plano: parcial.plano || planoPorClasse(parcial.classe)
  };
}

/**
 * @param {Object} evidencias
 * @returns {Object}
 */
function conciliarNfeAusentes(evidencias = {}) {
  const documentos = Array.isArray(evidencias.documentos) ? evidencias.documentos : [];
  const pendencias = Array.isArray(evidencias.pendenciasAuditoria)
    ? evidencias.pendenciasAuditoria
    : [];
  const chavesConhecidas = Array.isArray(evidencias.chavesConhecidas)
    ? evidencias.chavesConhecidas
    : [];
  const avancosNsuSemChave = Array.isArray(evidencias.avancosNsuSemChave)
    ? evidencias.avancosNsuSemChave
    : [];
  const filtroUi = evidencias.filtroUi || {};
  const nsuAtual = evidencias.nsuAtual || null;

  const abertas = filtrarPendenciasPersistenciaAbertas(pendencias, documentos);
  const reconciliadas = pendencias.filter((p) => {
    const ehErro = String(p.resultado || '') === 'ERRO_BANCO'
      && String(p.tipo || p.etapa || '') === 'PERSISTENCIA';
    return ehErro && !pendenciaAindaAberta(p, documentos);
  });

  const inventario = [];
  const vistos = new Set();

  function marcar(chave, empresaId) {
    vistos.add(`${normalizarChave(chave)}:${empresaId == null ? '*' : Number(empresaId)}`);
  }
  function jaVisto(chave, empresaId) {
    return vistos.has(`${normalizarChave(chave)}:${empresaId == null ? '*' : Number(empresaId)}`);
  }

  for (const doc of documentos) {
    const motivos = avaliarFiltroUi(doc, filtroUi);
    if (!motivos.length) continue;
    const empresaId = doc.empresaId ?? doc.empresa_id;
    inventario.push(itemInventario({
      classe: CLASSES.A,
      empresaId,
      chave: doc.chave,
      nsu: doc.nsu,
      dataEmissao: doc.dataEmissao || doc.data_emissao,
      dataEmissaoOrigem: doc.dataEmissaoOrigem || doc.data_emissao_origem,
      dataEmissaoEstimada: doc.dataEmissaoEstimada === true
        || (doc.dataEmissaoOrigem || doc.data_emissao_origem) === 'chave_aamm',
      evidencia: 'documento_local',
      ultimoEstadoLocal: doc.status || 'PERSISTIDO',
      causaComprovada: `oculto_por_filtro:${motivos.join(',')}`,
      filtrosQueOcultam: motivos,
      plano: planoPorClasse(CLASSES.A, { filtrosQueOcultam: motivos })
    }));
    marcar(doc.chave, empresaId);
  }

  for (const pend of abertas) {
    const empresaId = pend.empresaId ?? pend.empresa_id;
    const chave = normalizarChave(pend.chave);
    const nsuLote = pend.nsu != null ? String(pend.nsu) : null;
    const nsuCursor = nsuAtual && nsuAtual.ultNsu != null ? String(nsuAtual.ultNsu) : null;
    const nsuAindaAnteriorAoLote = Boolean(nsuLote && nsuCursor && nsuCursor < String(nsuLote).padStart(15, '0'));
    inventario.push(itemInventario({
      classe: CLASSES.B,
      empresaId,
      chave: chave || null,
      nsu: nsuLote,
      evidencia: 'dfe_auditoria.ERRO_BANCO',
      ultimoEstadoLocal: 'PENDENTE_PERSISTENCIA',
      causaComprovada: chave ? 'persistencia_falhou_documento_ausente' : null,
      hipotese: chave ? null : 'ERRO_BANCO_sem_chave',
      plano: planoPorClasse(CLASSES.B, {
        nsuAindaAnteriorAoLote,
        chaveConhecida: Boolean(chave)
      })
    }));
    if (chave) marcar(chave, empresaId);
  }

  for (const conhecido of chavesConhecidas) {
    const chave = normalizarChave(conhecido.chave || conhecido);
    const empresaId = conhecido.empresaId ?? conhecido.empresa_id ?? evidencias.empresaId;
    if (!chaveValida44(chave)) {
      inventario.push(itemInventario({
        classe: CLASSES.E,
        empresaId,
        chave,
        evidencia: 'chave_conhecida_invalida',
        hipotese: 'chave_nao_tem_44_digitos',
        plano: planoPorClasse(CLASSES.E, { dadosFaltantes: ['chave_44_digitos'] })
      }));
      continue;
    }
    if (jaVisto(chave, empresaId)) continue;
    const persistido = documentos.some((d) => mesmoDocumento(d, { chave, empresaId }));
    if (persistido) continue;
    if (!empresaIdValido(empresaId)) {
      inventario.push(itemInventario({
        classe: CLASSES.E,
        empresaId: null,
        chave,
        evidencia: 'chave_conhecida_sem_empresa',
        hipotese: 'empresa_id_ausente',
        plano: planoPorClasse(CLASSES.E, { dadosFaltantes: ['empresa_id'] })
      }));
      continue;
    }
    const consCh = planejarConsChNFe({
      chave,
      empresaId,
      empresaIdEsperada: evidencias.empresaIdEsperada,
      gateBloqueado: evidencias.gateBloqueado === true,
      cooldownAtivo: evidencias.cooldownAtivo === true
    });
    inventario.push(itemInventario({
      classe: CLASSES.C,
      empresaId,
      chave,
      nsu: conhecido.nsu || null,
      evidencia: 'chave_operador_ou_danfe',
      ultimoEstadoLocal: 'AUSENTE_NO_REPOSITORIO',
      hipotese: 'nunca_persistido_ou_nsu_ja_consumido',
      plano: planoPorClasse(CLASSES.C, { consChNFe: consCh })
    }));
    marcar(chave, empresaId);
  }

  for (const avanco of avancosNsuSemChave) {
    inventario.push(itemInventario({
      classe: CLASSES.D,
      empresaId: avanco.empresaId ?? avanco.empresa_id ?? null,
      chave: null,
      nsu: avanco.nsu || avanco.ultNsu || null,
      evidencia: 'nsu_avanco_sem_chave',
      ultimoEstadoLocal: 'CURSOR_AVANCADO',
      hipotese: 'lote_consumido_sem_identificacao',
      plano: planoPorClasse(CLASSES.D)
    }));
  }

  if (!documentos.length && !pendencias.length && !chavesConhecidas.length && !avancosNsuSemChave.length) {
    inventario.push(itemInventario({
      classe: CLASSES.E,
      evidencia: 'sem_fontes_locais',
      hipotese: 'banco_oficial_nao_lido',
      plano: planoPorClasse(CLASSES.E, {
        dadosFaltantes: [
          'leitura_autorizada_central_entradas_documentos',
          'dfe_auditoria',
          'central_entradas_nsu',
          'lista_chaves_esperadas'
        ]
      })
    }));
  }

  const porClasse = { A: [], B: [], C: [], D: [], E: [] };
  for (const item of inventario) {
    porClasse[item.classe].push(item);
  }

  return {
    inventario,
    porClasse,
    presentesVisiveis: documentos.filter((d) => avaliarFiltroUi(d, filtroUi).length === 0),
    pendenciasAbertas: abertas,
    pendenciasReconciliadas: reconciliadas,
    resumo: {
      classeA: porClasse.A.length,
      classeB: porClasse.B.length,
      classeC: porClasse.C.length,
      classeD: porClasse.D.length,
      classeE: porClasse.E.length,
      visiveis: documentos.filter((d) => avaliarFiltroUi(d, filtroUi).length === 0).length,
      persistidos: documentos.length,
      pendenciasAbertas: abertas.length,
      pendenciasReconciliadas: reconciliadas.length
    },
    sefazExecutada: false,
    nsuAlterado: false,
    manifestacao210210: false
  };
}

class CentralConciliacaoNfeService {
  conciliar(evidencias) {
    return conciliarNfeAusentes(evidencias);
  }

  planejarConsChNFe(params) {
    return planejarConsChNFe(params);
  }

  avaliarFiltroUi(doc, filtro) {
    return avaliarFiltroUi(doc, filtro);
  }

  intervaloMesVigente(agora) {
    return calcularIntervaloPeriodoPadrao(PERIODOS_PADRAO.MES_VIGENTE, agora);
  }
}

module.exports = CentralConciliacaoNfeService;
module.exports.conciliarNfeAusentes = conciliarNfeAusentes;
module.exports.planejarConsChNFe = planejarConsChNFe;
module.exports.avaliarFiltroUi = avaliarFiltroUi;
module.exports.CLASSES = CLASSES;
module.exports.DESCRICAO_CLASSE = DESCRICAO_CLASSE;
module.exports.chaveValida44 = chaveValida44;
