# RISCOS ENCONTRADOS — Sprint 05.51

Inspeção durante isolamento de crédito/liberação de reservas. **Não implementados.**

| Item | Nota |
|------|------|
| `montarOptsPortaReservaPdv` ainda monta COMPAT na **criação** de reserva PDV | fora do caminho liberação/crédito de reserva persistida |
| `ajustarReservado` / `liberarQuantidadeReservada` aceitam COMPAT se o caller setar `modoLegadoSemEmpresa` sem linha de reserva | porta genérica F×NF; callers com reserva persistida passam dona |
| `creditarDisponibilidadeComReservaPedido` agrega crédito sem filtro `empresa_id` | só cálculo de disponibilidade; não muta estoque (já 05.50) |
| ReservaRepair `handlerLiberarReserva` | ownership 05.49; não reescrito nesta sprint |
| Liberação MUV (`AtendimentoMultiempresaService`) | domínio MUV; não auditado a fundo |
| `consumirReservasDaVenda` ainda chama `reduzirEstoqueDistribuido` (baixa física) | regra de venda/FEFO; só a liberação de reservado foi alinhada à dona |
| Acervo `empresa_id` NULL em tracking | bloqueado na operação; sem backfill |
| Expiração / scheduler | inexistente |
