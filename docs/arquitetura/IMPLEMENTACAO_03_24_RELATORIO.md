# Relatório — Implementação 03.24
## PDV — disponibilidade de estoque por empresa

**Data:** 2026-08-21 · **Status:** concluída

---

## Ponto real encontrado

`VendaPagamentoService.preCalcularDistribuicao` e `VendaPagamentoService.criarVenda`.

SELECT em `produtos` → (agora overlay) → `calcularEstoqueProduto` / `saldosParaDistribuicaoVenda` → Motor F×NF.

UX do PDV (`validarEstoqueVenda`) continua no produto já isolado pela 03.23.

---

## Arquivos / métodos

| Arquivo | Método |
|---|---|
| `leituraEstoqueEmpresaProduto.js` | `aplicarSaldosDisponibilidadeVenda` |
| `VendaPagamentoService.js` | overlay com `req.empresaId` após o SELECT |
| `frontend/pdv/js/pdv.js` | `X-Empresa-Id` no pré-cálculo e no POST `/vendas` |

Não alterados: `debitoEstoqueVendaViaPorta`, `estoqueSaldosPublico`, identificação 03.23.

---

## Saldos

SF, SNF, EA, RF, RNF. Disponibilidade = saldo − reservado (regra já existente). Separação F/NF preservada.

---

## Com / sem empresa / sem registro

Sem empresa: legado `produtos`.  
Com empresa: `estoque_empresa`.  
Sem registro: zeros → indisponível. **Sem fallback** para `produtos`.

---

## Escrita

Nenhuma escrita nesta validação. Baixa física 02.6 intacta.

---

## Testes

`pdv-disponibilidade-estoque-empresa.test.js`: 12/12 OK.

---

## Regressão

| Suite | Resultado |
|---|---|
| `pdv-disponibilidade-estoque-empresa.test.js` | 12/12 OK |
| `dual-write-porta-publica-empresa-03-19.test.js` | 15/15 OK |
| `reservas-dual-write-empresa.test.js` (03.20) | 12/12 OK |
| `leitura-operacional-empresa.test.js` (03.21) | 10/10 OK |
| `listagem-produtos-empresa.test.js` (03.22) | 15/15 OK |
| `pdv-identificacao-estoque-empresa.test.js` (03.23) | 10/10 OK |
| `debito-baixa-venda-porta-publica.test.js` (02.6) | 12/12 OK |
| `reservas-pdv-porta-publica.test.js` (02.7) | 11/11 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

---

Não iniciar 03.25.
