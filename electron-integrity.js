'use strict';

/**
 * RC3.16.6 — Integridade integral do pacote ERP (Frontend + Backend + Electron).
 * Amplia RC3.16.5. Sem dependência do módulo `electron` (Node puro).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const MANIFEST_REL = 'electron-manifest.json';
const SCHEMA = 'cds-electron-manifest/v2';

const ARQUIVOS_OBRIGATORIOS = [
  'frontend/erp/index.html',
  'frontend/shared/js/core.js',
  'frontend/erp/js/app.js',
  'frontend/erp/js/pedidos.js',
  'frontend/erp/js/faturamento.js',
  'frontend/erp/js/nfe-central.js',
  'frontend/erp/js/nfe-avulsa.js',
  'frontend/erp/js/nfe-operacional.js',
  'frontend/erp/js/configuracoes.js',
  'backend/server.js',
  'backend/database.js',
  'preload.js',
  'electron-common.js',
  'electron-erp.js',
  'electron-integrity.js',
  'electron-diagnostico.js',
  'package.json',
  'electron-builder-erp.json'
];

const ARQUIVOS_ELECTRON = [
  'preload.js',
  'electron.js',
  'electron-erp.js',
  'electron-pdv.js',
  'electron-common.js',
  'electron-integrity.js',
  'electron-diagnostico.js',
  'electron-auditoria-rc3164.js',
  'electron-rede-cliente.js',
  'electron-rede-recuperacao.js',
  'electron-sessao-rede.js',
  'package.json',
  'electron-builder-erp.json',
  'electron-builder-pdv.json'
];

function toPosix(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(absPath) {
  return sha256Buffer(fs.readFileSync(absPath));
}

function obterCommit(rootDir) {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    }).trim();
  } catch (_) {
    return 'desconhecido';
  }
}

function obterBranch(rootDir) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    }).trim();
  } catch (_) {
    return 'desconhecida';
  }
}

function obterVersaoElectronDev(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch (_) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
      return String((rootPkg.devDependencies && rootPkg.devDependencies.electron) || '');
    } catch (__) {
      return '';
    }
  }
}

function deveExcluirDoPacote(relPosix) {
  const rel = toPosix(relPosix);
  // Alinhado a electron-builder-erp.json (!**/*.md e artefatos git)
  if (/\.md$/i.test(rel)) return true;
  if (/(^|\/)\.git(?:ignore|attributes)?$/i.test(rel)) return true;
  if (/(^|\/)\.github\//i.test(rel)) return true;
  if (/(^|\/)\.gitkeep$/i.test(rel)) return true;
  if (/(^|\/)\.DS_Store$/i.test(rel)) return true;
  return false;
}

function walkFiles(absDir, rootDir, out = [], filtroRel = null) {
  if (!fs.existsSync(absDir)) return out;
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.github') continue;
      walkFiles(abs, rootDir, out, filtroRel);
      continue;
    }
    if (!entry.isFile()) continue;
    if (/(?:^|[\\/])(?:\.DS_Store|Thumbs\.db|Desktop\.ini)$/i.test(abs)) continue;
    const rel = toPosix(path.relative(rootDir, abs));
    if (deveExcluirDoPacote(rel)) continue;
    if (typeof filtroRel === 'function' && filtroRel(rel)) continue;
    out.push(rel);
  }
  return out;
}

function ignorarBackend(rel) {
  const r = toPosix(rel);
  if (!r.startsWith('backend/')) return true;
  if (r.includes('/storage/')) return true;
  if (r.includes('/banco/')) return true;
  if (/\.(db|db-shm|db-wal|db-journal|pfx|p12|pem|key|crt|log)$/i.test(r)) return true;
  if (/\/debug\//i.test(r)) return true;
  return false;
}

function mapearHrefParaArquivo(href) {
  const raw = String(href || '').trim();
  if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) {
    return null;
  }
  let cleaned = raw.split('?')[0].split('#')[0];
  if (cleaned.startsWith('/')) cleaned = cleaned.slice(1);
  if (
    cleaned.startsWith('erp/')
    || cleaned.startsWith('pdv/')
    || cleaned.startsWith('shared/')
    || cleaned.startsWith('css/')
    || cleaned.startsWith('vendor/')
  ) {
    return toPosix(`frontend/${cleaned}`);
  }
  if (cleaned.startsWith('branding/')) {
    return toPosix(`assets/${cleaned}`);
  }
  if (cleaned.startsWith('frontend/')) return toPosix(cleaned);
  return null;
}

function extrairReferenciasIndex(indexHtml) {
  const refs = new Set();
  const re = /(?:src|href)=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(indexHtml)) !== null) {
    const mapped = mapearHrefParaArquivo(match[1]);
    if (mapped) refs.add(mapped);
  }
  return [...refs].sort();
}

function listarArquivosFrontend(rootDir) {
  return walkFiles(path.join(rootDir, 'frontend'), rootDir).sort();
}

function listarArquivosBackend(rootDir) {
  return walkFiles(path.join(rootDir, 'backend'), rootDir, [], ignorarBackend).sort();
}

function listarArquivosRecursos(rootDir) {
  return walkFiles(path.join(rootDir, 'assets'), rootDir).sort();
}

function listarArquivosElectron(rootDir) {
  const set = new Set();
  for (const rel of ARQUIVOS_ELECTRON) {
    const abs = path.join(rootDir, ...toPosix(rel).split('/'));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) set.add(toPosix(rel));
  }
  return [...set].sort();
}

function classificarArquivo(relPosix) {
  const rel = toPosix(relPosix);
  if (rel.startsWith('frontend/')) return 'frontend';
  if (rel.startsWith('backend/')) return 'backend';
  if (rel.startsWith('assets/')) return 'recursos';
  if (ARQUIVOS_ELECTRON.includes(rel) || /^electron[-.].+\.js$/i.test(rel) || rel === 'preload.js') {
    return 'electron';
  }
  if (rel === 'package.json' || /^electron-builder/i.test(rel)) return 'electron';
  return 'outros';
}

function listarArquivosParaManifesto(rootDir) {
  const set = new Set(ARQUIVOS_OBRIGATORIOS.map(toPosix));
  const indexPath = path.join(rootDir, 'frontend', 'erp', 'index.html');
  if (fs.existsSync(indexPath)) {
    extrairReferenciasIndex(fs.readFileSync(indexPath, 'utf8')).forEach((f) => set.add(f));
  }
  listarArquivosFrontend(rootDir).forEach((f) => set.add(f));
  listarArquivosBackend(rootDir).forEach((f) => set.add(f));
  listarArquivosRecursos(rootDir).forEach((f) => set.add(f));
  listarArquivosElectron(rootDir).forEach((f) => set.add(f));
  return [...set].filter((f) => f !== MANIFEST_REL).sort();
}

function hashArquivos(rootDir, arquivosRel) {
  const arquivos = {};
  const ausentes = [];
  for (const rel of arquivosRel) {
    const abs = path.join(rootDir, ...toPosix(rel).split('/'));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      if (toPosix(rel) === MANIFEST_REL) continue;
      ausentes.push(toPosix(rel));
      continue;
    }
    arquivos[toPosix(rel)] = sha256File(abs);
  }
  return { arquivos, ausentes };
}

function hashManifestoArquivos(arquivosMap) {
  const keys = Object.keys(arquivosMap || {}).sort();
  const payload = keys.map((k) => `${k}:${arquivosMap[k]}`).join('\n');
  return sha256Buffer(Buffer.from(payload, 'utf8'));
}

function hashGrupo(arquivosMap, pred) {
  const subset = {};
  for (const [rel, hash] of Object.entries(arquivosMap || {})) {
    if (pred(rel)) subset[rel] = hash;
  }
  return {
    hash: hashManifestoArquivos(subset),
    quantidade: Object.keys(subset).length,
    arquivos: Object.keys(subset).sort()
  };
}

function calcularHashesPorCamada(arquivosMap) {
  const frontend = hashGrupo(arquivosMap, (r) => classificarArquivo(r) === 'frontend');
  const backend = hashGrupo(arquivosMap, (r) => classificarArquivo(r) === 'backend');
  const electron = hashGrupo(arquivosMap, (r) => classificarArquivo(r) === 'electron');
  const recursos = hashGrupo(arquivosMap, (r) => classificarArquivo(r) === 'recursos');
  const hashGlobal = sha256Buffer(Buffer.from(
    [frontend.hash, backend.hash, electron.hash, recursos.hash].join('\n'),
    'utf8'
  ));
  return { frontend, backend, electron, recursos, hashGlobal };
}

function gerarManifesto(rootDir, opcoes = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const lista = listarArquivosParaManifesto(rootDir);
  const { arquivos, ausentes } = hashArquivos(rootDir, lista);
  if (ausentes.length) {
    const err = new Error(`Arquivos obrigatórios/ausentes no repositório:\n${ausentes.join('\n')}`);
    err.code = 'MANIFEST_SOURCE_MISSING';
    err.ausentes = ausentes;
    throw err;
  }

  const camadas = calcularHashesPorCamada(arquivos);
  const timestamp = opcoes.timestamp || new Date().toISOString();
  const manifesto = {
    schema: SCHEMA,
    versao: String(pkg.version || ''),
    build: opcoes.build || timestamp,
    timestamp,
    commit: opcoes.commit || obterCommit(rootDir),
    branch: opcoes.branch || obterBranch(rootDir),
    node: opcoes.node || process.version.replace(/^v/, ''),
    electron: opcoes.electron || obterVersaoElectronDev(rootDir),
    chromium: opcoes.chromium || null,
    modulo: opcoes.modulo || 'erp',
    quantidadeArquivos: Object.keys(arquivos).length,
    quantidadeFrontend: camadas.frontend.quantidade,
    quantidadeBackend: camadas.backend.quantidade,
    quantidadeElectron: camadas.electron.quantidade,
    quantidadeRecursos: camadas.recursos.quantidade,
    hashFrontend: camadas.frontend.hash,
    hashBackend: camadas.backend.hash,
    hashElectron: camadas.electron.hash,
    hashRecursos: camadas.recursos.hash,
    hash: camadas.hashGlobal,
    hashArquivos: hashManifestoArquivos(arquivos),
    arquivos
  };
  return manifesto;
}

function escreverManifesto(rootDir, manifesto) {
  const abs = path.join(rootDir, MANIFEST_REL);
  fs.writeFileSync(abs, `${JSON.stringify(manifesto, null, 2)}\n`, 'utf8');
  return abs;
}

function lerManifesto(rootDir) {
  const abs = path.join(rootDir, MANIFEST_REL);
  if (!fs.existsSync(abs)) {
    const err = new Error(`Manifesto ausente: ${MANIFEST_REL}`);
    err.code = 'MANIFEST_MISSING';
    throw err;
  }
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function validarEstruturaManifesto(manifesto) {
  const erros = [];
  if (!manifesto || typeof manifesto !== 'object') {
    return ['manifesto inválido'];
  }
  if (!manifesto.versao) erros.push('campo versao ausente');
  if (!manifesto.build) erros.push('campo build ausente');
  if (!manifesto.hash) erros.push('campo hash ausente');
  if (!manifesto.arquivos || typeof manifesto.arquivos !== 'object') {
    erros.push('campo arquivos ausente');
    return erros;
  }

  for (const obrigatorio of ARQUIVOS_OBRIGATORIOS) {
    if (!manifesto.arquivos[obrigatorio]) {
      erros.push(`arquivo obrigatório ausente no manifesto: ${obrigatorio}`);
    }
  }

  const camadas = calcularHashesPorCamada(manifesto.arquivos);
  const hashArquivos = hashManifestoArquivos(manifesto.arquivos);

  const ehV2 = manifesto.schema === SCHEMA
    || !!(manifesto.hashFrontend && manifesto.hashBackend && manifesto.hashElectron);

  if (ehV2) {
    if (manifesto.hash !== camadas.hashGlobal) {
      erros.push(
        `hash global divergente (esperado ${camadas.hashGlobal}, obtido ${manifesto.hash})`
      );
    }
    if (manifesto.hashArquivos && manifesto.hashArquivos !== hashArquivos) {
      erros.push('hashArquivos divergente');
    }
    if (!manifesto.hashFrontend) erros.push('campo hashFrontend ausente');
    else if (manifesto.hashFrontend !== camadas.frontend.hash) erros.push('hashFrontend divergente');
    if (!manifesto.hashBackend) erros.push('campo hashBackend ausente');
    else if (manifesto.hashBackend !== camadas.backend.hash) erros.push('hashBackend divergente');
    if (!manifesto.hashElectron) erros.push('campo hashElectron ausente');
    else if (manifesto.hashElectron !== camadas.electron.hash) erros.push('hashElectron divergente');
    if (!manifesto.commit) erros.push('campo commit ausente');
    if (!manifesto.branch) erros.push('campo branch ausente');
  } else if (manifesto.hash !== hashArquivos) {
    erros.push(
      `hash do manifesto divergente (esperado ${hashArquivos}, obtido ${manifesto.hash})`
    );
  }

  return erros;
}

function asarKey(relPosix) {
  return toPosix(relPosix).replace(/\//g, '\\');
}

function listarAsar(asarPath) {
  const asar = require('@electron/asar');
  return asar.listPackage(asarPath).map((p) => toPosix(String(p).replace(/^[\\/]+/, '')));
}

function lerArquivoAsar(asarPath, relPosix) {
  const asar = require('@electron/asar');
  const key = asarKey(relPosix);
  return asar.extractFile(asarPath, key);
}

function compararRepoComAsar(rootDir, asarPath, opcoes = {}) {
  const manifesto = opcoes.manifesto || lerManifesto(rootDir);
  const erros = [];
  const logs = [];
  const estrutura = validarEstruturaManifesto(manifesto);
  estrutura.forEach((e) => erros.push(e));

  if (!fs.existsSync(asarPath)) {
    erros.push(`app.asar não encontrado: ${asarPath}`);
    return {
      ok: false,
      erros,
      logs,
      divergencias: [],
      ausentesNoAsar: [],
      extras: [],
      porCamada: null
    };
  }

  let asarList;
  try {
    asarList = new Set(listarAsar(asarPath));
  } catch (err) {
    erros.push(`falha ao listar asar: ${err.message}`);
    return {
      ok: false,
      erros,
      logs,
      divergencias: [],
      ausentesNoAsar: [],
      extras: [],
      porCamada: null
    };
  }

  const ausentesNoAsar = [];
  const divergencias = [];
  const porCamada = {
    frontend: { ok: 0, fail: 0 },
    backend: { ok: 0, fail: 0 },
    electron: { ok: 0, fail: 0 },
    recursos: { ok: 0, fail: 0 },
    outros: { ok: 0, fail: 0 }
  };
  const arquivos = Object.keys(manifesto.arquivos || {}).sort();

  for (const rel of arquivos) {
    const camada = classificarArquivo(rel);
    if (!asarList.has(rel)) {
      ausentesNoAsar.push(rel);
      porCamada[camada].fail += 1;
      logs.push(`AUSENTE no asar [${camada}]: ${rel}`);
      continue;
    }
    let buf;
    try {
      buf = lerArquivoAsar(asarPath, rel);
    } catch (err) {
      ausentesNoAsar.push(rel);
      porCamada[camada].fail += 1;
      logs.push(`FALHA leitura asar ${rel}: ${err.message}`);
      continue;
    }
    const hashAsar = sha256Buffer(buf);
    const hashEsperado = manifesto.arquivos[rel];
    if (hashAsar !== hashEsperado) {
      divergencias.push({ arquivo: rel, camada, esperado: hashEsperado, obtido: hashAsar });
      porCamada[camada].fail += 1;
      logs.push(`HASH divergente [${camada}]: ${rel}`);
      continue;
    }

    const absRepo = path.join(rootDir, ...rel.split('/'));
    if (fs.existsSync(absRepo) && fs.statSync(absRepo).isFile()) {
      const hashRepo = sha256File(absRepo);
      if (hashRepo !== hashAsar) {
        divergencias.push({
          arquivo: rel,
          camada,
          esperado: hashRepo,
          obtido: hashAsar,
          motivo: 'repo_vs_asar'
        });
        porCamada[camada].fail += 1;
        logs.push(`REPO≠ASAR [${camada}]: ${rel}`);
        continue;
      }
    }
    porCamada[camada].ok += 1;
  }

  if (!asarList.has(MANIFEST_REL)) {
    ausentesNoAsar.push(MANIFEST_REL);
    logs.push(`AUSENTE no asar: ${MANIFEST_REL}`);
  } else {
    try {
      const manifestAsar = JSON.parse(lerArquivoAsar(asarPath, MANIFEST_REL).toString('utf8'));
      const errMan = validarEstruturaManifesto(manifestAsar);
      errMan.forEach((e) => erros.push(`manifesto(asar): ${e}`));
      if (manifestAsar.hash !== manifesto.hash) {
        erros.push('hash do manifesto no asar difere do manifesto do repositório');
      }
      if (manifestAsar.hashFrontend && manifesto.hashFrontend
        && manifestAsar.hashFrontend !== manifesto.hashFrontend) {
        erros.push('hashFrontend asar ≠ repositório');
      }
      if (manifestAsar.hashBackend && manifesto.hashBackend
        && manifestAsar.hashBackend !== manifesto.hashBackend) {
        erros.push('hashBackend asar ≠ repositório');
      }
      if (manifestAsar.hashElectron && manifesto.hashElectron
        && manifestAsar.hashElectron !== manifesto.hashElectron) {
        erros.push('hashElectron asar ≠ repositório');
      }
    } catch (err) {
      erros.push(`manifesto no asar ilegível: ${err.message}`);
    }
  }

  if (ausentesNoAsar.length) {
    erros.push(`${ausentesNoAsar.length} arquivo(s) do manifesto ausentes no app.asar`);
  }
  if (divergencias.length) {
    erros.push(`${divergencias.length} arquivo(s) com hash divergente`);
  }

  return {
    ok: erros.length === 0,
    erros,
    logs,
    divergencias,
    ausentesNoAsar,
    quantidadeValidada: arquivos.length,
    porCamada,
    manifesto
  };
}

function validarIntegridadePacoteLocal(rootDir, opcoes = {}) {
  const resultado = {
    ok: true,
    status: 'OK',
    erros: [],
    avisos: [],
    manifesto: null,
    quantidadeArquivos: 0,
    integridade: true,
    origem: rootDir,
    hashFrontend: null,
    hashBackend: null,
    hashElectron: null,
    hashGlobal: null
  };

  try {
    const manifesto = lerManifesto(rootDir);
    resultado.manifesto = manifesto;
    resultado.quantidadeArquivos = manifesto.quantidadeArquivos || Object.keys(manifesto.arquivos || {}).length;
    resultado.hashFrontend = manifesto.hashFrontend || null;
    resultado.hashBackend = manifesto.hashBackend || null;
    resultado.hashElectron = manifesto.hashElectron || null;
    resultado.hashGlobal = manifesto.hash || null;

    const estrutura = validarEstruturaManifesto(manifesto);
    if (estrutura.length) {
      resultado.erros.push(...estrutura);
    }

    for (const [rel, hashEsperado] of Object.entries(manifesto.arquivos || {})) {
      const abs = path.join(rootDir, ...toPosix(rel).split('/'));
      if (!fs.existsSync(abs)) {
        resultado.erros.push(`ausente no pacote: ${rel}`);
        continue;
      }
      const atual = sha256File(abs);
      if (atual !== hashEsperado) {
        resultado.erros.push(`hash divergente: ${rel}`);
      }
    }
  } catch (err) {
    resultado.erros.push(err.message || String(err));
  }

  if (resultado.erros.length) {
    resultado.ok = false;
    resultado.integridade = false;
    resultado.status = 'ERRO';
  }

  return resultado;
}

function resumoManifesto(manifesto) {
  if (!manifesto) return null;
  return {
    schema: manifesto.schema,
    versao: manifesto.versao,
    build: manifesto.build,
    timestamp: manifesto.timestamp || manifesto.build,
    commit: manifesto.commit,
    branch: manifesto.branch,
    node: manifesto.node,
    electron: manifesto.electron,
    chromium: manifesto.chromium,
    quantidadeArquivos: manifesto.quantidadeArquivos,
    quantidadeFrontend: manifesto.quantidadeFrontend,
    quantidadeBackend: manifesto.quantidadeBackend,
    quantidadeElectron: manifesto.quantidadeElectron,
    hashFrontend: manifesto.hashFrontend,
    hashBackend: manifesto.hashBackend,
    hashElectron: manifesto.hashElectron,
    hashRecursos: manifesto.hashRecursos,
    hash: manifesto.hash
  };
}

module.exports = {
  MANIFEST_REL,
  SCHEMA,
  ARQUIVOS_OBRIGATORIOS,
  ARQUIVOS_ELECTRON,
  toPosix,
  sha256File,
  sha256Buffer,
  obterCommit,
  obterBranch,
  listarArquivosFrontend,
  listarArquivosBackend,
  listarArquivosRecursos,
  listarArquivosElectron,
  listarArquivosParaManifesto,
  extrairReferenciasIndex,
  mapearHrefParaArquivo,
  classificarArquivo,
  calcularHashesPorCamada,
  gerarManifesto,
  escreverManifesto,
  lerManifesto,
  validarEstruturaManifesto,
  hashManifestoArquivos,
  compararRepoComAsar,
  validarIntegridadePacoteLocal,
  listarAsar,
  lerArquivoAsar,
  resumoManifesto
};
