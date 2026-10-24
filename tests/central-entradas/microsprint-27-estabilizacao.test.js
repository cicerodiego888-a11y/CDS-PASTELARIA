/**
 * Microsprint 2.7 — Estabilização e regressão da recuperação 2.6.
 * Isolado: SQLite :memory:, mocks, sem SEFAZ e sem banco oficial.
 *
 * node --test tests/central-entradas/microsprint-27-estabilizacao.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-microsprint-27-estabilizacao-');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralProcessamentoService = require('../../backend/motores/central-entradas/services/CentralProcessamentoService');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { avaliarDocumento } = require('../../backend/motores/central-entradas/health/HealthRules');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const CHAVE = '35260112345678000199550010000000781000000078';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const inst = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(inst)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1)
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY,
      tipo_entrada TEXT,
      tipo_entrada_sugerido TEXT,
      tipo_entrada_confianca REAL,
      tipo_entrada_motivo TEXT,
      tipo_entrada_alterado INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL,
      xml TEXT NOT NULL DEFAULT '<nfe/>',
      fornecedor TEXT,
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

function repo(db) {
  return new CentralDocumentosRepository({ db });
}

function criarSvc(db) {
  let parseCalls = 0;
  let miipCalls = 0;
  const historico = [];
  const svc = new CentralProcessamentoService({
    documentosRepository: repo(db),
    historicoService: {
      registrar: async (dados) => {
        historico.push(dados);
        return dados;
      }
    },
    eventosRepository: { inserirUnico: async () => ({ criado: true }) },
    parseXml: async (xml) => {
      parseCalls += 1;
      return { chave_acesso: CHAVE, xml, itens: [] };
    },
    enriquecerParse: async (parsed) => {
      miipCalls += 1;
      return {
        parsed,
        miipImportacao: { operacaoId: 'op-27', resumo: { totalItens: 0 }, resultados: [] },
        possuiPendencias: false
      };
    },
    transitionService: {
      transicionar: async (id, _de, para, opts) => {
        await run(db, 'UPDATE central_entradas_documentos SET status = ?, status_detalhe = ? WHERE id = ?', [
          String(para),
          (opts && opts.detalhe) || null,
          id
        ]);
      }
    }
  });
  svc._contadoresTeste = () => ({ parseCalls, miipCalls, historico });
  return svc;
}

async function inserirDoc(db, patch = {}) {
  const r = await run(db, `
    INSERT INTO central_entradas_documentos
      (chave, xml, status, tipo_documento, parse_json, miip_resumo_json, empresa_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    patch.chave || CHAVE,
    patch.xml || '<nfe/>',
    patch.status || DocumentoFiscalStatus.XML_COMPLETO,
    'PROC_NFE',
    patch.parseJson != null ? JSON.stringify(patch.parseJson) : null,
    patch.miipResumoJson != null ? JSON.stringify(patch.miipResumoJson) : null,
    patch.empresaId != null ? patch.empresaId : EMP_A
  ]);
  return r.lastID;
}

function extrairPosParser() {
  const ux = src('frontend/erp/js/central-entradas-ux.js');
  const inicio = ux.indexOf('const posParser = [');
  const fim = ux.indexOf('const posMiip', inicio);
  return ux.slice(inicio, fim);
}

describe('Microsprint 2.7 estabilização da recuperação', () => {
  it('10 — XML_COMPLETO permanece 64%; status canônico pós-recuperação entra em posMiip', () => {
    const lista = extrairPosParser();
    assert.equal(lista.includes("'XML_COMPLETO'"), false);
    assert.equal(lista.includes("'EM_PROCESSAMENTO'"), false);
    assert.ok(lista.includes("'EM_REVISAO'"));
    assert.ok(lista.includes("'PRONTA_IMPORTACAO'"));
    assert.equal(Math.round((9 / 14) * 100), 64);
  });

  it('SEM_PARSER dispara para XML_COMPLETO canônico (alias SINCRONIZADA)', () => {
    const alertas = avaliarDocumento({
      id: 3,
      status: DocumentoFiscalStatus.SINCRONIZADA,
      tipoDocumento: 'PROC_NFE',
      xmlCompletoProvavel: true,
      updatedAt: '2026-07-28T10:00:00.000Z'
    }, {}, { agora: Date.parse('2026-07-28T12:00:00.000Z') });
    const regra = alertas.find((a) => a.regra === 'SEM_PARSER');
    assert.ok(regra);
    assert.equal(regra.autoRecuperavel, true);
    assert.equal(regra.acaoInterna, 'processar_pendentes');
  });

  it('EMPRESA_CENTRAL_AUSENTE permanece sem fallback global', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db, {
      parseJson: { chave_acesso: CHAVE },
      miipResumoJson: { operacaoId: 'x', resumo: {}, resultados: [] }
    });
    const svc = criarSvc(db);
    await assert.rejects(
      () => svc.processar(id, {}),
      (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
    );
    await assert.rejects(
      () => repo(db).listarPendentesProcessamento(10),
      (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
    );
    const srcProc = src('backend/motores/central-entradas/services/CentralProcessamentoService.js');
    const srcRepo = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
    const fn = srcRepo.slice(
      srcRepo.indexOf('async listarPendentesProcessamento'),
      srcRepo.indexOf('COLUNAS_LISTAGEM')
    );
    assert.equal(srcProc.includes('empresa_operacional'), false);
    assert.equal(fn.includes('COALESCE'), false);
    db.close();
  });

  it('documento já em revisão não reexecuta parser/MIIP', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db, {
      status: DocumentoFiscalStatus.EM_REVISAO,
      parseJson: { chave_acesso: CHAVE, itens: [] },
      miipResumoJson: { operacaoId: 'ok', resumo: {}, resultados: [] }
    });
    const svc = criarSvc(db);
    const r = await svc.processar(id, { empresaId: EMP_A });
    assert.equal(r.sucesso, true);
    assert.equal(r.reutilizado, true);
    assert.equal(r.recuperado, false);
    assert.equal(svc._contadoresTeste().parseCalls, 0);
    assert.equal(svc._contadoresTeste().miipCalls, 0);
    db.close();
  });

  it('parser+MIIP persistidos e status XML_COMPLETO retomam só o avanço de status', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db, {
      parseJson: { chave_acesso: CHAVE, itens: [] },
      miipResumoJson: { operacaoId: 'ok', resumo: { totalItens: 0 }, resultados: [] }
    });
    const svc = criarSvc(db);
    const r = await svc.processar(id, { empresaId: EMP_A });
    assert.equal(r.sucesso, true);
    assert.equal(r.recuperado, true);
    assert.equal(svc._contadoresTeste().parseCalls, 0);
    assert.equal(svc._contadoresTeste().miipCalls, 0);
    const row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [id]);
    assert.equal(row.status, DocumentoFiscalStatus.PRONTA_IMPORTACAO);
    db.close();
  });
});
