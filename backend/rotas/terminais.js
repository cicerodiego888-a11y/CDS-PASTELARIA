const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../database');
const { gravarAuditoria } = require('../services/auditoria');
const MobileTerminalService = require('../services/TerminalPdvMobileService');
const { verificarToken } = require('../middleware/auth');
const { exigirPermissaoOuSenhaAdmin } = require('../middleware/exigirPermissaoOuSenhaAdmin');

const { getJwtSecret } = require('../config/secrets');
const JWT_SECRET = getJwtSecret();
const HEARTBEAT_ONLINE_MS = 3 * 60 * 1000;

function terminalEstaOnline(ultimaConexao) {
  if (!ultimaConexao) return false;
  const diff = Date.now() - new Date(ultimaConexao).getTime();
  return diff >= 0 && diff < HEARTBEAT_ONLINE_MS;
}

function anexarStatusOnline(rows) {
  return (rows || []).map((row) => ({
    ...row,
    online: terminalEstaOnline(row.ultima_conexao)
  }));
}

function extrairUsuarioHeartbeat(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader) {
    try {
      const token = String(authHeader).split(' ')[1];
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET);
        return {
          usuario_id: decoded.id || null,
          usuario_nome: String(decoded.nome || decoded.username || '').trim() || null
        };
      }
    } catch (e) { /* ignore token inválido no heartbeat */ }
  }

  const usuarioId = req.query.usuario_id ? Number(req.query.usuario_id) : null;
  const usuarioNome = req.query.usuario_nome ? String(req.query.usuario_nome).trim() : null;
  return {
    usuario_id: Number.isInteger(usuarioId) && usuarioId > 0 ? usuarioId : null,
    usuario_nome: usuarioNome || null
  };
}

function registrarTerminalAuto(req, res) {
  const origem = String(req.query.origem || '').trim().toLowerCase();
  if (origem !== 'pdv') {
    return res.status(400).json({ error: 'Heartbeat de terminal permitido apenas pelo módulo PDV (origem=pdv).' });
  }

  const hostname = String(req.query.hostname || '').trim();
  if (!hostname || hostname === 'web-browser') {
    return res.status(400).json({ error: 'Hostname do terminal PDV inválido.' });
  }
  if (hostname.toLowerCase().startsWith(MobileTerminalService.MOBILE_HOST_PREFIX)) {
    return res.status(400).json({ error: 'Identidade Mobile reservada para o registro autenticado.' });
  }

  const { usuario_id: usuarioId, usuario_nome: usuarioNome } = extrairUsuarioHeartbeat(req);

  db.get(`SELECT * FROM terminais WHERE hostname = ?`, [hostname], (err, terminal) => {
    if (err) return res.status(500).json({ error: err.message });

    const agora = new Date().toISOString();
    if (terminal) {
      const aplicarHeartbeat = (usuarioIdSeguro) => {
        db.run(
          `UPDATE terminais SET ultima_conexao = ?, usuario_id = ?, usuario_nome = ?, updated_at = ? WHERE id = ?`,
          [agora, usuarioIdSeguro, usuarioNome, agora, terminal.id],
          (updateErr) => {
            if (updateErr) {
              console.error('Erro ao atualizar terminal:', updateErr);
            }
            db.get(`SELECT * FROM terminais WHERE id = ?`, [terminal.id], (getErr, updated) => {
              if (getErr) return res.status(500).json({ error: getErr.message });
              res.json({ ...updated, online: true });
            });
          }
        );
      };

      // Evita FK em terminais.usuario_id quando o JWT aponta usuário inexistente
      if (usuarioId) {
        db.get('SELECT id FROM usuarios WHERE id = ?', [usuarioId], (userErr, userRow) => {
          if (userErr) {
            console.error('Erro ao validar usuário do heartbeat:', userErr);
            return aplicarHeartbeat(null);
          }
          aplicarHeartbeat(userRow ? usuarioId : null);
        });
        return;
      }

      aplicarHeartbeat(null);
      return;
    }

    const nomeTerminal = hostname;
    db.run(
      `INSERT INTO terminais (nome, hostname, usuario_id, usuario_nome, ativo, ultima_conexao, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [hostname, hostname, usuarioId, usuarioNome, agora, agora, agora],
      function(insertErr) {
        if (insertErr) return res.status(500).json({ error: insertErr.message });

        const novoId = this.lastID;
        db.get(`SELECT * FROM terminais WHERE id = ?`, [novoId], (getErr, novoTerminal) => {
          if (getErr) return res.status(500).json({ error: getErr.message });

          gravarAuditoria({
            usuario_id: req.user?.id || null,
            usuario_nome: req.user?.nome || req.user?.username || null,
            modulo: 'terminais',
            acao: 'criar_terminal',
            referencia_tipo: 'terminal',
            referencia_id: novoId,
            detalhes: { nome: nomeTerminal, hostname, origem: 'pdv' },
            ip_requisicao: req.ip || null
          }).catch((auditErr) => console.error('Erro ao gravar auditoria de terminal:', auditErr));

          res.json({ ...novoTerminal, online: true });
        });
      }
    );
  });
}

function responderErroTerminalMobile(res, err) {
  const status = Number(err && (err.status || err.statusCode)) || 500;
  if (status >= 500) {
    console.error('Erro no fluxo de terminal Mobile:', err);
  }
  return res.status(status).json({
    error: err && err.message ? err.message : 'Erro no fluxo de terminal Mobile.',
    code: err && err.code ? err.code : 'TERMINAL_MOBILE_ERRO'
  });
}

async function registrarTerminalMobile(req, res) {
  try {
    const resultado = await MobileTerminalService.registrar({
      req,
      db,
      installationId: req.body && req.body.installation_id
    });
    if (resultado.criado) {
      gravarAuditoria({
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || req.user.username || null,
        modulo: 'terminais',
        acao: 'registrar_terminal_mobile',
        referencia_tipo: 'terminal',
        referencia_id: resultado.terminal.id,
        detalhes: {
          empresa_id: resultado.empresa_id,
          tipo: 'mobile'
        },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao auditar terminal Mobile:', auditErr));
    }
    return res.status(resultado.criado ? 201 : 200).json({
      ...resultado.terminal,
      tipo: 'mobile',
      empresa_id: resultado.empresa_id
    });
  } catch (err) {
    return responderErroTerminalMobile(res, err);
  }
}

async function heartbeatTerminalMobile(req, res) {
  try {
    const resultado = await MobileTerminalService.heartbeat({
      req,
      db,
      installationId: req.body && req.body.installation_id,
      terminalId: req.body && req.body.terminal_id
    });
    return res.json(resultado);
  } catch (err) {
    return responderErroTerminalMobile(res, err);
  }
}

async function garantirCaixaProprioMobile(req, res) {
  try {
    const resultado = await MobileTerminalService.garantirCaixaProprio({
      req,
      db,
      installationId: req.body && req.body.installation_id,
      terminalId: req.body && req.body.terminal_id
    });
    if (resultado.criado) {
      gravarAuditoria({
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || req.user.username || null,
        modulo: 'terminais',
        acao: 'criar_caixa_exclusivo_mobile',
        referencia_tipo: 'caixa',
        referencia_id: resultado.caixa.id,
        detalhes: {
          terminal_id: Number(req.body.terminal_id),
          empresa_id: resultado.empresa_id
        },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao auditar caixa Mobile:', auditErr));
    }
    return res.status(resultado.criado ? 201 : 200).json({
      ...resultado.caixa,
      criado: resultado.criado,
      empresa_id: resultado.empresa_id
    });
  } catch (err) {
    return responderErroTerminalMobile(res, err);
  }
}

function exigirSuperAdminTerminal(req, res, next) {
  const perfil = String(req.user?.perfil || '').toUpperCase();
  if (perfil !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Apenas SUPER_ADMIN pode nomear este PDV.' });
  }
  next();
}

function atualizarNomeTerminalPdv(req, res) {
  const hostname = String(req.body?.hostname || '').trim();
  const nome = String(req.body?.nome || '').trim();

  if (!hostname || hostname === 'web-browser') {
    return res.status(400).json({ error: 'Hostname do terminal PDV inválido.' });
  }

  if (!nome) {
    return res.status(400).json({ error: 'Informe um nome para identificar este PDV.' });
  }

  if (nome.length > 80) {
    return res.status(400).json({ error: 'Nome muito longo (máximo 80 caracteres).' });
  }

  const agora = new Date().toISOString();

  db.get(`SELECT * FROM terminais WHERE hostname = ?`, [hostname], (err, terminal) => {
    if (err) return res.status(500).json({ error: err.message });

    const salvarNome = (terminalId) => {
      db.run(
        `UPDATE terminais SET nome = ?, updated_at = ? WHERE id = ?`,
        [nome, agora, terminalId],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: updateErr.message });

          db.get(`
            SELECT t.*, c.nome AS caixa_nome
            FROM terminais t
            LEFT JOIN caixas c ON c.id = t.caixa_id
            WHERE t.id = ?
          `, [terminalId], (getErr, row) => {
            if (getErr) return res.status(500).json({ error: getErr.message });

            gravarAuditoria({
              usuario_id: req.user?.id || null,
              usuario_nome: req.user?.nome || req.user?.username || null,
              modulo: 'terminais',
              acao: 'nomear_terminal_pdv',
              referencia_tipo: 'terminal',
              referencia_id: terminalId,
              detalhes: { hostname, nome, origem: 'pdv' },
              ip_requisicao: req.ip || null
            }).catch((auditErr) => console.error('Erro ao gravar auditoria de nome do terminal:', auditErr));

            res.json({ ...row, online: terminalEstaOnline(row.ultima_conexao) });
          });
        }
      );
    };

    if (terminal) {
      return salvarNome(terminal.id);
    }

    db.run(
      `INSERT INTO terminais (nome, hostname, ativo, ultima_conexao, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`,
      [nome, hostname, agora, agora, agora],
      function(insertErr) {
        if (insertErr) return res.status(500).json({ error: insertErr.message });
        salvarNome(this.lastID);
      }
    );
  });
}

function registrarTerminalOffline(req, res) {
  const origem = String(req.query.origem || '').trim().toLowerCase();
  if (origem !== 'pdv') {
    return res.status(400).json({ error: 'Desconexão permitida apenas pelo módulo PDV (origem=pdv).' });
  }

  const hostname = String(req.query.hostname || '').trim();
  if (!hostname) {
    return res.status(400).json({ error: 'Hostname do terminal não pode estar vazio.' });
  }

  const agora = new Date().toISOString();
  db.run(
    `UPDATE terminais SET ultima_conexao = NULL, usuario_id = NULL, usuario_nome = NULL, updated_at = ? WHERE hostname = ?`,
    [agora, hostname],
    function(updateErr) {
      if (updateErr) return res.status(500).json({ error: updateErr.message });
      res.json({ ok: true, offline: true, hostname, changes: this.changes });
    }
  );
}

router.get('/', (req, res) => {
  db.all(`
    SELECT t.*, c.nome AS caixa_nome
    FROM terminais t
    LEFT JOIN caixas c ON c.id = t.caixa_id
    WHERE COALESCE(t.ativo, 1) = 1
    ORDER BY t.ultima_conexao DESC, t.id
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(anexarStatusOnline(rows));
  });
});

router.post('/', (req, res) => {
  const { nome, hostname, caixa_id, ativo } = req.body;
  const nomeTerminal = String(nome || hostname || '').trim();

  if (req.headers['x-mobile-installation-id']) {
    return res.status(403).json({
      error: 'Uma instalação Mobile não pode cadastrar outro terminal.',
      code: 'TERMINAL_MOBILE_OPERACAO_NAO_PERMITIDA'
    });
  }
  if (!nomeTerminal) {
    return res.status(400).json({ error: 'Nome ou hostname do terminal é obrigatório.' });
  }

  const hostnameTerminal = String(hostname || nomeTerminal).trim();
  if (hostnameTerminal.toLowerCase().startsWith(MobileTerminalService.MOBILE_HOST_PREFIX)) {
    return res.status(400).json({ error: 'Identidade Mobile reservada para o registro autenticado.' });
  }

  const valores = [nomeTerminal, hostnameTerminal || null, caixa_id || null, ativo === 0 ? 0 : 1, new Date().toISOString(), new Date().toISOString()];

  const inserirTerminal = () => db.run(
    `INSERT INTO terminais (nome, hostname, caixa_id, ativo, ultima_conexao, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    valores,
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM terminais WHERE id = ?`, [this.lastID], (getErr, row) => {
        if (getErr) return res.status(500).json({ error: getErr.message });
        res.status(201).json(row);
      });
    }
  );
  if (caixa_id == null || caixa_id === '') return inserirTerminal();

  db.get(
    `SELECT hostname FROM terminais WHERE caixa_id = ? LIMIT 1`,
    [caixa_id],
    (errVinculo, vinculo) => {
      if (errVinculo) return res.status(500).json({ error: errVinculo.message });
      if (vinculo && String(vinculo.hostname || '').toLowerCase().startsWith(MobileTerminalService.MOBILE_HOST_PREFIX)) {
        return res.status(409).json({
          error: 'O caixa já está vinculado a um terminal Mobile.',
          code: 'CAIXA_VINCULADO_A_OUTRO_TERMINAL'
        });
      }
      inserirTerminal();
    }
  );
});

router.post('/mobile/registro', verificarToken, registrarTerminalMobile);
router.post('/mobile/heartbeat', verificarToken, heartbeatTerminalMobile);
router.post(
  '/mobile/caixa-config',
  verificarToken,
  exigirPermissaoOuSenhaAdmin('abrir_caixa'),
  garantirCaixaProprioMobile
);
router.put('/auto/nome', exigirSuperAdminTerminal, atualizarNomeTerminalPdv);
router.post('/auto/nome', exigirSuperAdminTerminal, atualizarNomeTerminalPdv);

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { nome, hostname, caixa_id, ativo } = req.body;
  const identidadeMobileSolicitada = req.headers['x-mobile-installation-id'];

  db.get(`SELECT * FROM terminais WHERE id = ?`, [id], (err, terminal) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!terminal) return res.status(404).json({ error: 'Terminal não encontrado.' });

    const updatedNome = nome !== undefined ? String(nome).trim() : terminal.nome;
    if (!updatedNome) {
      return res.status(400).json({ error: 'Nome do terminal é obrigatório.' });
    }

    const updatedHostname = hostname !== undefined ? String(hostname).trim() : terminal.hostname;
    const updatedCaixaId = caixa_id === undefined
      ? terminal.caixa_id
      : caixa_id === '' || caixa_id === null
        ? null
        : Number(caixa_id);
    const updatedAtivo = ativo !== undefined ? (ativo ? 1 : 0) : terminal.ativo;
    const terminalEhMobile = String(terminal.hostname || '').toLowerCase()
      .startsWith(MobileTerminalService.MOBILE_HOST_PREFIX);
    const hostnameMobileSolicitado = updatedHostname.toLowerCase()
      .startsWith(MobileTerminalService.MOBILE_HOST_PREFIX);

    if (identidadeMobileSolicitada && !terminalEhMobile) {
      return res.status(403).json({
        error: 'Uma instalação Mobile não pode alterar o cadastro de outro terminal.',
        code: 'TERMINAL_MOBILE_OPERACAO_NAO_PERMITIDA'
      });
    }
    if (hostnameMobileSolicitado && !terminalEhMobile) {
      return res.status(400).json({ error: 'Identidade Mobile reservada para o registro autenticado.' });
    }
    if (terminalEhMobile && (
      updatedHostname !== terminal.hostname
      || Number(updatedCaixaId) !== Number(terminal.caixa_id)
      || updatedAtivo !== terminal.ativo
    )) {
      return res.status(403).json({
        error: 'O cadastro e o caixa do terminal Mobile só podem ser alterados pelo fluxo Mobile autenticado.',
        code: 'TERMINAL_MOBILE_GERENCIADO_PELO_FLUXO_PROPRIO'
      });
    }
    const agora = new Date().toISOString();

    const aplicarAtualizacao = () => {
      db.run(
        `UPDATE terminais SET nome = ?, hostname = ?, caixa_id = ?, ativo = ?, updated_at = ? WHERE id = ?`,
        [updatedNome, updatedHostname, updatedCaixaId, updatedAtivo, agora, id],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: updateErr.message });
          db.get(`
            SELECT t.*, c.nome AS caixa_nome
            FROM terminais t
            LEFT JOIN caixas c ON c.id = t.caixa_id
            WHERE t.id = ?
          `, [id], (getErr, row) => {
            if (getErr) return res.status(500).json({ error: getErr.message });

            gravarAuditoria({
              usuario_id: req.user?.id || null,
              usuario_nome: req.user?.nome || req.user?.username || null,
              modulo: 'terminais',
              acao: 'atualizar_terminal',
              referencia_tipo: 'terminal',
              referencia_id: id,
              detalhes: { antes: terminal, depois: { nome: updatedNome, hostname: updatedHostname, caixa_id: updatedCaixaId, ativo: updatedAtivo } },
              ip_requisicao: req.ip || null
            }).catch((auditErr) => console.error('Erro ao gravar auditoria de atualização de terminal:', auditErr));

            res.json(row);
          });
        }
      );
    };

    if (updatedCaixaId) {
      db.get(`SELECT id FROM caixas WHERE id = ?`, [updatedCaixaId], (errCaixa, caixa) => {
        if (errCaixa) return res.status(500).json({ error: errCaixa.message });
        if (!caixa) return res.status(400).json({ error: 'Caixa não encontrado.' });

        db.get(
          `SELECT id, hostname FROM terminais WHERE caixa_id = ? AND id != ? LIMIT 1`,
          [updatedCaixaId, id],
          (errVinculo, vinculo) => {
            if (errVinculo) return res.status(500).json({ error: errVinculo.message });
            const vinculoEhMobile = vinculo && String(vinculo.hostname || '').toLowerCase()
              .startsWith(MobileTerminalService.MOBILE_HOST_PREFIX);
            if ((terminalEhMobile || vinculoEhMobile) && vinculo) {
              return res.status(409).json({
                error: 'O caixa já está vinculado a outro terminal; nenhum vínculo foi alterado.',
                code: 'CAIXA_VINCULADO_A_OUTRO_TERMINAL'
              });
            }
            if (vinculo) {
              db.run(
                `UPDATE terminais SET caixa_id = NULL WHERE caixa_id = ? AND id != ?`,
                [updatedCaixaId, id],
                (errDetach) => {
                  if (errDetach) return res.status(500).json({ error: errDetach.message });
                  aplicarAtualizacao();
                }
              );
              return;
            }
            aplicarAtualizacao();
          }
        );
      });
      return;
    }

    aplicarAtualizacao();
  });
});

module.exports = router;
module.exports.registrarTerminalAuto = registrarTerminalAuto;
module.exports.registrarTerminalOffline = registrarTerminalOffline;
module.exports.registrarTerminalMobile = registrarTerminalMobile;
module.exports.heartbeatTerminalMobile = heartbeatTerminalMobile;
module.exports.garantirCaixaProprioMobile = garantirCaixaProprioMobile;
module.exports.atualizarNomeTerminalPdv = atualizarNomeTerminalPdv;
module.exports.exigirSuperAdminTerminal = exigirSuperAdminTerminal;
module.exports.terminalEstaOnline = terminalEstaOnline;
module.exports.HEARTBEAT_ONLINE_MS = HEARTBEAT_ONLINE_MS;
