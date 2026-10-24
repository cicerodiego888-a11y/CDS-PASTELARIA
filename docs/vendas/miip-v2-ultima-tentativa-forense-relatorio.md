# MIIP V2 — Última tentativa de rastreamento do candidato ABC001 / 58%

**Decisão final: investigação ENCERRADA como INCONCLUSIVA.** A causa **não foi comprovada**. Não há evidência autorizada que relacione a ocorrência a um registro, a um resultado MIIP persistido ou a um evento de diagnóstico. Esta linha forense está encerrada; nenhuma nova sprint forense deve ser aberta sem os dados listados na seção 7.

## 1. Artefatos revisados

- Relatórios em `docs/vendas/`: `miip-v2-auditoria-origem-candidato-cache.md`, `miip-v2-rastreamento-forense-candidato-relatorio.md`, `miip-v2-instrumentacao-origem-candidato-relatorio.md`, `miip-v2-coleta-controlada-abc001-relatorio.md`, `miip-v2-harness-isolado-relatorio.md`, `miip-v2-fixture-sintetica-contratos-relatorio.md`.
- Testes e fixtures: `tests/miip/miip-origin-isolated-harness.test.js`, `tests/miip/miip-origin-diagnostics.test.js`, `tests/miip/helpers/origin-fixture-loader.js`, seis JSON em `tests/miip/fixtures/origin-diagnostics/`.
- Código lido (somente leitura): `frontend/erp/js/miip-central-revisao-inteligente.js` (`enriquecerProdutoCds`, `registrarOrigemIdentidadeUi`), `frontend/erp/js/miip-central-revisao.js` (`renderPainelIdentificadores`, `renderComparacaoV2`), `backend/motores/miip/utils/MiipResultadoImportacaoMapper.js` (`montarProdutoEncontrado`), `backend/certification/*` (somente buscas por padrão).
- Capturas, exports ou HAR da ocorrência: **nenhum encontrado** (as únicas imagens do repositório são de PDV, login e painéis de homologação, sem relação com o caso).

## 2. Evidências encontradas (fatos observados)

1. `Refrigerante Cola 2L`, `ABC001` e `7891234567890` aparecem **juntos** como `xProd`, `cProd` e `cEAN` do item 1 das fixtures NF-e do repositório: `tests/central-entradas/fixtures/rc64-proc-nfe.xml` e `tests/shared/nfe/fixtures/nfe-proc-sample.xml`. `nfe-parser.test.js` confirma `codigo_fornecedor = ABC001`, `codigo_barras = 7891234567890`. Esses XMLs também são usados por `backend/certification/CentralInteligenteHomologacaoService.js` e `ReleaseCertificationService.js` e por testes da Central.
2. O painel **PRODUTO CDS** lê somente `pendencia.produtoEncontrado` ou `pendencia.candidatoSelecionado.produto` e os enriquece com a lista de produtos do catálogo (`enriquecerProdutoCds`: o valor do candidato tem precedência; o catálogo atual só preenche campo vazio). O painel XML usa `produtoXML`/itens da sessão, que é outro objeto. Não há caminho no código do painel que copie `cProd`, `cEAN` ou `xProd` do XML para o painel CDS.
3. `montarProdutoEncontrado` exige `produtoId` válido (> 0) e monta `codigo`, `nome`, `codigoBarras` a partir de `produto`/`snapshot` do candidato (com fallback para campos do próprio candidato). Não usa o item do XML.
4. Portanto, para o painel mostrar `ABC001` como **código do CDS**, o objeto de candidato precisa conter `codigo = ABC001`. Esse campo é o código interno do cadastro (`produtos.codigo`) quando vem do repositório de produtos; não é o `cProd` do fornecedor, que no contrato é `codigoFornecedor`/`codigo_fornecedor`.
5. Nenhum seed, script ou teste do repositório cadastra, em um banco operacional, um produto com `codigo = ABC001` ou GTIN `7891234567890`. O único `INSERT` com esses valores é um dado **sintético em memória** do teste `miip-origin-diagnostics.test.js`, criado nas sprints anteriores. Os serviços de certificação criam produtos com código prefixado e GTIN gerado por `Date.now()`.
6. Os mecanismos que poderiam sustentar a apresentação (resultado MIIP persistido reutilizado, cache de produto sem TTL por ID e GTIN, cache MIP por GTIN, associação de fornecedor, busca textual/NCM com GTIN divergente) existem e foram reproduzidos em dados sintéticos. Isso demonstra possibilidade técnica, não ocorrência.

## 3. Hipóteses

| Hipótese | Situação | Justificativa |
|---|---|---|
| Painel CDS exibiu valores do XML do fornecedor | **Descartada pelo caminho de código** (parcialmente) | Leitura do frontend e do mapeador não mostra fallback ao XML. Ressalva: leitura estática, sem execução da tela |
| Candidato é o produto de catálogo cujo cadastro tem os mesmos valores do XML de amostra | **Inconclusiva** (compatível com o fato 1) | Os valores coincidem com a fixture, mas não há registro de catálogo ou resultado para confirmar |
| Resultado MIIP persistido reutilizado | **Inconclusiva** | Mecanismo existe e foi reproduzido sinteticamente; não há `miip_resumo_json` da ocorrência |
| Cache obsoleto (ID/GTIN) | **Inconclusiva** | Mecanismo existe; um cache de execução passada não pode ser reconstituído |
| Associação de fornecedor | **Inconclusiva** | Mecanismo existe; sem `miip_associacoes` do caso. Coincidência `cProd = codigo` não prova associação |
| Busca textual/NCM com GTIN divergente | **Inconclusiva** | Mecanismo reproduzido; sem item, catálogo e score originais |
| Banco `mercadao(4).db` errado ou sem o produto | **Não avaliada** | Não foi aberto; a hipótese não pode ser confirmada nem descartada |

Nenhuma hipótese foi confirmada.

## 4. Testes executados e resultados reais

Reexecução dos testes existentes, sem novos testes sintéticos (nenhuma hipótese nova exigia deles):

| Comando | Resultado |
|---|---|
| `node tests\miip\miip-origin-isolated-harness.test.js` (`NODE_ENV=test`) | **17 passou, 0 falhou** |
| `node tests\miip\miip-origin-diagnostics.test.js` | **8 passou, 0 falhou** |
| `node tests\shared\nfe\nfe-parser.test.js` | **6 passou, 0 falhou** |

Prova de isolamento do harness nesta execução: `{"arquivoProibidoCarregado":[],"sqliteAbertos":16,"sqliteSomenteMemoria":true,"bloqueiosDeModulo":3,"bloqueiosDeArquivoBanco":2,"arquivosCriadosNoDiretorioTemporario":0,"modulosDoProjetoCarregados":120}`.

## 5. O score de 58%: reproduzido ou apenas lido?

**Não foi reproduzido e não foi lido de nenhum registro.** Nenhum motor produziu 58 em dados sintéticos (os scores calculados nas fixtures foram 100, 82 e 100; o 71 da fixture D é valor de entrada). Não há resultado persistido da ocorrência. Não se sabe se o 58% foi calculado naquela execução ou reutilizado de um resultado anterior.

## 6. Limitações

- Sem documento da ocorrência (`documentoId`, `operacaoId`), sem `miip_resumo_json`/`parse_json`, sem linha de `produtos` do `produto_id`, sem `miip_associacoes` e sem eventos `[MIIP_ORIGIN_DIAG]`/`campos_identidade_ui`.
- Nenhuma cópia autorizada de banco foi disponibilizada; `mercadao(4).db` e `backend\banco\mercadao.db` não foram usados.
- O comportamento da tela só foi lido, não executado (HTTP 403 não contornado).
- Cache de uma sessão passada é irrecuperável.
- Os dados sintéticos provam mecanismos, não a ocorrência; nenhum registro foi inventado nem score forçado.

## 7. Dado mínimo que fecharia o diagnóstico (se um dia for autorizado)

Uma exportação minimizada de **um** documento: `documentoId`, `operacaoId`, `miip_resumo_json` (item selecionado) e a linha de `produtos` do `produto_id`; ou os eventos `[MIIP_ORIGIN_DIAG]` capturados durante uma reabertura da tela com a flag de teste. Sem isso, a investigação não avança além do já demonstrado.

## 8. Declarações

- Nenhum banco operacional foi aberto, copiado ou consultado (`backend\banco\mercadao.db`, `%ProgramData%\MercantilFiscal\dados` e `mercadao(4).db` não foram acessados). Apenas `:memory:` nos testes.
- Nenhum serviço SEFAZ foi acessado; nenhum HTTP 403 foi contornado.
- Nenhum backend, Electron ou ERP foi iniciado nesta sprint.
- Nenhum código de produção, peso, score, motor, cache ou regra foi alterado; nenhum arquivo de teste ou fixture foi alterado nesta sprint (só este relatório foi criado). Nenhum commit, push, merge ou reset.

## 9. Decisão e recomendação

**Investigação encerrada como inconclusiva.** A causa do candidato `Refrigerante Cola 2L / ABC001 / 7891234567890 / 58%` não foi identificada. A coincidência exata dos três valores com o item da NF-e de amostra do repositório é um fato registrado, mas não prova a origem. Recomenda-se retomar as próximas prioridades do produto. A instrumentação opt-in, o harness e as fixtures permanecem disponíveis caso a ocorrência volte a aparecer com dados autorizados.
