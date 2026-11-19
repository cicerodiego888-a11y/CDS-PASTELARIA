# RELATÓRIO — S07-3A Configuração de roteamento de cozinhas

**Data:** 2026-11-18  
**Escopo:** somente S07-3A (config persistente + API admin)  
**Não incluído:** despacho, integração Pedidos→KDS, KDS UI, S06, S07-3B+  
**Banco oficial:** não acessado / não modificado

---

## 1. Arquitetura encontrada

| Mecanismo | Reutilizado |
|-----------|-------------|
| Config por empresa | Padrão `empresas_configuracao_estoque` (CREATE IF NOT EXISTS + serviço) |
| Unidades | `cozinha_unidades` (S07-2) + FK composta `(id, empresa_id)` |
| Admin | `isAdminOperacional` (`cozinhaAuthUnidade`) |
| Empresa | `empresaIdDoReqPedido` + middleware contexto; `empresa_id` do body ignorado |
| Rotas Cozinha | `backend/rotas/cozinha.js` + `exigirRecurso('pedidos')` + `exigirCozinhaOperacional` |
| Schema Cozinha v3 | **Não** bumpado — tabelas novas via `garantirSchemaCozinhaRoteamento` |

Segmentos admitidos (allowlist S07-3A): `LOJA`, `IFOOD`, `PEDIDO_ONLINE`.

---

## 2. Arquivos criados / modificados

| Arquivo | Ação |
|---------|------|
| `backend/services/cozinha/cozinhaRoteamentoSchema.js` | Criado |
| `backend/services/cozinha/CozinhaRoteamentoConfigService.js` | Criado |
| `backend/migrations/s07-3a-cozinha-roteamento.sql` | Criado (não executado no oficial) |
| `backend/rotas/cozinha.js` | Modificado — rotas `/roteamento*` |
| `tests/cozinha/sprint07-s07-3a-roteamento-cozinhas.test.js` | Criado |

---

## 3. Modelo de persistência

### `cozinha_roteamento_config`
- `empresa_id` PK  
- `modo` ∈ `COZINHA_PADRAO` | `COZINHA_POR_SEGMENTO`  
- `unidade_padrao_id` (nullable; FK → `cozinha_unidades(id, empresa_id)`)  
- `updated_at`, `updated_by`

### `cozinha_roteamento_segmentos`
- `UNIQUE (empresa_id, segmento)`  
- `unidade_id` NOT NULL + FK composta mesma empresa  
- `updated_at`

---

## 4. Contratos das APIs

Todas sob `/api/cozinha` (token + recurso `pedidos` + cozinha operacional).  
Empresa = contexto autenticado. Admin operacional obrigatório.

| Método | Rota | Body | Efeito |
|--------|------|------|--------|
| `GET` | `/roteamento` | — | Consulta config |
| `PUT` | `/roteamento/modo` | `{ modo }` | Define modo |
| `PUT` | `/roteamento/padrao` | `{ unidade_id }` | Define cozinha padrão (ativa da empresa) |
| `PUT` | `/roteamento/segmentos` | `{ segmento, unidade_id }` | Associa segmento → unidade |

Validações: unidade inexistente / inativa / outra empresa; segmento sem destino; modo PADRAO sem padrão prévio; operador → `403 ADMIN_OPERACIONAL_OBRIGATORIO`.

---

## 5. Testes

Flags: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`, `DB_DIR` temp, sem `CDS_ALLOW_OFFICIAL_DB`.

| Suite | Resultado |
|-------|-----------|
| `sprint07-s07-3a-roteamento-cozinhas.test.js` | **13/13 PASS** |

Cobertura: criar/ler; troca de modos; inexistente; inativa; outra empresa; segmento sem destino; sem auth; isolamento; persistência; HTTP.

Log: `Agent/LOG-S07-3A-ROTEAMENTO.txt`  
Evidência: `BANCO DE TESTE EM USO: ...\Temp\cds-cozinha-s07-3a-...`

---

## 6–7. Diff e logs

- Diff: `Agent/DIFF-S07-3A-ROTEAMENTO.patch`  
- Log: `Agent/LOG-S07-3A-ROTEAMENTO.txt`  
- Este relatório: `Agent/RELATORIO-S07-3A-ROTEAMENTO.md`

---

## 8. Confirmações

- Banco oficial **não** acessado nem modificado.  
- Migration SQL preparada, **não** executada no oficial.  
- S06 / S07-1 / S07-2 preservados (sem alteração de KDS, despacho ou pedidos comerciais).  
- S07-3B+ **não** iniciado.
