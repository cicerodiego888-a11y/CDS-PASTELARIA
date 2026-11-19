# EVIDÊNCIA DE IDEMPOTÊNCIA — Sprint 05

Mecanismo: **central** `cozinha_idempotencia` (S03 audit) + hash `cozinhaIdempotenciaHash`.  
Nenhum mecanismo paralelo criado.

## Tipos utilizados

| Operação | `tipo_operacao` |
|---|---|
| Iniciar preparação | `PREPARACAO_INICIADA` |
| Marcar pronto | `ITEM_PRONTO` |
| Entregar bebida | `BEBIDA_ENTREGUE` |

## Casos cobertos (`LOG-TESTES-S05.txt`)

| Caso | Evidência |
|---|---|
| Replay iniciar | `início duplicado` → 1 outbox, 1 claim `CONCLUIDA`, `repetida=true` |
| Replay pronto | `conclusão duplicada` → 1 evento |
| Replay bebida | `repetição idempotente BEBIDA_ENTREGUE` → 1 linha em `cozinha_bebida_entregas` |
| Hash divergente | `reutilização de chave com hash diferente` → `IDEMPOTENCY_PAYLOAD_DIVERGENTE` |
| Persistência atômica | claim + estado + outbox no mesmo `BEGIN IMMEDIATE` |

## Hash (padrão existente)

- Iniciar / Pronto: `empresa_id`, `item_id`, `responsavel_operador_id`.  
- Bebida: inclui `qty_entregue` (3 casas).  
- `unidade_id` **não** entra no hash (validação de escopo operacional, não de conteúdo da op).
