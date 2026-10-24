# Validação final — unidades personalizadas de volume

**Projeto:** CDS Sistemas / Pastelaria  
**Escopo:** validação HTTP, persistência e interface da funcionalidade existente.

## Resultado geral

Os testes de migração, contrato e rotas passaram em bancos temporários. A validação visual do formulário não pôde ser concluída: no aplicativo iniciado com banco isolado, a área de Produtos foi bloqueada pela licença de teste (`Sistema não ativado`, HTTP 403). Não foi contornado o controle de licenciamento.

## Defeito reproduzido e correção mínima

Ao iniciar `node backend/server.js` com `DB_DIR` temporário, o carregamento de `backend/rotas/produtos.js` falhou com `ReferenceError: validarUnidadeVolumeProduto is not defined`. O middleware estava declarado dentro de `normalizarProdutoResposta`, portanto não existia no escopo dos registros `POST` e `PUT`.

A declaração foi movida para o escopo do módulo. O mesmo teste HTTP que carrega o roteador passou após a correção. Na auditoria das rotas também se verificou que os endpoints de unidades usavam apenas a autenticação global, sem verificar a permissão de Produtos. GET e POST agora aplicam `verificarPermissaoEspecifica('produtos')`; a integração confirmou `403` para usuário autenticado sem essa permissão e acesso negado sem token.

## Cenários HTTP executados

O teste `node tests/produtos/unidades-volume-comercial-http.test.js` monta o roteador real e o middleware real de autenticação/permissão em um host Express local, com DB_DIR temporário. Ele não inicializa o servidor completo nem o gate de licença da aplicação.

Resultado: passou. Foram exercitados:

- GET de unidades sem token (`401`), usuário autenticado sem permissão de Produtos (`403`) e usuário autorizado (`200`), incluindo disponibilidade de `ML` e `L`.
- POST sem token (`401`), usuário autenticado sem permissão de Produtos (`403`), nome vazio (`400`) e sigla vazia (`400`).
- Cadastro com sucesso (`201`) e duas criações concorrentes de sigla equivalente normalizada: uma resposta `201`, uma `409`.
- Inclusão, edição e leitura HTTP de produto comercial. `volume_unidade`, `volume_unidade_id` e `volume_unidade_nome` corresponderam à unidade cadastrada.
- Payload parcial preservando a configuração; troca para outra unidade ativa; rejeição de nova associação a unidade inativa (`400`, `UNIDADE_VOLUME_INATIVA`); preservação da associação histórica ao editar outro campo; e desativação do volume limpando o ID retornado.
- Unidade inativa ausente da lista GET.

O teste desativa os efeitos assíncronos não relacionados de indexação do MIB durante a integração, para permitir fechar o banco isolado sem deixar tarefas de catálogo em execução. Os métodos de produção não são alterados.

## Validação visual

Foi iniciado `backend/server.js` com banco temporário e aberto o login no navegador integrado. O primeiro acesso ao painel ERP funcionou; ao selecionar **Produtos**, a interface mostrou `Sistema não ativado` e a requisição do módulo foi bloqueada com HTTP 403. Assim, **não foram testados visualmente** o formulário, o botão `+`, cancelar/salvar, a edição, nem o contexto de insumos. O banco temporário e o processo local foram encerrados/removidos; nenhum controle foi enfraquecido para prosseguir.

## Regressões executadas

- `node tests/produtos/unidades-volume-comercial-http.test.js` — passou; inclui importação real das rotas e integração HTTP em DB_DIR temporário.
- `node tests/produtos/unidades-volume-comercial.test.js` — passou; migração legada repetida, backfill e preservação de ML/L, normalização, divergência de sigla/ID, unidade inativa e persistência após reabertura.
- `node tests/produtos/volume-comercial-produto.test.js` — passou; compatibilidade e validação da funcionalidade anterior.
- `node tests/produtos/produto-embalagens.test.js` — 14 aprovados, 0 falhas.
- `node tests/motor-conversao-unidades/motor-conversao-unidades.test.js` — 15 aprovados, 0 falhas. O teste emitiu aviso de dependência circular preexistente envolvendo `recalcularEstoqueConsolidado`.
- `node tests/produto-identidade/mip-sprint06-cadastro.test.js` com `$env:DB_DIR` em diretório temporário — 13 aprovados, 0 falhas.
- `node --check` para as rotas e testes HTTP/unidade; `git diff --check` para os arquivos desta validação — passaram.

Os testes de serviço também confirmam rejeição de IDs inexistentes e sigla incompatível com o ID. A leitura legado ML/L foi verificada com produtos em SQLite isolado.

## Arquivos alterados nesta validação

- `backend/rotas/produtos.js` — correção do escopo do middleware e autorização da criação por permissão de Produtos.
- `tests/produtos/unidades-volume-comercial-http.test.js` — teste HTTP isolado de autenticação, autorização, concorrência e contratos de produto.
- `tests/produtos/unidades-volume-comercial.test.js` — cobertura de divergência sigla/ID, edição histórica e troca para unidade ativa.
- `docs/vendas/unidades-volume-comercial-relatorio.md` — atualização da regra de permissão.
- `docs/vendas/unidades-volume-comercial-validacao-final-relatorio.md` — este relatório.

## Limitações e proteções

- O gate de licença impediu validação visual end-to-end; esse é o principal cenário pendente para a revisão em ambiente de desenvolvimento devidamente licenciado.
- As rotas foram testadas no host Express local com roteador e middlewares reais, mas não através do `server.js` completo para as requisições HTTP de CRUD; o servidor completo foi usado apenas para a tentativa visual e bloqueou o módulo pelo gate de licença.
- Não foram executadas operações reais de SEFAZ. `C:\ProgramData\MercantilFiscal\dados` não foi acessado, aberto ou migrado. Todos os bancos de teste foram temporários e isolados.
- Não houve commit, push, merge, reset ou rollback destrutivo. MUC, `unidadesSi.js`, estoque, compras, apresentações, vendas, fiscal e cadastro de insumos não foram modificados funcionalmente nesta validação.
