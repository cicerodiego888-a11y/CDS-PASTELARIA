/**
 * Ciclo de preparação do pedido de salão.
 * Não há fila de cozinha, impressão nem status comercial representando o envio.
 * O relógio começa somente nesta operação explícita e usa o horário do servidor.
 */
'use strict';

const { LIMITES_PREPARACAO_MINUTOS } = require('./preparacaoLimites');

const STATUS_ENVIAVEIS = Object.freeze(['PEDIDO', 'ABERTO', 'EM_SEPARACAO']);
const filas = new WeakMap();

function erro(mensagem, statusCode, codigo) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  return err;
}

function conn(opts) {
  return (opts && opts.db) || require('../../database');
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return n;
}

function exigirOperador(operadorId) {
  const n = Number(operadorId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Sessão sem operador.', 401, 'SESSAO_INVALIDA');
  }
  return n;
}

function normalizarChave(chave) {
  if (chave == null || String(chave).trim() === '') return null;
  const texto = String(chave).trim();
  if (texto.length > 200) {
    throw erro('Chave de idempotência inválida.', 400, 'CHAVE_IDEMPOTENCIA_INVALIDA');
  }
  return texto;
}

function instanteInformado(opts) {
  if (!opts || opts.agora == null || opts.agora === '') return null;
  const isolado = process.env.CDS_TEST_ISOLATION === '1' && process.env.CDS_BLOQUEAR_BANCO_OFICIAL === '1';
  if (!isolado) return null;
  const texto = String(opts.agora).trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(texto)) {
    throw erro('Horário de teste inválido.', 400, 'HORARIO_INVALIDO');
  }
  return texto;
}

function instanteMs(valor) {
  const ms = Date.parse(`${String(valor).trim().replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) {
    throw erro('Horário persistido inválido.', 500, 'HORARIO_INVALIDO');
  }
  return ms;
}

function segundosEntre(inicio, fim) {
  const delta = Math.floor((instanteMs(fim) - instanteMs(inicio)) / 1000);
  return delta > 0 ? delta : 0;
}

function classificar(estado, enviadoEm, concluidoEm, agora) {
  if (estado === 'CONCLUIDO' || concluidoEm) return 'CONCLUIDO';
  if (estado !== 'EM_PREPARACAO' || !enviadoEm) return 'NAO_ENVIADO';
  const segundos = segundosEntre(enviadoEm, agora);
  if (segundos >= LIMITES_PREPARACAO_MINUTOS.critico * 60) return 'CRITICO';
  if (segundos >= LIMITES_PREPARACAO_MINUTOS.atraso * 60) return 'ATRASADO';
  return 'NORMAL';
}

function apresentar(row, agora) {
  const estado = row && row.estado ? row.estado : 'NAO_ENVIADO';
  const enviadoEm = row && row.enviado_em ? row.enviado_em : null;
  const concluidoEm = row && row.concluido_em ? row.concluido_em : null;
  const classificacao = classificar(estado, enviadoEm, concluidoEm, agora);
  const fim = classificacao === 'CONCLUIDO' && concluidoEm ? concluidoEm : agora;
  return {
    estado,
    enviado_em: enviadoEm,
    concluido_em: concluidoEm,
    operador_envio_id: row && row.operador_envio_id != null ? row.operador_envio_id : null,
    operador_conclusao_id: row && row.operador_conclusao_id != null ? row.operador_conclusao_id : null,
    classificacao,
    tempo_decorrido_segundos: classificacao === 'NAO_ENVIADO' || !enviadoEm ? null : segundosEntre(enviadoEm, fim)
  };
}

function emTransacao(db, trabalho) {
  const anterior = filas.get(db) || Promise.resolve();
  const execucao = anterior.then(() => trabalhoEmTransacao(db, trabalho), () => trabalhoEmTransacao(db, trabalho));
  filas.set(db, execucao.then(() => undefined, () => undefined));
  return execucao;
}

async function trabalhoEmTransacao(db, trabalho) {
  await run(db, 'BEGIN IMMEDIATE');
  try {
    const resultado = await trabalho();
    await run(db, 'COMMIT');
    return resultado;
  } catch (err) {
    try { await run(db, 'ROLLBACK'); } catch (_rollback) { /* a transação já pode ter sido desfeita */ }
    throw err;
  }
}

async function agoraServidor(db, opts) {
  const informado = instanteInformado(opts);
  if (informado) return informado;
  const row = await get(db, `SELECT datetime('now') AS agora`);
  return row.agora;
}

async function lerPedido(db, empresaId, pedidoId) {
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro('Pedido não encontrado.', 404, 'PEDIDO_NAO_ENCONTRADO');
  }
  const pedido = await get(db, `
    SELECT id, codigo, status, empresa_id, total, mesa_id, mesa_atendimento_id
    FROM pedidos WHERE id = ?
  `, [id]);
  if (!pedido || Number(pedido.empresa_id) !== empresaId) {
    throw erro('Pedido não encontrado.', 404, 'PEDIDO_NAO_ENCONTRADO');
  }
  return pedido;
}

async function lerPreparacao(db, pedidoId) {
  return get(db, 'SELECT * FROM pedido_preparacoes WHERE pedido_id = ?', [pedidoId]);
}

async function exigirAtendimentoAberto(db, empresaId, atendimentoId) {
  const atendimento = await get(db, `
    SELECT id, empresa_id, estado FROM mesa_atendimentos
    WHERE id = ? AND empresa_id = ?
  `, [atendimentoId, empresaId]);
  if (!atendimento) {
    throw erro('Atendimento não encontrado.', 404, 'ATENDIMENTO_NAO_ENCONTRADO');
  }
  if (atendimento.estado === 'FECHAMENTO') {
    throw erro('O atendimento está em fechamento e não recebe envio à preparação.', 409, 'ATENDIMENTO_EM_FECHAMENTO');
  }
  if (atendimento.estado === 'ENCERRADO') {
    throw erro('O atendimento já está encerrado.', 409, 'ATENDIMENTO_JA_ENCERRADO');
  }
  if (atendimento.estado !== 'OCUPADA') {
    throw erro('O atendimento não está aberto.', 409, 'ATENDIMENTO_NAO_ABERTO');
  }
  return atendimento;
}

function rejeitarChaveDivergente() {
  throw erro('A chave de idempotência já foi usada em outro contexto.', 409, 'CHAVE_IDEMPOTENCIA_DIVERGENTE');
}

async function registrarNaoEnviado({ db, empresaId, pedidoId, atendimentoId }) {
  await run(db, `
    INSERT INTO pedido_preparacoes (
      empresa_id, pedido_id, atendimento_id, estado, updated_at
    ) VALUES (?, ?, ?, 'NAO_ENVIADO', datetime('now'))
  `, [empresaId, pedidoId, atendimentoId]);
}

async function resolverDestinoPendente(db, empresaId, pedidoId) {
  const colunas = await all(db, 'PRAGMA table_info(pedidos)');
  const nomes = new Set((colunas || []).map((coluna) => String(coluna.name)));
  if (!nomes.has('cozinha_resolucao_status') || !nomes.has('unidade_cozinha_destino_id')) return;

  const campoOrigem = nomes.has('origem_canal') ? 'origem_canal' : 'NULL AS origem_canal';
  const campoCanal = nomes.has('cozinha_canal_codigo')
    ? 'cozinha_canal_codigo'
    : 'NULL AS cozinha_canal_codigo';
  const pedido = await get(db, `
    SELECT cozinha_resolucao_status, unidade_cozinha_destino_id,
           ${campoOrigem}, ${campoCanal}
    FROM pedidos
    WHERE id = ? AND empresa_id = ?
  `, [pedidoId, empresaId]);

  if (
    !pedido
    || (String(pedido.cozinha_resolucao_status || '') === 'RESOLVIDO'
      && pedido.unidade_cozinha_destino_id != null)
  ) return;

  const canalCodigo = pedido.origem_canal || pedido.cozinha_canal_codigo;
  const ResolucaoDestino = require('../cozinha/CozinhaResolucaoDestinoService');
  const PedidoRepository = require('./PedidoRepository');
  const resolucao = await ResolucaoDestino.resolverDestinoPedido({
    empresaId,
    canalCodigo
  }, { db });
  await PedidoRepository.persistirResolucaoDestinoCozinha(
    pedidoId,
    empresaId,
    resolucao,
    { db }
  );
}

async function despacharParaKds(db, empresaId, pedidoId, operadorId) {
  let resultado;
  try {
    await resolverDestinoPendente(db, empresaId, pedidoId);
    const CozinhaDespachoPedido = require('../cozinha/CozinhaDespachoPedidoService');
    resultado = await CozinhaDespachoPedido.despacharPedidoResolvido({
      empresaId,
      pedidoId,
      operadorId
    }, { db });
  } catch (err) {
    const codigo = err && (err.codigo || err.code)
      ? String(err.codigo || err.code)
      : 'DESPACHO_KDS_FALHA';
    resultado = {
      success: false,
      status: 'FALHA',
      codigo,
      empresa_id: empresaId,
      pedido_id: Number(pedidoId),
      unidade_id: null,
      rodada_id: null,
      repetida: false,
      bloqueado: false,
      mensagem: err && err.message ? String(err.message) : 'Falha inesperada no despacho KDS.'
    };
  }

  if (!resultado || resultado.success !== true) {
    console.warn(JSON.stringify({
      evento: 'COZINHA_DESPACHO_PEDIDO_RESULTADO',
      codigo: resultado && resultado.codigo ? String(resultado.codigo) : 'DESPACHO_KDS_SEM_RESULTADO',
      status: resultado && resultado.status ? String(resultado.status) : 'FALHA',
      pedido_id: Number(pedidoId),
      empresa_id: empresaId,
      unidade_id: resultado && resultado.unidade_id != null ? Number(resultado.unidade_id) : null,
      mensagem: resultado && resultado.mensagem ? String(resultado.mensagem).slice(0, 240) : null
    }));
  }

  return resultado;
}

async function enviar(empresaId, pedidoId, entrada = {}, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const chave = normalizarChave(entrada.idempotencyKey);
  const db = conn(opts);
  const marca = instanteInformado(opts);
  let resultadoPreparacao;
  try {
    resultadoPreparacao = await emTransacao(db, async () => {
      if (chave) {
        const outra = await get(db, `
          SELECT pedido_id, empresa_id FROM pedido_preparacoes WHERE idempotency_key_envio = ?
        `, [chave]);
        if (outra && (Number(outra.pedido_id) !== Number(pedidoId) || Number(outra.empresa_id) !== emp)) {
          rejeitarChaveDivergente();
        }
      }
      const pedido = await lerPedido(db, emp, pedidoId);
      if (pedido.mesa_atendimento_id == null) {
        throw erro('Pedido sem atendimento de salão.', 409, 'PEDIDO_FORA_DO_SALAO');
      }
      if (!STATUS_ENVIAVEIS.includes(String(pedido.status || '').toUpperCase())) {
        throw erro('O pedido não está em estado que permite envio à preparação.', 409, 'PREPARACAO_ESTADO_INCOMPATIVEL');
      }
      const preparacao = await lerPreparacao(db, pedido.id);
      if (
        preparacao
        && (preparacao.estado === 'EM_PREPARACAO' || preparacao.estado === 'CONCLUIDO')
      ) {
        const agora = await agoraServidor(db, opts);
        return { success: true, repetida: true, preparacao: apresentar(preparacao, agora) };
      }
      await exigirAtendimentoAberto(db, emp, pedido.mesa_atendimento_id);
      const atualizado = await run(db, `
        UPDATE pedido_preparacoes
        SET estado = 'EM_PREPARACAO',
            enviado_em = COALESCE(?, datetime('now')),
            operador_envio_id = ?,
            idempotency_key_envio = COALESCE(idempotency_key_envio, ?),
            updated_at = datetime('now')
        WHERE pedido_id = ? AND empresa_id = ? AND estado = 'NAO_ENVIADO'
      `, [marca, operadorId, chave, pedido.id, emp]);
      if (atualizado.changes !== 1) {
        const atual = await lerPreparacao(db, pedido.id);
        if (atual && (atual.estado === 'EM_PREPARACAO' || atual.estado === 'CONCLUIDO')) {
          const agora = await agoraServidor(db, opts);
          return { success: true, repetida: true, preparacao: apresentar(atual, agora) };
        }
        throw erro('O envio à preparação mudou durante a operação.', 409, 'PREPARACAO_CONCORRENTE');
      }
      const gravado = await lerPreparacao(db, pedido.id);
      const agora = await agoraServidor(db, opts);
      return { success: true, repetida: false, preparacao: apresentar(gravado, agora) };
    });
  } catch (err) {
    if (err && err.codigo) throw err;
    if (chave && /idempotency_key_envio/i.test(String(err.message || ''))) {
      const outra = await get(db, `
        SELECT pedido_id, empresa_id FROM pedido_preparacoes WHERE idempotency_key_envio = ?
      `, [chave]);
      if (outra && (Number(outra.pedido_id) !== Number(pedidoId) || Number(outra.empresa_id) !== emp)) {
        rejeitarChaveDivergente();
      }
      const atual = await lerPreparacao(db, pedidoId);
      if (atual && (atual.estado === 'EM_PREPARACAO' || atual.estado === 'CONCLUIDO')) {
        const agora = await agoraServidor(db, opts);
        resultadoPreparacao = { success: true, repetida: true, preparacao: apresentar(atual, agora) };
      }
    }
    if (!resultadoPreparacao) throw err;
  }

  const despacho = await despacharParaKds(db, emp, pedidoId, operadorId);
  return { ...resultadoPreparacao, despacho };
}

async function concluir(empresaId, pedidoId, entrada = {}, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const operadorId = exigirOperador(entrada.operadorId);
  const chave = normalizarChave(entrada.idempotencyKey);
  const db = conn(opts);
  const marca = instanteInformado(opts);
  try {
    return await emTransacao(db, async () => {
      if (chave) {
        const outra = await get(db, `
          SELECT pedido_id, empresa_id FROM pedido_preparacoes WHERE idempotency_key_conclusao = ?
        `, [chave]);
        if (outra && (Number(outra.pedido_id) !== Number(pedidoId) || Number(outra.empresa_id) !== emp)) {
          rejeitarChaveDivergente();
        }
      }
      const pedido = await lerPedido(db, emp, pedidoId);
      const preparacao = await lerPreparacao(db, pedido.id);
      if (!preparacao || preparacao.estado === 'NAO_ENVIADO') {
        throw erro('O pedido ainda não foi enviado à preparação.', 409, 'PREPARACAO_NAO_ENVIADA');
      }
      if (preparacao.estado === 'CONCLUIDO') {
        const agora = await agoraServidor(db, opts);
        return { success: true, repetida: true, preparacao: apresentar(preparacao, agora) };
      }
      const atualizado = await run(db, `
        UPDATE pedido_preparacoes
        SET estado = 'CONCLUIDO',
            concluido_em = COALESCE(?, datetime('now')),
            operador_conclusao_id = ?,
            idempotency_key_conclusao = COALESCE(idempotency_key_conclusao, ?),
            updated_at = datetime('now')
        WHERE pedido_id = ? AND empresa_id = ? AND estado = 'EM_PREPARACAO'
      `, [marca, operadorId, chave, pedido.id, emp]);
      if (atualizado.changes !== 1) {
        const atual = await lerPreparacao(db, pedido.id);
        if (atual && atual.estado === 'CONCLUIDO') {
          const agora = await agoraServidor(db, opts);
          return { success: true, repetida: true, preparacao: apresentar(atual, agora) };
        }
        throw erro('A conclusão da preparação mudou durante a operação.', 409, 'PREPARACAO_CONCORRENTE');
      }
      const gravado = await lerPreparacao(db, pedido.id);
      const pedidoDepois = await lerPedido(db, emp, pedido.id);
      if (pedidoDepois.status !== pedido.status || Number(pedidoDepois.total) !== Number(pedido.total)) {
        throw erro('A conclusão não pode alterar o pedido.', 409, 'PREPARACAO_CONCORRENTE');
      }
      const agora = await agoraServidor(db, opts);
      return { success: true, repetida: false, preparacao: apresentar(gravado, agora) };
    });
  } catch (err) {
    if (err && err.codigo) throw err;
    if (chave && /idempotency_key_conclusao/i.test(String(err.message || ''))) {
      const outra = await get(db, `
        SELECT pedido_id, empresa_id FROM pedido_preparacoes WHERE idempotency_key_conclusao = ?
      `, [chave]);
      if (outra && (Number(outra.pedido_id) !== Number(pedidoId) || Number(outra.empresa_id) !== emp)) {
        rejeitarChaveDivergente();
      }
      const atual = await lerPreparacao(db, pedidoId);
      if (atual && atual.estado === 'CONCLUIDO') {
        const agora = await agoraServidor(db, opts);
        return { success: true, repetida: true, preparacao: apresentar(atual, agora) };
      }
    }
    throw err;
  }
}

async function listarPorMesa(empresaId, mesaId, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const MesaService = require('./MesaService');
  const MesaAtendimentoService = require('./MesaAtendimentoService');
  const db = conn(opts);
  const mesa = await MesaService.obterDaEmpresa(emp, mesaId, opts);
  const ativo = await MesaAtendimentoService.consultarAtivo(emp, mesa.id, opts);
  if (!ativo.atendimento) {
    return { success: true, atendimento_id: null, mesa_id: mesa.id, numero: mesa.numero, pedidos: [] };
  }
  const agora = await agoraServidor(db, opts);
  const colunasPedidos = await all(db, 'PRAGMA table_info(pedidos)');
  const nomesColunasPedidos = new Set((colunasPedidos || []).map((c) => String(c.name)));
  const temClienteNomeLivre = nomesColunasPedidos.has('cliente_nome');
  const clienteNomeSelect = temClienteNomeLivre
    ? "COALESCE(NULLIF(TRIM(p.cliente_nome), ''), c.nome)"
    : 'c.nome';
  const camposDespacho = [
    'cozinha_resolucao_status',
    'unidade_cozinha_destino_id',
    'cozinha_despacho_status',
    'cozinha_despacho_codigo',
    'cozinha_despacho_rodada_id'
  ];
  const camposDespachoSelect = camposDespacho.map((campo) =>
    nomesColunasPedidos.has(campo) ? `p.${campo}` : `NULL AS ${campo}`
  );
  const rows = await all(db, `
    SELECT p.id, p.codigo, p.status, p.total, p.mesa_atendimento_id,
           ${clienteNomeSelect} AS cliente_nome,
           pr.estado, pr.enviado_em, pr.concluido_em, pr.operador_envio_id, pr.operador_conclusao_id,
           ${camposDespachoSelect.join(', ')}
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    LEFT JOIN pedido_preparacoes pr ON pr.pedido_id = p.id AND pr.empresa_id = p.empresa_id
    WHERE p.empresa_id = ? AND p.mesa_atendimento_id = ?
    ORDER BY p.id
  `, [emp, ativo.atendimento.id]);
  return {
    success: true,
    atendimento_id: ativo.atendimento.id,
    mesa_id: ativo.atendimento.mesa_id,
    numero: mesa.numero,
    pedidos: rows.map((row) => ({
      id: row.id,
      codigo: row.codigo,
      status: row.status,
      total: row.total,
      cliente_nome: row.cliente_nome || null,
      mesa_atendimento_id: row.mesa_atendimento_id,
      preparacao: apresentar(row, agora),
      despacho: {
        resolucao_status: row.cozinha_resolucao_status || null,
        status: row.cozinha_despacho_status || null,
        codigo: row.cozinha_despacho_codigo || null,
        unidade_id: row.unidade_cozinha_destino_id != null ? Number(row.unidade_cozinha_destino_id) : null,
        rodada_id: row.cozinha_despacho_rodada_id != null ? Number(row.cozinha_despacho_rodada_id) : null
      }
    }))
  };
}

module.exports = {
  registrarNaoEnviado,
  enviar,
  concluir,
  listarPorMesa,
  classificar
};
