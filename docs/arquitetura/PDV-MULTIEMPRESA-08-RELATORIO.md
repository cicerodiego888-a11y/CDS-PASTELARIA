# PDV-MULTIEMPRESA-08 — Alinhamento do Motor F×NF à compatibilidade de saldo

**Data:** 2026-10-26  
**Decisão arquitetural:** Opção A (M07)  
**Prioridade:** P0  
**Estado final:** **CONCLUÍDA** (validação + distribuição alinhadas; aguardar revisão TL antes de homologação/build)

## 1. Objetivo

Eliminar consumo cruzado de buckets no Motor F×NF para produtos **sem** ficha técnica:

- venda fiscal → somente `saldo_fiscal`;
- venda não fiscal → somente `saldo_nao_fiscal`;
- insuficiência no bucket exigido → bloqueio (sem usar total como substituto).

Ficha técnica: contrato vigente total F+NF **preservado** (sem alteração nesta sprint).

## 2. Mapa de impacto (pré-verificação)

### 2.1 Camada autoritativa escolhida

| Camada | Papel | Decisão |
|---|---|---|
| `distribuirQuantidadeVenda` | Núcleo compartilhado de distribuição | **Alterada** — bucket exclusivo |
| `distribuirItensVendaComValorFiscalEfetivo` | Pipeline finalização / preview motor | **Alterada** — faixa min/max colapsa (evita MIDP reintroduzir cruzamento) |
| `obterFaixaQuantidadeFiscal` | Faixa teórica F+NF (auditoria/legado) | Mantida (não autoritativa para débito) |
| `debitoEstoqueVendaViaPorta` | Aplica qF/qNF já calculados | Sem alteração (herda distribuição) |
| `FichaTecnicaConsumoService` | Insumos total F+NF | Sem alteração |
| Capacidade MUV / seletor | Já exclusivo (M04/M07) | Sem alteração de regra |
| `frontend/pdv/js/pdv.js` `distribuirQuantidadeVendaLocal` | Espelho local de preview | **Alinhado** ao motor |

### 2.2 Chamadores do distribuidor

| Canal | Entrada | Homologado nesta sprint? |
|---|---|---|
| PDV oficial `/pdv` → `VendaPagamentoService` | `distribuirItensVendaComValorFiscalEfetivo` + seletor | Sim (testes + alinhamento local) |
| Entrega `CriarVendaEntregaService` | Mesmo motor | Impactado pelo núcleo; **não** E2E dedicado aqui |
| Faturamento / pedido → núcleo venda | Mesmo motor via `VendaApplicationService` | Impactado; **não** E2E dedicado |
| Preview fiscal PDV (local) | `distribuirQuantidadeVendaLocal` | Alinhado |
| PDV Universal | Fora de escopo | Não modificado |
| Capacidade / `selecao-empresa` | Independente; já exclusivo | Regressão verde |

### 2.3 Impacto MIDP / “preservar dinheiro”

Antes: faixa `[min,max]` vinha de extremos opostos (cruzamento F↔NF), permitindo qty maior que um bucket se o total cobrisse (ex.: 105 com 55+55).

Depois (Opção A):

- distribuição exige o bucket da operação integralmente;
- min ≡ max no pipeline → `ajustarItensParaValorFiscalEfetivo` **não** move quantidade para o outro bucket;
- cenário clássico 105/55/55 fiscal **bloqueia** (insuficiência fiscal).

Canais que dependiam do split por prioridade+total para MIDP com estoque “partido” precisam de saldo suficiente **no bucket da operação**. Documentado como canal afetado; não exige nova decisão além da Opção A já tomada.

## 3. Implementação

### 3.1 `distribuirQuantidadeVenda`

- Fiscal: se `qty > saldoFiscal` → `sucesso:false`; senão `qF=qty`, `qNF=0`.
- Não fiscal: se `qty > saldoNaoFiscal` → `sucesso:false`; senão `qF=0`, `qNF=qty`.
- Mensagens explícitas por bucket; `disponivelBucket` / `bucketExclusivo` no retorno de falha.

### 3.2 Pipeline efetivo

```text
maxRes = distribuirItemVenda(..., vendaFiscal)
minRes = maxRes   // faixa colapsa — sem extremo oposto
```

Validação ocorre **antes** de qualquer débito (distribuição sem sucesso aborta o pipeline; `debitoEstoqueVendaViaPorta` só recebe qF/qNF já válidos).

### 3.3 O que não mudou

- Schema / contratos HTTP públicos.
- Motor fiscal SEFAZ / emissão.
- Ficha técnica (total F+NF).
- Regras de capacidade MUV / seletor.
- Transações/rollback de venda (fluxo existente preservado).

## 4. Arquivos alterados

| Arquivo | Ação |
|---|---|
| `backend/services/distribuidorEstoqueVenda.js` | Bucket exclusivo + faixa MIDP colapsada |
| `frontend/pdv/js/pdv.js` | Espelho local + mensagem de bucket |
| `tests/pdv/pdv-multiempresa-08-motor-bucket-exclusivo.test.js` | **Criado** |
| `tests/pdv/pdv-multiempresa-07-compatibilidade-saldo.test.js` | Expectativas motor alinhadas a M08 |
| `tests/vendas/sprint38b-midp-preservacao-dinheiro.test.js` | Cenário 105/55/55 → bloqueio |
| `tests/vendas/sprint38c-midp-preservar-dinheiro.test.js` | Pipeline com F≥qty |
| `docs/arquitetura/PDV-MULTIEMPRESA-08-RELATORIO.md` | Este relatório |

## 5. Testes executados (sequenciais, isolados)

```text
node --test tests/pdv/pdv-multiempresa-08-motor-bucket-exclusivo.test.js
→ 11 pass / 0 fail

node --test tests/pdv/pdv-multiempresa-07-compatibilidade-saldo.test.js
→ 12 pass / 0 fail

node --test tests/vendas/sprint38b-midp-preservacao-dinheiro.test.js
→ 10 pass / 0 fail

DB_DIR=<temp> CDS_TEST_ISOLATION=1 node --test tests/vendas/sprint38c-midp-preservar-dinheiro.test.js
→ 12 pass / 0 fail

node --test tests/pdv/pdv-multiempresa-04-capacidade-por-item.test.js → 10 pass
node --test tests/pdv/pdv-sel-01-selecao-empresa.test.js             → 18 pass
node --test tests/muv/muv-cap-01-capacidade-selecao.test.js          → 10 pass
node --test tests/estoque/rc80y-controla-estoque.test.js             →  4 pass
node --test tests/vendas/rc7101-valor-fiscal-liquido.test.js         → 15 pass
node --test tests/vendas/fiscal-402-desconto-pagamento.test.js       → 30 pass
```

Cobertura M08: fiscal OK; fiscal só-NF bloqueia; NF OK; NF só-F bloqueia; qty > bucket; ambos insuficientes no exigido; falha sem parcial; faixa colapsada; 105/55/55 bloqueia; ficha preservada; seletor≡motor no caso cruzado.

Sem `CDS_ALLOW_OFFICIAL_DB`, sem SEFAZ, sem vendas reais.

## 6. Canais ainda não homologados (E2E)

1. Entrega (`CriarVendaEntregaService`) — herda motor; falta cenário dedicado pós-M08.
2. Faturamento de pedido / expedição — idem.
3. Homologação UI Electron + Network em ambiente com dados sintéticos de estoque por bucket.
4. Build/instalador de produção — **não** gerado; aguardar revisão do Tech Lead.

## 7. Encerramento

Critérios atendidos: validação e distribuição alinhadas à Opção A; testes direcionados verdes; nenhum débito incompatível nos cenários cobertos; ficha preservada; seletor/capacidade sem regressão.

**Estado: CONCLUÍDA**  
Não iniciada outra sprint. Aguardar revisão do Tech Lead antes de homologação ou build de produção.
