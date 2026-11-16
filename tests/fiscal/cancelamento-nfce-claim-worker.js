'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const dns = require('dns');
const sqlite3 = require('sqlite3').verbose();

const bloquearRede = () => {
  throw new Error('Rede bloqueada pelo worker isolado de concorrência.');
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
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveCname',
  'resolveMx',
  'resolveNs',
  'resolveTxt',
  'reverse'
].forEach((method) => { dns[method] = bloquearRede; });
global.fetch = bloquearRede;
global.WebSocket = bloquearRede;

const [databasePath, barrierPath, sendLogPath, workerId] = process.argv.slice(2);
const officialDatabase = path.win32.resolve(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'MercantilFiscal',
  'dados',
  'mercadao.db'
);
assert.ok(databasePath && barrierPath && sendLogPath && workerId);
assert.notStrictEqual(
  path.win32.resolve(databasePath).toLowerCase(),
  officialDatabase.toLowerCase()
);
assert.strictEqual(typeof process.env.TEST_CERT_PEM, 'string');
assert.strictEqual(require.cache[require.resolve('../../backend/database')], undefined);

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

async function waitForBarrier() {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(barrierPath)) {
    if (Date.now() >= deadline) throw new Error('Barreira concorrente excedeu o timeout.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function main() {
  const db = await openDatabase(databasePath);
  await run(db, 'PRAGMA busy_timeout = 5000');
  await waitForBarrier();

  let sent = false;
  let code = null;
  try {
    await require('../../backend/services/fiscal/cancelarNfce')(
      1,
      'Cancelamento concorrente em teste isolado',
      {
        db,
        empresaIdContexto: 7,
        getFiscalConfig: async () => ({
          fonte: 'EMPRESA',
          empresaId: 7,
          ambiente: 2,
          codigoUf: '23',
          cnpj: '12345678000195',
          tokenCSC: 'token-sintetico',
          idCSC: '1',
          certificadoPath: 'certificado-sintetico',
          certificadoSenha: 'senha-sintetica'
        }),
        exigirCertificadoAptoParaUsoFiscal: async () => ({
          certificadoPath: 'certificado-sintetico',
          certificadoSenha: 'senha-sintetica'
        }),
        carregarCertificadoPfx: () => ({
          privateKeyPem: 'chave-sintetica',
          certPem: process.env.TEST_CERT_PEM
        }),
        assinarEvento: () => ({ xmlAssinado: '<evento-sintetico />' }),
        autorizacaoTransmissaoSefaz: require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz')
          .criarAutorizacaoCancelamentoOperador({ empresaId: 7, usuarioId: 1 }),
        enviarCancelamento: async () => {
          sent = true;
          fs.appendFileSync(sendLogPath, `${workerId}\n`);
          await new Promise((resolve) => setTimeout(resolve, 600));
          return {
            success: false,
            transmissionState: 'UNKNOWN',
            error: 'Timeout ambíguo de teste'
          };
        }
      }
    );
    throw new Error('Resultado desconhecido não foi lançado pelo serviço.');
  } catch (error) {
    code = error.code || 'ERRO_SEM_CODIGO';
    if (sent && code !== 'CANCELAMENTO_RESULTADO_DESCONHECIDO') throw error;
    if (!sent && ![
      'CANCELAMENTO_EM_ANDAMENTO',
      'CANCELAMENTO_RESULTADO_DESCONHECIDO'
    ].includes(code)) {
      throw error;
    }
  } finally {
    await new Promise((resolve, reject) => {
      db.close((error) => (error ? reject(error) : resolve()));
    });
  }

  process.stdout.write(`WORKER_RESULT:${JSON.stringify({ workerId, sent, code })}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
