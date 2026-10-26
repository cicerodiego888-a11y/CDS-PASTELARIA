# MCF-02.1 — Relatório de entrega

**Sprint:** MCF-02.1 — Fechamento operacional de Contas a Pagar  
**Status:** incremento entregue (MCF-02 / Sprint 03 **não** declarados concluídos)  
**Fonte canônica AP:** `contas_pagar` (MCF) + projeção `contas_pagar_financeiro_compat` → `financeiro` (`origem=mcf_compatibilidade`)

---

## 1. Classificação dos escritores legados de `financeiro`

| Fluxo | Classificação | Ação MCF-02.1 |
|-------|---------------|---------------|
| `POST /api/financeiro` com `tipo=despesa` | **MUST_USE_MCF** | Delega a `ContasPagarService.criar` (+ baixa opcional se status pago) |
| `PUT /api/financeiro/:id` sobre projeção MCF | **PROJEÇÃO** | Bloqueia `MCF_PROJECAO_IMUTAVEL` |
| `DELETE /api/financeiro/:id` sobre projeção MCF | **PROJEÇÃO** | Bloqueia |
| `POST /api/financeiro/pagar/:id/baixar` sobre projeção | **PROJEÇÃO** | Bloqueia — pagar via `/api/contas-pagar/:id/baixar` |
| Compra → `CompraContasPagarMcfService` | **MUST_USE_MCF** | Já canônico (MCF-02) |
| Cancelamento de compra → `UPDATE financeiro` | **PROJEÇÃO / histórico** | Exclui `mcf_compatibilidade` do UPDATE; títulos cancelados pelo MCF |
| `POST /api/financeiro` `tipo=receita` | **OTHER_NATURE** | Continua no legado |
| Baixa de contas a receber / split venda | **OTHER_NATURE** | Sem alteração |
| Despesas históricas pré-MCF em `financeiro` | **HISTÓRICO** | Sem migração; ver `MCF-02.1-RECONCILIACAO-HISTORICA.md` |

Rotas `/api/financeiro/*` **não** foram bloqueadas indiscriminadamente.

---

## 2. Projeção de compatibilidade

- Schema: `UNIQUE (empresa_id, conta_pagar_id)` e `UNIQUE (empresa_id, financeiro_id)`
- Criação: `assegurarProjecaoFinanceira` (1:1)
- Sync: `sincronizarProjecaoFinanceira` em baixar/cancelar (mesma TX)
- Guard: `ContasPagarFinanceiroCompatGuard` (identidade + SQL de exclusão)
- Listagens/dashboard/relatórios: excluem projeção; dashboard AP soma `contas_pagar.valor_restante`
- **MBC / matching:** não alterados

---

## 3. Multiempresa e permissões

- Rotas MCF e financeiro resolvem empresa no servidor (`X-Empresa-Id` / contrato)
- Operações MCF filtram por `empresa_id`; acesso cruzado → 404/403
- Cancelamento MCF e edição financeira sensível exigem `admin` onde já aplicável
- Testes HTTP com modo `MULTIEMPRESA` stubado + usuário vinculado às duas empresas

---

## 4. Arquivos alterados / criados

| Arquivo | Mudança |
|---------|---------|
| `backend/motores/mcf/services/ContasPagarFinanceiroCompatGuard.js` | Guard (novo) |
| `backend/motores/mcf/contracts/constantesMcf.js` | Erros + versão MCF-02.1 |
| `backend/motores/mcf/services/ContasPagarService.js` | Export sync/assegurar |
| `backend/rotas/financeiro.js` | Despesa→MCF; bloqueio projeção; exclusão em listagens/relatórios |
| `backend/rotas/compras.js` | Cancel não altera projeções MCF |
| `backend/rotas/dashboard.js` | AP via `contas_pagar` |
| `tests/financeiro/mcf-02.1-fechamento-operacional.test.js` | Suite MCF-02.1 |
| `tests/financeiro/mcf-01.test.js` | Assert de versão flexível |
| `docs/financeiro/MCF-02.1-RELATORIO.md` | Este relatório |
| `docs/financeiro/MCF-02.1-RECONCILIACAO-HISTORICA.md` | Estratégia (sem backfill) |

---

## 5. Testes executados

Comando:

```bash
node --test tests/financeiro/mcf-02.1-fechamento-operacional.test.js tests/financeiro/mcf-01.test.js tests/financeiro/mcf-02-compras.test.js
```

Cobertura MCF-02.1 (SQLite `:memory:`):

- Projeção 1:1 + UNIQUE
- Pagamento parcial/total, excesso, cancelamento parcial + sync
- Compra 1/N parcelas, idempotência, rollback
- Sem dupla contagem listagem legado vs MCF
- POST despesa→MCF; receita legado; PUT/DELETE/baixar projeção bloqueados
- API multiempresa cruzada
- Concorrência de baixas + idempotência
- TX abort sem título/projeção órfãos

---

## 6. Riscos residuais

- Despesas históricas em `financeiro` ainda entram em alguns relatórios legado (excluídas as projeções); reconciliação pendente
- UI legado que lista só `/api/financeiro/contas-pagar` deixa de ver títulos só-MCF (deve migrar para `/api/contas-pagar`)
- Consumidores externos que mutavam despesa via PUT legado precisam apontar para MCF
- Concorrência SQLite depende de `BEGIN IMMEDIATE`; em WAL multi-conexão real, revalidar sob carga

---

## 7. Próximo incremento recomendado

**MCF-02.2** — UI Contas a Pagar 100% em `/api/contas-pagar` + dry-run do relatório de reconciliação histórica (somente leitura), ainda sem backfill. Manter MBC intacto.
