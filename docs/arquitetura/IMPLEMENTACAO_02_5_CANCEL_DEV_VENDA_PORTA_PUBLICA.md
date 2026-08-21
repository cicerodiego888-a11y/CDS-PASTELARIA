# Implementação 02.5 — Cancelamento / Devolução de Venda → Porta Pública

**Status:** concluída · **Data:** 2026-08-14  
**Projeto:** Pastelaria · Fase 1 Fundação Multiempresa

---

## Fluxo anterior

### Cancelamento (`PUT /vendas/:id` e `POST /vendas/cancelar/:id`)

```
BEGIN
  → itens da venda
  → resolverQuantidadesVendaItem
  → desconta devoluções já feitas
  → devolverSaldosDistribuidos
       UPDATE produtos SET
         saldo_fiscal +=,
         saldo_nao_fiscal +=,
         estoque_atual = (SF+) + (SNF+)
  → cancela recebimentos / venda / financeiro
COMMIT
```

### Devolução parcial (`devolverParcial`)

```
BEGIN
  → INSERT vendas_devolucoes
  → calcularDevolucaoVendaFiscalPrimeiro
  → devolverEstoqueParcialItem
       → devolverSaldosDistribuidos
            UPDATE produtos SET saldo_fiscal / saldo_nao_fiscal / estoque_atual
  → financeiro
COMMIT
```

Mutador único de saldo: `devolverSaldosDistribuidos` em `VendaDevolucaoService.js`.

---

## Mutadores encontrados

| Ponto | Papel | Ação 02.5 |
|---|---|---|
| `devolverSaldosDistribuidos` | Único UPDATE de saldo F/NF no retorno | Migrado para a porta |
| `devolverEstoqueItemVenda` | Cancelamento (quantidades da venda − já devolvido) | Propaga `opcoes` |
| `devolverEstoqueItensVenda` | Loop do cancelamento | Propaga `opcoes` |
| `devolverEstoqueParcialItem` | Devolução parcial | Propaga `opcoes` |
| `cancelarVendaPut` / `cancelarVendaPost` | HTTP cancelamento | Passa `empresaId` + `db` |
| `devolverParcial` | HTTP devolução | Passa `empresaId` + `db` |
| `VendaPagamentoService.atualizarSaldoProdutoAposBaixa` | Baixa normal da venda | **Não migrado** (02.6) |
| `estoqueNfeDevolucaoVenda.reverterEstoqueNfeDevolucaoVenda` | Motor Fiscal (débito ao cancelar NF-e de devolução) | **Não migrado** |

Classificação preservada:

- Cancelamento: `resolverQuantidadesVendaItem` (`quantidade_fiscal` / `quantidade_nao_fiscal` persistidas)
- Devolução: `calcularDevolucaoVendaFiscalPrimeiro` (fiscal primeiro, sem nova regra)

---

## Fluxo novo

```
Cancelamento / Devolução
        ↓
quantidades F/NF da venda (já persistidas)
        ↓
devolverSaldosDistribuidos
        ↓
creditarEstoqueItemVenda
        ↓
estoqueSaldosPublico.creditarSaldo (FISCAL / NAO_FISCAL)
        ↓
produtos  (storage transitório)
```

- `estoque_atual` mantido pela porta (`SF + SNF`)
- Sem `UPDATE` de saldo nos dois fluxos migrados
- Lotes (`produtos_lotes`) inalterados

---

## empresaId

| Fonte | Uso |
|---|---|
| `req.body.empresa_id` / `empresaId` | Preferencial |
| `req.user.empresa_id` / `empresaId` | Em seguida |
| `req.empresaId` | Contexto já existente |
| Ausência | `COMPAT_CREDITO_VENDA_CANCEL_DEV_PRE_MULTIEMPRESA` |
| `exigirEmpresa: true` | `EMPRESA_OBRIGATORIA` |

Sem fallback silencioso / empresa 1 / CNPJ inventado.

O caller fiscal `retornarEstoqueNfeDevolucaoVenda` continua chamando `devolverSaldosDistribuidos` sem `empresaId` (arquivo do Motor Fiscal **não** foi alterado) → COMPAT explícita no adaptador.

---

## Compatibilidade

`MOTIVO_COMPAT_CREDITO_VENDA = 'COMPAT_CREDITO_VENDA_CANCEL_DEV_PRE_MULTIEMPRESA'`

Usada em cancelamento e devolução quando o ERP ainda não envia empresa no JWT.

---

## Transação

`BEGIN IMMEDIATE` dos serviços preservado. O crédito usa o mesmo `db` injetado. Rollback externo reverte o crédito (testado).

```
BEGIN
  cancelamento/devolução
  retorno estoque (porta)
  erro
ROLLBACK
→ saldo anterior
```

---

## Sem retorno duplicado

Exatamente **uma** chamada a `creditarEstoqueItemVenda` em `VendaDevolucaoService.js` (`devolverSaldosDistribuidos`).

Cancelamento PUT e POST usam o mesmo `devolverEstoqueItensVenda`.

Nenhum `UPDATE ... saldo_*` nesses fluxos.

---

## Testes

`tests/estoque/credito-cancel-dev-venda-porta-publica.test.js` — 01–12.

---

## Limitações

1. Storage ainda em `produtos`.
2. COMPAT necessário até JWT/empresas.
3. **Baixa normal da venda** permanece com SQL direto (`VendaPagamentoService`) — 02.6.
4. `reverterEstoqueNfeDevolucaoVenda` (Motor Fiscal) permanece com `UPDATE produtos` — fora do escopo.
5. Financeiro de cancel/devolução permanece como estava.

---

## Próxima etapa

**02.6** — Baixa normal de venda → `estoqueSaldosPublico` + `empresaId`.

Não implementada nesta Sprint.
