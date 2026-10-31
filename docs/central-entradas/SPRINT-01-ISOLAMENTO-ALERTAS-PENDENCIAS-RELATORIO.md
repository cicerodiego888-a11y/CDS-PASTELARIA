# Sprint 1 — Isolamento multiempresa de alertas e pendências

Central de Entradas. Correção pontual de vazamento entre empresas. Nenhuma alteração no Motor Fiscal, no Motor F×NF, na importação de XML, na manifestação, nos schedulers ou nas permissões de ADMIN, SUPER ADMIN e Diego.

Data: 31/10/2026.

## 1. Arquivos alterados

- `backend/motores/central-entradas/repositories/CentralDocumentosRepository.js`
- `backend/motores/central-entradas/services/CentralAlertasService.js`
- `backend/motores/central-entradas/services/CentralPendenciasService.js`
- `backend/motores/central-entradas/services/CentralAtencaoService.js`
- `backend/motores/central-entradas/services/CentralOperacionalDashboardService.js`
- `backend/motores/central-entradas/CentralEntradasOrchestrator.js`
- `backend/motores/central-entradas/CentralEntradasService.js`
- `backend/rotas/central-entradas.js`
- `tests/central-entradas/cds-central-alertas-isolamento-01.test.js` (novo)
- `tests/central-entradas/auditoria-leitores-globais-05-73.test.js` (o T02 deixou de exigir que `listarFornecedoresNovos` continuasse sem filtro)
- `docs/central-entradas/SPRINT-01-ISOLAMENTO-ALERTAS-PENDENCIAS-RELATORIO.md`

## 2. Causa raiz

`_idsEmpresaFiltro` trata a ausência de `empresaId` e de `empresaIds` como `null`. `null` significa SELECT sem filtro de empresa. Lista vazia significa `1 = 0`.

`listarAlertas` chamava o repositório sem nenhum desses campos. O mesmo valia para `listarFornecedoresNovos` e para as consultas de pendência (revisão, compras abertas, erro, XML inválido). `GET /alertas` e `GET /pendencias` não passavam por `resolverLeituraCentral`.

`GET /inteligencia` já resolvia o escopo e entregava `empresaId` / `empresaIds` aos indicadores. Em seguida `obterInteligenciaOperacional` ignorava esse escopo e recalculava alertas e pendências no conjunto global. A atenção operacional reutilizava esse resultado.

O alerta `FALHA_SINCRONIZACAO` lia `obterUltimaSincronizacao()`, um único carimbo da tabela de NSU, que não tem `empresa_id`.

## 3. Correções

As consultas de alerta e de pendência passaram a receber o escopo e a aplicá-lo no SQL, inclusive no `COUNT` e na média do fornecedor. Sem escopo, essas consultas usam `empresaIds: []` e não caem num SELECT global.

`listarPorStatus(status, limite)` sem o terceiro argumento continua sem filtro. Manifestação e MIIP chamam o método assim. Esta sprint não altera esses fluxos. Alertas e pendências sempre enviam o escopo no terceiro argumento.

`GET /alertas`, `GET /pendencias` e `GET /atencao` resolvem a leitura com `resolverLeituraCentral` antes de consultar. Empresa pedida fora do vínculo responde `EMPRESA_NAO_AUTORIZADA` (403), no mesmo padrão das outras leituras da Central. Visão `escopo=todas` com lista vazia devolve arrays vazios, não o conjunto global e não `EMPRESA_CENTRAL_AUSENTE`.

`obterInteligenciaOperacional`, `obterPendencias`, `obterOperacional` e `obterItensAtencao` calculam um único `escopoEmpresaConsulta` e reutilizam alertas já filtrados. As seções de pendência repetem a consulta de documentos com esse mesmo escopo. Os indicadores recebem `escopo.empresaId` e `escopo.empresaIds`, não o `empresa_id` cru da query.

`GET /atencao` entrou no mesmo resolver porque chamava `listarAlertas` sem escopo. É o mesmo vazamento, no painel de atenção que o objetivo desta sprint cobre. Não houve rota nova de sincronização nem mudança de permissão.

O alerta `FALHA_SINCRONIZACAO` saiu de `listarAlertas`. A seção `falhasSincronizacao` permanece no contrato, vazia. O formato `{ total, alertas }` e `{ resumo, secoes }` não mudou.

## 4. Como o escopo é resolvido e aplicado

1. A rota chama `resolverLeituraCentral` com `req.user` e `resolverEmpresaParaCentral`.
2. Empresa individual: o id do header é validado com `exigirEmpresaAutorizada(req.user, empresaId)`. O id informado pelo cliente não autoriza sozinho.
3. `escopo=todas` em MULTIEMPRESA: `listarEmpresasPermitidas(req.user)` preenche `dest.empresaIds`. Lista vazia permanece vazia.
4. `escopoEmpresaConsulta` transforma isso em `{ empresaId }` ou `{ empresaIds }`. Sem nenhum dos dois, devolve `{ empresaIds: [] }`.
5. O repositório aplica `empresa_id = ?`, `empresa_id IN (...)` ou `1 = 0`, sempre com `empresa_id IS NOT NULL` quando há ids. Documento com `empresa_id` nulo não entra.

## 5. Testes

Arquivo: `tests/central-entradas/cds-central-alertas-isolamento-01.test.js`

Comando: `node --test --test-concurrency=1 tests/central-entradas/cds-central-alertas-isolamento-01.test.js`

Banco `:memory:`. O arquivo não carrega `backend/database.js` nem `distribuicaoDFe`.

| Cenário | Resultado |
|---|---|
| 1. Usuário da empresa A vê alerta e pendência de A e não vê B nem C | Passou |
| 2. Usuário de A e B vê as duas e não vê C nem documento sem empresa | Passou |
| 3. Sem vínculo, visão consolidada devolve alertas, pendências e fornecedores vazios. Chamada sem escopo também não devolve o global | Passou |
| 4. Header da empresa A com usuário só de B gera `EMPRESA_NAO_AUTORIZADA` e status 403, antes da consulta. As rotas resolvem o escopo antes do serviço | Passou |
| 5. Alertas, pendências, contagem por status e atenção da inteligência usam o mesmo par A+B. O orquestrador passa esse `escopo` aos indicadores | Passou |
| 6. Usuário de A continua recebendo fornecedor e pendência de A, com `total`/`alertas` e `resumo`/`secoes` no formato atual | Passou |

6 passaram, 0 falharam.

O cenário 5 executa as consultas de alerta, pendência e `contarPorStatus` com o objeto que `obterInteligenciaOperacional` monta. Não chama `IndicadoresFiscaisService`, porque esse módulo carrega `backend/database.js`. O vínculo dos indicadores com o mesmo `escopo` está no fonte do orquestrador, conferido pelo teste.

O T02 de `auditoria-leitores-globais-05-73.test.js` passou com o novo contrato de `listarFornecedoresNovos`. O T10 desse arquivo falhou em `ReleaseCertificationService.js` por não encontrar `buscarPorChave(CHAVE)`. Esta sprint não alterou esse arquivo. A falha fica fora do recorte.

## 6. Banco oficial

Os testes desta sprint usaram SQLite em memória. Não houve abertura de `C:\ProgramData\MercantilFiscal\dados\mercadao.db`.

A execução seguinte do arquivo 05-73 reutilizou o `DB_DIR` temporário que já estava no ambiente (`cds-audit-20a-...` em `%LOCALAPPDATA%\Temp`) e verificou a tabela `empresas` nesse diretório temporário. Não é o banco oficial.

## 7. SEFAZ

Nenhuma chamada à SEFAZ, nenhuma sincronização, nenhuma importação de XML e nenhum evento fiscal. O teste recusa a leitura do NSU: se `listarAlertas` chamar `obterUltimaSincronizacao`, o teste quebra. Não chamou.

## 8. Pendência

`CentralOperacionalDashboardService.obterIndicadores` ainda lê `obterUltimaSincronizacao()` e devolve o campo `ultimaSincronizacao`. A tabela de NSU é por CNPJ, sem `empresa_id`. Filtrar esse carimbo muda a leitura da sincronização, que esta sprint não pode alterar. O alerta de falha de sincronização deixou de usar esse carimbo. O campo do painel operacional continua global e é o ponto em que a sprint para para avaliação.

`listarPorStatus` sem o terceiro argumento continua global para não mudar a manifestação. Os endpoints desta sprint não usam essa forma.

Não há outro caminho, nos alertas, nas pendências, nos fornecedores novos e na atenção, que devolva documento de empresa fora do escopo autorizado.
