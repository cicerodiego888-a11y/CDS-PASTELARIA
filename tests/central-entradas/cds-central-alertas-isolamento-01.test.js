/**
 * Sprint 1 — Isolamento multiempresa de alertas e pendências.
 * Banco em memória. Não abre o banco oficial e não consulta a SEFAZ.
 * Executar: node --test --test-concurrency=1 tests/central-entradas/cds-central-alertas-isolamento-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralAlertasService = require('../../backend/motores/central-entradas/services/CentralAlertasService');
const { escopoEmpresaConsulta } = require('../../backend/motores/central-entradas/services/CentralAlertasService');
const CentralPendenciasService = require('../../backend/motores/central-entradas/services/CentralPendenciasService');
const CentralAtencaoService = require('../../backend/motores/central-entradas/services/CentralAtencaoService');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const {
  resolverLeituraCentral
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');

const EMP_A = 10;
const EMP_B = 20;
const EMP_C = 30;
const CNPJ_COMPARTILHADO = '11111111000191';
const CNPJ_B = '22222222000172';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

async function criarDb() {
  const db = await openMem();
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT,
      numero TEXT,
      serie TEXT,
      modelo TEXT,
      fornecedor TEXT,
      cnpj_fornecedor TEXT,
      data_emissao TEXT,
      data_entrada TEXT,
      valor_total REAL,
      xml TEXT,
      nsu TEXT,
      origem TEXT,
      status TEXT,
      status_detalhe TEXT,
      tipo_documento TEXT,
      parse_json TEXT,
      miip_sessao_id TEXT,
      miip_resumo_json TEXT,
      compra_id TEXT,
      usuario_id INTEGER,
      processado_em TEXT,
      empresa_id INTEGER,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  return db;
}

async function inserir(db, dados) {
  return run(
    db,
    `INSERT INTO central_entradas_documentos
      (chave, fornecedor, cnpj_fornecedor, status, valor_total, xml, empresa_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '<nfe/>', ?, ${dados.quando}, ${dados.quando})`,
    [dados.chave, dados.fornecedor, dados.cnpj, dados.status, dados.valor, dados.empresaId]
  );
}

async function seed(db) {
  const agora = "datetime('now', 'localtime')";
  const antigo = "datetime('now', 'localtime', '-10 days')";
  const idAFornecedor = await inserir(db, {
    chave: 'CHAVE-A',
    fornecedor: 'Fornecedor A',
    cnpj: CNPJ_COMPARTILHADO,
    status: DocumentoFiscalStatus.SINCRONIZADA,
    valor: 100,
    empresaId: EMP_A,
    quando: agora
  });
  const idCFornecedor = await inserir(db, {
    chave: 'CHAVE-C',
    fornecedor: 'Fornecedor C',
    cnpj: CNPJ_COMPARTILHADO,
    status: DocumentoFiscalStatus.SINCRONIZADA,
    valor: 900,
    empresaId: EMP_C,
    quando: agora
  });
  const idBFornecedor = await inserir(db, {
    chave: 'CHAVE-B',
    fornecedor: 'Fornecedor B',
    cnpj: CNPJ_B,
    status: DocumentoFiscalStatus.SINCRONIZADA,
    valor: 200,
    empresaId: EMP_B,
    quando: agora
  });
  const idARevisao = await inserir(db, {
    chave: 'REV-A',
    fornecedor: 'Revisao A',
    cnpj: '33333333000153',
    status: DocumentoFiscalStatus.AGUARDANDO_REVISAO,
    valor: 10,
    empresaId: EMP_A,
    quando: antigo
  });
  const idBRevisao = await inserir(db, {
    chave: 'REV-B',
    fornecedor: 'Revisao B',
    cnpj: '44444444000134',
    status: DocumentoFiscalStatus.AGUARDANDO_REVISAO,
    valor: 20,
    empresaId: EMP_B,
    quando: antigo
  });
  const idCRevisao = await inserir(db, {
    chave: 'REV-C',
    fornecedor: 'Revisao C',
    cnpj: '55555555000115',
    status: DocumentoFiscalStatus.AGUARDANDO_REVISAO,
    valor: 30,
    empresaId: EMP_C,
    quando: antigo
  });
  const idNulo = await inserir(db, {
    chave: 'REV-NULO',
    fornecedor: 'Sem empresa',
    cnpj: '66666666000196',
    status: DocumentoFiscalStatus.AGUARDANDO_REVISAO,
    valor: 40,
    empresaId: null,
    quando: antigo
  });
  return { idAFornecedor, idBFornecedor, idCFornecedor, idARevisao, idBRevisao, idCRevisao, idNulo };
}

function servicos(db) {
  const repo = new CentralDocumentosRepository({ db });
  const nsuRepository = {
    obterUltimaSincronizacao: async () => {
      throw new Error('NSU global não deve ser lido pelos alertas');
    }
  };
  const alertas = new CentralAlertasService({ documentosRepository: repo, nsuRepository });
  const pendencias = new CentralPendenciasService({
    documentosRepository: repo,
    nsuRepository,
    alertasService: alertas
  });
  const atencao = new CentralAtencaoService({
    documentosRepository: repo,
    nsuRepository,
    alertasService: alertas,
    pendenciasService: pendencias
  });
  return { repo, alertas, pendencias, atencao };
}

function idsDeAlertas(resultado) {
  const ids = [];
  for (const alerta of resultado.alertas || []) {
    for (const id of alerta.documentoIds || []) ids.push(id);
    for (const fornecedor of alerta.fornecedores || []) {
      if (fornecedor.documentoId != null) ids.push(fornecedor.documentoId);
    }
  }
  return ids;
}

function idsDePendencias(pendencias) {
  const ids = [];
  for (const secao of ['aguardandoRevisao', 'comprasAbertas', 'erros', 'xmlInvalido']) {
    for (const item of pendencias.secoes[secao] || []) ids.push(item.documentoId);
  }
  return ids;
}

function depsAutorizacao(permitidasPorUsuario) {
  return {
    contrato: { modo_operacional: 'MULTIEMPRESA' },
    EmpresaService: {
      async buscarEmpresaPorId(id) {
        return { id: Number(id), ativo: 1, cnpj: '12345678000199' };
      }
    },
    UsuarioEmpresaService: {
      async exigirEmpresaAutorizada(user, empresaId) {
        const permitidas = permitidasPorUsuario(user);
        if (!permitidas.includes(Number(empresaId))) {
          const err = new Error('Usuário não está autorizado a usar esta empresa.');
          err.code = 'EMPRESA_NAO_AUTORIZADA';
          throw err;
        }
      },
      async listarEmpresasPermitidas(user) {
        return permitidasPorUsuario(user).map((id) => ({ id }));
      }
    }
  };
}

function usuario(id, empresas) {
  return { id, empresas };
}

describe('Sprint 1 — isolamento de alertas e pendências', () => {
  it('cenário 1 — empresa A vê os próprios alertas e não vê B nem C', async () => {
    const db = await criarDb();
    const ids = await seed(db);
    const { alertas, pendencias } = servicos(db);

    const resultado = await alertas.listarAlertas({ empresaId: EMP_A });
    const vistos = idsDeAlertas(resultado);
    assert.ok(vistos.includes(ids.idAFornecedor));
    assert.ok(!vistos.includes(ids.idBFornecedor));
    assert.ok(!vistos.includes(ids.idBRevisao));
    assert.ok(!vistos.includes(ids.idCFornecedor));
    assert.ok(!vistos.includes(ids.idCRevisao));
    assert.ok(!vistos.includes(ids.idNulo));

    const pend = await pendencias.obterPendencias({ empresaId: EMP_A, limite: 50 });
    const vistosPend = idsDePendencias(pend);
    assert.deepEqual(vistosPend, [ids.idARevisao]);
    db.close();
  });

  it('cenário 2 — empresas A e B juntas não incluem C', async () => {
    const db = await criarDb();
    const ids = await seed(db);
    const { alertas, pendencias } = servicos(db);
    const escopo = { empresaIds: [EMP_A, EMP_B] };

    const resultado = await alertas.listarAlertas(escopo);
    const vistos = [...new Set(idsDeAlertas(resultado))];
    assert.ok(vistos.includes(ids.idAFornecedor));
    assert.ok(vistos.includes(ids.idBFornecedor));
    assert.ok(!vistos.includes(ids.idCFornecedor));
    assert.ok(!vistos.includes(ids.idCRevisao));
    assert.ok(!vistos.includes(ids.idNulo));

    const pend = await pendencias.obterPendencias({ ...escopo, limite: 50 });
    const vistosPend = idsDePendencias(pend).sort((a, b) => a - b);
    assert.deepEqual(vistosPend, [ids.idARevisao, ids.idBRevisao].sort((a, b) => a - b));
    db.close();
  });

  it('cenário 3 — sem vínculo não devolve alerta, pendência nem fornecedor global', async () => {
    const db = await criarDb();
    await seed(db);
    const { repo, alertas, pendencias } = servicos(db);
    const deps = depsAutorizacao((user) => user.empresas);

    const dest = {};
    const leitura = await resolverLeituraCentral({
      req: { user: usuario(4, []), query: { escopo: 'todas' } },
      dest
    }, deps);
    assert.equal(leitura.visao.visao, 'todas');
    assert.deepEqual(dest.empresaIds, []);

    const resultado = await alertas.listarAlertas(dest);
    const pend = await pendencias.obterPendencias({ ...dest, limite: 50 });
    const fornecedores = await repo.listarFornecedoresNovos(dest);
    assert.equal(resultado.total, 0);
    assert.deepEqual(resultado.alertas, []);
    assert.equal(pend.resumo.total, 0);
    assert.deepEqual(pend.secoes.aguardandoRevisao, []);
    assert.deepEqual(pend.secoes.alertas, []);
    assert.deepEqual(fornecedores, []);

    const semEscopo = await alertas.listarAlertas();
    assert.deepEqual(idsDeAlertas(semEscopo), []);
    db.close();
  });

  it('cenário 4 — empresa não autorizada é recusada antes da consulta', async () => {
    const deps = depsAutorizacao((user) => user.empresas);
    const dest = {};
    await assert.rejects(
      () => resolverLeituraCentral({
        req: {
          user: usuario(2, [EMP_B]),
          headers: { 'x-empresa-id': String(EMP_A) },
          query: {}
        },
        empresaId: EMP_A,
        dest
      }, deps),
      (err) => err && err.code === 'EMPRESA_NAO_AUTORIZADA' && err.statusCode === 403
    );
    assert.equal(dest.empresaId, undefined);

    const rotas = src('backend/rotas/central-entradas.js');
    const blocoAlertas = rotas.slice(
      rotas.indexOf("router.get('/alertas'"),
      rotas.indexOf("router.get('/pendencias'")
    );
    const blocoPendencias = rotas.slice(
      rotas.indexOf("router.get('/pendencias'"),
      rotas.indexOf("router.get('/operacional'")
    );
    assert.ok(blocoAlertas.indexOf('resolverLeituraCentral') < blocoAlertas.indexOf('listarAlertas(dest)'));
    assert.ok(blocoAlertas.includes('resolverEmpresaParaCentral'));
    assert.ok(blocoPendencias.indexOf('resolverLeituraCentral') < blocoPendencias.indexOf('obterPendencias(dest)'));
    assert.ok(blocoPendencias.includes('responderErroDocumentoCentral'));
  });

  it('cenário 5 — inteligência usa o mesmo escopo em indicadores, alertas e pendências', async () => {
    const db = await criarDb();
    const ids = await seed(db);
    const { repo, alertas, pendencias, atencao } = servicos(db);
    const escopo = escopoEmpresaConsulta({ empresaIds: [EMP_A, EMP_B] });

    const resultadoAlertas = await alertas.listarAlertas(escopo);
    const pend = await pendencias.obterPendencias({
      limite: 20,
      alertasResultado: resultadoAlertas,
      ...escopo
    });
    const filas = await repo.contarPorStatus({
      empresaId: escopo.empresaId,
      empresaIds: escopo.empresaIds
    });
    const painel = await atencao.obterItensAtencao({
      alertasResultado: resultadoAlertas,
      pendenciasResultado: pend,
      ...escopo
    });

    const proibidos = [ids.idCFornecedor, ids.idCRevisao, ids.idNulo];
    for (const id of [...idsDeAlertas(resultadoAlertas), ...idsDePendencias(pend)]) {
      assert.ok(!proibidos.includes(id), `documento ${id} fora do escopo`);
    }
    assert.equal(filas[DocumentoFiscalStatus.AGUARDANDO_REVISAO], 2);
    const revisao = painel.itens.find((item) => item.id === 'revisao');
    assert.equal(revisao.quantidade, 2);

    const orquestrador = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
    const fn = orquestrador.slice(
      orquestrador.indexOf('async obterInteligenciaOperacional'),
      orquestrador.indexOf('async obterScoreDocumento')
    );
    assert.ok(fn.includes('const escopo = escopoEmpresaConsulta(opcoes)'));
    assert.ok(fn.includes('listarAlertas(escopo)'));
    assert.ok(fn.includes('...escopo'));
    assert.ok(fn.includes('empresaId: escopo.empresaId'));
    assert.ok(fn.includes('empresaIds: escopo.empresaIds'));
    assert.ok(fn.includes('alertasResultado: alertas'));
    db.close();
  });

  it('cenário 6 — usuário autorizado continua vendo a própria empresa no contrato atual', async () => {
    const db = await criarDb();
    const ids = await seed(db);
    const { alertas, pendencias } = servicos(db);
    const deps = depsAutorizacao((user) => user.empresas);
    const dest = {};
    await resolverLeituraCentral({
      req: {
        user: usuario(1, [EMP_A]),
        headers: { 'x-empresa-id': String(EMP_A) },
        query: {}
      },
      empresaId: EMP_A,
      dest
    }, deps);
    assert.equal(dest.empresaId, EMP_A);

    const resultado = await alertas.listarAlertas(dest);
    assert.equal(typeof resultado.total, 'number');
    assert.ok(Array.isArray(resultado.alertas));
    assert.ok(resultado.total > 0);
    const fornecedorNovo = resultado.alertas.find((alerta) => alerta.tipo === 'FORNECEDOR_NOVO');
    assert.ok(fornecedorNovo);
    assert.equal(typeof fornecedorNovo.gravidade, 'string');
    assert.equal(typeof fornecedorNovo.icone, 'string');
    assert.equal(typeof fornecedorNovo.cor, 'string');
    assert.equal(typeof fornecedorNovo.descricao, 'string');
    assert.equal(typeof fornecedorNovo.acaoSugerida, 'string');
    assert.ok(Array.isArray(fornecedorNovo.documentoIds));
    assert.ok(Array.isArray(fornecedorNovo.fornecedores));
    assert.deepEqual(
      [...fornecedorNovo.documentoIds].sort((a, b) => a - b),
      [ids.idAFornecedor, ids.idARevisao].sort((a, b) => a - b)
    );

    const pend = await pendencias.obterPendencias({ ...dest, limite: 5 });
    assert.equal(typeof pend.resumo.aguardandoRevisao, 'number');
    assert.equal(typeof pend.resumo.total, 'number');
    assert.ok(Array.isArray(pend.secoes.aguardandoRevisao));
    assert.ok(Array.isArray(pend.secoes.comprasAbertas));
    assert.ok(Array.isArray(pend.secoes.erros));
    assert.ok(Array.isArray(pend.secoes.xmlInvalido));
    assert.ok(Array.isArray(pend.secoes.falhasSincronizacao));
    assert.ok(Array.isArray(pend.secoes.alertas));
    assert.equal(pend.secoes.aguardandoRevisao.length, 1);
    assert.equal(pend.secoes.aguardandoRevisao[0].documentoId, ids.idARevisao);
    assert.equal(pend.secoes.aguardandoRevisao[0].fornecedor, 'Revisao A');
    db.close();
  });
});
