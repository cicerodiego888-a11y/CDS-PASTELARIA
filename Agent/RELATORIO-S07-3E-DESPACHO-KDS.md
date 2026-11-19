# RELATÓRIO — S07-3E Despacho controlado ao KDS

**Data:** 2026-11-18  
**Escopo:** despacho pós-resolução S07-3D. Sem iFood/WhatsApp/PDV. S06 congelada.  
**Status:** entrega para auditoria (não autoaprovada).

---

## 1. Resumo

Orquestrador `CozinhaDespachoPedidoService` despacha pedidos com `cozinha_resolucao_status = RESOLVIDO` para a unidade persistida, via `CozinhaDespachoService.despacharLote` existente. Integração em `PedidoOperacionalService.criar` **após COMMIT** comercial.

## 2. Arquivos

| Ação | Arquivo |
|------|---------|
| criado | `backend/services/cozinha/CozinhaDespachoPedidoService.js` |
| criado | `backend/utils/pedidosDespachoCozinhaSchema.js` |
| criado | `backend/migrations/s07-3e-pedido-despacho-kds.sql` |
| criado | `tests/cozinha/sprint07-s07-3e-despacho-kds.test.js` |
| modificado | `backend/services/pedido/PedidoOperacionalService.js` |

## 3. Fluxo

Ver `Agent/EVIDENCIA-S07-3E-FLUXO-IDEMPOTENCIA.md`.

Pré-requisito operacional do KDS atual: pedido com **mesa + atendimento** (schema de rodadas exige esses campos). Sem mesa → `BLOQUEADO` (`DESPACHO_MESA_OBRIGATORIA`), pedido comercial preservado.

## 4. Idempotência

Tabela `cozinha_pedido_despachos` com `UNIQUE(empresa_id, pedido_id)` + chave estável + idempotência do `despacharLote`.

## 5. Migration

`s07-3e-pedido-despacho-kds.sql` — **não executada no oficial**.

## 6. Testes

| Suite | Resultado |
|-------|-----------|
| S07-3E | **16/16 PASS** — `Agent/LOG-S07-3E-DESPACHO-KDS.txt` |
| Regressão 3A–3D + S06 B1/B2 | **97/97 PASS** — `Agent/LOG-S07-3E-REGRESSAO.txt` |

Flags + DB temp. Oficial intocado.

## 7. S06

Nenhum arquivo de impressão/fila/worker/driver alterado.

## 8. Diff

`Agent/DIFF-S07-3E-DESPACHO-KDS.patch`
