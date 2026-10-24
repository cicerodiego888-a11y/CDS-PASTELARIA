/**
 * P0.3 — Proteção do certificado no pipeline NF-e modelo 55.
 * Banco temporário + PFX sintéticos. Sem SEFAZ. Sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/fiscal/protecao-certificado-pipeline-nfe-55-p0-3.test.js
 */
'use strict';

const { isolarBancoTeste, caminhoEhOficial } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-fiscal-p03-nfe55-');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const forge = require('node-forge');

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  garantirSchemaFiscalEmpresaAsync,
  upsertConfiguracaoFiscalEmpresa,
  salvarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { exigirCertificadoAptoParaUsoFiscal } = require('../../backend/services/fiscal/CertificadoUsoFiscalGate');
const {
  resolverEmpresaIdDocumentoNfe,
  carregarConfigEAplicarGateCertificadoNfe,
  respostaBloqueioCertificadoNfe
} = require('../../backend/services/fiscal/nfeCertificadoUso');
const {
  ESTADOS_CERTIFICADO_A1,
  CODIGOS_CERTIFICADO_A1,
  snapshotInvalidadoPorSubstituicao
} = require('../../backend/services/fiscal/certificadoEstados');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const SENHA_OK = 'SenhaNfe55P03#1';
const SENHA_ERRADA = 'SenhaErrada#9';
const ROOT = path.join(__dirname, '../..');

let passou = 0;
let falhou = 0;

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passou += 1;
      console.log(`  OK  ${nome}`);
    })
    .catch((error) => {
      falhou += 1;
      console.error(`  FALHOU  ${nome}`);
      console.error(`         ${error.message}`);
    });
}

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_e) { resolve(); }
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function gerarChave() {
  return forge.pki.rsa.generateKeyPair({ bits: 512, workers: -1 });
}

function montarPfxBuffer({ senha, cnpj, notBefore, notAfter, keys }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = notBefore || new Date('2024-01-01T00:00:00Z');
  cert.validity.notAfter = notAfter || new Date('2035-01-01T00:00:00Z');
  const attrs = [{ name: 'commonName', value: `Empresa ${cnpj || 'sem-cnpj'}` }];
  if (cnpj) attrs.push({ type: '2.16.76.1.3.3', value: cnpj });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

function pastaCert(tmp) {
  const dir = path.join(tmp, 'certificados');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function schemaBase(db) {
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaFiscalEmpresaAsync(db);
}

async function prepararEmpresa(db, { cnpj, tag, pasta, senha = SENHA_OK, estado, notAfter, cnpjCert, corrompido }) {
  const emp = await EmpresaService.criarEmpresa(
    { cnpj, razao_social: `Empresa ${tag}`, inscricao_estadual: `IE${tag}` },
    { db }
  );
  const destino = path.join(pasta, `certificado-empresa-${emp.id}.pfx`);
  if (corrompido) {
    fs.writeFileSync(destino, Buffer.from('nao-e-um-pfx'));
  } else if (estado !== ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO) {
    const keys = gerarChave();
    fs.writeFileSync(destino, montarPfxBuffer({
      senha,
      cnpj: cnpjCert !== undefined ? cnpjCert : cnpj,
      notAfter: notAfter || new Date('2035-06-01T00:00:00Z'),
      keys
    }));
  }

  const patch = {
    ambiente: 2,
    uf: 'CE',
    codigo_uf: '23',
    serie: 1,
    numero_atual: 1,
    token_csc: `CSC-${tag}`,
    id_csc: '1',
    certificado_path: estado === ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO ? '' : destino,
    certificado_senha: estado === ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO ? '' : senha,
    crt: '1',
    ie: `IE${tag}`,
    ws_autorizacao_homologacao: 'https://sefaz.local/h/auth',
    ws_autorizacao_producao: 'https://sefaz.local/p/auth',
    csc_qrcode_url_homologacao: 'https://qr.local/h',
    csc_qrcode_url_producao: 'https://qr.local/p',
    consulta_chave_url_homologacao: 'https://ch.local/h',
    consulta_chave_url_producao: 'https://ch.local/p'
  };

  if (estado && estado !== ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    && estado !== ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO) {
    patch.certificado_validacao_status = estado;
    patch.certificado_validacao_em = new Date().toISOString();
    patch.certificado_validacao_codigo = estado === ESTADOS_CERTIFICADO_A1.VALIDO
      ? CODIGOS_CERTIFICADO_A1.VALIDACAO_OK
      : CODIGOS_CERTIFICADO_A1.ERRO;
    patch.certificado_validacao_mensagem = `estado ${estado}`;
    if (estado === ESTADOS_CERTIFICADO_A1.VALIDO) {
      patch.certificado_cnpj = cnpj;
      patch.certificado_validade_ate = '2035-06-01T00:00:00.000Z';
    }
  }

  await upsertConfiguracaoFiscalEmpresa(emp.id, patch, db);
  return { emp, destino, deps: { db, pastaCertificados: pasta } };
}

/** Espelha ordem NF-e 55: gate → só então transporte. */
async function pipelineNfe55SemTransporte({ venda, compra, empresaId, db, deps, enviarLote }) {
  const { config } = await carregarConfigEAplicarGateCertificadoNfe({
    venda,
    compra,
    empresaId,
    db,
    certDeps: deps,
    persistirSnapshot: false,
    validarUrls: false
  });
  return enviarLote({
    certificadoPath: config.certificadoPath,
    certificadoSenha: config.certificadoSenha,
    empresaId: config.empresaId
  });
}

async function main() {
  console.log('\n=== P0.3 Proteção certificado pipeline NF-e 55 ===\n');
  isolamento.comprobarSeCarregado();
  assert.ok(isolamento.dbDir && !caminhoEhOficial(isolamento.dbDir));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p03-pfx-'));
  const pasta = pastaCert(tmp);

  await test('1. Certificado válido e CNPJ correspondente', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps, destino } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A1', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const { config, certApto } = await carregarConfigEAplicarGateCertificadoNfe({
      venda: { empresa_id: emp.id },
      db,
      certDeps: deps,
      persistirSnapshot: false,
      validarUrls: false
    });
    assert.strictEqual(certApto.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.strictEqual(config.certificadoPath, destino);
    assert.strictEqual(Number(config.empresaId), Number(emp.id));
    await closeDb(db);
  });

  await test('2. Senha incorreta bloqueia', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A2', pasta, senha: SENHA_OK,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    await salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_senha: SENHA_ERRADA }, { db });
    let tx = false;
    await assert.rejects(
      () => pipelineNfe55SemTransporte({
        venda: { empresa_id: emp.id },
        db,
        deps,
        enviarLote: async () => { tx = true; return { success: true }; }
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA
    );
    assert.strictEqual(tx, false);
    await closeDb(db);
  });

  await test('3. Arquivo PKCS#12 corrompido', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A3', pasta,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO,
      corrompido: true
    });
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({
        venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.ARQUIVO_INVALIDO
    );
    await closeDb(db);
  });

  await test('4. Certificado expirado', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A4', pasta,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO,
      notAfter: new Date('2020-01-01T00:00:00Z')
    });
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({
        venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EXPIRADO
        || err.estado === ESTADOS_CERTIFICADO_A1.EXPIRADO
    );
    await closeDb(db);
  });

  await test('5. CNPJ divergente', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A5', pasta,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO,
      cnpjCert: CNPJ_B
    });
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({
        venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
    );
    await closeDb(db);
  });

  await test('6. Certificado ausente', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A6', pasta, estado: ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO
    });
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({
        venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.ARQUIVO_OBRIGATORIO
        || err.estado === ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO
    );
    await closeDb(db);
  });

  await test('7. CONFIGURADO_NÃO_VALIDADO exige validação local', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A7', pasta,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    const dtoAntes = await obterConfiguracaoFiscalEmpresa(emp.id, { db });
    assert.strictEqual(dtoAntes.apto_certificado_criptografico, false);
    const { certApto } = await carregarConfigEAplicarGateCertificadoNfe({
      venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
    });
    assert.strictEqual(certApto.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    await closeDb(db);
  });

  await test('8. Snapshot invalidado após alteração de senha/arquivo', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps, destino } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A8', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    await salvarConfiguracaoFiscalEmpresa(emp.id, {
      certificado_senha: 'NovaSenha#2',
      ...snapshotInvalidadoPorSubstituicao()
    }, { db });
    fs.writeFileSync(destino, montarPfxBuffer({
      senha: 'NovaSenha#2', cnpj: CNPJ_A, keys: gerarChave()
    }));
    const dto = await obterConfiguracaoFiscalEmpresa(emp.id, { db });
    assert.strictEqual(dto.apto_certificado_criptografico, false);
    const { certApto } = await carregarConfigEAplicarGateCertificadoNfe({
      venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
    });
    assert.strictEqual(certApto.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    await closeDb(db);
  });

  await test('9. Isolamento empresas A e B', async () => {
    const db = await openDb();
    await schemaBase(db);
    const a = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A9', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const b = await prepararEmpresa(db, {
      cnpj: CNPJ_B, tag: 'B9', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    await assert.rejects(
      () => salvarConfiguracaoFiscalEmpresa(a.emp.id, { certificado_path: b.destino }, {
        db, pastaCertificados: pasta
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    await run(db, `UPDATE empresas_configuracao_fiscal SET certificado_path = ? WHERE empresa_id = ?`, [
      b.destino, a.emp.id
    ]);
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({
        venda: { empresa_id: a.emp.id }, db, certDeps: a.deps, validarUrls: false
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    const okB = await carregarConfigEAplicarGateCertificadoNfe({
      compra: { empresa_id: b.emp.id }, db, certDeps: b.deps, persistirSnapshot: false, validarUrls: false
    });
    assert.ok(okB.config.certificadoPath.includes(`certificado-empresa-${b.emp.id}.pfx`));
    await closeDb(db);
  });

  await test('10. empresaId ausente', async () => {
    assert.throws(
      () => resolverEmpresaIdDocumentoNfe({ venda: {} }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA_USO
    );
    const db = await openDb();
    await schemaBase(db);
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({ venda: {}, db, validarUrls: false }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA_USO
    );
    await closeDb(db);
  });

  await test('11. Caminho externo / traversal rejeitados', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A11', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const externo = path.join(os.tmpdir(), `p03-ext-${Date.now()}.pfx`);
    fs.writeFileSync(externo, Buffer.from('x'));
    await assert.rejects(
      () => salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_path: externo }, {
        db, pastaCertificados: pasta
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    await run(db, `UPDATE empresas_configuracao_fiscal SET certificado_path = ? WHERE empresa_id = ?`, [
      externo, emp.id
    ]);
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({
        venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    const escapePath = path.join(pasta, '..', 'escape.pfx');
    await assert.rejects(
      () => salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_path: escapePath }, {
        db, pastaCertificados: pasta
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    await run(db, `UPDATE empresas_configuracao_fiscal SET certificado_path = ? WHERE empresa_id = ?`, [
      escapePath, emp.id
    ]);
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({
        venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    try { fs.unlinkSync(externo); } catch (_e) { /* ignore */ }
    await closeDb(db);
  });

  await test('12. Falha de validação antes da assinatura (ordem harness)', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A12', pasta, estado: ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA
    });
    let assinou = false;
    await assert.rejects(
      async () => {
        await carregarConfigEAplicarGateCertificadoNfe({
          venda: { empresa_id: emp.id }, db, certDeps: deps, validarUrls: false
        });
        assinou = true;
      },
      (err) => err.code === CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA
    );
    assert.strictEqual(assinou, false);
    await closeDb(db);
  });

  await test('13. Falha antes do transporte simulado', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A13', pasta, estado: ESTADOS_CERTIFICADO_A1.EXPIRADO
    });
    let tx = false;
    await assert.rejects(
      () => pipelineNfe55SemTransporte({
        venda: { empresa_id: emp.id },
        db,
        deps,
        enviarLote: async () => { tx = true; return { success: true }; }
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EXPIRADO
    );
    assert.strictEqual(tx, false);
    await closeDb(db);
  });

  await test('14. Ausência de falso sucesso de emissão', async () => {
    const err = Object.assign(new Error('bloqueado'), {
      code: CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA,
      estado: ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA,
      sefaz_chamado: false
    });
    const resp = respostaBloqueioCertificadoNfe(err);
    assert.strictEqual(resp.success, false);
    assert.strictEqual(resp.sefaz_chamado, false);
    assert.notStrictEqual(resp.status, 'autorizada');
    assert.ok(!JSON.stringify(resp).includes(SENHA_OK));
  });

  await test('15. Emissão por venda usa gate (fonte)', async () => {
    const emissor = src('backend/services/fiscal/nfeEmissorVenda.js');
    assert.ok(emissor.includes('carregarConfigEAplicarGateCertificadoNfe'));
    assert.ok(emissor.includes('respostaBloqueioCertificadoNfe'));
    const idxGate = emissor.indexOf('carregarConfigEAplicarGateCertificadoNfe');
    const idxNum = emissor.indexOf('proximoNumeroNFeVenda()');
    const idxSign = emissor.indexOf('carregarEValidarCertificadoNfe(config)');
    const idxSoap = emissor.indexOf('enviarLote({');
    assert.ok(idxGate > 0 && idxNum > idxGate && idxSign > idxGate && idxSoap > idxGate);
  });

  await test('16. Faturamento converge em emitirNfePorVendaId (fonte)', async () => {
    const fat = src('backend/services/faturamento/CentralFaturamentoService.js');
    assert.ok(fat.includes('emitirNfePorVendaId'));
    assert.ok(!fat.includes('enviarLote('));
  });

  await test('17. Devolução venda/compra usam gate (fonte)', async () => {
    const dv = src('backend/services/fiscal/nfeDevolucaoVenda.js');
    const dc = src('backend/services/fiscal/nfeDevolucaoCompra.js');
    assert.ok(dv.includes('carregarConfigEAplicarGateCertificadoNfe'));
    assert.ok(dc.includes('carregarConfigEAplicarGateCertificadoNfe'));
    assert.ok(dv.indexOf('carregarConfigEAplicarGateCertificadoNfe')
      < dv.indexOf('proximoNumeroNFeVenda()'));
    assert.ok(dc.indexOf('carregarConfigEAplicarGateCertificadoNfe')
      < dc.indexOf('proximoNumeroNFeVenda()'));
  });

  await test('18. Rotas alternativas / avulsa / faturamento (fonte)', async () => {
    const avulsa = src('backend/services/fiscal/nfeAvulsaService.js');
    const fatRota = src('backend/rotas/faturamento.js');
    assert.ok(avulsa.includes('emitirNfePorVendaId'));
    assert.ok(fatRota.includes('emitirNfePorVendaId'));
  });

  await test('19. Cancelamento NF-e 55 usa gate (fonte + comportamento)', async () => {
    const cancel = src('backend/services/fiscal/cancelarNfe.js');
    const lifeC = src('backend/services/fiscal/nfeDevolucaoLifecycleService.js');
    const lifeV = src('backend/services/fiscal/nfeDevolucaoLifecycleVenda.js');
    const central = src('backend/services/fiscal/nfeCentralService.js');
    assert.ok(cancel.includes('carregarConfigEAplicarGateCertificadoNfe'));
    assert.ok(lifeC.includes('carregarConfigGateDevolucaoCompra'));
    assert.ok(lifeV.includes('carregarConfigGateDevolucaoVenda'));
    assert.ok(central.includes('carregarConfigEAplicarGateCertificadoNfe'));
    assert.ok(cancel.indexOf('carregarConfigEAplicarGateCertificadoNfe')
      < cancel.indexOf('carregarPfx(config.certificadoPath'));

    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A19', pasta, estado: ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
    });
    let tx = false;
    await assert.rejects(
      () => pipelineNfe55SemTransporte({
        venda: { empresa_id: emp.id },
        db,
        deps,
        enviarLote: async () => { tx = true; return { success: true }; }
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
        || err.estado === ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
    );
    assert.strictEqual(tx, false);
    await closeDb(db);
  });

  await test('20. Falha de persistência do snapshot não libera sem validação', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A20', pasta,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    const depsFail = {
      ...deps,
      salvarConfiguracaoFiscalEmpresa: async () => {
        throw new Error('falha-persistencia-snapshot');
      }
    };
    // Validação em memória ainda pode liberar (gate P0.2); persistência falha é engolida.
    // Contrato: se PKCS#12 falhar, bloqueia mesmo com persistência quebrada.
    await salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_senha: SENHA_ERRADA }, { db });
    await assert.rejects(
      () => carregarConfigEAplicarGateCertificadoNfe({
        venda: { empresa_id: emp.id },
        db,
        certDeps: depsFail,
        validarUrls: false
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA
    );
    await closeDb(db);
  });

  await test('21. Nenhuma falha do gate invoca transporte simulado', async () => {
    const estados = [
      ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA,
      ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      ESTADOS_CERTIFICADO_A1.EXPIRADO,
      ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
    ];
    for (let i = 0; i < estados.length; i += 1) {
      const db = await openDb();
      await schemaBase(db);
      const { emp, deps } = await prepararEmpresa(db, {
        cnpj: CNPJ_A, tag: `T21${i}`, pasta, estado: estados[i],
        corrompido: estados[i] === ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO
      });
      let tx = false;
      await assert.rejects(
        () => pipelineNfe55SemTransporte({
          venda: { empresa_id: emp.id },
          db,
          deps,
          enviarLote: async () => { tx = true; return { success: true }; }
        })
      );
      assert.strictEqual(tx, false, `transporte chamado para ${estados[i]}`);
      await closeDb(db);
    }
  });

  await test('22. Compatibilidade com gate NFC-e 65', async () => {
    const gate = src('backend/services/fiscal/CertificadoUsoFiscalGate.js');
    const uso = src('backend/services/fiscal/nfeCertificadoUso.js');
    const emissor65 = src('backend/services/fiscal/emissor.js');
    assert.ok(uso.includes("require('./CertificadoUsoFiscalGate')"));
    assert.ok(emissor65.includes('exigirCertificadoAptoParaUsoFiscal'));
    assert.ok(gate.includes('validarArquivoPfx'));
    // Mesmo serviço: chamada direta equivale ao wrapper NF-e
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A22', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const direto = await exigirCertificadoAptoParaUsoFiscal({
      empresaId: emp.id, db, deps, persistirSnapshot: false
    });
    const via55 = await carregarConfigEAplicarGateCertificadoNfe({
      venda: { empresa_id: emp.id }, db, certDeps: deps, persistirSnapshot: false, validarUrls: false
    });
    assert.strictEqual(direto.estado, via55.certApto.estado);
    assert.strictEqual(direto.certificadoPath, via55.config.certificadoPath);
    await closeDb(db);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  isolamento.comprobarSeCarregado();
  console.log(`\nResultado: ${passou} ok, ${falhou} falha(s)`);
  if (falhou > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
