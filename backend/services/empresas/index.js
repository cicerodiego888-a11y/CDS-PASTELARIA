'use strict';

const EmpresaService = require('./EmpresaService');
const UsuarioEmpresaService = require('./UsuarioEmpresaService');
const empresasSchema = require('./empresasSchema');
const usuarioEmpresasSchema = require('./usuarioEmpresasSchema');
const empresaCnpj = require('./empresaCnpj');

module.exports = {
  ...EmpresaService,
  ...UsuarioEmpresaService,
  ...empresasSchema,
  ...usuarioEmpresasSchema,
  ...empresaCnpj
};
