# Relatório — Implementação 03.19
## Contexto operacional e dual-write centralizado

**Data:** 2026-08-21 · **Status:** concluída

---

## Auditoria

`estoqueSaldosPublico` é a porta de ajuste, crédito/débito compra, crédito/débito venda e revert NF-e.  
`req.empresaId` não era anexado de forma confiável em produtos/compras/vendas.  
empresaId vinha de body/user, e body podia prevalecer sobre contexto.

---

## O que foi feito

1. Middleware opcional nas três rotas operacionais.
2. `empresaIdDoReqOperacional` — contexto validado prevalece.
3. Dual-write centralizado na porta via `aplicarEfeitoSaldo`.
4. CREATE 03.13 deixou de reaplicar o delta (a porta já espelha).

---

## Sem empresaId

COMPAT existente. Só `produtos`. Não cria `estoque_empresa`.

---

## Criação do registro

Zerado + delta da operação. Não copia saldo legado.

---

## Leitura oficial

Porta continua lendo `produtos`.

---

## Arquivos

| Arquivo | Ação |
|---|---|
| `estoqueSaldosPublico.js` | dual-write |
| `empresaContexto.js` | `empresaIdDoReqOperacional` |
| `produtos.js` / `compras.js` / `vendas.js` | middleware opcional + propagação |
| `creditoEstoqueVendaViaPorta.js` | extrairEmpresaIdDeReq usa contexto validado |
| `ajusteEstoqueService.js` | 03.13 não duplica delta |
| teste + docs 03.19 | criados |

Não alterados: PDV, reservas, Repair, motores, schema, backfill, porta de leitura.

---

Sem tabela `empresas` (harness pré-cadastro / MTS): a porta não tenta o espelho e segue só em `produtos`.

---

## Testes

01–15 em `dual-write-porta-publica-empresa-03-19.test.js`.

---

## Regressão

| Suite | Resultado |
|---|---|
| `dual-write-porta-publica-empresa-03-19.test.js` | 15/15 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `ajuste-estoque-porta-publica.test.js` (02.1) | 15/15 OK |
| `credito-compra-porta-publica.test.js` (02.3) | 11/11 OK |
| `debito-cancel-dev-compra-porta-publica.test.js` (02.4) | 12/12 OK |
| `credito-cancel-dev-venda-porta-publica.test.js` (02.5) | 12/12 OK |
| `debito-baixa-venda-porta-publica.test.js` (02.6) | 12/12 OK |
| `consulta-administrativa-estoque-empresa.test.js` (03.18) | 8/8 OK |
| `backfill-estoque-empresa-03-14.test.js` | 12/12 OK |
| `dual-write-estoque-empresa-03-13.test.js` | 10/10 OK |
| `reserva-repair-porta-publica.test.js` (03.7) | 10/10 OK |
| `consumo-reserva-pedido-porta-publica.test.js` (03.6) | 10/10 OK |
| `revert-devolucao-venda-porta-publica.test.js` (03.5) | 10/10 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

---

Não iniciar 03.20.
