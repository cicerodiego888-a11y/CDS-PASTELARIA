'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Sprint 3.14 — autorização independente de Pedidos e Expedição', () => {
  let tempDir;
  let db;
  let configService;
  let PedidoOperacional;
  let FaturamentoService;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint314-'));
    process.env.DB_DIR = tempDir;

    configService = require('../../backend/services/configuracaoService');
    db = require('../../backend/database');
    await new Promise((resolve) => db.whenReady(resolve));

    PedidoOperacional = require('../../backend/services/pedido/PedidoOperacionalService');
    FaturamentoService = require('../../backend/services/faturamento/FaturamentoService');

    configService.saveConfig({
      tipoImplantacao: 'ERP_SEM_FISCAL',
      modoOperacao: 'LOCAL',
      habilitar_expedicao: false,
      habilitar_faturamento: false,
      modulo_pedidos: true
    });
  });

  after(async () => {
    if (db) {
      await new Promise((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
      });
    }
    delete process.env.DB_DIR;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('permite listar quando Pedidos está habilitado e Expedição está desligada', async () => {
    const recursos = configService.getRecursos().recursos;
    assert.equal(recursos.pedidos, true);
    assert.equal(recursos.expedicao, false);

    const resultado = await PedidoOperacional.listar({ empresaId: 1 });
    assert.equal(resultado.success, true);
    assert.deepEqual(resultado.itens, []);
  });

  it('bloqueia a listagem quando Pedidos está desligado', async () => {
    configService.saveConfig({ modulo_pedidos: false });

    await assert.rejects(
      PedidoOperacional.listar({ empresaId: 1 }),
      (err) => err.statusCode === 403 && err.codigo === 'MODULO_NAO_LICENCIADO'
    );
  });

  it('mantém operações de faturamento bloqueadas quando Expedição está desligada', async () => {
    configService.saveConfig({
      modulo_pedidos: true,
      habilitar_expedicao: false,
      habilitar_faturamento: false
    });

    await assert.rejects(
      PedidoOperacional.enviarParaFaturamento(1, {}, null, { empresaId: 1 }),
      (err) => err.statusCode === 404 && err.codigo === 'MODULO_FATURAMENTO_DESABILITADO'
    );
    await assert.rejects(
      FaturamentoService.faturarPedido(0),
      (err) => err.statusCode === 404 && err.codigo === 'MODULO_FATURAMENTO_DESABILITADO'
    );
  });

  it('preserva Pedidos e Expedição habilitados simultaneamente', async () => {
    configService.saveConfig({
      modulo_pedidos: true,
      habilitar_expedicao: true,
      habilitar_faturamento: true
    });

    const recursos = configService.getRecursos().recursos;
    assert.equal(recursos.pedidos, true);
    assert.equal(recursos.expedicao, true);
    assert.equal((await PedidoOperacional.listar({ empresaId: 1 })).success, true);

    await assert.rejects(
      FaturamentoService.faturarPedido(0),
      (err) => err.statusCode === 400 && err.message === 'Pedido inválido.'
    );
  });
});
