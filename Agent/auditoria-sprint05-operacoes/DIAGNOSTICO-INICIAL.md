# DIAGNÓSTICO INICIAL — Sprint 05 (Etapa Zero)

**Data:** 2026-11-16  
**Escopo:** inspeção obrigatória antes de programar.

---

## 1. Schema (`cozinhaSchema.js`)

Schema operacional **v3** (S04A aprovada). Tabelas relevantes presentes:

| Tabela | Papel nas ops S05 |
|---|---|
| `cozinha_itens` | Estado do item (`AGUARDANDO`/`EM_PREPARACAO`/`PRONTO`/`CANCELADO`) |
| `cozinha_rodadas` | Estado da rodada; vínculo unidade/empresa/atendimento |
| `cozinha_comandas` | Integridade atendimento/pedido |
| `cozinha_bebida_entregas` | Histórico de entregas parciais (qty millis) |
| `cozinha_idempotencia` | Claim central (tipos PREPARACAO/ITEM_PRONTO/BEBIDA) |
| `cozinha_eventos_outbox` | Eventos na mesma TX |

**Divergência sprint × contrato homologado:** nenhuma divergência estrutural. S05 não exige migration.

---

## 2. Serviços e contratos S01–S03

| Sprint | Contrato reutilizado |
|---|---|
| S01 | Persistência, FKs compostas `id+empresa_id`, qty millis |
| S02 | Despacho FIFO, classificação, claim idempotência |
| S03 | `CozinhaPreparacaoService` — 3 operações + sync de rodada |
| S03 audit | Tipos oficiais + hash canônico + tabela central |

**Conclusão:** as operações 01–03 do brief S05 **já estavam implementadas**. Criar segundo motor seria violação da restrição “não duplicar mecanismos”.

---

## 3. Estados reais

**Item:** `AGUARDANDO` → `EM_PREPARACAO` → `PRONTO` (ou `CANCELADO`)  
**Rodada:** `AGUARDANDO` → `EM_PREPARACAO` → `PRONTA` (ou `CANCELADA`)  
**Bebida:** entrega independente; nunca bloqueia conclusão da rodada.  
**Item PRONTO ≠ garçom retirou / entregou ao cliente.**

---

## 4. Mecanismos existentes

- Transação: `BEGIN IMMEDIATE` + `commit`/`rollback` no serviço.
- Hash: `calcularHashOperacao` + `TIPOS_OPERACAO` em `cozinhaIdempotenciaHash.js`.
- Idempotência: `claimIdempotenciaCentral` / `concluirIdempotencia` na mesma TX.
- Outbox: `registrarEventoOutbox` na mesma TX (sem delivery WS/SSE nesta sprint).

---

## 5. Rotas e validação

Padrão atual em `backend/rotas/cozinha.js`:
- `exigirCozinhaOperacional`
- `empresaIdDoReqPedido` / `operadorDaSessao` / `chaveIdempotencia`
- Erros via `responderErro`

**Lacuna S05 identificada:** `unidade_id` não era repassado às ops de preparação.

---

## 6. Plano de implementação (sem segundo motor)

1. Adicionar `validarIntegridadeOperacional` e chamar nas 3 ops.  
2. Aceitar `unidade_id` opcional nas rotas.  
3. Hook de teste `simularFalha: 'antes_commit'` para evidência de rollback.  
4. Suite `sprint05-operacoes-itens.test.js` + regressão S01–S04A.  
5. Pacote de auditoria; **não** iniciar S06.
