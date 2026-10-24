'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const {
  createMiipOriginDiagnostics,
  isEnabled
} = require('../../backend/motores/miip/diagnostics/MiipOriginDiagnostics');
const { ProdutoRepository } = require('../../backend/motores/miip/repositories/ProdutoRepository');
const produtoCache = require('../../backend/motores/miip/cache/ProdutoCache');
const MotorAssociacaoFornecedor = require('../../backend/motores/miip/engines/fornecedor/MotorAssociacaoFornecedor');
const MotorUniversalBuscaCandidatos = require('../../backend/motores/miip/engines/mubc/MotorUniversalBuscaCandidatos');
const MipLookupCache = require('../../backend/motores/produto-identidade/observability/MipLookupCache');
const ProdutoIdentidadeCatalogo = require('../../backend/motores/produto-identidade/services/ProdutoIdentidadeCatalogo');
const { MiipIntegracaoLogService } = require('../../backend/motores/miip/logs/MiipIntegracaoLogService');
const { MiipMotorLogService } = require('../../backend/motores/miip/logs/MiipMotorLogService');
const CentralProcessamentoService = require('../../backend/motores/central-entradas/services/CentralProcessamentoService');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const MiipCentralInteligente = require('../../frontend/erp/js/miip-central-revisao-inteligente');

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miip-origin-diagnostics-'));
const env = {
  NODE_ENV: 'test',
  CDS_MIIP_ORIGIN_DIAGNOSTICS: '1',
  DB_DIR: TEMP_DIR
};
const events = [];
const diagnostics = createMiipOriginDiagnostics({
  env,
  sink: (event) => events.push(event)
});
const silent = { registrar() {}, registrarExecucao() {} };

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      resolve(row || null);
    });
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

function criarCandidatoSintetico() {
  return {
    produtoId: 41,
    produto: {
      id: 41,
      nome: 'Refrigerante Cola 2L',
      codigo: 'ABC001',
      codigoBarras: '7891234567890'
    },
    scoreTotal: 74,
    evidencias: [
      { motor: 'motor_mubc', tipo: 'descricao', score: 74, valor: 'conteudo-ficticio' }
    ],
    motoresQueVotaram: ['motor_mubc'],
    atributosExtraidos: {
      origemDados: 'MUBC',
      motivosRelevancia: [{ tipo: 'descricao', rotulo: 'Descrição semelhante' }],
      matchMotivos: ['descricao', 'ncm']
    }
  };
}

async function criarSchema(db) {
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, codigo TEXT, codigo_barras TEXT, nome TEXT, unidade TEXT,
    ncm TEXT, cest TEXT, categoria_id INTEGER, subcategoria_id INTEGER, fornecedor TEXT,
    preco_venda REAL,
    ativo INTEGER, marca_id INTEGER
  )`);
  await run(db, 'CREATE TABLE marcas (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, `CREATE TABLE miip_associacoes (
    id INTEGER PRIMARY KEY, produto_id INTEGER, origem TEXT, fornecedor_cnpj TEXT,
    fornecedor_nome TEXT, codigo_fornecedor TEXT, codigo_barras TEXT, nome_item TEXT,
    nome_normalizado TEXT, ncm TEXT, unidade TEXT, score INTEGER, confianca TEXT,
    status TEXT, fonte TEXT, decisao_operacao_id TEXT, confirmado_por_usuario_id INTEGER,
    metadados TEXT, last_used_at TEXT, created_at TEXT, updated_at TEXT
  )`);
  await run(db, `CREATE TABLE compras (
    id INTEGER PRIMARY KEY, tipo_entrada TEXT, tipo_entrada_sugerido TEXT,
    tipo_entrada_confianca REAL, tipo_entrada_motivo TEXT, tipo_entrada_alterado INTEGER
  )`);
  await run(db, `CREATE TABLE central_entradas_documentos (
    id INTEGER PRIMARY KEY, chave TEXT, status TEXT, xml TEXT, parse_json TEXT,
    miip_resumo_json TEXT, miip_sessao_id TEXT, empresa_id INTEGER, compra_id INTEGER,
    fornecedor TEXT, numero TEXT, serie TEXT, modelo TEXT, cnpj_fornecedor TEXT,
    data_emissao TEXT, valor_total REAL, created_at TEXT, updated_at TEXT
  )`);
}

async function main() {
  let passou = 0;
  let falhou = 0;
  const db = new sqlite3.Database(':memory:');

  async function test(name, fn) {
    try {
      await fn();
      passou += 1;
      console.log(`  OK  ${name}`);
    } catch (error) {
      falhou += 1;
      console.error(`  FALHOU  ${name}`);
      console.error(`         ${error.stack || error.message}`);
    }
  }

  try {
    assert.equal(isEnabled(env), true);
    assert.equal(isEnabled({ ...env, NODE_ENV: 'production' }), false);
    assert.equal(isEnabled({ ...env, CDS_MIIP_ORIGIN_DIAGNOSTICS: '0' }), false);
    assert.equal(isEnabled({
      ...env,
      DB_DIR: path.resolve(process.cwd(), 'backend', 'banco')
    }), false);
    const disabledEvents = [];
    const disabledDiagnostics = createMiipOriginDiagnostics({
      env: { ...env, NODE_ENV: 'production' },
      sink: (event) => disabledEvents.push(event)
    });
    disabledDiagnostics.recordImport({
      documentoId: 7000,
      resultOrigin: 'novo_processamento',
      importResult: { resultados: [] }
    });
    assert.equal(disabledEvents.length, 0);

    console.log('\n=== Diagnóstico de origem MIIP (SQLite :memory:) ===\n');
    console.log('  OK  Instrumentação exige ambiente test, flag explícita e DB_DIR temporário');

    await criarSchema(db);
    await run(db, `INSERT INTO produtos
      (id,codigo,codigo_barras,nome,unidade,ncm,cest,fornecedor,ativo)
      VALUES (41,'ABC001','7891234567890','Refrigerante Cola 2L','UN','22021000','0300100','Fornecedor não divulgado',1)`);
    await run(db, `INSERT INTO produtos
      (id,codigo,codigo_barras,nome,unidade,ncm,fornecedor,ativo)
      VALUES (42,'SINT-42','1111111111111','Refrigerante Cola 2L','UN','22021000','Fornecedor não divulgado',1)`);
    await run(db, `INSERT INTO produtos
      (id,codigo,codigo_barras,nome,unidade,ncm,fornecedor,ativo)
      VALUES (43,'SINT-43','2222222222222','Produto associado fictício','UN','22021000','Fornecedor não divulgado',1)`);

    const repo = new ProdutoRepository({ db, originDiagnostics: diagnostics });

    await test('registra candidato de busca atual sem alterar identidade, score ou dados persistidos', async () => {
      produtoCache.limpar();
      const motor = new MotorUniversalBuscaCandidatos({
        produtoRepository: repo,
        metricsCollector: silent,
        logService: silent
      });
      let candidates;
      await diagnostics.withContext({ documentoId: 7001 }, async () => {
        diagnostics.setOperationId('op-miip-teste-01');
        candidates = await motor.identificar({
          produtoNome: 'Refrigerante Cola 2L',
          codigoBarras: '7891234567890',
          codigoFornecedor: 'CODIGO-EXTERNO-FICTICIO',
          ncm: '22021000',
          unidade: 'UN'
        });
      });
      const selected = candidates.find((candidate) => candidate.produtoId === 41);
      const textCandidate = candidates.find((candidate) => candidate.produtoId === 42);
      assert.ok(selected);
      assert.ok(textCandidate);
      assert.ok(textCandidate.atributosExtraidos.motivosRelevancia
        .some((motive) => motive.tipo === 'descricao'));
      assert.ok(!textCandidate.evidencias.some((evidence) => evidence.tipo === 'gtin_exato'));

      const before = selected.toJSON();
      const dbCountBefore = await get(db, 'SELECT COUNT(*) AS total FROM produtos');
      await diagnostics.withContext({ documentoId: 7001 }, async () => {
        diagnostics.setOperationId('op-miip-teste-01');
        diagnostics.recordImport({
          operacaoId: 'op-miip-teste-01',
          resultOrigin: 'novo_processamento',
          importResult: {
            resultados: [{
              operacaoId: 'op-miip-teste-01',
              score: selected.scoreTotal,
              motor: 'motor_mubc',
              produtoEncontrado: selected.produto,
              candidatoSelecionado: selected,
              candidatos: candidates
            }]
          }
        });
      });
      const after = selected.toJSON();
      assert.deepEqual(after, before);
      assert.equal((await get(db, 'SELECT COUNT(*) AS total FROM produtos')).total, dbCountBefore.total);

      const event = events.find((entry) => entry.evento === 'resultado_item'
        && entry.documentoId === 7001
        && entry.origemResultado === 'novo_processamento');
      assert.ok(event);
      assert.equal(event.operacaoId, 'op-miip-teste-01');
      assert.ok(event.candidatos.some((candidate) => candidate.produtoId === 41
        && candidate.fontes.includes('busca_textual_ncm')));
      assert.ok(event.candidatos.some((candidate) => candidate.produtoId === 42
        && candidate.fontes.includes('busca_textual_ncm')));
      assert.equal(event.candidatos.find((candidate) => candidate.produtoId === 41).scoreOriginal,
        selected.scoreTotal);
      assert.ok(!JSON.stringify(event).includes('7891234567890'));
      assert.ok(!JSON.stringify(event).includes('ABC001'));
      assert.ok(!JSON.stringify(event).includes('Refrigerante Cola 2L'));
      assert.ok(!JSON.stringify(event).includes('Fornecedor não divulgado'));
      const catalogEvent = events.find((entry) => entry.evento === 'busca_catalogo_universal'
        && entry.documentoId === 7001);
      assert.equal(catalogEvent.contextoCatalogo, 'sqlite_injetado');
      assert.ok(catalogEvent.candidatos.some((candidate) => candidate.produtoId === 41
        && candidate.motivosBusca.includes('descricao')));
    });

    await test('registra cache aquecido e snapshot desatualizado sem divulgar valores de identidade', async () => {
      produtoCache.limpar();
      await diagnostics.withContext({ documentoId: 7002, operacaoId: 'op-cache-teste' }, async () => {
        const first = await repo.buscarPorId(41);
        assert.equal(first.nome, 'Refrigerante Cola 2L');
        await run(db, `UPDATE produtos
          SET nome='Descrição atualizada fictícia', codigo='NOVO-CODIGO', codigo_barras='9999999999999'
          WHERE id=41`);
        const second = await repo.buscarPorId(41);
        assert.equal(second.nome, 'Refrigerante Cola 2L');
      });
      const hits = events.filter((entry) => entry.evento === 'consulta_produto'
        && entry.documentoId === 7002
        && entry.tipoConsulta === 'id');
      assert.equal(hits.length, 2);
      assert.deepEqual(hits.map((entry) => entry.cacheHit), [false, true]);
      assert.equal(hits[1].fonteConsulta, 'produto_cache');
      assert.equal(hits[1].produtoId, 41);
      assert.ok(!JSON.stringify(hits).includes('Refrigerante Cola 2L'));
    });

    await test('registra hit do cache MIP por GTIN sem registrar a chave consultada', async () => {
      const mipCache = new MipLookupCache(10);
      const catalogo = new ProdutoIdentidadeCatalogo({
        db,
        cache: mipCache,
        originDiagnostics: diagnostics
      });
      await diagnostics.withContext({ documentoId: 7007, operacaoId: 'op-mip-cache' }, async () => {
        const first = await catalogo.buscarProdutoPorCodigoBarras('1111111111111');
        assert.equal(first.id, 42);
        await run(db, `UPDATE produtos
          SET nome='Nome MIP alterado', codigo_barras='3333333333333'
          WHERE id=42`);
        const second = await catalogo.buscarProdutoPorCodigoBarras('1111111111111');
        assert.equal(second.nome, first.nome);
      });
      const lookups = events.filter((entry) => entry.evento === 'consulta_produto'
        && entry.documentoId === 7007
        && entry.tipoConsulta === 'gtin');
      assert.deepEqual(lookups.map((entry) => entry.cacheHit), [false, true]);
      assert.equal(lookups[1].fonteConsulta, 'produto_cache');
      assert.ok(!JSON.stringify(lookups).includes('1111111111111'));
    });

    await test('registra associação ativa sem incluir CNPJ ou cProd nos eventos', async () => {
      produtoCache.limpar();
      await run(db, `INSERT INTO miip_associacoes
        (id,produto_id,origem,fornecedor_cnpj,codigo_fornecedor,nome_item,status)
        VALUES (99,43,'manual','12345678000199','CODIGO-EXTERNO-FICTICIO','Descrição privada fictícia','ativa')`);
      const associationMotor = new MotorAssociacaoFornecedor({
        db,
        produtoRepository: repo,
        metricsCollector: silent,
        logService: silent
      });
      const candidates = await associationMotor.identificar({
        fornecedorCnpj: '12345678000199',
        codigoFornecedor: 'CODIGO-EXTERNO-FICTICIO'
      });
      assert.equal(candidates[0].produtoId, 43);
      diagnostics.recordImport({
        documentoId: 7003,
        operacaoId: 'op-associacao-teste',
        resultOrigin: 'novo_processamento',
        importResult: {
          resultados: [{
            operacaoId: 'op-associacao-teste',
            score: candidates[0].scoreTotal,
            motor: 'motor_associacao_fornecedor',
            candidatoSelecionado: candidates[0],
            produtoEncontrado: candidates[0].produto
          }]
        }
      });
      const event = events.find((entry) => entry.documentoId === 7003);
      assert.ok(event.candidatos[0].fontes.includes('associacao_fornecedor'));
      assert.ok(!JSON.stringify(event).includes('12345678000199'));
      assert.ok(!JSON.stringify(event).includes('CODIGO-EXTERNO-FICTICIO'));
    });

    await test('Central identifica resultado persistido reutilizado sem reexecutar parse ou MIIP', async () => {
      const persisted = {
        operacaoId: 'op-persistido-teste',
        resultados: [{
          operacaoId: 'op-persistido-teste',
          produtoEncontrado: { id: 41, nome: 'Snapshot antigo', codigo: 'ANTIGO', codigoBarras: '0000000000000' },
          candidatoSelecionado: {
            produtoId: 41,
            produto: { id: 41, nome: 'Snapshot antigo', codigo: 'ANTIGO', codigoBarras: '0000000000000' },
            motoresQueVotaram: ['motor_gtin'],
            evidencias: [{ motor: 'motor_gtin', tipo: 'gtin_exato', valor: 'GTIN privado' }]
          },
          score: 58,
          motor: 'motor_gtin'
        }]
      };
      const document = {
        id: 7004,
        empresaId: 7,
        status: DocumentoFiscalStatus.EM_REVISAO,
        parseJson: { miip_importacao: persisted },
        miipResumoJson: persisted,
        miipSessaoId: persisted.operacaoId
      };
      const documentRepository = { async buscarPorId() { return document; } };
      const service = new CentralProcessamentoService({
        documentosRepository: documentRepository,
        originDiagnostics: diagnostics,
        parseXml: async () => { throw new Error('parser não deveria rodar'); },
        enriquecerParse: async () => { throw new Error('MIIP não deveria rodar'); }
      });
      const response = await service.processar(7004, { empresaId: 7 });
      assert.equal(response.reutilizado, true, JSON.stringify(response));
      const event = events.find((entry) => entry.documentoId === 7004
        && entry.evento === 'resultado_item');
      assert.ok(event);
      assert.equal(event.origemResultado, 'persistido_reutilizado');
      assert.equal(event.operacaoId, 'op-persistido-teste');
      assert.equal(event.candidatos[0].scoreOriginal, 58);
      assert.ok(!JSON.stringify(event).includes('GTIN privado'));
    });

    await test('resultado sem metadados preserva origem desconhecida', async () => {
      diagnostics.recordImport({
        documentoId: 7005,
        operacaoId: 'op-sem-origem',
        resultOrigin: 'novo_processamento',
        importResult: {
          resultados: [{
            operacaoId: 'op-sem-origem',
            score: 58,
            produtoEncontrado: { id: 41 }
          }]
        }
      });
      const event = events.find((entry) => entry.documentoId === 7005);
      assert.deepEqual(event.candidatos[0].fontes, ['desconhecida']);
      assert.deepEqual(event.candidatos[0].origemCamposIdentidade, {
        nome: 'desconhecida',
        codigo: 'desconhecida',
        gtin: 'desconhecida'
      });
    });

    await test('logs MIIP existentes redigem campos pessoais durante coleta habilitada', async () => {
      const keys = ['NODE_ENV', 'CDS_MIIP_ORIGIN_DIAGNOSTICS', 'DB_DIR'];
      const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      const originalLog = console.log;
      const originalInfo = console.info;
      const outputs = [];
      const diagnosticOutputs = [];
      try {
        process.env.NODE_ENV = 'test';
        process.env.CDS_MIIP_ORIGIN_DIAGNOSTICS = '1';
        process.env.DB_DIR = TEMP_DIR;
        console.log = (...args) => outputs.push(args.join(' '));
        console.info = (_prefix, json) => diagnosticOutputs.push(JSON.parse(json));

        const integracaoLog = new MiipIntegracaoLogService();
        const integracaoRecord = integracaoLog.registrar({
          evento: 'miip_teste',
          item: {
            produtoNome: 'Nome privado fictício',
            codigoBarras: '7891234567890',
            codigoFornecedor: 'ABC001',
            fornecedorCnpj: '12345678000199',
            fornecedor: 'Fornecedor privado fictício'
          },
          erro: 'Erro contendo GTIN 7891234567890'
        });
        const motorLog = new MiipMotorLogService();
        const motorRecord = motorLog.registrar({
          motor: 'motor_gtin',
          item: {
            produtoNome: 'Nome privado fictício',
            codigoBarras: '7891234567890',
            fornecedorCnpj: '12345678000199'
          },
          fornecedorCnpj: '12345678000199',
          codigoFornecedor: 'ABC001',
          erro: 'Erro contendo GTIN 7891234567890'
        });
        const mipCatalog = new ProdutoIdentidadeCatalogo({
          db,
          cache: new MipLookupCache(10),
          identificadoresRepository: {
            async buscarPorTipoCodigo() {
              return null;
            }
          }
        });
        await mipCatalog.resolverPorIdentificador('GTIN', '7891234567890');
        const logged = JSON.stringify({ integracaoRecord, motorRecord, outputs, diagnosticOutputs });
        assert.ok(!logged.includes('Nome privado fictício'));
        assert.ok(!logged.includes('Fornecedor privado fictício'));
        assert.ok(!logged.includes('12345678000199'));
        assert.ok(!logged.includes('7891234567890'));
        assert.ok(!logged.includes('ABC001'));
        assert.equal(integracaoRecord.item.produtoIdHint, null);
        assert.equal(motorRecord.fornecedorCnpj, null);
        assert.equal(outputs.some((line) => line.includes('[MIP DEBUG]')), false);
        assert.ok(diagnosticOutputs.some((event) => event.tipoConsulta === 'gtin'
          && event.cacheHit === false));
      } finally {
        console.log = originalLog;
        console.info = originalInfo;
        keys.forEach((key) => {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        });
      }
    });

    await test('interface registra origem dos campos sem alterar o candidato nem imprimir valores', async () => {
      const originalFlag = globalThis.CDS_MIIP_ORIGIN_DIAGNOSTICS;
      const originalInfo = console.info;
      const uiEvents = [];
      const candidate = {
        id: 41,
        nome: 'Snapshot antigo',
        codigo: 'COD-ANTIGO',
        codigoBarras: 'GTIN-ANTIGO'
      };
      const catalog = [{
        id: 41,
        nome: 'Nome atual',
        codigo: 'COD-ATUAL',
        codigo_barras: 'GTIN-ATUAL'
      }];
      const before = JSON.stringify(candidate);
      try {
        globalThis.CDS_MIIP_ORIGIN_DIAGNOSTICS = true;
        console.info = (_prefix, json) => uiEvents.push(JSON.parse(json));
        const displayed = MiipCentralInteligente.enriquecerProdutoCds(candidate, catalog, {
          documentoId: 7006,
          operacaoId: 'op-ui-teste',
          score: 58
        });
        assert.equal(displayed.nome, 'Snapshot antigo');
        assert.equal(JSON.stringify(candidate), before);
      } finally {
        console.info = originalInfo;
        if (originalFlag === undefined) delete globalThis.CDS_MIIP_ORIGIN_DIAGNOSTICS;
        else globalThis.CDS_MIIP_ORIGIN_DIAGNOSTICS = originalFlag;
      }
      assert.equal(uiEvents.length, 1);
      assert.deepEqual(uiEvents[0].origemCamposIdentidade, {
        nome: 'snapshot_miip',
        codigo: 'snapshot_miip',
        gtin: 'snapshot_miip'
      });
      assert.equal(uiEvents[0].scoreOriginal, 58);
      assert.ok(!JSON.stringify(uiEvents).includes('GTIN-ANTIGO'));
      assert.ok(!JSON.stringify(uiEvents).includes('Snapshot antigo'));
    });

    if (falhou > 0) process.exitCode = 1;
    console.log(`\nResultado: ${passou} passou, ${falhou} falhou`);
  } finally {
    produtoCache.limpar();
    await close(db);
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
