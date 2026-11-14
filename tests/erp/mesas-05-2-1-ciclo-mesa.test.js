/**
 * MESAS-05.2.1 — encerramento da mesa após a venda confirmada
 * e abertura direta do modal de novo pedido.
 *
 * Executar: node --test --test-concurrency=1 tests/erp/mesas-05-2-1-ciclo-mesa.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mesas0521-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const lancamento = require('../../frontend/erp/js/mesas-lancamento');
const painel = require('../../frontend/erp/js/mesas-painel');

function memoria() {
  const dados = new Map();
  return {
    setItem(chave, valor) { dados.set(chave, String(valor)); },
    getItem(chave) { return dados.has(chave) ? dados.get(chave) : null; }
  };
}

function consulta(situacao, atendimento) {
  return { mesa_id: 4, numero: 7, situacao, atendimento };
}

describe('modal de novo pedido', () => {
  it('abre o modal na mesa livre e na ocupada, e bloqueia fechamento', () => {
    const storage = memoria();
    lancamento.gravarLancamento(storage, { mesaId: 4, atendimentoId: 15, empresaId: 1 });
    assert.equal(lancamento.temIntencaoModal(storage, 1), true);
    const livre = lancamento.decidirAberturaModal(consulta('OCUPADA', { id: 15 }), { intencao: true });
    assert.equal(livre.abrirModal, true);
    assert.equal(livre.mesa_id, 4);
    assert.equal(livre.atendimento_id, 15);
    assert.equal(livre.sucesso, false);

    const ocupada = lancamento.decidirAberturaModal(consulta('OCUPADA', { id: 9 }), { intencao: true });
    assert.equal(ocupada.abrirModal, true);
    assert.equal(ocupada.atendimento_id, 9);

    const fechamento = lancamento.decidirAberturaModal(consulta('FECHAMENTO', { id: 10 }), { intencao: true });
    assert.equal(fechamento.abrirModal, false);
    assert.equal(fechamento.bloqueado, true);
    assert.match(fechamento.mensagem, /fechamento/);
  });

  it('não duplica modal, não cria pedido ao fechar e não reabre ao recarregar', () => {
    const storage = memoria();
    lancamento.gravarLancamento(storage, { mesaId: 4, atendimentoId: 15, empresaId: 1 });
    const duplicada = lancamento.decidirAberturaModal(
      consulta('OCUPADA', { id: 15 }),
      { intencao: true, modalAberto: true }
    );
    assert.equal(duplicada.abrirModal, false);
    assert.equal(duplicada.duplicada, true);

    assert.deepEqual(lancamento.efeitoDaAcaoModal('fechar'), { criarPedido: false, criarAtendimento: false });
    assert.deepEqual(lancamento.efeitoDaAcaoModal('recarregar'), { criarPedido: false, criarAtendimento: false });
    assert.deepEqual(lancamento.efeitoDaAcaoModal('salvar'), { criarPedido: true, criarAtendimento: false });

    lancamento.consumirIntencaoModal(storage);
    assert.equal(lancamento.temIntencaoModal(storage, 1), false);
    assert.equal(lancamento.lerLancamento(storage, 1).mesa_id, 4);
    const recarga = lancamento.decidirAberturaModal(consulta('OCUPADA', { id: 15 }), { intencao: false });
    assert.equal(recarga.abrirModal, false);
    assert.equal(recarga.sucesso, false);
  });

  it('trata falha de rede e preserva o pedido sem mesa', () => {
    const rede = lancamento.decidirAberturaModal(null, { rede: true, intencao: true });
    assert.equal(rede.abrirModal, false);
    assert.equal(rede.sucesso, false);
    assert.match(rede.mensagem, /Não foi possível confirmar/);

    const pedidos = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');
    const faturamento = fs.readFileSync(path.join(__dirname, '../../backend/services/faturamento/FaturamentoService.js'), 'utf8');
    const mobile = fs.readFileSync(path.join(__dirname, '../../frontend/mobile-pedido/mobile-pedido.js'), 'utf8');
    assert.match(pedidos, /decidirAberturaModal/);
    assert.match(pedidos, /consumirIntencaoModal/);
    assert.match(pedidos, /getOrCreateInstance/);
    assert.match(pedidos, /data-bs-dismiss="modal"/);
    assert.doesNotMatch(pedidos, /mesa_atendimento_id:/);
    assert.match(pedidos, /iniciarVendaPdv/);
    assert.match(mobile, /mesa_id: estado\.mesaId \? Number\(estado\.mesaId\) : null/);
    assert.doesNotMatch(mobile, /mesa_atendimento_id:/);
    const fn = faturamento.slice(
      faturamento.indexOf('async function finalizarVendaPdvPedido'),
      faturamento.indexOf('async function registrarMesaAposVendaConfirmada')
    );
    const conclusao = fn.indexOf('finalizarPedidoComVenda');
    const pendente = fn.indexOf('PAGAMENTO_PDV_PENDENTE');
    assert.ok(pendente > 0 && pendente < conclusao);
    assert.ok(conclusao < fn.lastIndexOf('registrarMesaAposVendaConfirmada'));
    assert.match(faturamento, /encerrarAtendimentoQuitado/);
  });

  it('mesa ocupada recupera o atendimento sem outro POST', async () => {
    const posts = [];
    const control = painel.criarControlador({
      empresaId: 1,
      fetchJson: async (method, caminho) => {
        posts.push(method);
        if (caminho === '/mesas/situacao') {
          return { itens: [{ id: 2, numero: 2, ativo: true, situacao: 'OCUPADA', atendimento: { id: 9 } }] };
        }
        return { atendimento: { id: 9 } };
      },
      aoIrParaPedidos() {}
    });
    await control.iniciar();
    await control.selecionar(2);
    const ocupada = control.lancarPedido();
    assert.equal(ocupada.ok, true);
    assert.equal(posts.includes('POST'), false);
  });
});

const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');
const MesaService = require('../../backend/services/pedido/MesaService');
const Atendimento = require('../../backend/services/pedido/MesaAtendimentoService');
const PedidoOperacional = require('../../backend/services/pedido/PedidoOperacionalService');
const Operacao = require('../../backend/services/faturamento/PedidoFaturamentoOperacaoRepository');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

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

let ambientePronto;
let sequenciaVenda = 0;
function ambiente() {
  if (!ambientePronto) ambientePronto = montarAmbiente();
  return ambientePronto;
}

async function montarAmbiente() {
  const db = require('../../backend/database');
  await new Promise((resolve) => db.whenReady(() => resolve()));
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaMesas(db);
  await Operacao.garantirSchema(db);
  const a = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'Salao A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'Salao B' }, { db });
  const prod = await run(db, `
    INSERT INTO produtos (nome, preco_venda, unidade, unidade_estoque, utiliza_conversao, saldo_fiscal, estoque_atual)
    VALUES ('Pastel MESAS0521', 10, 'UN', 'UN', 0, 500, 500)
  `);
  for (const empresa of [a, b]) {
    await EstoqueEmpresaService.criarRegistro({
      produtoId: prod.lastID,
      empresaId: empresa.id,
      saldo_fiscal: 500,
      saldo_nao_fiscal: 0,
      estoque_atual: 500,
      reservado_fiscal: 0
    }, { db });
  }
  return { db, produtoId: prod.lastID, a, b };
}

async function criarPedido(ctx, empresaId, mesaId) {
  const original = configService.recursoHabilitado;
  configService.recursoHabilitado = () => true;
  try {
    const criado = await PedidoOperacional.criar({
      itens: [{ produto_id: ctx.produtoId, quantidade: 1, preco_unitario: 10, desconto_percentual: 0, subtotal: 10 }],
      total: 10,
      mesa_id: mesaId || null
    }, 8, { empresaId, db: ctx.db });
    return criado.pedido;
  } finally {
    configService.recursoHabilitado = original;
  }
}

async function confirmarVenda(db, pedido, empresaId, statusPagamento, extra = {}) {
  sequenciaVenda += 1;
  const venda = await run(db, `
    INSERT INTO vendas (codigo, data_venda, total, empresa_id, pedido_id, status_pagamento, status)
    VALUES (?, '2026-11-02', 10, ?, ?, ?, 'concluida')
  `, [`MESA521-${sequenciaVenda}`, empresaId, pedido.id, statusPagamento]);
  await run(db, `
    UPDATE pedidos SET status = ?, venda_id = ? WHERE id = ? AND empresa_id = ?
  `, [extra.statusPedido || 'FATURADO', venda.lastID, pedido.id, empresaId]);
  if (!extra.semOperacao) {
    await run(db, `
      INSERT INTO pedido_faturamento_operacoes
        (pedido_id, empresa_id, venda_id, status, tipo_operacao, payload_json)
      VALUES (?, ?, ?, ?, 'PDV_COMPOSICAO', '{}')
    `, [pedido.id, empresaId, venda.lastID, extra.operacao || 'FINALIZADA']);
  }
  return venda.lastID;
}

async function situacao(ctx, empresaId, mesaId) {
  return Atendimento.consultarAtivo(empresaId, mesaId, { db: ctx.db });
}

describe('encerramento depois da venda confirmada', () => {
  it('libera a mesa quando a venda quitou o único pedido e não repete o encerramento', async () => {
    const ctx = await ambiente();
    const mesa = await MesaService.criar(ctx.a.id, { numero: 21 }, { db: ctx.db });
    const aberto = await Atendimento.abrir(ctx.a.id, mesa.mesa.id, { operadorId: 8 }, { db: ctx.db });
    const pedido = await criarPedido(ctx, ctx.a.id, mesa.mesa.id);
    assert.equal(pedido.mesa_atendimento_id, aberto.atendimento.id);
    const antes = await get(ctx.db, 'SELECT aberto_em FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
    await confirmarVenda(ctx.db, pedido, ctx.a.id, 'quitada');
    const primeiro = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, pedido.id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(primeiro.encerrado, true);
    assert.equal(primeiro.repetida, false);
    assert.equal(primeiro.situacao, 'LIVRE');
    const depois = await situacao(ctx, ctx.a.id, mesa.mesa.id);
    assert.equal(depois.situacao, 'LIVRE');
    const gravado = await get(ctx.db, 'SELECT * FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
    assert.equal(gravado.estado, 'ENCERRADO');
    assert.equal(gravado.aberto_em, antes.aberto_em);
    assert.ok(gravado.encerrado_em);
    const pedidoGravado = await get(ctx.db, 'SELECT id, status FROM pedidos WHERE id = ?', [pedido.id]);
    assert.equal(pedidoGravado.status, 'FATURADO');
    const segundo = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, pedido.id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(segundo.repetida, true);
    assert.equal(segundo.atendimento.encerrado_em, primeiro.atendimento.encerrado_em);
    const linhas = await get(ctx.db, 'SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
    assert.equal(linhas.total, 1);
  });

  it('libera quando todos foram quitados e preserva a mesa se ainda há consumo', async () => {
    const ctx = await ambiente();
    const mesa = await MesaService.criar(ctx.a.id, { numero: 22 }, { db: ctx.db });
    const aberto = await Atendimento.abrir(ctx.a.id, mesa.mesa.id, { operadorId: 8 }, { db: ctx.db });
    const primeiro = await criarPedido(ctx, ctx.a.id, mesa.mesa.id);
    const segundo = await criarPedido(ctx, ctx.a.id, mesa.mesa.id);
    assert.equal(segundo.mesa_atendimento_id, primeiro.mesa_atendimento_id);
    const abertura = await get(ctx.db, 'SELECT aberto_em FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
    await confirmarVenda(ctx.db, primeiro, ctx.a.id, 'quitada');
    const parcial = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, primeiro.id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(parcial.codigo, 'PEDIDO_PENDENTE');
    assert.equal((await situacao(ctx, ctx.a.id, mesa.mesa.id)).situacao, 'OCUPADA');
    await run(ctx.db, `UPDATE pedidos SET status = 'CANCELADO' WHERE id = ?`, [segundo.id]);
    const completo = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, primeiro.id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(completo.encerrado, true);
    assert.equal((await situacao(ctx, ctx.a.id, mesa.mesa.id)).situacao, 'LIVRE');
    const gravado = await get(ctx.db, 'SELECT aberto_em, estado FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
    assert.equal(gravado.estado, 'ENCERRADO');
    assert.equal(gravado.aberto_em, abertura.aberto_em);
    const ambos = await get(ctx.db, 'SELECT COUNT(*) AS total FROM pedidos WHERE mesa_atendimento_id = ?', [aberto.atendimento.id]);
    assert.equal(ambos.total, 2);
  });

  it('não libera com pagamento pendente, recusado, venda incompleta ou falha da conclusão', async () => {
    const ctx = await ambiente();
    const casos = [
      ['pendente', 'PAGAMENTO_NAO_CONFIRMADO', 23],
      ['recusado', 'PAGAMENTO_NAO_CONFIRMADO', 24],
      ['quitada', 'VENDA_NAO_CONCLUIDA', 25],
      [null, 'PEDIDO_PENDENTE', 26]
    ];
    for (const [pagamento, codigo, numero] of casos) {
      const mesa = await MesaService.criar(ctx.a.id, { numero }, { db: ctx.db });
      const aberto = await Atendimento.abrir(ctx.a.id, mesa.mesa.id, { operadorId: 8 }, { db: ctx.db });
      const pedido = await criarPedido(ctx, ctx.a.id, mesa.mesa.id);
      if (pagamento) {
        await confirmarVenda(ctx.db, pedido, ctx.a.id, pagamento, {
          semOperacao: codigo === 'VENDA_NAO_CONCLUIDA'
        });
      }
      const resultado = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, pedido.id, { operadorId: 8 }, { db: ctx.db });
      assert.equal(resultado.codigo, codigo);
      const estado = await get(ctx.db, 'SELECT estado, encerrado_em FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
      assert.equal(estado.estado, 'OCUPADA');
      assert.equal(estado.encerrado_em, null);
    }
  });

  it('libera a mesa de destino da transferência, isola a empresa e preserva o histórico', async () => {
    const ctx = await ambiente();
    const origem = await MesaService.criar(ctx.a.id, { numero: 31 }, { db: ctx.db });
    const destino = await MesaService.criar(ctx.a.id, { numero: 32 }, { db: ctx.db });
    const aberto = await Atendimento.abrir(ctx.a.id, origem.mesa.id, { operadorId: 8 }, { db: ctx.db });
    const pedido = await criarPedido(ctx, ctx.a.id, origem.mesa.id);
    await Atendimento.transferir(ctx.a.id, origem.mesa.id, {
      operadorId: 8,
      mesaDestinoId: destino.mesa.id,
      idempotencyKey: 'mesas0521-transferencia'
    }, { db: ctx.db });
    await confirmarVenda(ctx.db, pedido, ctx.a.id, 'quitada');
    const encerrado = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, pedido.id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(encerrado.encerrado, true);
    assert.equal(encerrado.atendimento.mesa_id, destino.mesa.id);
    assert.equal((await situacao(ctx, ctx.a.id, destino.mesa.id)).situacao, 'LIVRE');
    assert.equal((await situacao(ctx, ctx.a.id, origem.mesa.id)).situacao, 'LIVRE');
    const pedidoGravado = await get(ctx.db, 'SELECT mesa_id, mesa_atendimento_id FROM pedidos WHERE id = ?', [pedido.id]);
    assert.equal(pedidoGravado.mesa_id, origem.mesa.id);
    assert.equal(pedidoGravado.mesa_atendimento_id, aberto.atendimento.id);
    const historia = await get(ctx.db, 'SELECT COUNT(*) AS total FROM mesa_atendimento_transferencias WHERE atendimento_id = ?', [aberto.atendimento.id]);
    assert.equal(historia.total, 1);

    const mesaB = await MesaService.criar(ctx.b.id, { numero: 41 }, { db: ctx.db });
    const abertoB = await Atendimento.abrir(ctx.b.id, mesaB.mesa.id, { operadorId: 8 }, { db: ctx.db });
    const pedidoB = await criarPedido(ctx, ctx.b.id, mesaB.mesa.id);
    await confirmarVenda(ctx.db, pedidoB, ctx.b.id, 'quitada');
    const cruzado = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, pedidoB.id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(cruzado.codigo, 'PEDIDO_FORA_DA_EMPRESA');
    assert.equal((await situacao(ctx, ctx.b.id, mesaB.mesa.id)).situacao, 'OCUPADA');
    assert.equal((await get(ctx.db, 'SELECT estado FROM mesa_atendimentos WHERE id = ?', [abertoB.atendimento.id])).estado, 'OCUPADA');
  });

  it('a consulta do controle libera a mesa já quitada e preserva pedido em aberto', async () => {
    const ctx = await ambiente();
    const mesa = await MesaService.criar(ctx.a.id, { numero: 61 }, { db: ctx.db });
    await Atendimento.abrir(ctx.a.id, mesa.mesa.id, { operadorId: 8 }, { db: ctx.db });
    const pedido = await criarPedido(ctx, ctx.a.id, mesa.mesa.id);
    await confirmarVenda(ctx.db, pedido, ctx.a.id, 'quitada');
    const semOperador = await Atendimento.listarSituacao(ctx.a.id, { db: ctx.db });
    assert.equal(semOperador.itens.find((item) => item.numero === 61).situacao, 'OCUPADA');
    const painel = await Atendimento.listarSituacao(ctx.a.id, { db: ctx.db, operadorId: 8 });
    assert.equal(painel.itens.find((item) => item.numero === 61).situacao, 'LIVRE');

    const aberta = await MesaService.criar(ctx.a.id, { numero: 62 }, { db: ctx.db });
    await Atendimento.abrir(ctx.a.id, aberta.mesa.id, { operadorId: 8 }, { db: ctx.db });
    await criarPedido(ctx, ctx.a.id, aberta.mesa.id);
    const deNovo = await Atendimento.listarSituacao(ctx.a.id, { db: ctx.db, operadorId: 8 });
    assert.equal(deNovo.itens.find((item) => item.numero === 62).situacao, 'OCUPADA');
    assert.equal(deNovo.itens.find((item) => item.numero === 61).situacao, 'LIVRE');

    const rotas = fs.readFileSync(path.join(__dirname, '../../backend/rotas/mesas.js'), 'utf8');
    assert.match(rotas, /listarSituacao\([\s\S]*operadorId: operadorSeHouver\(req\)/);
  });

  it('não encerra pedido sem mesa nem atendimento em fechamento', async () => {
    const ctx = await ambiente();
    const semMesa = await criarPedido(ctx, ctx.a.id, null);
    const fora = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, semMesa.id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(fora.codigo, 'PEDIDO_SEM_ATENDIMENTO');
    assert.equal(semMesa.mesa_atendimento_id, null);

    const mesa = await MesaService.criar(ctx.a.id, { numero: 51 }, { db: ctx.db });
    const aberto = await Atendimento.abrir(ctx.a.id, mesa.mesa.id, { operadorId: 8 }, { db: ctx.db });
    const pedido = await criarPedido(ctx, ctx.a.id, mesa.mesa.id);
    await confirmarVenda(ctx.db, pedido, ctx.a.id, 'quitada');
    await run(ctx.db, `UPDATE mesa_atendimentos SET estado = 'FECHAMENTO' WHERE id = ?`, [aberto.atendimento.id]);
    const bloqueio = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, pedido.id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(bloqueio.codigo, 'ATENDIMENTO_EM_FECHAMENTO');
    assert.equal((await get(ctx.db, 'SELECT estado FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id])).estado, 'FECHAMENTO');
  });
});
