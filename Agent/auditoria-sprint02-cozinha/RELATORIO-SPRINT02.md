# RELATÓRIO EXECUTIVO — Sprint 02 Cozinha

**Projeto:** CDS Sistemas — Pastelaria  
**Módulo:** Cozinha V1.2.3  
**Sprint:** 02 — Despacho de Comandas, Formação de Rodadas e FIFO  
**Data do pacote:** 2026-11-16  
**Escopo deste documento:** comportamento efetivamente encontrado no código (não intenções).

---

## 1. Objetivo da Sprint

Implementar o primeiro fluxo operacional da Cozinha: receber itens já registrados no ERP, validá-los, agrupá-los em uma rodada de despacho e enfileirá-los na sequência FIFO da unidade de preparação, com idempotência central e precisão em milésimos — sem KDS, impressão, preparação, PDV, estoque ou fiscal.

---

## 2. O que foi implementado

| Artefato | Papel |
|---|---|
| `backend/services/cozinha/CozinhaDespachoService.js` | Núcleo: `despacharLote` |
| `backend/rotas/cozinha.js` | `POST /api/cozinha/despacho`, `GET /api/cozinha/status` |
| `backend/server.js` | Mount autenticado em `/api/cozinha` |
| Ajuste em `cozinhaIdempotenciaHash.js` | `DESPACHO_LOTE` inclui `empresa_id` e `pedido_id` por item |
| `tests/cozinha/sprint02-despacho-fifo.test.js` | 21 testes em banco temporário |

Fundação Sprint 01 reutilizada (não recriada): `cozinhaSchema.js`, `cozinhaQuantidade.js`, tabelas `cozinha_*`.

---

## 3. Como funciona o despacho em lote

Fluxo real em `CozinhaDespachoService.despacharLote`:

1. Exige `empresaId`, `operadorId`, `Idempotency-Key`, `unidade_id`, `mesa_id`, `atendimento_id` e lista `itens`.
2. Normaliza cada item (`pedido_id`, `pedido_item_id`, `comanda_id`, qty → milésimos via `cozinhaQuantidade.js`).
3. Rejeita `pedido_item_id` duplicado no lote (`ITEM_DUPLICADO_NO_LOTE`).
4. Calcula hash SHA-256 semântico (`calcularHashOperacao(DESPACHO_LOTE, …)`).
5. `BEGIN IMMEDIATE`.
6. Consulta/cria claim em `cozinha_idempotencia`.
7. Valida unidade, mesa, atendimento, comandas, pedidos, itens e saldo.
8. Incrementa `cozinha_unidades.sequencia_atual`.
9. Insere **uma** linha em `cozinha_rodadas` + N linhas em `cozinha_itens` + snapshots em `cozinha_item_ingredientes`.
10. Persiste `resultado_json`, marca `CONCLUIDA`, `COMMIT`.
11. Em qualquer erro no `try`: `ROLLBACK` e relança.

A rota HTTP (`backend/rotas/cozinha.js`) apenas monta o contexto autenticado e chama o serviço — regras de negócio não estão duplicadas na rota.

---

## 4. Várias comandas → uma rodada

No mesmo `despacharLote`, após validações:

- `numero_rodada = MAX(numero_rodada do atendimento) + 1`
- Um único `INSERT INTO cozinha_rodadas`
- Todos os itens do lote recebem o mesmo `rodada_id`

Evidência de teste: caso “duas comandas do mesmo atendimento geram uma única rodada” → `cozinha_rodadas` com 1 linha e 2 itens apontando para o mesmo `rodada_id`.

Nova confirmação (nova chave) cria **nova** rodada; não reabre a anterior.

---

## 5. Cada item mantém sua comanda

No `INSERT` de `cozinha_itens`, o campo `comanda_id` vem de `linha.comanda_id` do item do payload — não há agregação de comandas em um único valor.

Validação adicional: se a comanda tiver `pedido_id` preenchido, deve coincidir com o `pedido_id` do item (`COMANDA_PEDIDO_INCOMPATIVEL`).

Comandas do lote devem pertencer ao `atendimento_id` informado (`COMANDA_ATENDIMENTO_INCOMPATIVEL`).

---

## 6. FIFO

- Sequência gerada só no servidor: `UPDATE cozinha_unidades SET sequencia_atual = sequencia_atual + 1` dentro da mesma transação.
- Valor lido de volta e gravado em `cozinha_rodadas.sequencia_global` e `cozinha_itens.sequencia_global`.
- Índice único `(unidade_id, sequencia_global)` no schema impede duplicidade.
- Não reinicia por atendimento: teste 8 mostrou `numero_rodada=1` no novo atendimento com `sequencia_global=2` na mesma unidade.
- Não usa horário do cliente nem ID da mesa como prioridade.

`BEGIN IMMEDIATE` serializa escritores SQLite; teste de concorrência com chaves distintas obteve sequências `{1,2}`.

---

## 7. Idempotência central

Tabela única: `cozinha_idempotencia` (Sprint 01).

- Chave consultada **antes** das validações de negócio (dentro da TX).
- Replay `CONCLUIDA` + mesmo hash → devolve `JSON.parse(resultado_json)` com `repetida: true` (HTTP 200 na rota).
- Mesmo key + hash diferente → `409 IDEMPOTENCY_PAYLOAD_DIVERGENTE`.
- Mesmo key + outro `tipo_operacao` → `409 IDEMPOTENCY_OPERACAO_DIVERGENTE`.
- Claim inicial `EM_ANDAMENTO`; sucesso → `CONCLUIDA` + `resultado_http_status=201` + `recurso_tipo='rodada'`.
- Falha → `ROLLBACK` remove o claim; a chave pode ser reutilizada (teste 20).

**Desvio observado vs. texto do adendo:** o hash é calculado **antes** do `BEGIN IMMEDIATE` (linhas ~222–237), não depois. O cálculo é determinístico sobre o payload já normalizado e não depende do banco; a consulta da chave ocorre dentro da TX.

---

## 8. Controle de quantidades

- Conversão exclusiva via `cozinhaQuantidade.js` (milésimos INTEGER; rejeita >3 casas).
- No primeiro despacho do item, cria `cozinha_pedido_item_controle` com `qty_referencia_despacho_millis` = qty do `pedidos_itens` naquele momento.
- Teto = referência + `SUM(cozinha_autorizacoes_qty ATIVA)`.
- Saldo líquido já despachado = `SUM(qty_solicitada_millis - qty_cancelada_millis)` em `cozinha_itens`.
- Excesso → `409 QTY_EXCEDE_RESTANTE` **antes** do incremento FIFO.
- Alterar `pedidos_itens.quantidade` depois **não** atualiza o controle → teto não sobe (teste 17).
- APIs de autorizar qty / reduzir teto **não** foram implementadas nesta Sprint (tabelas existem; serviços/rotas não).

---

## 9. Personalizações

Para cada item validado, lê `pedido_item_ingredientes` e, ao criar o item de cozinha, copia para `cozinha_item_ingredientes` (nome, qty millis, unidade, classificação, selecionado, preço adicional millis).

Não recalcula ficha técnica, não movimenta estoque, não altera a personalização original do pedido.

---

## 10. Rollback

`catch` do bloco transacional chama `rollback(db)` e relança o erro.

Evidências:

- Suite: falha de validação após claim → sem rodada, FIFO=0, sem linha de idempotência.
- Reprodução R4 (trigger após UPDATE da sequência): FIFO volta a 0; sem rodada/itens/idempotência.
- Reprodução R5 (trigger no 2º INSERT de item): sem resíduos parciais.

---

## 11. Ainda não implementado (limites da Sprint)

- Tela/KDS da cozinha
- Início/conclusão de preparação
- Impressão térmica / fila de impressão
- Notificações / SSE / WebSocket / Android
- Entrega de bebidas / retirada / entrega na mesa
- Alterações PDV, composição, estoque, ficha técnica, fiscal, NFC-e, NF-e, PIX, TEF
- Endpoints de autorização de qty e redução de teto
- UI de despacho (apenas API)

---

## 12. Pendências e limitações conhecidas

1. **Hash antes do BEGIN** — ordem diverge do checklist literal do adendo (efeito prático limitado).
2. **Unidade por item** — contrato tem uma `unidade_id` por requisição; não há validação “item de outra unidade” porque o modelo não carrega unidade no item.
3. **`mesas.ativo`** — mesa é filtrada por `empresa_id`, mas o código **não** rejeita mesa inativa (`ativo=0`) explicitamente.
4. **Cancelamento por item** — rejeita pedido `CANCELADO`/`ORCAMENTO`/fora de `{PEDIDO,ABERTO,EM_SEPARACAO}`; não há flag de cancelamento em `pedidos_itens` consultada.
5. **Concorrência mesma chave** — reprodução R2: ambos os callers podem “cumprir” (um cria, outro recebe replay); uma única rodada/FIFO. Não há teste dedicado no suite oficial para esse cenário (há no pacote de auditoria).
6. **`GET /status`** — expõe `getCozinhaSchemaStatus()` (inclui mensagem de erro de schema se houver).
7. **Middleware empresa** — `criarMiddlewareContextoEmpresa(db)` sem `obrigatorio:true`; ausência de contexto → `empresaId=null` → serviço responde `EMPRESA_CONTEXT_REQUIRED`.
8. **Banco oficial** — não foi migrado/alterado nesta auditoria; wiring de schema Cozinha em `database.js` pertence à Sprint 01.

---

## 13. Resultado dos testes (evidência reexecutada na auditoria)

- Sprint 02: **21/21 pass** (`logs/sprint02-testes.log`)
- Sprint 01 regressão: **22/22 pass** (`logs/sprint01-regressao.log`)
- Reproduções auditoria: R1–R6, R8–R10 PASS; R7 INFO (limitação de contrato)

**Sprint 03 não iniciada.**
