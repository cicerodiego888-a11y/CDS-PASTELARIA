/**
 * Empresa da transação TEF.
 * Usa o identificador já autorizado (cabeçalho oficial ou o único caixa aberto).
 * Não escolhe matriz, não pega a primeira empresa da lista e não ignora a validação.
 */
'use strict';

function ausente() {
  return {
    empresaId: null,
    codigo: 'TEF_EMPRESA_AUSENTE',
    mensagem: 'Empresa autorizada não identificada para a transação TEF.'
  };
}

function naoAutorizada(error) {
  return {
    empresaId: null,
    codigo: 'EMPRESA_NAO_AUTORIZADA',
    mensagem: (error && error.message) || 'Usuário não está autorizado a usar esta empresa.'
  };
}

async function resolverEmpresaAutorizadaTef(req, deps) {
  const usuario = req && req.user;
  if (!usuario || !deps || typeof deps.exigirEmpresaAutorizada !== 'function') {
    return ausente();
  }

  const headers = req.headers || {};
  const nomeHeader = Object.keys(headers).find((chave) => {
    const nome = String(chave).toLowerCase();
    return nome === 'x-empresa-id' || nome === 'x-empresaid';
  });
  const headerBruto = nomeHeader ? headers[nomeHeader] : null;
  const headerId = Number(headerBruto);
  if (Number.isInteger(headerId) && headerId > 0) {
    try {
      const autorizado = await deps.exigirEmpresaAutorizada(usuario, headerId);
      return { empresaId: autorizado.empresaId, codigo: null, mensagem: null };
    } catch (error) {
      if (error && error.code === 'EMPRESA_NAO_AUTORIZADA') return naoAutorizada(error);
      throw error;
    }
  }

  const usuarioId = usuario.id != null ? usuario.id : usuario.usuario_id;
  const sessoes = typeof deps.consultarEmpresasDoCaixaAberto === 'function'
    ? await deps.consultarEmpresasDoCaixaAberto(usuarioId)
    : [];
  const ids = [...new Set((sessoes || []).map((row) => Number(row.empresa_id)).filter((id) => id > 0))];
  if (ids.length !== 1) return ausente();

  try {
    const autorizado = await deps.exigirEmpresaAutorizada(usuario, ids[0]);
    return { empresaId: autorizado.empresaId, codigo: null, mensagem: null };
  } catch (error) {
    if (error && error.code === 'EMPRESA_NAO_AUTORIZADA') return naoAutorizada(error);
    throw error;
  }
}

module.exports = {
  resolverEmpresaAutorizadaTef
};
