# Sprint MIIP V2 — Auditoria da origem do candidato e possível cache

**Tipo:** auditoria somente leitura; nenhuma correção funcional foi aplicada.  
**Conclusão:** há mecanismos comprovados de reutilização de resultados persistidos e caches de produto sem TTL que podem sustentar uma apresentação obsoleta. A causa específica do caso “Refrigerante Cola 2L / ABC001 / 7891234567890 / 58%” não pôde ser comprovada porque o arquivo `mercadao(4).db`, o identificador do documento e o resultado MIIP persistido dessa execução não estavam disponíveis nesta sessão.  
**Banco de produção:** não acessado.

## 1. Resumo executivo

A tela MIIP V2 não busca novamente o candidato ao selecionar cada item. Ela recebe `dadosImportacao` da Central, monta as pendências a partir de `dadosImportacao.miip_importacao.resultados` e apresenta o produto encontrado/candidato já contido nesse resultado.

Na abertura da revisão, a Central também carrega `/api/produtos` e fornece essa listagem à tela. Entretanto, `enriquecerProdutoCds` mescla a listagem com o resultado MIIP usando precedência do objeto do candidato nos campos de identidade. Se o candidato persistido não estiver mais na listagem, o painel ainda pode apresentá-lo a partir do resultado MIIP. Se o mesmo ID estiver na listagem com nome/código/GTIN atualizados, os valores antigos do candidato prevalecem para esses campos. O preço, estoque e outros campos de catálogo podem vir da listagem atual.

O fluxo Central pode reutilizar o resumo MIIP gravado em `central_documentos.miip_resumo_json` quando parser e resultado MIIP já existem e não há opção `forcar`. Não há atualização automática do candidato apenas por abrir a tela.

Além disso, `ProdutoRepository` usa um singleton `ProdutoCache` por ID e GTIN, sem TTL; os métodos de busca consultam esse cache antes do SQLite. Em teste com SQLite `:memory:`, ficou demonstrado que uma busca por ID continua retornando o snapshot depois de a linha ser excluída do banco. O código pesquisado não mostrou invalidação desse cache nos fluxos usuais de alteração de produtos. Isso comprova uma possibilidade técnica de dado antigo, mas não prova que o cache participou desta ocorrência.

Os três valores também estão juntos em fixtures NF-e do repositório (`cProd=ABC001`, `cEAN=7891234567890`, `xProd=Refrigerante Cola 2L`). Isso confirma a presença desses valores nos exemplos de teste e não demonstra que a tela observada usou uma fixture. O parser os expõe como código do fornecedor, GTIN e descrição XML. O campo “Código Interno” do painel é exibido a partir do objeto do candidato CDS, não do rótulo do XML.

O valor exibido “58%” vem de `pendencia.score`, arredondado para inteiro. É um score MIIP apresentado sob o rótulo “Confiança”; o código não o recalcula ao renderizar o item, nem o define como probabilidade calibrada.

**Diagnóstico final:** causa raiz específica **inconclusiva**. Reutilização de MIIP persistido e cache de produto antigo são causas possíveis sustentadas por código e teste isolado. Também é possível um candidato atual encontrado por MUBC/similaridade/NCM com identificadores diferentes. Sem o registro da sessão, o `produto_id`, o motor/evidências e o estado da fonte consultada naquela execução, não é seguro escolher uma hipótese.

## 2. Fluxo completo

```text
XML
  → NFeParserService.parse()
  → enriquecerParseComMiip()
      → MiipService.processarImportacaoXml()
          → MiipImportacaoXmlService.processar() item a item
          → MiipService.identificar()
          → Pipeline/DecisionEngine e engines
      → MIP complementar para itens sem produto_id
  → CentralProcessamentoService persiste parse_json e miip_resumo_json
  → CentralComprasBridgeService.montarPayloadAbrirCompra() lê parse persistido
  → navegador busca GET /api/produtos e abre MIIP V2 com dadosImportacao
  → montarSessao() extrai pendências do resultado MIIP recebido
  → renderComparacaoV2() escolhe produtoEncontrado/candidatoSelecionado
  → enriquecerProdutoCds() mescla snapshot MIIP e catálogo atual por produto_id
  → renderPainelCds() apresenta nome, código, GTIN e demais campos
```

### 2.1 XML e processamento MIIP/MIP/MUC

`NFeParserService` transforma os campos da NF-e. No fluxo de enriquecimento:

1. `enriquecerParseComMiip` obtém o singleton de `MiipService` e chama `processarImportacaoXml(parsed)`.
2. `MiipImportacaoXmlService.processar` percorre os itens sequencialmente, forma o item identificável com `mapearItemCompraParaIdentificavel` e chama `MiipService.identificar`.
3. `MiipResultadoImportacaoMapper` mapeia a decisão e os candidatos para `produtoEncontrado`, `candidatoSelecionado`, `candidatos`, `score` e `motor`.
4. O mesmo resultado é incluído no parse do item (`item.miip_resultado`) e no resumo de importação. Candidatos automáticos também podem definir `produto_id`.
5. Depois, o passo MIP complementar tenta resolver identificadores para itens sem `produto_id`. Em caso de conflito com associação MIIP automática, converte a situação em revisão manual. O resultado MIP complementar fica em `item.mip_resultado`; não é a origem padrão do painel MIIP que usa os resultados de `miip_importacao`.

**MUC não é fonte do candidato nesse caminho.** A conversão de unidades não participa da busca que preenche `produtoEncontrado`. O código MIIP XML executa uma análise MIE de embalagem, mas essa análise apenas adiciona sugestão de embalagem ao item.

### 2.2 Motores e fontes de candidato

O bootstrap MIIP registra, entre outros:

- **MotorGTIN:** consulta `ProdutoRepository.buscarPorGtin`. A ordem documentada é cache, MIP (quando habilitado) e fallback legado em `produtos.codigo_barras`.
- **MotorAssociacaoFornecedor:** procura associação em `miip_associacoes` por CNPJ do fornecedor e código do fornecedor; depois carrega o produto pelo ID com `ProdutoRepository.buscarPorId`.
- **MUBC:** consulta `produtos` e `marcas` via `ProdutoRepository.buscarCandidatosUniversais`. A consulta pode incluir GTIN exato/parcial, código do fornecedor, código interno, PLU, tokens de descrição, sinônimos, marca, NCM e CEST. O score do MUBC combina esses motivos e unidade/embalagem.
- **MotorSimilarity:** participa do pipeline conforme configuração do registro. Não foi possível atribuir o candidato concreto a esse motor sem `motor`, `evidencias`, `motoresQueVotaram` e `atributosExtraidos` da sessão real.
- **MIP:** pode resolver identificadores registrados em `produto_identificadores` para um produto, por meio do passo complementar e também pelo caminho MIP chamado pelo repository ao procurar GTIN.
- **Associações anteriores:** `miip_associacoes` é uma fonte persistida possível para o motor do fornecedor. O motor carrega o produto associado; uma associação isolada não basta para afirmar que foi a fonte efetiva.

O `ProdutoSnapshot` usado pelos motores é criado a partir de uma linha de produto (em algumas consultas, com join de marca). Builders conhecidos formam o `produtoId` e os campos do candidato a partir desse snapshot. Isso tende a manter identidade do candidato coerente quando o fluxo é executado normalmente. Ainda assim, essa leitura do código não prova a consistência do objeto já persistido no banco analisado nem impede estado antigo.

### 2.3 API, persistência e estado de interface

- `CentralProcessamentoService` pode pular parser e/ou MIIP se o documento já possui `parseJson` e `miipResumoJson` válidos e não há `forcar`.
- Quando processa novamente, grava o parse atualizado e o resumo MIIP no documento.
- `CentralComprasBridgeService.montarPayloadAbrirCompra` retorna o parse persistido em `dadosCompra`; abrir o painel de revisão não reexecuta o MIIP.
- `abrirRevisaoMiipCentral` obtém `payload-compra`; `abrirCentralRevisaoMiip` carrega a listagem de produtos em `GET /api/produtos` e passa ambos para `MiipCentralRevisao.iniciar`.
- `montarSessao` deriva pendências de `miip_importacao.resultados`. `renderComparacaoV2` seleciona `pendencia.produtoEncontrado` ou `pendencia.candidatoSelecionado.produto`.
- `renderPainelCds` exibe `produto.nome`, `produto.codigo` e `produto.codigoBarras`/`codigo_barras`.
- `renderPainelCentro` apresenta `pendencia.score`; `barraConfianca` limita e arredonda o score antes de exibir a porcentagem.

## 3. Origem dos campos exibidos

| Campo apresentado | Origem no código | O que se pode afirmar |
|---|---|---|
| Descrição `Refrigerante Cola 2L` | Painel CDS usa `produto.nome` do candidato MIIP; o XML também contém essa descrição em fixtures. | Sem o resultado MIIP real, não é possível decidir se a tela usou a descrição do registro CDS ou um resultado antigo. |
| Código `ABC001` | Painel CDS usa `produto.codigo` do candidato. O XML de exemplo contém o mesmo valor em `cProd`, que o parser mapeia para `codigo_fornecedor`. | O código exibido como interno vem do objeto CDS; o valor igual no `cProd` XML não prova que seja o campo interno do cadastro nem que tenha sido a chave efetiva. |
| GTIN `7891234567890` | Painel CDS usa `codigoBarras`/`codigo_barras` do candidato. O mesmo GTIN está em `cEAN` da fixture XML. | Não foi comprovado se veio do registro atual, de um snapshot MIIP persistido ou de cache. |
| ID do produto | `produtoEncontrado.id` mapeado do `produtoId` do candidato; painel requer `produto.id`. | O `produto_id` concreto do caso não foi informado/disponibilizado, impedindo comparação com a base de seis produtos. |
| `58%` | `pendencia.score` derivado do resultado MIIP e renderizado por `barraConfianca`. | A interface mostra score arredondado, não um cálculo novo ao trocar item. Sem resultado/engine original, não se pode reconstituir os 58 pontos. |

`enriquecerProdutoCds` procura a listagem atual pelo ID, aplica `{ ...full, ...produtoBase }` e explicita novamente os campos de identidade com preferência do objeto-base MIIP. Foi executado um teste puro em Node com listagem ausente e com dados atuais divergentes: nome, código e GTIN do snapshot MIIP permaneceram no resultado visual em ambos os casos. Isso demonstra que a listagem atual não é uma validação obrigatória da identidade do candidato.

## 4. Cache, histórico e estado antigo

| Hipótese | Evidência e alcance | Situação |
|---|---|---|
| Resultado MIIP persistido é reutilizado | `CentralProcessamentoService` reconstrói `miipImportacao` a partir de `documento.miipResumoJson` e pula a etapa quando parse e MIIP já estão válidos e `forcar` não foi solicitado. O payload de abertura reutiliza o parse persistido. | **Confirmado no código.** Pode manter decisão anterior mesmo após alteração do cadastro; não prova que ocorreu neste documento. |
| Cache de produtos MIIP devolve objeto antigo | `ProdutoCache` é singleton com mapas por ID e GTIN; `buscarPorId` e `buscarPorGtin` retornam hit antes de consultar SQLite. Não tem TTL. A busca textual encontrou uso operacional em `ProdutoRepository`, sem chamada de invalidação nos fluxos de edição/exclusão pesquisados. | **Confirmado no código.** Um teste SQLite `:memory:` carregou produto, excluiu a linha e demonstrou que a próxima busca por ID devolveu o snapshot do cache. Possibilidade comprovada, causalidade do caso não comprovada. |
| Cache MIP | `ProdutoIdentidadeCatalogo` cria `MipLookupCache(500)`, com LRU e sem TTL. Ele guarda resultado por ID, código interno, código de barras e identificador; a invalidação exposta é `limparCache()`. | **Confirmado como mecanismo.** A permanência exata depende da instância de `ProdutoIdentidadeService` que executou o lookup. Não há prova de que esse cache tenha fornecido o painel em questão. |
| Cache da revisão no navegador para candidato/score | As preferências persistidas em `localStorage` são filtro, ordenação, painéis e modo de foco. A revisão guarda a sessão em memória recebida ao iniciar; a lista de produtos é buscada na abertura. Não foi encontrado armazenamento local de candidato ou score por GTIN/código/chave NF-e. | **Não encontrado no código inspecionado.** |
| Cache/in-flight de últimas compras | Existe cache temporário por `produto_id` e promessas in-flight para o cartão “Últimas Compras”; é iniciado a partir de ID e não é a fonte de `produtoEncontrado` ou da barra de score. | **Existe, mas não explica diretamente o candidato/score.** |
| Promessa/resultado de candidato antigo ao trocar item | A renderização da comparação usa o item/pendência selecionados no estado local. A troca de item renderiza novamente a sessão. Não foi localizada chamada assíncrona para refazer a busca de candidato na troca. As chamadas assíncronas identificadas atendem histórico de compras ou busca manual de produtos. | **Não há evidência de corrida de candidatos no fluxo de exibição padrão.** Não foi possível validar em navegador por bloqueio 403. |
| Resposta HTTP de candidato armazenada/reutilizada | O painel não chama endpoint de identificação ao abrir/trocar item; recebe o objeto MIIP do payload de abertura. A listagem `GET /api/produtos` é solicitada ao abrir a revisão. Não foram inspecionados cabeçalhos HTTP do app funcional. | **Cache de resposta não comprovado.** |
| Associação histórica fornecedor-produto | `miip_associacoes` pode alimentar `MotorAssociacaoFornecedor`, filtrada por fornecedor/código, e depois carregar o produto pelo ID. | **Fonte possível confirmada; associação concreta não pode ser verificada sem o banco/resultados reais.** |
| MUBC/similaridade com GTIN divergente | Repositório pode buscar por descrição, NCM, CEST, sinônimos, marca e outros campos, além de identificadores. A divergência de GTIN pode produzir score de revisão, mas não prova identidade nem diferença. | **Comportamento possível confirmado; candidato e score concretos não reproduzidos.** |

O estado principal da revisão é refeito em `MiipCentralRevisao.iniciar`. Os itens da sessão são clonados; a lista de pendências é derivada do resultado de importação recebido. O cache local de últimas compras não deve ser confundido com cache de candidato.

## 5. Banco e conexão efetiva

### Código de resolução

- `electron.js` define `process.env.DB_DIR` se ainda não existir; o default do aplicativo desktop é `%ProgramData%\MercantilFiscal\dados`.
- `backend/database.js` chama `exigirAberturaDatabaseModule()` antes de abrir SQLite e usa o resultado para conectar a `DB_DIR\mercadao.db`. A resolução aceita `DB_DIR` explícito; no processo protegido de teste, exige caminho temporário e recusa o fallback oficial.
- A rota de produtos importa `backend/database.js` e faz sua listagem diretamente por essa conexão.
- O MIIP padrão recebe a conexão pelo `MiipBootstrap`; o repository de produtos usa a conexão injetada. Os repositories podem resolver `backend/database.js` quando uma dependência DB não é fornecida.
- O MIP complementar da Central mantém um serviço de identificação lazy no processo; em teste, recebeu conexão temporária ou direta, conforme o teste.
- No código pesquisado, a consulta de candidatos não seleciona um arquivo `mercadao(4).db` por nome. O nome de trabalho do banco operacional é `mercadao.db`; outro arquivo só seria usado se o processo tivesse recebido outra configuração `DB_DIR` ou instância DB injetada.

### Limite da verificação do caminho

Não foi consultado o `DB_DIR` do processo operacional nem aberto qualquer arquivo de banco. O arquivo `mercadao(4).db` não estava no workspace nem nos diretórios de Downloads/Temp pesquisados nesta sessão; não foi acessado. Portanto, o caminho real usado na execução que mostrou o candidato e a correspondência entre esse arquivo e a conexão backend atual ficam **não comprovados**.

Os testes que exigiram conexão de serviço foram executados com `DB_DIR` temporário e caminhos de arquivos temporários criados pelo próprio teste. O teste isolado de cache usou exclusivamente SQLite `:memory:`.

## 6. Causa raiz e avaliação do candidato

### Evidências comprovadas

1. Os valores `ABC001`, `7891234567890` e `Refrigerante Cola 2L` aparecem juntos no XML de fixture `tests/central-entradas/fixtures/rc64-proc-nfe.xml` e no XML de amostra do parser.
2. O parser mapeia esses campos como código do fornecedor, GTIN e descrição XML.
3. MIIP pode armazenar candidato/score na importação e esse resultado fica persistido junto ao documento.
4. A tela favorece os campos de identidade do resultado MIIP sobre a listagem atual de produtos.
5. Existe cache MIIP por ID/GTIN sem TTL; o caso de snapshot obsoleto após exclusão foi demonstrado em banco em memória.
6. MUBC pode sugerir candidato por semelhança de descrição e atributos fiscais mesmo quando os identificadores são diferentes.
7. A barra de `58%` apenas reflete o score carregado no resultado e o arredonda para apresentação.

### O que continua inconclusivo

- Qual `produto_id` foi apresentado.
- Se a origem do candidato foi `motor_gtin`, `motor_associacao_fornecedor`, MUBC ou outro engine.
- Se `ABC001` e o GTIN estavam no mesmo produto no momento da execução MIIP.
- Se descrição/código/GTIN vieram de uma linha atual, de snapshot armazenado anteriormente ou de um arquivo diferente.
- Se houve alteração/exclusão do produto entre identificação e abertura da revisão.
- Se o resumo MIIP do documento foi reutilizado ou reprocessado.
- Quais motivos de relevância, evidências, motores e scores parciais levaram aos 58 pontos.
- Se a divergência entre o banco analisado anteriormente e o backend aconteceu por cache, caminho/contexto de banco, resultado histórico ou outro motivo.

**Não é seguro atribuir causa raiz ao cache.** Cache e reaproveitamento persistido são explicações demonstráveis, mas o caso concreto exige a cópia isolada do documento/resultados MIIP e metadados de caminho obtidos sem abrir o banco oficial.

## 7. Testes e validações

| Teste/comando | Resultado |
|---|---|
| `node tests/miip/miip-central-revisao.test.js` | **10 passaram, 0 falharam.** Sessão/pendências MIIP; teste de lógica sem banco. |
| `node tests/miip/miip-gtin-pipeline.test.js` | **5 passaram, 0 falharam.** Pipeline GTIN com repository mock. |
| `node tests/miip/motor-mubc.test.js` | **13 passaram, 0 falharam.** MUBC e relevância com catálogo mock. |
| `node tests/produto-identidade/mip-sprint03-miip.test.js` | Primeira execução bloqueada antes de abrir SQLite porque o guardião exige `DB_DIR` temporário em contexto de teste. Reexecutado com `DB_DIR` temporário: **6 ok, 0 falhas**. A pasta temporária foi removida após o teste. |
| `node tests/shared/nfe/nfe-parser.test.js` | **6 passaram, 0 falharam.** Confirmou que a fixture gera `cProd=ABC001`, `cEAN=7891234567890`, descrição `Refrigerante Cola 2L`, `codigo_fornecedor=ABC001` e `codigo_barras=7891234567890`. |
| Diagnóstico Node com `sqlite3.Database(':memory:')` + `ProdutoRepository.buscarPorId` | **Demonstrado:** após carregar e excluir um produto no banco em memória, `buscarPorId` retorna snapshot cacheado até limpar o singleton. O cache foi limpo e a conexão em memória fechada no fim. |
| Diagnóstico Node puro de `enriquecerProdutoCds` | **Demonstrado:** os campos de identidade do snapshot MIIP prevalecem sobre produto atual divergente e também são apresentados quando a listagem atual não contém o ID. |
| Navegador/execução da tela MIIP V2 | **Não executado.** A página ERP compartilhada registrou respostas HTTP 403 em recursos de inicialização/dashboard. Não houve tentativa de contornar acesso. |
| Consulta do banco `mercadao(4).db` e comparação dos seis registros | **Não executada.** Arquivo não disponível nos locais pesquisados; banco oficial também não foi acessado. |
| Reexecução de identificação contra o catálogo exato do caso, concorrência assíncrona real e inspeção de associação histórica | **Não executados.** Dependem do documento/fixtures e banco temporário do caso. |

Nenhum teste nesta auditoria alterou o banco oficial, enviou operação fiscal ou chamou SEFAZ.

## 8. Recomendação para próxima sprint (não implementada)

1. Disponibilizar uma cópia autorizada e isolada do `mercadao(4).db` (ou export somente leitura dos seis produtos relevantes) e o `documentoId`/chave de teste. Não fornecer credenciais nem usar o banco de produção.
2. Extrair, sem PII desnecessária, do resultado persistido: `produto_id`, `produtoEncontrado`, `candidatoSelecionado`, `score`, `motor`, `evidencias`, `motoresQueVotaram`, `atributosExtraidos`, `operacaoId` e data do processamento.
3. Comparar esse snapshot com o produto de mesmo ID e os identificadores vigentes no banco isolado. Verificar também se `miip_resumo_json` antecede alteração de catálogo e se houve associação ativa para o fornecedor/código.
4. Na etapa de implementação, priorizar a menor salvaguarda após a origem ser confirmada: revalidar o candidato persistido contra o produto atual por ID ao abrir a revisão; sinalizar candidato ausente/alterado como obsoleto e exigir nova revisão, sem associação automática. Separadamente, planejar invalidação dos caches MIIP/MIP nas operações de alteração/exclusão de produto.
5. Não recalcular ou promover a confiança usando GTIN divergente. Manter o caso como revisão manual até explicar os motivos que produziram a sugestão.
6. Acrescentar teste de regressão com banco temporário que cubra: snapshot MIIP válido; produto removido após identificação; produto alterado após identificação; reabertura de resultado persistido; e conflito entre GTIN/código e candidato textual. O teste deve validar identidade e score de origem sem chamar SEFAZ.

## 9. Arquivos e preservação

**Relatório criado:** este arquivo.  
**Arquivos de produção alterados:** nenhum.  
**Testes de produção alterados:** nenhum.  
**Workspace preexistente:** preservado; a auditoria não editou ou reverteu alterações locais existentes.

- Nenhum dado ou schema de banco foi alterado.
- O banco oficial `%ProgramData%\MercantilFiscal\dados\mercadao.db` não foi aberto, consultado, migrado nem alterado.
- Não houve operação real na SEFAZ.
- Não houve commit, push, merge, reset, checkout destrutivo ou rebase.
- Nenhuma cache, associação ou dado persistido foi apagado no ambiente da aplicação. O teste isolado limpou somente a instância de cache carregada no processo de teste e fechou a conexão SQLite em memória.
- Nenhuma sprint de implementação foi iniciada.

**Decisão recomendada:** manter a correção funcional bloqueada até obter os metadados da ocorrência e validar contra catálogo isolado. As evidências atuais justificam investigar resultado persistido e cache, mas não bastam para declarar uma causa única.
