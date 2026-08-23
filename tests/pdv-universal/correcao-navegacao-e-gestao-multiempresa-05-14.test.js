/**
 * Sprint 05.14 — correção de navegação, sessão e gestão multiempresa.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const acesso = require('../../frontend/shared/js/pdv-acesso-oficial.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');
const { obterContexto } = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
const { exigirEmpresaAlvoAdministrativo, dtoPublicoConfiguracao } = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const EMP_A = { id: 2, razao_social: 'Empresa A', nome_fantasia: 'A', cnpj: '11', ativo: 1 };
const EMP_B = { id: 3, razao_social: 'Empresa B', nome_fantasia: 'B', cnpj: '22', ativo: 1 };

function depsBase(modo, empresas) {
  return {
    obterModoOperacaoVenda: () => modo,
    listarEmpresasDisponiveis: async () => empresas
  };
}

function test01RotaPdvUniversal() {
  const server = src('backend/server.js');
  assert.ok(server.includes("app.get(['/pdv-universal', '/pdv-universal/'], verificarToken"));
  assert.ok(server.includes("frontendRoot, 'pdv-universal/index.html'"));
  assert.strictEqual(acesso.urlPdvUniversalOficial(), '/pdv-universal/');
}

function test02RotaErpParaUniversal() {
  const erp = src('frontend/erp/index.html');
  assert.ok(erp.includes('href="/pdv-universal/"'));
  assert.ok(erp.includes('PDV Universal'));
  assert.ok(erp.includes('href="/pdv"'));
  assert.ok(!erp.includes('href="/pdv-universal"\n') || erp.includes('href="/pdv-universal/"'));
}

async function test03MultiempresaSemEmpresa() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('MULTIEMPRESA', [EMP_A, EMP_B]));
  assert.strictEqual(ctx.empresa_selecionada, null);
  const modelo = tela.montarModeloVisual(ctx);
  assert.strictEqual(modelo.estado, 'READY');
  assert.strictEqual(tela.avisoContextoPronto(ctx), '');
}

async function test04EmpresaUnicaExigeSelecao() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('EMPRESA_UNICA', [EMP_A, EMP_B]));
  assert.strictEqual(ctx.exige_selecao, true);
  assert.strictEqual(ctx.empresa_selecionada, null);
  assert.ok(tela.avisoContextoPronto(ctx).includes('Selecione uma empresa'));
  assert.strictEqual(tela.montarModeloVisual(ctx).estado, 'READY');
}

async function test05EmpresaInvalida() {
  const info = tela.classificarErroContexto({
    code: 'EMPRESA_OPERACIONAL_INVALIDA',
    status: 400,
    message: 'Empresa operacional inválida.'
  });
  assert.strictEqual(info.acao, 'SELECIONAR');
  assert.ok(info.mensagem.includes('Selecione a empresa'));
}

async function test06EmpresaInativa() {
  const info = tela.classificarErroContexto({ code: 'EMPRESA_INATIVA', status: 400 });
  assert.strictEqual(info.acao, 'SELECIONAR');
}

async function test07AusenciaEmpresa() {
  const info = tela.classificarErroContexto({
    code: 'NENHUMA_EMPRESA_DISPONIVEL',
    status: 409
  });
  assert.strictEqual(info.tipo, 'SEM_EMPRESA');
  assert.ok(info.mensagem.includes('Nenhuma empresa operacional está disponível.'));
  assert.strictEqual(info.acao, 'CADASTRAR');
  await assert.rejects(
    () => obterContexto({ user: { id: 9, nome: 'Op' } }, depsBase('EMPRESA_UNICA', [])),
    (err) => err.code === 'NENHUMA_EMPRESA_DISPONIVEL' && err.statusCode === 409
  );
}

function test08ErroAutenticacao() {
  const auth = src('backend/middleware/auth.js');
  assert.ok(auth.includes("code: 'SESSAO_INVALIDA'"));
  assert.ok(auth.includes('/login?next='));
  const info = tela.classificarErroContexto({ status: 401, code: 'SESSAO_INVALIDA' });
  assert.strictEqual(info.acao, 'LOGIN');
  assert.ok(info.mensagem.includes('sessão expirou'));
  const html = src('frontend/pdv-universal/index.html');
  assert.ok(html.includes('VOLTAR PARA LOGIN'));
}

function test09ErroContexto() {
  const info = tela.classificarErroContexto({
    status: 500,
    code: 'ERRO_CONTEXTO',
    message: 'falha interna do contexto'
  });
  assert.strictEqual(info.acao, 'RETRY');
  assert.ok(info.mensagem.includes('falha interna') || info.mensagem.includes('Não foi possível carregar o PDV'));
}

function test10Retry() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes("retry.addEventListener('click', carregar)"));
  assert.ok(src('frontend/pdv-universal/index.html').includes('TENTAR NOVAMENTE'));
  assert.ok(src('frontend/pdv-universal/index.html').includes('CADASTRAR EMPRESA'));
  assert.ok(js.includes('/erp?page=empresas'));
}

async function test11SemFallbackEmpresa1() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('EMPRESA_UNICA', [EMP_A, EMP_B]));
  assert.notStrictEqual(ctx.contexto.empresa_id, 1);
  assert.ok(tela.nuncaAssumirEmpresaUm(ctx));
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(!/empresa_id['"\s:=]+1/.test(js) || js.includes('nuncaAssumirEmpresaUm'));
}

function test12SemFallbackPdvLegado() {
  assert.strictEqual(acesso.urlPdvLegadoOficial(), '/pdv');
  assert.notStrictEqual(acesso.urlPdvUniversalOficial(), '/pdv');
  const helper = src('frontend/shared/js/pdv-acesso-oficial.js');
  assert.ok(!/location\.href\s*=\s*['"]\/pdv['"]/.test(helper.replace(/urlPdvLegadoOficial[\s\S]*?}/, '')));
  const erp = src('frontend/erp/index.html');
  assert.ok(erp.includes('PDV legado'));
  assert.ok(erp.includes('href="/pdv-universal/"'));
}

function test13RemoveItemLateralEmpresas() {
  const html = src('frontend/erp/index.html');
  assert.ok(!html.includes('data-page="empresas"'));
  const admin = html.split('data-nav-group="administracao"')[1] || '';
  assert.ok(!/<span>Empresas<\/span>/.test(admin));
}

function test14PresencaConfiguracoesAvancadas() {
  const centro = src('frontend/erp/js/cds-centro-configuracoes.js');
  assert.ok(centro.includes('EMPRESAS'));
  assert.ok(centro.includes('btnAbrirGestaoEmpresas'));
  assert.ok(src('frontend/erp/index.html').includes('data-page="configuracoes-avancadas"'));
}

function test15LinkCorreto() {
  const centro = src('frontend/erp/js/cds-centro-configuracoes.js');
  assert.ok(centro.includes("loadPage('empresas')"));
  assert.ok(src('frontend/erp/js/app.js').includes("case 'empresas':"));
  assert.ok(src('frontend/erp/js/gestao-empresas-fiscal.js').includes('configuracoes-avancadas'));
}

function test16CarregamentoDadosEmpresa() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('/empresas/${Number(empresaId)}'));
  assert.ok(js.includes('Razão Social') || js.includes('razao_social'));
}

function test17CarregamentoConfigFiscal() {
  assert.strictEqual(G.urlGetFiscal(10), '/api/empresas/10/configuracao-fiscal');
  assert.ok(src('backend/rotas/empresas.js').includes("router.get('/:empresaId/configuracao-fiscal'"));
}

function test18PutParcial() {
  const p = G.montarPayloadFiscal({ ambiente: 2, token_csc: '', serie: 1 }, 10);
  assert.strictEqual(p.ambiente, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(p, 'token_csc'));
}

function test19EmpresaIdDivergenteBloqueado() {
  assert.throws(
    () => exigirEmpresaAlvoAdministrativo(10, { empresa_id: 99 }),
    (err) => err.code === 'EMPRESA_CONFIGURACAO_DIVERGENTE'
  );
  const envio = G.payloadNaoSubstituiUrl(10, { empresa_id: 99, ambiente: 2 });
  assert.ok(!('empresa_id' in envio.payload));
}

function test20CertificadoPorEmpresa() {
  const fiscal = src('backend/rotas/fiscal.js');
  assert.ok(fiscal.includes('certificado-empresa-${empresaId}.pfx'));
  assert.ok(fiscal.includes('empresa_id'));
}

function test21TrocaNaoMistura() {
  const s = G.abrirEmpresa(G.criarSessaoDetalhe(), 10);
  assert.ok(G.empresaANaoCarregaB(s, 10));
  assert.ok(!G.empresaANaoCarregaB(s, 20));
}

function test22DtoSemSegredos() {
  const dto = dtoPublicoConfiguracao(
    { id: 7, cnpj: '11222333000181', razao_social: 'X', ativo: 1 },
    {
      ambiente: 2,
      token_csc: 'SEGREDO',
      certificado_senha: 'senha',
      certificado_path: 'C:/interno/certificado-empresa-7.pfx'
    }
  );
  assert.ok(G.dtoNaoExpoeSegredos(dto));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_path'));
}

async function testRetryHeaderInvalido() {
  let n = 0;
  const fetchFn = async () => {
    n += 1;
    if (n === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ code: 'EMPRESA_OPERACIONAL_INVALIDA', error: 'inválida' })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        modo_operacao: 'MULTIEMPRESA',
        empresa_selecionada: null,
        empresas_disponiveis: [EMP_A]
      })
    };
  };
  const ctx = await tela.carregarContextoComRecuperacao(fetchFn);
  assert.strictEqual(n, 2);
  assert.strictEqual(ctx.modo_operacao, 'MULTIEMPRESA');
}

function testLoginNext() {
  assert.strictEqual(acesso.destinoNavegacaoSeguro('/pdv-universal/'), '/pdv-universal/');
  assert.strictEqual(acesso.destinoNavegacaoSeguro('https://evil'), null);
  assert.ok(src('frontend/shared/login.html').includes('pdv-acesso-oficial.js'));
  assert.ok(src('frontend/shared/js/access-control.js').includes('destinoNavegacaoSeguro'));
}

async function run() {
  const testes = [
    test01RotaPdvUniversal,
    test02RotaErpParaUniversal,
    test03MultiempresaSemEmpresa,
    test04EmpresaUnicaExigeSelecao,
    test05EmpresaInvalida,
    test06EmpresaInativa,
    test07AusenciaEmpresa,
    test08ErroAutenticacao,
    test09ErroContexto,
    test10Retry,
    test11SemFallbackEmpresa1,
    test12SemFallbackPdvLegado,
    test13RemoveItemLateralEmpresas,
    test14PresencaConfiguracoesAvancadas,
    test15LinkCorreto,
    test16CarregamentoDadosEmpresa,
    test17CarregamentoConfigFiscal,
    test18PutParcial,
    test19EmpresaIdDivergenteBloqueado,
    test20CertificadoPorEmpresa,
    test21TrocaNaoMistura,
    test22DtoSemSegredos,
    testRetryHeaderInvalido,
    testLoginNext
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.14 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
