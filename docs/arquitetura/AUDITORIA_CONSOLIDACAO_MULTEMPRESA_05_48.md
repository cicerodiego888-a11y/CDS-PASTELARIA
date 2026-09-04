# AUDITORIA DE CONSOLIDAÇÃO MULTIEMPRESA — Sprint 05.48

**Tipo:** auditoria de consolidação (sem correção automática)  
**Data:** 2026-08-25  
**Escopo:** cadeia 05.40–05.47 após domínio isolado. Suites verdes isoladas **não** bastam.

Código de produção: **não alterado**. Exceção: nenhum. Teste novo apenas em `tests/auditoria/consolidacao-multiempresa-05-48.test.js`.

---

## Veredito

**PARCIALMENTE CONSOLIDADO.**

A cadeia operacional PDV está consolidada **quando** `empresa_id` está persistido:

```
empresa do contexto → sessão da empresa → venda.empresa_id
  → estoque_empresa / FEFO da empresa / financeiro da venda
  → NFC-e (cert/CSC da empresa da venda)
  → cancelamento/devolução pela dona da venda
```

O que impede o veredito **CONSOLIDADO**:

1. **T05 D** — `pedidos` sem `empresa_id`; Motor COMPAT; ReservaRepair pode criar reserva operacional **sem** `empresa_id`.
2. **Acervo LEGADO_NULL** neste banco vivo (20/20 vendas, 20/20 financeiro, 5/5 sessões) — não é regressão de código; bloqueia reversão/NFC-e até classificação (proibido backfill automático).
3. **E** — NF-e 55 / DistDFe / `getFiscalConfig()` global fora do contrato NFC-e 05.46.

---

## O que foi auditado

- T01–T10 (mapa em `MAPA_TRANSICOES_EMPRESARIAIS_05_48.md`)
- NULL no DB `C:\ProgramData\MercantilFiscal\dados\mercadao.db` (somente leitura)
- Queries globais, COMPAT, Motor Comercial, ReservaRepair
- Cruzamento A→B (C01–C10) no teste de auditoria
- Regressões já conhecidas 05.47 e M1 monitoring (não mascaradas)

---

## Cadeia consolidada (quando há dono persistido)

| Elo | Evidência |
|-----|-----------|
| Caixa | SQL de sessão sempre com `empresa_id` |
| Venda | INSERT com `empresaIdVenda`; sessão divergente bloqueada |
| Estoque | Porta F×NF com empresa da operação / da venda na reversão |
| FEFO | filtro `empresa_id` + SKU; restauração AND empresa |
| Reserva PDV/pedido (porta) | `empresa_id` persistido; dual-write; 404 cruzado |
| Financeiro | INSERT da origem; divergência venda×caixa 409 |
| NFC-e | `fonte === 'EMPRESA'`; contexto B = 404 |
| Cancel/dev | `exigirOperacaoReversaoDaVenda` antes de mutar |

---

## Buracos restantes (não corrigidos nesta sprint)

| # | Buraco | Classe | Sprint origem |
|---|--------|--------|---------------|
| 1 | `pedidos` sem `empresa_id` | D | pré-05.47 / Motor |
| 2 | Motor `optsPortaSaldos` COMPAT sem empresa → reserva NULL | C | Motor |
| 3 | Repair INSERT tracking sem `empresa_id` (`dryRun: false`) | D | Repair |
| 4 | Vendas/financeiro/caixa vivos 100% NULL | LEGADO_NULL | 05.40/05.41 classificação |
| 5 | `nfce_notas` / `vendas_devolucoes` sem coluna empresa | INDIRETO | schema |
| 6 | `getFiscalConfig()` global | E | NF-e 55 |
| 7 | Cancel PUT: SEFAZ antes de estoque | ordem residual | 05.42 |
| 8 | Cancel POST sem INSERT estorno | residual | 05.42 |
| 9 | `gerarProximoLote` global | C | 05.47 |
| 10 | Helper débito venda ainda aceita COMPAT | C | 02.6/03 |

Motor Comercial e ReservaRepair **não** foram alterados (proibido nesta auditoria).

---

## Motor Comercial / ReservaRepair

| Componente | Classificação | Motivo |
|------------|---------------|--------|
| Motor com `empresaId` no opts/pedido | PARCIAL / A no ramo | porta recebe empresa; reserva 05.47 persiste |
| Motor sem empresa | PARCIAL / C | COMPAT explícito; **não** inventa empresa 1 |
| ReservaRepair dry-run | C | não escreve |
| ReservaRepair `dryRun: false` | **RISCO** | INSERT sem `empresa_id`; COMPAT de saldo |

Não há scheduler encontrado; execução é on-demand (`executarPlanoCorrecao`).

---

## Cenários A→B (teste 05.48)

Todos exercitados em `tests/auditoria/consolidacao-multiempresa-05-48.test.js`:

1. Consulta A não lê estoque B  
2. FEFO A não consome lote B (validade B menor)  
3. Sessão B não opera venda A  
4. Venda A não cria financeiro B (divergência)  
5. NFC-e A não aceita contexto B nem config `fonte=GLOBAL`  
6. Cancel A devolve estoque da venda, não do `req` B; NULL não inventa  
7. Devolução A não autoriza contexto B; financeiro da venda  
8. Reserva A não altera `reservado` B; B lê reserva A → 404  
9. Contexto B em venda A → 404 (não 403)  
10. Legado NULL não inventa `empresa_id` (venda, create, sessão)

---

## Próxima recomendação (única — não iniciada)

**Ownership persistido de Pedido Comercial:** coluna `pedidos.empresa_id`, Motor recusar confirm sem empresa (fim do COMPAT nesse fluxo), ReservaRepair INSERT com `empresa_id` da operação. É o único **D** estrutural da cadeia operacional. Não misturar com backfill do acervo NULL nem com NF-e 55.
