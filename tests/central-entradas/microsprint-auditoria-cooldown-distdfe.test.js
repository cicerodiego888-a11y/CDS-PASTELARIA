/**
 * Microsprint P0 — Auditoria do cooldown DistDFe e do estado da fila.
 * Isolado: mocks no ponto de envio, SQLite :memory:, sem SEFAZ real.
 *
 * node --test tests/central-entradas/microsprint-auditoria-cooldown-distdfe.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-audit-cooldown-');
const DB_DIR = isolamento.dbDir;
const fs = require('fs');
const path = require('path');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const zlib = require('zlib');

const CentralNsuService = require('../../backend/motores/central-entradas/services/CentralNsuService');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');
const CentralSincronizacaoService = require('../../backend/motores/central-entradas/services/CentralSincronizacaoService');
const CentralNotificacoesService = require('../../backend/motores/central-entradas/services/CentralNotificacoesService');
const { CentralSyncExecucaoService } = require(
  '../../backend/motores/central-entradas/services/CentralSyncExecucaoService'
);
const { ORIGENS } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const {
  sincronizarDistribuicaoDFe: sincronizarDistribuicaoDFeRaw
} = require('../../backend/services/fiscal/distribuicaoDFe');
const { anexarAutorizacaoTesteSefaz } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
function sincronizarDistribuicaoDFe(deps) {
  return sincronizarDistribuicaoDFeRaw(anexarAutorizacaoTesteSefaz(deps));
}
const {
  filtrarPendenciasPersistenciaAbertas
} = require('../../backend/services/fiscal/pendenciasPersistenciaDfe');
const gate = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
const sefazTrace = require('../../backend/motores/central-entradas/observability/SefazConsultaTrace');

const EMP_A = 11;
const EMP_B = 22;
const CNPJ_A = '11111111000191';
const CNPJ_B = '22222222000182';
const CHAVE_A = '35261012345678000199550010000000011000000011';
const FRONT_JS = path.join(__dirname, '../../frontend/erp/js/central-entradas.js');
const NSU_JS = path.join(__dirname, '../../backend/motores/central-entradas/services/CentralNsuService.js');
const FIXO = new Date('2026-10-17T18:00:00.000Z');

function xmlNota(chave) {
  return `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe${chave}">
    <ide><nNF>1</nNF><serie>1</serie><mod>55</mod><dhEmi>2026-10-10T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>12345678000199</CNPJ><xNome>FORN</xNome></emit>
    <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
  </infNFe></NFe></nfeProc>`;
}

function montarRetornoDist({ cStat = '137', ultNSU = '5', maxNSU = '5', documentos = [], xMotivo }) {
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
    <ultNSU>${String(ultNSU).padStart(15, '0')}</ultNSU>
    <maxNSU>${String(maxNSU).padStart(15, '0')}</maxNSU>
    <loteDistDFeInt>${docZips}</loteDistDFeInt>
  </retDistDFeInt>`;
}

function padNsu(n) {
  return String(n).padStart(15, '0');
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

async function criarDbNsu() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await run(db, `
    CREATE TABLE central_entradas_nsu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ambiente INTEGER NOT NULL DEFAULT 2,
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

function nsuServiceComDb(db, agora) {
  const repo = new CentralNsuRepository({ db });
  return new CentralNsuService({
    nsuRepository: repo,
    agora: agora || (() => new Date(FIXO)),
    eventosRepository: { buscarPorTipoECorrelationId: async () => null },
    emitirEventoObrigatorio: async (dados) => ({ id: 9001, ...dados })
  });
}

function auditoriaMem() {
  const registros = [];
  return {
    registros,
    registrar: async (d) => { registros.push(d); },
    registrarConsulta: async (d) => { registros.push({ ...d, tipo: 'CONSULTA' }); },
    registrarResumoSync: async (d) => { registros.push({ ...d, tipo: 'SYNC' }); },
    registrarNsuAvanco: async (d) => { registros.push({ ...d, tipo: 'NSU' }); }
  };
}

function contexto(empresaId = EMP_A) {
  return {
    certificadoPath: 'x.pfx',
    certificadoSenha: 'x',
    cnpj: empresaId === EMP_B ? CNPJ_B : CNPJ_A,
    codigoUf: '23',
    ambiente: 2,
    empresaId
  };
}

function criarEnvio(xml) {
  const chamadas = [];
  return {
    chamadas,
    enviar: async () => {
      chamadas.push(1);
      return {
        success: true,
        body: typeof xml === 'function' ? xml() : xml,
        endpoint: 'https://example.invalid/dfe',
        statusCode: 200
      };
    }
  };
}

let origAuthGate;

beforeEach(() => {
  sefazTrace.reset();
  origAuthGate = gate.autorizarConsultaDistDfe;
  gate.autorizarConsultaDistDfe = async () => ({ permitido: true, codigo: 'OK' });
});

afterEach(() => {
  gate.autorizarConsultaDistDfe = origAuthGate;
  sefazTrace.reset();
});

describe('Origem da janela de 1 hora', () => {
  it('INTERVALO_COOLDOWN_MS é 1h; FILA_ESGOTADA sticky (137/138/656 + ult=max, sem timer)', () => {
    assert.equal(CentralNsuService.INTERVALO_COOLDOWN_MS, 60 * 60 * 1000);
    const src = fs.readFileSync(NSU_JS, 'utf8');
    assert.match(src, /INTERVALO_COOLDOWN_MS = 60 \* 60 \* 1000/);
    assert.match(src, /CSTAT_FILA_ESGOTADA/);
    assert.match(src, /['"]656['"]/);
    assert.match(src, /FILA_LIBERADA_OP/);

    const nsu = new CentralNsuService({ agora: () => new Date(FIXO) });
    const fila = nsu.avaliarCooldown({
      ultNsu: padNsu(10),
      maxNsu: padNsu(10),
      ultimoCstat: '137',
      dataSincronizacao: '2026-10-17T17:30:00.000Z'
    });
    assert.equal(fila.ativo, true);
    assert.equal(fila.motivo, 'FILA_ESGOTADA');
    assert.equal(fila.proximaConsultaEm, null);

    const msg = CentralNsuService.montarMensagemCooldown(fila);
    assert.match(msg, /não enviada à SEFAZ/);
    assert.match(msg, /liberação operacional/i);
    assert.doesNotMatch(msg, /Erro na sincronização/);
  });
});

describe('1. Fila esgotada após resposta válida', () => {
  it('cStat 137 ult=max aplica NSU, inicia janela e bloqueia o segundo SOAP', async () => {
    const db = await criarDbNsu();
    const nsu = nsuServiceComDb(db);
    const xml = montarRetornoDist({ cStat: '137', ultNSU: '8', maxNSU: '8' });
    const envio = criarEnvio(xml);
    const r1 = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contexto(EMP_A),
      nsuService: nsu,
      persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true }) },
      auditoriaService: auditoriaMem(),
      enviarDistribuicaoDfe: envio.enviar
    });
    assert.equal(r1.consultaExecutada, true);
    assert.equal(r1.cStat, '137');
    assert.equal(envio.chamadas.length, 1);

    const controle = await nsu.buscarPorCnpjAmbiente(CNPJ_A, 2);
    const cooldown = nsu.avaliarCooldown(controle);
    assert.equal(cooldown.ativo, true);
    assert.equal(cooldown.motivo, 'FILA_ESGOTADA');
    assert.equal(controle.ultNsu, padNsu(8));
    assert.equal(controle.maxNsu, padNsu(8));

    const sync = new CentralSincronizacaoService({
      gate: null,
      nsuService: nsu,
      configuracaoService: {
        obterContextoOperacional: async () => ({
          ok: true,
          contexto: { cnpj: CNPJ_A, ambiente: 2, syncMaxDocumentos: 10 }
        })
      },
      sincronizarDistribuicaoDFe: async () => {
        envio.chamadas.push('BLOQUEIO_FALHOU');
        return { sucesso: true, consultaExecutada: true };
      }
    });
    const r2 = await sync._sincronizarEmpresa({ empresaId: EMP_A, cnpj: CNPJ_A }, {
      modo: ModoOperacionalGlobal.EMPRESA_SIMPLES
    });
    assert.equal(r2.consultaExecutada, false);
    assert.equal(r2.ignorado, true);
    assert.equal(r2.codigo, 'AGUARDAR_JANELA_DFE');
    assert.equal(r2.codigoDecisao, 'FILA_ESGOTADA');
    assert.match(r2.mensagem, /não enviada à SEFAZ/);
    assert.equal(r2.proximaConsultaEm, null);
    assert.match(r2.mensagem, /liberação operacional|fila esgotada/i);
    assert.equal(envio.chamadas.length, 1);
    db.close();
  });
});

describe('2. Consulta ignorada pelo Gate', () => {
  it('Gate bloqueia sem SOAP e sem iniciar FILA_ESGOTADA', async () => {
    gate.autorizarConsultaDistDfe = async () => ({
      permitido: false,
      codigo: 'BLOQUEADO_CONSUMO_INDEVIDO_656',
      mensagem: 'Gate bloqueado',
      cStat: '656'
    });
    const envio = criarEnvio(montarRetornoDist({ cStat: '137' }));
    const exec = new CentralSyncExecucaoService({
      sincronizacaoService: {
        sincronizar: async () => {
          envio.chamadas.push('NAO');
          return { sucesso: true, consultaExecutada: true };
        }
      },
      configuracaoService: {
        obterResumo: async () => ({}),
        verificarHorarioPermitido: async () => ({ permitido: true })
      },
      notificacoesService: { notificarSyncConcluida: async () => null }
    });
    const r = await exec.executar({
      origem: ORIGENS.MANUAL,
      ignorarHorario: true,
      ignorarCooldown: true
    });
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.ignorado, true);
    assert.equal(envio.chamadas.length, 0);
  });
});

describe('3. Consulta bloqueada pelo cooldown', () => {
  it('mensagem inclui horário de liberação e notificação não é SYNC_ERRO', async () => {
    const exec = new CentralSyncExecucaoService({
      sincronizacaoService: {
        sincronizar: async () => ({ sucesso: true, consultaExecutada: true })
      },
      configuracaoService: {
        obterResumo: async () => ({}),
        verificarHorarioPermitido: async () => ({ permitido: true })
      },
      notificacoesService: { notificarSyncConcluida: async () => null }
    });
    exec._verificarCooldownDfe = async () => ({
      ativo: true,
      motivo: 'FILA_ESGOTADA',
      ultNsu: padNsu(8),
      maxNsu: padNsu(8),
      proximaConsultaEm: '2026-10-17T19:00:00.000Z'
    });
    const gateMod = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
    const originalAuth = gateMod.autorizarConsultaDistDfe;
    gateMod.autorizarConsultaDistDfe = async () => ({ permitido: true, codigo: 'OK' });
    let r;
    try {
      r = await exec.executar({ origem: ORIGENS.MANUAL, ignorarHorario: true });
    } finally {
      gateMod.autorizarConsultaDistDfe = originalAuth;
    }
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.codigo, 'AGUARDAR_JANELA_DFE');
    assert.equal(r.codigoDecisao, 'FILA_ESGOTADA');
    assert.match(r.mensagem, /não enviada à SEFAZ/);
    assert.equal(r.proximaConsultaEm, '2026-10-17T19:00:00.000Z');
    assert.match(r.mensagem, /liberação operacional|fila esgotada/i);

    const gravados = [];
    const notif = new CentralNotificacoesService({
      notificacoesRepository: {
        inserir: async (d) => {
          gravados.push(d);
          return d;
        }
      }
    });
    const criada = await notif.notificarSyncConcluida({
      sucesso: false,
      ignorado: true,
      consultaExecutada: false,
      mensagem: r.mensagem
    });
    // Cooldown/fila esgotada: sem toast — operador não deve ver como erro do sistema.
    assert.equal(criada, null);
    assert.equal(gravados.length, 0);
  });
});

describe('4. Consulta concorrente impedida pelo mutex', () => {
  it('duas solicitações: 1 SOAP e 1 SYNC_EM_ANDAMENTO', async () => {
    const envio = criarEnvio(montarRetornoDist({ cStat: '137', ultNSU: '1', maxNSU: '1' }));
    const nsu = {
      obterOuCriar: async () => ({ id: 1, ultNsu: padNsu(0), maxNsu: padNsu(0) }),
      aplicarRetornoDistDfe: async (p) => ({
        controle: { id: 1, ultNsu: p.ultNsu, maxNsu: p.maxNsu },
        atualizouNsu: true,
        ultNsu: p.ultNsu,
        maxNsu: p.maxNsu
      }),
      avaliarCooldown: () => ({ ativo: false })
    };
    const gateMod = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
    const originalAuth = gateMod.autorizarConsultaDistDfe;
    gateMod.autorizarConsultaDistDfe = async () => ({ permitido: true, codigo: 'OK' });
    const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
    const exec = new CentralSyncExecucaoService({
      sincronizacaoService: {
        sincronizar: async (opts) => {
          await new Promise((r) => setTimeout(r, 40));
          return sincronizarDistribuicaoDFe({
            maxIteracoes: 1,
            contextoCentral: contexto(EMP_A),
            nsuService: nsu,
            persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true }) },
            auditoriaService: auditoriaMem(),
            enviarDistribuicaoDfe: envio.enviar,
            correlationId: opts.correlationId || null
          });
        }
      },
      configuracaoService: {
        obterResumo: async () => ({ notificarNovasNotas: false }),
        verificarHorarioPermitido: async () => ({ permitido: true })
      },
      listarAlvosSincronizacaoCentral: async () => ({
        modo: ModoOperacionalGlobal.MULTIEMPRESA,
        alvos: [{ empresaId: EMP_A, cnpj: CNPJ_A }]
      }),
      notificacoesService: { notificarSyncConcluida: async () => null }
    });
    try {
      const [a, b] = await Promise.all([
        exec.executar({ origem: ORIGENS.MANUAL, ignorarHorario: true }),
        exec.executar({ origem: ORIGENS.MANUAL, ignorarHorario: true })
      ]);
      const executado = [a, b].filter((r) => r.consultaExecutada === true);
      const mutex = [a, b].filter((r) => r.codigo === 'SYNC_EM_ANDAMENTO');
      assert.equal(executado.length, 1, JSON.stringify([a, b].map((r) => ({ c: r.codigo, e: r.consultaExecutada }))));
      assert.equal(mutex.length, 1);
      assert.equal(envio.chamadas.length, 1);
      assert.equal(mutex[0].consultaExecutada, false);
    } finally {
      gateMod.autorizarConsultaDistDfe = originalAuth;
    }
  });
});

describe('5. Falha de rede', () => {
  it('SOAP tentado, NSU preservado e FILA_ESGOTADA não inicia', async () => {
    const db = await criarDbNsu();
    const nsu = nsuServiceComDb(db);
    await nsu.obterOuCriar(CNPJ_A, 2);
    const envio = { chamadas: 0, enviar: async () => { envio.chamadas += 1; throw new Error('ECONNRESET simulado'); } };
    await assert.rejects(
      () => sincronizarDistribuicaoDFe({
        maxIteracoes: 1,
        contextoCentral: contexto(EMP_A),
        nsuService: nsu,
        persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true }) },
        auditoriaService: auditoriaMem(),
        enviarDistribuicaoDfe: envio.enviar
      }),
      /ECONNRESET/
    );
    assert.equal(envio.chamadas, 1);
    const controle = await nsu.buscarPorCnpjAmbiente(CNPJ_A, 2);
    assert.equal(controle.ultNsu, padNsu(0));
    assert.equal(nsu.avaliarCooldown(controle).ativo, false);
    db.close();
  });
});

describe('6. Falha de persistência', () => {
  it('consulta executada, NSU não avança, pendência ERRO_BANCO permanece, cooldown não inicia', async () => {
    const db = await criarDbNsu();
    const nsu = nsuServiceComDb(db);
    await nsu.obterOuCriar(CNPJ_A, 2);
    const xml = montarRetornoDist({
      cStat: '138',
      ultNSU: '9',
      maxNSU: '9',
      documentos: [{ nsu: '9', xml: xmlNota(CHAVE_A) }]
    });
    const envio = criarEnvio(xml);
    const aud = auditoriaMem();
    const r = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contexto(EMP_A),
      nsuService: nsu,
      persistenciaService: {
        persistirDocumentoDfe: async () => {
          const err = new Error('SQLITE_BUSY simulado');
          err.code = 'SQLITE_BUSY';
          throw err;
        }
      },
      auditoriaService: aud,
      enviarDistribuicaoDfe: envio.enviar
    });
    assert.equal(envio.chamadas.length, 1);
    assert.equal(r.consultaExecutada, true);
    assert.equal(r.sucesso, false);
    assert.ok((r.errosPersistencia || []).length >= 1);
    const controle = await nsu.buscarPorCnpjAmbiente(CNPJ_A, 2);
    assert.equal(controle.ultNsu, padNsu(0));
    assert.equal(nsu.avaliarCooldown(controle).ativo, false);
    const banco = aud.registros.filter((x) => String(x.resultado || '') === 'ERRO_BANCO');
    assert.ok(banco.length >= 1 || (r.errosPersistencia || []).length >= 1);
    const abertas = filtrarPendenciasPersistenciaAbertas(
      (r.errosPersistencia || []).map((p) => ({
        ...p,
        tipo: 'PERSISTENCIA',
        resultado: 'ERRO_BANCO'
      }))
    );
    assert.equal(abertas.length, (r.errosPersistencia || []).length);
    db.close();
  });
});

describe('7 e 8. Reinício e expiração da janela', () => {
  it('estado persiste; FILA sticky após 1h/24h; liberação operacional permite sync mock', async () => {
    const db = await criarDbNsu();
    let agora = new Date('2026-10-17T18:00:00.000Z');
    const nsu1 = nsuServiceComDb(db, () => agora);
    const controle0 = await nsu1.obterOuCriar(CNPJ_A, 2);
    await nsu1.aplicarRetornoDistDfe({
      controle: controle0,
      cStat: '137',
      ultNsu: padNsu(4),
      maxNsu: padNsu(4),
      xmlRetorno: montarRetornoDist({ cStat: '137', ultNSU: '4', maxNSU: '4' })
    });

    const nsuReinicio = nsuServiceComDb(db, () => new Date('2026-10-17T18:30:00.000Z'));
    const lido = await nsuReinicio.buscarPorCnpjAmbiente(CNPJ_A, 2);
    const ainda = nsuReinicio.avaliarCooldown(lido);
    assert.equal(ainda.ativo, true);
    assert.equal(ainda.motivo, 'FILA_ESGOTADA');

    const nsuUmaHora = nsuServiceComDb(db, () => new Date('2026-10-17T19:00:01.000Z'));
    const lido1h = await nsuUmaHora.buscarPorCnpjAmbiente(CNPJ_A, 2);
    assert.equal(nsuUmaHora.avaliarCooldown(lido1h).ativo, true);

    const nsu24h = nsuServiceComDb(db, () => new Date('2026-10-18T18:00:01.000Z'));
    const lido24 = await nsu24h.buscarPorCnpjAmbiente(CNPJ_A, 2);
    assert.equal(nsu24h.avaliarCooldown(lido24).ativo, true);
    assert.equal(nsu24h.avaliarCooldown(lido24).motivo, 'FILA_ESGOTADA');

    const { criarAutorizacaoTesteIsolado } = require(
      '../../backend/services/fiscal/autorizacaoTransmissaoSefaz'
    );
    await nsu24h.liberarFilaEsgotadaAutorizada({
      controle: lido24,
      confirmacaoLiberacaoFila: true,
      autorizacao: criarAutorizacaoTesteIsolado({ empresaId: EMP_A }),
      empresaId: EMP_A
    });
    const lidoLib = await nsu24h.buscarPorCnpjAmbiente(CNPJ_A, 2);
    assert.equal(nsu24h.avaliarCooldown(lidoLib).ativo, false);

    const envio = criarEnvio(montarRetornoDist({ cStat: '138', ultNSU: '5', maxNSU: '20' }));
    const r = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contexto(EMP_A),
      nsuService: nsu24h,
      persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true, documento: { chave: CHAVE_A } }) },
      auditoriaService: auditoriaMem(),
      enviarDistribuicaoDfe: envio.enviar,
      autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({ empresaId: EMP_A })
    });
    assert.equal(envio.chamadas.length, 1);
    assert.equal(r.consultaExecutada, true);
    db.close();
  });
});

describe('9. Isolamento entre duas empresas', () => {
  it('FILA_ESGOTADA de A não impede SOAP de B', async () => {
    const db = await criarDbNsu();
    const nsu = nsuServiceComDb(db);
    const a0 = await nsu.obterOuCriar(CNPJ_A, 2);
    await nsu.aplicarRetornoDistDfe({
      controle: a0,
      cStat: '137',
      ultNsu: padNsu(3),
      maxNsu: padNsu(3),
      xmlRetorno: montarRetornoDist({ cStat: '137', ultNSU: '3', maxNSU: '3' })
    });
    await nsu.obterOuCriar(CNPJ_B, 2);

    const envio = criarEnvio(montarRetornoDist({ cStat: '138', ultNSU: '1', maxNSU: '4', documentos: [{ nsu: '1', xml: xmlNota(CHAVE_A) }] }));
    const sync = new CentralSincronizacaoService({
      gate: null,
      nsuService: nsu,
      configuracaoService: {
        obterContextoOperacional: async ({ empresaId }) => ({
          ok: true,
          contexto: {
            ...contexto(Number(empresaId) === EMP_B ? EMP_B : EMP_A),
            syncMaxDocumentos: 10
          }
        })
      },
      sincronizarDistribuicaoDFe: async (deps) => {
        envio.chamadas.push(deps.contextoCentral.cnpj);
        return sincronizarDistribuicaoDFe({
          maxIteracoes: 1,
          contextoCentral: deps.contextoCentral,
          nsuService: nsu,
          persistenciaService: { persistirDocumentoDfe: async () => ({ novo: true }) },
          auditoriaService: auditoriaMem(),
          enviarDistribuicaoDfe: async () => ({
            success: true,
            body: montarRetornoDist({ cStat: '137', ultNSU: '1', maxNSU: '1' }),
            endpoint: 'https://example.invalid/dfe',
            statusCode: 200
          })
        });
      }
    });

    const ra = await sync._sincronizarEmpresa({ empresaId: EMP_A, cnpj: CNPJ_A }, {
      modo: ModoOperacionalGlobal.EMPRESA_SIMPLES
    });
    const rb = await sync._sincronizarEmpresa({ empresaId: EMP_B, cnpj: CNPJ_B }, {
      modo: ModoOperacionalGlobal.EMPRESA_SIMPLES
    });
    assert.equal(ra.consultaExecutada, false);
    assert.equal(ra.motivoIgnorado, 'FILA_ESGOTADA');
    assert.equal(rb.consultaExecutada, true);
    assert.deepEqual(envio.chamadas, [CNPJ_B]);
    db.close();
  });
});

describe('10. Respostas cStat 137, 138 e 656', () => {
  it('137 e 138 válidos avançam NSU; 656 usa cooldownAte; resposta inválida não renova FILA_ESGOTADA', async () => {
    const db = await criarDbNsu();
    const nsu = nsuServiceComDb(db);
    const c137 = await nsu.obterOuCriar(CNPJ_A, 2);
    const a137 = await nsu.aplicarRetornoDistDfe({
      controle: c137,
      cStat: '137',
      ultNsu: padNsu(2),
      maxNsu: padNsu(2),
      xmlRetorno: montarRetornoDist({ cStat: '137', ultNSU: '2', maxNSU: '2' })
    });
    assert.equal(a137.atualizouNsu, true);
    const data137 = (await nsu.buscarPorCnpjAmbiente(CNPJ_A, 2)).dataSincronizacao;
    const regressao = await nsu.aplicarRetornoDistDfe({
      controle: await nsu.buscarPorCnpjAmbiente(CNPJ_A, 2),
      cStat: '137',
      ultNsu: padNsu(1),
      maxNsu: padNsu(1),
      xmlRetorno: montarRetornoDist({ cStat: '137', ultNSU: '1', maxNSU: '1' })
    });
    assert.equal(regressao.preservado, true);
    const aPosRegressao = await nsu.buscarPorCnpjAmbiente(CNPJ_A, 2);
    assert.equal(aPosRegressao.ultNsu, padNsu(2));
    assert.equal(aPosRegressao.dataSincronizacao, data137);
    assert.equal(nsu.avaliarCooldown(aPosRegressao).motivo, 'FILA_ESGOTADA');

    const c138 = await nsu.obterOuCriar(CNPJ_B, 2);
    const a138 = await nsu.aplicarRetornoDistDfe({
      controle: c138,
      cStat: '138',
      ultNsu: padNsu(7),
      maxNsu: padNsu(12),
      xmlRetorno: montarRetornoDist({ cStat: '138', ultNSU: '7', maxNSU: '12' })
    });
    assert.equal(a138.atualizouNsu, true);
    assert.equal(nsu.avaliarCooldown(await nsu.buscarPorCnpjAmbiente(CNPJ_B, 2)).ativo, false);

    const a656 = await nsu.aplicarRetornoDistDfe({
      controle: await nsu.buscarPorCnpjAmbiente(CNPJ_B, 2),
      cStat: '656',
      xmlRetorno: montarRetornoDist({ cStat: '656', ultNSU: '7', maxNSU: '12' })
    });
    assert.equal(a656.cooldownAtivo, true);
    const cd656 = nsu.avaliarCooldown(await nsu.buscarPorCnpjAmbiente(CNPJ_B, 2));
    assert.equal(cd656.motivo, 'COOLDOWN_EXPLICITO');

    await nsu.aplicarRetornoDistDfe({
      controle: await nsu.buscarPorCnpjAmbiente(CNPJ_A, 2),
      cStat: '999',
      xmlRetorno: '<retDistDFeInt><cStat>999</cStat></retDistDFeInt>'
    });
    const aPosInvalido = await nsu.buscarPorCnpjAmbiente(CNPJ_A, 2);
    assert.equal(aPosInvalido.dataSincronizacao, data137);
    assert.equal(aPosInvalido.ultNsu, padNsu(2));
    db.close();
  });
});

describe('11. Regressão da sincronização ao abrir', () => {
  it('frontend diferencia bloqueio de sucesso e backend não afirma consulta enviada', () => {
    const src = fs.readFileSync(FRONT_JS, 'utf8');
    assert.match(src, /function montarMensagemConsultaNaoEnviadaCentral/);
    assert.match(src, /SYNC_CONSULTA_NAO_ENVIADA/);
    assert.match(src, /Liberação estimada/);
    assert.match(src, /consultaExecutada === false/);
    assert.match(src, /sincronizar-ao-abrir/);
    assert.equal(src.split('/sincronizar-ao-abrir').length - 1, 1);
  });
});

describe('12. Regressão da recuperação e histórico ERRO_BANCO', () => {
  it('NSU não avança em persistência falha e pendências abertas não são descartadas', async () => {
    const pendencias = [{
      chave: CHAVE_A,
      nsu: '9',
      tipo: 'PERSISTENCIA',
      codigo: 'SQLITE_BUSY',
      resultado: 'ERRO_BANCO'
    }];
    const abertas = filtrarPendenciasPersistenciaAbertas(pendencias, []);
    assert.equal(abertas.length, 1);
    assert.equal(abertas[0].chave, CHAVE_A);
    const resolvidas = filtrarPendenciasPersistenciaAbertas(pendencias, [
      { chave: CHAVE_A, empresaId: EMP_A }
    ]);
    assert.equal(resolvidas.length, 0);
  });
});

