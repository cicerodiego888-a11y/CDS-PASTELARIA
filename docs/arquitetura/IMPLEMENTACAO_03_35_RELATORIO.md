# Relatório — Implementação 03.35
## Leitura multiempresa de `consultarSaldo`

**Data:** 2026-08-21 · **Status:** concluída

### O que mudou

`backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js`:

- `consultarSaldo` com `opts.empresaId` → `EstoqueEmpresaService.consultarSaldoParaEmpresa`
- sem registro → zero
- sem `empresaId` → `produtos`
- writers usam `consultarSaldoEmProdutos` (produtos + dual-write intactos)

Não se alterou MTS, Motor Comercial, Pedido, reservas, schema nem dual-write.

### Sem empresa

100% legado.

### Com empresa

Saldos isolados. A não vê B. `produtos` não autoriza a empresa errada no MTS.

### Empresa sem registro

Zero. Não cria linha.

### Pedido / MTS

Caller real: `MtsService.transferirSaldo` → `consultarSaldo`.

- B SF=3, produtos=100, qty 5 → bloqueado
- A SF=10, qty 5 → permitido
- sem empresa → COMPAT

Pedido→MC→MTS: quando o plano transfere, o MTS usa a porta isolada.

### Testes novos

| Arquivo | Resultado |
|---|---|
| `consulta-saldo-porta-multiempresa.test.js` | 12/12 |
| `pedido-mts-disponibilidade-multiempresa.test.js` | 5/5 |

### Regressão

| Suite | Resultado |
|---|---|
| mts-multiempresa-contexto | 10/10 |
| pedido-expedicao-multiempresa-contexto | 12/12 |
| dual-write-porta-publica-empresa-03-19 | 15/15 |
| porta-publica-saldos-multiempresa | 17/17 |
| reservas-dual-write-empresa | 12/12 |
| venda-baixa-empresa-contexto | 12/12 |
| compras-multiempresa-contexto | 12/12 |
| muc-public-contract | 20/20 |
| credito/debito compra porta | 11/11 e 12/12 |

Suítes 03.12–03.15, 03.18 e cadastro 03.1 atualizadas no contrato de leitura da porta.

### Limitações

Disponibilidade do Pedido *antes* do MTS ainda lê `produtos` via `reservasPublico`.

Sprint **03.36 não iniciada**.
