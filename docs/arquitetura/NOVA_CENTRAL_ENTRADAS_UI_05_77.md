# Nova Central Inteligente de Entradas — UI 05.77

Camada visual sobre a Central existente. Motor, DistDFe, MIIP, Compras, Estoque, Fiscal e ownership **não** foram alterados nesta sprint.

## 1. Estrutura visual

Arquivos:

- `frontend/erp/js/central-entradas.js` — mesmo `loadCentralEntradas()`, mesmos IDs.
- `frontend/css/central-entradas-05-77.css` — tokens, empresas, tabela, painel ~380px.
- `frontend/erp/index.html` — link do CSS 05.77.

Ordem na inbox:

1. Cabeçalho (título, ONLINE, SEFAZ, Sincronizar).
2. Área EMPRESAS (seletor + chips ou modo compacto).
3. Indicadores fiscais (Valor/NF-e mês e ano) — API atual.
4. KPIs de fila (Recebidos hoje, Pendentes, Em revisão, Prontas, Erro/XML).
5. Toolbar (pesquisar, empresa, período, filtros, atualizar).
6. Monitoramento SEFAZ e Saúde (acordeão existente).
7. Tabela de documentos + painel lateral.

Identidade: classes CDS/`central-ux1-*` preservadas; 05.77 só complementa.

## 2. Área multiempresa

Fonte: **uma** chamada a `CdsEmpresaContexto.listarDisponiveis()` (`GET /empresas/contexto/disponiveis`), reutilizada após `garantirEmpresaAtivaParaCentral`.

Não há um HTTP por empresa para montar cards.

## 3. Uma empresa

Seletor + um chip compacto (nome, CNPJ, status). Contagens de fila só do **contexto autorizado** (`X-Empresa-Id` + dashboard já existente).

## 4. Três empresas

Chips lado a lado (`n < 6`). Empresa do contexto destacada. Demais chips não pedem dashboard próprio.

## 5. Cinco ou mais (10+)

A partir de **6** empresas: chips escondidos; permanece `[ Todas as empresas ▼ ]` + busca + contador `N empresas ativas`. Overflow horizontal nos chips quando ainda visíveis (viewport estreita).

## 6. Seletor

- Opção **Todas as empresas**.
- Lista filtrável (`Pesquisar empresa...`).
- Empresa específica → `CdsEmpresaContexto.selecionar(id)` e recarga de dashboard + documentos (mesmo isolamento de sempre).

## 7. Indicadores

Valores continuam de `/dashboard` e indicadores fiscais já carregados. Sem SQL novo. Sem recálculo paralelo no cliente.

## 8. Tabela

Colunas: Empresa, CNPJ, Tipo, Número, Série, Fornecedor, Emissão, Valor, Status, Ações.

Empresa/CNPJ na linha: cadastro permitido cruzado com `documento.empresaId` / `empresa_id` (exibição). A **lista** continua vindo do GET da Central filtrado pelo backend no contexto.

`data-documento-id` e classe `central-entradas-row` preservados. Paginação inalterada.

## 9. Painel de pré-visualização

`#centralEntradasPainelLateral` + `renderPainelLateralCentral`. Cabeçalho: fornecedor, NF número/série, badges, valor, próxima ação. Fechar (`#centralPainelFechar`) só limpa seleção.

Desktop: grid `1fr` + ~380px (máx. 420px). &lt;1200px: empilha (tabela depois painel).

## 10. Abas

Resumo, Produtos, Timeline, XML, Histórico — mesmos `data-aba` e `renderConteudoAbaCentral`. Abas extras do código (`miip` → produtos, compra) não removidas.

## 11. Ações

Regras de habilitação **iguais**: `renderAcoesPipelineCentral`, `renderCtaImportarCompraCentral`, `resolverProximaAcaoOperacional`. Linha: Visualizar / Revisar (se a ação operacional já for revisar) / Mais (abre o mesmo painel).

Sincronizar: `#centralBtnSincronizar` → `sincronizarCentralEntradas`.

## 12. Responsividade

Toolbar e chips com wrap; tabela com scroll horizontal interno; painel 100% em telas estreitas.

## 13. Endpoints

Preservados. Nenhum endpoint criado só para a UI. `listarDisponiveis` já existia para o seletor global do ERP.

## 14. Ownership

UI não escolhe empresa 1 / primeira / última como dono do documento.

`garantirEmpresaAtivaParaCentral` continua só quando o contexto da sessão é inválido (inativa/ausente): seleciona a **primeira empresa da lista permitida** — autorização de sessão, não ownership documental.

Lista e dashboard de uma empresa seguem `X-Empresa-Id`. `documento.empresa_id` permanece a identidade do documento no backend (não alterado).

Sprint **05.79**: “Todas as empresas” passou a usar `escopo=todas` com `empresa_id IN` das autorizadas do usuário (não é SELECT global nem N GETs no cliente). Ver `docs/arquitetura/TODAS_EMPRESAS_INBOX_CENTRAL_05_79.md`.

## 15. PDV Universal

Nenhuma referência. PDV Universal permanece congelado.
