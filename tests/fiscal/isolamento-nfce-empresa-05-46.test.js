/**
 * Sprint 05.46 — Isolamento NFC-e, certificado e CSC por empresa da venda.
 * Executar: node tests/fiscal/isolamento-nfce-empresa-05-46.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  upsertConfiguracaoFiscalEmpresa,
  garantirSchemaFiscalEmpresaAsync,
  incrementaNumeroFiscalEmpresa
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { getFiscalConfig, incrementaNumeroFiscal } = require('../../backend/services/fiscal/configService');
const {
  resolverEmpresaFiscalDaVenda,
  exigirContextoFiscalDaEmpresa,
  resolverCredenciaisNfceDaEmpresa,
  obterCertificadoDaEmpresa,
  mensagemErroFiscalSanitizada
} = require('../../backend/services/fiscal/FiscalEmpresaContextoService');
const { emitirPorVendaId } = require('../../backend/services/fiscal/emissor');
const cancelarNfce = require('../../backend/services/fiscal/cancelarNfce');
const { exigirCaixaCompativelComVenda } = require('../../backend/services/vendas/VendaEmpresaContextoService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
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
    const conn = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(conn)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE configuracoes (
    chave TEXT PRIMARY KEY, valor TEXT, tipo TEXT, descricao TEXT, updated_at DATETIME
  )`);
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES
    ('fiscal_ambiente', '1'),
    ('fiscal_serie', '9'),
    ('fiscal_numero_atual', '1'),
    ('fiscal_token_csc', 'CSC-GLOBAL-SECRETO'),
    ('fiscal_id_csc', '99'),
    ('fiscal_certificado_path', 'C:/certs/global.pfx'),
    ('fiscal_certificado_senha', 'senha-global'),
    ('fiscal_ws_autorizacao_producao', 'https://global.local/auth'),
    ('cnpj', '00000000000000')
  `);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT,
    empresa_id INTEGER,
    status_pagamento TEXT DEFAULT 'quitada',
    valor_fiscal REAL DEFAULT 10,
    cliente_id INTEGER
  )`);
  await run(db, `CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, cpf_cnpj TEXT)`);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, nome TEXT, ncm TEXT, cfop TEXT, csosn TEXT,
    origem TEXT, cest TEXT, codigo_barras TEXT, unidade TEXT,
    produto_fracionado INTEGER, vendido_por_peso INTEGER
  )`);
  await run(db, `CREATE TABLE vendas_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, produto_id INTEGER,
    quantidade REAL, quantidade_fiscal REAL, valor_fiscal REAL, preco_unitario REAL
  )`);
  await run(db, `CREATE TABLE venda_recebimentos (id INTEGER PRIMARY KEY, venda_id INTEGER, forma_pagamento TEXT, valor REAL, tipo_recebimento TEXT, tef_transacao_id INTEGER, nsu TEXT, autorizacao TEXT, status TEXT)`);
  await run(db, `CREATE TABLE venda_pagamentos (id INTEGER PRIMARY KEY, venda_id INTEGER, forma_pagamento TEXT, valor REAL)`);
  await run(db, `CREATE TABLE tef_transacoes (id INTEGER PRIMARY KEY, venda_id INTEGER)`);
  await run(db, `CREATE TABLE nfce_notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, numero INTEGER, serie INTEGER, chave_acesso TEXT,
    ambiente INTEGER, status TEXT, empresa_id INTEGER, xml_retorno TEXT, protocolo TEXT
  )`);
  await garantirSchemaFiscalEmpresaAsync(db);
  return db;
}

function cfg(tag, extra = {}) {
  return {
    ambiente: tag === 'A' ? 2 : 1,
    uf: 'CE',
    codigo_uf: '23',
    serie: tag === 'A' ? 1 : 2,
    numero_atual: extra.numero_atual != null ? extra.numero_atual : (tag === 'A' ? 100 : 500),
    token_csc: extra.token_csc !== undefined ? extra.token_csc : `CSC-${tag}-SECRETO`,
    id_csc: extra.id_csc !== undefined ? extra.id_csc : (tag === 'A' ? '1' : '2'),
    certificado_path: extra.certificado_path !== undefined ? extra.certificado_path : `C:/certs/${tag}.pfx`,
    certificado_senha: extra.certificado_senha !== undefined ? extra.certificado_senha : `senha-${tag}`,
    crt: '1',
    ie: `IE${tag}`,
    ws_autorizacao_homologacao: `https://sefaz.local/${tag}/h/auth`,
    ws_autorizacao_producao: `https://sefaz.local/${tag}/p/auth`,
    csc_qrcode_url_homologacao: `https://qr.local/${tag}/h`,
    csc_qrcode_url_producao: `https://qr.local/${tag}/p`,
    consulta_chave_url_homologacao: `https://ch.local/${tag}/h`,
    consulta_chave_url_producao: `https://ch.local/${tag}/p`
  };
}

async function seedEmpresas(db) {
  const a = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_A, razao_social: 'Empresa A', inscricao_estadual: 'IEA' },
    { db }
  );
  const b = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_B, razao_social: 'Empresa B', inscricao_estadual: 'IEB' },
    { db }
  );
  return { a, b };
}

async function t01ConfigA() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A'), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B'), db);
  const emp = resolverEmpresaFiscalDaVenda({ venda: { id: 1, empresa_id: a.id } });
  const cred = await resolverCredenciaisNfceDaEmpresa({ empresaId: emp, db });
  assert.strictEqual(Number(cred.empresaId), Number(a.id));
  assert.strictEqual(cred.csc, 'CSC-A-SECRETO');
  assert.notStrictEqual(cred.csc, 'CSC-B-SECRETO');
  assert.notStrictEqual(cred.csc, 'CSC-GLOBAL-SECRETO');
  db.close();
}

async function t02ConfigB() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A'), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B'), db);
  const emp = resolverEmpresaFiscalDaVenda({ venda: { id: 2, empresa_id: b.id } });
  const cred = await resolverCredenciaisNfceDaEmpresa({ empresaId: emp, db });
  assert.strictEqual(Number(cred.empresaId), Number(b.id));
  assert.strictEqual(cred.csc, 'CSC-B-SECRETO');
  db.close();
}

async function t03CertANaoUsadoPorB() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A'), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B'), db);
  const certB = await obterCertificadoDaEmpresa({ empresaId: b.id, db });
  assert.ok(String(certB.certificadoPath).includes('B.pfx'));
  assert.ok(!String(certB.certificadoPath).includes('A.pfx'));
  db.close();
}

async function t04CscANaoUsadoPorB() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A'), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B'), db);
  const credB = await resolverCredenciaisNfceDaEmpresa({ empresaId: b.id, db });
  assert.notStrictEqual(credB.csc, 'CSC-A-SECRETO');
  db.close();
}

async function t05AmbienteNaoContamina() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A'), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B'), db);
  const credA = await resolverCredenciaisNfceDaEmpresa({ empresaId: a.id, db });
  const credB = await resolverCredenciaisNfceDaEmpresa({ empresaId: b.id, db });
  assert.strictEqual(Number(credA.ambiente), 2);
  assert.strictEqual(Number(credB.ambiente), 1);
  db.close();
}

async function t06NumeracaoNaoUsaGlobal() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A', { numero_atual: 100 }), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B', { numero_atual: 500 }), db);
  await run(db, `INSERT INTO nfce_notas (venda_id, numero, serie, ambiente, status, empresa_id) VALUES (1, 100, 1, 2, 'autorizada', ?)`, [a.id]);
  await run(db, `INSERT INTO nfce_notas (venda_id, numero, serie, ambiente, status, empresa_id) VALUES (2, 500, 2, 1, 'autorizada', ?)`, [b.id]);
  const nA = await incrementaNumeroFiscal({ empresaId: a.id, db });
  const nB = await incrementaNumeroFiscal({ empresaId: b.id, db });
  assert.ok(nA < 200, `A não deve seguir a sequência global/B: ${nA}`);
  assert.ok(nB >= 500, `B deve seguir a própria sequência: ${nB}`);
  assert.notStrictEqual(nA, nB);
  db.close();
}

function t07ContextoBEmitirVendaA() {
  assert.throws(
    () => resolverEmpresaFiscalDaVenda({
      venda: { id: 1, empresa_id: 2 },
      empresaIdContexto: 3
    }),
    (err) => err.code === 'VENDA_NAO_ENCONTRADA' && err.statusCode === 404
  );
}

async function t08ContextoBCancelarVendaA() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A'), db);
  const venda = await run(db, `INSERT INTO vendas (codigo, empresa_id) VALUES ('A1', ?)`, [a.id]);
  let configChamada = null;
  await assert.rejects(
    () => cancelarNfce(venda.lastID, 'Cancelamento teste 123', {
      db,
      empresaIdContexto: b.id,
      getFiscalConfig: async (opts) => {
        configChamada = opts;
        return getFiscalConfig({ ...opts, db });
      }
    }),
    (err) => err.code === 'VENDA_NAO_ENCONTRADA' && err.statusCode === 404
  );
  assert.strictEqual(configChamada, null);
  db.close();
}

async function t09NullNaoConsomeNumero() {
  const db = await criarDb();
  await seedEmpresas(db);
  const venda = await run(db, `INSERT INTO vendas (codigo, empresa_id, status_pagamento) VALUES ('L1', NULL, 'quitada')`);
  const antes = await get(db, `SELECT valor FROM configuracoes WHERE chave = 'fiscal_numero_atual'`);
  await assert.rejects(
    () => emitirPorVendaId(venda.lastID, { db }),
    (err) => err.code === 'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const depois = await get(db, `SELECT valor FROM configuracoes WHERE chave = 'fiscal_numero_atual'`);
  assert.strictEqual(String(depois.valor), String(antes.valor));
  db.close();
}

async function t10NullNaoTransmite() {
  const db = await criarDb();
  await seedEmpresas(db);
  const venda = await run(db, `INSERT INTO vendas (codigo, empresa_id) VALUES ('L2', NULL)`);
  let configChamada = null;
  await assert.rejects(
    () => emitirPorVendaId(venda.lastID, {
      db,
      getFiscalConfig: async (opts) => {
        configChamada = opts;
        return getFiscalConfig({ ...opts, db });
      }
    }),
    (err) => err.code === 'EMPRESA_OWNERSHIP_REQUIRED'
  );
  assert.strictEqual(configChamada, null);
  db.close();
}

async function t11ConfigAusenteSemFallback() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await assert.rejects(
    () => exigirContextoFiscalDaEmpresa({ empresaId: a.id, db }),
    (err) => err.code === 'CONFIGURACAO_FISCAL_NAO_ENCONTRADA' || err.code === 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE'
  );
  const global = await getFiscalConfig({ db, validarUrls: false });
  assert.strictEqual(global.fonte, 'GLOBAL');
  assert.strictEqual(global.tokenCSC, 'CSC-GLOBAL-SECRETO');
  db.close();
}

async function t12CertAusenteNaoPegaOutro() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A', { certificado_path: '' }), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B'), db);
  await assert.rejects(
    () => obterCertificadoDaEmpresa({ empresaId: a.id, db }),
    (err) => err.code === 'CONFIGURACAO_FISCAL_NAO_ENCONTRADA' || err.code === 'CONFIGURACAO_FISCAL_EMPRESA_INCOMPLETA'
  );
  const certB = await obterCertificadoDaEmpresa({ empresaId: b.id, db });
  assert.ok(String(certB.certificadoPath).includes('B.pfx'));
  db.close();
}

async function t13CscAusenteSemFallback() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A', { token_csc: '' }), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B'), db);
  await assert.rejects(
    () => resolverCredenciaisNfceDaEmpresa({ empresaId: a.id, db }),
    (err) => err.code === 'CONFIGURACAO_FISCAL_EMPRESA_INCOMPLETA'
  );
  const credB = await resolverCredenciaisNfceDaEmpresa({ empresaId: b.id, db });
  assert.strictEqual(credB.csc, 'CSC-B-SECRETO');
  db.close();
}

async function t14CancelamentoUsaEmpresaDaVenda() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A'), db);
  const venda = await run(db, `INSERT INTO vendas (codigo, empresa_id) VALUES ('A-CAN', ?)`, [a.id]);
  await run(db, `INSERT INTO nfce_notas (venda_id, numero, serie, chave_acesso, ambiente, status, empresa_id, xml_retorno, protocolo)
    VALUES (?, 1, 1, '23260111222333000181650010000000011000000010', 2, 'autorizada', ?, '<cStat>100</cStat>', '123')`, [venda.lastID, a.id]);
  const ids = [];
  await assert.rejects(
    () => cancelarNfce(venda.lastID, 'Cancelamento teste 123', {
      db,
      getFiscalConfig: async (opts) => {
        ids.push(opts.empresaId);
        return getFiscalConfig({ ...opts, db });
      },
      carregarCertificadoPfx: () => {
        throw new Error('PFX_MOCK');
      }
    }),
    (err) => String(err.message).includes('PFX_MOCK')
  );
  assert.ok(ids.length > 0);
  assert.ok(ids.every((id) => Number(id) === Number(a.id)));
  db.close();
}

function t15CruzadoBloqueado() {
  assert.throws(
    () => resolverEmpresaFiscalDaVenda({
      venda: { id: 9, empresa_id: 1 },
      empresaIdContexto: 2
    }),
    (err) => err.code === 'VENDA_NAO_ENCONTRADA'
  );
}

async function t16FluxoA() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A'), db);
  const cred = await resolverCredenciaisNfceDaEmpresa({ empresaId: a.id, db });
  assert.strictEqual(cred.fonte, 'EMPRESA');
  assert.strictEqual(Number(cred.serie), 1);
  db.close();
}

async function t17FluxoB() {
  const db = await criarDb();
  const { b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B'), db);
  const cred = await resolverCredenciaisNfceDaEmpresa({ empresaId: b.id, db });
  assert.strictEqual(cred.fonte, 'EMPRESA');
  assert.strictEqual(Number(cred.serie), 2);
  db.close();
}

function t18RegressaoEmissaoFonte() {
  const emissor = src('backend/services/fiscal/emissor.js');
  const cancel = src('backend/services/fiscal/cancelarNfce.js');
  assert.ok(emissor.includes('exigirEmpresaFiscalDaVenda'));
  assert.ok(emissor.includes('resolverCredenciaisNfceDaEmpresa'));
  assert.ok(!/getFiscalConfig\(\s*\)/.test(emissor));
  assert.ok(!/getFiscalConfig\(\s*\)/.test(cancel));
  assert.ok(cancel.includes('exigirEmpresaFiscalDaVenda'));
}

function t19RegressaoCancelamentoFonte() {
  const fiscal = src('backend/rotas/fiscal.js');
  const svc = src('backend/services/vendas/VendaFiscalService.js');
  assert.ok(fiscal.includes('empresaIdContexto: req.empresaId'));
  assert.ok(svc.includes('empresaIdContexto'));
  assert.ok(fiscal.includes('anexarEmpresaFiscal'));
}

function t20SegredoNaoApareceNoLog() {
  const err = new Error('falha csc=CSC-A-SECRETO senha=abc certificadoSenha=xyz');
  const msg = mensagemErroFiscalSanitizada(err);
  assert.ok(!msg.includes('CSC-A-SECRETO'));
  assert.ok(!msg.includes('senha=abc'));
  assert.doesNotThrow(() => exigirCaixaCompativelComVenda(
    { caixaSessao: { id: 1, empresa_id: 2 } },
    2
  ));
}

async function t21NumeracaoIsoladaAB() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await upsertConfiguracaoFiscalEmpresa(a.id, cfg('A', { numero_atual: 100 }), db);
  await upsertConfiguracaoFiscalEmpresa(b.id, cfg('B', { numero_atual: 500 }), db);
  const nA = await incrementaNumeroFiscalEmpresa(a.id, db);
  const nB = await incrementaNumeroFiscalEmpresa(b.id, db);
  assert.strictEqual(nA, 100);
  assert.strictEqual(nB, 500);
  db.close();
}

async function main() {
  const testes = [
    ['T01 venda A resolve config A', t01ConfigA],
    ['T02 venda B resolve config B', t02ConfigB],
    ['T03 certificado A não usado por B', t03CertANaoUsadoPorB],
    ['T04 CSC A não usado por B', t04CscANaoUsadoPorB],
    ['T05 ambiente A não contamina B', t05AmbienteNaoContamina],
    ['T06 numeração não busca config global', t06NumeracaoNaoUsaGlobal],
    ['T07 contexto B emitir venda A = 404', t07ContextoBEmitirVendaA],
    ['T08 contexto B cancelar venda A = 404', t08ContextoBCancelarVendaA],
    ['T09 legado NULL não consome numeração', t09NullNaoConsomeNumero],
    ['T10 legado NULL não transmite', t10NullNaoTransmite],
    ['T11 config ausente sem fallback global', t11ConfigAusenteSemFallback],
    ['T12 certificado ausente não pega o de outra', t12CertAusenteNaoPegaOutro],
    ['T13 CSC ausente sem fallback', t13CscAusenteSemFallback],
    ['T14 cancelamento usa empresa da venda', t14CancelamentoUsaEmpresaDaVenda],
    ['T15 configuração cruzada bloqueada', t15CruzadoBloqueado],
    ['T16 fluxo normal empresa A', t16FluxoA],
    ['T17 fluxo normal empresa B', t17FluxoB],
    ['T18 regressão emissão (fonte)', t18RegressaoEmissaoFonte],
    ['T19 regressão cancelamento (fonte)', t19RegressaoCancelamentoFonte],
    ['T20 segredo não aparece em log de erro', t20SegredoNaoApareceNoLog],
    ['T21 numeração A/B isolada', t21NumeracaoIsoladaAB]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    try {
      await fn();
      console.log(`OK  ${nome}`);
      ok += 1;
    } catch (err) {
      console.error(`FAIL ${nome}`);
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${ok}/${testes.length} cenários 05.46 OK`);
}

main();
