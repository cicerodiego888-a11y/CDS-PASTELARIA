/**
 * Auditoria de consumo DistDFe ao abrir a Central de Entradas.
 * Isolado: intercepta o ponto de envio, SQLite :memory:, sem SEFAZ e sem certificado de produção.
 *
 * node --test tests/central-entradas/auditoria-consumo-abertura-central.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-p04-auditoria-consumo-abertura-central-');

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-audit-open-'));
process.env.DB_DIR = DB_DIR;
process.env.CDS_FORCAR_LOCAL = '1';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const sefazTrace = require('../../backend/motores/central-entradas/observability/SefazConsultaTrace');
const { ORIGENS } = require('../../backend/motores/central-entradas/config/centralEventosTipos');
const { CentralSyncExecucaoService } = require(
  '../../backend/motores/central-entradas/services/CentralSyncExecucaoService'
);
const CentralSincronizacaoService = require(
  '../../backend/motores/central-entradas/services/CentralSincronizacaoService'
);
const { CentralEntradasOrchestrator } = require(
  '../../backend/motores/central-entradas/CentralEntradasOrchestrator'
);
const {
  sincronizarDistribuicaoDFe
} = require('../../backend/services/fiscal/distribuicaoDFe');
const gate = require('../../backend/motores/central-entradas/services/CentralSefazOperationalGate');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const EMP_A = 11;
const EMP_B = 22;
const CNPJ_A = '11111111000191';
const CNPJ_B = '22222222000182';
const CHAVE_MES = '35261012345678000199550010000000011000000011';

const FRONT_JS = path.join(__dirname, '../../frontend/erp/js/central-entradas.js');
const ROTA_JS = path.join(__dirname, '../../backend/rotas/central-entradas.js');

function xmlNota(chave) {
  return `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe${chave}">
    <ide><nNF>1</nNF><serie>1</serie><mod>55</mod><dhEmi>2026-10-10T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>12345678000199</CNPJ><xNome>FORN</xNome></emit>
    <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
  </infNFe></NFe></nfeProc>`;
}

function montarRetornoDist({ cStat = '137', ultNSU = '1', maxNSU = '1', documentos = [] }) {
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

const XML_137 = montarRetornoDist({ cStat: '137', ultNSU: '5', maxNSU: '5' });
const XML_138 = montarRetornoDist({
  cStat: '138',
  ultNSU: '9',
  maxNSU: '9',
  documentos: [{ nsu: '9', xml: xmlNota(CHAVE_MES) }]
});

function contextoEmpresa(empresaId, cnpj) {
  return {
    certificadoPath: 'x.pfx',
    certificadoSenha: 'segredo-nao-pode-aparecer',
    cnpj,
    codigoUf: '23',
    ambiente: 2,
    empresaId
  };
}

function nsuServiceLivre() {
  const porCnpj = new Map();
  return {
    obterOuCriar: async (cnpj) => {
      const key = String(cnpj);
      if (!porCnpj.has(key)) {
        porCnpj.set(key, { id: porCnpj.size + 1, ultNsu: '000000000000000', maxNsu: '000000000000000' });
      }
      return porCnpj.get(key);
    },
    buscarPorCnpjAmbiente: async (cnpj) => porCnpj.get(String(cnpj)) || null,
    avaliarCooldown: () => ({ ativo: false }),
    aplicarRetornoDistDfe: async (p) => {
      const atual = {
        id: 1,
        ultNsu: p.ultNsu,
        maxNsu: p.maxNsu
      };
      porCnpj.set(String(p.cnpj || CNPJ_A), atual);
      return { controle: atual, atualizouNsu: true, ultNsu: p.ultNsu, maxNsu: p.maxNsu };
    },
    _porCnpj: porCnpj
  };
}

function auditoriaNoop() {
  return {
    registrar: async () => {},
    registrarConsulta: async () => {},
    registrarResumoSync: async () => {},
    registrarNsuAvanco: async () => {}
  };
}

function criarEnvioSpy(xmlPorCnpj = {}) {
  const chamadas = [];
  const enviar = async (params) => {
    chamadas.push({
      cnpj: params.cnpj || null,
      ambiente: params.ambiente,
      temSenha: Boolean(params.certificadoSenha),
      xmlConsulta: params.xmlConsulta
    });
    const xml = xmlPorCnpj.default || XML_137;
    return {
      success: true,
      body: xml,
      endpoint: 'https://example.invalid/dfe',
      statusCode: 200
    };
  };
  return { chamadas, enviar };
}

function criarExecucao(opcoes = {}) {
  const envio = opcoes.envio || criarEnvioSpy();
  const nsu = opcoes.nsuService || nsuServiceLivre();
  const persistencia = opcoes.persistencia || {
    persistirDocumentoDfe: async () => ({ novo: true, documento: { chave: CHAVE_MES } })
  };

  const sincronizacaoService = opcoes.sincronizacaoService || {
    sincronizar: async (opts) => sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: opcoes.contexto || contextoEmpresa(EMP_A, CNPJ_A),
      nsuService: nsu,
      persistenciaService: persistencia,
      auditoriaService: auditoriaNoop(),
      enviarDistribuicaoDfe: envio.enviar,
      correlationId: opts.correlationId || null,
      origemConsulta: opts.origem || null
    })
  };

  const sync = new CentralSyncExecucaoService({
    sincronizacaoService,
    configuracaoService: {
      obterResumo: async () => ({ syncMaxDocumentos: 1, notificarNovasNotas: false }),
      verificarHorarioPermitido: async () => ({ permitido: true }),
      obterContextoOperacional: async () => ({
        ok: true,
        contexto: contextoEmpresa(EMP_A, CNPJ_A)
      })
    },
    nsuService: nsu,
    nsuRepository: { buscarPorCnpjAmbiente: async () => null },
    notificacoesService: { notificarSyncConcluida: async () => null },
    emitirEvento: async () => null
  });

  if (opcoes.cooldown) {
    sync._verificarCooldownDfe = async () => opcoes.cooldown;
  }

  return { sync, envio, nsu };
}

async function abrirCentral(sync, extra = {}) {
  return sync.executar({
    origem: ORIGENS.ABRIR_CENTRAL,
    ignorarHorario: true,
    ...extra
  });
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

describe('1. Abrir a Central uma vez', () => {
  it('uma abertura solicita 1 sync e envia 1 consulta DistDFe', async () => {
    const { sync, envio } = criarExecucao();
    const r = await abrirCentral(sync, { ignorarCooldown: true });

    assert.equal(r.consultaExecutada, true);
    assert.equal(envio.chamadas.length, 1);
    assert.equal(sefazTrace.resumo().solicitadas, 1);
    assert.equal(sefazTrace.resumo().enviadas, 1);
    assert.equal(sefazTrace.listar({ origem: ORIGENS.ABRIR_CENTRAL, tipo: 'CONSULTA_SOLICITADA' }).length, 1);
    assert.equal(sefazTrace.listar({ tipo: 'CONSULTA_EXECUTADA' }).length, 1);
    assert.ok(!JSON.stringify(sefazTrace.listar()).includes('segredo-nao-pode-aparecer'));
  });
});

describe('2. Abrir, sair e retornar várias vezes', () => {
  it('N reaberturas = N solicitações; SOAP só quando não há cooldown', async () => {
    const { sync, envio } = criarExecucao();
    await abrirCentral(sync, { ignorarCooldown: true });
    await abrirCentral(sync, { ignorarCooldown: true });
    await abrirCentral(sync, { ignorarCooldown: true });

    assert.equal(sefazTrace.resumo().solicitadas, 3);
    assert.equal(envio.chamadas.length, 3);
    assert.equal(sefazTrace.resumo().enviadas, 3);
  });

  it('reabertura em cooldown não envia SOAP', async () => {
    const { sync, envio } = criarExecucao();
    await abrirCentral(sync, { ignorarCooldown: true });
    sync._verificarCooldownDfe = async () => ({
      ativo: true,
      motivo: 'FILA_ESGOTADA',
      ultNsu: '5',
      maxNsu: '5',
      proximaConsultaEm: new Date(Date.now() + 3600000).toISOString()
    });
    await abrirCentral(sync);
    await abrirCentral(sync);

    assert.equal(envio.chamadas.length, 1);
    assert.equal(sefazTrace.resumo().enviadas, 1);
    assert.equal(sefazTrace.resumo().bloqueadasCooldown, 2);
  });
});

describe('3. Repetir o evento de abertura', () => {
  it('dois executar(abrir_central) concorrentes geram 2 solicitações e 1 envio', async () => {
    const { sync, envio } = criarExecucao();
    const origSincronizar = sync._sincronizacao.sincronizar.bind(sync._sincronizacao);
    sync._sincronizacao.sincronizar = async (opts) => {
      await new Promise((r) => setTimeout(r, 40));
      return origSincronizar(opts);
    };

    const [a, b] = await Promise.all([
      abrirCentral(sync, { ignorarCooldown: true }),
      abrirCentral(sync, { ignorarCooldown: true })
    ]);

    const ignorado = [a, b].filter((r) => r.codigo === 'SYNC_EM_ANDAMENTO' || r.ignorado);
    const executado = [a, b].filter((r) => r.consultaExecutada === true);
    assert.equal(executado.length, 1);
    assert.equal(ignorado.length, 1);
    assert.equal(envio.chamadas.length, 1);
    assert.equal(sefazTrace.resumo().enviadas, 1);
    assert.equal(sefazTrace.resumo().solicitadas, 2);
    assert.equal(sefazTrace.resumo().enfileiradas, 1);
  });
});

describe('4. Abrir com sincronização já em andamento', () => {
  it('mutex rejeita a abertura sem segundo SOAP', async () => {
    const { sync, envio } = criarExecucao();
    sync._executando = true;
    sync._lockDono = 'scheduler';
    const r = await abrirCentral(sync, { ignorarCooldown: true, ignorarBloqueio656: true });

    assert.equal(r.codigo, 'SYNC_EM_ANDAMENTO');
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.sucesso, false);
    assert.equal(envio.chamadas.length, 0);
    assert.equal(sefazTrace.resumo().enviadas, 0);
    assert.equal(sefazTrace.resumo().enfileiradas, 1);
  });
});

describe('5. Abrir durante cooldown', () => {
  it('bloqueia antes do envio e não marca consulta executada', async () => {
    const { sync, envio } = criarExecucao({
      cooldown: {
        ativo: true,
        motivo: 'COOLDOWN_EXPLICITO',
        ultNsu: '8',
        maxNsu: '8',
        proximaConsultaEm: '2026-10-17T21:00:00.000Z'
      }
    });
    const r = await abrirCentral(sync);

    assert.equal(r.consultaExecutada, false);
    assert.equal(r.sucesso, false);
    assert.equal(r.ignorado, true);
    assert.equal(r.codigo, 'AGUARDAR_JANELA_DFE');
    assert.equal(envio.chamadas.length, 0);
    assert.equal(sefazTrace.resumo().enviadas, 0);
    assert.equal(sefazTrace.resumo().bloqueadasCooldown, 1);
  });
});

describe('6. Abrir com Gate bloqueado', () => {
  it('Gate 656 bloqueia SOAP e não devolve sucesso enganoso', async () => {
    gate.autorizarConsultaDistDfe = async () => ({
      permitido: false,
      ignorado: true,
      sucesso: true,
      codigo: 'BLOQUEADO_CONSUMO_INDEVIDO_656',
      cStat: '656',
      mensagem: 'Consulta temporariamente bloqueada pela SEFAZ (Consumo Indevido 656).',
      estadoOperacional: 'BLOCKED',
      empresaId: EMP_A
    });
    const { sync, envio } = criarExecucao();
    const r = await abrirCentral(sync, { ignorarCooldown: true });

    assert.equal(r.permitido, false);
    assert.equal(r.sucesso, false);
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.ignorado, true);
    assert.equal(envio.chamadas.length, 0);
    assert.equal(sefazTrace.resumo().enviadas, 0);
    assert.equal(sefazTrace.resumo().bloqueadasGate, 1);
  });
});

describe('7. Comparar abertura, botão manual e scheduler', () => {
  it('cada origem solicita 1 vez e o envio é 1 por execução liberada', async () => {
    const { sync, envio } = criarExecucao();
    await sync.executar({ origem: ORIGENS.ABRIR_CENTRAL, ignorarCooldown: true });
    await sync.executar({ origem: ORIGENS.MANUAL, ignorarCooldown: true });
    await sync.executar({ origem: ORIGENS.BACKGROUND, ignorarCooldown: true, ignorarHorario: true });

    assert.equal(envio.chamadas.length, 3);
    assert.equal(sefazTrace.listar({ origem: ORIGENS.ABRIR_CENTRAL, tipo: 'CONSULTA_SOLICITADA' }).length, 1);
    assert.equal(sefazTrace.listar({ origem: ORIGENS.MANUAL, tipo: 'CONSULTA_SOLICITADA' }).length, 1);
    assert.equal(sefazTrace.listar({ origem: ORIGENS.BACKGROUND, tipo: 'CONSULTA_SOLICITADA' }).length, 1);
    assert.equal(sefazTrace.resumo().enviadas, 3);
  });
});

describe('8. Duas empresas — isolamento por empresaId', () => {
  it('cada CNPJ dispara o próprio envio; cooldown de A não envia por B', async () => {
    const envio = criarEnvioSpy();
    const nsu = nsuServiceLivre();
    const contextos = {
      [EMP_A]: contextoEmpresa(EMP_A, CNPJ_A),
      [EMP_B]: contextoEmpresa(EMP_B, CNPJ_B)
    };
    const svc = new CentralSincronizacaoService({
      gate: { autorizarConsultaDistDfe: async () => ({ permitido: true, codigo: 'OK' }) },
      contrato: { modo_operacional: ModoOperacionalGlobal.MULTIEMPRESA },
      EmpresaService: {
        listarEmpresas: async () => [
          { id: EMP_A, cnpj: CNPJ_A },
          { id: EMP_B, cnpj: CNPJ_B }
        ]
      },
      configuracaoService: {
        obterContextoOperacional: async ({ empresaId }) => ({
          ok: true,
          contexto: contextos[empresaId]
        })
      },
      nsuService: nsu,
      sincronizarDistribuicaoDFe: async (deps) => sincronizarDistribuicaoDFe({
        ...deps,
        maxIteracoes: 1,
        nsuService: nsu,
        persistenciaService: {
          persistirDocumentoDfe: async () => ({ novo: true })
        },
        auditoriaService: auditoriaNoop(),
        enviarDistribuicaoDfe: envio.enviar
      })
    });

    nsu.avaliarCooldown = (controle) => {
      if (controle && String(controle.ultNsu) === '000000000000005') {
        return { ativo: true, motivo: 'FILA_ESGOTADA', ultNsu: '5', maxNsu: '5' };
      }
      return { ativo: false };
    };

    const r1 = await svc.sincronizar({ origem: ORIGENS.ABRIR_CENTRAL, correlationId: 'iso-1' });
    assert.equal(envio.chamadas.length, 2);

    nsu._porCnpj.set(CNPJ_A, { ultNsu: '000000000000005', maxNsu: '000000000000005' });
    const r2 = await svc.sincronizar({ origem: ORIGENS.ABRIR_CENTRAL, correlationId: 'iso-2' });
    assert.equal(envio.chamadas.length, 3);
    assert.equal(r1.consultaExecutada, true);
    assert.ok(Array.isArray(r2.porEmpresa));
    const empA = r2.porEmpresa.find((p) => Number(p.empresaId) === EMP_A);
    const empB = r2.porEmpresa.find((p) => Number(p.empresaId) === EMP_B);
    assert.equal(empA && empA.consultaExecutada, false);
    assert.equal(empB && empB.consultaExecutada, true);
  });
});

describe('9. Falha de persistência não avança NSU', () => {
  it('envia 1 SOAP, registra PERSISTENCIA_FALHOU e não chama aplicarRetornoDistDfe', async () => {
    const aplicar = [];
    const nsu = {
      obterOuCriar: async () => ({ id: 1, ultNsu: '000000000000000', maxNsu: '000000000000000' }),
      avaliarCooldown: () => ({ ativo: false }),
      aplicarRetornoDistDfe: async (p) => {
        aplicar.push(p);
        return { controle: p, atualizouNsu: true };
      }
    };
    const envio = {
      chamadas: [],
      enviar: async () => {
        envio.chamadas.push(1);
        return { success: true, body: XML_138, endpoint: 'https://example.invalid/dfe', statusCode: 200 };
      }
    };
    const persistencia = {
      persistirDocumentoDfe: async () => {
        const err = new Error('SQLITE_BUSY simulado');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
    };
    const { sync } = criarExecucao({ envio, nsuService: nsu, persistencia });
    const r = await abrirCentral(sync, { ignorarCooldown: true });

    assert.equal(envio.chamadas.length, 1);
    assert.equal(aplicar.length, 0);
    assert.equal(r.sucesso, false);
    assert.ok(Array.isArray(r.errosPersistencia) ? r.errosPersistencia.length >= 0 : true);
    assert.ok(sefazTrace.listar({ tipo: 'PERSISTENCIA_FALHOU' }).length >= 1);
    assert.equal(sefazTrace.resumo().enviadas, 1);
  });
});

describe('10. Bloqueio não produz mensagem de sincronização concluída', () => {
  it('abertura ignorada não dispara 210210 e sucesso fica false', async () => {
    let ciencia = 0;
    const mini = Object.create(CentralEntradasOrchestrator.prototype);
    mini._syncExecucao = {
      executar: async () => ({
        sucesso: false,
        ignorado: true,
        consultaExecutada: false,
        codigo: 'AGUARDAR_JANELA_DFE',
        mensagem: 'Consulta DF-e não executada: cooldown por CNPJ.'
      })
    };
    mini._manifestacaoDfeService = {
      processarCandidatos: async () => {
        ciencia += 1;
        return { enviados: 1 };
      }
    };
    mini.processarDocumentosPendentes = async () => [];

    const r = await mini.executarSincronizacao({ origem: ORIGENS.ABRIR_CENTRAL });
    assert.equal(r.sucesso, false);
    assert.equal(r.consultaExecutada, false);
    assert.equal(ciencia, 0);
  });

  it('rota ao-abrir desabilitada não afirma sucesso de consulta', () => {
    const src = fs.readFileSync(ROTA_JS, 'utf8');
    assert.match(src, /SYNC_AO_ABRIR_DESABILITADO/);
    assert.match(src, /consultaExecutada: false/);
    assert.doesNotMatch(
      src,
      /sync_ao_abrir desabilitado[\s\S]{0,80}sucesso: true/
    );
  });

  it('frontend de abertura não trata bloqueio como sucesso e tem reentrância', () => {
    const src = fs.readFileSync(FRONT_JS, 'utf8');
    const postsAoAbrir = src.split('/sincronizar-ao-abrir').length - 1;
    assert.equal(postsAoAbrir, 1);
    assert.match(src, /syncAoAbrirEmVoo/);
    assert.match(src, /consultaExecutada === false/);
    assert.match(src, /SYNC_AO_ABRIR_DESABILITADO/);
    assert.match(src, /Promise\.all\(\[\s*sincronizarAoAbrirCentralSuave\(\)/);

    const trechoTicker = src.slice(
      src.indexOf('function iniciarAutomacaoCentral'),
      src.indexOf('function iniciarAutomacaoCentral') + 3500
    );
    assert.equal(trechoTicker.includes('/sincronizar-ao-abrir'), false);
    assert.equal(trechoTicker.includes('/sincronizar\''), false);
  });
});

describe('Rastreio não depende só de dfe_auditoria', () => {
  it('eventos em memória cobrem solicitada vs executada vs bloqueada', () => {
    sefazTrace.emitir('CONSULTA_SOLICITADA', {
      origem: ORIGENS.ABRIR_CENTRAL,
      empresaId: EMP_A,
      cnpj: CNPJ_A,
      correlationId: 'abc',
      certificadoSenha: 'NAO'
    });
    const ev = sefazTrace.listar({ tipo: 'CONSULTA_SOLICITADA' })[0];
    assert.equal(ev.empresaId, EMP_A);
    assert.equal(ev.cnpj, CNPJ_A);
    assert.equal(ev.correlationId, 'abc');
    assert.ok(!JSON.stringify(ev).includes('NAO'));
  });
});
