'use strict';

/**
 * RC3.16.6 — Pipeline oficial de build ERP Electron (Frontend + Backend + Electron).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  gerarManifesto,
  escreverManifesto,
  compararRepoComAsar,
  ARQUIVOS_OBRIGATORIOS,
  resumoManifesto
} = require('../../electron-integrity');

const root = path.join(__dirname, '..', '..');
const distErp = path.join(root, 'dist', 'erp');
const TAG = '[RC3.16.6]';

function fail(msg) {
  console.error(TAG, 'ERRO —', msg);
  console.log('ERRO');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(TAG, cmd, args.join(' '));
  const result = spawnSync(cmd, args, {
    cwd: root,
    shell: true,
    stdio: 'inherit',
    env: process.env,
    ...opts
  });
  if (result.status !== 0) {
    fail(`comando falhou (${cmd}): exit ${result.status}`);
  }
}

function limparDistErp() {
  if (fs.existsSync(distErp)) {
    fs.rmSync(distErp, { recursive: true, force: true });
    console.log(TAG, 'dist/erp limpo');
  }
}

function validarFonte() {
  const ausentes = ARQUIVOS_OBRIGATORIOS.filter((rel) => !fs.existsSync(path.join(root, ...rel.split('/'))));
  if (ausentes.length) {
    fail(`arquivos obrigatórios ausentes:\n${ausentes.join('\n')}`);
  }
}

function main() {
  console.log(TAG, '=== BUILD ERP OFICIAL (INTEGRAL) ===');

  validarFonte();

  const manifesto = gerarManifesto(root, { modulo: 'erp' });
  escreverManifesto(root, manifesto);
  console.log(TAG, 'manifesto', resumoManifesto(manifesto));
  console.log(TAG, 'hashes', {
    frontend: manifesto.hashFrontend,
    backend: manifesto.hashBackend,
    electron: manifesto.hashElectron,
    global: manifesto.hash
  });

  limparDistErp();

  run('npx', ['electron-builder', '--config', 'electron-builder-erp.json']);

  const asarPath = path.join(distErp, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    fail(`app.asar não encontrado após build: ${asarPath}`);
  }

  const cmp = compararRepoComAsar(root, asarPath, { manifesto });
  if (!cmp.ok) {
    try {
      fs.rmSync(distErp, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
    fail(`pós-build: asar inválido\n${cmp.erros.join('\n')}\ncamadas=${JSON.stringify(cmp.porCamada)}`);
  }

  const setups = fs.existsSync(distErp)
    ? fs.readdirSync(distErp).filter((f) => /\.exe$/i.test(f) && /Setup/i.test(f))
    : [];

  console.log(TAG, '=== BUILD OK ===');
  console.log(JSON.stringify({
    versao: manifesto.versao,
    commit: manifesto.commit,
    branch: manifesto.branch,
    quantidadeArquivos: cmp.quantidadeValidada,
    hashFrontend: manifesto.hashFrontend,
    hashBackend: manifesto.hashBackend,
    hashElectron: manifesto.hashElectron,
    hashGlobal: manifesto.hash,
    porCamada: cmp.porCamada,
    asar: asarPath,
    setups
  }, null, 2));
  console.log('OK');
}

main();
