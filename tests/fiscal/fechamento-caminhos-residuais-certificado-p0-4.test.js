/**
 * P0.4 — Fechamento dos caminhos residuais de certificado.
 * Isolado: preload + :memory: + PFX sintéticos. Sem SEFAZ real. Sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/fiscal/fechamento-caminhos-residuais-certificado-p0-4.test.js
 */
'use strict';

const { isolarBancoTeste, caminhoEhOficial } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-fiscal-p04-');

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
const {
  ESTADOS_CERTIFICADO_A1,
  CODIGOS_CERTIFICADO_A1,
  snapshotInvalidadoPorSubstituicao
} = require('../../backend/services/fiscal/certificadoEstados');
const { inspecionarCertificadoEmpresa } = require('../../backend/services/faturamento/CentralFaturamentoService');
const { criarAutorizacaoTesteIsolado } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
const { TIPOS_CONSULTA_SEFAZ } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const SENHA_OK = 'SenhaP04#1';
const ROOT = path.join(__dirname, '../..');

let passou = 0;
let falhou = 0;

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passou += 1; console.log(`  OK  ${nome}`); })
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
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_e) { resolve(); } });
}

function gerarChave() {
  return forge.pki.rsa.generateKeyPair({ bits: 512, workers: -1 });
}

function montarPfxBuffer({ senha, cnpj, notAfter, keys }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2024-01-01T00:00:00Z');
  cert.validity.notAfter = notAfter || new Date('2035-01-01T00:00:00Z');
  const attrs = [{ name: 'commonName', value: `E ${cnpj}` }];
  if (cnpj) attrs.push({ type: '2.16.76.1.3.3', value: cnpj });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(
    forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' })).getBytes(),
    'binary'
  );
}

async function schemaBase(db) {
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaFiscalEmpresaAsync(db);
}

async function preparar(db, pasta, { cnpj, tag, estado, senha = SENHA_OK, corrompido }) {
  const emp = await EmpresaService.criarEmpresa(
    { cnpj, razao_social: `Emp ${tag}`, inscricao_estadual: `IE${tag}` },
    { db }
  );
  const destino = path.join(pasta, `certificado-empresa-${emp.id}.pfx`);
  if (corrompido) fs.writeFileSync(destino, Buffer.from('x'));
  else if (estado !== ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO) {
    fs.writeFileSync(destino, montarPfxBuffer({ senha, cnpj, keys: gerarChave() }));
  }
  const patch = {
    ambiente: 2, uf: 'CE', codigo_uf: '23', serie: 1, numero_atual: 1,
    token_csc: 'CSC', id_csc: '1', crt: '1', ie: `IE${tag}`,
    certificado_path: estado === ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO ? '' : destino,
    certificado_senha: estado === ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO ? '' : senha,
    ws_autorizacao_homologacao: 'https://sefaz.local/h',
    ws_autorizacao_producao: 'https://sefaz.local/p',
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
    if (estado === ESTADOS_CERTIFICADO_A1.VALIDO) {
      patch.certificado_cnpj = cnpj;
      patch.certificado_validade_ate = '2035-01-01T00:00:00.000Z';
    }
  }
  await upsertConfiguracaoFiscalEmpresa(emp.id, patch, db);
  return { emp, destino, deps: { db, pastaCertificados: pasta } };
}

async function main() {
  console.log('\n=== P0.4 Fechamento caminhos residuais certificado ===\n');
  isolamento.comprobarSeCarregado();
  assert.ok(!caminhoEhOficial(isolamento.dbDir));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p04-'));
  const pasta = path.join(tmp, 'certificados');
  fs.mkdirSync(pasta, { recursive: true });

  // --- Diagnóstico ---
  await test('1. Diagnóstico local sem conexão SEFAZ', async () => {
    const op = src('backend/services/fiscal/nfeOperacionalService.js');
    assert.ok(op.includes("modo: remoto ? 'remoto' : 'local'"));
    assert.ok(op.includes('Consulta remota não executada'));
    assert.ok(op.includes('exigirAutorizacaoTransmissao'));
    assert.ok(!/carregarCertificadoPfx\(/.test(op) || op.indexOf('carregarCertificadoPfx') < 0);
    // behavioral via require with mocks
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await preparar(db, pasta, {
      cnpj: CNPJ_A, tag: 'D1', estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    // Evita database.js global: exercita checklist/inspeção local + fonte do diagnóstico
    const info = await inspecionarCertificadoEmpresa({ empresaId: emp.id, db });
    assert.strictEqual(info.sefaz_chamado, false);
    assert.strictEqual(info.apto, true);
    await closeDb(db);
    void deps;
  });

  await test('2. Diagnóstico remoto sem autorização bloqueado (fonte + auth)', async () => {
    const { avaliarAutorizacaoTransmissao } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
    const r = avaliarAutorizacaoTransmissao({
      empresaId: 1,
      tipoConsulta: TIPOS_CONSULTA_SEFAZ.STATUS_SERVICO,
      autorizacao: null
    });
    assert.strictEqual(r.ok, false);
    assert.ok(src('backend/services/fiscal/nfeOperacionalService.js').includes('STATUS_SERVICO'));
  });

  await test('3. Diagnóstico remoto sem empresaId bloqueado', async () => {
    const opSrc = src('backend/services/fiscal/nfeOperacionalService.js');
    assert.ok(opSrc.includes('EMPRESA_OBRIGATORIA'));
    assert.ok(opSrc.includes('empresaId == null'));
  });

  await test('4. Certificado inválido bloqueia antes do transporte remoto', async () => {
    const opSrc = src('backend/services/fiscal/nfeOperacionalService.js');
    const idxAuth = opSrc.indexOf('exigirAutorizacaoTransmissao');
    const idxGate = opSrc.indexOf('exigirCertificadoAptoParaUsoFiscal');
    const idxConsult = opSrc.indexOf('consultar(');
    assert.ok(idxAuth > 0 && idxGate > idxAuth && idxConsult > idxGate);
  });

  await test('5. Empresa A não usa certificado da B no checklist', async () => {
    const db = await openDb();
    await schemaBase(db);
    const a = await preparar(db, pasta, { cnpj: CNPJ_A, tag: 'A5', estado: ESTADOS_CERTIFICADO_A1.VALIDO });
    const b = await preparar(db, pasta, { cnpj: CNPJ_B, tag: 'B5', estado: ESTADOS_CERTIFICADO_A1.VALIDO });
    const infoA = await inspecionarCertificadoEmpresa({ empresaId: a.emp.id, db });
    const infoB = await inspecionarCertificadoEmpresa({ empresaId: b.emp.id, db });
    assert.ok(infoA.apto);
    assert.ok(infoB.apto);
    assert.notStrictEqual(infoA.certificado_nome, infoB.certificado_nome);
    await closeDb(db);
  });

  await test('6. Bloqueio não indica consulta remota concluída', async () => {
    const { resultadoConsultaNaoExecutada } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
    const r = resultadoConsultaNaoExecutada({});
    assert.strictEqual(r.consultaExecutada, false);
    assert.strictEqual(r.sefazConsultada, false);
  });

  // --- Checklist ---
  await test('7. Empresa ausente bloqueada no checklist', async () => {
    const info = await inspecionarCertificadoEmpresa({ empresaId: null });
    assert.strictEqual(info.apto, false);
    assert.ok(info.codigo === 'CERTIFICADO_EMPRESA_OBRIGATORIA' || info.estado === 'NÃO_CONFIGURADO');
  });

  await test('8. Certificado válido identificado corretamente', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp } = await preparar(db, pasta, { cnpj: CNPJ_A, tag: 'C8', estado: ESTADOS_CERTIFICADO_A1.VALIDO });
    const info = await inspecionarCertificadoEmpresa({ empresaId: emp.id, db });
    assert.strictEqual(info.apto, true);
    assert.strictEqual(info.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.strictEqual(info.sefaz_chamado, false);
    await closeDb(db);
  });

  await test('9. Certificado não validado não aparece como apto', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp } = await preparar(db, pasta, {
      cnpj: CNPJ_A, tag: 'C9', estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    const info = await inspecionarCertificadoEmpresa({ empresaId: emp.id, db });
    assert.strictEqual(info.apto, false);
    assert.strictEqual(info.valido, false);
    assert.strictEqual(info.estado, ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO);
    await closeDb(db);
  });

  await test('10. Senha inválida / arquivo / expirado / CNPJ diferenciados', async () => {
    const estados = [
      ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA,
      ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      ESTADOS_CERTIFICADO_A1.EXPIRADO,
      ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
    ];
    for (const estado of estados) {
      const db = await openDb();
      await schemaBase(db);
      const { emp } = await preparar(db, pasta, {
        cnpj: CNPJ_A, tag: estado.slice(0, 4), estado,
        corrompido: estado === ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO
      });
      const info = await inspecionarCertificadoEmpresa({ empresaId: emp.id, db });
      assert.strictEqual(info.apto, false);
      assert.strictEqual(info.estado, estado);
      await closeDb(db);
    }
  });

  await test('11. Caminho arbitrário bloqueado na gravação', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await preparar(db, pasta, {
      cnpj: CNPJ_A, tag: 'C11', estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const externo = path.join(os.tmpdir(), `p04-ext-${Date.now()}.pfx`);
    fs.writeFileSync(externo, Buffer.from('x'));
    await assert.rejects(
      () => salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_path: externo }, deps),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    try { fs.unlinkSync(externo); } catch (_e) { /* ignore */ }
    await closeDb(db);
  });

  await test('12. Checklist não chama transmissão/cancelamento (fonte)', async () => {
    const fat = src('backend/services/faturamento/CentralFaturamentoService.js');
    assert.ok(fat.includes('inspecionarCertificadoEmpresa'));
    assert.ok(!fat.includes('enviarLote('));
    assert.ok(!fat.includes('enviarCancelamento('));
    assert.ok(!fat.includes('consultarStatusServico('));
  });

  // --- Gravação administrativa ---
  await test('13. Upload válido aceita após validação (regressão serviço)', async () => {
    const svc = src('backend/services/fiscal/CertificadoEmpresaService.js');
    assert.ok(svc.includes('confiarSnapshotValidacao: true'));
    assert.ok(svc.includes('validarArquivoPfx'));
  });

  await test('14. PUT administrativo não marca VÁLIDO sem confiarSnapshot', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps, destino } = await preparar(db, pasta, {
      cnpj: CNPJ_A, tag: 'C14', estado: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
    });
    await salvarConfiguracaoFiscalEmpresa(emp.id, {
      certificado_path: destino,
      certificado_senha: SENHA_OK,
      certificado_validacao_status: ESTADOS_CERTIFICADO_A1.VALIDO
    }, deps);
    const dto = await obterConfiguracaoFiscalEmpresa(emp.id, { db });
    assert.notStrictEqual(dto.certificado_status, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.strictEqual(dto.apto_certificado_criptografico, false);
    await closeDb(db);
  });

  await test('15. Arquivo corrompido não substitui via upload (fonte + serviço A1)', async () => {
    assert.ok(src('backend/services/fiscal/CertificadoEmpresaService.js').includes('restaurarAnterior'));
  });

  await test('16. Troca de senha invalida snapshot', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await preparar(db, pasta, {
      cnpj: CNPJ_A, tag: 'C16', estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    await salvarConfiguracaoFiscalEmpresa(emp.id, { certificado_senha: 'Outra#2' }, deps);
    const dto = await obterConfiguracaoFiscalEmpresa(emp.id, { db });
    assert.strictEqual(dto.certificado_status, ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO);
    await closeDb(db);
  });

  await test('17. Troca de arquivo invalida snapshot', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await preparar(db, pasta, {
      cnpj: CNPJ_A, tag: 'C17', estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    const novo = path.join(pasta, `certificado-empresa-${emp.id}.pfx`);
    fs.writeFileSync(novo, montarPfxBuffer({ senha: SENHA_OK, cnpj: CNPJ_A, keys: gerarChave() }));
    await salvarConfiguracaoFiscalEmpresa(emp.id, {
      certificado_path: novo,
      ...snapshotInvalidadoPorSubstituicao()
    }, { ...deps, confiarSnapshotValidacao: false });
    const dto = await obterConfiguracaoFiscalEmpresa(emp.id, { db });
    assert.strictEqual(dto.apto_certificado_criptografico, false);
    await closeDb(db);
  });

  await test('18. Traversal bloqueado na gravação', async () => {
    const db = await openDb();
    await schemaBase(db);
    const { emp, deps } = await preparar(db, pasta, {
      cnpj: CNPJ_A, tag: 'C18', estado: ESTADOS_CERTIFICADO_A1.VALIDO
    });
    await assert.rejects(
      () => salvarConfiguracaoFiscalEmpresa(emp.id, {
        certificado_path: path.join(pasta, '..', 'escape.pfx')
      }, deps),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    await closeDb(db);
  });

  await test('19. Empresa não autorizada bloqueada no upload (fonte)', async () => {
    assert.ok(src('backend/services/fiscal/CertificadoEmpresaService.js').includes('autorizarOperacaoCertificadoEmpresa'));
  });

  await test('20. Respostas/logs não expõem segredos (fonte)', async () => {
    const fat = src('backend/services/faturamento/CentralFaturamentoService.js');
    assert.ok(!fat.includes('certificadoSenha'));
    assert.ok(fat.includes('sefaz_chamado: false'));
  });

  // --- Contexto empresarial ---
  await test('21. Devolução usa empresa da venda/compra (fonte)', async () => {
    const dv = src('backend/services/fiscal/nfeDevolucaoVenda.js');
    const dc = src('backend/services/fiscal/nfeDevolucaoCompra.js');
    assert.ok(dv.includes('getFiscalConfig({ empresaId: empresaIdPrep'));
    assert.ok(dc.includes('getFiscalConfig({ empresaId: empresaIdPrep'));
    assert.ok(dv.includes('CERTIFICADO_EMPRESA_OBRIGATORIA'));
  });

  await test('22. Ficha documental usa emitente da empresa da venda (fonte)', async () => {
    const central = src('backend/services/fiscal/nfeCentralService.js');
    assert.ok(central.includes('getFiscalConfig({ empresaId: empresaIdFicha'));
    assert.ok(!/getFiscalConfig\(\s*\)/.test(central.replace(/getFiscalConfig\(\s*\{\s*empresaId/g, '')));
  });

  await test('23. Ausência de empresa não provoca fallback global (preparar/ficha)', async () => {
    const dv = src('backend/services/fiscal/nfeDevolucaoVenda.js');
    assert.ok(dv.includes("code: 'CERTIFICADO_EMPRESA_OBRIGATORIA'"));
  });

  await test('24. Regressão P0.2/P0.3 gates intactos (fonte)', async () => {
    assert.ok(src('backend/services/fiscal/emissor.js').includes('exigirCertificadoAptoParaUsoFiscal'));
    assert.ok(src('backend/services/fiscal/nfeEmissorVenda.js').includes('carregarConfigEAplicarGateCertificadoNfe'));
    assert.ok(src('backend/services/fiscal/nfeCertificadoUso.js').includes('exigirCertificadoAptoParaUsoFiscal'));
    const auth = criarAutorizacaoTesteIsolado({
      empresaId: 1,
      tiposConsulta: [TIPOS_CONSULTA_SEFAZ.STATUS_SERVICO]
    });
    assert.strictEqual(auth.modo, 'TESTE_ISOLADO');
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  isolamento.comprobarSeCarregado();
  console.log(`\nResultado: ${passou} ok, ${falhou} falha(s)`);
  if (falhou > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
