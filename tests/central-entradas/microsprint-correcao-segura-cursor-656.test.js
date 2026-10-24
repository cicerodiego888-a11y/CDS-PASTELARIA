/**
 * Microsprint P0 — Bloqueio de avanço indevido do NSU em cStat 656.
 * Isolado: SQLite :memory:, SOAP simulado, sem certificado real.
 *
 * node --test tests/central-entradas/microsprint-correcao-segura-cursor-656.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-cursor-656-');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const zlib = require('zlib');

const CentralNsuService = require('../../backend/motores/central-entradas/services/CentralNsuService');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');
const NsuRecoveryService = require('../../backend/motores/central-entradas/services/NsuRecoveryService');
const { TIPOS_EVENTO } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { CentralSyncExecucaoService } = require(
  '../../backend/motores/central-entradas/services/CentralSyncExecucaoService'
);
const { ORIGENS } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { sincronizarDistribuicaoDFe: sincronizarDistribuicaoDFeRaw } = require('../../backend/services/fiscal/distribuicaoDFe');
const { anexarAutorizacaoTesteSefaz } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');

function sincronizarDistribuicaoDFe(deps) {
  return sincronizarDistribuicaoDFeRaw(anexarAutorizacaoTesteSefaz(deps));
}

const CNPJ_MATRIZ = '38204469000115';
const CNPJ_FILIAL2 = '38204469000387';
const CNPJ_FILIAL3 = '38204469000204';
const FIXO = new Date('2026-10-17T21:00:00.000Z');

function padNsu(n) {
  return String(n).padStart(15, '0');
}

function xmlNota(chave) {
  return `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe${chave}">
    <ide><nNF>1</nNF><serie>1</serie><mod>55</mod><dhEmi>2026-09-27T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>12345678000199</CNPJ><xNome>FORN</xNome></emit>
    <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
  </infNFe></NFe></nfeProc>`;
}

function montarRetornoDist({
  cStat = '137',
  ultNSU = '0',
  maxNSU = '0',
  documentos = [],
  xMotivo
}) {
  const docZips = documentos.map((doc) => {
    const compactado = zlib.gzipSync(Buffer.from(doc.xml, 'utf8')).toString('base64');
    return `<docZip NSU="${doc.nsu}" schema="${doc.schema || 'procNFe_v4.00.xsd'}">${compactado}</docZip>`;
  }).join('');
  const motivo = xMotivo
    || (cStat === '137'
      ? 'Nenhum documento localizado'
      : (cStat === '656' ? 'Consumo Indevido' : 'Documento localizado'));
  return `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">
    <cStat>${cStat}</cStat><xMotivo>${motivo}</xMotivo>
    <ultNSU>${padNsu(ultNSU)}</ultNSU>
    <maxNSU>${padNsu(maxNSU)}</maxNSU>
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

async function criarDbNsu() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await run(db, `
    CREATE TABLE central_entradas_nsu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ambiente INTEGER NOT NULL DEFAULT 1,
      ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
      max_nsu TEXT NOT NULL DEFAULT '000000000000000',
      data_sincronizacao DATETIME,
      cooldown_ate DATETIME,
      ultimo_cstat TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ambiente)
    )
  `);
  return db;
}

function nsuStack(db, agora = () => new Date(FIXO)) {
  const eventos = [];
  const repo = new CentralNsuRepository({ db });
  const recovery = new NsuRecoveryService({
    nsuRepository: repo,
    agora,
    emitirEvento: async (ev) => { eventos.push(ev); }
  });
  const service = new CentralNsuService({
    nsuRepository: repo,
    agora,
    nsuRecovery: recovery,
    emitirEvento: async (ev) => { eventos.push(ev); }
  });
  return { repo, recovery, service, eventos };
}

function auditoriaMem() {
  const registros = [];
  return {
    registros,
    registrar: async (d) => { registros.push(d); },
    registrarConsulta: async (d) => { registros.push({ ...d, tipo: 'CONSULTA' }); },
    registrarResumoSync: async (d) => { registros.push({ ...d, tipo: 'SYNC', motivo: d.motivo }); },
    registrarNsuAvanco: async (d) => {
      registros.push({
        ...d,
        tipo: 'NSU',
        resultado: d.avancou ? 'NSU_AVANCO' : 'NSU_PRESERVADO'
      });
    }
  };
}

describe('isolamento do banco oficial', () => {
  it('guardião recusa abrir mercadao.db em ProgramData', () => {
    const sqlite3mod = require('sqlite3');
    const { MENSAGEM_RECUSA } = require('./helpers/isolarBancoTeste');
    assert.throws(
      () => new sqlite3mod.Database('C:\\ProgramData\\MercantilFiscal\\dados\\mercadao.db'),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
        || /banco oficial bloqueado/i.test(String(err.message))
    );
    assert.ok(process.env.DB_DIR);
    assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(process.env.DB_DIR), false);
  });
});

describe('656 não avança cursor', () => {
  beforeEach(() => NsuRecoveryService.limparCacheEventos());

  it('656 com ultNSU remoto maior e maxNSU=0: cursor preservado', async () => {
    const db = await criarDbNsu();
    const { service, eventos } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(127), padNsu(127)]);
    const controle = await service.obterOuCriar(CNPJ_MATRIZ, 1);

    const r = await service.aplicarRetornoDistDfe({
      controle,
      cStat: '656',
      ultNsu: padNsu(148),
      maxNsu: padNsu(0),
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 148, maxNSU: 0 }),
      correlationId: '656-max0',
      empresa: CNPJ_MATRIZ
    });

    assert.equal(r.atualizouNsu, false);
    assert.equal(r.preservado, true);
    assert.equal(r.cooldownAtivo, true);
    assert.equal(r.recuperacaoNsu.motivo, 'NSU_REMOTO_INCONSISTENTE');
    const row = await get(db, 'SELECT ult_nsu, max_nsu, ultimo_cstat, cooldown_ate FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_MATRIZ]);
    assert.equal(row.ult_nsu, padNsu(127));
    assert.equal(row.max_nsu, padNsu(127));
    assert.equal(row.ultimo_cstat, '656');
    assert.ok(row.cooldown_ate);
    assert.equal(eventos.filter((e) => e.tipo === TIPOS_EVENTO.AUTO_SYNC_NSU).length, 0);
    assert.equal(eventos.filter((e) => e.tipo === TIPOS_EVENTO.NSU_PRESERVADO_656).length, 1);
    db.close();
  });

  it('656 com ultNSU e maxNSU inconsistentes (max < ult): cursor preservado', async () => {
    const db = await criarDbNsu();
    const { service } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_FILIAL2, padNsu(25), padNsu(25)]);
    const r = await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_FILIAL2, 1),
      cStat: '656',
      ultNsu: padNsu(40),
      maxNsu: padNsu(29),
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 40, maxNSU: 29 }),
      correlationId: '656-inconsistente',
      empresa: CNPJ_FILIAL2
    });
    assert.equal(r.atualizouNsu, false);
    assert.equal(r.recuperacaoNsu.motivo, 'NSU_REMOTO_INCONSISTENTE');
    const row = await get(db, 'SELECT ult_nsu, max_nsu FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_FILIAL2]);
    assert.equal(row.ult_nsu, padNsu(25));
    assert.equal(row.max_nsu, padNsu(25));
    db.close();
  });

  it('656 com valores iguais ao cursor local: nenhum avanço', async () => {
    const db = await criarDbNsu();
    const { service, eventos } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_FILIAL3, padNsu(35), padNsu(35)]);
    const r = await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_FILIAL3, 1),
      cStat: '656',
      ultNsu: padNsu(35),
      maxNsu: padNsu(35),
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 35, maxNSU: 35 }),
      correlationId: '656-igual'
    });
    assert.equal(r.atualizouNsu, false);
    assert.equal(r.recuperacaoNsu.motivo, 'SEFAZ_NAO_MAIOR');
    const row = await get(db, 'SELECT ult_nsu, max_nsu FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_FILIAL3]);
    assert.equal(row.ult_nsu, padNsu(35));
    assert.equal(row.max_nsu, padNsu(35));
    assert.equal(eventos.filter((e) => e.tipo === TIPOS_EVENTO.AUTO_SYNC_NSU).length, 0);
    db.close();
  });

  it('656 com par remoto “válido” mas maior que o local: ainda não avança (RC3.7.5.1 revogado)', async () => {
    const db = await criarDbNsu();
    const { service, eventos } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(0), padNsu(0)]);
    const r = await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_MATRIZ, 1),
      cStat: '656',
      ultNsu: padNsu(428),
      maxNsu: padNsu(500),
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 428, maxNSU: 500 }),
      correlationId: '656-restore-bloqueado',
      empresa: CNPJ_MATRIZ
    });
    assert.equal(r.atualizouNsu, false);
    assert.equal(r.recuperacaoNsu.motivo, 'AVANCO_656_BLOQUEADO');
    const row = await get(db, 'SELECT ult_nsu, max_nsu FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_MATRIZ]);
    assert.equal(row.ult_nsu, padNsu(0));
    assert.equal(row.max_nsu, padNsu(0));
    assert.equal(eventos.some((e) => e.tipo === TIPOS_EVENTO.AUTO_SYNC_NSU), false);
    assert.equal(eventos.some((e) => e.tipo === TIPOS_EVENTO.NSU_PRESERVADO_656), true);
    db.close();
  });
});

describe('Preservação de max_nsu, cooldown e reinício', () => {
  beforeEach(() => NsuRecoveryService.limparCacheEventos());

  it('max_nsu válido existente não é zerado por 656 nem pelo CASE do repositório', async () => {
    const db = await criarDbNsu();
    const { repo } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(180), padNsu(180)]);
    const row0 = await repo.buscarPorCnpjAmbiente(CNPJ_MATRIZ, 1);
    const apos = await repo.atualizarSincronizacaoSegura(row0.id, {
      ultNsu: padNsu(196),
      maxNsu: padNsu(0),
      ultimoCstat: '656'
    });
    assert.equal(apos.ultNsu, padNsu(180));
    assert.equal(apos.maxNsu, padNsu(180));
    db.close();
  });

  it('cooldown 1h e motivo de preservação após 656', async () => {
    const db = await criarDbNsu();
    const agora = () => new Date(FIXO);
    const { service } = nsuStack(db, agora);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(196), padNsu(196)]);
    const r = await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_MATRIZ, 1),
      cStat: '656',
      ultNsu: padNsu(210),
      maxNsu: padNsu(0),
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 210, maxNSU: 0 }),
      correlationId: '656-cd'
    });
    assert.equal(r.proximaConsultaEm, '2026-10-17T22:00:00.000Z');
    const cd = service.avaliarCooldown(r.controle);
    assert.equal(cd.ativo, true);
    assert.equal(cd.motivo, 'COOLDOWN_EXPLICITO');
    assert.match(r.recuperacaoNsu.motivo, /656|INCONSISTENTE/);
    db.close();
  });

  it('656 repetido após reinicialização do cache: cursor íntegro', async () => {
    const db = await criarDbNsu();
    const { service } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(127), padNsu(127)]);
    await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_MATRIZ, 1),
      cStat: '656',
      ultNsu: padNsu(148),
      maxNsu: padNsu(0),
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 148, maxNSU: 0 }),
      correlationId: '656-ciclo-1'
    });
    NsuRecoveryService.limparCacheEventos();
    const r2 = await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_MATRIZ, 1),
      cStat: '656',
      ultNsu: padNsu(148),
      maxNsu: padNsu(0),
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 148, maxNSU: 0 }),
      correlationId: '656-ciclo-2'
    });
    assert.equal(r2.atualizouNsu, false);
    const row = await get(db, 'SELECT ult_nsu, max_nsu FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_MATRIZ]);
    assert.equal(row.ult_nsu, padNsu(127));
    assert.equal(row.max_nsu, padNsu(127));
    db.close();
  });
});

describe('Isolamento entre empresas e 137/138', () => {
  beforeEach(() => NsuRecoveryService.limparCacheEventos());

  it('656 em uma empresa não altera o cursor das outras', async () => {
    const db = await criarDbNsu();
    const { service } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu) VALUES
      (?, 1, ?, ?), (?, 1, ?, ?), (?, 1, ?, ?)`, [
      CNPJ_MATRIZ, padNsu(127), padNsu(127),
      CNPJ_FILIAL2, padNsu(25), padNsu(25),
      CNPJ_FILIAL3, padNsu(17), padNsu(17)
    ]);
    await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_MATRIZ, 1),
      cStat: '656',
      ultNsu: padNsu(196),
      maxNsu: padNsu(0),
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 196, maxNSU: 0 }),
      correlationId: 'iso-matriz',
      empresa: CNPJ_MATRIZ
    });
    const rows = await all(db, 'SELECT cnpj, ult_nsu, max_nsu, ultimo_cstat FROM central_entradas_nsu ORDER BY cnpj');
    const por = Object.fromEntries(rows.map((r) => [r.cnpj, r]));
    assert.equal(por[CNPJ_MATRIZ].ult_nsu, padNsu(127));
    assert.equal(por[CNPJ_MATRIZ].ultimo_cstat, '656');
    assert.equal(por[CNPJ_FILIAL2].ult_nsu, padNsu(25));
    assert.equal(por[CNPJ_FILIAL2].ultimo_cstat, null);
    assert.equal(por[CNPJ_FILIAL3].ult_nsu, padNsu(17));
    db.close();
  });

  it('137/138 válido avança cursor atomicamente', async () => {
    const db = await criarDbNsu();
    const { service } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(124), padNsu(124)]);
    const r138 = await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_MATRIZ, 1),
      cStat: '138',
      ultNsu: padNsu(127),
      maxNsu: padNsu(127),
      xmlRetorno: montarRetornoDist({ cStat: '138', ultNSU: 127, maxNSU: 127 }),
      correlationId: '138-ok'
    });
    assert.equal(r138.atualizouNsu, true);
    assert.equal(r138.ultNsu, padNsu(127));
    assert.equal(r138.maxNsu, padNsu(127));

    const r137 = await service.aplicarRetornoDistDfe({
      controle: r138.controle,
      cStat: '137',
      ultNsu: padNsu(127),
      maxNsu: padNsu(127),
      xmlRetorno: montarRetornoDist({ cStat: '137', ultNSU: 127, maxNSU: 127 }),
      correlationId: '137-ok'
    });
    assert.equal(r137.atualizouNsu, true);
    const row = await get(db, 'SELECT ult_nsu, max_nsu, ultimo_cstat FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_MATRIZ]);
    assert.equal(row.ult_nsu, padNsu(127));
    assert.equal(row.max_nsu, padNsu(127));
    assert.equal(row.ultimo_cstat, '137');
    db.close();
  });

  it('137 com max válido restaura max_nsu que estava zerado sem recuar ult', async () => {
    const db = await criarDbNsu();
    const { service } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_FILIAL3, padNsu(35), padNsu(0)]);
    const r = await service.aplicarRetornoDistDfe({
      controle: await service.obterOuCriar(CNPJ_FILIAL3, 1),
      cStat: '137',
      ultNsu: padNsu(35),
      maxNsu: padNsu(35),
      xmlRetorno: montarRetornoDist({ cStat: '137', ultNSU: 35, maxNSU: 35 }),
      correlationId: '137-restaura-max'
    });
    assert.equal(r.atualizouNsu, true);
    const row = await get(db, 'SELECT ult_nsu, max_nsu FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_FILIAL3]);
    assert.equal(row.ult_nsu, padNsu(35));
    assert.equal(row.max_nsu, padNsu(35));
    db.close();
  });
});

describe('Persistência 137/138, concorrência e DistDFe 656', () => {
  beforeEach(() => NsuRecoveryService.limparCacheEventos());

  it('falha de persistência em 138 não avança o cursor', async () => {
    const db = await criarDbNsu();
    const { service } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(124), padNsu(124)]);
    const controle = await service.obterOuCriar(CNPJ_MATRIZ, 1);
    let aplicarChamadas = 0;
    const nsuService = {
      obterOuCriar: async () => controle,
      avaliarCooldown: () => ({ ativo: false }),
      aplicarRetornoDistDfe: async (p) => {
        aplicarChamadas += 1;
        return service.aplicarRetornoDistDfe(p);
      }
    };
    const xml = montarRetornoDist({
      cStat: '138',
      ultNSU: 127,
      maxNSU: 127,
      documentos: [{
        nsu: '125',
        xml: xmlNota('23260908606343000106550080005208281025774244')
      }]
    });
    const resultado = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: {
        certificadoPath: 'x.pfx',
        certificadoSenha: 'x',
        cnpj: CNPJ_MATRIZ,
        codigoUf: '23',
        ambiente: 1,
        empresaId: 1
      },
      nsuService,
      persistenciaService: {
        persistirDocumentoDfe: async () => {
          const err = new Error('SQLITE_BUSY simulado');
          err.code = 'SQLITE_BUSY';
          throw err;
        }
      },
      auditoriaService: auditoriaMem(),
      enviarDistribuicaoDfe: async () => ({
        success: true,
        body: xml,
        endpoint: 'https://example.invalid/dfe',
        statusCode: 200
      })
    });
    assert.equal(resultado.codigo, 'PERSISTENCIA_DFE_INCOMPLETA');
    assert.equal(aplicarChamadas, 0);
    const row = await get(db, 'SELECT ult_nsu, max_nsu FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_MATRIZ]);
    assert.equal(row.ult_nsu, padNsu(124));
    assert.equal(row.max_nsu, padNsu(124));
    db.close();
  });

  it('DistDFe 656 simulado não emite AUTO_SYNC e não avança NSU', async () => {
    const db = await criarDbNsu();
    const { service, eventos } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(180), padNsu(180)]);
    const controle = await service.obterOuCriar(CNPJ_MATRIZ, 1);
    const aud = auditoriaMem();
    const xml = montarRetornoDist({
      cStat: '656',
      ultNSU: 196,
      maxNSU: 0,
      xMotivo: 'Rejeicao: Consumo Indevido (Deve ser utilizado o ultNSU nas solicitacoes subsequentes.)'
    });
    const resultado = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: {
        certificadoPath: 'x.pfx',
        certificadoSenha: 'x',
        cnpj: CNPJ_MATRIZ,
        codigoUf: '23',
        ambiente: 1,
        empresaId: 1
      },
      nsuService: service,
      persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true }) },
      auditoriaService: aud,
      enviarDistribuicaoDfe: async () => ({
        success: true,
        body: xml,
        endpoint: 'https://example.invalid/dfe',
        statusCode: 200
      })
    });
    assert.equal(resultado.codigo, 'CONSUMO_INDEVIDO');
    assert.equal(resultado.nsuRecuperado, false);
    assert.equal(resultado.ultNsu, padNsu(180));
    const nsuAud = aud.registros.filter((r) => r.tipo === 'NSU');
    assert.ok(nsuAud.every((r) => r.avancou === false));
    assert.ok(aud.registros.some((r) => r.motivo === 'CONSUMO_INDEVIDO'));
    assert.equal(aud.registros.some((r) => String(r.motivo || '').includes('NSU_RECUPERADO')), false);
    assert.equal(eventos.some((e) => e.tipo === TIPOS_EVENTO.AUTO_SYNC_NSU), false);
    const row = await get(db, 'SELECT ult_nsu, max_nsu FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_MATRIZ]);
    assert.equal(row.ult_nsu, padNsu(180));
    assert.equal(row.max_nsu, padNsu(180));
    void controle;
    db.close();
  });

  it('concorrência: atualizações 656/138 no mesmo CNPJ não corrompem o par', async () => {
    const db = await criarDbNsu();
    const { service } = nsuStack(db);
    await run(db, `INSERT INTO central_entradas_nsu (cnpj, ambiente, ult_nsu, max_nsu)
      VALUES (?, 1, ?, ?)`, [CNPJ_MATRIZ, padNsu(124), padNsu(124)]);
    const controle = await service.obterOuCriar(CNPJ_MATRIZ, 1);
    const resultados = await Promise.all([
      service.aplicarRetornoDistDfe({
        controle,
        cStat: '656',
        ultNsu: padNsu(196),
        maxNsu: padNsu(0),
        xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 196, maxNSU: 0 }),
        correlationId: 'conc-656-a'
      }),
      service.aplicarRetornoDistDfe({
        controle,
        cStat: '656',
        ultNsu: padNsu(196),
        maxNsu: padNsu(0),
        xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: 196, maxNSU: 0 }),
        correlationId: 'conc-656-b'
      }),
      service.aplicarRetornoDistDfe({
        controle,
        cStat: '138',
        ultNsu: padNsu(127),
        maxNsu: padNsu(127),
        xmlRetorno: montarRetornoDist({ cStat: '138', ultNSU: 127, maxNSU: 127 }),
        correlationId: 'conc-138'
      })
    ]);
    assert.ok(resultados.filter((r) => r.preservado && r.recuperacaoNsu).length >= 2);
    const row = await get(db, 'SELECT ult_nsu, max_nsu FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_MATRIZ]);
    const ult = Number(row.ult_nsu);
    const max = Number(row.max_nsu);
    assert.ok(ult === 124 || ult === 127);
    assert.equal(max, ult);
    assert.notEqual(row.max_nsu, padNsu(0));
    db.close();
  });

  it('mutex DistDFe: uma execução efetiva', async () => {
    const envios = [];
    const gateMod = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
    const originalAuth = gateMod.autorizarConsultaDistDfe;
    gateMod.autorizarConsultaDistDfe = async () => ({ permitido: true, codigo: 'OK' });
    const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
    const exec = new CentralSyncExecucaoService({
      sincronizacaoService: {
        sincronizar: async () => {
          envios.push(1);
          await new Promise((r) => setTimeout(r, 30));
          return { sucesso: true, consultaExecutada: true, cStat: '137' };
        }
      },
      configuracaoService: {
        obterResumo: async () => ({ notificarNovasNotas: false }),
        verificarHorarioPermitido: async () => ({ permitido: true })
      },
      // MULTIEMPRESA: cooldown global pré-lock é adiado para o loop por empresa.
      listarAlvosSincronizacaoCentral: async () => ({
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        alvos: [{ empresaId: 1, cnpj: CNPJ_MATRIZ }]
      }),
      notificacoesService: { notificarSyncConcluida: async () => null }
    });
    try {
      // P0.11: ignorarCooldown não bypassa mais; mocks acima liberam Gate/NSU para isolar o mutex.
      const [a, b] = await Promise.all([
        exec.executar({ origem: ORIGENS.MANUAL, ignorarHorario: true }),
        exec.executar({ origem: ORIGENS.MANUAL, ignorarHorario: true })
      ]);
      const mutex = [a, b].filter((r) => r.codigo === 'SYNC_EM_ANDAMENTO');
      const ok = [a, b].filter((r) => r.consultaExecutada === true);
      assert.equal(ok.length, 1, `ok=${JSON.stringify([a, b].map((r) => ({ c: r.codigo, e: r.consultaExecutada })))}`);
      assert.equal(mutex.length, 1);
      assert.equal(envios.length, 1);
    } finally {
      gateMod.autorizarConsultaDistDfe = originalAuth;
    }
  });
});
