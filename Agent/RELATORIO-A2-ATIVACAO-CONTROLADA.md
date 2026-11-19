# A2 — Diagnóstico e ativação controlada do banco local

## Status final

**Ativação de schema, configuração e endpoints de roteamento/canais concluída no banco local de testes confirmado. S08 ainda não está homologada ponta a ponta.** A interface Electron não abriu, não houve evidência visual, e o fluxo de criação de pedido até o KDS não foi executado. S09 não foi iniciado.

## Alvo, backup e proteção

O usuário confirmou como alvo exclusivo `C:\ProgramData\MercantilFiscal\dados\mercadao.db` e autorizou seu uso como banco local de testes. Não foi acessado servidor remoto nem outro checkout/banco.

Backup SQLite consistente, feito antes das migrations:

- Arquivo: `C:\Users\cicer\.copilot\session-state\9f276c4e-650d-444e-9571-a62530356de1\files\mercadao-A2-pre-migration.db`
- Tamanho: 30.224.384 bytes.
- SHA-256: `A85BB29250C94F4099679E76491D3FB7483A4639A62193517A386127A0055C8F`
- `integrity_check`: `ok`.
- Baseline `foreign_key_check`: 2.082 violações; não foram corrigidas.

Backups das configurações anteriores:

- `config-servidor.json`: 73 bytes, SHA-256 `6A47C01C2C6DC89BF397D574A5061643619A0C44F186540825DE6E7D6A5561B2`.
- `configuracoes.json`: 1.646 bytes, SHA-256 `078DF7084128747A65E52E442CDA551F29641465384C7C10631F428901F87348`.

Na verificação final, o banco ativo tinha 30.285.824 bytes. Os arquivos WAL/SHM não foram removidos manualmente; o WAL estava presente com 0 bytes após checkpoint do SQLite e o SHM com 32.768 bytes.

## Causa da divergência e configuração

O Electron ERP já selecionava modo local em [electron-common.js](../electron-common.js), com `DB_DIR` padrão em `%ProgramData%\MercantilFiscal\dados`. A divergência restante estava em `configuracoes.json`, que mantinha `modoOperacao=CLIENTE_SERVIDOR`; `config-servidor.json` também havia sido encontrado em modo cliente.

Com backup prévio, ambos foram normalizados para modo local usando o serviço oficial [configuracaoService.js](../backend/services/configuracaoService.js). A leitura posterior confirmou `modoOperacao=LOCAL`, sem servidor configurado, e `modo=local` para a estação. A porta configurada permaneceu 3001.

Isso corrige a premissa de conexão local; não prova por si só que a interface instalada abriu ou que o frontend foi visualmente homologado.

## Schema e migrations

- S07-2 já estava presente: `cozinha_schema_meta.schema_version=3`; não foi reaplicado.
- Aplicadas, em ordem e somente porque ausentes: [S07-3A](../backend/migrations/s07-3a-cozinha-roteamento.sql), [S07-3C](../backend/migrations/s07-3c-cozinha-canais.sql), [S07-3D](../backend/migrations/s07-3d-pedido-destino-cozinha.sql) e [S07-3E](../backend/migrations/s07-3e-pedido-despacho-kds.sql).
- Cada etapa foi validada com `integrity_check=ok`; FK global permaneceu em 2.082 e FK do domínio Cozinha em 0.
- Comparação entre backup e banco final: 289 → 294 tabelas, cinco tabelas S07 esperadas e seus índices; nenhuma tabela removida. A única tabela existente com SQL alterado foi `pedidos`, pelas colunas S07-3D/E.
- Contagens de empresas, pedidos e produtos permaneceram em 5, 134 e 22. As duas unidades de cozinha preexistentes foram mantidas.
- Relatório/log das migrations: [LOG-A2-S07-MIGRATIONS-TESTDB.log](./LOG-A2-S07-MIGRATIONS-TESTDB.log).

## Homologação HTTP de roteamento e canais

Como o servidor completo inicia serviços de background, a homologação foi feita com um harness temporário, limitado a `127.0.0.1`, montando o roteador real [cozinha.js](../backend/rotas/cozinha.js), `verificarToken`, o gate de recurso e o middleware de empresa. O backend completo, serviços fiscais, worker de impressão e Electron não foram iniciados nesse harness. Foi usado um JWT temporário em memória, assinado para um SUPER_ADMIN ativo do banco; portanto, as rotas/middlewares foram exercitados, mas login por senha não foi homologado.

Resultados:

- Sem token: `401 SESSAO_INVALIDA`; com token de teste: `200`, schema operacional v3.
- Leitura inicial de roteamento: `200`, sem configuração anterior.
- Salva e relê cozinha padrão: empresa 1, unidade 1 (`COZINHA - 01`), modo `COZINHA_PADRAO`.
- Cadastrado canal manual `A2 Homologação Manual` e associado à unidade 1; leitura posterior confirmou a persistência. A rota também garantiu o canal sistema `LOJA`.
- Tentativas de usar unidade/canal da empresa 1 no contexto da empresa 2 foram bloqueadas com `403 UNIDADE_EMPRESA_ISOLAMENTO` e `403 CANAL_EMPRESA_ISOLAMENTO`; nenhuma configuração foi criada para a empresa 2.
- Após fechar e reabrir a conexão SQLite, configuração, canal e destino continuaram persistidos.
- Integridade final: `integrity_check=ok`; FK global permaneceu 2.082; FK das tabelas Cozinha verificadas permaneceu 0.
- Sem pedido de teste, despacho KDS ou impressão: `cozinha_pedido_despachos=0` e `cozinha_impressao_fila=0`.

**Ressalva do identificador do canal:** a primeira chamada do harness serializou o nome sem os acentos por limitação de code page do console e gerou o código `A2_HOMOLOGA_O_MANUAL`. O nome foi corrigido pelo endpoint PATCH, em UTF-8, e confirmado após reabertura. A API protege o campo `codigo`; ele não foi alterado diretamente no banco. O nome final está correto, mas o código gerado deve ser revisto se houver requisito de normalização visual.

Logs completos do harness e da correção UTF-8:

- [LOG-A2-API-HOMOLOGACAO.json](./LOG-A2-API-HOMOLOGACAO.json)
- [LOG-A2-API-CORRECAO-NOME-UTF8.json](./LOG-A2-API-CORRECAO-NOME-UTF8.json)

## Inicialização completa e efeitos observados

Uma tentativa anterior de iniciar o backend completo foi interrompida ao detectar que o bootstrap não é neutro:

- O log do servidor registrou início de `SYNC_DFE` e término com erro. No banco, foram registrados `SYNC_INICIADA` e `SYNC_CONCLUIDA` (`resultado=ignorado`, `sucesso=0`, zero notas novas/duplicadas, 336 ms). Não foi emitida NF-e/NFC-e deliberadamente; não é possível comprovar retrospectivamente se houve comunicação externa durante a sincronização.
- O bootstrap também criou um log `equipamentos_logs` (`manager.inicializar`) e um snapshot de observabilidade. A contagem de `central_entradas_eventos` aumentou em 2, `equipamentos_logs` em 1 e `obs_metric_snapshots` em 1. Esses registros não foram apagados.
- O log registrou tentativa de remoção de categoria legada bloqueada por FK; a comparação não encontrou tabela removida nem alteração de contagem em pedidos/empresas/produtos.
- O backend foi parado; na verificação final não havia processo anterior nem listener na porta 3001. Não será iniciado novamente sem isolamento explícito dos serviços de background.

## Testes anteriores e limites de aceite

- Regressão S06/S07 por suíte isolada: **314/314 aprovados, 0 falhas, exit code 0**. Log: [LOG-S08-REGRESSOES-S06-S07-POR-SUITE.txt](./LOG-S08-REGRESSOES-S06-S07-POR-SUITE.txt).
- Uma execução agrupada anterior teve **313/314, 1 falha, exit code 1**; a repetição isolada do teste S06 E-03 passou **16/16**. A divergência está preservada em [LOG-S08-REGRESSOES-S06-S07.txt](./LOG-S08-REGRESSOES-S06-S07.txt) e no log de validação.
- As 11 suítes S07 passaram **189/189**, conforme [RELATORIO-STATUS-S08.md](./RELATORIO-STATUS-S08.md). Esses testes são evidência de regressão do código existente, não substituem a homologação da instalação.
- O Electron não abriu uma janela utilizável. Não há captura visual.
- Não foram testados login real, endpoints via servidor completo da instalação, formulário da interface, criação comercial de pedido, resolução S07-3D em pedido real, despacho S07-3E, isolamento visual entre unidades, falha/recuperação do despacho ou idempotência no banco operacional.
- Nenhum arquivo de código do repositório foi alterado. A S06 permaneceu congelada; não houve impressão física, despacho, emissão fiscal deliberada nem início da S09.

## Conclusão

O banco autorizado está com as migrations S07 necessárias, modo local corrigido e persistência de roteamento/canal validada por HTTP nas rotas reais. A Gestão de Cozinhas **ainda não atende aos critérios finais de S08** porque faltam a homologação visual pelo Electron e o fluxo comercial até o KDS. A inicialização completa permanece bloqueada até que os serviços automáticos de background, especialmente a sincronização DFE, possam ser isolados sem risco.
