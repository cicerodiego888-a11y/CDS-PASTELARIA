/**
 * MESAS-05.3 — vários pedidos da mesma mesa em uma única venda.
 * O núcleo oficial é injetado: o teste não emite NFC-e, não cobra e não usa o banco oficial.
 *
 * Executar: node --test --test-concurrency=1 tests/erp/mesas-05-3-fechamento-consolidado.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mesas053-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

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
const Consolidada = require('../../backend/services/vendas/VendaConsolidadaMesaService');
const selecao = require('../../frontend/erp/js/mesas-venda-consolidada');

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
let sequencia = 0;
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
    VALUES ('Pastel catalogo 10', 10, 'UN', 'UN', 0, 500, 500)
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
  return { db, produtoId: prod.lastID, a, b, baixas: [] };
}

async function criarPedido(ctx, empresaId, mesaId, extra = {}) {
  const quantidade = extra.quantidade || 1;
  const preco = extra.preco != null ? extra.preco : 10;
  const subtotal = Math.round(preco * quantidade * 100) / 100;
  const original = configService.recursoHabilitado;
  configService.recursoHabilitado = () => true;
  try {
    const criado = await PedidoOperacional.criar({
      itens: [{
        produto_id: ctx.produtoId,
        quantidade,
        preco_unitario: preco,
        desconto_percentual: 0,
        subtotal
      }],
      total: subtotal,
      observacao: extra.observacao || null,
      mesa_id: mesaId
    }, 8, { empresaId, db: ctx.db });
    return criado.pedido;
  } finally {
    configService.recursoHabilitado = original;
  }
}

function nucleoDe(ctx, extra = {}) {
  return async function nucleo(contrato, entrada) {
    extra.chamadas = (extra.chamadas || 0) + 1;
    if (extra.falharCriacao) {
      const falha = new Error('criação interrompida');
      falha.codigo = 'VENDA_NAO_CRIADA';
      throw falha;
    }
    sequencia += 1;
    const status = entrada.statusPagamento || 'quitada';
    const venda = await run(ctx.db, `
      INSERT INTO vendas (codigo, data_venda, total, desconto, empresa_id, status_pagamento, status)
      VALUES (?, '2026-11-02', ?, ?, ?, ?, 'concluida')
    `, [`MESA053-${sequencia}`, contrato.total, contrato.desconto || 0, entrada.empresaId, status]);
    for (const item of contrato.itens) {
      await run(ctx.db, `
        INSERT INTO vendas_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
        VALUES (?, ?, ?, ?, ?)
      `, [venda.lastID, item.produto_id, item.quantidade, item.preco_unitario, item.subtotal]);
    }
    const quantidade = contrato.itens.reduce((soma, item) => soma + Number(item.quantidade), 0);
    ctx.baixas.push({ venda_id: venda.lastID, quantidade });
    return { venda_id: venda.lastID, status_pagamento: status };
  };
}

async function mesaComPedidos(ctx, numero, precos, empresa) {
  const dona = empresa || ctx.a;
  const mesa = await MesaService.criar(dona.id, { numero }, { db: ctx.db });
  await Atendimento.abrir(dona.id, mesa.mesa.id, { operadorId: 8 }, { db: ctx.db });
  const pedidos = [];
  for (const preco of precos) {
    pedidos.push(await criarPedido(ctx, dona.id, mesa.mesa.id, {
      preco: preco.preco != null ? preco.preco : preco,
      observacao: preco.observacao || null,
      quantidade: preco.quantidade || 1
    }));
  }
  return { mesa: mesa.mesa, pedidos, empresaId: dona.id };
}

function entrada(ctx, mesa, pedidos, chave, extra = {}) {
  return {
    empresaId: extra.empresaId || ctx.a.id,
    mesaId: mesa.id,
    pedidoIds: pedidos.map((pedido) => pedido.id),
    operadorId: 8,
    idempotencyKey: chave,
    statusPagamento: extra.statusPagamento
  };
}

describe('venda consolidada da mesa', () => {
  it('1 e 3. dois pedidos geram uma venda com a soma gravada', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 1, [{ preco: 9, observacao: 'sem cebola' }, { preco: 39.99, observacao: 'gelada' }]);
    const contagem = {};
    const resultado = await Consolidada.concluir(
      entrada(ctx, sala.mesa, sala.pedidos, 'dois'),
      { db: ctx.db, nucleo: nucleoDe(ctx, contagem) }
    );
    assert.equal(contagem.chamadas, 1);
    assert.equal(resultado.venda_id > 0, true);
    const vinculados = await get(ctx.db, `
      SELECT COUNT(DISTINCT venda_id) AS vendas, COUNT(*) AS pedidos
      FROM pedidos WHERE id IN (?, ?)
    `, sala.pedidos.map((pedido) => pedido.id));
    assert.equal(vinculados.vendas, 1);
    assert.equal(vinculados.pedidos, 2);
    const venda = await get(ctx.db, 'SELECT total, pedido_id FROM vendas WHERE id = ?', [resultado.venda_id]);
    assert.equal(Number(venda.total), 48.99);
    assert.equal(venda.pedido_id, null);
    const itens = await get(ctx.db, 'SELECT COUNT(*) AS total FROM vendas_itens WHERE venda_id = ?', [resultado.venda_id]);
    assert.equal(itens.total, 2);
  });

  it('2. três pedidos geram uma única venda', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 2, [9, 10, 1]);
    const contagem = {};
    const resultado = await Consolidada.concluir(
      entrada(ctx, sala.mesa, sala.pedidos, 'tres'),
      { db: ctx.db, nucleo: nucleoDe(ctx, contagem) }
    );
    assert.equal(contagem.chamadas, 1);
    const venda = await get(ctx.db, 'SELECT total FROM vendas WHERE id = ?', [resultado.venda_id]);
    assert.equal(Number(venda.total), 20);
    const pedidos = await get(ctx.db, `
      SELECT COUNT(*) AS total FROM pedidos WHERE venda_id = ? AND status = 'FATURADO'
    `, [resultado.venda_id]);
    assert.equal(pedidos.total, 3);
  });

  it('4 e 5. preserva o preço e a observação gravados no pedido', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 3, [{ preco: 9, observacao: 'sem cebola' }, { preco: 39.99, observacao: 'gelada' }]);
    const preparado = await Consolidada.preparar(
      entrada(ctx, sala.mesa, sala.pedidos, 'precos'),
      { db: ctx.db }
    );
    const precos = preparado.itens.map((item) => item.preco_unitario).sort((a, b) => a - b);
    assert.deepEqual(precos, [9, 39.99]);
    assert.equal(preparado.itens.some((item) => item.observacao === 'sem cebola' && item.pedido_id === sala.pedidos[0].id), true);
    assert.equal(preparado.itens.some((item) => item.observacao === 'gelada' && item.pedido_id === sala.pedidos[1].id), true);
    assert.equal(preparado.itens.every((item) => item.preco_unitario !== 10), true);
  });

  it('6 a 12. bloqueia mesa, empresa, atendimento, cancelado, faturado, venda e item vazio', async () => {
    const ctx = await ambiente();
    const uma = await mesaComPedidos(ctx, 4, [9]);
    const outra = await mesaComPedidos(ctx, 5, [10]);
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, uma.mesa, [uma.pedidos[0], outra.pedidos[0]], 'mesas'), { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'MESAS_DIFERENTES'
    );

    const daOutra = await mesaComPedidos(ctx, 6, [8], ctx.b);
    await assert.rejects(
      () => Consolidada.concluir({
        empresaId: ctx.a.id,
        mesaId: uma.mesa.id,
        pedidoIds: [uma.pedidos[0].id, daOutra.pedidos[0].id],
        operadorId: 8,
        idempotencyKey: 'empresa'
      }, { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'PEDIDO_OUTRA_EMPRESA'
    );

    const sala = await mesaComPedidos(ctx, 7, [4, 5]);
    const encerrado = await run(ctx.db, `
      INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id, aberto_em, encerrado_em)
      VALUES (?, ?, 'ENCERRADO', 8, datetime('now'), datetime('now'))
    `, [ctx.a.id, sala.mesa.id]);
    await run(ctx.db, 'UPDATE pedidos SET mesa_atendimento_id = ? WHERE id = ?', [encerrado.lastID, sala.pedidos[1].id]);
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, sala.mesa, sala.pedidos, 'atend'), { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'ATENDIMENTOS_DIFERENTES'
    );

    const cancelada = await mesaComPedidos(ctx, 8, [4, 5]);
    await run(ctx.db, `UPDATE pedidos SET status = 'CANCELADO' WHERE id = ?`, [cancelada.pedidos[1].id]);
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, cancelada.mesa, cancelada.pedidos, 'canc'), { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'PEDIDO_CANCELADO'
    );

    const faturada = await mesaComPedidos(ctx, 9, [4, 5]);
    await run(ctx.db, `UPDATE pedidos SET status = 'FATURADO', venda_id = 1 WHERE id = ?`, [faturada.pedidos[0].id]);
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, faturada.mesa, faturada.pedidos, 'fat'), { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'PEDIDO_FATURADO'
    );

    const vinculada = await mesaComPedidos(ctx, 10, [4, 5]);
    await run(ctx.db, 'UPDATE pedidos SET venda_id = 1 WHERE id = ?', [vinculada.pedidos[0].id]);
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, vinculada.mesa, vinculada.pedidos, 'vinc'), { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'PEDIDO_JA_VINCULADO'
    );

    const vazia = await mesaComPedidos(ctx, 11, [4, 5]);
    await run(ctx.db, 'DELETE FROM pedidos_itens WHERE pedido_id = ?', [vazia.pedidos[1].id]);
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, vazia.mesa, vazia.pedidos, 'vazia'), { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'PEDIDO_SEM_ITENS'
    );
  });

  it('13 a 16. pagamento e operação incompletos não liberam a mesa', async () => {
    const ctx = await ambiente();
    for (const [pagamento, chave, numero] of [['pendente', 'pag-pendente', 12], ['recusado', 'pag-recusado', 13]]) {
      const sala = await mesaComPedidos(ctx, numero, [9, 10]);
      const resultado = await Consolidada.concluir(
        entrada(ctx, sala.mesa, sala.pedidos, chave, { statusPagamento: pagamento }),
        { db: ctx.db, nucleo: nucleoDe(ctx, {}) }
      );
      assert.equal(resultado.mesa.codigo, 'PAGAMENTO_NAO_CONFIRMADO');
      const estado = await get(ctx.db, `
        SELECT estado FROM mesa_atendimentos WHERE mesa_id = ? AND empresa_id = ? AND estado = 'OCUPADA'
      `, [sala.mesa.id, ctx.a.id]);
      assert.equal(estado.estado, 'OCUPADA');
    }

    const sala = await mesaComPedidos(ctx, 14, [9, 10]);
    const resultado = await Consolidada.concluir(
      entrada(ctx, sala.mesa, sala.pedidos, 'op-aberta', { statusPagamento: 'pendente' }),
      { db: ctx.db, nucleo: nucleoDe(ctx, {}) }
    );
    await run(ctx.db, `
      UPDATE pedido_faturamento_operacoes SET status = 'INICIADA' WHERE venda_id = ?
    `, [resultado.venda_id]);
    await run(ctx.db, `UPDATE vendas SET status_pagamento = 'quitada' WHERE id = ?`, [resultado.venda_id]);
    const bloqueio = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, sala.pedidos[0].id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(bloqueio.codigo, 'VENDA_NAO_CONCLUIDA');
    assert.equal((await get(ctx.db, 'SELECT estado FROM mesa_atendimentos WHERE id = ?', [sala.pedidos[0].mesa_atendimento_id])).estado, 'OCUPADA');

    const confirmada = await mesaComPedidos(ctx, 15, [9, 10]);
    const ok = await Consolidada.concluir(
      entrada(ctx, confirmada.mesa, confirmada.pedidos, 'quitada'),
      { db: ctx.db, nucleo: nucleoDe(ctx, {}) }
    );
    assert.equal(ok.mesa.encerrado, true);
    assert.equal(ok.mesa.situacao, 'LIVRE');

    const cancelada = await mesaComPedidos(ctx, 25, [9, 10]);
    const aguardando = await Consolidada.concluir(
      entrada(ctx, cancelada.mesa, cancelada.pedidos, 'venda-cancelada', { statusPagamento: 'pendente' }),
      { db: ctx.db, nucleo: nucleoDe(ctx, {}) }
    );
    await run(ctx.db, `
      UPDATE vendas SET status_pagamento = 'quitada', status = 'cancelada' WHERE id = ?
    `, [aguardando.venda_id]);
    const bloqueioVendaCancelada = await Atendimento.encerrarAtendimentoQuitado(
      ctx.a.id,
      cancelada.pedidos[0].id,
      { operadorId: 8 },
      { db: ctx.db }
    );
    assert.equal(bloqueioVendaCancelada.codigo, 'VENDA_NAO_CONCLUIDA');
    await run(ctx.db, `UPDATE vendas SET status = 'concluida' WHERE id = ?`, [aguardando.venda_id]);
    const liberada = await Atendimento.encerrarAtendimentoQuitado(
      ctx.a.id,
      cancelada.pedidos[0].id,
      { operadorId: 8 },
      { db: ctx.db }
    );
    assert.equal(liberada.encerrado, true);
  });

  it('17 e 18. falha na criação não fatura e falha no vínculo não abre outra venda', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 16, [9, 10]);
    const contagem = { falharCriacao: true };
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, sala.mesa, sala.pedidos, 'falha-cria'), { db: ctx.db, nucleo: nucleoDe(ctx, contagem) }),
      (err) => err.pedidos_faturados === false
    );
    const intactos = await get(ctx.db, `
      SELECT COUNT(*) AS total FROM pedidos WHERE id IN (?, ?) AND status = 'PEDIDO' AND venda_id IS NULL
    `, sala.pedidos.map((pedido) => pedido.id));
    assert.equal(intactos.total, 2);
    const reservaFalha = await get(ctx.db, `
      SELECT id, status FROM venda_consolidacoes WHERE idempotency_key = 'falha-cria'
    `);
    assert.equal(reservaFalha.status, 'FALHA_CRIACAO');
    const participantesFalha = await get(ctx.db, `
      SELECT COUNT(*) AS total FROM venda_consolidacao_pedidos WHERE consolidacao_id = ?
    `, [reservaFalha.id]);
    assert.equal(participantesFalha.total, 2);
    await assert.rejects(
      () => Consolidada.preparar(entrada(ctx, sala.mesa, sala.pedidos, 'falha-cria'), { db: ctx.db }),
      (err) => err.codigo === 'CONSOLIDACAO_FALHA_CRIACAO'
    );

    const deNovo = await mesaComPedidos(ctx, 17, [9, 10]);
    const estado = { chamadas: 0, falharVinculo: true };
    const nucleo = nucleoDe(ctx, estado);
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, deNovo.mesa, deNovo.pedidos, 'falha-vinc'), {
        db: ctx.db,
        nucleo,
        antesDeVincular() {
          if (estado.falharVinculo) {
            estado.falharVinculo = false;
            throw new Error('vínculo interrompido');
          }
        }
      })
    );
    const vendas = await get(ctx.db, `
      SELECT COUNT(*) AS total FROM venda_consolidacoes WHERE idempotency_key = 'falha-vinc' AND venda_id IS NOT NULL
    `);
    assert.equal(vendas.total, 1);
    const aberto = await get(ctx.db, `
      SELECT COUNT(*) AS total FROM pedidos WHERE id IN (?, ?) AND status = 'PEDIDO'
    `, deNovo.pedidos.map((pedido) => pedido.id));
    assert.equal(aberto.total, 2);
    const recuperado = await Consolidada.concluir(
      entrada(ctx, deNovo.mesa, deNovo.pedidos, 'falha-vinc'),
      { db: ctx.db, nucleo }
    );
    assert.equal(estado.chamadas, 1);
    assert.equal(recuperado.venda_id > 0, true);
    const ligados = await get(ctx.db, `
      SELECT COUNT(DISTINCT venda_id) AS vendas FROM pedidos WHERE id IN (?, ?)
    `, deNovo.pedidos.map((pedido) => pedido.id));
    assert.equal(ligados.vendas, 1);
  });

  it('19 e 20. a mesma chave e o duplo clique reutilizam a venda', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 18, [9, 10]);
    const contagem = {};
    const nucleo = nucleoDe(ctx, contagem);
    const primeiro = await Consolidada.concluir(entrada(ctx, sala.mesa, sala.pedidos, 'chave'), { db: ctx.db, nucleo });
    const repetido = await Consolidada.concluir(entrada(ctx, sala.mesa, sala.pedidos, 'chave'), { db: ctx.db, nucleo });
    assert.equal(repetido.venda_id, primeiro.venda_id);
    assert.equal(repetido.idempotente, true);
    assert.equal(contagem.chamadas, 1);

    const dupla = await mesaComPedidos(ctx, 19, [4, 5]);
    const contagemDupla = {};
    const [a, b] = await Promise.all([
      Consolidada.concluir(entrada(ctx, dupla.mesa, dupla.pedidos, 'clique'), { db: ctx.db, nucleo: nucleoDe(ctx, contagemDupla) }),
      Consolidada.concluir(entrada(ctx, dupla.mesa, dupla.pedidos, 'clique'), { db: ctx.db, nucleo: nucleoDe(ctx, contagemDupla) })
    ]);
    assert.equal(a.venda_id, b.venda_id);
    assert.equal(contagemDupla.chamadas, 1);
  });

  it('recupera uma reserva pendente da mesma seleção mesmo com uma chave de repetição nova', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 28, [9, 10]);
    const primeira = await Consolidada.preparar(
      entrada(ctx, sala.mesa, sala.pedidos, 'reserva-antiga'),
      { db: ctx.db }
    );
    const repetida = await Consolidada.preparar(
      entrada(ctx, sala.mesa, sala.pedidos, 'reserva-repetida'),
      { db: ctx.db }
    );
    assert.equal(repetida.consolidacao_id, primeira.consolidacao_id);
    assert.equal(repetida.status, 'RESERVADA');
    const quantidade = await get(ctx.db, `
      SELECT COUNT(*) AS total FROM venda_consolidacoes
      WHERE empresa_id = ? AND mesa_id = ?
    `, [ctx.a.id, sala.mesa.id]);
    assert.equal(quantidade.total, 1);
    const outraSelecao = await mesaComPedidos(ctx, 29, [9, 10]);
    await assert.rejects(
      () => Consolidada.preparar(
        entrada(ctx, outraSelecao.mesa, outraSelecao.pedidos, 'reserva-repetida'),
        { db: ctx.db }
      ),
      (err) => err.codigo === 'IDEMPOTENCIA_CONTEUDO_DIVERGENTE'
    );
  });

  it('recupera a mesma venda persistida após resposta perdida sem abrir uma segunda venda', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 30, [9, 10]);
    const estado = {};
    const concluida = await Consolidada.concluir(
      entrada(ctx, sala.mesa, sala.pedidos, 'venda-resposta-perdida'),
      { db: ctx.db, nucleo: nucleoDe(ctx, estado) }
    );
    const recuperada = await Consolidada.preparar(
      entrada(ctx, sala.mesa, sala.pedidos, 'nova-chave-resposta-perdida'),
      { db: ctx.db }
    );
    assert.equal(recuperada.consolidacao_id, concluida.consolidacao.id);
    assert.equal(recuperada.venda_id, concluida.venda_id);
    assert.equal(recuperada.status, 'VINCULADA');
    assert.equal(estado.chamadas, 1);
    const vendas = await get(ctx.db, `
      SELECT COUNT(DISTINCT venda_id) AS total
      FROM venda_consolidacao_pedidos
      WHERE pedido_id IN (?, ?)
    `, sala.pedidos.map((pedido) => pedido.id));
    assert.equal(vendas.total, 1);
  });

  it('impede duas criações concorrentes para uma reserva quando chaves diferentes chegam juntas', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 31, [9, 10]);
    const estado = {};
    const resultados = await Promise.allSettled([
      Consolidada.concluir(
        entrada(ctx, sala.mesa, sala.pedidos, 'concorrente-a'),
        { db: ctx.db, nucleo: nucleoDe(ctx, estado) }
      ),
      Consolidada.concluir(
        entrada(ctx, sala.mesa, sala.pedidos, 'concorrente-b'),
        { db: ctx.db, nucleo: nucleoDe(ctx, estado) }
      )
    ]);
    assert.equal(resultados.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(estado.chamadas, 1);
  });

  it('rejeita reuso da chave com outra seleção e confere todos os valores dos itens', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 26, [9, 10, 11]);
    await Consolidada.preparar({
      ...entrada(ctx, sala.mesa, sala.pedidos.slice(0, 2), 'conteudo-chave'),
      pedidoIds: sala.pedidos.slice(0, 2).map((pedido) => pedido.id)
    }, { db: ctx.db });
    await assert.rejects(
      () => Consolidada.preparar({
        ...entrada(ctx, sala.mesa, sala.pedidos.slice(1), 'conteudo-chave'),
        pedidoIds: sala.pedidos.slice(1).map((pedido) => pedido.id)
      }, { db: ctx.db }),
      (err) => err.codigo === 'IDEMPOTENCIA_CONTEUDO_DIVERGENTE'
    );
    await assert.rejects(
      () => Consolidada.preparar({
        ...entrada(ctx, sala.mesa, [sala.pedidos[1], sala.pedidos[2]], 'outra-chave-sobreposta'),
        pedidoIds: [sala.pedidos[1].id, sala.pedidos[2].id]
      }, { db: ctx.db }),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.codigo, 'PEDIDO_EM_OUTRA_CONSOLIDACAO');
        assert.equal(err.message, 'Um dos pedidos já participa de outra consolidação.');
        return true;
      }
    );

    const outra = await mesaComPedidos(ctx, 27, [9, 10]);
    const preparacao = await Consolidada.preparar(
      entrada(ctx, outra.mesa, outra.pedidos, 'itens-divergentes'),
      { db: ctx.db }
    );
    const venda = await run(ctx.db, `
      INSERT INTO vendas (codigo, data_venda, total, desconto, empresa_id, status_pagamento, status)
      VALUES ('MESA053-ITENS-DIVERGENTES', '2026-11-02', 19, 0, ?, 'quitada', 'concluida')
    `, [ctx.a.id]);
    for (const [preco, subtotal] of [[8, 8], [11, 11]]) {
      await run(ctx.db, `
        INSERT INTO vendas_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
        VALUES (?, ?, 1, ?, ?)
      `, [venda.lastID, ctx.produtoId, preco, subtotal]);
    }
    await assert.rejects(
      () => Consolidada.vincular({
        empresaId: ctx.a.id,
        consolidacaoId: preparacao.consolidacao_id,
        vendaId: venda.lastID,
        operadorId: 8
      }, { db: ctx.db }),
      (err) => err.codigo === 'ITENS_DIVERGENTES'
    );
  });

  it('usa a porta de aplicação exportada ao delegar a venda oficial', async () => {
    const ctx = await ambiente();
    const app = require('../../backend/services/vendas/VendaApplicationService');
    const original = app.concluirVendaNoNucleoOficial;
    app.concluirVendaNoNucleoOficial = (req, res, contexto, contrato) => {
      assert.equal(req.body.origem, 'PDV');
      assert.equal(req.body.total, 19);
      assert.equal(contexto.origem, 'PDV');
      assert.equal(contrato.payload.total, 19);
      res.json({ venda_id: 731 });
    };
    try {
      const resultado = await Consolidada.nucleoOficial({
        origem: 'PDV',
        total: 19,
        itens: []
      }, {
        empresaId: ctx.a.id,
        operadorId: 8
      });
      assert.equal(resultado.venda_id, 731);
    } finally {
      app.concluirVendaNoNucleoOficial = original;
    }
  });

  it('21. o fechamento individual e o consolidado não correm juntos', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 20, [9, 10]);
    await Consolidada.preparar(entrada(ctx, sala.mesa, sala.pedidos, 'reserva'), { db: ctx.db });
    await assert.rejects(
      () => Operacao.prepararOperacaoPdv(sala.pedidos[0].id, ctx.a.id, { total: 9, itens: [] }),
      (err) => err.codigo === 'PEDIDO_EM_CONSOLIDACAO'
    );

    const individual = await mesaComPedidos(ctx, 21, [6, 7]);
    await Operacao.prepararOperacaoPdv(individual.pedidos[0].id, ctx.a.id, {
      pedidoId: individual.pedidos[0].id,
      empresaId: ctx.a.id,
      total: 6,
      itens: [{ produto_id: ctx.produtoId, quantidade: 1, preco_unitario: 6, subtotal: 6 }]
    });
    await assert.rejects(
      () => Consolidada.concluir(entrada(ctx, individual.mesa, individual.pedidos, 'corrida'), { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'PEDIDO_FECHAMENTO_INDIVIDUAL'
    );
  });

  it('22 a 24. vincula os participantes e só encerra o atendimento resolvido', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 22, [9, 10, 4]);
    const dois = sala.pedidos.slice(0, 2);
    const resultado = await Consolidada.concluir(
      entrada(ctx, sala.mesa, dois, 'parcial'),
      { db: ctx.db, nucleo: nucleoDe(ctx, {}) }
    );
    const ligados = await get(ctx.db, `
      SELECT COUNT(*) AS total FROM pedidos WHERE venda_id = ? AND id IN (?, ?)
    `, [resultado.venda_id, dois[0].id, dois[1].id]);
    assert.equal(ligados.total, 2);
    assert.equal(resultado.mesa.codigo, 'PEDIDO_PENDENTE');
    const ocupada = await get(ctx.db, 'SELECT estado FROM mesa_atendimentos WHERE id = ?', [sala.pedidos[0].mesa_atendimento_id]);
    assert.equal(ocupada.estado, 'OCUPADA');
    await run(ctx.db, `UPDATE pedidos SET status = 'CANCELADO' WHERE id = ?`, [sala.pedidos[2].id]);
    const encerrado = await Atendimento.encerrarAtendimentoQuitado(ctx.a.id, dois[0].id, { operadorId: 8 }, { db: ctx.db });
    assert.equal(encerrado.encerrado, true);
    assert.equal(encerrado.situacao, 'LIVRE');
  });

  it('25 e 28. o pedido individual e o pedido sem mesa continuam no fluxo próprio', async () => {
    const ctx = await ambiente();
    const sala = await mesaComPedidos(ctx, 23, [8]);
    const operacao = await Operacao.prepararOperacaoPdv(sala.pedidos[0].id, ctx.a.id, {
      pedidoId: sala.pedidos[0].id,
      empresaId: ctx.a.id,
      total: 8,
      itens: [{ produto_id: ctx.produtoId, quantidade: 1, preco_unitario: 8, subtotal: 8 }]
    });
    assert.equal(operacao.operacao.status, 'INICIADA');
    const pedidosJs = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');
    assert.match(pedidosJs, /Gerar venda no PDV/);
    assert.match(pedidosJs, /Gerar venda consolidada da mesa/);
    const pdvJs = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');
    assert.match(pdvJs, /retomarVinculoVendaConsolidada/);
    assert.match(pdvJs, /mesa-consolidacao-/);

    const semMesa = await criarPedido(ctx, ctx.a.id, null, { preco: 7 });
    await assert.rejects(
      () => Consolidada.concluir({
        empresaId: ctx.a.id,
        mesaId: sala.mesa.id,
        pedidoIds: [sala.pedidos[0].id, semMesa.id],
        operadorId: 8,
        idempotencyKey: 'sem-mesa'
      }, { db: ctx.db, nucleo: nucleoDe(ctx, {}) }),
      (err) => err.codigo === 'PEDIDO_SEM_MESA' || err.codigo === 'PEDIDO_FECHAMENTO_INDIVIDUAL' || err.codigo === 'PEDIDO_JA_VINCULADO' || err.codigo === 'MESAS_DIFERENTES'
    );
    const livre = await criarPedido(ctx, ctx.a.id, null, { preco: 6 });
    const propria = await Operacao.prepararOperacaoPdv(livre.id, ctx.a.id, {
      pedidoId: livre.id,
      empresaId: ctx.a.id,
      total: 6,
      itens: [{ produto_id: ctx.produtoId, quantidade: 1, preco_unitario: 6, subtotal: 6 }]
    });
    assert.equal(propria.operacao.tipo_operacao, 'PDV_COMPOSICAO');
    assert.equal((await get(ctx.db, 'SELECT status FROM pedidos WHERE id = ?', [livre.id])).status, 'PEDIDO');
  });

  it('26 e 27. o núcleo recebe os itens uma vez e a consolidação não recalcula F×NF', async () => {
    const ctx = await ambiente();
    const antes = ctx.baixas.length;
    const sala = await mesaComPedidos(ctx, 24, [{ preco: 9, quantidade: 1 }, { preco: 10, quantidade: 2 }]);
    const contagem = {};
    await Consolidada.concluir(entrada(ctx, sala.mesa, sala.pedidos, 'estoque'), { db: ctx.db, nucleo: nucleoDe(ctx, contagem) });
    assert.equal(contagem.chamadas, 1);
    assert.equal(ctx.baixas.length - antes, 1);
    assert.equal(ctx.baixas[ctx.baixas.length - 1].quantidade, 3);
    const fonte = fs.readFileSync(path.join(__dirname, '../../backend/services/vendas/VendaConsolidadaMesaService.js'), 'utf8');
    assert.match(fonte, /concluirVendaNoNucleoOficial/);
    assert.equal(fonte.includes('saldo_fiscal'), false);
    assert.equal(fonte.includes('FichaTecnica'), false);
    assert.equal(fonte.includes('saldo_nao_fiscal'), false);
    const selecaoFonte = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/mesas-venda-consolidada.js'), 'utf8');
    const grupo = selecao.grupos([
      { id: 1, status: 'PEDIDO', mesa_id: 1, mesa_atendimento_id: 9, empresa_id: 1, total: 9 },
      { id: 2, status: 'PEDIDO', mesa_id: 1, mesa_atendimento_id: 9, empresa_id: 1, total: 10 },
      { id: 3, status: 'PEDIDO', mesa_id: 2, mesa_atendimento_id: 10, empresa_id: 1, total: 4 }
    ]);
    assert.equal(grupo.length, 1);
    assert.equal(grupo[0].pedidos.length, 2);
    assert.match(selecaoFonte, /criarVenda: false/);
  });

  it('mantém a chave na repetição da mesma seleção e cria outra para seleção diferente', () => {
    const valores = new Map();
    let criacoes = 0;
    const storage = {
      getItem(chave) { return valores.get(chave) || null; },
      setItem(chave, valor) { valores.set(chave, String(valor)); }
    };
    const obter = (pedidoIds) => selecao.chaveIdempotencia({
      storage,
      empresaId: 7,
      mesaId: 12,
      atendimentoId: 35,
      pedidoIds,
      criarChave: () => `op-${++criacoes}`
    });
    const primeira = obter([101, 102]);
    const repetida = obter([102, 101]);
    const outraSelecao = obter([101, 103]);
    assert.equal(repetida, primeira);
    assert.notEqual(outraSelecao, primeira);
    assert.equal(criacoes, 2);
  });
});
