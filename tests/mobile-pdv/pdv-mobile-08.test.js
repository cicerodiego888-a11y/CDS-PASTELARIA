/**
 * PDV-MOBILE-08 — empresa padrão da loja no Mobile.
 * Banco temporário. Não abre o banco oficial, não cobra TEF e não transmite NFC-e.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-08.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mobpdv08-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const db = require('../../backend/database');
const { getJwtSecret } = require('../../backend/config/secrets');
const { verificarToken } = require('../../backend/middleware/auth');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const empresasRouter = require('../../backend/rotas/empresas');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL = '11222333000262';

let server;
let porta;
let matriz;
let filial;
let tokenMatriz;
let tokenFilial;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function pedir(caminho, token, empresaId) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (empresaId) headers['X-Empresa-Id'] = String(empresaId);
    const req = http.request({
      hostname: '127.0.0.1',
      port: porta,
      path: caminho,
      method: 'GET',
      headers
    }, (res) => {
      const partes = [];
      res.on('data', (parte) => partes.push(parte));
      res.on('end', () => {
        const body = Buffer.concat(partes).toString('utf8');
        let json = null;
        try { json = JSON.parse(body); } catch (_erro) { json = null; }
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function esperarTabela(nome) {
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    const row = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [nome]);
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('tabela ausente: ' + nome);
}

describe('empresa padrão da loja', () => {
  before(async () => {
    await db.whenReady;
    await esperarTabela('empresas');
    await esperarTabela('usuarios');
    await garantirSchemaUsuarioEmpresasAsync(db);
    matriz = await EmpresaService.criarEmpresa({
      cnpj: CNPJ_MATRIZ,
      razao_social: 'Matriz da loja'
    }, { db });
    filial = await EmpresaService.criarEmpresa({
      cnpj: CNPJ_FILIAL,
      razao_social: 'Filial da loja'
    }, { db });
    const operadorMatriz = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-matriz', 'x', 'operador', 'Operador Matriz', 'CAIXA', 1)`
    );
    const operadorFilial = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op-filial', 'x', 'operador', 'Operador Filial', 'CAIXA', 1)`
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operadorMatriz.lastID, matriz.id]
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operadorMatriz.lastID, filial.id]
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operadorFilial.lastID, filial.id]
    );
    const segredo = getJwtSecret();
    tokenMatriz = jwt.sign({
      id: operadorMatriz.lastID,
      username: 'op-matriz',
      role: 'operador',
      perfil: 'CAIXA'
    }, segredo, { expiresIn: '1h' });
    tokenFilial = jwt.sign({
      id: operadorFilial.lastID,
      username: 'op-filial',
      role: 'operador',
      perfil: 'CAIXA'
    }, segredo, { expiresIn: '1h' });
    const app = express();
    app.use(express.json());
    app.use('/api/empresas', verificarToken, empresasRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    porta = server.address().port;
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('resolve a matriz pelo cadastro oficial e não a primeira empresa da lista', async () => {
    const resposta = await pedir('/api/empresas/contexto/padrao', tokenMatriz);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.json.empresaId, matriz.id);
    assert.equal(resposta.json.empresa.cnpj, CNPJ_MATRIZ);
    assert.equal(resposta.json.origem, 'MATRIZ_CNPJ_0001');
    assert.notEqual(resposta.json.empresaId, filial.id);
  });

  it('o operador sem autorização à matriz não recebe outra empresa', async () => {
    const resposta = await pedir('/api/empresas/contexto/padrao', tokenFilial);
    assert.equal(resposta.status, 403);
    assert.equal(resposta.json.code, 'EMPRESA_PADRAO_NAO_AUTORIZADA');
    assert.equal(resposta.json.empresaId, undefined);
    assert.equal(resposta.json.empresa, undefined);
    assert.equal(resposta.json.empresa_id, matriz.id);
    assert.equal(resposta.body.includes(CNPJ_FILIAL), false);
  });

  it('o contexto adotado segue para consulta, pagamento e fechamento', async () => {
    const memoria = new Map();
    global.localStorage = {
      getItem(chave) {
        if (chave === 'token') return tokenMatriz;
        return memoria.has(chave) ? memoria.get(chave) : null;
      },
      setItem(chave, valor) { memoria.set(chave, String(valor)); },
      removeItem(chave) { memoria.delete(chave); }
    };
    global.API_URL = 'http://127.0.0.1:' + porta + '/api';
    global.fetch = (url, opcoes) => new Promise((resolve, reject) => {
      const alvo = new URL(url);
      const headers = Object.assign({}, opcoes && opcoes.headers);
      const req = http.request({
        hostname: alvo.hostname,
        port: alvo.port,
        path: alvo.pathname + alvo.search,
        method: (opcoes && opcoes.method) || 'GET',
        headers
      }, (res) => {
        const partes = [];
        res.on('data', (parte) => partes.push(parte));
        res.on('end', () => {
          const body = Buffer.concat(partes).toString('utf8');
          resolve({
            ok: res.statusCode < 400,
            status: res.statusCode,
            json: async () => JSON.parse(body)
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
    delete require.cache[require.resolve('../../frontend/shared/js/cds-empresa-contexto.js')];
    require('../../frontend/shared/js/cds-empresa-contexto.js');
    const adotada = await global.CdsEmpresaContexto.adotarEmpresaPadrao();
    assert.equal(adotada.empresaId, matriz.id);
    const cabecalhos = global.CdsEmpresaContexto.headersJson();
    assert.equal(cabecalhos['X-Empresa-Id'], String(matriz.id));

    const semContexto = await pedir('/api/empresas/contexto', tokenMatriz);
    assert.equal(semContexto.json.selecionada, false);
    const comContexto = await pedir('/api/empresas/contexto', tokenMatriz, matriz.id);
    assert.equal(comContexto.json.empresaId, matriz.id);
    assert.equal(comContexto.json.empresa.cnpj, CNPJ_MATRIZ);

    const pedido = fs.readFileSync(path.join(__dirname, '../../frontend/mobile-pedido/mobile-pedido.js'), 'utf8');
    const pdv = fs.readFileSync(path.join(__dirname, '../../frontend/mobile-pdv/mobile-pdv.js'), 'utf8');
    const inicio = fs.readFileSync(path.join(__dirname, '../../frontend/mobile/mobile-inicio.js'), 'utf8');
    assert.match(inicio, /adotarEmpresaPadrao/);
    assert.match(pedido, /adotarEmpresaPadrao/);
    assert.match(pdv, /adotarEmpresaPadrao/);
    assert.doesNotMatch(pedido, /selecionar\(lista\[0\]\.id\)/);
    assert.match(pdv, /headersJson/);
    assert.match(pdv, /\/vendas\/composicao-sequencial/);
    assert.match(pdv, /\/pedidos\/venda-por-valor-pasteis|preparado\.endpoint/);
    assert.match(pdv, /\/vendas'/);
  });

  it('modo empresa única não troca a matriz configurada por outra empresa', async () => {
    await assert.rejects(
      () => EmpresaService.resolverEmpresaPadraoDaLoja({
        db,
        user: { id: 999001, role: 'operador', perfil: 'CAIXA' },
        cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id }
      }),
      (err) => err.code === 'EMPRESA_PADRAO_NAO_AUTORIZADA' && err.empresa_id === matriz.id
    );
    const resolvida = await EmpresaService.resolverEmpresaPadraoDaLoja({
      db,
      user: jwt.verify(tokenMatriz, getJwtSecret()),
      cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: matriz.id }
    });
    assert.equal(resolvida.empresa.id, matriz.id);
    assert.equal(resolvida.origem, 'CONFIG_PDV_EMPRESA_UNICA');
  });

  it('matriz inativa não cai na filial', async () => {
    await EmpresaService.inativarEmpresa(matriz.id, { db });
    const resposta = await pedir('/api/empresas/contexto/padrao', tokenMatriz);
    assert.equal(resposta.status, 400);
    assert.equal(resposta.json.code, 'EMPRESA_PADRAO_INATIVA');
    assert.equal(resposta.json.empresa_id, matriz.id);
    assert.equal(resposta.body.includes(CNPJ_FILIAL), false);
    await EmpresaService.ativarEmpresa(matriz.id, { db });
  });

  it('sem matriz ativa a resolução não escolhe uma filial', async () => {
    await run(`UPDATE empresas SET cnpj = ? WHERE id = ?`, ['38111111000229', matriz.id]);
    const resposta = await pedir('/api/empresas/contexto/padrao', tokenMatriz);
    assert.equal(resposta.status, 409);
    assert.equal(resposta.json.code, 'EMPRESA_PADRAO_AUSENTE');
    assert.equal(resposta.json.empresaId, undefined);
    await run(`UPDATE empresas SET cnpj = ? WHERE id = ?`, [CNPJ_MATRIZ, matriz.id]);
  });
});
