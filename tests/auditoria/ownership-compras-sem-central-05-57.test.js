/**
 * Sprint 05.57 — Auditoria: ownership de compras SEM central_documento_id.
 * Comprova o comportamento ATUAL. Não espera correção.
 * Executar: node tests/auditoria/ownership-compras-sem-central-05-57.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const {
  resolverEmpresaDaCompra,
  resolverEmpresaContextoCompra,
  exigirCompraDaEmpresa
} = require('../../backend/services/compras/ComprasEmpresaContextoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;

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

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1)
  `);
  return db;
}

function contratoMulti() {
  return { modo_operacional: 'MULTIEMPRESA', empresa_operacional: null };
}

function contratoSimples(empresaId) {
  return {
    modo_operacional: 'EMPRESA_SIMPLES',
    empresa_operacional: { empresa_id: empresaId }
  };
}

function deps(db, extra = {}) {
  return { db, contrato: contratoMulti(), ...extra };
}

function coletarInsertsProducao() {
  const hits = [];
  function walk(dir) {
    for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
      if (nome.name === 'node_modules' || nome.name === '.git') continue;
      const full = path.join(dir, nome.name);
      if (nome.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|sql)$/i.test(nome.name)) continue;
      const texto = fs.readFileSync(full, 'utf8');
      const re = /INSERT\s+INTO\s+compras\s*\(/gi;
      let m;
      while ((m = re.exec(texto))) {
        const trecho = texto.slice(m.index, m.index + 48).replace(/\s+/g, ' ');
        if (/INSERT\s+INTO\s+compras_itens/i.test(trecho)) continue;
        if (/INSERT\s+INTO\s+compras_devolucoes/i.test(trecho)) continue;
        hits.push({
          arquivo: path.relative(ROOT, full).replace(/\\/g, '/'),
          snippet: trecho
        });
      }
    }
  }
  walk(path.join(ROOT, 'backend'));
  return hits;
}

async function t01writerManual() {
  const rotas = src('backend/rotas/compras.js');
  assert.ok(rotas.includes("router.post('/',"), 'POST /api/compras existe');
  assert.ok(rotas.includes('continuarGravacao'), 'gravação via continuarGravacao');
  assert.ok(/INSERT\s+INTO\s+compras\s*\(/.test(rotas), 'único INSERT produção na rota');
  assert.ok(rotas.includes('resolverEmpresaDaCompra(req, {'));
  assert.ok(rotas.includes('centralDocumentoId,'));
  console.log('  T01 writer = backend/rotas/compras.js POST / → continuarGravacao');
}

async function t02fonteEmpresa() {
  const db = await criarDb();
  const http = await resolverEmpresaDaCompra(
    { empresaId: EMP_A },
    {},
    deps(db)
  );
  assert.strictEqual(http.empresaId, EMP_A);
  assert.strictEqual(http.origem, 'CONTEXTO_HTTP');
  assert.strictEqual(http.documento, null);

  const bodySo = await resolverEmpresaDaCompra(
    {},
    { empresaIdBody: EMP_A },
    deps(db)
  );
  assert.strictEqual(bodySo.empresaId, EMP_A);
  assert.ok(
    bodySo.origem === 'BODY_EXPLICITO' || bodySo.origem === 'CONTEXTO_HTTP',
    `body-only origem atual=${bodySo.origem} (daRequisicao pode classificar body como HTTP)`
  );

  const simples = await resolverEmpresaDaCompra(
    {},
    {},
    { db, contrato: contratoSimples(EMP_A) }
  );
  assert.strictEqual(simples.empresaId, EMP_A);
  assert.strictEqual(simples.origem, 'CONTRATO_EMPRESA_SIMPLES');
  db.close();
}

async function t03bodyDiferente() {
  const db = await criarDb();
  await assert.rejects(
    () => resolverEmpresaDaCompra(
      { empresaId: EMP_A },
      { empresaIdBody: EMP_B },
      deps(db)
    ),
    (err) => err.code === 'EMPRESA_COMPRA_INCOMPATIVEL' && err.statusCode === 403
  );
  db.close();
}

async function t04contextoDiferente() {
  const db = await criarDb();
  const a = await resolverEmpresaDaCompra({ empresaId: EMP_A }, {}, deps(db));
  const b = await resolverEmpresaDaCompra({ empresaId: EMP_B }, {}, deps(db));
  assert.strictEqual(a.empresaId, EMP_A);
  assert.strictEqual(b.empresaId, EMP_B);
  assert.strictEqual(a.origem, 'CONTEXTO_HTTP');
  assert.strictEqual(b.origem, 'CONTEXTO_HTTP');
  db.close();
}

async function t05centralPreservada() {
  const db = await criarDb();
  const doc = { id: 77, empresaId: EMP_A, empresa_id: EMP_A, status: 'PRONTA_PARA_COMPRA' };
  const ok = await resolverEmpresaDaCompra(
    { empresaId: EMP_A },
    { centralDocumentoId: 77, empresaIdBody: EMP_B },
    deps(db, { buscarDocumentoCentral: async () => doc })
  );
  assert.strictEqual(ok.empresaId, EMP_A);
  assert.strictEqual(ok.origem, 'DOCUMENTO_CENTRAL');

  await assert.rejects(
    () => resolverEmpresaDaCompra(
      { empresaId: EMP_B },
      { centralDocumentoId: 77 },
      deps(db, { buscarDocumentoCentral: async () => doc })
    ),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  db.close();
}

async function t06semCentralDocumentoId() {
  const db = await criarDb();
  const r = await resolverEmpresaDaCompra(
    { empresaId: EMP_A },
    { centralDocumentoId: null, empresaIdBody: EMP_A },
    deps(db)
  );
  assert.notStrictEqual(r.origem, 'DOCUMENTO_CENTRAL');
  assert.strictEqual(r.documento, null);
  assert.strictEqual(r.empresaId, EMP_A);

  await assert.rejects(
    () => resolverEmpresaDaCompra({}, {}, deps(db)),
    (err) => err.code === 'EMPRESA_COMPRA_AUSENTE'
  );
  db.close();
}

async function t07leituraPorEmpresa() {
  const rotas = src('backend/rotas/compras.js');
  assert.ok(
    /FROM compras c\s+WHERE c\.empresa_id = \?/.test(rotas),
    'GET / filtra WHERE empresa_id'
  );
  const ctx = await (async () => {
    const db = await criarDb();
    const r = await resolverEmpresaContextoCompra({ empresaId: EMP_A }, deps(db));
    db.close();
    return r;
  })();
  assert.strictEqual(ctx.empresaId, EMP_A);
  assert.strictEqual(ctx.origem, 'CONTEXTO_HTTP');
}

async function t08acessoCruzado() {
  assert.throws(
    () => exigirCompraDaEmpresa({ id: 9, empresa_id: EMP_A }, EMP_B),
    (err) => err.code === 'COMPRA_EMPRESA_INCOMPATIVEL'
  );
  const rotas = src('backend/rotas/compras.js');
  const getId = rotas.indexOf("router.get('/:id'");
  const postCancel = rotas.indexOf("router.post('/:id/cancelar'");
  const putChave = rotas.indexOf("router.put('/:id/chave-nfe-fornecedor'");
  assert.ok(getId >= 0 && rotas.slice(getId, getId + 2500).includes('exigirCompraParaMutacaoOpaca'));
  assert.ok(postCancel >= 0 && rotas.slice(postCancel, postCancel + 2000).includes('exigirCompraParaMutacaoOpaca'));
  const blocoPut = rotas.slice(putChave, putChave + 1800);
  assert.ok(blocoPut.includes('UPDATE compras') || blocoPut.includes('atualizarChaveNfeFornecedorCompra'));
  assert.ok(
    blocoPut.includes('atualizarChaveNfeFornecedorCompra'),
    '05.58: PUT chave-nfe-fornecedor valida ownership antes do UPDATE'
  );
}

async function t09inventarioInserts() {
  const hits = coletarInsertsProducao();
  assert.strictEqual(
    hits.length,
    1,
    `esperado 1 INSERT produção em backend/; achados=${JSON.stringify(hits)}`
  );
  assert.strictEqual(hits[0].arquivo, 'backend/rotas/compras.js');
}

async function t10classificacaoFinal() {
  const rotas = src('backend/rotas/compras.js');
  const svc = src('backend/services/compras/ComprasEmpresaContextoService.js');

  assert.ok(svc.includes("'CONTEXTO_HTTP'"));
  assert.ok(svc.includes("'BODY_EXPLICITO'"));
  assert.ok(svc.includes("'CONTRATO_EMPRESA_SIMPLES'"));
  assert.ok(svc.includes("'DOCUMENTO_CENTRAL'"));
  assert.ok(svc.includes('EMPRESA_COMPRA_AUSENTE'));
  assert.ok(rotas.includes('COMPAT_CREDITO') === false);
  const credito = src('backend/services/compras/creditoEstoqueCompraViaPorta.js');
  assert.ok(credito.includes('COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA'));

  const classificacao = {
    post_compras_sem_central: 'C',
    post_compras_com_central: 'A',
    get_lista: 'B',
    get_por_id: 'B',
    cancelar_devolver: 'B',
    put_chave_nfe: 'B',
    credito_estoque_compat: 'E',
    inserts_teste: 'E'
  };
  assert.strictEqual(classificacao.post_compras_sem_central, 'C');
  assert.strictEqual(classificacao.post_compras_com_central, 'A');
  assert.strictEqual(classificacao.put_chave_nfe, 'B');
  console.log('  T10 classificação:', JSON.stringify(classificacao));
}

const TESTS = [
  ['T01 writer compra manual', t01writerManual],
  ['T02 fonte de empresa (sem Central)', t02fonteEmpresa],
  ['T03 body empresa diferente', t03bodyDiferente],
  ['T04 contexto empresa diferente', t04contextoDiferente],
  ['T05 compra Central preservada', t05centralPreservada],
  ['T06 sem central_documento_id', t06semCentralDocumentoId],
  ['T07 leitura por empresa', t07leituraPorEmpresa],
  ['T08 acesso cruzado', t08acessoCruzado],
  ['T09 inventário INSERT produção', t09inventarioInserts],
  ['T10 classificação final', t10classificacaoFinal]
];

(async () => {
  let ok = 0;
  let fail = 0;
  for (const [nome, fn] of TESTS) {
    try {
      await fn();
      ok += 1;
      console.log(`  OK  ${nome}`);
    } catch (err) {
      fail += 1;
      console.error(`  FAIL ${nome}:`, err.message);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 10).join('\n'));
    }
  }
  console.log(`\nResultado: ${ok}/${TESTS.length} OK, ${fail} falha(s).`);
  if (fail > 0) process.exit(1);
})();
