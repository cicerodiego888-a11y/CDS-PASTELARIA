# SPRINT 05.59

## OBJETIVO

GET, cancelar e devolver: cruzado → 404 `COMPRA_NAO_ENCONTRADA`, sem vazamento de existência.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/compras/ComprasEmpresaContextoService.js` | wrapper opaco + `carregarCompraAutorizada` / `jsonErroCompraOpaca` |
| `backend/rotas/compras.js` | GET / cancelar / devolver |
| `tests/auditoria/ownership-compras-sem-central-05-57.test.js` | GET/cancelar usam wrapper 404 |

## ARQUIVOS CRIADOS

| Arquivo | Papel |
|---------|--------|
| `tests/compras/ownership-leitura-mutacao-05-59.test.js` | T01–T10 |
| `docs/arquitetura/OWNERSHIP_LEITURA_MUTACAO_COMPRA_05_59.md` | contrato |
| este relatório | |

## TESTES 05.59

T01–T10 **10/10 OK**.

## REGRESSÕES (2026-08-29)

| Suite | Resultado |
|-------|-----------|
| ownership-leitura-mutacao-05-59 | 10/10 |
| ownership-chave-nfe-05-58 | 10/10 |
| ownership-compras-sem-central-05-57 | 10/10 |
| ownership-documento-compra-05-56 | 10/10 |
| ownership-documento-05-55 | 16/16 |
| modo-multiempresa-05-54 | 12/12 |
| central-entradas-multiempresa-05-38-e | 19/19 |
| compras-multiempresa-05-38-f-b | 16/16 |
| ownership-pedido-reserva-05-49 | 10 testes OK |
| consumo-reserva-pedido-sem-compat-05-50 | 10/10 |
| credito-liberacao-reserva-empresa-05-51 | 10/10 |
| criacao-reserva-pdv-sem-compat-05-52 | 10/10 |
| consumo-fisico-reserva-pdv-sem-compat-05-53 | 10/10 |

Nenhuma falha mascarada.

## NÃO ALTERADO

`POST /api/compras`, Central, estoque, financeiro, fiscal, PUT chave-nfe (05.58).

## RISCOS RESTANTES

Listagem `GET /` já filtra `WHERE empresa_id`; legado NULL continua invisível na lista. Relatórios de uso/consumo não foram reauditados nesta sprint.
