/**
 * CONTEXTO-EMPRESA-01 — cadeia única de contexto (empresa → CNPJ → ambiente → certificado)
 * para Central de Monitoramento, Centro de Configurações e Central de Entradas.
 *
 * Código real exercitado: ContextoEmpresaOperacionalService, EmpresaService,
 * getFiscalConfig({ empresaId }) / empresas_configuracao_fiscal, IndicadoresFiscaisService,
 * FiscalProvider, MonitoringEngine, MonitoringController.anexarContextoEmpresa,
 * CentralConfiguracaoController, resolverEmpresaParaCentral.
 * Fixture: SQLite em memória (schema mínimo + cadastro via serviços oficiais).
 * Certificados: arquivos fictícios em diretório temporário, nunca abertos como PFX.
 * Nenhuma chamada SEFAZ; banco oficial nunca é aberto.
 *
 * Executar: node tests/central-entradas/contexto-empresa-operacional.test.js
 */
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

if (!process.env.DB_DIR) {
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-empresa-'));
}
const BANCO_OFICIAL = /MercantilFiscal[\\/]+dados[\\/]+mercadao\.db/i;
assert.ok(!BANCO_OFICIAL.test(process.env.DB_DIR), 'DB_DIR não pode apontar para o banco oficial');

const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(':memory:');
require.cache[require.resolve('../../backend/database')] = { exports: db };
require.cache[require.resolve('../../backend/motores/central-entradas/services/CentralXmlWaitScheduler')] = {
  exports: { enfileirarRecuperacao: async () => {}, cancelar: () => true }
};

// Barreiras: SOAP real e abertura de PFX falham o teste.
const runtimeDist = require('../../backend/services/fiscal/distribuicaoDfeRuntime');
let soapReal = 0;
runtimeDist.enviarDistribuicaoDfe = async () => {
  soapReal += 1;
  throw new Error('SOAP real proibido');
};
const certificateService = require('../../backend/services/fiscal/certificateService');
let pfxAberto = 0;
certificateService.carregarCertificadoPfx = async () => {
  pfxAberto += 1;
  throw new Error('Abertura de PFX proibida');
};

const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const fiscalEmpresa = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const Ctx = require('../../backend/services/empresas/ContextoEmpresaOperacionalService');
const IndicadoresFiscaisService = require('../../backend/services/IndicadoresFiscaisService');
const FiscalProvider = require('../../backend/monitoring/providers/FiscalProvider');
const { MonitoringEngine } = require('../../backend/monitoring/MonitoringEngine');
const { criarMonitoringContext } = require('../../backend/monitoring/MonitoringContext');
const { anexarContextoEmpresa } = require('../../backend/monitoring/MonitoringController');
const CentralConfiguracaoController = require(
  '../../backend/motores/central-entradas/controllers/CentralConfiguracaoController'
);
const { resolverEmpresaParaCentral } = require(
  '../../backend/services/central-entradas/CentralEntradasEmpresaContextoService'
);

const MULTI = ModoOperacionalGlobal.MULTIEMPRESA;
const SIMPLES = ModoOperacionalGlobal.EMPRESA_SIMPLES;
const CNPJ = Object.freeze({
  matriz: '38111111000148',
  filial1: '38111111000229',
  filial2: '38111111000300',
  filial3: '38111111000490'
});
const CNPJ_GLOBAL = '11222333000181';
const CERT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-empresa-cert-'));

let ok = 0;
let falhas = 0;

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      ok += 1;
      console.log(`  OK  ${nome}`);
    })
    .catch((err) => {
      falhas += 1;
      console.error(`  FALHOU  ${nome}`);
      console.error(`         ${err.stack || err.message}`);
    });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) { return err ? reject(err) : resolve(this); });
  });
}

function certFicticio(nome) {
  const p = path.join(CERT_DIR, nome);
  fs.writeFileSync(p, 'certificado-ficticio-nao-pfx');
  return p;
}

async function criarSchema() {
  await run(`CREATE TABLE empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cnpj TEXT UNIQUE NOT NULL, razao_social TEXT NOT NULL,
    nome_fantasia TEXT, inscricao_estadual TEXT, inscricao_municipal TEXT,
    ativo INTEGER NOT NULL DEFAULT 1, created_at DATETIME, updated_at DATETIME)`);
  await run(`CREATE TABLE configuracoes (chave TEXT PRIMARY KEY, valor TEXT, tipo TEXT, descricao TEXT)`);
  await run(`CREATE TABLE vendas (id INTEGER PRIMARY KEY, data_venda TEXT, status TEXT, total REAL,
    valor_fiscal REAL, valor_nao_fiscal REAL)`);
  await run(`CREATE TABLE nfe_notas (id INTEGER PRIMARY KEY, venda_id INTEGER, status TEXT, ambiente INTEGER)`);
  await run(`CREATE TABLE central_entradas_documentos (id INTEGER PRIMARY KEY, numero TEXT, chave TEXT,
    fornecedor TEXT, valor_total REAL, data_emissao TEXT, data_entrada TEXT, created_at TEXT,
    empresa_id INTEGER, status TEXT)`);
  await run(`CREATE TABLE compras (id INTEGER PRIMARY KEY, numero_nf TEXT, fornecedor TEXT,
    valor_total_nota REAL, total REAL, data_entrada TEXT, data_compra TEXT, created_at TEXT, chave_acesso TEXT)`);
}

async function definirGlobal(chave, valor) {
  await run(`INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`, [chave, valor]);
}

const E = {};

async function montarFixture() {
  await criarSchema();
  // Configuração global legada divergente de propósito (Homologação, outro CNPJ, outro certificado).
  await definirGlobal('fiscal_ambiente', '2');
  await definirGlobal('cnpj', CNPJ_GLOBAL);
  await definirGlobal('razao_social', 'Empresa Global Legada');
  await definirGlobal('fiscal_certificado_path', certFicticio('cert-global.pfx'));

  // Ordem alfabética coloca filiais antes da matriz.
  E.filial1 = await EmpresaService.criarEmpresa({ cnpj: CNPJ.filial1, razao_social: 'Alfa Filial 1' }, { db });
  E.filial2 = await EmpresaService.criarEmpresa({ cnpj: CNPJ.filial2, razao_social: 'Beta Filial 2' }, { db });
  E.matriz = await EmpresaService.criarEmpresa({ cnpj: CNPJ.matriz, razao_social: 'CDS Sistemas' }, { db });
  E.filial3 = await EmpresaService.criarEmpresa({ cnpj: CNPJ.filial3, razao_social: 'Delta Filial 3' }, { db });

  const fiscal = (ambiente, arquivo) => ({
    ambiente,
    uf: 'CE',
    codigo_uf: '23',
    serie: 1,
    numero_atual: 1,
    certificado_path: certFicticio(arquivo),
    certificado_senha: 'segredo-ficticio'
  });
  await fiscalEmpresa.upsertConfiguracaoFiscalEmpresa(E.matriz.id, fiscal(1, 'cert-matriz.pfx'), db);
  await fiscalEmpresa.upsertConfiguracaoFiscalEmpresa(E.filial1.id, fiscal(2, 'cert-filial1.pfx'), db);
  await fiscalEmpresa.upsertConfiguracaoFiscalEmpresa(E.filial2.id, fiscal(1, 'cert-filial2.pfx'), db);
  // filial3 sem configuração fiscal própria.

  // Uma NF-e autorizada em Produção na competência 2026-09.
  await run(`INSERT INTO vendas (id, data_venda, status, total, valor_fiscal) VALUES (1, '2026-09-10', 'finalizada', 100, 100)`);
  await run(`INSERT INTO nfe_notas (id, venda_id, status, ambiente) VALUES (1, 1, 'autorizada', 1)`);
}

const depsMulti = (extra = {}) => ({
  db,
  obterModoOperacionalGlobal: () => MULTI,
  obterEmpresaOperacionalId: () => null,
  ...extra
});
const depsSimples = (empresaOperacionalId) => ({
  db,
  obterModoOperacionalGlobal: () => SIMPLES,
  empresa_operacional_id: empresaOperacionalId
});
const reqEmpresa = (empresaId) => ({
  headers: empresaId != null ? { 'x-empresa-id': String(empresaId) } : {},
  query: {}
});
const resolver = (empresaId, deps = depsMulti()) => Ctx.resolverContextoEmpresaOperacional(
  { req: reqEmpresa(empresaId) },
  deps
);

async function summaryMonitoring(empresaId, query = { ano: '2026', mes: '9' }) {
  const req = { ...reqEmpresa(empresaId), query };
  const context = await anexarContextoEmpresa(criarMonitoringContext(req), req, depsMulti());
  const engine = new MonitoringEngine();
  const r = await engine.summary(context);
  return r.data;
}

function criarControllerCentral() {
  const chamadasPainel = [];
  const chamadasTeste = [];
  const configuracaoService = {
    async obterPainelCompleto(opcoes) {
      chamadasPainel.push(opcoes);
      return {
        empresaContexto: opcoes.empresa
          ? { estado: 'OK', empresaId: opcoes.empresa.empresaId }
          : { estado: 'EMPRESA_NAO_SELECIONADA', codigo: opcoes.empresaErro && opcoes.empresaErro.codigo },
        ambiente: { codigo: null }
      };
    }
  };
  const orchestrator = {
    async testarSefazDiagnostico(opcoes) { chamadasTeste.push(opcoes); return { sucesso: false }; },
    async testarCertificadoDiagnostico(opcoes) { chamadasTeste.push(opcoes); return { sucesso: false }; }
  };
  const controller = new CentralConfiguracaoController({
    configuracaoService,
    orchestrator,
    resolverEmpresa: (req) => resolverEmpresaParaCentral(
      { req, empresaId: req.empresaId },
      { contrato: { modo_operacional: MULTI, empresa_operacional: null }, db }
    ),
    resolverContextoEmpresa: (params) => Ctx.resolverContextoEmpresaOperacional(params, depsMulti())
  });
  const chamar = async (metodo, empresaId) => {
    let corpo = null;
    await controller[metodo](reqEmpresa(empresaId), {
      json(b) { corpo = b; return this; },
      status() { return this; }
    });
    return corpo;
  };
  return { controller, chamar, chamadasPainel, chamadasTeste };
}

(async () => {
  await montarFixture();
  console.log('CONTEXTO-EMPRESA-01 — cadeia única de contexto\n');

  // ————————————————————————————————————— A
  console.log('— A. matriz selecionada —');

  await test('A-01 matriz explícita: empresa, CNPJ, tipo, ambiente e certificado coerentes', async () => {
    const c = await resolver(E.matriz.id);
    assert.strictEqual(c.estado, 'OK');
    assert.strictEqual(c.contextoResolvido, true);
    assert.strictEqual(c.empresaId, E.matriz.id);
    assert.strictEqual(c.razaoSocial, 'CDS Sistemas');
    assert.strictEqual(c.cnpj, CNPJ.matriz);
    assert.strictEqual(c.tipoEmpresa, 'MATRIZ');
    assert.strictEqual(c.ambienteFiscal, 1);
    assert.strictEqual(c.ambienteLabel, 'Produção');
    assert.strictEqual(c.uf, 'CE');
    assert.strictEqual(c.certificado.empresaId, E.matriz.id);
    assert.strictEqual(c.certificado.cnpjEmpresa, CNPJ.matriz);
    assert.strictEqual(c.certificado.arquivo, 'cert-matriz.pfx');
    assert.strictEqual(c.origens.origemEmpresa, 'SELECAO_EXPLICITA');
    assert.strictEqual(c.origens.origemCnpj, 'empresas.cnpj');
    assert.strictEqual(c.origens.origemAmbiente, 'empresas_configuracao_fiscal');
    assert.strictEqual(c.origens.origemCertificado, 'empresas_configuracao_fiscal');
  });

  await test('A-02 visão global (sem seleção) → matriz por padrão, nunca EMPRESA_NAO_SELECIONADA', async () => {
    const c = await resolver(null);
    assert.strictEqual(c.estado, 'OK');
    assert.strictEqual(c.empresaId, E.matriz.id);
    assert.strictEqual(c.origens.origemEmpresa, 'MATRIZ_CNPJ_0001');
    assert.strictEqual(c.ambienteFiscal, 1);
  });

  await test('A-03 matriz não depende da ordem alfabética (filiais listadas antes)', async () => {
    const lista = await EmpresaService.listarEmpresas({ ativo: 1 }, { db });
    assert.strictEqual(lista[0].razao_social, 'Alfa Filial 1');
    const escolha = Ctx.escolherMatrizPadrao(lista);
    assert.strictEqual(Number(escolha.empresa.id), E.matriz.id);
    assert.strictEqual(Ctx.classificarTipoEmpresa(CNPJ.matriz), 'MATRIZ');
    assert.strictEqual(Ctx.classificarTipoEmpresa(CNPJ.filial1), 'FILIAL');
  });

  await test('A-04 Monitoramento sem seleção mostra a matriz (razão social, CNPJ, ambiente real)', async () => {
    const s = await summaryMonitoring(null);
    assert.strictEqual(s.contextoEmpresa.empresaId, E.matriz.id);
    assert.strictEqual(s.contextoEmpresa.razaoSocial, 'CDS Sistemas');
    assert.strictEqual(s.contextoEmpresa.cnpj, CNPJ.matriz);
    assert.strictEqual(s.indicadoresFiscais.ambiente, 1);
    assert.strictEqual(s.indicadoresFiscais.ambienteLabel, 'Produção');
  });

  await test('A-05 painel Central/Centro de Configurações sem seleção abre na matriz', async () => {
    const { chamar, chamadasPainel } = criarControllerCentral();
    const corpo = await chamar('obter', null);
    assert.strictEqual(chamadasPainel[0].empresa.empresaId, E.matriz.id);
    assert.strictEqual(chamadasPainel[0].empresaErro, undefined);
    assert.strictEqual(corpo.empresaContexto.estado, 'OK');
    assert.strictEqual(corpo.contextoEmpresa.razaoSocial, 'CDS Sistemas');
    assert.strictEqual(corpo.contextoEmpresa.cnpj, CNPJ.matriz);
    assert.strictEqual(corpo.contextoEmpresa.ambienteLabel, 'Produção');
    assert.strictEqual(corpo.contextoEmpresa.certificado.arquivo, 'cert-matriz.pfx');
  });

  // ————————————————————————————————————— B
  console.log('\n— B. nenhuma empresa selecionada / sem matriz válida —');

  const empresaServiceSo = (lista) => ({
    listarEmpresas: async () => lista,
    buscarEmpresaPorId: async (id) => lista.find((e) => Number(e.id) === Number(id)) || null
  });

  await test('B-01 sem matriz (só filiais ativas) → EMPRESA_NAO_SELECIONADA explícito, sem fallback global', async () => {
    const filiais = [E.filial1, E.filial2];
    const c = await Ctx.resolverContextoEmpresaOperacional(
      { req: reqEmpresa(null) },
      depsMulti({ EmpresaService: empresaServiceSo(filiais) })
    );
    assert.strictEqual(c.estado, 'EMPRESA_NAO_SELECIONADA');
    assert.strictEqual(c.codigo, 'MATRIZ_AUSENTE');
    assert.strictEqual(c.empresaId, null);
    assert.strictEqual(c.ambienteFiscal, null, 'configuracoes.fiscal_ambiente não é usado');
    assert.strictEqual(c.cnpj, null, 'configuracoes.cnpj não é usado');
    assert.strictEqual(c.certificado, null, 'certificado global não é usado');
  });

  await test('B-02 duas matrizes ativas → MATRIZ_AMBIGUA; empresa_operacional_id existente desempata', async () => {
    const outraMatriz = { id: 99, cnpj: CNPJ_GLOBAL, razao_social: 'Outra Raiz', ativo: 1 };
    const lista = [E.matriz, outraMatriz];
    const amb = Ctx.escolherMatrizPadrao(lista);
    assert.strictEqual(amb.empresa, null);
    assert.strictEqual(amb.codigo, 'MATRIZ_AMBIGUA');
    assert.deepStrictEqual(amb.candidatas.sort(), [E.matriz.id, 99].sort());
    const des = Ctx.escolherMatrizPadrao(lista, { empresaOperacionalId: E.matriz.id });
    assert.strictEqual(Number(des.empresa.id), E.matriz.id);
    assert.strictEqual(des.origem, 'MATRIZ_EMPRESA_OPERACIONAL_ID');
  });

  await test('B-03 empresa selecionada inexistente → CONTEXTO_EMPRESA_INVALIDO (não troca para matriz)', async () => {
    const c = await resolver(999);
    assert.strictEqual(c.estado, 'CONTEXTO_EMPRESA_INVALIDO');
    assert.strictEqual(c.empresaId, null);
    assert.strictEqual(c.ambienteFiscal, null);
  });

  await test('B-04 Monitoramento e painel sem matriz exibem estado controlado', async () => {
    const semMatriz = empresaServiceSo([E.filial1, E.filial2]);
    const req = reqEmpresa(null);
    const context = await anexarContextoEmpresa(criarMonitoringContext({ ...req, query: {} }), req,
      depsMulti({ EmpresaService: semMatriz }));
    assert.strictEqual(context.contextoEmpresa.estado, 'EMPRESA_NAO_SELECIONADA');
    const r = await FiscalProvider.collect(context);
    assert.strictEqual(r.data.indicadoresFiscais.ambiente, null);
    assert.strictEqual(r.data.indicadoresFiscais.ambienteLabel, 'Não configurado');

    const controller = new CentralConfiguracaoController({
      configuracaoService: { obterPainelCompleto: async (op) => ({ recebido: op }) },
      resolverEmpresa: async () => {
        const err = new Error('Modo MULTIEMPRESA exige empresa explícita.');
        err.code = 'EMPRESA_CENTRAL_AUSENTE';
        throw err;
      },
      resolverContextoEmpresa: (params) => Ctx.resolverContextoEmpresaOperacional(params,
        depsMulti({ EmpresaService: semMatriz }))
    });
    let corpo = null;
    await controller.obter(reqEmpresa(null), { json(b) { corpo = b; }, status() { return this; } });
    assert.strictEqual(corpo.recebido.empresa, undefined);
    assert.strictEqual(corpo.recebido.empresaErro.codigo, 'MATRIZ_AUSENTE');
    assert.strictEqual(corpo.contextoEmpresa.estado, 'EMPRESA_NAO_SELECIONADA');
  });

  await test('B-05 ações SEFAZ/certificado continuam exigindo empresa explícita (CE-06 P15)', async () => {
    const { chamar, chamadasTeste } = criarControllerCentral();
    await chamar('testarSefaz', null);
    await chamar('testarCertificado', null);
    assert.strictEqual(chamadasTeste.length, 2);
    chamadasTeste.forEach((op) => {
      assert.strictEqual(op.empresa, undefined);
      assert.strictEqual(op.empresaErro.codigo, 'EMPRESA_CENTRAL_AUSENTE');
    });
  });

  // ————————————————————————————————————— C
  console.log('\n— C. filial selecionada —');

  await test('C-01 filial 1 selecionada: Central recebe a filial, não a matriz', async () => {
    const { chamar, chamadasPainel } = criarControllerCentral();
    const corpo = await chamar('obter', E.filial1.id);
    assert.strictEqual(chamadasPainel[0].empresa.empresaId, E.filial1.id);
    assert.strictEqual(corpo.contextoEmpresa.empresaId, E.filial1.id);
    assert.strictEqual(corpo.contextoEmpresa.tipoEmpresa, 'FILIAL');
    assert.strictEqual(corpo.contextoEmpresa.cnpj, CNPJ.filial1);
    assert.strictEqual(corpo.contextoEmpresa.ambienteLabel, 'Homologação');
  });

  await test('C-02 filial 1 selecionada: Monitoramento mostra a filial e o ambiente dela', async () => {
    const s = await summaryMonitoring(E.filial1.id);
    assert.strictEqual(s.contextoEmpresa.empresaId, E.filial1.id);
    assert.strictEqual(s.contextoEmpresa.origens.origemEmpresa, 'SELECAO_EXPLICITA');
    assert.strictEqual(s.indicadoresFiscais.ambiente, 2);
    assert.strictEqual(s.indicadoresFiscais.empresaId, E.filial1.id);
  });

  // ————————————————————————————————————— D
  console.log('\n— D. volta para a matriz —');

  await test('D-01 matriz → filial → matriz: Central e Monitoramento retornam à matriz', async () => {
    const { chamar } = criarControllerCentral();
    const seq = [E.matriz.id, E.filial1.id, E.matriz.id];
    const central = [];
    const monit = [];
    for (const id of seq) {
      central.push((await chamar('obter', id)).contextoEmpresa);
      monit.push((await summaryMonitoring(id)).contextoEmpresa);
    }
    assert.deepStrictEqual(central.map((c) => c.empresaId), seq);
    assert.deepStrictEqual(monit.map((c) => c.empresaId), seq);
    assert.strictEqual(central[2].ambienteFiscal, 1);
    assert.strictEqual(monit[2].ambienteFiscal, 1);
    assert.strictEqual(central[2].certificado.arquivo, 'cert-matriz.pfx');
  });

  await test('D-02 limpar seleção (visão global) volta para a matriz', async () => {
    const antes = await resolver(E.filial2.id);
    const depois = await resolver(null);
    assert.strictEqual(antes.empresaId, E.filial2.id);
    assert.strictEqual(depois.empresaId, E.matriz.id);
  });

  // ————————————————————————————————————— E
  console.log('\n— E. configuração global antiga não sobrescreve a empresa —');

  await test('E-01 global Homologação/CNPJ/certificado próprios não alteram o contexto da matriz', async () => {
    const c = await resolver(null);
    assert.strictEqual(c.ambienteFiscal, 1);
    assert.strictEqual(c.cnpj, CNPJ.matriz);
    assert.notStrictEqual(c.certificado.arquivo, 'cert-global.pfx');
  });

  await test('E-02 alternar configuracoes.fiscal_ambiente (1 ↔ 2) não muda o ambiente da empresa', async () => {
    await definirGlobal('fiscal_ambiente', '1');
    const a = await resolver(E.filial1.id);
    await definirGlobal('fiscal_ambiente', '2');
    const b = await resolver(E.filial1.id);
    assert.strictEqual(a.ambienteFiscal, 2);
    assert.strictEqual(b.ambienteFiscal, 2);
  });

  await test('E-03 diagnóstico expõe origens e divergências globais (ambiente, CNPJ, certificado)', async () => {
    const d = await Ctx.diagnosticarContextoEmpresa({ req: reqEmpresa(null) }, depsMulti());
    assert.strictEqual(d.origens.origemEmpresa, 'MATRIZ_CNPJ_0001');
    assert.strictEqual(d.origens.origemCnpj, 'empresas.cnpj');
    assert.strictEqual(d.origens.origemAmbiente, 'empresas_configuracao_fiscal');
    assert.strictEqual(d.origens.origemCertificado, 'empresas_configuracao_fiscal');
    assert.ok(d.origens.origemCompetencia);
    assert.strictEqual(d.fontesLegadas.configuracoesFiscalAmbiente, 2);
    assert.strictEqual(d.fontesLegadas.usadasComoFallback, false);
    const campos = d.divergencias.map((x) => x.campo).sort();
    assert.deepStrictEqual(campos, ['ambiente', 'certificado', 'cnpj']);
    const amb = d.divergencias.find((x) => x.campo === 'ambiente');
    assert.strictEqual(amb.contextoEmpresa, 'Produção');
    assert.strictEqual(amb.legadoGlobal, 'Homologação');
  });

  await test('E-04 MULTIEMPRESA: empresa sem config fiscal própria → FISCAL_NAO_CONFIGURADO (sem global)', async () => {
    const c = await resolver(E.filial3.id);
    assert.strictEqual(c.estado, 'FISCAL_NAO_CONFIGURADO');
    assert.strictEqual(c.empresaId, E.filial3.id);
    assert.strictEqual(c.ambienteFiscal, null);
    assert.strictEqual(c.certificado.configurado, false);
    assert.strictEqual(c.origens.origemAmbiente, null);
  });

  await test('E-05 EMPRESA_SIMPLES sem config própria: global só como legado declarado na origem', async () => {
    const c = await resolver(null, depsSimples(E.filial3.id));
    assert.strictEqual(c.empresaId, E.filial3.id);
    assert.strictEqual(c.ambienteFiscal, 2);
    assert.strictEqual(c.origens.origemAmbiente, Ctx.ORIGEM_FISCAL_GLOBAL_LEGADO);
    const s = await resolver(null, depsSimples(E.matriz.id));
    assert.strictEqual(s.origens.origemAmbiente, 'empresas_configuracao_fiscal');
    assert.strictEqual(s.ambienteFiscal, 1);
  });

  // ————————————————————————————————————— F
  console.log('\n— F. ambiente da matriz no Monitoramento —');

  await test('F-01 Monitoramento exibe o ambiente da matriz (Produção) com global em Homologação', async () => {
    await definirGlobal('fiscal_ambiente', '2');
    const s = await summaryMonitoring(null);
    assert.strictEqual(s.indicadoresFiscais.ambiente, 1);
    assert.strictEqual(s.indicadoresFiscais.ambienteLabel, 'Produção');
    assert.strictEqual(s.indicadoresFiscais.ambienteOrigem, 'empresas_configuracao_fiscal');
    assert.strictEqual(s.indicadoresFiscais.ambiente, s.contextoEmpresa.ambienteFiscal);
  });

  await test('F-02 NF-e emitidas contadas no ambiente da empresa (Produção = 1), não no global', async () => {
    const s = await summaryMonitoring(null);
    assert.strictEqual(s.indicadoresFiscais.quantidadeNfeEmitidas, 1);
    const f1 = await summaryMonitoring(E.filial1.id);
    assert.strictEqual(f1.indicadoresFiscais.quantidadeNfeEmitidas, 0, 'filial em Homologação');
  });

  await test('F-03 falha do provider não cai em "Homologação" fixo: usa o contexto da empresa', async () => {
    const original = IndicadoresFiscaisService.obterResumo;
    IndicadoresFiscaisService.obterResumo = async () => { throw new Error('falha simulada'); };
    try {
      const req = reqEmpresa(null);
      const context = await anexarContextoEmpresa(criarMonitoringContext({ ...req, query: {} }), req, depsMulti());
      const r = await FiscalProvider.collect(context);
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.data.indicadoresFiscais.ambiente, 1);
      assert.strictEqual(r.data.indicadoresFiscais.ambienteLabel, 'Produção');
    } finally {
      IndicadoresFiscaisService.obterResumo = original;
    }
  });

  await test('F-04 indicadores da Central por empresa usam empresas_configuracao_fiscal', async () => {
    const m = await IndicadoresFiscaisService.obterIndicadoresCentral({ empresaId: E.matriz.id, ano: 2026, mes: 9 });
    const f = await IndicadoresFiscaisService.obterIndicadoresCentral({ empresaId: E.filial1.id, ano: 2026, mes: 9 });
    assert.strictEqual(m.ambiente, 1);
    assert.strictEqual(m.ambienteOrigem, 'empresas_configuracao_fiscal');
    assert.strictEqual(f.ambiente, 2);
    const legado = await IndicadoresFiscaisService.obterIndicadoresCentral({ ano: 2026, mes: 9 });
    assert.strictEqual(legado.ambienteOrigem, 'configuracoes.fiscal_ambiente', 'sem empresa: origem legada declarada');
  });

  // ————————————————————————————————————— G
  console.log('\n— G. certificado pertence à empresa —');

  await test('G-01 certificado exibido é o da empresa resolvida (matriz, filial 1, filial 2)', async () => {
    const esperado = [
      [E.matriz.id, 'cert-matriz.pfx', CNPJ.matriz],
      [E.filial1.id, 'cert-filial1.pfx', CNPJ.filial1],
      [E.filial2.id, 'cert-filial2.pfx', CNPJ.filial2]
    ];
    for (const [id, arquivo, cnpj] of esperado) {
      const c = await resolver(id);
      assert.strictEqual(c.certificado.empresaId, id);
      assert.strictEqual(c.certificado.arquivo, arquivo);
      assert.strictEqual(c.certificado.cnpjEmpresa, cnpj);
      assert.strictEqual(c.certificado.status, 'CONFIGURADO');
      assert.notStrictEqual(c.certificado.arquivo, 'cert-global.pfx');
    }
  });

  await test('G-02 contexto público não expõe senha nem caminho completo do certificado', async () => {
    const pub = Ctx.contextoPublico(await resolver(E.matriz.id));
    const json = JSON.stringify(pub);
    assert.ok(!json.includes('segredo-ficticio'), 'senha exposta');
    assert.ok(!json.includes(CERT_DIR.replace(/\\/g, '\\\\')), 'caminho completo exposto');
    assert.strictEqual(pub.certificado.senhaConfigurada, true);
  });

  await test('G-03 nenhum PFX foi aberto para montar o contexto', async () => {
    await resolver(E.matriz.id);
    await summaryMonitoring(null);
    assert.strictEqual(pfxAberto, 0);
  });

  // ————————————————————————————————————— H
  console.log('\n— H. competência ≠ ambiente —');

  await test('H-01 mudar a competência não muda o ambiente', async () => {
    const jan = await summaryMonitoring(null, { ano: '2026', mes: '1' });
    const set = await summaryMonitoring(null, { ano: '2026', mes: '9' });
    assert.notStrictEqual(jan.indicadoresFiscais.competencia, set.indicadoresFiscais.competencia);
    assert.strictEqual(jan.indicadoresFiscais.ambiente, 1);
    assert.strictEqual(set.indicadoresFiscais.ambiente, 1);
  });

  await test('H-02 mudar a empresa (ambiente) não muda a competência', async () => {
    const m = await summaryMonitoring(E.matriz.id, { ano: '2026', mes: '9' });
    const f = await summaryMonitoring(E.filial1.id, { ano: '2026', mes: '9' });
    assert.strictEqual(m.indicadoresFiscais.competencia, f.indicadoresFiscais.competencia);
    assert.notStrictEqual(m.indicadoresFiscais.ambiente, f.indicadoresFiscais.ambiente);
  });

  await test('H-03 origens distintas: competência vem da requisição, ambiente da empresa', async () => {
    const d = await Ctx.diagnosticarContextoEmpresa(
      { req: reqEmpresa(null), competencia: { competencia: '2026-09', label: 'Setembro/2026', origem: 'parametro ano/mes' } },
      depsMulti()
    );
    assert.strictEqual(d.origens.origemCompetencia, 'parametro ano/mes');
    assert.strictEqual(d.origens.origemAmbiente, 'empresas_configuracao_fiscal');
    assert.strictEqual(d.competencia.competencia, '2026-09');
    assert.ok(!('ambiente' in d.competencia));
    const s = await summaryMonitoring(null);
    assert.ok(!String(s.indicadoresFiscais.competenciaLabel).includes('Produção'));
  });

  // ————————————————————————————————————— I
  console.log('\n— I. três empresas: isolamento —');

  await test('I-01 alternar matriz/filial 1/filial 2 (2 ciclos) mantém cada contexto isolado', async () => {
    const esperado = {
      [E.matriz.id]: { cnpj: CNPJ.matriz, amb: 1, cert: 'cert-matriz.pfx', tipo: 'MATRIZ' },
      [E.filial1.id]: { cnpj: CNPJ.filial1, amb: 2, cert: 'cert-filial1.pfx', tipo: 'FILIAL' },
      [E.filial2.id]: { cnpj: CNPJ.filial2, amb: 1, cert: 'cert-filial2.pfx', tipo: 'FILIAL' }
    };
    const { chamar } = criarControllerCentral();
    const ordem = [E.matriz.id, E.filial1.id, E.filial2.id, E.matriz.id, E.filial2.id, E.filial1.id];
    for (const id of ordem) {
      const exp = esperado[id];
      const c = await resolver(id);
      const central = (await chamar('obter', id)).contextoEmpresa;
      const mon = await summaryMonitoring(id);
      for (const ctx of [c, central, mon.contextoEmpresa]) {
        assert.strictEqual(ctx.empresaId, id);
        assert.strictEqual(ctx.cnpj, exp.cnpj);
        assert.strictEqual(ctx.ambienteFiscal, exp.amb);
        assert.strictEqual(ctx.certificado.arquivo, exp.cert);
        assert.strictEqual(ctx.tipoEmpresa, exp.tipo);
      }
      assert.strictEqual(mon.indicadoresFiscais.ambiente, exp.amb);
    }
  });

  await test('I-02 resoluções concorrentes não vazam contexto entre empresas', async () => {
    const ids = [E.matriz.id, E.filial1.id, E.filial2.id, E.filial1.id, E.matriz.id];
    const res = await Promise.all(ids.map((id) => resolver(id)));
    assert.deepStrictEqual(res.map((c) => c.empresaId), ids);
    assert.deepStrictEqual(res.map((c) => c.ambienteFiscal), [1, 2, 1, 2, 1]);
  });

  // ————————————————————————————————————— Segurança
  console.log('\n— segurança —');

  await test('S-01 nenhuma chamada SOAP/SEFAZ, nenhum PFX aberto, banco oficial não usado', async () => {
    assert.strictEqual(soapReal, 0);
    assert.strictEqual(pfxAberto, 0);
    assert.ok(!BANCO_OFICIAL.test(process.env.DB_DIR));
  });

  await test('S-02 dados fiscais das empresas intactos após a suíte (ambiente, CNPJ, certificado)', async () => {
    const rows = await new Promise((resolve, reject) => {
      db.all(`SELECT e.id, e.cnpj, f.ambiente, f.certificado_path FROM empresas e
        LEFT JOIN empresas_configuracao_fiscal f ON f.empresa_id = e.id ORDER BY e.id`,
      (err, r) => (err ? reject(err) : resolve(r)));
    });
    const porId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.strictEqual(porId[E.matriz.id].cnpj, CNPJ.matriz);
    assert.strictEqual(porId[E.matriz.id].ambiente, 1);
    assert.strictEqual(porId[E.filial1.id].ambiente, 2);
    assert.strictEqual(porId[E.filial2.id].ambiente, 1);
    assert.strictEqual(porId[E.filial3.id].ambiente, null);
    assert.strictEqual(path.basename(porId[E.matriz.id].certificado_path), 'cert-matriz.pfx');
  });

  console.log(`\nResultado: ${ok} OK, ${falhas} FALHA(S)`);
  try { fs.rmSync(CERT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exitCode = falhas ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
