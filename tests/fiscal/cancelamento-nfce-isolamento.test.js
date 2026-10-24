'use strict';

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
isolarBancoTeste('cds-fiscal-canc-iso-');

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
const spawnProcess = childProcess.spawn;
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const forge = require('node-forge');

const bloquearRede = () => {
  throw new Error('Rede bloqueada pelo harness isolado de cancelamento NFC-e.');
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
[
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork'
].forEach((method) => { childProcess[method] = bloquearRede; });
global.fetch = bloquearRede;
global.WebSocket = bloquearRede;

const cancelarNfce = require('../../backend/services/fiscal/cancelarNfce');
const { extrairCnpjDoCertificadoPem } = require('../../backend/services/fiscal/certificateService');
const databaseModule = require.resolve('../../backend/database');
const CHAVE = '23260112345678000195650010000000011000000001';
const PROTOCOLO = '123456789012345';
const EMPRESA_ID = 7;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nfce-cancelamento-isolado-'));
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
const CERTIFICADO_DIVERGENTE_PEM = certificadoTeste('11222333000181');
const CERTIFICADO_SEM_CNPJ_PEM = certificadoTeste(null);
const DATABASE_OFICIAL = path.win32.resolve(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'MercantilFiscal',
  'dados',
  'mercadao.db'
);

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
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row || null);
    });
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

async function abrirBanco(filename = ':memory:') {
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
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
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
  await run(db, `
    INSERT INTO nfce_notas
      (id, venda_id, chave_acesso, protocolo, ambiente, status, empresa_id, xml_retorno)
    VALUES (10, 1, ?, ?, 2, 'autorizada', ?, ?)
  `, [
    CHAVE,
    PROTOCOLO,
    EMPRESA_ID,
    `<protNFe><infProt><chNFe>${CHAVE}</chNFe><cStat>100</cStat><nProt>${PROTOCOLO}</nProt></infProt></protNFe>`
  ]);
  return db;
}

function retorno(cStat, extra = '') {
  return `<retEnvEvento><cStat>128</cStat><retEvento><infEvento><tpEvento>110111</tpEvento><chNFe>${CHAVE}</chNFe><cStat>${cStat}</cStat><xMotivo>${extra || 'Resposta simulada'}</xMotivo><nProt>987654321012345</nProt></infEvento></retEvento></retEnvEvento>`;
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
  return {
    db,
    getFiscalConfig: async () => ({ ...config }),
    carregarCertificadoPfx: () => ({
      privateKeyPem: 'chave-falsa',
      certPem: overrides.certPem || CERTIFICADO_TESTE_PEM
    }),
    assinarEvento: () => ({ xmlAssinado: '<evento-assinado-falso />' }),
    enviarCancelamento
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.strictEqual(error.code, code, `${error.code || 'SEM_CODIGO'}: ${error.message}`);
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

async function testFluxoCancelamentoComercial(resultadoFiscalDesconhecido) {
  const root = path.resolve(__dirname, '../..');
  const vendaServicePath = path.join(root, 'backend/services/vendas/VendaCancelamentoService.js');
  const modules = new Map();
  const sideEffects = [];
  const mockDb = {
    get(_sql, _params, callback) {
      callback(null, {
        id: 1,
        empresa_id: EMPRESA_ID,
        status_pagamento: 'fiscal_pago',
        tef_transacao_id: 99,
        cancelada: 0
      });
    },
    serialize(callback) {
      callback();
    },
    all(_sql, _params, callback) {
      callback(null, [{ id: 1, venda_id: 1 }]);
    },
    run(sql, params, callback) {
      const done = typeof params === 'function' ? params : callback;
      if (/venda_recebimentos/i.test(sql)) sideEffects.push('recebimentos');
      if (/UPDATE vendas/i.test(sql)) sideEffects.push('venda');
      if (done) done.call({ changes: 1 }, null);
    }
  };
  const unknownError = Object.assign(
    new Error('Resultado fiscal desconhecido. Não tente reenviar.'),
    {
      code: 'CANCELAMENTO_RESULTADO_DESCONHECIDO',
      statusCode: 202,
      resultUnknown: true
    }
  );
  const mocks = {
    'backend/database.js': mockDb,
    'backend/services/auditoria.js': { gravarAuditoria: async () => {} },
    'backend/services/tef/ReversaoFiscal.js': {
      cancelarFiscal: async () => { sideEffects.push('tef'); }
    },
    'backend/services/vendas/VendaDevolucaoService.js': {
      devolverEstoqueItensVenda: (_itens, callback) => {
        sideEffects.push('estoque');
        callback(null);
      }
    },
    'backend/services/vendas/VendaFiscalService.js': {
      buscarNfceAutorizadaVenda(_vendaId, callback) {
        callback(null, { id: 10, status: 'autorizada' });
      },
      cancelarNfceAutorizadaVenda: async () => {
        sideEffects.push('fiscal');
        if (resultadoFiscalDesconhecido) throw unknownError;
        return { status: 'cancelada' };
      }
    },
    'backend/services/vendas/VendaFinanceiroService.js': {
      cancelarFinanceiroVenda: async () => { sideEffects.push('financeiro'); }
    },
    'backend/services/mpfc.js': { resolverPoliticaOperacionalDaVenda: () => ({}) },
    'backend/services/vendas/creditoEstoqueVendaViaPorta.js': {
      montarOpcoesRetornoEstoqueDaVenda: () => ({ empresaId: EMPRESA_ID })
    },
    'backend/services/produtos/FichaTecnicaConsumoService.js': {
      estornarConsumoFichaTecnicaDaVendaCb: (_args, callback) => {
        sideEffects.push('ficha_tecnica');
        callback(null);
      }
    },
    'backend/services/vendas/VendaEmpresaContextoService.js': {
      exigirOperacaoReversaoDaVenda: () => {},
      responderErroEmpresaVenda: () => {}
    },
    'backend/services/financeiro/FinanceiroEmpresaContextoService.js': {
      resolverEmpresaDaOrigemFinanceira: () => EMPRESA_ID
    }
  };

  Object.entries(mocks).forEach(([relativePath, exports]) => {
    const filename = path.join(root, relativePath);
    const previous = require.cache[filename];
    modules.set(filename, previous);
    require.cache[filename] = {
      id: filename,
      filename,
      loaded: true,
      exports
    };
  });

  let httpStatus = null;
  let responseBody = null;
  const response = {
    status(status) {
      httpStatus = status;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    const serviceModulePath = require.resolve(vendaServicePath);
    const previousService = require.cache[serviceModulePath];
    delete require.cache[serviceModulePath];
    const service = require(vendaServicePath);
    service.cancelarVendaPost(1, 'Cancelamento fiscal de teste seguro', { empresaId: EMPRESA_ID }, response);
    await new Promise((resolve) => setImmediate(resolve));
    if (resultadoFiscalDesconhecido) {
      assert.strictEqual(httpStatus, 202);
      assert.strictEqual(responseBody.resultUnknown, true);
      assert.deepStrictEqual(sideEffects, ['fiscal']);
    } else {
      assert.strictEqual(responseBody.sucesso, true);
      assert.ok(sideEffects.indexOf('fiscal') < sideEffects.indexOf('tef'));
      assert.ok(sideEffects.indexOf('tef') < sideEffects.indexOf('estoque'));
      assert.ok(sideEffects.indexOf('estoque') < sideEffects.indexOf('recebimentos'));
      assert.ok(sideEffects.indexOf('recebimentos') < sideEffects.indexOf('financeiro'));
    }
    if (previousService) require.cache[serviceModulePath] = previousService;
    else delete require.cache[serviceModulePath];
  } finally {
    modules.forEach((previous, filename) => {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    });
  }
}

async function main() {
  assert.strictEqual(
    require.cache[databaseModule],
    undefined,
    'Importar o serviço não deve carregar nem inicializar backend/database.js.'
  );

  await test('serviço importado sem abrir o inicializador do banco oficial', async () => {
    assert.strictEqual(require.cache[databaseModule], undefined);
  });
  await test('CNPJ é extraído da extensão de identidade do certificado de teste', async () => {
    assert.strictEqual(
      extrairCnpjDoCertificadoPem(CERTIFICADO_TESTE_PEM),
      '12345678000195'
    );
    assert.strictEqual(
      extrairCnpjDoCertificadoPem(CERTIFICADO_DIVERGENTE_PEM),
      '11222333000181'
    );
    assert.throws(
      () => extrairCnpjDoCertificadoPem(CERTIFICADO_SEM_CNPJ_PEM),
      (error) => error.code === 'CERTIFICADO_CNPJ_NAO_COMPROVADO'
    );
  });

  await test('resultado incerto não aciona TEF, estoque, recebíveis ou financeiro comercial', () => (
    testFluxoCancelamentoComercial(true)
  ));
  await test('cancelamento comercial só inicia após confirmação fiscal simulada', () => (
    testFluxoCancelamentoComercial(false)
  ));

  await test('CNPJ inválido ou divergente bloqueia o envio antes do claim', async () => {
    for (const [cnpj, expectedCode] of [
      ['12345678000199', 'CANCELAMENTO_CNPJ_INVALIDO'],
      ['11222333000181', 'CANCELAMENTO_CNPJ_DIVERGENTE']
    ]) {
      const db = await abrirBanco();
      let sends = 0;
      try {
        await expectCode(
          cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(
            db,
            async () => { sends += 1; },
            { config: { cnpj } }
          )),
          expectedCode
        );
        assert.strictEqual(sends, 0);
        assert.strictEqual(
          (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
          'autorizada'
        );
      } finally {
        await close(db);
      }
    }
  });

  await test('certificado com CNPJ diferente bloqueia o envio antes do claim', async () => {
    const db = await abrirBanco();
    let sends = 0;
    try {
      await expectCode(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(
          db,
          async () => { sends += 1; },
          { certPem: CERTIFICADO_DIVERGENTE_PEM }
        )),
        'CANCELAMENTO_CERTIFICADO_DIVERGENTE'
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

  await test('certificado sem identidade CNPJ comprovável bloqueia o envio', async () => {
    const db = await abrirBanco();
    let sends = 0;
    try {
      await expectCode(
        cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(
          db,
          async () => { sends += 1; },
          { certPem: CERTIFICADO_SEM_CNPJ_PEM }
        )),
        'CERTIFICADO_CNPJ_NAO_COMPROVADO'
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

  await test('cStat 135 persiste cancelada apenas após resposta oficial simulada', async () => {
    const db = await abrirBanco();
    try {
      const result = await cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({
        success: true,
        body: retorno('135', 'Evento registrado'),
        transmissionState: 'RESPONSE_RECEIVED'
      })));
      const note = await get(db, 'SELECT status, xml_retorno FROM nfce_notas WHERE id = 10');
      assert.strictEqual(result.status, 'cancelada');
      assert.strictEqual(note.status, 'cancelada');
      assert.match(note.xml_retorno, /"estado":"CONFIRMADO"/);
    } finally {
      await close(db);
    }
  });

  for (const cStat of ['136', '155']) {
    await test(`cStat ${cStat} é aceito com evento correlacionado e protocolo`, async () => {
      const db = await abrirBanco();
      try {
        await cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({
          success: true,
          body: retorno(cStat, 'Evento registrado'),
          transmissionState: 'RESPONSE_RECEIVED'
        })));
        assert.strictEqual(
          (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
          'cancelada'
        );
      } finally {
        await close(db);
      }
    });
  }

  await test('rejeição fiscal fica registrada e permite nova tentativa explícita', async () => {
    const db = await abrirBanco();
    let sends = 0;
    try {
      await expectCode(cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
        sends += 1;
        return {
          success: true,
          body: retorno('501', 'Prazo de cancelamento inválido'),
          transmissionState: 'RESPONSE_RECEIVED'
        };
      })), 'CANCELAMENTO_REJEITADO');
      assert.strictEqual((await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status, 'cancelamento_rejeitado');

      const result = await cancelarNfce(1, 'Nova justificativa de teste', opcoes(db, async () => {
        sends += 1;
        return {
          success: true,
          body: retorno('135', 'Evento registrado'),
          transmissionState: 'RESPONSE_RECEIVED'
        };
      }));
      assert.strictEqual(result.status, 'cancelada');
      assert.strictEqual(sends, 2);
    } finally {
      await close(db);
    }
  });

  await test('falha comprovadamente pré-envio persiste estado retryable', async () => {
    const db = await abrirBanco();
    try {
      await expectCode(cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => ({
        success: false,
        transmissionState: 'NOT_SENT',
        error: 'Conexão recusada antes do envio'
      }))), 'CANCELAMENTO_FALHA_PRE_ENVIO');
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'cancelamento_falha_pre_envio'
      );
    } finally {
      await close(db);
    }
  });

  await test('timeout ambíguo persiste resultado desconhecido e bloqueia novo envio', async () => {
    const db = await abrirBanco();
    let sends = 0;
    try {
      const options = opcoes(db, async () => {
        sends += 1;
        return {
          success: false,
          transmissionState: 'UNKNOWN',
          error: 'Timeout após início do transporte'
        };
      });

      await test('falha ao persistir resposta autorizada não é reportada como confirmação', async () => {
        const db = await abrirBanco();
        try {
          await run(db, `
            CREATE TRIGGER falhar_persistencia_cancelada
            BEFORE UPDATE OF status ON nfce_notas
            WHEN NEW.status = 'cancelada'
            BEGIN
              SELECT RAISE(ABORT, 'Falha de persistência simulada');
            END
          `);
          await assert.rejects(cancelarNfce(
            1,
            'Cancelamento de teste seguro',
            opcoes(db, async () => ({
              success: true,
              body: retorno('135', 'Evento registrado'),
              transmissionState: 'RESPONSE_RECEIVED'
            }))
          ), /Falha de persistência simulada/);
          assert.strictEqual(
            (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
            'cancelamento_em_andamento'
          );
        } finally {
          await close(db);
        }
      });

      await test('transição concorrente não é sobrescrita pela resposta fiscal tardia', async () => {
        const db = await abrirBanco();
        try {
          await assert.rejects(cancelarNfce(
            1,
            'Cancelamento de teste seguro',
            opcoes(db, async () => {
              await run(db, `
                UPDATE nfce_notas
                SET status = 'cancelamento_desconhecido'
                WHERE id = 10 AND status = 'cancelamento_em_andamento'
              `);
              return {
                success: true,
                body: retorno('135', 'Evento registrado'),
                transmissionState: 'RESPONSE_RECEIVED'
              };
            })
          ), (error) => error.code === 'CANCELAMENTO_ESTADO_PERSISTENCIA_FALHOU');
          assert.strictEqual(
            (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
            'cancelamento_desconhecido'
          );
        } finally {
          await close(db);
        }
      });
      await expectCode(
        cancelarNfce(1, 'Cancelamento de teste seguro', options),
        'CANCELAMENTO_RESULTADO_DESCONHECIDO'
      );
      const stored = await get(db, 'SELECT status, xml_retorno FROM nfce_notas WHERE id = 10');
      assert.strictEqual(stored.status, 'cancelamento_desconhecido');
      assert.match(stored.xml_retorno, /"estado":"RESULTADO_DESCONHECIDO"/);
      assert.match(stored.xml_retorno, /"correlationId":"/);
      await expectCode(
        cancelarNfce(1, 'Reenvio não permitido', options),
        'CANCELAMENTO_RESULTADO_DESCONHECIDO'
      );
      assert.strictEqual(sends, 1);
    } finally {
      await close(db);
    }
  });

  for (const cStat of ['573', '631']) {
    await test(`cStat ${cStat} não é presumido como sucesso`, async () => {
      const db = await abrirBanco();
      try {
        await expectCode(cancelarNfce(
          1,
          'Cancelamento de teste seguro',
          opcoes(db, async () => ({
            success: true,
            body: retorno(cStat, 'Evento duplicado'),
            transmissionState: 'RESPONSE_RECEIVED'
          }))
        ), 'CANCELAMENTO_RESULTADO_DESCONHECIDO');
        assert.strictEqual(
          (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
          'cancelamento_desconhecido'
        );
      } finally {
        await close(db);
      }
    });
  }

  await test('resposta de sucesso para outra chave não confirma esta NFC-e', async () => {
    const db = await abrirBanco();
    try {
      const body = retorno('135', 'Evento registrado')
        .replace(CHAVE, '23260112345678000199650010000000011000000002');
      await expectCode(cancelarNfce(
        1,
        'Cancelamento de teste seguro',
        opcoes(db, async () => ({
          success: true,
          body,
          transmissionState: 'RESPONSE_RECEIVED'
        }))
      ), 'CANCELAMENTO_RESULTADO_DESCONHECIDO');
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'cancelamento_desconhecido'
      );
    } finally {
      await close(db);
    }
  });

  await test('duas instâncias concorrentes permitem somente um envio', async () => {
    const filename = path.join(TMP_DIR, 'cancelamento-concorrente.db');
    const db = await abrirBanco(filename);
    const segundaConexao = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(filename, (error) => {
        if (error) reject(error);
        else resolve(connection);
      });
    });
    let sends = 0;
    let releaseSend;
    let notifySendStarted;
    const sendStarted = new Promise((resolve) => { notifySendStarted = resolve; });
    const sendResponse = new Promise((resolve) => { releaseSend = resolve; });
    try {
      const first = cancelarNfce(1, 'Cancelamento de teste seguro', opcoes(db, async () => {
        sends += 1;
        notifySendStarted();
        return sendResponse;
      }));
      await sendStarted;
      await expectCode(cancelarNfce(
        1,
        'Segundo pedido concorrente',
        opcoes(segundaConexao, async () => {
          sends += 1;
          return { success: true, body: retorno('135'), transmissionState: 'RESPONSE_RECEIVED' };
        })
      ), 'CANCELAMENTO_EM_ANDAMENTO');
      releaseSend({
        success: true,
        body: retorno('135', 'Evento registrado'),
        transmissionState: 'RESPONSE_RECEIVED'
      });
      await first;
      assert.strictEqual(sends, 1);
    } finally {
      await close(db);
      await close(segundaConexao);
    }
  });

  await test('dois processos Node concorrentes permitem somente um envio', async () => {
    const filename = path.join(TMP_DIR, 'cancelamento-dois-processos.db');
    const barrier = path.join(TMP_DIR, 'cancelamento-dois-processos.start');
    const sendLog = path.join(TMP_DIR, 'cancelamento-dois-processos.sends');
    const seedDb = await abrirBanco(filename);
    await close(seedDb);
    const workerPath = path.join(__dirname, 'cancelamento-nfce-claim-worker.js');
    const startWorker = (workerId) => new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, [
        workerPath,
        filename,
        barrier,
        sendLog,
        workerId
      ], {
        env: { ...process.env, TEST_CERT_PEM: CERTIFICADO_TESTE_PEM },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Processo ${workerId} excedeu o timeout de teste.`));
      }, 15000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`Worker ${workerId} falhou (${code}): ${stderr || stdout}`));
          return;
        }
        const resultLine = stdout.split(/\r?\n/)
          .find((line) => line.startsWith('WORKER_RESULT:'));
        if (!resultLine) {
          reject(new Error(`Worker ${workerId} não produziu resultado: ${stderr || stdout}`));
          return;
        }
        resolve(JSON.parse(resultLine.slice('WORKER_RESULT:'.length)));
      });
    });

    const workers = [startWorker('a'), startWorker('b')];
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(barrier, 'go');
    const results = await Promise.all(workers);
    const sends = fs.readFileSync(sendLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(results.filter((result) => result.sent).length, 1);
    assert.strictEqual(results.filter((result) => !result.sent).length, 1);
    assert.ok(results.every((result) => (
      result.code === 'CANCELAMENTO_RESULTADO_DESCONHECIDO'
      || result.code === 'CANCELAMENTO_EM_ANDAMENTO'
    )));

    const persistedDb = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(filename, (error) => {
        if (error) reject(error);
        else resolve(connection);
      });
    });
    try {
      assert.strictEqual(
        (await get(persistedDb, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'cancelamento_desconhecido'
      );
    } finally {
      await close(persistedDb);
    }
  });

  await test('estado desconhecido sobrevive a reabertura simulada do banco temporário', async () => {
    const filename = path.join(TMP_DIR, 'cancelamento-isolado.db');
    assert.notStrictEqual(
      path.win32.resolve(filename).toLowerCase(),
      DATABASE_OFICIAL.toLowerCase()
    );
    let db = await abrirBanco(filename);
    let sends = 0;
    try {
      await expectCode(cancelarNfce(
        1,
        'Cancelamento de teste seguro',
        opcoes(db, async () => {
          sends += 1;
          return {
            success: false,
            transmissionState: 'UNKNOWN',
            error: 'Timeout simulado'
          };
        })
      ), 'CANCELAMENTO_RESULTADO_DESCONHECIDO');
      await close(db);
      db = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(filename, (error) => {
          if (error) reject(error);
          else resolve(connection);
        });
      });
      await expectCode(cancelarNfce(
        1,
        'Tentativa após reinicialização simulada',
        opcoes(db, async () => {
          sends += 1;
          return { success: true, body: retorno('135'), transmissionState: 'RESPONSE_RECEIVED' };
        })
      ), 'CANCELAMENTO_RESULTADO_DESCONHECIDO');
      assert.strictEqual(sends, 1);
      assert.strictEqual(
        (await get(db, 'SELECT status FROM nfce_notas WHERE id = 10')).status,
        'cancelamento_desconhecido'
      );
    } finally {
      await close(db);
    }
  });

  console.log(`\nResultado: ${passou} aprovados, ${falhou} falhos.`);
  if (falhou) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });
