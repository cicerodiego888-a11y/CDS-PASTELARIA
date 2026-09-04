# SPRINT 05.48

## OBJETIVO

Auditar a consolidação da cadeia de ownership empresarial (05.40–05.47) nas transições de domínio. Não corrigir produção. Não mascarar falha. Não iniciar o próximo sprint.

## CÓDIGO ALTERADO

**NÃO** (produção).  

**SIM** (somente auditoria): `tests/auditoria/consolidacao-multiempresa-05-48.test.js`  
**SIM** (documentos): `docs/arquitetura/AUDITORIA_CONSOLIDACAO_MULTEMPRESA_05_48.md`, `MATRIZ_INVARIANTES_EMPRESARIAIS_05_48.md`, `MAPA_TRANSICOES_EMPRESARIAIS_05_48.md`, este relatório.

Motor Comercial, ReservaRepair, schema, backfill, NFC-e 55: **não tocados**.

## VEREDITO

**PARCIALMENTE CONSOLIDADO.**

Cadeia PDV com `empresa_id` persistido: consolidada (T01–T04, T06 porta, T07–T10, T08 NFC-e).  
Buraco **D**: pedido sem dono + Repair INSERT sem `empresa_id`.  
Acervo vivo: LEGADO_NULL (não backfill).  
NF-e 55 / DistDFe: **E**.

## TESTES (execução 2026-08-25)

| Suite | Executados | Aprovados | Falhos | Tipo |
|-------|------------|-----------|--------|------|
| `ownership-vendas-05-40` | 13 | 13 | 0 | EXECUTADO |
| `ownership-financeiro-05-41` | 14 | 14 | 0 | EXECUTADO |
| `ownership-cancelamento-devolucao-05-42` | 9 | 9 | 0 | EXECUTADO |
| `distdfe-blindagem-05-43` | 7 | 7 | 0 | EXECUTADO |
| `ownership-caixa-sessao-05-44` | 10 | 10 | 0 | EXECUTADO |
| `isolamento-dashboard-caixa-05-45` | 14 | 14 | 0 | EXECUTADO |
| `isolamento-nfce-empresa-05-46` | 21 | 21 | 0 | EXECUTADO |
| `isolamento-lotes-fefo-reservas-05-47` | 19 | 19 | 0 | EXECUTADO |
| `consolidacao-multiempresa-05-48` | 12 | 12 | 0 | **NOVO** |
| `ajuste-estoque-porta-publica` | até falha | — | 1 | **PRÉ-EXISTENTE** (espera saldo `produtos` 13, veio 3) |
| `inventario-ajuste-multiempresa-contexto` | 01–12 OK, 13 falha | 12 | 1 | **PRÉ-EXISTENTE** (A 20 vs 110 dual-write) |
| `compras-multiempresa-contexto` | 01–09 OK, 10 falha | 9 | 1 | **PRÉ-EXISTENTE** (scan `empresaIdDoReqCompra`; rota já usa `compra.empresa_id`) |
| `monitoring-engine-m1` | 10 | 9 | 1 | **PRÉ-EXISTENTE** UI sem `modoFiscalAtivo` — não é isolamento de caixa |

Nenhuma falha **NOVA** introduzida pela auditoria. Suites 05.40–05.47 oficiais verdes. **Não** afirmar “tudo verde”.

Não executados: suíte completa de NF-e 55, TEF, Open Finance, UI PDV E2E no browser.

## RISCOS (TOP 10)

1. `pedidos` sem `empresa_id` — confirm pode variar empresa.  
2. ReservaRepair `dryRun: false` grava tracking sem `empresa_id`.  
3. Motor COMPAT → reserva NULL.  
4. 20/20 vendas e financeiro NULL neste DB.  
5. 5/5 `caixa_sessoes` NULL.  
6. `getFiscalConfig()` global (NF-e 55).  
7. Cancel NFC-e SEFAZ antes de estoque/financeiro.  
8. POST cancel sem estorno financeiro.  
9. `nfce_notas` sem `empresa_id`.  
10. Helper débito venda / `gerarProximoLote` COMPAT ou global.

## INVARIANTE

```
EMPRESA DA OPERAÇÃO → ownership persistido → fonte de verdade
contexto atual apenas autoriza
```

## PRÓXIMA RECOMENDAÇÃO (não iniciada)

Persistir `pedidos.empresa_id` e fechar Motor/Repair COMPAT nesse fluxo.
