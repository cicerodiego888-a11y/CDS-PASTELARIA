# Relatório — Implementação 03.16
## Leitura controlada de estoque_empresa

**Data:** 2026-08-21 · **Status:** concluída

---

## Auditoria

Métodos 03.12–03.15 confirmados. Porta pública continua `FROM produtos`. Nenhum endpoint operacional escolhido.

---

## Implementação

`consultarSaldoParaEmpresa` em `EstoqueEmpresaService.js`. Camada técnica isolada.

`null` = não existe estoque isolado para a empresa. Sem fallback.

---

## Arquivos

- `backend/services/estoque/EstoqueEmpresaService.js` — método novo
- `tests/estoque/leitura-controlada-estoque-empresa.test.js`
- docs 03.16

Não alterados: porta, dual-write, backfill, CREATE, PDV, motores.

---

## Testes

01–08.

---

## Regressão

| Suite | Resultado |
|---|---|
| `leitura-controlada-estoque-empresa.test.js` | 8/8 OK |
| `leitura-estoque-empresa-03-15.test.js` | 10/10 OK |
| `backfill-estoque-empresa-03-14.test.js` | 12/12 OK |
| `dual-write-estoque-empresa-03-13.test.js` | 10/10 OK |
| `estoque-empresa-service-03-12.test.js` | 8/8 OK |
| `estoque-empresa-schema.test.js` | 8/8 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `create-produto-saldo-inicial-porta-publica.test.js` | 10/10 OK |
| `reserva-repair-porta-publica.test.js` | 10/10 OK |
| `consumo-reserva-pedido-porta-publica.test.js` | 10/10 OK |
| `revert-devolucao-venda-porta-publica.test.js` | 10/10 OK |
| `muc-public-contract.test.js` | 20/20 OK |

---

## Limitações

Leitura não usada operacionalmente. `produtos` segue oficial.

Não iniciar 03.17 nesta entrega.
