/**
 * Sprint 20C — autorização das rotas de sincronização e limpeza na saída por módulo negado.
 * Não abre o banco oficial e não chama a SEFAZ.
 * Executar: node --test tests/central-entradas/cds-central-sincronizacao-sessao-20c.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const {
  resolverEmpresaParaCentral
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');

const contratoMulti = { modo_operacional: 'MULTIEMPRESA', empresa_operacional: null };
const empresas = {
  10: { id: 10, ativo: 1, cnpj: '11111111000110' },
  30: { id: 30, ativo: 1, cnpj: '33333333000130' }
};
const vinculos = { 1: [10, 20], 2: [30], 3: [] };

function erro(code, status) {
  const err = new Error(code);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function usuarioId(fonte) {
  if (!fonte || typeof fonte !== 'object') return null;
  const n = Number(fonte.id != null ? fonte.id : fonte.usuario_id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const UsuarioEmpresaService = {
  async exigirEmpresaAutorizada(usuarioFonte, empresaId) {
    const uid = usuarioId(usuarioFonte);
    if (!uid) throw erro('USUARIO_OBRIGATORIO', 400);
    if (!(vinculos[uid] || []).includes(Number(empresaId))) throw erro('EMPRESA_NAO_AUTORIZADA', 403);
    return { usuarioId: uid, empresaId: Number(empresaId) };
  }
};

const deps = {
  contrato: contratoMulti,
  EmpresaService: {
    async buscarEmpresaPorId(id) {
      return empresas[Number(id)] || null;
    }
  },
  UsuarioEmpresaService
};

const sefazChamadas = [];

async function sincronizarIsolado(opcoes) {
  return {
    sucesso: true,
    consultaExecutada: false,
    sefazConsultada: false,
    empresaId: opcoes.empresaId,
    usuarioId: opcoes.usuarioId,
    cnpj: empresas[opcoes.empresaId] ? empresas[opcoes.empresaId].cnpj : null
  };
}

async function fluxoSincronizacao(req, executar) {
  const ctx = await resolverEmpresaParaCentral({ req, empresaId: req.empresaId }, deps);
  return executar({
    empresaId: ctx.empresaId,
    usuarioId: req.user && (req.user.id || req.user.usuario_id)
  });
}

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function trecho(rel, inicio, fim) {
  const texto = src(rel);
  const i = texto.indexOf(inicio);
  const j = texto.indexOf(fim, i + inicio.length);
  assert.ok(i >= 0 && j > i, `trecho ausente: ${inicio}`);
  return texto.slice(i, j);
}

describe('20C — sincronização exige empresa autorizada', () => {
  it('usuário A sincroniza a empresa 10 e a SEFAZ não é chamada', async () => {
    sefazChamadas.length = 0;
    const resultado = await fluxoSincronizacao({
      user: { id: 1 },
      headers: { 'x-empresa-id': '10' },
      query: {},
      body: { cnpj: '33333333000130', empresaId: 30 }
    }, sincronizarIsolado);
    assert.equal(resultado.empresaId, 10);
    assert.equal(resultado.usuarioId, 1);
    assert.equal(resultado.cnpj, '11111111000110');
    assert.equal(resultado.sefazConsultada, false);
    assert.equal(resultado.consultaExecutada, false);
    assert.equal(sefazChamadas.length, 0);
  });

  it('usuário B não sincroniza a empresa 10', async () => {
    let executou = false;
    await assert.rejects(
      () => fluxoSincronizacao({
        user: { id: 2 },
        usuario: { id: 1 },
        headers: { 'x-empresa-id': '10' },
        query: {},
        body: { empresaId: 10, cnpj: '11111111000110' }
      }, async () => {
        executou = true;
        return sincronizarIsolado({ empresaId: 10 });
      }),
      (err) => err.code === 'EMPRESA_NAO_AUTORIZADA' && err.statusCode === 403
    );
    assert.equal(executou, false);
  });

  it('usuário B sincroniza a empresa 30 em ambiente isolado', async () => {
    const resultado = await fluxoSincronizacao({
      user: { id: 2 },
      headers: { 'x-empresa-id': '30' },
      query: {}
    }, sincronizarIsolado);
    assert.equal(resultado.empresaId, 30);
    assert.equal(resultado.sefazConsultada, false);
  });

  it('sem empresa específica a sincronização é rejeitada', async () => {
    let executou = false;
    await assert.rejects(
      () => fluxoSincronizacao({
        user: { id: 1 },
        headers: {},
        query: { escopo: 'todas' },
        body: {}
      }, async () => {
        executou = true;
        return { sucesso: true };
      }),
      (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
    );
    assert.equal(executou, false);
  });

  it('as rotas oficiais resolvem a empresa antes de sincronizar e não chamam a SEFAZ neste teste', () => {
    const abrir = trecho(
      'backend/rotas/central-entradas.js',
      "router.post('/sincronizar-ao-abrir'",
      "router.get('/fornecedor/:cnpj/estatisticas'"
    );
    const manual = trecho(
      'backend/rotas/central-entradas.js',
      "router.post('/sincronizar'",
      "router.get('/buscar-chave'"
    );
    for (const rota of [abrir, manual]) {
      const resolve = rota.indexOf('resolverEmpresaParaCentral');
      const chama = rota.indexOf('empresaId: ctx.empresaId');
      assert.ok(resolve >= 0 && chama > resolve);
      assert.match(rota, /req\.user && \(req\.user\.id \|\| req\.user\.usuario_id\)/);
      assert.doesNotMatch(rota, /req\.body/);
      assert.doesNotMatch(rota, /sincronizarDistribuicaoDFe|consultarNotaPorChave/);
    }
    assert.match(src('backend/motores/central-entradas/services/CentralSyncExecucaoService.js'), /empresaIdFiltro: opcoes\.empresaId/);
    assert.match(src('backend/motores/central-entradas/CentralEntradasOrchestrator.js'), /alvosProcessamento/);
    assert.equal(
      Object.keys(require.cache).some((arquivo) => arquivo.includes('distribuicaoDFe')),
      false
    );
  });
});

describe('20C — saída por módulo negado', () => {
  function executarRedirecionamento({ podeModulo, podePdv, podeErp, modulo }) {
    const store = new Map([
      ['token', 'token-anterior'],
      ['user', '{"id":1}'],
      ['cds_empresa_id', '10'],
      ['cds_empresa', '{"id":10}']
    ]);
    const sandbox = {
      podeAcessarModulo: () => podeModulo,
      podeAbrirPDV: () => podePdv,
      podeAbrirERP: () => podeErp,
      URLSearchParams,
      localStorage: {
        getItem: (chave) => (store.has(chave) ? store.get(chave) : null),
        removeItem: (chave) => { store.delete(chave); },
        setItem: (chave, valor) => { store.set(chave, valor); }
      },
      window: {
        location: {
          search: '',
          href: null,
          replace(url) { this.href = url; }
        },
        CdsEmpresaContexto: {
          limpar() {
            store.delete('cds_empresa_id');
            store.delete('cds_empresa');
          }
        }
      }
    };
    vm.createContext(sandbox);
    const codigo = trecho(
      'frontend/shared/js/access-control.js',
      'function redirecionarSeModuloNegado(moduloAtual)',
      'window.obterUsuarioLogado = obterUsuarioLogado'
    );
    vm.runInContext(codigo, sandbox);
    const redirecionou = sandbox.redirecionarSeModuloNegado(modulo);
    return { redirecionou, href: sandbox.window.location.href, store };
  }

  it('nega o módulo, limpa token, usuário e empresa, e segue para /login', () => {
    const saida = executarRedirecionamento({
      podeModulo: false,
      podePdv: false,
      podeErp: false,
      modulo: 'erp'
    });
    assert.equal(saida.redirecionou, true);
    assert.equal(saida.href, '/login');
    assert.equal(saida.store.has('token'), false);
    assert.equal(saida.store.has('user'), false);
    assert.equal(saida.store.has('cds_empresa_id'), false);
    assert.equal(saida.store.has('cds_empresa'), false);
  });

  it('troca ERP para PDV sem encerrar a sessão nem mudar o destino', () => {
    const saida = executarRedirecionamento({
      podeModulo: false,
      podePdv: true,
      podeErp: false,
      modulo: 'erp'
    });
    assert.equal(saida.redirecionou, true);
    assert.equal(saida.href, '/pdv');
    assert.equal(saida.store.get('token'), 'token-anterior');
    assert.equal(saida.store.get('cds_empresa_id'), '10');
  });

  it('acesso permitido não redireciona', () => {
    const saida = executarRedirecionamento({
      podeModulo: true,
      podePdv: false,
      podeErp: false,
      modulo: 'erp'
    });
    assert.equal(saida.redirecionou, false);
    assert.equal(saida.href, null);
    assert.equal(saida.store.get('token'), 'token-anterior');
  });

  it('o próximo login descarta o contexto anterior antes de gravar o usuário novo', () => {
    const login = trecho(
      'frontend/shared/js/login.js',
      'function concluirPosLogin(data)',
      'const destino ='
    );
    const limpa = login.indexOf('invalidarContextoEmpresaDaSessaoAnterior()');
    const token = login.indexOf("localStorage.setItem('token'");
    assert.ok(limpa >= 0 && limpa < token);
    assert.match(src('frontend/shared/js/core.js'), /redirecionarSeModuloNegado\(window\.CDS_MODULE\)/);
    assert.match(src('frontend/shared/js/cds-empresa-contexto.js'), /async function inicializar\(/);
  });
});
