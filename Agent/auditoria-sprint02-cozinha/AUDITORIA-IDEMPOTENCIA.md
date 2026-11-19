# AUDITORIA — IDEMPOTÊNCIA CENTRAL (Sprint 02)

Tabela: `cozinha_idempotencia` (schema Sprint 01).  
Hash: `backend/services/cozinha/cozinhaIdempotenciaHash.js`.  
Uso: `CozinhaDespachoService.despacharLote`.

---

## Campos do hash `DESPACHO_LOTE`

`montarPayloadSemantico` inclui:

- `tipo_operacao: DESPACHO_LOTE`
- `empresa_id`
- `unidade_id`
- `atendimento_id`
- `mesa_id`
- `pedido_id` (opcional no topo; o serviço não envia o topo, só por item)
- `responsavel_operador_id`
- `itens[]`: `pedido_id`, `pedido_item_id`, `comanda_id`, `qty_solicitada` (normalizada com 3 casas)

Sprint 02 acrescentou `empresa_id` no payload e `pedido_id` dentro de cada item (além dos campos já previstos).

Quantidades passam por `serializarQtyParaHash` / `CAMPOS_QTY`. Timestamps e IDs de servidor estão em `CAMPOS_EXCLUIDOS`.

---

## Fluxos reais

### 1) Primeira execução com chave nova

1. `SELECT` não encontra chave.
2. `INSERT … situacao='EM_ANDAMENTO'` + `payload_hash`.
3. Valida / cria rodada / FIFO.
4. `UPDATE … situacao='CONCLUIDA', resultado_http_status=201, resultado_json=…, recurso_tipo='rodada', recurso_id=rodadaId`.
5. `COMMIT`.
6. Retorno: `repetida: false` (HTTP 201 na rota).

Evidência: teste 21.

### 2) Mesma chave + mesmo payload (replay)

1. Encontra registro `CONCLUIDA` com mesmo hash.
2. `COMMIT` (encerra a TX de leitura/lock).
3. Retorna `{ ...JSON.parse(resultado_json), repetida: true }`.
4. **Não** incrementa FIFO; **não** cria nova rodada.

Evidência: teste 9 — após cancelar o pedido, o replay ainda funciona (consulta da chave **antes** da validação de negócio).

### 3) Mesma chave + payload diferente

`409 IDEMPOTENCY_PAYLOAD_DIVERGENTE` (L254–259).  
Evidência: teste 10 + R10.

### 4) Mesma chave em outro tipo de operação

Se `tipo_operacao !== DESPACHO_LOTE` → `409 IDEMPOTENCY_OPERACAO_DIVERGENTE`.  
Evidência: teste 11 (chave pré-inserida como `AUTORIZAR_QTY`).

### 5) Falha antes do COMMIT

`catch` → `ROLLBACK`. Linha `EM_ANDAMENTO` desaparece.  
Evidência: teste 20 (item inexistente) + R4/R5.

### 6) Reutilização da chave após rollback

Teste 20: após falha com chave `tx-20`, nova chamada com a mesma chave e payload válido **conclui** com sucesso.

### Situação `EM_ANDAMENTO` residual

Se a chave existir como `EM_ANDAMENTO` (crash sem rollback — cenário extremo fora do catch normal), o serviço responde `409 IDEMPOTENCY_EM_ANDAMENTO`. Não há worker de limpeza nesta Sprint.

---

## Concorrência mesma chave

Reprodução R2 (arquivo SQLite tmp, `busy_timeout=10000`):

- `fulfilled=2`, `rejected=0`
- `rodadas=1`, `sequencia_atual=1`

Interpretação: um caller criou; o outro obteve replay (ambos “sucesso” do ponto de vista da API). Integridade preservada.

Há também ramo UNIQUE (L288–306) para corrida no INSERT do claim → replay se já `CONCLUIDA`, senão `IDEMPOTENCY_CONCORRENTE`.
