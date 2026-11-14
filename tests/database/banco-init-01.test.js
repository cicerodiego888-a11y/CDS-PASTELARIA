/**
 * BANCO-INIT-01 — Inicialização de banco inexistente, vazio, parcial e existente.
 *
 * Cada cenário carrega backend/database.js num processo filho com DB_DIR temporário;
 * o banco oficial nunca é aberto.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');

const RAIZ = path.join(__dirname, '..', '..');
const ESPERA_POS_PRONTO_MS = 4000;

const SONDA = `
const db = require('./backend/database');
const limite = setTimeout(() => { console.error('SONDA_TIMEOUT'); process.exit(3); }, 90000);
db.whenReady((err) => {
  setTimeout(() => {
    clearTimeout(limite);
    db.close(() => { console.log(err ? 'SONDA_PRONTO_COM_ERRO' : 'SONDA_PRONTO'); process.exit(err ? 2 : 0); });
  }, ${ESPERA_POS_PRONTO_MS});
});
`;

function inicializar(dbDir) {
  const r = spawnSync(process.execPath, ['-e', SONDA], {
    cwd: RAIZ,
    env: { ...process.env, DB_DIR: dbDir },
    encoding: 'utf8',
    timeout: 120000
  });
  const saida = `${r.stdout || ''}\n${r.stderr || ''}`;
  return { status: r.status, saida };
}

function assertInicializou(r, contexto) {
  assert.strictEqual(
    r.status,
    0,
    `${contexto}: processo terminou com ${r.status}\n${r.saida.split('\n').filter((l) => /Error|SONDA|no such table/i.test(l)).join('\n')}`
  );
  assert.ok(r.saida.includes('SONDA_PRONTO'), `${contexto}: prontidão não sinalizada`);
  assert.ok(!/no such table: configuracoes/.test(r.saida), `${contexto}: acesso a configuracoes antes da criação`);
  assert.doesNotMatch(
    r.saida,
    /Erro ao adicionar coluna \w+: SQLITE_ERROR: duplicate column name:/i,
    `${contexto}: migração de coluna duplicada em venda_pagamentos`
  );
}

function abrir(arquivo) {
  return new sqlite3.Database(arquivo);
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));
}

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (e) => (e ? reject(e) : resolve())));
}

function fechar(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function comBanco(arquivo, fn) {
  const db = abrir(arquivo);
  try {
    return await fn(db);
  } finally {
    await fechar(db);
  }
}

async function schema(arquivo) {
  return comBanco(arquivo, (db) => all(
    db,
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ));
}

async function dump(arquivo) {
  return comBanco(arquivo, async (db) => {
    const tabelas = await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const out = {};
    for (const { name } of tabelas) {
      out[name] = await all(db, `SELECT * FROM "${name}" ORDER BY rowid`);
    }
    return out;
  });
}

function diferencas(antes, depois) {
  const out = [];
  const tabelas = new Set([...Object.keys(antes), ...Object.keys(depois)]);
  for (const t of tabelas) {
    const a = antes[t] || [];
    const d = depois[t] || [];
    if (a.length !== d.length) {
      out.push(`${t}: ${a.length} → ${d.length} linhas`);
      continue;
    }
    a.forEach((linha, i) => {
      for (const col of new Set([...Object.keys(linha), ...Object.keys(d[i])])) {
        if (JSON.stringify(linha[col]) !== JSON.stringify(d[i][col])) {
          out.push(`${t}[${i}].${col}: ${JSON.stringify(linha[col])} → ${JSON.stringify(d[i][col])}`);
        }
      }
    });
  }
  return out;
}

function assertSemDiferencas(antes, depois, contexto) {
  const diff = diferencas(antes, depois);
  assert.deepStrictEqual(diff, [], `${contexto}:\n  ${diff.slice(0, 30).join('\n  ')}`);
}

function dirTemp(nome) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `banco-init-01-${nome}-`));
}

async function verificarEstruturaMinima(arquivo, contexto) {
  const nomes = (await schema(arquivo)).filter((o) => o.type === 'table').map((o) => o.name);
  for (const t of ['configuracoes', 'usuarios', 'empresas', 'central_entradas_config', 'caixas', 'equipamentos_drivers', 'pedidos', 'nfe_notas']) {
    assert.ok(nomes.includes(t), `${contexto}: tabela ${t} ausente`);
  }
  const colunasPagamentos = await comBanco(arquivo, (db) => all(db, 'PRAGMA table_info(venda_pagamentos)'));
  const nomesColunasPagamentos = colunasPagamentos.map((coluna) => coluna.name);
  assert.ok(nomesColunasPagamentos.includes('valor_entregue'), `${contexto}: venda_pagamentos.valor_entregue ausente`);
  assert.ok(nomesColunasPagamentos.includes('troco'), `${contexto}: venda_pagamentos.troco ausente`);
  const dados = await dump(arquivo);
  const chaves = dados.configuracoes.map((c) => c.chave);
  for (const c of ['nome_empresa', 'fiscal_ambiente', 'equipamentos_ativo', 'produto_identidade_enabled', 'migracao_modo_fiscal_padrao_ativo']) {
    assert.ok(chaves.includes(c), `${contexto}: configuração ${c} não semeada`);
  }
  assert.ok(dados.usuarios.some((u) => u.username === 'admin' && u.perfil === 'SUPER_ADMIN'), `${contexto}: admin inicial ausente`);
  return dados;
}

let ok = 0;
let falhas = 0;
const limpar = [];

async function test(nome, fn) {
  try {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  } catch (error) {
    falhas += 1;
    console.error(`  FALHOU  ${nome}`);
    console.error(error.message || error);
  }
}

async function main() {
  console.log('\nBANCO-INIT-01 — Inicialização do banco\n');

  await test('banco inexistente: cria pasta, arquivo e estrutura completa', async () => {
    const base = dirTemp('inexistente');
    limpar.push(base);
    const dbDir = path.join(base, 'dados', 'nova-instalacao');
    assert.ok(!fs.existsSync(dbDir));
    const r = inicializar(dbDir);
    assertInicializou(r, 'inexistente');
    const arquivo = path.join(dbDir, 'mercadao.db');
    assert.ok(fs.existsSync(arquivo));
    await verificarEstruturaMinima(arquivo, 'inexistente');
  });

  await test('banco SQLite vazio (arquivo de 0 bytes): inicializa', async () => {
    const dbDir = dirTemp('vazio');
    limpar.push(dbDir);
    const arquivo = path.join(dbDir, 'mercadao.db');
    fs.writeFileSync(arquivo, '');
    const r = inicializar(dbDir);
    assertInicializou(r, 'vazio');
    await verificarEstruturaMinima(arquivo, 'vazio');
  });

  await test('pagamentos legado: adiciona colunas de troco e preserva registros', async () => {
    const dbDir = dirTemp('pagamentos-troco');
    limpar.push(dbDir);
    const arquivo = path.join(dbDir, 'mercadao.db');
    await comBanco(arquivo, (db) => exec(db, `
      CREATE TABLE venda_pagamentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venda_id INTEGER NOT NULL,
        forma_pagamento TEXT NOT NULL,
        valor DECIMAL(10,2) NOT NULL,
        tef_transacao_id INTEGER,
        tef_nsu TEXT,
        tef_autorizacao TEXT,
        tef_bandeira TEXT,
        tef_adquirente TEXT,
        tef_comprovante_cliente TEXT,
        tef_comprovante_estabelecimento TEXT,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor)
        VALUES (1, 'pix', 40.00);
    `));

    const inicializacao = inicializar(dbDir);
    assertInicializou(inicializacao, 'pagamentos-troco');
    await verificarEstruturaMinima(arquivo, 'pagamentos-troco');
    await comBanco(arquivo, async (db) => {
      const legado = await all(db, `
        SELECT valor, valor_entregue, troco FROM venda_pagamentos WHERE venda_id = 1
      `);
      assert.deepStrictEqual(legado.map((linha) => [Number(linha.valor), linha.valor_entregue, linha.troco]), [[40, null, null]]);
      await exec(db, `
        INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor, valor_entregue, troco)
        VALUES (1, 'dinheiro', 8.99, 9.00, 0.01)
      `);
      const pagamentos = await all(db, `
        SELECT valor, valor_entregue, troco FROM venda_pagamentos WHERE venda_id = 1 ORDER BY id
      `);
      assert.deepStrictEqual(
        pagamentos.map((linha) => [Number(linha.valor), Number(linha.valor_entregue || 0), Number(linha.troco || 0)]),
        [[40, 0, 0], [8.99, 9, 0.01]]
      );
      const soma = pagamentos.reduce((total, linha) => total + Math.round(Number(linha.valor) * 100), 0);
      assert.equal(soma, 4899);
    });
  });

  await test('banco parcialmente inicializado (sem configuracoes): completa sem perder dados', async () => {
    const dbDir = dirTemp('parcial');
    limpar.push(dbDir);
    const arquivo = path.join(dbDir, 'mercadao.db');
    await comBanco(arquivo, (db) => exec(db, `
      CREATE TABLE caixas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        descricao TEXT,
        ativo INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO caixas (nome, descricao) VALUES ('Caixa Loja', 'pré-existente');
      CREATE TABLE equipamentos_drivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE NOT NULL,
        fabricante TEXT NOT NULL,
        modelo TEXT NOT NULL,
        nome_exibicao TEXT NOT NULL,
        versao TEXT DEFAULT '1.0.0',
        transportes TEXT,
        descricao TEXT,
        ativo INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO equipamentos_drivers (codigo, fabricante, modelo, nome_exibicao, descricao, ativo)
        VALUES ('TOLEDO_PRIX4_UNO', 'Toledo', 'Prix 4 Uno', 'Nome editado pelo cliente', 'editado', 0);
    `));
    const r = inicializar(dbDir);
    assertInicializou(r, 'parcial');
    const dados = await verificarEstruturaMinima(arquivo, 'parcial');
    assert.deepStrictEqual(
      dados.caixas.map((c) => [c.id, c.nome, c.descricao]),
      [[1, 'Caixa Loja', 'pré-existente']]
    );
    const toledo = dados.equipamentos_drivers.find((d) => d.codigo === 'TOLEDO_PRIX4_UNO');
    assert.strictEqual(toledo.nome_exibicao, 'Nome editado pelo cliente');
    assert.strictEqual(toledo.ativo, 0);
  });

  await test('banco parcialmente inicializado (só configuracoes com valores do cliente): valores preservados', async () => {
    const dbDir = dirTemp('parcial-cfg');
    limpar.push(dbDir);
    const arquivo = path.join(dbDir, 'mercadao.db');
    await comBanco(arquivo, (db) => exec(db, `
      CREATE TABLE configuracoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chave VARCHAR(100) UNIQUE NOT NULL,
        valor TEXT,
        tipo VARCHAR(50),
        descricao TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO configuracoes (chave, valor, tipo) VALUES ('nome_empresa', 'Pastelaria do Cliente', 'string');
      INSERT INTO configuracoes (chave, valor, tipo) VALUES ('equipamentos_ativo', 'false', 'boolean');
      INSERT INTO configuracoes (chave, valor, tipo) VALUES ('fiscal_ambiente', '1', 'number');
    `));
    const r = inicializar(dbDir);
    assertInicializou(r, 'parcial-cfg');
    const dados = await verificarEstruturaMinima(arquivo, 'parcial-cfg');
    const valor = (k) => dados.configuracoes.find((c) => c.chave === k).valor;
    assert.strictEqual(valor('nome_empresa'), 'Pastelaria do Cliente');
    assert.strictEqual(valor('equipamentos_ativo'), 'false');
    assert.strictEqual(valor('fiscal_ambiente'), '1');
  });

  await test('banco existente: dados de empresas/configurações/usuários/caixa permanecem intactos', async () => {
    const dbDir = dirTemp('existente');
    limpar.push(dbDir);
    const arquivo = path.join(dbDir, 'mercadao.db');
    assertInicializou(inicializar(dbDir), 'existente (1ª)');
    await comBanco(arquivo, (db) => exec(db, `
      UPDATE configuracoes SET valor = 'Pastelaria Matriz' WHERE chave = 'nome_empresa';
      UPDATE configuracoes SET valor = '1' WHERE chave = 'fiscal_ambiente';
      INSERT INTO configuracoes (chave, valor, tipo) VALUES ('chave_do_cliente', 'x', 'string');
      INSERT INTO central_entradas_config (chave, valor, tipo) VALUES ('periodo_padrao_empresa_2', 'TODO_PERIODO', 'string');
      INSERT INTO caixas (nome) VALUES ('Caixa 01');
      INSERT INTO empresas (razao_social, cnpj) VALUES ('Matriz Teste LTDA', '38111111000115');
      INSERT INTO empresas (razao_social, cnpj) VALUES ('Filial Teste LTDA', '38111111000387');
      UPDATE configuracoes_validade SET dias_aviso_vencimento = 15 WHERE id = 1;
      INSERT INTO configuracoes_validade (dias_aviso_vencimento, bloquear_venda_vencido, alertar_venda_proximo_vencimento)
        VALUES (30, 0, 1);
    `));
    const antes = await dump(arquivo);
    assert.strictEqual(antes.empresas.length, 2);
    assert.strictEqual(antes.configuracoes_validade.length, 2);
    assertInicializou(inicializar(dbDir), 'existente (2ª)');
    const depois = await dump(arquivo);
    assertSemDiferencas(antes, depois, 'dados alterados na reinicialização');
    const valor = (k) => depois.configuracoes.find((c) => c.chave === k).valor;
    assert.strictEqual(valor('nome_empresa'), 'Pastelaria Matriz');
    assert.strictEqual(valor('fiscal_ambiente'), '1');
    assert.strictEqual(valor('chave_do_cliente'), 'x');
    assert.ok(depois.caixas.some((c) => c.nome === 'Caixa 01'));
    assert.deepStrictEqual(depois.empresas.map((e) => e.cnpj), ['38111111000115', '38111111000387']);
    assert.strictEqual(depois.configuracoes_validade.length, 2, 'linhas antigas de validade não são apagadas');
    assert.strictEqual(depois.configuracoes_validade[0].dias_aviso_vencimento, 15);
    assert.ok(depois.central_entradas_config.some((c) => c.chave === 'periodo_padrao_empresa_2' && c.valor === 'TODO_PERIODO'));
  });

  await test('segunda e terceira inicialização idempotentes: schema e dados idênticos', async () => {
    const dbDir = dirTemp('idempotente');
    limpar.push(dbDir);
    const arquivo = path.join(dbDir, 'mercadao.db');
    assertInicializou(inicializar(dbDir), 'idempotente (1ª)');
    const s1 = await schema(arquivo);
    const d1 = await dump(arquivo);
    assertInicializou(inicializar(dbDir), 'idempotente (2ª)');
    const s2 = await schema(arquivo);
    const d2 = await dump(arquivo);
    assertInicializou(inicializar(dbDir), 'idempotente (3ª)');
    assert.deepStrictEqual(s2, s1, 'schema mudou na 2ª inicialização');
    assertSemDiferencas(d1, d2, 'dados mudaram na 2ª inicialização');
    assert.deepStrictEqual(await schema(arquivo), s1, 'schema mudou na 3ª inicialização');
    assertSemDiferencas(d1, await dump(arquivo), 'dados mudaram na 3ª inicialização');
    const cfg = d1.configuracoes.map((c) => c.chave);
    assert.strictEqual(new Set(cfg).size, cfg.length, 'configuração duplicada');
    assert.strictEqual(d1.usuarios.filter((u) => u.perfil === 'SUPER_ADMIN').length, 1);
    assert.strictEqual(d1.configuracoes_validade.length, 1);
  });

  for (const dir of limpar) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* arquivo WAL ainda aberto no Windows */ }
  }

  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exitCode = falhas ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
