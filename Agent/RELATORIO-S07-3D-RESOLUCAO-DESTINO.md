# RELATÓRIO — S07-3D Resolução automática do destino

**Data:** 2026-11-18  
**Escopo:** origem + roteamento. **Sem despacho ao KDS.**  
**Status:** implementação entregue para auditoria (não autoaprovada).

---

## 1. Resumo

Serviço central `CozinhaResolucaoDestinoService` consulta `cozinha_canais` / `cozinha_canal_destinos` / `cozinha_unidades` e devolve resultado estruturado. Integrado em `PedidoOperacionalService.criar` quando há `origemCanal`. Snapshot gravado no pedido; alteração futura do roteamento não move pedidos já `RESOLVIDO`.

## 2. Arquivos

| Ação | Arquivo |
|------|---------|
| criado | `backend/services/cozinha/CozinhaResolucaoDestinoService.js` |
| criado | `backend/utils/pedidosDestinoCozinhaSchema.js` |
| criado | `backend/migrations/s07-3d-pedido-destino-cozinha.sql` |
| criado | `tests/cozinha/sprint07-s07-3d-resolucao-destino.test.js` |
| modificado | `backend/services/pedido/PedidoOperacionalService.js` |
| modificado | `backend/services/pedido/PedidoRepository.js` |
| modificado | `backend/services/pedido/EntradaPedidoService.js` (doc) |

## 3. Fluxos de entrada e origem

- **Loja / garçom:** `POST /api/pedidos` → adaptador `EQUIPE` → resolução mapeia para canal de cozinha **`LOJA`**.
- **iFood / WhatsApp / cardápio online:** sem integração real; o serviço aceita os códigos (`IFOOD`, `WHATSAPP`, `PEDIDO_ONLINE`) quando cadastrados na S07-3C.
- Origem **não** é deduzida de cliente/produtos; **não** confia em `canal` do body.

## 4. Contrato

Ver `Agent/EVIDENCIA-S07-3D-CONTRATO-PERSISTENCIA.md`.

## 5. Campos

- Reutilizado: `origem_canal`
- Novos (migration, não aplicada no oficial): `cozinha_canal_codigo`, `unidade_cozinha_destino_id`, `cozinha_resolucao_status`

## 6. Migration

`backend/migrations/s07-3d-pedido-destino-cozinha.sql`  
Impacto: 3 colunas nullable + 2 índices em `pedidos`. Sem alteração do schema v3 da Cozinha. **Não executada no oficial.**

## 7. Testes

| Suite | Resultado |
|-------|-----------|
| S07-3D | **18/18 PASS** — `Agent/LOG-S07-3D-RESOLUCAO-DESTINO.txt` |
| Regressão 3A+3B+3C | **52/52 PASS** — `Agent/LOG-S07-3D-REGRESSAO-3A-3B-3C.txt` |

Flags: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`, `DB_DIR` temp, `CDS_ALLOW_OFFICIAL_DB` ausente.

## 8. Despacho

**Não houve despacho para o KDS.** O serviço fixa `despacho: false` e não referencia `CozinhaDespachoService`.

## 9. Banco oficial

**Não acessado / não alterado.** Migration não aplicada no oficial.

## 10. Diff

`Agent/DIFF-S07-3D-RESOLUCAO-DESTINO.patch`
