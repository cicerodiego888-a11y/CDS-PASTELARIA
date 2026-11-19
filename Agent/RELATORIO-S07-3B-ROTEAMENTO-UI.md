# RELATÓRIO — S07-3B Interface de gestão de roteamento

**Data:** 2026-11-18  
**Escopo:** somente UI administrativa de roteamento (consome S07-3A)  
**Não incluído:** S07-3C, despacho, Pedidos→KDS, migration/DDL no oficial

---

## 1. Arquivos

| Arquivo | Ação |
|---------|------|
| `frontend/erp/js/cozinha-roteamento.js` | Criado — tela + cliente HTTP |
| `frontend/erp/js/app.js` | Registro page `cozinha-roteamento` |
| `frontend/erp/index.html` | Nav Gestão de Cozinhas → Roteamento |
| `frontend/shared/js/access-control.js` | ACL admin operacional |
| `frontend/shared/js/cds-page-shell.js` | Meta da página |
| `frontend/shared/js/core.js` | Busca rápida |
| `frontend/erp/js/cds-centro-configuracoes.js` | Categoria **Cozinhas** no Centro de Configurações |
| `tests/cozinha/sprint07-s07-3b-roteamento-ui.test.js` | Criado |

---

## 2. Onde fica a tela

1. **Menu:** Administração → Gestão de Cozinhas → **Roteamento**  
2. **Centro de Configurações (avançadas):** categoria **Cozinhas** → “Abrir Gestão de Roteamento”  
3. Breadcrumb: Configurações Avançadas → Gestão de Cozinhas → Roteamento

Permissão: mesmo gate de S07-2 (admin operacional). API continua sob `exigirRecurso('pedidos')`.

---

## 3. Funcionalidades

- Modos `COZINHA_PADRAO` e `COZINHA_POR_SEGMENTO`
- Seleção de cozinha padrão (unidades ativas via `GET /api/cozinha/unidades`)
- Associação segmento → unidade (`PUT .../segmentos`)
- Feedback sucesso/erro/validação
- **503 `SCHEMA_ROTEAMENTO_INDISPONIVEL`:** alerta claro — schema depende de migration controlada
- Operador sem permissão: bloqueio na UI

Sem DDL na UI. Sem migration nesta etapa.

---

## 4. Testes

Flags: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`, `DB_DIR` temp.

| Suite | Resultado |
|-------|-----------|
| `sprint07-s07-3b-roteamento-ui.test.js` | **10/10 PASS** |

Cobertura: renderização, unidades, dois modos, segmentos, 503, bloqueio sem permissão, preservação S06/S07-2, flags.

Log: `Agent/LOG-S07-3B-ROTEAMENTO-UI.txt`  
Evidência DB: `...\Temp\cds-cozinha-s07-3b-...\mercadao.db`

---

## 5. Evidência visual

- HTML: `Agent/EVIDENCIA-S07-3B-ROTEAMENTO-UI.html`
- Screenshot: `Agent/EVIDENCIA-S07-3B-ROTEAMENTO-UI.png`
- Diff: `Agent/DIFF-S07-3B-ROTEAMENTO-UI.patch`

---

## 6. Confirmações

- Banco oficial **não** acessado; **sem** migration/DDL no oficial.  
- S06 e seleção de unidade S07-2 **intactas**.  
- Fluxo Pedidos / impressão **não** alterados.  
- Despacho e Pedidos→KDS **não** implementados.  
- S07-3C **não** iniciado.
