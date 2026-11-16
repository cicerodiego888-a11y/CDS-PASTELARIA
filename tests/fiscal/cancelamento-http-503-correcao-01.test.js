'use strict';

/**
 * CDS-FISCAL-CORRECAO-HTTP-503-CANCELAMENTO-NOTA-01
 * Banco temporário + mocks. Rede e SEFAZ bloqueadas.
 */

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
isolarBancoTeste('cds-fiscal-canc-503-');

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const dns = require('dns');
const childProcess = require('child_process');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const forge = require('node-forge');

const bloquearRede = () => {
  throw new Error('Rede bloqueada pelo harness 503-cancelamento.');
};
http.request = bloquearRede;
https.request = bloquearRede;
http2.connect = bloquearRede;
net.connect = bloquearRede;
net.createConnection = bloquearRede;
net.Socket.prototype.connect = bloquearRede;
tls.connect = bloquearRede;
dgram.createSocket = bloquearRede;
[
  'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6',
  'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'reverse'
].forEach((method) => { dns[method] = bloquearRede; });
[
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'
].forEach((method) => { childProcess[method] = bloquearRede; });
global.fetch = bloquearRede;
global.WebSocket = bloquearRede;

const cancelarNfce = require('../../backend/services/fiscal/cancelarNfce');
const {
  criarAutorizacaoTesteIsolado,
  criarAutorizacaoCancelamentoOperador
} = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');

const CHAVE = '23260112345678000195650010000000011000000001';
const PROTOCOLO = '123456789012345';
const EMPRESA_ID = 7;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nfce-canc-503-'));
const DATABASE_OFICIAL = path.win32.resolve(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'MercantilFiscal',
  'dados',
  'mercadao.db'
);

function certificadoTeste(cnpj) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 512, workers: -1 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date('2025-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2035-01-01T00:00:00Z');
  certificate.setSubject(cnpj
    ? [{ type: '2.16.76.1.3.3', value: cnpj }]
    : [{ name: 'commonName', value: 'Certificado sem CNPJ' }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(keys.privateKey);
  return forge.pki.certificateToPem(certificate);
}
const CERTIFICADO_TESTE_PEM = certificadoTeste('12345678000195');

let passou = 0;
let falhou = 0;

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row || null)));
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

function retorno(cStat, xMotivo = 'Evento registrado') {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">',
    '<soap:Body><nfeRecepcaoEventoNFResult>',
    `<retEnvEvento><retEvento><infEvento>`,
    `<tpEvento>110111</tpEvento><chNFe>${CHAVE}</chNFe>`,
    `<cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>`,
    `<nProt>999999999999999</nProt>`,
    `</infEvento></retEvento></retEnvEvento>`,
    '</nfeRecepcaoEventoNFResult></soap:Body></soap:Envelope>'
  ].join('');
}

async function abrirBanco(statusNota = 'autorizada', extras = {}) {
  const filename = extras.filename || ':memory:';
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(filename, (error) => {
      if (error) reject(error);
      else resolve(connection);
    });
  });
  assert.notStrictEqual(
    path.win32.resolve(db.filename || filename).toLowerCase(),
    DATABASE_OFICIAL.toLowerCase(),
    'O harness não pode resolver para o banco oficial.'
  );
  await run(db, 'PRAGMA busy_timeout = 5000');
  await run(db, 'CREATE TABLE vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER)');
  await run(db, `CREATE TABLE nfce_notas (
    id INTEGER PRIMARY KEY,
    venda_id INTEGER NOT NULL,
    chave_acesso TEXT,
    protocolo TEXT,
    ambiente INTEGER,
    status TEXT,
    empresa_id INTEGER,
    xml_retorno TEXT,
    updated_at TEXT
  )`);
  await run(db, 'INSERT INTO vendas (id, empresa_id) VALUES (1, ?)', [EMPRESA_ID]);
  const chave = extras.chave === null ? null : (extras.chave || CHAVE);
  const protocolo = extras.protocolo === null ? null : (extras.protocolo || PROTOCOLO);
  const xml = extras.xml_retorno != null
    ? extras.xml_retorno
    : (chave && protocolo
      ? `<protNFe><infProt><chNFe>${chave}</chNFe><nProt>${protocolo}</nProt><cStat>100</cStat></infProt></protNFe>`
      : null);
  await run(db, `INSERT INTO nfce_notas
    (id, venda_id, chave_acesso, protocolo, ambiente, status, empresa_id, xml_retorno, updated_at)
    VALUES (10, 1, ?, ?, 2, ?, ?, ?, datetime('now','localtime'))`,
  [chave, protocolo, statusNota, EMPRESA_ID, xml]);
  return db;
}

function opcoes(db, enviarCancelamento, overrides = {}) {
  const config = {
    fonte: 'EMPRESA',
    empresaId: EMPRESA_ID,
    ambiente: 2,
    codigoUf: '23',
    cnpj: '12345678000195',
    tokenCSC: 'csc-falso',
    idCSC: '1',
    certificadoPath: 'certificado-falso.pfx',
    certificadoSenha: 'senha-falsa',
    ...(overrides.config || {})
  };
  const auth = Object.prototype.hasOwnProperty.call(overrides, 'autorizacaoTransmissaoSefaz')
    ? overrides.autorizacaoTransmissaoSefaz
    : criarAutorizacaoCancelamentoOperador({ empresaId: EMPRESA_ID, usuarioId: 1 });
  return {
    db,
    getFiscalConfig: overrides.getFiscalConfig || (async () => ({ ...config })),
    exigirCertificadoAptoParaUsoFiscal: overrides.exigirCertificadoAptoParaUsoFiscal || (async () => ({
      certificadoPath: config.certificadoPath,
      certificadoSenha: config.certificadoSenha
    })),
    carregarCertificadoPfx: overrides.carregarCertificadoPfx || (() => ({
      privateKeyPem: 'chave-falsa',
      certPem: overrides.certPem || CERTIFICADO_TESTE_PEM
    })),
    assinarEvento: () => ({ xmlAssinado: '<evento-assinado-falso />' }),
    enviarCancelamento,
    autorizacaoTransmissaoSefaz: auth,
    ...overrides.extra
  };
}

async function expectReject(promise, { code, statusCode }) {
  await assert.rejects(promise, (error) => {
    if (code) assert.strictEqual(error.code, code, `${error.code}: ${error.message}`);
    if (statusCode != null) {
      assert.strictEqual(error.statusCode, statusCode, `HTTP ${error.statusCode} != ${statusCode}`);
    }
    return true;
  });
}

async function test(nome, fn) {
  try {
    await fn();
    passou += 1;
    console.log(`  OK  ${nome}`);
  } catch (error) {
    falhou += 1;
    console.error(`  FALHOU  ${nome}`);
    console.error(`         ${error.stack || error.message}`);
  }
}

async function main() {
  console.log('\nCDS-FISCAL-CORRECAO-HTTP-503-CANCELAMENTO-NOTA-01\n');

  await test('A — nota elegível cancela com mock SEFAZ (ambiente simulado)', async () => {
    const db = await abrirBanco();
    try {
      const result = await cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({
        success: true,
        body: retorno('135', 'Evento registrado'),
        transmissionState: 'RESPONSE_RECEIVED'
      })));
      assert.strictEqual(result.status, 'cancelada');
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'cancelada'
      );
    } finally {
      await close(db);
    }
  });

  await test('B — serviço fiscal indisponível (NOT_SENT) → 503, estado retryable', async () => {
    const db = await abrirBanco();
    try {
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({
          success: false,
          transmissionState: 'NOT_SENT',
          error: 'Conexão recusada pelo provedor fiscal'
        }))),
        { code: 'CANCELAMENTO_FALHA_PRE_ENVIO', statusCode: 503 }
      );
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'cancelamento_falha_pre_envio'
      );
    } finally {
      await close(db);
    }
  });

  await test('C — certificado ausente/inválido → HTTP coerente, sem claim', async () => {
    const db = await abrirBanco();
    let sends = 0;
    try {
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
          sends += 1;
          return { success: true, body: retorno('135'), transmissionState: 'RESPONSE_RECEIVED' };
        }, {
          exigirCertificadoAptoParaUsoFiscal: async () => {
            const err = new Error('Certificado digital A1 não configurado para a empresa.');
            err.code = 'CERTIFICADO_ARQUIVO_OBRIGATORIO';
            err.statusCode = 409;
            throw err;
          }
        })),
        { code: 'CERTIFICADO_ARQUIVO_OBRIGATORIO', statusCode: 409 }
      );
      assert.strictEqual(sends, 0);
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'autorizada'
      );
    } finally {
      await close(db);
    }
  });

  await test('D — configuração fiscal incompleta → 400, sem mutação', async () => {
    const db = await abrirBanco();
    let sends = 0;
    try {
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
          sends += 1;
        }, {
          getFiscalConfig: async () => {
            const err = new Error('Configuração fiscal da empresa incompleta.');
            err.code = 'CONFIG_FISCAL_INCOMPLETA';
            err.statusCode = 400;
            throw err;
          }
        })),
        { code: 'CONFIG_FISCAL_INCOMPLETA', statusCode: 400 }
      );
      assert.strictEqual(sends, 0);
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'autorizada'
      );
    } finally {
      await close(db);
    }
  });

  await test('E — nota sem autorização fiscal (sem chave/protocolo) → 409', async () => {
    const db = await abrirBanco('autorizada', {
      chave: null,
      protocolo: null,
      xml_retorno: '<protNFe><infProt><cStat>100</cStat></infProt></protNFe>'
    });
    let sends = 0;
    try {
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
          sends += 1;
        })),
        { code: 'CANCELAMENTO_SEM_AUTORIZACAO_FISCAL', statusCode: 409 }
      );
      assert.strictEqual(sends, 0);
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'autorizada'
      );
    } finally {
      await close(db);
    }
  });

  await test('F — nota já cancelada → 409, sem envio', async () => {
    const db = await abrirBanco('cancelada');
    let sends = 0;
    try {
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
          sends += 1;
        })),
        { code: 'CANCELAMENTO_NOTA_NAO_ELEGIVEL', statusCode: 409 }
      );
      assert.strictEqual(sends, 0);
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'cancelada'
      );
    } finally {
      await close(db);
    }
  });

  await test('G — falha de comunicação SEFAZ (throw NOT_SENT) → 503 com mensagem clara', async () => {
    const db = await abrirBanco();
    try {
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
          const err = new Error('Timeout de conexão com a SEFAZ antes do envio');
          err.transmissionState = 'NOT_SENT';
          err.code = 'SEFAZ_TRANSPORT_UNAVAILABLE';
          throw err;
        })),
        { code: 'CANCELAMENTO_FALHA_PRE_ENVIO', statusCode: 503 }
      );
      const row = await get(db, 'SELECT status FROM nfce_notas WHERE id = 10');
      assert.strictEqual(row.status, 'cancelamento_falha_pre_envio');
    } finally {
      await close(db);
    }
  });

  await test('H — erro interno inesperado após claim → 202 desconhecido (não 503)', async () => {
    const db = await abrirBanco();
    try {
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
          throw new Error('Falha interna inesperada no transporte');
        })),
        { code: 'CANCELAMENTO_RESULTADO_DESCONHECIDO', statusCode: 202 }
      );
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'cancelamento_desconhecido'
      );
    } finally {
      await close(db);
    }
  });

  await test('I — duplo clique / concorrência: segundo pedido recebe 409 EM_ANDAMENTO', async () => {
    const db = await abrirBanco();
    let releaseSend;
    const gate = new Promise((resolve) => { releaseSend = resolve; });
    let sends = 0;
    try {
      const first = cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
        sends += 1;
        await gate;
        return {
          success: true,
          body: retorno('135', 'Evento registrado'),
          transmissionState: 'RESPONSE_RECEIVED'
        };
      }));
      await new Promise((r) => setTimeout(r, 40));
      await expectReject(
        cancelarNfce(1, 'Segundo clique simultâneo', opcoes(db, async () => {
          sends += 1;
          return { success: true, body: retorno('135'), transmissionState: 'RESPONSE_RECEIVED' };
        })),
        { code: 'CANCELAMENTO_EM_ANDAMENTO', statusCode: 409 }
      );
      releaseSend();
      await first;
      assert.strictEqual(sends, 1);
    } finally {
      await close(db);
    }
  });

  await test('J — bloqueio de autorização NÃO altera situação e NÃO retorna 503', async () => {
    const db = await abrirBanco();
    let sends = 0;
    try {
      // Sem enviarCancelamento injetado: usa runtime real → barreira de auth antes do claim.
      // Forçamos sender real mockando apenas via ausência de mock + auth nula:
      // aqui simulamos retorno bloqueadoAutorizacao do sender (pós-claim path) e
      // também o path pré-claim sem sender (abaixo).
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
          sends += 1;
          return {
            success: false,
            bloqueadoAutorizacao: true,
            codigo: 'TRANSMISSAO_SEFAZ_NAO_AUTORIZADA',
            code: 'TRANSMISSAO_SEFAZ_NAO_AUTORIZADA',
            error: 'Transmissão SEFAZ não autorizada. O cancelamento não foi executado.',
            statusCode: 403,
            transmissionState: 'NOT_SENT'
          };
        })),
        { code: 'TRANSMISSAO_SEFAZ_NAO_AUTORIZADA', statusCode: 403 }
      );
      assert.strictEqual(sends, 1);
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'autorizada',
        'Falha de autorização não pode deixar a nota em falha_pre_envio'
      );
    } finally {
      await close(db);
    }
  });

  await test('J2 — sem autorização → 403 com mensagem de cancelamento (não consulta)', async () => {
    const db = await abrirBanco();
    try {
      await expectReject(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({
          success: true,
          body: retorno('135'),
          transmissionState: 'RESPONSE_RECEIVED'
        }), { autorizacaoTransmissaoSefaz: null })),
        { code: 'TRANSMISSAO_SEFAZ_NAO_AUTORIZADA', statusCode: 403 }
      );
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'autorizada'
      );
    } finally {
      await close(db);
    }
  });

  await test('J2b — mensagem de bloqueio fala em cancelamento, não em consulta', async () => {
    const db = await abrirBanco();
    try {
      await assert.rejects(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({}), {
          autorizacaoTransmissaoSefaz: null
        })),
        (error) => {
          assert.match(error.message, /cancelamento não foi executado/i);
          assert.doesNotMatch(error.message, /consulta não foi executada/i);
          return true;
        }
      );
    } finally {
      await close(db);
    }
  });

  await test('J3 — autorização CANCELAMENTO_OPERADOR libera preflight (mock envia)', async () => {
    const db = await abrirBanco();
    try {
      const auth = criarAutorizacaoCancelamentoOperador({
        empresaId: EMPRESA_ID,
        usuarioId: 99
      });
      assert.strictEqual(auth.modo, 'CANCELAMENTO_OPERADOR');
      const result = await cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({
        success: true,
        body: retorno('135'),
        transmissionState: 'RESPONSE_RECEIVED'
      }), { autorizacaoTransmissaoSefaz: auth }));
      assert.strictEqual(result.status, 'cancelada');
    } finally {
      await close(db);
    }
  });

  await test('J3b — autorização de teste isolado com 110111 também libera', async () => {
    const db = await abrirBanco();
    try {
      const auth = criarAutorizacaoTesteIsolado({
        empresaId: EMPRESA_ID,
        tipoConsulta: '110111'
      });
      const result = await cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({
        success: true,
        body: retorno('135'),
        transmissionState: 'RESPONSE_RECEIVED'
      }), { autorizacaoTransmissaoSefaz: auth }));
      assert.strictEqual(result.status, 'cancelada');
    } finally {
      await close(db);
    }
  });

  await test('Frontend: guarda de duplo clique e mensagem com code presentes', async () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/fiscal.js'),
      'utf8'
    );
    assert.match(src, /cancelamentoEmVoo/);
    assert.match(src, /mensagemErroCancelamento/);
    assert.match(src, /liberarBotaoCancelamento/);
    assert.match(src, /resp\.code/);
  });

  await test('Rota fiscal: status transmissao_nao_autorizada e bloqueadoAutorizacao', async () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/rotas/fiscal.js'),
      'utf8'
    );
    assert.match(src, /transmissao_nao_autorizada/);
    assert.match(src, /bloqueadoAutorizacao/);
  });

  console.log(`\nBanco temporário: ${TMP_DIR}`);
  console.log('Rede/SEFAZ: bloqueadas no harness.');
  console.log(`Resultado: ${passou} aprovados, ${falhou} falhos.`);
  if (falhou) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
