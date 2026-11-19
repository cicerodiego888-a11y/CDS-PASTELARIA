# RELATÓRIO — S07-3C Cadastro dinâmico de canais de pedidos

**Data:** 2026-11-18  
**Escopo:** canais + destino + UI; sem despacho, sem iFood real, sem migration no oficial  
**Auditoria prévia:** `Agent/AUDITORIA-S07-3C-ANTES.md`

---

## 1. Arquivos

| Arquivo | Ação |
|---------|------|
| `backend/migrations/s07-3c-cozinha-canais.sql` | Criado (não executado no oficial) |
| `backend/services/cozinha/cozinhaCanaisSchema.js` | Criado |
| `backend/services/cozinha/CozinhaCanaisService.js` | Criado |
| `backend/rotas/cozinha.js` | Rotas `/canais*` |
| `frontend/erp/js/cozinha-roteamento.js` | UI canais dinâmicos |
| `tests/cozinha/sprint07-s07-3c-canais-pedidos.test.js` | Criado |
| `tests/cozinha/sprint07-s07-3b-roteamento-ui.test.js` | Ajuste assert markup |

---

## 2. Modelo

### `cozinha_canais`
`id`, `empresa_id`, `codigo` (UNIQUE por empresa), `nome`, `origem_tipo` (`SISTEMA|MANUAL|INTEGRACAO`), `ativo`, timestamps, `created_by`/`updated_by`, `UNIQUE(id, empresa_id)`.

### `cozinha_canal_destinos`
`UNIQUE(empresa_id, canal_id)` → no máximo 1 destino; FKs compostas para canal e `cozinha_unidades`.

### LOJA
Seed idempotente SISTEMA (`codigo=LOJA`, `nome=Loja`, ativo). Não desativável.

### Convivência S07-3A
`cozinha_roteamento_segmentos` **preservada**. Sem conversão automática.  
Ordem migration controlada: S07-2 (unidades) → S07-3A (roteamento) → **S07-3C (canais)**.

---

## 3. APIs

| Método | Rota | Efeito |
|--------|------|--------|
| GET | `/api/cozinha/canais` | Lista + garante LOJA |
| POST | `/api/cozinha/canais` | Canal MANUAL; código gerado no servidor |
| PATCH | `/api/cozinha/canais/:id` | Nome / ativo (não código/origem/empresa; LOJA protegido) |
| PUT | `/api/cozinha/canais/:id/destino` | Unidade ativa da mesma empresa |

Auth: token + `exigirRecurso('pedidos')` + admin operacional + empresa do contexto.  
Schema ausente → `503 SCHEMA_CANAIS_INDISPONIVEL` (sem DDL).

---

## 4. Interface

Administração → Gestão de Cozinhas → Roteamento: listagem dinâmica de canais, novo canal, editar nome, ativar/desativar, destino por canal, LOJA marcado como sistema.  
Modo/padrão S07-3A mantidos. Segmentos fixos removidos da UI operacional.

Evidência: `Agent/EVIDENCIA-S07-3C-CANAIS-UI.html` + `.png` (módulo real + dados de demonstração explícitos na página de evidência; **testes de API/serviço em DB temp real**, não só mock).

---

## 5. Testes

| Suite | Resultado |
|-------|-----------|
| `sprint07-s07-3c-canais-pedidos.test.js` | **18/18 PASS** |
| Regressão `sprint07-s07-3b-roteamento-ui.test.js` | **12/12 PASS** |

Flags: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`, `DB_DIR` temp (`cds-cozinha-s07-3c-*`), sem `CDS_ALLOW_OFFICIAL_DB`.

Cobertura: LOJA idempotente, CRUD, nome vazio/duplicado, proteção LOJA, destino ativo/inativa/outra empresa, isolamento, 403, schema 503 sem DDL, persistência, compat S07-3A.

Logs: `Agent/LOG-S07-3C-CANAIS.txt`, `Agent/LOG-S07-3C-REGRESSAO-3B.txt`  
Diff: `Agent/DIFF-S07-3C-CANAIS.patch`

---

## 6–7. Banco oficial

**Não acessado / não alterado.** Migration S07-3C **não** executada no oficial. APIs sem DDL.

---

## 8. Pendências / riscos

- Migration S07-3A e S07-3C ainda pendentes de aplicação controlada no oficial.
- Canais não disparam despacho KDS (próximas sprints).
- iFood/WhatsApp como canais manuais ≠ integração real.
- Transição segmentos→canais: planejada, não automática.
- Homologação visual no Electron oficial depende de migration aplicada; evidência UI usa módulo real com dados de demonstração na página de evidência.

**Critério de aprovação técnico (DB temp):** cadastrar canal, vincular unidade, editar, ativar/desativar, LOJA protegido — **atendido nos testes 18/18**.
