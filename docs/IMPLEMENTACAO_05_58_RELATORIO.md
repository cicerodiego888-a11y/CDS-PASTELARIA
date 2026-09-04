# SPRINT 05.58

## OBJETIVO

Blindar `PUT /api/compras/:id/chave-nfe-fornecedor`: contexto autoriza, `compras.empresa_id` determina, depois UPDATE da chave.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/compras/ComprasEmpresaContextoService.js` | wrapper opaco + `atualizarChaveNfeFornecedorCompra` |
| `backend/rotas/compras.js` | rota PUT usa contexto → helper (não UPDATE cru) |
| `tests/auditoria/ownership-compras-sem-central-05-57.test.js` | T08/T10: risco D do PUT encerrado (não mascaramento de falha de produto) |

## ARQUIVOS CRIADOS

| Arquivo | Papel |
|---------|--------|
| `tests/compras/ownership-chave-nfe-05-58.test.js` | T01–T10 |
| `docs/arquitetura/OWNERSHIP_CHAVE_NFE_COMPRA_05_58.md` | contrato |
| este relatório | |

## TESTES 05.58

T01–T10 **10/10 OK**.

## REGRESSÕES (2026-08-29)

| Suite | Resultado |
|-------|-----------|
| ownership-chave-nfe-05-58 | 10/10 |
| ownership-compras-sem-central-05-57 | 10/10 (T08/T10 alinhados ao PUT protegido) |
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

Nenhuma falha mascarada. `compras-multiempresa-contexto` T10 (grep) continua pré-existente e **não** esteve nesta lista obrigatória.

## NÃO ALTERADO

Criação de compras, Central, documentos, estoque, financeiro, fiscal, NF-e 55, NFC-e, GET `/:id`, cancelar, devolver.

## RISCOS RESTANTES

GET/cancelar/devolver ainda 403 cruzado (fora desta sprint).
