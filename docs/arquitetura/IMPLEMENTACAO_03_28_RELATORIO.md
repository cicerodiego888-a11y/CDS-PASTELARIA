# Relatório — Implementação 03.28
## Inventário e ajuste administrativo multiempresa

**Data:** 2026-08-21 · **Status:** concluída

---

## 1. Fluxos auditados

Ajuste HTTP, PUT de saldos iniciais, CREATE de saldo inicial, recálculo HTTP, importação inicial/quantidades, leituras de histórico/relatório, GET `estoque/empresa`, bootstrap de recálculo em `database.js`. Não há módulo de inventário/contagem.

## 2. Escritores reais

Ajuste, saldos iniciais (PUT e CREATE), recálculo HTTP, importação (mesmo `aplicarAjusteEstoqueProduto`). Já usavam crédito/débito F/NF pela porta — não foi preciso inventar distribuição.

## 3. Descartados

Inventário (inexistente). GET histórico/relatório/`tem-movimentacoes`. GET estoque por empresa (03.18, leitura). Migração `migrarRecalcularSaldosEstoque` (C).

## 4. Alterações

`empresaIdDoReqAjuste(req)` nos callers HTTP. Montadores da porta só leem `opcoes.empresaId`. CREATE deixa de encaminhar `req`/`contexto`. Importação: middleware + `empresaId` até o ajuste. Frontend do ajuste envia `X-Empresa-Id`.

## 5. Origem final do empresaId

`req.empresaId` validado.

## 6. Sem empresa

COMPAT existente (`COMPAT_AJUSTE_ESTOQUE_PRE_MULTIEMPRESA`, recálculo, CREATE). Só `produtos`. Sem empresa 1. Sem copiar legado para `estoque_empresa`.

## 7. Dual-write

Reutilizado na porta 03.19 (`aplicarEfeitoSaldo`). Sem espelho no domínio de ajuste.

## 8. Impacto em produtos

Storage oficial da fase. O ajuste continua creditando/debitando SF/SNF e `estoque_atual = SF+SNF`.

## 9. Impacto em estoque_empresa

Recebe o mesmo delta quando há `empresaId`. Sem empresa, nenhuma linha.

## 10. Transação / rollback

Mesmo `db` do caller. Sem BEGIN próprio. Rollback externo restaura `produtos` e `estoque_empresa`.

## 11. Isolamento

A +10 não altera B. B +20 isolado.

## 12–13. Testes / regressão

`inventario-ajuste-multiempresa-contexto.test.js`: 13/13 OK.

| Suite | Resultado |
|---|---|
| `inventario-ajuste-multiempresa-contexto.test.js` | 13/13 OK |
| `ajuste-estoque-porta-publica.test.js` (02.1) | 15/15 OK |
| `recalculo-saldos-porta-publica.test.js` (02.2) | 15/15 OK |
| `create-produto-saldo-inicial-porta-publica.test.js` (03.8) | 10/10 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `dual-write-porta-publica-empresa-03-19.test.js` | 15/15 OK |
| `reservas-dual-write-empresa.test.js` (03.20) | 12/12 OK |
| `venda-baixa-empresa-contexto.test.js` (03.25) | 12/12 OK |
| `reservas-pdv-multiempresa-contexto.test.js` (03.26) | 10/10 OK |
| `compras-multiempresa-contexto.test.js` (03.27) | 12/12 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

A suíte `importacao-inicial-modo-fiscal-v1018` falha por schema de fixture (`produtos.reservado_fiscal` ausente na porta). Não é regressão desta sprint: o writer 02.1 no mesmo caminho passou.

## 14. Pendentes

Não há inventário físico para migrar. Recálculo bootstrap permanece COMPAT. PUT de saldos iniciais aplica delta contra `produtos`, não saldo absoluto em `estoque_empresa`.

Não iniciar a Sprint 03.29.
