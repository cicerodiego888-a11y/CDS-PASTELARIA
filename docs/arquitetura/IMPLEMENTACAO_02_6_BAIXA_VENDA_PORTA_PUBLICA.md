# Implementação 02.6 — Baixa Normal de Venda → Porta Pública

**Status:** concluída · **Data:** 2026-08-14  
**Projeto:** Pastelaria · Fase 1 Fundação Multiempresa

---

## Fluxo anterior

```
criarVenda (prazo | à vista)
  → BEGIN IMMEDIATE
  → distribuição (distribuidorEstoqueVenda) — intacta
  → INSERT vendas_itens (quantidade_fiscal / quantidade_nao_fiscal)
  → reduzirEstoqueDistribuido
       → reduzirEstoqueComFEFO (lotes, se validade)
       → atualizarSaldoProdutoAposBaixa
            UPDATE produtos SET
              saldo_fiscal -=  (se itemFiscal=1)
              saldo_nao_fiscal -=  (senão)
              estoque_atual = SF + SNF
  → financeiro / TEF
COMMIT
```

---

## Mutador encontrado

| Ponto | Papel | Ação 02.6 |
|---|---|---|
| `atualizarSaldoProdutoAposBaixa` | Único UPDATE de saldo F/NF na baixa | Migrado para a porta |
| `reduzirEstoqueComFEFO` | Lotes + chama o mutador | Propaga `opcoes` |
| `reduzirEstoqueDistribuido` | Loop F depois NF com qtds já distribuídas | Propaga `opcoes` + mesmo `db` |
| `criarVenda` (prazo e à vista) | HTTP da venda | Passa `empresaId` + `db` |
| SELECT `saldo_fiscal` / `saldo_nao_fiscal` | Leitura para distribuição | **Mantido** |
| `EstoqueConsumoReserva` UPDATE `reservado_*` | Reserva (não saldo) | **Não migrado** |
| Cancelamento / devolução (02.5) | Crédito | **Não alterado** |

Classificação preservada: `item.quantidade_fiscal` / `item.quantidade_nao_fiscal` produzidos por `distribuidorEstoqueVenda`. A baixa não recalcula.

---

## Fluxo novo

```
Venda
  ↓
Distribuição Fiscal / Não Fiscal  (intacta)
  ↓
quantidade_fiscal / quantidade_nao_fiscal
  ↓
reduzirEstoqueDistribuido
  ↓
atualizarSaldoProdutoAposBaixa
  ↓
debitarEstoqueItemVenda
  ↓
estoqueSaldosPublico.debitarSaldo (FISCAL / NAO_FISCAL)
  ↓
produtos  (storage transitório)
```

`estoque_atual` mantido pela porta (`SF + SNF`).

---

## empresaId

| Fonte | Uso |
|---|---|
| `req.body.empresa_id` / `empresaId` | Preferencial |
| `req.user` | Em seguida |
| `req` | Contexto já existente |
| Ausência | `COMPAT_DEBITO_VENDA_PRE_MULTIEMPRESA` |
| `exigirEmpresa: true` | `EMPRESA_OBRIGATORIA` |

Sem fallback silencioso / empresa 1 / CNPJ inventado.

`EstoqueConsumoReserva` continua chamando `reduzirEstoqueDistribuido` sem empresa (arquivo de reserva **não** foi editado) → COMPAT no adaptador.

---

## Compatibilidade

`MOTIVO_COMPAT_DEBITO_VENDA = 'COMPAT_DEBITO_VENDA_PRE_MULTIEMPRESA'`

Constante nova (crédito 02.5 é outro fluxo). Extração de `empresaId` reutiliza `extrairEmpresaIdDeReq`.

---

## Transação

`BEGIN IMMEDIATE` de `criarVenda` preservado. Débito usa o mesmo `db`. Rollback externo reverte o débito (testado). Sem transação paralela.

---

## Sem débito duplicado

Exatamente **uma** chamada a `debitarEstoqueItemVenda` (`atualizarSaldoProdutoAposBaixa`).  
Dois callers de `reduzirEstoqueDistribuido` (prazo + à vista), ambos com as quantidades já distribuídas.

Nenhum `UPDATE ... saldo_*` na seção de baixa.

---

## Testes

`tests/estoque/debito-baixa-venda-porta-publica.test.js` — 01–12.

---

## Limitações

1. Storage ainda em `produtos`.
2. COMPAT até JWT/empresas.
3. Reservas (`reservado_*`) permanecem com SQL direto — próxima etapa.
4. `debitarSaldo` recusa saldo negativo (a porta); a distribuição já valida antes da baixa.
5. Financeiro / TEF / FEFO de lotes inalterados.

---

## Próxima etapa

**Reservas PDV** → porta pública, antes de `estoque_empresa`.

Não implementada nesta Sprint.
