# Ownership NF-e de devolução de compra (Sprint 05.66)

**Status:** implementação  
**Data:** 2026-08-29  
**Origem:** risco D da 05.65

## Regra

Contexto autoriza. `compras.empresa_id` é o dono.

Por `compraId` (`preparar`, `historico`, `emitir`): `resolverEmpresaContextoCompra` + `carregarCompraAutorizadaP`.

Por `notaId`: carrega a nota, depois a compra em `nota.compra_id` com o mesmo guard. XML só depois da autorização.

Cruzado → 404 `COMPRA_NAO_ENCONTRADA` (`jsonErroCompraOpaca`). NULL → 409 `EMPRESA_OWNERSHIP_REQUIRED`.

## Não alterado

`carregarCompraCabecalho` (ainda `WHERE c.id = ?` no service fiscal). Chave global. Central. `existeCompraComChave`. Schema. Criação de compras.

## Residual

Chamadas internas ao service fiscal sem passar pela rota continuam sem guard HTTP. Próximo isolamento no service fica fora desta sprint.
