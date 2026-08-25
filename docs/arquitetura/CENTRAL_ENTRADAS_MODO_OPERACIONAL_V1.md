# Central de Entradas — Modo Operacional Global V1

**Sprint:** 05.38.E  
**Fonte oficial do modo:** `ContratoOperacionalService` / `resolverModoOperacionalGlobalAtivo()`  
**Classificação:** ESTADO B (código + testes automatizados; sem validação manual completa SEFAZ)

---

## 1. Arquitetura final

Uma única Central de Entradas. Sem segundo pipeline MIIP, sem segunda tabela de NSU, sem segundo motor de compras.

```
ContratoOperacionalService
        ↓
EMPRESA_SIMPLES | MULTIEMPRESA
        ↓
CentralEntradasEmpresaContextoService
        ↓
CentralSincronizacaoService (loop por empresa quando MULTI)
        ↓
Distribuição DF-e (CNPJ + ambiente + certificado da empresa)
        ↓
CentralNsuRepository (chave: CNPJ + ambiente)
        ↓
central_entradas_documentos.empresa_id
        ↓
Parser → MIIP → Central Review → Compra → Estoque → Financeiro
```

---

## 2. Resolução de empresa

Componente: `backend/services/central-entradas/CentralEntradasEmpresaContextoService.js`

| Função | Papel |
|--------|--------|
| `resolverEmpresaParaCentral({ empresaId, cnpj, operacao, req })` | Resolve empresa para upload/import/API |
| `listarAlvosSincronizacaoCentral()` | Plano de sync (1 alvo ou N empresas ativas) |
| `exigirDocumentoCompraMesmaEmpresa` | Bloqueia documento A → compra B |

Erros explícitos: `EMPRESA_CENTRAL_AUSENTE`, `EMPRESA_CENTRAL_AMBIGUA`, `EMPRESA_CENTRAL_INATIVA`, `EMPRESA_CENTRAL_INVALIDA`, `DOCUMENTO_EMPRESA_INCOMPATIVEL`.

---

## 3. EMPRESA_SIMPLES

- Empresa operacional via contrato (transparente).
- Sync: um único alvo (empresa operacional).
- Contexto fiscal: preferência `empresas_configuracao_fiscal`; fallback `getFiscalConfig` (transparência legado).
- Sem exigência de `X-Empresa-Id` na sincronização interna.
- Documentos novos recebem `empresa_id` da empresa operacional.

---

## 4. MULTIEMPRESA

- Sync: lista empresas **ativas** e chama `sincronizarEmpresa` isolado por iteração (`empresaId`, `cnpj`, `ambiente`).
- Sem estado global mutável entre iterações.
- Empresa inativa não entra no plano.
- Upload/XML: resolve por CNPJ do destinatário ou `X-Empresa-Id`; bloqueia CNPJ desconhecido.
- Cooldown DF-e avaliado **por CNPJ** (não bloqueia o lote inteiro).

---

## 5. Fluxo SEFAZ

```
sincronizarCentralEntradas
  → listarAlvosSincronizacaoCentral
  → para cada alvo:
       obterContextoOperacional({ empresaId, permitirFallbackGlobal })
       cooldown(cnpj, ambiente)
       sincronizarDistribuicaoDFe({ contextoCentral, persistencia com empresaId })
```

---

## 6. Fluxo XML (upload / importação legada)

1. Extrai CNPJ destinatário do XML.
2. `resolverEmpresaParaCentral`.
3. Valida divergência destinatário × empresa.
4. Persistência / atualização com contexto empresarial preservado no documento.

---

## 7. NSU por CNPJ

Repositório: `CentralNsuRepository` — `UNIQUE(cnpj, ambiente)`.

Não foi criada nova tabela. Sync A nunca altera NSU B.

---

## 8. Propagação até compras / estoque / financeiro

| Etapa | Mecanismo |
|-------|-----------|
| Documento | `central_entradas_documentos.empresa_id` |
| Abrir compra | payload inclui `empresaId` / `empresa_id` do documento |
| Vincular compra | `exigirDocumentoCompraMesmaEmpresa` |
| Estoque | `estoque_empresa` por `empresa_id` (catálogo compartilhado) |
| Financeiro | Fronteira 05.38.D (`criarFinanceiroCompra` + `empresa_id`) |

**GAP residual:** tabela `compras` ainda sem coluna `empresa_id` (igual 05.38.D) — isolamento na fronteira documento→payload→financeiro/estoque.

---

## 9. Migrations

- Coluna `empresa_id` em `central_entradas_documentos` (DDL + ALTER idempotente).
- Índice `idx_central_entradas_documentos_empresa`.
- Backfill: (1) match CNPJ destinatário no XML → empresa ativa; (2) EMPRESA_SIMPLES seguro → empresa operacional; (3) MULTIEMPRESA ambíguo permanece `NULL`.

Helper: `backend/utils/centralEntradasEmpresaHelpers.js`.

---

## 10. Compatibilidade legado

| Cenário | Comportamento |
|---------|----------------|
| EMPRESA_SIMPLES + 1 empresa / `empresa_operacional_id` | Backfill seguro |
| MULTIEMPRESA + XML sem destinatário resolvível | Sem atribuição arbitrária |
| Sync sem certificado por empresa (SIMPLES) | Fallback `getFiscalConfig` |

---

## 11. Dashboard

- Filtro opcional `empresa_id` / `req.empresaId` em listagem e dashboard.
- Sem filtro em MULTIEMPRESA: visão marcada `consolidada_sem_identificacao_por_empresa` (**GAP UX** — não expandido nesta sprint).

---

## 12. Matriz de auditoria (fronteiras)

| Fronteira | empresa_id? | CNPJ? | Migration? | Risco cruzamento |
|-----------|-------------|-------|------------|------------------|
| Sync SEFAZ | Via alvo + contexto | Fiscal empresa / fallback | N/A | Mitigado por loop isolado |
| NSU | Implícito via CNPJ | Sim (chave) | Não | Isolado |
| Import XML | Resolver + doc | Destinatário | N/A | Bloqueio divergência |
| Documentos | Coluna nova | Destinatário no XML | Sim | Isolado |
| MIIP | Herda do documento | — | Não | Sem alteração de regras |
| Central Review | Preserva doc | — | Não | Sem seleção silenciosa |
| Compra | Payload + validação | — | GAP em `compras` | Bloqueio incompatível |
| Estoque | `estoque_empresa` | — | Já existia | Isolado |
| Financeiro | 05.38.D | — | Já existia | Isolado |
