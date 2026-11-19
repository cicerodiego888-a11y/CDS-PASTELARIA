# RELATÓRIO OBRIGATÓRIO — Sprint 03 Cozinha

**Projeto:** CDS Sistemas — Pastelaria  
**Módulo:** Cozinha  
**Sprint:** 03 — Motor de Preparação e Controle de Rodadas  
**Data:** 2026-11-16  
**Responsável implementação:** Cursor  
**Status:** IMPLEMENTADA E TESTADA — aguardando auditoria/aprovação do Product Owner  
**Sprint 04:** NÃO INICIADA

---

## 1. Resumo executivo

Foi implementado o motor backend de preparação da Cozinha sobre a persistência e o despacho das Sprints 01/02: iniciar preparação, marcar item pronto, entregar bebida (parcial/total), consultar estado da rodada e derivar automaticamente `RODADA_PRONTA` pelas regras PASTEL/OUTRO/BEBIDA. Classificação PASTEL|BEBIDA|OUTRO passou a ser calculada no domínio da Cozinha (Opção A + evidência de categoria refrigerante para bebida), sem alterar Pedido, PDV, estoque, ficha técnica, fiscal, TEF ou PIX. Testes em banco temporário: **17/17 Sprint 03** e **50/50 regressão S01+S02** (mais 5 HTTP S02 em execução separada).

---

## 2. Diagnóstico inicial

| Achado | Impacto |
|---|---|
| Schema S01 já possui `cozinha_itens.estado_preparacao`, `cozinha_rodadas.estado_preparacao`, `cozinha_bebida_entregas`, `cozinha_eventos_outbox` | Sem necessidade de novas tabelas |
| Despacho S02 gravava `tipo_item` sem política confiável PASTEL/BEBIDA (COMERCIAL→OUTRO) | Evoluir classificação no despacho |
| Auditoria de produtos recomendou Opção A + não inferir por nome | Adotar no módulo Cozinha |
| Não havia serviço/rotas de preparação | Criar `CozinhaPreparacaoService` + rotas |

---

## 3. Arquivos criados, modificados e excluídos

### Criados
| Arquivo | Função |
|---|---|
| `backend/services/cozinha/CozinhaPreparacaoService.js` | Motor de preparação |
| `backend/services/cozinha/cozinhaClassificacaoItem.js` | Classificação PASTEL/BEBIDA/OUTRO |
| `tests/cozinha/sprint03-preparacao.test.js` | Cobertura obrigatória S03 |
| `Agent/auditoria-sprint03-cozinha/*` | Relatório, logs e diff |

### Modificados
| Arquivo | Função |
|---|---|
| `backend/rotas/cozinha.js` | Rotas iniciar/pronto/bebida/preparacao |
| `backend/services/cozinha/CozinhaDespachoService.js` | Usa classificação enriquecida (ficha/categoria/personalização) |

### Excluídos
Nenhum.

### Intactos (confirmado por escopo e greps)
Pedido, PDV Normal/Express/Universal, estoque, ficha técnica (cadastro), fiscal, TEF, PIX — nenhum arquivo desses fluxos alterado nesta sprint.

---

## 4. Diff integral

Conteúdo integral dos artefatos S03 em:

`Agent/auditoria-sprint03-cozinha/DIFF-SPRINT03.patch`

Arquivos incluídos no patch: `CozinhaPreparacaoService.js`, `cozinhaClassificacaoItem.js`, `cozinha.js` (rotas), `CozinhaDespachoService.js`, `sprint03-preparacao.test.js`.

---

## 5. Schema utilizado e alterações

**Schema Cozinha v2 (Sprint 01) — sem alteração estrutural nesta sprint.**

Reutilizado:
- `cozinha_rodadas.estado_preparacao` ∈ AGUARDANDO | EM_PREPARACAO | PRONTA | CANCELADA
- `cozinha_itens.estado_preparacao` ∈ AGUARDANDO | EM_PREPARACAO | PRONTO | CANCELADO
- `cozinha_itens.tipo_item` ∈ PASTEL | BEBIDA | OUTRO
- `cozinha_item_ingredientes` (personalizações)
- `cozinha_bebida_entregas` (qty millis + idempotency_key)
- `cozinha_eventos_outbox` (eventos na mesma transação)

Nenhuma tabela duplicada criada.

---

## 6. Regras de classificação efetivamente implementadas

Módulo: `cozinhaClassificacaoItem.js` (chamado no despacho).

Ordem:
1. Snapshot/campo explícito PASTEL|BEBIDA|OUTRO → respeitar.
2. INSUMO + `comercializavel=1` + categoria refrigerante (`Refrigerantes`/`Refrigerante`) → **BEBIDA**.
3. COMERCIAL com evidência de ficha (`utiliza_ficha_tecnica` / `ficha_tecnica` ativa / personalização / ingredientes do pedido) → **PASTEL**.
4. Demais → **OUTRO** (com `confiavel=false` quando sem evidência).

**Não faz:** COMERCIAL→PASTEL automático; INSUMO comercializável sem categoria→BEBIDA; inferência por nome; transformar ingrediente de ficha em item independente.

---

## 7. Regras de preparação

| Operação | Transição / efeito |
|---|---|
| Despacho | Item nasce `AGUARDANDO` |
| `iniciarPreparacao` | AGUARDANDO → EM_PREPARACAO; rodada pode ir a EM_PREPARACAO |
| `marcarItemPronto` | Somente EM_PREPARACAO → PRONTO; grava qty_preparada; rejeita AGUARDANDO→PRONTO |
| `entregarBebida` | Somente `tipo_item=BEBIDA`; parcial/total via `cozinha_bebida_entregas`; bloqueia qty > saldo; marca item PRONTO se saldo zerar |

Eventos (outbox, mesma TX): `PREPARACAO_INICIADA`, `ITEM_PRONTO`, `BEBIDA_ENTREGUE`, `RODADA_PRONTA`.

---

## 8. Regras de conclusão da rodada

Função `avaliarConclusaoRodada` + `sincronizarEstadoRodada`:

- **Com PASTEL:** rodada PRONTA só quando todos os pastéis (não cancelados) estão PRONTO. Bebidas e OUTRO **não** bloqueiam.
- **Sem PASTEL:** OUTROs precisam estar PRONTO. Bebidas **não** bloqueiam.
- Conclusão é **derivada do estado real dos itens**, não de botão manual que ignore pendências.
- Esta sprint **não** implementa retirada pelo garçom nem entrega ao cliente (`retirada_estado` / `entrega_estado` permanecem no despacho inicial).

---

## 9. Testes individuais e resultados

Arquivo: `tests/cozinha/sprint03-preparacao.test.js`  
Comando: `node --test --test-concurrency=1 tests/cozinha/sprint03-preparacao.test.js`  
Log: `Agent/auditoria-sprint03-cozinha/LOG-TESTES-S03.txt`

| # | Caso | Resultado |
|---|---|---|
| 1 | Item inicia AGUARDANDO | PASS |
| 2 | Pastel → EM_PREPARACAO | PASS |
| 3 | Pastel → PRONTO | PASS |
| 4 | Transição inválida AGUARDANDO→PRONTO | PASS |
| 5–7 | Dois pastéis independentes / um não conclui / todos concluem | PASS |
| 8–9 | Bebida antes dos pastéis / não bloqueia | PASS |
| 10–11 | Entrega parcial / bloqueio acima da qty | PASS |
| 12 | OUTRO não bloqueia com PASTEL | PASS |
| 13 | OUTRO bloqueia sem PASTEL | PASS |
| 14–15 | Personalização vinculada; ingrediente ≠ item | PASS |
| 16 | Isolamento empresas | PASS |
| 17 | Sem operador → SESSAO_INVALIDA | PASS |
| 18 | Falha TX sem estado parcial | PASS |
| 19 | Idempotência entrega/evento | PASS |
| 20 | Regressão S01 | PASS |
| 21 | Regressão S02 | PASS |

**Total S03: 17 testes, 17 pass, 0 fail.**

---

## 10. Logs completos

- `Agent/auditoria-sprint03-cozinha/LOG-TESTES-S03.txt`
- `Agent/auditoria-sprint03-cozinha/LOG-REGRESSAO-S01-S02.txt` (resumo S01+S02: 50 pass / 0 fail)

---

## 11. Evidência de isolamento empresarial

- Serviço sempre filtra `WHERE id = ? AND empresa_id = ?`.
- `empresaId` vem do contexto autenticado (`empresaIdDoReqPedido`), não do body como autorização.
- Teste 16: item da empresa 1 inacessível com `empresaId=2` (`ITEM_NAO_ENCONTRADO`); rodada cruzada `RODADA_NAO_ENCONTRADA`.
- Rotas mantêm `verificarToken` + `exigirRecurso('pedidos')` + middleware de contexto empresarial (mount em `server.js`).

---

## 12. Evidência de transações e idempotência

- Todas as mutações: `PRAGMA foreign_keys=ON` → `BEGIN IMMEDIATE` → commit/rollback.
- Teste 18: `marcarItemPronto` inválido e entrega acima do saldo → zero alteração / zero outbox / zero entrega.
- Teste 19: mesma `Idempotency-Key` em entrega de bebida → `repetida=true`, 1 linha em `cozinha_bebida_entregas`, 1 evento; replay de `iniciarPreparacao` não duplica outbox.
- Entregas: UNIQUE parcial em `cozinha_bebida_entregas.idempotency_key`.
- Eventos: UNIQUE em `cozinha_eventos_outbox.idempotency_key`.

---

## 13. Regressão Sprint 01 e Sprint 02

Executado sequencialmente (`--test-concurrency=1`):

| Suite | Resultado |
|---|---|
| sprint01-fundacao-persistencia | PASS |
| sprint01-correcao-isolamento-empresa | PASS |
| sprint02-despacho-fifo | PASS |
| sprint02-correcoes-auditoria | PASS |
| sprint02-http-seguranca (execução anterior no ciclo) | PASS (5/5) |

Correção S02 mantida: COMERCIAL sem evidência → OUTRO (não PASTEL automático).

---

## 14. Confirmação de intactitude Pedido / PDV / estoque / ficha / fiscal / TEF / PIX

- Nenhuma alteração em serviços/rotas de Pedido, PDV, estoque, emissão fiscal, TEF ou PIX.
- Ficha técnica apenas **lida** no despacho para evidência de classificação (`SELECT` em `ficha_tecnica`), sem UPDATE/INSERT no cadastro.
- Cozinha não movimenta estoque, não calcula preço, não registra pagamento.

---

## 15. Limitações e riscos remanescentes

1. Classificação Opção A ainda é heurística: COMERCIAL sem ficha/personalização permanece OUTRO; INSUMO comercializável fora de refrigerantes permanece OUTRO (`confiavel=false`).
2. Campo explícito de preparação no cadastro (Opção B) **não** foi criado — aguarda decisão do PO se A for insuficiente em produção.
3. Rodada só-bebidas: pela regra (bebidas não bloqueiam e não há OUTRO), a sync pode marcar PRONTA quando acionada — comportamento alinhado à letra da regra, mas merece validação operacional do PO.
4. Sem KDS, impressão, SSE, retirada/entrega ao cliente (escopo consciente).
5. Autorização HTTP de preparação herda o mesmo recurso `pedidos` do despacho; não há perfil “cozinha-only” dedicado.

---

## API entregue

| Método | Rota | Serviço |
|---|---|---|
| POST | `/api/cozinha/itens/:id/iniciar` | `iniciarPreparacao` |
| POST | `/api/cozinha/itens/:id/pronto` | `marcarItemPronto` |
| POST | `/api/cozinha/itens/:id/bebida/entregar` | `entregarBebida` |
| GET | `/api/cozinha/rodadas/:id/preparacao` | `consultarPreparacaoRodada` |

Todas exigem autenticação, recurso `pedidos`, contexto empresarial e `Idempotency-Key` nas mutações.

---

## Declaração final

- Banco oficial **não** acessado (testes em `:memory:` / `os.tmpdir` com `CDS_BLOQUEAR_BANCO_OFICIAL=1`).
- Nenhuma operação fiscal executada.
- Nenhuma movimentação real de estoque.
- Nenhuma transação financeira executada.
- Nenhuma alteração no fluxo atual do Pedido.
- **Sprint 04 não iniciada.**

**A Sprint 03 termina com o motor backend de preparação e conclusão da rodada implementado e testado.**  
Aguardando auditoria e aprovação do Product Owner.
