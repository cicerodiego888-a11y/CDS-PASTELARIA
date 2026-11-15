/**
 * Pedido salvo sem mesa, depois editado com mesa → ocupa a mesa.
 * Executar: node --test --test-concurrency=1 tests/pedidos/atribuir-mesa-na-edicao.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mesa-edicao-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const MesaService = require('../../backend/services/pedido/MesaService');
const MesaAtendimentoService = require('../../backend/services/pedido/MesaAtendimentoService');
const PedidoOperacional = require('../../backend/services/pedido/PedidoOperacionalService');
const configService = require('../../backend/services/configuracaoService');

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

async function prepararBanco() {
  const db = require('../../backend/database');
  await new Promise((r) => db.whenReady(() => r()));
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaMesas(db);
  const empresa = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Mesa Edicao LTDA' },
    { db }
  );
  const prod = await run(
    db,
    `INSERT INTO produtos (nome, preco_venda, unidade, saldo_fiscal, estoque_atual)
     VALUES ('Pastel Edicao Mesa', 10, 'UN', 100, 100)`
  );
  await EstoqueEmpresaService.criarRegistro({
    produtoId: prod.lastID,
    empresaId: empresa.id,
    saldo_fiscal: 100,
    saldo_nao_fiscal: 0,
    estoque_atual: 100,
    reservado_fiscal: 0
  }, { db });
  const mesa = (await MesaService.criar(empresa.id, { numero: 1 }, { db })).mesa;
  return { db, empresaId: empresa.id, produtoId: prod.lastID, mesa };
}

describe('Atribuir mesa na edição do pedido', () => {
  it('pedido sem mesa, ao atualizar com mesa_id, vincula atendimento e ocupa a mesa', async () => {
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const { db, empresaId, produtoId, mesa } = await prepararBanco();
      const itens = [{
        produto_id: produtoId,
        quantidade: 1,
        preco_unitario: 10,
        desconto_percentual: 0,
        subtotal: 10
      }];

      const criado = await PedidoOperacional.criar(
        { itens, total: 10 },
        1,
        { empresaId, db }
      );
      assert.equal(criado.pedido.mesa_id, null);
      assert.equal(criado.pedido.mesa_atendimento_id, null);

      let situacao = await MesaAtendimentoService.consultarAtivo(empresaId, mesa.id, { db });
      assert.equal(situacao.situacao, 'LIVRE');

      await MesaAtendimentoService.abrir(
        empresaId,
        mesa.id,
        { operadorId: 1, idempotencyKey: 'idem-abrir-mesa-edicao-1' },
        { db }
      );

      const atualizado = await PedidoOperacional.atualizar(
        criado.pedido.id,
        { itens, total: 10, mesa_id: mesa.id },
        { empresaId, db }
      );

      assert.equal(Number(atualizado.pedido.mesa_id), Number(mesa.id));
      assert.ok(Number(atualizado.pedido.mesa_atendimento_id) > 0);

      situacao = await MesaAtendimentoService.consultarAtivo(empresaId, mesa.id, { db });
      assert.equal(situacao.situacao, 'OCUPADA');
      assert.equal(
        Number(situacao.atendimento.id),
        Number(atualizado.pedido.mesa_atendimento_id)
      );

      const prep = await get(
        db,
        'SELECT estado FROM pedido_preparacoes WHERE pedido_id = ?',
        [criado.pedido.id]
      );
      assert.equal(prep.estado, 'NAO_ENVIADO');
    } finally {
      configService.recursoHabilitado = original;
    }
  });

  it('UI chama garantir atendimento também na edição (não só na criação)', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/pedidos.js'),
      'utf8'
    );
    assert.match(ui, /Criação ou edição: atribuir mesa exige atendimento aberto/);
    assert.match(
      ui,
      /if \(payload\.mesa_id\) \{\s*await garantirAtendimentoAbertoParaNovoPedido\(payload\.mesa_id\);/
    );
    assert.doesNotMatch(ui, /if \(!pedidoEditandoId && payload\.mesa_id\)/);
  });
});
