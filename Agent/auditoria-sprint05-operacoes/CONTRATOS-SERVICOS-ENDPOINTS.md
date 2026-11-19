# CONTRATOS — Serviços e Endpoints (Sprint 05)

Base path: rotas montadas em `/api/cozinha` (padrão do projeto).  
Header de idempotência: mesmo mecanismo S02/S03 (`Idempotency-Key` / helper `chaveIdempotencia`).

---

## Serviços (`CozinhaPreparacaoService`)

### `iniciarPreparacao(entrada, opts)`

| Campo | Obrigatório | Notas |
|---|---|---|
| `empresaId` | sim | Isolamento |
| `operadorId` | sim | Responsável |
| `itemId` | sim | Item da cozinha |
| `idempotencyKey` | sim | Tipo `PREPARACAO_INICIADA` |
| `unidade_id` / `unidadeId` | **sim** | Origem autoritativa: JWT `unidade_cozinha_id` (rota). Body/query só podem coincidir. |

Hash: `empresa_id` + `item_id` + `responsavel_operador_id`.  
Resposta 200: `{ success, repetida, ja_em_preparacao, item, rodada, evento }`.

### `marcarItemPronto(entrada, opts)`

Mesmos campos de contexto. Tipo `ITEM_PRONTO`.  
Não altera `retirada_estado` / `entrega_estado`.  
Resposta 200: `{ success, repetida, ja_pronto, item, rodada, evento, evento_rodada? }`.

### `entregarBebida(entrada, opts)`

| Campo | Obrigatório | Notas |
|---|---|---|
| `qty_entregue` / `quantidade` | sim | Decimal → millis; > 0 |
| demais | como acima | Tipo `BEBIDA_ENTREGUE` |

Hash inclui `qty_entregue`.  
HTTP: 201 na primeira execução; 200 se `repetida`.

---

## Endpoints

| Método | Rota | Serviço |
|---|---|---|
| POST | `/itens/:id/iniciar` | `iniciarPreparacao` |
| POST | `/itens/:id/pronto` | `marcarItemPronto` |
| POST | `/itens/:id/bebida/entregar` | `entregarBebida` |
| GET | `/rodadas/:id/preparacao` | `consultarPreparacaoRodada` (consulta S03; sem mudança funcional S05) |

Body opcional comum: `{ "unidade_id": <int> }` (também aceito via query).

---

## Códigos de erro relevantes (S05)

| Código | Quando |
|---|---|
| `TRANSICAO_INVALIDA` | Estado incompatível |
| `ITEM_INEXISTENTE` / 404 | Item fora do escopo empresarial |
| `UNIDADE_ISOLAMENTO` | `unidade_id` ≠ item |
| `ITEM_UNIDADE_INCOMPATIVEL` | Item e rodada com unidades divergentes |
| `COMANDA_ITEM_INEXISTENTE` | Comanda ausente |
| `COMANDA_RODADA_INCOMPATIVEL` | Atendimentos divergentes |
| `QTY_INVALIDA` / `QTY_ENTREGA_EXCEDE` | Quantidade bebida |
| `IDEMPOTENCY_PAYLOAD_DIVERGENTE` | Mesma chave, hash diferente |
| `FALHA_SIMULADA` | Somente testes (`opts.simularFalha`) |
