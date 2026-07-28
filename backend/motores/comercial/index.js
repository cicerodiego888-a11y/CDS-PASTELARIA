/**
 * Motor Comercial — fachada pública.
 * @module motores/comercial
 */
'use strict';

const MotorComercialService = require('./MotorComercialService');

module.exports = {
  ...MotorComercialService,
  MotorComercialService
};
