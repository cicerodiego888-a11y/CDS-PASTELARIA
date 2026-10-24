/**
 * Testes — MIP Sprint 07 (Compras / XML / Central de Entradas)
 * Executar: npm run test:mip-sprint07
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const {
  garantirSchemaProdutoIdentificadores,
  ProdutoIdentificadoresService,
  EntradasProdutoIdentificacaoService,
  extrairCandidatosCodigo,
  setProdutoIdentidadeEnabled
} = require('../../backend/motores/produto-identidade');

const { enriquecerItensComMip } = require('../../backend/shared/nfe/enriquecerParseComMiip');

let passou = 0;
let falhou = 0;

function test(nome, fn) {
  return Promise.resolve()
    .then(() => fn())
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

function openDb(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function criarDb() {
  const file = path.join(os.tmpdir(), `mip-s07-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const db = await openDb(file);
  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(50) UNIQUE,
      nome VARCHAR(200) NOT NULL,
      codigo_barras TEXT,
      unidade TEXT,
      preco_venda DECIMAL(10,2) DEFAULT 0,
      ativo INTEGER DEFAULT 1
    )
  `);
  await new Promise((resolve, reject) => {
    garantirSchemaProdutoIdentificadores(db, (err) => (err ? reject(err) : resolve()));
  });
  return { db, file };
}

async function seedProduto(db, { codigo, nome, codigo_barras = null }) {
  const r = await run(
    db,
    'INSERT INTO produtos (codigo, nome, codigo_barras, unidade, preco_venda) VALUES (?, ?, ?, ?, ?)',
    [codigo, nome, codigo_barras, 'UN', 10]
  );
  const id = r.lastID;
  const sync = new ProdutoIdentificadoresService({ db });
  await sync.espelharCodigoEBarras(id, { codigo, codigo_barras });
  return id;
}

async function main() {
  console.log('\n=== MIP Sprint 07 — Compras / XML / Central ===\n');

  setProdutoIdentidadeEnabled(false);
  delete process.env.PRODUTO_IDENTIDADE_ENABLED;

  await test('extrairCandidatosCodigo — ordem barras → codigo → fornecedor', () => {
    const c = extrairCandidatosCodigo({
      codigo_barras: '7891234567890',
      codigo: 'INT-1',
      codigo_fornecedor: 'FORN-9',
      plu: '67'
    });
    assert.strictEqual(c[0], '7891234567890');
    assert.ok(c.includes('INT-1'));
    assert.ok(c.includes('67'));
    assert.ok(c.includes('FORN-9'));
  });

  await test('extrairCandidatosCodigo — ignora SEM GTIN e zeros', () => {
    const c = extrairCandidatosCodigo({
      codigo_barras: 'SEM GTIN',
      codigo: 'ABC',
      cEAN: '0000000000000'
    });
    assert.ok(!c.some((x) => /sem\s*gtin/i.test(x)));
    assert.ok(c.includes('ABC'));
  });

  await test('flag OFF → identificarItem modo legado', async () => {
    setProdutoIdentidadeEnabled(false);
    const svc = new EntradasProdutoIdentificacaoService({
      db: null,
      isEnabled: () => false
    });
    const r = await svc.identificarItem({ codigo_barras: '7891234567890' }, { origem: 'compras' });
    assert.strictEqual(r.habilitado, false);
    assert.strictEqual(r.modo, 'legado');
  });

  {
    const { db, file } = await criarDb();
    try {
      const id = await seedProduto(db, {
        codigo: 'P-MIP',
        nome: 'Via Identificadores',
        codigo_barras: null
      });
      const sync = new ProdutoIdentificadoresService({ db });
      await sync.espelharCodigoEBarras(id, {
        codigo: 'P-MIP',
        codigo_barras: '7899999999999'
      });
      await run(db, 'UPDATE produtos SET codigo_barras = NULL WHERE id = ?', [id]);

      setProdutoIdentidadeEnabled(true);
      const idGtinAlternativo = await seedProduto(db, {
        codigo: 'P-MIP-ALTERNATIVO',
        nome: 'Produto com GTIN alternativo',
        codigo_barras: '7891234567895'
      });

      await test('flag ON → identificarItem acha GTIN só em produto_identificadores', async () => {
        const svc = new EntradasProdutoIdentificacaoService({ db, isEnabled: () => true });
        const r = await svc.identificarItem(
          { codigo_barras: '7899999999999', produto_nome: 'X' },
          { origem: 'compras' }
        );
        assert.strictEqual(r.encontrado, true);
        assert.strictEqual(r.produtoId, id);
        assert.strictEqual(r.modo, 'mip');
      });

      await test('enriquecerItensComMip preenche produto_id em parse XML', async () => {
        const parsed = {
          itens: [
            {
              produto_nome: 'Item NF',
              codigo_barras: '7899999999999',
              codigo_fornecedor: 'X1'
            },
            {
              produto_nome: 'Sem match',
              codigo_barras: '1111111111111'
            }
          ]
        };
        const svc = new EntradasProdutoIdentificacaoService({ db, isEnabled: () => true });
        const mip = await enriquecerItensComMip(parsed, {
          entradasIdentificacao: svc,
          forcarMip: true,
          origem: 'xml_central'
        });
        assert.strictEqual(parsed.itens[0].produto_id, id);
        assert.ok(parsed.itens[0].mip_resultado);
        assert.ok(!parsed.itens[1].produto_id);
        assert.strictEqual(mip.aplicados, 1);
        assert.strictEqual(mip.tentados, 2);
      });

      await test('enriquecerItensComMip não sobrescreve produto_id existente', async () => {
        const parsed = {
          itens: [{ produto_id: 999, codigo_barras: '7899999999999' }]
        };
        const svc = new EntradasProdutoIdentificacaoService({ db, isEnabled: () => true });
        await enriquecerItensComMip(parsed, {
          entradasIdentificacao: svc,
          forcarMip: true
        });
        assert.strictEqual(parsed.itens[0].produto_id, 999);
      });

      await test('Central não usa cProd como identidade global de produto', async () => {
        const svc = new EntradasProdutoIdentificacaoService({ db, isEnabled: () => true });
        const r = await svc.identificarItem(
          { cProd: 'P-MIP', codigo_fornecedor: 'P-MIP', codigo_barras: 'SEM GTIN' },
          { origem: 'xml_central', fornecedor_cnpj: '12345678000199' }
        );
        assert.strictEqual(r.encontrado, false);
        assert.strictEqual(r.produtoId, null);
      });

      await test('GTIN/EAN inequívoco associa e GTINs conflitantes exigem revisão', async () => {
        const svc = new EntradasProdutoIdentificacaoService({ db, isEnabled: () => true });
        const inequivoco = await svc.identificarItem(
          { cEAN: '7899999999999', cEANTrib: '0000000000000' },
          { origem: 'xml_central' }
        );
        assert.strictEqual(inequivoco.encontrado, true);
        assert.strictEqual(inequivoco.produtoId, id);

        const ambiguo = await svc.identificarItem(
          { cEAN: '7899999999999', cEANTrib: '7891234567895' },
          { origem: 'xml_central' }
        );
        assert.strictEqual(ambiguo.encontrado, false);
        assert.strictEqual(ambiguo.ambiguidade, true);
        assert.deepStrictEqual(
          new Set(ambiguo.produtosCandidatos.map((c) => c.produtoId)),
          new Set([id, idGtinAlternativo])
        );
      });

      await test('ambiguidade MIP mantém item sem produto_id e cria pendência de revisão', async () => {
        const parsed = {
          itens: [{
            cEAN: '7899999999999',
            cEANTrib: '7891234567895',
            codigo_barras: '7899999999999'
          }]
        };
        const resultado = await require('../../backend/shared/nfe/enriquecerParseComMiip').enriquecerParseComMiip(
          parsed,
          {
            miipService: { processarImportacaoXml: async () => ({ resultados: [] }) },
            entradasIdentificacao: new EntradasProdutoIdentificacaoService({ db, isEnabled: () => true }),
            forcarMip: true,
            origem: 'xml_central'
          }
        );
        assert.strictEqual(resultado.possuiPendencias, true);
        assert.strictEqual(parsed.itens[0].produto_id, undefined);
        assert.strictEqual(parsed.itens[0].mip_resultado.ambiguidade, true);
      });

      await test('GTINs conflitantes revogam associação automática MIIP e exigem revisão', async () => {
        const parsed = {
          itens: [{
            cEAN: '7899999999999',
            cEANTrib: '7891234567895',
            codigo_barras: '7899999999999'
          }]
        };
        const resultado = await require('../../backend/shared/nfe/enriquecerParseComMiip').enriquecerParseComMiip(
          parsed,
          {
            miipService: {
              processarImportacaoXml: async () => ({
                resultados: [{
                  indice: 0,
                  associadoAutomaticamente: true,
                  precisaConfirmacao: false,
                  precisaCadastro: false,
                  produtoEncontrado: { id, nome: 'Via Identificadores' },
                  candidatos: [{ produtoId: id }],
                  motivos: []
                }],
                resumo: {
                  identificadosAutomaticamente: 1,
                  precisamConfirmacao: 0
                }
              })
            },
            entradasIdentificacao: new EntradasProdutoIdentificacaoService({ db, isEnabled: () => true }),
            forcarMip: true,
            origem: 'xml_central'
          }
        );
        assert.strictEqual(resultado.possuiPendencias, true);
        assert.strictEqual(parsed.itens[0].produto_id, undefined);
        assert.strictEqual(parsed.miip_importacao.resultados[0].associadoAutomaticamente, false);
        assert.strictEqual(parsed.miip_importacao.resultados[0].precisaConfirmacao, true);
        assert.strictEqual(parsed.miip_importacao.resumo.identificadosAutomaticamente, 0);
        assert.strictEqual(parsed.miip_importacao.resumo.precisamConfirmacao, 1);
        assert.deepStrictEqual(
          new Set(parsed.itens[0].mip_resultado.produtosCandidatos.map((c) => c.produtoId)),
          new Set([id, idGtinAlternativo])
        );
      });

      await test('flag OFF → enriquecerItensComMip noop', async () => {
        setProdutoIdentidadeEnabled(false);
        const parsed = { itens: [{ codigo_barras: '7899999999999' }] };
        const mip = await enriquecerItensComMip(parsed, {});
        assert.strictEqual(mip.aplicados, 0);
        assert.ok(!parsed.itens[0].produto_id);
        setProdutoIdentidadeEnabled(true);
      });

      await test('identificar por codigo interno do item', async () => {
        const svc = new EntradasProdutoIdentificacaoService({ db, isEnabled: () => true });
        const r = await svc.identificarItem({ codigo: 'P-MIP' }, { origem: 'compras' });
        assert.strictEqual(r.encontrado, true);
        assert.strictEqual(r.produtoId, id);
      });

      await test('compras router exporta helpers ensureProduct', () => {
        const compras = require('../../backend/rotas/compras');
        assert.strictEqual(typeof compras.ensureProductForItem, 'function');
        assert.strictEqual(typeof compras.ensureProductForItemLegado, 'function');
      });
    } finally {
      setProdutoIdentidadeEnabled(false);
      await closeDb(db);
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }

  console.log(`\nResultado: ${passou} ok, ${falhou} falha(s)\n`);
  if (falhou === 0) console.log('MIP Sprint 07 OK\n');
  process.exit(falhou > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
