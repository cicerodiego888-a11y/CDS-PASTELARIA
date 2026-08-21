# Implementação 02.3 — Crédito de Compra → Porta Pública

**Status:** concluída · **Data:** 2026-08-12  
**Projeto:** Pastelaria · Fase 1 Fundação Multiempresa

---

## Fluxo anterior

```
POST /compras (concluída)
  → BEGIN
  → INSERT compras
  → processarItensCompra
       → INSERT compras_itens
       → UPDATE produtos SET
            saldo_fiscal += qtdFiscal,
            saldo_nao_fiscal += qtdNaoFiscal,
            estoque_atual = ...,
            preco_compra, preco_venda, ncm, ...
  → financeiro
  → COMMIT
```

Mutador: `backend/rotas/compras.js` → `processarItensCompra` / `continuarItem`  
SQL de saldo misturado com atualização de cadastro/preço no mesmo `UPDATE`.

Cancelamento e devolução de compra **não** foram migrados (ainda debitam com `UPDATE` direto — Sprint 02.4).

---

## Novo fluxo

```
POST /compras (concluída)
  → BEGIN  (mesmo db)
  → INSERT compras / itens
  → creditarEstoqueItemCompra
        → estoqueSaldosPublico.creditarSaldo (FISCAL e/ou NAO_FISCAL)
  → UPDATE produtos  (somente metadados: preço, NCM, etc. — SEM saldos)
  → financeiro
  → COMMIT
```

Storage permanece em `produtos`. Sem `estoque_empresa`.

---

## Classificação Fiscal / Não Fiscal

Preservada exatamente como antes:

1. MUC (`resultadoMuc.quantidadeFiscal` / `quantidadeNaoFiscal`)
2. Tratamento fiscal (`resolverTratamentoFiscalItem` → `gerarEstoque`)
3. Se `!gerarEstoque` → quantidades zeradas → porta **não** credita

Não altera `resolverQuantidadesCompraItemPersistido`, MIIP, item_fiscal nem distribuição F/NF.

---

## empresaId

| Fonte | Uso |
|---|---|
| `opcoes.empresaId` / body / `req.user` na criação da compra | Preferencial |
| Ausência (ERP atual) | `COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA` |
| `exigirEmpresa: true` | `EMPRESA_OBRIGATORIA` |

**Não** usa empresa 1, CNPJ de `configuracoes` nem fallback silencioso.

### CNPJ destinatário (futuro)

A compra/NF-e hoje persiste fornecedor (`fornecedor_cnpj`) e dados da nota; **não** há tabela `empresas` nem `empresa_id` na compra.

Futuro (quando existir cadastro multiempresa):

```
CNPJ destinatário da NF-e
  → lookup empresas.cnpj
  → empresaId
  → estoqueSaldosPublico (já preparado)
```

**Não** implementado nesta Sprint.

---

## Transação

`BEGIN IMMEDIATE` da rota de criação permanece.  
Crédito usa o mesmo `db` — rollback externo desfaz o crédito (testado).

---

## Sem crédito duplicado

Um único caminho: `creditarEstoqueItemCompra` em `processarItensCompra`.  
O `UPDATE` de metadados **não** toca `saldo_*` / `estoque_atual`.

---

## Métodos

| Método | Papel |
|---|---|
| `creditarEstoqueItemCompra` | Crédito F/NF via porta |
| `montarOptsPortaCreditoCompra` | empresa / COMPAT |
| `processarItensCompra` | Chama porta + UPDATE só de cadastro |

---

## Testes

`tests/estoque/credito-compra-porta-publica.test.js` (01–10 + zero).

---

## Limitações

1. Sem isolamento físico por CNPJ.
2. COMPAT necessário até JWT/empresas.
3. Cancelamento/devolução de compra ainda com SQL direto de saldo.
4. Entrada simplificada continua sem processar itens/estoque (igual ao legado).

---

## Próxima etapa

**02.4** — Cancelamento / Devolução de Compra → débito via porta.
