'use strict';

const fs = require('fs');
const f = 'tests/cozinha/sprint05-operacoes-itens.test.js';
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.includes("it('isolamento entre unidades"));
const end = lines.findIndex((l, i) => i > start && l.includes("it('reutiliza"));
if (start < 0 || end < 0) {
  throw new Error(`markers start=${start} end=${end}`);
}

const replacement = `    it('homologação unidade — autorizada / outra / ausente / vazia / divergente / rollback / idempotência (3 ops)', async () => {
      const db = await open();
      await schemaErp(db);
      const infraA = await seedInfra(db, 1);
      const unidadeA = infraA.unidadeId;
      const unidadeBRow = await run(db, \`
        INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual)
        VALUES (1, 'U-B-HOM', 0)
      \`);
      const unidadeB = unidadeBRow.lastID;
      const infraB = { ...infraA, unidadeId: unidadeB };

      const pastelA = await despacharPastel(db, infraA, 's05-hom-a-pastel');
      const bebidaA = await despacharBebida(db, infraA, 's05-hom-a-beb', '2.000');
      const pastelB = await despacharPastel(db, infraB, 's05-hom-b-pastel');
      const bebidaB = await despacharBebida(db, infraB, 's05-hom-b-beb', '1.000');

      const iniOk = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: pastelA.itemId, idempotencyKey: 's05-hom-ok-ini'
      }, { db });
      assert.equal(iniOk.item.estado_preparacao, 'EM_PREPARACAO');

      const prontoOk = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: pastelA.itemId, idempotencyKey: 's05-hom-ok-pronto'
      }, { db });
      assert.equal(prontoOk.item.estado_preparacao, 'PRONTO');

      const bebOk = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: bebidaA.itemId, qty_entregue: '1.000',
        idempotencyKey: 's05-hom-ok-beb'
      }, { db });
      assert.equal(bebOk.success, true);

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: unidadeA,
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-cross-ini'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: unidadeA,
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-cross-pronto'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, unidade_id: unidadeA,
          itemId: bebidaB.itemId, qty_entregue: '1.000',
          idempotencyKey: 's05-hom-cross-beb'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7,
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-sem-ini'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7,
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-sem-pronto'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7,
          itemId: bebidaB.itemId, qty_entregue: '1.000',
          idempotencyKey: 's05-hom-sem-beb'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: '',
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-vazia-ini'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: '   ',
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-vazia-pronto'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, unidade_id: '',
          itemId: bebidaB.itemId, qty_entregue: '1.000',
          idempotencyKey: 's05-hom-vazia-beb'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );

      assert.throws(
        () => resolverUnidadeOperacionalReq({ user: { id: 7 }, body: {}, query: {} }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      assert.throws(
        () => resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: '' }, body: {}, query: {}
        }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      assert.throws(
        () => resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: unidadeA },
          body: { unidade_id: '' }, query: {}
        }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      assert.throws(
        () => resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: unidadeA },
          body: { unidade_id: unidadeB }, query: {}
        }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );
      assert.equal(
        resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: unidadeA },
          body: { unidade_id: unidadeA }, query: {}
        }),
        unidadeA
      );
      assert.equal(
        resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: unidadeA }, body: {}, query: {}
        }),
        unidadeA
      );

      const itemBAntes = await get(db, \`SELECT estado_preparacao FROM cozinha_itens WHERE id=?\`, [pastelB.itemId]);
      assert.equal(itemBAntes.estado_preparacao, 'AGUARDANDO');
      assert.equal((await all(db, \`SELECT * FROM cozinha_idempotencia WHERE idempotency_key='s05-hom-cross-ini'\`)).length, 0);
      assert.equal((await all(db, \`SELECT * FROM cozinha_eventos_outbox WHERE idempotency_key LIKE 's05-hom-cross%'\`)).length, 0);
      assert.equal((await all(db, \`SELECT * FROM cozinha_bebida_entregas WHERE cozinha_item_id=?\`, [bebidaB.itemId])).length, 0);

      const iniReplay = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: pastelA.itemId, idempotencyKey: 's05-hom-ok-ini'
      }, { db });
      assert.equal(iniReplay.repetida, true);
      const bebReplay = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: bebidaA.itemId, qty_entregue: '1.000',
        idempotencyKey: 's05-hom-ok-beb'
      }, { db });
      assert.equal(bebReplay.repetida, true);
      assert.equal((await all(db, \`SELECT id FROM cozinha_bebida_entregas WHERE cozinha_item_id=?\`, [bebidaA.itemId])).length, 1);

      await close(db);
    });
`;

const out = [...lines.slice(0, start), ...replacement.split('\n'), ...lines.slice(end)];
fs.writeFileSync(f, out.join('\n'));
console.log('replaced lines', start + 1, '-', end, '->', replacement.split('\n').length, 'lines');
