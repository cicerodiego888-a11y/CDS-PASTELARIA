'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const Module = require('module');

const databasePath = require.resolve('../../backend/database');
const databaseMock = new sqlite3.Database(':memory:');
const databaseModule = new Module(databasePath);
databaseModule.filename = databasePath;
databaseModule.loaded = true;
databaseModule.exports = databaseMock;
require.cache[databasePath] = databaseModule;

const { garantirSchemaCozinha } = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const Turno = require('../../backend/services/cozinha/CozinhaTurnoService');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function cb(err) {
    if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
  }));
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => {
    if (err) reject(err); else resolve(row || null);
  }));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => {
    if (err) reject(err); else resolve(rows || []);
  }));
}
function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', async (err) => {
      if (err) return reject(err);
      await run(db, 'PRAGMA foreign_keys = ON');
      await run(db, 'PRAGMA busy_timeout = 10000');
      resolve(db);
    });
  });
}
function close(db) {
  return new Promise(resolve => db.close(() => resolve()));
}

async function foreignKeysCozinha(db) {
  const tabelas = await all(db, `
    SELECT name FROM sqlite_master
    WHERE type='table' AND name LIKE 'cozinha_%'
      AND name <> 'cozinha_turno_relatorios'
    ORDER BY name
  `);
  const resultado = {};
  for (const tabela of tabelas) {
    const nome = String(tabela.name).replace(/"/g, '""');
    resultado[tabela.name] = await all(db, `PRAGMA foreign_key_list("${nome}")`);
  }
  return resultado;
}

after(() => close(databaseMock));

async function preparar(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      nome TEXT,
      role TEXT,
      perfil TEXT,
      ativo INTEGER DEFAULT 1
    )
  `);
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaCozinha(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS cozinha_operador_unidades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      operador_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      UNIQUE (empresa_id, operador_id, unidade_id)
    )
  `);
  const emp1 = await run(db, `INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11111111000111','Empresa 1','E1',1)`);
  const emp2 = await run(db, `INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('22222222000122','Empresa 2','E2',1)`);
  const op = await run(db, `INSERT INTO usuarios (username,nome,role,perfil,ativo)
    VALUES ('op','Operador','operador','USUARIO',1)`);
  const gerente = await run(db, `INSERT INTO usuarios (username,nome,role,perfil,ativo)
    VALUES ('gerente','Gerente','gerente','GERENTE',1)`);
  const superAdmin = await run(db, `INSERT INTO usuarios (username,nome,role,perfil,ativo)
    VALUES ('super','Super Administrador','admin','SUPER_ADMIN',1)`);
  const admin = await run(db, `INSERT INTO usuarios (username,nome,role,perfil,ativo)
    VALUES ('admin','Administrador','admin','ADMIN',1)`);
  const cozinheiro = await run(db, `INSERT INTO usuarios (username,nome,role,perfil,ativo)
    VALUES ('cozinheiro','Cozinheiro','cozinheiro','USUARIO',1)`);
  const garcom = await run(db, `INSERT INTO usuarios (username,nome,role,perfil,ativo)
    VALUES ('garcom','Garçom','garcom','USUARIO',1)`);
  const ua = await run(db, `INSERT INTO cozinha_unidades (empresa_id,codigo,ativo) VALUES (?, 'UA',1)`, [emp1.lastID]);
  const ub = await run(db, `INSERT INTO cozinha_unidades (empresa_id,codigo,ativo) VALUES (?, 'UB',1)`, [emp1.lastID]);
  const ux = await run(db, `INSERT INTO cozinha_unidades (empresa_id,codigo,ativo) VALUES (?, 'UX',1)`, [emp2.lastID]);
  await run(db, `INSERT INTO usuario_empresas (usuario_id,empresa_id,ativo) VALUES (?,?,1)`, [op.lastID, emp1.lastID]);
  await run(db, `INSERT INTO usuario_empresas (usuario_id,empresa_id,ativo) VALUES (?,?,1)`, [gerente.lastID, emp1.lastID]);
  await run(db, `INSERT INTO usuario_empresas (usuario_id,empresa_id,ativo) VALUES (?,?,1)`, [cozinheiro.lastID, emp1.lastID]);
  await run(db, `INSERT INTO usuario_empresas (usuario_id,empresa_id,ativo) VALUES (?,?,1)`, [garcom.lastID, emp1.lastID]);
  await run(db, `INSERT INTO cozinha_operador_unidades (empresa_id,operador_id,unidade_id) VALUES (?,?,?)`, [emp1.lastID, op.lastID, ua.lastID]);
  await run(db, `INSERT INTO cozinha_operador_unidades (empresa_id,operador_id,unidade_id) VALUES (?,?,?)`, [emp1.lastID, gerente.lastID, ua.lastID]);
  await run(db, `INSERT INTO cozinha_operador_unidades (empresa_id,operador_id,unidade_id) VALUES (?,?,?)`, [emp1.lastID, cozinheiro.lastID, ua.lastID]);
  await run(db, `INSERT INTO cozinha_operador_unidades (empresa_id,operador_id,unidade_id) VALUES (?,?,?)`, [emp1.lastID, garcom.lastID, ua.lastID]);
  return {
    emp1: emp1.lastID, emp2: emp2.lastID, op: op.lastID, gerente: gerente.lastID,
    superAdmin: superAdmin.lastID, admin: admin.lastID, cozinheiro: cozinheiro.lastID,
    garcom: garcom.lastID, ua: ua.lastID, ub: ub.lastID, ux: ux.lastID
  };
}

async function rebaixarParaV8ComDados(db, contexto) {
  const fechada = await run(db, `
    INSERT INTO cozinha_turnos (
      empresa_id, unidade_id, estado, abertura_operador_id, abertura_em,
      fechamento_operador_id, fechamento_em, fechamento_tipo
    ) VALUES (?, ?, 'FECHADA', ?, '2026-01-02T08:00:00Z', ?, '2026-01-02T16:00:00Z', 'NORMAL')
  `, [contexto.emp1, contexto.ua, contexto.gerente, contexto.gerente]);
  const aberta = await run(db, `
    INSERT INTO cozinha_turnos (
      empresa_id, unidade_id, estado, abertura_operador_id, abertura_em
    ) VALUES (?, ?, 'ABERTA', ?, '2026-01-03T08:00:00Z')
  `, [contexto.emp1, contexto.ua, contexto.gerente]);

  await run(db, `
    INSERT INTO cozinha_turno_pedidos (empresa_id, unidade_id, turno_id, pedido_id)
    VALUES (?, ?, ?, 101)
  `, [contexto.emp1, contexto.ua, fechada.lastID]);
  await run(db, `
    INSERT INTO cozinha_turno_intervencoes (
      empresa_id, unidade_id, turno_id, tipo, operador_id, observacao
    ) VALUES (?, ?, ?, 'AJUSTE', ?, 'registro legado')
  `, [contexto.emp1, contexto.ua, fechada.lastID, contexto.gerente]);

  await run(db, `CREATE TABLE cozinha_retirada_itens (
    id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, unidade_id INTEGER NOT NULL,
    turno_id INTEGER, operacao_id TEXT NOT NULL, qty_millis INTEGER NOT NULL
  )`);
  await run(db, `CREATE TABLE cozinha_cancelamento_itens (
    id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, unidade_id INTEGER NOT NULL,
    turno_id INTEGER, operacao_id TEXT NOT NULL, qty_millis INTEGER NOT NULL
  )`);
  await run(db, `
    INSERT INTO cozinha_retirada_itens VALUES (1, ?, ?, ?, 'retirada-legada', 500)
  `, [contexto.emp1, contexto.ua, fechada.lastID]);
  await run(db, `
    INSERT INTO cozinha_cancelamento_itens VALUES (1, ?, ?, ?, 'cancelamento-legado', 250)
  `, [contexto.emp1, contexto.ua, aberta.lastID]);

  await run(db, 'DROP TRIGGER trg_cozinha_turno_relatorio_turno_fechado');
  await run(db, 'DROP TRIGGER trg_cozinha_turno_relatorio_imutavel_update');
  await run(db, 'DROP TRIGGER trg_cozinha_turno_relatorio_imutavel_delete');
  await run(db, 'DROP TABLE cozinha_turno_relatorios');
  await run(db, 'DROP INDEX ux_cozinha_turnos_id_contexto');
  await run(db, 'ALTER TABLE cozinha_turnos DROP COLUMN configuracoes_snapshot_json');
  await run(db, "UPDATE cozinha_schema_meta SET valor='8' WHERE chave='schema_version'");
  return { turnoFechadoId: fechada.lastID, turnoAbertoId: aberta.lastID };
}

describe('Turnos de cozinha', () => {
  it('abre, bloqueia duplicidade concorrente e isola por unidade e empresa', async () => {
    const db = await openDb();
    const c = await preparar(db);
    await assert.rejects(
      () => Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ux, operadorId: c.op }, { db }),
      err => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
    );
    const resultados = await Promise.allSettled([
      Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente }, { db }),
      Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.superAdmin }, { db })
    ]);
    assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(resultados.filter(r => r.status === 'rejected' && r.reason.codigo === 'TURNO_JA_ABERTO').length, 1);
    await Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ub, operadorId: c.superAdmin }, { db });
    const statusA = await Turno.statusTurno({ empresaId: c.emp1, unidadeId: c.ua }, { db });
    const statusB = await Turno.statusTurno({ empresaId: c.emp1, unidadeId: c.ub }, { db });
    assert.equal(statusA.estado, 'ABERTA');
    assert.equal(statusB.estado, 'ABERTA');
    await close(db);
  });

  it('fecha normalmente para gerente e super administrador, e excepcional com justificativa', async () => {
    const db = await openDb();
    const c = await preparar(db);
    await Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente }, { db });
    const normalGerente = await Turno.fecharTurno({
      empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente, tipo: 'NORMAL'
    }, { db });
    assert.equal(normalGerente.fechamento_tipo, 'NORMAL');
    assert.equal(normalGerente.pendencias.length, 0);
    assert.ok(normalGerente.relatorio_id > 0);
    const normalReport = await Turno.gerarRelatorio({
      empresaId: c.emp1, unidadeId: c.ua, turnoId: normalGerente.turno_id
    }, { db });
    assert.equal(normalReport.snapshot_persistido, true);
    assert.equal(normalReport.relatorio_id, normalGerente.relatorio_id);
    await assert.rejects(
      () => Turno.fecharTurno({
        empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente, tipo: 'NORMAL'
      }, { db }),
      err => err.codigo === 'COZINHA_JA_FECHADA'
    );
    assert.equal(Number((await get(db, `
      SELECT COUNT(*) AS total FROM cozinha_turno_relatorios
      WHERE turno_id=?
    `, [normalGerente.turno_id])).total), 1);

    await Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ub, operadorId: c.superAdmin }, { db });
    const normalSuperAdmin = await Turno.fecharTurno({
      empresaId: c.emp1, unidadeId: c.ub, operadorId: c.superAdmin, tipo: 'NORMAL'
    }, { db });
    assert.equal(normalSuperAdmin.fechamento_tipo, 'NORMAL');
    assert.equal(normalSuperAdmin.pendencias.length, 0);

    await Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente }, { db });
    await assert.rejects(
      () => Turno.fecharTurno({
        empresaId: c.emp1, unidadeId: c.ua, operadorId: c.admin, tipo: 'NORMAL'
      }, { db }),
      err => err.codigo === 'GESTAO_COZINHA_SEM_AUTORIZACAO'
    );
    await assert.rejects(
      () => Turno.fecharTurno({
        empresaId: c.emp1, unidadeId: c.ua, operadorId: c.op, tipo: 'NORMAL'
      }, { db }),
      err => err.codigo === 'GESTAO_COZINHA_SEM_AUTORIZACAO'
    );
    await assert.rejects(
      () => Turno.fecharTurno({
        empresaId: c.emp1, unidadeId: c.ub, operadorId: c.gerente, tipo: 'NORMAL'
      }, { db }),
      err => err.codigo === 'UNIDADE_SEM_AUTORIZACAO'
    );
    await assert.rejects(
      () => Turno.fecharTurno({
        empresaId: c.emp2, unidadeId: c.ua, operadorId: c.gerente, tipo: 'NORMAL'
      }, { db }),
      err => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
    );

    const turno = await Turno.statusTurno({ empresaId: c.emp1, unidadeId: c.ua }, { db });
    await run(db, `
      INSERT INTO cozinha_rodadas
        (empresa_id,unidade_id,turno_id,mesa_id,atendimento_id,numero_rodada,sequencia_global,
         enviada_em,operador_envio_id,estado_preparacao,retirada_estado,entrega_estado,updated_at)
      VALUES (?, ?, ?, 1,1,1,1,datetime('now'),?,'AGUARDANDO','PENDENTE','PENDENTE',datetime('now'))
    `, [c.emp1, c.ua, turno.turno.id, c.op]);
    await assert.rejects(
      () => Turno.fecharTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente, tipo: 'NORMAL' }, { db }),
      err => err.codigo === 'FECHAMENTO_NORMAL_BLOQUEADO'
    );
    assert.equal(Number((await get(db, `
      SELECT COUNT(*) AS total FROM cozinha_turno_relatorios WHERE turno_id=?
    `, [turno.turno.id])).total), 0);
    await assert.rejects(
      () => Turno.fecharTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.op, tipo: 'EXCEPCIONAL', justificativa: 'Falta de equipe no encerramento' }, { db }),
      err => err.codigo === 'GESTAO_COZINHA_SEM_AUTORIZACAO'
    );
    await assert.rejects(
      () => Turno.fecharTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.admin, tipo: 'EXCEPCIONAL', justificativa: 'Falta de equipe no encerramento' }, { db }),
      err => err.codigo === 'GESTAO_COZINHA_SEM_AUTORIZACAO'
    );
    await assert.rejects(
      () => Turno.fecharTurno({
        empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente,
        tipo: 'EXCEPCIONAL', justificativa: 'curta'
      }, { db }),
      err => err.codigo === 'JUSTIFICATIVA_FECHAMENTO_OBRIGATORIA'
    );
    const exceptional = await Turno.fecharTurno({
      empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente,
      tipo: 'EXCEPCIONAL', justificativa: 'Falta de equipe no encerramento'
    }, { db });
    assert.equal(exceptional.fechamento_tipo, 'EXCEPCIONAL');
    assert.equal(exceptional.criado_sem_retiradas_artificiais, true);
    assert.ok(exceptional.relatorio_id > 0);
    const exceptionalReport = await Turno.gerarRelatorio({
      empresaId: c.emp1, unidadeId: c.ua, turnoId: exceptional.turno_id
    }, { db });
    assert.equal(exceptionalReport.snapshot_persistido, true);
    assert.equal(exceptionalReport.turno.fechamento_operador_nome, 'Gerente');
    assert.ok(exceptionalReport.turno.fechamento_justificativa);
    assert.ok(exceptionalReport.indicadores.pendencias.some(p =>
      p.situacao === 'PRESERVADA_NO_FECHAMENTO_EXCEPCIONAL'
    ));
    assert.ok(exceptionalReport.ocorrencias.pendencias_preservadas.length > 0);
    await close(db);
  });

  it('não fecha turno pertencente a outra empresa', async () => {
    const db = await openDb();
    const c = await preparar(db);
    await Turno.abrirTurno({ empresaId: c.emp2, unidadeId: c.ux, operadorId: c.superAdmin }, { db });
    await assert.rejects(
      () => Turno.fecharTurno({
        empresaId: c.emp1, unidadeId: c.ux, operadorId: c.superAdmin, tipo: 'NORMAL'
      }, { db }),
      err => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
    );
    const status = await Turno.statusTurno({ empresaId: c.emp2, unidadeId: c.ux }, { db });
    assert.equal(status.estado, 'ABERTA');
    await close(db);
  });

  it('mantém configuração versionada e gera relatório do turno', async () => {
    const db = await openDb();
    const c = await preparar(db);
    await Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente }, { db });
    await assert.rejects(
      () => Turno.salvarConfiguracoes({
        empresaId: c.emp1, unidadeId: c.ua, operadorId: c.op,
        config: { meta_preparo_minutos: 25 }
      }, { db }),
      err => err.codigo === 'COZINHA_CONFIG_SEM_AUTORIZACAO'
    );
    const config = await Turno.salvarConfiguracoes({
      empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente,
      config: { meta_preparo_minutos: 25, horario_abertura: '08:00' }
    }, { db });
    assert.equal(config.config.meta_preparo_minutos, '25');
    await assert.rejects(
      () => Turno.obterConfiguracoes({ empresaId: c.emp1, unidadeId: c.ub, operadorId: c.gerente }, { db }),
      err => err.codigo === 'UNIDADE_SEM_AUTORIZACAO'
    );
    await assert.rejects(
      () => Turno.salvarConfiguracoes({
        empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente,
        config: { meta_preparo_minutos: '' }
      }, { db }),
      err => err.codigo === 'COZINHA_CONFIG_INVALIDA'
    );
    const status = await Turno.statusTurno({ empresaId: c.emp1, unidadeId: c.ua }, { db });
    const comanda = await run(db, `
      INSERT INTO cozinha_comandas
        (empresa_id, atendimento_id, numero_comanda, registrado_em, created_at, updated_at)
      VALUES (?,1,1,datetime('now'),datetime('now'),datetime('now'))
    `, [c.emp1]);
    const rodada = await run(db, `
      INSERT INTO cozinha_rodadas
        (empresa_id,unidade_id,turno_id,mesa_id,atendimento_id,numero_rodada,sequencia_global,
         enviada_em,operador_envio_id,estado_preparacao,retirada_estado,entrega_estado,
         retirada_em,retirada_por,preparacao_iniciada_em,pronta_em,updated_at)
      VALUES (?, ?, ?,1,1,1,1,datetime('now','-30 minutes'),?, 'PRONTA','RETIRADA','PENDENTE',
        datetime('now','-5 minutes'),?,datetime('now','-20 minutes'),datetime('now','-10 minutes'),datetime('now'))
    `, [c.emp1, c.ua, status.turno.id, c.op, c.gerente]);
    await run(db, `
      INSERT INTO cozinha_itens
        (empresa_id,unidade_id,turno_id,rodada_id,comanda_id,pedido_id,pedido_item_id,sequencia_global,
         tipo_item,qty_solicitada_millis,qty_preparada_millis,estado_preparacao,
         produto_id,produto_nome_snapshot,preparo_iniciado_em,pronto_em,updated_at)
      VALUES (?,?,?,?,?,1,1,1,'PASTEL',1000,1000,'PRONTO',123,'Pastel teste',
        datetime('now','-20 minutes'),datetime('now','-10 minutes'),datetime('now'))
    `, [c.emp1, c.ua, status.turno.id, rodada.lastID, comanda.lastID]);
    await run(db, `
      CREATE TABLE cozinha_retirada_itens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER NOT NULL,
        unidade_id INTEGER NOT NULL,
        turno_id INTEGER NOT NULL,
        tipo_evento TEXT NOT NULL,
        qty_millis INTEGER NOT NULL,
        operador_id INTEGER NOT NULL,
        autorizado_por_operador_id INTEGER,
        cozinha_item_id INTEGER NOT NULL,
        rodada_id INTEGER NOT NULL,
        justificativa TEXT,
        registrado_em TEXT,
        created_at TEXT
      )
    `);
    await run(db, `
      INSERT INTO cozinha_retirada_itens
        (empresa_id,unidade_id,turno_id,tipo_evento,qty_millis,operador_id,cozinha_item_id,rodada_id)
      VALUES
        (?,?,?,'RETIRADA_CONFIRMADA',600,?,?,?),
        (?,?,?,'RETIRADA_CONFIRMADA',400,?,?,?)
    `, [c.emp1, c.ua, status.turno.id, c.gerente, 1, rodada.lastID,
      c.emp1, c.ua, status.turno.id, c.op, 1, rodada.lastID]);
    const report = await Turno.gerarRelatorio({
      empresaId: c.emp1, unidadeId: c.ua, turnoId: status.turno.id
    }, { db });
    assert.equal(report.indicadores.pedidos_recebidos, 0);
    assert.equal(report.indicadores.itens_preparados_millis, 1000);
    assert.equal(report.indicadores.itens_retirados_millis, 1000);
    assert.equal(report.indicadores.retiradas_parciais, 1);
    assert.deepEqual(report.configuracoes, []);
    assert.equal(report.desempenho.produtos[0].preparados_millis, 1000);
    assert.equal(report.desempenho.produtos[0].retirados_millis, 1000);
    assert.equal(report.snapshot_persistido, false);
    assert.ok(Array.isArray(report.intervencoes));
    await close(db);
  });

  it('recupera o snapshot após recarga do serviço e impede alterações retroativas', async () => {
    const db = await openDb();
    const c = await preparar(db);
    await Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente }, { db });
    const fechamento = await Turno.fecharTurno({
      empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente, tipo: 'NORMAL'
    }, { db });
    const original = await Turno.gerarRelatorio({
      empresaId: c.emp1, unidadeId: c.ua, turnoId: fechamento.turno_id
    }, { db });
    await run(db, 'UPDATE usuarios SET nome=? WHERE id=?', ['Nome posterior', c.gerente]);

    const servicePath = require.resolve('../../backend/services/cozinha/CozinhaTurnoService');
    delete require.cache[servicePath];
    const TurnoRecarregado = require('../../backend/services/cozinha/CozinhaTurnoService');
    const recuperado = await TurnoRecarregado.gerarRelatorio({
      empresaId: c.emp1, unidadeId: c.ua, turnoId: fechamento.turno_id
    }, { db });
    assert.equal(recuperado.relatorio_id, original.relatorio_id);
    assert.equal(recuperado.snapshot_sha256, original.snapshot_sha256);
    assert.equal(recuperado.turno.fechamento_operador_nome, 'Gerente');

    await assert.rejects(
      () => run(db, 'UPDATE cozinha_turno_relatorios SET snapshot_json=? WHERE id=?', ['{}', original.relatorio_id]),
      /imutavel/
    );
    await assert.rejects(
      () => run(db, 'DELETE FROM cozinha_turno_relatorios WHERE id=?', [original.relatorio_id]),
      /imutavel/
    );
    await assert.rejects(
      () => TurnoRecarregado.gerarRelatorio({
        empresaId: c.emp1, unidadeId: c.ub, turnoId: fechamento.turno_id
      }, { db }),
      err => err.codigo === 'TURNO_NAO_ENCONTRADO'
    );
    await assert.rejects(
      () => TurnoRecarregado.gerarRelatorio({
        empresaId: c.emp2, unidadeId: c.ua, turnoId: fechamento.turno_id
      }, { db }),
      err => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
    );
    assert.equal((await get(db, 'PRAGMA integrity_check')).integrity_check, 'ok');
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
    await close(db);
  });

  it('faz rollback do fechamento se o snapshot não puder ser persistido', async () => {
    const db = await openDb();
    const c = await preparar(db);
    await Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente }, { db });
    await run(db, `
      CREATE TRIGGER bloquear_snapshot_teste
      BEFORE INSERT ON cozinha_turno_relatorios
      BEGIN
        SELECT RAISE(ABORT, 'falha controlada de persistência');
      END
    `);
    await assert.rejects(
      () => Turno.fecharTurno({
        empresaId: c.emp1, unidadeId: c.ua, operadorId: c.gerente, tipo: 'NORMAL'
      }, { db }),
      /falha controlada de persistência/
    );
    const status = await Turno.statusTurno({ empresaId: c.emp1, unidadeId: c.ua }, { db });
    assert.equal(status.estado, 'ABERTA');
    assert.equal(Number((await get(db, `
      SELECT COUNT(*) AS total FROM cozinha_turno_relatorios
    `)).total), 0);
    await close(db);
  });

  it('migra v8 real para v9 preservando registros, ledgers e FKs sem reconstrução histórica', async () => {
    const db = await openDb();
    const c = await preparar(db);
    const turnos = await rebaixarParaV8ComDados(db, c);
    const antes = {
      turnos: await all(db, `
        SELECT id, empresa_id, unidade_id, estado, abertura_operador_id, abertura_em,
          fechamento_operador_id, fechamento_em, fechamento_tipo
        FROM cozinha_turnos ORDER BY id
      `),
      pedidos: await all(db, 'SELECT * FROM cozinha_turno_pedidos ORDER BY id'),
      intervencoes: await all(db, 'SELECT * FROM cozinha_turno_intervencoes ORDER BY id'),
      retiradas: await all(db, 'SELECT * FROM cozinha_retirada_itens ORDER BY id'),
      cancelamentos: await all(db, 'SELECT * FROM cozinha_cancelamento_itens ORDER BY id'),
      fks: await foreignKeysCozinha(db)
    };
    assert.equal((await get(db, 'PRAGMA integrity_check')).integrity_check, 'ok');
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);

    const migracao = await garantirSchemaCozinha(db);
    const depois = {
      turnos: await all(db, `
        SELECT id, empresa_id, unidade_id, estado, abertura_operador_id, abertura_em,
          fechamento_operador_id, fechamento_em, fechamento_tipo
        FROM cozinha_turnos ORDER BY id
      `),
      pedidos: await all(db, 'SELECT * FROM cozinha_turno_pedidos ORDER BY id'),
      intervencoes: await all(db, 'SELECT * FROM cozinha_turno_intervencoes ORDER BY id'),
      retiradas: await all(db, 'SELECT * FROM cozinha_retirada_itens ORDER BY id'),
      cancelamentos: await all(db, 'SELECT * FROM cozinha_cancelamento_itens ORDER BY id'),
      fks: await foreignKeysCozinha(db)
    };
    assert.equal(migracao.versao, 9);
    assert.equal(migracao.backup_pre_migracao, null);
    assert.deepEqual(depois, antes);
    assert.equal(migracao.migracao_v8_v9.migrado, true);
    assert.ok(await get(db, `
      SELECT 1 AS existe FROM sqlite_master
      WHERE type='table' AND name='cozinha_turno_relatorios'
    `));
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS total FROM cozinha_turno_relatorios')).total), 0);
    assert.ok(await get(db, `
      SELECT 1 AS existe FROM pragma_table_info('cozinha_turnos')
      WHERE name='configuracoes_snapshot_json'
    `));
    assert.equal((await get(db, 'PRAGMA integrity_check')).integrity_check, 'ok');
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);

    await run(db, `
      INSERT INTO cozinha_turno_relatorios (
        empresa_id, unidade_id, turno_id, snapshot_json, snapshot_sha256, gerado_em
      ) VALUES (?, ?, ?, '{}', 'teste', '2026-01-02T16:00:00Z')
    `, [c.emp1, c.ua, turnos.turnoFechadoId]);
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_turno_relatorios (
          empresa_id, unidade_id, turno_id, snapshot_json, snapshot_sha256, gerado_em
        ) VALUES (?, ?, ?, '{}', 'duplicado', '2026-01-02T16:00:00Z')
      `, [c.emp1, c.ua, turnos.turnoFechadoId]),
      /UNIQUE constraint failed/
    );
    await assert.rejects(
      () => run(db, `
        UPDATE cozinha_turno_relatorios SET snapshot_json='{}' WHERE turno_id=?
      `, [turnos.turnoFechadoId]),
      /imutavel/
    );
    await assert.rejects(
      () => run(db, 'DELETE FROM cozinha_turno_relatorios WHERE turno_id=?', [turnos.turnoFechadoId]),
      /imutavel/
    );

    const objetosAntes = await all(db, `
      SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `);
    const repetida = await garantirSchemaCozinha(db);
    const objetosDepois = await all(db, `
      SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `);
    assert.equal(repetida.versao, 9);
    assert.equal(repetida.migracao_v8_v9, null);
    assert.deepEqual(objetosDepois, objetosAntes);
    await close(db);
  });

  it('reverte integralmente a migration v8→v9 quando a gravação da versão falha', async () => {
    const db = await openDb();
    const c = await preparar(db);
    await rebaixarParaV8ComDados(db, c);
    await run(db, `
      CREATE TRIGGER bloquear_versao_v9_teste
      BEFORE UPDATE OF valor ON cozinha_schema_meta
      WHEN OLD.chave='schema_version' AND NEW.valor='9'
      BEGIN
        SELECT RAISE(ABORT, 'falha controlada na versão v9');
      END
    `);

    await assert.rejects(() => garantirSchemaCozinha(db), /falha controlada na versão v9/);
    assert.equal((await get(db, `
      SELECT valor FROM cozinha_schema_meta WHERE chave='schema_version'
    `)).valor, '8');
    assert.equal(await get(db, `
      SELECT 1 AS existe FROM sqlite_master
      WHERE type='table' AND name='cozinha_turno_relatorios'
    `), null);
    assert.equal(await get(db, `
      SELECT 1 AS existe FROM sqlite_master
      WHERE type='index' AND name='ux_cozinha_turnos_id_contexto'
    `), null);
    assert.equal(await get(db, `
      SELECT 1 AS existe FROM pragma_table_info('cozinha_turnos')
      WHERE name='configuracoes_snapshot_json'
    `), null);
    assert.equal((await get(db, 'PRAGMA integrity_check')).integrity_check, 'ok');

    await run(db, 'DROP TRIGGER bloquear_versao_v9_teste');
    const migracao = await garantirSchemaCozinha(db);
    assert.equal(migracao.versao, 9);
    assert.equal(migracao.migracao_v8_v9.migrado, true);
    await close(db);
    await close(db);
  });

  it('autoriza a gestão somente para gerente e super administrador na unidade permitida', async () => {
    const db = await openDb();
    const c = await preparar(db);
    const gerente = await Turno.exigirAcessoGerencial({ operadorId: c.gerente, unidadeId: c.ua }, { db });
    const superAdmin = await Turno.exigirAcessoGerencial({ operadorId: c.superAdmin, unidadeId: c.ub }, { db });
    assert.equal(gerente.unidadeId, c.ua);
    assert.equal(superAdmin.unidadeId, c.ub);
    for (const operadorId of [c.admin, c.cozinheiro, c.garcom]) {
      await assert.rejects(
        () => Turno.exigirAcessoGerencial({ operadorId, unidadeId: c.ua }, { db }),
        err => err.codigo === 'GESTAO_COZINHA_SEM_AUTORIZACAO'
      );
    }
    await assert.rejects(
      () => Turno.exigirAcessoGerencial({ operadorId: c.gerente, unidadeId: c.ub }, { db }),
      err => err.codigo === 'UNIDADE_SEM_AUTORIZACAO'
    );
    await assert.rejects(
      () => Turno.abrirTurno({ empresaId: c.emp1, unidadeId: c.ua, operadorId: c.op }, { db }),
      err => err.codigo === 'GESTAO_COZINHA_SEM_AUTORIZACAO'
    );
    await close(db);
  });
});
