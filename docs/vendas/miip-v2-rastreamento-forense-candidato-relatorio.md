# Sprint MIIP V2 — Rastreamento forense do candidato ABC001

**Tipo:** auditoria e reprodução isolada; nenhuma alteração funcional.

**Conclusão da ocorrência:** **INCONCLUSIVA**. Foram reproduzidos mecanismos compatíveis com a apresentação de candidato persistido, cache obsoleto, associação por fornecedor e busca textual/NCM com GTIN divergente. Nenhum reproduziu a ocorrência concreta porque não há cópia autorizada identificada nem resultado original da MIIP disponível nesta sessão.

**Banco oficial:** não acessado.

## 1. Escopo e evidência disponível

O caso a explicar é a exibição de:

- Produto: `Refrigerante Cola 2L`
- Código interno exibido: `ABC001`
- GTIN exibido: `7891234567890`
- Score exibido: `58%`

A auditoria anterior rastreou o fluxo completo XML → MIIP/MIP → persistência Central → payload → MIIP V2, incluindo a precedência do snapshot MIIP na interface. Este relatório aprofunda as hipóteses com testes reproduzíveis em SQLite `:memory:` e registra o limite forense da ocorrência.

Foi encontrado no workspace o caminho `backend\banco\mercadao.db` (aprox. 1,34 MB), ignorado pelo Git pela regra `*.db`. Não há evidência disponível de sua procedência, isolamento, conteúdo ou autorização como cópia do caso. Também não é o arquivo `mercadao(4).db` citado na auditoria inicial. **O arquivo não foi aberto nem consultado**; portanto, não foi tratado como cópia autorizada.

Nenhuma cópia autorizada ou export mínimo foi disponibilizado. Também não foram fornecidos `documentoId`, resultado original de `miip_resumo_json`, `produto_id` ou metadados de processamento da ocorrência.

## 2. Método e isolamento

As reproduções foram executadas em um processo Node separado, com SQLite `:memory:` e registros inteiramente sintéticos. As instâncias de `ProdutoRepository`, `CentralDocumentosRepository`, `CentralProcessamentoService`, `MotorAssociacaoFornecedor` e `MotorUniversalBuscaCandidatos` receberam a conexão em memória por injeção.

Os casos de cache usaram somente o singleton carregado naquele processo de teste; ele foi limpo ao final e a conexão em memória foi fechada. Nenhum cache do aplicativo em execução foi acessado ou invalidado. Não foram criados arquivos de banco temporários, fixtures persistentes ou arquivos de teste.

Para o teste de reabertura Central, foi criada em memória uma linha sintética em `central_entradas_documentos`; parser e enriquecimento MIIP foram instrumentados para falhar se chamados. O serviço retornou `reutilizado=true`, manteve o resultado persistido e não chamou nenhum dos dois processadores.

## 3. Resultado por hipótese

| # | Hipótese/cenário | Reprodução isolada | Resultado e alcance |
|---|---|---|---|
| 1 | Resultado MIIP persistido com produto ainda válido | Produto sintético ID 41 com descrição, código e GTIN do cenário foi passado à função de enriquecimento usada pela UI; score sintético 58 foi passado à função de barra. | **Reproduzido como mecanismo:** a função preservou os campos de identidade e apresentou score 58. Não demonstra que o ID 41 ou esses dados vieram da ocorrência real. |
| 2 | Produto removido após identificação | `ProdutoRepository.buscarPorId(41)` carregou snapshot; a linha foi removida de `produtos`; uma segunda busca retornou o snapshot cacheado, enquanto consulta direta em `:memory:` confirmou ausência da linha. | **Reproduzido:** hit por ID pode continuar fornecendo dados após remoção no banco conectado. Não há vínculo com a sessão original. |
| 3 | Produto alterado após identificação | Produto sintético ID 42 foi carregado; nome/código/GTIN foram alterados na linha SQLite; nova busca retornou o snapshot anterior. Após limpar somente o cache do processo de teste, a busca retornou o nome atualizado. | **Reproduzido:** um cache aquecido pode divergir do registro atual. O cache por ID/GTIN foi a diferença observada. |
| 4 | Resultado persistido reaberto sem reprocessamento | `CentralProcessamentoService` foi executado contra `CentralDocumentosRepository` e documento sintético em SQLite `:memory:`, em status `EM_REVISAO`, com `parse_json` e `miip_resumo_json`. | **Reproduzido:** serviço retornou `reutilizado=true`, preservou resultado/score persistidos e não executou parser nem MIIP. |
| 5 | Cache contém snapshot anterior | Testado por ID no cenário 3 e por GTIN separadamente: depois de carregar produto sintético ID 91 por `7890000000091`, linha atualizada para outro nome e GTIN, a busca pelo GTIN antigo devolveu o snapshot antigo. | **Reproduzido:** ambos os índices do cache podem reter identidade anterior no processo que já carregou o produto. A limpeza ocorreu apenas no processo isolado ao terminar. |
| 6 | Associação histórica de fornecedor | Inserida em SQLite `:memory:` uma associação ativa sintética para fornecedor de teste + `cProd=ABC001`, apontando para produto sintético ID 43. O motor real foi executado com essas dependências injetadas. | **Reproduzido:** `MotorAssociacaoFornecedor` retornou produto 43 e evidência de origem `MiipAssociacoesRepository`. Não há evidência de que a associação do caso real exista ou tenha sido usada. |
| 7 | Candidato textual/NCM com GTIN divergente | MUBC e `ProdutoRepository` reais consultaram produto sintético ID 44, com descrição/NCM correspondentes, GTIN cadastrado `1111111111111` e GTIN do item `7891234567890`, além de código do fornecedor diferente. | **Reproduzido:** candidato retornado com motivo de descrição e score 74; GTIN divergente. O score não foi 58 e a entrada era sintética. Isso demonstra a possibilidade do mecanismo, não a origem/score do caso. |

Os sete cenários demonstram mecanismos independentes ou sobrepostos. **Nenhum foi comparado aos dados originais da ocorrência.** Em particular, o score 58 do cenário 1 foi um valor de fixture para verificar a apresentação, não um score recalculado pelo motor. O score 74 do cenário 7 pertence apenas ao conjunto sintético usado nessa busca MUBC.

### 3.1 Origem dos identificadores

Os valores `ABC001`, `7891234567890` e `Refrigerante Cola 2L` já aparecem juntos em fixtures NF-e do repositório. O parser mapeia esses valores como `cProd`/código do fornecedor, GTIN (`cEAN`) e descrição de item XML. A UI, por sua vez, exibe `produto.codigo` como código interno do candidato CDS e `produto.codigoBarras` como GTIN do candidato.

A igualdade textual entre `cProd=ABC001` e o código interno mostrado não comprova que a tela exibiu o valor do XML como código interno. O objeto do resultado MIIP e o ID do produto são necessários para decidir se `ABC001` veio do cadastro CDS, do `cProd`, ou se a igualdade é coincidência. O teste sintético da associação usou `ABC001` como `codigoFornecedor`, mas **não é prova de associação real**.

## 4. Interpretação do candidato e do score

O resultado da ocorrência ainda pode ter vindo de:

1. resultado MIIP já persistido e reutilizado pela Central;
2. snapshot anterior carregado pelo cache MIIP por ID ou GTIN;
3. associação ativa em `miip_associacoes`;
4. busca atual MUBC por descrição, NCM, CEST, marca ou outros sinais;
5. mais de uma fonte combinada na decisão/persistência.

Na tela, o objeto `produtoEncontrado` ou `candidatoSelecionado.produto` pode prevalecer sobre os campos de identidade da listagem atual. O score exibido é o score já carregado na pendência, arredondado/clampado na apresentação. Assim, a tela não fornece, por si só, prova de que os campos sejam atuais nem de que 58 represente uma probabilidade calibrada.

As reproduções não capturaram `motor`, `evidencias`, `motoresQueVotaram`, `atributosExtraidos`, ID de produto ou origem temporal do caso. Não é possível associar os quatro valores apresentados a uma linha específica do banco ou a um engine específico.

## 5. Testes existentes executados

| Comando | Resultado |
|---|---|
| `node tests/miip/motor-mubc.test.js` | **13 ok, 0 falharam.** Inclui descrição semelhante, GTIN parcial, código fornecedor/interno, NCM/marca e relevância. |
| `node tests/miip/motor-associacao-fornecedor.test.js` | **17 passaram, 0 falharam.** Inclui isolamento por CNPJ + `cProd`, associação ausente/inativa e produto ausente/inativo. |
| `node tests/miip/miip-central-revisao.test.js` | **10 passaram, 0 falharam.** Inclui composição de pendências, revisão mista e evidências do candidato. |
| Script diagnóstico Node em SQLite `:memory:` | **7/7 cenários sintéticos passaram**, conforme detalhamento na seção 3. |
| Comparação com a base do caso | **Não executada:** nenhuma cópia autorizada/export mínimo identificável foi disponibilizada; banco encontrado no workspace não foi aberto. |
| Inspeção do candidato real pela interface | **Não executada nesta etapa.** A auditoria anterior registrou HTTP 403; não foi contornado nem tentado contornar. |

Não foram alterados testes existentes nem código de produção.

## 6. Classificação da conclusão

**INCONCLUSIVA para a ocorrência concreta.**

Está **confirmado como comportamento do código** que:

- resultados de MIIP podem ser reutilizados sem reprocessamento;
- a interface pode apresentar campos de identidade do snapshot MIIP;
- caches do repository podem retornar snapshot antigo por ID ou GTIN após exclusão/alteração, no mesmo processo;
- associação histórica e busca textual/NCM podem fornecer candidato por mecanismos distintos.

Não está comprovado que qualquer um desses mecanismos tenha fornecido o candidato da ocorrência. Nenhum candidato real foi vinculado ao `produto_id`, e a reprodução textual sintética produziu 74, não 58. O fato de caches existirem não autoriza atribuir a causa ao cache.

## 7. Dado mínimo que falta para fechar o diagnóstico

Solicitar uma destas opções, sempre em ambiente/cópia autorizada:

1. **Preferível:** cópia de teste autorizada e isolada do banco que contém o documento e produto; ou
2. export mínimo anonimizado contendo:
   - resultado MIIP persistido daquele item: `produtoEncontrado`, `candidatoSelecionado`, `produto_id`, `score`, `motor`, `evidencias`, `motoresQueVotaram` e `atributosExtraidos`;
   - `documentoId` fictício/de teste ou identificador interno não sensível, status, timestamp e indicação se houve reprocessamento ou reutilização;
   - registro atual do mesmo `produto_id` (nome, código, GTIN, NCM, CEST e contexto empresa necessário);
   - associação correspondente em `miip_associacoes`, se existente, removendo CNPJ/nome do fornecedor e demais dados pessoais não necessários; pode-se preservar um hash estável no lugar do identificador do fornecedor para verificar igualdade.

Para provar snapshot/cache histórico, o dado mais decisivo é o `produto_id` e o resultado MIIP original com timestamp, comparados com o registro atual do mesmo ID e com o estado de catálogo na hora do processamento. Uma captura apenas da tela não discrimina persistência, cache, associação ou MUBC.

O arquivo `backend\banco\mercadao.db` encontrado no workspace não foi usado: sua origem e autorização não foram confirmadas. A cópia `mercadao(4).db` referida anteriormente continua ausente.

## 8. Preservação e restrições

- Código funcional e serviços operacionais não foram alterados.
- Nenhum banco, schema, associação ou documento operacional foi aberto, migrado ou alterado.
- `backend\banco\mercadao.db` não foi aberto nem consultado.
- Banco oficial `%ProgramData%\MercantilFiscal\dados\mercadao.db` não foi acessado.
- Nenhuma operação real na SEFAZ foi executada.
- Nenhuma tentativa de contornar HTTP 403 foi feita.
- Nenhum cache da aplicação em execução foi limpo ou invalidado; os caches manipulados foram apenas da instância isolada de teste, encerrada ao final.
- Não houve commit, push, merge, reset, rebase ou checkout destrutivo.
- As alterações locais preexistentes foram preservadas.
- Não foi iniciada correção funcional.

**Próxima decisão:** obter o dado mínimo da seção 7 antes de atribuir causa à persistência, ao cache, à associação histórica ou ao MUBC. Até lá, manter o caso como inconclusivo e sem implementação.
