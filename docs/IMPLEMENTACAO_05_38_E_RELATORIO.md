    # Relatório — Implementação 05.38.E

    **Sprint:** Central de Entradas por Modo Operacional Global  
    **Classificação:** ESTADO B (código + migration + testes automatizados; sem validação manual completa SEFAZ)  
    **Data:** 2026-08-24

    ---

    ## 1. Objetivo

    Propagar o Modo Operacional Global (`EMPRESA_SIMPLES` | `MULTIEMPRESA`) para a Central de Entradas, mantendo **um** pipeline (SEFAZ → Central → MIIP → Review → Compras → Estoque → Financeiro), com empresa operacional resolvida corretamente em cada processamento.

    ---

    ## 2. Arquivos auditados

    | Área | Arquivos |
    |------|----------|
    | Orquestração | `CentralEntradasOrchestrator.js`, `CentralEntradasService.js`, `CentralSyncExecucaoService.js` |
    | Sync SEFAZ | `CentralSincronizacaoService.js`, `distribuicaoDFe.js`, `CentralConfiguracaoService.js` |
    | NSU | `CentralNsuRepository.js`, `CentralNsuService.js` |
    | Documentos | `CentralDocumentosRepository.js`, `CentralDfePersistenciaService.js`, `database.js` |
    | XML | `CentralUploadService.js`, `CentralImportacaoXmlLegadoService.js` |
    | Compras | `CentralComprasBridgeService.js`, `compras.js` (fronteira financeiro 05.38.D) |
    | Dashboard | `CentralDashboardService.js`, `rotas/central-entradas.js` |
    | Modo | `ContratoOperacionalService`, `PoliticaEmpresaSimples`, `empresasConfiguracaoFiscal.js` |

    ---

    ## 3. Arquivos alterados / criados

    ### Criados

    | Arquivo | Função |
    |---------|--------|
    | `backend/services/central-entradas/CentralEntradasEmpresaContextoService.js` | Resolução de empresa (não é motor novo) |
    | `backend/utils/centralEntradasEmpresaHelpers.js` | Migration/backfill documentos |
    | `tests/central-entradas-multiempresa-05-38-e.test.js` | Suite 05.38.E |
    | `docs/arquitetura/CENTRAL_ENTRADAS_MODO_OPERACIONAL_V1.md` | Arquitetura V1 |
    | `docs/IMPLEMENTACAO_05_38_E_RELATORIO.md` | Este relatório |

    ### Alterados

    | Arquivo | Alteração |
    |---------|-----------|
    | `CentralSincronizacaoService.js` | Loop EMPRESA_SIMPLES / MULTIEMPRESA; sync isolado |
    | `CentralConfiguracaoService.js` | `obterContextoOperacional({ empresaId })` |
    | `CentralDfePersistenciaService.js` | Persiste `empresaId` |
    | `CentralDocumentosRepository.js` | Coluna/mapa/filtro `empresa_id` |
    | `distribuicaoDFe.js` | Propaga `empresaId` na persistência |
    | `CentralUploadService.js` | Resolve empresa no upload |
    | `CentralImportacaoXmlLegadoService.js` | Resolve/valida empresa no XML legado |
    | `CentralComprasBridgeService.js` | Payload + vínculo com validação |
    | `CentralSyncExecucaoService.js` | Cooldown por modo |
    | `CentralDashboardService.js` / rotas | Filtro opcional por empresa |
    | `DocumentoFiscalInboxDTO.js` | Expõe `empresaId` |
    | `database.js` | DDL/ALTER/índice + migration 05.38.E |

    ---

    ## 4. Migrations

    - `central_entradas_documentos.empresa_id INTEGER REFERENCES empresas(id)`
    - Índice `idx_central_entradas_documentos_empresa`
    - Backfill: CNPJ destinatário → empresa; EMPRESA_SIMPLES seguro → operacional; MULTIEMPRESA ambíguo → `NULL`

    ---

    ## 5. Componentes reutilizados

    - `ContratoOperacionalService` / políticas 05.38.B
    - `CentralNsuRepository` (CNPJ + ambiente)
    - Pipeline MIIP / Central Review / Compras / `estoque_empresa` / Financeiro 05.38.D
    - `empresasConfiguracaoFiscal` + fallback `getFiscalConfig` (SIMPLES)

    ---

    ## 6. Fluxo antes / depois

    **Antes:** sync único via `getFiscalConfig` (CNPJ global); documentos sem `empresa_id`.

    **Depois:** plano por modo operacional; cada sync com `empresaId`+`cnpj`+NSU próprio; documento carrega `empresa_id` até compra/estoque/financeiro.

    ---

    ## 7. Testes novos

    Suite: `tests/central-entradas-multiempresa-05-38-e.test.js` — **19/19 PASS** (cenários 1–20 consolidados + estrutural).

    ---

    ## 8. Regressões

    Executadas na entrega (ver seção correspondente do status final): modo 05.38.B, caixa 05.38.C, financeiro 05.38.D e smoke estrutural Central.

    ---

    ## 9. Limitações / GAPs

    1. Tabela `compras` ainda sem `empresa_id` (GAP herdado 05.38.D).
    2. Dashboard consolidado MULTIEMPRESA sem identificação visual rica por empresa (filtro opcional apenas).
    3. Sem validação manual completa DistDFe/SEFAZ em ambiente real (ESTADO B).
    4. Sync MULTIEMPRESA exige certificado/CNPJ por empresa (sem fallback global por alvo).

    ---

    ## 10. Declaração ESTADO B

    Implementação concluída com código, migration idempotente, testes automatizados e documentação. **Não** inclui homologação operacional completa SEFAZ em produção.
