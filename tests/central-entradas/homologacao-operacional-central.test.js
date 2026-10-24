/**
 * Homologação operacional controlada da Central de Entradas (pós 2.6–2.8).
 * Isolado: SQLite :memory:, parser/MIIP mockados, sem SEFAZ e sem banco oficial.
 *
 * node --test tests/central-entradas/homologacao-operacional-central.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-homologacao-operacional-central-');

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_DIR_HOMOLOG = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-homolog-central-'));
process.env.DB_DIR = DB_DIR_HOMOLOG;
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.SEFAZ_AMBIENTE;

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralHistoricoRepository = require('../../backend/motores/central-entradas/repositories/CentralHistoricoRepository');
const CentralDfePersistenciaService = require('../../backend/motores/central-entradas/services/CentralDfePersistenciaService');
const CentralProcessamentoService = require('../../backend/motores/central-entradas/services/CentralProcessamentoService');
const CentralComprasBridgeService = require('../../backend/motores/central-entradas/services/CentralComprasBridgeService');
const CentralHistoricoService = require('../../backend/motores/central-entradas/services/CentralHistoricoService');
const DocumentoTransitionService = require('../../backend/motores/central-entradas/services/DocumentoTransitionService');
const centralEventosEmitter = require('../../backend/motores/central-entradas/utils/centralEventosEmitter');

centralEventosEmitter.emitirDocumentoRecebido = async () => null;
centralEventosEmitter.emitirDocumentoProcessado = async () => null;
centralEventosEmitter.emitirCompraGravada = async () => null;
centralEventosEmitter.emitirEvento = async () => null;
const CentralScoreDocumentoService = require('../../backend/motores/central-entradas/services/CentralScoreDocumentoService');
const { DocumentoFiscalStatus, normalizarStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { validarTransicao } = require('../../backend/motores/central-entradas/core/MaquinaEstadosDocumento');
const NFeParserError = require('../../backend/shared/nfe/errors/NFeParserError');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { creditarEstoqueItemCompra } = require('../../backend/services/compras/creditoEstoqueCompraViaPorta');
const estoqueSaldosPublico = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');

const ROOT = path.join(__dirname, '../..');
const EMP_A = 11;
const EMP_B = 22;
const CHAVE_A = '35260112345678000199550010000000771000000077';
const CHAVE_B = '35260112345678000199550010000000781000000088';

function xmlProc(chave, nome = 'FORNECEDOR HOMOLOG') {
  return `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${chave}">
      <ide><nNF>77</nNF><serie>1</serie><mod>55</mod><dhEmi>2026-10-17T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>12345678000199</CNPJ><xNome>${nome}</xNome></emit>
      <total><ICMSTot><vNF>150.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function creditoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    creditarEstoqueItemCompra(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1)
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave_acesso TEXT,
      fornecedor TEXT,
      total REAL,
      status TEXT,
      empresa_id INTEGER,
      tipo_entrada TEXT,
      tipo_entrada_sugerido TEXT,
      tipo_entrada_confianca REAL,
      tipo_entrada_motivo TEXT,
      tipo_entrada_alterado INTEGER DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL,
      numero TEXT,
      serie TEXT,
      modelo TEXT,
      fornecedor TEXT,
      cnpj_fornecedor TEXT,
      data_emissao TEXT,
      data_entrada TEXT,
      valor_total REAL,
      xml TEXT NOT NULL DEFAULT '<nfe/>',
      nsu TEXT,
      origem TEXT DEFAULT 'dfe',
      status TEXT,
      status_detalhe TEXT,
      tipo_documento TEXT DEFAULT 'PROC_NFE',
      parse_json TEXT,
      miip_sessao_id TEXT,
      miip_resumo_json TEXT,
      processado_em TEXT,
      compra_id INTEGER,
      usuario_id INTEGER,
      empresa_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave, empresa_id)
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_historico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_id INTEGER,
      status_anterior TEXT,
      status_novo TEXT,
      detalhe TEXT,
      usuario_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await garantirSchemaEstoqueEmpresaAsync(db);
  return db;
}

function repos(db) {
  const documentosRepository = new CentralDocumentosRepository({ db });
  const historicoRepository = new CentralHistoricoRepository({ db });
  const transitionService = new DocumentoTransitionService({
    documentosRepository,
    historicoRepository
  });
  return { documentosRepository, historicoRepository, transitionService };
}

function persistencia(db) {
  const r = repos(db);
  return {
    ...r,
    svc: new CentralDfePersistenciaService({
      db,
      documentosRepository: r.documentosRepository,
      historicoRepository: r.historicoRepository,
      transitionService: r.transitionService
    })
  };
}

function criarProcessamento(db, extra = {}) {
  const r = repos(db);
  let parseCalls = 0;
  let miipCalls = 0;
  const falharStatus = extra.falharStatus === true;
  const transitionService = extra.transitionService || {
    transicionar: async (id, de, para, opts) => {
      const destino = String(para);
      const avanco = destino === DocumentoFiscalStatus.EM_REVISAO
        || destino === DocumentoFiscalStatus.PRONTA_IMPORTACAO
        || destino === DocumentoFiscalStatus.ERRO;
      if (falharStatus && avanco) {
        const err = new Error('Transição simulada falhou: XML_COMPLETO → ' + destino);
        err.statusCode = 500;
        err.code = 'TRANSICAO_STATUS_FALHOU';
        throw err;
      }
      return r.transitionService.transicionar(id, de, para, opts);
    }
  };
  const historicoService = new CentralHistoricoService({
    historicoRepository: r.historicoRepository
  });
  const svc = new CentralProcessamentoService({
    documentosRepository: r.documentosRepository,
    historicoRepository: r.historicoRepository,
    historicoService,
    transitionService,
    eventosRepository: {
      inserirUnico: async () => ({ criado: true, conflito: false })
    },
    parseXml: extra.parseXml || (async (xml) => {
      parseCalls += 1;
      if (extra.falharParse) {
        throw extra.erroParse || new NFeParserError('XML inválido simulado');
      }
      return {
        chave_acesso: extra.chave || CHAVE_A,
        xml,
        itens: extra.itens || [{ codigo: 'P1', descricao: 'Pastel', quantidade: 2 }]
      };
    }),
    enriquecerParse: extra.enriquecerParse || (async (parsed) => {
      miipCalls += 1;
      const possuiPendencias = extra.possuiPendencias === true;
      return {
        parsed,
        miipImportacao: extra.miipImportacao || {
          operacaoId: 'op-homolog',
          resumo: {
            totalItens: (parsed.itens || []).length,
            identificados: possuiPendencias ? 0 : (parsed.itens || []).length,
            precisamConfirmacao: possuiPendencias ? 1 : 0,
            precisamCadastro: 0
          },
          resultados: possuiPendencias ? [{ precisaConfirmacao: true }] : [{ produtoId: 1 }]
        },
        possuiPendencias
      };
    })
  });
  svc._contadoresTeste = () => ({ parseCalls, miipCalls });
  return { svc, ...r };
}

function modeloProgressoUi(doc) {
  const status = doc?.status || '';
  const xmlCompleto = ['PROC_NFE', 'NFE'].includes(doc?.tipoDocumento)
    && status !== 'AGUARDANDO_XML_COMPLETO'
    && status !== 'RESUMO_RECEBIDO';
  const posParser = [
    'AGUARDANDO_REVISAO', 'REVISADA', 'PRONTA_PARA_COMPRA', 'EM_COMPRA', 'GRAVADA',
    'EM_REVISAO', 'PRONTA_IMPORTACAO', 'EM_IMPORTACAO', 'IMPORTADA'
  ].includes(status);
  const finalizado = status === 'GRAVADA' || status === 'IMPORTADA' || status === 'FINALIZADA';
  return {
    xmlCompleto,
    posParser,
    posMiip: posParser,
    estoqueUiConcluido: finalizado,
    parserUiConcluido: Boolean(doc?.parseJson) || posParser
  };
}

describe('Homologação operacional Central — Fase 2', () => {
  it('roda em SQLite :memory: com DB_DIR temporário e sem certificado de produção', () => {
    assert.equal(String(process.env.CDS_FORCAR_LOCAL), '1');
    assert.ok(String(process.env.DB_DIR).includes('cds-homolog-central'));
    assert.equal(String(process.env.DB_DIR).includes('MercantilFiscal'), false);
    assert.equal(fs.readFileSync(__filename, 'utf8').includes("sqlite3.Database(':memory:'"), true);
  });

  it('entrada válida persiste XML_COMPLETO na empresa correta', async () => {
    const db = await criarDb();
    const { svc, documentosRepository } = persistencia(db);
    const r = await svc.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'upload_manual',
      empresaId: EMP_A
    });
    assert.equal(r.ignorado, false);
    assert.equal(r.duplicado, false);
    assert.equal(r.documento.status, DocumentoFiscalStatus.XML_COMPLETO);
    assert.equal(Number(r.documento.empresaId), EMP_A);

    const row = await get(db, 'SELECT chave, status, empresa_id, xml FROM central_entradas_documentos WHERE id = ?', [r.documento.id]);
    assert.equal(row.chave, CHAVE_A);
    assert.equal(row.status, 'XML_COMPLETO');
    assert.equal(row.empresa_id, EMP_A);
    assert.ok(row.xml.includes(CHAVE_A));

    const daA = await documentosRepository.buscarPorChave(CHAVE_A, EMP_A);
    const daB = await documentosRepository.buscarPorChave(CHAVE_A, EMP_B);
    assert.ok(daA);
    assert.equal(daB, null);
    db.close();
  });

  it('consulta por empresa não devolve documento da outra empresa', async () => {
    const db = await criarDb();
    const { svc, documentosRepository } = persistencia(db);
    await svc.persistirDocumentoDfe({ xml: xmlProc(CHAVE_A), origem: 'dfe', empresaId: EMP_A });
    await svc.persistirDocumentoDfe({ xml: xmlProc(CHAVE_A, 'FORN B'), origem: 'dfe', empresaId: EMP_B });

    const listaA = await documentosRepository.listar({ empresaId: EMP_A });
    const listaB = await documentosRepository.listar({ empresaId: EMP_B });
    assert.equal(listaA.length, 1);
    assert.equal(listaB.length, 1);
    assert.equal(listaA[0].empresaId, EMP_A);
    assert.equal(listaB[0].empresaId, EMP_B);
    assert.equal(listaA[0].chave, listaB[0].chave);

    const rows = await all(db, 'SELECT empresa_id FROM central_entradas_documentos WHERE chave = ? ORDER BY empresa_id', [CHAVE_A]);
    assert.deepEqual(rows.map((x) => x.empresa_id), [EMP_A, EMP_B]);
    db.close();
  });

  it('processamento completo persiste parse, MIIP e status canônico', async () => {
    const db = await criarDb();
    const { svc: persist } = persistencia(db);
    const entrada = await persist.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'upload_manual',
      empresaId: EMP_A
    });
    const { svc, historicoRepository } = criarProcessamento(db);
    const r = await svc.processar(entrada.documento.id, { empresaId: EMP_A });
    assert.equal(r.sucesso, true, r.mensagem || 'processar sem mensagem');
    assert.equal(r.recuperado, false);
    const row = await get(db, `
      SELECT status, parse_json, miip_resumo_json, miip_sessao_id, empresa_id
      FROM central_entradas_documentos WHERE id = ?
    `, [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.PRONTA_IMPORTACAO);
    assert.equal(row.empresa_id, EMP_A);
    const parse = JSON.parse(row.parse_json);
    const miip = JSON.parse(row.miip_resumo_json);
    assert.equal(parse.chave_acesso, CHAVE_A);
    assert.equal(miip.operacaoId, 'op-homolog');
    assert.equal(row.miip_sessao_id, 'op-homolog');
    const hist = await historicoRepository.listar({ documentoId: entrada.documento.id });
    assert.ok(hist.some((h) => h.statusNovo === DocumentoFiscalStatus.PRONTA_IMPORTACAO));
    assert.equal(svc._contadoresTeste().parseCalls, 1);
    assert.equal(svc._contadoresTeste().miipCalls, 1);
    db.close();
  });

  it('recuperação não reexecuta parse/MIIP já persistidos', async () => {
    const db = await criarDb();
    const { svc: persist } = persistencia(db);
    const entrada = await persist.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'dfe',
      empresaId: EMP_A
    });
    const falha = criarProcessamento(db, { falharStatus: true });
    const r1 = await falha.svc.processar(entrada.documento.id, { empresaId: EMP_A });
    assert.equal(r1.sucesso, false);
    let row = await get(db, 'SELECT status, parse_json, miip_resumo_json FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.XML_COMPLETO);
    assert.ok(row.parse_json);

    const ok = criarProcessamento(db);
    const r2 = await ok.svc.processar(entrada.documento.id, { empresaId: EMP_A });
    assert.equal(r2.sucesso, true);
    assert.equal(r2.recuperado, true);
    assert.ok(r2.etapasPuladas.includes('parse'));
    assert.equal(ok.svc._contadoresTeste().parseCalls, 0);
    row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.PRONTA_IMPORTACAO);
    db.close();
  });

  it('falha de parser grava ERRO e retomada exige forcarReprocessamento', async () => {
    const db = await criarDb();
    const { svc: persist } = persistencia(db);
    const entrada = await persist.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'dfe',
      empresaId: EMP_A
    });
    const falha = criarProcessamento(db, { falharParse: true });
    const r1 = await falha.svc.processar(entrada.documento.id, { empresaId: EMP_A });
    assert.equal(r1.sucesso, false);
    assert.equal(r1.etapaAtual, 'parse');
    let row = await get(db, 'SELECT status, status_detalhe, parse_json FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.ERRO);
    assert.equal(row.parse_json, null);

    const hist = await all(db, 'SELECT detalhe FROM central_entradas_historico WHERE documento_id = ?', [entrada.documento.id]);
    assert.ok(hist.some((h) => /Falha original no pipeline \(parse\)/.test(h.detalhe || '')));

    const semForcar = await criarProcessamento(db).svc.processar(entrada.documento.id, { empresaId: EMP_A });
    assert.equal(semForcar.sucesso, false);
    assert.match(String(semForcar.mensagem), /não pode ser processado no status ERRO/);
    row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.ERRO);

    const r2 = await criarProcessamento(db).svc.processar(entrada.documento.id, {
      empresaId: EMP_A,
      forcarReprocessamento: true
    });
    assert.equal(r2.sucesso, true);
    row = await get(db, 'SELECT status, parse_json FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.PRONTA_IMPORTACAO);
    assert.ok(row.parse_json);
    db.close();
  });

  it('transições canônicas XML_COMPLETO → EM_REVISAO → PRONTA_IMPORTACAO → EM_IMPORTACAO → IMPORTADA', async () => {
    const db = await criarDb();
    const { svc: persist } = persistencia(db);
    const entrada = await persist.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'dfe',
      empresaId: EMP_A
    });
    const proc = criarProcessamento(db, { possuiPendencias: true });
    const rProc = await proc.svc.processar(entrada.documento.id, { empresaId: EMP_A });
    assert.equal(rProc.sucesso, true);
    let row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.EM_REVISAO);

    const bridge = new CentralComprasBridgeService({
      documentosRepository: proc.documentosRepository,
      historicoRepository: proc.historicoRepository
    });
    const revisao = await bridge.concluirRevisao(entrada.documento.id, {
      itens: [{ codigo: 'P1', produtoId: 1 }],
      empresaIdContexto: EMP_A
    });
    assert.equal(revisao.sucesso, true);
    row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.PRONTA_IMPORTACAO);

    const abrir = await bridge.registrarAberturaCompra(entrada.documento.id, { empresaIdContexto: EMP_A });
    assert.equal(abrir.sucesso, true);
    row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.EM_IMPORTACAO);

    const compra = await run(db, 'INSERT INTO compras (chave_acesso, fornecedor, total, status, empresa_id) VALUES (?, ?, ?, ?, ?)', [
      CHAVE_A, 'FORN', 150, 'gravada', EMP_A
    ]);
    const vinculo = await bridge.vincularCompra(entrada.documento.id, compra.lastID, { empresaIdContexto: EMP_A });
    assert.equal(vinculo.sucesso, true);
    row = await get(db, 'SELECT status, compra_id, empresa_id FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.IMPORTADA);
    assert.equal(row.compra_id, compra.lastID);
    assert.equal(row.empresa_id, EMP_A);

    const hist = await all(db, 'SELECT status_anterior, status_novo FROM central_entradas_historico WHERE documento_id = ? ORDER BY id', [entrada.documento.id]);
    const novos = hist.map((h) => h.status_novo);
    assert.ok(novos.includes(DocumentoFiscalStatus.EM_REVISAO));
    assert.ok(novos.includes(DocumentoFiscalStatus.PRONTA_IMPORTACAO));
    assert.ok(novos.includes(DocumentoFiscalStatus.EM_IMPORTACAO));
    assert.ok(novos.includes(DocumentoFiscalStatus.IMPORTADA));
    db.close();
  });

  it('documento duplicado na mesma empresa não cria segundo registro', async () => {
    const db = await criarDb();
    const { svc } = persistencia(db);
    const r1 = await svc.persistirDocumentoDfe({ xml: xmlProc(CHAVE_A), origem: 'dfe', empresaId: EMP_A });
    const r2 = await svc.persistirDocumentoDfe({ xml: xmlProc(CHAVE_A), origem: 'dfe', empresaId: EMP_A });
    assert.equal(r1.documento.id, r2.documento.id);
    assert.equal(r2.duplicado, true);
    const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE chave = ? AND empresa_id = ?', [CHAVE_A, EMP_A]);
    assert.equal(n.n, 1);
    db.close();
  });

  it('empresa A não altera documento nem saldo da empresa B', async () => {
    const db = await criarDb();
    const { svc: persist, documentosRepository } = persistencia(db);
    const docA = await persist.persistirDocumentoDfe({ xml: xmlProc(CHAVE_A), origem: 'dfe', empresaId: EMP_A });
    const docB = await persist.persistirDocumentoDfe({ xml: xmlProc(CHAVE_B), origem: 'dfe', empresaId: EMP_B });
    await criarProcessamento(db).svc.processar(docA.documento.id, { empresaId: EMP_A });

    await assert.rejects(
      () => criarProcessamento(db).svc.processar(docB.documento.id, { empresaId: EMP_A }),
      (err) => err && err.code === 'DOCUMENTO_NAO_ENCONTRADO'
    );

    const rowB = await get(db, 'SELECT status, parse_json, empresa_id FROM central_entradas_documentos WHERE id = ?', [docB.documento.id]);
    assert.equal(rowB.status, DocumentoFiscalStatus.XML_COMPLETO);
    assert.equal(rowB.parse_json, null);
    assert.equal(rowB.empresa_id, EMP_B);

    const prod = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('Pastel', 0, 0, 0)`);
    await creditoAsync(db, {
      produtoId: prod.lastID,
      quantidadeFiscal: 10,
      quantidadeNaoFiscal: 0,
      empresaId: EMP_A,
      exigirEmpresa: true
    });
    const eeA = await get(db, 'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [prod.lastID, EMP_A]);
    const eeB = await get(db, 'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [prod.lastID, EMP_B]);
    assert.equal(Number(eeA.saldo_fiscal), 10);
    assert.equal(eeB, null);
    const consultaB = await estoqueSaldosPublico.consultarSaldo(prod.lastID, { db, empresaId: EMP_B });
    assert.equal(Number(consultaB.saldo_fiscal), 0);

    const aindaB = await documentosRepository.buscarPorId(docB.documento.id);
    assert.equal(aindaB.status, DocumentoFiscalStatus.XML_COMPLETO);
    db.close();
  });

  it('vincularCompra não credita estoque; crédito isolado na porta pública exige empresaId', async () => {
    const db = await criarDb();
    const { svc: persist } = persistencia(db);
    const entrada = await persist.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'dfe',
      empresaId: EMP_A
    });
    const proc = criarProcessamento(db);
    await proc.svc.processar(entrada.documento.id, { empresaId: EMP_A });
    const bridge = new CentralComprasBridgeService({
      documentosRepository: proc.documentosRepository,
      historicoRepository: proc.historicoRepository
    });
    await bridge.registrarAberturaCompra(entrada.documento.id, { empresaIdContexto: EMP_A });
    const compra = await run(db, 'INSERT INTO compras (chave_acesso, fornecedor, total, status, empresa_id) VALUES (?, ?, ?, ?, ?)', [
      CHAVE_A, 'FORN', 150, 'gravada', EMP_A
    ]);
    const prod = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('Pastel', 0, 0, 0)`);

    await bridge.vincularCompra(entrada.documento.id, compra.lastID, { empresaIdContexto: EMP_A });
    const doc = await get(db, 'SELECT status, compra_id FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(doc.status, DocumentoFiscalStatus.IMPORTADA);
    const eeAntes = await get(db, 'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [prod.lastID, EMP_A]);
    assert.equal(eeAntes, null);

    const credito = await creditoAsync(db, {
      produtoId: prod.lastID,
      quantidadeFiscal: 5,
      quantidadeNaoFiscal: 0,
      empresaId: EMP_A,
      exigirEmpresa: true
    });
    assert.equal(credito.creditado, true);
    assert.equal(Number(credito.empresa_id), EMP_A);
    const ee = await get(db, 'SELECT saldo_fiscal, estoque_atual FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [prod.lastID, EMP_A]);
    assert.equal(Number(ee.saldo_fiscal), 5);
    assert.equal(Number(ee.estoque_atual), 5);

    await assert.rejects(
      () => creditoAsync(db, {
        produtoId: prod.lastID,
        quantidadeFiscal: 1,
        exigirEmpresa: true
      }),
      (err) => err && err.code === 'EMPRESA_OBRIGATORIA'
    );
    db.close();
  });

  it('reprocessamento da porta de crédito acumula saldo — sem idempotência no contrato atual', async () => {
    const db = await criarDb();
    const prod = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('Pastel', 0, 0, 0)`);
    const dados = {
      produtoId: prod.lastID,
      quantidadeFiscal: 7,
      quantidadeNaoFiscal: 0,
      empresaId: EMP_A,
      exigirEmpresa: true
    };
    await creditoAsync(db, dados);
    await creditoAsync(db, dados);
    const ee = await get(db, 'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [prod.lastID, EMP_A]);
    assert.equal(Number(ee.saldo_fiscal), 14);

    const concorrente = await Promise.all([
      creditoAsync(db, dados),
      creditoAsync(db, dados)
    ]);
    assert.equal(concorrente.every((c) => c.creditado), true);
    const ee2 = await get(db, 'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [prod.lastID, EMP_A]);
    assert.ok(
      Number(ee2.saldo_fiscal) > 14,
      `crédito concorrente não é idempotente (saldo=${ee2.saldo_fiscal})`
    );
    db.close();
  });

  it('vincularCompra concorrente na mesma compra não troca empresa nem compra_id', async () => {
    const db = await criarDb();
    const { svc: persist } = persistencia(db);
    const entrada = await persist.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'dfe',
      empresaId: EMP_A
    });
    const proc = criarProcessamento(db);
    await proc.svc.processar(entrada.documento.id, { empresaId: EMP_A });
    const bridge = new CentralComprasBridgeService({
      documentosRepository: proc.documentosRepository,
      historicoRepository: proc.historicoRepository
    });
    await bridge.registrarAberturaCompra(entrada.documento.id, { empresaIdContexto: EMP_A });
    const compra = await run(db, 'INSERT INTO compras (chave_acesso, fornecedor, total, status, empresa_id) VALUES (?, ?, ?, ?, ?)', [
      CHAVE_A, 'FORN', 150, 'gravada', EMP_A
    ]);
    await Promise.all([
      bridge.vincularCompra(entrada.documento.id, compra.lastID, { empresaIdContexto: EMP_A }),
      bridge.vincularCompra(entrada.documento.id, compra.lastID, { empresaIdContexto: EMP_A })
    ]);
    const row = await get(db, 'SELECT status, compra_id, empresa_id FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(row.status, DocumentoFiscalStatus.IMPORTADA);
    assert.equal(row.compra_id, compra.lastID);
    assert.equal(row.empresa_id, EMP_A);
    const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE id = ?', [entrada.documento.id]);
    assert.equal(n.n, 1);
    db.close();
  });

  it('barra de progresso da UI não prova crédito de estoque nem parser em XML_COMPLETO', async () => {
    const db = await criarDb();
    const { svc: persist, documentosRepository } = persistencia(db);
    const entrada = await persist.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'dfe',
      empresaId: EMP_A
    });
    const docXml = await documentosRepository.buscarPorId(entrada.documento.id);
    const uiXml = modeloProgressoUi(docXml);
    assert.equal(uiXml.xmlCompleto, true);
    assert.equal(uiXml.posParser, false);
    assert.equal(docXml.parseJson == null, true);

    const proc = criarProcessamento(db);
    await proc.svc.processar(entrada.documento.id, { empresaId: EMP_A });
    const bridge = new CentralComprasBridgeService({
      documentosRepository: proc.documentosRepository,
      historicoRepository: proc.historicoRepository
    });
    await bridge.registrarAberturaCompra(entrada.documento.id, { empresaIdContexto: EMP_A });
    const compra = await run(db, 'INSERT INTO compras (chave_acesso, fornecedor, total, status, empresa_id) VALUES (?, ?, ?, ?, ?)', [
      CHAVE_A, 'FORN', 150, 'gravada', EMP_A
    ]);
    await bridge.vincularCompra(entrada.documento.id, compra.lastID, { empresaIdContexto: EMP_A });
    const docImp = await proc.documentosRepository.buscarPorId(entrada.documento.id);
    const uiImp = modeloProgressoUi(docImp);
    assert.equal(uiImp.estoqueUiConcluido, true);
    const ee = await get(db, 'SELECT COUNT(*) AS n FROM estoque_empresa');
    assert.equal(ee.n, 0);
    db.close();
  });

  it('processar sem empresaId é recusado (EMPRESA_CENTRAL_AUSENTE)', async () => {
    const db = await criarDb();
    const { svc: persist } = persistencia(db);
    const entrada = await persist.persistirDocumentoDfe({
      xml: xmlProc(CHAVE_A),
      origem: 'dfe',
      empresaId: EMP_A
    });
    await assert.rejects(
      () => criarProcessamento(db).svc.processar(entrada.documento.id, {}),
      (err) => err && err.code === 'EMPRESA_CENTRAL_AUSENTE'
    );
    db.close();
  });
});

describe('Homologação operacional Central — Fase 3 pontuação', () => {
  const score = new CentralScoreDocumentoService();
  const SCORE_POR_STATUS = (() => {
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/motores/central-entradas/services/CentralScoreDocumentoService.js'),
      'utf8'
    );
    return src;
  })();

  it('mapa usa chaves canônicas únicas e IMPORTADA vale 100', () => {
    assert.match(SCORE_POR_STATUS, /\[DocumentoFiscalStatus\.IMPORTADA\]:\s*100/);
    assert.match(SCORE_POR_STATUS, /\[DocumentoFiscalStatus\.PRONTA_IMPORTACAO\]:\s*95/);
    assert.match(SCORE_POR_STATUS, /\[DocumentoFiscalStatus\.EM_IMPORTACAO\]:\s*85/);
    assert.match(SCORE_POR_STATUS, /\[DocumentoFiscalStatus\.EM_REVISAO\]:\s*65/);
    assert.match(SCORE_POR_STATUS, /\[DocumentoFiscalStatus\.XML_COMPLETO\]:\s*60/);
    assert.equal(SCORE_POR_STATUS.includes('[DocumentoFiscalStatus.GRAVADA]'), false);
    assert.equal(SCORE_POR_STATUS.includes('[DocumentoFiscalStatus.DUPLICADA]'), false);
    assert.equal(DocumentoFiscalStatus.GRAVADA, DocumentoFiscalStatus.IMPORTADA);
    assert.equal(DocumentoFiscalStatus.DUPLICADA, DocumentoFiscalStatus.IMPORTADA);
  });

  it('aliases legados GRAVADA/DUPLICADA não sobrescrevem IMPORTADA', () => {
    const base = {
      miipResumoJson: {
        resumo: {
          totalItens: 2,
          identificadosAutomaticamente: 2,
          precisamConfirmacao: 0,
          precisamCadastro: 0
        }
      },
      processadoEm: new Date().toISOString()
    };
    const imp = score.calcular({ ...base, status: DocumentoFiscalStatus.IMPORTADA });
    const grav = score.calcular({ ...base, status: DocumentoFiscalStatus.GRAVADA });
    const dup = score.calcular({ ...base, status: DocumentoFiscalStatus.DUPLICADA });
    assert.equal(imp.detalhes.status, 'IMPORTADA');
    assert.equal(grav.fatores.find((f) => f.nome === 'status').valor, 100);
    assert.equal(dup.fatores.find((f) => f.nome === 'status').valor, 100);
    assert.ok(imp.scoreGeral >= 90);
  });

  it('scoreGeral distingue estados canônicos sem colisão', () => {
    const base = {
      miipResumoJson: {
        resumo: {
          totalItens: 4,
          identificadosAutomaticamente: 4,
          precisamConfirmacao: 0,
          precisamCadastro: 0
        }
      },
      processadoEm: new Date().toISOString()
    };
    const imp = score.calcular({ ...base, status: DocumentoFiscalStatus.IMPORTADA });
    const xml = score.calcular({ ...base, status: DocumentoFiscalStatus.XML_COMPLETO });
    const erro = score.calcular({ ...base, status: DocumentoFiscalStatus.ERRO });
    const rev = score.calcular({ ...base, status: DocumentoFiscalStatus.EM_REVISAO });
    assert.ok(imp.scoreGeral > xml.scoreGeral);
    assert.ok(xml.scoreGeral > erro.scoreGeral);
    assert.ok(rev.scoreGeral > erro.scoreGeral);
    assert.equal(imp.fatores.find((f) => f.nome === 'status').valor, 100);
    assert.equal(xml.fatores.find((f) => f.nome === 'status').valor, 60);
    assert.equal(erro.fatores.find((f) => f.nome === 'status').valor, 15);
    assert.equal(rev.fatores.find((f) => f.nome === 'status').valor, 65);
  });

  it('normalização de aliases bate com o mapa canônico', () => {
    assert.equal(normalizarStatus('SINCRONIZADA'), DocumentoFiscalStatus.XML_COMPLETO);
    assert.equal(normalizarStatus('AGUARDANDO_REVISAO'), DocumentoFiscalStatus.EM_REVISAO);
    assert.equal(normalizarStatus('GRAVADA'), DocumentoFiscalStatus.IMPORTADA);
    assert.equal(normalizarStatus('DUPLICADA'), DocumentoFiscalStatus.IMPORTADA);
    assert.equal(normalizarStatus('EM_PROCESSAMENTO'), DocumentoFiscalStatus.XML_COMPLETO);
    assert.equal(validarTransicao(DocumentoFiscalStatus.XML_COMPLETO, DocumentoFiscalStatus.EM_REVISAO).valido, true);
    assert.equal(validarTransicao(DocumentoFiscalStatus.XML_COMPLETO, DocumentoFiscalStatus.NOVA).valido, false);
  });
});
