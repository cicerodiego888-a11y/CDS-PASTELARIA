const express = require('express');
const router = express.Router();
const db = require('../database');
const { verificarToken } = require('../middleware/auth');
const { validarCaixaAberto } = require('../middleware/validarCaixaAberto');
const { gravarAuditoria } = require('../services/auditoria');
const { isMultiCaixaAtivo, exigirTerminalId, obterTerminalIdDaRequisicao } = require('../utils/multiCaixa');
const { obterCaixaTurnoId, obterSessaoAtivaDaEmpresa, montarSqlHistoricoTurnosDaEmpresa, montarSqlUltimaSessaoDoTurnoDaEmpresa, montarSqlMovimentacoesDaSessaoDaEmpresa, obterSessaoDaEmpresaPorId, obterMovimentacaoDaEmpresaPorId } = require('../utils/caixaSessaoHelpers');
const FechamentoCaixaResumoService = require('../services/caixa/FechamentoCaixaResumoService');
const { gerarHtmlCupomFechamento } = require('../services/caixa/FechamentoCaixaCupomService');
const {
  middlewareResolverEmpresaCaixa,
  obterMetaEmpresaPorId,
  exigirSessaoDaEmpresa,
  statusDeErroEmpresa
} = require('../services/caixa/CaixaEmpresaContextoService');

const anexarEmpresaCaixa = middlewareResolverEmpresaCaixa({ db });

function n(valor) {
  return Number(valor || 0);
}

/** Metadados de empresa via empresa_id da sessão (não configuracoes.cnpj). */
function obterConfigsEmpresa(empresaId, callback) {
  obterMetaEmpresaPorId(empresaId, { db })
    .then((meta) => callback(null, meta))
    .catch((err) => callback(err));
}

function obterMetaSessao(sessao, operadorNome, callback) {
  const empresaId = sessao && sessao.empresa_id != null ? sessao.empresa_id : null;
  obterConfigsEmpresa(empresaId, (cfgErr, empresa) => {
    if (cfgErr) return callback(cfgErr);
    if (!sessao?.terminal_id) {
      return callback(null, {
        ...empresa,
        terminal_id: null,
        terminal_nome: null,
        operador_id: sessao?.operador_id || null,
        operador_nome: operadorNome || null
      });
    }
    db.get(
      `SELECT t.id, t.nome, c.nome AS caixa_nome
       FROM terminais t
       LEFT JOIN caixas c ON c.id = t.caixa_id
       WHERE t.id = ?`,
      [sessao.terminal_id],
      (tErr, terminal) => {
        if (tErr) return callback(tErr);
        callback(null, {
          ...empresa,
          terminal_id: sessao.terminal_id,
          terminal_nome: terminal?.nome || terminal?.caixa_nome || `Terminal ${sessao.terminal_id}`,
          operador_id: sessao.operador_id || null,
          operador_nome: operadorNome || null
        });
      }
    );
  });
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

function hoje() {
  return agoraLocalBrasil().slice(0, 10);
}

function obterTerminalId(req) {
  return obterTerminalIdDaRequisicao(req);
}

function obterSessaoAberta(terminalId, empresaId, callback) {
  if (typeof empresaId === 'function') {
    callback = empresaId;
    empresaId = null;
  }

  if (!terminalId && isMultiCaixaAtivo()) {
    return callback(null, null);
  }

  obterSessaoAtivaDaEmpresa(db, { terminalId, empresaId }, callback);
}

function validarTerminalParaAbertura(terminalId, callback) {
  db.get(
    `SELECT t.*, c.ativo AS caixa_ativo, c.nome AS caixa_nome
     FROM terminais t
     LEFT JOIN caixas c ON c.id = t.caixa_id
     WHERE t.id = ?`,
    [terminalId],
    (err, terminal) => {
      if (err) return callback(err);
      if (!terminal) {
        return callback(null, { ok: false, error: 'Terminal não encontrado.' });
      }
      if (!terminal.ativo) {
        return callback(null, { ok: false, error: 'Terminal inativo. Ative-o no ERP em Gerenciar Caixas.' });
      }
      if (!terminal.caixa_id) {
        return callback(null, {
          ok: false,
          error: 'Terminal não vinculado a um caixa. Vincule no ERP em Gerenciar Caixas.'
        });
      }
      if (!terminal.caixa_ativo) {
        return callback(null, { ok: false, error: `Caixa "${terminal.caixa_nome || terminal.caixa_id}" está inativo.` });
      }
      return callback(null, { ok: true, terminal, caixaConfigId: terminal.caixa_id });
    }
  );
}

function buscarCaixaTurnoDaSessao(sessao, callback) {
  const turnoId = obterCaixaTurnoId(sessao);
  if (!turnoId) return callback(null, null);
  db.get('SELECT * FROM caixa WHERE id = ?', [turnoId], callback);
}

/** Fonte única: FechamentoCaixaResumoService (resumo aberto e fechamento). */
function calcularResumoCaixa(caixa, options = {}, callback) {
  FechamentoCaixaResumoService.calcularResumoCaixa(caixa, options, callback);
}

function calcularFechamentoDetalhado(caixa, options = {}, callback) {
  FechamentoCaixaResumoService.calcularFechamentoDetalhado(caixa, options, callback);
}

const { exigirPermissaoOuSenhaAdmin } = require('../middleware/exigirPermissaoOuSenhaAdmin');

function encerrarSessaoOrfa(sessao, motivo, empresaId, callback) {
  if (typeof empresaId === 'function') {
    callback = empresaId;
    empresaId = sessao && sessao.empresa_id != null ? sessao.empresa_id : null;
  }
  if (!sessao || !sessao.id) return callback && callback(null);
  const emp = Number(empresaId);
  const params = Number.isInteger(emp) && emp > 0
    ? [motivo || 'Sessão órfã encerrada automaticamente', sessao.id, emp]
    : null;
  if (!params) return callback && callback(null);
  db.run(
    `UPDATE caixa_sessoes
     SET status = 'fechado',
         fechado_em = COALESCE(fechado_em, DATETIME('now','localtime')),
         observacoes = COALESCE(observacoes, ?)
     WHERE id = ? AND status = 'aberto' AND empresa_id = ?`,
    params,
    (err) => {
      if (err) console.error('Erro ao encerrar sessão órfã:', err.message);
      if (callback) callback(err || null);
    }
  );
}

router.get('/aberto', anexarEmpresaCaixa, (req, res) => {
  const terminalId = obterTerminalId(req);
  const empresaId = req.empresaId;

  if (isMultiCaixaAtivo() && !terminalId) {
    return res.json(null);
  }

  obterSessaoAberta(terminalId, empresaId, (sessErr, sessao) => {
    if (sessErr) return res.status(500).json({ error: sessErr.message });
    if (sessao) {
      try {
        exigirSessaoDaEmpresa(sessao, empresaId);
      } catch (empErr) {
        return res.status(statusDeErroEmpresa(empErr)).json({
          error: empErr.message,
          code: empErr.code
        });
      }

      buscarCaixaTurnoDaSessao(sessao, (cErr, caixa) => {
        if (cErr) return res.status(500).json({ error: cErr.message });

        // Turno já fechado / inexistente com sessão ainda "aberto" = inconsistência.
        // Encerra a órfã e não mantém a UI em "caixa aberto".
        if (!caixa || caixa.status !== 'aberto') {
          return encerrarSessaoOrfa(
            sessao,
            'Encerrada automaticamente: turno de caixa já estava fechado',
            empresaId,
            () => res.json(null)
          );
        }

        calcularResumoCaixa(caixa, { sessaoId: sessao.id }, (calcErr, resumo) => {
          if (calcErr) return res.status(500).json({ error: calcErr.message });
          resumo.sessao = sessao;
          resumo.empresa_id = empresaId;
          res.json(resumo);
        });
      });
      return;
    }

    // Sem sessão aberta: não reabrir a tela por turno órfão legado.
    // Só considera aberto se existir sessão consistente (caminho acima).
    return res.json(null);
  });
});

router.get('/saldo-inicial-sugerido', anexarEmpresaCaixa, (req, res) => {
  const terminalId = obterTerminalId(req);
  const empresaId = req.empresaId;

  if (isMultiCaixaAtivo() && !terminalId) {
    return res.json({
      valor_sugerido: 0,
      ultimo_caixa_id: null,
      fechado_em: null,
      mensagem: 'Aguardando registro do terminal para sugerir saldo.'
    });
  }

  const filtroTerminal = terminalId ? 'AND c.terminal_id = ?' : '';
  const params = terminalId ? [empresaId, terminalId] : [empresaId];

  db.get(`
    SELECT
      c.id,
      c.valor_fechamento,
      c.fechado_em
    FROM caixa c
    INNER JOIN caixa_sessoes s ON s.caixa_turno_id = c.id
    WHERE c.status = 'fechado'
      AND s.empresa_id = ?
      ${filtroTerminal}
    ORDER BY c.id DESC
    LIMIT 1
  `, params, (err, caixa) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const valor = Number(caixa?.valor_fechamento || 0);

    res.json({
      valor_sugerido: valor,
      ultimo_caixa_id: caixa?.id || null,
      fechado_em: caixa?.fechado_em || null,
      mensagem: caixa
        ? 'Saldo sugerido carregado do último fechamento.'
        : 'Nenhum fechamento anterior encontrado.'
    });
  });
});

function executarAberturaCaixa(req, res, { valorInicial, terminalId, caixaConfigId, empresaId }) {
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', (beginErr) => {
      if (beginErr) return res.status(500).json({ error: beginErr.message });

      obterSessaoAberta(terminalId, empresaId, (sessErr, sessaoAberta) => {
        if (sessErr) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: sessErr.message });
        }
        if (sessaoAberta) {
          db.run('ROLLBACK');
          return res.status(400).json({ error: 'Já existe um caixa aberto neste terminal.' });
        }

        const caixaData = {
          data: hoje(),
          valor_inicial: valorInicial,
          status: 'aberto',
          aberto_em: agoraLocalBrasil(),
          aberto_por: req.user?.id || null,
          terminal_id: terminalId || null
        };

        db.insertSafe('caixa', caixaData, function(insertErr, info) {
          if (insertErr) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: insertErr.message });
          }

          const caixaTurnoId = info && info.lastID ? info.lastID : this && this.lastID ? this.lastID : null;
          const sessaoCaixaConfigId = isMultiCaixaAtivo() ? caixaConfigId : caixaTurnoId;

          db.run(`
            INSERT INTO caixa_sessoes (
              caixa_id, caixa_turno_id, terminal_id, operador_id, empresa_id, valor_abertura, aberto_em, status
            ) VALUES (?, ?, ?, ?, ?, ?, DATETIME('now','localtime'), 'aberto')
          `, [sessaoCaixaConfigId, caixaTurnoId, terminalId || null, req.user?.id || null, empresaId, valorInicial], function(sessInsertErr) {
            if (sessInsertErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: sessInsertErr.message });
            }

            const sessaoId = this.lastID;

            db.run(`
              INSERT INTO caixa_movimentacoes (
                caixa_id,
                sessao_id,
                tipo,
                valor,
                motivo,
                usuario_id,
                terminal_id
              ) VALUES (?, ?, 'abertura', ?, 'Abertura de caixa', ?, ?)
            `, [caixaTurnoId, sessaoId, valorInicial, req.user?.id || null, terminalId || null], (movErr) => {
              if (movErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: movErr.message });
              }

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: commitErr.message });
                }

                gravarAuditoria({
                  usuario_id: req.user?.id || null,
                  usuario_nome: req.user?.nome || req.user?.username || null,
                  modulo: 'caixa',
                  acao: 'abrir_caixa',
                  referencia_tipo: 'caixa_sessao',
                  referencia_id: sessaoId,
                  detalhes: {
                    valor_inicial: valorInicial,
                    caixa_turno_id: caixaTurnoId,
                    caixa_config_id: sessaoCaixaConfigId,
                    terminal_id: terminalId || null,
                    empresa_id: empresaId
                  },
                  ip_requisicao: req.ip || null
                }).catch((auditErr) => console.error('Erro ao gravar auditoria de abertura de caixa:', auditErr));

                // RC5 — verificação de equipamentos via IntegrationService (não acessa Drivers).
                try {
                  const { modulos } = require('../services/equipamentos-integracao');
                  const ids = String(process.env.PDV_EQUIPAMENTOS_OBRIGATORIOS || '')
                    .split(',')
                    .map((s) => Number(String(s).trim()))
                    .filter(Boolean);
                  modulos.pdv.naAberturaCaixa(req.user || {}, {
                    equipamento_ids: ids,
                    tipos: ['balanca']
                  }).catch((e) => console.warn('[RC5] verificação equipamentos PDV:', e.message));
                } catch (e) {
                  console.warn('[RC5] integração equipamentos indisponível na abertura:', e.message);
                }

                res.json({
                  message: 'Caixa aberto com sucesso.',
                  caixa_id: caixaTurnoId,
                  caixa_config_id: sessaoCaixaConfigId,
                  sessao_id: sessaoId,
                  terminal_id: terminalId || null,
                  empresa_id: empresaId
                });
              });
            });
          });
        });
      });
    });
  });
}

router.post('/abrir', anexarEmpresaCaixa, exigirPermissaoOuSenhaAdmin('abrir_caixa'), exigirTerminalId, (req, res) => {
  const valorInicial = n(req.body.valor_inicial);
  const terminalId = obterTerminalId(req);
  const empresaId = req.empresaId;

  if (!isMultiCaixaAtivo()) {
    return executarAberturaCaixa(req, res, { valorInicial, terminalId, caixaConfigId: null, empresaId });
  }

  validarTerminalParaAbertura(terminalId, (valErr, validacao) => {
    if (valErr) return res.status(500).json({ error: valErr.message });
    if (!validacao.ok) return res.status(400).json({ error: validacao.error });

    executarAberturaCaixa(req, res, {
      valorInicial,
      terminalId,
      caixaConfigId: validacao.caixaConfigId,
      empresaId
    });
  });
});

router.post('/sangria', verificarToken, anexarEmpresaCaixa, validarCaixaAberto, exigirPermissaoOuSenhaAdmin('sangria_caixa'), async (req, res) => {
  const valor = n(req.body.valor);
  const motivo = req.body.motivo || 'Sangria de caixa';
  const operadorId = req.user?.id || null;
  const operadorNome = req.user?.nome || req.user?.username || 'Desconhecido';
  const empresaId = req.empresaId;

  if (valor <= 0) {
    return res.status(400).json({ error: 'Informe um valor válido para sangria.' });
  }

  const terminalId = obterTerminalId(req);

  obterSessaoAberta(terminalId, empresaId, (errSess, sessao) => {
        if (errSess) {
          return res.status(500).json({ error: errSess.message });
        }

        if (!sessao) {
          return res.status(400).json({ error: terminalId ? 'Nenhuma sessão de caixa aberta para este terminal.' : 'Nenhuma sessão de caixa aberta.' });
        }

        try {
          exigirSessaoDaEmpresa(sessao, empresaId);
        } catch (empErr) {
          return res.status(statusDeErroEmpresa(empErr)).json({
            error: empErr.message,
            code: empErr.code,
            empresa_id: empErr.empresa_id
          });
        }

        db.get('SELECT * FROM caixa WHERE id = ?', [obterCaixaTurnoId(sessao)], (errCaixa, caixa) => {
          if (errCaixa) return res.status(500).json({ error: errCaixa.message });
          if (!caixa) return res.status(400).json({ error: 'Caixa vinculado à sessão não encontrado.' });

          calcularResumoCaixa(caixa, { sessaoId: sessao.id }, (calcErr, resumo) => {
            if (calcErr) {
              return res.status(500).json({ error: calcErr.message });
            }

            if (valor > resumo.dinheiro.dinheiro_esperado) {
              return res.status(400).json({
                error: `Sangria maior que o dinheiro esperado. Disponível: ${resumo.dinheiro.dinheiro_esperado.toFixed(2)}`
              });
            }

            db.serialize(() => {
              db.run('BEGIN IMMEDIATE');

              db.run(
                `INSERT INTO caixa_movimentacoes (
                  caixa_id,
                  sessao_id,
                  tipo,
                  valor,
                  motivo,
                  usuario_id,
                  operador_nome,
                  terminal_id
                ) VALUES (?, ?, 'sangria', ?, ?, ?, ?, ?)`,
                [caixa.id, sessao.id, valor, motivo, operadorId, operadorNome, terminalId],
                (movErr) => {
                  if (movErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: movErr.message });
                  }

                  db.run(
                      `INSERT INTO auditoria_caixa (
                        sessao_id,
                        caixa_id,
                        operador_id,
                        terminal_id,
                        acao,
                        tipo_movimentacao,
                        valor,
                        detalhes
                      ) VALUES (?, ?, ?, ?, 'sangria', 'sangria', ?, ?)`,
                      [sessao.id, caixa.id, operadorId, sessao.terminal_id || terminalId, valor, JSON.stringify({ motivo, operador: operadorNome, sessao_id: sessao.id, empresa_id: empresaId })], (auditErr) => {
                      if (auditErr) console.error('Erro ao registrar auditoria:', auditErr);

                      db.run('COMMIT', (commitErr) => {
                        if (commitErr) {
                          db.run('ROLLBACK');
                          return res.status(500).json({ error: commitErr.message });
                        }

                        // auditoria centralizada
                        gravarAuditoria({
                          usuario_id: operadorId,
                          usuario_nome: operadorNome,
                          modulo: 'caixa',
                          acao: 'sangria',
                          referencia_tipo: 'caixa_sessao',
                          referencia_id: sessao.id,
                          detalhes: { valor, motivo, caixa_id: caixa.id, empresa_id: empresaId },
                          ip_requisicao: req.ip || null
                        }).catch((auditErr) => console.error('Erro ao gravar auditoria de sangria:', auditErr));

                        res.json({
                          message: 'Sangria registrada com sucesso.',
                          valor,
                          motivo,
                          operador: operadorNome,
                          empresa_id: empresaId
                        });
                      });
                    }
                  );
                }
              );
            });
          });
        });
      });
});

router.post('/suprimento', verificarToken, anexarEmpresaCaixa, validarCaixaAberto, exigirPermissaoOuSenhaAdmin('suprimento_caixa'), (req, res) => {
  const valor = n(req.body.valor);
  const motivo = req.body.motivo || 'Suprimento de caixa';
  const operadorId = req.user?.id || null;
  const operadorNome = req.user?.nome || req.user?.username || 'Desconhecido';
  const empresaId = req.empresaId;

  if (valor <= 0) {
    return res.status(400).json({ error: 'Informe um valor válido para suprimento.' });
  }

  const terminalId = obterTerminalId(req);

  obterSessaoAberta(terminalId, empresaId, (errSess, sessao) => {
      if (errSess) return res.status(500).json({ error: errSess.message });
      if (!sessao) return res.status(400).json({ error: terminalId ? 'Nenhuma sessão de caixa aberta para este terminal.' : 'Nenhuma sessão de caixa aberta.' });

      try {
        exigirSessaoDaEmpresa(sessao, empresaId);
      } catch (empErr) {
        return res.status(statusDeErroEmpresa(empErr)).json({
          error: empErr.message,
          code: empErr.code,
          empresa_id: empErr.empresa_id
        });
      }

      db.get('SELECT * FROM caixa WHERE id = ?', [obterCaixaTurnoId(sessao)], (err, caixa) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!caixa) return res.status(400).json({ error: 'Caixa vinculado à sessão não encontrado.' });

        db.serialize(() => {
          db.run('BEGIN IMMEDIATE');

          db.run(
            `INSERT INTO caixa_movimentacoes (
              caixa_id,
              sessao_id,
              tipo,
              valor,
              motivo,
              usuario_id,
              operador_nome,
              terminal_id
            ) VALUES (?, ?, 'suprimento', ?, ?, ?, ?, ?)`,
            [caixa.id, sessao.id, valor, motivo, operadorId, operadorNome, terminalId],
            (movErr) => {
              if (movErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: movErr.message });
              }

              db.run(
                `INSERT INTO auditoria_caixa (
                  sessao_id,
                  caixa_id,
                  operador_id,
                  terminal_id,
                  acao,
                  tipo_movimentacao,
                  valor,
                  detalhes,
                  ip_requisicao
                ) VALUES (?, ?, ?, ?, 'suprimento', 'suprimento', ?, ?, ?)`,
                [sessao.id, caixa.id, operadorId, sessao.terminal_id || terminalId, valor, JSON.stringify({ motivo, operador: operadorNome, sessao_id: sessao.id, empresa_id: empresaId }), req.ip || null],
                (auditErr) => {
                  if (auditErr) console.error('Erro ao registrar auditoria:', auditErr);

                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: commitErr.message });
                    }

                    // auditoria centralizada
                    gravarAuditoria({
                      usuario_id: operadorId,
                      usuario_nome: operadorNome,
                      modulo: 'caixa',
                      acao: 'suprimento',
                      referencia_tipo: 'caixa_sessao',
                      referencia_id: sessao.id,
                      detalhes: { valor, motivo, caixa_id: caixa.id, empresa_id: empresaId },
                      ip_requisicao: req.ip || null
                    }).catch((auditErr) => console.error('Erro ao gravar auditoria de suprimento:', auditErr));

                    res.json({
                      message: 'Suprimento registrado com sucesso.',
                      valor,
                      motivo,
                      operador: operadorNome,
                      empresa_id: empresaId
                    });
                  });
                }
              );
            }
          );
        });
      });
    }
  );
});

router.post('/fechar', verificarToken, anexarEmpresaCaixa, validarCaixaAberto, exigirPermissaoOuSenhaAdmin('fechar_caixa'), (req, res) => {
  const valorInformado = n(req.body.valor_informado);
  const observacao = req.body.observacao || '';
  const operadorId = req.user?.id || null;
  const operadorNome = req.user?.nome || req.user?.username || 'Desconhecido';
  const terminalId = obterTerminalId(req);
  const empresaId = req.empresaId;
  obterSessaoAberta(terminalId, empresaId, (errSess, sessao) => {
      if (errSess) return res.status(500).json({ error: errSess.message });
      if (!sessao) return res.status(400).json({ error: terminalId ? 'Nenhuma sessão de caixa aberta para este terminal.' : 'Nenhuma sessão de caixa aberta.' });

      try {
        exigirSessaoDaEmpresa(sessao, empresaId);
      } catch (empErr) {
        return res.status(statusDeErroEmpresa(empErr)).json({
          error: empErr.message,
          code: empErr.code,
          empresa_id: empErr.empresa_id
        });
      }

      db.get('SELECT * FROM caixa WHERE id = ?', [obterCaixaTurnoId(sessao)], (err, caixa) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!caixa) return res.status(400).json({ error: 'Caixa vinculado à sessão não encontrado.' });

        db.get(`SELECT id FROM caixa_fechamentos WHERE sessao_id = ? LIMIT 1`, [sessao.id], (checkErr, jaFechado) => {
          if (checkErr) return res.status(500).json({ error: checkErr.message });
          if (jaFechado) {
            return res.status(400).json({ error: 'Esta sessão de caixa já foi fechada. Use REIMPRESSÃO se necessário reimprimir.' });
          }

          obterMetaSessao(sessao, operadorNome, (metaErr, meta) => {
            if (metaErr) return res.status(500).json({ error: metaErr.message });

            calcularFechamentoDetalhado(caixa, {
              sessaoId: sessao.id,
              valorInformado,
              meta,
              validar: true
            }, (calcErr, detalhes) => {
              if (calcErr) return res.status(400).json({ error: calcErr.message });

              const diferenca = n(detalhes.diferenca);
              const consolidacao = detalhes.consolidacao || null;
              const fechadoEm = agoraLocalBrasil();
              if (consolidacao) {
                consolidacao.fechamento = consolidacao.fechamento || {};
                consolidacao.fechamento.em = fechadoEm;
                consolidacao.periodo = consolidacao.periodo || {};
                consolidacao.periodo.fechado_em = fechadoEm;
                consolidacao.operador = {
                  ...(consolidacao.operador || {}),
                  id: operadorId,
                  nome: operadorNome
                };
                consolidacao.empresa = {
                  id: empresaId,
                  nome: meta.empresa_nome,
                  cnpj: meta.empresa_cnpj
                };
                consolidacao.terminal = {
                  id: meta.terminal_id,
                  nome: meta.terminal_nome
                };
              }

              const cupomHtml = gerarHtmlCupomFechamento(consolidacao, {
                empresa_nome: meta.empresa_nome,
                empresa_cnpj: meta.empresa_cnpj,
                terminal_nome: meta.terminal_nome,
                operador_nome: operadorNome,
                caixa_id: caixa.id,
                fechado_em: fechadoEm,
                reimpressao: false
              });

              const resumoJson = consolidacao ? JSON.stringify(consolidacao) : null;

              db.serialize(() => {
                db.run('BEGIN IMMEDIATE');

                db.run(`
                  UPDATE caixa SET
                    status = 'fechado',
                    fechado_em = ?,
                    fechado_por = ?,
                    valor_fechamento = ?,
                    total_sangrias = ?,
                    total_suprimentos = ?,
                    saldo_esperado = ?,
                    diferenca = ?,
                    observacao = ?
                  WHERE id = ?
                `, [
                  fechadoEm,
                  operadorId,
                  valorInformado,
                  detalhes.total_sangrias,
                  detalhes.total_suprimentos,
                  detalhes.total_esperado,
                  diferenca,
                  observacao,
                  caixa.id
                ], (updateErr) => {
                  if (updateErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: updateErr.message });
                  }

                  db.run(`
                    INSERT INTO caixa_fechamentos (
                      sessao_id,
                      caixa_id,
                      operador_id,
                      terminal_id,
                      data_fechamento,
                      valor_inicial,
                      vendas_dinheiro,
                      vendas_pix,
                      vendas_debito,
                      vendas_credito,
                      vendas_prazo,
                      vendas_tef,
                      vendas_outros,
                      total_sangrias,
                      total_suprimentos,
                      total_vendido,
                      total_esperado,
                      total_informado,
                      diferenca,
                      observacao,
                      resumo_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  `, [
                    sessao.id,
                    caixa.id,
                    operadorId,
                    sessao.terminal_id || terminalId,
                    fechadoEm,
                    detalhes.valor_inicial,
                    detalhes.vendas_dinheiro,
                    detalhes.vendas_pix,
                    detalhes.vendas_debito,
                    detalhes.vendas_credito,
                    detalhes.vendas_prazo,
                    detalhes.vendas_tef,
                    detalhes.vendas_outros || 0,
                    detalhes.total_sangrias,
                    detalhes.total_suprimentos,
                    detalhes.total_vendido,
                    detalhes.total_esperado,
                    valorInformado,
                    diferenca,
                    observacao,
                    resumoJson
                  ], (insertErr) => {
                    if (insertErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: insertErr.message });
                    }

                    let sqlSessoes = `
                      UPDATE caixa_sessoes
                      SET status = 'fechado',
                          fechado_em = ?,
                          valor_fechamento = ?
                      WHERE status = 'aberto'
                        AND empresa_id = ?
                        AND (id = ? OR caixa_turno_id = ?)
                    `;
                    const paramsSessaoFull = [fechadoEm, valorInformado, empresaId, sessao.id, caixa.id];
                    if (terminalId) {
                      sqlSessoes += ' AND (terminal_id = ? OR terminal_id IS NULL)';
                      paramsSessaoFull.push(terminalId);
                    }

                    db.run(sqlSessoes, paramsSessaoFull, function(sessUpdErr) {
                      if (sessUpdErr) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: sessUpdErr.message });
                      }
                      if (this.changes < 1) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: 'Não foi possível encerrar a sessão de caixa.' });
                      }

                      db.run(`
                        INSERT INTO auditoria_caixa (
                          sessao_id,
                          caixa_id,
                          operador_id,
                          terminal_id,
                          acao,
                          tipo_movimentacao,
                          valor,
                          detalhes,
                          ip_requisicao
                        ) VALUES (?, ?, ?, ?, 'fechamento', 'fechamento', ?, ?, ?)
                      `, [
                        sessao.id,
                        caixa.id,
                        operadorId,
                        sessao.terminal_id || terminalId,
                        valorInformado,
                        JSON.stringify({
                          diferenca,
                          operador: operadorNome,
                          observacao,
                          sessao_id: sessao.id,
                          empresa_id: empresaId,
                          sessoes_encerradas: this.changes,
                          total_recebido: detalhes.total_vendido,
                          entregas_pendentes: detalhes.entregas_pendentes || 0
                        }),
                        req.ip || null
                      ], (auditErr) => {
                        if (auditErr) console.error('Erro ao registrar auditoria:', auditErr);

                        db.run(`
                          INSERT INTO caixa_movimentacoes (
                            caixa_id,
                            sessao_id,
                            tipo,
                            valor,
                            motivo,
                            usuario_id,
                            operador_nome
                          ) VALUES (?, ?, 'fechamento', ?, 'Fechamento de caixa', ?, ?)
                        `, [caixa.id, sessao.id, valorInformado, operadorId, operadorNome], (movErr) => {
                          if (movErr) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: movErr.message });
                          }

                          db.run('COMMIT', (commitErr) => {
                            if (commitErr) {
                              db.run('ROLLBACK');
                              return res.status(500).json({ error: commitErr.message });
                            }

                            gravarAuditoria({
                              usuario_id: operadorId,
                              usuario_nome: operadorNome,
                              modulo: 'caixa',
                              acao: 'fechar_caixa',
                              referencia_tipo: 'caixa_sessao',
                              referencia_id: sessao.id,
                              detalhes: {
                                valor_informado: valorInformado,
                                diferenca,
                                observacao,
                                caixa_id: caixa.id,
                                empresa_id: empresaId,
                                total_recebido: detalhes.total_vendido
                              },
                              ip_requisicao: req.ip || null
                            }).catch((aErr) => console.error('Erro ao gravar auditoria de fechamento de caixa:', aErr));

                            res.json({
                              message: 'Caixa fechado com sucesso.',
                              caixa_id: caixa.id,
                              sessao_id: sessao.id,
                              empresa_id: empresaId,
                              operador: operadorNome,
                              cupom_html: cupomHtml,
                              detalhes: {
                                ...detalhes,
                                total_informado: valorInformado,
                                diferenca
                              }
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    }
  );
});

function obterDetalhesCaixa(caixaId, empresaId, callback) {
  if (typeof empresaId === 'function') {
    return empresaId(new Error('Empresa é obrigatória para detalhar turno de caixa.'));
  }
  db.get(`
    SELECT c.*, ua.nome AS aberto_por_nome, uf.nome AS fechado_por_nome
    FROM caixa c
    LEFT JOIN usuarios ua ON ua.id = c.aberto_por
    LEFT JOIN usuarios uf ON uf.id = c.fechado_por
    WHERE c.id = ?
      AND EXISTS (
        SELECT 1 FROM caixa_sessoes s
        WHERE s.empresa_id = ?
          AND (s.caixa_turno_id = c.id OR (s.caixa_turno_id IS NULL AND s.caixa_id = c.id))
      )
  `, [caixaId, empresaId], (err, caixa) => {
    if (err) return callback(err);
    if (!caixa) return callback(null, null);

    let querySessao;
    try {
      querySessao = montarSqlUltimaSessaoDoTurnoDaEmpresa({ caixaTurnoId: caixaId, empresaId });
    } catch (sqlErr) {
      return callback(sqlErr);
    }

    db.get(querySessao.sql, querySessao.params, (sErr, sRow) => {
      if (sErr) return callback(sErr);

      if (!sRow) {
        return callback(null, {
          caixa,
          fechamento: null,
          movimentacoes: [],
          auditoria: []
        });
      }

      const sessaoId = sRow.id;

      db.get(
        `SELECT * FROM caixa_fechamentos WHERE sessao_id = ? ORDER BY id DESC LIMIT 1`,
        [sessaoId],
        (fechErr, fechamento) => {
          if (fechErr) return callback(fechErr);

          db.all(`SELECT cm.*, u.nome as usuario_nome FROM caixa_movimentacoes cm LEFT JOIN usuarios u ON u.id = cm.usuario_id WHERE cm.sessao_id = ? ORDER BY cm.id DESC`, [sessaoId], (movErr, movimentacoes) => {
            if (movErr) return callback(movErr);

            db.all(`SELECT * FROM auditoria_caixa WHERE sessao_id = ? ORDER BY criado_em DESC`, [sessaoId], (auditErr, auditoria) => {
              if (auditErr) return callback(auditErr);

              callback(null, {
                caixa,
                fechamento: fechamento || null,
                movimentacoes: movimentacoes || [],
                auditoria: auditoria || []
              });
            });
          });
        }
      );
    });
  });
}

router.get('/fechamento/:caixa_id', anexarEmpresaCaixa, (req, res) => {
  const caixaId = Number(req.params.caixa_id);

  obterDetalhesCaixa(caixaId, req.empresaId, (err, detalhes) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!detalhes) return res.status(404).json({ error: 'Caixa não encontrado.', code: 'CAIXA_NAO_ENCONTRADO' });

    let consolidacao = null;
    if (detalhes.fechamento?.resumo_json) {
      try {
        consolidacao = JSON.parse(detalhes.fechamento.resumo_json);
      } catch (_) {
        consolidacao = null;
      }
    }

    res.json({
      caixa: detalhes.caixa,
      fechamento: detalhes.fechamento,
      consolidacao,
      movimentacoes: detalhes.movimentacoes,
      auditoria: detalhes.auditoria
    });
  });
});

/**
 * Reimpressão do cupom de fechamento — não altera valores financeiros.
 * Marca ja_reimpresso = 1 apenas como flag informativa (não bloqueia novas reimpressões).
 */
router.post('/:caixa_id/reimprimir', verificarToken, anexarEmpresaCaixa, (req, res) => {
  const caixaId = Number(req.params.caixa_id);
  if (!caixaId) return res.status(400).json({ error: 'ID do caixa inválido.' });

  obterDetalhesCaixa(caixaId, req.empresaId, (err, detalhes) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!detalhes?.caixa) return res.status(404).json({ error: 'Caixa não encontrado.', code: 'CAIXA_NAO_ENCONTRADO' });
    if (detalhes.caixa.status !== 'fechado') {
      return res.status(400).json({ error: 'Somente caixas fechados podem ser reimpressos.' });
    }

    const fechamento = detalhes.fechamento;
    if (!fechamento) {
      return res.status(404).json({ error: 'Registro de fechamento não encontrado para este caixa.' });
    }

    const operadorNome = req.user?.nome || req.user?.username || detalhes.caixa.fechado_por_nome || 'Operador';

    const finalizarComHtml = (consolidacao, meta = {}) => {
      const cupomHtml = gerarHtmlCupomFechamento(consolidacao, {
        empresa_nome: meta.empresa_nome || consolidacao?.empresa?.nome,
        empresa_cnpj: meta.empresa_cnpj || consolidacao?.empresa?.cnpj,
        terminal_nome: meta.terminal_nome || consolidacao?.terminal?.nome,
        operador_nome: consolidacao?.operador?.nome || operadorNome,
        caixa_id: caixaId,
        fechado_em: detalhes.caixa.fechado_em || fechamento.data_fechamento,
        reimpressao: true
      });

      db.run(
        `UPDATE caixa SET ja_reimpresso = 1 WHERE id = ?`,
        [caixaId],
        (updErr) => {
          if (updErr) console.error('Erro ao marcar ja_reimpresso:', updErr.message);

          gravarAuditoria({
            usuario_id: req.user?.id || null,
            usuario_nome: operadorNome,
            modulo: 'caixa',
            acao: 'reimprimir_fechamento',
            referencia_tipo: 'caixa',
            referencia_id: caixaId,
            detalhes: { fechamento_id: fechamento.id, sessao_id: fechamento.sessao_id },
            ip_requisicao: req.ip || null
          }).catch(() => {});

          res.json({
            message: 'Reimpressão do fechamento gerada com sucesso.',
            caixa_id: caixaId,
            ja_reimpresso: 1,
            cupom_html: cupomHtml,
            consolidacao,
            fechamento
          });
        }
      );
    };

    if (fechamento.resumo_json) {
      try {
        const consolidacao = JSON.parse(fechamento.resumo_json);
        return finalizarComHtml(consolidacao);
      } catch (parseErr) {
        console.warn('resumo_json inválido no fechamento, recalculando:', parseErr.message);
      }
    }

    // Fallback: recomputa a partir da sessão (não altera o registro de fechamento)
    db.get('SELECT * FROM caixa_sessoes WHERE id = ? AND empresa_id = ?', [fechamento.sessao_id, req.empresaId], (sErr, sessao) => {
      if (sErr) return res.status(500).json({ error: sErr.message });
      if (!sessao) return res.status(404).json({ error: 'Sessão do fechamento não encontrada.' });

      obterMetaSessao(sessao, operadorNome, (metaErr, meta) => {
        if (metaErr) return res.status(500).json({ error: metaErr.message });

        FechamentoCaixaResumoService.consolidarSessaoCaixa(detalhes.caixa, {
          sessaoId: sessao.id,
          valorInformado: n(fechamento.total_informado),
          meta
        }).then((consolidacao) => {
          consolidacao.operador = {
            ...(consolidacao.operador || {}),
            id: fechamento.operador_id,
            nome: operadorNome
          };
          consolidacao.fechamento = {
            em: detalhes.caixa.fechado_em || fechamento.data_fechamento,
            valor_informado: n(fechamento.total_informado)
          };
          consolidacao.dinheiro.informado = n(fechamento.total_informado);
          consolidacao.dinheiro.diferenca = n(fechamento.diferenca);
          finalizarComHtml(consolidacao, meta);
        }).catch((calcErr) => res.status(500).json({ error: calcErr.message }));
      });
    });
  });
});

router.get('/sessoes/:sessao_id', anexarEmpresaCaixa, (req, res) => {
  obterSessaoDaEmpresaPorId(db, {
    sessaoId: Number(req.params.sessao_id),
    empresaId: req.empresaId
  }).then((sessao) => res.json(sessao)).catch((err) => {
    const status = err.statusCode || statusDeErroEmpresa(err);
    return res.status(status).json({
      error: err.message || 'Sessão de caixa não encontrada.',
      code: err.code || 'CAIXA_SESSAO_NAO_ENCONTRADA'
    });
  });
});

router.get('/movimentacao/:id', anexarEmpresaCaixa, (req, res) => {
  obterMovimentacaoDaEmpresaPorId(db, {
    movimentacaoId: Number(req.params.id),
    empresaId: req.empresaId
  }).then((row) => res.json(row)).catch((err) => {
    const status = err.statusCode || statusDeErroEmpresa(err);
    return res.status(status).json({
      error: err.message || 'Movimentação de caixa não encontrada.',
      code: err.code || 'CAIXA_MOVIMENTACAO_NAO_ENCONTRADA'
    });
  });
});

router.get('/historico', anexarEmpresaCaixa, (req, res) => {
  let query;
  try {
    query = montarSqlHistoricoTurnosDaEmpresa(req.empresaId, { limite: 100 });
  } catch (sqlErr) {
    return res.status(statusDeErroEmpresa(sqlErr)).json({
      error: sqlErr.message,
      code: sqlErr.code
    });
  }
  db.all(query.sql, query.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

router.get('/movimentacoes/:caixa_id', anexarEmpresaCaixa, validarCaixaAberto, (req, res) => {
  const sessaoId = req.caixaSessaoId;
  const empresaId = req.empresaId;
  const caixaId = Number(req.params.caixa_id);
  if (!sessaoId) return res.status(400).json({ error: 'Nenhuma sessão de caixa aberta para este terminal.' });

  let turnoQuery;
  try {
    turnoQuery = montarSqlUltimaSessaoDoTurnoDaEmpresa({ caixaTurnoId: caixaId, empresaId });
  } catch (sqlErr) {
    return res.status(statusDeErroEmpresa(sqlErr)).json({
      error: sqlErr.message,
      code: sqlErr.code
    });
  }

  db.get(turnoQuery.sql, turnoQuery.params, (turnoErr, turnoSessao) => {
    if (turnoErr) return res.status(500).json({ error: turnoErr.message });
    if (!turnoSessao) {
      return res.status(404).json({
        error: 'Sessão de caixa não encontrada.',
        code: 'CAIXA_SESSAO_NAO_ENCONTRADA'
      });
    }

    let query;
    try {
      query = montarSqlMovimentacoesDaSessaoDaEmpresa({ sessaoId, empresaId });
    } catch (sqlErr) {
      return res.status(statusDeErroEmpresa(sqlErr)).json({
        error: sqlErr.message,
        code: sqlErr.code
      });
    }

    db.all(query.sql, query.params, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  });
});

router.get('/por-data', anexarEmpresaCaixa, (req, res) => {
  const data = req.query.data || hoje();
  const modoFiscal = req.query.modo_fiscal || '0';
  const empresaId = req.empresaId;

  let query;
  try {
    query = montarSqlHistoricoTurnosDaEmpresa(empresaId, { limite: 500, data });
  } catch (sqlErr) {
    return res.status(statusDeErroEmpresa(sqlErr)).json({
      sucesso: false,
      mensagem: sqlErr.message,
      code: sqlErr.code
    });
  }

  db.all(query.sql, query.params, (err, caixas) => {
    if (err) {
      return res.status(500).json({
        sucesso: false,
        mensagem: err.message
      });
    }

    if (!caixas || caixas.length === 0) {
      return res.json({
        sucesso: true,
        data,
        caixas: []
      });
    }

    const resultado = [];
    let processados = 0;

    caixas.forEach((caixa) => {
      let querySessao;
      try {
        querySessao = montarSqlUltimaSessaoDoTurnoDaEmpresa({ caixaTurnoId: caixa.id, empresaId });
      } catch (sqlErr) {
        return res.status(statusDeErroEmpresa(sqlErr)).json({
          sucesso: false,
          mensagem: sqlErr.message,
          code: sqlErr.code
        });
      }

      db.get(querySessao.sql, querySessao.params, (sErr, sRow) => {
        if (sErr) {
          return res.status(500).json({ sucesso: false, mensagem: sErr.message });
        }

        const sessaoId = sRow ? sRow.id : null;

        calcularResumoCaixa(caixa, { sessaoId, modo_fiscal: modoFiscal }, (calcErr, resumo) => {
          if (calcErr) {
            return res.status(500).json({ sucesso: false, mensagem: calcErr.message });
          }

          if (!sessaoId) {
            resultado.push({ caixa, resumo, movimentacoes: [] });
            processados++;
            if (processados === caixas.length) {
              res.json({ sucesso: true, data, caixas: resultado });
            }
            return;
          }

          db.all(`
            SELECT cm.*, u.nome as usuario_nome
            FROM caixa_movimentacoes cm
            LEFT JOIN usuarios u ON u.id = cm.usuario_id
            WHERE cm.sessao_id = ?
            ORDER BY cm.id DESC
          `, [sessaoId], (movErr, movimentacoes) => {
            if (movErr) return res.status(500).json({ sucesso: false, mensagem: movErr.message });

            resultado.push({ caixa, resumo, movimentacoes: movimentacoes || [] });

            processados++;

            if (processados === caixas.length) {
              res.json({ sucesso: true, data, caixas: resultado });
            }
          });
        });
      });
    });
  });
});

module.exports = router;