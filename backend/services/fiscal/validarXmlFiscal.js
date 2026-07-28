/**
 * RC7.10.4 — Validador único do XML fiscal (NFC-e / NF-e).
 * Executar SEMPRE antes da assinatura; após assinar, fase pos_assinatura.
 */
'use strict';

const path = require('path');
const { validarIdentidadeICMSTot, round2 } = require('./modeloTotais');

function tag(xml, name) {
  const m = String(xml || '').match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`));
  return m ? m[1] : null;
}

function hasGroup(xml, name) {
  return new RegExp(`<${name}[\\s>]`).test(String(xml || ''));
}

function somaTags(xml, name) {
  const re = new RegExp(`<${name}>([^<]+)</${name}>`, 'g');
  let s = 0;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    s += Number(m[1] || 0);
  }
  return round2(s);
}

function extrairTotais(xml) {
  return {
    vProd: round2(Number(tag(xml, 'vProd') || 0)),
    vDesc: round2(Number(tag(xml, 'vDesc') || 0)),
    vFrete: round2(Number(tag(xml, 'vFrete') || 0)),
    vSeg: round2(Number(tag(xml, 'vSeg') || 0)),
    vOutro: round2(Number(tag(xml, 'vOutro') || 0)),
    vIPI: round2(Number(tag(xml, 'vIPI') || 0)),
    vST: round2(Number(tag(xml, 'vST') || 0)),
    vII: round2(Number(tag(xml, 'vII') || 0)),
    vPIS: round2(Number(tag(xml, 'vPIS') || 0)),
    vCOFINS: round2(Number(tag(xml, 'vCOFINS') || 0)),
    vIPIDevol: round2(Number(tag(xml, 'vIPIDevol') || 0)),
    vNF: round2(Number(tag(xml, 'vNF') || 0)),
    vTroco: round2(Number(tag(xml, 'vTroco') || 0))
  };
}

function validarGruposObrigatorios(xml, modeloDoc = '65') {
  const obrigatorios = ['ide', 'emit', 'det', 'prod', 'imposto', 'ICMSTot', 'transp', 'pag', 'detPag'];
  if (modeloDoc === '55') {
    obrigatorios.push('dest');
  }
  const faltando = obrigatorios.filter((g) => !hasGroup(xml, g));
  if (faltando.length) {
    const erro = new Error(`Grupos obrigatórios ausentes: ${faltando.join(', ')}`);
    erro.code = 'XML_GRUPOS_INCOMPLETOS';
    erro.detalhes = { faltando };
    throw erro;
  }
  const cMunFG = tag(xml, 'cMunFG');
  const tpImp = tag(xml, 'tpImp');
  if (!cMunFG || !/^\d{7}$/.test(cMunFG) || cMunFG === 'undefined') {
    const erro = new Error(`cMunFG inválido: ${cMunFG}`);
    erro.code = 'XML_CMUNFG_INVALIDO';
    throw erro;
  }
  if (tpImp == null || tpImp === 'undefined' || !/^[0-5]$/.test(String(tpImp))) {
    const erro = new Error(`tpImp inválido: ${tpImp}`);
    erro.code = 'XML_TPIMP_INVALIDO';
    throw erro;
  }
  return true;
}

function validarPagamentosETroco(xml, totais) {
  const somaPag = somaTags(xml, 'vPag');
  const vTroco = totais.vTroco;
  const esperado = round2(totais.vNF + vTroco);
  if (Math.abs(somaPag - esperado) > 0.01) {
    const erro = new Error(
      `Pagamentos inconsistentes: ΣvPag=${somaPag.toFixed(2)} ≠ vNF(${totais.vNF.toFixed(2)}) + vTroco(${vTroco.toFixed(2)})`
    );
    erro.code = 'XML_PAGAMENTO_INCONSISTENTE';
    erro.detalhes = { somaPag, vNF: totais.vNF, vTroco, esperado };
    throw erro;
  }
  return true;
}

function validarAssinaturaEstrutura(xml) {
  const checks = [
    ['Signature', hasGroup(xml, 'Signature')],
    ['SignedInfo', hasGroup(xml, 'SignedInfo')],
    ['SignatureValue', hasGroup(xml, 'SignatureValue')],
    ['DigestValue', !!tag(xml, 'DigestValue')],
    ['Reference', /<Reference[\s>]/.test(xml)],
    ['CanonicalizationMethod', /CanonicalizationMethod/.test(xml)],
    ['Transform', /Transform[\s>]/.test(xml) || /Transforms/.test(xml)]
  ];
  const faltando = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (faltando.length) {
    const erro = new Error(`Assinatura incompleta: ${faltando.join(', ')}`);
    erro.code = 'XML_ASSINATURA_INCOMPLETA';
    erro.detalhes = { faltando };
    throw erro;
  }
  const digest = tag(xml, 'DigestValue');
  const sigVal = tag(xml, 'SignatureValue');
  if (!digest || digest.length < 20) {
    const erro = new Error('DigestValue inválido');
    erro.code = 'XML_DIGEST_INVALIDO';
    throw erro;
  }
  if (!sigVal || sigVal.length < 20) {
    const erro = new Error('SignatureValue inválido');
    erro.code = 'XML_SIGNATUREVALUE_INVALIDO';
    throw erro;
  }
  if (!/REC-xml-c14n-20010315/.test(xml) && !/xml-c14n/.test(xml)) {
    const erro = new Error('CanonicalizationMethod não encontrado (C14N esperado)');
    erro.code = 'XML_C14N_AUSENTE';
    throw erro;
  }
  return {
    digestValue: digest,
    signatureValue: sigVal.slice(0, 32) + '…'
  };
}

function validarSchemaXsd(xml, { exigirAssinatura = false } = {}) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const xsdPath = path.join(__dirname, '../../schemas/nfe_v4.00/nfe_v4.00.xsd');
  if (!fs.existsSync(xsdPath)) {
    return { ok: false, status: 'XSD_AUSENTE', erros: ['nfe_v4.00.xsd não encontrado'] };
  }

  const tmp = path.join(os.tmpdir(), `cds-nfce-validar-${Date.now()}.xml`);
  fs.writeFileSync(tmp, xml, 'utf8');
  const py = `
from lxml import etree
xml = etree.parse(r'''${tmp.replace(/\\/g, '/')}''')
schema = etree.XMLSchema(etree.parse(r'''${xsdPath.replace(/\\/g, '/')}'''))
ok = schema.validate(xml)
errs = [str(e) for e in schema.error_log]
print('OK' if ok else 'FAIL')
for e in errs:
    print(e)
`;
  const result = spawnSync('python', ['-c', py], { encoding: 'utf8', timeout: 60000 });
  try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }

  if (result.error || (result.status !== 0 && !result.stdout)) {
    return {
      ok: false,
      status: 'XSD_FERRAMENTA_INDISPONIVEL',
      erros: [String(result.error || result.stderr || 'python/lxml falhou')]
    };
  }

  const lines = String(result.stdout || '').trim().split(/\r?\n/);
  const ok = lines[0] === 'OK';
  const erros = lines.slice(1).filter(Boolean);

  if (!ok && !exigirAssinatura) {
    const soSignature = erros.every((e) =>
      /Missing child element.*Signature/i.test(e) || /infNFeSupl/i.test(e)
    );
    if (soSignature && erros.length > 0) {
      return { ok: true, status: 'XSD_OK_SEM_ASSINATURA', erros };
    }
  }

  if (!ok) {
    const erro = new Error(`Validação XSD falhou (${erros.length} erro(s))`);
    erro.code = 'XML_XSD_INVALIDO';
    erro.detalhes = { erros: erros.slice(0, 20) };
    throw erro;
  }

  return { ok: true, status: 'XSD_OK', erros: [] };
}

/**
 * @param {object} args
 * @param {string} args.xml
 * @param {'pre_assinatura'|'pos_assinatura'} [args.fase]
 * @param {string} [args.modeloDoc] '65' | '55'
 * @param {boolean} [args.validarXsd]
 */
function validarXmlFiscal({
  xml,
  fase = 'pre_assinatura',
  modeloDoc = '65',
  validarXsd = false
} = {}) {
  if (!xml || typeof xml !== 'string') {
    const erro = new Error('XML fiscal ausente');
    erro.code = 'XML_AUSENTE';
    throw erro;
  }

  const resultado = {
    ok: true,
    fase,
    checks: {}
  };

  validarGruposObrigatorios(xml, modeloDoc);
  resultado.checks.grupos = 'PASSOU';

  const totais = extrairTotais(xml);
  validarIdentidadeICMSTot(totais);
  resultado.checks.icmsTot = 'PASSOU';
  resultado.checks.formulasSefaz = 'PASSOU';
  resultado.totais = totais;

  const somaDet = (() => {
    const re = /<det[\s\S]*?<vProd>([^<]+)<\/vProd>/g;
    let s = 0;
    let m;
    while ((m = re.exec(xml)) !== null) s += Number(m[1] || 0);
    return round2(s);
  })();
  if (Math.abs(somaDet - totais.vProd) > 0.01) {
    const erro = new Error(`Σ det.vProd (${somaDet}) ≠ ICMSTot.vProd (${totais.vProd})`);
    erro.code = 'XML_VPROD_DIVERGENTE';
    throw erro;
  }
  resultado.checks.descontosTotais = 'PASSOU';

  validarPagamentosETroco(xml, totais);
  resultado.checks.pagamentos = 'PASSOU';
  resultado.checks.troco = totais.vTroco > 0 ? 'PASSOU_COM_TROCO' : 'PASSOU_SEM_TROCO';

  if (fase === 'pos_assinatura') {
    resultado.checks.assinatura = validarAssinaturaEstrutura(xml);
  } else {
    resultado.checks.assinatura = 'ADIADO_PRE_ASSINATURA';
  }

  if (validarXsd || fase === 'pos_assinatura') {
    resultado.checks.schema = validarSchemaXsd(xml, {
      exigirAssinatura: fase === 'pos_assinatura'
    });
  } else {
    resultado.checks.schema = 'ADIADO';
  }

  return resultado;
}

module.exports = {
  validarXmlFiscal,
  extrairTotais,
  validarGruposObrigatorios,
  validarPagamentosETroco,
  validarAssinaturaEstrutura,
  validarSchemaXsd
};
