/**
 * Sprint 20B — isolamento da Central ao trocar de usuário e visão consolidada.
 * Vínculos simulados. Não abre o banco oficial.
 * Executar: node --test tests/central-entradas/cds-central-contexto-usuario-20b.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, it, before } = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const {
  resolverEmpresaParaCentral,
  resolverLeituraCentral
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');

const contratoMulti = { modo_operacional: 'MULTIEMPRESA', empresa_operacional: null };

const empresas = {
  10: { id: 10, ativo: 1, cnpj: '11111111000110' },
  20: { id: 20, ativo: 1, cnpj: '22222222000120' },
  30: { id: 30, ativo: 1, cnpj: '33333333000130' },
  40: { id: 40, ativo: 0, cnpj: '44444444000140' }
};

const vinculos = {
  1: [10, 20],
  2: [30],
  3: []
};

function erro(code, status) {
  const err = new Error(code);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function usuarioId(fonte) {
  if (!fonte || typeof fonte !== 'object') return null;
  const id = fonte.id != null ? fonte.id : fonte.usuario_id;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const chamadasVinculo = [];

const UsuarioEmpresaService = {
  async exigirEmpresaAutorizada(usuarioFonte, empresaId) {
    chamadasVinculo.push({ usuarioFonte, empresaId: Number(empresaId) });
    const uid = usuarioId(usuarioFonte);
    if (!uid) throw erro('USUARIO_OBRIGATORIO', 400);
    const ids = vinculos[uid] || [];
    if (!ids.includes(Number(empresaId))) throw erro('EMPRESA_NAO_AUTORIZADA', 403);
    return { usuarioId: uid, empresaId: Number(empresaId) };
  },
  async listarEmpresasPermitidas(usuarioFonte) {
    const uid = usuarioId(usuarioFonte);
    if (!uid) throw erro('USUARIO_OBRIGATORIO', 400);
    return (vinculos[uid] || []).map((id) => ({ id, ativo: 1 }));
  }
};

const EmpresaService = {
  async buscarEmpresaPorId(id) {
    return empresas[Number(id)] || null;
  }
};

const deps = { contrato: contratoMulti, EmpresaService, UsuarioEmpresaService };

function reqDe(usuario, extra = {}) {
  return {
    user: usuario,
    headers: {},
    query: {},
    ...extra
  };
}

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function trecho(arquivo, inicio, fim) {
  const texto = src(arquivo);
  const i = texto.indexOf(inicio);
  const j = texto.indexOf(fim, i + inicio.length);
  assert.ok(i >= 0 && j > i, `trecho ausente: ${inicio}`);
  return texto.slice(i, j);
}

describe('20B — autorização individual', () => {
  before(() => {
    chamadasVinculo.length = 0;
  });

  it('usuário B não consulta a empresa 10 do usuário A', async () => {
    chamadasVinculo.length = 0;
    await assert.rejects(
      () => resolverEmpresaParaCentral({
        req: reqDe(
          { id: 2 },
          { headers: { 'x-empresa-id': '10' }, usuario: { id: 1 } }
        )
      }, deps),
      (err) => err.code === 'EMPRESA_NAO_AUTORIZADA' && err.statusCode === 403
    );
    assert.equal(chamadasVinculo.length, 1);
    assert.equal(chamadasVinculo[0].usuarioFonte.id, 2);
    assert.equal(chamadasVinculo[0].empresaId, 10);
  });

  it('X-Empresa-Id antigo não autoriza quando o usuário não tem o vínculo', async () => {
    await assert.rejects(
      () => resolverEmpresaParaCentral({
        req: reqDe({ id: 2 }, { headers: { 'x-empresa-id': '10' } })
      }, deps),
      (err) => err.code === 'EMPRESA_NAO_AUTORIZADA'
    );
  });

  it('usuário B consulta a própria empresa 30', async () => {
    const ctx = await resolverEmpresaParaCentral({
      req: reqDe({ id: 2 }, { headers: { 'x-empresa-id': '30' } })
    }, deps);
    assert.equal(ctx.empresaId, 30);
    assert.equal(ctx.origem, 'EMPRESA_EXPLICITA');
  });

  it('empresa inexistente e empresa inativa são rejeitadas', async () => {
    await assert.rejects(
      () => resolverEmpresaParaCentral({
        req: reqDe({ id: 1 }, { headers: { 'x-empresa-id': '99' } })
      }, deps),
      (err) => err.code === 'EMPRESA_CENTRAL_INATIVA'
    );
    chamadasVinculo.length = 0;
    await assert.rejects(
      () => resolverEmpresaParaCentral({
        req: reqDe({ id: 1 }, { headers: { 'x-empresa-id': '40' } })
      }, deps),
      (err) => err.code === 'EMPRESA_CENTRAL_INATIVA'
    );
    assert.equal(chamadasVinculo.length, 0);
  });

  it('req.usuario sem req.user não autoriza a empresa', async () => {
    await assert.rejects(
      () => resolverEmpresaParaCentral({
        req: {
          usuario: { id: 1 },
          headers: { 'x-empresa-id': '10' },
          query: {}
        }
      }, deps),
      (err) => err.code === 'EMPRESA_NAO_AUTORIZADA' && err.statusCode === 403
    );
  });

  it('resolução interna sem req continua sem exigir usuário', async () => {
    chamadasVinculo.length = 0;
    const ctx = await resolverEmpresaParaCentral({ empresaId: 10 }, deps);
    assert.equal(ctx.empresaId, 10);
    assert.equal(chamadasVinculo.length, 0);
  });
});

describe('20B — visão consolidada', () => {
  it('A e B leem todas as empresas sem X-Empresa-Id', async () => {
    const destA = {};
    const leituraA = await resolverLeituraCentral({
      req: reqDe({ id: 1 }, { query: { escopo: 'todas' } }),
      dest: destA
    }, deps);
    assert.equal(leituraA.visao.visao, 'todas');
    assert.deepEqual(destA.empresaIds, [10, 20]);
    assert.equal(destA.empresaId, null);

    const destB = {};
    const leituraB = await resolverLeituraCentral({
      req: reqDe({ id: 2 }, { query: { escopo: 'todas' } }),
      dest: destB
    }, deps);
    assert.deepEqual(destB.empresaIds, [30]);
    assert.equal(leituraB.ctx.origem, 'LEITURA_CONSOLIDADA');
  });

  it('usuário C recebe lista vazia sem EMPRESA_CENTRAL_AUSENTE', async () => {
    const dest = {};
    const leitura = await resolverLeituraCentral({
      req: reqDe({ id: 3 }, { query: { escopo: 'todas' } }),
      dest
    }, deps);
    assert.equal(leitura.visao.visao, 'todas');
    assert.deepEqual(dest.empresaIds, []);
    assert.equal(dest.empresaId, null);
  });

  it('escopo todas sem usuário autenticado não usa req.usuario', async () => {
    await assert.rejects(
      () => resolverLeituraCentral({
        req: { usuario: { id: 2 }, headers: {}, query: { escopo: 'todas' } },
        dest: {}
      }, deps),
      (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
    );
  });

  it('consulta SEFAZ continua exigindo empresa individual mesmo com escopo=todas', async () => {
    const rotas = src('backend/rotas/central-entradas.js');
    const consulta = trecho(
      'backend/rotas/central-entradas.js',
      "router.post('/operacao-fiscal-real/consultar-dfe'",
      "router.post('/operacao-fiscal-real/"
    );
    assert.match(consulta, /resolverEmpresaParaCentral/);
    assert.doesNotMatch(consulta, /resolverLeituraCentral/);
    assert.match(rotas, /router\.post\('\/sincronizar'/);

    await assert.rejects(
      () => resolverEmpresaParaCentral({
        req: reqDe({ id: 1 }, { query: { escopo: 'todas' } })
      }, deps),
      (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
    );
  });
});

describe('20B — troca de usuário na Central', () => {
  it('cache segue o usuário, lista vazia é estado vazio e falha não reutiliza dados', async () => {
    const front = src('frontend/erp/js/central-entradas.js');
    const helpers = trecho(
      'frontend/erp/js/central-entradas.js',
      'function idUsuarioCentralAtual()',
      'async function alinharContextoComDocumentoCentral'
    );
    const garantir = trecho(
      'frontend/erp/js/central-entradas.js',
      'async function garantirEmpresaAtivaParaCentral()',
      'function formatarCnpjUiCentral'
    );
    const carregar = trecho(
      'frontend/erp/js/central-entradas.js',
      'async function carregarEmpresasPermitidasCentral()',
      'function empresasFiltradasBuscaUiCentral'
    );

    const estado = {
      empresasPermitidas: [],
      empresasUsuarioId: null,
      empresasEstado: 'vazio',
      empresasErro: null,
      documentos: [{ id: 1 }],
      total: 4,
      ultimoDashboardContadores: { total: 4 },
      vistaEmpresas: 'contexto'
    };
    let usuario = { id: 1 };
    let falha = false;
    const limpezas = [];
    const selecionadas = [];
    const ctx = {
      centralEntradasState: estado,
      obterUsuarioLogadoCentral: () => usuario,
      centralModoEmpresaSimples: () => false,
      showNotification: () => {},
      CdsEmpresaContexto: {
        lerEmpresaId: () => 10,
        listarDisponiveis: async () => {
          if (falha) throw new Error('disponiveis indisponivel');
          if (usuario.id === 1) return [{ id: 10, ativo: 1 }, { id: 20, ativo: 1 }];
          if (usuario.id === 2) return [{ id: 30, ativo: 1 }];
          return [];
        },
        selecionar: async (id) => { selecionadas.push(id); },
        empresaPadrao: (lista) => lista[0],
        limpar: () => { limpezas.push(estado.empresasUsuarioId); }
      }
    };
    vm.createContext(ctx);
    vm.runInContext(`${helpers}\n${garantir}\n${carregar}`, ctx);

    await ctx.garantirEmpresaAtivaParaCentral();
    assert.deepEqual(estado.empresasPermitidas.map((e) => e.id), [10, 20]);
    assert.equal(estado.empresasUsuarioId, 1);
    assert.equal(estado.empresasEstado, 'ok');

    usuario = { id: 2 };
    await ctx.garantirEmpresaAtivaParaCentral();
    assert.deepEqual(estado.empresasPermitidas.map((e) => e.id), [30]);
    assert.equal(estado.empresasUsuarioId, 2);
    assert.deepEqual(estado.documentos, []);
    assert.ok(selecionadas.includes(30));

    usuario = { id: 1 };
    await ctx.garantirEmpresaAtivaParaCentral();
    assert.deepEqual(estado.empresasPermitidas.map((e) => e.id), [10, 20]);

    falha = true;
    estado.empresasPermitidas = [{ id: 10 }, { id: 20 }];
    estado.empresasEstado = 'ok';
    await ctx.garantirEmpresaAtivaParaCentral();
    assert.equal(estado.empresasEstado, 'erro');
    assert.deepEqual(estado.empresasPermitidas, []);
    assert.equal(ctx.podeLerCentralNoEscopoAtual(), false);
    assert.match(ctx.mensagemEscopoCentralBloqueado(), /Não foi possível consultar/);
    assert.ok(limpezas.length >= 1);

    falha = false;
    usuario = { id: 3 };
    await ctx.garantirEmpresaAtivaParaCentral();
    assert.equal(estado.empresasEstado, 'ok');
    assert.deepEqual(estado.empresasPermitidas, []);
    assert.equal(estado.vistaEmpresas, 'todas');
    assert.equal(ctx.podeLerCentralNoEscopoAtual(), true);
    assert.deepEqual(ctx.opcoesLeituraCentral(), { leituraConsolidada: true });

    assert.match(front, /empresasEstado === 'erro'/);
    assert.match(front, /empresas indisponíveis/);
    assert.match(front, /leituraConsolidada/);
    assert.match(front, /recarregarDadosCentralAposTrocaEmpresa/);
    assert.match(front, /contextoIndividualResolvidoCentral/);
  });

  it('login e sessão inválida descartam o contexto empresarial anterior', () => {
    const login = src('frontend/shared/js/login.js');
    const sucesso = trecho(
      'frontend/shared/js/login.js',
      'success: function (data)',
      'publicarLoginDuration(true)'
    );
    assert.match(sucesso, /invalidarContextoEmpresaDaSessaoAnterior\(\)/);
    const pos = sucesso.indexOf('invalidarContextoEmpresaDaSessaoAnterior()');
    const token = sucesso.indexOf("localStorage.setItem('token'");
    assert.ok(pos >= 0 && pos < token);

    const core = src('frontend/shared/js/core.js');
    const unauth = trecho('frontend/shared/js/core.js', 'function handleUnauthorized()', 'function isErroSessaoExpirada');
    assert.match(unauth, /cds_empresa_id/);
    assert.match(unauth, /cds_empresa/);
    assert.match(core, /function logout\(\)/);

    const contexto = src('frontend/shared/js/cds-empresa-contexto.js');
    const falha = trecho(
      'frontend/shared/js/cds-empresa-contexto.js',
      'Contexto empresarial: falha ao carregar empresas.',
      'if (!Array.isArray(disponiveis)'
    );
    assert.match(falha, /limpar\(\)/);
    assert.match(contexto, /function limpar\(\)/);
  });
});
