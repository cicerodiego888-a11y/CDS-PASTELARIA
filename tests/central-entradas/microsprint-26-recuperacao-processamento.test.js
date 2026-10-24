/**
 * Microsprint 2.6 — Recuperação segura de processamento incompleto.
 * Isolado: SQLite :memory:, mocks de parser/MIIP, sem SEFAZ e sem banco oficial.
 *
 * node --test tests/central-entradas/microsprint-26-recuperacao-processamento.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-microsprint-26-recuperacao-processamento-');

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
const EMP_B = 22;
const CHAVE = '35260112345678000199550010000000771000000077';

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

async function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

async function criarDb() {
  const db = await openMem();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1)
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave, empresa_id)
    )
  `);
  return db;
}

function repo(db) {
  return new CentralDocumentosRepository({ db });
}

function criarSvc(db, extra = {}) {
  const historico = extra.historico || [];
  let parseCalls = 0;
  let miipCalls = 0;
  const transicoes = extra.transicoes || [];
  const falharStatus = extra.falharStatus === true;
  const svc = new CentralProcessamentoService({
    documentosRepository: repo(db),
    historicoService: {
      registrar: async (dados) => {
        historico.push(dados);
        return dados;
      }
    },
    eventosRepository: {
      inserirUnico: async () => ({ criado: true, conflito: false })
    },
    parseXml: extra.parseXml || (async (xml) => {
      parseCalls += 1;
      return {
        chave_acesso: CHAVE,
        xml,
        itens: extra.itens || []
      };
    }),
    enriquecerParse: extra.enriquecerParse || (async (parsed) => {
      miipCalls += 1;
      const possuiPendencias = extra.possuiPendencias === true;
      return {
        parsed,
        miipImportacao: extra.miipImportacao || {
          operacaoId: 'op-mock',
          resumo: { totalItens: (parsed.itens || []).length },
          resultados: possuiPendencias
            ? [{ precisaConfirmacao: true }]
            : []
        },
        possuiPendencias
      };
    }),
    transitionService: extra.transitionService || {
      transicionar: async (id, de, para, opts) => {
        transicoes.push({ id, de, para, detalhe: opts && opts.detalhe });
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
        await run(db, 'UPDATE central_entradas_documentos SET status = ?, status_detalhe = ? WHERE id = ?', [
          destino,
          (opts && opts.detalhe) || null,
          id
        ]);
      }
    }
  });
  svc._contadoresTeste = () => ({ parseCalls, miipCalls, transicoes, historico });
  return svc;
}

async function inserirDoc(db, patch = {}) {
  const r = await run(db, `
    INSERT INTO central_entradas_documentos
      (chave, xml, fornecedor, status, tipo_documento, parse_json, miip_resumo_json, miip_sessao_id, empresa_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    patch.chave || CHAVE,
    patch.xml || '<nfe/>',
    patch.fornecedor || 'FORN_A',
    patch.status || DocumentoFiscalStatus.XML_COMPLETO,
    patch.tipoDocumento || 'PROC_NFE',
    patch.parseJson != null ? JSON.stringify(patch.parseJson) : null,
    patch.miipResumoJson != null ? JSON.stringify(patch.miipResumoJson) : null,
    patch.miipSessaoId || null,
    patch.empresaId != null ? patch.empresaId : EMP_A
  ]);
  return r.lastID;
}

describe('Microsprint 2.6 recuperação processamento incompleto', () => {
  it('reproduz 64% (9/14 etapas) com XML completo e status ainda XML_COMPLETO', () => {
    const ux = src('frontend/erp/js/central-entradas-ux.js');
    const bloco = ux.slice(
      ux.indexOf('const etapas = ['),
      ux.indexOf('const concluidas = etapas.filter')
    );
    const ids = [...bloco.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.equal(ids.length, 14);
    const concluidasSemStatus = [
      'localizado', 'res_nfe', 'manif_enviada', 'manif_ok',
      'xml_solicitado', 'xml_sefaz', 'xml_baixado', 'xml_validado', 'parser'
    ];
    assert.equal(concluidasSemStatus.length, 9);
    assert.equal(Math.round((9 / 14) * 100), 64);
    assert.equal(src('backend/motores/central-entradas/services/CentralProcessamentoService.js')
      .includes('Processamento já existente — resultado reutilizado'), true);
  });

  it('1+2 — preso em XML_COMPLETO após falha real na transição de status', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db);
    const svc = criarSvc(db, { falharStatus: true });
    const r1 = await svc.processar(id, { empresaId: EMP_A });
    assert.equal(r1.sucesso, false);
    assert.match(r1.mensagem, /Transição simulada falhou/);
    assert.equal(r1.etapaAtual, 'status');
    const row = await get(db, 'SELECT status, parse_json, miip_resumo_json FROM central_entradas_documentos WHERE id = ?', [id]);
    assert.equal(row.status, DocumentoFiscalStatus.XML_COMPLETO);
    assert.ok(row.parse_json);
    assert.ok(row.miip_resumo_json);
    const hist = svc._contadoresTeste().historico;
    assert.ok(hist.some((h) => /Falha original no pipeline \(status\)/.test(h.detalhe)));
    db.close();
  });

  it('3+4 — recuperação com parser e MIIP já persistidos não reexecuta', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db);
    const svcFalha = criarSvc(db, { falharStatus: true });
    await svcFalha.processar(id, { empresaId: EMP_A });
    const depoisFalha = svcFalha._contadoresTeste();
    assert.equal(depoisFalha.parseCalls, 1);
    assert.equal(depoisFalha.miipCalls, 1);

    const svcOk = criarSvc(db);
    const r2 = await svcOk.processar(id, { empresaId: EMP_A });
    assert.equal(r2.sucesso, true);
    assert.equal(r2.recuperado, true);
    assert.equal(r2.reutilizado, false);
    assert.ok(r2.etapasPuladas.includes('parse'));
    assert.ok(r2.etapasPuladas.includes('miip'));
    const c = svcOk._contadoresTeste();
    assert.equal(c.parseCalls, 0);
    assert.equal(c.miipCalls, 0);
    const row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [id]);
    assert.equal(row.status, DocumentoFiscalStatus.PRONTA_IMPORTACAO);
    db.close();
  });

  it('5 — parseJson existente com MIIP incompleto executa só MIIP', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db, {
      parseJson: { chave_acesso: CHAVE, itens: [] }
    });
    const svc = criarSvc(db);
    const r = await svc.processar(id, { empresaId: EMP_A });
    assert.equal(r.sucesso, true);
    assert.equal(r.recuperado, true);
    assert.ok(r.etapasPuladas.includes('parse'));
    assert.equal(r.etapasPuladas.includes('miip'), false);
    const c = svc._contadoresTeste();
    assert.equal(c.parseCalls, 0);
    assert.equal(c.miipCalls, 1);
    db.close();
  });

  it('6 — persistência parcial permanece XML_COMPLETO e não é marcada concluída', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db, {
      parseJson: { chave_acesso: CHAVE, itens: [] },
      miipResumoJson: { operacaoId: 'x', resumo: { totalItens: 0 }, resultados: [] }
    });
    const row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [id]);
    assert.equal(row.status, DocumentoFiscalStatus.XML_COMPLETO);
    const lista = await repo(db).listarPendentesProcessamento(10, EMP_A);
    assert.ok(lista.some((d) => d.id === id));
    db.close();
  });

  it('7 — idempotência, concorrência e reinício', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db, {
      parseJson: { chave_acesso: CHAVE, itens: [] },
      miipResumoJson: { operacaoId: 'x', resumo: {}, resultados: [] }
    });
    const svc = criarSvc(db);
    const [a, b] = await Promise.all([
      svc.processar(id, { empresaId: EMP_A }),
      svc.processar(id, { empresaId: EMP_A })
    ]);
    assert.equal(a.sucesso, true);
    assert.equal(b.sucesso, true);
    const row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [id]);
    assert.equal(row.status, DocumentoFiscalStatus.PRONTA_IMPORTACAO);

    const terceiro = await svc.processar(id, { empresaId: EMP_A });
    assert.equal(terceiro.sucesso, true);
    assert.equal(terceiro.reutilizado, true);
    assert.equal(svc._contadoresTeste().parseCalls, 0);
    db.close();
  });

  it('8 — eventos/histórico preservam falha original e retomada', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db);
    const svcFalha = criarSvc(db, { falharStatus: true });
    await svcFalha.processar(id, { empresaId: EMP_A });
    assert.ok(svcFalha._contadoresTeste().historico.some((h) => /Falha original/.test(h.detalhe)));
    const svcOk = criarSvc(db);
    const r = await svcOk.processar(id, { empresaId: EMP_A });
    assert.equal(r.sucesso, true);
    assert.match(r.mensagem, /Recuperação segura/);
    db.close();
  });

  it('9 — empresaId é obrigatório e isolamento A/B', async () => {
    const db = await criarDb();
    const idA = await inserirDoc(db, { empresaId: EMP_A, chave: CHAVE });
    const idB = await inserirDoc(db, {
      empresaId: EMP_B,
      chave: CHAVE,
      fornecedor: 'FORN_B'
    });
    const svc = criarSvc(db);
    await assert.rejects(
      () => svc.processar(idA, {}),
      (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
    );
    await assert.rejects(
      () => svc.processar(idA, { empresaId: EMP_B }),
      (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO' || err.code === 'OPERACAO_EMPRESA_DIVERGENTE'
    );
    const okA = await svc.processar(idA, { empresaId: EMP_A });
    assert.equal(okA.sucesso, true);
    const b = await get(db, 'SELECT status, fornecedor FROM central_entradas_documentos WHERE id = ?', [idB]);
    assert.equal(b.status, DocumentoFiscalStatus.XML_COMPLETO);
    assert.equal(b.fornecedor, 'FORN_B');
    const listaB = await repo(db).listarPendentesProcessamento(10, EMP_B);
    assert.deepEqual(listaB.map((d) => d.id), [idB]);
    db.close();
  });

  it('HealthMonitor trata processamento incompleto como auto-recuperável sem esperar 6h', () => {
    const alertas = avaliarDocumento({
      id: 7,
      status: DocumentoFiscalStatus.XML_COMPLETO,
      parseJson: { chave_acesso: CHAVE },
      miipResumoJson: { operacaoId: 'x', resumo: {}, resultados: [] },
      updatedAt: new Date().toISOString()
    });
    const regra = alertas.find((a) => a.regra === 'PROCESSAMENTO_INCOMPLETO');
    assert.ok(regra);
    assert.equal(regra.autoRecuperavel, true);
    assert.equal(regra.acaoInterna, 'processar_pendentes');
  });

  it('não considera concluído só porque parseJson existe', async () => {
    const db = await criarDb();
    const id = await inserirDoc(db, {
      parseJson: { chave_acesso: CHAVE, itens: [] },
      miipResumoJson: { operacaoId: 'x', resumo: {}, resultados: [] }
    });
    const svc = criarSvc(db);
    const r = await svc.processar(id, { empresaId: EMP_A });
    assert.equal(r.reutilizado, false);
    assert.equal(r.recuperado, true);
    const row = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id = ?', [id]);
    assert.equal(row.status, DocumentoFiscalStatus.PRONTA_IMPORTACAO);
    db.close();
  });
});
