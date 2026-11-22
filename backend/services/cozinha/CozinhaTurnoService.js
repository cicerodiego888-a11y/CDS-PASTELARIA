'use strict';

const crypto = require('crypto');
const UsuarioEmpresaService = require('../empresas/UsuarioEmpresaService');
const CozinhaSessaoUnidade = require('./CozinhaSessaoUnidadeService');
const { perfilPodeAcessarGestao } = require('./permissaoGerencial');

const filasTransacao = new WeakMap();

function erro(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

function conn(opts) { return (opts && opts.db) || require('../../database'); }
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function cb(err) {
    if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
  }));
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null)));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}

async function beginImmediate(db) { await run(db, 'BEGIN IMMEDIATE'); }
async function commit(db) { await run(db, 'COMMIT'); }
async function rollback(db) { try { await run(db, 'ROLLBACK'); } catch (_e) {} }
function serializar(db, trabalho) {
  const anterior = filasTransacao.get(db) || Promise.resolve();
  const atual = anterior.then(trabalho, trabalho);
  filasTransacao.set(db, atual.then(() => undefined, () => undefined));
  return atual;
}
function inteiroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}
async function tabelaExiste(db, nome) {
  const row = await get(db,
    "SELECT 1 AS existe FROM sqlite_master WHERE type='table' AND name=?",
    [nome]);
  return !!row;
}
async function timestampUtc(db) {
  const row = await get(db, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS agora");
  if (!row?.agora) throw erro('Não foi possível obter o horário UTC.', 500, 'HORARIO_UTC_INDISPONIVEL');
  return row.agora;
}
function perfilEhGerenteOuSuperior(user) {
  const role = String(user?.role || '').trim().toLowerCase();
  const perfil = String(user?.perfil || '').trim().toUpperCase();
  return role === 'admin' || role === 'gerente'
    || ['SUPER_ADMIN', 'ADMIN', 'GERENTE'].includes(perfil);
}

async function validarUsuarioBackend(db, usuarioId) {
  const row = await get(db, `
    SELECT id, username, nome, role, COALESCE(perfil, 'USUARIO') AS perfil, ativo
    FROM usuarios WHERE id = ?
  `, [usuarioId]);
  if (!row || Number(row.ativo) !== 1) {
    throw erro('Operador sem autorização efetiva.', 403, 'OPERADOR_SEM_AUTORIZACAO');
  }
  return row;
}

async function exigirAcessoGerencial({ operadorId, unidadeId }, opts = {}) {
  const operador = inteiroPositivo(operadorId);
  const unidade = inteiroPositivo(unidadeId);
  if (!operador || !unidade) throw erro('Sessão gerencial inválida.', 401, 'SESSAO_INVALIDA');
  const db = conn(opts);
  const usuario = await validarUsuarioBackend(db, operador);
  if (!perfilPodeAcessarGestao(usuario)) {
    throw erro('A Gestão da Cozinha é exclusiva de Gerentes e Super Administradores.', 403, 'GESTAO_COZINHA_SEM_AUTORIZACAO');
  }
  const unidadeDb = await get(db, `
    SELECT id, empresa_id, ativo, codigo
    FROM cozinha_unidades
    WHERE id=?
  `, [unidade]);
  if (!unidadeDb || Number(unidadeDb.ativo) !== 1) {
    throw erro('Unidade operacional inválida ou inativa.', 403, 'UNIDADE_SEM_AUTORIZACAO');
  }
  const empresa = Number(unidadeDb.empresa_id);
  const podeEmpresa = await UsuarioEmpresaService.usuarioPodeAcessarEmpresa(
    operador,
    empresa,
    { db, user: usuario }
  );
  if (!podeEmpresa) throw erro('Operador sem autorização para a empresa.', 403, 'EMPRESA_SEM_AUTORIZACAO');
  if (String(usuario.perfil || '').trim().toUpperCase() !== 'SUPER_ADMIN') {
    if (!await tabelaExiste(db, 'cozinha_operador_unidades')) {
      throw erro('Operador sem autorização para esta unidade.', 403, 'UNIDADE_SEM_AUTORIZACAO');
    }
    const vinculo = await get(db, `
      SELECT 1 AS autorizado
      FROM cozinha_operador_unidades
      WHERE empresa_id=? AND operador_id=? AND unidade_id=? AND ativo=1
      LIMIT 1
    `, [empresa, operador, unidade]);
    if (!vinculo) {
      throw erro('Operador sem autorização para esta unidade.', 403, 'UNIDADE_SEM_AUTORIZACAO');
    }
  }
  return {
    empresaId: empresa,
    unidadeId: unidade,
    operadorId: operador,
    operadorNome: usuario.nome || usuario.username || String(operador),
    unidadeCodigo: unidadeDb.codigo
  };
}

async function validarUnidade(db, empresaId, unidadeId) {
  const unidade = await get(db, `
    SELECT id, empresa_id, codigo, ativo
    FROM cozinha_unidades WHERE id = ? AND empresa_id = ?
  `, [unidadeId, empresaId]);
  if (!unidade) throw erro('Unidade fora do contexto da empresa.', 404, 'UNIDADE_EMPRESA_ISOLAMENTO');
  if (Number(unidade.ativo) !== 1) throw erro('Unidade inativa.', 409, 'UNIDADE_INATIVA');
  return unidade;
}

async function validarAcessoConfiguracao(db, empresaId, unidadeId, operadorId) {
  const usuario = await validarUsuarioBackend(db, operadorId);
  const podeEmpresa = await UsuarioEmpresaService.usuarioPodeAcessarEmpresa(
    operadorId,
    empresaId,
    { db, user: usuario }
  );
  if (!podeEmpresa) throw erro('Operador sem autorização para a empresa.', 403, 'EMPRESA_SEM_AUTORIZACAO');
  const acesso = await CozinhaSessaoUnidade.listarUnidadesDisponiveis(
    { user: usuario, empresaId },
    { db }
  );
  if (!acesso.unidades.some(unidade => unidade.id === unidadeId)) {
    throw erro('Operador sem autorização para esta unidade.', 403, 'UNIDADE_SEM_AUTORIZACAO');
  }
}

async function obterTurnoAberto(db, empresaId, unidadeId) {
  return get(db, `
    SELECT * FROM cozinha_turnos
    WHERE empresa_id = ? AND unidade_id = ? AND estado = 'ABERTA'
    LIMIT 1
  `, [empresaId, unidadeId]);
}

async function exigirTurnoAberto({ empresaId, unidadeId }, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  if (!emp || !uni) throw erro('Empresa e unidade são obrigatórias.', 400, 'TURNO_CONTEXTO_INVALIDO');
  const db = conn(opts);
  const turno = await obterTurnoAberto(db, emp, uni);
  if (!turno) throw erro('A cozinha desta unidade está fechada.', 409, 'COZINHA_FECHADA');
  return turno;
}

async function abrirTurno({ empresaId, unidadeId, operadorId }, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  const operador = inteiroPositivo(operadorId);
  if (!emp || !uni || !operador) throw erro('Contexto ou operador inválido.', 400, 'TURNO_CONTEXTO_INVALIDO');
  const db = conn(opts);
  return serializar(db, async () => {
    await beginImmediate(db);
    try {
      await validarUnidade(db, emp, uni);
      const contextoGerencial = await exigirAcessoGerencial(
        { operadorId: operador, unidadeId: uni },
        { db }
      );
      if (contextoGerencial.empresaId !== emp) {
        throw erro('Unidade fora do contexto da empresa.', 403, 'UNIDADE_EMPRESA_ISOLAMENTO');
      }
      const existente = await obterTurnoAberto(db, emp, uni);
      if (existente) {
        throw erro('Já existe um turno aberto nesta unidade.', 409, 'TURNO_JA_ABERTO', {
          turno_id: Number(existente.id)
        });
      }
      const aberturaEm = await timestampUtc(db);
      const configuracoes = await all(db, `
        SELECT chave, valor, tipo, versao
        FROM cozinha_configuracoes
        WHERE empresa_id=? AND unidade_id=? AND ativo=1
        ORDER BY chave
      `, [emp, uni]);
      const metaPreparo = await get(db, `
        SELECT valor FROM cozinha_configuracoes
        WHERE empresa_id=? AND unidade_id=? AND chave='meta_preparo_minutos' AND ativo=1
      `, [emp, uni]);
      const metaEspera = await get(db, `
        SELECT valor FROM cozinha_configuracoes
        WHERE empresa_id=? AND unidade_id=? AND chave='meta_espera_minutos' AND ativo=1
      `, [emp, uni]);
      const r = await run(db, `
        INSERT INTO cozinha_turnos
          (empresa_id, unidade_id, estado, abertura_operador_id, abertura_em,
           meta_preparo_minutos_snapshot, meta_espera_minutos_snapshot,
           configuracoes_snapshot_json)
        VALUES (?, ?, 'ABERTA', ?, ?, ?, ?, ?)
      `, [emp, uni, operador, aberturaEm,
        metaPreparo?.valor != null ? Number(metaPreparo.valor) : null,
        metaEspera?.valor != null ? Number(metaEspera.valor) : null,
        JSON.stringify(configuracoes)]);
      await run(db, `
        INSERT INTO cozinha_turno_intervencoes
          (empresa_id, unidade_id, turno_id, tipo, operador_id, observacao, created_at)
        VALUES (?, ?, ?, 'ABERTURA', ?, 'Turno aberto', ?)
      `, [emp, uni, r.lastID, operador, aberturaEm]);
      await commit(db);
      return { success: true, turno: await get(db, 'SELECT * FROM cozinha_turnos WHERE id = ?', [r.lastID]) };
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function calcularPendencias(db, empresaId, unidadeId, turnoId) {
  const pendencias = [];
  const preparacao = await get(db, `
    SELECT COUNT(*) AS total
    FROM cozinha_rodadas r
    WHERE r.empresa_id = ? AND r.unidade_id = ? AND r.turno_id = ?
      AND r.estado_preparacao <> 'PRONTA'
      AND r.estado_preparacao <> 'CANCELADA'
  `, [empresaId, unidadeId, turnoId]);
  if (Number(preparacao?.total || 0) > 0) pendencias.push({ tipo: 'PREPARACAO', quantidade: Number(preparacao.total) });

  const bebidas = await get(db, `
    SELECT COUNT(*) AS total
    FROM cozinha_itens i
    JOIN cozinha_rodadas r ON r.id = i.rodada_id AND r.empresa_id = i.empresa_id
    WHERE i.empresa_id = ? AND i.unidade_id = ? AND i.turno_id = ?
      AND UPPER(i.tipo_item) = 'BEBIDA'
      AND NOT EXISTS (
        SELECT 1 FROM cozinha_bebida_entregas b
        WHERE b.empresa_id = i.empresa_id AND b.cozinha_item_id = i.id
          AND b.rodada_id = i.rodada_id
      )
  `, [empresaId, unidadeId, turnoId]);
  if (Number(bebidas?.total || 0) > 0) pendencias.push({ tipo: 'ENTREGA_BEBIDAS', quantidade: Number(bebidas.total) });

  const retirada = await get(db, `
    SELECT COUNT(*) AS total
    FROM cozinha_rodadas r
    WHERE r.empresa_id = ? AND r.unidade_id = ? AND r.turno_id = ?
      AND r.estado_preparacao = 'PRONTA'
      AND r.retirada_estado <> 'RETIRADA'
  `, [empresaId, unidadeId, turnoId]);
  if (Number(retirada?.total || 0) > 0) pendencias.push({ tipo: 'RETIRADA_INDIVIDUAL', quantidade: Number(retirada.total) });

  if (await tabelaExiste(db, 'cozinha_retirada_itens')) {
    const divergentes = await get(db, `
      SELECT COUNT(*) AS total
      FROM cozinha_retirada_itens e
      LEFT JOIN cozinha_itens i
        ON i.id=e.cozinha_item_id AND i.empresa_id=e.empresa_id
       AND i.unidade_id=e.unidade_id
      LEFT JOIN cozinha_rodadas r
        ON r.id=e.rodada_id AND r.empresa_id=e.empresa_id
       AND r.unidade_id=e.unidade_id
      WHERE e.empresa_id=? AND e.unidade_id=? 
        AND e.turno_id IS NOT NULL
        AND (e.turno_id <> COALESCE(i.turno_id,e.turno_id)
          OR e.turno_id <> COALESCE(r.turno_id,e.turno_id))
    `, [empresaId, unidadeId]);
    if (Number(divergentes?.total || 0) > 0) {
      pendencias.push({ tipo: 'LEDGER_INTEGRIDADE', quantidade: Number(divergentes.total) });
    }
  }
  if (await tabelaExiste(db, 'cozinha_cancelamento_itens')) {
    const divergentes = await get(db, `
      SELECT COUNT(*) AS total
      FROM cozinha_cancelamento_itens e
      LEFT JOIN cozinha_itens i
        ON i.id=e.cozinha_item_id AND i.empresa_id=e.empresa_id
       AND i.unidade_id=e.unidade_id
      LEFT JOIN cozinha_rodadas r
        ON r.id=e.rodada_id AND r.empresa_id=e.empresa_id
       AND r.unidade_id=e.unidade_id
      WHERE e.empresa_id=? AND e.unidade_id=?
        AND e.turno_id IS NOT NULL
        AND (e.turno_id <> COALESCE(i.turno_id,e.turno_id)
          OR e.turno_id <> COALESCE(r.turno_id,e.turno_id))
    `, [empresaId, unidadeId]);
    if (Number(divergentes?.total || 0) > 0) {
      pendencias.push({ tipo: 'LEDGER_CANCELAMENTO_INTEGRIDADE', quantidade: Number(divergentes.total) });
    }
  }

  return pendencias;
}

async function fecharTurno({
  empresaId, unidadeId, operadorId, tipo, justificativa
}, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  const operador = inteiroPositivo(operadorId);
  if (!emp || !uni || !operador) throw erro('Contexto ou operador inválido.', 400, 'TURNO_CONTEXTO_INVALIDO');
  const db = conn(opts);
  return serializar(db, async () => {
    await beginImmediate(db);
    try {
      await validarUnidade(db, emp, uni);
      const contextoGerencial = await exigirAcessoGerencial(
        { operadorId: operador, unidadeId: uni },
        { db }
      );
      if (contextoGerencial.empresaId !== emp) {
        throw erro('Unidade fora do contexto da empresa.', 403, 'UNIDADE_EMPRESA_ISOLAMENTO');
      }
      const turno = await obterTurnoAberto(db, emp, uni);
      if (!turno) throw erro('Não existe turno aberto nesta unidade.', 409, 'COZINHA_JA_FECHADA');
      const fechamentoTipo = String(tipo || 'NORMAL').trim().toUpperCase() === 'EXCEPCIONAL'
        ? 'EXCEPCIONAL' : 'NORMAL';
      if (fechamentoTipo === 'EXCEPCIONAL') {
        const texto = String(justificativa || '').trim();
        if (texto.length < 10) {
          throw erro('Justificativa obrigatória com pelo menos 10 caracteres.', 400, 'JUSTIFICATIVA_FECHAMENTO_OBRIGATORIA');
        }
      }
      const pendencias = await calcularPendencias(db, emp, uni, Number(turno.id));
      if (fechamentoTipo === 'NORMAL' && pendencias.length) {
        throw erro('Fechamento normal bloqueado por pendências operacionais.', 409, 'FECHAMENTO_NORMAL_BLOQUEADO', { pendencias });
      }
      const fechamentoEm = await timestampUtc(db);
      const fechamento = await run(db, `
        UPDATE cozinha_turnos
        SET estado = 'FECHADA',
            fechamento_operador_id = ?,
            fechamento_em = ?,
            fechamento_tipo = ?,
            fechamento_justificativa = ?,
            updated_at = ?
        WHERE id = ? AND estado = 'ABERTA'
      `, [operador, fechamentoEm, fechamentoTipo,
        fechamentoTipo === 'EXCEPCIONAL' ? String(justificativa).trim() : null,
        fechamentoEm, Number(turno.id)]);
      if (fechamento.changes !== 1) {
        throw erro('O turno mudou durante o fechamento.', 409, 'TURNO_FECHAMENTO_CONCORRENTE');
      }
      await run(db, `
        INSERT INTO cozinha_turno_intervencoes
          (empresa_id, unidade_id, turno_id, tipo, operador_id, observacao, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [emp, uni, Number(turno.id),
        fechamentoTipo === 'EXCEPCIONAL' ? 'FECHAMENTO_EXCEPCIONAL' : 'FECHAMENTO_NORMAL',
        operador,
        fechamentoTipo === 'EXCEPCIONAL'
          ? String(justificativa).trim()
          : JSON.stringify(pendencias),
        fechamentoEm]);
      const relatorio = await consolidarRelatorio({
        empresaId: emp,
        unidadeId: uni,
        turnoId: Number(turno.id)
      }, { db });
      const snapshotJson = JSON.stringify(relatorio);
      const snapshotHash = crypto.createHash('sha256').update(snapshotJson).digest('hex');
      const relatorioPersistido = await run(db, `
        INSERT INTO cozinha_turno_relatorios
          (empresa_id, unidade_id, turno_id, snapshot_json, snapshot_sha256, gerado_em)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [emp, uni, Number(turno.id), snapshotJson, snapshotHash, fechamentoEm]);
      await commit(db);
      return {
        success: true,
        turno_id: Number(turno.id),
        relatorio_id: relatorioPersistido.lastID,
        fechamento_tipo: fechamentoTipo,
        pendencias,
        pedidos_pendentes_nao_cancelados: fechamentoTipo === 'EXCEPCIONAL',
        criado_sem_retiradas_artificiais: fechamentoTipo === 'EXCEPCIONAL'
      };
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function statusTurno({ empresaId, unidadeId }, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  if (!emp || !uni) throw erro('Empresa e unidade são obrigatórias.', 400, 'TURNO_CONTEXTO_INVALIDO');
  const db = conn(opts);
  await validarUnidade(db, emp, uni);
  const turno = await obterTurnoAberto(db, emp, uni);
  let turnoComOperador = turno;
  if (turno) {
    turnoComOperador = await get(db, `
      SELECT t.*,
             COALESCE(u.nome,u.username,CAST(t.abertura_operador_id AS TEXT)) AS abertura_operador_nome,
             COALESCE(uf.nome,uf.username,CAST(t.fechamento_operador_id AS TEXT)) AS fechamento_operador_nome
      FROM cozinha_turnos t
      LEFT JOIN usuarios u ON u.id=t.abertura_operador_id
      LEFT JOIN usuarios uf ON uf.id=t.fechamento_operador_id
      WHERE t.id=? AND t.empresa_id=? AND t.unidade_id=?
    `, [turno.id, emp, uni]);
  }
  return {
    success: true,
    empresa_id: emp,
    unidade_id: uni,
    estado: turno ? 'ABERTA' : 'FECHADA',
    turno: turnoComOperador || null
  };
}

async function listarHistorico({ empresaId, unidadeId, limite }, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  if (!emp || !uni) throw erro('Empresa e unidade são obrigatórias.', 400, 'TURNO_CONTEXTO_INVALIDO');
  const db = conn(opts);
  await validarUnidade(db, emp, uni);
  const lim = Math.min(Math.max(Number(limite) || 20, 1), 200);
  const turnos = await all(db, `
    SELECT * FROM cozinha_turnos
    WHERE empresa_id = ? AND unidade_id = ?
    ORDER BY id DESC LIMIT ?
  `, [emp, uni, lim]);
  const intervencoes = await all(db, `
    SELECT * FROM cozinha_turno_intervencoes
    WHERE empresa_id = ? AND unidade_id = ?
    ORDER BY id DESC LIMIT ?
  `, [emp, uni, lim]);
  return { success: true, turnos, intervencoes };
}

async function vincularPedidoAoTurno(db, { empresaId, unidadeId, turnoId, pedidoId, pedidoItemId, cozinhaItemId, rodadaId }) {
  if (!inteiroPositivo(turnoId) || !inteiroPositivo(pedidoId)) return null;
  await run(db, `
    INSERT OR IGNORE INTO cozinha_turno_pedidos
      (empresa_id, unidade_id, turno_id, pedido_id, pedido_item_id, cozinha_item_id, rodada_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [empresaId, unidadeId, turnoId, pedidoId,
    pedidoItemId || null, cozinhaItemId || null, rodadaId || null]);
  return get(db, `
    SELECT * FROM cozinha_turno_pedidos
    WHERE empresa_id=? AND unidade_id=? AND turno_id=? AND pedido_id=? 
      AND COALESCE(pedido_item_id,0)=COALESCE(?,0)
  `, [empresaId, unidadeId, turnoId, pedidoId, pedidoItemId || null]);
}

async function vincularRodadaAoTurno(db, {
  empresaId, unidadeId, rodadaId
}) {
  const turno = await obterTurnoAberto(db, empresaId, unidadeId);
  if (!turno) throw erro('A cozinha desta unidade está fechada.', 409, 'COZINHA_FECHADA');
  await run(db, `
    UPDATE cozinha_rodadas SET turno_id = ?
    WHERE id=? AND empresa_id=? AND unidade_id=? AND turno_id IS NULL
  `, [turno.id, rodadaId, empresaId, unidadeId]);
  await run(db, `
    UPDATE cozinha_itens SET turno_id = ?
    WHERE rodada_id=? AND empresa_id=? AND unidade_id=? AND turno_id IS NULL
  `, [turno.id, rodadaId, empresaId, unidadeId]);
  await run(db, `
    UPDATE cozinha_retirada_itens SET turno_id = ?
    WHERE rodada_id=? AND empresa_id=? AND unidade_id=? AND turno_id IS NULL
  `, [turno.id, rodadaId, empresaId, unidadeId]);
  return turno;
}

async function resolverTurnoOperacional(db, {
  empresaId,
  unidadeId,
  rodadaId,
  cozinhaItemId
}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  if (!emp || !uni) throw erro('Empresa e unidade são obrigatórias.', 400, 'TURNO_CONTEXTO_INVALIDO');

  if (inteiroPositivo(rodadaId)) {
    const rodada = await get(db,
      'SELECT id, turno_id FROM cozinha_rodadas WHERE id=? AND empresa_id=? AND unidade_id=?',
      [rodadaId, emp, uni]);
    if (rodada?.turno_id) return get(db, 'SELECT * FROM cozinha_turnos WHERE id=? AND empresa_id=? AND unidade_id=?', [rodada.turno_id, emp, uni]);
  }
  if (inteiroPositivo(cozinhaItemId)) {
    const item = await get(db,
      'SELECT id, turno_id, rodada_id FROM cozinha_itens WHERE id=? AND empresa_id=? AND unidade_id=?',
      [cozinhaItemId, emp, uni]);
    if (item?.turno_id) return get(db, 'SELECT * FROM cozinha_turnos WHERE id=? AND empresa_id=? AND unidade_id=?', [item.turno_id, emp, uni]);
  }

  const turno = await obterTurnoAberto(db, emp, uni);
  if (!turno) throw erro('A cozinha desta unidade está fechada.', 409, 'COZINHA_FECHADA');
  if (inteiroPositivo(rodadaId)) {
    await run(db, `UPDATE cozinha_rodadas SET turno_id=? WHERE id=? AND empresa_id=? AND unidade_id=? AND turno_id IS NULL`,
      [turno.id, rodadaId, emp, uni]);
  }
  if (inteiroPositivo(cozinhaItemId)) {
    await run(db, `UPDATE cozinha_itens SET turno_id=? WHERE id=? AND empresa_id=? AND unidade_id=? AND turno_id IS NULL`,
      [turno.id, cozinhaItemId, emp, uni]);
  }
  return turno;
}

async function vincularEventoAoTurno(db, {
  empresaId,
  unidadeId,
  rodadaId,
  cozinhaItemId,
  tabela,
  eventoId
}) {
  const tabelasPermitidas = new Set([
    'cozinha_bebida_entregas',
    'cozinha_retirada_itens',
    'cozinha_cancelamento_itens'
  ]);
  if (!tabelasPermitidas.has(tabela) || !inteiroPositivo(eventoId)) return null;
  const turno = await resolverTurnoOperacional(db, {
    empresaId,
    unidadeId,
    rodadaId,
    cozinhaItemId
  });
  await run(db, `UPDATE "${tabela}" SET turno_id=?, unidade_id=? WHERE id=? AND empresa_id=? AND turno_id IS NULL`,
    [turno.id, unidadeId, eventoId, empresaId]);
  return turno;
}

async function obterConfiguracoes({ empresaId, unidadeId, operadorId }, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  if (!emp || !uni) throw erro('Empresa e unidade são obrigatórias.', 400, 'TURNO_CONTEXTO_INVALIDO');
  const db = conn(opts);
  await validarUnidade(db, emp, uni);
  if (!inteiroPositivo(operadorId)) throw erro('Sessão sem operador.', 401, 'SESSAO_INVALIDA');
  await validarAcessoConfiguracao(db, emp, uni, Number(operadorId));
  const rows = await all(db, `
    SELECT chave, valor, tipo, versao, updated_at
    FROM cozinha_configuracoes
    WHERE empresa_id=? AND unidade_id=? AND ativo=1
  `, [emp, uni]);
  const config = Object.fromEntries(rows.map(r => [r.chave, r.valor]));
  return { success: true, config, versoes: rows };
}

async function salvarConfiguracoes({ empresaId, unidadeId, operadorId, config }, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  const operador = inteiroPositivo(operadorId);
  if (!emp || !uni || !operador) throw erro('Contexto inválido.', 400, 'TURNO_CONTEXTO_INVALIDO');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw erro('Configuração inválida.', 400, 'COZINHA_CONFIG_INVALIDA');
  }
  const db = conn(opts);
  return serializar(db, async () => {
    await beginImmediate(db);
    try {
      await validarUnidade(db, emp, uni);
      const usuario = await validarUsuarioBackend(db, operador);
      if (!perfilEhGerenteOuSuperior(usuario)) {
        throw erro('Apenas administrador, gerente ou super administrador pode alterar a Cozinha.', 403, 'COZINHA_CONFIG_SEM_AUTORIZACAO');
      }
      await validarAcessoConfiguracao(db, emp, uni, operador);
      const permitidas = new Set([
        'meta_preparo_minutos',
        'meta_espera_minutos',
        'horario_abertura',
        'horario_fechamento'
      ]);
      const entradas = Object.entries(config).filter(([chave]) => permitidas.has(chave));
      if (!entradas.length) {
        throw erro('Informe ao menos uma configuração válida da cozinha.', 400, 'COZINHA_CONFIG_INVALIDA');
      }
      for (const [chave, valor] of entradas) {
        const normalizado = String(valor == null ? '' : valor).trim();
        const metaValida = ['meta_preparo_minutos', 'meta_espera_minutos'].includes(chave)
          && /^[1-9]\d*$/.test(normalizado);
        const horarioValido = ['horario_abertura', 'horario_fechamento'].includes(chave)
          && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalizado);
        if (!metaValida && !horarioValido) {
          throw erro(`Valor inválido para ${chave}.`, 400, 'COZINHA_CONFIG_INVALIDA');
        }
        const atual = await get(db, `
          SELECT COALESCE(MAX(versao),0) AS versao
          FROM cozinha_configuracoes
          WHERE empresa_id=? AND unidade_id=? AND chave=? 
        `, [emp, uni, chave]);
        const versao = Number(atual?.versao || 0) + 1;
        await run(db, `
          INSERT INTO cozinha_configuracoes
            (empresa_id, unidade_id, chave, valor, tipo, versao, ativo, criado_por, updated_by)
          VALUES (?, ?, ?, ?, 'TEXT', ?, 1, ?, ?)
          ON CONFLICT(empresa_id, unidade_id, chave) DO UPDATE SET
            valor=excluded.valor, versao=excluded.versao, ativo=1,
            updated_by=excluded.updated_by, updated_at=datetime('now')
        `, [emp, uni, chave, normalizado, versao, operador, operador]);
        await run(db, `
          INSERT INTO cozinha_configuracoes_historico
            (empresa_id, unidade_id, chave, valor, versao, alterado_por, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `, [emp, uni, chave, normalizado, versao, operador]);
      }
      await commit(db);
      return obterConfiguracoes({ empresaId: emp, unidadeId: uni, operadorId: operador }, { db });
    } catch (err) {
      await rollback(db);
      throw err;
    }
  });
}

async function consolidarRelatorio({ empresaId, unidadeId, turnoId }, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  const turno = inteiroPositivo(turnoId);
  if (!emp || !uni || !turno) throw erro('Contexto do turno inválido.', 400, 'TURNO_CONTEXTO_INVALIDO');
  const db = conn(opts);
  const row = await get(db, `
    SELECT t.*,
           e.razao_social AS empresa_nome,
           e.nome_fantasia AS empresa_nome_fantasia,
           un.codigo AS unidade_codigo,
           COALESCE(ua.nome,ua.username,CAST(t.abertura_operador_id AS TEXT)) AS abertura_operador_nome,
           COALESCE(uf.nome,uf.username,CAST(t.fechamento_operador_id AS TEXT)) AS fechamento_operador_nome
    FROM cozinha_turnos t
    LEFT JOIN empresas e ON e.id=t.empresa_id
    LEFT JOIN cozinha_unidades un ON un.id=t.unidade_id AND un.empresa_id=t.empresa_id
    LEFT JOIN usuarios ua ON ua.id=t.abertura_operador_id
    LEFT JOIN usuarios uf ON uf.id=t.fechamento_operador_id
    WHERE t.id=? AND t.empresa_id=? AND t.unidade_id=?
  `, [turno, emp, uni]);
  if (!row) throw erro('Turno não encontrado.', 404, 'TURNO_NAO_ENCONTRADO');
  const recebidos = await get(db, `SELECT COUNT(*) total FROM cozinha_turno_pedidos WHERE turno_id=? AND empresa_id=? AND unidade_id=?`, [turno, emp, uni]);
  const prontos = await get(db, `SELECT COUNT(*) total FROM cozinha_itens WHERE turno_id=? AND empresa_id=? AND unidade_id=? AND estado_preparacao='PRONTO'`, [turno, emp, uni]);
  const retirados = await get(db, `SELECT COUNT(*) total FROM cozinha_rodadas WHERE turno_id=? AND empresa_id=? AND unidade_id=? AND retirada_estado='RETIRADA'`, [turno, emp, uni]);
  const cancelados = await get(db, `SELECT COUNT(*) total FROM cozinha_rodadas WHERE turno_id=? AND empresa_id=? AND unidade_id=? AND estado_preparacao='CANCELADA'`, [turno, emp, uni]);
  const emPreparacao = await get(db, `
    SELECT COUNT(DISTINCT r.id) AS total
    FROM cozinha_rodadas r
    WHERE r.turno_id=? AND r.empresa_id=? AND r.unidade_id=? AND r.estado_preparacao='EM_PREPARACAO'
  `, [turno, emp, uni]);
  const prontosAguardandoRetirada = await get(db, `
    SELECT COUNT(DISTINCT r.id) AS total
    FROM cozinha_rodadas r
    WHERE r.turno_id=? AND r.empresa_id=? AND r.unidade_id=?
      AND r.estado_preparacao='PRONTA' AND r.retirada_estado<>'RETIRADA'
  `, [turno, emp, uni]);
  const pedidosRecebidos = await get(db, `
    SELECT COUNT(DISTINCT pedido_id) AS total
    FROM cozinha_turno_pedidos
    WHERE turno_id=? AND empresa_id=? AND unidade_id=?
  `, [turno, emp, uni]);
  const pendencias = await calcularPendencias(db, emp, uni, turno);
  const intervencoes = await all(db, `
    SELECT i.tipo, i.operador_id,
           COALESCE(u.nome,u.username,CAST(i.operador_id AS TEXT)) AS operador_nome,
           i.observacao, i.created_at
    FROM cozinha_turno_intervencoes i
    LEFT JOIN usuarios u ON u.id=i.operador_id
    WHERE i.turno_id=? AND i.empresa_id=? AND i.unidade_id=? ORDER BY i.id
  `, [turno, emp, uni]);
  const tempos = await get(db, `
    SELECT
      AVG(CASE WHEN i.preparo_iniciado_em IS NOT NULL AND i.pronto_em IS NOT NULL
        THEN (julianday(i.pronto_em)-julianday(i.preparo_iniciado_em))*1440 END) AS preparo_medio,
      MAX(CASE WHEN i.preparo_iniciado_em IS NOT NULL AND i.pronto_em IS NOT NULL
        THEN (julianday(i.pronto_em)-julianday(i.preparo_iniciado_em))*1440 END) AS maior_preparo,
      AVG(CASE WHEN r.enviada_em IS NOT NULL AND i.pronto_em IS NOT NULL
        THEN (julianday(i.pronto_em)-julianday(r.enviada_em))*1440 END) AS espera_media,
      MAX(CASE WHEN r.enviada_em IS NOT NULL AND i.pronto_em IS NOT NULL
        THEN (julianday(i.pronto_em)-julianday(r.enviada_em))*1440 END) AS maior_atraso,
      AVG(CASE WHEN i.pronto_em IS NOT NULL AND r.retirada_em IS NOT NULL
        THEN (julianday(r.retirada_em)-julianday(i.pronto_em))*1440 END) AS pronto_retirada
    FROM cozinha_itens i
    JOIN cozinha_rodadas r ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id
    WHERE i.turno_id=? AND i.empresa_id=? AND i.unidade_id=?
  `, [turno, emp, uni]);
  const itensOperacionais = await get(db, `
    SELECT
      COALESCE(SUM(qty_preparada_millis),0) AS preparados_millis,
      COALESCE(SUM(CASE WHEN estado_preparacao IN ('PRONTO','RETIRADO')
        THEN qty_preparada_millis ELSE 0 END),0) AS prontos_millis
    FROM cozinha_itens
    WHERE turno_id=? AND empresa_id=? AND unidade_id=?
  `, [turno, emp, uni]);
  const dentroMeta = await get(db, `
    SELECT
      COUNT(CASE WHEN r.enviada_em IS NOT NULL AND i.pronto_em IS NOT NULL THEN 1 END) AS total,
      SUM(CASE WHEN ? IS NOT NULL AND r.enviada_em IS NOT NULL AND i.pronto_em IS NOT NULL
        AND (julianday(i.pronto_em)-julianday(r.enviada_em))*1440
          <= ?
        THEN 1 ELSE 0 END) AS dentro_meta
    FROM cozinha_itens i
    JOIN cozinha_rodadas r ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id
    WHERE i.turno_id=? AND i.empresa_id=? AND i.unidade_id=?
  `, [row.meta_espera_minutos_snapshot, row.meta_espera_minutos_snapshot, turno, emp, uni]);
  const garcons = await all(db, `
    SELECT r.retirada_por AS operador_id,
           COALESCE(u.nome,u.username,CAST(r.retirada_por AS TEXT)) AS operador_nome,
           COUNT(DISTINCT r.id) AS pedidos_retirados,
           AVG(CASE WHEN r.retirada_em IS NOT NULL AND i.pronto_em IS NOT NULL
             THEN (julianday(r.retirada_em)-julianday(i.pronto_em))*1440 END) AS pronto_retirada_medio_minutos,
           SUM(CASE WHEN ? IS NOT NULL AND r.retirada_em IS NOT NULL AND r.enviada_em IS NOT NULL
             AND (julianday(r.retirada_em)-julianday(r.enviada_em))*1440
               <= ? THEN 1 ELSE 0 END) AS dentro_meta
    FROM cozinha_rodadas r
    LEFT JOIN cozinha_itens i
      ON i.rodada_id=r.id AND i.empresa_id=r.empresa_id AND i.unidade_id=r.unidade_id
    LEFT JOIN usuarios u ON u.id=r.retirada_por
    WHERE r.turno_id=? AND r.empresa_id=? AND r.unidade_id=? AND r.retirada_estado='RETIRADA'
    GROUP BY r.retirada_por
  `, [row.meta_espera_minutos_snapshot, row.meta_espera_minutos_snapshot, turno, emp, uni]);
  const cozinheiros = await tabelaExiste(db, 'cozinha_eventos_outbox') ? await all(db, `
    SELECT e.operador_id,
           COALESCE(u.nome,u.username,CAST(e.operador_id AS TEXT)) AS operador_nome,
           COUNT(DISTINCT CASE WHEN e.tipo='PREPARACAO_INICIADA' THEN e.item_id END) AS itens_iniciados,
           COUNT(DISTINCT CASE WHEN e.tipo='ITEM_PRONTO' THEN e.item_id END) AS itens_prontos
    FROM (
      SELECT tipo,
             CAST(json_extract(payload_json,'$.operador_id') AS INTEGER) AS operador_id,
             CAST(COALESCE(json_extract(payload_json,'$.item.id'),
               json_extract(payload_json,'$.item_id')) AS INTEGER) AS item_id
      FROM cozinha_eventos_outbox
      WHERE empresa_id=? AND unidade_id=?
        AND tipo IN ('PREPARACAO_INICIADA','ITEM_PRONTO')
        AND json_valid(payload_json)
    ) e
    INNER JOIN cozinha_itens i
      ON i.id=e.item_id AND i.empresa_id=? AND i.unidade_id=? AND i.turno_id=?
    LEFT JOIN usuarios u ON u.id=e.operador_id
    WHERE e.operador_id IS NOT NULL
    GROUP BY e.operador_id, u.nome, u.username
    ORDER BY itens_prontos DESC, itens_iniciados DESC
  `, [emp, uni, emp, uni, turno]) : [];
  const categorias = await all(db, `
    SELECT UPPER(i.tipo_item) AS categoria,
           COUNT(*) AS total,
           SUM(i.qty_preparada_millis) AS preparados_millis,
           SUM(CASE WHEN i.estado_preparacao='PRONTO' THEN 1 ELSE 0 END) AS preparados,
           SUM(CASE WHEN i.estado_preparacao='CANCELADO' THEN 1 ELSE 0 END) AS cancelados,
           AVG(CASE WHEN i.preparo_iniciado_em IS NOT NULL AND i.pronto_em IS NOT NULL
             THEN (julianday(i.pronto_em)-julianday(i.preparo_iniciado_em))*1440 END) AS tempo_medio_preparo_minutos,
           MAX(CASE WHEN r.enviada_em IS NOT NULL AND i.pronto_em IS NOT NULL
             THEN (julianday(i.pronto_em)-julianday(r.enviada_em))*1440 END) AS maior_atraso_minutos
    FROM cozinha_itens i
    JOIN cozinha_rodadas r ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
    WHERE i.turno_id=? AND i.empresa_id=? AND i.unidade_id=? GROUP BY UPPER(i.tipo_item)
    ORDER BY total DESC
  `, [turno, emp, uni]);
  const ledgerRetiradaExiste = await tabelaExiste(db, 'cozinha_retirada_itens');
  const produtos = await all(db, `
    SELECT COALESCE(i.produto_id,0) AS produto_id,
           COALESCE(i.produto_nome_snapshot,'Sem nome') AS produto,
           COUNT(*) AS total,
           SUM(i.qty_preparada_millis) AS preparados_millis,
           SUM(CASE WHEN i.estado_preparacao='PRONTO' THEN 1 ELSE 0 END) AS preparados,
           SUM(CASE WHEN i.estado_preparacao='CANCELADO' THEN 1 ELSE 0 END) AS cancelados,
           ${ledgerRetiradaExiste ? `(SELECT COALESCE(SUM(CASE
             WHEN e.tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO') THEN e.qty_millis
             WHEN e.tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO') THEN -e.qty_millis
             ELSE 0 END),0)
             FROM cozinha_retirada_itens e
             WHERE e.cozinha_item_id=i.id AND e.empresa_id=i.empresa_id
               AND e.unidade_id=i.unidade_id AND e.turno_id=i.turno_id)` : '0'} AS retirados_millis,
           AVG(CASE WHEN i.preparo_iniciado_em IS NOT NULL AND i.pronto_em IS NOT NULL
             THEN (julianday(i.pronto_em)-julianday(i.preparo_iniciado_em))*1440 END) AS tempo_medio_preparo_minutos,
           MAX(CASE WHEN r.enviada_em IS NOT NULL AND i.pronto_em IS NOT NULL
             THEN (julianday(i.pronto_em)-julianday(r.enviada_em))*1440 END) AS maior_atraso_minutos
    FROM cozinha_itens i
    JOIN cozinha_rodadas r ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
    WHERE i.turno_id=? AND i.empresa_id=? AND i.unidade_id=? GROUP BY COALESCE(i.produto_id,0), COALESCE(i.produto_nome_snapshot,'Sem nome')
    ORDER BY maior_atraso_minutos DESC, total DESC
  `, [turno, emp, uni]);
  let retiradasParciais = [];
  let retiradasEfetivas = 0;
  let ocorrenciasRetirada = [];
  if (ledgerRetiradaExiste) {
    const totalRetiradas = await get(db, `
      SELECT COALESCE(SUM(
        CASE WHEN tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO') THEN qty_millis
          WHEN tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO') THEN -qty_millis ELSE 0 END
      ),0) AS total_millis
      FROM cozinha_retirada_itens
      WHERE turno_id=? AND empresa_id=? AND unidade_id=?
    `, [turno, emp, uni]);
    retiradasEfetivas = Number(totalRetiradas?.total_millis || 0);
    ocorrenciasRetirada = await all(db, `
      SELECT id, tipo_evento AS tipo, operador_id, autorizado_por_operador_id,
             qty_millis, justificativa, registrado_em
      FROM cozinha_retirada_itens
      WHERE turno_id=? AND empresa_id=? AND unidade_id=?
        AND tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_CREDITO','AJUSTE_DEBITO')
      ORDER BY id
    `, [turno, emp, uni]);
    retiradasParciais = await all(db, `
      SELECT e.operador_id,
             COALESCE(u.nome,u.username,CAST(e.operador_id AS TEXT)) AS operador_nome,
             COUNT(*) AS eventos,
             SUM(e.qty_millis) AS qty_millis,
             e.cozinha_item_id, e.rodada_id
      FROM cozinha_retirada_itens e
      JOIN cozinha_itens i
        ON i.id=e.cozinha_item_id AND i.empresa_id=e.empresa_id
          AND i.unidade_id=e.unidade_id AND i.turno_id=e.turno_id
      LEFT JOIN usuarios u ON u.id=e.operador_id
      WHERE e.turno_id=? AND e.empresa_id=? AND e.unidade_id=?
        AND e.tipo_evento='RETIRADA_CONFIRMADA'
        AND e.qty_millis < i.qty_solicitada_millis-i.qty_cancelada_millis-COALESCE((
          SELECT SUM(CASE
            WHEN anterior.tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO') THEN anterior.qty_millis
            WHEN anterior.tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO') THEN -anterior.qty_millis
            ELSE 0 END)
          FROM cozinha_retirada_itens anterior
          WHERE anterior.empresa_id=e.empresa_id
            AND anterior.cozinha_item_id=e.cozinha_item_id
            AND anterior.id<e.id
        ),0)
      GROUP BY e.operador_id, u.nome, u.username, e.cozinha_item_id, e.rodada_id
    `, [turno, emp, uni]);
  }
  const itensParciais = ledgerRetiradaExiste ? await get(db, `
    SELECT COUNT(*) AS total FROM (
      SELECT i.id,
        COALESCE(SUM(CASE
          WHEN e.tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO') THEN e.qty_millis
          WHEN e.tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO') THEN -e.qty_millis
          ELSE 0 END),0) AS retirado_millis,
        i.qty_solicitada_millis-i.qty_cancelada_millis AS exigivel_millis
      FROM cozinha_itens i
      LEFT JOIN cozinha_retirada_itens e
        ON e.cozinha_item_id=i.id AND e.empresa_id=i.empresa_id
          AND e.unidade_id=i.unidade_id AND e.turno_id=i.turno_id
      WHERE i.turno_id=? AND i.empresa_id=? AND i.unidade_id=?
      GROUP BY i.id
      HAVING retirado_millis > 0 AND retirado_millis < exigivel_millis
    )
  `, [turno, emp, uni]) : null;
  const horariosPico = await all(db, `
    SELECT strftime('%H', datetime(enviada_em, '-3 hours')) AS hora, COUNT(*) AS pedidos
    FROM cozinha_rodadas
    WHERE turno_id=? AND empresa_id=? AND unidade_id=? AND enviada_em IS NOT NULL
    GROUP BY strftime('%H', datetime(enviada_em, '-3 hours'))
    ORDER BY pedidos DESC, hora
    LIMIT 3
  `, [turno, emp, uni]);
  const cancelamentos = await tabelaExiste(db, 'cozinha_cancelamento_itens')
    ? await all(db, `
      SELECT id, tipo_evento AS tipo, operador_id, autorizado_por_operador_id,
             qty_millis, justificativa, registrado_em
      FROM cozinha_cancelamento_itens
      WHERE turno_id=? AND empresa_id=? AND unidade_id=?
      ORDER BY id
    `, [turno, emp, uni])
    : [];
  const pendenciasRelatorio = pendencias.map(p => ({
    ...p,
    situacao: row.fechamento_tipo === 'EXCEPCIONAL'
      ? 'PRESERVADA_NO_FECHAMENTO_EXCEPCIONAL'
      : 'PENDENTE'
  }));
  const percentualForaMeta = row.meta_espera_minutos_snapshot != null && Number(dentroMeta?.total || 0) > 0
    ? 100 - Number(dentroMeta.dentro_meta) / Number(dentroMeta.total) * 100
    : null;
  let configuracoesSnapshot = [];
  if (row.configuracoes_snapshot_json) {
    try { configuracoesSnapshot = JSON.parse(row.configuracoes_snapshot_json); }
    catch (_error) {
      throw erro('O snapshot das configurações do turno está inválido.', 500, 'TURNO_CONFIGURACAO_SNAPSHOT_INVALIDO');
    }
    if (!Array.isArray(configuracoesSnapshot)) {
      throw erro('O snapshot das configurações do turno está inválido.', 500, 'TURNO_CONFIGURACAO_SNAPSHOT_INVALIDO');
    }
  }
  return {
    success: true,
    turno: row,
    configuracoes: configuracoesSnapshot,
    indicadores: {
      pedidos_recebidos: pedidosRecebidos ? Number(pedidosRecebidos.total || 0) : Number(recebidos?.total || 0),
      pedidos_preparados: Number(prontos?.total || 0),
      pedidos_em_preparacao: Number(emPreparacao?.total || 0),
      pedidos_prontos_aguardando_retirada: Number(prontosAguardandoRetirada?.total || 0),
      pedidos_retirados: Number(retirados?.total || 0),
      pedidos_concluidos: Number(retirados?.total || 0),
      pedidos_cancelados: Number(cancelados?.total || 0),
      pedidos_pendentes: pendencias.reduce((n, p) => n + Number(p.quantidade || 0), 0),
      pendencias: pendenciasRelatorio,
      itens_preparados_millis: Number(itensOperacionais?.preparados_millis || 0),
      itens_prontos_millis: Number(itensOperacionais?.prontos_millis || 0),
      itens_retirados_millis: retiradasEfetivas,
      retiradas_parciais: retiradasParciais.reduce((total, item) => total + Number(item.eventos || 0), 0),
      itens_parcialmente_retirados: Number(itensParciais?.total || 0)
    },
    tempos: {
      preparo_medio_minutos: tempos?.preparo_medio != null ? Number(tempos.preparo_medio) : null,
      espera_media_minutos: tempos?.espera_media != null ? Number(tempos.espera_media) : null,
      pronto_para_retirada_medio_minutos: tempos?.pronto_retirada != null ? Number(tempos.pronto_retirada) : null,
      maior_atraso_minutos: tempos?.maior_atraso != null ? Number(tempos.maior_atraso) : null,
      maior_preparo_minutos: tempos?.maior_preparo != null ? Number(tempos.maior_preparo) : null,
      percentual_no_prazo: row.meta_espera_minutos_snapshot != null && Number(dentroMeta?.total || 0) > 0
        ? Number(dentroMeta.dentro_meta) / Number(dentroMeta.total) * 100
        : null,
      percentual_fora_prazo: percentualForaMeta,
      horarios_pico: horariosPico
    },
    desempenho: {
      cozinheiros,
      garcons,
      categorias,
      produtos,
      retiradas_parciais: retiradasParciais
    },
    ocorrencias: {
      cancelamentos,
      estornos_e_ajustes: ocorrenciasRetirada,
      pendencias_preservadas: row.fechamento_tipo === 'EXCEPCIONAL' ? pendenciasRelatorio : []
    },
    intervencoes,
    fechamentos_excepcionais: intervencoes.filter(i => i.tipo === 'FECHAMENTO_EXCEPCIONAL')
  };
}

async function gerarRelatorio({ empresaId, unidadeId, turnoId }, opts = {}) {
  const emp = inteiroPositivo(empresaId);
  const uni = inteiroPositivo(unidadeId);
  const turno = inteiroPositivo(turnoId);
  if (!emp || !uni || !turno) throw erro('Contexto do turno inválido.', 400, 'TURNO_CONTEXTO_INVALIDO');
  const db = conn(opts);
  await validarUnidade(db, emp, uni);
  const snapshot = await get(db, `
    SELECT id, snapshot_json, snapshot_sha256, gerado_em
    FROM cozinha_turno_relatorios
    WHERE turno_id=? AND empresa_id=? AND unidade_id=?
  `, [turno, emp, uni]);
  if (snapshot) {
    const hashCalculado = crypto.createHash('sha256').update(snapshot.snapshot_json).digest('hex');
    if (hashCalculado !== snapshot.snapshot_sha256) {
      throw erro('O snapshot do relatório está inconsistente.', 500, 'RELATORIO_SNAPSHOT_INTEGRIDADE');
    }
    let relatorio;
    try { relatorio = JSON.parse(snapshot.snapshot_json); }
    catch (_error) {
      throw erro('O snapshot do relatório não contém JSON válido.', 500, 'RELATORIO_SNAPSHOT_INVALIDO');
    }
    return {
      ...relatorio,
      relatorio_id: Number(snapshot.id),
      relatorio_gerado_em: snapshot.gerado_em,
      snapshot_sha256: snapshot.snapshot_sha256,
      snapshot_persistido: true
    };
  }
  const turnoRow = await get(db, `
    SELECT estado FROM cozinha_turnos
    WHERE id=? AND empresa_id=? AND unidade_id=?
  `, [turno, emp, uni]);
  if (!turnoRow) throw erro('Turno não encontrado.', 404, 'TURNO_NAO_ENCONTRADO');
  const relatorio = await consolidarRelatorio({ empresaId: emp, unidadeId: uni, turnoId: turno }, { db });
  if (turnoRow.estado === 'FECHADA') {
    return { ...relatorio, snapshot_persistido: false, legado_sem_snapshot: true };
  }
  return { ...relatorio, snapshot_persistido: false };
}

module.exports = {
  abrirTurno,
  fecharTurno,
  exigirAcessoGerencial,
  perfilPodeAcessarGestao,
  statusTurno,
  listarHistorico,
  exigirTurnoAberto,
  vincularPedidoAoTurno,
  vincularRodadaAoTurno,
  resolverTurnoOperacional,
  vincularEventoAoTurno,
  obterConfiguracoes,
  salvarConfiguracoes,
  gerarRelatorio
};
