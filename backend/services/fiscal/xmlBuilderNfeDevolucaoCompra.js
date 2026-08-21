/**
 * Builder XML NF-e de Devolução de Compra (finNFe=4).
 * Reutiliza utils/cert do motor oficial; não altera xmlBuilderNfeVenda.
 */

'use strict';

const {
  onlyDigits,
  formatNumber,
  nowDhEmi,
  gerarCodigoNumerico,
  gerarChaveAcesso,
  xmlEscape,
  compactarXml
} = require('./utils');
const { extrairNomeEmpresaDoCertificado } = require('./certificateService');

function limparCNPJ(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

function extrairCnpjDaChave(chave) {
  const limpa = onlyDigits(chave);
  return limpa.length === 44 ? limpa.substring(6, 20) : null;
}

function num(v, casas = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** casas;
  return Math.round(n * f) / f;
}

/**
 * Monta bloco <imposto>.
 * RC2: quando houver espelhamento da NF-e original, usa exclusivamente esses dados.
 * Sem espelhamento, não inventa alíquotas — exige CST/CSOSN informados no item.
 */
function montarImpostoItem({ compra, item, config, valorItem }) {
  if (item.impostoEspelhadoXml && String(item.impostoEspelhadoXml).trim()) {
    const t = item.tributosEspelhados || {};
    const icms = t.icms || {};
    const pis = t.pis || {};
    const cofins = t.cofins || {};
    const ipi = t.ipi || {};
    return {
      xml: item.impostoEspelhadoXml,
      totais: {
        vBC: num(icms.vBC),
        vICMS: num(icms.vICMS != null ? icms.vICMS : icms.vCredICMSSN),
        vBCST: num(icms.vBCST),
        vST: num(icms.vICMSST),
        vFCP: num(icms.vFCP),
        vFCPST: num(icms.vFCPST),
        vPis: num(pis.vPIS),
        vCofins: num(cofins.vCOFINS),
        vIpi: num(ipi.vIPI),
        vIpiDevol: num(item.v_ipi_devol != null ? item.v_ipi_devol : ipi.vIPI)
      },
      espelhado: true
    };
  }

  const crt = Number(config.crt || 1);
  const orig = String(
    item.origem != null && item.origem !== ''
      ? item.origem
      : (compra.origem_mercadoria != null ? compra.origem_mercadoria : '0')
  );

  const csosnRaw = String(
    item.csosn || item.CSOSN || compra.csosn_cst_xml || compra.csosn_cst || ''
  ).replace(/\D/g, '');
  const cstRaw = String(
    item.cst || item.CST || (csosnRaw.length === 2 ? '' : compra.csosn_cst || '')
  ).replace(/\D/g, '');

  if (!csosnRaw && !cstRaw) {
    throw Object.assign(
      new Error('Tributação ICMS (CST/CSOSN) não carregada da NF-e original.'),
      { code: 'TRIBUTACAO_AUSENTE', statusCode: 400 }
    );
  }

  const cstPis = String(item.cst_pis || compra.cst_pis_xml || compra.cst_pis || '').replace(/\D/g, '');
  const cstCofins = String(item.cst_cofins || compra.cst_cofins_xml || compra.cst_cofins || '').replace(/\D/g, '');
  const cstIpi = String(item.cst_ipi || compra.cst_ipi_xml || compra.cst_ipi || '').replace(/\D/g, '');

  if (!cstPis || !cstCofins) {
    throw Object.assign(
      new Error('CST PIS/COFINS não carregados da NF-e original.'),
      { code: 'TRIBUTACAO_AUSENTE', statusCode: 400 }
    );
  }

  const vBC = num(item.v_bc_icms != null ? item.v_bc_icms : (item.base_icms != null ? item.base_icms : null));
  const pICMS = num(item.p_icms != null ? item.p_icms : (item.aliquota_icms != null ? item.aliquota_icms : null));
  const vICMS = num(item.v_icms != null ? item.v_icms : (vBC != null && pICMS != null ? (vBC * pICMS) / 100 : null));

  const vBCPis = num(item.v_bc_pis);
  const pPis = num(item.p_pis);
  const vPis = num(item.v_pis != null ? item.v_pis : (vBCPis != null && pPis != null ? (vBCPis * pPis) / 100 : null));

  const vBCCofins = num(item.v_bc_cofins);
  const pCofins = num(item.p_cofins);
  const vCofins = num(item.v_cofins != null ? item.v_cofins : (vBCCofins != null && pCofins != null ? (vBCCofins * pCofins) / 100 : null));

  const vBCIpi = num(item.v_bc_ipi);
  const pIpi = num(item.p_ipi);
  const vIpi = num(item.v_ipi != null ? item.v_ipi : (vBCIpi != null && pIpi != null ? (vBCIpi * pIpi) / 100 : null));

  let icmsXml;
  if (crt === 1 || csosnRaw.length === 3) {
    const csosn = csosnRaw.padStart(3, '0').slice(-3);
    if (['101', '102', '103', '300', '400'].includes(csosn)) {
      icmsXml = `
            <ICMSSN${csosn === '101' ? '101' : '102'}>
              <orig>${orig}</orig>
              <CSOSN>${csosn}</CSOSN>
              ${csosn === '101' ? `<pCredSN>${formatNumber(pICMS || 0, 4)}</pCredSN><vCredICMSSN>${formatNumber(vICMS || 0, 2)}</vCredICMSSN>` : ''}
            </ICMSSN${csosn === '101' ? '101' : '102'}>`;
    } else if (csosn === '500') {
      icmsXml = `
            <ICMSSN500>
              <orig>${orig}</orig>
              <CSOSN>500</CSOSN>
            </ICMSSN500>`;
    } else {
      icmsXml = `
            <ICMSSN900>
              <orig>${orig}</orig>
              <CSOSN>${csosn}</CSOSN>
              ${vBC != null ? `<modBC>3</modBC><vBC>${formatNumber(vBC, 2)}</vBC><pICMS>${formatNumber(pICMS || 0, 4)}</pICMS><vICMS>${formatNumber(vICMS || 0, 2)}</vICMS>` : ''}
            </ICMSSN900>`;
    }
  } else {
    const cst = cstRaw.padStart(2, '0').slice(-2);
    if (['00', '20'].includes(cst)) {
      icmsXml = `
            <ICMS${cst}>
              <orig>${orig}</orig>
              <CST>${cst}</CST>
              <modBC>3</modBC>
              <vBC>${formatNumber(vBC || 0, 2)}</vBC>
              <pICMS>${formatNumber(pICMS || 0, 4)}</pICMS>
              <vICMS>${formatNumber(vICMS || 0, 2)}</vICMS>
            </ICMS${cst}>`;
    } else if (['40', '41', '50'].includes(cst)) {
      icmsXml = `
            <ICMS40>
              <orig>${orig}</orig>
              <CST>${cst}</CST>
            </ICMS40>`;
    } else {
      icmsXml = `
            <ICMS90>
              <orig>${orig}</orig>
              <CST>${cst}</CST>
              ${vBC != null ? `<modBC>3</modBC><vBC>${formatNumber(vBC, 2)}</vBC><pICMS>${formatNumber(pICMS || 0, 4)}</pICMS><vICMS>${formatNumber(vICMS || 0, 2)}</vICMS>` : ''}
            </ICMS90>`;
    }
  }

  const pisNt = ['04', '05', '06', '07', '08', '09'].includes(cstPis.padStart(2, '0'));
  const cofinsNt = ['04', '05', '06', '07', '08', '09'].includes(cstCofins.padStart(2, '0'));
  const cstPis2 = cstPis.padStart(2, '0').slice(0, 2);
  const cstCofins2 = cstCofins.padStart(2, '0').slice(0, 2);

  const pisXml = pisNt
    ? `<PIS><PISNT><CST>${cstPis2}</CST></PISNT></PIS>`
    : `<PIS><PISOutr><CST>${cstPis2}</CST><vBC>${formatNumber(vBCPis || 0, 2)}</vBC><pPIS>${formatNumber(pPis || 0, 4)}</pPIS><vPIS>${formatNumber(vPis || 0, 2)}</vPIS></PISOutr></PIS>`;

  const cofinsXml = cofinsNt
    ? `<COFINS><COFINSNT><CST>${cstCofins2}</CST></COFINSNT></COFINS>`
    : `<COFINS><COFINSOutr><CST>${cstCofins2}</CST><vBC>${formatNumber(vBCCofins || 0, 2)}</vBC><pCOFINS>${formatNumber(pCofins || 0, 4)}</pCOFINS><vCOFINS>${formatNumber(vCofins || 0, 2)}</vCOFINS></COFINSOutr></COFINS>`;

  let ipiXml = '';
  if (cstIpi) {
    const cstIpi2 = cstIpi.padStart(2, '0').slice(0, 2);
    const ipiNt = ['01', '02', '03', '04', '05', '51', '52', '53', '54', '55'].includes(cstIpi2);
    ipiXml = ipiNt
      ? `<IPI><cEnq>999</cEnq><IPINT><CST>${cstIpi2}</CST></IPINT></IPI>`
      : `<IPI><cEnq>999</cEnq><IPITrib><CST>${cstIpi2}</CST><vBC>${formatNumber(vBCIpi || 0, 2)}</vBC><pIPI>${formatNumber(pIpi || 0, 4)}</pIPI><vIPI>${formatNumber(vIpi || 0, 2)}</vIPI></IPITrib></IPI>`;
  }

  return {
    xml: `
          <ICMS>${icmsXml}
          </ICMS>
          ${ipiXml}
          ${pisXml}
          ${cofinsXml}`,
    totais: {
      vBC: num(vBC),
      vICMS: num(vICMS),
      vBCST: 0,
      vST: 0,
      vFCP: 0,
      vFCPST: 0,
      vPis: num(vPis),
      vCofins: num(vCofins),
      vIpi: num(vIpi),
      vIpiDevol: num(item.v_ipi_devol != null ? item.v_ipi_devol : vIpi)
    },
    espelhado: false
  };
}

/**
 * @param {object} params
 * @param {object} params.config
 * @param {object} params.compra
 * @param {Array} params.itens
 * @param {number} params.numero
 * @param {string} [params.observacoes]
 * @param {string} [params.cfopOverride]
 */
function buildXmlNFeDevolucaoCompra({ config, compra, itens, numero, observacoes, cfopOverride }) {
  const refNFe = onlyDigits(compra.chave_acesso || compra.refNFe || '');
  if (refNFe.length !== 44) {
    throw Object.assign(
      new Error('A compra precisa ter a chave de acesso da NF-e original com 44 dígitos.'),
      { code: 'REF_NFE_INVALIDA', statusCode: 400 }
    );
  }
  if (!Array.isArray(itens) || !itens.length) {
    throw Object.assign(new Error('Informe ao menos um produto para devolução.'), {
      code: 'ITENS_VAZIOS',
      statusCode: 400
    });
  }

  let cnpjFornecedor =
    limparCNPJ(compra.cnpj) ||
    limparCNPJ(compra.cpf_cnpj) ||
    limparCNPJ(compra.documento) ||
    limparCNPJ(compra.fornecedor_cnpj);

  if (!cnpjFornecedor) {
    cnpjFornecedor = extrairCnpjDaChave(refNFe);
  }
  if (!cnpjFornecedor || cnpjFornecedor.length !== 14) {
    throw Object.assign(new Error('Fornecedor da compra sem CNPJ válido.'), {
      code: 'FORNECEDOR_INVALIDO',
      statusCode: 400
    });
  }

  const dhEmi = nowDhEmi();
  const aamm = dhEmi.slice(2, 4) + dhEmi.slice(5, 7);
  const cNF = gerarCodigoNumerico();
  const serie = Number(config.serie || 1);

  const chave = gerarChaveAcesso({
    uf: config.codigoUf,
    aamm,
    cnpj: config.cnpj,
    modelo: '55',
    serie,
    numero,
    tpEmis: '1',
    cNF
  });

  const idDest =
    String((compra.uf || config.uf || '').toUpperCase()) === String(config.uf || '').toUpperCase()
      ? '1'
      : '2';
  const cfopPadrao = onlyDigits(cfopOverride || (idDest === '1' ? '5202' : '6202')).slice(0, 4)
    || (idDest === '1' ? '5202' : '6202');

  let nomeEmpresaCertificado = null;
  if (config.certificadoPath && config.certificadoSenha) {
    try {
      nomeEmpresaCertificado = extrairNomeEmpresaDoCertificado(
        config.certificadoPath,
        config.certificadoSenha
      );
    } catch (_) {
      /* fallback config */
    }
  }

  const nomeEmpresa = nomeEmpresaCertificado || config.nomeEmpresa || 'EMPRESA NAO INFORMADA';
  const xFant =
    nomeEmpresa
      .replace(/\s+(LTDA|EIRELI|ME|EPP|SS|S\/A|S\.A\.|LIMITADA|SOCIEDADE)\.?$/gi, '')
      .trim() || nomeEmpresa;

  let totalProdutos = 0;
  let totVBC = 0;
  let totVICMS = 0;
  let totVBCST = 0;
  let totVST = 0;
  let totVFCP = 0;
  let totVFCPST = 0;
  let totVPIS = 0;
  let totVCOFINS = 0;
  let totVIPI = 0;
  let totVIPIDevol = 0;

  const detXml = itens.map((item, idx) => {
    const nome = item.produto_nome || item.descricao_produto || 'PRODUTO DEVOLVIDO';
    const codigo = item.produto_codigo || item.produto_id || item.id || idx + 1;
    const ncm = onlyDigits(item.produto_ncm || item.ncm || '').padEnd(8, '0').slice(0, 8);
    if (!ncm || ncm === '00000000') {
      throw Object.assign(new Error(`NCM ausente no item ${idx + 1} (deve vir da NF-e original).`), {
        code: 'NCM_AUSENTE',
        statusCode: 400
      });
    }
    const cest = onlyDigits(item.cest || item.CEST || '');
    const unidade = String(item.produto_unidade || item.unidade || 'UN').substring(0, 6).toUpperCase();
    const qtd = Number(item.quantidade || 0);
    if (!(qtd > 0)) {
      throw Object.assign(new Error(`Quantidade inválida no item ${idx + 1}.`), {
        code: 'QTD_INVALIDA',
        statusCode: 400
      });
    }
    const valorUnit = Number(item.valor_unitario != null ? item.valor_unitario : (item.custo_unitario_final || item.preco_unitario || 0));
    const valorTotal = num(qtd * valorUnit);
    totalProdutos += valorTotal;

    const cfopItem = onlyDigits(item.cfop || cfopPadrao).slice(0, 4) || cfopPadrao;
    const imposto = montarImpostoItem({ compra, item, config, valorItem: valorTotal });
    totVBC += imposto.totais.vBC || 0;
    totVICMS += imposto.totais.vICMS || 0;
    totVBCST += imposto.totais.vBCST || 0;
    totVST += imposto.totais.vST || 0;
    totVFCP += imposto.totais.vFCP || 0;
    totVFCPST += imposto.totais.vFCPST || 0;
    totVPIS += imposto.totais.vPis || 0;
    totVCOFINS += imposto.totais.vCofins || 0;
    totVIPI += imposto.totais.vIpi || 0;
    totVIPIDevol += imposto.totais.vIpiDevol || 0;

    const gtin = onlyDigits(item.codigo_barras || item.produto_codigo_barras || item.cEAN || '');
    const cEAN = gtin.length >= 8 ? gtin : 'SEM GTIN';

    return `
      <det nItem="${idx + 1}">
        <prod>
          <cProd>${xmlEscape(codigo)}</cProd>
          <cEAN>${cEAN}</cEAN>
          <xProd>${xmlEscape(String(nome).substring(0, 120))}</xProd>
          <NCM>${ncm}</NCM>
          ${cest.length >= 7 ? `<CEST>${cest.slice(0, 7)}</CEST>` : ''}
          <CFOP>${cfopItem}</CFOP>
          <uCom>${xmlEscape(unidade)}</uCom>
          <qCom>${formatNumber(qtd, 4)}</qCom>
          <vUnCom>${formatNumber(valorUnit, 10)}</vUnCom>
          <vProd>${formatNumber(valorTotal, 2)}</vProd>
          <cEANTrib>${cEAN}</cEANTrib>
          <uTrib>${xmlEscape(unidade)}</uTrib>
          <qTrib>${formatNumber(qtd, 4)}</qTrib>
          <vUnTrib>${formatNumber(valorUnit, 10)}</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto>
          ${imposto.xml}
        </imposto>
      </det>`;
  }).join('');

  totalProdutos = num(totalProdutos);
  totVIPI = num(totVIPI);
  totVIPIDevol = num(totVIPIDevol);
  // Em devolução, IPI espelhado entra tipicamente como vIPIDevol (não soma em vIPI + vNF duplicado)
  const vIPIXml = totVIPIDevol > 0 ? 0 : totVIPI;
  const vIPIDevolXml = totVIPIDevol > 0 ? totVIPIDevol : 0;
  const vNF = num(totalProdutos + vIPIXml + vIPIDevolXml);

  const cplBase =
    observacoes ||
    `Devolução referente à NF-e ${refNFe}. Compra interna #${compra.id}.`;

  const xml = `
    <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
      <infNFe versao="4.00" Id="NFe${chave}">
        <ide>
          <cUF>${config.codigoUf}</cUF>
          <cNF>${cNF}</cNF>
          <natOp>DEVOLUCAO DE COMPRA</natOp>
          <mod>55</mod>
          <serie>${serie}</serie>
          <nNF>${numero}</nNF>
          <dhEmi>${dhEmi}</dhEmi>
          <dhSaiEnt>${dhEmi}</dhSaiEnt>
          <tpNF>1</tpNF>
          <idDest>${idDest}</idDest>
          <cMunFG>${config.municipioCodigo}</cMunFG>
          <tpImp>1</tpImp>
          <tpEmis>1</tpEmis>
          <cDV>${chave.slice(-1)}</cDV>
          <tpAmb>${config.ambiente}</tpAmb>
          <finNFe>4</finNFe>
          <indFinal>0</indFinal>
          <indPres>9</indPres>
          <procEmi>0</procEmi>
          <verProc>CDS-ERP-NFe-Dev-1.0</verProc>
          <NFref>
            <refNFe>${refNFe}</refNFe>
          </NFref>
        </ide>
        <emit>
          <CNPJ>${onlyDigits(config.cnpj)}</CNPJ>
          <xNome>${xmlEscape(nomeEmpresa)}</xNome>
          <xFant>${xmlEscape(xFant)}</xFant>
          <enderEmit>
            <xLgr>${xmlEscape(config.logradouro || 'ENDERECO NAO INFORMADO')}</xLgr>
            <nro>${xmlEscape((config.numero && String(config.numero).trim() !== '') ? String(config.numero).trim() : 'S/N')}</nro>
            <xBairro>${xmlEscape(config.bairro || 'CENTRO')}</xBairro>
            <cMun>${config.municipioCodigo}</cMun>
            <xMun>${xmlEscape(config.municipioNome)}</xMun>
            <UF>${xmlEscape(config.uf)}</UF>
            <CEP>${onlyDigits(config.cep)}</CEP>
            <cPais>1058</cPais>
            <xPais>BRASIL</xPais>
            <fone>${onlyDigits(config.telefone)}</fone>
          </enderEmit>
          <IE>${onlyDigits(config.ie)}</IE>
          <CRT>${config.crt}</CRT>
        </emit>
        <dest>
          <CNPJ>${cnpjFornecedor}</CNPJ>
          <xNome>${xmlEscape(compra.fornecedor || 'FORNECEDOR')}</xNome>
          <enderDest>
            <xLgr>${xmlEscape(compra.rua || 'NAO INFORMADO')}</xLgr>
            <nro>${xmlEscape(compra.numero || 'S/N')}</nro>
            <xBairro>${xmlEscape(compra.bairro || 'CENTRO')}</xBairro>
            <cMun>${onlyDigits(compra.codigo_municipio || config.municipioCodigo)}</cMun>
            <xMun>${xmlEscape(compra.cidade || config.municipioNome || 'MUNICIPIO')}</xMun>
            <UF>${xmlEscape(compra.uf || config.uf)}</UF>
            <CEP>${onlyDigits(compra.cep || '00000000')}</CEP>
            <cPais>1058</cPais>
            <xPais>BRASIL</xPais>
          </enderDest>
          <indIEDest>${compra.inscricao_estadual ? '1' : '9'}</indIEDest>
          ${compra.inscricao_estadual ? `<IE>${onlyDigits(compra.inscricao_estadual)}</IE>` : ''}
        </dest>
        ${detXml}
        <total>
          <ICMSTot>
            <vBC>${formatNumber(num(totVBC), 2)}</vBC>
            <vICMS>${formatNumber(num(totVICMS), 2)}</vICMS>
            <vICMSDeson>0.00</vICMSDeson>
            <vFCP>${formatNumber(num(totVFCP), 2)}</vFCP>
            <vBCST>${formatNumber(num(totVBCST), 2)}</vBCST>
            <vST>${formatNumber(num(totVST), 2)}</vST>
            <vFCPST>${formatNumber(num(totVFCPST), 2)}</vFCPST>
            <vFCPSTRet>0.00</vFCPSTRet>
            <vProd>${formatNumber(totalProdutos, 2)}</vProd>
            <vFrete>0.00</vFrete>
            <vSeg>0.00</vSeg>
            <vDesc>0.00</vDesc>
            <vII>0.00</vII>
            <vIPI>${formatNumber(vIPIXml, 2)}</vIPI>
            <vIPIDevol>${formatNumber(vIPIDevolXml, 2)}</vIPIDevol>
            <vPIS>${formatNumber(num(totVPIS), 2)}</vPIS>
            <vCOFINS>${formatNumber(num(totVCOFINS), 2)}</vCOFINS>
            <vOutro>0.00</vOutro>
            <vNF>${formatNumber(vNF, 2)}</vNF>
          </ICMSTot>
        </total>
        <transp><modFrete>9</modFrete></transp>
        <pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>
        <infAdic>
          <infCpl>${xmlEscape(String(cplBase).substring(0, 5000))}</infCpl>
        </infAdic>
      </infNFe>
    </NFe>
  `;

  return {
    chave,
    serie,
    refNFe,
    finNFe: 4,
    tpNF: 1,
    natOp: 'DEVOLUCAO DE COMPRA',
    totalProdutos: vNF,
    cfop: cfopPadrao,
    xmlSemAssinatura: compactarXml(xml)
  };
}

module.exports = {
  buildXmlNFeDevolucaoCompra,
  montarImpostoItem
};
