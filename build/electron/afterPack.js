'use strict';

/**
 * electron-builder afterPack — aborta se app.asar ≠ repositório/manifesto.
 */

const fs = require('fs');
const path = require('path');
const { compararRepoComAsar, lerManifesto } = require('../../electron-integrity');

exports.default = async function afterPack(context) {
  const root = path.join(__dirname, '..', '..');
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');

  console.log('[RC3.16.6][afterPack] validando', asarPath);

  if (!fs.existsSync(asarPath)) {
    throw new Error(`[RC3.16.6] afterPack: app.asar não gerado em ${asarPath}`);
  }

  const manifesto = lerManifesto(root);
  const cmp = compararRepoComAsar(root, asarPath, { manifesto });

  if (!cmp.ok) {
    const detalhe = [
      '[RC3.16.6] BUILD ABORTADO — app.asar inconsistente com o repositório (Frontend/Backend/Electron).',
      ...cmp.erros.map((e) => ` - ${e}`),
      cmp.porCamada ? `Camadas: ${JSON.stringify(cmp.porCamada)}` : '',
      cmp.ausentesNoAsar.length ? `Ausentes: ${cmp.ausentesNoAsar.slice(0, 15).join(', ')}` : '',
      cmp.divergencias.length
        ? `Hashes: ${cmp.divergencias.slice(0, 10).map((d) => `${d.camada}:${d.arquivo}`).join(', ')}`
        : ''
    ].filter(Boolean).join('\n');

    try {
      fs.rmSync(asarPath, { force: true });
    } catch (_) {
      /* ignore */
    }

    throw new Error(detalhe);
  }

  console.log('[RC3.16.6][afterPack] OK —', cmp.quantidadeValidada, 'arquivo(s)', cmp.porCamada);
};
