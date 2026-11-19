/**
 * Sprint G1 — Cancelamento Operacional e Coluna RETIRADOS
 * Teste de integração: cancelamento por motivo, retirada, e renderização
 */
'use strict';

const assert = require('assert');
const path = require('path');

// Isolamento de banco de testes
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_ALLOW_OFFICIAL_DB = '';

const db = require(path.resolve(__dirname, '../../backend/database'));
const { garantirSchemaCozinha } = require(path.resolve(__dirname, '../../backend/utils/cozinhaSchema'));
const CozinhaPreparacaoService = require(path.resolve(__dirname, '../../backend/services/cozinha/CozinhaPreparacaoService'));
const CozinhaKdsPainelService = require(path.resolve(__dirname, '../../backend/services/cozinha/CozinhaKdsPainelService'));

describe('Sprint G1 — Cancelamento e Retirados', () => {
  const empresaId = 1;
  const unidadeId = 100;
  const operadorId = 999;

  before(async () => {
    await garantirSchemaCozinha({ db });
  });

  describe('Cancelamento — Validação de Motivos', () => {
    it('Cancelar com motivo PRAZO_EXCEDIDO', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);

      const result = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'PRAZO_EXCEDIDO',
        cancelamento_justificativa: null,
        empresaId,
        unidadeId,
        operadorId,
        idempotency_key: `teste-${rodada.id}-prazo-${Date.now()}`
      }, { db });

      assert.strictEqual(result.success, true, 'Cancelamento deve suceder');
      assert.strictEqual(result.rodada.estado_preparacao, 'CANCELADA');
      assert.strictEqual(result.rodada.cancelamento_motivo, 'PRAZO_EXCEDIDO');
    });

    it('Cancelar com motivo CLIENTE_DESISTIU', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);

      const result = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'CLIENTE_DESISTIU',
        cancelamento_justificativa: null,
        empresaId,
        unidadeId,
        operadorId,
        idempotency_key: `teste-${rodada.id}-cliente-${Date.now()}`
      }, { db });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.rodada.cancelamento_motivo, 'CLIENTE_DESISTIU');
    });

    it('Cancelar com motivo OUTRO (exige justificativa)', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);
      const justificativa = 'Teste de cancelamento com justificativa';

      const result = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'OUTRO',
        cancelamento_justificativa: justificativa,
        empresaId,
        unidadeId,
        operadorId,
        idempotency_key: `teste-${rodada.id}-outro-${Date.now()}`
      }, { db });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.rodada.cancelamento_motivo, 'OUTRO');
      assert.strictEqual(result.rodada.cancelamento_justificativa, justificativa);
    });
  });

  describe('Cancelamento — Bloqueios de Segurança', () => {
    it('Bloquear cancelamento de rodada já retirada', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);

      // Simular retirada
      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE cozinha_rodadas SET retirada_estado = ?, retirada_em = ?, retirada_por = ? WHERE id = ?',
          ['RETIRADA', new Date().toISOString(), operadorId, rodada.id],
          (err) => err ? reject(err) : resolve()
        );
      });

      const result = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'CLIENTE_DESISTIU',
        cancelamento_justificativa: null,
        empresaId,
        unidadeId,
        operadorId,
        idempotency_key: `teste-${rodada.id}-bloqueio-retirada-${Date.now()}`
      }, { db });

      assert.strictEqual(result.success, false, 'Cancelamento de rodada retirada deve falhar');
      assert(result.erro, 'Deve retornar erro');
    });

    it('Rejeitar cancelamento sem motivo', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);

      const result = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: null,
        cancelamento_justificativa: null,
        empresaId,
        unidadeId,
        operadorId,
        idempotency_key: `teste-${rodada.id}-semMotivo-${Date.now()}`
      }, { db });

      assert.strictEqual(result.success, false, 'Cancelamento sem motivo deve falhar');
    });

    it('Exigir justificativa para motivo OUTRO', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);

      const result = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'OUTRO',
        cancelamento_justificativa: null,
        empresaId,
        unidadeId,
        operadorId,
        idempotency_key: `teste-${rodada.id}-outro-semJustif-${Date.now()}`
      }, { db });

      assert.strictEqual(result.success, false, 'OUTRO sem justificativa deve falhar');
    });

    it('Bloquear de outra empresa', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);

      const result = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'CLIENTE_DESISTIU',
        cancelamento_justificativa: null,
        empresaId: 999,
        unidadeId,
        operadorId,
        idempotency_key: `teste-${rodada.id}-empresa-${Date.now()}`
      }, { db });

      assert.strictEqual(result.success, false, 'Deve bloquear outra empresa');
    });

    it('Bloquear de outra unidade', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);

      const result = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'CLIENTE_DESISTIU',
        cancelamento_justificativa: null,
        empresaId,
        unidadeId: 999,
        operadorId,
        idempotency_key: `teste-${rodada.id}-unidade-${Date.now()}`
      }, { db });

      assert.strictEqual(result.success, false, 'Deve bloquear outra unidade');
    });
  });

  describe('Idempotência', () => {
    it('Cancelamento repetido com mesma chave', async () => {
      const rodada = await criarRodadaTeste(db, empresaId, unidadeId);
      const chave = `teste-idempotencia-${rodada.id}`;

      const result1 = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'CLIENTE_DESISTIU',
        cancelamento_justificativa: null,
        empresaId,
        unidadeId,
        operadorId,
        idempotency_key: chave
      }, { db });

      assert.strictEqual(result1.success, true, 'Primeiro cancelamento');

      const result2 = await CozinhaPreparacaoService.cancelarRodada({
        rodada_id: rodada.id,
        cancelamento_motivo: 'CLIENTE_DESISTIU',
        cancelamento_justificativa: null,
        empresaId,
        unidadeId,
        operadorId,
        idempotency_key: chave
      }, { db });

      assert.strictEqual(result2.success, true, 'Cancelamento repetido');
      assert.strictEqual(result2.repetida, true, 'Deve indicar repetição');
    });
  });
});

async function criarRodadaTeste(db, empresaId, unidadeId) {
  const rodadaId = Math.floor(Math.random() * 1000000) + 1;
  const itemId = Math.floor(Math.random() * 1000000) + 1;
  const comandaId = Math.floor(Math.random() * 1000000) + 1;
  const pedidoId = Math.floor(Math.random() * 1000000) + 1;
  const pedidoItemId = Math.floor(Math.random() * 1000000) + 1;
  const productoId = Math.floor(Math.random() * 1000000) + 1;

  // Inserir comanda
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO cozinha_comandas (id, empresa_id, numero_comanda, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [comandaId, empresaId, `CMD-${comandaId}`, new Date().toISOString(), new Date().toISOString()],
      (err) => err ? reject(err) : resolve()
    );
  });

  // Inserir rodada
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO cozinha_rodadas (
        id, empresa_id, unidade_id, numero_rodada, sequencia_global, estado_preparacao,
        retirada_estado, enviada_em, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rodadaId, empresaId, unidadeId, 1, rodadaId, 'AGUARDANDO',
        'PENDENTE', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()
      ],
      (err) => err ? reject(err) : resolve()
    );
  });

  // Inserir item
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO cozinha_itens (
        id, rodada_id, comanda_id, empresa_id, unidade_id, pedido_id, pedido_item_id,
        produto_id, produto_nome_snapshot, estado_preparacao, qty_solicitada_millis,
        tipo_item, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        itemId, rodadaId, comandaId, empresaId, unidadeId, pedidoId, pedidoItemId,
        productoId, 'Teste Produto', 'AGUARDANDO', 1000,
        'NORMAL', new Date().toISOString(), new Date().toISOString()
      ],
      (err) => err ? reject(err) : resolve()
    );
  });

  return {
    id: rodadaId,
    empresa_id: empresaId,
    unidade_id: unidadeId,
    estado_preparacao: 'AGUARDANDO',
    retirada_estado: 'PENDENTE',
    itens: [{ id: itemId }]
  };
}
