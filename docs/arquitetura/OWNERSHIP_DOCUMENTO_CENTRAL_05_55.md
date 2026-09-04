# Ownership de documento na Central de Entradas — Sprint 05.55

**Status:** implementado  
**Data:** 2026-08-29  
**Escopo:** operações por ID da Central. Sem DistDFe, NSU, MIIP, schema novo ou motor paralelo.

## Fonte de ownership

```
CONTEXTO AUTORIZA   →  X-Empresa-Id / contrato (EMPRESA_SIMPLES)
DOCUMENTO DETERMINA →  central_entradas_documentos.empresa_id
COMPRA HERDA        →  documento.empresa_id = compra.empresa_id
```

O HTTP **não** escolhe a empresa da operação depois da autorização. Não há fallback (primeira empresa, CNPJ, `empresa_operacional_id`, COMPAT, último contexto).

## Helper

Único: `exigirDocumentoDaEmpresa` em `backend/services/central-entradas/CentralEntradasEmpresaContextoService.js`.

HTTP: `autorizarDocumentoCentralHttp` + wrapper `comDocumentoAutorizado` em `backend/rotas/central-entradas.js`.

## GET `/:id` (e detalhe, XML, parse, score, histórico, saúde, homologação)

1. Resolve contexto (`resolverEmpresaParaCentral`).
2. Carrega o documento.
3. `empresa_id` NULL → `EMPRESA_DOCUMENTO_NAO_RESOLVIDA` (409).
4. Dono ≠ contexto → **404** `DOCUMENTO_NAO_ENCONTRADO`.
5. Corpo cruzado: `{ error, code }` apenas — sem `empresa_id`, CNPJ, chave, fornecedor.

EMPRESA_SIMPLES: o contexto é a empresa operacional do contrato (comportamento existente). MULTIEMPRESA: `X-Empresa-Id` obrigatório.

## Processamento `POST /:id/processar`

Ordem: contexto → documento → ownership → pipeline. Cruzado não altera status/parse.

## Revisão

`POST /:id/revisar/concluir` usa o mesmo guard. `concluirRevisao` recusa cruzado **antes** de gravar itens ou transicionar.

## Abrir compra

Após autorização, `dadosCompra.empresa_id` / `empresaId` vêm só de `documento.empresaId`.  
Documento A + contexto B = 404, nenhuma compra.

## Vínculo documento → compra

`vincularCompra` compara `documento.empresa_id` com `compras.empresa_id` persistido (não `req.empresaId`). Divergência → `OPERACAO_EMPRESA_DIVERGENTE` sem alterar o documento.

## Documento NULL

Sem descoberta de empresa. Erro `EMPRESA_DOCUMENTO_NAO_RESOLVIDA`. Sem mutação.

## Cruzado

Para o caller, o documento **não existe** naquele contexto (404).

## Listagem `GET /`

Filtro = empresa do contexto resolvido (não “todas”, não query de outra empresa). `CentralFiltroDTO` e listagem SQL passam `empresa_id`.

## Inventário de rotas por ID

| Rota | Guard |
|------|--------|
| GET `/saude/documento/:id` | sim |
| GET `/homologacao/:id/inspecionar` | sim |
| GET `/homologacao/:id/exportar` | sim |
| POST `/:id/processar` | sim |
| POST `/:id/ciclo-dfe` | sim |
| POST `/:id/solicitar-xml-completo` | sim |
| POST `/:id/chave-copiada` | sim |
| GET/POST `/:id/recuperar-portal-nacional*` | sim |
| POST `/:id/revisar/concluir` | sim |
| GET `/:id/payload-compra` | sim |
| POST `/:id/abrir-compra` | sim |
| GET `/:id/historico` \| `/xml` \| `/parse` \| `/score` \| `/:id` | sim |
| PATCH `/:id/status` | sim |
| PATCH `/notificacoes/:id/lida` | **não** (não é documento) |
