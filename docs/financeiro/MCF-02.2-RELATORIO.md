# MCF-02.2 — Relatório de entrega

**Sprint:** MCF-02.2 — Interface canônica Contas a Pagar + dry-run histórico  
**Status:** incremento entregue — **aguardar Tech Lead** antes de qualquer backfill  
**Fonte canônica AP:** `/api/contas-pagar` (MCF)

---

## 1. Interface

### Operações da tela Contas a Pagar (`frontend/erp/js/financeiro-pagar.js`)

| Operação | Contrato MCF |
|----------|--------------|
| Listagem / filtros | `GET /api/contas-pagar` |
| Criação (incl. parcelas) | `POST /api/contas-pagar/lote` + `Idempotency-Key` |
| Detalhes | `GET /api/contas-pagar/:id/detalhes` |
| Pagamento | `POST /api/contas-pagar/:id/baixar` |
| Cancelamento (admin) | `POST /api/contas-pagar/:id/cancelar` |
| Exportar CSV | client-side a partir da lista MCF |
| Dry-run histórico (admin) | `GET /api/contas-pagar/reconciliacao-historica/dry-run` |

Relatório “Contas a Pagar” e tipo “Dry-run reconciliação histórica” em `financeiro-relatorios.js` também usam `/api/contas-pagar*`.

### Estados cobertos na UI

- Carregando / lista vazia / erro (401/403/409 com mensagem)
- Replay idempotente em criação, baixa e cancelamento
- Autorização de cancelamento e dry-run (admin)

### Escritas legadas AP

Nenhuma chamada de escrita AP ativa na UI para `/api/financeiro/*`.  
Receitas, histórico genérico, resumo/fluxo e Contas a Receber permanecem no legado (outras naturezas).

### Dashboard financeiro

`GET /api/financeiro/dashboard` passa a:

- **próximos pagamentos / alertas AP** → `contas_pagar`
- **totalPago** → pagamentos MCF no período + despesas históricas pagas (sem projeção)
- **totalPagar** → `valor_restante` MCF + despesas históricas abertas (sem projeção)

Projeções `mcf_compatibilidade` continuam excluídas — sem dupla contagem título+projeção.

---

## 2. Dry-run histórico (somente leitura)

- Serviço: `ContasPagarReconciliacaoHistoricaDryRunService.js`
- Rota: `GET /api/contas-pagar/reconciliacao-historica/dry-run` (admin; `?multiempresa=1` opcional)
- Critérios: conforme `MCF-02.1-RECONCILIACAO-HISTORICA.md`
- Ações: `vincular` | `criar_titulo` | `ignorar` | `revisao_manual`
- Totais por empresa e gerais (quantidade + valor conhecido + qtd não verificável)
- **Não** inferir quitação/saldo só pelo status legado (`saldo_conhecido = null`)
- **Não** INSERT/UPDATE/DELETE (revisão de código + teste com spy em `db.run`)

---

## 3. Testes executados

```bash
node --test tests/financeiro/mcf-02.2-interface-dry-run.test.js tests/financeiro/mcf-02.1-fechamento-operacional.test.js
```

Cobertura 02.2:

- UI aponta só para `/api/contas-pagar` (AP)
- Match compra+parcela → vincular
- Ambiguidade / divergência → revisão manual
- Pago/parcial/cancelado sem inferir saldo; projeções excluídas
- Título com projeção + legado paralelo → revisão
- Totais + anti-dupla-contagem
- API admin/403 + isolamento multiempresa
- Ausência de SQL de escrita no serviço

**Não testado nesta entrega:** integração real Electron desktop nem matching MBC (intactos).

---

## 4. Arquivos principais

| Arquivo | Papel |
|---------|-------|
| `backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService.js` | Dry-run |
| `backend/rotas/contas_pagar.js` | Endpoint dry-run |
| `backend/rotas/financeiro.js` | Dashboard AP via MCF |
| `frontend/erp/js/financeiro-pagar.js` | UI canônica + export + dry-run |
| `frontend/erp/js/financeiro-relatorios.js` | Relatório AP + dry-run |
| `tests/financeiro/mcf-02.2-interface-dry-run.test.js` | Suite |
| `docs/financeiro/MCF-02.2-RELATORIO.md` | Este documento |

---

## 5. Riscos residuais

- Despesas históricas ainda entram em `totalPagar` do dashboard até backfill — dry-run classifica, não migra
- Histórico financeiro (`GET /api/financeiro`) lista despesas legadas, não títulos MCF (visão ledger, não AP canônica)
- Resumo/fluxo legado ainda agregam despesas históricas sem títulos MCF quitados no período (exceto dashboard AP)
- UI Electron não validada end-to-end neste incremento

---

## 6. Próximo passo (bloqueado)

Backfill / migração persistente **somente após aprovação do Tech Lead**, usando o relatório dry-run como entrada. MBC permanece fora de escopo.
