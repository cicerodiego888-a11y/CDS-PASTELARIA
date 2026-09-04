# Auditoria — duplicidade de documento da Central por chave (Sprint 05.69)

**Status:** auditoria (produção **não** alterada)  
**Data:** 2026-08-29  
**Pergunta:** a identidade do documento da Central já é `chave + empresa_id`, ou ainda é só a chave?

## Resposta

Ainda é **só a chave**, e de forma mais forte que um `SELECT` solto:

1. Lookup: `WHERE chave = ?` (sem `empresa_id`).
2. Schema: `chave TEXT NOT NULL UNIQUE` — **uma chave no banco inteiro**.

A coluna da tabela é `chave`, não `chave_acesso` (esta última é de `compras`, isolada na 05.68).

Logo, no código atual:

    A + X = B + X   (a mesma linha)

Não é possível persistir duas linhas. A Central B encontra o documento da A.

---

## 1. Estrutura da tabela

`central_entradas_documentos` (`backend/database.js`):

| Item | Valor |
|------|--------|
| PK | `id INTEGER PRIMARY KEY AUTOINCREMENT` |
| Identidade natural | `chave TEXT NOT NULL UNIQUE` (global) |
| `empresa_id` | `INTEGER` **nullable**, FK `empresas(id)` (05.38.E) |
| UNIQUE composto | **não existe** `(chave, empresa_id)` |
| Índices | `status`, `cnpj_fornecedor`, `empresa_id` (não único), `data_emissao` |
| Outras colunas de identificação | `nsu`, `compra_id`, `cnpj_fornecedor`, `tipo_documento` |

Sem migration nesta sprint.

---

## 2. Writers

Um único `INSERT` de produção: `CentralDocumentosRepository.inserir`.

| Writer | Arquivo | Origem | empresa_id | Classe |
|--------|---------|--------|------------|--------|
| `inserir` | `CentralDocumentosRepository.js` | DistDFe / sync / upload via `persistirDocumentoDfe` | `dados.empresaId ?? dados.empresa_id ?? null` | **C** na gravação do campo; unicidade **D** |
| `criar` | `CentralDocumentoService.js` | wrapper; **orquestrador não chama** | passa `dados` | **E** (caminho morto HTTP) |

`empresa_id` no INSERT vem do alvo (`dados.empresaId` / `this._empresaId`). Pode ser `NULL`. Sem COMPAT, sem primeira empresa, sem COALESCE no INSERT.

Não há `INSERT INTO central_entradas_documentos` literal no `backend/` — só o template `INSERT INTO ${TABELA}`.

---

## 3. Readers

Hub: `CentralDocumentosRepository` (`buscarPorId`, `buscarPorChave`, `listar*`, `contar*`, métricas, pendentes).

SQL avulso (amostra, fora da duplicidade de persistência): `espelharTributosNfeDevolucaoCompra`, `exportarContabilidadeService`, `IndicadoresFiscaisService`, `FiscalProvider`, `HealthRepository`, `CentralDiagnosticoService`, `comprasEmpresaHelpers`, `centralEntradasEmpresaHelpers` (backfill), `MonitoringAlertService`.

Listagem HTTP da Central filtra `empresa_id` quando o DTO traz empresa (05.55). **Não** é o caminho de duplicidade DistDFe.

---

## 4. Funções de duplicidade documental

| Função | Arquivo | Chamador | SQL | Params | Fonte empresa | Sem empresa |
|--------|---------|----------|-----|--------|---------------|-------------|
| `buscarPorChave` | `CentralDocumentosRepository` | persistência, sync GET, legado, certificação | `SELECT * … WHERE chave = ?` | `[chave]` | **nenhuma** | devolve a primeira linha da chave |
| `persistirDocumentoDfe` | `CentralDfePersistenciaService` | DistDFe, upload, sync | via `buscarPorChave` **antes** de `empresaIdOperacao` | chave | alvo só no **INSERT** posterior | se achar linha, trata como duplicado e **devolve o documento** |
| `aplicarEventoDfe` | mesmo | DistDFe evento | `buscarPorChave` | chave | nenhuma | ignora se não achar; se achar, **transiciona aquele id** |
| `CentralSincronizacaoService.buscarPorChave` | sync + `GET /buscar-chave` | rota | `buscarPorChave` após SEFAZ | chave | contexto operacional da **consulta SEFAZ**, não do SELECT | devolve DTO do documento global |
| importação XML legado | `CentralImportacaoXmlLegadoService` | importação | `buscarPorChave` | chave | depois compara CNPJ do doc (05.38.E) se `empresaId` preenchido | **B** se já tem empresa; **D** se NULL |
| UNIQUE | schema | SQLite no INSERT | — | — | — | segundo INSERT da mesma chave falha |

Classificação: lookup e UNIQUE = **D**. Importação legado com empresa já persistida = **B**. INSERT com alvo = **C**.

---

## 5. Consultas encontradas

**Globais (D):**

```sql
SELECT * FROM central_entradas_documentos WHERE chave = ?
```

```sql
SELECT xml, chave FROM central_entradas_documentos
 WHERE REPLACE(chave, ' ', '') = ? … LIMIT 1
```
(`espelharTributosNfeDevolucaoCompra` — XML de devolução; fora do inbox DistDFe, ainda global.)

**Empresariais (não são duplicidade de persistência):**

- `_montarClausulaWhere` + `empresa_id = ?` na listagem/contagem (quando filtro presente).
- `existeCompraComChave`: `compras.chave_acesso + empresa_id` (**05.68**, outra tabela).

---

## 6. Fonte de empresa

Sync 05.54: `listarAlvosSincronizacaoCentral` → `alvo.empresaId` → ctor da persistência + DistDFe `empresaIdPersistencia` → **INSERT**.

Esse `empresaId` **não** entra em `buscarPorChave`.

Upload: `resolverEmpresaParaCentral` → `persistirDocumentoDfe({ empresaId })` — mesma ordem (lookup global, depois INSERT).

---

## 7. EMPRESA_SIMPLES

Contrato: uma `empresa_operacional`. Alvo único. INSERT usa essa empresa. Lookup continua global: se existir documento de outra empresa (legado / erro anterior) com a mesma chave, a operação simples **enxerga essa linha**.

Não usa `empresa_operacional_id` como filtro do SELECT de duplicidade.

---

## 8. MULTIEMPRESA

Cada iteração tem `empresaId` próprio no INSERT. A duplicidade documental **não** é por alvo:

    sincronização B + chave X  →  encontra documento da A  →  `duplicado: true`
    e pode `atualizarComXmlCompleto` no **id da A** se o status permitir XML completo.

`A + X` e `B + X` **não coexistirem** (UNIQUE).

---

## 9. NULL

`empresa_id IS NULL` + chave X: `buscarPorChave` **encontra**. UNIQUE **ocupa** a chave. Sem COALESCE para empresa operacional / empresa 1 / COMPAT no lookup.

---

## 10. Cross-company

| Tipo | Comportamento real |
|------|-------------------|
| BLOQUEIO CORRETO (`chave + empresa`) | **não** |
| BLOQUEIO GLOBAL | **sim** (UNIQUE + duplicado) |
| VAZAMENTO | **sim** (`SELECT *`, DTO com id/xml/fornecedor/empresa_id da outra) |
| MUTAÇÃO | **sim** se o fluxo de XML completo atualizar o documento existente |

---

## 11. Relação com compra (05.56 não reaberta)

Duplicidade de **documento** não usa JOIN com `compras`. `existeCompraComChave` é separado e já empresarial. `buscarPorId` do documento faz `LEFT JOIN compras ON c.id = d.compra_id` **sem** `empresa_id` (load por id; HTTP 05.55 valida depois).

Risco extra: XML de devolução por chave global (`espelharTributos`).

---

## 12. Riscos D

1. `buscarPorChave` global.
2. UNIQUE global em `chave` (impede `A + X ≠ B + X` no disco).
3. `persistirDocumentoDfe` usa o lookup **antes** do alvo; pode marcar duplicado e atualizar XML da outra empresa.
4. `GET /api/central-entradas/buscar-chave` devolve documento de qualquer empresa.
5. `carregarXmlNfeCompraOrigem` por chave sem `empresa_id`.

## 13. Riscos C

- INSERT com `empresaId` do alvo (campo preenchido, unicidade ainda global).
- Upload resolve empresa pelo contrato; lookup ignora.

## 14. Fora do escopo

NSU, DistDFe além do lookup, MIIP, POST compras, 05.68, backfill `migrarEmpresaIdCentralDocumentos`, ownership HTTP 05.55, documento→compra 05.56.

---

## Próxima micro-sprint

Isolar duplicidade documental: `buscarPorChave(chave, empresaId)` com `chave + empresa_id`, **e** tratar o UNIQUE global (schema) — sem isso A+X e B+X continuam impossíveis. Não corrigido aqui.
