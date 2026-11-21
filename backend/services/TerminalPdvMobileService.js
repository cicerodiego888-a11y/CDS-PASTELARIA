'use strict';

const {
  resolverEmpresaIdParaCaixa
} = require('./caixa/CaixaEmpresaContextoService');
const UsuarioEmpresaService = require('./empresas/UsuarioEmpresaService');

const MOBILE_HOST_PREFIX = 'cds-mobile-v1:';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const transacoesPendentes = new WeakMap();

function erro(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function normalizarInstallationId(value) {
  const id = String(value || '').trim().toLowerCase();
  return UUID_V4_RE.test(id) ? id : null;
}

function idUsuario(req) {
  const id = Number(req.user && (req.user.id || req.user.usuario_id));
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function resolverContextoAutorizado(req, db) {
  const usuarioId = idUsuario(req);
  if (!usuarioId) throw erro('SESSAO_INVALIDA', 'Sessão autenticada inválida.', 401);

  const usuario = await dbGet(db, 'SELECT id, ativo FROM usuarios WHERE id = ?', [usuarioId]);
  if (!usuario || Number(usuario.ativo) !== 1) {
    throw erro('SESSAO_INVALIDA', 'Usuário da sessão inexistente ou inativo.', 401);
  }

  const resolvido = await resolverEmpresaIdParaCaixa(req, { db });
  await UsuarioEmpresaService.exigirEmpresaAutorizada(
    req.user,
    resolvido.empresaId,
    { db }
  );
  return { usuarioId, empresaId: resolvido.empresaId };
}

function exigirCaixaMultiTerminalAtivo() {
  const recursos = require('../services/configuracaoService').getRecursos();
  if (!recursos || !recursos.recursos || recursos.recursos.multiCaixa !== true) {
    throw erro(
      'MULTICAIXA_NAO_HABILITADO',
      'O PDV Mobile exige o recurso de múltiplos caixas habilitado.',
      409
    );
  }
}

async function obterTerminalMobile(db, installationId, terminalId, usuarioId) {
  const hostname = MOBILE_HOST_PREFIX + installationId;
  const terminal = await dbGet(
    db,
    `SELECT id, nome, hostname, caixa_id, ativo, usuario_id, ultima_conexao
     FROM terminais
     WHERE hostname = ? AND id = ?`,
    [hostname, terminalId]
  );
  if (!terminal) {
    throw erro('TERMINAL_MOBILE_NAO_ENCONTRADO', 'Terminal Mobile não encontrado.', 404);
  }
  if (Number(terminal.usuario_id) !== Number(usuarioId)) {
    throw erro(
      'TERMINAL_MOBILE_NAO_AUTORIZADO',
      'Este terminal Mobile pertence a outro usuário.',
      403
    );
  }
  if (Number(terminal.ativo) !== 1) {
    throw erro('TERMINAL_MOBILE_INATIVO', 'Terminal Mobile inativo.', 403);
  }
  return terminal;
}

async function atualizarHeartbeat(db, terminalId) {
  const agora = new Date().toISOString();
  const result = await dbRun(
    db,
    `UPDATE terminais SET ultima_conexao = ?, updated_at = ? WHERE id = ?`,
    [agora, agora, terminalId]
  );
  if (result.changes !== 1) {
    throw erro('TERMINAL_MOBILE_NAO_ENCONTRADO', 'Terminal Mobile não encontrado.', 404);
  }
  return agora;
}

async function registrar({ req, db, installationId: rawInstallationId }) {
  exigirCaixaMultiTerminalAtivo();
  const installationId = normalizarInstallationId(rawInstallationId);
  if (!installationId) {
    throw erro('IDENTIDADE_MOBILE_INVALIDA', 'Identidade da instalação Mobile inválida.');
  }

  const { usuarioId, empresaId } = await resolverContextoAutorizado(req, db);
  const hostname = MOBILE_HOST_PREFIX + installationId;
  const existente = await dbGet(
    db,
    `SELECT id, nome, hostname, caixa_id, ativo, usuario_id, ultima_conexao
     FROM terminais WHERE hostname = ?`,
    [hostname]
  );

  if (existente) {
    if (Number(existente.usuario_id) !== usuarioId) {
      throw erro(
        'TERMINAL_MOBILE_NAO_AUTORIZADO',
        'Esta instalação Mobile já está vinculada a outro usuário.',
        403
      );
    }
    if (Number(existente.ativo) !== 1) {
      throw erro('TERMINAL_MOBILE_INATIVO', 'Terminal Mobile inativo.', 403);
    }
    const ultimaConexao = await atualizarHeartbeat(db, existente.id);
    return {
      criado: false,
      empresa_id: empresaId,
      terminal: { ...existente, ultima_conexao: ultimaConexao, online: true }
    };
  }

  const agora = new Date().toISOString();
  const nome = `PDV Mobile ${installationId.slice(0, 8)}`;
  let insercao;
  try {
    insercao = await dbRun(
      db,
      `INSERT INTO terminais
        (nome, hostname, usuario_id, usuario_nome, ativo, ultima_conexao, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        nome,
        hostname,
        usuarioId,
        String(req.user.nome || req.user.username || '').trim() || null,
        agora,
        agora,
        agora
      ]
    );
  } catch (insertError) {
    if (!/UNIQUE|constraint/i.test(String(insertError.message || ''))) throw insertError;
    const concorrente = await dbGet(
      db,
      `SELECT id, nome, hostname, caixa_id, ativo, usuario_id, ultima_conexao
       FROM terminais WHERE hostname = ?`,
      [hostname]
    );
    if (!concorrente || Number(concorrente.usuario_id) !== usuarioId) {
      throw erro(
        'TERMINAL_MOBILE_NAO_AUTORIZADO',
        'Esta identidade Mobile já está registrada para outro usuário.',
        403
      );
    }
    const ultimaConexao = await atualizarHeartbeat(db, concorrente.id);
    return {
      criado: false,
      empresa_id: empresaId,
      terminal: { ...concorrente, ultima_conexao: ultimaConexao, online: true }
    };
  }

  const terminal = await dbGet(
    db,
    `SELECT id, nome, hostname, caixa_id, ativo, usuario_id, ultima_conexao
     FROM terminais WHERE id = ?`,
    [insercao.lastID]
  );
  return {
    criado: true,
    empresa_id: empresaId,
    terminal: { ...terminal, online: true }
  };
}

async function heartbeat({ req, db, installationId: rawInstallationId, terminalId: rawTerminalId }) {
  exigirCaixaMultiTerminalAtivo();
  const installationId = normalizarInstallationId(rawInstallationId);
  const terminalId = Number(rawTerminalId);
  if (!installationId || !Number.isInteger(terminalId) || terminalId <= 0) {
    throw erro('IDENTIDADE_MOBILE_INVALIDA', 'Identidade ou identificador do terminal inválido.');
  }

  const { usuarioId, empresaId } = await resolverContextoAutorizado(req, db);
  const terminal = await obterTerminalMobile(db, installationId, terminalId, usuarioId);
  const ultimaConexao = await atualizarHeartbeat(db, terminal.id);
  return {
    empresa_id: empresaId,
    terminal_id: terminal.id,
    ultima_conexao: ultimaConexao,
    online: true
  };
}

function transacao(db, trabalho) {
  const anterior = transacoesPendentes.get(db) || Promise.resolve();
  const atual = anterior
    .catch(() => undefined)
    .then(() => executarTransacao(db, trabalho));
  transacoesPendentes.set(db, atual);
  return atual;
}

function executarTransacao(db, trabalho) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (beginErr) => {
        if (beginErr) return reject(beginErr);
        Promise.resolve()
          .then(trabalho)
          .then((resultado) => {
            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                db.run('ROLLBACK');
                return reject(commitErr);
              }
              resolve(resultado);
            });
          })
          .catch((err) => {
            db.run('ROLLBACK', () => reject(err));
          });
      });
    });
  });
}

async function garantirCaixaProprio({
  req,
  db,
  installationId: rawInstallationId,
  terminalId: rawTerminalId
}) {
  exigirCaixaMultiTerminalAtivo();
  const installationId = normalizarInstallationId(rawInstallationId);
  const terminalId = Number(rawTerminalId);
  if (!installationId || !Number.isInteger(terminalId) || terminalId <= 0) {
    throw erro('IDENTIDADE_MOBILE_INVALIDA', 'Identidade ou identificador do terminal inválido.');
  }

  const { usuarioId, empresaId } = await resolverContextoAutorizado(req, db);
  await obterTerminalMobile(db, installationId, terminalId, usuarioId);

  return transacao(db, async () => {
    const terminal = await obterTerminalMobile(db, installationId, terminalId, usuarioId);
    if (terminal.caixa_id != null) {
      const vinculo = await dbGet(
        db,
        'SELECT id FROM terminais WHERE caixa_id = ? AND id != ? LIMIT 1',
        [terminal.caixa_id, terminal.id]
      );
      if (vinculo) {
        throw erro(
          'CAIXA_VINCULADO_A_OUTRO_TERMINAL',
          'O caixa associado já pertence a outro terminal; nenhum vínculo foi alterado.',
          409
        );
      }
      const caixaAtual = await dbGet(
        db,
        'SELECT id, nome, ativo FROM caixas WHERE id = ?',
        [terminal.caixa_id]
      );
      if (!caixaAtual || Number(caixaAtual.ativo) !== 1) {
        throw erro('CAIXA_MOBILE_INDISPONIVEL', 'O caixa próprio do Mobile está ausente ou inativo.', 409);
      }
      return { criado: false, empresa_id: empresaId, caixa: caixaAtual };
    }

    const nome = `PDV Mobile ${terminal.id}`;
    const insercao = await dbRun(
      db,
      `INSERT INTO caixas (nome, descricao, ativo) VALUES (?, ?, 1)`,
      [nome, `Caixa exclusivo do terminal Mobile ${terminal.id}`]
    );
    const atribuicao = await dbRun(
      db,
      `UPDATE terminais SET caixa_id = ?, updated_at = ?
       WHERE id = ? AND hostname = ? AND usuario_id = ? AND ativo = 1 AND caixa_id IS NULL`,
      [
        insercao.lastID,
        new Date().toISOString(),
        terminal.id,
        MOBILE_HOST_PREFIX + installationId,
        usuarioId
      ]
    );
    if (atribuicao.changes !== 1) {
      throw erro(
        'CAIXA_MOBILE_CONCORRENTE',
        'O terminal mudou durante a configuração do caixa. Atualize o estado e tente novamente.',
        409
      );
    }
    return {
      criado: true,
      empresa_id: empresaId,
      caixa: { id: insercao.lastID, nome, ativo: 1 }
    };
  });
}

module.exports = {
  MOBILE_HOST_PREFIX,
  normalizarInstallationId,
  resolverContextoAutorizado,
  obterTerminalMobile,
  registrar,
  heartbeat,
  garantirCaixaProprio
};
