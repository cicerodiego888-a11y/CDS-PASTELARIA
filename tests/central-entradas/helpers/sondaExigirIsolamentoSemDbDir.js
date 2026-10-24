/**
 * Sonda P0.11 — teste protegido executado SEM isolarBancoTeste() / SEM DB_DIR.
 *
 * Deve falhar em exigirIsolamentoAtivo() ANTES de qualquer require de database.js
 * ou DfeAuditoriaService. Não abre o banco oficial.
 *
 * Uso (processo filho, env sem DB_DIR):
 *   node tests/central-entradas/helpers/sondaExigirIsolamentoSemDbDir.js
 */
'use strict';

const { exigirIsolamentoAtivo } = require('./isolarBancoTeste');

exigirIsolamentoAtivo();

console.log('SONDA_NAO_DEVERIA_CHEGAR_AQUI');
require('../../../backend/services/fiscal/DfeAuditoriaService');
process.exit(2);
