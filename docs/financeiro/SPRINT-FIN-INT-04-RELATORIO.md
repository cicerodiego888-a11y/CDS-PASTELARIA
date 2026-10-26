# Sprint FIN-INT-04 — Relatório de entrega

**Tipo:** união controlada da lista Contas a Receber  
**Data:** 2026-10-26  
**Homologação:** pendente (Tech Lead)

## Arquivos alterados

- `backend/rotas/financeiro.js` — `GET /api/financeiro/receber` passa a unir legado elegível + `contas_receber`; helpers de mapeamento/status; `buildReceberQueryFilters` ganha opção `excluirComContaCanonica` (alias `GET /contas-receber` permanece legado puro).
- `frontend/erp/js/financeiro-receber.js` — renderização com `fonte`/`chave`, ações por origem, baixa canônica via `/api/contas-receber/pagar/:id`, detalhes CR a partir do cache da lista.
- `tests/financeiro/fin-int-04-uniao-receber.test.js` — testes isolados `:memory:` + regressão UI.
- `tests/financeiro/fin-int-02-contas-receber.test.js` — ajuste da coluna origem (rótulo legado/canônico).
- `docs/financeiro/SPRINT-FIN-INT-04-RELATORIO.md`

## Contrato anterior → novo

### Anterior
```json
{ "success": true, "contas": [{ "id", "descricao", "valor", "dataEmissao", "dataVencimento", "cliente", "status", "observacao", "documento", "numero_parcela", "total_parcelas", "origem" }] }
```
Somente `financeiro` tipo receita.

### Novo (compatível por adição)
```json
{
  "success": true,
  "uniao": true,
  "contas": [{
    "id": 123,
    "fonte": "financeiro" | "contas_receber",
    "chave": "financeiro:123" | "contas_receber:123",
    "descricao", "valor", "dataEmissao", "dataVencimento", "cliente",
    "status", "status_persistido", "observacao", "documento",
    "numero_parcela", "total_parcelas", "origem",
    "venda_id", "cliente_id", "componente",
    "valor_parcela?", "acoes_disponiveis": ["baixar","detalhes", ...]
  }]
}
```

- Campos antigos preservados; `fonte` e `chave` tornam a identidade inequívoca.
- Canônico: `valor` = `valor_restante` (não soma espelho).
- Consumidores que ignoram campos extras continuam lendo `contas[]`.

## Regra de sobreposição

Reutiliza **`sqlExcluirFinanceiroReceberComContaCanonica`** (`empresa_id` + `venda_id` resolvido de `venda_id`/`referencia_id` + `numero_parcela`).

- Legado listado **somente** se não houver CR correspondente.
- CR listado por registro/componente (múltiplos componentes = múltiplas linhas; soma = parcela agregada).
- Sem segundo predicado; sem chave por valor/descrição/cliente.

## Status e filtros

| Filtro UI | Legado (`financeiro`) | Canônico (`contas_receber`) |
|---|---|---|
| `todas` | todos elegíveis | todos não excluídos por venda cancelada |
| `vencidas` | não liquidados + vencimento &lt; hoje | `aberto`/`parcial` + vencimento &lt; hoje |
| `a_vencer` | não liquidados + vencimento ≥ hoje | `aberto`/`parcial` + vencimento ≥ hoje |
| `recebidas` | `recebido`/`pago` | `recebido`/`pago` |
| `aberto`/`pendente` | não liquidados | `aberto`/`parcial` |
| documento | aplica | **omite CR** (sem coluna documento) |
| cliente / período / empresa | preservados | preservados |

`status` na resposta pode ser derivado para exibição (`vencido`); `status_persistido` mantém o valor do domínio.

## IDs e ações por origem

| Fonte | Baixar | Detalhes | Editar / renegociar / cancelar |
|---|---|---|---|
| `financeiro` | `POST /api/financeiro/receber/:id/baixar` | `GET /api/financeiro/:id` | fluxos legados existentes |
| `contas_receber` | `POST /api/contas-receber/pagar/:id` (somente `status_persistido=aberto`) | modal a partir do cache da lista | não disponíveis nesta lista (orientação a Dívidas) |

Botões usam `data-id` + `data-fonte` + `data-chave`. IDs iguais em fontes distintas não se confundem.

## Testes executados

| Comando | Resultado |
|---|---|
| `node --check backend/rotas/financeiro.js` | Aprovado |
| `node --check frontend/erp/js/financeiro-receber.js` | Aprovado |
| `node --test tests/financeiro/fin-int-04-uniao-receber.test.js` | **2/2** |
| `node --test tests/financeiro/fin-int-02-contas-receber.test.js` | **5/5** |
| `node --test tests/financeiro/fin-p1-2-consistencia.test.js` | **4/4** |
| `node --test tests/financeiro/contexto-empresarial-financeiro-p0.test.js` | **6/6** |

Evidências cobertas nos testes isolados: dual-write sem duplicar espelho; 2 componentes = 500; manual legado; só-CR com `valor_restante`; cancelados excluídos; isolamento A/B; colisão de `id` com `fonte` distinta; filtros cliente/documento; UI data/escape/`data-fonte`.

## Confirmações de escopo

- Relatório `/relatorios/receber`, Histórico, Dashboard, Dívidas, Contas a Pagar, MCF/MBC: **não** alterados.
- Sem migração/backfill; sem escrita em banco original/cliente (apenas `:memory:` nos testes).
- Alias `GET /api/financeiro/contas-receber` permanece legado (sem união).

## Limitações

- Baixa de CR `parcial` continua fora desta lista (`/pagar/:id` só aceita `aberto`); use Dívidas por Cliente.
- Filtro por documento não inclui títulos só-CR.
- Sem sessão Electron autenticada nesta Sprint.
- `GET /contas-receber` (alias legado) não unificado de propósito.

**Status:** FIN-INT-04 concluída para homologação. Nenhuma outra Sprint iniciada.
