# Auditoria dos leitores globais da Central (Sprint 05.73)

**Status:** auditoria  
**Data:** 2026-08-29  
**Produção alterada:** não

## 1. Objetivo

Inventariar leitores de `central_entradas_documentos` após 05.54–05.72, sem corrigir código. Identidade documental: `empresa_id + chave`. Operações por ID: contexto autoriza; `documento.empresa_id` determina.

## 2. Tabela auditada

`central_entradas_documentos` — campos `id`, `chave`, `empresa_id`, `compra_id`, `status`, `xml`, demais. `empresa_id IS NULL` = legado; `buscarPorChave` não o atribui.

## 3. Leitores encontrados (produção)

Hub: `CentralDocumentosRepository` (`listar`, `contar`, `buscarPorId`, `buscarPorChave`, filas/dashboard, `atualizar`/`remover` por `id`).

SQL avulso: Health, IndicadoresFiscais, MonitoringAlert, FiscalProvider, CentralDiagnostico, espelharTributos (Central + DistDFe), JOIN compras, helpers de backfill.

HTTP por ID: `comDocumentoAutorizado` / `autorizarDocumentoCentralHttp` / `exigirDocumentoDaEmpresa`.

## 4. Readers por chave

| Função | Arquivo | Tipo | Fonte empresa | Lookup | Mutação | Classe | Risco |
|--------|---------|------|---------------|--------|---------|--------|-------|
| `buscarPorChave(chave, empresaId)` | `CentralDocumentosRepository.js` | prod | parâmetro | `chave + empresa_id` | não | A | — |
| persistência DistDFe | `CentralDfePersistenciaService.js` | prod | `_empresaIdOperacao` | idem | UPDATE/INSERT no id encontrado | A | — |
| GET `/buscar-chave` | `rotas/central-entradas.js` + sync | prod | `resolverEmpresaParaCentral` | idem | só se `novo` dispara fila (ver §11) | A lookup / D fila | 05.72 ok; fila 05.73 |
| importação XML legado | `CentralImportacaoXmlLegadoService.js` | prod | `empresaIdLookup` | idem | pode atualizar doc encontrado | A | — |
| XML devolução Central | `espelharTributosNfeDevolucaoCompra.js` | prod | `compra.empresa_id` | `REPLACE(chave) + empresa_id` | não | A | 05.71 |
| XML DistDFe/disco | mesmo arquivo, `notas_recebidas(_dfe)` | prod | nenhuma | `WHERE chave = ? LIMIT 1` | não | D | XML legado |
| certificação | `ReleaseCertificationService.js` | cert | nenhuma | `buscarPorChave(CHAVE)` 1-arg | DELETE se achasse | E | 1-arg → `null` (05.70) |
| homologação | `CentralInteligenteHomologacaoService.js` | cert | nenhuma | 1-arg | DELETE | E | idem |
| `GET /consultar-chave` | `rotas/dfe.js` | legado | n/a | nenhum (HTTP 410) | não | E | aponta para buscar-chave |

Não há `buscarPorChave(chave)` operacional no repository. Config/MIRX `buscarPorChave` é `central_entradas_config`, não documentos.

## 5. Readers por ID

| Função | Guard | Classe |
|--------|-------|--------|
| Rotas `/:id/*` (xml, parse, processar, revisar, compra, status, saúde documento, portal) | `comDocumentoAutorizado` | GUARD_PRESENTE |
| `buscarPorId` no repositório | interno; HTTP passa pelo guard | LEITURA_INTERNA |
| `carregarDocumentoCentral` | depois `exigirDocumentoDaEmpresa` na compra | GUARD_PRESENTE (C no SELECT) |
| `DocumentoTransitionService` / MIRX worker / processamento | job interno por id da fila | LEITURA_INTERNA / C |
| Testes | — | TESTE |

`buscarPorId` não filtra `empresa_id`. Isolamento HTTP depende do guard. Sem guard (fila, MIRX, transição), o id já veio de lista/sync.

## 6. JOINs

| JOIN | Proteção | Classe |
|------|----------|--------|
| `buscarPorId`: `LEFT JOIN compras c ON c.id = d.compra_id` | só `compra_id` | C |
| Relatório uso/consumo: `ON d.compra_id = c.id AND d.empresa_id = c.empresa_id` | 05.61 | A |
| Backfill compras: `d.compra_id = compras.id AND d.empresa_id IS NOT NULL` | migração | C |

## 7. NULL

`buscarPorChave` + `AND empresa_id = ?` não casa NULL. Sem `COALESCE(empresa_id)` no repositório.

`backfillDocumentosCentral` (startup): preenche NULL via CNPJ destinatário; em EMPRESA_SIMPLES pode aplicar `empresa_operacional` no restante. Não é reader de runtime; é migração 05.38.E.

## 8. DistDFe

Persistência de documentos na Central: `buscarPorChave(chave, empresaIdOperacao)` (05.70) — A.

Cache `notas_recebidas` / `notas_recebidas_dfe` por chave sem empresa — D leitura XML (05.71 residual).

SEFAZ `consultarNotaPorChave` é consulta nacional da chave, não linha da Central.

## 9. XML

Central devolução: isolado. DistDFe/disco: global. Health scan não devolve XML bruto, mas devolve chave/fornecedor/CNPJ.

## 10. GET `/buscar-chave`

Único endpoint vivo. `dfe` `/consultar-chave` = 410. Sem `/documento-chave` / `/consulta-chave` duplicados na Central.

## 11. UPDATEs

| UPDATE | Lookup | Empresa | Classe |
|--------|--------|---------|--------|
| `repository.atualizar` | `WHERE id = ?` | não no SQL | C (id pré-autorizado ou fila) |
| persistência DistDFe | chave+empresa → id | sim | A |
| `CentralStatusMigracaoService` | `WHERE status = ?` | não | C bootstrap |
| backfill `empresa_id` | `WHERE id = ? AND empresa_id IS NULL` | migração | C |
| `listarPendentesProcessamento` → `processar(id)` | fila sem empresa | não | **D** |

Evidência D: a fila lista A e B com a mesma chave se ambos estão `XML_COMPLETO` sem parse. `GET /buscar-chave` com `novo` chama `processarDocumentosPendentes({ limite: 5 })` — pode processar documento de outra empresa. `POST /diagnostico/acoes/reprocessar-pendencias` e Health auto-recuperação idem.

Não há `UPDATE ... WHERE chave = ?` no repositório.

## 12. Classificação A/B/C/D/E (resumo)

**A:** `buscarPorChave`, persist DistDFe Central, GET buscar-chave (lookup), XML devolução Central, JOIN compras 05.61, listagem HTTP com `filtros.empresaId`.

**B:** `IndicadoresFiscaisService` e `MonitoringAlertService` (COUNT/SUM sem payload de outra empresa identificável, mas mistura totais).

**C:** `buscarPorId` + JOIN compra; dashboards `listarFornecedoresNovos`, `listarRevisaoParada`, `listarComprasAbertas`, `listarXmlInvalido`, métricas globais, diagnóstico MIIP, migração status/legado, backfill.

**D (evidência):**
1. `HealthRepository` scan + `GET /saude` — chave, fornecedor, CNPJ de qualquer empresa.
2. `FiscalProvider.ultimaEntradaFiscal` — `ORDER BY … LIMIT 1` global (chave/fornecedor da última NF de qualquer empresa).
3. `listarPendentesProcessamento` / `processarDocumentosPendentes` — mutação cruzada possível.
4. XML `notas_recebidas(_dfe)` por chave.

**E:** testes, `rotas/dfe.js` 410, certificação 1-arg.

## 13. Riscos comprovados

- Painel saúde e última entrada fiscal vazam identidade documental (chave/fornecedor) sem recorte de empresa.
- Fila de pendentes processa ids de todas as empresas.
- XML DistDFe/disco por chave (já 05.71).

## 14. Riscos inexistentes (neste recorte)

- Lookup operacional `WHERE chave = ?` sem empresa no repository.
- UNIQUE global só em `chave` (05.70).
- GET `/buscar-chave` devolver documento A ao caller B (05.72).
- JOIN do relatório de compras anexar documento de outra empresa (05.61).
- Fallback `COALESCE(empresa_id)` nos leitores do repositório.

## 15. Próximos pontos (não implementar aqui)

Candidatos 05.74 (só após priorização):

1. Isolar `listarPendentesProcessamento` / auto-processo por `empresa_id`.
2. Isolar `GET /saude` e `FiscalProvider.ultimaEntradaFiscal`.
3. Isolar XML DistDFe/disco (se ainda for prioridade).
4. Corrigir certificação `buscarPorChave(chave, empresaId)` (E, não produção ERP).
