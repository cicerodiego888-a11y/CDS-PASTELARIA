# Isolamento do GET /buscar-chave da Central (Sprint 05.72)

**Status:** implementação  
**Data:** 2026-08-29

## 1. Comportamento anterior

`GET /central-entradas/buscar-chave?chave=` normalizava a chave (`replace(/\D/g, '')`, 44 dígitos) e chamava `centralEntradasService.buscarPorChave(chave)` sem empresa.

No serviço de sincronização, `obterContextoOperacional()` era chamado **sem** `empresaId`. O lookup documental só ocorria se `contexto.empresaId` viesse preenchido (em geral não vinha no HTTP). Resultado típico: payload SEFAZ + `documento: null`, sem vazar XML de outra empresa, mas também sem anexar o documento da empresa autorizada.

## 2. Lookup encontrado

Cadeia HTTP:

1. `backend/rotas/central-entradas.js` — `GET /buscar-chave`
2. `CentralEntradasService.buscarPorChave`
3. `CentralEntradasOrchestrator.buscarPorChave`
4. `CentralSincronizacaoService.buscarPorChave`
5. `CentralDocumentosRepository.buscarPorChave` (já 05.70: `WHERE chave = ? AND empresa_id = ?`)

Chamadores desta cadeia HTTP: rota, fachada, orquestrador, sync. Persistência DistDFe (05.70) **não** foi alterada. Frontend: `centralEntradasFetch` (chamador direto do endpoint) passou a enviar `X-Empresa-Id` quando há contexto de sessão.

## 3. Empresa exigida

O endpoint resolve empresa **antes** de qualquer `buscarPorChave` documental e **antes** de `consultarNotaPorChave`.

Sem empresa válida no serviço: `EMPRESA_CENTRAL_AUSENTE` — não executa `buscarPorChave(chave)` nem SQL `WHERE chave = ?` isolado.

## 4. Fonte da empresa

`resolverEmpresaParaCentral({ req, empresaId: req.empresaId })` — mesmo contrato da listagem `GET /`.

- MULTIEMPRESA: `X-Empresa-Id` / `req.empresaId` / `resolverEmpresaIdDaRequisicao` (header, body, query). Sem valor: `EMPRESA_CENTRAL_AUSENTE`.
- EMPRESA_SIMPLES: `contrato.empresa_operacional.empresa_id` (`origem: CONTRATO_EMPRESA_SIMPLES`).

Não usa primeira/última empresa, empresa 1, `empresa_operacional_id` como substituto em MULTIEMPRESA, usuário nem COMPAT.

## 5. Consulta nova

Após o contexto:

```text
buscarPorChave(chave, empresaId)  →  WHERE chave = ? AND empresa_id = ?
```

`obterContextoOperacional({ empresaId, permitirFallbackGlobal })` apenas para certificado/SEFAZ daquela empresa (`permitirFallbackGlobal` só em EMPRESA_SIMPLES, alinhado à sync 05.54). O documento **não** é escolhido pelo certificado global.

## 6. MULTIEMPRESA

`X-Empresa-Id` obrigatório. Sem header/contexto: erro de contexto; nenhum SELECT por chave; nenhuma consulta SEFAZ neste endpoint.

## 7. EMPRESA_SIMPLES

Empresa operacional do contrato. Header não é necessário. Lookup com o `empresaId` do contrato.

## 8. Cross-company

Documento A (empresa 11, chave X) e consulta com empresa 22: `documento: null` no formato atual (200 + payload SEFAZ mock/real). Não devolve id, fornecedor, CNPJ, XML nem `empresaId` do documento A.

## 9. NULL

`empresa_id IS NULL` não casa `AND empresa_id = A`. Sem COALESCE e sem backfill.

## 10. Resposta

Formato preservado: JSON do consChNFe + `documento` (DTO inbox) ou `null`. Cruzado/inexistente: `documento: null` (mesmo código funcional de “não encontrado” local). Erros de contexto: `responderErroDocumentoCentral` (`EMPRESA_CENTRAL_AUSENTE`, etc.).

## 11. Testes

`tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js` — T01–T10.

## 12. Riscos restantes

- XML legado DistDFe/disco ainda pode localizar por chave (fora deste endpoint).
- UNIQUE composto com vários `empresa_id` NULL (SQLite).
- `consultarNotaPorChave` (SEFAZ) continua global pela chave de acesso da NF-e; o isolamento desta sprint é o **documento persistido** da Central.
- Gate SEFAZ (`CentralSefazOperationalGate`) permanece no caminho de produção após a empresa resolvida.
