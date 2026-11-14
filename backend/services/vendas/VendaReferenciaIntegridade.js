'use strict';

function idPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function consultar(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function idDeclaradoDoUsuario(usuario) {
  if (!usuario || typeof usuario !== 'object') return null;
  if (usuario.usuario_id != null && usuario.usuario_id !== '') return idPositivo(usuario.usuario_id);
  return idPositivo(usuario.id);
}

function listar(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function colunasUsuarios(db) {
  const colunas = await listar(db, 'PRAGMA table_info(usuarios)');
  return new Set(colunas.map((coluna) => coluna.name));
}

function usuarioUtilizavel(row, colunas) {
  if (!row) return null;
  if (colunas.has('ativo') && Number(row.ativo) === 0) return null;
  return row;
}
function referenciaInvalida(codigo, mensagem, referencia) {
  const err = new Error(mensagem);
  err.codigo = codigo;
  err.statusCode = 400;
  err.referencia = referencia;
  return err;
}

function operadorEhAdministrador(usuario) {
  const role = String(usuario && usuario.role || '').trim().toLowerCase();
  const perfil = String(usuario && usuario.perfil || '').trim().toUpperCase();
  return role === 'admin' || perfil === 'ADMIN' || perfil === 'SUPER_ADMIN';
}

async function tabelaExiste(db, nome) {
  const row = await consultar(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [nome]
  );
  return !!row;
}

/**
 * vendas.operador_id só recebe usuarios.id do usuário autenticado.
 * Um número vindo da sessão ou de outro cadastro não substitui essa linha.
 */
async function resolverOperadorUsuario(db, entrada = {}) {
  const usuario = entrada.usuario && typeof entrada.usuario === 'object' ? entrada.usuario : null;
  const username = usuario ? String(usuario.username || '').trim() : '';
  const declarado = idDeclaradoDoUsuario(usuario) || idPositivo(entrada.operadorId);

  const colunas = await colunasUsuarios(db);
  let operador = null;
  if (username && colunas.has('username')) {
    operador = usuarioUtilizavel(
      await consultar(db, 'SELECT * FROM usuarios WHERE username = ?', [username]),
      colunas
    );
    if (!operador) {
      throw referenciaInvalida(
        'OPERADOR_INEXISTENTE',
        `O usuário autenticado "${username}" não existe em usuarios. A venda não foi gravada.`,
        { tabela: 'usuarios', coluna: 'operador_id', username }
      );
    }
  } else if (declarado) {
    operador = usuarioUtilizavel(
      await consultar(db, 'SELECT * FROM usuarios WHERE id = ?', [declarado]),
      colunas
    );
    if (!operador) {
      throw referenciaInvalida(
        'OPERADOR_INEXISTENTE',
        `Operador ${declarado} não existe em usuarios. A venda não foi gravada.`,
        { tabela: 'usuarios', coluna: 'operador_id', id: declarado }
      );
    }
  } else {
    throw referenciaInvalida(
      'SESSAO_SEM_USUARIO',
      'Não há usuário autenticado para gravar a venda. vendas.operador_id exige usuarios(id).',
      { tabela: 'usuarios', coluna: 'operador_id' }
    );
  }

  const empresaId = idPositivo(entrada.empresaId);
  if (empresaId && !operadorEhAdministrador(operador) && await tabelaExiste(db, 'usuario_empresas')) {
    const restricao = await consultar(
      db,
      `SELECT COUNT(*) AS n
       FROM usuario_empresas
       WHERE empresa_id = ? AND COALESCE(ativo, 0) = 1`,
      [empresaId]
    );
    if (restricao && Number(restricao.n) > 0) {
      const vinculo = await consultar(
        db,
        `SELECT id
         FROM usuario_empresas
         WHERE usuario_id = ? AND empresa_id = ? AND COALESCE(ativo, 0) = 1`,
        [operador.id, empresaId]
      );
      if (!vinculo) {
        throw referenciaInvalida(
          'OPERADOR_OUTRA_EMPRESA',
          `O usuário ${operador.id} não tem vínculo ativo com a empresa ${empresaId}.`,
          { tabela: 'usuario_empresas', coluna: 'operador_id', id: operador.id, empresa_id: empresaId }
        );
      }
    }
  }

  return Number(operador.id);
}

/**
 * Confere as FKs de vendas antes do INSERT.
 * vendas.caixa_id aponta para caixa(id), o turno.
 * caixa_sessoes.caixa_id aponta para caixas(id), o cadastro.
 * O cadastro não substitui o turno, mesmo quando os números coincidem.
 */
async function validarReferenciasPersistenciaVenda(db, entrada = {}) {
  const caixaInformado = idPositivo(entrada.caixaId);
  const sessaoId = idPositivo(entrada.caixaSessaoId);
  const terminalInformado = idPositivo(entrada.terminalId);
  const operadorInformado = idPositivo(entrada.operadorId);
  const empresaId = idPositivo(entrada.empresaId);
  const clienteId = idPositivo(entrada.clienteId);

  if (empresaId) {
    const empresa = await consultar(db, 'SELECT id FROM empresas WHERE id = ?', [empresaId]);
    if (!empresa) {
      throw referenciaInvalida(
        'EMPRESA_INEXISTENTE',
        `Empresa ${empresaId} não existe. vendas.empresa_id referencia empresas(id).`,
        { tabela: 'empresas', coluna: 'empresa_id', id: empresaId }
      );
    }
  }

  let sessao = null;
  if (sessaoId) {
    sessao = await consultar(
      db,
      `SELECT id, caixa_id, caixa_turno_id, terminal_id, operador_id, empresa_id
       FROM caixa_sessoes WHERE id = ?`,
      [sessaoId]
    );
    if (!sessao) {
      throw referenciaInvalida(
        'SESSAO_INEXISTENTE',
        `Sessão de caixa ${sessaoId} não existe. vendas.caixa_sessao_id referencia caixa_sessoes(id).`,
        { tabela: 'caixa_sessoes', coluna: 'caixa_sessao_id', id: sessaoId }
      );
    }
    if (empresaId && idPositivo(sessao.empresa_id) && idPositivo(sessao.empresa_id) !== empresaId) {
      throw referenciaInvalida(
        'SESSAO_OUTRA_EMPRESA',
        `A sessão ${sessaoId} pertence à empresa ${sessao.empresa_id}, diferente da empresa ${empresaId} da venda.`,
        { tabela: 'caixa_sessoes', coluna: 'empresa_id', id: sessao.empresa_id, esperado: empresaId }
      );
    }
  }

  const turnoDaSessao = sessao ? idPositivo(sessao.caixa_turno_id) : null;
  if (sessao && !turnoDaSessao) {
    throw referenciaInvalida(
      'SESSAO_SEM_TURNO',
      `A sessão ${sessaoId} não tem turno em caixa_turno_id. ` +
        `O cadastro caixas (${sessao.caixa_id == null ? 'vazio' : sessao.caixa_id}) não pode ser gravado em vendas.caixa_id.`,
      {
        tabela: 'caixa',
        coluna: 'caixa_id',
        caixa_sessao_id: sessaoId,
        caixa_cadastro_id: sessao.caixa_id == null ? null : Number(sessao.caixa_id)
      }
    );
  }

  if (caixaInformado && turnoDaSessao && caixaInformado !== turnoDaSessao) {
    throw referenciaInvalida(
      'SESSAO_OUTRO_CAIXA',
      `A sessão ${sessaoId} pertence ao turno ${turnoDaSessao}, não ao caixa ${caixaInformado}.`,
      {
        tabela: 'caixa',
        coluna: 'caixa_id',
        caixa_sessao_id: sessaoId,
        caixa_turno_id: turnoDaSessao,
        caixa_id_informado: caixaInformado
      }
    );
  }

  const caixaId = turnoDaSessao || caixaInformado;
  if (caixaId) {
    const caixa = await consultar(db, 'SELECT id FROM caixa WHERE id = ?', [caixaId]);
    if (!caixa) {
      throw referenciaInvalida(
        'CAIXA_INEXISTENTE',
        `Caixa ${caixaId} não existe em caixa(id). vendas.caixa_id referencia o turno, não o cadastro caixas.`,
        { tabela: 'caixa', coluna: 'caixa_id', id: caixaId }
      );
    }
  }

  let terminalId = terminalInformado;
  if (sessao && idPositivo(sessao.terminal_id)) {
    const terminalDaSessao = idPositivo(sessao.terminal_id);
    if (terminalId && terminalId !== terminalDaSessao) {
      throw referenciaInvalida(
        'TERMINAL_INCOMPATIVEL',
        `O terminal ${terminalId} não é o terminal ${terminalDaSessao} da sessão ${sessaoId}.`,
        {
          tabela: 'terminais',
          coluna: 'terminal_id',
          id: terminalId,
          terminal_da_sessao: terminalDaSessao
        }
      );
    }
    terminalId = terminalDaSessao;
  }
  if (terminalId) {
    const terminal = await consultar(db, 'SELECT id FROM terminais WHERE id = ?', [terminalId]);
    if (!terminal) {
      throw referenciaInvalida(
        'TERMINAL_INEXISTENTE',
        `Terminal ${terminalId} não existe. vendas.terminal_id referencia terminais(id).`,
        { tabela: 'terminais', coluna: 'terminal_id', id: terminalId }
      );
    }
  }

  const operadorId = await resolverOperadorUsuario(db, {
    usuario: entrada.usuario,
    operadorId: operadorInformado,
    empresaId
  });

  if (clienteId) {
    const cliente = await consultar(db, 'SELECT id FROM clientes WHERE id = ?', [clienteId]);
    if (!cliente) {
      throw referenciaInvalida(
        'CLIENTE_INEXISTENTE',
        `Cliente ${clienteId} não existe. vendas.cliente_id referencia clientes(id).`,
        { tabela: 'clientes', coluna: 'cliente_id', id: clienteId }
      );
    }
  }

  return {
    caixaId,
    caixaSessaoId: sessaoId,
    terminalId,
    operadorId,
    empresaId,
    clienteId
  };
}

module.exports = {
  validarReferenciasPersistenciaVenda,
  resolverOperadorUsuario,
  idDeclaradoDoUsuario,
  referenciaInvalida
};
