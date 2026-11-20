'use strict';

function get(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
  });
}

function all(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function run(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function done(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function erro(mensagem, statusCode, codigo) {
  return Object.assign(new Error(mensagem), { statusCode, codigo });
}

async function registrar(db, { empresaId, unidadeId, pedidoId, rodadaId, chave }) {
  const cabecalho = await get(db, `
    SELECT r.id AS rodada_id, r.numero_rodada, r.enviada_em, r.operador_envio_id,
           r.mesa_id, m.numero AS mesa_numero, p.codigo AS pedido_codigo,
           p.observacao AS observacao_geral,
           COALESCE(NULLIF(u.nome, ''), u.username) AS garcom
    FROM cozinha_rodadas r
    JOIN mesas m ON m.id = r.mesa_id AND m.empresa_id = r.empresa_id
    JOIN pedidos p ON p.id = ? AND p.empresa_id = r.empresa_id
    LEFT JOIN usuarios u ON u.id = r.operador_envio_id
    WHERE r.id = ? AND r.empresa_id = ? AND r.unidade_id = ?
  `, [pedidoId, rodadaId, empresaId, unidadeId]);
  if (!cabecalho) throw erro('Dados da rodada indisponíveis para o snapshot.', 409, 'SNAPSHOT_RODADA_INVALIDA');
  const colunasPedido = await all(db, 'PRAGMA table_info(pedidos_itens)');
  const temPersonalizacao = colunasPedido.some((coluna) => coluna.name === 'personalizacao_ingredientes_snapshot');
  const itens = await all(db, `
    SELECT i.id, i.pedido_item_id, i.produto_id, i.produto_nome_snapshot AS nome,
           i.qty_solicitada_millis, i.observacoes_snapshot AS observacao, i.tipo_item,
           ${temPersonalizacao ? 'pi.personalizacao_ingredientes_snapshot' : '0'} AS personalizacao_registrada,
           c.id AS comanda_id, c.numero_comanda
    FROM cozinha_itens i
    JOIN cozinha_comandas c ON c.id = i.comanda_id AND c.empresa_id = i.empresa_id
    JOIN pedidos_itens pi ON pi.id = i.pedido_item_id AND pi.pedido_id = i.pedido_id
    WHERE i.empresa_id = ? AND i.unidade_id = ? AND i.rodada_id = ? AND i.pedido_id = ?
    ORDER BY i.id
  `, [empresaId, unidadeId, rodadaId, pedidoId]);
  if (!itens.length) throw erro('Rodada sem itens do pedido.', 409, 'SNAPSHOT_SEM_ITENS');
  const ingredientes = await all(db, `
    SELECT ci.cozinha_item_id, ci.insumo_id, ci.insumo_nome_snapshot AS nome,
           ci.quantidade_snapshot_millis, ci.unidade_snapshot AS unidade,
           ci.classificacao_comercial_snapshot AS classificacao, ci.selecionado
    FROM cozinha_item_ingredientes ci
    JOIN cozinha_itens i ON i.id = ci.cozinha_item_id
    WHERE i.empresa_id = ? AND i.unidade_id = ? AND i.rodada_id = ? AND i.pedido_id = ?
    ORDER BY ci.id
  `, [empresaId, unidadeId, rodadaId, pedidoId]);
  for (const item of itens) {
    const componentes = ingredientes.filter((ing) => Number(ing.cozinha_item_id) === Number(item.id));
    const confiavel = Number(item.personalizacao_registrada) === 1 && componentes.length > 0
      && new Set(componentes.map((ing) => Number(ing.insumo_id))).size === componentes.length
      && componentes.some((ing) => Number(ing.selecionado) === 1)
      && componentes.every((ing) => Number.isSafeInteger(Number(ing.insumo_id)) && Number(ing.insumo_id) > 0
        && typeof ing.nome === 'string' && ing.nome.trim()
        && ing.nome.trim() !== `#${ing.insumo_id}` && typeof ing.unidade === 'string' && ing.unidade.trim()
        && Number.isSafeInteger(Number(ing.quantidade_snapshot_millis)) && Number(ing.quantidade_snapshot_millis) > 0
        && ['OBRIGATORIO_OCULTO', 'OPCIONAL', 'OPCIONAL_COM_ADICIONAL'].includes(ing.classificacao)
        && [0, 1].includes(Number(ing.selecionado))
        && (ing.classificacao !== 'OBRIGATORIO_OCULTO' || Number(ing.selecionado) === 1));
    item.composicao_confiavel = confiavel;
    item.ingredientes = confiavel ? componentes.map(({ cozinha_item_id, ...ing }) => ing) : [];
    delete item.personalizacao_registrada;
  }
  const conteudo = { empresa_id: empresaId, unidade_id: unidadeId, pedido_id: pedidoId,
    identificador_envio: chave, ...cabecalho, itens };
  await run(db, `
    INSERT INTO cozinha_comanda_snapshots
      (empresa_id, unidade_id, pedido_id, rodada_id, idempotency_key, conteudo_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [empresaId, unidadeId, pedidoId, rodadaId, chave, JSON.stringify(conteudo)]);
}

async function obter(db, empresaId, unidadeId, snapshotId) {
  const row = await get(db, `
    SELECT s.* FROM cozinha_comanda_snapshots s
    JOIN cozinha_pedido_despachos d ON d.empresa_id = s.empresa_id
      AND d.unidade_id = s.unidade_id AND d.pedido_id = s.pedido_id
      AND d.rodada_id = s.rodada_id AND d.idempotency_key = s.idempotency_key
      AND d.status = 'CONCLUIDO'
    WHERE s.id = ? AND s.empresa_id = ? AND s.unidade_id = ?
      AND s.disponibilidade = 'DISPONIVEL'
  `, [snapshotId, empresaId, unidadeId]);
  if (!row) throw erro('Comanda indisponível para esta empresa e unidade.', 404, 'SNAPSHOT_NAO_DISPONIVEL');
  return { id: row.id, conteudo: JSON.parse(row.conteudo_json) };
}

module.exports = { registrar, obter, get, run, erro };
