const db = require('../database');
const { isMultiCaixaAtivo, obterTerminalIdDaRequisicao, parsePositiveInteger } = require('../utils/multiCaixa');
const { obterCaixaTurnoId, montarSqlSessaoAberta } = require('../utils/caixaSessaoHelpers');
const { origemExigeCaixa } = require('../services/vendas/VendaOrigin');
const {
  exigirSessaoDaEmpresa,
  statusDeErroEmpresa,
  resolverEmpresaIdParaCaixa
} = require('../services/caixa/CaixaEmpresaContextoService');

function obterTerminalId(req) {
  return obterTerminalIdDaRequisicao(req);
}

function obterSessaoId(req) {
  const rawId = req.body?.caixa_sessao_id || req.query?.caixa_sessao_id || req.headers['x-caixa-sessao-id'] || req.user?.caixa_sessao_id;
  return parsePositiveInteger(rawId);
}

function obterEmpresaIdDoReq(req) {
  const raw = req.empresaId != null ? req.empresaId : req.caixaEmpresaContexto?.empresaId;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function responderErroCaixa(res, empErr, { cancelamento = false } = {}) {
  const status = statusDeErroEmpresa(empErr);
  if (cancelamento) {
    return res.status(status).json({
      sucesso: false,
      mensagem: empErr.message,
      code: empErr.code
    });
  }
  return res.status(status).json({
    error: empErr.message,
    code: empErr.code,
    empresa_id: empErr.empresa_id
  });
}

function comEmpresaOperacionalCaixa(req, res, onOk, { cancelamento = false } = {}) {
  const ja = obterEmpresaIdDoReq(req);
  if (ja != null) return onOk(ja);

  resolverEmpresaIdParaCaixa(req, { db, exigirAutorizacaoUsuario: false })
    .then((resolved) => {
      req.empresaId = resolved.empresaId;
      onOk(resolved.empresaId);
    })
    .catch((err) => responderErroCaixa(res, err, { cancelamento }));
}

function montarConsultaSessaoAberta({ sessaoId, terminalId, empresaId }) {
  return montarSqlSessaoAberta({ sessaoId, terminalId, empresaId });
}

/**
 * Sprint 2.2 — política de porta por origem.
 * PDV: exige caixa aberto (comportamento atual).
 * Demais origens: não executa validarCaixaAberto.
 */
function validarCaixaSeOrigemPdv(req, res, next) {
  const origemRaw = req.body?.origem ?? req.query?.origem ?? req.headers?.['x-venda-origem'];
  if (origemExigeCaixa(origemRaw)) {
    return validarCaixaAberto(req, res, next);
  }
  return next();
}

function validarCaixaAberto(req, res, next) {
  const terminalId = obterTerminalId(req);
  const sessaoId = obterSessaoId(req);

  if (isMultiCaixaAtivo() && !sessaoId && !terminalId) {
    return res.status(400).json({
      error: 'terminal_id é obrigatório no modo multi-caixa.'
    });
  }

  comEmpresaOperacionalCaixa(req, res, (empresaId) => {
    let sql;
    let params;
    try {
      if (sessaoId) {
        ({ sql, params } = montarConsultaSessaoAberta({ sessaoId, empresaId }));
      } else if (terminalId || empresaId || !isMultiCaixaAtivo()) {
        ({ sql, params } = montarConsultaSessaoAberta({ terminalId, empresaId }));
      } else {
        return res.status(400).json({ error: 'Nenhum caixa aberto neste terminal.' });
      }
    } catch (sqlErr) {
      return responderErroCaixa(res, sqlErr);
    }

    db.get(sql, params, (err, sessao) => {
      if (err) {
        console.error('Erro ao verificar sessão de caixa:', err);
        return res.status(500).json({ error: 'Erro ao verificar sessão de caixa.' });
      }

      if (!sessao) {
        const mensagem = sessaoId
          ? 'Nenhuma sessão de caixa aberta para esta sessão.'
          : terminalId
            ? 'Nenhum caixa aberto neste terminal.'
            : 'Nenhum caixa aberto.';
        return res.status(400).json({ error: mensagem, code: 'CAIXA_NAO_ENCONTRADO' });
      }

      try {
        exigirSessaoDaEmpresa(sessao, empresaId);
      } catch (empErr) {
        return responderErroCaixa(res, empErr);
      }

      const turnoId = obterCaixaTurnoId(sessao);
      if (!turnoId) {
        return res.status(400).json({ error: 'Sessão de caixa sem turno vinculado.' });
      }

      db.get('SELECT id, status FROM caixa WHERE id = ?', [turnoId], (caixaErr, caixa) => {
        if (caixaErr) {
          console.error('Erro ao verificar turno de caixa:', caixaErr);
          return res.status(500).json({ error: 'Erro ao verificar sessão de caixa.' });
        }

        if (!caixa || caixa.status !== 'aberto') {
          db.run(
            `UPDATE caixa_sessoes
             SET status = 'fechado',
                 fechado_em = COALESCE(fechado_em, DATETIME('now','localtime')),
                 observacoes = COALESCE(observacoes, 'Encerrada: turno já fechado')
             WHERE id = ? AND status = 'aberto' AND empresa_id = ?`,
            [sessao.id, empresaId],
            () => res.status(400).json({ error: 'Nenhum caixa aberto neste terminal.' })
          );
          return;
        }

        req.caixaSessaoId = sessao.id;
        req.caixaId = turnoId;
        req.caixaConfigId = sessao.caixa_id || null;
        req.terminalId = terminalId || sessao.terminal_id || null;
        req.operadorId = req.user?.id || sessao.operador_id || null;
        req.caixaSessao = sessao;

        next();
      });
    });
  });
}

function validarCaixaAbertoCancelamentoVenda(req, res, next) {
  const vendaId = parsePositiveInteger(req.params.id);
  if (!vendaId) {
    return validarCaixaAberto(req, res, next);
  }

  db.get(
    'SELECT terminal_id, caixa_sessao_id, operador_id FROM vendas WHERE id = ?',
    [vendaId],
    (err, venda) => {
      if (err) {
        console.error('Erro ao buscar venda para cancelamento:', err);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao verificar venda.' });
      }

      if (!venda) {
        return res.status(404).json({ sucesso: false, mensagem: 'Venda não encontrada.' });
      }

      req.body = req.body || {};
      if (!obterTerminalId(req) && venda.terminal_id) {
        req.body.terminal_id = venda.terminal_id;
      }
      if (!obterSessaoId(req) && venda.caixa_sessao_id) {
        req.body.caixa_sessao_id = venda.caixa_sessao_id;
      }

      const terminalId = obterTerminalId(req);
      const sessaoId = obterSessaoId(req);

      comEmpresaOperacionalCaixa(req, res, (empresaId) => {
        let sql;
        let params;

        try {
          if (sessaoId) {
            ({ sql, params } = montarConsultaSessaoAberta({ sessaoId, empresaId }));
          } else if (terminalId || empresaId || !isMultiCaixaAtivo()) {
            ({ sql, params } = montarConsultaSessaoAberta({ terminalId, empresaId }));
          } else {
            req.operadorId = req.user?.id || venda.operador_id || null;
            return next();
          }
        } catch (sqlErr) {
          return responderErroCaixa(res, sqlErr, { cancelamento: true });
        }

        db.get(sql, params, (sessaoErr, sessao) => {
          if (sessaoErr) {
            console.error('Erro ao verificar sessão no cancelamento:', sessaoErr);
            return res.status(500).json({ sucesso: false, mensagem: 'Erro ao verificar caixa.' });
          }

          if (sessao) {
            try {
              exigirSessaoDaEmpresa(sessao, empresaId);
            } catch (empErr) {
              return responderErroCaixa(res, empErr, { cancelamento: true });
            }
            req.caixaSessaoId = sessao.id;
            req.caixaId = obterCaixaTurnoId(sessao);
            req.caixaConfigId = sessao.caixa_id || null;
            req.terminalId = terminalId || sessao.terminal_id || null;
            req.operadorId = req.user?.id || sessao.operador_id || null;
            req.caixaSessao = sessao;
            return next();
          }

          req.operadorId = req.user?.id || venda.operador_id || null;
          req.terminalId = terminalId || venda.terminal_id || null;
          return next();
        });
      }, { cancelamento: true });
    }
  );
}

function validarCaixaAbertoDevolucaoVenda(req, res, next) {
  const vendaId = parsePositiveInteger(req.params.id);
  if (!vendaId) {
    return validarCaixaAberto(req, res, next);
  }

  db.get(
    'SELECT terminal_id, caixa_sessao_id, operador_id FROM vendas WHERE id = ?',
    [vendaId],
    (err, venda) => {
      if (err) {
        console.error('Erro ao buscar venda para devolução:', err);
        return res.status(500).json({ error: 'Erro ao verificar venda.' });
      }

      if (!venda) {
        return res.status(404).json({ error: 'Venda não encontrada.' });
      }

      req.body = req.body || {};
      if (!obterTerminalId(req) && venda.terminal_id) {
        req.body.terminal_id = venda.terminal_id;
      }
      if (!obterSessaoId(req) && venda.caixa_sessao_id) {
        req.body.caixa_sessao_id = venda.caixa_sessao_id;
      }

      return validarCaixaAberto(req, res, next);
    }
  );
}

module.exports = {
  validarCaixaAberto,
  validarCaixaSeOrigemPdv,
  validarCaixaAbertoCancelamentoVenda,
  validarCaixaAbertoDevolucaoVenda
};
