# Sprint FIN-INT-03 — Auditoria da fonte canônica de Contas a Receber

**Tipo:** auditoria arquitetural somente leitura  
**Data:** 2026-10-26  
**Homologação:** pendente (Tech Lead)

## 1. Resumo executivo

Há **duas trilhas coexistentes** para obrigações a receber:

| Trilha | Tabela | Papel observado no código |
|---|---|---|
| Canônica de parcelas de venda a prazo / crédito | `contas_receber` (+ `contas_receber_pagamentos`) | Dívidas por Cliente, parte do Dashboard, inadimplência (união), rotas `/api/contas-receber/*` |
| Legado / espelho / manuais | `financeiro` tipo `receita` | Lista `GET /api/financeiro/receber`, Relatório receber, Histórico, baixas via `/api/financeiro/receber/:id/baixar` |

Na finalização de vendas a prazo/crédito o sistema **grava nas duas**: parcelas em `contas_receber` (por componente) e linhas agregadas em `financeiro`. Para **evitar dupla contagem em totais**, o backend já possui o predicado `sqlExcluirFinanceiroReceberComContaCanonica` — usado no Dashboard, resumos e inadimplência — mas **não** na lista Contas a Receber nem no relatório `/relatorios/receber`.

**MCF / projeções `mcf_compatibilidade`** aplicam-se a Contas a **Pagar**, não a Contas a Receber. Não confundir as duas famílias.

**Integração operacional real não foi revalidada** (sem backend autenticado). Evidências: código + testes em SQLite `:memory:`.

## 2. Mapa das fontes e relacionamentos

### 2.1 Schema relevante

**`contas_receber`** (`backend/database.js`): `venda_id`, `cliente_id`, `empresa_id`, `numero_parcela`, `total_parcelas`, `componente`, `valor_parcela`, `valor_restante`, `data_vencimento`, `data_pagamento`, `status` (`aberto` / `parcial` / `recebido` / `pago`…).

**`contas_receber_pagamentos`**: `conta_receber_id`, `cliente_id`, `valor_pago`, `data_pagamento`, `forma_pagamento`.

**`financeiro`** (receitas): `tipo='receita'`, `venda_id` / `referencia_tipo='venda'` + `referencia_id`, `numero_parcela`, `valor`, `status` (`pendente` / `parcial` / `recebido` / `pago`…), `origem`, `empresa_id`, `vencimento`, `baixado_em`.

### 2.2 Ciclo de vida (origem)

```
Venda a prazo / crédito (PDV)
  ├─ INSERT contas_receber (1..N por parcela × componente)     ← canônico saldo aberto
  └─ INSERT financeiro receita (1 por parcela, valor agregado) ← espelho / lista legada

Venda à vista (sem gerar parcelas)
  └─ INSERT financeiro (recebido|pendente)                    ← muitas vezes sem CR

Lançamento manual em financeiro
  └─ somente financeiro                                       ← sem CR

Pagamento parcial agrupado (Dívidas)
  └─ contas_receber_pagamentos + UPDATE valor_restante/status ← canônico

Baixa pela lista legado (/financeiro/receber/:id/baixar)
  ├─ UPDATE financeiro
  └─ se houver CR (venda+parcela+empresa): liquida componentes + INSERT pagamentos
```

Evidências de dual-write: `VendaPagamentoService` (prazo ~L1644–1692; crédito ~L1862–1889); entrega `MotorFinalizacaoVenda` (~L477–485) também cria CR em vendas a prazo (observação: trecho inspecionado **não** seta `empresa_id` naquele INSERT — lacuna potencial de ownership na entrega, fora do escopo de correção desta Sprint).

### 2.3 Chave de relacionamento confiável

O predicado oficial de sobreposição (`VendaFinanceiroService.sqlExcluirFinanceiroReceberComContaCanonica`) considera o mesmo compromisso quando:

1. `financeiro.empresa_id = contas_receber.empresa_id`
2. `contas_receber.venda_id = COALESCE(financeiro.venda_id, referencia_id se referencia_tipo='venda')`
3. `numero_parcela` igual (incluindo ambos NULL)

**Não** usa igualdade de valor/descrição.  
**Não** há FK `financeiro.id ↔ contas_receber.id`.  
Um `financeiro` agrega **vários** `contas_receber` do mesmo `numero_parcela` com `componente` distinto (`produtos` / `outros`); a baixa sincronizada exige que a soma dos componentes confira com `financeiro.valor` (tolerância 0,01).

### 2.4 O que não é Contas a Receber canônico

| Conceito | Identificação | Escopo |
|---|---|---|
| Projeção MCF | `origem='mcf_compatibilidade'` ou `referencia_tipo='contas_pagar_mcf'` | Contas a **Pagar** |
| Vínculo MCF | `contas_pagar_financeiro_compat` | AP |
| Histórico liquidado em CR | `status IN ('recebido','pago')`, `valor_restante≈0`, linhas em `contas_receber_pagamentos` | AR canônico |
| Espelho financeiro de venda | `origem='venda'`, `tipo='receita'` | Legado / histórico de movimentação |

## 3. Contratos e filtros comparados

| Superfície | Endpoint | Fonte | Exclui CR canônico no legado? | Exclui venda cancelada? | Exclui projeção MCF? | Filtros principais |
|---|---|---|---|---|---|---|
| Lista Contas a Receber (aba) | `GET /api/financeiro/receber` | só `financeiro` | **Não** | Sim | N/A (receita) | empresa, período vencimento, status UI (`vencidas`/`a_vencer`/`recebidas`), cliente, documento |
| Dívidas por Cliente | `GET .../receber/agrupado` | só `contas_receber` | — | Sim | — | empresa, status aberto/parcial, vencimento, cliente |
| Dashboard `totalReceber` | `GET /dashboard` | legado pendente **+** CR aberto/parcial | **Sim** | Sim | Sim (despesas/projeções) | empresa; CR também por vencimento se período |
| Dashboard `totalRecebido` | idem | financeiro baixado **+** `contas_receber_pagamentos` | exclusão no legado | Sim | Sim | período |
| Relatório receber | `GET .../relatorios/receber` | só `financeiro` | **Não** | Sim | — | período, status, cliente, modo fiscal |
| Relatório inadimplência | `GET .../relatorios/inadimplencia` | união financeiro elegível + CR + AP MCF | **Sim** no legado | Sim | Sim | período opcional |
| Histórico | `GET /api/financeiro` | `financeiro` | **Não** (lista movimentações) | Sim | Sim | período, tipo, status, busca |
| API dedicada CR | `/api/contas-receber/*` | `contas_receber` | — | parcial (em aberto/vencidas) | — | empresa |

### Vocabulário de status (causa de divergência de tela)

| Domínio | Status típicos de aberto | Liquidado |
|---|---|---|
| `financeiro` | `pendente`, `parcial` (e UI deriva `vencido`) | `recebido`, `pago` |
| `contas_receber` | `aberto`, `parcial` | `recebido`, `pago` |

A aba Contas a Receber filtra status do **legado**; Dívidas filtra **CR**. Mesmo cliente/período pode parecer “limpo” numa tela e “em dívida” na outra (ou o inverso), sem que os valores sejam “errados” dentro de cada contrato.

### Pagamentos parciais

- Caminho canônico: `POST .../receber/agrupado/:clienteId/pagamento-parcial` → `contas_receber_pagamentos` + `valor_restante` / `parcial|recebido` (testado em `sprint-2-3-1-recebimentos-integrados.test.js`).
- Caminho legado: `POST /api/financeiro/receber/:id/baixar` atualiza `financeiro` e, se houver CR casada, liquida componentes (não é o mesmo fluxo parcial agrupado).
- Dashboard “recebido no período” soma pagamentos CR **e** receitas baixadas no legado (com exclusão de espelhos canônicos no lado legado).

## 4. Situações de sobreposição / risco

| Situação | Efeito |
|---|---|
| Venda a prazo dual-write | Mesmo compromisso em CR e `financeiro`; Dashboard conta uma vez (exclusão + CR); **lista Contas a Receber ainda mostra o espelho financeiro** |
| Vários componentes CR × um financeiro | Exclusão por `numero_parcela` cobre o agregado; baixas exigem soma coerente |
| Só `financeiro` manual | Necessário para histórico/compatibilidade; aparece na lista; **não** em Dívidas |
| Só CR (teórico / entrega sem espelho completo) | Aparece em Dívidas/Dashboard; **ausente** na lista Contas a Receber |
| Relatório receber sem exclusão | Pode reportar espelhos já representados em CR noutros relatórios/telas |
| Igualdade de valor/descrição | **Não** é chave — não presumir identidade |
| Multiempresa | Predicado e rotas usam `empresa_id`; P0 e P1.2 cobrem isolamento em memória |

## 5. Respostas às perguntas do briefing

1. **`contas_receber` é canônica para quê?**  
   Parcelas/componentes de venda a prazo/crédito (saldo aberto, dívidas por cliente, pagamentos parciais, parte dos totais do Dashboard e inadimplência).

2. **O que ainda precisa de `financeiro`?**  
   Espelho de movimentação/histórico; receitas manuais e fluxos sem CR; baixas/edições legadas; relatórios ainda baseados no legado; Histórico geral.

3. **Chave confiável de sobreposição?**  
   Sim, no código: `(empresa_id, venda_id resolvido, numero_parcela)` via `sqlExcluirFinanceiroReceberComContaCanonica`. Não há ID compartilhado único.

4. **Como evitar dupla contagem?**  
   Nos agregados: já aplicar exclusão no legado **e** somar CR/`contas_receber_pagamentos` (padrão Dashboard/inadimplência). Nunca somar valor de espelho + `valor_restante` do mesmo `(venda, parcela)`.

5. **Diferenças de status/filtros?**  
   Vocabulários distintos; lista/relatório receber ignoram a exclusão canônica; Dívidas só vê `aberto|parcial` em CR.

6. **Solução mais segura?**  
   **Curto prazo:** manter fontes distintas com **escopos explícitos na UI** (lista = legado; Dívidas = canônico) **até** existir união testada — reduz risco imediato sem mudar SQL.  
   **Médio prazo (recomendado para Sprint corretiva):** **união controlada no backend** da lista (e idealmente do relatório receber), reutilizando o predicado já existente + linhas CR sem espelho, **sem** misturar projeções MCF (irrelevantes a AR).  
   Ajustar “apenas a consulta” da lista aplicando só a exclusão **sem** unir CR **omitiria** títulos só-CR e **não** resolve a lacuna frente a Dívidas.

7. **Testes antes de implementar?**  
   Ver seção 8.

## 6. Alternativas arquiteturais

| Alternativa | Vantagens | Riscos |
|---|---|---|
| **A.** Só documentar escopos na UI | Zero mudança de cálculo; rápido | Lista continua desalinhada do canônico; operador confuso |
| **B.** Lista = só `contas_receber` | Alinha a Dívidas | Perde manuais/legado sem CR; quebra baixas/`id` financeiro; regressão grande |
| **C.** União controlada (legado elegível + CR) com exclusão | Preserva histórico e canônico; padrão já usado no Dashboard/inadimplência | Contrato de resposta (ids de fontes distintas), status unificados, ações (baixar legado vs pagar CR), testes densos |
| **D.** Migrar/backfill tudo para CR e aposentar espelho | Fonte única | Fora do escopo seguro atual; exige migração — **não recomendado agora** |

**Recomendação técnica:** preparar **Alternativa C** numa Sprint corretiva futura, precedida de testes da seção 8; até lá, **Alternativa A** (clareza de escopo) como mitigação de produto sem alterar backend.

## 7. Evidências de testes somente leitura

| Comando | Resultado | O que prova |
|---|---|---|
| `node --test tests/financeiro/fin-p1-2-consistencia.test.js` | **4/4** | Dashboard: exclusão de cancelados/projeções; `totalReceber` mistura legado elegível (25) + CR; isolamento empresa; inadimplência com `fonte: contas_receber` / `contas_pagar` |
| `node --test tests/financeiro/contexto-empresarial-financeiro-p0.test.js` | **6/6** | Rotas `/receber` e `/receber/agrupado` exigem empresa; headers frontend |

Fixtures usam SQLite `:memory:`. Nenhum banco original/cliente foi aberto por esta Sprint.

## 8. Critérios / testes exigidos antes da Sprint corretiva

1. Dual-write (venda+parcela): Dashboard e futura lista unificada contam **uma** obrigação; valores = `valor_restante` CR (não soma com espelho).
2. Componentes múltiplos na mesma parcela: exclusão e totais corretos.
3. Recebível **só** `financeiro` manual: continua listado.
4. Recebível **só** CR: aparece na união; ações apontam para API CR.
5. Pagamento parcial CR: lista/Dashboard refletem `valor_restante`; sem duplicar pagamento no legado.
6. Baixa legado com sync: ambos liquidados sem divergência residual.
7. Venda cancelada: ausente nas duas fontes filtradas.
8. Multiempresa: sem vazamento A↔B.
9. Contrato UI: campo `fonte` (`financeiro` \| `contas_receber`) e ids não colidem em ações.
10. Regressão: Histórico ainda lista movimentações; MCF AP intacto.

## 9. Confirmação de não alteração

Nesta Sprint FIN-INT-03:

- **Não** foram alterados arquivos de implementação.
- **Não** houve migração, backfill, criação de títulos/pagamentos/cancelamentos.
- **Não** foi iniciado backend contra banco de cliente.
- Único artefato novo: este relatório `docs/financeiro/SPRINT-FIN-INT-03-RELATORIO.md`.

## 10. Lacunas registradas (sem inventar regra)

- Volume real de títulos só-legado vs dual-write em bases de cliente: **não medido** (sem acesso a DB cliente).
- Se todos os caminhos de venda hoje sempre gravam o par CR+financeiro: evidência forte no PDV prazo/crédito; caminhos alternativos (entrega sem `empresa_id` no INSERT CR) merecem auditoria pontual futura.
- Unificação de status (`pendente` vs `aberto`) no contrato unificado: **ainda não especificada**.

**Status:** FIN-INT-03 concluída para homologação. Nenhuma correção e nenhuma Sprint seguinte foram iniciadas.
