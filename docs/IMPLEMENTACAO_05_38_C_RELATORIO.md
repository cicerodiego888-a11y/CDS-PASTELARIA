# Relatório — Implementação 05.38.C

**Sprint:** Caixa por Empresa  
**Classificação:** ESTADO B (código + migration + testes automatizados)  
**Data:** 2026-08-24

---

## Objetivo

Evoluir o módulo de Caixa para respeitar o Modo Operacional Global (05.38.B), com isolamento real por `empresa_id` em `caixa_sessoes`, sem criar motor novo nem duplicar regras.

---

## 1. Arquivos alterados / criados

### Criados

| Arquivo | Função |
|---------|--------|
| `backend/services/caixa/CaixaEmpresaContextoService.js` | Resolve empresa via ContratoOperacional + empresaContexto; meta empresa sem `configuracoes.cnpj` |
| `tests/caixa/caixa-multiempresa-05-38-c.test.js` | 15 cenários obrigatórios + extras |
| `docs/IMPLEMENTACAO_05_38_C_RELATORIO.md` | Este relatório |

### Alterados

| Arquivo | Alteração |
|---------|-----------|
| `backend/database.js` | DDL + `ALTER` seguro `caixa_sessoes.empresa_id` |
| `backend/utils/caixaSessaoHelpers.js` | SQL por empresa; migration/backfill idempotente |
| `backend/rotas/caixa.js` | Middleware empresarial; abrir/status/sangria/suprimento/fechar isolados |
| `backend/middleware/validarCaixaAberto.js` | Filtra/valida sessão por `empresa_id` quando contexto presente |
| `frontend/pdv-universal/pdv-universal-caixa.js` | Envia `X-Empresa-Id` do contexto já existente |
| `frontend/shared/js/caixaPermissoes.js` | Idem nas operações POST |
| `frontend/erp/js/caixa.js` | Header no GET `/caixa/aberto` |
| `frontend/pdv/js/caixa.js` | Header no GET `/caixa/aberto` |

---

## 2. Migration

Idempotente, em dois pontos:

1. **Schema** (`database.js`):
   - `CREATE TABLE` de `caixa_sessoes` inclui `empresa_id`
   - `aplicarAlteracaoSegura(... ADD COLUMN empresa_id ...)` para bases existentes

2. **Backfill** (`migrarEmpresaIdCaixaSessoes` em `caixaSessaoHelpers.js`):
   - Resolve empresa operacional (config `empresa_operacional_id` → única ativa)
   - `UPDATE caixa_sessoes SET empresa_id = ? WHERE empresa_id IS NULL`
   - Não apaga sessões; não recria tabela
   - Índice `idx_caixa_sessoes_empresa_status`

Validação observada em ambiente local ao carregar o banco:  
`[05.38.C] caixa_sessoes.empresa_id: added=false backfilled=1 empresaId=1`

---

## 3. Como `empresa_id` é resolvido

```
Request
  → middlewareResolverEmpresaCaixa
  → ContratoOperacionalService.montarContratoOperacional
  → EMPRESA_SIMPLES: PoliticaEmpresaSimples (empresa operacional)
  → MULTIEMPRESA: X-Empresa-Id / req.empresaId + validarEmpresaId (+ vínculo usuário)
  → req.empresaId
  → operações em caixa_sessoes WHERE empresa_id = ?
```

Fonte única: **ContratoOperacionalService** + **empresaContexto** (sem segundo resolver).

---

## 4. Comportamento EMPRESA_SIMPLES

- Operador não escolhe empresa
- Backend resolve empresa operacional automaticamente
- Novas sessões gravam `empresa_id` interno
- UI permanece a mesma (sem seletor no Caixa)

---

## 5. Comportamento MULTIEMPRESA

- Exige contexto empresarial válido (`X-Empresa-Id` ou mecanismo oficial)
- Empresa inválida / inativa / sem contexto → bloqueio com código operacional
- Cada empresa possui sessões próprias

---

## 6. Isolamento entre empresas

| Operação | Regra |
|----------|--------|
| GET `/aberto` | Sessão aberta da empresa atual |
| POST `/abrir` | Impede segunda sessão aberta no mesmo escopo (terminal + empresa) |
| POST `/sangria` | `exigirSessaoDaEmpresa` |
| POST `/suprimento` | idem |
| POST `/fechar` | UPDATE só `empresa_id` da sessão atual |

Movimentações/fechamentos continuam vinculados via `sessao_id` (sem `empresa_id` extra nas tabelas filhas — escopo comprovado no código).

---

## 7. Contratos HTTP preservados

- `GET  /api/caixa/aberto`
- `POST /api/caixa/abrir`
- `POST /api/caixa/sangria`
- `POST /api/caixa/suprimento`
- `POST /api/caixa/fechar`

Nenhuma rota `/api/caixa/empresa/:id/...` criada.

---

## 8. Testes executados

| Suite | Resultado |
|-------|-----------|
| `tests/caixa/caixa-multiempresa-05-38-c.test.js` | **17/17 OK** |
| `tests/caixa/rc-fechamento-caixa-conciliacao.test.js` | OK |
| `tests/modo-operacional-global-05-38-b.test.js` | **17/17 OK** |
| `tests/pdv-universal/*.test.js` (todas) | OK |

Cenários 05.38.C: C1–C15 + meta empresa + contrato simples.

---

## 9. Limitações reais

1. **ESTADO B** — sem validação manual completa em fluxo real multiempresa com operador.
2. Tabelas `caixa` (turno), `caixa_movimentacoes`, `caixa_fechamentos` **não** receberam `empresa_id` (isolamento via sessão).
3. Rotas de histórico/consulta por data (`/historico`, `/por-data`) não foram filtradas por empresa nesta sprint (fora do escopo operacional abrir/sangria/suprimento/fechar).
4. Em MULTIEMPRESA, frontends que ainda não enviem `X-Empresa-Id` serão bloqueados nas rotas de caixa (comportamento esperado).

---

## 10. O que NÃO foi alterado

MUV, checkout, TEF, PIX, Motor Fiscal, Central de Entradas, Financeiro, Dashboard, Relatórios, pagamento misto, PDV legado (regras comerciais), estoque, catálogo compartilhado — e **não** antecipada a Sprint 05.38.D.

---

## Critérios de conclusão

| Critério | Status |
|----------|--------|
| `caixa_sessoes` com `empresa_id` | ✅ |
| Sessões antigas preservadas (backfill) | ✅ |
| EMPRESA_SIMPLES sem seleção manual | ✅ |
| MULTIEMPRESA com isolamento | ✅ |
| Abrir / status / sangria / suprimento / fechar por empresa | ✅ |
| Contratos HTTP preservados | ✅ |
| Sem duplicar motor de caixa | ✅ |
| Testes novos + regressões | ✅ |
| Documentação | ✅ |

**Classificação: ESTADO B**
