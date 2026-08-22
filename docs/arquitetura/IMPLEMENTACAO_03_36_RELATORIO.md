# Relatório — Implementação 03.36
## Disponibilidade multiempresa nas reservas

**Data:** 2026-08-21 · **Status:** concluída

### O que mudou

`backend/services/fiscalNaoFiscal/reservasPublico.js` — `consultarDisponibilidade`:

- com `opts.empresaId` → `estoque_empresa` + fórmula atual
- sem registro → zero
- sem `empresaId` → `produtos` / COMPAT

Pedido e Motor Comercial não foram alterados: `empresaId` já chegava via `optsPortaSaldos` (03.30).

### Integração

Pedido B qty 5 / disp 3 → `SALDO_INSUFICIENTE`.  
Pedido A qty 5 / disp 8 → permitido.  
Disponibilidade e MTS usam `estoque_empresa` quando há empresa.

### Testes novos

12/12 e 4/4.

### Regressão

| Suite | Resultado |
|---|---|
| consulta-saldo-porta-multiempresa | 12/12 |
| pedido-mts-disponibilidade-multiempresa | 5/5 |
| mts-multiempresa-contexto | 10/10 |
| pedido-expedicao-multiempresa-contexto | 12/12 |
| reservas-dual-write-empresa | 12/12 |
| reservas-pdv-multiempresa-contexto | 10/10 |
| porta-publica-saldos-multiempresa | 17/17 |
| dual-write-porta-publica-empresa-03-19 | 15/15 |
| muc-public-contract | 20/20 |

Sprint **03.37 não iniciada**.
