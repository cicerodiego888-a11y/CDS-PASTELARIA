# SPRINT 05.66

## OBJETIVO

Guard opaco nas rotas de NF-e de devolução de compra.

## ALTERAÇÃO

| Arquivo | Papel |
|---------|--------|
| `backend/rotas/compras.js` | `autorizarCompraParaNfeDevolucao` / `autorizarNotaNfeDevolucaoCompra` em todas as rotas `nfe-devolucao` e `emitir-nfe-devolucao` |
| `backend/services/compras/ComprasEmpresaContextoService.js` | `carregarCompraAutorizadaP` |
| `tests/auditoria/ownership-modulo-compras-05-65.test.js` | T07 alinhado ao guard |

## TESTES

`tests/compras/ownership-nfe-devolucao-compra-05-66.test.js` T01–T08 **8/8**.

05.65 10/10 · 05.59 10/10.

## NÃO ALTERADO

Criação, Central, chave global, `nfeDevolucaoCompra.carregarCompraCabecalho`, estoque, financeiro.

## PRODUÇÃO

SIM — somente rotas de NF-e de devolução de compra (+ promisify do load autorizado).

OUTROS DOMÍNIOS: NÃO.
