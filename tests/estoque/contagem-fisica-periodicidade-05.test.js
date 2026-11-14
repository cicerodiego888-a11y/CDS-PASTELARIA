/**
 * SPRINT CDS-ESTOQUE-CONTAGEM-PERIODICIDADE-05
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/estoque/contagem-fisica-periodicidade-05.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-contagem-period-05-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  PERIODICIDADE,
  STATUS,
  INTERVALOS,
  obterPeriodicidade,
  salvarPeriodicidade,
  obterStatusPeriodicidade,
  listarHistoricoContagens,
  calcularStatus,
  adicionarDias,
  paraDataLocalIso,
  diffDiasCalendario
} = require('../../backend/services/estoque/EstoqueContagemPeriodicidadeService');
const { garantirSchemaEstoqueContagemPeriodicidadeAsync } = require('../../backend/services/estoque/estoqueContagemPeriodicidadeSchema');
const { garantirSchemaEstoqueContagemFisicaAsync } = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const { exigirSnapshotItensOficiais } = require('../../backend/services/estoque/contagemFisicaSnapshotOficial');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  garantirSchemaEmpresasConfiguracaoEstoqueAsync
} = require('../../backend/services/empresas/empresasConfiguracaoEstoqueSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EmpresaModoEstoqueService = require('../../backend/services/empresas/EmpresaModoEstoqueService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_C = '27865757000102';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup(n = 2) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await garantirSchemaEstoqueContagemPeriodicidadeAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      motivo TEXT,
      ajuste_fiscal REAL,
      ajuste_nao_fiscal REAL,
      saldo_fiscal_antes REAL,
      saldo_fiscal_depois REAL,
      saldo_nao_fiscal_antes REAL,
      saldo_nao_fiscal_depois REAL,
      estoque_total_antes REAL,
      estoque_total_depois REAL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const cnpjs = [CNPJ_A, CNPJ_B, CNPJ_C];
  const empresas = [];
  for (let i = 0; i < n; i += 1) {
    empresas.push(await EmpresaService.criarEmpresa({
      cnpj: cnpjs[i],
      razao_social: `Emp ${i}`
    }, { db }));
  }
  return { db, empresas, empresaA: empresas[0], empresaB: empresas[1] };
}

async function produtoComSaldo(db, empresaId, saldoF = 10, saldoNf = 0) {
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('Item', ?, ?, ?)`,
    [saldoF, saldoNf, saldoF + saldoNf]
  );
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID,
    empresaId,
    saldo_fiscal: saldoF,
    saldo_nao_fiscal: saldoNf,
    estoque_atual: saldoF + saldoNf
  }, { db });
  return p.lastID;
}

async function confirmarContagem(db, empresaId, produtoId, qF, snapF, chave) {
  const itens = exigirSnapshotItensOficiais([{
    produto_id: produtoId,
    quantidade_fiscal_contada: qF,
    quantidade_nao_fiscal_contada: 0,
    saldo_fiscal_esperado: snapF,
    saldo_nao_fiscal_esperado: 0
  }]);
  return EstoqueContagemFisicaService.registrarContagemFisica({
    db,
    empresaId,
    itens,
    usuarioId: 1,
    usuarioNome: 'op',
    chaveIdempotencia: chave
  });
}

describe('CDS-ESTOQUE-CONTAGEM-PERIODICIDADE-05', { concurrency: false }, () => {
  it('01 configuração semanal', async () => {
    const { db, empresaA } = await setup();
    const cfg = await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'SEMANAL' });
    assert.equal(cfg.periodicidade, PERIODICIDADE.SEMANAL);
    assert.equal(cfg.intervalo_dias, 7);
    await closeDb(db);
  });

  it('02 configuração quinzenal', async () => {
    const { db, empresaA } = await setup();
    const cfg = await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'QUINZENAL' });
    assert.equal(cfg.periodicidade, PERIODICIDADE.QUINZENAL);
    assert.equal(cfg.intervalo_dias, 15);
    await closeDb(db);
  });

  it('03 configuração sob demanda', async () => {
    const { db, empresaA } = await setup();
    const cfg = await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'SOB_DEMANDA' });
    assert.equal(cfg.periodicidade, PERIODICIDADE.SOB_DEMANDA);
    assert.equal(cfg.intervalo_dias, null);
    await closeDb(db);
  });

  it('04 configuração independente por empresa', async () => {
    const { db, empresaA, empresaB } = await setup(2);
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'SEMANAL' });
    await salvarPeriodicidade(db, empresaB.id, { periodicidade: 'QUINZENAL' });
    assert.equal((await obterPeriodicidade(db, empresaA.id)).periodicidade, 'SEMANAL');
    assert.equal((await obterPeriodicidade(db, empresaB.id)).periodicidade, 'QUINZENAL');
    await closeDb(db);
  });

  it('05 empresa sem configuração inicial → SEMANAL padrão', async () => {
    const { db, empresaA } = await setup(1);
    const cfg = await obterPeriodicidade(db, empresaA.id);
    assert.equal(cfg.periodicidade, 'SEMANAL');
    assert.equal(cfg.origem, 'PADRAO_INICIAL');
    assert.equal(cfg.intervalo_dias, 7);
    await closeDb(db);
  });

  it('06 empresa sem histórico → PRIMEIRA_CONTAGEM_PENDENTE', async () => {
    const { db, empresaA } = await setup(1);
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'SEMANAL' });
    const st = await obterStatusPeriodicidade(db, empresaA.id);
    assert.equal(st.status, STATUS.PRIMEIRA_CONTAGEM_PENDENTE);
    assert.equal(st.contagem_permitida, true);
    await closeDb(db);
  });

  it('07 contagem confirmada atualiza última contagem', async () => {
    const { db, empresaA } = await setup(1);
    const pid = await produtoComSaldo(db, empresaA.id, 10, 0);
    await confirmarContagem(db, empresaA.id, pid, 9, 10, 'c7');
    const st = await obterStatusPeriodicidade(db, empresaA.id);
    assert.ok(st.ultima_contagem);
    assert.ok(st.ultima_contagem.id > 0);
    assert.equal(st.ultima_contagem.quantidade_produtos, 1);
    await closeDb(db);
  });

  it('08 preview não atualiza última contagem', async () => {
    const { db, empresaA } = await setup(1);
    const pid = await produtoComSaldo(db, empresaA.id, 10, 0);
    await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 8,
      quantidade_nao_fiscal_contada: 0
    });
    const hist = await listarHistoricoContagens(db, empresaA.id);
    assert.equal(hist.total, 0);
    const st = await obterStatusPeriodicidade(db, empresaA.id);
    assert.equal(st.status, STATUS.PRIMEIRA_CONTAGEM_PENDENTE);
    await closeDb(db);
  });

  it('09 contagem rejeitada (desatualizada) não atualiza última', async () => {
    const { db, empresaA } = await setup(1);
    const pid = await produtoComSaldo(db, empresaA.id, 20, 0);
    await confirmarContagem(db, empresaA.id, pid, 15, 20, 'c9a');
    const antes = await obterStatusPeriodicidade(db, empresaA.id);
    await assert.rejects(
      () => confirmarContagem(db, empresaA.id, pid, 10, 20, 'c9b'),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    const depois = await obterStatusPeriodicidade(db, empresaA.id);
    assert.equal(depois.ultima_contagem.id, antes.ultima_contagem.id);
    assert.equal((await listarHistoricoContagens(db, empresaA.id)).total, 1);
    await closeDb(db);
  });

  it('10 rollback não atualiza última contagem', async () => {
    const { db, empresaA } = await setup(1);
    const p1 = await produtoComSaldo(db, empresaA.id, 10, 0);
    const p2 = await produtoComSaldo(db, empresaA.id, 5, 0);
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'roll-10',
        itens: exigirSnapshotItensOficiais([
          {
            produto_id: p1,
            quantidade_fiscal_contada: 8,
            quantidade_nao_fiscal_contada: 0,
            saldo_fiscal_esperado: 10,
            saldo_nao_fiscal_esperado: 0
          },
          {
            produto_id: p2,
            quantidade_fiscal_contada: 1,
            quantidade_nao_fiscal_contada: 0,
            saldo_fiscal_esperado: 999,
            saldo_nao_fiscal_esperado: 0
          }
        ])
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.equal((await listarHistoricoContagens(db, empresaA.id)).total, 0);
    assert.equal((await obterStatusPeriodicidade(db, empresaA.id)).status, STATUS.PRIMEIRA_CONTAGEM_PENDENTE);
    await closeDb(db);
  });

  it('11 reenvio idempotente não duplica histórico', async () => {
    const { db, empresaA } = await setup(1);
    const pid = await produtoComSaldo(db, empresaA.id, 10, 0);
    const a = await confirmarContagem(db, empresaA.id, pid, 9, 10, 'idem-11');
    const b = await confirmarContagem(db, empresaA.id, pid, 9, 10, 'idem-11');
    assert.equal(a.id, b.id);
    assert.equal((await listarHistoricoContagens(db, empresaA.id)).total, 1);
    await closeDb(db);
  });

  it('12 cálculo correto de 7 dias', () => {
    assert.equal(adicionarDias('2026-11-05', 7), '2026-11-12');
    assert.equal(INTERVALOS.SEMANAL, 7);
  });

  it('13 cálculo correto de 15 dias', () => {
    assert.equal(adicionarDias('2026-11-05', 15), '2026-11-20');
    assert.equal(INTERVALOS.QUINZENAL, 15);
  });

  it('14 situação EM_DIA', () => {
    const cfg = {
      periodicidade: 'SEMANAL',
      intervalo_dias: 7,
      ativo: true
    };
    const ultima = { criado_em: '2026-11-10 10:00:00' };
    const agora = new Date(2026, 10, 12); // 12/11 local
    const r = calcularStatus(cfg, ultima, agora);
    assert.equal(r.status, STATUS.EM_DIA);
    assert.equal(r.proxima_contagem_data, '2026-11-17');
  });

  it('15 situação PROXIMA_DO_VENCIMENTO', () => {
    const cfg = { periodicidade: 'SEMANAL', intervalo_dias: 7, ativo: true };
    const ultima = { criado_em: '2026-11-10' };
    // proxima = 17/11; hoje = 16/11 → 1 dia
    const r = calcularStatus(cfg, ultima, new Date(2026, 10, 16));
    assert.equal(r.status, STATUS.PROXIMA_DO_VENCIMENTO);
    assert.equal(r.dias_para_vencimento, 1);
  });

  it('16 situação ATRASADA', () => {
    const cfg = { periodicidade: 'SEMANAL', intervalo_dias: 7, ativo: true };
    const ultima = { criado_em: '2026-11-01' };
    const r = calcularStatus(cfg, ultima, new Date(2026, 10, 12));
    assert.equal(r.status, STATUS.ATRASADA);
    assert.ok(r.dias_atraso >= 3);
  });

  it('17 situação SEM_PERIODICIDADE', async () => {
    const { db, empresaA } = await setup(1);
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'SOB_DEMANDA' });
    const st = await obterStatusPeriodicidade(db, empresaA.id);
    assert.equal(st.status, STATUS.SEM_PERIODICIDADE);
    await closeDb(db);
  });

  it('18 situação PRIMEIRA_CONTAGEM_PENDENTE', async () => {
    const { db, empresaA } = await setup(1);
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'QUINZENAL' });
    const st = await obterStatusPeriodicidade(db, empresaA.id);
    assert.equal(st.status, STATUS.PRIMEIRA_CONTAGEM_PENDENTE);
    await closeDb(db);
  });

  it('19 situação DESATIVADA', async () => {
    const { db, empresaA } = await setup(1);
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'SEMANAL', ativo: false });
    const st = await obterStatusPeriodicidade(db, empresaA.id);
    assert.equal(st.status, STATUS.DESATIVADA);
    assert.equal(st.contagem_permitida, true);
    await closeDb(db);
  });

  it('20 alteração de periodicidade preserva histórico', async () => {
    const { db, empresaA } = await setup(1);
    const pid = await produtoComSaldo(db, empresaA.id, 10, 0);
    await confirmarContagem(db, empresaA.id, pid, 9, 10, 'h20');
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'SEMANAL' });
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'QUINZENAL' });
    assert.equal((await listarHistoricoContagens(db, empresaA.id)).total, 1);
    assert.equal((await obterPeriodicidade(db, empresaA.id)).periodicidade, 'QUINZENAL');
    await closeDb(db);
  });

  it('21 alteração de empresa não mistura configurações', async () => {
    const { db, empresas } = await setup(3);
    await salvarPeriodicidade(db, empresas[0].id, { periodicidade: 'SEMANAL' });
    await salvarPeriodicidade(db, empresas[1].id, { periodicidade: 'QUINZENAL' });
    await salvarPeriodicidade(db, empresas[2].id, { periodicidade: 'SOB_DEMANDA' });
    assert.equal((await obterPeriodicidade(db, empresas[0].id)).periodicidade, 'SEMANAL');
    assert.equal((await obterPeriodicidade(db, empresas[1].id)).periodicidade, 'QUINZENAL');
    assert.equal((await obterPeriodicidade(db, empresas[2].id)).periodicidade, 'SOB_DEMANDA');
    await closeDb(db);
  });

  it('22 falha de consulta não retorna falsamente EM_DIA', async () => {
    await assert.rejects(
      () => obterStatusPeriodicidade(null, 1),
      (err) => err && err.code === 'DB_OBRIGATORIO'
    );
    const rotas = fs.readFileSync(
      path.resolve(__dirname, '../../backend/rotas/estoque.js'),
      'utf8'
    );
    assert.match(rotas, /consulta_disponivel:\s*false/);
    assert.match(rotas, /Não inventar EM_DIA/);
    const blocoStatus = rotas.slice(
      rotas.indexOf("'/contagem-fisica/status-periodicidade'"),
      rotas.indexOf("'/contagem-fisica/historico'")
    );
    assert.match(blocoStatus, /ok:\s*false/);
    assert.doesNotMatch(blocoStatus, /status:\s*['"]EM_DIA['"]/);
  });

  it('23 contagem pode ser realizada mesmo atrasada', async () => {
    const { db, empresaA } = await setup(1);
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'SEMANAL' });
    const pid = await produtoComSaldo(db, empresaA.id, 10, 0);
    // Contagem antiga simulada
    await run(
      db,
      `INSERT INTO estoque_contagens_fisicas
        (empresa_id, usuario_id, usuario_nome, observacao, chave_idempotencia, criado_em)
       VALUES (?, 1, 'op', null, 'old', '2026-01-01 10:00:00')`,
      [empresaA.id]
    );
    const st = await obterStatusPeriodicidade(db, empresaA.id, {
      agora: new Date(2026, 10, 12)
    });
    assert.equal(st.status, STATUS.ATRASADA);
    assert.equal(st.contagem_permitida, true);
    const out = await confirmarContagem(db, empresaA.id, pid, 9, 10, 'atrasada-23');
    assert.ok(out.id > 0);
    await closeDb(db);
  });

  it('24 contagem fora da data prevista é permitida', async () => {
    const { db, empresaA } = await setup(1);
    await salvarPeriodicidade(db, empresaA.id, { periodicidade: 'QUINZENAL' });
    const pid = await produtoComSaldo(db, empresaA.id, 10, 0);
    const out = await confirmarContagem(db, empresaA.id, pid, 8, 10, 'fora-24');
    assert.ok(out.id > 0);
    const st = await obterStatusPeriodicidade(db, empresaA.id);
    assert.equal(st.contagem_permitida, true);
    assert.ok(st.ultima_contagem.id === out.id);
    await closeDb(db);
  });

  it('25 contagem funciona em AUTOMATICO e MANUAL', async () => {
    const { db, empresaA, empresaB } = await setup(2);
    await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresaA.id, 'AUTOMATICO');
    await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresaB.id, 'MANUAL');
    const pA = await produtoComSaldo(db, empresaA.id, 10, 0);
    const pB = await produtoComSaldo(db, empresaB.id, 10, 0);
    const a = await confirmarContagem(db, empresaA.id, pA, 9, 10, 'modo-a');
    const b = await confirmarContagem(db, empresaB.id, pB, 9, 10, 'modo-b');
    assert.ok(a.id > 0 && b.id > 0);
    await closeDb(db);
  });

  it('fonte: rotas e UI de periodicidade', () => {
    const rotas = fs.readFileSync(
      path.resolve(__dirname, '../../backend/rotas/estoque.js'),
      'utf8'
    );
    assert.match(rotas, /contagem-fisica\/periodicidade/);
    assert.match(rotas, /status-periodicidade/);
    assert.match(rotas, /contagem-fisica\/historico/);
    const iPer = rotas.indexOf("'/contagem-fisica/periodicidade'");
    const iId = rotas.indexOf("'/contagem-fisica/:id'");
    assert.ok(iPer > 0 && iId > iPer);
    const ui = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/erp/js/contagem-estoque.js'),
      'utf8'
    );
    assert.match(ui, /cef-periodicidade|Salvar periodicidade/);
    assert.match(ui, /não impede contagens|informativo/i);
  });

  it('diff dias calendário local estável', () => {
    assert.equal(diffDiasCalendario('2026-11-05', '2026-11-12'), 7);
    assert.equal(diffDiasCalendario('2026-11-05', '2026-11-20'), 15);
    assert.equal(paraDataLocalIso('2026-11-05 23:59:59'), '2026-11-05');
  });
});
