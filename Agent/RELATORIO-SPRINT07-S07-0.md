# RELATÓRIO — Sprint 07 · S07-0 · GET `/api/cozinha/preparacao/painel`

**Data:** 2026-11-17  
**Bloco autorizado:** S07-0 apenas  
**Product Owner:** autorizado  
**Tech Lead:** aguardando auditoria  
**Implementação de S07-1+:** **não iniciada**  

---

## 1. Arquivos criados e modificados

| Arquivo | Ação |
|---------|------|
| `backend/services/cozinha/CozinhaKdsPainelService.js` | **Criado** — consulta somente leitura |
| `backend/rotas/cozinha.js` | **Modificado** — rota `GET /preparacao/painel` |
| `tests/cozinha/sprint07-s07-0-painel-kds.test.js` | **Criado** — 12 testes |
| `Agent/_run-log-sprint07-s07-0.js` | **Criado** — runner de evidência |
| `Agent/LOG-SPRINT07-S07-0.txt` | **Criado** — log integral |
| `Agent/RELATORIO-SPRINT07-S07-0.md` | **Criado** — este relatório |

**Não alterados:** schema v3, Sprint 06 (worker/fila/estações), PDV, login, dual-write ERP, frontend.

---

## 2. Contrato HTTP

```
GET /api/cozinha/preparacao/painel
Authorization: Bearer <JWT>
X-Empresa-Id: <empresa do contexto>
```

### Query (opcional)

| Parâmetro | Descrição |
|-----------|-----------|
| `estado_item` | `AGUARDANDO`, `EM_PREPARACAO`, `PRONTO`, `CANCELADO` (vírgula = lista) |
| `estado_rodada` | `AGUARDANDO`, `EM_PREPARACAO`, `PRONTA`, `CANCELADA` |
| `limite` | default 50, máximo 100 |
| `offset` | default 0 |
| `incluir_cancelados` | `true`/`1` para incluir cancelados |

### Segurança

- Empresa: somente contexto autenticado (`empresaIdDoReqPedido`). `empresa_id` na query divergente → **409 `EMPRESA_ISOLAMENTO`**.
- Unidade: somente JWT `unidade_cozinha_id` (`resolverUnidadeOperacionalReq`). Ausente → **400 `UNIDADE_OBRIGATORIA`**. Query `unidade_id` divergente → **409 `UNIDADE_ISOLAMENTO`**.
- Unidade inexistente na empresa → **403 `UNIDADE_NAO_AUTORIZADA`**.
- Recurso: `pedidos` (já no router Cozinha).
- Sem preços/fiscais na resposta (`financeiro: false`, `fiscal: false`, `impressao_fisica: false`).

### Ordenação

FIFO por `rodada.sequencia_global ASC`, depois `enviada_em`, `id`; itens por `item.sequencia_global ASC`.

---

## 3. Exemplo de resposta

```json
{
  "success": true,
  "empresa_id": 1,
  "unidade_id": 2,
  "total": 2,
  "limite": 50,
  "offset": 0,
  "impressao_fisica": false,
  "financeiro": false,
  "fiscal": false,
  "ordenacao": "FIFO_SEQUENCIA_GLOBAL",
  "rodadas": [
    {
      "id": 10,
      "empresa_id": 1,
      "unidade_id": 2,
      "mesa_id": 5,
      "mesa_numero": "12",
      "atendimento_id": 8,
      "numero_rodada": 1,
      "sequencia_global": 3,
      "estado_preparacao": "AGUARDANDO",
      "enviada_em": "2026-11-17T20:00:00.000Z",
      "created_at": "...",
      "updated_at": "...",
      "itens": [
        {
          "id": 100,
          "comanda_id": 20,
          "numero_comanda": 7,
          "pedido_id": 55,
          "tipo_item": "PASTEL",
          "estado_preparacao": "AGUARDANDO",
          "sequencia_global": 3,
          "qty_solicitada": "2.000",
          "produto_nome_snapshot": "Pastel Carne",
          "observacoes_snapshot": "Sem cebola",
          "created_at": "...",
          "updated_at": "..."
        }
      ]
    }
  ]
}
```

---

## 4. Testes e resultados

Ambiente: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, sequencial.

| Suíte | Pass | Fail |
|-------|-----:|-----:|
| S07-0 | 12 | 0 |
| S01 | 22 | 0 |
| S02 | 33 | 0 |
| S03 | 38 | 0 |
| S04A | 15 | 0 |
| S05 | 30 | 0 |
| S06 A–D | 93 | 0 |
| S06 E | 32 | 0 |
| **TOTAL_FAIL** | | **0** |

Log: `Agent/LOG-SPRINT07-S07-0.txt`

### Cobertura S07-0 (checklist)

1. Listagem unidade autenticada — OK  
2. Isolamento empresas — OK  
3. Isolamento unidades mesma empresa — OK  
4–6. Filtros AGUARDANDO / EM_PREPARACAO / PRONTO — OK  
7. Observações — OK  
8. Mesa e comanda — OK  
9. FIFO — OK  
10. Unidade ausente/inválida — OK  
11. Empresa ausente/inválida — OK  
12. Unidade não autorizada / divergente — OK  
13. Sem financeiro/fiscal — OK  
14. Limite/offset (cap 100) — OK  
15. Regressão S01–S06 — OK  

---

## 5. Evidências de preservação

- Banco oficial: **não acessado** (`CDS_BLOQUEAR_BANCO_OFICIAL=1`; testes em `:memory:` / `tmpdir`).  
- Schema Cozinha v3: **sem migration**.  
- Sprint 06: **sem alteração** de worker/fila/estações.  
- Impressão física / spooler: **não executados**.  
- Frontend / dual-write / login: **não implementados** (fora do S07-0).  

---

## 6. Parada obrigatória

**S07-0 concluído.**  
Não iniciar S07-1 nem qualquer outro bloco.  

**Aguardando auditoria do Tech Lead e nova autorização do Product Owner.**
