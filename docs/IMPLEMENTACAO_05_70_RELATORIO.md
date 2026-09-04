# SPRINT 05.70

STATUS: CONCLUÍDA

PRODUÇÃO ALTERADA: SIM — schema `central_entradas_documentos`, `buscarPorChave(chave, empresaId)`, persistência/evento DistDFe, sync GET local, importação legado (lookup)

TABELA: central_entradas_documentos

CONSTRAINT ANTERIOR: UNIQUE(chave)

CONSTRAINT NOVA: UNIQUE(chave, empresa_id)

WRITER: `CentralDocumentosRepository.inserir` — `empresa_id` do alvo (05.54). Origem da empresa inalterada.

LOOKUP: `buscarPorChave(chave, empresaId)` → `WHERE chave = ? AND empresa_id = ?`

MULTIEMPRESA: A+X, B+X, C+X coexistentes; cada alvo só o próprio documento

NULL: não preenchido; não é encontrado como documento da A

CROSS-COMPANY: persistência B não atualiza nem devolve o documento A

TESTES: 12/12 (`tests/central-entradas/identidade-documento-empresa-05-70.test.js`)

REGRESSÕES (2026-08-29): ALL_OK — 05.70 12/12 · 05.69 8/8 · 05.68 8/8 · 05.67 8/8 · 05.66 8/8 · 05.65 10/10 · 05.64 8/8 · 05.63 10/10 · 05.62 8/8 · 05.61 8/8 · 05.60 10/10 · 05.59 10/10 · 05.58 10/10 · 05.57 10/10 · 05.56 10/10 · 05.55 16/16 · 05.54 12/12 (T11 cert B falha isolada)

RISCOS RESTANTES:
- 05.70.1 XML de devolução por chave global (`espelharTributosNfeDevolucaoCompra`)
- 05.70.2 GET `/buscar-chave` sem empresa no contexto (não anexa documento; não vaza)
- 05.70.3 UNIQUE composto com vários NULL (SQLite)
