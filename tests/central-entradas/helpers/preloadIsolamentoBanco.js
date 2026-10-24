/**
 * Preload Node para suítes da Central.
 *
 * Forma segura (npm / node -r), ANTES do arquivo de teste:
 *   node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/central-entradas/ARQUIVO.test.js
 *   node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test tests/central-entradas/ARQUIVO.test.js
 *
 * `node ARQUIVO.test.js` SEM este -r NÃO herda o preload do package.json.
 * Só é aceitável se o arquivo chama isolarBancoTeste() antes de qualquer require de risco.
 *
 * Não é usado em produção.
 */
'use strict';

// Marca o processo antes de qualquer outro require (P0.5).
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = process.env.CDS_BLOQUEAR_BANCO_OFICIAL || '1';

const { isolarBancoTeste } = require('./isolarBancoTeste');

isolarBancoTeste(process.env.CDS_TEST_DB_PREFIX || 'cds-preload-');
