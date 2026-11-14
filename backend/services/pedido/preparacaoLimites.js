/**
 * Limites iniciais do salão. A duração é calculada na consulta; estes números
 * não se repetem nas rotas nem no painel.
 */
'use strict';

const LIMITES_PREPARACAO_MINUTOS = Object.freeze({
  atraso: 5,
  critico: 20
});

module.exports = { LIMITES_PREPARACAO_MINUTOS };
