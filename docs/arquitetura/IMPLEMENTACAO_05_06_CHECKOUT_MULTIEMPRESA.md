# Sprint 05.06 — Checkout MULTIEMPRESA + Atendimento MUV

## Fluxo

PDV Universal → `POST /api/pdv-universal/checkout` → `resolverModoOperacaoVendaAtivo()` → `AtendimentoMultiempresaService.criarAtendimento`.

Resultado: atendimento `VALIDADO`, operações `VALIDADA`, `pagamento_pendente: true`, sem `venda_id`.

## Autoridade

Agrupamento e estoque continuam no MUV. O item carrega `produto_id` + `empresa_id`. A empresa do contexto operacional não substitui a empresa do item.

## Fora de escopo

Reserva, pagamento, TEF, materialização, NFC-e, impressão, sprint 05.07.
