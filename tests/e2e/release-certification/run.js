#!/usr/bin/env node
/**
 * RC4.32.0 — Certificação Funcional de Release
 * Executar: node tests/e2e/release-certification/run.js
 * Preferível: node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/e2e/release-certification/run.js
 *           npm run test:release-certification
 *
 * Isola DB_DIR antes de qualquer require de backend/database.js
 * (sem CDS_ALLOW_OFFICIAL_DB e sem fallback ProgramData).
 */
'use strict';

const path = require('path');
const { isolarBancoTeste } = require('../../central-entradas/helpers/isolarBancoTeste');
isolarBancoTeste('cds-release-cert-');

const { ReleaseCertificationService } = require('../../../backend/certification/ReleaseCertificationService');

const ROOT = path.join(__dirname, '../../..');

async function main() {
  const svc = new ReleaseCertificationService({ rootDir: ROOT });
  const relatorio = await svc.executar();
  process.exit(relatorio.status === 'APROVADA' ? 0 : 1);
}

main().catch((err) => {
  console.error('[RC4.32.0] ERRO FATAL:', err.message);
  process.exit(1);
});
