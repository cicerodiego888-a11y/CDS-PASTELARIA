'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const servico = require('../../backend/services/vendas/CanalVendaEmpresaService');

function abrir() {
  const db = new sqlite3.Database(':memory:');
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE empresas (
        id INTEGER PRIMARY KEY,
        nome_fantasia TEXT,
        razao_social TEXT,
        cnpj TEXT,
        ativo INTEGER NOT NULL DEFAULT 1
      )`);
      db.run(`CREATE TABLE vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER, total REAL)`);
      db.run(`CREATE TABLE pedidos (id INTEGER PRIMARY KEY, empresa_id INTEGER)`, (err) => {
        if (err) reject(err);
        else resolve(db);
      });
    });
  });
}

function run(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params || [], (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function empresa(db, id, cnpj, ativo) {
  await run(db, 'INSERT INTO empresas (id, nome_fantasia, cnpj, ativo) VALUES (?, ?, ?, ?)', [
    id, `Empresa ${id}`, cnpj, ativo == null ? 1 : ativo
  ]);
}

const admin = { id: 1, role: 'admin' };

test('1 e 2. cadastra canais personalizados diferentes', async () => {
  const db = await abrir();
  await empresa(db, 1, '111', 1);
  await empresa(db, 2, '222', 1);
  const ifood = await servico.cadastrarCanal(db, {
    nome: 'iFood', codigo: 'ifood', tipo_origem: 'Marketplace', empresa_id: 1
  }, { usuario: admin });
  const food = await servico.cadastrarCanal(db, {
    nome: '99Food', codigo: '99FOOD', tipo_origem: 'Marketplace', descricao: 'App', empresa_id: 2
  }, { usuario: admin });
  assert.equal(ifood.codigo, 'IFOOD');
  assert.notEqual(ifood.id, food.id);
  assert.equal(food.empresa_id, 2);
});

test('3 e 4. canais em empresas diferentes e na mesma empresa', async () => {
  const db = await abrir();
  await empresa(db, 1, '111', 1);
  await empresa(db, 2, '222', 1);
  const a = await servico.cadastrarCanal(db, { nome: 'WhatsApp', codigo: 'WHATSAPP', tipo_origem: 'Mensagem', empresa_id: 1 }, { usuario: admin });
  const b = await servico.cadastrarCanal(db, { nome: 'Cardápio', codigo: 'CARDAPIO', tipo_origem: 'Online', empresa_id: 2 }, { usuario: admin });
  const c = await servico.cadastrarCanal(db, { nome: 'Delivery', codigo: 'DELIVERY', tipo_origem: 'Proprio', empresa_id: 1 }, { usuario: admin });
  assert.notEqual(a.empresa_id, b.empresa_id);
  assert.equal(a.empresa_id, c.empresa_id);
});

test('5. altera o vínculo e registra auditoria', async () => {
  const db = await abrir();
  await empresa(db, 1, '111', 1);
  await empresa(db, 2, '222', 1);
  const canal = await servico.cadastrarCanal(db, { nome: 'App', codigo: 'APP', tipo_origem: 'Aplicativo', empresa_id: 1 }, { usuario: admin });
  const atualizado = await servico.atualizarVinculo(db, canal.id, { empresa_id: 2 }, { usuario: admin });
  assert.equal(atualizado.empresa_id, 2);
  const auditoria = await get(db, 'SELECT * FROM canais_venda_auditoria WHERE canal_id = ? AND empresa_nova_id = 2', [canal.id]);
  assert.equal(auditoria.empresa_anterior_id, 1);
});

test('6, 7 e 8. sem empresa, empresa inativa e canal inativo', async () => {
  const db = await abrir();
  await empresa(db, 3, '333', 0);
  await empresa(db, 4, '444', 1);
  await assert.rejects(
    () => servico.cadastrarCanal(db, { nome: 'Solto', codigo: 'SOLTO', tipo_origem: 'Outro', ativo: true }, { usuario: admin }),
    (err) => err.code === 'CANAL_SEM_EMPRESA'
  );
  await assert.rejects(
    () => servico.cadastrarCanal(db, { nome: 'Parado', codigo: 'PARADO', tipo_origem: 'Outro', empresa_id: 3 }, { usuario: admin }),
    (err) => err.code === 'EMPRESA_INATIVA'
  );
  const canal = await servico.cadastrarCanal(db, { nome: 'Pausa', codigo: 'PAUSA', tipo_origem: 'Outro', empresa_id: 4 }, { usuario: admin });
  await servico.atualizarVinculo(db, canal.id, { ativo: false }, { usuario: admin });
  await assert.rejects(
    () => servico.resolverEmpresaDoCanal(db, { canalId: canal.id, usuario: admin }, {}),
    (err) => err.code === 'CANAL_INATIVO'
  );
});

test('9 e 10. usuário sem autorização e canal inexistente', async () => {
  const db = await abrir();
  await empresa(db, 2, '222', 1);
  const canal = await servico.cadastrarCanal(db, { nome: 'Loja', codigo: 'LOJA', tipo_origem: 'Fisica', empresa_id: 2 }, { usuario: admin });
  await assert.rejects(
    () => servico.resolverEmpresaDoCanal(db, { canalId: canal.id, usuario: { id: 9, empresas: [1] } }, {}),
    (err) => err.code === 'CANAL_USUARIO_SEM_AUTORIZACAO'
  );
  await assert.rejects(
    () => servico.resolverEmpresaDoCanal(db, { codigo: 'NAO_EXISTE', usuario: admin }, {}),
    (err) => err.code === 'CANAL_INEXISTENTE'
  );
});

test('11, 12 e 13. PDV preserva pdv_empresa_id nos dois modos', async () => {
  const db = await abrir();
  await empresa(db, 7, '777', 1);
  await empresa(db, 8, '888', 1);
  await servico.garantirSchema(db);
  await run(db, `
    INSERT INTO canais_venda (nome, codigo, tipo_origem, empresa_id, ativo, criado_em, atualizado_em)
    VALUES ('PDV', 'PDV', 'PDV', 8, 1, 't', 't')
  `);
  const deps = {
    cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: 7 },
    validarEmpresaPdv: async (id) => ({ empresa_id: id })
  };
  const unica = await servico.resolverEmpresaDoCanal(db, { codigo: 'PDV', usuario: admin }, deps);
  assert.equal(unica.empresa_id, 7);
  assert.equal(unica.pdv_empresa_id, 7);
  assert.equal(unica.cnpj, '777');
  const multiplas = await servico.resolverEmpresaDoCanal(db, { codigo: 'PDV', usuario: admin }, {
    cfg: { pdv_modelo_empresa: 'MULTIPLAS', pdv_empresa_id: 7 }
  });
  assert.equal(multiplas.aplicada, false);
  assert.equal(multiplas.motivo, 'PDV_MULTIPLAS');
  assert.equal(multiplas.pdv_empresa_id, 7);
  assert.equal(multiplas.empresa_id, undefined);
});

test('14 e 15. pedido antigo e venda histórica não mudam com o vínculo', async () => {
  const db = await abrir();
  await empresa(db, 1, '111', 1);
  await empresa(db, 2, '222', 1);
  const canal = await servico.cadastrarCanal(db, { nome: 'Balcão', codigo: 'BALCAO', tipo_origem: 'Loja', empresa_id: 1 }, { usuario: admin });
  await run(db, 'INSERT INTO pedidos (id, empresa_id) VALUES (10, 1)');
  await run(db, 'INSERT INTO vendas (id, empresa_id, total) VALUES (20, 1, 61.9)');
  await servico.atualizarVinculo(db, canal.id, { empresa_id: 2 }, { usuario: admin });
  const pedido = await get(db, 'SELECT empresa_id FROM pedidos WHERE id = 10');
  const venda = await get(db, 'SELECT empresa_id, total FROM vendas WHERE id = 20');
  assert.equal(pedido.empresa_id, 1);
  assert.equal(venda.empresa_id, 1);
  assert.equal(venda.total, 61.9);
});

test('16 e 17. pedido e venda usam a mesma empresa e o CNPJ não é duplicado no canal', async () => {
  const db = await abrir();
  await empresa(db, 5, '555', 1);
  const canal = await servico.cadastrarCanal(db, { nome: 'Site', codigo: 'SITE', tipo_origem: 'Online', empresa_id: 5 }, { usuario: admin });
  const contexto = await servico.resolverEmpresaDoCanal(db, { canalId: canal.id, usuario: admin }, {});
  await run(db, 'INSERT INTO pedidos (id, empresa_id) VALUES (1, ?)', [contexto.empresa_id]);
  await run(db, 'INSERT INTO vendas (id, empresa_id, total) VALUES (1, ?, 10)', [contexto.empresa_id]);
  const pedido = await get(db, 'SELECT empresa_id FROM pedidos WHERE id = 1');
  const venda = await get(db, 'SELECT empresa_id FROM vendas WHERE id = 1');
  assert.equal(pedido.empresa_id, venda.empresa_id);
  assert.equal(contexto.cnpj, '555');
  const colunas = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(canais_venda)', (err, rows) => (err ? reject(err) : resolve(rows)));
  });
  assert.equal(colunas.some((coluna) => coluna.name === 'cnpj'), false);
  const gravado = await get(db, 'SELECT * FROM canais_venda WHERE id = ?', [canal.id]);
  assert.equal(gravado.cnpj, undefined);
});
