# SPRINT 05.73

STATUS: CONCLUÍDA

TIPO: AUDITORIA

PRODUÇÃO ALTERADA: NÃO

TABELA: central_entradas_documentos

IDENTIDADE: empresa_id + chave

READERS POR CHAVE:
- A: repository.buscarPorChave; persistência DistDFe; GET /buscar-chave; importação legado; XML devolução Central
- D: notas_recebidas(_dfe) WHERE chave = ? LIMIT 1
- E: certificação/homologação buscarPorChave(1 arg); dfe /consultar-chave 410

READERS POR ID:
- GUARD_PRESENTE nas rotas /:id via comDocumentoAutorizado
- LEITURA_INTERNA: buscarPorId, transição, MIRX, processamento
- C: carregarDocumentoCentral (SELECT id) depois exigirDocumentoDaEmpresa

JOINS:
- A: compras LEFT JOIN … AND d.empresa_id = c.empresa_id
- C: buscarPorId LEFT JOIN compras só por compra_id; backfill compras por compra_id

FALLBACKS:
- nenhum COALESCE(empresa_id) no repository
- backfill startup 05.38.E (CNPJ / operacional SIMPLES) — migração, não reader HTTP

NULL: buscarPorChave não atribui linha NULL a A/B

UPDATES:
- repository.atualizar WHERE id = ? (sem chave)
- persistência após lookup empresarial
- D: fila listarPendentesProcessamento → processar(id) global
- C: migração de status; backfill empresa_id NULL

DISTDFE: persistência Central isolada (05.70); cache XML por chave global (D)

XML: Central devolução A (05.71); DistDFe/disco D

GET /buscar-chave: único vivo; lookup A (05.72); efeito colateral fila pendentes D

RISCOS D:
1. GET /saude + HealthRepository scan (chave/fornecedor/CNPJ globais)
2. FiscalProvider.ultimaEntradaFiscal LIMIT 1 global
3. listarPendentesProcessamento / processarDocumentosPendentes (mutação cruzada)
4. XML notas_recebidas(_dfe) por chave

RISCOS C:
- dashboards/filas do repository sem empresa_id (fornecedores novos, revisão parada, XML inválido, métricas)
- buscarPorId sem empresa no SQL
- Indicadores/alertas agregados misturam empresas (B/C)

TESTES: 10/10 (`tests/central-entradas/auditoria-leitores-globais-05-73.test.js`)

REGRESSÕES (2026-08-29): ALL_OK — 05.73 10/10 · 05.72 10/10 · 05.71 10/10 · 05.70 12/12 · 05.69 8/8 · 05.68–05.54 (05.55 16/16 · 05.54 12/12)

PRÓXIMA MICRO-SPRINT:
05.74 — isolar fila `listarPendentesProcessamento` / auto-processo por empresa_id (único D de mutação no núcleo da Central), depois painel saúde / ultimaEntradaFiscal; XML DistDFe permanece residual 05.71.
