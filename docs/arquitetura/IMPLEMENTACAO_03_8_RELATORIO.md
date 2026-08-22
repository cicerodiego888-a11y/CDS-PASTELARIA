# Relatório — Implementação 03.8
## CREATE produto / saldos iniciais → Porta Pública

**Data:** 2026-08-21 · **Status:** concluída (critérios da Sprint)

---

## 1. Mutador encontrado

`backend/rotas/produtos.js` — `POST /` (CREATE principal).

Helper: `aplicarSaldoInicialCreateProduto` em `ajusteEstoqueService.js` → `estoqueSaldosPublico`.

Outros CREATE (compras zerado; importação já 02.1) **não** migrados.

---

## 2. Fluxo anterior

INSERT direto de `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_atual`.

Legado: `estoque_atual` sem F/NF → todo fiscal.

---

## 3. Fluxo novo

INSERT com SF/SNF/`estoque_atual` = 0.  
Se quantidade inicial > 0 → `creditarSaldo` FISCAL e/ou NAO_FISCAL.  
Zero não chama a porta.

---

## 4. empresaId / COMPAT

`COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA` quando o POST não envia empresa.

Sem empresa 1 / CNPJ.

---

## 5. Transação

Mesmo `db`. Sem BEGIN próprio. Rollback testado.

---

## 6. Testes executados

`node tests/estoque/create-produto-saldo-inicial-porta-publica.test.js`

| # | Cenário |
|---|---|
| 01 | Sem saldo inicial (porta não grava zero) |
| 02 | Saldo fiscal inicial |
| 03 | Saldo não fiscal inicial |
| 04 | `estoque_atual = SF + SNF` |
| 05 | empresaId propagado |
| 06 | COMPAT explícita |
| 07 | Rollback com mesmo db |
| 08 | Sem escrita operacional direta após CREATE |
| 09 | Legado `estoque_atual` → fiscal |
| 10 | Motores / fluxos anteriores intactos |

### Regressão

| Suite | Resultado |
|---|---|
| `create-produto-saldo-inicial-porta-publica.test.js` | **10/10 OK** |
| `revert-devolucao-venda-porta-publica.test.js` | **10/10 OK** |
| `consumo-reserva-pedido-porta-publica.test.js` | **10/10 OK** |
| `reserva-repair-porta-publica.test.js` | **10/10 OK** |
| `reservas-pdv-porta-publica.test.js` | **11/11 OK** |
| `debito-baixa-venda-porta-publica.test.js` | **12/12 OK** |
| `mts-v1.test.js` | **9/9 OK** (homologado) |
| `muc-public-contract.test.js` | **20/20 OK** |

---

## 7. Arquivos alterados

- `backend/rotas/produtos.js` — INSERT zerado + crédito via helper
- `backend/services/ajusteEstoqueService.js` — `aplicarSaldoInicialCreateProduto` + COMPAT CREATE

**Criados**

- `tests/estoque/create-produto-saldo-inicial-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_03_8_CREATE_PRODUTO_SALDO_INICIAL.md`
- `docs/arquitetura/IMPLEMENTACAO_03_8_RELATORIO.md` (este)

Não alterados: vendas, compras, reservas, lotes, motores, 02.6, 02.7, 03.6, 03.7, NF-e, JWT, `estoque_empresa`.

---

## 8. Limitações

- Sem isolamento físico.
- COMPAT até o POST enviar empresa.
- Distribuição legada: `estoque_atual` → 100% fiscal.

---

## 9. Próximo escritor ainda pendente

**Lotes.** Sprint parada aqui.
