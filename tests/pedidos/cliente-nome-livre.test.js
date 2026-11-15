/**
 * Nome do cliente no pedido sem cadastro prévio.
 * Executar: node --test --test-concurrency=1 tests/pedidos/cliente-nome-livre.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cliente-livre-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
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

describe('Cliente nome livre no pedido', () => {
  it('grava e lê nome digitado sem cliente_id', async () => {
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const db = require('../../backend/database');
      await new Promise((r) => db.whenReady(() => r()));
      await garantirSchemaEmpresasAsync(db);
      await garantirSchemaEstoqueEmpresaAsync(db);
      await run(db, 'ALTER TABLE pedidos ADD COLUMN cliente_nome TEXT').catch(() => {});

      const empresa = await EmpresaService.criarEmpresa(
        { cnpj: '11222333000181', razao_social: 'Cliente Livre LTDA' },
        { db }
      );
      const prod = await run(
        db,
        `INSERT INTO produtos (nome, preco_venda, unidade, saldo_fiscal, estoque_atual)
         VALUES ('Pastel Livre', 10, 'UN', 50, 50)`
      );
      await EstoqueEmpresaService.criarRegistro({
        produtoId: prod.lastID,
        empresaId: empresa.id,
        saldo_fiscal: 50,
        saldo_nao_fiscal: 0,
        estoque_atual: 50,
        reservado_fiscal: 0
      }, { db });

      const itens = [{
        produto_id: prod.lastID,
        quantidade: 1,
        preco_unitario: 10,
        desconto_percentual: 0,
        subtotal: 10
      }];

      const criado = await PedidoOperacional.criar({
        itens,
        total: 10,
        cliente_nome: 'Cicero Diego'
      }, 1, { empresaId: empresa.id, db });

      assert.equal(criado.pedido.cliente_id, null);
      assert.equal(criado.pedido.cliente_nome, 'Cicero Diego');

      const obtido = await PedidoOperacional.obter(criado.pedido.id, { empresaId: empresa.id, db });
      assert.equal(obtido.pedido.cliente_nome, 'Cicero Diego');
      assert.equal(obtido.pedido.cliente_id, null);
    } finally {
      configService.recursoHabilitado = original;
    }
  });

  it('UI envia cliente_nome digitado sem exigir cliente_id', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/pedidos.js'),
      'utf8'
    );
    assert.match(ui, /cliente_nome:\s*clienteNomeDigitado/);
    assert.match(ui, /Digite o nome \(cadastro opcional\)/);
    assert.match(ui, /Nome no pedido:/);
  });

  it('painel de mesas exibe cliente_nome em cada pedido e no cabeçalho do atendimento', () => {
    const painel = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/mesas-painel.js'),
      'utf8'
    );
    const prep = fs.readFileSync(
      path.join(__dirname, '../../backend/services/pedido/PedidoPreparacaoService.js'),
      'utf8'
    );
    assert.match(painel, /nomesClientesDosPedidos/);
    assert.match(painel, /Cliente \$\{escapar\(String\(pedido\.cliente_nome\)\.trim\(\)\)\}/);
    assert.match(prep, /cliente_nome/);
    assert.match(prep, /LEFT JOIN clientes c ON c\.id = p\.cliente_id/);
  });
});
