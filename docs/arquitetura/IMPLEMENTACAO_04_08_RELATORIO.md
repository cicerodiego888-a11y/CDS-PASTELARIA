# Relatório — Sprint 04.08
## Contexto fiscal multiempresa + materialização fiscal completa

**Data:** 2026-08-22 · **Status:** concluída

### Resumo executivo

O MULTIEMPRESA deixa de usar a configuração NFC-e global por acidente. Cada operação usa a config da `empresa_id` persistida, numera NFC-e no próprio contexto e materializa `quantidade_fiscal`/`valor_fiscal` para o emissor oficial. Não há motor fiscal paralelo.

### Auditoria (campos do emissor)

| Campo | Origem atual | Destino | Já existia? | Materializar? | Risco |
|---|---|---|---|---|---|
| CNPJ / razão / IE | `configuracoes` | `empresas` + config empresa | cadastro sim | não | fallback global |
| CSC / certificado / URLs | `configuracoes` | `empresas_configuracao_fiscal` | não por empresa | config | mistura A/B |
| série / número | global + MAX `nfce_notas` | por `empresa_id` | sim, global | não | colisão de numeração |
| `quantidade_fiscal` / `valor_fiscal` | `vendas_itens` no PDV | mesma tabela na 04.06 | colunas sim | **sim** | `sem_itens_fiscais` |
| XML | `nfce_notas` | mesma + `empresa_id` | sim | ref. 04.07 | copiar XML |

### Decisões

1. Tabela `empresas_configuracao_fiscal` — origem da config, não motor novo.
2. `getFiscalConfig({ empresaId })` sem fallback para global/empresa 1.
3. `empresaId` externo divergente é **rejeitado**.
4. Overload compatível em `emitirPorVendaId`.
5. Status 04.07 mantidos.

### Schema

- `empresas_configuracao_fiscal`
- `nfce_notas.empresa_id` (coluna)

### Testes novos

`contexto-fiscal-multiempresa-04-08` — **30/30**

### Regressão

04.01–04.07, MUC, rc7104, orquestrador, TEF, dual-write 03.19, reservas 03.20, portas, venda-baixa, compras, cancel/devolução, MTS, expedição, VendaApplicationService — OK.

`fiscal-platform`: falha pré-existente (`26 !== 24` em FiscalWebServices), sem dependência desta sprint.

### Próxima sprint (não iniciada)

**04.09** (sugestão): UI de configuração fiscal por empresa, preenchimento de certificado/CSC no cadastro, e só então impressão/cancelamento se priorizado.
