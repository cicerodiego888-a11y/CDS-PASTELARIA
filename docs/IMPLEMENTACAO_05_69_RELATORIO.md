# SPRINT 05.69

STATUS: CONCLUÍDA

TIPO: AUDITORIA

PRODUÇÃO ALTERADA: NÃO

TABELA: central_entradas_documentos (coluna `chave`, não `chave_acesso`)

WRITERS: 1 INSERT de produção (`CentralDocumentosRepository.inserir`). Callers: `persistirDocumentoDfe` (vivo) e `CentralDocumentoService.criar` (orquestrador não usa).

READERS: hub no repositório (listar/buscar/contar/métricas) + SQL avulso em ~10 arquivos (`espelharTributos`, indicadores, health, diagnóstico, helpers, monitoring, certificação).

FUNÇÕES DE DUPLICIDADE:
- `buscarPorChave` (SELECT global)
- `persistirDocumentoDfe` / `aplicarEventoDfe`
- `CentralSincronizacaoService.buscarPorChave` + `GET /buscar-chave`
- `CentralImportacaoXmlLegadoService` (depois valida CNPJ se já houver `empresa_id`)
- UNIQUE SQLite em `chave`

CONSULTAS GLOBAIS:
- `SELECT * FROM central_entradas_documentos WHERE chave = ?`
- `SELECT xml, chave … WHERE REPLACE(chave, ' ', '') = ? LIMIT 1` (XML devolução)

CONSULTAS EMPRESARIAIS:
- listagem/contagem com `empresa_id = ?` quando o filtro existe (não é DistDFe)
- `existeCompraComChave` em `compras` (05.68)

FONTE DE EMPRESA:
alvo 05.54 / DistDFe `empresaIdPersistencia` / upload `resolverEmpresaParaCentral` → **INSERT**. Não chega ao SELECT de duplicidade.

EMPRESA_SIMPLES: INSERT usa empresa operacional; lookup ignora empresa.

MULTIEMPRESA: cada alvo grava `empresa_id` no INSERT; lookup e UNIQUE são globais. Alvo B encontra documento A.

NULL: linha com `empresa_id` NULL é encontrada por chave; UNIQUE ocupa a chave; sem COALESCE.

CROSS-COMPANY: RISCO (bloqueio global + vazamento do documento + possível UPDATE de XML no id da outra empresa)

TESTES: 8/8 (`tests/auditoria/duplicidade-documento-central-05-69.test.js`)

REGRESSÕES (2026-08-29): ALL_OK — 05.69 8/8 · 05.68 8/8 · 05.67 8/8 · 05.66 8/8 · 05.65 10/10 · 05.64 8/8 · 05.63 10/10 · 05.62 8/8 · 05.61 8/8 · 05.60 10/10 · 05.59 10/10 · 05.58 10/10 · 05.57 10/10 · 05.56 10/10 · 05.55 16/16 · 05.54 12/12

RISCOS D:
- `buscarPorChave` sem `empresa_id`
- UNIQUE global em `chave` (A+X e B+X não coexistam)
- persistência DistDFe trata documento A como duplicata de B e pode atualizar XML
- GET buscar-chave devolve documento de qualquer empresa
- XML devolução por chave sem empresa

RISCOS C:
- INSERT com `empresaId` do alvo (campo ok; unicidade não)

PRÓXIMA MICRO-SPRINT:
isolar `buscarPorChave(chave, empresaId)` **e** o UNIQUE global — sem schema composto, A+X ≠ B+X continua impossível no disco.
