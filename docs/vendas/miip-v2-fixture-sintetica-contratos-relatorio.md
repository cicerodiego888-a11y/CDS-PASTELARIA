# MIIP V2 — Fixture sintética fiel aos contratos reais

**Resultado:** `miip-origin-isolated-harness.test.js` → **17 passou, 0 falhou** (8 casos anteriores + 9 novos casos de fixture). `miip-origin-diagnostics.test.js` → **8 passou, 0 falhou**.  
Cada "caso" é um bloco `scenario()` do harness (uma conexão `:memory:` por caso). O total **não** é a soma de assertions: cada caso contém várias assertions, não contadas.

> **Conclusão obrigatória:** a fixture sintética valida contratos e mecanismos, mas **não comprova a origem da ocorrência real `ABC001 / 58%`**. Nenhum dado real foi usado e nenhum score foi fixado em 58.

## 1. Contratos reais identificados

| Contrato | Origem no código | Como foi reutilizado |
|---|---|---|
| Colunas de `produtos` lidas pelos motores | `ProdutoRepository` / `ProdutoIdentidadeCatalogo` (`id, codigo, codigo_barras, nome, unidade, ncm, cest, ativo, preco_venda, …`) | O mesmo DDL mínimo do harness anterior; a fixture só fornece parâmetros |
| Item de entrada dos motores | `MotorGTIN` (`codigoBarras`), `MotorUniversalBuscaCandidatos` (`produtoNome`, `codigoBarras`, `ncm`, `unidade`), `MotorAssociacaoFornecedor` (`fornecedorCnpj`, `codigoFornecedor`) | Campos do `item` da fixture |
| `miip_associacoes` | Colunas consultadas por `MotorAssociacaoFornecedor` | Inserção parametrizada |
| Candidato do motor | Saída real dos motores: `produtoId`, `snapshot`, `produto`, `scoreTotal`, `confianca`, `ranking`, `evidencias`, `motoresQueVotaram`, `atributosExtraidos` | O candidato persistido da fixture D é verificado contra as chaves de um candidato produzido pelo `MotorGTIN` real (`verificarContratoPersistido`); chave desconhecida reprova |
| Resultado MIIP persistido | `CentralProcessamentoService` — `miipValido` / `montarMiipDePersistido` (`resumo`, `resultados[]`, `operacaoId`); caminho de reutilização em `_processarInterno` | Fixture D e F |
| Linha de documento | `CentralDocumentosRepository._mapearRow` e `buscarPorId` (`parse_json`, `miip_sessao_id`, `miip_resumo_json`, `empresa_id`, `LEFT JOIN compras`) | Schema mínimo + repositório **real** (FxD2) |
| Diagnóstico | `MiipOriginDiagnostics`: `candidateRecords`, `candidateSources`, `identitySources`, `recordImport` | Eventos `resultado_item`, `consulta_produto`, `busca_catalogo_universal` |

**Reproduzíveis diretamente no harness:** motores GTIN/associação/MUBC, `ProdutoRepository` + `ProdutoCache`, `CentralProcessamentoService` (caminho de reutilização), `CentralDocumentosRepository`, `MiipOriginDiagnostics.recordImport`.

**Dependem de serviços fora do harness:** a tela (`campos_identidade_ui` é emitido no navegador por `miip-central-revisao-inteligente.js`); `MiipService`/`MiipBootstrap` (têm `require('database')` tardio); rotas HTTP; `MiipImportacaoXmlService` e o parse do XML (o harness injeta o resultado já pronto, sem XML). O schema mínimo dos documentos foi derivado das colunas lidas pelo mapeador e conferido por leitura (sem abrir o banco) contra o `CREATE TABLE central_entradas_documentos` em `backend/database.js`; **não** é a migração real e não inclui a coluna `data_emissao_origem`, `empresa` FK nem as demais tabelas.

## 2. Fixtures criadas

Pasta exclusiva: [tests/miip/fixtures/origin-diagnostics/](../../tests/miip/fixtures/origin-diagnostics). Todas com `schema: "cds.miip.origin-fixture.v1"` e `sintetico: true`. Dados fictícios: GTIN `7890000xxxxxx`, códigos `SINT-*`, código de fornecedor `CPROD-SINT-*`, CNPJ `9999xxxxxxxxxx`, chave `9999`+40 dígitos, operação `op-fixture-*`, nomes com "Sintetic/Ficticio".

| Arquivo | Cenário | Campos principais |
|---|---|---|
| `a-busca-gtin.json` | A — busca por identificador | `catalogo[101]`, `item.codigoBarras`, `esperado` |
| `b-gtin-divergente.json` | B — GTIN divergente | `catalogo[202]`, `item` com GTIN e `codigoFornecedor` diferentes do cadastro, `esperado.gtinDivergente` |
| `c-associacao-fornecedor.json` | C — associação | `catalogo[303]`, `associacoes[1]`, `item.fornecedorCnpj/codigoFornecedor` |
| `d-resultado-persistido.json` | D — persistido | `documento`, `resultadoPersistido` (contrato real), `catalogo[404]`, `persistencia` |
| `e-catalogo-alterado.json` | E — catálogo alterado | `catalogo[505]` (snapshot anterior) e `catalogoAtualizado` (nome, código, GTIN novos) |
| `f-metadados-ausentes.json` | F — sem metadados | `resultadoPersistido` mínimo (somente `produtoEncontrado.id`) |

O score **não** é campo de fixtura nos cenários A–C (é calculado pelo motor). Na D, o score `71` é valor de **entrada** persistido (escolhido deliberadamente diferente de 58).

## 3. Carregador estrito

[origin-fixture-loader.js](../../tests/miip/helpers/origin-fixture-loader.js)

- Carrega apenas nomes declarados no teste (`criarCarregador({ declaradas })`); nome fora do padrão, com `..` ou subpasta é recusado antes de qualquer acesso a disco. O teste também reprova se a pasta tiver arquivo não declarado (nenhum é lido).
- Valida estrutura, tipos, campos obrigatórios e marcadores sintéticos **antes** de criar registros; campo desconhecido é rejeitado (lista de permitidos).
- Rejeita referências a `.db/.sqlite/-wal/-shm`, caminhos, comandos SQL, marcações `<…>`, nomes de campo fiscais/pessoais (`cpf`, `xml`, `razao`, …), CNPJ/GTIN/código fora do padrão sintético.
- SQL é fixo no módulo; o JSON só fornece parâmetros (`?`). Colunas do `UPDATE` vêm de uma lista permitida no código. Não há `require` dinâmico de caminho vindo do JSON. O objeto carregado é congelado.
- Rejeições verificadas no caso Fx0 (mutações negativas: schema, `sintetico:false`, campo de topo extra, `cpf`, GTIN real-like, código `ABC001`, nome sem "Sintetic", referência `.db`, caminho Windows, `../`, SQL, marcação, CNPJ não sintético, `xml`, campo desconhecido, código de fornecedor real, fixture não declarada, nomes de arquivo inválidos, objeto congelado).

## 4. Casos executados

| Caso | Resultado | O que verifica |
|---|---|---|
| Fx0 contrato/schema/rejeições | OK | As 6 fixtures carregam e validam; nenhuma fixture extra na pasta; rejeições acima |
| FxA busca por GTIN | OK | Motor real; fonte `busca_gtin`; `gtin_exato`; lookup sem cache; candidato idêntico com instrumentação ligada/desligada; tabelas inalteradas |
| FxB GTIN divergente | OK | Motor real (MUBC); GTIN do item ≠ cadastrado; código de fornecedor ≠ código interno; fonte só `busca_textual_ncm`; sem `gtin_exato`; invariantes idênticos |
| FxC associação | OK | Fonte `associacao_fornecedor`; eventos sem CNPJ/código de fornecedor |
| FxD1 persistido [simulada] | OK | Contrato verificado contra candidato real; reutilização sem parser/MIIP; resposta idêntica ligada/desligada; documento intacto |
| FxD2 persistido [SQL em memória] | OK | `CentralDocumentosRepository` real lê `miip_resumo_json`; mesma verificação; snapshot de tabelas idêntico |
| FxE-id catálogo alterado | OK | Snapshot do cache por ID ≠ catálogo atual; valores idênticos ligada/desligada; `cacheHit` false → true |
| FxE-gtin catálogo alterado | OK | Idem por GTIN |
| FxF metadados ausentes | OK | `desconhecida`; motor, score e evidências `null`/vazio; sem inferência |
| 7 casos anteriores + isolamento | OK | Inalterados |

Valores devolvidos e resultados foram comparados com a instrumentação desabilitada versus habilitada; só `carregadoEm` do snapshot (carimbo regenerado a cada leitura) é ignorado. Nenhum cache foi limpo fora do processo de teste (as chamadas a `produtoCache.limpar()` são do processo do harness). O FxE restaura o catálogo em memória antes da segunda passada para comparar duas execuções.

## 5. Persistência simulada versus SQL em memória

| Categoria | Caso | O que é real | O que é simulado |
|---|---|---|---|
| `persistencia_simulada` | FxD1 | `CentralProcessamentoService`, diagnóstico | Repositório de documentos (objeto fake que devolve o documento) |
| `persistencia_sql_memoria` | FxD2 | `CentralDocumentosRepository` (SQL e mapeador reais) sobre `:memory:` | Schema mínimo (não é a migração real); XML substituído por texto neutro |

Os dois resultados são relatados separadamente. FxD2 **não** valida o schema real nem a migração de produção. Também não usa `database.js`, `server.js`, Electron ou `MiipBootstrap`.

## 6. Scores calculados versus persistidos

Saída real (`FIXTURE_SCORES`):

| Fixture | Origem do score | Motor | Score |
|---|---|---|---:|
| A busca GTIN | **calculado** pelo motor real | `motor_gtin` | 100 |
| B GTIN divergente | **calculado** pelo motor real | `motor_mubc` | 82 |
| C associação | **calculado** pelo motor real | `motor_associacao_fornecedor` | 100 |
| D persistido (simulada) | **valor de entrada** | `motor_gtin` | 71 |
| D persistido (SQL memória) | **valor de entrada** | `motor_gtin` | 71 |

Nenhuma fixture produziu 58 e nenhum valor foi ajustado para isso. O 82 do cenário B é específico do dado sintético e das regras atuais do MUBC; não é evidência sobre o caso real.

## 7. Prova de isolamento

`HARNESS_PROVAS` desta execução:

```json
{"arquivoProibidoCarregado":[],"sqliteAbertos":16,"sqliteSomenteMemoria":true,"bloqueiosDeModulo":3,"bloqueiosDeArquivoBanco":2,"arquivosCriadosNoDiretorioTemporario":0,"modulosDoProjetoCarregados":120}
```

- Guardas reutilizadas sem enfraquecimento: bloqueio de `database.js`, `server.js`, `electron*.js`/`electron`; SQLite só `:memory:`; bloqueio de abrir/ler/copiar `*.db`, `*.sqlite`, `-wal`, `-shm`.
- Os únicos bloqueios foram os 3 + 2 controles negativos do caso 0. As rejeições do carregador ocorrem por validação, sem tocar nas guardas.
- 16 conexões abertas, todas `:memory:`; nenhum arquivo criado; diretório temporário removido ao final (nenhum sobrou). Cada conexão é fechada em `finally`.
- O carregador lê apenas JSON da pasta de fixtures; nenhum `.db` foi aberto, e `backend\banco\mercadao.db` e o banco oficial não foram tocados.

## 8. Limitações

- Dados sintéticos: provam que os mecanismos e contratos funcionam e que a instrumentação observa sem alterar; **não** reproduzem nem explicam `ABC001 / 58%`.
- A tela e o evento `campos_identidade_ui` não foram exercitados; o campo de "fonte de identidade" validado é `origemCamposIdentidade` do diagnóstico de backend (`snapshot_miip` ou `desconhecida`).
- O parse do XML e o `MiipImportacaoXmlService` não rodaram; o resultado de importação é construído a partir dos candidatos reais dos motores.
- O schema de documentos em memória é mínimo; colunas e restrições reais não foram reproduzidas.
- Um cache de execução passada não pode ser reconstituído; apenas hit/miss no processo de teste.
- O contrato do candidato persistido é verificado por inclusão de chaves, não por esquema formal de tipos.
- Não foi executada validação visual (HTTP 403 não contornado). Não foi executada a suíte completa do projeto.

## 9. Dados necessários para uma futura reprodução autorizada

1. Autorização explícita e cópia/exportação **minimizada** do documento de teste: `documentoId` e `operacaoId` internos, `miip_resumo_json` e `parse_json` (sem XML completo, CNPJ nem nome de fornecedor).
2. Linhas de `produtos` (e `marcas` se houver) do `produto_id` candidato **e** de eventuais produtos concorrentes, no estado atual e, se existir, no estado da época.
3. Linhas relevantes de `miip_associacoes` (por `produto_id`).
4. Se existir, os eventos `[MIIP_ORIGIN_DIAG]` e `campos_identidade_ui` da ocorrência.
5. Mapear essas linhas para o formato de fixture (`catalogo`, `associacoes`, `resultadoPersistido`), usando valores sintéticos/pseudonimizados que preservem as relações (igualdade/diferença de GTIN, códigos), declarar o arquivo em `FIXTURES_DECLARADAS` e adicionar um caso no harness. Para valores reais minimizados será necessário decisão explícita para relaxar os validadores de padrão sintético; não foi feito por padrão.

## 10. Arquivos

- Novos: `tests/miip/helpers/origin-fixture-loader.js`; seis JSON em `tests/miip/fixtures/origin-diagnostics/`; este relatório.
- Alterado: `tests/miip/miip-origin-isolated-harness.test.js` (imports, declaração das fixtures e 9 casos novos; os 8 casos anteriores permanecem inalterados).
- Nenhum código de produção, regra MIIP/MIP/MUBC, cache ou banco foi alterado.

## 11. Validações executadas

- `node tests\miip\miip-origin-isolated-harness.test.js` (`NODE_ENV=test`): **17 passou, 0 falhou**.
- `node tests\miip\miip-origin-diagnostics.test.js`: **8 passou, 0 falhou**.
- `node --check` no harness e no carregador: OK. `git diff --check`: sem erros (apenas o aviso CRLF→LF preexistente de `backend/server.js`).
- Não executados: suíte completa do projeto, testes de UI.

**Estado:** aguardando revisão antes de qualquer correção funcional.
