# Ownership da chave NF-e da compra — Sprint 05.58

**Status:** implementado  
**Data:** 2026-08-29  
**Escopo:** somente `PUT /api/compras/:id/chave-nfe-fornecedor`. GET detalhe, cancelar e devolver **não** mudam (continuam 403 cruzado).

## Risco 05.57

A rota localizava a compra só por `id` e fazia `UPDATE compras SET chave_acesso` sem conferir `compras.empresa_id`. Empresa B alterava a chave da compra A.

## Contrato anterior

```
PUT /:id/chave-nfe-fornecedor
  → valida 44 dígitos
  → UPDATE WHERE id = ?
```

## Contrato novo

```
CONTEXTO AUTORIZA          → resolverEmpresaContextoCompra
COMPRA.empresa_id DETERMINA → exigirCompraDaEmpresa (via wrapper opaco)
UPDATE da chave            → WHERE id = ? AND empresa_id = ?
```

Body (`chave`, `empresa_id`, `empresaId`) **não** é dono. A coluna persistida `compras.empresa_id` é a única fonte. Compra da Central e compra manual usam a mesma coluna — não se aplica `documento.empresa_id` neste PUT.

## Cruzado

`req.empresaId != compra.empresa_id` → **404** `COMPRA_NAO_ENCONTRADA`. Mensagem genérica. Sem `empresa_id` da compra, CNPJ, fornecedor ou chave atual. Nenhuma mutação.

## NULL

`compra.empresa_id IS NULL` → **409** `EMPRESA_OWNERSHIP_REQUIRED` antes do UPDATE. Sem fallback (contexto, EMPRESA_SIMPLES, documento, COMPAT).

## Inexistente

**404** `COMPRA_AUSENTE` — mesma mensagem de domínio: `Compra não encontrada.`

## Helper

`exigirCompraDaEmpresa` permanece 403 no GET/cancelar/devolver.

`exigirCompraParaMutacaoOpaca` reutiliza esse helper e só remapeia códigos para mutação opaca.

`atualizarChaveNfeFornecedorCompra` executa load → ownership → validação da chave → UPDATE reforçado por `empresa_id`.
