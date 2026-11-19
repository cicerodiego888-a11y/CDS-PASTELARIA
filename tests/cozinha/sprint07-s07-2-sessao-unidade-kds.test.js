/**
 * Sprint 07 · S07-2 — Seleção segura de unidade operacional no KDS.
 * Banco temporário. Sem banco oficial. Sem impressão / SEFAZ / pagamentos.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-2-sessao-unidade-kds.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-2-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-2-sessao';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../backend/utils/cozinhaSchema');
const { garantirTabelaOperadorUnidades } = require('../../backend/services/cozinha/cozinhaAuthUnidade');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const CozinhaSessaoUnidade = require('../../backend/services/cozinha/CozinhaSessaoUnidadeService');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const { verificarToken } = require('../../backend/middleware/auth');
const { exigirRecurso } = require('../../backend/middleware/validarRecursoImplantacao');
const configService = require('../../backend/services/configuracaoService');
const kds = require('../../frontend/erp/js/cozinha-kds.js');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}
function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (e) => (e ? reject(e) : resolve(db)));
      });
    });
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function prepararBase(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'operador',
      perfil TEXT DEFAULT 'USUARIO',
      ativo INTEGER DEFAULT 1,
      nome TEXT
    )
  `);
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaCozinha(db);
  await garantirTabelaOperadorUnidades(db);

  const emp1 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11111111000111', 'Empresa 1', 'E1', 1)
  `);
  const emp2 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('22222222000122', 'Empresa 2', 'E2', 1)
  `);

  const op = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('op_s07_2', 'hash', 'operador', 'USUARIO', 1, 'Operador')
  `);
  const admin = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('admin_s07_2', 'hash', 'admin', 'ADMIN', 1, 'Admin')
  `);
  const opSemVinculo = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('op_sem_vinculo', 'hash', 'operador', 'USUARIO', 1, 'Sem vínculo')
  `);

  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
  `, [op.lastID, emp1.lastID]);
  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
  `, [admin.lastID, emp1.lastID]);
  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
  `, [opSemVinculo.lastID, emp1.lastID]);

  const unA = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UA', 1)
  `, [emp1.lastID]);
  const unB = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UB', 1)
  `, [emp1.lastID]);
  const unOutraEmp = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UX', 1)
  `, [emp2.lastID]);
  const unInativa = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UI', 0)
  `, [emp1.lastID]);

  await run(db, `
    INSERT INTO cozinha_operador_unidades (empresa_id, operador_id, unidade_id, ativo)
    VALUES (?, ?, ?, 1)
  `, [emp1.lastID, op.lastID, unA.lastID]);

  return {
    emp1: emp1.lastID,
    emp2: emp2.lastID,
    opId: op.lastID,
    adminId: admin.lastID,
    opSemVinculoId: opSemVinculo.lastID,
    unA: unA.lastID,
    unB: unB.lastID,
    unOutraEmp: unOutraEmp.lastID,
    unInativa: unInativa.lastID
  };
}

function userOp(ctx) {
  return { id: ctx.opId, username: 'op_s07_2', role: 'operador', perfil: 'USUARIO', permissoes: [] };
}
function userAdmin(ctx) {
  return { id: ctx.adminId, username: 'admin_s07_2', role: 'admin', perfil: 'ADMIN', permissoes: [] };
}

describe('S07-2 — serviço listagem/seleção (memória)', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('B) listagem retorna somente unidades ativas autorizadas do operador', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userOp(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.equal(out.success, true);
    assert.deepEqual(out.unidades.map((u) => u.codigo).sort(), ['UA']);
    assert.ok(!out.unidades.some((u) => u.id === ctx.unB));
    assert.ok(!out.unidades.some((u) => u.id === ctx.unOutraEmp));
    assert.ok(!out.unidades.some((u) => u.id === ctx.unInativa));
    await close(db);
  });

  it('C) administrador operacional recebe unidades ativas da empresa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    const codigos = out.unidades.map((u) => u.codigo).sort();
    assert.deepEqual(codigos, ['UA', 'UB']);
    assert.ok(!out.unidades.some((u) => u.id === ctx.unOutraEmp));
    assert.ok(!out.unidades.some((u) => u.id === ctx.unInativa));
    await close(db);
  });

  it('D) operador comum só vê vínculo ativo', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userOp(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.equal(out.unidades.length, 1);
    assert.equal(out.unidades[0].id, ctx.unA);
    await close(db);
  });

  it('E) unidade de outra empresa não aparece na listagem', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.ok(!out.unidades.some((u) => Number(u.id) === ctx.unOutraEmp));
    await close(db);
  });

  it('F) selecionar unidade de outra empresa é bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaSessaoUnidade.selecionarUnidadeSessao({
        user: userOp(ctx),
        empresaId: ctx.emp1,
        unidadeCozinhaIdRaw: ctx.unOutraEmp,
        tokenAtual: jwt.sign(userOp(ctx), process.env.JWT_SECRET, { expiresIn: '1h' })
      }, { db }),
      (err) => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
        || err.codigo === 'UNIDADE_NAO_AUTORIZADA'
        || err.codigo === 'EMPRESA_NAO_AUTORIZADA'
    );
    await close(db);
  });

  it('G) unidade inexistente é bloqueada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaSessaoUnidade.selecionarUnidadeSessao({
        user: userOp(ctx),
        empresaId: ctx.emp1,
        unidadeCozinhaIdRaw: 999999,
        tokenAtual: jwt.sign(userOp(ctx), process.env.JWT_SECRET, { expiresIn: '1h' })
      }, { db }),
      (err) => err.codigo === 'UNIDADE_INEXISTENTE'
    );
    await close(db);
  });

  it('H) unidade inativa é bloqueada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaSessaoUnidade.selecionarUnidadeSessao({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        unidadeCozinhaIdRaw: ctx.unInativa,
        tokenAtual: jwt.sign(userAdmin(ctx), process.env.JWT_SECRET, { expiresIn: '1h' })
      }, { db }),
      (err) => err.codigo === 'UNIDADE_INATIVA'
    );
    await close(db);
  });

  it('I) operador sem vínculo ativo é bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaSessaoUnidade.selecionarUnidadeSessao({
        user: {
          id: ctx.opSemVinculoId,
          username: 'op_sem_vinculo',
          role: 'operador',
          perfil: 'USUARIO',
          permissoes: []
        },
        empresaId: ctx.emp1,
        unidadeCozinhaIdRaw: ctx.unA,
        tokenAtual: jwt.sign({ id: ctx.opSemVinculoId, role: 'operador' }, process.env.JWT_SECRET, { expiresIn: '1h' })
      }, { db }),
      (err) => err.codigo === 'UNIDADE_NAO_AUTORIZADA'
    );
    await close(db);
  });

  it('J+K) seleção válida emite JWT com unidade; token anterior permanece sem claim', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const tokenAnterior = jwt.sign(
      { ...userOp(ctx), permissoes: ['vendas'] },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    const decodedAntes = jwt.verify(tokenAnterior, process.env.JWT_SECRET);
    assert.equal(decodedAntes.unidade_cozinha_id, undefined);

    const out = await CozinhaSessaoUnidade.selecionarUnidadeSessao({
      user: { ...userOp(ctx), permissoes: ['vendas'] },
      empresaId: ctx.emp1,
      unidadeCozinhaIdRaw: ctx.unA,
      tokenAtual: tokenAnterior
    }, { db });

    assert.equal(out.success, true);
    assert.equal(out.unidade_cozinha_id, ctx.unA);
    const novo = jwt.verify(out.token, process.env.JWT_SECRET);
    assert.equal(novo.unidade_cozinha_id, ctx.unA);
    assert.equal(novo.id, ctx.opId);
    assert.equal(novo.exp, decodedAntes.exp);

    const aindaAntigo = jwt.verify(tokenAnterior, process.env.JWT_SECRET);
    assert.equal(aindaAntigo.unidade_cozinha_id, undefined);
    await close(db);
  });

  it('ausência de vínculos com unidades na empresa → SEM_VINCULO_OPERADOR', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: {
        id: ctx.opSemVinculoId,
        username: 'op_sem_vinculo',
        role: 'operador',
        perfil: 'USUARIO'
      },
      empresaId: ctx.emp1
    }, { db });
    assert.equal(out.success, true);
    assert.equal(out.unidades.length, 0);
    assert.equal(out.admin_operacional, false);
    assert.ok(out.unidades_ativas_empresa >= 1);
    assert.equal(out.codigo, 'SEM_VINCULO_OPERADOR');
    assert.match(out.mensagem || '', /vinculad/i);
    await close(db);
  });

  it('empresa sem unidades ativas → SEM_UNIDADES_CADASTRADAS (admin)', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    // Remove ativas da emp2 (seed tinha UX ativa).
    await run(db, `UPDATE cozinha_unidades SET ativo = 0 WHERE empresa_id = ?`, [ctx.emp2]);
    await run(db, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [ctx.adminId, ctx.emp2]);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userAdmin(ctx),
      empresaId: ctx.emp2
    }, { db });
    assert.equal(out.success, true);
    assert.equal(out.unidades.length, 0);
    assert.equal(out.admin_operacional, true);
    assert.equal(out.unidades_ativas_empresa, 0);
    assert.equal(out.codigo, 'SEM_UNIDADES_CADASTRADAS');
    assert.match(out.mensagem || '', /cadastrad/i);
    await close(db);
  });

  it('perfil operacional (perfil ADMIN) lista ativas sem vínculo', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: {
        id: ctx.opSemVinculoId,
        username: 'op_sem_vinculo',
        role: 'operador',
        perfil: 'ADMIN'
      },
      empresaId: ctx.emp1
    }, { db });
    assert.equal(out.admin_operacional, true);
    const codigos = out.unidades.map((u) => u.codigo).sort();
    assert.deepEqual(codigos, ['UA', 'UB']);
    await close(db);
  });
});

describe('S07-2 — UI seleção KDS', () => {
  it('sem unidade no JWT abre seleção e não auto-escolhe', async () => {
    const chamadas = [];
    const control = kds.criarControlador({
      empresaId: 1,
      empresaRotulo: 'E1',
      lerUnidadeJwt: () => null,
      fetchJson: async (method, path) => {
        chamadas.push({ method, path });
        return {
          success: true,
          unidades: [
            { id: 10, codigo: 'UA' },
            { id: 11, codigo: 'UB' }
          ]
        };
      },
      agendar: () => null,
      cancelar: () => {}
    });
    await control.iniciar();
    assert.equal(control.estado.modo, 'selecao');
    assert.equal(control.estado.unidadeSelecionadaId, null);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].path, '/cozinha/unidades-disponiveis');
    const html = control.html();
    assert.match(html, /Selecione a unidade/);
    assert.match(html, /kds-selecao__codigo[^>]*>UA</);
    assert.match(html, /data-acao="confirmar-unidade"/);
    assert.match(html, /disabled/);
  });

  it('com unidade no JWT abre painel normalmente', async () => {
    const chamadas = [];
    const control = kds.criarControlador({
      empresaId: 1,
      lerUnidadeJwt: () => 10,
      fetchJson: async (method, path) => {
        chamadas.push({ method, path });
        return { success: true, empresa_id: 1, unidade_id: 10, rodadas: [] };
      },
      agendar: () => 1,
      cancelar: () => {}
    });
    await control.iniciar();
    assert.equal(control.estado.modo, 'painel');
    assert.equal(chamadas[0].path.startsWith('/cozinha/preparacao/painel'), true);
  });

  it('confirmação atualiza sessão e carrega painel', async () => {
    const sessoes = [];
    const chamadas = [];
    const fakeToken = jwt.sign(
      { id: 1, unidade_cozinha_id: 10 },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const control = kds.criarControlador({
      empresaId: 1,
      lerUnidadeJwt: () => null,
      aoAtualizarSessao: async (data) => { sessoes.push(data); },
      fetchJson: async (method, path, corpo) => {
        chamadas.push({ method, path, corpo });
        if (path === '/cozinha/unidades-disponiveis') {
          return { success: true, unidades: [{ id: 10, codigo: 'UA' }] };
        }
        if (path === '/cozinha/sessao/unidade') {
          return {
            success: true,
            token: fakeToken,
            unidade_cozinha_id: 10,
            user: { id: 1, unidade_cozinha_id: 10 }
          };
        }
        return { success: true, empresa_id: 1, unidade_id: 10, rodadas: [] };
      },
      agendar: () => 1,
      cancelar: () => {}
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.equal(r.ok, true);
    assert.equal(sessoes.length, 1);
    assert.equal(control.estado.modo, 'painel');
    assert.ok(chamadas.some((c) => c.path === '/cozinha/sessao/unidade' && c.method === 'POST'));
    assert.ok(chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
  });

  it('falha de lista não dispara chamada repetitiva automática', async () => {
    let n = 0;
    const control = kds.criarControlador({
      empresaId: 1,
      lerUnidadeJwt: () => null,
      fetchJson: async () => {
        n += 1;
        const err = new Error('Rede indisponível');
        err.codigo = 'REDE';
        throw err;
      },
      agendar: () => null,
      cancelar: () => {}
    });
    await control.iniciar();
    assert.equal(n, 1);
    assert.equal(control.estado.selecaoFalhaLista, true);
    const r2 = await control.carregarUnidadesDisponiveis();
    assert.equal(r2.ignorada, true);
    assert.equal(n, 1);
    await control.carregarUnidadesDisponiveis({ forcar: true });
    assert.equal(n, 2);
  });

  it('lerUnidadeCozinhaDoToken lê claim do JWT', () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 42 }, process.env.JWT_SECRET);
    assert.equal(kds.lerUnidadeCozinhaDoToken(token), 42);
    assert.equal(kds.lerUnidadeCozinhaDoToken(jwt.sign({ id: 1 }, process.env.JWT_SECRET)), null);
  });
});

describe('S07-2 correção — validação JWT antes de persistir', () => {
  function memoriaStorage(inicial = {}) {
    const map = { ...inicial };
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
      setItem: (k, v) => { map[k] = String(v); },
      removeItem: (k) => { delete map[k]; },
      _dump: () => ({ ...map })
    };
  }

  function montarConfirmacao({ tokenResposta, corpoUnidadeHttp, aoAtualizarSessao, agendar }) {
    const chamadas = [];
    const timers = [];
    const control = kds.criarControlador({
      empresaId: 1,
      lerUnidadeJwt: () => null,
      aoAtualizarSessao,
      fetchJson: async (method, path, corpo) => {
        chamadas.push({ method, path, corpo });
        if (path === '/cozinha/unidades-disponiveis') {
          return { success: true, unidades: [{ id: 10, codigo: 'UA' }] };
        }
        if (path === '/cozinha/sessao/unidade') {
          return {
            success: true,
            token: tokenResposta,
            unidade_cozinha_id: corpoUnidadeHttp != null ? corpoUnidadeHttp : 10,
            user: { id: 1, unidade_cozinha_id: corpoUnidadeHttp != null ? corpoUnidadeHttp : 10 }
          };
        }
        return { success: true, empresa_id: 1, unidade_id: 10, rodadas: [] };
      },
      agendar: (fn, ms) => {
        const t = { fn, ms, ativo: true };
        timers.push(t);
        if (agendar) agendar(t);
        return t;
      },
      cancelar: (t) => { if (t) t.ativo = false; }
    });
    return { control, chamadas, timers };
  }

  it('A) JWT com unidade correta: aceito e persistido', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage();
    const electronCalls = [];
    const globalFake = {
      localStorage: store,
      electronAPI: {
        cozinhaImpressao: {
          estabelecerSessao: async (payload) => {
            electronCalls.push(payload);
            // Contrato real IPC: success explícito (Promise resolve ≠ sucesso).
            return {
              success: true,
              sessao: { empresaId: 1, unidadeId: 10 },
              contexto: null
            };
          }
        }
      }
    };
    const ordem = [];
    const { control, chamadas, timers } = montarConfirmacao({
      tokenResposta: token,
      aoAtualizarSessao: async (data) => {
        ordem.push('persistir');
        await kds.persistirSessao(globalFake, data);
        ordem.push('persistido');
      }
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.equal(r.ok, true);
    assert.equal(control.estado.modo, 'painel');
    assert.equal(store.getItem('token'), token);
    assert.equal(electronCalls.length, 1);
    assert.equal(control.estado.unidadeId, 10);
    assert.ok(chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
    assert.ok(timers.length >= 1);
    assert.deepEqual(ordem, ['persistir', 'persistido']);
  });

  it('B) JWT sem unidade_cozinha_id: rejeitado, sem persistência', async () => {
    const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const persistencias = [];
    const { control, chamadas, timers } = montarConfirmacao({
      tokenResposta: token,
      corpoUnidadeHttp: 10,
      aoAtualizarSessao: async (data) => { persistencias.push(data); }
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.ok(r.erro);
    assert.equal(r.erro.codigo, 'TOKEN_UNIDADE_AUSENTE');
    assert.equal(persistencias.length, 0);
    assert.equal(control.estado.modo, 'selecao');
    assert.ok(!chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
    assert.equal(timers.length, 0);
  });

  it('C) JWT com unidade divergente: rejeitado, sem persistência', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 99 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const persistencias = [];
    const { control, chamadas, timers } = montarConfirmacao({
      tokenResposta: token,
      corpoUnidadeHttp: 10,
      aoAtualizarSessao: async (data) => { persistencias.push(data); }
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.ok(r.erro);
    assert.equal(r.erro.codigo, 'TOKEN_UNIDADE_DIVERGENTE');
    assert.equal(persistencias.length, 0);
    assert.equal(control.estado.modo, 'selecao');
    assert.ok(!chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
    assert.equal(timers.length, 0);
  });

  it('D) HTTP com unidade correta mas JWT sem claim: rejeitada', async () => {
    const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal(kds.lerUnidadeCozinhaDoToken(token), null);
    const persistencias = [];
    const { control } = montarConfirmacao({
      tokenResposta: token,
      corpoUnidadeHttp: 10,
      aoAtualizarSessao: async (data) => { persistencias.push(data); }
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.ok(r.erro);
    assert.equal(r.erro.codigo, 'TOKEN_UNIDADE_AUSENTE');
    assert.equal(persistencias.length, 0);
    assert.equal(control.estado.modo, 'selecao');
  });

  it('E) Falha Electron: tratada sem declarar sessão atualizada', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage({ token: 'token-anterior', user: '{"id":1}' });
    const globalFake = {
      localStorage: store,
      electronAPI: {
        cozinhaImpressao: {
          estabelecerSessao: async () => {
            throw new Error('IPC falhou');
          }
        }
      }
    };
    await assert.rejects(
      () => kds.persistirSessao(globalFake, {
        token,
        user: { id: 1, unidade_cozinha_id: 10 }
      }),
      (err) => err.codigo === 'SESSAO_ELECTRON_FALHA'
    );
    assert.equal(store.getItem('token'), 'token-anterior');
    assert.equal(store.getItem('user'), '{"id":1}');

    const { control, chamadas, timers } = montarConfirmacao({
      tokenResposta: token,
      aoAtualizarSessao: async (data) => kds.persistirSessao(globalFake, data)
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.ok(r.erro);
    assert.equal(r.erro.codigo, 'SESSAO_ELECTRON_FALHA');
    assert.equal(control.estado.modo, 'selecao');
    assert.equal(store.getItem('token'), 'token-anterior');
    assert.ok(!chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
    assert.equal(timers.length, 0);
  });

  it('F) Painel e polling não iniciam antes da persistência bem-sucedida', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    let liberarPersistencia;
    const barreira = new Promise((resolve) => { liberarPersistencia = resolve; });
    const ordem = [];
    const { control, chamadas, timers } = montarConfirmacao({
      tokenResposta: token,
      aoAtualizarSessao: async () => {
        ordem.push('persistindo');
        await barreira;
        ordem.push('persistido');
      }
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const promessa = control.confirmarUnidade();
    await new Promise((r) => setImmediate(r));
    assert.equal(control.estado.modo, 'selecao');
    assert.ok(!chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
    assert.equal(timers.length, 0);
    liberarPersistencia();
    const r = await promessa;
    assert.equal(r.ok, true);
    assert.deepEqual(ordem, ['persistindo', 'persistido']);
    assert.equal(control.estado.modo, 'painel');
    assert.ok(chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
    assert.ok(timers.length >= 1);
  });

  it('exigirUnidadeNoJwt rejeita corpo HTTP como substituto', () => {
    const tokenSem = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
    assert.throws(
      () => kds.exigirUnidadeNoJwt(tokenSem, 10),
      (err) => err.codigo === 'TOKEN_UNIDADE_AUSENTE'
    );
    const tokenOk = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET);
    assert.equal(kds.exigirUnidadeNoJwt(tokenOk, 10), 10);
  });

  it('persistência ausente: não avança para painel', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const { control, chamadas, timers } = montarConfirmacao({
      tokenResposta: token,
      aoAtualizarSessao: undefined
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.ok(r.erro);
    assert.equal(r.erro.codigo, 'SESSAO_PERSISTENCIA_OBRIGATORIA');
    assert.equal(control.estado.modo, 'selecao');
    assert.ok(!chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
    assert.equal(timers.length, 0);
  });

  it('Electron resolve com success:false → falha + rollback', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage({ token: 'tok-ant', user: '{"id":9}' });
    const globalFake = {
      localStorage: store,
      electronAPI: {
        cozinhaImpressao: {
          // Contrato real: resolve sem rejeitar, success=false.
          estabelecerSessao: async () => ({
            success: false,
            codigo: 'IMPRESSAO_SESSAO_SEM_UNIDADE',
            erro: 'Sessão sem unidade de cozinha autenticada.'
          })
        }
      }
    };
    await assert.rejects(
      () => kds.persistirSessao(globalFake, {
        token,
        user: { id: 1, unidade_cozinha_id: 10 }
      }),
      (err) => err.codigo === 'IMPRESSAO_SESSAO_SEM_UNIDADE'
        || err.codigo === 'SESSAO_ELECTRON_FALHA'
    );
    assert.equal(store.getItem('token'), 'tok-ant');
    assert.equal(store.getItem('user'), '{"id":9}');

    const { control, timers } = montarConfirmacao({
      tokenResposta: token,
      aoAtualizarSessao: async (data) => kds.persistirSessao(globalFake, data)
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.ok(r.erro);
    assert.equal(control.estado.modo, 'selecao');
    assert.equal(timers.length, 0);
  });

  it('falha na gravação do token: rollback e sem painel', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage({ token: 'tok-ant', user: '{"id":1}' });
    const originalSet = store.setItem.bind(store);
    store.setItem = (k, v) => {
      if (k === 'token' && v === token) throw new Error('quota token');
      return originalSet(k, v);
    };
    await assert.rejects(
      () => kds.persistirSessao({ localStorage: store }, {
        token,
        user: { id: 1, unidade_cozinha_id: 10 }
      }),
      (err) => err.codigo === 'SESSAO_PERSISTENCIA_FALHA'
        || err.codigo === 'SESSAO_ROLLBACK_FALHA'
    );
    assert.equal(store.getItem('token'), 'tok-ant');
    assert.equal(store.getItem('user'), '{"id":1}');
  });

  it('falha na gravação do usuário após token: rollback integral', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage({ token: 'tok-ant', user: '{"id":1}' });
    const originalSet = store.setItem.bind(store);
    store.setItem = (k, v) => {
      if (k === 'user' && String(v).includes('"unidade_cozinha_id":10')) {
        throw new Error('quota user');
      }
      return originalSet(k, v);
    };
    await assert.rejects(
      () => kds.persistirSessao({ localStorage: store }, {
        token,
        user: { id: 1, unidade_cozinha_id: 10 }
      }),
      (err) => err.codigo === 'SESSAO_PERSISTENCIA_FALHA'
        || err.codigo === 'SESSAO_ROLLBACK_FALHA'
    );
    // Não pode ficar token novo + user antigo.
    assert.equal(store.getItem('token'), 'tok-ant');
    assert.equal(store.getItem('user'), '{"id":1}');
  });

  it('rollback preserva token e usuário anteriores', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage({ token: 'prev-token', user: '{"id":7,"nome":"Prev"}' });
    const globalFake = {
      localStorage: store,
      electronAPI: {
        cozinhaImpressao: {
          estabelecerSessao: async () => ({
            success: false,
            codigo: 'IMPRESSAO_SESSAO_TOKEN_INVALIDO',
            erro: 'Token de sessão inválido.'
          })
        }
      }
    };
    await assert.rejects(
      () => kds.persistirSessao(globalFake, {
        token,
        user: { id: 1, unidade_cozinha_id: 10 }
      }),
      (err) => !!err.codigo
    );
    assert.equal(store.getItem('token'), 'prev-token');
    assert.equal(store.getItem('user'), '{"id":7,"nome":"Prev"}');
  });

  it('interpretarRetornoEstabelecerSessao exige success:true', () => {
    assert.doesNotThrow(() => kds.interpretarRetornoEstabelecerSessao({
      success: true,
      sessao: { empresaId: 1, unidadeId: 2 }
    }));
    assert.throws(
      () => kds.interpretarRetornoEstabelecerSessao({
        success: false,
        codigo: 'IMPRESSAO_SESSAO_ERRO',
        erro: 'x'
      }),
      (err) => err.codigo === 'IMPRESSAO_SESSAO_ERRO'
    );
    assert.throws(
      () => kds.interpretarRetornoEstabelecerSessao({ ok: true }),
      (err) => err.codigo === 'SESSAO_ELECTRON_FALHA'
    );
  });

  it('resposta sem user: rejeitada, sem persistir token', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage({ token: 'tok-ant', user: '{"id":1,"nome":"Antigo"}' });
    await assert.rejects(
      () => kds.persistirSessao({ localStorage: store }, { token }),
      (err) => err.codigo === 'SESSAO_USER_AUSENTE'
    );
    assert.equal(store.getItem('token'), 'tok-ant');
    assert.equal(store.getItem('user'), '{"id":1,"nome":"Antigo"}');

    const { control, timers } = montarConfirmacao({
      tokenResposta: token,
      aoAtualizarSessao: async (data) => {
        // Simula contrato quebrado sem user.
        delete data.user;
        return kds.persistirSessao({ localStorage: store }, data);
      }
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.ok(r.erro);
    assert.equal(r.erro.codigo, 'SESSAO_USER_AUSENTE');
    assert.equal(control.estado.modo, 'selecao');
    assert.equal(store.getItem('token'), 'tok-ant');
    assert.equal(timers.length, 0);
  });

  it('não permanece usuário antigo associado ao token novo', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage({
      token: 'tok-antigo',
      user: '{"id":99,"nome":"UsuarioAntigo","unidade_cozinha_id":null}'
    });
    const userNovo = { id: 1, nome: 'Op', unidade_cozinha_id: 10 };
    await kds.persistirSessao({ localStorage: store }, { token, user: userNovo });
    assert.equal(store.getItem('token'), token);
    assert.equal(store.getItem('user'), JSON.stringify(userNovo));
    assert.doesNotMatch(store.getItem('user'), /UsuarioAntigo/);
    assert.match(store.getItem('user'), /"unidade_cozinha_id":10/);
  });

  it('falha na atualização do user após token: rollback integral', async () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 10 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const store = memoriaStorage({
      token: 'tok-ant',
      user: '{"id":5,"nome":"Prev"}'
    });
    const originalSet = store.setItem.bind(store);
    let gravouTokenNovo = false;
    store.setItem = (k, v) => {
      if (k === 'token' && v === token) {
        gravouTokenNovo = true;
        return originalSet(k, v);
      }
      if (k === 'user' && gravouTokenNovo) {
        throw new Error('falha ao atualizar user');
      }
      return originalSet(k, v);
    };
    await assert.rejects(
      () => kds.persistirSessao({ localStorage: store }, {
        token,
        user: { id: 1, unidade_cozinha_id: 10 }
      }),
      (err) => err.codigo === 'SESSAO_PERSISTENCIA_FALHA'
        || err.codigo === 'SESSAO_ROLLBACK_FALHA'
    );
    assert.equal(store.getItem('token'), 'tok-ant');
    assert.equal(store.getItem('user'), '{"id":5,"nome":"Prev"}');
  });
});

describe('S07-2 — schema Cozinha / cozinha_notificacoes', () => {
  it('garantirSchema sequencial cria cozinha_notificacoes e marca operacional', async () => {
    const db = await openMem();
    marcarCozinhaOperacional(false);
    const out = await garantirSchemaCozinha(db);
    assert.equal(out.operacional, true);
    assert.equal(isCozinhaOperacional(), true);
    const row = await get(db, `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='cozinha_notificacoes'
    `);
    assert.ok(row, 'cozinha_notificacoes deve existir após garantirSchemaCozinha');
    const idx = await get(db, `
      SELECT name FROM sqlite_master
      WHERE type='index' AND name='ux_cozinha_notificacoes_evento'
    `);
    assert.ok(idx, 'índice de cozinha_notificacoes deve existir');
    await close(db);
  });

  it('falha ao indexar notificações deixa Cozinha NÃO operacional', async () => {
    const db = await openMem();
    marcarCozinhaOperacional(false);
    await garantirSchemaCozinha(db);
    assert.equal(isCozinhaOperacional(), true);

    // Simula condição observada nos logs: índice sem tabela (DROP concorrente).
    await run(db, 'DROP TABLE IF EXISTS cozinha_notificacoes');
    await assert.rejects(
      () => run(db, `
        CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_notificacoes_evento
        ON cozinha_notificacoes(evento_chave)
      `),
      (err) => /no such table:\s*(main\.)?cozinha_notificacoes/i.test(String(err.message))
    );

    // Política: não declarar operacional enquanto a falha persistir.
    marcarCozinhaOperacional(false, Object.assign(
      new Error('SQLITE_ERROR: no such table: main.cozinha_notificacoes'),
      { codigo: 'COZINHA_SCHEMA_FALHA' }
    ));
    assert.equal(isCozinhaOperacional(), false);
    const st = getCozinhaSchemaStatus();
    assert.equal(st.operacional, false);
    assert.match(String(st.erro && st.erro.mensagem || st.erro), /cozinha_notificacoes/);

    // Recuperação somente via garantirSchema bem-sucedido (não ocultar).
    const recovery = await garantirSchemaCozinha(db);
    assert.equal(recovery.operacional, true);
    assert.equal(isCozinhaOperacional(), true);
    const row = await get(db, `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='cozinha_notificacoes'
    `);
    assert.ok(row);
    await close(db);
  });

  it('origem da falha: CREATE INDEX após DROP concorrente da tabela', async () => {
    // Evidência de sequência (não altera schema de produção):
    // 1) recriarSchemaVazioSeNecessario faz DROP TABLE de TABELAS_COZINHA
    // 2) criarTabelasCozinha recria cozinha_notificacoes e em seguida os índices
    // 3) segunda chamada concorrente de garantirSchemaCozinha pode DROPar a tabela
    //    enquanto a primeira ainda executa CREATE INDEX → SQLITE_ERROR no such table
    const schemaSrc = fs.readFileSync(
      path.join(__dirname, '../../backend/utils/cozinhaSchema.js'),
      'utf8'
    );
    assert.match(schemaSrc, /CREATE TABLE IF NOT EXISTS cozinha_notificacoes/);
    assert.match(schemaSrc, /ux_cozinha_notificacoes_evento/);
    assert.match(schemaSrc, /DROP TABLE IF EXISTS \$\{t\}|DROP TABLE IF EXISTS/);
    assert.match(schemaSrc, /marcarCozinhaOperacional\(false/);
  });
});

describe('S07-2 — HTTP (listagem, seleção, painel, login)', () => {
  let server;
  let baseUrl;
  let recursoOriginal;
  let dbHttp;
  let empresaId;
  let empresaOutraId;
  let unidadeId;
  let unidadeB;
  let unidadeOutraEmp;
  let unidadeInativa;
  let operadorId;
  let adminId;
  let opSemVinculoId;
  let passwordPlain;
  let tokenSemUnidade;
  let tokenAdminSemUnidade;

  function requestJson(method, urlPath, { token, headers = {}, body, empresaHeader } = {}) {
    const u = new URL(urlPath, baseUrl);
    const emp = empresaHeader != null ? empresaHeader : empresaId;
    const payload = body != null ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(emp != null ? { 'X-Empresa-Id': String(emp) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch (_e) { json = { raw }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  before(async () => {
    dbHttp = require('../../backend/database');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DB timeout')), 60000);
      dbHttp.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    // Aguarda estabilização do boot (evita corrida com DROP/CREATE de cozinha_notificacoes).
    for (let i = 0; i < 100; i += 1) {
      const row = await get(dbHttp, `
        SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_notificacoes'
      `);
      const st = getCozinhaSchemaStatus();
      if (row && row.name === 'cozinha_notificacoes' && (st.operacional || st.erro)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // Uma única garantia sequencial — não marcar operacional se falhar.
    let schemaOut = null;
    let ultimoErroSchema = null;
    for (let tentativa = 0; tentativa < 8; tentativa += 1) {
      try {
        schemaOut = await garantirSchemaCozinha(dbHttp);
        ultimoErroSchema = null;
        break;
      } catch (err) {
        ultimoErroSchema = err;
        // Se ainda há corrida de boot, espera e tenta de novo.
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!schemaOut || !schemaOut.operacional) {
      assert.equal(isCozinhaOperacional(), false);
      throw ultimoErroSchema || new Error('Schema Cozinha não operacional após tentativas.');
    }
    await garantirTabelaOperadorUnidades(dbHttp);
    assert.equal(isCozinhaOperacional(), true);
    const notif = await get(dbHttp, `
      SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_notificacoes'
    `);
    assert.ok(notif, 'cozinha_notificacoes obrigatória antes dos testes HTTP');

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    passwordPlain = 'senha-s07-2';
    const hash = await bcrypt.hash(passwordPlain, 4);

    const op = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_s07_2_http', ?, 'operador', 'USUARIO', 1, 'Op HTTP')
    `, [hash]);
    operadorId = op.lastID;
    const adm = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_s07_2_http', ?, 'admin', 'ADMIN', 1, 'Admin HTTP')
    `, [hash]);
    adminId = adm.lastID;
    const opSv = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_s07_2_sv', ?, 'operador', 'USUARIO', 1, 'Sem vínculo')
    `, [hash]);
    opSemVinculoId = opSv.lastID;

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('55667788000199', 'Empresa S07-2', 'S07-2', 1)
    `);
    empresaId = emp.lastID;
    const emp2 = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('55667788000270', 'Empresa S07-2 B', 'S07-2B', 1)
    `);
    empresaOutraId = emp2.lastID;

    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [operadorId, empresaId]);
    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [adminId, empresaId]);
    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [opSemVinculoId, empresaId]);

    const un = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'S072-A', 0, 1)
    `, [empresaId]);
    unidadeId = un.lastID;
    const unB = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'S072-B', 0, 1)
    `, [empresaId]);
    unidadeB = unB.lastID;
    const unX = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'S072-X', 0, 1)
    `, [empresaOutraId]);
    unidadeOutraEmp = unX.lastID;
    const unI = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'S072-I', 0, 0)
    `, [empresaId]);
    unidadeInativa = unI.lastID;

    await run(dbHttp, `
      INSERT INTO cozinha_operador_unidades (empresa_id, operador_id, unidade_id, ativo)
      VALUES (?, ?, ?, 1)
    `, [empresaId, operadorId, unidadeId]);

    // Pedido mínimo para painel contextualizado.
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS categorias (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL)
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        tipo_operacional TEXT DEFAULT 'COMERCIAL',
        comercializavel INTEGER DEFAULT 0,
        categoria_id INTEGER,
        utiliza_ficha_tecnica INTEGER DEFAULT 0,
        permite_personalizacao_ingredientes INTEGER DEFAULT 0,
        preco_venda REAL DEFAULT 0
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS ficha_tecnica (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        produto_id INTEGER NOT NULL,
        ativo INTEGER DEFAULT 1
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS mesas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER NOT NULL,
        numero INTEGER NOT NULL,
        ativo INTEGER NOT NULL DEFAULT 1
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS mesa_atendimentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER NOT NULL,
        mesa_id INTEGER NOT NULL,
        estado TEXT NOT NULL,
        operador_abertura_id INTEGER NOT NULL DEFAULT 1,
        aberto_em TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT,
        status TEXT,
        empresa_id INTEGER,
        mesa_id INTEGER,
        mesa_atendimento_id INTEGER,
        total REAL,
        data_pedido TEXT
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS pedidos_itens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pedido_id INTEGER,
        produto_id INTEGER,
        quantidade REAL,
        preco_unitario REAL,
        subtotal REAL,
        classificacao_operacional_snapshot TEXT,
        produto_nome_snapshot TEXT,
        observacao TEXT
      )
    `);

    const mesa = await run(dbHttp, `
      INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 7, 1)
    `, [empresaId]);
    const at = await run(dbHttp, `
      INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
      VALUES (?, ?, 'OCUPADA', ?)
    `, [empresaId, mesa.lastID, operadorId]);
    const cat = await run(dbHttp, `INSERT INTO categorias (nome) VALUES ('S072')`);
    const prod = await run(dbHttp, `
      INSERT INTO produtos (
        nome, tipo_operacional, comercializavel, categoria_id, utiliza_ficha_tecnica, preco_venda
      ) VALUES ('Pastel S072', 'COMERCIAL', 0, ?, 1, 0)
    `, [cat.lastID]);
    await run(dbHttp, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [prod.lastID]);
    const ped = await run(dbHttp, `
      INSERT INTO pedidos (
        codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total, data_pedido
      ) VALUES ('PS072', 'PEDIDO', ?, ?, ?, 10, date('now'))
    `, [empresaId, mesa.lastID, at.lastID]);
    const pit = await run(dbHttp, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal,
        classificacao_operacional_snapshot, produto_nome_snapshot
      ) VALUES (?, ?, 1, 9.99, 9.99, 'PASTEL', 'Pastel S072')
    `, [ped.lastID, prod.lastID]);
    const cmd = await run(dbHttp, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, 1, ?, ?)
    `, [empresaId, at.lastID, ped.lastID, operadorId]);
    await CozinhaDespacho.despacharLote({
      empresaId,
      operadorId,
      idempotencyKey: 'http-s07-2-despacho',
      unidade_id: unidadeId,
      mesa_id: mesa.lastID,
      atendimento_id: at.lastID,
      itens: [{
        pedido_id: ped.lastID,
        pedido_item_id: pit.lastID,
        comanda_id: cmd.lastID,
        qty_solicitada: 1
      }]
    }, { db: dbHttp });

    tokenSemUnidade = jwt.sign(
      { id: operadorId, username: 'op_s07_2_http', role: 'operador', perfil: 'USUARIO', permissoes: [] },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    tokenAdminSemUnidade = jwt.sign(
      { id: adminId, username: 'admin_s07_2_http', role: 'admin', perfil: 'ADMIN', permissoes: [] },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    const authRouter = require('../../backend/rotas/auth').router;
    const cozinhaRoutes = require('../../backend/rotas/cozinha');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((r) => server.close(() => r()));
  });

  it('A) login normal sem unidade continua funcionando', async () => {
    const r = await requestJson('POST', '/api/auth/login', {
      body: {
        username: 'op_s07_2_http',
        password: passwordPlain,
        empresa_id: empresaId
      },
      empresaHeader: null
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
    assert.equal(decoded.unidade_cozinha_id, null);
    assert.equal(decoded.id, operadorId);
  });

  it('HTTP B/D) listagem operador: só vínculo ativo', async () => {
    const r = await requestJson('GET', '/api/cozinha/unidades-disponiveis', {
      token: tokenSemUnidade
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.success, true);
    assert.equal(r.body.unidades.length, 1);
    assert.equal(r.body.unidades[0].id, unidadeId);
    assert.ok(!r.body.unidades.some((u) => u.id === unidadeB));
    assert.ok(!r.body.unidades.some((u) => u.id === unidadeOutraEmp));
  });

  it('HTTP C) listagem admin: unidades ativas da empresa', async () => {
    const r = await requestJson('GET', '/api/cozinha/unidades-disponiveis', {
      token: tokenAdminSemUnidade
    });
    assert.equal(r.status, 200);
    const ids = r.body.unidades.map((u) => u.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [unidadeId, unidadeB].sort((a, b) => a - b));
    assert.ok(!ids.includes(unidadeInativa));
    assert.ok(!ids.includes(unidadeOutraEmp));
  });

  it('HTTP F) seleção de outra empresa bloqueada', async () => {
    const r = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token: tokenSemUnidade,
      body: { unidade_cozinha_id: unidadeOutraEmp }
    });
    assert.ok(r.status >= 400);
    assert.ok(r.body.codigo);
    assert.ok(!r.body.token);
  });

  it('HTTP G) unidade inexistente bloqueada', async () => {
    const r = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token: tokenSemUnidade,
      body: { unidade_cozinha_id: 999999 }
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'UNIDADE_INEXISTENTE');
  });

  it('HTTP H) unidade inativa bloqueada', async () => {
    const r = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token: tokenAdminSemUnidade,
      body: { unidade_cozinha_id: unidadeInativa }
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'UNIDADE_INATIVA');
  });

  it('HTTP I) operador sem vínculo bloqueado', async () => {
    const token = jwt.sign(
      { id: opSemVinculoId, role: 'operador', perfil: 'USUARIO' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const r = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token,
      body: { unidade_cozinha_id: unidadeId }
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'UNIDADE_NAO_AUTORIZADA');
  });

  it('HTTP J/L) seleção válida → JWT → painel OK', async () => {
    const sel = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token: tokenSemUnidade,
      body: { unidade_cozinha_id: unidadeId }
    });
    assert.equal(sel.status, 200, JSON.stringify(sel.body));
    assert.ok(sel.body.token);
    assert.equal(sel.body.unidade_cozinha_id, unidadeId);
    // Contrato: user sempre presente em seleção válida (persistirSessao exige).
    assert.ok(sel.body.user && typeof sel.body.user === 'object');
    assert.equal(sel.body.user.id, operadorId);
    assert.equal(sel.body.user.usuario_id, operadorId);
    assert.equal(sel.body.user.unidade_cozinha_id, unidadeId);
    assert.equal(sel.body.user.username, 'op_s07_2_http');
    assert.equal(sel.body.user.role, 'operador');
    assert.ok(Array.isArray(sel.body.user.permissoes));
    const decoded = jwt.verify(sel.body.token, process.env.JWT_SECRET);
    assert.equal(decoded.unidade_cozinha_id, unidadeId);
    assert.equal(decoded.unidade_cozinha_id, sel.body.user.unidade_cozinha_id);

    const painel = await requestJson('GET', '/api/cozinha/preparacao/painel', {
      token: sel.body.token
    });
    assert.equal(painel.status, 200, JSON.stringify(painel.body));
    assert.equal(painel.body.unidade_id, unidadeId);
    assert.equal(painel.body.empresa_id, empresaId);
    assert.ok(painel.body.rodadas.length >= 1);
  });

  it('HTTP K/M) JWT anterior sem unidade → UNIDADE_OBRIGATORIA', async () => {
    const aindaAntigo = jwt.verify(tokenSemUnidade, process.env.JWT_SECRET);
    assert.equal(aindaAntigo.unidade_cozinha_id, undefined);
    const r = await requestJson('GET', '/api/cozinha/preparacao/painel', {
      token: tokenSemUnidade
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'UNIDADE_OBRIGATORIA');
  });

  it('HTTP N) query manipulada não substitui unidade do JWT', async () => {
    const token = jwt.sign(
      {
        id: operadorId,
        role: 'operador',
        perfil: 'USUARIO',
        unidade_cozinha_id: unidadeId
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const r = await requestJson(
      'GET',
      `/api/cozinha/preparacao/painel?unidade_id=${unidadeB}`,
      { token }
    );
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'UNIDADE_ISOLAMENTO');
  });

  it('evidência isolamento: DB_DIR temporário e flags ativas', () => {
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.ok(String(process.env.DB_DIR).includes('cds-cozinha-s07-2-'));
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB, undefined);
  });
});
