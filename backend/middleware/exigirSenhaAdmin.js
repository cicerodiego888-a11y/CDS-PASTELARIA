'use strict';

const { validarSenhaAdminComUsuario } = require('../utils/validarSenhaAdmin');

function exigirSenhaAdmin(req, res, next) {
  const senhaAdmin = req.body?.senha_admin;

  validarSenhaAdminComUsuario(senhaAdmin, (err, administrador) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!administrador) {
      return res.status(403).json({
        error: 'Senha de administrador inválida ou não informada.'
      });
    }

    req.adminAutorizador = administrador;
    req.adminAutorizadorId = Number(administrador.id);
    next();
  });
}

module.exports = { exigirSenhaAdmin };
