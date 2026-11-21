'use strict';

const bcrypt = require('bcryptjs');
const db = require('../database');

function isAdminUsuario(usuario) {
  const perfil = String(usuario?.perfil || '').trim().toUpperCase();
  return usuario?.role === 'admin' || ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR'].includes(perfil);
}

function validarSenhaAdmin(senhaAdmin, callback) {
  validarSenhaAdminComUsuario(senhaAdmin, (err, usuario) => {
    if (err) return callback(err);
    callback(null, !!usuario);
  });
}

function validarSenhaAdminComUsuario(senhaAdmin, callback) {
  if (!senhaAdmin) {
    return callback(null, null);
  }

  db.all('SELECT * FROM usuarios WHERE COALESCE(ativo, 1) = 1', [], async (err, usuarios) => {
    if (err) return callback(err);

    if (!usuarios || usuarios.length === 0) {
      return callback(null, null);
    }

    for (const usuario of usuarios) {
      if (!isAdminUsuario(usuario)) continue;

      const senhaBanco =
        usuario.password_hash ||
        usuario.senha_hash ||
        usuario.senha ||
        usuario.password;

      if (!senhaBanco) continue;

      const senhaOk = await bcrypt.compare(senhaAdmin, senhaBanco).catch(() => false);

      if (senhaOk || senhaAdmin === senhaBanco) {
        return callback(null, {
          id: usuario.id,
          username: usuario.username,
          role: usuario.role,
          perfil: usuario.perfil
        });
      }
    }

    return callback(null, null);
  });
}

module.exports = {
  isAdminUsuario,
  validarSenhaAdmin,
  validarSenhaAdminComUsuario
};
