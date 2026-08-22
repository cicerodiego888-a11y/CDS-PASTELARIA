# Implementação 03.35 — Leitura multiempresa da porta pública

**Data:** 2026-08-21

## Antes

`estoqueSaldosPublico.consultarSaldo` lia sempre `produtos`.

Pedido / MTS podiam receber `empresaId`, mas a autorização usava o saldo global.

## Depois

| Contexto | Origem | Sem registro |
|---|---|---|
| Sem `opts.empresaId` | `produtos` | n/a (COMPAT) |
| Com `opts.empresaId` | `estoque_empresa` | zero |

Zero = a empresa ainda não tem saldo isolado. Sem fallback, sem criar linha, sem backfill.

`empresaId` sai só de `opts.empresaId`. Body, query, `contexto`, `ctx` e `empresa_id` não substituem.

## Contrato

O objeto retornado é o mesmo:

`produto_id`, `empresa_id`, `legado`, `existe`, `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_atual`, `estoque_total`, `reservado_*`, `disponivel_*`.

Só muda a origem quando há empresa.

Produto inexistente continua `PRODUTO_NAO_ENCONTRADO` (a linha de `produtos` ainda é exigida).

## Writers

`_ajustarSaldo` e `transferirSaldoEntreTipos` leem `produtos` via `consultarSaldoEmProdutos`.

Se lessem `estoque_empresa`, o `UPDATE` absoluto em `produtos` destruiria o saldo global. Dual-write 03.19 permanece.

## Pedido / MTS

`MtsService.transferirSaldo` já chamava `consultarSaldo`. Com empresa B (SF=3) e `produtos` SF=100, transferir 5 é `SALDO_INSUFICIENTE`. Empresa A (SF=10) passa.

`Motor Comercial` não foi alterado. A disponibilidade *antes* do MTS ainda passa por `reservasPublico.consultarDisponibilidade` (`produtos`). Quando o plano chama o MTS, a porta isolada bloqueia a empresa errada.

## COMPAT

Sem `empresaId` + `modoLegadoSemEmpresa`: leitura de `produtos`. Nenhum COMPAT removido.

## Testes

- `tests/estoque/consulta-saldo-porta-multiempresa.test.js` (01–12)
- `tests/estoque/pedido-mts-disponibilidade-multiempresa.test.js`

## Limitações

1. `reservasPublico.consultarDisponibilidade` ainda lê `produtos`.
2. Sem tabela `empresas`, a leitura isolada não roda (mesmo critério do dual-write).
3. Storage oficial da **escrita** continua `produtos`.
4. Sem cutover, sem seletor visual, sem 03.36.
