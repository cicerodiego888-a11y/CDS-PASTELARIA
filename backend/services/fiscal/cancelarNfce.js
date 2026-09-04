const dbDefault = require('../../database');
const { assinarEvento } = require('./signer');
const { carregarCertificadoPfx } = require('./certificateService');
const { compactarXml, extrairChaveEProtocoloAutorizados } = require('./utils');
const { validarMotivoTexto } = require('../validacao/validarMotivoTexto');
const { enviarCancelamento } = require('./cancelamentoRuntime');
const {
  exigirEmpresaFiscalDaVenda,
  exigirContextoFiscalDaEmpresa,
  obterCertificadoDaEmpresa,
  coerenciaDocumentoComVenda
} = require('./FiscalEmpresaContextoService');

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function cancelarNfce(vendaId, justificativa, opcoes = {}) {
  const db = opcoes.db || dbDefault;

  if (!vendaId) {
    throw new Error('venda_id é obrigatório para cancelar NFC-e.');
  }

  const validacaoJustificativa = validarMotivoTexto(justificativa);
  if (!validacaoJustificativa.valido) {
    throw new Error(validacaoJustificativa.erro);
  }

  const venda = await dbGet(db, `SELECT * FROM vendas WHERE id = ?`, [vendaId]);
  const empresaIdContexto = opcoes.empresaIdContexto != null ? opcoes.empresaIdContexto : opcoes.empresaId;
  const empresaFiscal = exigirEmpresaFiscalDaVenda({ venda, empresaIdContexto });

  const getFiscalConfigFn = opcoes.getFiscalConfig;
  const config = await exigirContextoFiscalDaEmpresa({
    empresaId: empresaFiscal,
    db,
    validarUrls: false,
    getFiscalConfigFn
  });
  const certificadoInfo = await obterCertificadoDaEmpresa({
    empresaId: empresaFiscal,
    db,
    getFiscalConfigFn
  });

  const notaAutorizada = await dbGet(db, `
      SELECT *
      FROM nfce_notas
      WHERE venda_id = ?
        AND status IN ('autorizada', 'cancelamento_rejeitado')
        AND (
          (chave_acesso IS NOT NULL AND chave_acesso <> '')
          OR (xml_retorno IS NOT NULL AND xml_retorno LIKE '%<cStat>100</cStat>%')
        )
      ORDER BY id DESC
      LIMIT 1
    `, [vendaId]);

  if (!notaAutorizada) {
    throw new Error('Nenhuma NFC-e autorizada encontrada para cancelar.');
  }
  coerenciaDocumentoComVenda({ nota: notaAutorizada, empresaFiscal });

  const authSefaz = extrairChaveEProtocoloAutorizados(notaAutorizada.xml_retorno);
  const chaveAcesso = authSefaz?.chaveAcesso || notaAutorizada.chave_acesso;
  const protocolo = authSefaz?.protocolo || notaAutorizada.protocolo;

  if (!chaveAcesso || !protocolo) {
    throw new Error('NFC-e autorizada sem chave ou protocolo.');
  }

  if (authSefaz?.chaveAcesso && authSefaz.chaveAcesso !== notaAutorizada.chave_acesso) {
    console.warn(
      `[CANCELAMENTO] Corrigindo chave no banco: ${notaAutorizada.chave_acesso} -> ${authSefaz.chaveAcesso}`
    );

    await dbRun(db, `
        UPDATE nfce_notas
        SET
          chave_acesso = ?,
          protocolo = COALESCE(?, protocolo),
          status = 'autorizada',
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `, [authSefaz.chaveAcesso, authSefaz.protocolo, notaAutorizada.id]);
  }

  function formatarDataHoraEvento(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');

    const ano = date.getFullYear();
    const mes = pad(date.getMonth() + 1);
    const dia = pad(date.getDate());
    const hora = pad(date.getHours());
    const min = pad(date.getMinutes());
    const seg = pad(date.getSeconds());

    return `${ano}-${mes}-${dia}T${hora}:${min}:${seg}-03:00`;
  }

  const dataEvento = formatarDataHoraEvento();
  const idLote = String(Date.now()).slice(-15);
  const nSeqEvento = '1';

  const eventoXml = `
    <evento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">
      <infEvento Id="ID110111${chaveAcesso}${nSeqEvento.padStart(2, '0')}">
        <cOrgao>${config.codigoUf}</cOrgao>
        <tpAmb>${config.ambiente}</tpAmb>
        <CNPJ>${String(config.cnpj || '').replace(/\D/g, '')}</CNPJ>
        <chNFe>${chaveAcesso}</chNFe>
        <dhEvento>${dataEvento}</dhEvento>
        <tpEvento>110111</tpEvento>
        <nSeqEvento>${nSeqEvento}</nSeqEvento>
        <verEvento>1.00</verEvento>
        <detEvento versao="1.00">
          <descEvento>Cancelamento</descEvento>
          <nProt>${protocolo}</nProt>
          <xJust>${justificativa.trim()}</xJust>
        </detEvento>
      </infEvento>
    </evento>
  `;

  const carregarPfx = opcoes.carregarCertificadoPfx || carregarCertificadoPfx;
  const certificado = carregarPfx(
    certificadoInfo.certificadoPath,
    certificadoInfo.certificadoSenha
  );

  const assinatura = assinarEvento(
    compactarXml(eventoXml),
    certificado.privateKeyPem,
    certificado.certPem
  );

  const eventoAssinado = assinatura.xmlAssinado;

  const envEvento = `
    <envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
      <idLote>${idLote}</idLote>
      ${eventoAssinado}
    </envEvento>
  `;

  const soap = `<?xml version="1.0" encoding="utf-8"?>
    <soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                     xmlns:xsd="http://www.w3.org/2003/XMLSchema"
                     xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
      <soap12:Header>
        <nfeCabecMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">
          <cUF>${config.codigoUf}</cUF>
          <versaoDados>1.00</versaoDados>
        </nfeCabecMsg>
      </soap12:Header>
      <soap12:Body>
        <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">
          ${compactarXml(envEvento)}
        </nfeDadosMsg>
      </soap12:Body>
    </soap12:Envelope>`;

  const enviar = opcoes.enviarCancelamento || enviarCancelamento;
  const envio = await enviar({
    envelope: soap,
    ambiente: config.ambiente,
    cUF: config.codigoUf,
    chave: chaveAcesso,
    protocolo,
    xJust: justificativa.trim(),
    certificadoPath: certificadoInfo.certificadoPath,
    certificadoSenha: certificadoInfo.certificadoSenha
  });

  if (!envio.success) {
    throw new Error(envio.error || 'Falha no cancelamento SEFAZ.');
  }

  return {
    sefaz: envio.body,
    notaId: notaAutorizada.id,
    chaveAcesso,
    protocolo,
    source: envio.source,
    fallbackUtilizado: envio.fallbackUtilizado,
    empresaId: empresaFiscal
  };
}

module.exports = cancelarNfce;
