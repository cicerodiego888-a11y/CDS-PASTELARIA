# Ownership documento → compra — Sprint 05.56

**Status:** implementado  
**Data:** 2026-08-29  
**Escopo:** fluxo Central `documento` → abrir/criar compra → vínculo. Sem DistDFe, NSU, MIIP, estoque, financeiro, NF-e 55, PDV ou motor novo.

## Fonte de ownership

```
CONTEXTO AUTORIZA   →  X-Empresa-Id / contrato (só acesso ao documento)
DOCUMENTO DETERMINA →  central_entradas_documentos.empresa_id
COMPRA HERDA        →  compras.empresa_id = documento.empresa_id
```

Depois do guard 05.55:

```
empresaDocumentoId = documento.empresa_id
```

É a única fonte de ownership da compra. Não são donos: `req.empresaId`, `body.empresaId`, `query.empresaId`, `empresa_operacional_id`, usuário, primeira/última empresa, COMPAT.

## Autorização

O contexto HTTP decide se o caller **vê** o documento. Cruzado → `404 DOCUMENTO_NAO_ENCONTRADO` (sem `empresa_id`, CNPJ, chave, fornecedor da outra empresa).

## Payload (`obterPayloadCompra` / `montarPayloadAbrirCompra`)

`empresaId`, `dadosCompra.empresa_id` e `dadosCompra.empresaId` vêm só de `exigirEmpresaIdDoDocumento`.  
`opcoes.empresaId` / body **não** substituem ownership. `empresaIdContexto` / `req` só autorizam.

## Criação da compra

Ordem:

1. Resolver contexto (`resolverEmpresaParaCentral`).
2. Carregar documento.
3. `exigirDocumentoDaEmpresa`.
4. `exigirEmpresaIdDoDocumento`.
5. Se já houver `compra_id`, validar `documento.empresa_id === compra.empresa_id`.
6. `resolverEmpresaDaCompra` com `centralDocumentoId` devolve `origem: DOCUMENTO_CENTRAL`.
7. INSERT em `compras` com essa empresa.
8. `vincularCompra` (autorização + igualdade documento × compra).

A resolução de empresa acontece **antes** do `BEGIN` da gravação (`iniciarGravacaoComEmpresa`).

## Vínculo

Antes de mutar: documento autorizado, `documento.empresa_id` resolvido, `compras.empresa_id` persistido, `exigirDocumentoCompraMesmaEmpresa`.  
Documento já ligado a **outro** `compra_id` → `OPERACAO_EMPRESA_DIVERGENTE`, sem UPDATE.

`vincularDocumentoCentralAposCompra` passa `empresaIdContexto` (autorização), não usa o ID HTTP como dono da compra.

## Compra já existente no documento

Compara empresas persistidas. Divergência → `OPERACAO_EMPRESA_DIVERGENTE`. Sem correção automática, sem trocar empresa de documento ou compra.

## Documento `empresa_id` NULL

`EMPRESA_DOCUMENTO_NAO_RESOLVIDA` (409). Sem descoberta, sem contexto como dono, sem COMPAT. Nenhuma compra.

## Cruzado

Documento A (empresa 11) + caller 22 → 404. Nenhuma compra, nenhum vínculo, nenhum dado da empresa 11.

## Frontend (tela Compras)

Com `central_documento_id`, o body só envia `empresa_id` se veio do payload da Central (`centralEmpresaIdAtual`). Não cai no contexto operacional do ERP como dono.
