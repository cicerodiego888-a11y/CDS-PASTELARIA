const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getFiscalConfig, setConfiguracao, dtoPublicoFiscalParaUi, filtrarPayloadConfigFiscalUi, completarUrlsGlobaisVazias } = require('../services/fiscal/configService');
const {
  substituirCertificadoEmpresa,
  testarCertificadoEmpresa,
  pastaTemporaria,
  rejeitarCaminhoCliente
} = require('../services/fiscal/CertificadoEmpresaService');
const { sanitizarTextoCertificado } = require('../services/fiscal/ValidarCertificadoA1Service');
const { CODIGOS_CERTIFICADO_A1, MENSAGENS_CERTIFICADO_A1 } = require('../services/fiscal/certificadoEstados');
const { emitirPorVendaId, obterDanfeHtmlAtualizado } = require('../services/fiscal/emissor');
const cancelarNfce = require('../services/fiscal/cancelarNfce');
const {
  criarAutorizacaoCancelamentoOperador
} = require('../services/fiscal/autorizacaoTransmissaoSefaz');
const { gravarAuditoria } = require('../services/auditoria');
const { validarMotivoTexto } = require('../services/validacao/validarMotivoTexto');
const { middlewareResolverEmpresaVenda } = require('../services/vendas/VendaEmpresaContextoService');
const {
  statusDeErroFiscalEmpresa,
  mensagemErroFiscalSanitizada
} = require('../services/fiscal/FiscalEmpresaContextoService');
const {
  exportarContabilidade,
  limparExportacaoTemporaria
} = require('../services/fiscal/exportarContabilidadeService');

// Middleware para carregar perfil do usuário
function carregarPerfilUsuario(req, res, next) {
  if (!req.user || !req.user.id) {
    return next();
  }

  db.get(
    'SELECT id, username, role, COALESCE(perfil, \'USUARIO\') as perfil FROM usuarios WHERE id = ?',
    [req.user.id],
    (err, usuario) => {
      if (err || !usuario) {
        return next();
      }
      req.user.perfil = usuario.perfil;
      next();
    }
  );
}

const pastaTmpCertificados = pastaTemporaria();
const anexarEmpresaFiscal = middlewareResolverEmpresaVenda({ db, exigirAutorizacaoUsuario: false });

function exigirAdminFiscal(req, res, next) {
  carregarPerfilUsuario(req, res, () => {
    const perfil = String((req.user && req.user.perfil) || '').toUpperCase();
    const role = String((req.user && req.user.role) || '');
    if (role === 'admin' || perfil === 'ADMIN' || perfil === 'SUPER_ADMIN') {
      return next();
    }
    return res.status(403).json({
      error: 'Apenas administradores podem gerenciar o certificado digital.',
      code: 'ADMIN_OBRIGATORIO'
    });
  });
}

function responderErroCertificado(res, error) {
  const status = Number(error && error.statusCode) || Number(error && error.status) || 500;
  const mensagem = sanitizarTextoCertificado(
    (error && error.message) || MENSAGENS_CERTIFICADO_A1.FALHA_INTERNA
  );
  const body = {
    error: mensagem,
    code: (error && error.code) || CODIGOS_CERTIFICADO_A1.ERRO,
    estado: (error && error.estado) || null,
    diagnostico_id: (error && error.diagnosticoId) || null,
    sefaz_chamado: false
  };
  if (error && error.validacao) {
    body.validacao = error.validacao;
  }
  return res.status(status).json(body);
}

function agoraLocalBrasil() {
  const agora = new Date();
  const dataBrasil = new Date(
    agora.toLocaleString('en-US', { timeZone: 'America/Fortaleza' })
  );
  const ano = dataBrasil.getFullYear();
  const mes = String(dataBrasil.getMonth() + 1).padStart(2, '0');
  const dia = String(dataBrasil.getDate()).padStart(2, '0');
  const hora = String(dataBrasil.getHours()).padStart(2, '0');
  const min = String(dataBrasil.getMinutes()).padStart(2, '0');
  const seg = String(dataBrasil.getSeconds()).padStart(2, '0');
  return `${ano}-${mes}-${dia} ${hora}:${min}:${seg}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, pastaTmpCertificados);
  },
  filename: (req, file, cb) => {
    cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pfx`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (ext !== '.pfx') {
      return cb(new Error('Envie apenas arquivo .pfx'));
    }

    cb(null, true);
  }
});

router.post('/certificado/upload', exigirAdminFiscal, upload.single('certificado'), async (req, res) => {
  const arquivoTmp = req.file && req.file.path ? path.resolve(req.file.path) : '';
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'Nenhum certificado enviado.',
        code: CODIGOS_CERTIFICADO_A1.ARQUIVO_OBRIGATORIO,
        sefaz_chamado: false
      });
    }

    rejeitarCaminhoCliente(req.body);
    const senha = req.body && (req.body.certificado_senha || req.body.senha);
    const resultado = await substituirCertificadoEmpresa({
      empresaId: req.body && (req.body.empresa_id != null ? req.body.empresa_id : req.body.empresaId),
      arquivoTmp,
      senha,
      usuario: req.user,
      deps: { db }
    });

    gravarAuditoria({
      usuario_id: req.user?.id || null,
      usuario_nome: req.user?.username || req.user?.nome || null,
      modulo: 'fiscal',
      acao: 'upload_certificado_empresa',
      referencia_tipo: 'empresa',
      referencia_id: resultado.empresa_id,
      detalhes: {
        empresa_id: resultado.empresa_id,
        certificado_nome: resultado.certificado_nome,
        estado: resultado.estado,
        ip: req.ip || null
      },
      ip_requisicao: req.ip || null
    }).catch((auditErr) => console.error('Erro ao gravar auditoria de certificado:', auditErr));

    return res.json({
      success: true,
      message: resultado.mensagem,
      empresa_id: resultado.empresa_id,
      certificado_nome: resultado.certificado_nome,
      certificado_configurado: resultado.certificado_configurado,
      certificado_validado: resultado.certificado_validado,
      certificado_status: resultado.certificado_status,
      estado: resultado.estado,
      codigo: resultado.codigo,
      titular: resultado.titular,
      validade_ate: resultado.validade_ate,
      diagnostico_id: resultado.diagnostico_id,
      sefaz_chamado: false
    });
  } catch (error) {
    try { if (arquivoTmp && fs.existsSync(arquivoTmp)) fs.unlinkSync(arquivoTmp); } catch (_e) { /* ignore */ }
    return responderErroCertificado(res, error);
  }
});

router.post('/certificado/testar', exigirAdminFiscal, upload.single('certificado'), async (req, res) => {
  const arquivoTmp = req.file && req.file.path ? path.resolve(req.file.path) : '';
  try {
    rejeitarCaminhoCliente(req.body);
    const senha = req.body && (req.body.certificado_senha || req.body.senha);
    const resultado = await testarCertificadoEmpresa({
      empresaId: req.body && (req.body.empresa_id != null ? req.body.empresa_id : req.body.empresaId),
      arquivoTmp: arquivoTmp || '',
      senha,
      usuario: req.user,
      body: req.body,
      deps: { db }
    });
    const status = resultado.ok ? 200 : 400;
    return res.status(status).json({
      success: !!resultado.ok,
      ...resultado
    });
  } catch (error) {
    try { if (arquivoTmp && fs.existsSync(arquivoTmp)) fs.unlinkSync(arquivoTmp); } catch (_e) { /* ignore */ }
    return responderErroCertificado(res, error);
  }
});

router.get('/config', async (req, res) => {
  try {
    await completarUrlsGlobaisVazias().catch(() => null);
    const config = await getFiscalConfig({ validarUrls: false });
    res.json(dtoPublicoFiscalParaUi(config));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/config', carregarPerfilUsuario, async (req, res) => {
  try {
    const payload = filtrarPayloadConfigFiscalUi(req.body || {});

    // Validação do número NFC-e
    if (payload.fiscal_numero_atual !== undefined) {
      const numeroAtual = parseInt(payload.fiscal_numero_atual, 10);

      if (numeroAtual < 0) {
        return res.status(400).json({
          error: 'Número NFC-e inválido'
        });
      }

      // Proteção: apenas SUPER_ADMIN pode alterar numeração NFC-e
      const usuario = req.user || {};
      if (usuario.perfil !== 'SUPER_ADMIN') {
        gravarAuditoria({
          usuario_id: usuario.id || null,
          usuario_nome: usuario.username || usuario.nome || null,
          modulo: 'fiscal',
          acao: 'tentativa_alterar_numeracao_nfce_negada',
          referencia_tipo: 'nfce',
          referencia_id: null,
          detalhes: {
            numero_solicitado: numeroAtual,
            perfil: usuario.perfil || null,
            ip: req.ip || null
          },
          ip_requisicao: req.ip || null
        }).catch((auditErr) => console.error('Erro ao gravar auditoria fiscal:', auditErr));
        return res.status(403).json({
          error: 'Apenas SUPER ADMIN pode alterar a numeração NFC-e.'
        });
      }

      gravarAuditoria({
        usuario_id: usuario.id || null,
        usuario_nome: usuario.username || usuario.nome || null,
        modulo: 'fiscal',
        acao: 'alterar_numeracao_nfce',
        referencia_tipo: 'nfce',
        referencia_id: null,
        detalhes: { numero_atual: numeroAtual, ip: req.ip || null },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao gravar auditoria fiscal:', auditErr));
    }

    const entries = Object.entries(payload);

    for (const [chave, valor] of entries) {
      await setConfiguracao(chave, String(valor ?? ''), 'string', `Configuração fiscal: ${chave}`);
    }

    await completarUrlsGlobaisVazias().catch(() => null);

    gravarAuditoria({
      usuario_id: req.user?.id || null,
      usuario_nome: req.user?.username || req.user?.nome || null,
      modulo: 'fiscal',
      acao: 'atualizar_config_fiscal',
      referencia_tipo: 'configuracao_fiscal',
      referencia_id: null,
      detalhes: { chaves: entries.map(([chave]) => chave), ip: req.ip || null },
      ip_requisicao: req.ip || null
    }).catch((auditErr) => console.error('Erro ao gravar auditoria fiscal:', auditErr));

    res.json({ message: 'Configurações fiscais atualizadas com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Rota legada — NÃO aceita caminho arbitrário do cliente.
 * Exige empresa_id e resolve o PFX apenas da configuração persistida da empresa.
 */
router.post('/config/certificado/testar', exigirAdminFiscal, async (req, res) => {
  try {
    rejeitarCaminhoCliente(req.body || {});
    const empresaId = req.body && (req.body.empresa_id != null ? req.body.empresa_id : req.body.empresaId);
    const senha = req.body && (req.body.certificado_senha || req.body.senha);
    const resultado = await testarCertificadoEmpresa({
      empresaId,
      arquivoTmp: '',
      senha: senha || '',
      usuario: req.user,
      body: req.body,
      deps: { db }
    });
    const status = resultado.ok ? 200 : 400;
    return res.status(status).json({
      success: !!resultado.ok,
      ...resultado,
      sefaz_chamado: false
    });
  } catch (error) {
    return responderErroCertificado(res, error);
  }
});

router.post('/emitir/venda/:vendaId', anexarEmpresaFiscal, async (req, res) => {
  try {
    const vendaId = Number(req.params.vendaId);
    const resultado = await emitirPorVendaId(vendaId, { empresaIdContexto: req.empresaId });

    gravarAuditoria({
      usuario_id: req.user?.id || null,
      usuario_nome: req.user?.username || req.user?.nome || null,
      modulo: 'fiscal',
      acao: 'emitir_nfce',
      referencia_tipo: 'venda',
      referencia_id: vendaId,
      detalhes: {
        status: resultado?.status || null,
        nota_id: resultado?.notaId || resultado?.id || null,
        ip: req.ip || null
      },
      ip_requisicao: req.ip || null
    }).catch((auditErr) => console.error('Erro ao gravar auditoria de emissão NFC-e:', auditErr));

    res.json(resultado);
  } catch (error) {
    const status = statusDeErroFiscalEmpresa(error);
    if (error && (error.code === 'VENDA_NAO_ENCONTRADA' || status === 404)) {
      return res.status(404).json({
        success: false,
        status: 'erro_emissao',
        message: 'Venda não encontrada.',
        code: 'VENDA_NAO_ENCONTRADA'
      });
    }
    console.error('Erro ao emitir NFC-e:', mensagemErroFiscalSanitizada(error));
    res.status(status >= 400 && status < 600 ? status : 200).json({
      success: false,
      status: 'erro_emissao',
      message: mensagemErroFiscalSanitizada(error),
      code: error && error.code
    });
  }
});

router.get('/danfe/venda/:vendaId', anexarEmpresaFiscal, async (req, res) => {
  const vendaId = Number(req.params.vendaId);

  try {
    const { html } = await obterDanfeHtmlAtualizado(vendaId, { empresaIdContexto: req.empresaId });
    if (!html) {
      return res.status(404).send('DANFE não gerado para esta NFC-e.');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  } catch (error) {
    const statusFiscal = statusDeErroFiscalEmpresa(error);
    if (error && error.code === 'VENDA_NAO_ENCONTRADA') {
      return res.status(404).send('Venda não encontrada.');
    }
    console.error('Erro ao gerar DANFE atualizado:', mensagemErroFiscalSanitizada(error));
    const msg = mensagemErroFiscalSanitizada(error) || 'Erro interno ao buscar DANFE.';
    const status = /não encontrada/i.test(msg) || statusFiscal === 404 ? 404 : (statusFiscal || 500);
    return res.status(status).send(msg);
  }
});

function extrairTagXml(xml, tag) {
  const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 'i');
  const match = String(xml || '').match(regex);
  return match ? match[1] : null;
}

function extrairCancelamentoSefaz(xml) {
  const texto = String(xml || '');

  const blocoEventoMatch = texto.match(/<retEvento[\s\S]*?<\/retEvento>/i);
  const blocoEvento = blocoEventoMatch ? blocoEventoMatch[0] : texto;

  return {
    cStatLote: extrairTagXml(texto, 'cStat'),
    xMotivoLote: extrairTagXml(texto, 'xMotivo'),
    cStatEvento: extrairTagXml(blocoEvento, 'cStat'),
    xMotivoEvento: extrairTagXml(blocoEvento, 'xMotivo'),
    protocoloCancelamento: extrairTagXml(blocoEvento, 'nProt'),
    dataCancelamento: extrairTagXml(blocoEvento, 'dhRegEvento')
  };
}

router.post('/notas/:id/cancelar', anexarEmpresaFiscal, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { justificativa } = req.body || {};

    const validacaoJustificativa = validarMotivoTexto(justificativa);
    if (!validacaoJustificativa.valido) {
      return res.status(400).json({
        error: validacaoJustificativa.erro
      });
    }

    // Fail-closed: autorização SEFAZ nunca vem do cliente.
    const body = req.body || {};
    if (
      body.autorizacaoTransmissaoSefaz != null
      || body.tokenSeed != null
      || body.token != null
    ) {
      return res.status(403).json({
        success: false,
        error: 'Autorização de transmissão SEFAZ não pode ser enviada pelo cliente.',
        code: 'TRANSMISSAO_SEFAZ_NAO_AUTORIZADA',
        status: 'transmissao_nao_autorizada'
      });
    }

    db.get(`
      SELECT n.*, v.empresa_id AS venda_empresa_id
      FROM nfce_notas n
      INNER JOIN vendas v ON v.id = n.venda_id
      WHERE n.id = ?
        AND v.empresa_id = ?
    `, [id, req.empresaId], async (err, nota) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (!nota) {
        return res.status(404).json({ error: 'NFC-e não encontrada.', code: 'NFCE_NAO_ENCONTRADA' });
      }

      if (!nota.venda_id) {
        return res.status(400).json({
          error: 'NFC-e sem venda vinculada. Não é possível cancelar.'
        });
      }

      db.get(`
        SELECT id, status
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
        ORDER BY id DESC
        LIMIT 1
      `, [nota.venda_id], async (authErr, notaAutorizada) => {
        if (authErr) {
          return res.status(500).json({ error: authErr.message });
        }

        if (!notaAutorizada) {
          return res.status(400).json({
            error: 'Nenhuma NFC-e autorizada encontrada para esta venda.'
          });
        }

        try {
          const cancelamento = await cancelarNfce(nota.venda_id, justificativa.trim(), {
            empresaIdContexto: req.empresaId,
            // Servidor-only: nunca aceitar autorizacaoTransmissaoSefaz do body.
            autorizacaoTransmissaoSefaz: criarAutorizacaoCancelamentoOperador({
              empresaId: req.empresaId,
              usuarioId: req.user?.id || null
            })
          });
          const notaIdAutorizada = cancelamento.notaId;

          const retornoTexto = typeof cancelamento.sefaz === 'string'
            ? cancelamento.sefaz
            : JSON.stringify(cancelamento.sefaz);

          const dadosCancelamento = extrairCancelamentoSefaz(retornoTexto);
          res.json({
            success: true,
            message: 'NFC-e cancelada com confirmação fiscal.',
            status: 'cancelada',
            notaId: notaIdAutorizada,
            chaveAcesso: cancelamento.chaveAcesso,
            protocoloCancelamento: cancelamento.protocoloCancelamento
              || dadosCancelamento.protocoloCancelamento,
            dataCancelamento: dadosCancelamento.dataCancelamento,
            correlationId: cancelamento.correlationId,
            retorno: cancelamento.sefaz,
            dadosCancelamento
          });

          gravarAuditoria({
            usuario_id: req.user?.id || null,
            usuario_nome: req.user?.username || req.user?.nome || null,
            modulo: 'fiscal',
            acao: 'cancelar_nfce',
            referencia_tipo: 'nfce',
            referencia_id: notaIdAutorizada,
            detalhes: {
              venda_id: nota.venda_id,
              justificativa: justificativa.trim(),
              protocolo: cancelamento.protocoloCancelamento
                || dadosCancelamento.protocoloCancelamento || null,
              correlation_id: cancelamento.correlationId,
              ip: req.ip || null
            },
            ip_requisicao: req.ip || null
          }).catch((auditErr) => console.error('Erro ao gravar auditoria de cancelamento NFC-e:', auditErr));
        } catch (cancelErr) {
          const status = cancelErr.statusCode || statusDeErroFiscalEmpresa(cancelErr);
          const code = cancelErr && cancelErr.code;
          const bloqueadoAutorizacao = cancelErr.bloqueadoAutorizacao === true
            || String(code || '').startsWith('TRANSMISSAO_SEFAZ_');
          let statusOperacional;
          if (cancelErr.resultUnknown) {
            statusOperacional = 'cancelamento_desconhecido';
          } else if (code === 'CANCELAMENTO_EM_ANDAMENTO') {
            statusOperacional = 'cancelamento_em_andamento';
          } else if (bloqueadoAutorizacao) {
            statusOperacional = 'transmissao_nao_autorizada';
          } else if (code === 'CANCELAMENTO_FALHA_PRE_ENVIO') {
            statusOperacional = 'cancelamento_falha_pre_envio';
          } else if (code === 'CANCELAMENTO_REJEITADO') {
            statusOperacional = 'cancelamento_rejeitado';
          } else if (code === 'CANCELAMENTO_NAO_ELEGIVEL') {
            statusOperacional = 'cancelamento_nao_elegivel';
          }
          return res.status(status).json({
            success: false,
            error: status === 404 ? 'NFC-e não encontrada.' : mensagemErroFiscalSanitizada(cancelErr),
            code,
            resultUnknown: cancelErr.resultUnknown === true,
            bloqueadoAutorizacao: bloqueadoAutorizacao || undefined,
            status: statusOperacional,
            correlationId: cancelErr.correlationId
          });
        }
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/notas', anexarEmpresaFiscal, (req, res) => {
  const todas = req.query.todas === '1';
  const params = [req.empresaId];
  let where = ' WHERE v.empresa_id = ? ';

  if (!todas) {
    const dataHoje = agoraLocalBrasil().split(' ')[0];
    where += ' AND DATE(n.created_at) = ? ';
    params.push(dataHoje);
  }

  db.all(`
    SELECT n.*, v.codigo as venda_codigo, v.total as venda_total
    FROM nfce_notas n
    INNER JOIN vendas v ON v.id = n.venda_id
    ${where}
    ORDER BY n.id DESC
  `, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

router.get('/notas/:id', anexarEmpresaFiscal, (req, res) => {
  db.get(`
    SELECT n.*, v.codigo as venda_codigo, v.total as venda_total
    FROM nfce_notas n
    INNER JOIN vendas v ON v.id = n.venda_id
    WHERE n.id = ?
      AND v.empresa_id = ?
  `, [req.params.id, req.empresaId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'NFC-e não encontrada.', code: 'NFCE_NAO_ENCONTRADA' });
    res.json(row);
  });
});

router.post('/exportar-contabilidade', async (req, res) => {
  let resultado = null;

  try {
    const body = req.body || {};
    const { dataInicial, dataFinal } = body;
    resultado = await exportarContabilidade({
      dataInicial,
      dataFinal,
      incluirNfce: body.incluirNfce,
      incluirNfe: body.incluirNfe,
      incluirEntradas: body.incluirEntradas,
      incluirRelatorios: body.incluirRelatorios,
      incluirManifesto: body.incluirManifesto
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${resultado.nomeZip}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Filename, X-Export-Arquivos, X-Export-Resumo');
    res.setHeader('X-Export-Filename', resultado.nomeZip);
    res.setHeader('X-Export-Arquivos', JSON.stringify(resultado.arquivosGerados));
    res.setHeader('X-Export-Resumo', JSON.stringify(resultado.resumo));

    const stream = fs.createReadStream(resultado.caminhoZip);
    stream.on('close', () => limparExportacaoTemporaria(resultado));
    stream.on('error', () => limparExportacaoTemporaria(resultado));
    res.on('close', () => limparExportacaoTemporaria(resultado));
    stream.pipe(res);
  } catch (error) {
    if (resultado) {
      limparExportacaoTemporaria(resultado);
    }

    const status = error.statusCode || 500;
    res.status(status).json({
      error: error.message || 'Erro ao exportar documentos para contabilidade.'
    });
  }
});

module.exports = router;
