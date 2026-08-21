/**
 * Rotas de empresas — cadastro (03.1) + contexto (03.2/03.3) + contexto obrigatório (03.4).
 * Autenticação: verificarToken existente. Sem JWT novo.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const EmpresaService = require('../services/empresas/EmpresaService');
const { criarMiddlewareContextoEmpresa, exigirEmpresaAlvoDoContexto } = require('../services/fiscalNaoFiscal/empresaContexto');

const STATUS_POR_CODIGO = {
  CNPJ_EMPRESA_OBRIGATORIO: 400,
  CNPJ_EMPRESA_INVALIDO: 400,
  CNPJ_EMPRESA_DUPLICADO: 409,
  RAZAO_SOCIAL_OBRIGATORIA: 400,
  EMPRESA_ID_OBRIGATORIO: 400,
  EMPRESA_NAO_ENCONTRADA: 404,
  EMPRESA_INATIVA: 400,
  EMPRESA_JA_ATIVA: 409,
  EMPRESA_JA_INATIVA: 409,
  EMPRESA_OBRIGATORIA: 400,
  EMPRESA_NAO_AUTORIZADA: 403,
  VINCULO_EMPRESA_DUPLICADO: 409,
  VINCULO_NAO_ENCONTRADO: 404,
  VINCULO_JA_INATIVO: 409,
  USUARIO_OBRIGATORIO: 400
};

function responderErro(res, err) {
  const code = err && err.code ? err.code : 'ERRO_EMPRESA';
  const status = Number(err && err.status) || STATUS_POR_CODIGO[code] || 500;
  const payload = {
    error: err && err.message ? err.message : 'Erro ao processar empresa.',
    code
  };
  if (err && err.empresa_id != null) payload.empresa_id = err.empresa_id;
  if (err && err.cnpj) payload.cnpj = err.cnpj;
  if (status >= 500) {
    console.error('Erro em /api/empresas:', err);
  }
  return res.status(status).json(payload);
}

const anexarContexto = criarMiddlewareContextoEmpresa(db);
const exigirContexto = criarMiddlewareContextoEmpresa(db, { obrigatorio: true });

router.get('/contexto/disponiveis', async (req, res) => {
  try {
    const lista = await EmpresaService.listarEmpresasDisponiveis({
      db,
      user: req.user
    });
    return res.json(lista);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/contexto', anexarContexto, async (req, res) => {
  try {
    const contexto = await EmpresaService.obterContextoEmpresa(req.empresaId, {
      db,
      req,
      user: req.user
    });
    return res.json(contexto);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/contexto', async (req, res) => {
  try {
    const fonte = req.body && (req.body.empresaId != null || req.body.empresa_id != null)
      ? req.body
      : req.body;
    const empresa = await EmpresaService.selecionarEmpresaContexto(fonte, {
      db,
      user: req.user
    });
    return res.json({
      empresaId: empresa.id,
      empresa,
      selecionada: true
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/', async (req, res) => {
  try {
    const filtros = {};
    if (req.query.ativo !== undefined && req.query.ativo !== '') {
      filtros.ativo = req.query.ativo;
    }
    const lista = await EmpresaService.listarEmpresas(filtros, { db });
    return res.json(lista);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const empresa = await EmpresaService.buscarEmpresaPorId(req.params.id, { db });
    return res.json(empresa);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const empresa = await EmpresaService.criarEmpresa(req.body || {}, { db });
    return res.status(201).json(empresa);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.put('/:id', exigirContexto, async (req, res) => {
  try {
    const empresaId = exigirEmpresaAlvoDoContexto(req.empresaId, req.params.id);
    const empresa = await EmpresaService.atualizarEmpresa(empresaId, req.body || {}, { db });
    return res.json(empresa);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.patch('/:id/ativar', async (req, res) => {
  try {
    const empresa = await EmpresaService.ativarEmpresa(req.params.id, { db });
    return res.json(empresa);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.patch('/:id/inativar', async (req, res) => {
  try {
    const empresa = await EmpresaService.inativarEmpresa(req.params.id, { db });
    return res.json(empresa);
  } catch (err) {
    return responderErro(res, err);
  }
});

module.exports = router;
