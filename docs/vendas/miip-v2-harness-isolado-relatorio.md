# MIIP V2 — Harness isolado de identificação

**Resultado:** harness independente criado e executado — **8 passou, 0 falhou**.  
**Ocorrência real `ABC001 / 58%`:** **não diagnosticada**. Todos os dados são sintéticos; este trabalho valida a instrumentação e o isolamento, não a origem do caso real.  
**Código funcional:** nenhuma regra MIIP/MIP/MUBC, cache, entrypoint ou banco foi alterado. O único arquivo novo de código é [miip-origin-isolated-harness.test.js](../../tests/miip/miip-origin-isolated-harness.test.js).

## 1. Auditoria de dependências

Foi usada uma sondagem descartável que **bloqueava** (lançava erro) qualquer carga de `backend/database.js`, `backend/server.js`, `electron.js` e `electron`, executada para cada componente. Todos carregaram sem acionar o bloqueio:

| Componente | Módulos do projeto carregados | Entrypoint proibido |
|---|---:|---|
| `MiipOriginDiagnostics` | 1 | nenhum |
| `ProdutoRepository` | 5 | nenhum |
| `ProdutoCache` | 1 | nenhum |
| `MotorAssociacaoFornecedor` | 17 | nenhum |
| `MotorUniversalBuscaCandidatos` (MUBC) | 24 | nenhum |
| `MipLookupCache` | 1 | nenhum |
| `ProdutoIdentidadeCatalogo` | 8 | nenhum |
| `MiipImportacaoXmlService` | 12 | nenhum |
| `CentralProcessamentoService` | 65 | nenhum |
| `miip-central-revisao-inteligente.js` (frontend) | 1 | nenhum |

O harness completo carrega 119 módulos do projeto, sem nenhum dos entrypoints proibidos.

### Pontos onde o banco operacional poderia entrar (não importados)

Os únicos `require` de `database` dentro de `backend/motores/miip`, `backend/motores/produto-identidade` e `CentralProcessamentoService` são lazy e ficam fora do grafo usado:

- `backend/motores/produto-identidade/index.js:58` — só se `deps.db` for nulo;
- `backend/motores/miip/MiipBootstrap.js:40` — só se `opcoes.db` for nulo;
- `backend/motores/miip/MiipService.js:254` e `:492` — só se `db` não for injetado;
- `backend/motores/miip/repositories/dbHelpers.js:16` (`resolverDb`) — só se `db` for nulo.

`MiipBootstrap`, `MiipService` e `produto-identidade/index.js` **não são importados** pelo harness. `ProdutoRepository` e os motores recebem `db` por injeção explícita.

## 2. Entrypoints importados e recusados

**Importados** (todos sem efeito colateral de banco): `MiipOriginDiagnostics`, `ProdutoRepository`, `ProdutoCache`, `MotorGTIN`, `MotorAssociacaoFornecedor`, `MotorUniversalBuscaCandidatos`, `MipLookupCache`, `ProdutoIdentidadeCatalogo`, `CentralProcessamentoService`.

**Recusados** pelas guardas do harness, instaladas antes de qualquer import do projeto:

- `backend/database.js`, `backend/server.js`, `electron*.js` na raiz e o módulo `electron` — `Module._load` lança `HARNESS_GUARD`;
- `new sqlite3.Database(<qualquer caminho>)` — só `:memory:` é aceito; qualquer outro valor lança erro **antes** de abrir;
- `fs.openSync`, `readFileSync`, `createReadStream`, `open` e `copyFileSync` sobre `*.db`, `*.sqlite`, `*.db-wal`, `*.db-shm` — lançam erro.

As guardas são verificadas por **controles negativos** no cenário 0: o harness tenta carregar `database`, `server` e `electron`, abrir um `.db` em arquivo e lê-lo, e exige que cada tentativa seja bloqueada e que nenhum arquivo seja criado. Não foi usado `backend\banco\mercadao.db`, e nenhum arquivo `.db` existente foi aberto.

## 3. Tabelas mínimas criadas em memória

Cada cenário abre sua própria conexão `:memory:` e cria somente o necessário:

| Cenário | Tabelas |
|---|---|
| 1. GTIN | `produtos` |
| 2. MUBC | `produtos`, `marcas` |
| 3. Associação | `produtos`, `miip_associacoes` |
| 4. Persistido | nenhuma (repositório de documentos simulado em memória) |
| 5. Cache | `produtos` |
| 6. Sem metadados | nenhuma |

`produtos` inclui `preco_venda`, exigida pelo catálogo MIP. Não foi criado schema completo nem executada migração.

## 4. Cenários e resultados

Execução: `NODE_ENV=test; node tests\miip\miip-origin-isolated-harness.test.js` → **8 passou, 0 falhou**, exit 0. Os 8 itens são os 6 cenários, o cenário 0 de guardas e a prova final de isolamento.

| # | Cenário | Resultado | Verificação principal |
|---|---|---|---|
| 0 | Gate e controles negativos | OK | Gate só liga com `test` + flag + `DB_DIR` temporário; as 5 tentativas proibidas foram bloqueadas |
| 1 | Busca atual por GTIN | OK | Evento `resultado_item` com `novo_processamento`, fonte `busca_gtin`, `scoreOriginal` = score do candidato; lookup `gtin` com `cacheHit=false` |
| 2 | Descrição/NCM com GTIN divergente | OK | Candidato retornado só com fonte `busca_textual_ncm`; sem `busca_gtin` nem `associacao_fornecedor`; sem evidência `gtin_exato`; GTIN do catálogo difere do GTIN do item |
| 3 | Associação de fornecedor | OK | Fonte `associacao_fornecedor` registrada; evento sem CNPJ nem código do fornecedor |
| 4 | Persistido reutilizado | OK | `persistido_reutilizado`, `operacaoId` preservado, `scoreOriginal` 58; parser e MIIP não foram chamados; documento persistido idêntico antes e depois |
| 5 | Cache obsoleto | OK | Após `UPDATE` no catálogo, `ProdutoCache` por ID e por GTIN e `MipLookupCache` por GTIN devolveram o snapshot antigo; eventos registraram `cacheHit=true` com fonte `produto_cache`, sem a chave consultada |
| 6 | Sem metadados | OK | Fontes `["desconhecida"]`, `origemResultado` `desconhecida`, motor `null`, identidade `desconhecida`; origem não é inventada |

Em 1 a 3, o candidato produzido com a instrumentação ligada foi comparado a uma execução de referência com o diagnóstico **desligado**: o resultado é idêntico (produto, score, motor, evidências), e um snapshot completo de todas as tabelas em memória antes e depois da instrumentação é idêntico. A comparação ignora apenas `carregadoEm` e `timestamp` de evidência, carimbos de tempo regenerados a cada execução (a primeira versão do harness falhou por isso; foi um defeito do teste, não da instrumentação).

O cenário 5 mostra que o cache devolve um snapshot desatualizado, algo que o código já permite. Isso demonstra que a instrumentação **observa** o fenômeno, não que ele tenha ocorrido na ocorrência real.

Os eventos foram verificados contra vazamento: nenhum evento contém GTIN, código, nome, CNPJ ou `cProd` sintéticos.

## 5. Prova de que nenhum banco operacional foi aberto

Saída da prova final do harness (`HARNESS_PROVAS`):

```json
{"arquivoProibidoCarregado":[],"sqliteAbertos":7,"sqliteSomenteMemoria":true,"bloqueiosDeModulo":3,"bloqueiosDeArquivoBanco":2,"arquivosCriadosNoDiretorioTemporario":0,"modulosDoProjetoCarregados":119}
```

- `arquivoProibidoCarregado: []` — `database.js`, `server.js` e `electron*.js` não aparecem em `require.cache`;
- `sqliteAbertos: 7`, todos `:memory:` (`sqliteSomenteMemoria: true`): contagem feita pela guarda de `sqlite3.Database`; o mapeamento exato de conexões por cenário não foi detalhado;
- `bloqueiosDeModulo: 3` e `bloqueiosDeArquivoBanco: 2` correspondem **exatamente** aos controles negativos do cenário 0; qualquer bloqueio adicional reprovaria a asserção;
- `arquivosCriadosNoDiretorioTemporario: 0` — o `DB_DIR` temporário serve só de trava do gate; nenhum arquivo foi gravado nele, e o diretório é removido ao final. Nenhum diretório sobrou.

Complementarmente: `backend\banco\mercadao.db` e `git status` de `backend\banco` não foram tocados; a execução não gerou SEFAZ, HTTP nem navegador.

## 6. Limitações

- Prova que a **instrumentação e o código MIIP/MUBC isolados** funcionam com dados sintéticos; **não** prova a origem do candidato `ABC001 / 58%`.
- O cenário 4 simula o repositório de documentos em memória; não exercita a leitura real de `miip_resumo_json` e `parse_json` do banco.
- O harness cobre repositório, motores GTIN/associação/MUBC, caches MIIP e MIP, e `CentralProcessamentoService`. **Não** cobre o `MiipService` completo, `MiipBootstrap`, as rotas HTTP, o pipeline de decisão completo nem a renderização da tela; o evento `campos_identidade_ui` continua coberto apenas pelo teste anterior de diagnóstico.
- O `DB_DIR` temporário precisa existir apenas para satisfazer o gate; ele não representa um banco.
- Para executar uma fixture real isolada, o `ProdutoRepository` e os motores precisam receber a conexão por injeção; não há caminho pronto para apontar o harness para uma cópia em disco, e as guardas rejeitam propositalmente qualquer arquivo `.db`.
- Um hit de cache só pode ser comprovado no processo em que ocorre; o catálogo atual não reconstrói retroativamente um cache de uma execução anterior.

## 7. Procedimento para adicionar uma fixture autorizada no futuro

1. Obter autorização explícita e uma fixture **minimizada** (preferencialmente JSON/SQL), sem XML completo, CNPJ ou fornecedor reais; manter IDs internos necessários à correlação.
2. Incluir apenas: o item de teste (campos usados na identificação), a linha de `produtos` do `produto_id` candidato, as linhas relevantes de `miip_associacoes` e, se existir, o resultado MIIP persistido (`miip_resumo_json`, `parse_json`).
3. Carregar a fixture **em `:memory:`** por um cenário novo no harness, via `INSERT` das linhas, sem abrir arquivo `.db`. Se uma cópia em disco for realmente necessária, isso exige autorização e uma decisão separada para relaxar a guarda de arquivos; não deve ser feita por padrão.
4. Executar com `NODE_ENV=test` e a flag de diagnóstico; o harness aplica o gate e captura os eventos com `sink` em memória.
5. Reproduzir a sequência da ocorrência: persistido ou reprocessado, cache aquecido antes/depois de editar o catálogo, associação, e busca por descrição/NCM; comparar `origemResultado`, fontes, `scoreOriginal` e hits de cache com o que a UI exibiu.
6. Só então classificar (`PERSISTIDO_REUTILIZADO`, `CACHE_OBSOLETO`, `ASSOCIACAO_FORNECEDOR`, `BUSCA_ATUAL_MUBC_OU_SIMILARIDADE`, `FONTES_COMBINADAS` ou `INCONCLUSIVO`), registrando todas as fontes observadas.

## 8. Confirmações

- Nenhum banco operacional, `backend\banco\mercadao.db` ou cópia foi aberto; só `:memory:`.
- Nenhum Electron, servidor ERP ou navegador da aplicação foi iniciado; nenhum HTTP 403 foi contornado; nenhuma operação SEFAZ.
- Nenhuma regra MIIP/MIP/MUBC, cache, score, candidato ou entrypoint foi alterado; nenhum cache fora do processo de teste foi limpo.
- As alterações locais preexistentes foram preservadas. Nenhum commit, push, merge, reset ou checkout.

**Estado:** harness entregue e verde; a ocorrência real segue **inconclusiva**. Aguardando revisão antes de qualquer correção ou fixture real.
