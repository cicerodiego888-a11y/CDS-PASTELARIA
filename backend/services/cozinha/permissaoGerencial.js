'use strict';

function perfilPodeAcessarGestao(user) {
  const role = String(user?.role || '').trim().toLowerCase();
  const perfil = String(user?.perfil || '').trim().toUpperCase();
  return role === 'gerente' || perfil === 'GERENTE' || perfil === 'SUPER_ADMIN';
}

module.exports = { perfilPodeAcessarGestao };
