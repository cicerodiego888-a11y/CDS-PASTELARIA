/**
 * P0.2 — Proteção do certificado no pipeline de emissão NFC-e.
 * Banco temporário + PFX sintéticos. Sem SEFAZ. Sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/fiscal/protecao-certificado-pipeline-nfce-p0-2.test.js
 */
'use strict';

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-fiscal-p02-nfce-');

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
const { caminhoEhOficial } = require('../central-entradas/helpers/isolarBancoTeste');
const {
  ESTADOS_CERTIFICADO_A1,
  CODIGOS_CERTIFICADO_A1,
  snapshotInvalidadoPorSubstituicao
} = require('../../backend/services/fiscal/certificadoEstados');

/**
 * Espelha a ordem do emissor: gate → (só então) transporte.
 * Evita carregar database.js / schema completo de vendas_itens.
 */
async function emitirComGateSemTransporte({ empresaId, db, deps, enviarAutorizacao }) {
  await exigirCertificadoAptoParaUsoFiscal({
    empresaId,
    db,
    deps,
    persistirSnapshot: false
  });
  return enviarAutorizacao({
    certificadoPath: 'apos-gate',
    sefaz: true
  });
}

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const SENHA_OK = 'SenhaPipeP02#1';
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
    db.run(sql, params, function cb(err) {
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
    const buf = montarPfxBuffer({
      senha,
      cnpj: cnpjCert !== undefined ? cnpjCert : cnpj,
      notAfter: notAfter || new Date('2035-06-01T00:00:00Z'),
      keys
    });
    fs.writeFileSync(destino, buf);
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

async function schemaBase(db) {
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaFiscalEmpresaAsync(db);
  await run(db, `CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT,
    empresa_id INTEGER,
    status_pagamento TEXT DEFAULT 'quitada',
    total REAL DEFAULT 10
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS venda_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER,
    produto_id INTEGER,
    descricao TEXT,
    quantidade REAL,
    preco_unitario REAL,
    total REAL,
    ncm TEXT,
    cfop TEXT,
    unidade TEXT
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS nfce_notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, numero INTEGER, serie INTEGER, chave_acesso TEXT,
    ambiente INTEGER, status TEXT, empresa_id INTEGER, xml_retorno TEXT,
    protocolo TEXT, danfe_html TEXT, xml_enviado TEXT, qr_code_url TEXT,
    created_at TEXT, updated_at TEXT
  )`);
}

async function main() {
  console.log('\n=== P0.2 Proteção certificado pipeline NFC-e ===\n');
  isolamento.comprobarSeCarregado();
  assert.ok(isolamento.dbDir, 'dbDir de isolamento obrigatório');
  assert.ok(!caminhoEhOficial(isolamento.dbDir), 'DB_DIR não pode ser o banco oficial');
  assert.ok(!caminhoEhOficial(isolamento.dbPathEsperado), 'dbPathEsperado não pode ser oficial');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p02-pfx-'));
  const pasta = pastaCert(tmp);

  await test('1. Certificado válido e CNPJ correspondente libera uso', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A1', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const r = await exigirCertificadoAptoParaUsoFiscal({
      empresaId: emp.id, db, deps, persistirSnapshot: false
    });
    assert.strictEqual(r.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.strictEqual(r.apto_certificado_criptografico, true);
    assert.ok(r.certificadoPath.includes(`certificado-empresa-${emp.id}.pfx`));
    await closeDb(db);
  });

  await test('2. Senha incorreta bloqueia antes do cliente fiscal', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps, destino } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A2', pasta, senha: SENHA_OK,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    await salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_senha: SENHA_ERRADA }, { db });
    let transporte = false;
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA
        && err.sefaz_chamado === false
    );
    assert.strictEqual(transporte, false);
    assert.ok(fs.existsSync(destino));
    await closeDb(db);
  });

  await test('3. Arquivo corrompido bloqueia', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A3', pasta, estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO,
      corrompido: true
    });
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.ARQUIVO_INVALIDO
    );
    await closeDb(db);
  });

  await test('4. Certificado expirado bloqueia', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A4', pasta,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO,
      notAfter: new Date('2020-01-01T00:00:00Z')
    });
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EXPIRADO
        || err.estado === ESTADOS_CERTIFICADO_A1.EXPIRADO
    );
    await closeDb(db);
  });

  await test('5. CNPJ divergente bloqueia', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A5', pasta,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO,
      cnpjCert: CNPJ_B
    });
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
    );
    await closeDb(db);
  });

  await test('6. Certificado ausente bloqueia', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A6', pasta, estado: ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO
    });
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.ARQUIVO_OBRIGATORIO
        || err.estado === ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO
    );
    await closeDb(db);
  });

  await test('7. CONFIGURADO_NÃO_VALIDADO não é interpretado como válido sem PKCS#12', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A7', pasta,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    const dtoAntes = await obterConfiguracaoFiscalEmpresa(emp.id, { db });
    assert.strictEqual(dtoAntes.certificado_validado, false);
    assert.strictEqual(dtoAntes.apto_certificado_criptografico, false);
    assert.notStrictEqual(dtoAntes.certificado_status, ESTADOS_CERTIFICADO_A1.VALIDO);
    // Gate exige validação local — com PFX bom, promove após prova criptográfica.
    const r = await exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps });
    assert.strictEqual(r.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    const dtoDepois = await obterConfiguracaoFiscalEmpresa(emp.id, { db });
    assert.strictEqual(dtoDepois.apto_certificado_criptografico, true);
    await closeDb(db);
  });

  await test('8. Snapshot invalidado após mudança de senha/arquivo', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps, destino } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A8', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    await salvarConfiguracaoFiscalEmpresa(emp.id, {
      certificado_senha: 'NovaSenha#2',
      ...snapshotInvalidadoPorSubstituicao()
    }, { db });
    // Recria PFX com a nova senha para isolar o efeito do snapshot inválido vs senha.
    const keys = gerarChave();
    fs.writeFileSync(destino, montarPfxBuffer({ senha: 'NovaSenha#2', cnpj: CNPJ_A, keys }));
    const dto = await obterConfiguracaoFiscalEmpresa(emp.id, { db });
    assert.strictEqual(dto.certificado_status, ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO);
    assert.strictEqual(dto.apto_certificado_criptografico, false);
    // Com senha correta no arquivo, gate revalida e pode promover — snapshot não era VÁLIDO.
    const r = await exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps });
    assert.strictEqual(r.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    await closeDb(db);
  });

  await test('9. Empresa A não utiliza certificado da empresa B', async () => {
    const db = await openDb();
    await schemaBase(db);
    const a = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A9', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const b = await prepararEmpresa(db, {
      cnpj: CNPJ_B, tag: 'B9', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    // P0.4 — gravação administrativa já rejeita path de outra empresa.
    await assert.rejects(
      () => salvarConfiguracaoFiscalEmpresa(a.emp.id, {
        certificado_path: b.destino
      }, { db, pastaCertificados: pasta }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    // Legado já persistido: gate continua bloqueando no uso.
    await run(db, `UPDATE empresas_configuracao_fiscal SET certificado_path = ? WHERE empresa_id = ?`, [
      b.destino, a.emp.id
    ]);
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({
        empresaId: a.emp.id, db, deps: a.deps
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    const okB = await exigirCertificadoAptoParaUsoFiscal({
      empresaId: b.emp.id, db, deps: b.deps, persistirSnapshot: false
    });
    assert.ok(okB.certificadoPath.includes(`certificado-empresa-${b.emp.id}.pfx`));
    await closeDb(db);
  });

  await test('10. Empresa ausente bloqueada', async () => {
    const db = await openDb();
    await schemaBase(db);
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({
        empresaId: 99999, db, deps: { db, pastaCertificados: pasta }
      }),
      (err) => err.code === 'EMPRESA_INVALIDA'
        || err.code === 'EMPRESA_NAO_ENCONTRADA'
        || err.code === 'CONFIGURACAO_FISCAL_NAO_ENCONTRADA'
        || err.code === 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE'
        || /não cadastrada/i.test(String(err.message || ''))
    );
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: null, db }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA_USO
        || err.code === CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA
    );
    await closeDb(db);
  });

  await test('11. Caminho externo ao diretório protegido é rejeitado', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A11', pasta, estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const externo = path.join(os.tmpdir(), `p02-externo-${Date.now()}.pfx`);
    fs.writeFileSync(externo, Buffer.from('x'));
    // P0.4 — gravação administrativa bloqueia path externo.
    await assert.rejects(
      () => salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_path: externo }, {
        db, pastaCertificados: pasta
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    // Legado já persistido: gate bloqueia no uso fiscal.
    await run(db, `UPDATE empresas_configuracao_fiscal SET certificado_path = ? WHERE empresa_id = ?`, [
      externo, emp.id
    ]);
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    try { fs.unlinkSync(externo); } catch (_e) { /* ignore */ }
    await closeDb(db);
  });

  await test('12. Falha de validação não altera o certificado armazenado', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps, destino } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A12', pasta, senha: SENHA_OK,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    const antes = fs.readFileSync(destino);
    await salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_senha: SENHA_ERRADA }, { db });
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps })
    );
    const depois = fs.readFileSync(destino);
    assert.ok(Buffer.compare(antes, depois) === 0);
    await closeDb(db);
  });

  await test('13. Falha não produz falsa indicação de emissão concluída', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A13', pasta,
      estado: ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA
    });
    let enviarChamado = false;
    await assert.rejects(
      () => emitirComGateSemTransporte({
        empresaId: emp.id,
        db,
        deps,
        enviarAutorizacao: async () => {
          enviarChamado = true;
          return { success: true, status: 'autorizada' };
        }
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA
        && err.sefaz_chamado === false
    );
    assert.strictEqual(enviarChamado, false);
    await closeDb(db);
  });

  await test('14. Erros não expõem senha nem conteúdo do PFX', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A14', pasta, senha: SENHA_OK,
      estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    await salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_senha: SENHA_ERRADA }, { db });
    try {
      await exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps });
      assert.fail('deveria falhar');
    } catch (err) {
      const blob = JSON.stringify({
        message: err.message,
        code: err.code,
        estado: err.estado,
        detalhe: err.detalhe
      });
      assert.ok(!blob.includes(SENHA_ERRADA));
      assert.ok(!blob.includes(SENHA_OK));
      assert.ok(!/BEGIN (RSA )?PRIVATE KEY|BAG ATTRIBUTES|MII/i.test(blob));
    }
    await closeDb(db);
  });

  await test('15. Nenhuma transmissão ou manifestação fiscal é executada', async () => {
    const emissorSrc = src('backend/services/fiscal/emissor.js');
    const gateSrc = src('backend/services/fiscal/CertificadoUsoFiscalGate.js');
    assert.ok(emissorSrc.includes('exigirCertificadoAptoParaUsoFiscal'));
    assert.ok(gateSrc.includes('validarArquivoPfx'));
    assert.ok(!gateSrc.includes('enviarAutorizacao'));
    assert.ok(!gateSrc.includes('DistDFe'));
    assert.ok(!gateSrc.includes('210210'));
    assert.ok(process.env.DB_DIR && !caminhoEhOficial(process.env.DB_DIR));
    // Ordem no emissor: gate antes de carregarCertificadoPfx e entregarUrlsAoTransporte
    const idxGate = emissorSrc.indexOf('exigirCertificadoAptoParaUsoFiscal');
    const idxPfx = emissorSrc.indexOf('carregarCertificadoPfx(config.certificadoPath');
    const idxSoap = emissorSrc.indexOf('entregarUrlsAoTransporte');
    assert.ok(idxGate > 0 && idxPfx > idxGate && idxSoap > idxGate);
  });

  await test('16. Rotas alternativas de emissão respeitam a mesma política', async () => {
    const fiscal = src('backend/rotas/fiscal.js');
    const vendaFiscal = src('backend/services/vendas/VendaFiscalService.js');
    const muv = src('backend/motores/muv/FiscalizarAtendimentoService.js');
    assert.ok(fiscal.includes('emitirPorVendaId'));
    assert.ok(vendaFiscal.includes('emitirPorVendaId'));
    assert.ok(muv.includes('emitirPorVendaId'));
    const emissor = src('backend/services/fiscal/emissor.js');
    assert.ok(emissor.includes('exigirCertificadoAptoParaUsoFiscal'));
    const cancel = src('backend/services/fiscal/cancelarNfce.js');
    assert.ok(cancel.includes('exigirCertificadoAptoParaUsoFiscal'));
  });

  await test('Snapshot SENHA_INVÁLIDA bloqueia sem reabrir como sucesso', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A15', pasta, senha: SENHA_OK,
      estado: ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA
    });
    await assert.rejects(
      () => exigirCertificadoAptoParaUsoFiscal({ empresaId: emp.id, db, deps }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA
    );
    await closeDb(db);
  });

  await test('Emissor/cancelamento referenciam o mesmo gate (fonte)', async () => {
    const emissor = src('backend/services/fiscal/emissor.js');
    const cancel = src('backend/services/fiscal/cancelarNfce.js');
    assert.ok(emissor.includes("require('./CertificadoUsoFiscalGate')"));
    assert.ok(cancel.includes("require('./CertificadoUsoFiscalGate')"));
    assert.ok(emissor.includes('config.certificadoPath = certApto.certificadoPath'));
  });

  await test('Gate com EXPIRADO impede transporte', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await prepararEmpresa(db, {
      cnpj: CNPJ_A, tag: 'A16', pasta, estado: ESTADOS_CERTIFICADO_A1.EXPIRADO
    });
    let enviarChamado = false;
    await assert.rejects(
      () => emitirComGateSemTransporte({
        empresaId: emp.id,
        db,
        deps,
        enviarAutorizacao: async () => {
          enviarChamado = true;
          return { success: true };
        }
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EXPIRADO
    );
    assert.strictEqual(enviarChamado, false);
    await closeDb(db);
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }

  isolamento.comprobarSeCarregado();
  console.log(`\nResultado: ${passou} ok, ${falhou} falha(s)`);
  if (falhou > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
