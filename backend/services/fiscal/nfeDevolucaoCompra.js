/**
 * NF-e de Devolução de Compra — MVP produção (RC1).
 * Reutiliza motor oficial: certificado, assinatura, validação, SOAP, parser, DANFE, numeração.
 * Builder específico: xmlBuilderNfeDevolucaoCompra (finNFe=4 + NFref).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../database');
const { getFiscalConfig } = require('./configService');
const { assinarNFe } = require('./signer');
const { montarLote, enviarLote } = require('./soapClient');
const { onlyDigits, compactarXml } = require('./utils');
const { getFiscalSubDir } = require('./paths');
const { validarXmlFiscal } = require('./validarXmlFiscal');
const { parseRetornoAutorizacaoNfe } = require('./nfeRetornoAutorizacao');
const { gerarDanfeNfeHtml } = require('./danfeNfe');
const { buildXmlNFeDevolucaoCompra } = require('./xmlBuilderNfeDevolucaoCompra');
const {
  espelharTributosNfeDevolucaoCompra,
  validarEspelhamentoAntesTransmissao
} = require('./espelharTributosNfeDevolucaoCompra');
const {
  garantirTabelasSaldoDevolucao,
  carregarSaldosDevolucaoCompra,
  validarQuantidadesContraSaldo,
  persistirItensNfeDevolucao,
  cancelarNfeDevolucaoCompra,
  listarNotasDevolucaoCompra,
  STATUS
} = require('./controleSaldoDevolucaoCompra');
const {
  carregarEValidarCertificadoNfe,
  getUrlNFe55,
  proximoNumeroNFeVenda
} = require('./nfeEmissorVenda');
const {
  garantirSchemaLifecycle,
  aposPersistirEmissao,
  cancelarNfeDevolucaoOficial,
  consultarSituacaoDevolucao,
  reenviarNfeDevolucao,
  listarEventosDevolucao,
  obterPainelStatus,
  obterXmlVersionado
} = require('./nfeDevolucaoLifecycleService');
const {
  uiDoEstado,
  podeReenviarDevolucao,
  podeCancelarDevolucao,
  mensagemRejeicaoDetalhada
} = require('./nfeDevolucaoEstados');
const configService = require('../configuracaoService');

function salvarDebug(nome, conteudo) {
  const pasta = getFiscalSubDir('debug/nfe-devolucao');
  fs.writeFileSync(path.join(pasta, nome), String(conteudo || ''), 'utf8');
}

async function garantirTabelas() {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS nfe_devolucoes_compra (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        compra_id INTEGER NOT NULL,
        numero INTEGER,
        serie INTEGER,
        chave_acesso TEXT,
        chave_referenciada TEXT,
        protocolo TEXT,
        ambiente INTEGER,
        status TEXT,
        natureza_operacao TEXT,
        cfop TEXT,
        xml_enviado TEXT,
        xml_retorno TEXT,
        danfe_html TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) return reject(err);
      const alters = [
        `ALTER TABLE nfe_devolucoes_compra ADD COLUMN chave_referenciada TEXT`,
        `ALTER TABLE nfe_devolucoes_compra ADD COLUMN natureza_operacao TEXT`,
        `ALTER TABLE nfe_devolucoes_compra ADD COLUMN cfop TEXT`,
        `ALTER TABLE nfe_devolucoes_compra ADD COLUMN danfe_html TEXT`
      ];
      let i = 0;
      const next = () => {
        if (i >= alters.length) {
          return garantirSchemaLifecycle().then(resolve).catch(reject);
        }
        db.run(alters[i++], () => next());
      };
      next();
    });
  });
}

function obterNotaAutorizadaPorCompra(compraId) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT * FROM nfe_devolucoes_compra
      WHERE compra_id = ? AND status = 'autorizada'
      ORDER BY id DESC LIMIT 1
    `, [compraId], (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function obterNotaEmAndamento(compraId) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT * FROM nfe_devolucoes_compra
      WHERE compra_id = ? AND status IN (
        'pendente','soap_enviado','enviada','aguardando_retorno',
        'lote_enviado','enviando','assinando','validando','processando'
      )
      ORDER BY id DESC LIMIT 1
    `, [compraId], (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function carregarCompraCabecalho(compraId) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT c.*,
        f.rua, f.numero, f.bairro, f.cidade, f.uf, f.cep, f.inscricao_estadual,
        f.cpf_cnpj AS fornecedor_doc_cadastro
      FROM compras c
      LEFT JOIN fornecedores f
        ON REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(f.cpf_cnpj,''),'.',''),'/',''),'-',''),' ','') =
           REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(c.fornecedor_cnpj,''),'.',''),'/',''),'-',''),' ','')
      WHERE c.id = ?
    `, [compraId], (err, compra) => {
      if (err) return reject(err);
      if (!compra) {
        return reject(Object.assign(new Error('Compra não encontrada.'), {
          code: 'COMPRA_NAO_ENCONTRADA',
          statusCode: 404
        }));
      }
      resolve(compra);
    });
  });
}

function carregarItensCompra(compraId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT
        ci.*,
        p.nome AS produto_nome,
        p.codigo AS produto_codigo,
        p.codigo_barras AS produto_codigo_barras,
        p.ncm AS produto_ncm,
        p.unidade AS produto_unidade,
        p.csosn AS produto_csosn,
        COALESCE((
          SELECT SUM(cd.quantidade)
          FROM compras_devolucoes cd
          WHERE cd.compra_item_id = ci.id
        ), 0) AS quantidade_devolvida
      FROM compras_itens ci
      LEFT JOIN produtos p ON p.id = ci.produto_id
      WHERE ci.compra_id = ?
      ORDER BY ci.id
    `, [compraId], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function carregarItensDevolucaoInterna(compraId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT
        cd.*,
        ci.descricao_produto,
        ci.codigo_barras,
        ci.ncm,
        ci.unidade,
        ci.preco_unitario,
        ci.custo_unitario_final,
        p.nome AS produto_nome,
        p.codigo AS produto_codigo,
        p.codigo_barras AS produto_codigo_barras,
        p.ncm AS produto_ncm,
        p.unidade AS produto_unidade,
        p.csosn AS produto_csosn
      FROM compras_devolucoes cd
      INNER JOIN compras_itens ci ON ci.id = cd.compra_item_id
      LEFT JOIN produtos p ON p.id = cd.produto_id
      WHERE cd.compra_id = ?
      ORDER BY cd.id
    `, [compraId], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function mapearTributosItem(compra, item) {
  const raw = String(item.csosn || item.produto_csosn || compra.csosn_cst_xml || compra.csosn_cst || '').trim();
  const digits = raw.replace(/\D/g, '');
  return {
    csosn: digits.length === 3 ? digits : '',
    cst: digits.length === 2 ? digits : String(compra.csosn_cst || '').replace(/\D/g, '').slice(0, 2),
    origem: item.origem != null && item.origem !== '' ? item.origem : 0,
    cst_pis: compra.cst_pis_xml || compra.cst_pis || '',
    cst_cofins: compra.cst_cofins_xml || compra.cst_cofins || '',
    cst_ipi: compra.cst_ipi_xml || compra.cst_ipi || ''
  };
}

function sugerirCfop(compra, config) {
  const ufEmpresa = String(config?.uf || '').toUpperCase();
  const ufForn = String(compra.uf || '').toUpperCase();
  return ufEmpresa && ufForn && ufEmpresa !== ufForn ? '6202' : '5202';
}

/**
 * Pré-preenchimento para a Central NF-e modo DEVOLUÇÃO (RC3: saldo por item).
 */
async function prepararNfeDevolucaoCompra(compraId) {
  await garantirTabelas();
  await garantirTabelasSaldoDevolucao();
  const id = Number(compraId);
  const compra = await carregarCompraCabecalho(id);
  const config = await getFiscalConfig();
  const chave = onlyDigits(compra.chave_acesso);
  const cfopSugerido = sugerirCfop(compra, config);

  const saldos = await carregarSaldosDevolucaoCompra(id);
  const notas = await listarNotasDevolucaoCompra(id);

  const itensComSaldo = saldos.itens
    .filter((s) => s.saldo > 0)
    .map((s) => {
      const trib = mapearTributosItem(compra, s);
      return {
        compra_item_id: s.compra_item_id,
        produto_id: s.produto_id,
        produto_nome: s.produto_nome,
        produto_codigo: s.produto_codigo,
        ncm: s.ncm,
        unidade: s.unidade,
        quantidade: s.saldo,
        quantidade_maxima: s.saldo,
        quantidade_comprada: s.quantidade_comprada,
        quantidade_devolvida: s.quantidade_devolvida,
        saldo: s.saldo,
        status_saldo: s.status,
        status_ui: s.status_ui,
        valor_unitario: s.valor_unitario,
        cfop: cfopSugerido,
        editavel_quantidade: true,
        bloqueado_tributos: true,
        ...trib
      };
    });

  // Itens sem saldo ainda aparecem na UI (histórico/status), mas não na emissão
  const itensPainel = saldos.itens.map((s) => ({
    compra_item_id: s.compra_item_id,
    produto_id: s.produto_id,
    produto_nome: s.produto_nome,
    produto_codigo: s.produto_codigo,
    quantidade_comprada: s.quantidade_comprada,
    quantidade_devolvida: s.quantidade_devolvida,
    saldo: s.saldo,
    status_saldo: s.status,
    status_ui: s.status_ui
  }));

  let espelhamento = null;
  let itensFinais = itensComSaldo;
  let motivoEspelhamento = null;

  if (chave.length === 44 && itensComSaldo.length) {
    try {
      espelhamento = await espelharTributosNfeDevolucaoCompra({
        compraId: id,
        chave,
        itens: itensComSaldo,
        cfopPadrao: cfopSugerido,
        exigirXml: false
      });
      if (espelhamento.ok) {
        itensFinais = espelhamento.itens.map((it) => {
          const saldoInfo = saldos.itens.find((s) => Number(s.compra_item_id) === Number(it.compra_item_id));
          return {
            ...it,
            quantidade_comprada: saldoInfo?.quantidade_comprada,
            quantidade_devolvida: saldoInfo?.quantidade_devolvida,
            saldo: saldoInfo?.saldo,
            quantidade_maxima: saldoInfo?.saldo,
            status_saldo: saldoInfo?.status,
            status_ui: saldoInfo?.status_ui
          };
        });
      } else {
        motivoEspelhamento = espelhamento.erro?.message
          || 'XML da NF-e original não encontrado para espelhamento fiscal.';
      }
    } catch (espErr) {
      motivoEspelhamento = espErr.message;
      espelhamento = { ok: false, erro: espErr };
    }
  }

  const compraCancelada = saldos.compraCancelada;
  const semSaldo = saldos.totais.saldo <= 0;
  const espelhamentoOk = Boolean(espelhamento?.ok) || !itensComSaldo.length;
  const podeEmitir = chave.length === 44
    && !compraCancelada
    && !semSaldo
    && itensFinais.length > 0
    && Boolean(espelhamento?.ok);

  let motivoBloqueio = null;
  if (!chave || chave.length !== 44) motivoBloqueio = 'Compra sem chave da NF-e (44 dígitos).';
  else if (compraCancelada) motivoBloqueio = 'Compra cancelada.';
  else if (semSaldo) motivoBloqueio = 'Compra totalmente devolvida — saldo zerado.';
  else if (!itensFinais.length) motivoBloqueio = 'Nenhum item com saldo disponível para devolução.';
  else if (!espelhamento?.ok) motivoBloqueio = motivoEspelhamento || 'Espelhamento fiscal da NF-e original indisponível.';

  return {
    tipoDocumento: 'DEVOLUCAO',
    finNFe: 4,
    origem: 'COMPRA',
    compraId: id,
    refNFe: chave,
    podeEmitir,
    motivoBloqueio,
    compra: {
      id: compra.id,
      fornecedor: compra.fornecedor,
      fornecedor_cnpj: compra.fornecedor_cnpj || compra.fornecedor_doc_cadastro,
      total: compra.total,
      status: compra.status,
      chave_acesso: chave,
      numero_nf: compra.numero_nf,
      serie_nf: compra.serie_nf,
      csosn_cst: compra.csosn_cst || compra.csosn_cst_xml,
      cst_pis: compra.cst_pis || compra.cst_pis_xml,
      cst_cofins: compra.cst_cofins || compra.cst_cofins_xml,
      cst_ipi: compra.cst_ipi || compra.cst_ipi_xml
    },
    cfopSugerido,
    camposEditaveis: ['quantidade', 'observacoes', 'cfop'],
    camposBloqueados: ['emitente', 'destinatario', 'refNFe', 'cst', 'csosn', 'tributos'],
    itens: itensFinais,
    itensPainel,
    controleSaldo: {
      statusCompra: saldos.statusCompra,
      statusCompraUi: saldos.statusCompraUi,
      totais: saldos.totais
    },
    tributacaoOriginal: espelhamento?.tributacaoOriginal || null,
    comparacaoFiscal: espelhamento?.comparacaoFiscal || [],
    ajustesFiscais: espelhamento?.ajustes || [],
    fonteXmlOrigem: espelhamento?.fonteXml || null,
    espelhamentoOk: Boolean(espelhamento?.ok),
    nfeDevolucoes: notas.map((n) => {
      const st = String(n.status || '').toLowerCase();
      return {
        id: n.id,
        status: n.status,
        statusUi: uiDoEstado(n.status),
        numero: n.numero,
        serie: n.serie,
        chave_acesso: n.chave_acesso,
        chave_referenciada: n.chave_referenciada || chave,
        protocolo: n.protocolo,
        recibo: n.recibo || null,
        consultado_em: n.consultado_em || null,
        sincronizado_em: n.sincronizado_em || null,
        rejeicao: n.rejeicao_codigo
          ? mensagemRejeicaoDetalhada(n.rejeicao_codigo, n.rejeicao_motivo)
          : null,
        created_at: n.created_at,
        quantidade_total: n.quantidade_total,
        tem_danfe: Boolean(n.tem_danfe),
        tem_danfe_cancelado: Boolean(n.tem_danfe_cancelado),
        tem_xml: Boolean(n.tem_xml),
        itens: n.itens || [],
        acoes: {
          downloadXml: Boolean(n.tem_xml),
          imprimirDanfe: Boolean(n.tem_danfe),
          consultar: Boolean(n.chave_acesso),
          reenviar: podeReenviarDevolucao({ status: st }),
          cancelar: podeCancelarDevolucao({ status: st })
        }
      };
    }),
    nfeDevolucao: notas.filter((n) => n.status === 'autorizada').slice(-1)[0] || null
  };
}

function resolverItensDoBody(compra, itensCompra, bodyItens, cfopPadrao) {
  return bodyItens.map((b) => {
    const base = itensCompra.find((i) => Number(i.id) === Number(b.compra_item_id || b.id))
      || itensCompra.find((i) => Number(i.produto_id) === Number(b.produto_id));
    if (!base) {
      throw Object.assign(new Error(`Item da compra não encontrado: ${b.compra_item_id || b.produto_id}`), {
        code: 'ITEM_NAO_ENCONTRADO',
        statusCode: 400
      });
    }
    const trib = mapearTributosItem(compra, base);
    const qtd = Number(b.quantidade);
    const max = Number(base.quantidade || 0);
    if (!(qtd > 0) || qtd > max + 1e-9) {
      throw Object.assign(
        new Error(`Quantidade inválida para o item ${base.produto_nome || base.id} (máx. ${max}).`),
        { code: 'QTD_INVALIDA', statusCode: 400 }
      );
    }
    return {
      ...base,
      ...trib,
      compra_item_id: base.id,
      quantidade: qtd,
      valor_unitario: Number(
        b.valor_unitario != null
          ? b.valor_unitario
          : (base.custo_unitario_final || base.preco_unitario || 0)
      ),
      cfop: onlyDigits(b.cfop || cfopPadrao).slice(0, 4) || cfopPadrao
    };
  });
}

function resolverItensDevolucaoInterna(compra, itensDev, cfopPadrao) {
  return itensDev.map((base) => {
    const trib = mapearTributosItem(compra, base);
    return {
      ...base,
      ...trib,
      quantidade: Number(base.quantidade || 0),
      valor_unitario: Number(base.valor_unitario || base.custo_unitario_final || base.preco_unitario || 0),
      cfop: cfopPadrao
    };
  });
}

function persistirNota(payload) {
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO nfe_devolucoes_compra (
        compra_id, numero, serie, chave_acesso, chave_referenciada, protocolo, ambiente,
        status, natureza_operacao, cfop, xml_enviado, xml_retorno, danfe_html, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      payload.compra_id,
      payload.numero,
      payload.serie,
      payload.chave_acesso,
      payload.chave_referenciada,
      payload.protocolo,
      payload.ambiente,
      payload.status,
      payload.natureza_operacao,
      payload.cfop,
      payload.xml_enviado,
      payload.xml_retorno,
      payload.danfe_html
    ], function onIns(err) {
      if (err) return reject(err);
      resolve(this.lastID);
    });
  });
}

/**
 * Emite NF-e de devolução via pipeline oficial (sign → validate → SEFAZ → parse).
 * @param {number} compraId
 * @param {object} [opcoes]
 */
async function emitirNFeDevolucaoCompra(compraId, opcoes = {}) {
  const { traceNfe } = require('./nfeTrace');
  traceNfe('emitirNFeDevolucaoCompra', {
    compraId,
    tipoDocumento: 'DEVOLUCAO',
    origem: 'COMPRA',
    arquivo: __filename
  });

  if (!configService.recursoHabilitado('nfe')) {
    return {
      success: false,
      status: 'modulo_desabilitado',
      message: 'Módulo NF-e desabilitado na implantação.'
    };
  }

  await garantirTabelas();
  await garantirTabelasSaldoDevolucao();
  const id = Number(compraId);

  const emAndamento = await obterNotaEmAndamento(id);
  if (emAndamento) {
    return {
      success: false,
      reused: true,
      idNota: emAndamento.id,
      notaId: emAndamento.id,
      status: emAndamento.status,
      numero: emAndamento.numero,
      serie: emAndamento.serie,
      chave: emAndamento.chave_acesso,
      chaveAcesso: emAndamento.chave_acesso,
      protocolo: emAndamento.protocolo,
      message: 'Há uma NF-e de devolução em andamento para esta compra. Aguarde o retorno da SEFAZ.'
    };
  }

  const compra = await carregarCompraCabecalho(id);
  if (String(compra.status || '').toLowerCase() === 'cancelada') {
    throw Object.assign(new Error('Compra cancelada — não é possível emitir NF-e de devolução.'), {
      code: 'COMPRA_CANCELADA',
      statusCode: 400
    });
  }
  if (opcoes.refNFe) {
    compra.chave_acesso = onlyDigits(opcoes.refNFe);
  }
  const refNFe = onlyDigits(compra.chave_acesso);
  if (refNFe.length !== 44) {
    throw Object.assign(
      new Error('Compra sem chave da NF-e original (44 dígitos).'),
      { code: 'REF_NFE_INVALIDA', statusCode: 400 }
    );
  }

  const config = await getFiscalConfig();
  const cfopPadrao = onlyDigits(opcoes.cfop || sugerirCfop(compra, config)).slice(0, 4)
    || sugerirCfop(compra, config);

  const saldos = await carregarSaldosDevolucaoCompra(id);
  if (saldos.totais.saldo <= 0) {
    throw Object.assign(
      new Error('Compra totalmente devolvida — não há saldo disponível para nova NF-e.'),
      { code: 'SALDO_ZERADO', statusCode: 400 }
    );
  }

  let itens;
  if (Array.isArray(opcoes.itens) && opcoes.itens.length) {
    const itensCompra = await carregarItensCompra(id);
    itens = resolverItensDoBody(compra, itensCompra, opcoes.itens, cfopPadrao);
  } else {
    // Prefill automático: devolve o saldo restante de cada item
    itens = saldos.itens
      .filter((s) => s.saldo > 0)
      .map((s) => {
        const trib = mapearTributosItem(compra, s);
        return {
          compra_item_id: s.compra_item_id,
          id: s.compra_item_id,
          produto_id: s.produto_id,
          produto_nome: s.produto_nome,
          produto_codigo: s.produto_codigo,
          ncm: s.ncm,
          unidade: s.unidade,
          quantidade: s.saldo,
          valor_unitario: s.valor_unitario,
          cfop: cfopPadrao,
          ...trib
        };
      });
  }
  if (!itens.length || !itens.some((i) => Number(i.quantidade) > 0)) {
    throw Object.assign(
      new Error('Quantidades inválidas para emissão da NF-e de devolução.'),
      { code: 'QTD_INVALIDA', statusCode: 400 }
    );
  }

  const itensAtivos = itens.filter((i) => Number(i.quantidade) > 0);
  const validacaoSaldo = validarQuantidadesContraSaldo({
    saldos,
    itensSolicitados: itensAtivos.map((i) => ({
      compra_item_id: i.compra_item_id || i.id,
      quantidade: i.quantidade,
      produto_nome: i.produto_nome
    })),
    compraCancelada: saldos.compraCancelada
  });
  if (!validacaoSaldo.ok) {
    throw Object.assign(
      new Error(validacaoSaldo.erros.join(' | ')),
      { code: 'SALDO_INSUFICIENTE', statusCode: 400, erros: validacaoSaldo.erros }
    );
  }

  const espelhamento = await espelharTributosNfeDevolucaoCompra({
    compraId: id,
    chave: refNFe,
    itens: itensAtivos,
    cfopPadrao,
    exigirXml: true
  });
  const validacaoEsp = validarEspelhamentoAntesTransmissao(espelhamento, espelhamento.itens);
  if (!validacaoEsp.ok) {
    throw Object.assign(
      new Error(`Inconsistência fiscal: ${validacaoEsp.erros.join(' | ')}`),
      { code: 'VALIDACAO_FISCAL', statusCode: 400, erros: validacaoEsp.erros }
    );
  }

  const numero = await proximoNumeroNFeVenda();
  const built = buildXmlNFeDevolucaoCompra({
    config,
    compra,
    itens: espelhamento.itens,
    numero,
    observacoes: opcoes.observacoes,
    cfopOverride: cfopPadrao
  });

  traceNfe('emitirNFeDevolucaoCompra→buildXml', {
    compraId: id,
    numero,
    chave: built.chave,
    finNFe: 4,
    refNFe: built.refNFe,
    espelhamento: true,
    fonteXml: espelhamento.fonteXml,
    qtdItens: espelhamento.itens.length
  });
  salvarDebug(`${id}-01-original.xml`, built.xmlSemAssinatura);
  salvarDebug(`${id}-rc2-espelhamento.json`, JSON.stringify({
    fonteXml: espelhamento.fonteXml,
    ajustes: espelhamento.ajustes,
    comparacaoFiscal: espelhamento.comparacaoFiscal,
    tributacaoOriginal: espelhamento.tributacaoOriginal
  }, null, 2));
  salvarDebug(`${id}-rc3-saldo.json`, JSON.stringify({
    totaisAntes: saldos.totais,
    itensSolicitados: itensAtivos.map((i) => ({
      compra_item_id: i.compra_item_id || i.id,
      quantidade: i.quantidade
    }))
  }, null, 2));

  try {
    validarXmlFiscal({
      xml: built.xmlSemAssinatura,
      fase: 'pre_assinatura',
      modeloDoc: '55',
      validarXsd: false
    });
  } catch (validErr) {
    return {
      success: false,
      status: 'erro_validacao',
      message: validErr.message || 'XML da NF-e de devolução inválido.',
      code: validErr.code || 'XML_INVALIDO',
      detalhes: validErr.detalhes || null
    };
  }

  let xmlAssinado;
  try {
    const { privateKeyPem, certPem } = carregarEValidarCertificadoNfe(config);
    const assinatura = assinarNFe(built.xmlSemAssinatura, privateKeyPem, certPem);
    xmlAssinado = compactarXml(assinatura?.xmlAssinado || '');
    if (!xmlAssinado) throw new Error('Assinatura da NF-e de devolução não gerou XML.');
    salvarDebug(`${id}-02-assinada.xml`, xmlAssinado);
  } catch (signErr) {
    const { classificarErro } = require('./nfeErros');
    const rawMsg = String(signErr.message || signErr);
    const amigavel = classificarErro({ erro: rawMsg });
    const notaId = await persistirNota({
      compra_id: id,
      numero,
      serie: built.serie,
      chave_acesso: built.chave,
      chave_referenciada: built.refNFe,
      protocolo: null,
      ambiente: config.ambiente,
      status: 'erro_assinatura',
      natureza_operacao: built.natOp,
      cfop: built.cfop,
      xml_enviado: built.xmlSemAssinatura,
      xml_retorno: rawMsg,
      danfe_html: null
    });
    await aposPersistirEmissao(notaId, {
      status: 'erro_assinatura',
      xmlGerado: built.xmlSemAssinatura,
      xmlRetorno: rawMsg,
      message: amigavel.mensagem || rawMsg,
      usuarioId: opcoes.usuarioId,
      usuarioNome: opcoes.usuarioNome,
      ip: opcoes.ip,
      computador: opcoes.computador
    });
    return {
      success: false,
      notaId,
      idNota: notaId,
      status: 'erro_assinatura',
      message: amigavel.mensagem || rawMsg,
      sugestao: amigavel.sugestao || null,
      code: 'ERRO_ASSINATURA'
    };
  }

  try {
    validarXmlFiscal({
      xml: xmlAssinado,
      fase: 'pos_assinatura',
      modeloDoc: '55',
      validarXsd: false
    });
  } catch (validErr) {
    return {
      success: false,
      status: 'erro_validacao',
      message: validErr.message || 'XML assinado inválido.',
      code: 'XML_INVALIDO'
    };
  }

  const loteXml = montarLote(xmlAssinado, String(numero));
  let soapResponse;
  try {
    soapResponse = await enviarLote({
      url: getUrlNFe55(config),
      loteXml,
      certificadoPath: config.certificadoPath,
      certificadoSenha: config.certificadoSenha,
      cUF: config.codigoUf,
      versaoDados: '4.00'
    });
  } catch (commErr) {
    const notaId = await persistirNota({
      compra_id: id,
      numero,
      serie: built.serie,
      chave_acesso: built.chave,
      chave_referenciada: built.refNFe,
      protocolo: null,
      ambiente: config.ambiente,
      status: 'erro_comunicacao',
      natureza_operacao: built.natOp,
      cfop: built.cfop,
      xml_enviado: xmlAssinado,
      xml_retorno: String(commErr.message || commErr),
      danfe_html: null
    });
    await aposPersistirEmissao(notaId, {
      status: 'erro_comunicacao',
      xmlGerado: built.xmlSemAssinatura,
      xmlAssinado,
      xmlRetorno: String(commErr.message || commErr),
      message: 'Erro de comunicação com a SEFAZ ao emitir NF-e de devolução.',
      usuarioId: opcoes.usuarioId,
      usuarioNome: opcoes.usuarioNome,
      ip: opcoes.ip,
      computador: opcoes.computador
    });
    return {
      success: false,
      notaId,
      idNota: notaId,
      status: 'erro_comunicacao',
      message: 'Erro de comunicação com a SEFAZ ao emitir NF-e de devolução.',
      detalhe: String(commErr.message || commErr),
      code: 'ERRO_COMUNICACAO'
    };
  }

  const raw = String(soapResponse.raw || soapResponse.message || '');
  salvarDebug(`${id}-03-retorno.xml`, raw);
  const parsed = parseRetornoAutorizacaoNfe(raw);
  let status = parsed.status || 'pendente';
  const protocolo = parsed.nProt || null;
  const chaveFinal = onlyDigits(parsed.chNFe || built.chave);

  let danfeHtml = null;
  if (status === 'autorizada') {
    try {
      const itensDanfe = (espelhamento.itens || []).filter((i) => Number(i.quantidade) > 0).map((i) => ({
        produto_nome: i.produto_nome || i.descricao_produto,
        quantidade_fiscal: Number(i.quantidade),
        valor_fiscal: Number(i.quantidade) * Number(i.valor_unitario || 0),
        preco_unitario: Number(i.valor_unitario || 0)
      }));
      danfeHtml = await gerarDanfeNfeHtml({
        venda: {
          valor_fiscal: built.totalProdutos,
          cliente_nome: compra.fornecedor
        },
        itens: itensDanfe,
        empresa: {
          nome: config.nomeEmpresa,
          cnpj: config.cnpj,
          ie: config.ie,
          endereco: config.logradouro || config.endereco
        },
        chave: chaveFinal,
        numero,
        serie: built.serie,
        protocolo,
        status,
        natureza: built.natOp
      });
    } catch (_) {
      /* DANFE opcional */
    }
  }

  const notaId = await persistirNota({
    compra_id: id,
    numero,
    serie: built.serie,
    chave_acesso: chaveFinal,
    chave_referenciada: built.refNFe,
    protocolo,
    ambiente: config.ambiente,
    status,
    natureza_operacao: built.natOp,
    cfop: built.cfop,
    xml_enviado: xmlAssinado,
    xml_retorno: raw,
    danfe_html: danfeHtml
  });

  const notaLifecycle = await aposPersistirEmissao(notaId, {
    parsed,
    status,
    xmlGerado: built.xmlSemAssinatura,
    xmlAssinado,
    xmlRetorno: raw,
    danfeGerado: Boolean(danfeHtml),
    usuarioId: opcoes.usuarioId,
    usuarioNome: opcoes.usuarioNome,
    ip: opcoes.ip,
    computador: opcoes.computador
  });
  status = (notaLifecycle && notaLifecycle.status) || status;

  let saldosApos = null;
  if (status === 'autorizada') {
    saldosApos = await persistirItensNfeDevolucao({
      nfeDevolucaoId: notaId,
      compraId: id,
      itens: espelhamento.itens,
      usuarioId: opcoes.usuarioId || null,
      usuarioNome: opcoes.usuarioNome || null
    });
    if (opcoes.usuarioId || opcoes.usuarioNome) {
      await new Promise((resolve) => {
        db.run(
          `UPDATE nfe_devolucoes_compra SET usuario_id = ?, usuario_nome = ? WHERE id = ?`,
          [opcoes.usuarioId || null, opcoes.usuarioNome || null, notaId],
          () => resolve()
        );
      });
    }
  }

  const msgDetalhada = (status === 'rejeitada' || status === 'denegada')
    ? mensagemRejeicaoDetalhada(parsed.cStat, parsed.xMotivo)
    : null;

  return {
    success: status === 'autorizada',
    tipoDocumento: 'DEVOLUCAO',
    finNFe: 4,
    origem: 'COMPRA',
    compraId: id,
    refNFe: built.refNFe,
    idNota: notaId,
    notaId,
    status,
    statusUi: uiDoEstado(status),
    numero,
    serie: built.serie,
    chave: chaveFinal,
    chaveAcesso: chaveFinal,
    protocolo: (notaLifecycle && notaLifecycle.protocolo) || protocolo,
    recibo: (notaLifecycle && notaLifecycle.recibo) || parsed.recibo || null,
    cStat: parsed.cStat,
    xMotivo: parsed.xMotivo,
    danfeHtml: Boolean(danfeHtml),
    controleSaldo: saldosApos
      ? { statusCompra: saldosApos.statusCompra, totais: saldosApos.totais }
      : { statusCompra: saldos.statusCompra, totais: saldos.totais },
    message: status === 'autorizada'
      ? 'NF-e de devolução autorizada com sucesso.'
      : (msgDetalhada || parsed.xMotivo || `NF-e de devolução não autorizada (status: ${status}).`),
    retorno: raw
  };
}

async function obterNfeDevolucaoPorId(notaId) {
  await garantirTabelas();
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM nfe_devolucoes_compra WHERE id = ?`, [Number(notaId)], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

async function listarHistoricoDevolucaoCompra(compraId) {
  await garantirTabelas();
  await garantirTabelasSaldoDevolucao();
  const compra = await carregarCompraCabecalho(compraId);
  const saldos = await carregarSaldosDevolucaoCompra(compraId);
  const notas = await listarNotasDevolucaoCompra(compraId);

  return {
    nfeOriginal: {
      chave: onlyDigits(compra.chave_acesso),
      numero: compra.numero_nf,
      serie: compra.serie_nf,
      fornecedor: compra.fornecedor
    },
    controleSaldo: {
      statusCompra: saldos.statusCompra,
      statusCompraUi: saldos.statusCompraUi,
      totais: saldos.totais,
      itens: saldos.itens
    },
    devolucoes: notas.map((n) => {
      const st = String(n.status || '').toLowerCase();
      return {
        id: n.id,
        numero: n.numero,
        serie: n.serie,
        chave_acesso: n.chave_acesso,
        chave_referenciada: n.chave_referenciada,
        protocolo: n.protocolo,
        recibo: n.recibo || null,
        status: n.status,
        statusUi: uiDoEstado(n.status),
        cStat: n.cstat_retorno || null,
        xMotivo: n.xmotivo_retorno || null,
        rejeicao: n.rejeicao_codigo
          ? mensagemRejeicaoDetalhada(n.rejeicao_codigo, n.rejeicao_motivo)
          : null,
        consultado_em: n.consultado_em || null,
        sincronizado_em: n.sincronizado_em || null,
        created_at: n.created_at,
        quantidade_total: n.quantidade_total,
        usuario_nome: n.usuario_nome,
        cancelado_em: n.cancelado_em,
        motivo_cancelamento: n.motivo_cancelamento,
        protocolo_cancelamento: n.protocolo_cancelamento || null,
        tem_danfe: Boolean(n.tem_danfe),
        tem_danfe_cancelado: Boolean(n.tem_danfe_cancelado),
        tem_xml: Boolean(n.tem_xml),
        itens: n.itens || [],
        acoes: {
          downloadXml: Boolean(n.tem_xml),
          imprimirDanfe: Boolean(n.tem_danfe),
          imprimirDanfeCancelado: Boolean(n.tem_danfe_cancelado),
          consultar: Boolean(n.chave_acesso),
          reenviar: podeReenviarDevolucao({ status: st }),
          cancelar: podeCancelarDevolucao({ status: st })
        }
      };
    })
  };
}

module.exports = {
  emitirNFeDevolucaoCompra,
  prepararNfeDevolucaoCompra,
  obterNfeDevolucaoPorId,
  listarHistoricoDevolucaoCompra,
  cancelarNfeDevolucaoCompra,
  cancelarNfeDevolucaoOficial,
  consultarSituacaoDevolucao,
  reenviarNfeDevolucao,
  listarEventosDevolucao,
  obterPainelStatus,
  obterXmlVersionado,
  garantirTabelas,
  sugerirCfop,
  STATUS
};
