/**
 * Facade oficial do Motor Bancário (MBC-01 — fundação).
 * @module motores/bancario
 */
'use strict';

const MotorBancarioService = require('./MotorBancarioService');
const constantes = require('./contracts/constantes');
const dto = require('./contracts/TransacaoBancariaNormalizada');
const { IBankProvider } = require('./contracts/IBankProvider');
const contexto = require('./BancarioEmpresaContextoService');
const VERSAO = require('./version');

module.exports = {
  ...MotorBancarioService,
  ...constantes,
  ...dto,
  ...contexto,
  IBankProvider,
  VERSAO
};
