const express = require('express');
const router = express.Router();
const db = require('../database');
const { validarCaixaAberto, validarCaixaSeOrigemPdv, validarCaixaAbertoCancelamentoVenda, validarCaixaAbertoDevolucaoVenda } = require('../middleware/validarCaixaAberto');
const { exigirSenhaAdmin } = require('../middleware/exigirSenhaAdmin');
const {
  FILTRO_VENDA_VALIDA,
  isModoFiscalRelatorio,
  getExprValorVenda,
  getExprValorItem,
  getExprValorItemFiscal,
  getExprValorItemNaoFiscal,
  getExprQuantidadeItem,
  getExprQuantidadeItemFiscal,
  getExprQuantidadeItemNaoFiscal,
  getFiltroItensFiscal
} = require('../services/reportFiscalHelpers');
const VendaFinanceiroService = require('../services/vendas/VendaFinanceiroService');
const VendaApplicationService = require('../services/vendas/VendaApplicationService');
const VendaPagamentoService = require('../services/vendas/VendaPagamentoService');
const VendaDevolucaoService = require('../services/vendas/VendaDevolucaoService');
const VendaCancelamentoService = require('../services/vendas/VendaCancelamentoService');
const { avaliarReferenciaRecomposicao } = require('../services/vendas/PagamentoSequencialComposicaoService');
const {
  integrarPagamentoRecomposicao,
  apresentacaoComposicaoFiscal
} = require('../services/vendas/PagamentoRecomposicaoDocumentoService');

const { agoraLocalBrasil } = VendaFinanceiroService;
const { criarVenda } = VendaApplicationService;
const {
  preCalcularDistribuicao,
  consultarPagamentoNaoFiscal,
  registrarPagamentoNaoFiscal
} = VendaPagamentoService;
const { devolverParcial } = VendaDevolucaoService;
const { cancelarVendaPut, cancelarVendaPost } = VendaCancelamentoService;
const {
  emitirNFeDevolucaoVenda,
  prepararNfeDevolucaoVenda,
  obterNfeDevolucaoVendaPorId,
  listarHistoricoDevolucaoVenda,
  cancelarNfeDevolucaoOficial,
  consultarSituacaoDevolucao,
  reenviarNfeDevolucao,
  listarEventosDevolucao,
  obterPainelStatus,
  obterXmlVersionado
} = require('../services/fiscal/nfeDevolucaoVenda');
const { criarMiddlewareContextoEmpresa, resolverEmpresaId } = require('../services/fiscalNaoFiscal/empresaContexto');
const { sqlFiltroEmpresaVenda } = require('../utils/vendasEmpresaHelpers');
const {
  middlewareResolverEmpresaVenda,
  exigirVendaDaEmpresa,
  responderErroEmpresaVenda
} = require('../services/vendas/VendaEmpresaContextoService');

const anexarEmpresaVenda = middlewareResolverEmpresaVenda({ db, exigirAutorizacaoUsuario: false });
const anexarEmpresaReversaoVenda = middlewareResolverEmpresaVenda({
  db,
  exigirAutorizacaoUsuario: false,
  adotarEmpresaDaVenda: true
});
const {
  middlewareAplicarPdvModeloEmpresa,
  obterPdvModeloEmpresaPublico,
  lerConfigPdvModelo,
  PDV_MODELO_UNICA
} = require('../services/pdv/PdvModeloEmpresaService');
// CDS-PDV-EMPRESA-UNICA-06: canal HTTP confiável — política PDV não depende de body.origem.
const aplicarPdvModeloEmpresa = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });

router.use(criarMiddlewareContextoEmpresa(db));

// Listar vendas com busca — apenas empresa do contexto (exclui legado NULL)
router.get('/', anexarEmpresaVenda, (req, res) => {
  const busca = String(req.query.busca || '').trim();
  const todas = req.query.todas === '1';
  const somenteFiscal = String(req.query.modo || '').toLowerCase() === 'fiscal';
  const empresaId = Number(req.empresaId);
  const params = [];
  let where = ' WHERE ' + sqlFiltroEmpresaVenda('v', empresaId, params);

  if (busca) {
    where += `
      AND (
        v.id LIKE ?
        OR v.codigo LIKE ?
        OR c.nome LIKE ?
        OR v.forma_pagamento LIKE ?
        OR v.status LIKE ?
      )
    `;

    const termo = `%${busca}%`;
    params.push(termo, termo, termo, termo, termo);
  }

  if (!todas) {
    const dataHoje = agoraLocalBrasil().slice(0, 10);
    where += (where ? ' AND ' : ' WHERE ');
    where += ` v.data_venda = ? `;
    params.push(dataHoje);
  }

  if (somenteFiscal) {
    where += (where ? ' AND ' : ' WHERE ');
    // Lista "modo fiscal" = vendas com documento fiscal (NFC-e ou NF-e).
    where += ` (n.id IS NOT NULL OR nfe.id IS NOT NULL) `;
  }

  db.all(`
    SELECT
      v.id,
      v.codigo,
      v.data_venda,
      v.created_at,
      v.cliente_id,
      v.total,
      v.valor_fiscal,
      v.valor_nao_fiscal,
      v.desconto,
      v.acrescimo,
      v.forma_pagamento,
      v.status,
      v.status_pagamento,
      v.tef_transacao_id,
      v.pedido_id,
      (
        SELECT GROUP_CONCAT(vp.forma_pagamento || '|' || printf('%.2f', vp.valor), ';')
        FROM venda_pagamentos vp
        WHERE vp.venda_id = v.id
      ) AS pagamentos_resumo,
      n.id AS nfce_id,
      n.numero AS nfce_numero,
      n.status AS nfce_status,
      n.chave_acesso AS nfce_chave,
      nfe.id AS nfe_id,
      nfe.numero AS nfe_numero,
      nfe.serie AS nfe_serie,
      nfe.status AS nfe_status,
      nfe.chave_acesso AS nfe_chave,
      nfe.protocolo AS nfe_protocolo,
      c.nome AS cliente_nome,
      (
        SELECT COUNT(*)
        FROM vendas_itens vi
        WHERE vi.venda_id = v.id
      ) AS total_itens
    FROM vendas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN nfce_notas n ON n.id = (
      SELECT n2.id
      FROM nfce_notas n2
      WHERE n2.venda_id = v.id
      ORDER BY n2.id DESC
      LIMIT 1
    )
    LEFT JOIN nfe_notas nfe ON nfe.id = (
      SELECT nfe2.id
      FROM nfe_notas nfe2
      WHERE nfe2.venda_id = v.id
        AND LOWER(COALESCE(nfe2.status, '')) = 'autorizada'
      ORDER BY nfe2.id DESC
      LIMIT 1
    )
    ${where}
    ORDER BY v.data_venda DESC, v.id DESC
  `, params, (err, rows) => {
    if (err) {
      console.error('Erro ao listar vendas:', err);
      return res.status(500).json({ error: err.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(rows || []);
  });
});

/** CDS-PDV-EMPRESA-UNICA-02 — leitura do modelo exclusivo do PDV (antes de GET /:id). */
router.get('/pdv-modelo-empresa', (req, res) => {
  try {
    return res.json({ success: true, ...obterPdvModeloEmpresaPublico() });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Falha ao ler modelo de empresa do PDV.',
      code: err.code || undefined
    });
  }
});

/** Sprint 23/28 — valida as parcelas e, no ambiente de teste, prepara o documento fiscal. Não emite NFC-e. */
router.post('/composicao-sequencial', async (req, res) => {
  try {
    const body = req.body || {};
    const resultado = avaliarReferenciaRecomposicao({
      total: body.total,
      total_comercial: body.total_comercial,
      pagamentos: body.pagamentos,
      itens: body.itens
    });
    let documentoFiscal = null;
    if (
      resultado.recomposicao_executada === true
      && Array.isArray(body.itens)
      && body.itens.length > 0
    ) {
      documentoFiscal = await integrarPagamentoRecomposicao({
        total: body.total,
        pagamentos: body.pagamentos,
        itens: body.itens,
        empresaId: req.empresaId
      }, { db });
    }
    return res.json({
      ...resultado,
      documento_fiscal: documentoFiscal,
      composicao_fiscal: apresentacaoComposicaoFiscal(documentoFiscal, resultado)
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      sucesso: false,
      error: err.message,
      codigo: err.code || err.codigo || 'COMPOSICAO_INVALIDA'
    });
  }
});

/** PDV-SEL-01 — preview somente leitura (rota estática antes de /:id). */
router.post('/selecao-empresa', async (req, res) => {
  try {
    const {
      avaliarSelecaoEmpresaPdv,
      responderBloqueioSelecao
    } = require('../services/vendas/SelecaoEmpresaVendaPdvService');
    const { resolverModoOperacaoVendaAtivo } = require('../motores/muv');
    const pdvCfg = lerConfigPdvModelo();
    if (pdvCfg.pdv_modelo_empresa === PDV_MODELO_UNICA) {
      return res.status(200).json({
        success: true,
        aplicada: false,
        motivo: 'PDV_EMPRESA_UNICA',
        empresa_id: pdvCfg.pdv_empresa_id,
        mensagem: 'PDV em modo Empresa única: a empresa configurada prevalece; seleção automática não se aplica.'
      });
    }
    let modo;
    try {
      modo = resolverModoOperacaoVendaAtivo();
    } catch (e) {
      return res.status(500).json({ success: false, code: e.code, error: e.message });
    }
    if (modo !== 'MULTIEMPRESA') {
      return res.status(200).json({
        success: true,
        aplicada: false,
        motivo: 'EMPRESA_SIMPLES',
        mensagem: 'Seleção automática não se aplica em EMPRESA_SIMPLES.'
      });
    }
    const usuarioId = req.user && (req.user.id != null ? req.user.id : req.user.usuario_id);
    const out = await avaliarSelecaoEmpresaPdv({
      body: req.body || {},
      itens: (req.body && req.body.itens) || [],
      usuarioId
    });
    if (out.bloqueio) {
      return res.status(409).json({
        success: false,
        code: out.bloqueio.codigo,
        error: out.bloqueio.mensagem,
        mensagem: out.bloqueio.mensagem,
        selecao: out,
        venda_concluida: false
      });
    }
    return res.status(200).json({
      success: true,
      aplicada: true,
      empresa_id: out.selecionada.empresaId,
      justificativa: out.justificativa,
      hash_carrinho: out.hashCarrinho,
      tipo_saldo: out.tipoSaldo,
      matriz_id: out.capacidade && out.capacidade.matrizId,
      capacidade: out.capacidade
    });
  } catch (err) {
    const { responderBloqueioSelecao } = require('../services/vendas/SelecaoEmpresaVendaPdvService');
    if (err && err.code) return responderBloqueioSelecao(res, err);
    return res.status(500).json({ success: false, error: err.message || 'Erro na seleção de empresa.' });
  }
});

// Buscar venda por ID — ownership obrigatório (outra empresa / legado NULL = 404)
router.get('/:id', anexarEmpresaVenda, (req, res) => {
  const { id } = req.params;
  const empresaId = Number(req.empresaId);

  db.get(`
    SELECT
      v.*,
      c.nome AS cliente_nome,
      c.cpf_cnpj AS cliente_cpf,
      n.id AS nfce_id,
      n.numero AS nfce_numero,
      n.status AS nfce_status,
      n.chave_acesso AS nfce_chave,
      nfe.id AS nfe_id,
      nfe.numero AS nfe_numero,
      nfe.serie AS nfe_serie,
      nfe.status AS nfe_status,
      nfe.chave_acesso AS nfe_chave,
      nfe.protocolo AS nfe_protocolo
    FROM vendas v
    LEFT JOIN clientes c ON v.cliente_id = c.id
    LEFT JOIN nfce_notas n ON n.id = (
      SELECT n2.id
      FROM nfce_notas n2
      WHERE n2.venda_id = v.id
      ORDER BY n2.id DESC
      LIMIT 1
    )
    LEFT JOIN nfe_notas nfe ON nfe.id = (
      SELECT nfe2.id
      FROM nfe_notas nfe2
      WHERE nfe2.venda_id = v.id
        AND LOWER(COALESCE(nfe2.status, '')) = 'autorizada'
      ORDER BY nfe2.id DESC
      LIMIT 1
    )
    WHERE v.id = ?
      AND v.empresa_id = ?
  `, [id, empresaId], (err, venda) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    try {
      exigirVendaDaEmpresa(venda, empresaId);
    } catch (ownErr) {
      return responderErroEmpresaVenda(res, ownErr);
    }

    db.all(`
      SELECT vi.*, p.nome as produto_nome, p.codigo as produto_codigo, p.unidade
      FROM vendas_itens vi
      JOIN produtos p ON vi.produto_id = p.id
      WHERE vi.venda_id = ?
    `, [id], (errItens, itens) => {
      if (errItens) {
        res.status(500).json({ error: errItens.message });
        return;
      }
      db.all(`
        SELECT
          id, venda_id, forma_pagamento, valor, tef_transacao_id,
          tef_nsu, tef_autorizacao, tef_bandeira, tef_adquirente,
          confirmacao_modalidade, confirmacao_manual, operador_id, confirmado_em,
          valor_entregue, troco, criado_em
        FROM venda_pagamentos
        WHERE venda_id = ?
        ORDER BY id ASC
      `, [id], (errPag, pagamentos) => {
        if (errPag) {
          res.status(500).json({ error: errPag.message });
          return;
        }
        db.all(`
          SELECT
            id, venda_id, tipo_recebimento, forma_pagamento, valor,
            tef_transacao_id, nsu, autorizacao, status
          FROM venda_recebimentos
          WHERE venda_id = ?
          ORDER BY id ASC
        `, [id], (errRec, recebimentos) => {
          if (errRec) {
            res.status(500).json({ error: errRec.message });
            return;
          }
          res.json({
            ...venda,
            itens: itens || [],
            venda_pagamentos: pagamentos || [],
            venda_recebimentos: recebimentos || []
          });
        });
      });
    });
  });
});

// Buscar detalhes completos da venda para emissão de NFC-e
router.get('/:id/detalhes', anexarEmpresaVenda, (req, res) => {
  const vendaId = req.params.id;
  const empresaId = Number(req.empresaId);

  db.get(`
    SELECT v.*, c.nome as cliente_nome
    FROM vendas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    WHERE v.id = ?
      AND v.empresa_id = ?
  `, [vendaId, empresaId], (err, venda) => {
    if (err) return res.status(500).json({ error: err.message });

    try {
      exigirVendaDaEmpresa(venda, empresaId);
    } catch (ownErr) {
      return responderErroEmpresaVenda(res, ownErr);
    }

    db.all(`
      SELECT vi.*, p.nome as produto_nome
      FROM vendas_itens vi
      JOIN produtos p ON p.id = vi.produto_id
      WHERE vi.venda_id = ?
    `, [vendaId], (errItens, itens) => {
      if (errItens) return res.status(500).json({ error: errItens.message });

      res.json({
        venda,
        itens
      });
    });
  });
});

router.post('/pre-calcular-distribuicao', validarCaixaAberto, preCalcularDistribuicao);

// CDS-PDV-EMPRESA-UNICA-02: fixa empresa PDV UNICA antes do caixa; depois núcleo.
// Sprint 2.2: PDV exige caixa; demais origens reconhecidas sem validarCaixaAberto
function criarVendaComIdempotenciaPdv(req, res) {
  const chave = String(req.body && req.body.chave_fechamento_pdv || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(chave)) return criarVenda(req, res);
  db.run(`CREATE TABLE IF NOT EXISTS pdv_fechamento_idempotencia (
    chave TEXT PRIMARY KEY,
    venda_id INTEGER NOT NULL,
    status_pagamento TEXT,
    criado_em TEXT
  )`, (errTabela) => {
    if (errTabela) return criarVenda(req, res);
    db.get(
      'SELECT venda_id, status_pagamento FROM pdv_fechamento_idempotencia WHERE chave = ?',
      [chave],
      (err, row) => {
        if (err) return criarVenda(req, res);
        if (row && row.venda_id) {
          return res.json({
            id: Number(row.venda_id),
            venda_id: Number(row.venda_id),
            status_pagamento: row.status_pagamento || 'quitada',
            venda_ja_persistida: true,
            message: 'Venda já registrada. Nenhuma segunda venda foi criada.'
          });
        }
        const enviar = res.json.bind(res);
        res.json = function (corpo) {
          const vendaId = corpo && (corpo.venda_id || corpo.id);
          if (!(vendaId && res.statusCode < 400)) return enviar(corpo);
          db.run(
            `INSERT OR IGNORE INTO pdv_fechamento_idempotencia (chave, venda_id, status_pagamento, criado_em)
             VALUES (?, ?, ?, datetime('now', 'localtime'))`,
            [chave, Number(vendaId), corpo.status_pagamento || null],
            () => enviar(corpo)
          );
        };
        return criarVenda(req, res);
      }
    );
  });
}

router.post('/', aplicarPdvModeloEmpresa, validarCaixaSeOrigemPdv, criarVendaComIdempotenciaPdv);

router.get('/:id/pagamento-nao-fiscal', consultarPagamentoNaoFiscal);

router.post('/:id/pagamento-nao-fiscal', validarCaixaAberto, registrarPagamentoNaoFiscal);

router.post('/:id/devolver', anexarEmpresaReversaoVenda, validarCaixaAbertoDevolucaoVenda, exigirSenhaAdmin, (req, res) => {
  const vendaId = Number(req.params.id);
  const motivo = String(req.body?.motivo || '').trim();
  const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];

  devolverParcial(vendaId, motivo, itens, req, res);
});

router.put('/:id/cancelar', anexarEmpresaReversaoVenda, validarCaixaAbertoCancelamentoVenda, (req, res) => {
  const { id } = req.params;
  const motivo = req.body.motivo || req.body.justificativa || '';
  cancelarVendaPut(id, motivo, req, res);
});

router.post('/cancelar/:id', anexarEmpresaReversaoVenda, validarCaixaAbertoCancelamentoVenda, (req, res) => {
  const vendaId = req.params.id;
  const { motivo } = req.body;
  cancelarVendaPost(vendaId, motivo, req, res);
});

router.delete('/:id', anexarEmpresaVenda, (req, res) => {
  const id = Number(req.params.id);
  const empresaId = Number(req.empresaId);

  db.get(`
    SELECT *
    FROM vendas
    WHERE id = ?
      AND empresa_id = ?
  `, [id, empresaId], (err, venda) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    try {
      exigirVendaDaEmpresa(venda, empresaId);
    } catch (ownErr) {
      return responderErroEmpresaVenda(res, ownErr);
    }

    if (venda.nfce_id) {
      return res.status(400).json({
        error: 'Venda fiscal não pode ser excluída. Cancele a NFC-e primeiro.'
      });
    }

    db.run(`
      DELETE FROM vendas_itens WHERE venda_id = ?
    `, [id], (errItens) => {
      if (errItens) {
        return res.status(500).json({ error: errItens.message });
      }

      db.run(`
        DELETE FROM vendas WHERE id = ?
      `, [id], (errVenda) => {
        if (errVenda) {
          return res.status(500).json({ error: errVenda.message });
        }

        res.json({
          success: true,
          message: 'Venda excluída com sucesso'
        });
      });
    });
  });
});

router.get('/relatorio/fechamento-caixa', anexarEmpresaVenda, (req, res) => {
  const { data_inicio, data_fim, modo_fiscal } = req.query;

  if (!data_inicio || !data_fim) {
    return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórios' });
  }

  const modoFiscal = modo_fiscal || '0';
  const exprValor = getExprValorVenda(modoFiscal);
  const empresaId = Number(req.empresaId);

  db.all(`
    SELECT
      forma_pagamento,
      COUNT(*) as quantidade,
      SUM(${exprValor}) as total
    FROM vendas v
    WHERE ${FILTRO_VENDA_VALIDA}
      AND v.empresa_id = ?
      AND date(v.data_venda) BETWEEN date(?) AND date(?)
    GROUP BY forma_pagamento
    ORDER BY total DESC
  `, [empresaId, data_inicio, data_fim], (err, pagamentos) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    db.get(`
      SELECT
        COUNT(*) as quantidade_vendas,
        SUM(${exprValor}) as total_vendido,
        SUM(desconto) as total_descontos,
        AVG(${exprValor}) as ticket_medio
      FROM vendas v
      WHERE ${FILTRO_VENDA_VALIDA}
        AND v.empresa_id = ?
        AND date(v.data_venda) BETWEEN date(?) AND date(?)
    `, [empresaId, data_inicio, data_fim], (errResumo, resumo) => {
      if (errResumo) {
        return res.status(500).json({ error: errResumo.message });
      }

      res.json({
        modo_fiscal_ativo: isModoFiscalRelatorio(modoFiscal),
        resumo: resumo || {
          quantidade_vendas: 0,
          total_vendido: 0,
          total_descontos: 0,
          ticket_medio: 0
        },
        pagamentos: pagamentos || []
      });
    });
  });
});

router.get('/relatorio/produtos-mais-vendidos', anexarEmpresaVenda, (req, res) => {
  const { data_inicio, data_fim, modo_fiscal, limite } = req.query;

  if (!data_inicio || !data_fim) {
    return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórios' });
  }

  const modoFiscal = modo_fiscal || '0';
  const exprValor = getExprValorItem(modoFiscal);
  const exprQtd = getExprQuantidadeItem(modoFiscal);
  const exprQtdFiscal = getExprQuantidadeItemFiscal();
  const exprQtdNaoFiscal = getExprQuantidadeItemNaoFiscal();
  const exprValorFiscal = getExprValorItem('1');
  const exprValorNaoFiscal = getExprValorItemNaoFiscal();
  const filtroItens = getFiltroItensFiscal(modoFiscal);
  const limit = Math.min(Math.max(parseInt(limite, 10) || 100, 1), 500);
  const empresaId = Number(req.empresaId);

  db.all(`
    SELECT
      p.id,
      p.codigo,
      p.nome,
      p.unidade,
      SUM(${exprQtd}) as quantidade_vendida,
      SUM(${exprQtdFiscal}) as quantidade_fiscal,
      SUM(${exprQtdNaoFiscal}) as quantidade_nao_fiscal,
      SUM(${exprValor}) as total_vendido,
      SUM(${exprValorFiscal}) as total_vendido_fiscal,
      SUM(${exprValorNaoFiscal}) as total_vendido_nao_fiscal,
      CASE
        WHEN SUM(${exprQtd}) > 0 THEN SUM(${exprValor}) / SUM(${exprQtd})
        ELSE AVG(vi.preco_unitario)
      END as preco_medio
    FROM vendas v
    INNER JOIN vendas_itens vi ON v.id = vi.venda_id
    INNER JOIN produtos p ON vi.produto_id = p.id
    WHERE ${FILTRO_VENDA_VALIDA}
      AND v.empresa_id = ?
      AND date(v.data_venda) BETWEEN date(?) AND date(?)
      ${filtroItens}
    GROUP BY p.id
    HAVING quantidade_vendida > 0
    ORDER BY total_vendido DESC
    LIMIT ?
  `, [empresaId, data_inicio, data_fim, limit], (err, produtos) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    res.json({
      modo_fiscal_ativo: isModoFiscalRelatorio(modoFiscal),
      produtos: produtos || []
    });
  });
});

router.get('/relatorio/periodo', anexarEmpresaVenda, (req, res) => {
  const { data_inicio, data_fim, modo_fiscal } = req.query;
  const modoFiscal = modo_fiscal || '0';
  const exprValor = getExprValorVenda(modoFiscal);
  const empresaId = Number(req.empresaId);

  db.all(`
    SELECT
      DATE(v.data_venda) as data,
      COUNT(*) as total_vendas,
      SUM(${exprValor}) as valor_total,
      AVG(${exprValor}) as valor_medio,
      SUM(CASE WHEN v.cliente_id IS NOT NULL THEN 1 ELSE 0 END) as vendas_com_cliente
    FROM vendas v
    WHERE ${FILTRO_VENDA_VALIDA}
      AND v.empresa_id = ?
      AND date(v.data_venda) BETWEEN date(?) AND date(?)
    GROUP BY DATE(v.data_venda)
    ORDER BY data DESC
  `, [empresaId, data_inicio, data_fim], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({
      modo_fiscal_ativo: isModoFiscalRelatorio(modoFiscal),
      dias: rows || []
    });
  });
});

/** RC5 — NF-e Devolução de Venda */
router.get('/:id/nfe-devolucao/preparar', async (req, res) => {
  try {
    const prep = await prepararNfeDevolucaoVenda(Number(req.params.id));
    res.json({ success: true, ...prep });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      code: error.code || null
    });
  }
});

router.get('/:id/nfe-devolucao/historico', async (req, res) => {
  try {
    const historico = await listarHistoricoDevolucaoVenda(Number(req.params.id));
    res.json({ success: true, ...historico });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

router.get('/nfe-devolucao/:notaId/xml', async (req, res) => {
  try {
    const tipo = String(req.query.tipo || 'assinado').toLowerCase();
    const xml = await obterXmlVersionado(Number(req.params.notaId), tipo);
    const nota = await obterNfeDevolucaoVendaPorId(Number(req.params.notaId));
    if (!nota) return res.status(404).json({ error: 'NF-e de devolução não encontrada.' });
    if (!xml) return res.status(404).json({ error: `XML (${tipo}) não disponível.` });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="nfe-devolucao-venda-${tipo}-${nota.chave_acesso || nota.id}.xml"`
    );
    res.send(xml);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/nfe-devolucao/:notaId/danfe', async (req, res) => {
  try {
    const nota = await obterNfeDevolucaoVendaPorId(Number(req.params.notaId));
    if (!nota) return res.status(404).json({ error: 'NF-e de devolução não encontrada.' });
    const cancelado = String(req.query.tipo || '').toLowerCase() === 'cancelado';
    const html = cancelado ? nota.danfe_html_cancelado : nota.danfe_html;
    if (!html) return res.status(404).json({ error: 'DANFE não disponível.' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/nfe-devolucao/:notaId/status', async (req, res) => {
  try {
    const painel = await obterPainelStatus(Number(req.params.notaId));
    if (!painel) return res.status(404).json({ success: false, error: 'NF-e não encontrada.' });
    res.json({ success: true, ...painel });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

router.get('/nfe-devolucao/:notaId/eventos', async (req, res) => {
  try {
    const eventos = await listarEventosDevolucao(Number(req.params.notaId));
    res.json({ success: true, eventos });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

router.post('/nfe-devolucao/:notaId/consultar', async (req, res) => {
  try {
    const out = await consultarSituacaoDevolucao(Number(req.params.notaId), {
      usuarioId: req.usuario?.id || req.user?.id || null,
      usuarioNome: req.usuario?.nome || req.user?.nome || null,
      ip: req.ip || null
    });
    res.json(out);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
  }
});

router.post('/nfe-devolucao/:notaId/reenviar', async (req, res) => {
  try {
    const out = await reenviarNfeDevolucao(Number(req.params.notaId), {
      usuarioId: req.usuario?.id || req.user?.id || null,
      usuarioNome: req.usuario?.nome || req.user?.nome || null,
      ip: req.ip || null
    });
    res.json(out);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
  }
});

router.post('/nfe-devolucao/:notaId/cancelar', async (req, res) => {
  try {
    const out = await cancelarNfeDevolucaoOficial(Number(req.params.notaId), {
      motivo: req.body?.motivo || req.body?.justificativa,
      usuarioId: req.usuario?.id || req.user?.id || null,
      usuarioNome: req.usuario?.nome || req.user?.nome || null,
      ip: req.ip || null,
      forcarPrazo: Boolean(req.body?.forcarPrazo),
      empresaId: resolverEmpresaId(req.empresaId)
    });
    res.status(out.success ? 200 : 422).json(out);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      code: error.code || error.codigo || null
    });
  }
});

router.post('/:id/emitir-nfe-devolucao', async (req, res) => {
  try {
    const body = req.body || {};
    const resultado = await emitirNFeDevolucaoVenda(Number(req.params.id), {
      itens: body.itens,
      observacoes: body.observacoes,
      cfop: body.cfop,
      usuarioId: req.usuario?.id || req.user?.id || null,
      usuarioNome: req.usuario?.nome || req.user?.nome || null,
      ip: req.ip || null,
      empresaId: resolverEmpresaId(req.empresaId)
    });

    if (!resultado.success && resultado.status === 'rejeitada') {
      return res.status(400).json({
        sucesso: false,
        autorizado: false,
        mensagem: resultado.message,
        cStat: resultado.cStat,
        xMotivo: resultado.xMotivo,
        resultado
      });
    }
    if (!resultado.success && ['erro_assinatura', 'erro_comunicacao', 'erro_validacao', 'modulo_desabilitado'].includes(resultado.status)) {
      return res.status(400).json({ sucesso: false, error: resultado.message, code: resultado.code, resultado });
    }

    res.json({
      message: resultado.message,
      resultado,
      notaId: resultado.notaId,
      status: resultado.status,
      chaveAcesso: resultado.chaveAcesso || resultado.chave,
      protocolo: resultado.protocolo,
      recibo: resultado.recibo || null,
      numero: resultado.numero,
      serie: resultado.serie,
      origem: 'VENDA'
    });
  } catch (error) {
    console.error('Erro ao emitir NF-e devolução venda:', error);
    res.status(error.statusCode || 500).json({
      error: error.message,
      code: error.code || null,
      erros: error.erros || null
    });
  }
});

module.exports = router;
