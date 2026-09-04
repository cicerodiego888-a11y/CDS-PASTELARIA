# OWNERSHIP CONSUMO FÍSICO DE RESERVA PDV — Sprint 05.53

**Status:** implementado  
**Data:** 2026-08-25  
**Escopo:** baixa física no consumo de `venda_estoque_reservas`.

## Auditoria

| Peça | Arquivo | Empresa antes | Risco |
|------|---------|---------------|-------|
| `consumirReservasDaVenda` | `EstoqueConsumoReserva.js` | `{ ...opcoes, empresaId: dona }` | D — spread podia levar `modoLegadoSemEmpresa` / COMPAT |
| `reduzirEstoqueDistribuido` | `VendaPagamentoService.js` | `opcoes.empresaId` | genérico; depende do caller |
| `atualizarSaldoProdutoAposBaixa` → `debitarEstoqueItemVenda` | débito venda | `montarOptsPortaDebitoVenda` ainda tem COMPAT se sem empresa | C fora do path se `exigirEmpresa` + `empresaId` |
| Liberação de reservado (mesmo arquivo) | já 05.51 | dona | A |

## Contrato depois

```
1. carregar venda + reservas ATIVAS
2. reserva.empresa_id obrigatório → senão EMPRESA_OWNERSHIP_REQUIRED
3. caller ≠ dona → RESERVA_EMPRESA_DIVERGENTE
4. venda.empresa_id ≠ reserva.empresa_id → OPERACAO_EMPRESA_DIVERGENTE
5. baixa física com opts limpos: empresaId = reserva.empresa_id, exigirEmpresa: true
6. liberar reservado na mesma empresa
7. status CONSUMIDA
```

`montarOpcoesBaixaFisicaDaReserva` **não** faz spread de `opcoes` do caller.

## COMPAT

**Eliminado** no caminho consumo físico de reserva PDV persistida (sem `modoLegadoSemEmpresa: true`, sem motivo COMPAT decidindo empresa).

**Mantido:** `montarOptsPortaDebitoVenda` COMPAT em baixas de venda **sem** reserva (fora do escopo).

## Cadeia

```
venda.empresa_id = reserva.empresa_id = estoque_empresa.empresa_id
```
