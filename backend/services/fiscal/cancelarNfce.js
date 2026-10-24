const crypto = require('crypto');
const { assinarEvento } = require('./signer');
const {
  carregarCertificadoPfx,
  extrairCnpjDoCertificadoPem
} = require('./certificateService');
const { compactarXml, extrairChaveEProtocoloAutorizados } = require('./utils');
const { validarMotivoTexto } = require('../validacao/validarMotivoTexto');
const { enviarCancelamento } = require('./cancelamentoRuntime');
const { logFiscalRuntime } = require('./core/FiscalRuntimeLog');
const {
  exigirEmpresaFiscalDaVenda,
  exigirContextoFiscalDaEmpresa,
  coerenciaDocumentoComVenda
} = require('./FiscalEmpresaContextoService');
const { exigirCertificadoAptoParaUsoFiscal } = require('./CertificadoUsoFiscalGate');

const STATUS_RETRYABLE = [
  'autorizada',
  'cancelamento_rejeitado',
  'cancelamento_falha_pre_envio'
];
const EVENT_TYPE_CANCELAMENTO = '110111';

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

function erroCancelamentoFiscal(code, message, statusCode, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function duracaoMs(started) {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function serializarEstadoCancelamento(state) {
  return `\n[CANCELAMENTO_NFCE] ${JSON.stringify(state)}\n`;
}

async function persistirResultado(db, notaId, status, registro, retorno) {
  const started = process.hrtime.bigint();
  try {
    const atualizacao = await dbRun(db, `
      UPDATE nfce_notas
      SET status = ?,
          xml_retorno = COALESCE(xml_retorno, '') || char(10) || ? || COALESCE(?, ''),
          updated_at = datetime('now', 'localtime')
      WHERE id = ? AND status = 'cancelamento_em_andamento'
    `, [
      status,
      serializarEstadoCancelamento(registro),
      retorno ? `\n${retorno}\n` : '',
      notaId
    ]);
    if (atualizacao.changes !== 1) {
      throw erroCancelamentoFiscal(
        'CANCELAMENTO_ESTADO_PERSISTENCIA_FALHOU',
        'Não foi possível persistir o resultado do cancelamento. A operação permanece bloqueada para evitar reenvio.',
        500
      );
    }
    logFiscalRuntime('CANCELAMENTO', {
      correlationId: registro.correlationId,
      etapa: 'persistencia_resultado',
      duracaoMs: duracaoMs(started),
      status,
      resultado: 'concluido'
    });
  } catch (error) {
    logFiscalRuntime('CANCELAMENTO', {
      correlationId: registro.correlationId,
      etapa: 'persistencia_resultado',
      duracaoMs: duracaoMs(started),
      resultado: 'falha',
      codigoErro: error.code || null
    });
    throw error;
  }
}

async function cancelarNfce(vendaId, justificativa, opcoes = {}) {
  const totalStarted = process.hrtime.bigint();
  const db = opcoes.db || require('../../database');

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

  const notaAutorizada = await dbGet(db, `
      SELECT *
      FROM nfce_notas
      WHERE venda_id = ?
        AND status IN (
          'autorizada',
          'cancelamento_rejeitado',
          'cancelamento_falha_pre_envio',
          'cancelamento_em_andamento',
          'cancelamento_desconhecido'
        )
        AND (
          (chave_acesso IS NOT NULL AND chave_acesso <> '')
          OR (xml_retorno IS NOT NULL AND xml_retorno LIKE '%<cStat>100</cStat>%')
        )
      ORDER BY CASE
        WHEN status IN ('cancelamento_em_andamento', 'cancelamento_desconhecido') THEN 0
        ELSE 1
      END, id DESC
      LIMIT 1
    `, [vendaId]);
  const correlationId = opcoes.correlationId || crypto.randomUUID();
  logFiscalRuntime('CANCELAMENTO', {
    correlationId,
    etapa: 'contexto_e_consulta_nota',
    duracaoMs: duracaoMs(totalStarted)
  });

  if (!notaAutorizada) {
    throw new Error('Nenhuma NFC-e autorizada encontrada para cancelar.');
  }
  coerenciaDocumentoComVenda({ nota: notaAutorizada, empresaFiscal });
  if (notaAutorizada.status === 'cancelamento_em_andamento') {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_EM_ANDAMENTO',
      'Já existe um cancelamento em andamento para esta NFC-e. Não envie outro evento.',
      409
    );
  }
  if (notaAutorizada.status === 'cancelamento_desconhecido') {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_RESULTADO_DESCONHECIDO',
      'O resultado fiscal do cancelamento é desconhecido. A NFC-e permanece bloqueada até reconciliação oficial; não tente reenviar.',
      202,
      { resultUnknown: true, notaId: notaAutorizada.id }
    );
  }
  if (!STATUS_RETRYABLE.includes(notaAutorizada.status)) {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_NAO_ELEGIVEL',
      'A NFC-e não está em um estado que permita iniciar o cancelamento.',
      409
    );
  }

  const getFiscalConfigFn = opcoes.getFiscalConfig;
  const config = await exigirContextoFiscalDaEmpresa({
    empresaId: empresaFiscal,
    db,
    validarUrls: false,
    getFiscalConfigFn
  });
  const exigirCert = typeof opcoes.exigirCertificadoAptoParaUsoFiscal === 'function'
    ? opcoes.exigirCertificadoAptoParaUsoFiscal
    : exigirCertificadoAptoParaUsoFiscal;
  const certificadoInfo = await exigirCert({
    empresaId: empresaFiscal,
    db,
    config,
    getFiscalConfigFn,
    deps: opcoes.certDeps || {}
  });

  const authSefaz = extrairChaveEProtocoloAutorizados(notaAutorizada.xml_retorno);
  const chaveAcesso = authSefaz?.chaveAcesso || notaAutorizada.chave_acesso;
  const protocolo = authSefaz?.protocolo || notaAutorizada.protocolo;

  if (!chaveAcesso || !protocolo) {
    throw new Error('NFC-e autorizada sem chave ou protocolo.');
  }
  const cnpjEmpresa = validarCnpjFiscal(config.cnpj);
  const chaveNormalizada = String(chaveAcesso);
  if (!/^\d{44}$/.test(chaveNormalizada)) {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_CHAVE_INVALIDA',
      'A chave de acesso da NFC-e não tem formato válido.',
      409
    );
  }
  if (chaveNormalizada.slice(6, 20) !== cnpjEmpresa) {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_CNPJ_DIVERGENTE',
      'O CNPJ da empresa não corresponde ao CNPJ da chave da NFC-e.',
      409
    );
  }

  if (authSefaz?.chaveAcesso && authSefaz.chaveAcesso !== notaAutorizada.chave_acesso) {
    console.warn(
      `[CANCELAMENTO] Corrigindo chave no banco: ${notaAutorizada.chave_acesso} -> ${authSefaz.chaveAcesso}`
    );

    const atualizacao = await dbRun(db, `
        UPDATE nfce_notas
        SET
          chave_acesso = ?,
          protocolo = COALESCE(?, protocolo),
          updated_at = datetime('now', 'localtime')
        WHERE id = ? AND status IN (?, ?, ?)
      `, [
      authSefaz.chaveAcesso,
      authSefaz.protocolo,
      notaAutorizada.id,
      ...STATUS_RETRYABLE
    ]);
    if (atualizacao.changes !== 1) {
      throw erroCancelamentoFiscal(
        'CANCELAMENTO_EM_ANDAMENTO',
        'Outro pedido iniciou o cancelamento desta NFC-e. Não envie outro evento.',
        409
      );
    }
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
  const preparationStarted = process.hrtime.bigint();

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
  logFiscalRuntime('CANCELAMENTO', {
    correlationId,
    etapa: 'preparacao_evento',
    duracaoMs: duracaoMs(preparationStarted)
  });

  const certificadoStarted = process.hrtime.bigint();
  const carregarPfx = opcoes.carregarCertificadoPfx || carregarCertificadoPfx;
  const certificado = carregarPfx(
    certificadoInfo.certificadoPath,
    certificadoInfo.certificadoSenha
  );
  const cnpjCertificado = extrairCnpjDoCertificadoPem(certificado.certPem);
  if (cnpjCertificado !== cnpjEmpresa) {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_CERTIFICADO_DIVERGENTE',
      'O CNPJ do certificado digital não corresponde ao CNPJ da empresa.',
      409
    );
  }
  logFiscalRuntime('CANCELAMENTO', {
    correlationId,
    etapa: 'carregamento_certificado',
    duracaoMs: duracaoMs(certificadoStarted)
  });

  const assinaturaStarted = process.hrtime.bigint();
  const assinar = opcoes.assinarEvento || assinarEvento;
  const assinatura = assinar(
    compactarXml(eventoXml),
    certificado.privateKeyPem,
    certificado.certPem
  );
  logFiscalRuntime('CANCELAMENTO', {
    correlationId,
    etapa: 'assinatura_evento',
    duracaoMs: duracaoMs(assinaturaStarted)
  });

  const eventoAssinado = assinatura.xmlAssinado;
  const envelopeStarted = process.hrtime.bigint();

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
  logFiscalRuntime('CANCELAMENTO', {
    correlationId,
    etapa: 'montagem_envelope_soap',
    duracaoMs: duracaoMs(envelopeStarted)
  });

  const attemptStartedAt = new Date().toISOString();
  const attempt = {
    correlationId,
    empresaId: empresaFiscal,
    notaId: notaAutorizada.id,
    chave: chaveAcesso,
    tpEvento: EVENT_TYPE_CANCELAMENTO,
    nSeqEvento,
    protocoloAutorizacao: protocolo,
    estado: 'EM_ANDAMENTO',
    iniciadoEm: attemptStartedAt
  };
  const claimStarted = process.hrtime.bigint();
  let claim;
  try {
    claim = await dbRun(db, `
      UPDATE nfce_notas
      SET status = 'cancelamento_em_andamento',
          xml_retorno = COALESCE(xml_retorno, '') || char(10) || ?,
          updated_at = datetime('now', 'localtime')
      WHERE id = ? AND status IN (?, ?, ?)
    `, [
      serializarEstadoCancelamento(attempt),
      notaAutorizada.id,
      ...STATUS_RETRYABLE
    ]);
  } catch (error) {
    logFiscalRuntime('CANCELAMENTO', {
      correlationId,
      etapa: 'persistencia_claim',
      duracaoMs: duracaoMs(claimStarted),
      resultado: 'falha',
      codigoErro: error.code || null
    });
    throw error;
  }
  logFiscalRuntime('CANCELAMENTO', {
    correlationId,
    etapa: 'persistencia_claim',
    duracaoMs: duracaoMs(claimStarted),
    resultado: claim.changes === 1 ? 'adquirido' : 'negado'
  });
  if (claim.changes !== 1) {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_EM_ANDAMENTO',
      'Outro pedido iniciou o cancelamento desta NFC-e. Não envie outro evento.',
      409
    );
  }

  const enviar = opcoes.enviarCancelamento || enviarCancelamento;
  let envio;
  try {
    envio = await enviar({
      envelope: soap,
      ambiente: config.ambiente,
      cUF: config.codigoUf,
      chave: chaveAcesso,
      protocolo,
      xJust: justificativa.trim(),
      certificadoPath: certificadoInfo.certificadoPath,
      certificadoSenha: certificadoInfo.certificadoSenha,
      safeCancellationMode: true,
      correlationId,
      empresaId: empresaFiscal,
      autorizacaoTransmissaoSefaz: opcoes.autorizacaoTransmissaoSefaz || null
    });
    if (envio && envio.bloqueadoAutorizacao === true) {
      throw erroCancelamentoFiscal(
        envio.codigo || envio.code || 'TRANSMISSAO_SEFAZ_NAO_AUTORIZADA',
        envio.error || envio.mensagem || 'Cancelamento NFC-e não executado: falta autorização operacional explícita.',
        403,
        { transmissionState: 'NOT_SENT', bloqueadoAutorizacao: true, notaId: notaAutorizada.id, correlationId }
      );
    }
  } catch (sendError) {
    const notSent = sendError.transmissionState === 'NOT_SENT';
    const status = notSent
      ? 'cancelamento_falha_pre_envio'
      : 'cancelamento_desconhecido';
    const record = {
      ...attempt,
      estado: notSent ? 'FALHA_PRE_ENVIO' : 'RESULTADO_DESCONHECIDO',
      concluidoEm: new Date().toISOString(),
      codigoErro: sendError.code || null
    };
    await persistirResultado(db, notaAutorizada.id, status, record, null);
    throw erroCancelamentoFiscal(
      notSent ? 'CANCELAMENTO_FALHA_PRE_ENVIO' : 'CANCELAMENTO_RESULTADO_DESCONHECIDO',
      notSent
        ? 'O cancelamento falhou antes do envio e pode ser tentado novamente.'
        : 'Não foi possível confirmar o resultado fiscal. A operação está bloqueada até reconciliação oficial; não tente reenviar.',
      notSent ? 503 : 202,
      { resultUnknown: !notSent, notaId: notaAutorizada.id, correlationId }
    );
  }

  const body = typeof envio.body === 'string' ? envio.body : '';
  const dadosEvento = extrairDadosEventoFiscal(body);
  const cStatEvento = dadosEvento.cStat;
  const retornoOficial = envio.transmissionState === 'RESPONSE_RECEIVED';
  const respostaEventoCorrelacionada = retornoOficial
    && dadosEvento.tpEvento === EVENT_TYPE_CANCELAMENTO
    && dadosEvento.chave === chaveAcesso
    && Boolean(cStatEvento);
  const protocoloCancelamento = dadosEvento.protocolo;
  const resultUnknown = envio.transmissionState !== 'NOT_SENT'
    && (
      !respostaEventoCorrelacionada
      || cStatEvento === '573'
      || cStatEvento === '631'
    );
  const canceladoComSucesso = respostaEventoCorrelacionada
    && ['135', '136', '155'].includes(cStatEvento)
    && Boolean(protocoloCancelamento);
  const rejeitado = respostaEventoCorrelacionada
    && Boolean(cStatEvento)
    && !canceladoComSucesso
    && !['573', '631'].includes(cStatEvento);
  const statusFinal = canceladoComSucesso
    ? 'cancelada'
    : (rejeitado
      ? 'cancelamento_rejeitado'
      : (envio.transmissionState === 'NOT_SENT'
        ? 'cancelamento_falha_pre_envio'
        : 'cancelamento_desconhecido'));
  const record = {
    ...attempt,
    estado: canceladoComSucesso
      ? 'CONFIRMADO'
      : (rejeitado
        ? 'REJEITADO'
        : (statusFinal === 'cancelamento_falha_pre_envio'
          ? 'FALHA_PRE_ENVIO'
          : 'RESULTADO_DESCONHECIDO')),
    concluidoEm: new Date().toISOString(),
    cStatEvento: cStatEvento || null,
    protocoloCancelamento: protocoloCancelamento || null,
    transmissionState: envio.transmissionState || 'UNKNOWN',
    codigoErro: envio.code || null
  };
  await persistirResultado(db, notaAutorizada.id, statusFinal, record, body);

  if (!canceladoComSucesso) {
    if (resultUnknown || statusFinal === 'cancelamento_desconhecido') {
      throw erroCancelamentoFiscal(
        'CANCELAMENTO_RESULTADO_DESCONHECIDO',
        'Não foi possível confirmar o resultado do cancelamento. A NFC-e permanece bloqueada até reconciliação oficial; não tente reenviar.',
        202,
        {
          resultUnknown: true,
          notaId: notaAutorizada.id,
          correlationId,
          cStatEvento: cStatEvento || null
        }
      );
    }
    throw erroCancelamentoFiscal(
      statusFinal === 'cancelamento_falha_pre_envio'
        ? 'CANCELAMENTO_FALHA_PRE_ENVIO'
        : 'CANCELAMENTO_REJEITADO',
      statusFinal === 'cancelamento_falha_pre_envio'
        ? 'O cancelamento falhou antes do envio e pode ser tentado novamente.'
        : (envio.xMotivo || 'Cancelamento rejeitado pela SEFAZ.'),
      statusFinal === 'cancelamento_falha_pre_envio' ? 503 : 400,
      { notaId: notaAutorizada.id, correlationId, cStatEvento: cStatEvento || null }
    );
  }

  return {
    sefaz: envio.body,
    notaId: notaAutorizada.id,
    chaveAcesso,
    protocolo,
    source: envio.source,
    fallbackUtilizado: envio.fallbackUtilizado,
    empresaId: empresaFiscal,
    correlationId,
    cStatEvento,
    protocoloCancelamento,
    status: 'cancelada'
  };
}

function extrairDadosEventoFiscal(xml) {
  const bloco = String(xml || '').match(/<(?:\w+:)?infEvento\b[\s\S]*?<\/(?:\w+:)?infEvento>/i);
  if (!bloco) {
    return { cStat: null, tpEvento: null, chave: null, protocolo: null };
  }
  const campo = (tag) => {
    const match = bloco[0].match(new RegExp(
      `<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`,
      'i'
    ));
    return match ? match[1].trim() : null;
  };
  return {
    cStat: campo('cStat'),
    tpEvento: campo('tpEvento'),
    chave: campo('chNFe'),
    protocolo: campo('nProt')
  };
}

function validarCnpjFiscal(valor) {
  const cnpj = String(valor || '').trim().replace(/[./-]/g, '');
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_CNPJ_INVALIDO',
      'O CNPJ configurado para a empresa não é válido.',
      409
    );
  }
  const digitosBase = cnpj.slice(0, 12).split('').map(Number);
  const calcularDigito = (digitos, pesos) => {
    const soma = pesos.reduce((total, peso, index) => total + digitos[index] * peso, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const primeiroDigito = calcularDigito(
    digitosBase,
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  );
  const segundoDigito = calcularDigito(
    [...digitosBase, primeiroDigito],
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  );
  if (primeiroDigito !== Number(cnpj[12]) || segundoDigito !== Number(cnpj[13])) {
    throw erroCancelamentoFiscal(
      'CANCELAMENTO_CNPJ_INVALIDO',
      'O CNPJ configurado para a empresa não passou na validação dos dígitos verificadores.',
      409
    );
  }
  return cnpj;
}

module.exports = cancelarNfce;
