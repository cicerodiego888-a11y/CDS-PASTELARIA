/**
 * Diagnóstico/correção: Central não localiza NF-e do mês.
 * Isolado: mocks DistDFe, SQLite :memory:, sem SEFAZ e sem certificado de produção.
 *
 * node --test tests/central-entradas/nfe-nao-localizada-sync.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-nfe-nao-localizada-sync-');

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-nfe-ausente-'));
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
const {
  persistirDocumentosRetorno,
  sincronizarDistribuicaoDFe: sincronizarDistribuicaoDFeRaw
} = require('../../backend/services/fiscal/distribuicaoDFe');
const { anexarAutorizacaoTesteSefaz } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
function sincronizarDistribuicaoDFe(deps) {
  return sincronizarDistribuicaoDFeRaw(anexarAutorizacaoTesteSefaz(deps));
}
const { calcularIntervaloPeriodoPadrao, PERIODOS_PADRAO } = require('../../backend/motores/central-entradas/services/CentralPeriodoPadraoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_MES = '35261012345678000199550010000000011000000011';
const CHAVE_MES_B = '35261012345678000199550010000000021000000022';

function xmlNota(chave, dhEmi) {
  const dh = dhEmi
    ? `<dhEmi>${dhEmi}</dhEmi>`
    : '';
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
    <cStat>${cStat}</cStat><xMotivo>Documento localizado</xMotivo>
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
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY, chave_acesso TEXT, empresa_id INTEGER,
      tipo_entrada TEXT, tipo_entrada_sugerido TEXT,
      tipo_entrada_confianca REAL, tipo_entrada_motivo TEXT,
      tipo_entrada_alterado INTEGER
    )
  `);
  return db;
}

describe('NF-e não localizada — consulta vs cooldown', () => {
  it('FILA_ESGOTADA com 137/138/656 quando ult=max; cooldown 656 explícito tem prioridade', () => {
    const nsu = new CentralNsuService({ agora: () => new Date('2026-10-17T18:00:00.000Z') });
    const fila = nsu.avaliarCooldown({
      ultNsu: '000000000000100',
      maxNsu: '000000000000100',
      ultimoCstat: '138',
      dataSincronizacao: '2026-10-17T17:30:00.000Z'
    });
    assert.equal(fila.ativo, true);
    assert.equal(fila.motivo, 'FILA_ESGOTADA');

    // P0.14 — 656 com ult=max e cooldown expirado ainda bloqueia por FILA_ESGOTADA.
    const pos656 = nsu.avaliarCooldown({
      ultNsu: '000000000000100',
      maxNsu: '000000000000100',
      ultimoCstat: '656',
      dataSincronizacao: '2026-10-17T17:30:00.000Z',
      cooldownAte: null
    });
    assert.equal(pos656.ativo, true);
    assert.equal(pos656.motivo, 'FILA_ESGOTADA');

    const explicito = nsu.avaliarCooldown({
      ultNsu: '000000000000100',
      maxNsu: '000000000000200',
      ultimoCstat: '656',
      cooldownAte: '2026-10-17T19:00:00.000Z'
    });
    assert.equal(explicito.ativo, true);
    assert.equal(explicito.motivo, 'COOLDOWN_EXPLICITO');
  });

  it('sincronização em cooldown não se apresenta como consulta concluída', async () => {
    const nsuService = {
      buscarPorCnpjAmbiente: async () => ({
        ultNsu: '000000000000010',
        maxNsu: '000000000000010',
        ultimoCstat: '137',
        dataSincronizacao: new Date().toISOString()
      }),
      avaliarCooldown(controle) {
        return new CentralNsuService({ agora: () => new Date() }).avaliarCooldown(controle);
      }
    };
    let consultas = 0;
    const sync = new CentralSincronizacaoService({
      gate: null,
      nsuService,
      configuracaoService: {
        obterContextoOperacional: async () => ({
          ok: true,
          contexto: { cnpj: '11111111000191', ambiente: 2, syncMaxDocumentos: 10 }
        })
      },
      sincronizarDistribuicaoDFe: async () => {
        consultas += 1;
        return { sucesso: true, consultaExecutada: true, notasNovas: 3 };
      }
    });
    const r = await sync._sincronizarEmpresa({ empresaId: EMP_A, cnpj: '11111111000191' }, {
      modo: ModoOperacionalGlobal.EMPRESA_SIMPLES
    });
    assert.equal(consultas, 0);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.ignorado, true);
    assert.equal(r.sucesso, false);
    assert.equal(r.codigo, 'AGUARDAR_JANELA_DFE');
    assert.equal(r.motivoIgnorado, 'FILA_ESGOTADA');
    assert.equal(/conclu[ií]da/i.test(r.mensagem), false);
  });

  it('falha de consulta DistDFe não avança NSU e não vira sucesso', async () => {
    const nsu = {
      obterOuCriar: async () => ({ id: 1, ultNsu: '000000000000001', maxNsu: '000000000000010' }),
      aplicarRetornoDistDfe: async () => {
        throw new Error('NSU não deveria ser aplicado em falha de consulta');
      }
    };
    await assert.rejects(
      () => sincronizarDistribuicaoDFe({
        maxIteracoes: 1,
        contextoCentral: {
          certificadoPath: 'x.pfx',
          certificadoSenha: 'x',
          cnpj: '11111111000191',
          codigoUf: '23',
          ambiente: 2,
          empresaId: EMP_A
        },
        nsuService: nsu,
        persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true }) },
        auditoriaService: {
          registrar: async () => {},
          registrarConsulta: async () => {},
          registrarResumoSync: async () => {},
          registrarNsuAvanco: async () => {}
        },
        enviarDistribuicaoDfe: async () => {
          throw new Error('ECONNRESET simulado');
        }
      }),
      /ECONNRESET/
    );
  });
});

describe('NF-e não localizada — persistência e retomada', () => {
  it('erro de persistência não conta como ignorado e não avança NSU', async () => {
    const xml = montarRetornoDist({
      ultNSU: '9',
      maxNSU: '9',
      documentos: [{ nsu: '9', xml: xmlNota(CHAVE_MES, '2026-10-10T10:00:00-03:00') }]
    });
    const chamadasAplicar = [];
    const nsuService = {
      obterOuCriar: async () => ({
        id: 1,
        ultNsu: '000000000000000',
        maxNsu: '000000000000000'
      }),
      aplicarRetornoDistDfe: async (p) => {
        chamadasAplicar.push(p);
        return {
          controle: { id: 1, ultNsu: p.ultNsu, maxNsu: p.maxNsu },
          atualizouNsu: true,
          ultNsu: p.ultNsu,
          maxNsu: p.maxNsu
        };
      }
    };
    const persistencia = {
      persistirDocumentoDfe: async () => {
        const err = new Error('SQLITE_BUSY simulado');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
    };
    const resultado = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: {
        certificadoPath: 'x.pfx',
        certificadoSenha: 'x',
        cnpj: '11111111000191',
        codigoUf: '23',
        ambiente: 2,
        empresaId: EMP_A
      },
      nsuService,
      persistenciaService: persistencia,
      auditoriaService: {
        registrar: async () => {},
        registrarConsulta: async () => {},
        registrarResumoSync: async () => {},
        registrarNsuAvanco: async () => {}
      },
      enviarDistribuicaoDfe: async () => ({
        success: true,
        body: xml,
        endpoint: 'https://example.invalid/dfe',
        statusCode: 200
      })
    });
    assert.equal(resultado.sucesso, false);
    assert.equal(resultado.consultaExecutada, true);
    assert.equal(resultado.codigo, 'PERSISTENCIA_DFE_INCOMPLETA');
    assert.equal(resultado.errosPersistencia.length, 1);
    assert.equal(chamadasAplicar.length, 0);
    assert.equal(resultado.ultNsu, '000000000000000');
  });

  it('retomada idempotente persiste na 2ª tentativa e então permite avançar NSU', async () => {
    let tentativas = 0;
    const persistencia = {
      persistirDocumentoDfe: async () => {
        tentativas += 1;
        if (tentativas === 1) {
          const err = new Error('falha transitória');
          err.code = 'SQLITE_BUSY';
          throw err;
        }
        return { novo: true, duplicado: false, documento: { id: 1, chave: CHAVE_MES } };
      }
    };
    const lote = await persistirDocumentosRetorno(
      montarRetornoDist({
        documentos: [{ nsu: '3', xml: xmlNota(CHAVE_MES, '2026-10-10T10:00:00-03:00') }]
      }),
      persistencia,
      'dfe',
      { empresaId: EMP_A }
    );
    assert.equal(lote.notasNovas, 1);
    assert.equal(lote.errosPersistencia.length, 0);
    assert.equal(tentativas, 2);
  });

  it('duplicata na mesma empresa não cria segundo documento', async () => {
    const db = await criarDb();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db }),
      empresaId: EMP_A
    });
    const xml = xmlNota(CHAVE_MES, '2026-10-10T10:00:00-03:00');
    const a = await persist.persistirDocumentoDfe({ xml, nsu: '1', origem: 'dfe', empresaId: EMP_A });
    const b = await persist.persistirDocumentoDfe({ xml, nsu: '1', origem: 'dfe', empresaId: EMP_A });
    assert.equal(a.documento.id, b.documento.id);
    assert.equal(b.duplicado, true);
    const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE chave = ? AND empresa_id = ?', [
      CHAVE_MES, EMP_A
    ]);
    assert.equal(n.n, 1);
    db.close();
  });

  it('empresa B não vê documento persistido da empresa A', async () => {
    const db = await criarDb();
    const repo = new CentralDocumentosRepository({ db });
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: repo,
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_MES, '2026-10-10T10:00:00-03:00'),
      nsu: '1',
      origem: 'dfe',
      empresaId: EMP_A
    });
    const daB = await repo.buscarPorChave(CHAVE_MES, EMP_B);
    const listaB = await repo.listar({ empresaId: EMP_B });
    assert.equal(daB, null);
    assert.equal(listaB.length, 0);
    const listaA = await repo.listar({ empresaId: EMP_A });
    assert.equal(listaA.length, 1);
    db.close();
  });
});

describe('NF-e não localizada — filtros mensais', () => {
  it('mês vigente inclui emissão de outubro/2026 e exclui setembro', async () => {
    const db = await criarDb();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_MES, '2026-10-05T08:00:00-03:00'),
      empresaId: EMP_A,
      origem: 'dfe'
    });
    await persist.persistirDocumentoDfe({
      xml: xmlNota('35260912345678000199550010000000011000000099', '2026-09-30T08:00:00-03:00'),
      empresaId: EMP_A,
      origem: 'dfe'
    });
    const intervalo = calcularIntervaloPeriodoPadrao(
      PERIODOS_PADRAO.MES_VIGENTE,
      new Date(2026, 9, 17)
    );
    assert.equal(intervalo.dataEmissaoInicio, '2026-10-01');
    assert.equal(intervalo.dataEmissaoFim, '2026-10-17');
    const repo = new CentralDocumentosRepository({ db });
    const doMes = await repo.listar({
      empresaId: EMP_A,
      dataEmissaoInicio: intervalo.dataEmissaoInicio,
      dataEmissaoFim: intervalo.dataEmissaoFim
    });
    assert.equal(doMes.length, 1);
    assert.equal(doMes[0].chave, CHAVE_MES);
    db.close();
  });

  it('XML sem dhEmi recebe data da chave e aparece no mês vigente', async () => {
    const preenchido = CentralDfePersistenciaService.completarDataEmissaoFromChave({
      chave: CHAVE_MES,
      dataEmissao: ''
    });
    assert.equal(preenchido.dataEmissao, '2026-10-01');
    const db = await criarDb();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_MES_B, null),
      empresaId: EMP_A,
      origem: 'dfe'
    });
    const row = await get(db, 'SELECT data_emissao FROM central_entradas_documentos WHERE chave = ?', [CHAVE_MES_B]);
    assert.equal(row.data_emissao, '2026-10-01');
    db.close();
  });
});
