/**
 * enriquecerParseComMiip — Enriquecimento MIIP + MIP do parse NF-e (Sprint 07).
 *
 * Pipeline:
 * 1) MIIP (aprendizado / fornecedor / similaridade) — inalterado
 * 2) MIP (produto_identificadores) para itens ainda sem produto_id
 *
 * Usado por Compras e Central de Entradas.
 *
 * @module shared/nfe/enriquecerParseComMiip
 */

const { getMiipService } = require('../../motores/miip/getMiipService');
const { extrairPendencias } = require('../../motores/miip/utils/miipCentralRevisaoUtils');
const EntradasProdutoIdentificacaoService = require('../../motores/produto-identidade/services/EntradasProdutoIdentificacaoService');
const { isProdutoIdentidadeEnabled } = require('../../motores/produto-identidade/config/produtoIdentidadeFlags');
const mipLogger = require('../../motores/produto-identidade/observability/mipLogger');

let _entradasIdentificacao = null;

function obterEntradasIdentificacao(deps = {}) {
  if (deps.entradasIdentificacao) return deps.entradasIdentificacao;
  if (!_entradasIdentificacao) {
    _entradasIdentificacao = new EntradasProdutoIdentificacaoService({ db: deps.db || null });
  }
  return _entradasIdentificacao;
}

function obterResultadoMiipItem(parsed, indice) {
  const resultados = parsed?.miip_importacao?.resultados;
  if (!Array.isArray(resultados)) return null;
  return resultados.find((resultado) => Number(resultado?.indice) === indice)
    || resultados[indice]
    || null;
}

function candidatoMiip(resultado) {
  const produtoId = Number(resultado?.produtoEncontrado?.id);
  if (!Number.isInteger(produtoId) || produtoId <= 0) return null;
  return {
    produtoId,
    produto: resultado.produtoEncontrado,
    origem: 'MIIP',
    motor: resultado.motor || null
  };
}

function marcarConflitoIdentidade(parsed, item, indice, resultadoMip) {
  const resultadoMiip = obterResultadoMiipItem(parsed, indice) || item.miip_resultado || null;
  const eraAssociadoAutomaticamente = resultadoMiip?.associadoAutomaticamente === true;
  const candidatoExistente = candidatoMiip(resultadoMiip);
  const candidatosMip = resultadoMip.ambiguidade
    ? (resultadoMip.produtosCandidatos || [])
    : [{
      produtoId: resultadoMip.produtoId,
      produto: resultadoMip.produto || null,
      origem: 'MIP',
      strategy: resultadoMip.strategy || null
    }];
  const candidatos = [...(candidatoExistente ? [candidatoExistente] : []), ...candidatosMip]
    .filter((candidato, indiceAtual, lista) => (
      candidato.produtoId
      && lista.findIndex((outro) => Number(outro.produtoId) === Number(candidato.produtoId)) === indiceAtual
    ));
  const motivos = [
    ...(Array.isArray(resultadoMiip?.motivos) ? resultadoMiip.motivos : []),
    'identificadores_xml_apontam_para_produtos_diferentes'
  ];

  item.mip_resultado = {
    ...resultadoMip,
    encontrado: false,
    produtoId: null,
    ambiguidade: true,
    conflitoIdentidade: true,
    produtosCandidatos: candidatos
  };
  delete item.produto_id;

  if (resultadoMiip) {
    const resultadoRevisao = {
      ...resultadoMiip,
      associadoAutomaticamente: false,
      precisaConfirmacao: true,
      precisaCadastro: false,
      acao: 'REVISAR_MANUAL',
      motivos: [...new Set(motivos)],
      candidatos: [
        ...(Array.isArray(resultadoMiip.candidatos) ? resultadoMiip.candidatos : []),
        ...candidatos.filter((candidato) => (
          Number(candidato.produtoId) !== Number(resultadoMiip?.produtoEncontrado?.id)
        ))
      ]
    };
    item.miip_resultado = resultadoRevisao;

    const resultadoLote = obterResultadoMiipItem(parsed, indice);
    if (resultadoLote) Object.assign(resultadoLote, resultadoRevisao);

    const resumo = parsed?.miip_importacao?.resumo;
    if (resumo && eraAssociadoAutomaticamente) {
      resumo.identificadosAutomaticamente = Math.max(
        0,
        Number(resumo.identificadosAutomaticamente || 0) - 1
      );
      resumo.precisamConfirmacao = Number(resumo.precisamConfirmacao || 0) + 1;
    }
  }
}

/**
 * Passo MIP: preenche produto_id em itens ainda sem associação.
 * @param {Object} parsed
 * @param {Object} [deps]
 */
async function enriquecerItensComMip(parsed, deps = {}) {
  if (!isProdutoIdentidadeEnabled() && !deps.forcarMip) {
    return { aplicados: 0, tentados: 0 };
  }

  const svc = obterEntradasIdentificacao(deps);
  let aplicados = 0;
  let tentados = 0;
  let ambiguos = 0;

  for (let indice = 0; indice < (parsed.itens || []).length; indice += 1) {
    const item = parsed.itens[indice];
    const associacaoMiipAutomatica = item?.miip_resultado?.associadoAutomaticamente === true
      && Number(item?.produto_id) > 0;
    if (!item || (item.produto_id && !associacaoMiipAutomatica)) continue;
    tentados += 1;

    try {
      const r = await svc.identificarItem(item, {
        origem: deps.origem || 'xml_central'
      });
      if (r.ambiguidade) {
        if (associacaoMiipAutomatica) {
          marcarConflitoIdentidade(parsed, item, indice, r);
        } else {
          item.mip_resultado = r;
        }
        ambiguos += 1;
        continue;
      }

      if (r.encontrado && r.produtoId) {
        item.mip_resultado = {
          encontrado: true,
          produtoId: r.produtoId,
          metodo: r.metodo,
          strategy: r.strategy,
          codigoUsado: r.codigoUsado || null
        };
        if (associacaoMiipAutomatica && Number(item.produto_id) !== Number(r.produtoId)) {
          marcarConflitoIdentidade(parsed, item, indice, r);
          ambiguos += 1;
          continue;
        }
        if (!item.produto_id) item.produto_id = Number(r.produtoId);
        aplicados += 1;
      }
    } catch (err) {
      mipLogger.warn('xml item mip falhou', { erro: err.message });
    }
  }

  return { aplicados, tentados, ambiguos };
}

/**
 * @param {Object} parsed — saída de NFeParserService.parse()
 * @param {Object} [deps] — testes / override
 * @returns {Promise<{ parsed: Object, miipImportacao: Object|null, possuiPendencias: boolean, erroMiip?: string, mip?: Object }>}
 */
async function enriquecerParseComMiip(parsed, deps = {}) {
  const resultado = {
    parsed,
    miipImportacao: null,
    possuiPendencias: false,
    mip: null
  };

  try {
    const MiipService = deps.miipService || getMiipService();
    const MiipImportacaoXmlService = deps.miipImportacaoXmlService
      || require('../../motores/miip/services/MiipImportacaoXmlService');
    const miipImportacao = await MiipService.processarImportacaoXml(parsed);
    if (miipImportacao) {
      parsed.miip_importacao = miipImportacao;
      resultado.miipImportacao = miipImportacao;

      (miipImportacao.resultados || []).forEach((itemResultado, indice) => {
        const item = parsed.itens[indice];
        if (!item) return;

        item.miip_resultado = itemResultado;

        if (itemResultado.associadoAutomaticamente && itemResultado.produtoEncontrado?.id) {
          item.produto_id = itemResultado.produtoEncontrado.id;
        }

        const sugestao = MiipImportacaoXmlService.paraSugestaoUi(itemResultado);
        if (sugestao) {
          item.miip_sugestao = sugestao;
        }
      });

      resultado.possuiPendencias = extrairPendencias(miipImportacao.resultados || []).length > 0;
    }
  } catch (error) {
    mipLogger.error('Falha MIIP — parse segue sem bloqueio', { erro: error?.message });
    resultado.erroMiip = error.message;
  }

  // Sprint 07 — MIP para itens sem produto_id (Central / XML / Compras)
  try {
    resultado.mip = await enriquecerItensComMip(parsed, deps);
    if (resultado.mip.ambiguos > 0) {
      resultado.possuiPendencias = true;
    }
  } catch (mipErr) {
    mipLogger.warn('Falha MIP complementar no parse', { erro: mipErr.message });
    resultado.erroMip = mipErr.message;
  }

  return resultado;
}

module.exports = {
  enriquecerParseComMiip,
  enriquecerItensComMip,
  obterEntradasIdentificacao
};
