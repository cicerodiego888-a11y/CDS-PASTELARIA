'use strict';
/**
 * Diagnóstico isolado S07-1 — reproduz HTTP 503 do gate COZINHA_NAO_OPERACIONAL
 * sem abrir o banco oficial e sem alterar código de produto.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_TEST_ISOLATION = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-diag-s07-1-503';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../backend/utils/cozinhaSchema');

// Simula o estado observado no servidor real após falha de FK check.
const erroFk = new Error('[COZINHA] foreign_key_check encontrou 2082 violação(ões).');
erroFk.codigo = 'COZINHA_SCHEMA_FALHA';
marcarCozinhaOperacional(false, erroFk);

function exigirCozinhaOperacional(res) {
  if (isCozinhaOperacional()) return true;
  const st = getCozinhaSchemaStatus();
  res.status(503).json({
    success: false,
    codigo: 'COZINHA_NAO_OPERACIONAL',
    mensagem: 'Módulo Cozinha não operacional.'
  });
  return false;
}

const app = express();
app.get('/api/cozinha/status', (req, res) => {
  const st = getCozinhaSchemaStatus();
  res.json({
    success: true,
    operacional: isCozinhaOperacional(),
    versao_schema: st.versao != null ? st.versao : null,
    erro: st.erro
  });
});
app.get('/api/cozinha/preparacao/painel', (req, res) => {
  // Espelha a ordem real da rota: gate ANTES do serviço.
  if (!exigirCozinhaOperacional(res)) return;
  res.status(200).json({ success: true, rodadas: [], _nao_deveria_chegar: true });
});

(async () => {
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const port = server.address().port;
  const token = jwt.sign({ id: 1, role: 'admin' }, process.env.JWT_SECRET);

  function get(pathname) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Empresa-Id': '1',
          Accept: 'application/json'
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(raw); } catch (_e) { body = { raw }; }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  const status = await get('/api/cozinha/status');
  const painel = await get('/api/cozinha/preparacao/painel?limite=100&offset=0');

  const out = {
    evidencia: 'S07-1 diagnostico 503 isolado',
    banco_oficial_acessado: false,
    estado_in_memory: getCozinhaSchemaStatus(),
    status_endpoint: status,
    painel_endpoint: painel,
    conclusao: painel.status === 503 && painel.body && painel.body.codigo === 'COZINHA_NAO_OPERACIONAL'
      ? 'REPRODUZIDO: gate exigirCozinhaOperacional bloqueia antes do serviço'
      : 'FALHA_NA_REPRODUCAO'
  };

  const dest = path.join(__dirname, 'DIAGNOSTICO-S07-1-HTTP-503.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  console.log('wrote', dest);
  await new Promise((r) => server.close(() => r()));
  process.exit(out.conclusao.startsWith('REPRODUZIDO') ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
