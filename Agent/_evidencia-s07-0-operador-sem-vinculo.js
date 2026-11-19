'use strict';
/**
 * Evidência somente leitura — captura status/código do caso
 * "HTTP: operador sem vínculo de empresa" (S07-0).
 * Não altera código de produto.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-s07-0-evid-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = 'cds-test-jwt-s07-0-evidencia';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const repo = path.resolve(__dirname, '..');

(async () => {
  process.chdir(repo);
  const db = require('../backend/database');
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 60000);
    db.whenReady((err) => {
      clearTimeout(t);
      if (err) reject(err);
      else resolve();
    });
  });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const {
    garantirSchemaCozinha,
    marcarCozinhaOperacional
  } = require('../backend/utils/cozinhaSchema');
  await garantirSchemaCozinha(db);
  marcarCozinhaOperacional(true);

  const configService = require('../backend/services/configuracaoService');
  const orig = configService.recursoHabilitado;
  configService.recursoHabilitado = (n) => (n === 'pedidos' ? true : orig.call(configService, n));

  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });

  await run(`
    INSERT OR IGNORE INTO usuarios (id, username, password_hash, role, perfil, ativo)
    VALUES (71, 'kds_noemp', 'h', 'operador', 'USUARIO', 1)
  `);
  const emp = await run(`
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11122233000199', 'Evid S07', 'Evid', 1)
  `);
  const empresaId = emp.lastID;
  // operador 71 SEM usuario_empresas
  await run(`
    INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
    VALUES (?, 'EVID', 0, 1)
  `, [empresaId]);
  const un = await get(
    `SELECT id FROM cozinha_unidades WHERE empresa_id = ? AND codigo = 'EVID'`,
    [empresaId]
  );

  const token = jwt.sign(
    { id: 71, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: un.id },
    process.env.JWT_SECRET
  );

  const cozinhaRoutes = require('../backend/rotas/cozinha');
  const { verificarToken } = require('../backend/middleware/auth');
  const { exigirRecurso } = require('../backend/middleware/validarRecursoImplantacao');
  const app = express();
  app.use(express.json());
  app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const port = server.address().port;

  const body = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/cozinha/preparacao/painel',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Empresa-Id': String(empresaId)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_e) { json = { raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });

  const out = {
    evidencia: 'HTTP operador sem vinculo de empresa',
    db_tmp: dbDir,
    banco_oficial_acessado: false,
    status: body.status,
    codigo: body.body && (body.body.codigo || body.body.code),
    mensagem: body.body && (body.body.mensagem || body.body.error),
    body: body.body
  };
  const outPath = path.join(__dirname, 'EVIDENCIA-S07-0-OPERADOR-SEM-VINCULO.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  console.log('wrote', outPath);

  configService.recursoHabilitado = orig;
  await new Promise((r) => server.close(() => r()));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
