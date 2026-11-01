'use strict';

const { test } = require('node:test');
const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  salvarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa,
  upsertConfiguracaoFiscalEmpresa,
  selecionarCscParaEmissao,
  validarIdCsc,
  garantirSchemaFiscalEmpresaAsync
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { resolverCredenciaisNfceDaEmpresa } = require('../../backend/services/fiscal/FiscalEmpresaContextoService');
const { getFiscalConfig } = require('../../backend/services/fiscal/configService');
const { gerarQRCodeNFCe } = require('../../backend/services/fiscal/qrcode');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_NOVO = '38204469000115';
const TOKEN_HOM = 'CSC-HOM-SINTETICO';
const TOKEN_PROD = 'CSC-PROD-SINTETICO';
const TOKEN_B = 'CSC-B-SINTETICO';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
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

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_err) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE configuracoes (chave TEXT PRIMARY KEY, valor TEXT)`);
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_token_csc', 'CSC-GLOBAL-NAO-USAR')`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Empresa A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Empresa B' }, { db });
  return { db, a, b };
}

function base(extra) {
  return Object.assign({
    ambiente: 2,
    uf: 'CE',
    serie: 1,
    numero_atual: 1
  }, extra || {});
}

async function rejeita(fn, code) {
  await assert.rejects(fn, (err) => err && err.code === code);
}

test('homologação configurada seleciona somente o CSC de homologação', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    id_csc_homologacao: '7',
    token_csc_homologacao: TOKEN_HOM
  }), { db: ctx.db });
  const cred = await resolverCredenciaisNfceDaEmpresa({
    empresaId: ctx.a.id, db: ctx.db, validarUrls: false
  });
  assert.strictEqual(cred.idCsc, '7');
  assert.strictEqual(cred.csc, TOKEN_HOM);
  assert.strictEqual(cred.ambiente, 2);
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.strictEqual(dto.csc_homologacao_configurado, true);
  assert.strictEqual(dto.csc_producao_configurado, false);
  assert.ok(!JSON.stringify(dto).includes(TOKEN_HOM));
  await closeDb(ctx.db);
});

test('produção configurada seleciona somente o CSC de produção', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    ambiente: 1,
    id_csc_producao: '9',
    token_csc_producao: TOKEN_PROD
  }), { db: ctx.db });
  const cred = await resolverCredenciaisNfceDaEmpresa({
    empresaId: ctx.a.id, db: ctx.db, validarUrls: false
  });
  assert.strictEqual(cred.idCsc, '9');
  assert.strictEqual(cred.csc, TOKEN_PROD);
  assert.strictEqual(cred.ambiente, 1);
  await closeDb(ctx.db);
});

test('homologação sem CSC bloqueia a emissão', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    id_csc_producao: '9',
    token_csc_producao: TOKEN_PROD
  }), { db: ctx.db });
  await rejeita(
    () => resolverCredenciaisNfceDaEmpresa({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false }),
    'CSC_NAO_CONFIGURADO_PARA_AMBIENTE'
  );
  await closeDb(ctx.db);
});

test('produção sem CSC bloqueia a emissão', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    ambiente: 1,
    id_csc_homologacao: '7',
    token_csc_homologacao: TOKEN_HOM
  }), { db: ctx.db });
  await rejeita(
    () => resolverCredenciaisNfceDaEmpresa({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false }),
    'CSC_NAO_CONFIGURADO_PARA_AMBIENTE'
  );
  await closeDb(ctx.db);
});

test('ID CSC vazio ou inválido bloqueia e não assume 1', async () => {
  const ctx = await setup();
  await rejeita(
    () => salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
      id_csc_homologacao: 'abc',
      token_csc_homologacao: TOKEN_HOM
    }), { db: ctx.db }),
    'CSC_ID_INVALIDO'
  );
  await rejeita(
    () => salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
      id_csc_homologacao: '0',
      token_csc_homologacao: TOKEN_HOM
    }), { db: ctx.db }),
    'CSC_ID_INVALIDO'
  );
  await rejeita(
    () => salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
      id_csc_homologacao: ' 1',
      token_csc_homologacao: TOKEN_HOM
    }), { db: ctx.db }),
    'CSC_ID_INVALIDO'
  );
  assert.throws(() => validarIdCsc('', { obrigatorio: true }), (err) => err.code === 'CSC_NAO_CONFIGURADO_PARA_AMBIENTE');
  assert.throws(
    () => gerarQRCodeNFCe({
      chave: '23261165957340000150650010000010231577252107',
      ambiente: 2,
      idCSC: '',
      CSC: TOKEN_HOM,
      consultaUrl: 'https://qr.local/h'
    }),
    (err) => err.code === 'CSC_NAO_CONFIGURADO_PARA_AMBIENTE'
  );
  const row = await get(ctx.db, 'SELECT id_csc_homologacao FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.a.id]);
  assert.ok(!row || row.id_csc_homologacao == null);
  await closeDb(ctx.db);
});

test('token ausente bloqueia a emissão', async () => {
  const ctx = await setup();
  await rejeita(
    () => salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
      id_csc_homologacao: '7'
    }), { db: ctx.db }),
    'CSC_NAO_CONFIGURADO_PARA_AMBIENTE'
  );
  assert.throws(
    () => gerarQRCodeNFCe({
      chave: '23261165957340000150650010000010231577252107',
      ambiente: 2,
      idCSC: '7',
      CSC: '   ',
      consultaUrl: 'https://qr.local/h'
    }),
    (err) => err.code === 'CSC_NAO_CONFIGURADO_PARA_AMBIENTE'
  );
  await closeDb(ctx.db);
});

test('alteração de CNPJ invalida a associação anterior', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    id_csc_homologacao: '7',
    token_csc_homologacao: TOKEN_HOM,
    id_csc_producao: '9',
    token_csc_producao: TOKEN_PROD
  }), { db: ctx.db });
  const atualizada = await EmpresaService.atualizarEmpresa(ctx.a.id, {
    cnpj: CNPJ_NOVO,
    razao_social: 'Empresa A'
  }, { db: ctx.db });
  assert.strictEqual(atualizada.cscs_invalidados, true);
  assert.match(atualizada.cscs_mensagem, /invalidad/i);
  const row = await get(
    ctx.db,
    `SELECT token_csc, id_csc, token_csc_homologacao, id_csc_homologacao,
            token_csc_producao, id_csc_producao, csc_cnpj_vinculado
       FROM empresas_configuracao_fiscal WHERE empresa_id = ?`,
    [ctx.a.id]
  );
  assert.strictEqual(row.token_csc_homologacao, null);
  assert.strictEqual(row.token_csc_producao, null);
  assert.strictEqual(row.id_csc_homologacao, null);
  assert.strictEqual(row.id_csc_producao, null);
  assert.strictEqual(row.csc_cnpj_vinculado, null);
  await rejeita(
    () => resolverCredenciaisNfceDaEmpresa({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false }),
    'CSC_NAO_CONFIGURADO_PARA_AMBIENTE'
  );
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.ok(!JSON.stringify(dto).includes(TOKEN_HOM));
  assert.ok(!JSON.stringify(dto).includes(TOKEN_PROD));
  await closeDb(ctx.db);
});

test('atualização de outros campos preserva o CSC do mesmo CNPJ e ambiente', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    id_csc_homologacao: '000007',
    token_csc_homologacao: TOKEN_HOM
  }), { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { serie: 8, uf: 'CE' }, { db: ctx.db });
  const row = await get(
    ctx.db,
    'SELECT serie, token_csc_homologacao, id_csc_homologacao, csc_cnpj_vinculado FROM empresas_configuracao_fiscal WHERE empresa_id = ?',
    [ctx.a.id]
  );
  assert.strictEqual(Number(row.serie), 8);
  assert.strictEqual(row.token_csc_homologacao, TOKEN_HOM);
  assert.strictEqual(row.id_csc_homologacao, '7');
  assert.strictEqual(row.csc_cnpj_vinculado, CNPJ_A);
  const cred = await resolverCredenciaisNfceDaEmpresa({
    empresaId: ctx.a.id, db: ctx.db, validarUrls: false
  });
  assert.strictEqual(cred.csc, TOKEN_HOM);
  assert.strictEqual(cred.idCsc, '7');
  await closeDb(ctx.db);
});

test('duas empresas não misturam credenciais', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    id_csc_homologacao: '3',
    token_csc_homologacao: TOKEN_HOM
  }), { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, base({
    id_csc_homologacao: '4',
    token_csc_homologacao: TOKEN_B
  }), { db: ctx.db });
  const a = await resolverCredenciaisNfceDaEmpresa({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false });
  const b = await resolverCredenciaisNfceDaEmpresa({ empresaId: ctx.b.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(a.csc, TOKEN_HOM);
  assert.strictEqual(b.csc, TOKEN_B);
  assert.notStrictEqual(a.csc, b.csc);
  assert.strictEqual(a.idCsc, '3');
  assert.strictEqual(b.idCsc, '4');
  await closeDb(ctx.db);
});

test('CSC de homologação não é reutilizado em produção', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    id_csc_homologacao: '7',
    token_csc_homologacao: TOKEN_HOM
  }), { db: ctx.db });
  const empresa = await EmpresaService.buscarEmpresaPorId(ctx.a.id, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.a.id]);
  assert.throws(
    () => selecionarCscParaEmissao(row, empresa, 1),
    (err) => err.code === 'CSC_NAO_CONFIGURADO_PARA_AMBIENTE'
  );
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ambiente: 1 }, { db: ctx.db });
  const config = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false });
  assert.notStrictEqual(config.tokenCSC, TOKEN_HOM);
  assert.strictEqual(config.tokenCSC, '');
  assert.notStrictEqual(config.tokenCSC, 'CSC-GLOBAL-NAO-USAR');
  await closeDb(ctx.db);
});

test('CSC de produção não é reutilizado em homologação', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    ambiente: 1,
    id_csc_producao: '9',
    token_csc_producao: TOKEN_PROD
  }), { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ambiente: 2 }, { db: ctx.db });
  const config = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(config.tokenCSC, '');
  assert.notStrictEqual(config.tokenCSC, TOKEN_PROD);
  await closeDb(ctx.db);
});

test('tokens diferentes por ambiente selecionam somente o tpAmb efetivo', async () => {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, base({
    id_csc_homologacao: '7',
    token_csc_homologacao: TOKEN_HOM,
    id_csc_producao: '9',
    token_csc_producao: TOKEN_PROD
  }), { db: ctx.db });
  const empresa = await EmpresaService.buscarEmpresaPorId(ctx.a.id, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id = ?', [ctx.a.id]);
  const hom = selecionarCscParaEmissao(row, empresa, 2);
  const prod = selecionarCscParaEmissao(row, empresa, 1);
  assert.strictEqual(hom.tokenCSC, TOKEN_HOM);
  assert.strictEqual(hom.idCSC, '7');
  assert.strictEqual(prod.tokenCSC, TOKEN_PROD);
  assert.strictEqual(prod.idCSC, '9');
  assert.notStrictEqual(hom.tokenCSC, prod.tokenCSC);
  await closeDb(ctx.db);
});

test('CSC antigo e CSC global não entram na emissão', async () => {
  const ctx = await setup();
  await garantirSchemaFiscalEmpresaAsync(ctx.db);
  await upsertConfiguracaoFiscalEmpresa(ctx.a.id, base({
    token_csc: TOKEN_HOM,
    id_csc: 'ID-ANTIGO'
  }), ctx.db);
  const config = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false });
  assert.strictEqual(config.fonte, 'EMPRESA');
  assert.strictEqual(config.tokenCSC, '');
  assert.strictEqual(config.idCSC, '');
  assert.notStrictEqual(config.tokenCSC, 'CSC-GLOBAL-NAO-USAR');
  await rejeita(
    () => resolverCredenciaisNfceDaEmpresa({ empresaId: ctx.a.id, db: ctx.db, validarUrls: false }),
    'CSC_NAO_CONFIGURADO_PARA_AMBIENTE'
  );
  await closeDb(ctx.db);
});
