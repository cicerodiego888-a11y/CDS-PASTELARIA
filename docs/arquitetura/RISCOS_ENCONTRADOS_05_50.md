# RISCOS ENCONTRADOS — Sprint 05.50

Inspeção durante a eliminação do COMPAT no consumo de reserva de pedido. **Não implementados** nesta sprint.

| Item | Por quê está fora | Nota |
|------|-------------------|------|
| `obterCreditoReservaPedido` agrega `pedido_estoque_reservas` sem filtro de `empresa_id` | leitura de disponibilidade; não é o writer de consumo | risco de crédito cruzado se tracking misturado; ownership de crédito não foi fechado aqui |
| Tabela `vendas` ausente ou venda inexistente com `vendaId` informado | não inventar venda | a validação pedido×venda só corre se a linha de venda existir |
| Venda com `empresa_id` NULL (linha encontrada) | tratado como divergência (`OPERACAO_EMPRESA_DIVERGENTE`) | não houve backfill de vendas |
| COMPAT em F×NF, crédito de venda, PDV `venda_estoque_reservas`, ajuste, compras | outros domínios | constante global permanece |
| `auditoria_pedido_estoque_fiscal` sem `empresa_id` | log, não writer | já 05.49 |
| Expiração / scheduler de reservas | fluxo inexistente | |
| NF-e 55 / DistDFe | proibido nesta sprint | |
| Acervo `pedidos`/`reservas` NULL | bloqueado na operação; sem backfill | |
| `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js` carrega `FaturamentoService` | bootstrap do banco oficial no `require` | o consume em memória já é coberto por 05.50 e pela suíte porta pública |
