/**
 * Recuperação segura de NF-e potencialmente ausentes.
 * Isolado: SQLite :memory:, DistDFe mockado, sem SEFAZ e sem certificado.
 *
 * node --test tests/central-entradas/recuperacao-segura-nfe-ausentes.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-recuperacao-segura-nfe-ausentes-');

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-recup-nfe-'));
process.env.DB_DIR = DB_DIR;
process.env.CDS_FORCAR_LOCAL = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const zlib = require('zlib');

const CentralNsuService = require('../../backend/motores/central-entradas/services/CentralNsuService');
const CentralSincronizacaoService = require('../../backend/motores/central-entradas/services/CentralSincronizacaoService');
const CentralDfePersistenciaService = require('../../backend/motores/central-entradas/services/CentralDfePersistenciaService');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralHistoricoRepository = require('../../backend/motores/central-entradas/repositories/CentralHistoricoRepository');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { persistirDocumentosRetorno, sincronizarDistribuicaoDFe: sincronizarDistribuicaoDFeRaw } = require('../../backend/services/fiscal/distribuicaoDFe');
const { anexarAutorizacaoTesteSefaz } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');

function sincronizarDistribuicaoDFe(deps) {
  return sincronizarDistribuicaoDFeRaw(anexarAutorizacaoTesteSefaz(deps));
}
const {
  listarPendenciasPersistenciaAbertas,
  filtrarPendenciasPersistenciaAbertas
} = require('../../backend/services/fiscal/pendenciasPersistenciaDfe');
const { calcularIntervaloPeriodoPadrao, PERIODOS_PADRAO } = require('../../backend/motores/central-entradas/services/CentralPeriodoPadraoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const DocumentoFiscalInboxDTO = require('../../backend/motores/central-entradas/contracts/DocumentoFiscalInboxDTO');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_A = '35261012345678000199550010000000011000000011';
const CHAVE_B = '35261012345678000199550010000000021000000022';
const CHAVE_SET = '35260912345678000199550010000000011000000099';

function xmlNota(chave, dhEmi) {
  const dh = dhEmi ? `<dhEmi>${dhEmi}</dhEmi>` : '';
  return `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe${chave}">
    <ide><nNF>1</nNF><serie>1</serie><mod>55</mod>${dh}</ide>
    <emit><CNPJ>12345678000199</CNPJ><xNome>FORN</xNome></emit>
    <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
  </infNFe></NFe></nfeProc>`;
}

function montarRetornoDist({ cStat = '138', ultNSU = '5', maxNSU = '5', documentos = [] }) {
  const docZips = documentos.map((doc) => {
    const compactado = zlib.gzipSync(Buffer.from(doc.xml, 'utf8')).toString('base64');
    return `<docZip NSU="${doc.nsu}" schema="${doc.schema || 'procNFe_v4.00.xsd'}">${compactado}</docZip>`;
  }).join('');
  return `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">
    <cStat>${cStat}</cStat><xMotivo>${cStat === '137' ? 'Nenhum documento localizado' : 'Documento localizado'}</xMotivo>
    <ultNSU>${String(ultNSU).padStart(15, '0')}</ultNSU>
    <maxNSU>${String(maxNSU).padStart(15, '0')}</maxNSU>
    <loteDistDFeInt>${docZips}</loteDistDFeInt>
  </retDistDFeInt>`;
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
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL,
      numero TEXT, serie TEXT, modelo TEXT,
      fornecedor TEXT, cnpj_fornecedor TEXT,
      data_emissao TEXT, data_entrada TEXT, valor_total REAL,
      xml TEXT NOT NULL DEFAULT '<nfe/>',
      nsu TEXT, origem TEXT DEFAULT 'dfe',
      status TEXT, status_detalhe TEXT, tipo_documento TEXT,
      parse_json TEXT, miip_sessao_id TEXT, miip_resumo_json TEXT,
      processado_em TEXT, compra_id INTEGER, usuario_id INTEGER,
      empresa_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave, empresa_id)
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_historico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_id INTEGER, status_anterior TEXT, status_novo TEXT,
      detalhe TEXT, usuario_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE dfe_auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT, empresa_id INTEGER, cnpj TEXT, ambiente INTEGER,
      nsu TEXT, tipo TEXT, schema TEXT, chave TEXT,
      resultado TEXT NOT NULL, motivo TEXT, tempo_ms INTEGER, detalhe_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY, chave_acesso TEXT, empresa_id INTEGER,
      tipo_entrada TEXT, tipo_entrada_sugerido TEXT,
      tipo_entrada_confianca REAL, tipo_entrada_motivo TEXT,
      tipo_entrada_alterado INTEGER
    )
  `);
  return db;
}

function criarNsuMemoria(inicial = {}) {
  let controle = {
    id: 1,
    ultNsu: '000000000000000',
    maxNsu: '000000000000000',
    dataSincronizacao: null,
    ...inicial
  };
  return {
    snapshot() { return { ...controle }; },
    obterOuCriar: async () => ({ ...controle }),
    aplicarRetornoDistDfe: async (p) => {
      controle = {
        ...controle,
        ultNsu: p.ultNsu,
        maxNsu: p.maxNsu,
        ultimoCstat: p.cStat,
        dataSincronizacao: new Date().toISOString()
      };
      return {
        controle: { ...controle },
        atualizouNsu: true,
        ultNsu: controle.ultNsu,
        maxNsu: controle.maxNsu
      };
    }
  };
}

function criarAuditoriaSqlite(db) {
  const registros = [];
  async function registrar(evento = {}) {
    registros.push({ ...evento });
    await run(db, `
      INSERT INTO dfe_auditoria (
        correlation_id, empresa_id, cnpj, ambiente, nsu, tipo, schema, chave,
        resultado, motivo, tempo_ms, detalhe_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      evento.correlation_id || evento.correlationId || null,
      evento.empresa_id != null ? evento.empresa_id : (evento.empresaId != null ? evento.empresaId : null),
      evento.cnpj || null,
      evento.ambiente != null ? evento.ambiente : null,
      evento.nsu || null,
      evento.tipo || null,
      evento.schema || null,
      evento.chave || null,
      evento.resultado || 'DESCONHECIDO',
      evento.motivo || null,
      evento.tempo_ms != null ? evento.tempo_ms : null,
      evento.detalhe != null ? JSON.stringify(evento.detalhe) : null
    ]);
    return registros.length;
  }
  return {
    registros,
    registrar,
    registrarConsulta: (d) => registrar({ ...d, tipo: 'CONSULTA', resultado: d.resultado || 'CONSULTA' }),
    registrarResumoSync: (d) => registrar({
      ...d,
      tipo: 'SYNC',
      resultado: 'SYNC_RESUMO',
      detalhe: {
        ultNsu: d.ultNsu,
        maxNsu: d.maxNsu,
        cStat: d.cStat,
        pendenciasPersistencia: d.pendenciasPersistencia || d.errosPersistencia || []
      }
    }),
    registrarNsuAvanco: (d) => registrar({
      ...d,
      tipo: 'NSU',
      resultado: d.avancou ? 'NSU_AVANCO' : 'NSU_PRESERVADO'
    })
  };
}

function contexto(empresaId = EMP_A) {
  return {
    certificadoPath: 'x.pfx',
    certificadoSenha: 'x',
    cnpj: empresaId === EMP_B ? '22222222000182' : '11111111000191',
    codigoUf: '23',
    ambiente: 2,
    empresaId
  };
}

describe('Recuperação segura — DistDFe e NSU', () => {
  it('lote persistido com sucesso avança NSU e aparece na lista da empresa', async () => {
    const db = await criarDb();
    const nsu = criarNsuMemoria();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    const xml = montarRetornoDist({
      ultNSU: '5',
      maxNSU: '5',
      documentos: [{ nsu: '5', xml: xmlNota(CHAVE_A, '2026-10-10T10:00:00-03:00') }]
    });
    const r = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contexto(EMP_A),
      nsuService: nsu,
      persistenciaService: persist,
      auditoriaService: criarAuditoriaSqlite(db),
      enviarDistribuicaoDfe: async () => ({ success: true, body: xml, endpoint: 'https://example.invalid/dfe', statusCode: 200 })
    });
    assert.equal(r.sucesso, true);
    assert.equal(r.consultaExecutada, true);
    assert.equal(r.notasNovas, 1);
    assert.equal(nsu.snapshot().ultNsu, '000000000000005');
    const repo = new CentralDocumentosRepository({ db });
    const lista = await repo.listar({ empresaId: EMP_A });
    assert.equal(lista.length, 1);
    assert.equal(lista[0].chave, CHAVE_A);
    db.close();
  });

  it('cStat 137 sem documentos é consulta executada, não falha e não prova inexistência histórica', async () => {
    const nsu = criarNsuMemoria({ ultNsu: '000000000000010', maxNsu: '000000000000010' });
    const xml = montarRetornoDist({ cStat: '137', ultNSU: '10', maxNSU: '10', documentos: [] });
    const r = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contexto(EMP_A),
      nsuService: nsu,
      persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true }) },
      auditoriaService: {
        registrar: async () => null,
        registrarConsulta: async () => null,
        registrarResumoSync: async () => null,
        registrarNsuAvanco: async () => null
      },
      enviarDistribuicaoDfe: async () => ({ success: true, body: xml, endpoint: 'https://example.invalid/dfe', statusCode: 200 })
    });
    assert.equal(r.consultaExecutada, true);
    assert.equal(r.sucesso, true);
    assert.equal(r.notasNovas, 0);
    assert.equal(r.cStat, '137');
    assert.equal(/erro|falha/i.test(r.mensagem || ''), false);
  });

  it('SQLITE_BUSY persistente não avança NSU e grava pendência durável com chave', async () => {
    const db = await criarDb();
    const nsu = criarNsuMemoria();
    const auditoria = criarAuditoriaSqlite(db);
    const persist = {
      persistirDocumentoDfe: async () => {
        const err = new Error('SQLITE_BUSY simulado');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
    };
    const xml = montarRetornoDist({
      ultNSU: '9',
      maxNSU: '9',
      documentos: [{ nsu: '9', xml: xmlNota(CHAVE_A, '2026-10-10T10:00:00-03:00') }]
    });
    const r = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contexto(EMP_A),
      nsuService: nsu,
      persistenciaService: persist,
      auditoriaService: auditoria,
      enviarDistribuicaoDfe: async () => ({ success: true, body: xml, endpoint: 'https://example.invalid/dfe', statusCode: 200 })
    });
    assert.equal(r.sucesso, false);
    assert.equal(r.codigo, 'PERSISTENCIA_DFE_INCOMPLETA');
    assert.equal(r.errosPersistencia[0].chave, CHAVE_A);
    assert.equal(nsu.snapshot().ultNsu, '000000000000000');
    const pendencias = await listarPendenciasPersistenciaAbertas(db, { empresaId: EMP_A });
    assert.equal(pendencias.length, 1);
    assert.equal(pendencias[0].chave, CHAVE_A);
    assert.equal(pendencias[0].nsu, '000000000000009');
    db.close();
  });

  it('reinício retoma o mesmo NSU, persiste e fecha a pendência sem duplicar', async () => {
    const db = await criarDb();
    const nsu = criarNsuMemoria();
    const auditoria = criarAuditoriaSqlite(db);
    const persistReal = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    let tentativas = 0;
    const persist = {
      persistirDocumentoDfe: async (payload) => {
        tentativas += 1;
        if (tentativas <= 2) {
          const err = new Error('falha até reinício');
          err.code = 'SQLITE_BUSY';
          throw err;
        }
        return persistReal.persistirDocumentoDfe(payload);
      }
    };
    const xml = montarRetornoDist({
      ultNSU: '4',
      maxNSU: '4',
      documentos: [{ nsu: '4', xml: xmlNota(CHAVE_A, '2026-10-11T08:00:00-03:00') }]
    });
    const enviar = async () => ({ success: true, body: xml, endpoint: 'https://example.invalid/dfe', statusCode: 200 });
    const deps = {
      maxIteracoes: 1,
      contextoCentral: contexto(EMP_A),
      nsuService: nsu,
      persistenciaService: persist,
      auditoriaService: auditoria,
      enviarDistribuicaoDfe: enviar
    };
    const falha = await sincronizarDistribuicaoDFe(deps);
    assert.equal(falha.sucesso, false);
    assert.equal(nsu.snapshot().ultNsu, '000000000000000');
    const abertas1 = await listarPendenciasPersistenciaAbertas(db, { empresaId: EMP_A });
    assert.equal(abertas1.length, 1);

    const ok = await sincronizarDistribuicaoDFe(deps);
    assert.equal(ok.sucesso, true);
    assert.equal(ok.notasNovas, 1);
    assert.equal(nsu.snapshot().ultNsu, '000000000000004');
    const docs = await all(db, 'SELECT id FROM central_entradas_documentos WHERE chave = ? AND empresa_id = ?', [CHAVE_A, EMP_A]);
    assert.equal(docs.length, 1);
    const abertas2 = await listarPendenciasPersistenciaAbertas(db, { empresaId: EMP_A });
    assert.equal(abertas2.length, 0);
    db.close();
  });

  it('lote com dois documentos: falha em um não avança NSU e retoma só o pendente', async () => {
    const db = await criarDb();
    const nsu = criarNsuMemoria();
    const persistReal = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    const falharChave = new Set([CHAVE_B]);
    const persist = {
      persistirDocumentoDfe: async (payload) => {
        if (String(payload.xml || '').includes(CHAVE_B) && falharChave.has(CHAVE_B)) {
          const err = new Error('falha seletiva');
          err.code = 'SQLITE_BUSY';
          throw err;
        }
        return persistReal.persistirDocumentoDfe(payload);
      }
    };
    const xml = montarRetornoDist({
      ultNSU: '8',
      maxNSU: '8',
      documentos: [
        { nsu: '7', xml: xmlNota(CHAVE_A, '2026-10-10T10:00:00-03:00') },
        { nsu: '8', xml: xmlNota(CHAVE_B, '2026-10-12T10:00:00-03:00') }
      ]
    });
    const r1 = await persistirDocumentosRetorno(xml, persist, 'dfe', {
      empresaId: EMP_A,
      auditoria: criarAuditoriaSqlite(db),
      cnpj: '11111111000191',
      ambiente: 2
    });
    assert.equal(r1.notasNovas, 1);
    assert.equal(r1.errosPersistencia.length, 1);
    assert.equal(r1.errosPersistencia[0].chave, CHAVE_B);
    const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE empresa_id = ?', [EMP_A]);
    assert.equal(n.n, 1);

    falharChave.clear();
    const r2 = await persistirDocumentosRetorno(xml, persistReal, 'dfe', { empresaId: EMP_A });
    assert.equal(r2.notasNovas, 1);
    assert.equal(r2.notasDuplicadas, 1);
    const n2 = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE empresa_id = ?', [EMP_A]);
    assert.equal(n2.n, 2);
    db.close();
  });

  it('resposta DistDFe repetida não duplica documento', async () => {
    const db = await criarDb();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    const xml = montarRetornoDist({
      documentos: [{ nsu: '3', xml: xmlNota(CHAVE_A, '2026-10-10T10:00:00-03:00') }]
    });
    const a = await persistirDocumentosRetorno(xml, persist, 'dfe', { empresaId: EMP_A });
    const b = await persistirDocumentosRetorno(xml, persist, 'dfe', { empresaId: EMP_A });
    assert.equal(a.notasNovas, 1);
    assert.equal(b.notasDuplicadas, 1);
    assert.equal(b.notasNovas, 0);
    const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE chave = ?', [CHAVE_A]);
    assert.equal(n.n, 1);
    db.close();
  });
});

describe('Recuperação segura — cooldown, Gate e multiempresa', () => {
  it('cooldown FILA_ESGOTADA não executa DistDFe', async () => {
    let consultas = 0;
    const sync = new CentralSincronizacaoService({
      gate: null,
      nsuService: {
        buscarPorCnpjAmbiente: async () => ({
          ultNsu: '000000000000010',
          maxNsu: '000000000000010',
          ultimoCstat: '137',
          dataSincronizacao: new Date().toISOString()
        }),
        avaliarCooldown(controle) {
          return new CentralNsuService({ agora: () => new Date() }).avaliarCooldown(controle);
        }
      },
      configuracaoService: {
        obterContextoOperacional: async () => ({
          ok: true,
          contexto: { cnpj: '11111111000191', ambiente: 2, syncMaxDocumentos: 10 }
        })
      },
      sincronizarDistribuicaoDFe: async () => {
        consultas += 1;
        return { sucesso: true, consultaExecutada: true };
      }
    });
    const r = await sync._sincronizarEmpresa({ empresaId: EMP_A, cnpj: '11111111000191' }, {
      modo: ModoOperacionalGlobal.EMPRESA_SIMPLES
    });
    assert.equal(consultas, 0);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.ignorado, true);
  });

  it('Gate bloqueia distNSU sem avançar cursor', async () => {
    const nsu = criarNsuMemoria({ ultNsu: '000000000000003', maxNsu: '000000000000020' });
    const r = await sincronizarDistribuicaoDFe({
      contextoCentral: contexto(EMP_A),
      nsuService: nsu,
      persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true }) },
      gateSefaz: {
        autorizarConsultaDistDfe: async () => ({
          permitido: false,
          codigo: 'GATE_BLOQUEADO',
          mensagem: 'Gate recusou distNSU'
        })
      },
      enviarDistribuicaoDfe: async () => {
        throw new Error('SEFAZ não deveria ser chamada');
      }
    });
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.bloqueadoGate, true);
    assert.equal(nsu.snapshot().ultNsu, '000000000000003');
  });

  it('NSU da empresa A não altera cursor nem documentos da empresa B', async () => {
    const db = await criarDb();
    const nsuA = criarNsuMemoria();
    const nsuB = criarNsuMemoria({ ultNsu: '000000000000040', maxNsu: '000000000000040' });
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    const xml = montarRetornoDist({
      ultNSU: '6',
      maxNSU: '6',
      documentos: [{ nsu: '6', xml: xmlNota(CHAVE_A, '2026-10-10T10:00:00-03:00') }]
    });
    await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contexto(EMP_A),
      nsuService: nsuA,
      persistenciaService: persist,
      auditoriaService: criarAuditoriaSqlite(db),
      enviarDistribuicaoDfe: async () => ({ success: true, body: xml, endpoint: 'https://example.invalid/dfe', statusCode: 200 })
    });
    assert.equal(nsuA.snapshot().ultNsu, '000000000000006');
    assert.equal(nsuB.snapshot().ultNsu, '000000000000040');
    const repo = new CentralDocumentosRepository({ db });
    assert.equal((await repo.listar({ empresaId: EMP_B })).length, 0);
    assert.equal((await repo.listar({ empresaId: EMP_A })).length, 1);
    db.close();
  });
});

describe('Recuperação segura — filtros, data estimada e estoque', () => {
  it('documento de outro mês persiste mas some do filtro mês vigente', async () => {
    const db = await criarDb();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_SET, '2026-09-30T08:00:00-03:00'),
      empresaId: EMP_A,
      origem: 'dfe'
    });
    const intervalo = calcularIntervaloPeriodoPadrao(PERIODOS_PADRAO.MES_VIGENTE, new Date(2026, 9, 17));
    const repo = new CentralDocumentosRepository({ db });
    const doMes = await repo.listar({
      empresaId: EMP_A,
      dataEmissaoInicio: intervalo.dataEmissaoInicio,
      dataEmissaoFim: intervalo.dataEmissaoFim
    });
    const todos = await repo.listar({ empresaId: EMP_A });
    assert.equal(todos.length, 1);
    assert.equal(doMes.length, 0);
    db.close();
  });

  it('sem dhEmi a data de lista é estimada; com dhEmi é comprovada', async () => {
    const estimada = CentralDfePersistenciaService.completarDataEmissaoFromChave({
      chave: CHAVE_A,
      dataEmissao: ''
    });
    assert.equal(estimada.dataEmissao, '2026-10-01');
    assert.equal(estimada.dataEmissaoOrigem, 'chave_aamm');
    const comprovada = CentralDfePersistenciaService.completarDataEmissaoFromChave({
      chave: CHAVE_A,
      dataEmissao: '2026-10-17'
    });
    assert.equal(comprovada.dataEmissaoOrigem, 'xml');
    assert.equal(
      CentralDfePersistenciaService.classificarOrigemDataEmissao({ xml: xmlNota(CHAVE_B, null), chave: CHAVE_B }),
      'chave_aamm'
    );
    assert.equal(
      CentralDfePersistenciaService.classificarOrigemDataEmissao({
        xml: xmlNota(CHAVE_A, '2026-10-17T09:00:00-03:00'),
        chave: CHAVE_A
      }),
      'xml'
    );
    const dto = DocumentoFiscalInboxDTO.create({
      chave: CHAVE_A,
      dataEmissao: '2026-10-01',
      dataEmissaoOrigem: 'chave_aamm'
    }).toJSON();
    assert.equal(dto.dataEmissaoEstimada, true);
  });

  it('chave já em compras não cria segundo crédito de estoque (IMPORTADA duplicada)', async () => {
    const db = await criarDb();
    await run(db, 'INSERT INTO compras (id, chave_acesso, empresa_id) VALUES (1, ?, ?)', [CHAVE_A, EMP_A]);
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    const a = await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_A, '2026-10-10T10:00:00-03:00'),
      empresaId: EMP_A,
      origem: 'dfe'
    });
    const b = await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_A, '2026-10-10T10:00:00-03:00'),
      empresaId: EMP_A,
      origem: 'dfe'
    });
    assert.equal(a.documento.status, 'IMPORTADA');
    assert.equal(b.duplicado, true);
    const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE chave = ? AND empresa_id = ?', [
      CHAVE_A, EMP_A
    ]);
    assert.equal(n.n, 1);
    db.close();
  });

  it('pendência em memória some da lista aberta depois que o documento existe', () => {
    const abertas = filtrarPendenciasPersistenciaAbertas(
      [{ tipo: 'PERSISTENCIA', resultado: 'ERRO_BANCO', chave: CHAVE_A, empresaId: EMP_A }],
      [{ chave: CHAVE_A, empresaId: EMP_A }]
    );
    assert.equal(abertas.length, 0);
  });
});
